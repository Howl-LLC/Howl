// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Validate the Stream Deck plugin structure before packaging.
 *
 * Checks:
 *   1. manifest.json parses as valid JSON with required fields.
 *   2. All declared action UUIDs start with the plugin UUID prefix.
 *   3. Actions array has exactly 20 entries.
 *   4. Referenced PropertyInspectorPath files exist on disk.
 *   5. Referenced icon paths exist on disk (warning only — icons are TODO).
 *   6. Built plugin.js exists.
 *   7. Version is 4-part (e.g. 1.0.0.0).
 *   8. Category is "Howl".
 *
 * Usage: node scripts/validate.js
 * Exit code: 0 on success, 1 on errors (warnings don't cause failure).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const sdPluginDir = resolve(root, 'com.howlpro.streamdeck.sdPlugin');

let errors = 0;
let warnings = 0;

function error(msg) {
  console.error(`  ERROR: ${msg}`);
  errors++;
}

function warn(msg) {
  console.warn(`  WARN:  ${msg}`);
  warnings++;
}

function ok(msg) {
  console.log(`  OK:    ${msg}`);
}

console.log('Validating Stream Deck plugin...\n');

// 1. Parse manifest
let manifest;
const manifestPath = resolve(sdPluginDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  error('manifest.json not found');
  process.exit(1);
}

try {
  const raw = readFileSync(manifestPath, 'utf-8');
  manifest = JSON.parse(raw);
  ok('manifest.json parses as valid JSON');
} catch (e) {
  error(`manifest.json parse failed: ${e.message}`);
  process.exit(1);
}

// 2. Required top-level fields
const requiredFields = ['UUID', 'Name', 'Author', 'Version', 'Description', 'CodePath', 'SDKVersion', 'Actions'];
for (const field of requiredFields) {
  if (manifest[field] === undefined) {
    error(`Missing required field: ${field}`);
  }
}

// 3. Version is 4-part
if (manifest.Version) {
  const parts = manifest.Version.split('.');
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p))) {
    ok(`Version is 4-part: ${manifest.Version}`);
  } else {
    error(`Version must be 4-part (e.g. 1.0.0.0), got: ${manifest.Version}`);
  }
}

// 4. Category is "Howl"
if (manifest.Category === 'Howl') {
  ok('Category is "Howl"');
} else {
  error(`Category must be "Howl", got: "${manifest.Category}"`);
}

// 5. Actions array
const actions = manifest.Actions;
if (!Array.isArray(actions)) {
  error('Actions is not an array');
  process.exit(1);
}

const EXPECTED_ACTION_COUNT = 20;
if (actions.length === EXPECTED_ACTION_COUNT) {
  ok(`Actions array has exactly ${EXPECTED_ACTION_COUNT} entries`);
} else {
  error(`Expected ${EXPECTED_ACTION_COUNT} actions, found ${actions.length}`);
}

// 6. Validate each action
const pluginUUID = manifest.UUID;
const actionUUIDs = new Set();

for (const action of actions) {
  const uuid = action.UUID;
  if (!uuid) {
    error('Action missing UUID');
    continue;
  }

  // Check UUID prefix
  if (!uuid.startsWith(pluginUUID + '.')) {
    error(`Action UUID "${uuid}" does not start with plugin prefix "${pluginUUID}."`);
  }

  // Check for duplicate UUIDs
  if (actionUUIDs.has(uuid)) {
    error(`Duplicate action UUID: ${uuid}`);
  }
  actionUUIDs.add(uuid);

  // Check PropertyInspectorPath if declared
  if (action.PropertyInspectorPath) {
    const piPath = resolve(sdPluginDir, action.PropertyInspectorPath);
    if (existsSync(piPath)) {
      ok(`PI exists: ${action.PropertyInspectorPath} (${action.Name})`);
    } else {
      error(`PI file missing: ${action.PropertyInspectorPath} (${action.Name})`);
    }
  }

  // Check icon paths (warnings only)
  if (action.Icon) {
    // Manifest icon paths don't have extensions — SD tries .png and .svg
    const iconPng = resolve(sdPluginDir, action.Icon + '.png');
    const iconSvg = resolve(sdPluginDir, action.Icon + '.svg');
    if (!existsSync(iconPng) && !existsSync(iconSvg)) {
      warn(`Icon file missing: ${action.Icon}.png/.svg (${action.Name})`);
    }
  }

  // Check state images (warnings only)
  if (Array.isArray(action.States)) {
    for (const state of action.States) {
      if (state.Image) {
        const imgPng = resolve(sdPluginDir, state.Image + '.png');
        const imgSvg = resolve(sdPluginDir, state.Image + '.svg');
        if (!existsSync(imgPng) && !existsSync(imgSvg)) {
          warn(`State image missing: ${state.Image}.png/.svg (${action.Name})`);
        }
      }
    }
  }
}

// 7. Built plugin.js exists
const pluginJs = resolve(sdPluginDir, 'bin', 'plugin.js');
if (existsSync(pluginJs)) {
  ok('bin/plugin.js exists');
} else {
  error('bin/plugin.js not found — run `npm run build` first');
}

// 8. Check shared PI stylesheet
const stylesPath = resolve(sdPluginDir, 'ui', 'styles.css');
if (existsSync(stylesPath)) {
  ok('ui/styles.css exists');
} else {
  warn('ui/styles.css missing — PI pages will have no shared styles');
}

// Summary
console.log(`\n  --- Summary ---`);
console.log(`  Errors:   ${errors}`);
console.log(`  Warnings: ${warnings}`);
console.log('');

if (errors > 0) {
  console.error('Validation FAILED. Fix errors before packaging.');
  process.exit(1);
} else {
  console.log('Validation passed.');
  process.exit(0);
}
