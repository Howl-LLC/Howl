// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
'use strict';
const { app, ipcMain } = require('electron');

const bridgeServer = require('./bridge-server.js');
const portFile = require('./port-file.js');
const installId = require('./install-id.js');
const tokenStore = require('./token-store.js');
const log = require('./log.js');

// Emergency boot-time kill switch. Flip in a hotfix build if the bridge
// must be disabled globally regardless of the user setting.
const STREAMDECK_KILLED = false;

let _server = null;
let _installId = null;
let _pendingPairResolvers = new Map(); // requestId → resolve(decision)

// TODO: When the Stream Deck plugin protocol gains a "mobile-relay"
// capability field in the `pair` command, pass `allowMobile` into `boot()` and
// have the bridge-server refuse pairing when `allowMobile === false` and the
// plugin advertises mobile-relay. Until then the toggle only controls future
// behavior; desktop-only hardware connections are always local-loopback and
// unaffected.

async function boot({ userDataDir, appVersion, getMainWindow }) {
  if (STREAMDECK_KILLED) { log.warn('boot-skipped', { reason: 'kill-switch' }); return; }

  _installId = installId.getOrCreate(userDataDir);
  portFile.removeStale(userDataDir); // recover from prior ungraceful exit

  _server = await bridgeServer.start({
    userDataDir,
    installId: _installId,
    appVersion,
    onPairRequest: async (info) => askRendererForPairDecision(getMainWindow, info),
    onExecute: async (params) => sendToRenderer(getMainWindow, 'streamdeck:action', params, 2000)
      .catch(() => ({ code: 'timeout' })),
    onListResource: async (params) => sendToRenderer(getMainWindow, 'streamdeck:list', params, 2000)
      .catch(() => { throw new Error('timeout'); }),
    onSubscribe: async (params) => sendToRenderer(getMainWindow, 'streamdeck:subscribe', params, 2000)
      .catch(() => []),
  });

  portFile.write(userDataDir, { port: _server.port, installId: _installId, version: appVersion });
  log.info('orchestrator-booted', { port: _server.port });
}

async function shutdown(userDataDir) {
  if (!_server) return;
  await _server.stop();
  _server = null;
  portFile.remove(userDataDir);
  log.info('orchestrator-shutdown');
}

function isRunning() { return !!_server; }

function broadcastEvent(topic, data) {
  if (_server) _server.broadcastEvent(topic, data);
}

function askRendererForPairDecision(getMainWindow, info) {
  const win = getMainWindow();
  if (!win) return { decision: 'deny' };
  const requestId = require('crypto').randomUUID();
  const p = new Promise((resolve) => {
    _pendingPairResolvers.set(requestId, resolve);
    // 60-second fallback — if the renderer doesn't respond, treat as deny.
    setTimeout(() => {
      if (_pendingPairResolvers.has(requestId)) {
        _pendingPairResolvers.delete(requestId);
        resolve({ decision: 'deny' });
      }
    }, 60_000);
  });
  win.webContents.send('streamdeck:pair-request', { requestId, ...info });
  return p;
}

function handlePairDecision(evt, { requestId, decision }) {
  const resolver = _pendingPairResolvers.get(requestId);
  if (!resolver) return;
  _pendingPairResolvers.delete(requestId);
  resolver({ decision: decision === 'allow' ? 'allow' : 'deny' });
}

function sendToRenderer(getMainWindow, channel, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const win = getMainWindow();
    if (!win) { reject(new Error('no-renderer')); return; }
    const replyChannel = `${channel}:reply:${require('crypto').randomUUID()}`;
    const timer = setTimeout(() => {
      ipcMain.removeAllListeners(replyChannel);
      reject(new Error('timeout'));
    }, timeoutMs);
    ipcMain.once(replyChannel, (_e, data) => {
      clearTimeout(timer);
      resolve(data);
    });
    win.webContents.send(channel, { replyChannel, ...payload });
  });
}

function listPairings() {
  if (!_installId) return [];
  return tokenStore.listPairings(app.getPath('userData'), _installId);
}

function revokePairing(pluginId) {
  if (!_installId) return;
  tokenStore.revoke(app.getPath('userData'), _installId, pluginId);
  log.info('pair-revoked', { pluginId });
}

function registerIpc() {
  ipcMain.on('streamdeck:pair-decision', handlePairDecision);
  ipcMain.on('streamdeck:push-state', (_e, topic, data) => broadcastEvent(topic, data));
  ipcMain.handle('streamdeck:list-pairings', () => listPairings());
  ipcMain.handle('streamdeck:revoke-pairing', (_e, pluginId) => revokePairing(pluginId));
  ipcMain.handle('streamdeck:is-running', () => isRunning());
}

module.exports = { boot, shutdown, broadcastEvent, registerIpc, isRunning };
