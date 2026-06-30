// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Memoized feature-detection probes for capabilities that are expensive to
// check and can't change within a browser session.
//
// Callers should use these instead of ad-hoc getContext() / dynamic-import
// probes so the actual probe runs at most once per page/session.

let webglCache: boolean | null = null;
let webgl2Cache: boolean | null = null;
let mediaPipeCache: Promise<boolean> | null = null;

function probeWebGLContext(contextType: 'webgl' | 'webgl2' | 'experimental-webgl'): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext(contextType) as WebGLRenderingContext | WebGL2RenderingContext | null;
    if (!gl) return false;
    // Proactively release the GPU context; the canvas itself is GC'd after return.
    const loseCtx = gl.getExtension?.('WEBGL_lose_context') as { loseContext?: () => void } | null;
    loseCtx?.loseContext?.();
    return true;
  } catch {
    return false;
  }
}

export function hasWebGL(): boolean {
  if (webglCache !== null) return webglCache;
  webglCache = probeWebGLContext('webgl') || probeWebGLContext('experimental-webgl');
  return webglCache;
}

export function hasWebGL2(): boolean {
  if (webgl2Cache !== null) return webgl2Cache;
  webgl2Cache = probeWebGLContext('webgl2');
  return webgl2Cache;
}

// Async because it dynamically imports the MediaPipe tasks-vision bundle and
// resolves the WASM fileset. Cached so the bundle loads at most once.
// Concurrent callers share the same in-flight promise. WASM is served from
// our own bundle under /mediapipe/wasm so Electron offline launches work.
export async function hasMediaPipeTasks(): Promise<boolean> {
  if (mediaPipeCache !== null) return mediaPipeCache;
  mediaPipeCache = (async () => {
    try {
      const vision = await import('@mediapipe/tasks-vision');
      await vision.FilesetResolver.forVisionTasks(
        `${import.meta.env.BASE_URL}mediapipe/wasm`,
      );
      return true;
    } catch {
      return false;
    }
  })();
  return mediaPipeCache;
}

export function resetCapabilityCache(): void {
  webglCache = null;
  webgl2Cache = null;
  mediaPipeCache = null;
}
