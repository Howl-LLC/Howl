// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
export interface BoostEntry {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  compressor: DynamicsCompressorNode;
  ctx: AudioContext;
  srcStream: MediaStream;
}

let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    sharedAudioContext = new AudioContext();
  }
  return sharedAudioContext;
}

export function cleanupBoost(entry: BoostEntry) {
  try { entry.source.disconnect(); } catch { /* cleanup failed */ }
  try { entry.gain.disconnect(); } catch { /* cleanup failed */ }
  try { entry.compressor.disconnect(); } catch { /* cleanup failed */ }
}

/**
 * Primary path: <audio> element plays the raw WebRTC stream directly.
 * Chrome grants autoplay for WebRTC MediaStreams on <audio> elements,
 * so this is the only reliable cross-browser approach.
 *
 * For volume > 1.0 (boost), we switch to Web Audio (source → gain →
 * compressor → ctx.destination) and mute the <audio> element to avoid
 * double playback. If the AudioContext is suspended (Chrome blocks it),
 * we fall back to el.volume = 1.0 as the best we can do.
 */
export function applyVolume(
  el: HTMLAudioElement,
  boosts: Map<string, BoostEntry>,
  userId: string,
  stream: MediaStream | null,
  vol: number,
  speakerId?: string,
) {
  if (!stream) {
    el.srcObject = null;
    el.volume = 0;
    const existing = boosts.get(userId);
    if (existing) { cleanupBoost(existing); boosts.delete(userId); }
    return;
  }

  if (el.srcObject !== stream) {
    el.srcObject = stream;
    el.play().catch(() => {});
  }

  if (speakerId && 'setSinkId' in el) {
    (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(speakerId).catch(() => {});
  }

  if (vol <= 1.0) {
    el.volume = Math.max(0, vol);
    el.muted = false;

    const existing = boosts.get(userId);
    if (existing) { cleanupBoost(existing); boosts.delete(userId); }
  } else {
    el.muted = true;

    let entry = boosts.get(userId);
    if (entry && entry.srcStream !== stream) {
      cleanupBoost(entry); boosts.delete(userId); entry = undefined;
    }

    if (!entry) {
      try {
        const ctx = getAudioContext();
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});

        const source = ctx.createMediaStreamSource(stream);
        const gain = ctx.createGain();
        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -3;
        compressor.knee.value = 6;
        compressor.ratio.value = 12;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.1;

        source.connect(gain).connect(compressor).connect(ctx.destination);
        gain.gain.value = vol;

        entry = { source, gain, compressor, ctx, srcStream: stream };
        boosts.set(userId, entry);

        setTimeout(() => {
          if (entry && entry.ctx.state === 'suspended') {
            el.muted = false;
            el.volume = 1.0;
          }
        }, 200);
      } catch {
        el.muted = false;
        el.volume = 1.0;
      }
    } else {
      if (entry.ctx.state === 'suspended') {
        entry.ctx.resume().catch(() => {});
      }
      if (entry.ctx.state === 'running') {
        entry.gain.gain.value = vol;
      } else {
        el.muted = false;
        el.volume = 1.0;
      }
    }
  }
}
