// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { StageSession } from '../types';
import { apiClient } from '../services/api';

/** Resolve an asset URL through the API client's CDN helper. */
export const resolveAsset = (url?: string | null): string | undefined =>
  apiClient.resolveAssetUrl(url ?? undefined) ?? url ?? undefined;

/** Normalize speaker/audience/hand-raise avatar/banner URLs in a StageSession payload. */
export const normalizeStageSession = (session: StageSession): StageSession => ({
  ...session,
  speakers: session.speakers.map(s => ({
    ...s,
    avatar: resolveAsset(s.avatar) ?? null,
    banner: resolveAsset(s.banner) ?? null,
  })),
  audienceMembers: session.audienceMembers?.map(m => ({
    ...m,
    avatar: resolveAsset(m.avatar) ?? null,
  })),
  handRaises: session.handRaises.map(h => ({
    ...h,
    avatar: resolveAsset(h.avatar) ?? null,
  })),
});
