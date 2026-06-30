// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// @sentry/electron/preload — sets up an IPC bridge so renderer events flow
// through the main-process Sentry SDK for unified release/session tracking
// and so renderer crashes get bundled with main-process minidumps. Must be
// required at the top of every preload script (per @sentry/electron docs).
try { require('@sentry/electron/preload'); } catch (e) {
  // Sentry preload is optional — log only, don't block app startup
  // eslint-disable-next-line no-console
  console.warn('[preload] @sentry/electron/preload init failed:', e?.message || e);
}

const { contextBridge, ipcRenderer, webFrame } = require('electron');

const validChannels = new Set([
  'window-minimize',
  'window-maximize',
  'window-fullscreen',
  'window-close',
  'restart-for-update',
  'show-notification',
  'overlay-set-enabled',
  'overlay-update-voice',
  'overlay-update-notifications',
  'overlay-update-settings',
  'overlay-update-servers',
  'overlay-update-messages',
  'overlay-update-unreads',
  'check-for-update',
  'repair-clear-cache',
  'repair-reinstall',
  'start-sso',
  'start-sso-link',
  'start-app-connect',
  'start-passkey-login',
  'set-badge-count',
  'close-action-chosen',
  'update-check-complete',
  'autostart:set',
  'voice-session-state',
  'keybinds:set',
  'keybinds:shutdown',
  'streamdeck:pair-decision',
  'streamdeck:push-state',
  'spellcheck:add-to-dictionary',
  'spellcheck:replace-misspelling',
]);

function safeSend(channel, ...args) {
  if (validChannels.has(channel)) ipcRenderer.send(channel, ...args);
}

const validInvokeChannels = new Set([
  'get-build-date',
  'get-gpu-info',
  'set-force-sw-encode',
  'get-detected-game',
  'set-game-detection-enabled',
  'get-running-processes',
  'add-custom-game',
  'remove-custom-game',
  'get-custom-games',
  'get-detected-spotify',
  'set-spotify-detection-enabled',
  'get-desktop-sources',
  'clear-cache',
  'open-external',
  'get-app-settings',
  'set-app-settings',
  'start-passkey-register',
  'start-passkey-mfa',
  'get-update-status',
  'autostart:get',
  'safestorage:encrypt',
  'safestorage:decrypt',
  'safestorage:is-available',
  'download-blob',
  'keybinds:open-macos-accessibility',
  'streamdeck:list-pairings',
  'streamdeck:revoke-pairing',
  'streamdeck:is-running',
  'streamdeck:set-enabled',
  'spellcheck:get-available-languages',
  'spellcheck:get-languages',
  'spellcheck:set-languages',
]);

function safeInvoke(channel, ...args) {
  if (validInvokeChannels.has(channel)) return ipcRenderer.invoke(channel, ...args);
  return Promise.reject(new Error(`Blocked invoke channel: ${channel}`));
}

contextBridge.exposeInMainWorld('__ELECTRON_WINDOW__', true);
contextBridge.exposeInMainWorld('__ELECTRON_PLATFORM__', process.platform);

contextBridge.exposeInMainWorld('electron', {
  minimize: () => safeSend('window-minimize'),
  maximize: () => safeSend('window-maximize'),
  setFullscreen: (enabled) => safeSend('window-fullscreen', !!enabled),
  close: () => safeSend('window-close'),
  isElectron: true,
  platform: process.platform,
  onMaximizedChange: (callback) => {
    const handler = (_e, isMaximized) => callback(isMaximized);
    ipcRenderer.on('window-maximized-change', handler);
    return () => ipcRenderer.removeListener('window-maximized-change', handler);
  },
  onFullscreenChange: (callback) => {
    const handler = (_e, isFull) => callback(isFull);
    ipcRenderer.on('window-fullscreen-change', handler);
    return () => ipcRenderer.removeListener('window-fullscreen-change', handler);
  },
  onUpdateDownloaded: (callback) => {
    const handler = (_e, version) => callback(version);
    ipcRenderer.on('update-downloaded', handler);
    return () => ipcRenderer.removeListener('update-downloaded', handler);
  },
  restartForUpdate: () => safeSend('restart-for-update'),
  onUpdateAvailable: (callback) => {
    const handler = (_event, version) => callback(version);
    ipcRenderer.on('update-available', handler);
    return () => ipcRenderer.removeListener('update-available', handler);
  },
  checkForUpdate: () => safeSend('check-for-update'),
  repairClearCache: () => safeSend('repair-clear-cache'),
  repairReinstall: () => safeSend('repair-reinstall'),
  showNotification: (title, body) => safeSend('show-notification', { title, body }),
  getBuildDate: () => safeInvoke('get-build-date'),
  getGPUInfo: () => safeInvoke('get-gpu-info'),
  setForceSwEncode: (enabled) => safeInvoke('set-force-sw-encode', enabled),
  onSystemResume: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('system-resume', handler);
    return () => ipcRenderer.removeListener('system-resume', handler);
  },
  onUpdateError: (callback) => {
    const handler = (_e, message) => callback(message);
    ipcRenderer.on('update-error', handler);
    return () => ipcRenderer.removeListener('update-error', handler);
  },
  getDetectedGame: () => safeInvoke('get-detected-game'),
  setGameDetectionEnabled: (enabled) => safeInvoke('set-game-detection-enabled', !!enabled),
  onGameActivityDetected: (callback) => {
    const handler = (_e, game) => callback(game);
    ipcRenderer.on('game-activity-detected', handler);
    return () => ipcRenderer.removeListener('game-activity-detected', handler);
  },
  onGameActivityCleared: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('game-activity-cleared', handler);
    return () => ipcRenderer.removeListener('game-activity-cleared', handler);
  },
  getRunningProcesses: () => safeInvoke('get-running-processes'),
  addCustomGame: (game) => safeInvoke('add-custom-game', game),
  removeCustomGame: (exeName) => safeInvoke('remove-custom-game', exeName),
  getCustomGames: () => safeInvoke('get-custom-games'),
  getDesktopSources: () => safeInvoke('get-desktop-sources'),
  getDetectedSpotify: () => safeInvoke('get-detected-spotify'),
  setSpotifyDetectionEnabled: (enabled) => safeInvoke('set-spotify-detection-enabled', !!enabled),
  onSpotifyDetected: (callback) => {
    const handler = (_e, track) => callback(track);
    ipcRenderer.on('spotify-activity-detected', handler);
    return () => ipcRenderer.removeListener('spotify-activity-detected', handler);
  },
  onSpotifyCleared: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('spotify-activity-cleared', handler);
    return () => ipcRenderer.removeListener('spotify-activity-cleared', handler);
  },
  onWindowVisibility: (callback) => {
    const handler = (_e, visible) => callback(visible);
    ipcRenderer.on('window-visibility', handler);
    return () => ipcRenderer.removeListener('window-visibility', handler);
  },
  // Composer spellcheck — main forwards Chromium's context-menu params
  // (suggestions, misspelt word, edit flags) so the renderer can render the
  // Howl-styled menu using native suggestions. Suggestion-replace and
  // add-to-dictionary go back to main so they hit Chromium's
  // replaceMisspelling / addWordToSpellCheckerDictionary APIs (which
  // properly hook into the OS user dictionary).
  spellcheck: {
    onContextMenu: (callback) => {
      const handler = (_e, params) => callback(params);
      ipcRenderer.on('composer-context-menu', handler);
      return () => ipcRenderer.removeListener('composer-context-menu', handler);
    },
    replaceMisspelling: (word) => safeSend('spellcheck:replace-misspelling', word),
    addToDictionary: (word) => safeSend('spellcheck:add-to-dictionary', word),
    getAvailableLanguages: () => safeInvoke('spellcheck:get-available-languages'),
    getLanguages: () => safeInvoke('spellcheck:get-languages'),
    setLanguages: (languages) => safeInvoke('spellcheck:set-languages', languages),
  },
  clearCache: () => safeInvoke('clear-cache'),
  setOverlayEnabled: (enabled) => safeSend('overlay-set-enabled', enabled),
  updateOverlayVoice: (data) => safeSend('overlay-update-voice', data),
  updateOverlayNotifications: (data) => safeSend('overlay-update-notifications', data),
  updateOverlaySettings: (settings) => safeSend('overlay-update-settings', settings),
  updateOverlayServers: (data) => safeSend('overlay-update-servers', data),
  updateOverlayMessages: (data) => safeSend('overlay-update-messages', data),
  updateOverlayUnreads: (data) => safeSend('overlay-update-unreads', data),
  onOverlayToMain: (callback) => {
    const handler = (_e, channel, ...args) => callback(channel, ...args);
    ipcRenderer.on('overlay-to-main', handler);
    return () => ipcRenderer.removeListener('overlay-to-main', handler);
  },
  onDeepLink: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('deep-link', handler);
    return () => ipcRenderer.removeListener('deep-link', handler);
  },
  startSso: (provider) => safeSend('start-sso', provider),
  startSsoLink: (data) => safeSend('start-sso-link', data),
  startAppConnect: (data) => safeSend('start-app-connect', data),
  startPasskeyLogin: () => safeSend('start-passkey-login'),
  startPasskeyMfa: (mfaToken) => safeInvoke('start-passkey-mfa', mfaToken),
  startPasskeyRegister: (sessionToken) => safeInvoke('start-passkey-register', sessionToken),
  onSsoCallback: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('sso-callback', handler);
    return () => ipcRenderer.removeListener('sso-callback', handler);
  },
  onSsoSettingsCallback: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('sso-settings-callback', handler);
    return () => ipcRenderer.removeListener('sso-settings-callback', handler);
  },
  openExternal: (url) => safeInvoke('open-external', url),
  getAppSettings: () => safeInvoke('get-app-settings'),
  setAppSettings: (settings) => safeInvoke('set-app-settings', settings),
  setBadgeCount: (count, options) => safeSend('set-badge-count', count, options),
  onShowCloseActionModal: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('show-close-action-modal', handler);
    return () => ipcRenderer.removeListener('show-close-action-modal', handler);
  },
  closeActionChosen: (action, remember) => safeSend('close-action-chosen', { action, remember }),
  // Update screen (supplement existing channels)
  updateCheckComplete: () => safeSend('update-check-complete'),
  onUpdateChecking: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('update-checking', handler);
    return () => ipcRenderer.removeListener('update-checking', handler);
  },
  onUpdateDownloadProgress: (callback) => {
    const handler = (_e, percent) => callback(percent);
    ipcRenderer.on('update-download-progress', handler);
    return () => ipcRenderer.removeListener('update-download-progress', handler);
  },
  onUpdateNotAvailable: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('update-not-available', handler);
    return () => ipcRenderer.removeListener('update-not-available', handler);
  },
  getUpdateStatus: () => safeInvoke('get-update-status'),
  getAutostart: () => safeInvoke('autostart:get'),
  setAutostart: (opts) => safeSend('autostart:set', opts),
  setVoiceSessionState: (active) => safeSend('voice-session-state', !!active),
  setZoomFactor: (factor) => {
    if (typeof factor === 'number' && factor >= 0.5 && factor <= 2.0) {
      webFrame.setZoomFactor(factor);
    }
  },
  getZoomFactor: () => webFrame.getZoomFactor(),
  onZoomCommand: (callback) => {
    const handler = (_e, direction) => callback(direction);
    ipcRenderer.on('zoom-command', handler);
    return () => ipcRenderer.removeListener('zoom-command', handler);
  },
  downloadBlob: (base64Data, fileName) => safeInvoke('download-blob', base64Data, fileName),
  safeStorage: {
    // OS-keychain-wrapped string envelope. Renderer passes plaintext in, gets
    // back a base64 ciphertext bound to the OS user account. Available only
    // in the main process; we expose just two narrow IPC calls.
    isAvailable: () => safeInvoke('safestorage:is-available'),
    encryptString: (plaintext) => safeInvoke('safestorage:encrypt', plaintext),
    decryptString: (ciphertextB64) => safeInvoke('safestorage:decrypt', ciphertextB64),
  },
  keybinds: {
    setBindings: (bindings) => safeSend('keybinds:set', bindings),
    shutdown:    () => safeSend('keybinds:shutdown'),
    openMacAccessibility: () => safeInvoke('keybinds:open-macos-accessibility'),
    onTrigger: (callback) => {
      const handler = (_e, trigger) => {
        // Defensive: reject anything that doesn't match the expected shape.
        if (!trigger || typeof trigger !== 'object') return;
        if (typeof trigger.actionId !== 'string') return;
        if (trigger.phase !== 'down' && trigger.phase !== 'up') return;
        callback(trigger);
      };
      ipcRenderer.on('keybinds:trigger', handler);
      return () => ipcRenderer.removeListener('keybinds:trigger', handler);
    },
  },
  streamdeck: {
    onPairRequest: (callback) => {
      const handler = (_e, info) => callback(info);
      ipcRenderer.on('streamdeck:pair-request', handler);
      return () => ipcRenderer.removeListener('streamdeck:pair-request', handler);
    },
    sendPairDecision: (requestId, decision) =>
      safeSend('streamdeck:pair-decision', { requestId, decision }),
    onAction: (callback) => {
      const handler = (_e, payload) => callback(payload);
      ipcRenderer.on('streamdeck:action', handler);
      return () => ipcRenderer.removeListener('streamdeck:action', handler);
    },
    replyAction: (replyChannel, data) => {
      // Only allow reply channels that match our known pattern.
      if (typeof replyChannel !== 'string' || !/^streamdeck:action:reply:[0-9a-f-]{36}$/.test(replyChannel)) return;
      ipcRenderer.send(replyChannel, data);
    },
    onList: (callback) => {
      const handler = (_e, payload) => callback(payload);
      ipcRenderer.on('streamdeck:list', handler);
      return () => ipcRenderer.removeListener('streamdeck:list', handler);
    },
    replyList: (replyChannel, data) => {
      if (typeof replyChannel !== 'string' || !/^streamdeck:list:reply:[0-9a-f-]{36}$/.test(replyChannel)) return;
      ipcRenderer.send(replyChannel, data);
    },
    onSubscribe: (callback) => {
      const handler = (_e, payload) => callback(payload);
      ipcRenderer.on('streamdeck:subscribe', handler);
      return () => ipcRenderer.removeListener('streamdeck:subscribe', handler);
    },
    replySubscribe: (replyChannel, data) => {
      if (typeof replyChannel !== 'string' || !/^streamdeck:subscribe:reply:[0-9a-f-]{36}$/.test(replyChannel)) return;
      ipcRenderer.send(replyChannel, data);
    },
    listPairings: () => safeInvoke('streamdeck:list-pairings'),
    revokePairing: (pluginId) => safeInvoke('streamdeck:revoke-pairing', pluginId),
    isRunning: () => safeInvoke('streamdeck:is-running'),
    setEnabled: (enabled) => safeInvoke('streamdeck:set-enabled', !!enabled),
    pushState: (topic, data) => safeSend('streamdeck:push-state', topic, data),
  },
});

