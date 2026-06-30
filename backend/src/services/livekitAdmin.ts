// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { RoomServiceClient } from 'livekit-server-sdk';
import { TrackSource } from '@livekit/protocol';
import { logger } from '../logger.js';
import { getDefaultRegion } from './livekitRegions.js';

const log = logger.child({ module: 'livekit-admin' });

let _client: RoomServiceClient | null = null;
let _clientUrl: string | null = null;

export function getRoomServiceClient(): RoomServiceClient | null {
  const region = getDefaultRegion();
  if (!region.apiKey || !region.apiSecret) return null;
  const httpUrl = region.url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  // Re-create client if the URL changed (e.g. after env reload)
  if (_client && _clientUrl === httpUrl) return _client;
  _client = new RoomServiceClient(httpUrl, region.apiKey, region.apiSecret);
  _clientUrl = httpUrl;
  log.info({ url: httpUrl }, 'LiveKit RoomServiceClient initialized');
  return _client;
}

const LIVEKIT_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`LiveKit ${label} timed out after ${LIVEKIT_TIMEOUT_MS}ms`)), LIVEKIT_TIMEOUT_MS)),
  ]);
}

/**
 * Hard-disconnect a participant from a LiveKit room at the SFU. Without this
 * call, a banned, kicked, or timed-out user with a cached LiveKit JWT can
 * continue to publish audio into the room for the remainder of the token's
 * TTL (bounded to 15 minutes by the token TTL). Best-effort: fails silently
 * if LiveKit is unreachable, the service lacks credentials, or the participant
 * is not currently in the room.
 */
export async function removeLiveKitParticipant(roomName: string, participantIdentity: string): Promise<void> {
  const client = getRoomServiceClient();
  if (!client) return;
  try {
    await withTimeout(client.removeParticipant(roomName, participantIdentity), 'removeParticipant');
    log.info({ roomName, participantIdentity }, 'SFU participant removed');
  } catch (err) {
    log.warn({ err, roomName, participantIdentity }, 'failed to remove participant via LiveKit API');
  }
}

/**
 * Server-side mute/unmute a participant's audio track in a LiveKit room.
 * Best-effort — fails silently if LiveKit is unreachable or the participant is not in the room.
 */
export async function muteParticipantAudio(roomName: string, participantIdentity: string, mute: boolean): Promise<void> {
  const client = getRoomServiceClient();
  if (!client) return;

  try {
    const participant = await withTimeout(client.getParticipant(roomName, participantIdentity), 'getParticipant');
    if (!participant || !participant.tracks) return;

    for (const track of participant.tracks) {
      if (track.source === TrackSource.MICROPHONE) {
        await withTimeout(client.mutePublishedTrack(roomName, participantIdentity, track.sid, mute), 'mutePublishedTrack');
        log.info({ roomName, participantIdentity, trackSid: track.sid, mute }, 'SFU track mute applied');
        return;
      }
    }
  } catch (err) {
    log.warn({ err, roomName, participantIdentity, mute }, 'failed to mute via LiveKit API (client-side enforcement still active)');
  }
}
