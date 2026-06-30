// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Shared LiveKit AccessToken minter used by the socket handlers (voice +
 * stage + dm-call) that return the token inline with their join ACK, and by
 * the legacy POST /livekit/token HTTP endpoint kept as a fallback.
 *
 * Inlining the token in the ACK saves the client one HTTP round trip to
 * api.howlpro.com — the only synchronization point is the socket ACK itself.
 * Discord's VOICE_SERVER_UPDATE follows the same shape.
 */
import { AccessToken } from 'livekit-server-sdk';
import { TrackSource } from '@livekit/protocol';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { type LiveKitRegion, getRegion, getDefaultRegion } from './livekitRegions.js';

const log = logger.child({ module: 'livekitTokens' });
// 15-minute TTL. The inline ACK mint runs on every join/reconnect, so client
// re-mint cost is negligible. Combined with removeLiveKitParticipant on
// ban/kick/timeout/GDPR, this bounds the post-moderation-action SFU access
// window to ≤15 minutes.
const TOKEN_TTL = '15m';

/**
 * Resolve the LiveKit region for a given server. Falls back to the default
 * region if the server-configured region isn't credentialed — same logic as
 * the HTTP POST /livekit/token endpoint, kept in sync so inline ACK minting
 * behaves identically.
 */
export async function resolveLiveKitRegionForServer(serverId: string): Promise<LiveKitRegion> {
  const settings = await prisma.serverSettings.findUnique({
    where: { serverId },
    select: { region: true },
  }).catch(() => null);
  const primary = getRegion(settings?.region ?? 'automatic');
  if (primary && primary.apiKey && primary.apiSecret) return primary;
  log.warn({ serverId, configuredRegion: settings?.region }, 'Primary region missing credentials — falling back to default');
  return getDefaultRegion();
}

export interface MintedAccessToken {
  token: string;
  url: string;
}

export interface MintAccessTokenOpts {
  userId: string;
  participantName: string;
  roomName: string;
  region: LiveKitRegion;
  canPublish: boolean;
  plan: 'free' | 'essential' | 'pro';
}

export async function mintLiveKitAccessToken(opts: MintAccessTokenOpts): Promise<MintedAccessToken | null> {
  const { userId, participantName, roomName, region, canPublish, plan } = opts;
  if (!region.apiKey || !region.apiSecret) return null;

  const maxCameraBitrate = plan === 'pro' ? 8_000_000 : plan === 'essential' ? 4_500_000 : 2_500_000;
  const maxCameraRes = plan === 'pro' ? '1440p' : plan === 'essential' ? '1080p' : '720p';
  const maxScreenShareBitrate = plan === 'pro' ? 5_000_000 : plan === 'essential' ? 3_000_000 : 2_000_000;

  const token = new AccessToken(region.apiKey, region.apiSecret, {
    identity: userId,
    name: participantName.slice(0, 32),
    ttl: TOKEN_TTL,
    metadata: JSON.stringify({ plan, maxCameraBitrate, maxCameraRes, maxScreenShareBitrate }),
  });
  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish,
    canSubscribe: true,
    canPublishData: true,
    canPublishSources: canPublish
      ? [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]
      : [],
  });

  const jwt = await token.toJwt();
  return { token: jwt, url: region.url };
}
