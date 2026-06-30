// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { GradeId } from './colorGradeProcessor';
import type { AutoFrameMode } from '../../utils/settingsStorage';
import { createCameraPipeline, type CameraPipelineHandle } from './CameraPipeline';

export interface CameraEffectSettings {
  /** Auto-frame smoothness level. 'off' disables detection entirely. */
  autoFrameMode?: AutoFrameMode;
  autoFrameZoom?: number;
  /** When true, zoom is computed dynamically from face bounding-box width. */
  autoFrameZoomAuto?: boolean;
  videoColorGradeEnabled?: boolean;
  videoColorGrade?: GradeId;
  /** 'off' / 'blur' / 'image' — mirrors voiceSettings.videoBackgroundMode. */
  videoBackgroundMode?: 'off' | 'blur' | 'image';
  /** Blur strength (1-30ish). Ignored when mode !== 'blur'. */
  videoBackgroundBlurRadius?: number;
  /** Image URL for virtual background. Ignored when mode !== 'image'. */
  videoBackgroundImageUrl?: string;
}

export interface ProcessedStreamHandle {
  stream: MediaStream;
  /** Stop the processor and release resources. Idempotent. */
  cleanup: () => void;
  /**
   * The underlying CameraPipeline handle. Exposes live-update methods
   * (updateAutoFrame, updateZoom, updateColorGrade, updateBackground)
   * so callers can change effects mid-stream without rebuilding.
   */
  pipeline: CameraPipelineHandle;
}

/**
 * Takes a raw `getUserMedia` MediaStream + effect settings and returns a
 * processed stream with autoframe, color grade, and optional background
 * blur / virtual background applied.
 *
 * Delegates to `createCameraPipeline` which automatically selects the
 * Worker-based pipeline (Chromium/Electron) or main-thread fallback
 * (Firefox/older Safari). The returned handle includes a `pipeline`
 * property with live-update methods for mid-call effect changes.
 *
 * If no effect is active, returns the raw stream and a noop cleanup.
 */
export async function buildProcessedCameraStream(
  rawStream: MediaStream,
  settings: CameraEffectSettings,
): Promise<ProcessedStreamHandle> {
  const pipelineHandle = await createCameraPipeline(rawStream, settings);

  return {
    stream: pipelineHandle.processedStream,
    cleanup: () => pipelineHandle.stop(),
    pipeline: pipelineHandle,
  };
}
