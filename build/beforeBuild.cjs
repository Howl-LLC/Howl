// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// electron-builder beforeBuild hook. Forces @electron/rebuild to actually
// recompile uiohook-napi for the target arch instead of leaving whatever
// binary is already in node_modules untouched.
//
// Without this:
//   1. First run: x64 rebuild produces x64. arm64 rebuild compiles from
//      source and overwrites node_modules/uiohook-napi/build/Release with
//      arm64. afterPack hardlink-breaker isolates each arch's packaged
//      output. Build succeeds.
//   2. Second run: build/Release/uiohook_napi.node is still arm64 from
//      run 1. @electron/rebuild for x64 sees an existing .node, decides
//      "nothing to rebuild", logs "finished" but does no work. The arm64
//      binary gets packaged into win-unpacked (the x64 target). x64
//      installer ships an arm64 native module. Crash on launch.
//
// Deleting build/ before each rebuild forces @electron/rebuild to copy
// the arch-correct prebuild (or compile from source if no prebuild exists
// for that arch). Pair with the afterPack hardlink-breaker in afterPack.cjs.
//
// Returns true so electron-builder proceeds with npmRebuild. Anything
// falsy (including undefined) skips the rebuild step entirely.

const fs = require('node:fs');
const path = require('node:path');

// electron-builder context.arch is a numeric enum: 1=ia32, 2=x64,
// 3=armv7l, 4=arm64, 5=universal (mac).
const ARCH_NAME = { 1: 'ia32', 2: 'x64', 3: 'armv7l', 4: 'arm64' };

// Module-specific seeding rules. uiohook-napi ships prebuilt .node files
// in `prebuilds/<platform>-<arch>/node.napi.node`, but electron-builder's
// asar packer only ships `build/Release/<bindingName>.node` as the canonical
// load path. We mirror the right prebuild into build/Release before each
// arch's @electron/rebuild call so the packaged tree always has an
// arch-correct binary at the canonical location.
const MODULES = [{
  name: 'uiohook-napi',
  bindingFile: 'uiohook_napi.node',     // build/Release/<bindingFile>
  prebuildFile: 'node.napi.node',       // prebuilds/<platform>-<arch>/<prebuildFile>
}];

exports.default = async function beforeBuild(context) {
  const { appDir, arch: archEnum, platform } = context;
  const platformName = platform && platform.nodeName ? platform.nodeName : String(platform);
  if (platformName !== 'win32') return true;

  const archName = ARCH_NAME[archEnum] || String(archEnum);

  for (const m of MODULES) {
    const moduleDir = path.join(appDir, 'node_modules', m.name);
    const buildDir = path.join(moduleDir, 'build');
    const buildReleaseDir = path.join(buildDir, 'Release');
    const builtBinary = path.join(buildReleaseDir, m.bindingFile);
    const prebuildKey = `${platformName}-${archName}`;
    const prebuildBinary = path.join(moduleDir, 'prebuilds', prebuildKey, m.prebuildFile);

    // Always start fresh so @electron/rebuild does not skip on stale state.
    if (fs.existsSync(buildDir)) {
      fs.rmSync(buildDir, { recursive: true, force: true });
    }

    if (fs.existsSync(prebuildBinary)) {
      // Seed build/Release/ with the matching prebuild. @electron/rebuild
      // sees a present binary and treats the module as built; the packaged
      // win-*-unpacked tree gets the right arch immediately.
      fs.mkdirSync(buildReleaseDir, { recursive: true });
      fs.copyFileSync(prebuildBinary, builtBinary);
      console.log(`[beforeBuild] Seeded ${m.name}/build/Release/${m.bindingFile} from prebuilds/${prebuildKey} for arch=${archName}`);
    } else {
      // No prebuild for this arch — leave build/ empty so @electron/rebuild
      // compiles from source.
      console.log(`[beforeBuild] No prebuild at prebuilds/${prebuildKey}; ${m.name} will compile from source for arch=${archName}`);
    }
  }

  return true;
};
