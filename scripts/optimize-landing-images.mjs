// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Generates responsive AVIF/WebP variants for the landing screenshots, downsizes
// the PNG fallbacks and mascots in place, converts the mascot GIFs to WebP, and
// writes components/landingImageManifest.ts. Run via `npm run optimize:landing`
// when landing imagery changes; the output is committed and served statically.
// Re-runs operate on the already-optimized files on disk, so keep masters elsewhere.
import sharp from 'sharp';
import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_DIR = path.join(ROOT, 'public/landing/screenshots');
const ASSETS_DIR = path.join(ROOT, 'public/landing/assets');
const MANIFEST_TS = path.join(ROOT, 'components/landingImageManifest.ts');

// Each width is emitted only when smaller than the source; the source width
// (capped at MAX_PNG_W) is always included so the largest variant is real pixels.
const SHOT_WIDTHS = [640, 1280, 1920];
const MAX_PNG_W = 1920;
const AVIF = { quality: 58, effort: 5 };
const WEBP = { quality: 80, effort: 5 };
const WEBP_ANIM = { quality: 80, effort: 4 };

// Decorative mascots, rendered small: downscale in place. GIFs become animated WebP.
const MASCOTS = [
  { file: 'howl-logo-v4.png', target: 160 },
  { file: 'howl-mascot-hero.png', target: 200 },
  { file: 'roo-puppy.webp', target: 360, animated: true },
  { file: 'roo-waving.webp', target: 1000, animated: true },
  { file: 'roo-wave-animated.webp', target: 1000, animated: true },
  { file: 'painter-roo.webp', target: 900, animated: true },
  { file: 'roo-lock-key.gif', target: 900, animated: true, toWebp: true },
  { file: 'roo-megaphone.gif', target: 900, animated: true, toWebp: true },
  { file: 'roo-reading-transparent.gif', target: 220, animated: true, toWebp: true },
];

const kb = (n) => `${(n / 1024).toFixed(0)}KB`;

async function processScreenshots() {
  const dirFiles = await readdir(SHOTS_DIR);
  const files = dirFiles.filter((f) => f.toLowerCase().endsWith('.png')).sort();
  const manifest = {};

  for (const file of files) {
    const name = file.replace(/\.png$/i, '');
    const full = path.join(SHOTS_DIR, file);
    const original = await readFile(full);
    const { width: srcW, height: srcH } = await sharp(original).metadata();

    // Drop any variants from a prior run (e.g. a now-removed width).
    for (const f of dirFiles) {
      if (new RegExp(`^${name}-\\d+\\.(avif|webp)$`).test(f)) await unlink(path.join(SHOTS_DIR, f));
    }

    const cap = Math.min(srcW, MAX_PNG_W);
    const widths = [...new Set([...SHOT_WIDTHS.filter((w) => w < srcW), cap])]
      .filter((w) => w <= srcW)
      .sort((a, b) => a - b);

    for (const w of widths) {
      const base = sharp(original).resize({ width: w, withoutEnlargement: true });
      await base.clone().avif(AVIF).toFile(path.join(SHOTS_DIR, `${name}-${w}.avif`));
      await base.clone().webp(WEBP).toFile(path.join(SHOTS_DIR, `${name}-${w}.webp`));
    }

    const pngBuf = await sharp(original)
      .resize({ width: cap, withoutEnlargement: true })
      .png({ compressionLevel: 9, effort: 10 })
      .toBuffer();
    await writeFile(full, pngBuf);

    manifest[name] = { w: cap, h: Math.round((srcH / srcW) * cap), widths };
    console.log(`  ${file}  ${srcW}x${srcH} -> ${widths.join('/')}  png ${kb(original.length)}->${kb(pngBuf.length)}`);
  }
  return manifest;
}

async function processMascots() {
  for (const m of MASCOTS) {
    const full = path.join(ASSETS_DIR, m.file);
    if (!existsSync(full)) { console.warn(`  ! missing ${m.file}`); continue; }
    const original = await readFile(full);
    const ext = path.extname(m.file).slice(1).toLowerCase();
    const pipeline = sharp(original, m.animated ? { animated: true } : {})
      .resize({ width: m.target, withoutEnlargement: true });

    if (m.toWebp) {
      const out = full.replace(/\.gif$/i, '.webp');
      await writeFile(out, await pipeline.webp(WEBP_ANIM).toBuffer());
      await unlink(full);
      console.log(`  ${m.file} -> ${path.basename(out)}`);
      continue;
    }

    let buf;
    if (ext === 'webp') buf = await pipeline.webp(m.animated ? WEBP_ANIM : WEBP).toBuffer();
    else if (ext === 'png') buf = await pipeline.png({ compressionLevel: 9, effort: 10 }).toBuffer();
    else { console.warn(`  ! unhandled ext ${m.file}`); continue; }
    await writeFile(full, buf);
    console.log(`  ${m.file}  ${kb(original.length)}->${kb(buf.length)}`);
  }
}

function renderManifest(manifest) {
  const entries = Object.keys(manifest).sort().map((name) => {
    const v = manifest[name];
    return `  ${JSON.stringify(name)}: { w: ${v.w}, h: ${v.h}, widths: [${v.widths.join(', ')}] },`;
  }).join('\n');
  return `// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// AUTO-GENERATED by scripts/optimize-landing-images.mjs. Do not edit by hand.
// Intrinsic size of each screenshot's PNG fallback and the responsive widths
// available as <name>-<w>.avif / <name>-<w>.webp under /public/landing/screenshots/.
export interface ShotMeta {
  w: number;
  h: number;
  widths: number[];
}

export const LANDING_SHOTS: Record<string, ShotMeta> = {
${entries}
};
`;
}

async function main() {
  console.log('Optimizing landing screenshots…');
  const manifest = await processScreenshots();
  console.log('Optimizing landing mascots…');
  await processMascots();
  await writeFile(MANIFEST_TS, renderManifest(manifest));
  console.log(`Wrote ${path.relative(ROOT, MANIFEST_TS)} (${Object.keys(manifest).length} screenshots).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
