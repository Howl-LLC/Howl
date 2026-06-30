// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
'use strict';
const crypto = require('crypto');
const WORDS = require('./bip39-english.js');

// Takes the first 44 bits of SHA-256(pluginId || challenge || installId)
// and splits into 4 × 11-bit words indexed into the BIP-39 English list.
function derive({ pluginId, challenge, installId }) {
  const h = crypto.createHash('sha256')
    .update(String(pluginId), 'utf8')
    .update('\x00', 'utf8')
    .update(String(challenge), 'utf8')
    .update('\x00', 'utf8')
    .update(String(installId), 'utf8')
    .digest();

  // Read 44 bits = first 5.5 bytes → easier: build a BigInt from first 6 bytes, shift down 4 bits.
  let bits = 0n;
  for (let i = 0; i < 6; i++) bits = (bits << 8n) | BigInt(h[i]);
  bits >>= 4n; // keep top 44 bits of the leading 48 we loaded

  const words = [];
  for (let i = 3; i >= 0; i--) {
    const idx = Number((bits >> BigInt(i * 11)) & 0x7FFn);
    words.push(WORDS[idx]);
  }
  return { words, display: words.join(' ') };
}

module.exports = { derive };
