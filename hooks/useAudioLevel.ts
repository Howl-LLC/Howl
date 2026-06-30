// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect, useRef } from 'react';
import { isAppVisible, onVisibilityChange } from './useAppVisible';

/**
 * Returns a 0–1 level for the audio in the given stream (for voice level meters).
 *
 * Optimization: runs at ~60 fps via rAF, and only calls setState
 * when the rounded level actually changes (avoids re-renders on noise).
 *
 * NOTE: prefer `useSharedAudioLevel` / `useSharedIsSpeaking` over this hook —
 * they share an AudioContext across all subscribers. This standalone hook
 * creates a new AudioContext per call (Chrome caps ~6 total), so it's only
 * suitable for one-off uses on non-shared streams.
 */
export function useAudioLevel(stream: MediaStream | null): number {
  const [level, setLevel] = useState(0);
  const rafRef = useRef<number>(0);
  const lastUpdateRef = useRef(0);
  const lastLevelRef = useRef(0);

  useEffect(() => {
    if (!stream) {
      setLevel(0);
      lastLevelRef.current = 0;
      return;
    }
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      setLevel(0);
      lastLevelRef.current = 0;
      return;
    }
    try {
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.85;
      source.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      const INTERVAL = 0; // ~60 fps (rAF native)

      const tick = (now: number) => {
        if (now - lastUpdateRef.current >= INTERVAL) {
          lastUpdateRef.current = now;
          analyser.getByteFrequencyData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i];
          const avg = data.length > 0 ? sum / data.length / 255 : 0;
          const rounded = Math.round(Math.min(1, avg * 2) * 100) / 100;
          if (rounded !== lastLevelRef.current) {
            lastLevelRef.current = rounded;
            setLevel(rounded);
          }
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);

      return () => {
        cancelAnimationFrame(rafRef.current);
        source.disconnect();
        ctx.close().catch(() => {});
        setLevel(0);
        lastLevelRef.current = 0;
      };
    } catch {
      setLevel(0);
      return undefined;
    }
  }, [stream]);

  return level;
}

/**
 * Shared AudioContext for all audio level monitoring.
 * Chrome degrades at ~6-8 AudioContexts; with 100 participants we'd create 100.
 * Instead, we use ONE shared AudioContext and create per-stream source+analyser pairs.
 */
let sharedAudioCtx: AudioContext | null = null;

function getSharedAudioContext(): AudioContext {
  if (sharedAudioCtx && sharedAudioCtx.state !== 'closed') return sharedAudioCtx;
  sharedAudioCtx = new AudioContext();
  if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume().catch(() => {});
  return sharedAudioCtx;
}

interface SharedEntry {
  level: number;
  listeners: Set<() => void>;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  // Explicit ArrayBuffer generic so `getByteFrequencyData` accepts it under
  // TS 5.7+'s stricter TypedArray variance.
  data: Uint8Array<ArrayBuffer>;
  stream: MediaStream;
  endedHandler: (() => void) | null;
}

const sharedCache = new Map<MediaStream, SharedEntry>();

// Single consolidated rAF loop for all shared entries
//
// Previous design ran one rAF per entry (N participants = N rAF callbacks).
// This single loop iterates all entries on each tick, which keeps tick cost
// flat with participant count and eliminates N timer contexts.
//
// Also: skips sampling for entries whose audio track is muted/disabled — no
// point reading the analyser when we know the level is zero.

const SAMPLE_INTERVAL_MS = 66; // ~15 fps — matches prior behaviour
let globalRaf: number | null = null;
let lastGlobalTick = 0;
// Mirror window/tab visibility so the global tick can early-out while the
// app is hidden or blurred. Browsers throttle RAF on hidden tabs but NOT on
// blurred-but-visible windows (alt-tab), and during a call we don't need
// per-participant level samples nobody can see — flush levels to zero so
// the speaking UI drops, then bail until the user comes back.
let globalTickVisible = typeof window !== 'undefined' ? isAppVisible() : true;
if (typeof window !== 'undefined') {
  onVisibilityChange((v) => {
    const wasHidden = !globalTickVisible;
    globalTickVisible = v;
    if (wasHidden && v && sharedCache.size > 0 && globalRaf === null) {
      // Resume after a hidden→visible transition.
      lastGlobalTick = 0;
      globalRaf = requestAnimationFrame(globalTick);
    }
  });
}

function globalTick(now: number): void {
  if (!globalTickVisible) {
    // Drop everyone's level to zero so the speaking ring doesn't stay lit
    // on a frozen frame, then stop the loop. ensureGlobalTick + the
    // visibility listener restart it when the window returns.
    for (const entry of sharedCache.values()) {
      if (entry.level !== 0) {
        entry.level = 0;
        for (const fn of entry.listeners) fn();
      }
    }
    globalRaf = null;
    return;
  }
  if (now - lastGlobalTick >= SAMPLE_INTERVAL_MS) {
    lastGlobalTick = now;
    for (const entry of sharedCache.values()) {
      const track = entry.stream.getAudioTracks()[0];
      // Skip muted/disabled tracks — level is guaranteed 0. If the current
      // level is non-zero, flush it to zero so the UI drops immediately.
      if (!track || !track.enabled || track.muted) {
        if (entry.level !== 0) {
          entry.level = 0;
          for (const fn of entry.listeners) fn();
        }
        continue;
      }
      entry.analyser.getByteFrequencyData(entry.data);
      let sum = 0;
      for (let i = 0; i < entry.data.length; i++) sum += entry.data[i];
      const avg = entry.data.length > 0 ? sum / entry.data.length / 255 : 0;
      const rounded = Math.round(Math.min(1, avg * 2) * 50) / 50;
      if (rounded !== entry.level) {
        entry.level = rounded;
        for (const fn of entry.listeners) fn();
      }
    }
  }
  if (sharedCache.size > 0) {
    globalRaf = requestAnimationFrame(globalTick);
  } else {
    globalRaf = null;
  }
}

function ensureGlobalTick(): void {
  if (globalRaf !== null) return;
  if (!globalTickVisible) return; // Visibility listener will resume.
  lastGlobalTick = 0;
  globalRaf = requestAnimationFrame(globalTick);
}

// Prune orphaned sharedCache entries whose MediaStream tracks have all ended.
let sharedCachePruneInterval: ReturnType<typeof setInterval> | null = null;

function ensurePruneInterval() {
  if (sharedCachePruneInterval !== null) return;
  sharedCachePruneInterval = setInterval(() => {
    for (const [stream, entry] of sharedCache) {
      if (stream.getTracks().every((t) => t.readyState === 'ended')) {
        entry.source.disconnect();
        entry.analyser.disconnect();
        entry.listeners.clear();
        sharedCache.delete(stream);
      }
    }
    if (sharedCache.size === 0) {
      if (sharedCachePruneInterval !== null) {
        clearInterval(sharedCachePruneInterval);
        sharedCachePruneInterval = null;
      }
      if (globalRaf !== null) {
        cancelAnimationFrame(globalRaf);
        globalRaf = null;
      }
      if (sharedAudioCtx && sharedAudioCtx.state !== 'closed') {
        sharedAudioCtx.close().catch(() => {});
        sharedAudioCtx = null;
      }
    }
  }, 60_000);
}

function cleanupEntry(stream: MediaStream): void {
  const entry = sharedCache.get(stream);
  if (!entry) return;
  entry.source.disconnect();
  entry.analyser.disconnect();
  const track = stream.getAudioTracks()[0];
  if (track && entry.endedHandler) track.removeEventListener('ended', entry.endedHandler);
  sharedCache.delete(stream);

  if (sharedCache.size === 0) {
    if (globalRaf !== null) {
      cancelAnimationFrame(globalRaf);
      globalRaf = null;
    }
    if (sharedAudioCtx && sharedAudioCtx.state !== 'closed') {
      sharedAudioCtx.close().catch(() => {});
      sharedAudioCtx = null;
    }
  }
}

function getOrCreateEntry(stream: MediaStream): SharedEntry | null {
  let entry = sharedCache.get(stream);
  if (entry) return entry;

  ensurePruneInterval();
  try {
    const ctx = getSharedAudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.85;
    source.connect(analyser);

    const data = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    entry = {
      level: 0, listeners: new Set(), source, analyser,
      data, stream, endedHandler: null,
    };

    const track = stream.getAudioTracks()[0];
    if (track) {
      const onEnded = () => cleanupEntry(stream);
      entry.endedHandler = onEnded;
      track.addEventListener('ended', onEnded, { once: true });
    }

    sharedCache.set(stream, entry);
    ensureGlobalTick();
    return entry;
  } catch {
    return null;
  }
}

/**
 * Non-React subscriber for audio level changes.
 * Uses the same shared AudioContext + analyser infrastructure as useSharedAudioLevel.
 * Returns a cleanup function. Used by the overlay bridge for speaking detection
 * without introducing React hook dependencies.
 */
export function subscribeStreamAudioLevel(
  stream: MediaStream,
  callback: (level: number) => void,
): () => void {
  if (!stream || stream.getAudioTracks().length === 0) return () => {};

  const entry = getOrCreateEntry(stream);
  if (!entry) return () => {};

  const listener = () => callback(entry.level);
  entry.listeners.add(listener);
  callback(entry.level);

  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) cleanupEntry(stream);
  };
}

/**
 * Shared audio level for a stream: multiple components using the same stream
 * share a single AudioContext + analyser instead of creating duplicates.
 * All streams share ONE AudioContext to avoid Chrome's ~6 context limit.
 *
 * This hook triggers a re-render on every quantized level change. If you only
 * care about the speaking/not-speaking boolean (most UI does), use
 * `useSharedIsSpeaking` instead — it re-renders only on the flip, not on every
 * level step.
 */
export function useSharedAudioLevel(stream: MediaStream | null): number {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setLevel(0);
      return;
    }

    const entry = getOrCreateEntry(stream);
    if (!entry) {
      setLevel(0);
      return;
    }

    const listener = () => setLevel(entry.level);
    entry.listeners.add(listener);
    setLevel(entry.level);

    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) cleanupEntry(stream);
    };
  }, [stream]);

  return level;
}

/**
 * Boolean speaking indicator — re-renders only when the speaking/not-speaking
 * state flips, not on every level step. ~5-7× fewer re-renders than
 * `useSharedAudioLevel` for components that only need the boolean (the
 * waveform meter, name-color highlight, etc.).
 */
export function useSharedIsSpeaking(
  stream: MediaStream | null,
  threshold = 0.06,
): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setActive(false);
      return;
    }

    const entry = getOrCreateEntry(stream);
    if (!entry) {
      setActive(false);
      return;
    }

    let prev = entry.level > threshold;
    setActive(prev);

    const listener = () => {
      const next = entry.level > threshold;
      if (next !== prev) {
        prev = next;
        setActive(next);
      }
    };
    entry.listeners.add(listener);

    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) cleanupEntry(stream);
    };
  }, [stream, threshold]);

  return active;
}
