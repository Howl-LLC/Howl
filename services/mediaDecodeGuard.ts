// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Recipient-side decompression-bomb guard for decrypted attachments.
 *
 * The server skips image-safety checks for E2E uploads ("bytes are ciphertext"),
 * so the recipient is the first party to decode fully sender-controlled bytes.
 * We parse intrinsic dimensions/frame counts from the decrypted bytes (no
 * rasterization) and downscale anything over the server's caps before render.
 */

export const MAX_DECODE_PIXELS = 100_000_000; // mirrors backend MAX_PIXEL_COUNT
export const MAX_DECODE_FRAMES = 500;         // mirrors backend MAX_GIF_FRAMES
export const MAX_RENDER_DIM = 8192;           // hard per-side cap for downscaled output

function u16be(b: Uint8Array, o: number): number { return (b[o] << 8) | b[o + 1]; }
function u16le(b: Uint8Array, o: number): number { return b[o] | (b[o + 1] << 8); }
function u32be(b: Uint8Array, o: number): number { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

function parsePng(b: Uint8Array): { width: number; height: number; frames: number } | null {
  if (b.length < 24) return null;
  return { width: u32be(b, 16), height: u32be(b, 20), frames: 1 };
}

function parseGif(b: Uint8Array): { width: number; height: number; frames: number } | null {
  if (b.length < 13) return null;
  const width = u16le(b, 6), height = u16le(b, 8);
  // Walk blocks to count image descriptors (frames), bounded by MAX_DECODE_FRAMES.
  let off = 13;
  if (b[10] & 0x80) off += 3 * (2 << (b[10] & 0x07)); // global color table
  let frames = 0;
  const skipSubBlocks = (o: number): number => {
    while (o < b.length) { const sz = b[o++]; if (sz === 0) break; o += sz; }
    return o;
  };
  while (off < b.length) {
    const marker = b[off];
    if (marker === 0x3b) break;                          // trailer
    if (marker === 0x2c) {                               // image descriptor = one frame
      if (++frames > MAX_DECODE_FRAMES) break;
      const packed = b[off + 9];
      off += 10;
      if (packed & 0x80) off += 3 * (2 << (packed & 0x07)); // local color table
      off += 1;                                          // LZW min code size
      off = skipSubBlocks(off);
    } else if (marker === 0x21) {                        // extension
      off += 2;
      off = skipSubBlocks(off);
    } else break;
  }
  return { width, height, frames: Math.max(1, frames) };
}

function parseJpeg(b: Uint8Array): { width: number; height: number; frames: number } | null {
  let off = 2;
  while (off + 9 <= b.length) { // need to read through b[off+8] (the second width byte)
    if (b[off] !== 0xff) { off++; continue; }
    const marker = b[off + 1];
    // SOF0..SOF15 carry dimensions; exclude DHT(C4), JPG(C8), DAC(CC) and RST/SOI/EOI.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, off + 5), width: u16be(b, off + 7), frames: 1 };
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    const segLen = u16be(b, off + 2);
    if (segLen < 2) break;
    off += 2 + segLen;
  }
  return null;
}

function parseWebp(b: Uint8Array): { width: number; height: number; frames: number } | null {
  if (b.length < 30) return null;
  const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (fourcc === 'VP8 ') {
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, frames: 1 };
  }
  if (fourcc === 'VP8L') {
    const b1 = b[21], b2 = b[22], b3 = b[23], b4 = b[24];
    const width = 1 + (((b2 & 0x3f) << 8) | b1);
    const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
    return { width, height, frames: 1 };
  }
  if (fourcc === 'VP8X') {
    const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { width, height, frames: 1 }; // animated-WebP frame count not in header (residual)
  }
  return null;
}

/** Sniff intrinsic dimensions (+ GIF frames) from decrypted bytes; null if unparseable. */
export function parseImageDimensions(b: Uint8Array): { width: number; height: number; frames: number } | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return parsePng(b);
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return parseGif(b);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return parseJpeg(b);
  if (b.length >= 16 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return parseWebp(b);
  return null;
}

async function reencodeDownscaled(blob: Blob, width: number, height: number): Promise<string> {
  // Aspect-preserving target within both the pixel budget and the per-side cap.
  const pixelScale = Math.sqrt(MAX_DECODE_PIXELS / (width * height));
  const dimScale = Math.min(MAX_RENDER_DIM / width, MAX_RENDER_DIM / height, 1);
  const scale = Math.min(pixelScale, dimScale, 1);
  const tw = Math.max(1, Math.floor(width * scale));
  const th = Math.max(1, Math.floor(height * scale));
  // resize options bound the decode; quality engines (Chromium/WebKit) avoid
  // rasterizing the full-resolution source.
  const bitmap = await createImageBitmap(blob, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'medium' });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    const out = await canvas.convertToBlob({ type: 'image/png' });
    return URL.createObjectURL(out);
  } finally {
    bitmap.close();
  }
}

/**
 * Return an object URL safe to render. Parseable images over the pixel cap (or
 * GIFs over the frame cap) are downscaled / reduced to a still frame; everything
 * else passes through unchanged. Decode failures → { blocked: true }.
 */
export async function guardedImageObjectURL(blob: Blob): Promise<{ url: string; downsized: boolean } | { blocked: true }> {
  let dims: { width: number; height: number; frames: number } | null;
  try {
    dims = parseImageDimensions(new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer()));
  } catch { dims = null; }

  // Unparseable type → pass through (documented residual: AVIF/animated-WebP bombs).
  if (!dims) return { url: URL.createObjectURL(blob), downsized: false };

  const overPixels = dims.width * dims.height > MAX_DECODE_PIXELS;
  const overFrames = dims.frames > MAX_DECODE_FRAMES;
  if (!overPixels && !overFrames) return { url: URL.createObjectURL(blob), downsized: false };

  try {
    // Over-pixel → downscale; over-frame (but within pixels) → re-encode a single still frame.
    const w = Math.max(1, dims.width), h = Math.max(1, dims.height);
    return { url: await reencodeDownscaled(blob, w, h), downsized: true };
  } catch {
    return { blocked: true };
  }
}
