// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { build, context } from 'esbuild';

const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/plugin.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'com.howlpro.streamdeck.sdPlugin/bin/plugin.js',
  // @elgato/streamdeck is bundled (it's pure JS).
  // @napi-rs/canvas must be external — it ships prebuilt native binaries
  // that are loaded at runtime and cannot be inlined by a bundler.
  external: ['@napi-rs/canvas'],
  sourcemap: false,
  minify: false,
  banner: {
    // ESM shims for __dirname / __filename (needed by some deps)
    js: [
      'import { createRequire as __createRequire } from "module";',
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
};

if (isWatch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[esbuild] watching for changes...');
} else {
  await build(options);
  console.log('[esbuild] build complete: com.howlpro.streamdeck.sdPlugin/bin/plugin.js');
}
