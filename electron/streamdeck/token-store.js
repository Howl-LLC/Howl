// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'streamdeck-pairings.enc';

/**
 * Module-level safeStorage ref. In production this is set lazily from
 * require('electron').safeStorage on first use. Tests inject a mock via
 * _setSafeStorage() before calling any other export.
 */
let _safeStorage = null;

function getSafeStorage() {
  if (!_safeStorage) {
    _safeStorage = require('electron').safeStorage;
  }
  return _safeStorage;
}

/** @internal — test-only: inject a safeStorage mock. */
function _setSafeStorage(mock) {
  _safeStorage = mock;
}

function filePath(userDataDir) {
  return path.join(userDataDir, FILE);
}

function assertKeychain() {
  const ss = getSafeStorage();
  if (!ss.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption not available on this platform.');
  }
  const backend = typeof ss.getSelectedStorageBackend === 'function'
    ? ss.getSelectedStorageBackend() : 'unknown';
  if (backend === 'basic_text') {
    throw new Error('keychain unavailable (basic_text mode). Install GNOME Keyring or KWallet, or launch Howl with --password-store=gnome-libsecret.');
  }
}

function loadAll(userDataDir) {
  assertKeychain();
  const ss = getSafeStorage();
  try {
    const cipher = fs.readFileSync(filePath(userDataDir));
    const plaintext = ss.decryptString(cipher);
    const parsed = JSON.parse(plaintext);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAll(userDataDir, records) {
  assertKeychain();
  const ss = getSafeStorage();
  fs.mkdirSync(userDataDir, { recursive: true });
  const cipher = ss.encryptString(JSON.stringify(records));
  fs.writeFileSync(filePath(userDataDir), cipher);
}

function recordKey(installId, pluginId) {
  return `${installId}\x00${pluginId}`;
}

function storePairing(userDataDir, installId, { pluginId, displayName, version, token }) {
  const all = loadAll(userDataDir);
  const now = Date.now();
  const key = recordKey(installId, pluginId);
  const next = all.filter((r) => recordKey(r.installId, r.pluginId) !== key);
  next.push({
    installId, pluginId, displayName, version,
    token,                 // stored inside the encrypted blob only
    pairedAt: now,
    lastUsedAt: now,
  });
  saveAll(userDataDir, next);
}

function verifyToken(userDataDir, installId, pluginId, candidateToken) {
  const all = loadAll(userDataDir);
  const rec = all.find((r) => r.installId === installId && r.pluginId === pluginId);
  if (!rec) return false;
  const a = Buffer.from(rec.token, 'utf8');
  const b = Buffer.from(candidateToken, 'utf8');
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  rec.lastUsedAt = Date.now();
  saveAll(userDataDir, all);
  return true;
}

// Returns pairings for this installId WITHOUT the raw token field.
function listPairings(userDataDir, installId) {
  return loadAll(userDataDir)
    .filter((r) => r.installId === installId)
    .map(({ token, ...rest }) => rest);
}

function revoke(userDataDir, installId, pluginId) {
  const all = loadAll(userDataDir);
  const next = all.filter((r) => !(r.installId === installId && r.pluginId === pluginId));
  saveAll(userDataDir, next);
}

function generateToken() {
  return crypto.randomBytes(32).toString('base64');
}

module.exports = { storePairing, verifyToken, listPairings, revoke, generateToken, _setSafeStorage };
