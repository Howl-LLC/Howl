// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
'use strict';

// Thin structured-log helper for main-side bridge events.
// Uses console.* in dev; in production (app.isPackaged) emits JSON lines
// to stdout so they can be captured by the shipping log pipeline.
// Fields that contain secrets (tokens) must be hashed by the caller.

function write(level, msg, fields) {
  const rec = { ts: new Date().toISOString(), level, ns: 'streamdeck', msg, ...(fields || {}) };
  const line = JSON.stringify(rec);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function info(msg, fields)  { write('info',  msg, fields); }
function warn(msg, fields)  { write('warn',  msg, fields); }
function error(msg, fields) { write('error', msg, fields); }

// Hash a token for logging (first 6 hex chars of SHA-256).
function tokenPrefix(token) {
  if (!token) return null;
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex').slice(0, 6);
}

module.exports = { info, warn, error, tokenPrefix };
