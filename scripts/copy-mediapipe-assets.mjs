// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Copies MediaPipe tasks-vision WASM assets from node_modules into
// public/mediapipe/wasm/ so the app can load them locally (Electron offline,
// zero 3rd-party CDN dependency at runtime).
//
// Model .tflite files are committed to git under public/mediapipe/models/
// because they don't ship with the npm package and are small (~500 KB total).
// WASM files are large (~33 MB) and re-derivable from node_modules, so they
// are git-ignored and copied here on postinstall / predev / prebuild.
//
// Also copies RNNoise's sync WASM loader from @jitsi/rnnoise-wasm/dist into
// public/ for the RNNoise AudioWorklet. Same rationale: large (~1.9 MB),
// re-derivable from node_modules, git-ignored.

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const DST = join(ROOT, 'public', 'mediapipe', 'wasm');

if (existsSync(SRC)) {
  mkdirSync(DST, { recursive: true });
  const files = readdirSync(SRC).filter((f) => f.endsWith('.wasm') || f.endsWith('.js'));
  for (const f of files) copyFileSync(join(SRC, f), join(DST, f));
  console.log(`[mediapipe] Copied ${files.length} WASM assets to public/mediapipe/wasm/`);
}

// RNNoise AudioWorklet bundle — loaded lazily when the user enables
// "Advanced noise suppression". The sync version has the WASM inlined as
// base64 so an AudioWorklet (which lacks fetch) can bootstrap it.
const RNN_SRC = join(ROOT, 'node_modules', '@jitsi', 'rnnoise-wasm', 'dist', 'rnnoise-sync.js');
const RNN_DST = join(ROOT, 'public', 'rnnoise-sync.js');
if (existsSync(RNN_SRC)) {
  copyFileSync(RNN_SRC, RNN_DST);
  console.log('[rnnoise] Copied rnnoise-sync.js to public/');
}
