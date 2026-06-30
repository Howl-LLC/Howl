// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import { app, BrowserWindow, desktopCapturer, ipcMain, safeStorage, session, shell, Notification, nativeImage, screen, powerMonitor, Tray, Menu } from 'electron';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import * as SentryMain from '@sentry/electron/main';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { GameScanner } from './gameScanner.js';
import { SpotifyDetector } from './spotifyDetector.js';

const require = createRequire(import.meta.url);
const globalKeybinds = require('./electron/globalKeybinds.js');
const streamdeck = require('./electron/streamdeck/index.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Force the canonical capitalised app name so app.getPath('userData') resolves
// to %APPDATA%\Howl (matching package.json productName), not "howl" (npm package
// name). MUST run before any app.getPath() call — userData paths resolve on first
// read. NTFS is case-insensitive so existing "howl" data is still found.
app.setName('Howl');

// Refuse to boot a packaged build launched with a debugging CLI arg (--inspect,
// --remote-debugging-port, --js-flags, etc.). Electron Fuses (build/afterPack.cjs)
// disable the Node-level inspect flags; rejecting here is belt-and-suspenders
// against any flag the fuses miss and gives a clean exit rather than an opened
// debug port. Dev builds (not app.isPackaged) are unaffected.
if (app.isPackaged) {
  const FORBIDDEN = [
    '--inspect', '--inspect-brk', '--inspect-port',
    '--remote-debugging-port', '--remote-debugging-pipe',
    '--js-flags', '--enable-logging',
  ];
  const bad = process.argv.slice(1).find((arg) =>
    FORBIDDEN.some((f) => arg === f || arg.startsWith(`${f}=`))
  );
  if (bad) {
    console.error(`[howl] rejecting debug CLI argument: ${bad}`);
    app.exit(1);
  }
  if (process.env.ELECTRON_RUN_AS_NODE || process.env.NODE_OPTIONS) {
    console.error('[howl] rejecting ELECTRON_RUN_AS_NODE / NODE_OPTIONS environment');
    app.exit(1);
  }
}

// Sentry — main process + native crash reporting (Crashpad). Init BEFORE
// app.whenReady so startup errors are captured. DSN comes from
// release-config.json (bundled with the asar). Native crash minidumps upload
// automatically; renderer errors reach Sentry independently via @sentry/react.
// preload.js runs @sentry/electron/preload to bridge renderer events for unified
// release/session tracking.
function readSentryDsn() {
  try {
    const rcPath = path.join(__dirname, 'release-config.json');
    const rcFallback = path.join(__dirname, 'release-config.example.json');
    const rcFile = fs.existsSync(rcPath) ? rcPath : rcFallback;
    const rc = JSON.parse(fs.readFileSync(rcFile, 'utf8'));
    return typeof rc.SENTRY_DSN === 'string' && rc.SENTRY_DSN.trim() ? rc.SENTRY_DSN.trim() : null;
  } catch { return null; }
}

const _sentryDsn = readSentryDsn() || process.env.SENTRY_DSN || process.env.VITE_SENTRY_DSN || null;
if (_sentryDsn) {
  try {
    SentryMain.init({
      dsn: _sentryDsn,
      release: app.getVersion(),
      environment: app.isPackaged ? 'production' : 'development',
      autoSessionTracking: true,
      // Crashpad minidump upload for GPU/renderer/main native crashes on Win/macOS/Linux
      enableNative: true,
      tracesSampleRate: 0.05,
      beforeSend(event) {
        // Strip auth headers and sensitive query params before upload
        if (event.request?.headers) {
          delete event.request.headers['Authorization'];
          delete event.request.headers['authorization'];
          delete event.request.headers['Cookie'];
        }
        if (event.request?.url) {
          try {
            const u = new URL(event.request.url);
            ['token', 'key', 'code', 'state'].forEach(p => u.searchParams.delete(p));
            event.request.url = u.toString();
          } catch { /* ignored */ }
        }
        return event;
      },
    });
  } catch (e) {
    console.error('[main] Sentry init failed:', e?.message || e);
  }
}

// Quit flag — true when the app is actually terminating (not hiding to tray)

let isQuitting = false;

// Interval registry — guarantees all setIntervals are cleared on quit

const _intervals = new Set();

function trackedSetInterval(fn, ms) {
  const id = setInterval(fn, ms);
  _intervals.add(id);
  return id;
}

function clearAllIntervals() {
  for (const id of _intervals) clearInterval(id);
  _intervals.clear();
}

// Build date injected at package time: prod = installer build day, dev = today
// (keeps the version-gate permissive against the dev server).
const BUILD_DATE = process.env.HOWL_BUILD_DATE || new Date().toISOString().slice(0, 10);

// App settings persistence (close action, start minimized)

const appSettingsPath = path.join(app.getPath('userData'), 'app-settings.json');

function loadAppSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(appSettingsPath, 'utf8'));
    return {
      closeAction: ['ask', 'tray', 'quit'].includes(raw.closeAction) ? raw.closeAction : 'ask',
      startMinimized: !!raw.startMinimized,
      streamdeckEnabled: !!raw.streamdeckEnabled,
      streamdeckAllowMobile: !!raw.streamdeckAllowMobile,
    };
  } catch {
    return { closeAction: 'ask', startMinimized: false, streamdeckEnabled: false, streamdeckAllowMobile: false };
  }
}

function saveAppSettings(settings) {
  try { fs.writeFileSync(appSettingsPath, JSON.stringify(settings, null, 2)); } catch { /* best effort */ }
}

let appSettings = loadAppSettings();

// System autostart (login item) — cross-platform

const AUTOSTART_HIDDEN_ARG = '--hidden';
const launchedHidden = process.argv.includes(AUTOSTART_HIDDEN_ARG);

function getLinuxAutostartPath() {
  return path.join(os.homedir(), '.config', 'autostart', 'howl.desktop');
}

function writeLinuxAutostart(enabled, startHidden) {
  const p = getLinuxAutostartPath();
  if (!enabled) {
    try { fs.unlinkSync(p); } catch { /* absent is fine */ }
    return;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const execCmd = process.execPath + (startHidden ? ` ${AUTOSTART_HIDDEN_ARG}` : '');
  fs.writeFileSync(p, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Howl',
    `Exec=${execCmd}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n'), 'utf8');
}

function getAutostartState() {
  if (process.platform === 'linux') {
    const p = getLinuxAutostartPath();
    const enabled = fs.existsSync(p);
    let startHidden = false;
    if (enabled) {
      try {
        const content = fs.readFileSync(p, 'utf8');
        startHidden = content.includes(AUTOSTART_HIDDEN_ARG);
      } catch { /* noop */ }
    }
    return { enabled, startHidden };
  }
  const s = app.getLoginItemSettings(process.platform === 'darwin' ? undefined : { path: process.execPath });
  return { enabled: s.openAtLogin, startHidden: (s.openAsHidden === true) || process.argv.includes(AUTOSTART_HIDDEN_ARG) };
}

function setAutostartState(enabled, startHidden) {
  if (process.platform === 'linux') {
    writeLinuxAutostart(enabled, startHidden);
    return;
  }
  if (process.platform === 'darwin') {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: startHidden,
    });
  } else {
    // Windows
    app.setLoginItemSettings({
      openAtLogin: enabled,
      args: startHidden ? [AUTOSTART_HIDDEN_ARG] : [],
      path: process.execPath,
    });
  }
}

// Single instance lock — prevent multiple windows / tray icon confusion

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (process.platform === 'darwin' && app.dock) app.dock.show();
    }
    const deepLinkUrl = argv.find(arg => arg.startsWith('howl://'));
    if (deepLinkUrl) handleDeepLink(deepLinkUrl);
  });
}

// Deep link protocol registration (howl://)

// Log protocol-registration result so Windows deep-link failures (usually
// permission denied or already owned by another install) surface in logs instead
// of silently producing "Failed to connect app" later when OAuth round-trips
// through howl://settings/callback.
try {
  const alreadyRegistered = app.isDefaultProtocolClient('howl');
  if (!alreadyRegistered) {
    const ok = app.setAsDefaultProtocolClient('howl');
    if (!ok) {
      // eslint-disable-next-line no-console
      console.warn('[howl] Could not register howl:// protocol client. OAuth deep-links will not work on this install.');
    } else {
      // eslint-disable-next-line no-console
      console.log('[howl] Registered howl:// protocol client.');
    }
  }
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn('[howl] Protocol registration threw:', err?.message || err);
}

// macOS delivers protocol URLs via the open-url event
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// On Windows/Linux the protocol URL arrives as a command-line argument
const launchDeepLink = process.argv.find(arg => arg.startsWith('howl://'));

const DEEP_LINK_CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;
let lastDeepLinkTime = 0;

// Nonce state for SSO system-browser flow — declared here so handleDeepLink can
// reach it; the full implementation (generateNonce, cleanup interval, IPC
// handlers) is at the bottom of this file after the auto-updater section.
const MAX_PENDING_NONCES = 100;
const NONCE_TTL_MS = 5 * 60 * 1000;
const pendingSsoNonces = new Map();

function handleDeepLink(rawUrl) {
  const now = Date.now();
  if (now - lastDeepLinkTime < 1000) return;
  lastDeepLinkTime = now;

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'howl:') return;

    const pathParts = parsed.pathname.replace(/^\/\//, '').split('/').filter(Boolean);
    const action = parsed.host || pathParts[0];
    const subAction = pathParts[parsed.host ? 0 : 1];

    if (!action) return;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
    }

    switch (action) {
      case 'invite': {
        const code = subAction;
        if (!code || !DEEP_LINK_CODE_RE.test(code)) return;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('deep-link', { action: 'invite', code });
        }
        break;
      }

      case 'auth': {
        // howl://auth/callback?code=xxx&nonce=yyy  OR  howl://auth/callback?error=xxx&nonce=yyy
        if (subAction !== 'callback') return;
        const code = parsed.searchParams.get('code');
        const error = parsed.searchParams.get('error');
        const nonce = parsed.searchParams.get('nonce');

        if (!nonce || !pendingSsoNonces.has(nonce)) return;
        const nonceData = pendingSsoNonces.get(nonce);
        if (nonceData.consumed) return; // duplicate deep-link delivery — ignore silently
        if (Date.now() - nonceData.timestamp > NONCE_TTL_MS) { pendingSsoNonces.delete(nonce); return; }
        // Mark consumed; cleanup interval sweeps the entry after TTL so a
        // duplicate protocol-handler firing (common on Windows via both
        // second-instance and open-url) doesn't re-notify the renderer.
        nonceData.consumed = true;

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sso-callback', { code: code || null, error: error || null });
        }
        break;
      }

      case 'settings': {
        // howl://settings/callback?sso_linked=google&nonce=yyy
        // howl://settings/callback?sso_error=xxx&nonce=yyy
        // howl://settings/callback?app_linked=spotify&nonce=yyy
        // howl://settings/callback?app_error=xxx&nonce=yyy
        // howl://settings/callback?app_connected=riot&nonce=yyy
        if (subAction !== 'callback') return;
        const nonce = parsed.searchParams.get('nonce');

        if (!nonce || !pendingSsoNonces.has(nonce)) return;
        const nonceData = pendingSsoNonces.get(nonce);
        if (nonceData.consumed) return; // duplicate deep-link delivery — ignore silently
        if (Date.now() - nonceData.timestamp > NONCE_TTL_MS) { pendingSsoNonces.delete(nonce); return; }
        nonceData.consumed = true;

        // Forward all query params to renderer (except nonce)
        const params = Object.fromEntries(parsed.searchParams.entries());
        delete params.nonce;

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sso-settings-callback', params);
        }
        break;
      }

      default:
        break;
    }
  } catch {
    // Malformed URL — silently ignore
  }
}

let mainWindow = null;
let overlayWindow = null;
let tray = null; // Module scope — prevents garbage collection (known Electron issue)
let currentGame = null; // Overlay visibility: game detected AND main window unfocused

// Process-level error handlers — prevent silent crashes

process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught exception:', err);
  // Process may be in an undefined state after an uncaught exception — save
  // window state and relaunch rather than continue with corrupted state.
  try {
    if (mainWindow && !mainWindow.isDestroyed()) saveWindowState(mainWindow);
  } catch { /* best effort */ }
  app.relaunch();
  app.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled rejection:', reason);
});

// Increase renderer V8 heap limit from default ~1.4GB to 4GB — heavy servers
// with many embeds/images exceed the default and OOM-crash the renderer.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');

// App-level crash listeners — catch renderer + child-process (GPU/utility) deaths.
app.on('render-process-gone', (_event, webContents, details) => {
  let host = '';
  try { host = new URL(webContents.getURL()).host; } catch { /* destroyed or invalid */ }
  console.error(`[app] render-process-gone reason=${details.reason} exitCode=${details.exitCode} host=${host}`);
});
app.on('child-process-gone', (_event, details) => {
  console.error(`[app] child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode} name=${details.name || ''}`);
});


// Chromium feature flags — accumulated per-platform then emitted once.
// appendSwitch('enable-features', …) called more than once does not merge
// cleanly across Chromium versions, so build a single comma-separated value.

const enableFeatures = [];
// HardwareMediaKeyHandling installs a global low-level media-key listener
// (Win32 keyboard hook). Howl drives its own keybinds via
// electron/globalKeybinds.js and never publishes a Media Session, so it's
// wasted CPU.
const disableFeatures = ['HardwareMediaKeyHandling'];

if (process.platform === 'linux') {
  // Wayland / older mesa drivers can crash without this; only apply
  // VaapiVideoDecoder when not on pure software rendering.
  if (process.env.HOWL_DISABLE_GPU !== '1') {
    enableFeatures.push('VaapiVideoDecoder');
  }
  // UseSkiaRenderer can cause rendering issues on some distros.
  disableFeatures.push('UseSkiaRenderer');
}

if (process.platform === 'win32') {
  // Pause compositing when the window is fully occluded (fullscreen game on
  // top, browser stacked over Howl). Without this Chromium keeps producing
  // hidden frames.
  enableFeatures.push('CalculateNativeWinOcclusion');
}

if (enableFeatures.length) {
  app.commandLine.appendSwitch('enable-features', enableFeatures.join(','));
}
app.commandLine.appendSwitch('disable-features', disableFeatures.join(','));

if (process.env.HOWL_DISABLE_GPU === '1') {
  // Hardware acceleration opt-out for all platforms.
  app.disableHardwareAcceleration();
} else {
  // GPU rasterization + zero-copy: upload paint tiles directly to the GPU
  // instead of software-rasterizing on the CPU. Big idle-CPU win.
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
}

// Force software video encoding — read from persisted flag file
const swEncodeFlagPath = path.join(app.getPath('userData'), 'force-sw-encode.json');
try {
  const flag = JSON.parse(fs.readFileSync(swEncodeFlagPath, 'utf8'));
  if (flag?.enabled) {
    app.commandLine.appendSwitch('disable-gpu-video-encode');
  }
} catch { /* file doesn't exist yet or is invalid — default to GPU encoding */ }

// Limit Chromium HTTP disk cache to 250MB (default is unlimited — grows over weeks)
app.commandLine.appendSwitch('disk-cache-size', String(250 * 1024 * 1024));

// Window state persistence — remember position/size across sessions

const stateFile = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (state && typeof state === 'object') {
      state.width = Math.max(900, Math.min(4000, Number(state.width) || 1280));
      state.height = Math.max(600, Math.min(3000, Number(state.height) || 800));
      if (state.x != null) state.x = Number(state.x) || 0;
      if (state.y != null) state.y = Number(state.y) || 0;
    }
    return state;
  } catch {
    return null;
  }
}

let saveTimer = null;

/**
 * Persist window bounds/maximised state to disk.
 * Uses synchronous write — called on close/quit paths where the process is
 * about to exit and we must guarantee the file is written before teardown.
 */
function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.isMaximized() ? (win._lastBounds || win.getBounds()) : win.getBounds();
  const state = { ...bounds, isMaximized: win.isMaximized() };
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch { /* ignore */ }
}

/**
 * Debounced save — fires 500ms after the last move/resize event.
 * Uses async write here because the app is still running and we don't need
 * to block the main thread for a non-critical persistence write.
 */
function scheduleSaveWindowState(win) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!win || win.isDestroyed()) return;
    const bounds = win.isMaximized() ? (win._lastBounds || win.getBounds()) : win.getBounds();
    const state = { ...bounds, isMaximized: win.isMaximized() };
    try { await fs.promises.writeFile(stateFile, JSON.stringify(state)); } catch { /* ignore */ }
  }, 500);
}

// Preload path resolution

function getPreloadPath() {
  if (app.isPackaged) {
    const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'preload.js');
    if (fs.existsSync(unpackedPath)) return unpackedPath;
    return path.join(process.resourcesPath, 'app.asar', 'preload.js');
  }
  return path.join(__dirname, 'preload.js');
}

// App icon path (Howl logo for taskbar / title bar)

function getIconPath() {
  // Windows taskbar/title-bar pulls icon glyphs at multiple DPIs (16/24/32/48
  // up through 256). A single PNG forces electron to scale at runtime and
  // usually looks soft on the taskbar. The multi-resolution howl-logo.ico
  // already has the right glyph for every DPI bucket, so prefer it on win32
  // and keep the PNG fallback for macOS/Linux + as a last resort.
  const candidates = process.platform === 'win32'
    ? ['howl-logo.ico', 'howl-logo.png']
    : ['howl-logo.png'];

  for (const iconFile of candidates) {
    if (app.isPackaged) {
      const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'public', iconFile);
      if (fs.existsSync(unpacked)) return unpacked;
      const inAsar = path.join(__dirname, 'public', iconFile);
      if (fs.existsSync(inAsar)) return inAsar;
    } else {
      const devPath = path.join(__dirname, 'public', iconFile);
      if (fs.existsSync(devPath)) return devPath;
    }
  }
  // Final fallback — return the PNG path even if missing, so the caller's
  // error surfaces clearly instead of silently passing undefined to Electron.
  return path.join(__dirname, 'public', 'howl-logo.png');
}

// Window creation

function isOnScreen(x, y, width, height) {
  if (x == null || y == null) return false;
  try {
    const displays = screen.getAllDisplays();
    return displays.some(d => {
      const { x: dx, y: dy, width: dw, height: dh } = d.bounds;
      return x + width > dx && x < dx + dw && y + height > dy && y < dy + dh;
    });
  } catch { return false; }
}

// Renderer origin — packaged builds load the production web bundle directly from
// Cloudflare Pages (same code path web users see); dev loads Vite. This ships
// frontend changes at CDN speed without an Electron release, and web-origin-bound
// integrations like Cloudflare Turnstile just work.

const PACKAGED_RENDERER_URL = (() => {
  try {
    const rcPath = path.join(__dirname, 'release-config.json');
    const rcFallback = path.join(__dirname, 'release-config.example.json');
    const rcFile = fs.existsSync(rcPath) ? rcPath : rcFallback;
    const rc = JSON.parse(fs.readFileSync(rcFile, 'utf8'));
    return (rc.FRONTEND_ORIGIN || 'https://app.howlpro.com').replace(/\/$/, '');
  } catch { return 'https://app.howlpro.com'; }
})();

// Optional Cloudflare Access (Zero Trust) team URL. When set, navigation to this
// origin is allowed inside the main window so users can complete the Access OTP
// flow without being punted to the system browser. Cloudflare sets the
// CF_Authorization cookie on PACKAGED_RENDERER_URL after auth; the Electron
// session persists that cookie across restarts until CF's TTL.
const CLOUDFLARE_ACCESS_TEAM_URL = (() => {
  try {
    const rcPath = path.join(__dirname, 'release-config.json');
    const rcFallback = path.join(__dirname, 'release-config.example.json');
    const rcFile = fs.existsSync(rcPath) ? rcPath : rcFallback;
    const rc = JSON.parse(fs.readFileSync(rcFile, 'utf8'));
    const raw = rc.CLOUDFLARE_ACCESS_TEAM_URL;
    if (!raw) return '';
    return String(raw).replace(/\/$/, '');
  } catch { return ''; }
})();

let _mainAppLoading = false;

// Path the Electron desktop client always loads first.
//   /home   — bypasses the public landing page web visitors see at `/`. Authed
//             users land directly in the app shell; unauthed users hit the
//             unauth catch-all which renders Login (because `?app=1` tells
//             App.tsx this is Electron).
//   ?app=1  — synchronous signal read by App.tsx at module-load time, so the
//             "is this Electron?" decision is made before React's first render.
//             Avoids the contextBridge cold-start race. App.tsx caches the answer
//             in sessionStorage so in-app navigation that strips the query string
//             keeps working.
const ELECTRON_ENTRY_PATH = '/home?app=1';

function loadMainApp(win) {
  if (_mainAppLoading) return;
  if (win.isDestroyed()) return;
  _mainAppLoading = true;
  if (app.isPackaged) {
    win.loadURL(`${PACKAGED_RENDERER_URL}${ELECTRON_ENTRY_PATH}`);
  } else {
    const devUrl = process.env.VITE_DEV_URL || 'http://localhost:3000';
    win.loadURL(`${devUrl}${ELECTRON_ENTRY_PATH}`).catch(() => win.loadFile(path.join(__dirname, 'index.html')));
  }
}

/**
 * Returns true if the loaded URL is the renderer's main-app shell (the page
 * that hosts the React bundle). Excludes update-screen.html, repair-screen,
 * about:blank, and Cloudflare Access OTP origins.
 */
function isMainAppUrl(url) {
  if (!url) return false;
  if (url.startsWith(PACKAGED_RENDERER_URL)) return true;
  if (url.startsWith('http://localhost')) return true;
  if (url.startsWith('https://localhost')) return true;
  if (url.startsWith('http://127.0.0.1')) return true;
  return false;
}

function createWindow() {
  const saved = loadWindowState();
  const preloadPath = getPreloadPath();
  const iconPath = getIconPath();
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : null;

  const w = saved?.width || 1280;
  const h = saved?.height || 800;
  const validPos = isOnScreen(saved?.x, saved?.y, w, h);

  const win = new BrowserWindow({
    width: w,
    height: h,
    ...(validPos ? { x: saved.x, y: saved.y } : {}),
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    ...(icon ? { icon } : {}),
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 14 },
      frame: true,
    } : {}),
    backgroundColor: '#020617',
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      // Disabled at boot, re-enabled ~10s after the main-app HTML loads (see
      // did-finish-load below). With CalculateNativeWinOcclusion, leaving this
      // true would demote the renderer to ~1Hz mid-startup if Chromium deemed the
      // window occluded during the file:// → app.howlpro.com navigation, freezing
      // JS with the static HTML fallback visible. Occlusion still pauses
      // compositing once mount completes — only the timer-throttle is deferred.
      backgroundThrottling: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow = win;

  // Belt-and-suspenders: slam DevTools shut if anything opens it in a packaged
  // build (webContents.openDevTools, compromised renderer, etc.). devTools:false
  // already prevents this, but the listener is cheap and closes second-order
  // bypasses.
  if (app.isPackaged) {
    win.webContents.on('devtools-opened', () => { win.webContents.closeDevTools(); });
  }

  // Composer spellcheck: forward Chromium's context-menu event (with
  // suggestions) to the renderer, which renders the Howl-styled menu from
  // `params.dictionarySuggestions`/`params.misspelledWord`. Chromium's bundled
  // Hunspell engine has already computed these, so we ship no JS dictionary.
  win.webContents.on('context-menu', (_event, params) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('composer-context-menu', {
      x: params.x,
      y: params.y,
      isEditable: !!params.isEditable,
      misspelledWord: params.misspelledWord || '',
      dictionarySuggestions: Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions : [],
      selectionText: params.selectionText || '',
      canCut: !!params.editFlags?.canCut,
      canCopy: !!params.editFlags?.canCopy,
      canPaste: !!params.editFlags?.canPaste,
      canSelectAll: !!params.editFlags?.canSelectAll,
    });
  });

  // Send visibility state to renderer for render throttling.
  // backgroundThrottling starts false, enabled ~10s after did-finish-load, then
  // disabled again while a voice/call session is active (via 'voice-session-state'
  // IPC from renderer).
  win.on('hide', () => win.webContents.send('window-visibility', false));
  win.on('show', () => win.webContents.send('window-visibility', true));
  win.on('minimize', () => win.webContents.send('window-visibility', false));
  win.on('restore', () => win.webContents.send('window-visibility', true));
  win.on('focus', () => {
    win.webContents.send('window-visibility', true);
    // Overlay visibility: hide overlay when main window gains focus
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
      overlayWindow.hide();
    }
  });
  win.on('blur', () => {
    // Overlay visibility: re-show overlay when main window loses focus AND a game is running
    if (currentGame && overlayWindow && !overlayWindow.isDestroyed() && !overlayWindow.isVisible()) {
      overlayWindow.showInactive();
    }
  });

  // Intercept zoom shortcuts — redirect to our own handler.
  // DevTools shortcuts (F12 / Ctrl+Shift+Alt+I) only work in dev builds.
  // Ctrl+Shift+I is claimed by the React keybind system (toggleStreamerMode), so
  // use Ctrl+Shift+Alt+I here to avoid stealing it back.
  win.webContents.on('before-input-event', (event, input) => {
    // DevTools shortcuts — dev builds only.
    if (!app.isPackaged) {
      if (input.key === 'F12' && input.type === 'keyDown') {
        event.preventDefault();
        if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
        else win.webContents.openDevTools({ mode: 'detach' });
        return;
      }
      if ((input.control || input.meta) && input.shift && input.alt
          && input.key.toUpperCase() === 'I' && input.type === 'keyDown') {
        event.preventDefault();
        if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
        else win.webContents.openDevTools({ mode: 'detach' });
        return;
      }
    }

    if (!input.control && !input.meta) return;
    const key = input.key;
    if (key === '+' || key === '=' || key === '-' || key === '0') {
      event.preventDefault();
      const direction = (key === '+' || key === '=') ? 'in' : key === '-' ? 'out' : 'reset';
      win.webContents.send('zoom-command', direction);
    }
  });

  if (saved?.isMaximized) {
    win.maximize();
  }

  win.on('move', () => {
    if (!win.isMaximized()) win._lastBounds = win.getBounds();
    scheduleSaveWindowState(win);
  });
  win.on('resize', () => {
    if (!win.isMaximized()) win._lastBounds = win.getBounds();
    scheduleSaveWindowState(win);
  });
  win.on('close', (event) => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveWindowState(win);

    // If actually quitting (from tray "Quit", app.quit(), or Cmd+Q), let it close
    if (isQuitting) return;

    event.preventDefault();

    // On non-app pages (install/update screen, login) the close-action modal
    // can't render — quit directly. Main app loads from the production CDN
    // (https://app.howlpro.com) in packaged builds, localhost in dev.
    const currentUrl = win.webContents.getURL();
    const isMainApp = currentUrl.startsWith(PACKAGED_RENDERER_URL) || currentUrl.startsWith('http://localhost') || currentUrl.startsWith('https://localhost');
    if (!isMainApp) {
      isQuitting = true;
      app.quit();
      return;
    }

    if (appSettings.closeAction === 'ask') {
      // First time (or reset) — ask the user via a modal in the renderer
      win.webContents.send('show-close-action-modal');
    } else if (appSettings.closeAction === 'tray') {
      // User chose "Minimize to Tray" previously
      win.hide();
      if (process.platform === 'darwin' && app.dock) app.dock.hide();
    } else {
      // User chose "Quit" previously — fully exit
      isQuitting = true;
      app.quit();
    }
  });

  win.once('ready-to-show', () => {
    if (launchedHidden || appSettings.startMinimized) {
      // Don't show window — tray icon is already visible
      if (process.platform === 'darwin' && app.dock) app.dock.hide();
    } else {
      win.show();
    }
    if (process.platform === 'darwin') {
      win.setWindowButtonVisibility(true);
    }
    // Send any deep link that triggered the initial launch
    if (launchDeepLink) handleDeepLink(launchDeepLink);
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'mediaKeySystem', 'display-capture', 'notifications', 'clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'];
    callback(allowed.includes(permission));
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    const allowed = ['media', 'mediaKeySystem', 'display-capture', 'notifications', 'clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'];
    return allowed.includes(permission);
  });

  function isSafeExternalUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
    } catch { return false; }
  }

  // Restrict navigation to prevent loading untrusted URLs
  win.webContents.on('will-navigate', (event, url) => {
    // Sentinel URLs from the injected external-page drag strip.
    if (url.startsWith('howl-ui://')) {
      event.preventDefault();
      const action = url.slice('howl-ui://'.length).replace(/\/+$/, '');
      if (action === 'min') win.minimize();
      else if (action === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
      else if (action === 'close') win.close();
      return;
    }
    const allowedPrefixes = app.isPackaged
      ? [
          PACKAGED_RENDERER_URL,
          ...(CLOUDFLARE_ACCESS_TEAM_URL ? [CLOUDFLARE_ACCESS_TEAM_URL] : []),
        ]
      : [
          'http://localhost', 'https://localhost', 'http://127.0.0.1',
          ...(process.env.HOWL_DEV_HOST ? [`http://${process.env.HOWL_DEV_HOST}`] : []),
        ];
    if (!allowedPrefixes.some(p => url.startsWith(p))) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) shell.openExternal(url);
    }
  });

  // Open external links in the default browser, not in Electron
  // Allow blank popout windows (used by voice/DM call popout feature)
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Allow blank windows for voice/DM call popouts (window.open('', ...))
    if (!url || url === '' || url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          frame: true,
          autoHideMenuBar: true,
          backgroundColor: '#020617',
          webPreferences: {
            preload: getPreloadPath(),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            devTools: !app.isPackaged,
          },
        },
      };
    }
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Apply same navigation restrictions + DevTools guard to popout child windows
  win.webContents.on('did-create-window', (childWin) => {
    childWin.webContents.on('devtools-opened', () => {
      if (app.isPackaged) childWin.webContents.closeDevTools();
    });
    childWin.webContents.on('will-navigate', (event, url) => {
      const allowedPrefixes = app.isPackaged
        ? [
            PACKAGED_RENDERER_URL,
            ...(CLOUDFLARE_ACCESS_TEAM_URL ? [CLOUDFLARE_ACCESS_TEAM_URL] : []),
          ]
        : ['http://localhost', 'https://localhost', 'http://127.0.0.1'];
      if (!allowedPrefixes.some(p => url.startsWith(p))) {
        event.preventDefault();
        if (isSafeExternalUrl(url)) shell.openExternal(url);
      }
    });
    childWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    if (app.isPackaged) {
      childWin.webContents.on('devtools-opened', () => { childWin.webContents.closeDevTools(); });
    }
  });

  // Recover from renderer process crashes (OOM, GPU crash, etc.)
  let crashCount = 0;
  let lastCrashTime = 0;
  const CRASH_LIMIT = 3;
  const CRASH_WINDOW_MS = 60_000;

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[main] Renderer process gone: ${details.reason} (exit ${details.exitCode})`);
    const now = Date.now();
    if (now - lastCrashTime > CRASH_WINDOW_MS) crashCount = 0;
    lastCrashTime = now;
    crashCount++;
    if (crashCount > CRASH_LIMIT) {
      console.warn('[crash-recovery] Crash limit exceeded, showing repair screen');
      if (!win.isDestroyed()) win.loadFile(path.join(__dirname, 'repair-screen.html'));
      return;
    }
    if (!win.isDestroyed()) {
      if (app.isPackaged) {
        // Do NOT preserve route hash on crash recovery — the crash was likely
        // caused by the current view (heavy server, large file, etc.).
        // Reloading the same route would crash again in a loop.
        win.loadURL(`${PACKAGED_RENDERER_URL}${ELECTRON_ENTRY_PATH}`);
      } else {
        const devUrl = process.env.VITE_DEV_URL || 'http://localhost:3000';
        win.loadURL(`${devUrl}${ELECTRON_ENTRY_PATH}`).catch(() => win.loadFile(path.join(__dirname, 'index.html')));
      }
    }
  });

  // Set Content Security Policy for production builds
  if (app.isPackaged) {
    // Hosts we embed as <iframe>. Many set `frame-ancestors 'none'` or
    // `X-Frame-Options: DENY`, which we strip from sub-frame responses. The
    // renderer runs at https://app.howlpro.com (a real web origin), so services
    // like Twitch that cross-check the `parent=` query against the request origin
    // accept us natively — no Origin/Referer rewrite required.
    const EMBED_HOSTS = new Set([
      'player.twitch.tv',
      'clips.twitch.tv',
      'www.youtube-nocookie.com',
      'www.youtube.com',
      'open.spotify.com',
      'store.steampowered.com',
      'www.tiktok.com',
      'platform.twitter.com',
      'embed.reddit.com',
      'player.kick.com',
    ]);

    function isEmbedHost(hostname) { return EMBED_HOSTS.has(hostname); }

    function stripFrameBlockingHeaders(responseHeaders) {
      for (const key of Object.keys(responseHeaders)) {
        const lk = key.toLowerCase();
        if (lk === 'content-security-policy' || lk === 'content-security-policy-report-only') {
          const values = Array.isArray(responseHeaders[key]) ? responseHeaders[key] : [responseHeaders[key]];
          const cleaned = values
            .map((csp) => String(csp)
              .split(/;\s*/)
              .filter((d) => {
                const l = d.trim().toLowerCase();
                return !l.startsWith('frame-ancestors');
              })
              .join('; '))
            .filter((v) => v.trim().length > 0);
          if (cleaned.length === 0) delete responseHeaders[key];
          else responseHeaders[key] = cleaned;
        } else if (lk === 'x-frame-options') {
          delete responseHeaders[key];
        }
      }
    }

    // CSP is served by Cloudflare Pages (same bundle web users load): the
    // <meta http-equiv="Content-Security-Policy"> in index.html is the single
    // source of truth for both web and Electron renderers. The only header
    // rewrite we need is stripping frame-blocking headers from third-party embed
    // hosts so their iframes render inside the app.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType !== 'subFrame') return callback({});
      try {
        const reqHost = new URL(details.url).hostname;
        if (isEmbedHost(reqHost)) {
          const responseHeaders = { ...details.responseHeaders };
          stripFrameBlockingHeaders(responseHeaders);
          callback({ responseHeaders });
          return;
        }
      } catch { /* malformed URL — pass through */ }
      callback({});
    });
  }

  // Periodic HTTP cache cleanup. clearCache() only removes the HTTP disk cache —
  // NOT cookies, localStorage, IndexedDB, or any user data — so it's safe to call
  // periodically.
  session.defaultSession.clearCache().catch(() => {});
  // Clear HTTP disk cache once per day. The disk-cache-size flag (250MB) bounds
  // growth between clears; 24h keeps a warm cache for repeated asset loads.
  trackedSetInterval(() => {
    session.defaultSession.clearCache().catch(() => {});
  }, 24 * 60 * 60 * 1000);

  // Linux non-AppImage builds (.deb, .rpm, tarball) have no auto-update feed.
  // AppImage sets process.env.APPIMAGE when launched from the bundle.
  const isLinuxNoAutoUpdate = process.platform === 'linux' && !process.env.APPIMAGE;

  if (app.isPackaged && !isLinuxNoAutoUpdate) {
    // Production (Windows/macOS/AppImage): show the loading/update-check modal,
    // then load the main app.
    win.loadFile(path.join(__dirname, 'update-screen.html'));
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) {
        win.webContents.send('update-checking');
        autoUpdater.checkForUpdatesAndNotify().catch(() => {
          if (!win.isDestroyed()) win.webContents.send('update-error', 'Check failed');
        });
      }
    });

    // Safety timeout — never block startup longer than 5 seconds
    const updateCheckHandler = () => {
      clearTimeout(startupTimeout);
      if (mainWindow && !mainWindow.isDestroyed()) loadMainApp(mainWindow);
    };
    ipcMain.once('update-check-complete', updateCheckHandler);

    const startupTimeout = setTimeout(() => {
      ipcMain.removeListener('update-check-complete', updateCheckHandler);
      if (mainWindow && !mainWindow.isDestroyed()) loadMainApp(mainWindow);
    }, 5000);

    win.once('closed', () => {
      ipcMain.removeListener('update-check-complete', updateCheckHandler);
      clearTimeout(startupTimeout);
    });
  } else if (app.isPackaged && isLinuxNoAutoUpdate) {
    // Linux non-AppImage: updates are managed by the OS package manager.
    // Skip the update screen entirely and go straight to the main app.
    console.log('[main] Linux non-AppImage build — skipping update check');
    loadMainApp(win);
  } else {
    // Dev mode — skip update screen, load app directly
    loadMainApp(win);
  }

  let failLoadRetries = 0;
  const MAX_FAIL_RETRIES = 3;
  // One-shot guard: arm the throttling-enable timer once per window lifetime —
  // repeated did-finish-load events (HashRouter SPA reloads, Cloudflare Access
  // OTP round-trip, etc.) must not restart the timer.
  let throttlingEnableScheduled = false;
  const THROTTLING_ENABLE_DELAY_MS = 10_000;

  win.webContents.on('did-finish-load', () => {
    failLoadRetries = 0;
    win.webContents.send('window-maximized-change', win.isMaximized());

    // Re-enable backgroundThrottling once the renderer is past initial mount.
    // Deferred because CalculateNativeWinOcclusion + backgroundThrottling=true
    // would throttle JS to ~1Hz if the window was occluded during the file:// →
    // main-app navigation, hanging mount. Arms only on the main app (not the
    // local update/repair screens) and only once per window — voice-session-state
    // IPC still overrides during calls.
    if (!throttlingEnableScheduled && isMainAppUrl(win.webContents.getURL())) {
      throttlingEnableScheduled = true;
      setTimeout(() => {
        if (win.isDestroyed()) return;
        win.webContents.setBackgroundThrottling(true);
      }, THROTTLING_ENABLE_DELAY_MS);
    }
  });

  // Inject a thin draggable strip atop any non-app page (e.g. the Cloudflare
  // Access OTP gate) so the user can move/close the window while it's on an
  // origin we don't control. Controls dispatch via sentinel `howl-ui://` URLs
  // intercepted in will-navigate.
  win.webContents.on('did-navigate', (_event, url) => {
    try {
      const u = new URL(url);
      const origin = `${u.protocol}//${u.host}`;
      const isAppOrigin = origin === PACKAGED_RENDERER_URL
        || url.startsWith('http://localhost')
        || url.startsWith('https://localhost')
        || url.startsWith('http://127.0.0.1');
      if (isAppOrigin) return;
    } catch { return; }

    const script = `
      (() => {
        if (document.getElementById('__howl_drag_strip')) return;
        const bar = document.createElement('div');
        bar.id = '__howl_drag_strip';
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:28px;z-index:2147483647;background:rgba(2,6,23,0.92);display:flex;align-items:stretch;font-family:-apple-system,"Segoe UI",system-ui,sans-serif;';
        bar.style.setProperty('-webkit-app-region', 'drag');
        const label = document.createElement('div');
        label.textContent = 'HOWL';
        label.style.cssText = 'flex:1;padding-left:16px;color:rgba(226,232,240,0.7);font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;display:flex;align-items:center;';
        bar.appendChild(label);
        const ctrls = document.createElement('div');
        ctrls.style.cssText = 'display:flex;align-items:stretch;';
        ctrls.style.setProperty('-webkit-app-region', 'no-drag');
        const mkBtn = (sym, title, action, hoverBg) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.title = title;
          b.innerHTML = sym;
          b.style.cssText = 'width:40px;height:28px;border:none;background:transparent;color:rgba(226,232,240,0.8);cursor:pointer;font-family:inherit;font-size:12px;display:flex;align-items:center;justify-content:center;';
          b.style.setProperty('-webkit-app-region', 'no-drag');
          b.addEventListener('mouseenter', () => { b.style.background = hoverBg; b.style.color = '#fff'; });
          b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; b.style.color = 'rgba(226,232,240,0.8)'; });
          b.addEventListener('click', () => { location.href = 'howl-ui://' + action; });
          return b;
        };
        ctrls.appendChild(mkBtn('&#8722;', 'Minimize', 'min', 'rgba(255,255,255,0.1)'));
        ctrls.appendChild(mkBtn('&#9633;', 'Maximize', 'max', 'rgba(255,255,255,0.1)'));
        ctrls.appendChild(mkBtn('&#10005;', 'Close', 'close', 'rgb(239,68,68)'));
        bar.appendChild(ctrls);
        document.documentElement.appendChild(bar);
        const pad = document.createElement('style');
        pad.textContent = 'body{padding-top:28px !important;}';
        document.head.appendChild(pad);
      })();
    `;
    win.webContents.executeJavaScript(script, true).catch(() => {});
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    // CRITICAL: only retry MAIN-FRAME failures. Sub-frame (iframe) failures are
    // common and benign (Twitch/YouTube embeds blocked by their own
    // frame-ancestors); without this guard every blocked embed triggered a full
    // app reload, cascading into multi-second freezes that looked like crashes.
    // ABORT (-3) is also benign — the navigation was intentionally cancelled.
    if (!isMainFrame) return;
    if (errorCode === -3) return;
    console.error(`[main] Main-frame failed to load: ${errorCode} ${errorDescription}`);
    if (app.isPackaged && failLoadRetries < MAX_FAIL_RETRIES) {
      failLoadRetries++;
      const delay = 1000 * Math.pow(2, failLoadRetries - 1);
      console.log(`[main] Retrying main-frame load (${failLoadRetries}/${MAX_FAIL_RETRIES}) in ${delay}ms`);
      setTimeout(() => win.loadURL(`${PACKAGED_RENDERER_URL}${ELECTRON_ENTRY_PATH}`), delay);
    }
  });

  const sendMaximized = () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window-maximized-change', win.isMaximized());
    }
  };
  win.on('maximize', sendMaximized);
  win.on('unmaximize', sendMaximized);

  const sendFullscreen = () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window-fullscreen-change', win.isFullScreen());
    }
  };
  win.on('enter-full-screen', sendFullscreen);
  win.on('leave-full-screen', sendFullscreen);

  win.on('closed', () => {
    mainWindow = null;
  });
}

// Overlay window creation (on-demand only)

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return;

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.bounds;

  const overlayPreloadPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'overlayPreload.js')
    : path.join(__dirname, 'overlayPreload.js');

  overlayWindow = new BrowserWindow({
    x: 0,
    y: 0,
    width,
    height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: overlayPreloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: true,
      devTools: !app.isPackaged,
    },
  });

  if (app.isPackaged) {
    overlayWindow.webContents.on('devtools-opened', () => { overlayWindow.webContents.closeDevTools(); });
  }

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.setFocusable(false);

  if (app.isPackaged) {
    overlayWindow.loadURL(`${PACKAGED_RENDERER_URL}/overlay.html`);
  } else {
    const devUrl = process.env.VITE_DEV_URL || 'http://localhost:3000';
    overlayWindow.loadURL(`${devUrl}/overlay.html`).catch(() => {
      overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
    });
  }

  // Prevent navigation, window opens, and DevTools from overlay (defense-in-depth)
  overlayWindow.webContents.on('devtools-opened', () => {
    if (app.isPackaged) overlayWindow.webContents.closeDevTools();
  });
  overlayWindow.webContents.on('will-navigate', (event) => { event.preventDefault(); });
  overlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  overlayWindow.webContents.on('did-finish-load', () => {
    overlayWindow.webContents.setFrameRate(30);
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

// IPC handlers — registered once at app level (not per-window)

// Spellcheck IPC. Renderer pushes the user's selected languages (from
// accessibility settings) on boot and whenever the picker changes; default
// fallback is app.getLocale(). Chromium loads Hunspell dictionaries on demand.
// `availableSpellCheckerLanguages` lists locales Chromium has dictionaries for
// (~50 languages, no CJK — see
// https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries).
ipcMain.handle('spellcheck:get-available-languages', () => {
  try {
    return session.defaultSession.availableSpellCheckerLanguages ?? [];
  } catch {
    return [];
  }
});
ipcMain.handle('spellcheck:get-languages', () => {
  try {
    return session.defaultSession.getSpellCheckerLanguages?.() ?? [];
  } catch {
    return [];
  }
});
ipcMain.handle('spellcheck:set-languages', (_e, languages) => {
  if (!Array.isArray(languages)) return false;
  // Filter to known-available locales so a stale localStorage entry can't
  // crash the spellchecker. setSpellCheckerLanguages throws on unknown codes.
  let available = [];
  try { available = session.defaultSession.availableSpellCheckerLanguages ?? []; } catch { /* */ }
  const filtered = languages.filter((l) => typeof l === 'string' && available.includes(l));
  if (filtered.length === 0) return false;
  try {
    session.defaultSession.setSpellCheckerLanguages(filtered);
    return true;
  } catch { return false; }
});
ipcMain.on('spellcheck:add-to-dictionary', (_e, word) => {
  if (typeof word !== 'string' || !word) return;
  try { session.defaultSession.addWordToSpellCheckerDictionary?.(word); } catch { /* */ }
});
ipcMain.on('spellcheck:replace-misspelling', (_e, word) => {
  if (typeof word !== 'string' || !mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.replaceMisspelling(word); } catch { /* */ }
});

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});
ipcMain.on('window-close', () => mainWindow?.close());
ipcMain.on('window-fullscreen', (_e, enabled) => {
  if (!mainWindow) return;
  mainWindow.setFullScreen(!!enabled);
});
ipcMain.on('restart-for-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

// Dynamic backgroundThrottling: renderer reports voice/call session state.
// Throttling is disabled only while a voice channel or DM call is active so
// audio/video streams are never starved. Re-enabled when the session ends to
// save CPU when the window is backgrounded.
ipcMain.on('voice-session-state', (_e, active) => {
  const throttle = !active;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.setBackgroundThrottling(throttle);
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.setBackgroundThrottling(throttle);
  }
});

ipcMain.on('repair-clear-cache', async () => {
  try {
    const ses = session.defaultSession;
    await ses.clearCache();
    await ses.clearStorageData({ storages: ['localstorage', 'cachestorage'] });
  } catch (e) {
    console.error('[repair] Failed to clear cache:', e.message);
  }
  app.relaunch();
  app.exit(0);
});

ipcMain.on('repair-reinstall', () => {
  shell.openExternal('https://howlpro.com/download');
});

ipcMain.on('check-for-update', () => {
  if (!app.isPackaged) return;
  // Linux non-AppImage: no auto-update feed available
  if (process.platform === 'linux' && !process.env.APPIMAGE) return;
  autoUpdater.checkForUpdatesAndNotify().catch(err => {
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) w.webContents.send('update-error', err?.message || 'check failed');
    });
  });
});

// Notification rate limiting — max 5 per 10 seconds, then coalesce.
// Uses a (count, windowStart) tuple instead of an array of timestamps to avoid
// repeated shift() allocations in hot paths.
const NOTIF_RATE_LIMIT = 5;
const NOTIF_RATE_WINDOW = 10000;
let _notifCount = 0;
let _notifWindowStart = 0;

ipcMain.on('show-notification', (_event, data) => {
  if (!Notification.isSupported()) return;
  const title = typeof data?.title === 'string' ? data.title.slice(0, 256) : '';
  const body = typeof data?.body === 'string' ? data.body.slice(0, 1024) : '';
  if (!title) return;

  const now = Date.now();
  // Reset window if expired
  if (now - _notifWindowStart > NOTIF_RATE_WINDOW) {
    _notifCount = 0;
    _notifWindowStart = now;
  }
  if (_notifCount >= NOTIF_RATE_LIMIT) return;
  _notifCount++;
  new Notification({ title, body }).show();
});

const GPU_VENDOR_NAMES = { '0x10de': 'NVIDIA', '0x1002': 'AMD', '0x8086': 'Intel', '0x106b': 'Apple' };

// OS-keychain envelope for sensitive renderer data (E2E remembered passphrase,
// future consumers). Expose only encrypt/decrypt — never the raw keychain, never
// a way to list/enumerate entries.
ipcMain.handle('safestorage:is-available', async () => {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
});
ipcMain.handle('safestorage:encrypt', async (_event, plaintext) => {
  if (typeof plaintext !== 'string' || plaintext.length === 0 || plaintext.length > 4096) {
    throw new Error('invalid plaintext');
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable');
  return safeStorage.encryptString(plaintext).toString('base64');
});
ipcMain.handle('safestorage:decrypt', async (_event, ciphertextB64) => {
  if (typeof ciphertextB64 !== 'string' || ciphertextB64.length === 0 || ciphertextB64.length > 8192) {
    throw new Error('invalid ciphertext');
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable');
  return safeStorage.decryptString(Buffer.from(ciphertextB64, 'base64'));
});

ipcMain.handle('set-force-sw-encode', async (_event, enabled) => {
  try {
    fs.writeFileSync(swEncodeFlagPath, JSON.stringify({ enabled: !!enabled }));
    return true;
  } catch { return false; }
});

ipcMain.handle('clear-cache', async () => {
  await session.defaultSession.clearCache();
  return { success: true };
});

// 256 MB cap on the base64 payload: without it a compromised renderer could push
// a multi-GB string through IPC, and `Buffer.from(…, 'base64')` would materialize
// the full binary in main-process memory before the user even sees the save
// dialog. Applied pre-allocation so oversize payloads fail cheap.
const DOWNLOAD_BLOB_MAX_BYTES = 256 * 1024 * 1024;

ipcMain.handle('download-blob', async (_event, base64Data, suggestedName) => {
  if (typeof base64Data !== 'string' || typeof suggestedName !== 'string') return false;
  if (base64Data.length > DOWNLOAD_BLOB_MAX_BYTES) return false;
  const name = suggestedName.slice(0, 255).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'download';
  try {
    const { canceled, filePath } = await require('electron').dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('downloads'), name),
      filters: [{ name: 'All Files', extensions: ['*'] }],
    });
    if (canceled || !filePath) return false;
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filePath, buffer);
    return true;
  } catch (e) {
    console.error('[download-blob] Failed:', e?.message || e);
    return false;
  }
});

ipcMain.handle('get-gpu-info', async () => {
  try {
    const info = await app.getGPUInfo('basic');
    const devices = info?.gpuDevice ?? [];
    const primary = devices.find(d => d.active) || devices[0];
    if (!primary) return { vendor: 'Unknown', name: 'No GPU detected', vendorId: null };
    const vid = `0x${primary.vendorId?.toString(16).padStart(4, '0')}`;
    return {
      vendor: GPU_VENDOR_NAMES[vid] || 'Unknown',
      name: primary.driverVendor || 'GPU',
      vendorId: primary.vendorId,
      deviceId: primary.deviceId,
      driverVersion: primary.driverVersion || null,
    };
  } catch {
    return { vendor: 'Unknown', name: 'Detection unavailable', vendorId: null };
  }
});

ipcMain.handle('get-build-date', () => BUILD_DATE);

ipcMain.handle('get-desktop-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  return sources.map(s => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    appIcon: s.appIcon?.toDataURL() ?? null,
    display_id: s.display_id,
  }));
});

// Game detection scanner

/** @type {GameScanner | null} */
let gameScanner = null;

function loadGameDatabase() {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'app.asar.unpacked', 'public', 'game-database.json'),
        path.join(__dirname, 'public', 'game-database.json'),
      ]
    : [path.join(__dirname, 'public', 'game-database.json')];

  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      const db = JSON.parse(raw);
      if (!db || typeof db !== 'object' || typeof db.version !== 'number' || !db.games || typeof db.games !== 'object') {
        console.warn('[game-scanner] Invalid game database schema, skipping:', candidate);
        continue;
      }
      return db.games;
    } catch { /* try next candidate */ }
  }
  console.warn('[game-scanner] No valid game database found');
  return null;
}

function setupGameScanner() {
  const games = loadGameDatabase();
  if (!games) return;

  const intervalMs = Math.max(5000, parseInt(process.env.HOWL_GAME_SCAN_INTERVAL || '15000', 10) || 15000);
  gameScanner = new GameScanner(games);

  gameScanner.startScanning((game) => {
    BrowserWindow.getAllWindows().forEach((w) => {
      if (w.isDestroyed()) return;
      if (game) {
        w.webContents.send('game-activity-detected', game);
      } else {
        w.webContents.send('game-activity-cleared');
      }
    });

    // Overlay visibility: track game state; show overlay only when main window is not focused
    currentGame = game ?? null;
    if (game && overlayWindow && !overlayWindow.isDestroyed()) {
      const howlFocused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
      if (!howlFocused) overlayWindow.showInactive();
      overlayWindow.webContents.send('overlay-game-detected', game);
    }
    if (!game && overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('overlay-game-cleared');
      overlayWindow.hide();
    }
  }, intervalMs);
}

ipcMain.handle('get-detected-game', async () => {
  return gameScanner?.currentGame ?? null;
});

ipcMain.handle('set-game-detection-enabled', async (_event, enabled) => {
  if (typeof enabled !== 'boolean') return;
  if (gameScanner) gameScanner.enabled = enabled;
});

ipcMain.handle('get-running-processes', async () => {
  return gameScanner?.getRunningProcesses() ?? [];
});

ipcMain.handle('add-custom-game', async (_event, game) => {
  if (!game || typeof game.exeName !== 'string' || typeof game.displayName !== 'string') return;
  // Cap custom games to prevent unbounded memory growth from renderer
  if (gameScanner && gameScanner.getCustomGames().length >= 100) return;
  gameScanner?.addCustomGame(game.exeName, game.displayName);
});

ipcMain.handle('remove-custom-game', async (_event, exeName) => {
  if (typeof exeName !== 'string') return;
  gameScanner?.removeCustomGame(exeName);
});

ipcMain.handle('get-custom-games', async () => {
  return gameScanner?.getCustomGames() ?? [];
});

// Overlay IPC

ipcMain.on('overlay-toggle-lock', (_event, locked) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (locked) {
    overlayWindow.setIgnoreMouseEvents(false);
    overlayWindow.setFocusable(true);
    overlayWindow.focus();
  } else {
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.setFocusable(false);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
  }
});

ipcMain.on('overlay-show', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.showInactive();
  }
});

ipcMain.on('overlay-hide', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
  }
});

ipcMain.on('overlay-update-voice', (_event, data) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-voice-update', data);
  }
});

ipcMain.on('overlay-update-notifications', (_event, data) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-notification', data);
  }
});

ipcMain.on('overlay-update-settings', (_event, settings) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-settings-changed', settings);
  }
});

const OVERLAY_TO_MAIN_ALLOWED = new Set([
  'send-message',
  'switch-channel',
  'switch-server',
]);

ipcMain.on('overlay-to-main', (_event, channel, ...args) => {
  if (!OVERLAY_TO_MAIN_ALLOWED.has(channel)) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlay-to-main', channel, ...args);
  }
});

ipcMain.on('overlay-update-servers', (_event, data) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-servers-update', data);
  }
});

ipcMain.on('overlay-update-messages', (_event, data) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-messages-update', data);
  }
});

ipcMain.on('overlay-update-unreads', (_event, data) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-unreads-update', data);
  }
});

ipcMain.on('overlay-set-enabled', (_event, enabled) => {
  if (enabled) {
    createOverlayWindow();
  } else {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.close();
      overlayWindow = null;
    }
  }
});

// Spotify local detection

/** @type {SpotifyDetector | null} */
let spotifyDetector = null;

function setupSpotifyDetector() {
  const intervalMs = Math.max(3000, parseInt(process.env.HOWL_SPOTIFY_DETECT_INTERVAL || '5000', 10) || 5000);
  spotifyDetector = new SpotifyDetector();

  spotifyDetector.startDetecting((track) => {
    BrowserWindow.getAllWindows().forEach((w) => {
      if (w.isDestroyed()) return;
      if (track) {
        w.webContents.send('spotify-activity-detected', track);
      } else {
        w.webContents.send('spotify-activity-cleared');
      }
    });
  }, intervalMs);
}

ipcMain.handle('get-detected-spotify', async () => {
  return spotifyDetector?.currentTrack ?? null;
});

ipcMain.handle('set-spotify-detection-enabled', async (_event, enabled) => {
  if (typeof enabled !== 'boolean') return;
  if (spotifyDetector) spotifyDetector.enabled = enabled;
});

// Auto updater

// Persists update state so the React app can hydrate missed events
const _updateState = { available: null, downloaded: null };

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  // Linux non-AppImage builds (.deb, .rpm, tarball) rely on the OS package
  // manager for updates — no electron-updater feed is published for them.
  if (process.platform === 'linux' && !process.env.APPIMAGE) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.forceDevUpdateConfig = false; // Never bypass signature verification
  autoUpdater.logger = null;

  // Override feed URL to a public custom domain, not the authenticated S3
  // endpoint. The package.json S3 publish config is BUILD-time (uploading
  // releases); at RUNTIME the updater reads the public domain (no credentials).
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: 'https://releases.howlpro.com',
  });

  autoUpdater.on('checking-for-update', () => console.log('[updater] Checking for update...'));
  autoUpdater.on('update-available', (info) => {
    console.log('[updater] Update available:', info.version);
    _updateState.available = info.version;
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) w.webContents.send('update-available', info.version);
    });
  });
  autoUpdater.on('update-not-available', () => {
    console.log('[updater] App is up to date.');
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) w.webContents.send('update-not-available');
    });
  });
  autoUpdater.on('download-progress', (p) => {
    console.log(`[updater] Downloading ${Math.round(p.percent)}%`);
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) w.webContents.send('update-download-progress', Math.round(p.percent));
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] Update downloaded:', info.version);
    _updateState.downloaded = info.version;
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) w.webContents.send('update-downloaded', info.version);
    });
  });
  autoUpdater.on('error', (err) => {
    // Log full error to the main-process console only — never expose internal
    // paths, S3 URLs, or network details to the renderer.
    console.error('[updater] Error:', err?.message || err);
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) w.webContents.send('update-error', 'Update check failed');
    });
  });

  // Initial check is now triggered by the update screen flow in createWindow().
  // Re-check periodically (every 4 hours)
  trackedSetInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }, 4 * 60 * 60 * 1000);
}

// Returns update events that fired before the React app mounted, closing the gap
// where the update screen consumes events during startup.
ipcMain.handle('get-update-status', () => ({
  available: _updateState.available,
  downloaded: _updateState.downloaded,
}));

// SSO system browser — RFC 8252 compliant (no embedded views)

// Lazy cleanup interval for SSO nonces: starts when the map becomes non-empty,
// stops when all nonces are consumed/expired — avoids a permanent 60s interval
// running when no SSO flow is in progress.
let _ssoCleanupInterval = null;

function startSsoCleanupIfNeeded() {
  if (_ssoCleanupInterval || pendingSsoNonces.size === 0) return;
  _ssoCleanupInterval = trackedSetInterval(() => {
    const now = Date.now();
    for (const [nonce, data] of pendingSsoNonces) {
      if (now - data.timestamp > NONCE_TTL_MS) pendingSsoNonces.delete(nonce);
    }
    if (pendingSsoNonces.size === 0 && _ssoCleanupInterval) {
      clearInterval(_ssoCleanupInterval);
      _intervals.delete(_ssoCleanupInterval);
      _ssoCleanupInterval = null;
    }
  }, 60_000);
}

const SSO_PROVIDERS = ['google', 'apple', 'steam'];
const APP_PROVIDERS = ['spotify', 'riot', 'epic', 'twitch', 'youtube', 'github', 'reddit'];

function generateNonce() {
  const nonce = crypto.randomBytes(16).toString('hex');
  // Evict oldest if at cap
  if (pendingSsoNonces.size >= MAX_PENDING_NONCES) {
    const oldest = pendingSsoNonces.keys().next().value;
    pendingSsoNonces.delete(oldest);
  }
  return nonce;
}

function readReleaseConfig() {
  let backendUrl = '';
  try {
    const rcPath = path.join(__dirname, 'release-config.json');
    const rcFallback = path.join(__dirname, 'release-config.example.json');
    const rcFile = fs.existsSync(rcPath) ? rcPath : rcFallback;
    const rc = JSON.parse(fs.readFileSync(rcFile, 'utf8'));
    backendUrl = rc.BACKEND_URL || '';
  } catch { /* ignore */ }
  if (!backendUrl) backendUrl = 'https://api.howlpro.com';
  return { backendUrl };
}

function getFrontendOrigin() {
  try {
    const rcPath = path.join(__dirname, 'release-config.json');
    const rcFallback = path.join(__dirname, 'release-config.example.json');
    const rcFile = fs.existsSync(rcPath) ? rcPath : rcFallback;
    const rc = JSON.parse(fs.readFileSync(rcFile, 'utf8'));
    if (rc.FRONTEND_ORIGIN) return rc.FRONTEND_ORIGIN;
  } catch { /* ignore */ }
  return 'https://app.howlpro.com';
}

function handleSsoSystemBrowser(provider, mode, extraParams = {}) {
  const allowedProviders = mode === 'app' ? APP_PROVIDERS : SSO_PROVIDERS;
  if (!allowedProviders.includes(provider)) return;

  const nonce = generateNonce();
  pendingSsoNonces.set(nonce, { provider, mode, timestamp: Date.now() });
  startSsoCleanupIfNeeded();

  const { backendUrl } = readReleaseConfig();
  const params = new URLSearchParams({ platform: 'electron', nonce, ...extraParams });

  let url;
  if (mode === 'login') {
    url = `${backendUrl}/api/auth/sso/${encodeURIComponent(provider)}?${params}`;
  } else if (mode === 'link') {
    url = `${backendUrl}/api/auth/sso/${encodeURIComponent(provider)}?${params}`;
  } else if (mode === 'app') {
    // Connected app OAuth (Spotify, Twitch, etc.)
    url = `${backendUrl}/api/v1/connected-apps/${encodeURIComponent(provider)}/connect?${params}`;
  } else {
    return;
  }

  shell.openExternal(url);
}

ipcMain.on('start-sso', (_event, provider) => {
  if (typeof provider !== 'string') return;
  handleSsoSystemBrowser(provider, 'login');
});

ipcMain.on('start-sso-link', (_event, data) => {
  if (!data || typeof data.provider !== 'string') return;
  const extra = {};
  if (data.linkToken) extra.link_token = data.linkToken;
  handleSsoSystemBrowser(data.provider, 'link', extra);
});

ipcMain.on('start-app-connect', (_event, data) => {
  if (!data || typeof data.provider !== 'string') return;
  const extra = {};
  if (data.connectToken) extra.connect_token = data.connectToken;
  handleSsoSystemBrowser(data.provider, 'app', extra);
});

ipcMain.on('start-passkey-login', () => {
  const nonce = generateNonce();
  pendingSsoNonces.set(nonce, { provider: 'passkey', mode: 'login', timestamp: Date.now() });
  startSsoCleanupIfNeeded();
  const url = `${getFrontendOrigin()}/auth/passkey-login?nonce=${nonce}`;
  shell.openExternal(url);
});

ipcMain.handle('start-passkey-mfa', async (_event, mfaToken) => {
  if (typeof mfaToken !== 'string' || mfaToken.length > 2048) return;
  try {
    // Create server-side session — mfaToken never touches a URL
    const { backendUrl } = readReleaseConfig();
    const res = await fetch(`${backendUrl}/api/auth/mfa/passkey/create-mfa-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfaToken }),
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });
    if (!res.ok) return;
    const { sessionId } = await res.json();

    const nonce = generateNonce();
    pendingSsoNonces.set(nonce, { provider: 'passkey-mfa', mode: 'login', timestamp: Date.now() });
    startSsoCleanupIfNeeded();
    const url = `${getFrontendOrigin()}/auth/passkey-mfa?session=${encodeURIComponent(sessionId)}&nonce=${nonce}`;
    shell.openExternal(url);
  } catch (err) {
    console.error('[main] Failed to create MFA session:', err?.message || err);
  }
});

ipcMain.handle('start-passkey-register', async (_event, sessionToken) => {
  if (typeof sessionToken !== 'string') return;
  const nonce = generateNonce();
  pendingSsoNonces.set(nonce, { provider: 'passkey', mode: 'register', timestamp: Date.now() });
  startSsoCleanupIfNeeded();
  const url = `${getFrontendOrigin()}/auth/passkey-register?session=${encodeURIComponent(sessionToken)}&nonce=${nonce}`;
  shell.openExternal(url);
});

// System tray icon

function createTray() {
  const iconPath = getIconPath();
  if (!fs.existsSync(iconPath)) return;
  const icon = nativeImage.createFromPath(iconPath);
  // Resize for tray (16x16 on Windows/Linux, 22x22 on macOS)
  const trayIcon = process.platform === 'darwin'
    ? icon.resize({ width: 22, height: 22 })
    : icon.resize({ width: 16, height: 16 });

  tray = new Tray(trayIcon);
  tray.setToolTip('Howl');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Howl',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
          if (process.platform === 'darwin' && app.dock) app.dock.show();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Howl',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Left-click: toggle show/hide (Windows/Linux behavior)
  // macOS: click on tray icon shows context menu by default
  if (process.platform !== 'darwin') {
    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    });
  }
}

// Close action modal IPC

ipcMain.on('close-action-chosen', (_event, data) => {
  if (!data || typeof data !== 'object') return;
  const { action, remember } = data;
  if (action !== 'tray' && action !== 'quit') return;

  if (remember) {
    appSettings.closeAction = action;
    saveAppSettings(appSettings);
  }

  if (action === 'tray') {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
      if (process.platform === 'darwin' && app.dock) app.dock.hide();
    }
  } else {
    isQuitting = true;
    app.quit();
  }
});

// App settings IPC (renderer read/write close behavior)

ipcMain.handle('get-app-settings', async () => {
  return { ...appSettings };
});

ipcMain.handle('set-app-settings', async (_event, newSettings) => {
  if (typeof newSettings !== 'object' || newSettings === null) return { ...appSettings };
  if (typeof newSettings.closeAction === 'string' && ['ask', 'tray', 'quit'].includes(newSettings.closeAction)) {
    appSettings.closeAction = newSettings.closeAction;
  }
  if (typeof newSettings.startMinimized === 'boolean') appSettings.startMinimized = newSettings.startMinimized;
  if (typeof newSettings.streamdeckAllowMobile === 'boolean') appSettings.streamdeckAllowMobile = newSettings.streamdeckAllowMobile;
  saveAppSettings(appSettings);
  return { ...appSettings };
});

ipcMain.handle('streamdeck:set-enabled', async (_e, enabled) => {
  appSettings = { ...appSettings, streamdeckEnabled: !!enabled };
  saveAppSettings(appSettings);
  if (enabled && !streamdeck.isRunning()) {
    await streamdeck.boot({
      userDataDir: app.getPath('userData'),
      appVersion: app.getVersion(),
      getMainWindow: () => mainWindow,
    });
  } else if (!enabled && streamdeck.isRunning()) {
    await streamdeck.shutdown(app.getPath('userData'));
  }
  return { ok: true, running: streamdeck.isRunning() };
});

// Autostart IPC (launch at login)

ipcMain.handle('autostart:get', () => {
  try { return getAutostartState(); } catch { return { enabled: false, startHidden: false }; }
});

ipcMain.on('autostart:set', (_event, payload) => {
  if (!payload || typeof payload !== 'object') return;
  const enabled = !!payload.enabled;
  const startHidden = !!payload.startHidden;
  try { setAutostartState(enabled, startHidden); } catch { /* swallow — renderer gets refreshed state on next get */ }
});

// Badge count IPC (unread notifications on tray/dock)

// Cache decoded nativeImage instances keyed by data URL. ~11 badge states (empty
// + 1-9 + 9+), so 32 is generous headroom. LRU-by-insertion-order eviction.
const BADGE_IMG_CACHE_MAX = 32;
const _badgeImageCache = new Map();

function getBadgeImage(dataUrl) {
  const cached = _badgeImageCache.get(dataUrl);
  if (cached) {
    // LRU touch: move to end of iteration order
    _badgeImageCache.delete(dataUrl);
    _badgeImageCache.set(dataUrl, cached);
    return cached;
  }
  const img = nativeImage.createFromDataURL(dataUrl);
  // Evict oldest if at capacity
  if (_badgeImageCache.size >= BADGE_IMG_CACHE_MAX) {
    const oldest = _badgeImageCache.keys().next().value;
    if (oldest !== undefined) _badgeImageCache.delete(oldest);
  }
  _badgeImageCache.set(dataUrl, img);
  return img;
}

ipcMain.on('set-badge-count', (_event, count, options) => {
  const n = Math.max(0, Math.min(Number(count) || 0, 99999));
  const overlayPng = options && typeof options === 'object' && typeof options.overlayPng === 'string'
    ? options.overlayPng : null;
  const taskbarFlash = options && typeof options === 'object' && typeof options.taskbarFlash === 'boolean'
    ? options.taskbarFlash : true;

  // macOS — dock badge (text). Cap at "9+" to match the Windows overlay: the
  // bubble is small, so a single digit or "9+" reads instantly while "47"/"132"
  // is visual noise.
  if (process.platform === 'darwin' && app.dock) {
    const badgeLabel = n > 0 ? (n > 9 ? '9+' : String(n)) : '';
    app.dock.setBadge(badgeLabel);
  }

  // Windows — taskbar overlay icon (number circle) + optional flashFrame
  if (process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
    if (n > 0 && overlayPng) {
      try {
        const img = getBadgeImage(overlayPng);
        if (!img.isEmpty()) {
          // Accessibility tooltip carries the real count — screen readers read
          // this description, not the rendered pixel text.
          const label = n === 1 ? '1 unread mention' : `${n} unread mentions`;
          mainWindow.setOverlayIcon(img, label);
        } else {
          mainWindow.setOverlayIcon(null, '');
        }
      } catch {
        mainWindow.setOverlayIcon(null, '');
      }
    } else {
      mainWindow.setOverlayIcon(null, '');
    }
    if (taskbarFlash) {
      mainWindow.flashFrame(n > 0 && !mainWindow.isFocused());
    } else {
      mainWindow.flashFrame(false);
    }
  }

  // Linux — Unity launcher badge
  if (process.platform === 'linux' && typeof app.setBadgeCount === 'function') {
    app.setBadgeCount(n);
  }

  if (tray && !tray.isDestroyed()) {
    tray.setToolTip(n > 0 ? `Howl (${n} unread)` : 'Howl');
  }
});

// Open external URL IPC (Stripe billing portal/checkout)

const ALLOWED_EXTERNAL_DOMAINS = new Set([
  'checkout.stripe.com',
  'billing.stripe.com',
  'donate.stripe.com', // Stripe-hosted donation pages (homepage Support Us button)
  'buy.stripe.com',    // Stripe Payment Links (used for some gift/donate flows)
]);

ipcMain.handle('open-external', async (_event, url) => {
  if (typeof url !== 'string') return { success: false };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return { success: false };
    if (!ALLOWED_EXTERNAL_DOMAINS.has(parsed.hostname)) return { success: false };
    await shell.openExternal(url);
    return { success: true };
  } catch {
    return { success: false };
  }
});

// Global keybinds IPC

ipcMain.on('keybinds:set', (_e, bindings) => {
  // Validate: array of { actionId: string, combo: string }. Reject malformed
  // input silently — main never fully trusts the renderer.
  if (!Array.isArray(bindings)) return;
  // Hard cap on array length — any real user has at most ~20 bindings.
  if (bindings.length > 100) return;
  const safe = [];
  for (const b of bindings) {
    if (!b || typeof b !== 'object') continue;
    if (typeof b.actionId !== 'string' || typeof b.combo !== 'string') continue;
    // Hard cap on string lengths to block pathological input.
    if (b.combo.length > 100) continue;
    if (b.actionId.length > 80) continue;
    safe.push({ actionId: b.actionId, combo: b.combo });
  }
  globalKeybinds.start(safe);
});

ipcMain.on('keybinds:shutdown', () => {
  globalKeybinds.stop();
});

ipcMain.handle('keybinds:open-macos-accessibility', async () => {
  if (process.platform !== 'darwin') return false;
  try {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    );
    return true;
  } catch {
    return false;
  }
});

// Forward triggers to the focused BrowserWindow's renderer. Never log the
// trigger — not even the action ID — to avoid building a usage-pattern log.
globalKeybinds.onTrigger((trigger) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('keybinds:trigger', trigger);
  }
});

// App lifecycle

// Defense-in-depth: always reject invalid certificates (prevents MITM bypass)
app.on('certificate-error', (_event, _webContents, _url, _error, _certificate, callback) => {
  callback(false);
});

app.whenReady().then(async () => {
  // Strip "Electron/X.Y.Z" and "Howl/X.Y.Z" from the default UA so embed hosts
  // (YouTube, Twitch, Reddit, TikTok, X) that refuse the inline player when they
  // detect Electron get a plain Chrome UA instead. Without this, YouTube's embed
  // shows a "Watch on YouTube" fallback link instead of the inline play button.
  try {
    const originalUa = app.userAgentFallback;
    if (originalUa) {
      const cleaned = originalUa
        .replace(/\s*Howl\/[\d.]+/gi, '')
        .replace(/\s*Electron\/[\d.]+/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      app.userAgentFallback = cleaned;
      session.defaultSession.setUserAgent(cleaned);
    }
  } catch (e) {
    console.warn('[main] Failed to strip Electron from UA:', e.message);
  }

  createWindow();
  createTray();
  setupAutoUpdater();
  setupGameScanner();
  setupSpotifyDetector();

  // Stream Deck bridge (opt-in)
  streamdeck.registerIpc();
  if (appSettings.streamdeckEnabled) {
    try {
      await streamdeck.boot({
        userDataDir: app.getPath('userData'),
        appVersion: app.getVersion(),
        getMainWindow: () => mainWindow,
      });
    } catch (err) {
      console.error('[streamdeck] boot failed:', err && err.message || err);
    }
  }

  // Resize overlay window when display resolution changes
  screen.on('display-metrics-changed', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      const { width, height } = screen.getPrimaryDisplay().bounds;
      overlayWindow.setBounds({ x: 0, y: 0, width, height });
    }
  });

  // Notify renderer on sleep/wake so it can reconnect sockets
  powerMonitor.on('resume', () => {
    globalKeybinds.clearHeldKeys();
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) w.webContents.send('system-resume');
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  // Stream Deck bridge — best-effort async shutdown (fire and forget)
  try { streamdeck.shutdown(app.getPath('userData')).catch(() => {}); } catch { /* best effort */ }

  globalKeybinds.stop();
  isQuitting = true;

  // Stop all scanners/detectors
  if (gameScanner) gameScanner.stopScanning();
  if (spotifyDetector) spotifyDetector.stopDetecting();

  // Clear ALL tracked intervals
  clearAllIntervals();

  // Close all windows
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveWindowState(mainWindow);
  }

  // Destroy tray icon
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
});

app.on('window-all-closed', () => {
  // Don't quit when minimizing to tray — only quit when isQuitting is set
  if (process.platform === 'darwin' || !isQuitting) return;
  app.quit();
});
