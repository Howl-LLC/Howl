// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { logger } from '../logger.js';

export interface LiveKitRegion {
  id: string;
  name: string;
  url: string;
  apiKey: string;
  apiSecret: string;
}

let regions: LiveKitRegion[] | null = null;

function loadRegions(): LiveKitRegion[] {
  if (regions) return regions;

  const raw = process.env.LIVEKIT_REGIONS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as LiveKitRegion[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        regions = parsed;
        logger.info({ count: parsed.length }, 'Loaded LiveKit regions from LIVEKIT_REGIONS');
        return regions;
      }
    } catch (e) {
      logger.warn({ error: (e as Error).message }, 'Failed to parse LIVEKIT_REGIONS, falling back to single region');
    }
  }

  const url = process.env.LIVEKIT_WS_URL || process.env.LIVEKIT_URL || 'ws://localhost:7880';
  const apiKey = process.env.LIVEKIT_API_KEY || '';
  const apiSecret = process.env.LIVEKIT_API_SECRET || '';

  regions = [{
    id: 'default',
    name: 'Default',
    url,
    apiKey,
    apiSecret,
  }];
  return regions;
}

export function getAllRegions(): LiveKitRegion[] {
  return loadRegions();
}

export function getRegion(id: string): LiveKitRegion {
  const all = loadRegions();
  if (id === 'automatic' || !id) return all[0];
  return all.find(r => r.id === id) ?? all[0];
}

export function getDefaultRegion(): LiveKitRegion {
  return loadRegions()[0];
}

export function getRegionListForClient(): { id: string; name: string }[] {
  return loadRegions().map(r => ({ id: r.id, name: r.name }));
}
