// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = 'streamdeck-bridge.json';

function filePath(userDataDir) {
  return path.join(userDataDir, FILE);
}

function write(userDataDir, info) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const payload = JSON.stringify({
    port: info.port,
    installId: info.installId,
    version: info.version,
  });
  fs.writeFileSync(filePath(userDataDir), payload, 'utf8');
}

function read(userDataDir) {
  try {
    const raw = fs.readFileSync(filePath(userDataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.port !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function remove(userDataDir) {
  try { fs.unlinkSync(filePath(userDataDir)); } catch { /* absent is fine */ }
}

// Called on boot to clean up a stale file from a prior ungraceful exit.
function removeStale(userDataDir) { remove(userDataDir); }

module.exports = { write, read, remove, removeStale, filePath };
