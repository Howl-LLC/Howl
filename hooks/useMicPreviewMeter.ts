// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect, useRef } from 'react';
import type { NoiseEngine, NoiseSuppression } from '../utils/settingsStorage';
import {
  buildMicProcessingChain,
  createDenoiserNode,
  destroyDenoiserNode,
  sensitivityPctToThreshold,
  thresholdToSensitivityPct,
  NS_FLOOR_UPDATE,
  NS_FLOOR_DECAY,
  NS_MIN_FLOOR,
  NS_OPEN_RATIO,
  NS_CLOSE_RATIO,
  INITIAL_NOISE_FLOOR,
  type MicProcessingNodes,
} from '../services/audio/micProcessingChain';

export interface UseMicPreviewMeterOptions {
  noiseEngine: NoiseEngine;
  noiseSuppression: NoiseSuppression;
  autoInputSensitivity: boolean;
  inputSensitivity: number;
}

export interface MicPreviewMeter {
  level: number;
  gateOpen: boolean;
  noiseFloorPct: number;
}

const ZERO_METER: MicPreviewMeter = { level: 0, gateOpen: false, noiseFloorPct: 0 };

export function useMicPreviewMeter(
  stream: MediaStream | null,
  opts: UseMicPreviewMeterOptions,
): MicPreviewMeter {
  const [meter, setMeter] = useState<MicPreviewMeter>(ZERO_METER);

  // Live-read refs so the rAF loop always sees current values without rebuilds
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Track stream + noiseEngine for rebuild triggers
  const prevEngineRef = useRef<NoiseEngine>(opts.noiseEngine);

  // Separate effect for noiseSuppression changes (no rebuild, just applyNodeParams)
  const nodesRef = useRef<MicProcessingNodes | null>(null);
  useEffect(() => {
    if (nodesRef.current) {
      nodesRef.current.applyNodeParams(opts.noiseSuppression);
    }
  }, [opts.noiseSuppression]);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setMeter(ZERO_METER);
      return;
    }

    let disposed = false;
    let rafId = 0;
    let ctx: AudioContext | null = null;
    let nodes: MicProcessingNodes | null = null;
    let denoiser: AudioWorkletNode | null = null;
    let denoiserEngine: NoiseEngine = optsRef.current.noiseEngine;

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) { setMeter(ZERO_METER); return; }

    try { ctx = new AudioCtx({ sampleRate: 48000 }); }
    catch { try { ctx = new AudioCtx(); } catch { setMeter(ZERO_METER); return; } }

    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    nodes = buildMicProcessingChain(ctx, stream, optsRef.current.noiseSuppression);
    if (!nodes) {
      ctx.close().catch(() => {});
      setMeter(ZERO_METER);
      return;
    }
    nodesRef.current = nodes;

    const analyser = nodes.analyser;
    const dataArray = new Float32Array(analyser.fftSize);
    let noiseFloor = INITIAL_NOISE_FLOOR;
    let autoGateOpen = false;

    // State for throttled updates
    let lastLevel = 0;
    let lastGateOpen = false;
    let lastNoiseFloorPct = 0;

    // Discord-style peak-hold + smooth decay for the visible level. The
    // raw RMS drops to ~0 the instant a user stops talking, which made
    // the meter "snap dark" before they could read the peak. We:
    //   1. Snap UP instantly when RMS exceeds the displayed level.
    //   2. Hold at peak for ~120ms after a new peak.
    //   3. Decay linearly back toward the live level at ~100% / 320ms.
    // dt is computed from performance.now() so the decay rate stays
    // consistent across 60Hz / 120Hz / 144Hz monitors. NOTE: only the
    // *displayed* level is smoothed — `gateOpen` keeps using the raw
    // RMS so push-to-talk / auto-gate UX isn't delayed by the visual
    // smoothing.
    const PEAK_HOLD_MS = 120;
    const DECAY_PER_MS = 100 / 320;
    let displayedLevel = 0;
    let peakHoldMsRemaining = 0;
    let lastFrameTime = performance.now();

    const poll = (): void => {
      if (disposed) return;
      const now = performance.now();
      // Cap dt at 50ms so a tab refocus doesn't instantly drain the
      // meter when rAF resumes (would erase the user's last peak).
      const dt = Math.min(50, now - lastFrameTime);
      lastFrameTime = now;

      analyser.getFloatTimeDomainData(dataArray);
      let sumSquares = 0;
      for (let i = 0; i < dataArray.length; i++) sumSquares += dataArray[i] * dataArray[i];
      const rms = Math.sqrt(sumSquares / dataArray.length);
      const rmsLevel = thresholdToSensitivityPct(rms);

      if (rmsLevel >= displayedLevel) {
        displayedLevel = rmsLevel;
        peakHoldMsRemaining = PEAK_HOLD_MS;
      } else if (peakHoldMsRemaining > 0) {
        peakHoldMsRemaining = Math.max(0, peakHoldMsRemaining - dt);
      } else {
        displayedLevel = Math.max(rmsLevel, displayedLevel - DECAY_PER_MS * dt);
      }
      const level = Math.round(displayedLevel);

      const { autoInputSensitivity, inputSensitivity } = optsRef.current;
      let gateOpen: boolean;
      let nfPct: number;

      if (autoInputSensitivity) {
        if (rms < noiseFloor * 1.5) {
          noiseFloor = noiseFloor * NS_FLOOR_UPDATE + rms * (1 - NS_FLOOR_UPDATE);
        } else {
          noiseFloor *= NS_FLOOR_DECAY;
        }
        if (noiseFloor < NS_MIN_FLOOR) noiseFloor = NS_MIN_FLOOR;
        const openT = noiseFloor * NS_OPEN_RATIO;
        const closeT = noiseFloor * NS_CLOSE_RATIO;
        if (autoGateOpen) { if (rms < closeT) autoGateOpen = false; }
        else { if (rms > openT) autoGateOpen = true; }
        gateOpen = autoGateOpen;
        nfPct = Math.round(thresholdToSensitivityPct(noiseFloor * NS_OPEN_RATIO));
      } else {
        const threshold = sensitivityPctToThreshold(inputSensitivity);
        gateOpen = rms >= threshold;
        nfPct = 0;
      }

      // Only setState when values actually changed (throttled to 1% granularity)
      if (level !== lastLevel || gateOpen !== lastGateOpen || nfPct !== lastNoiseFloorPct) {
        lastLevel = level;
        lastGateOpen = gateOpen;
        lastNoiseFloorPct = nfPct;
        setMeter({ level, gateOpen, noiseFloorPct: nfPct });
      }

      rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);

    // Async-insert denoiser between compressor and analyser
    const engine = optsRef.current.noiseEngine;
    if (engine !== 'off') {
      const capturedNodes = nodes;
      createDenoiserNode(ctx, engine).then((node) => {
        if (!node) return;
        if (disposed) {
          try { destroyDenoiserNode(node, engine); } catch { /* */ }
          return;
        }
        try {
          capturedNodes.compressor.disconnect(capturedNodes.analyser);
          capturedNodes.compressor.connect(node);
          node.connect(capturedNodes.analyser);
          denoiser = node;
          denoiserEngine = engine;
        } catch {
          try { destroyDenoiserNode(node, engine); } catch { /* */ }
          try { capturedNodes.compressor.connect(capturedNodes.analyser); } catch { /* */ }
        }
      }).catch(() => {});
    }

    // Track ended on the stream's audio track to auto-cleanup
    const track = stream.getAudioTracks()[0];
    const onTrackEnded = () => { if (!disposed) cleanup(); };
    track?.addEventListener('ended', onTrackEnded, { once: true });

    function cleanup() {
      disposed = true;
      cancelAnimationFrame(rafId);
      if (denoiser) {
        try { destroyDenoiserNode(denoiser, denoiserEngine); } catch { /* */ }
        denoiser = null;
      }
      if (nodes) {
        try { nodes.sourceNode.disconnect(); } catch { /* */ }
        try { nodes.hpf.disconnect(); } catch { /* */ }
        try { nodes.compressor.disconnect(); } catch { /* */ }
        try { nodes.analyser.disconnect(); } catch { /* */ }
        try { nodes.gainNode.disconnect(); } catch { /* */ }
        try { nodes.limiter.disconnect(); } catch { /* */ }
        try { nodes.destination.disconnect(); } catch { /* */ }
        nodesRef.current = null;
        nodes = null;
      }
      track?.removeEventListener('ended', onTrackEnded);
      ctx?.close().catch(() => {});
      ctx = null;
      setMeter(ZERO_METER);
    }

    prevEngineRef.current = optsRef.current.noiseEngine;
    return cleanup;
  }, [stream, opts.noiseEngine]);

  return meter;
}
