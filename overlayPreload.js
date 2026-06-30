// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// @sentry/electron/preload — bridge overlay-window errors to the main-process
// Sentry SDK. Must be required at the top of preload, per @sentry/electron docs.
try { require('@sentry/electron/preload'); } catch (e) {
  // eslint-disable-next-line no-console
  console.warn('[overlayPreload] @sentry/electron/preload init failed:', e?.message || e);
}

const { contextBridge, ipcRenderer } = require('electron');

const validSendChannels = new Set([
  'overlay-toggle-lock',
  'overlay-show',
  'overlay-hide',
  'overlay-to-main',
]);

function safeSend(channel, ...args) {
  if (validSendChannels.has(channel)) ipcRenderer.send(channel, ...args);
}

contextBridge.exposeInMainWorld('overlayBridge', {
  toggleLock: (locked) => safeSend('overlay-toggle-lock', locked),
  show: () => safeSend('overlay-show'),
  hide: () => safeSend('overlay-hide'),
  sendToMain: (channel, ...args) => safeSend('overlay-to-main', channel, ...args),

  onVoiceUpdate: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('overlay-voice-update', handler);
    return () => ipcRenderer.removeListener('overlay-voice-update', handler);
  },
  onNotification: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('overlay-notification', handler);
    return () => ipcRenderer.removeListener('overlay-notification', handler);
  },
  onSettingsChanged: (callback) => {
    const handler = (_e, settings) => callback(settings);
    ipcRenderer.on('overlay-settings-changed', handler);
    return () => ipcRenderer.removeListener('overlay-settings-changed', handler);
  },
  onServersUpdate: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('overlay-servers-update', handler);
    return () => ipcRenderer.removeListener('overlay-servers-update', handler);
  },
  onMessagesUpdate: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('overlay-messages-update', handler);
    return () => ipcRenderer.removeListener('overlay-messages-update', handler);
  },
  onUnreadsUpdate: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('overlay-unreads-update', handler);
    return () => ipcRenderer.removeListener('overlay-unreads-update', handler);
  },
  onGameDetected: (callback) => {
    const handler = (_e, game) => callback(game);
    ipcRenderer.on('overlay-game-detected', handler);
    return () => ipcRenderer.removeListener('overlay-game-detected', handler);
  },
  onGameCleared: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('overlay-game-cleared', handler);
    return () => ipcRenderer.removeListener('overlay-game-cleared', handler);
  },
});
