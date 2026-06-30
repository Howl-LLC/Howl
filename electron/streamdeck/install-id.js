// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INSTALL_ID_FILE = 'streamdeck-install-id';

function getOrCreate(userDataDir) {
  const p = path.join(userDataDir, INSTALL_ID_FILE);
  try {
    const raw = fs.readFileSync(p, 'utf8').trim();
    if (/^[0-9a-f-]{36}$/.test(raw)) return raw;
  } catch { /* missing or unreadable */ }
  const id = crypto.randomUUID();
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(p, id, 'utf8');
  return id;
}

module.exports = { getOrCreate };
