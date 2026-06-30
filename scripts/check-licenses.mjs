#!/usr/bin/env node
// License compatibility guard for AGPL-3.0-only.
//
// Walks the installed node_modules of every workspace and fails if any package
// carries a license that is NOT known-compatible with AGPL-3.0. This is an
// ALLOWLIST (fail-closed): a dependency whose license we don't recognise is
// treated as a violation so it gets a human review before it can ship, rather
// than silently slipping in.
//
// Why these are the rules:
//   - Howl ships under AGPL-3.0-only (a GPLv3-family strong copyleft). Code from
//     a permissive (MIT/BSD/ISC/Apache-2.0/...) or a GPLv3-compatible copyleft
//     (LGPL-3.0, MPL-2.0, GPL-3.0, AGPL-3.0) dependency may be combined into the
//     work; the combined result is governed by AGPL-3.0.
//   - Apache-2.0 is one-way compatible: fine to pull INTO a GPLv3 work, NOT into
//     a GPLv2-only one. Howl is v3, so it's allowed.
//   - Things that would taint an AGPL distribution and are therefore NOT on the
//     allowlist: GPL-2.0-only, LGPL-2.0/2.1-only, EPL, MPL-1.x, CDDL, BSD-4-Clause,
//     SSPL, BUSL, Elastic, the JSON "good not evil" license, and any
//     non-commercial / no-derivatives Creative Commons variant.
//
// No external dependencies — runnable with a bare Node (>=18).
//
// Usage:
//   node scripts/check-licenses.mjs            # scan default workspaces
//   node scripts/check-licenses.mjs --json     # machine-readable report
//   node scripts/check-licenses.mjs a b c      # scan only these workspace dirs

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// SPDX identifiers (upper-cased) that are compatible with AGPL-3.0-only.
const ALLOW = new Set([
  // Permissive
  'MIT', 'MIT-0', 'ISC', 'BSD-2-CLAUSE', 'BSD-3-CLAUSE', 'BSD-3-CLAUSE-CLEAR',
  '0BSD', 'BLUEOAK-1.0.0', 'APACHE-2.0', 'UNLICENSE', 'WTFPL', 'ZLIB',
  'CC0-1.0', 'CC-BY-4.0', 'CC-BY-3.0', 'PYTHON-2.0', 'PSF-2.0', 'UPL-1.0',
  'X11', 'BSD', 'OFL-1.1', 'ARTISTIC-2.0', 'NCSA', 'BEERWARE',
  // Copyleft that is GPLv3-family compatible
  'LGPL-3.0', 'LGPL-3.0-ONLY', 'LGPL-3.0-OR-LATER',
  'LGPL-2.1-OR-LATER', 'LGPL-2.0-OR-LATER',
  'MPL-2.0',
  'GPL-3.0', 'GPL-3.0-ONLY', 'GPL-3.0-OR-LATER', 'GPL-2.0-OR-LATER',
  'AGPL-3.0', 'AGPL-3.0-ONLY', 'AGPL-3.0-OR-LATER',
]);

// Packages with a missing / non-SPDX license field that we have manually
// verified. Keyed by "name" or exact "name@version". Each MUST carry a reason.
const EXCEPTIONS = {
  // ships a plain MIT LICENSE file; the package.json just omits the field.
  'seq-queue': 'LICENSE file is "(The MIT License)"; package.json field missing.',
};

// Workspace dirs (relative to repo root) to scan. Missing node_modules are
// skipped, so this works locally with a partial install and in CI alike.
const DEFAULT_WORKSPACES = [
  '.', 'backend', 'admin', 'electron', 'streamdeck-plugin', 'workers/cdn-signer',
];

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const workspaces = argv.filter((a) => !a.startsWith('--'));
const targets = workspaces.length ? workspaces : DEFAULT_WORKSPACES;

function normalizeLicense(pkg) {
  const { license, licenses } = pkg;
  if (typeof license === 'string') return license;
  if (license && typeof license === 'object') return license.type || null;
  if (Array.isArray(licenses)) {
    const types = licenses.map((l) => (typeof l === 'object' ? l.type : l)).filter(Boolean);
    return types.length ? types.join(' OR ') : null;
  }
  if (licenses && typeof licenses === 'object') return licenses.type || null;
  return null;
}

// Split an SPDX expression into its atomic license ids.
function atomsOf(expr) {
  return expr
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND|WITH)\s+/i)
    .map((s) => s.trim().replace(/\+$/, '-or-later'))
    .filter(Boolean);
}

// Returns true if the expression is acceptable.
//   OR  -> acceptable if ANY atom is allowed (we may pick the compatible one)
//   AND -> acceptable only if EVERY atom is allowed
function isAllowed(expr) {
  if (!expr) return false;
  const up = expr.toUpperCase();
  const parts = atomsOf(up);
  if (!parts.length) return false;
  const isOr = /\s+OR\s+/.test(up);
  const ok = parts.map((p) => ALLOW.has(p));
  return isOr ? ok.some(Boolean) : ok.every(Boolean);
}

const seen = new Map(); // name@version -> { name, version, license, workspace }
const violations = [];
const exceptionsUsed = new Set();
const licenseCounts = new Map();

function recordPkg(pkgDir, name, workspace) {
  const pjPath = join(pkgDir, 'package.json');
  if (existsSync(pjPath)) {
    let pkg;
    try { pkg = JSON.parse(readFileSync(pjPath, 'utf8')); } catch { return walkNested(pkgDir, workspace); }
    const version = pkg.version || '0.0.0';
    const key = `${name}@${version}`;
    if (!seen.has(key)) {
      const license = normalizeLicense(pkg);
      seen.set(key, { name, version, license, workspace });
      licenseCounts.set(license || '(none)', (licenseCounts.get(license || '(none)') || 0) + 1);

      const exceptionKey = EXCEPTIONS[key] ? key : (EXCEPTIONS[name] ? name : null);
      if (!isAllowed(license)) {
        if (exceptionKey) {
          exceptionsUsed.add(exceptionKey);
        } else {
          violations.push({ key, license: license || '(no license field)', workspace });
        }
      }
    }
  }
  walkNested(pkgDir, workspace);
}

function walkNested(pkgDir, workspace) {
  scanNodeModules(join(pkgDir, 'node_modules'), workspace);
}

function scanNodeModules(nmDir, workspace) {
  if (!existsSync(nmDir)) return;
  let entries;
  try { entries = readdirSync(nmDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const name = e.name;
    if (name === '.bin' || name === '.cache' || name === '.package-lock.json') continue;
    const full = join(nmDir, name);
    if (name.startsWith('@')) {
      let scoped;
      try { scoped = readdirSync(full, { withFileTypes: true }); } catch { continue; }
      for (const s of scoped) recordPkg(join(full, s.name), `${name}/${s.name}`, workspace);
    } else {
      recordPkg(full, name, workspace);
    }
  }
}

let scannedAny = false;
for (const ws of targets) {
  const nm = join(isAbsolute(ws) ? ws : join(REPO_ROOT, ws), 'node_modules');
  if (existsSync(nm)) {
    scannedAny = true;
    scanNodeModules(nm, ws);
  }
}

if (!scannedAny) {
  console.error('license-check: no node_modules found in any workspace — run "npm ci" first.');
  process.exit(2);
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    totalPackages: seen.size,
    licenseCounts: Object.fromEntries(licenseCounts),
    violations,
    exceptionsUsed: [...exceptionsUsed],
  }, null, 2));
} else {
  console.log(`license-check: scanned ${seen.size} unique packages across ${targets.length} workspace target(s)`);
  const sortedCounts = [...licenseCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [lic, count] of sortedCounts) {
    console.log(`  ${String(count).padStart(5)}  ${lic}`);
  }
  if (exceptionsUsed.size) {
    console.log('\nManually-approved exceptions in use:');
    for (const k of exceptionsUsed) console.log(`  - ${k}: ${EXCEPTIONS[k]}`);
  }
}

// Warn (don't fail) about exceptions that no longer match any installed package,
// so the list stays pruned as dependencies change.
const staleExceptions = Object.keys(EXCEPTIONS).filter((k) => !exceptionsUsed.has(k));
if (staleExceptions.length && !JSON_OUT) {
  console.log(`\nNote: ${staleExceptions.length} license exception(s) matched nothing this run (safe to remove): ${staleExceptions.join(', ')}`);
}

if (violations.length) {
  console.error(`\n✗ ${violations.length} package(s) carry a license NOT known-compatible with AGPL-3.0-only:\n`);
  for (const v of violations.sort((a, b) => a.key.localeCompare(b.key))) {
    console.error(`  [${v.license}]  ${v.key}   (in ${v.workspace}/node_modules)`);
  }
  console.error('\nIf one of these is in fact compatible (e.g. a dual-license or a missing');
  console.error('field), add it to ALLOW or to EXCEPTIONS in scripts/check-licenses.mjs');
  console.error('with a one-line justification. Otherwise, replace the dependency.');
  process.exit(1);
}

if (!JSON_OUT) console.log('\n✓ All dependency licenses are compatible with AGPL-3.0-only.');
