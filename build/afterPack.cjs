// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// electron-builder afterPack hook — flips Electron Fuses on the packaged
// binary so runtime switches that weaken sandbox / DevTools / ASAR trust are
// denied by the binary itself, not just by our main.js gates.
//
// Fuses we set:
//   - RunAsNode: off            — no ELECTRON_RUN_AS_NODE=1 Node shell
//   - EnableNodeCliInspectArguments: off — no --inspect / --inspect-brk
//   - EnableNodeOptionsEnvironmentVariable: off — no NODE_OPTIONS injection
//   - OnlyLoadAppFromAsar: on   — must load from app.asar (no unpacked attack)
//   - EnableEmbeddedAsarIntegrityValidation: on (macOS + Windows) —
//     app.asar has a SHA-256 header checked at load; tampering aborts.
//   - LoadBrowserProcessSpecificV8Snapshot: off (default)
//   - GrantFileProtocolExtraPrivileges: off
const fs = require('node:fs');
const path = require('node:path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

// Walk app.asar.unpacked/ and replace every `.node` file with an independent
// copy of itself, severing any hardlink electron-builder created back into the
// source `node_modules` tree. Required for Windows multi-arch builds: when
// @electron/rebuild runs for the next arch, it overwrites the shared source
// file and — via the hardlink — corrupts the already-packaged arch. Breaking
// the hardlink after packaging isolates each arch's output.
function breakNativeBinaryHardlinks(unpackedRoot) {
  const touched = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.node')) {
        const buf = fs.readFileSync(full);
        fs.unlinkSync(full);
        fs.writeFileSync(full, buf);
        touched.push(full);
      }
    }
  };
  if (fs.existsSync(unpackedRoot)) walk(unpackedRoot);
  return touched;
}

exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  // Pick the platform-correct binary basename:
  //   - Linux: electron-builder uses package.json#name (lowercase), exposed as
  //     `packager.executableName`. `productFilename` would be "Howl" which
  //     doesn't match the on-disk file.
  //   - Windows/macOS: `packager.executableName` is not populated on the
  //     WinPackager in electron-builder 26.x (ends up `undefined`), so fall
  //     back to `appInfo.productFilename` ("Howl").
  const exe = electronPlatformName === 'linux'
    ? (packager.executableName || packager.appInfo.productFilename)
    : packager.appInfo.productFilename;
  const ext = electronPlatformName === 'darwin' ? '.app' : electronPlatformName === 'win32' ? '.exe' : '';
  const target = path.join(appOutDir, `${exe}${ext}`);

  const fuses = {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: electronPlatformName === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  };
  // Embedded ASAR integrity validation is macOS + Windows only.
  if (electronPlatformName === 'darwin' || electronPlatformName === 'win32') {
    fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] = true;
  }
  await flipFuses(target, fuses);

  console.log(`[afterPack] Electron fuses flipped on ${target}`);

  if (electronPlatformName === 'win32') {
    const unpacked = path.join(appOutDir, 'resources', 'app.asar.unpacked');
    const touched = breakNativeBinaryHardlinks(unpacked);
    if (touched.length > 0) {
      console.log(`[afterPack] Broke hardlinks on ${touched.length} native binaries in ${unpacked}`);
    }
  }
};
