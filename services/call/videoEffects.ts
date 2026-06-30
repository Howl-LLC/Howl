// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Lazy imports — loaded on first use
let loadPromise: Promise<void> | null = null;
let supportsBackgroundProcessorsFn: (() => boolean) | null = null;

async function ensureBackgroundModule() {
  if (supportsBackgroundProcessorsFn) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const mod = await import('@livekit/track-processors');
        supportsBackgroundProcessorsFn = mod.supportsBackgroundProcessors;
      } catch (err) {
        // Reset on failure so the next call can retry the dynamic import.
        loadPromise = null;
        throw err;
      }
    })();
  }
  await loadPromise;
}

export async function checkBackgroundSupport(): Promise<boolean> {
  try {
    await ensureBackgroundModule();
    return supportsBackgroundProcessorsFn?.() ?? false;
  } catch {
    return false;
  }
}
