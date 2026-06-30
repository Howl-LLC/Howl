// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { z, ZodSchema } from 'zod';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function parseSocketPayload<T>(schema: ZodSchema<T>, data: unknown): T | null {
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}

export const typingPayload = z.object({
  channelId: z.string().uuid().optional(),
  dmChannelId: z.string().uuid().optional(),
}).passthrough().refine(d => d.channelId || d.dmChannelId, 'channelId or dmChannelId required');

export const voiceStatePayload = z.object({
  channelId: z.string().uuid(),
  isMuted: z.boolean(),
  isDeafened: z.boolean(),
}).passthrough();

export const soundboardPayload = z.object({
  channelId: z.string().uuid(),
  soundId: z.string().uuid(),
}).passthrough();

export const joinDmCallPayload = z.object({
  dmChannelId: z.string().uuid(),
  username: z.string().max(100).optional(),
  avatar: z.string().max(2048).optional(),
  banner: z.string().max(2048).optional(),
  withVideo: z.boolean().optional(),
  /** Joiner's MLS-call readiness; opaque to the server (stored + relayed,
   *  never interpreted). The symmetric useMls AND is computed client-side. */
  mlsCallReady: z.boolean().optional(),
}).passthrough();

// The signed voice join blob stays .strict() — extra fields would change
// what the signature covers. If the blob shape needs to evolve, bump the
// `v` literal to 2 and add a v2 variant alongside.
export const signedVoiceJoinBlob = z.object({
  v: z.literal(1),
  channelId: z.string().uuid(),
  joinTimestamp: z.number().int().min(0).max(9_999_999_999_999),
  pub: z.string().min(1).max(512),
  sigPub: z.string().min(1).max(512),
}).strict();

export const joinVoicePayload = z.object({
  channelId: z.string().uuid(),
  // Client-sent profile hints. Server does NOT trust these — it re-derives
  // from the authenticated DB row. Matches joinDmCallPayload.
  username: z.string().max(100).optional(),
  avatar: z.string().max(2048).optional(),
  banner: z.string().max(2048).optional(),
  joinBlob: signedVoiceJoinBlob.optional(),
  signature: z.string().min(1).max(512).optional(),
}).passthrough();

export const serverMutePayload = z.object({
  channelId: z.string().uuid(),
  targetUserId: z.string().uuid(),
  muted: z.boolean(),
}).passthrough();

export const serverDeafenPayload = z.object({
  channelId: z.string().uuid(),
  targetUserId: z.string().uuid(),
  deafened: z.boolean(),
}).passthrough();

export const moveVoicePayload = z.object({
  targetUserId: z.string().uuid(),
  fromChannelId: z.string().uuid(),
  toChannelId: z.string().uuid(),
}).passthrough();

export const dmCallStatePayload = z.object({
  dmChannelId: z.string().uuid(),
  isMuted: z.boolean(),
  isDeafened: z.boolean(),
}).passthrough();

// Client → server: the local user reports whether E2EE is established on their
// own SFrame leg. Relayed to the rest of the dm-call room so peers can render a
// bilateral encryption shield instead of over-claiming on local key possession.
export const dmCallE2eeAckPayload = z.object({
  dmChannelId: z.string().uuid(),
  ok: z.boolean(),
}).passthrough();

export const leaveVoicePayload = z.object({
  channelId: z.string().uuid(),
}).passthrough();

// Client → server: advertise that the local user has started or stopped
// publishing a screen track in the given voice channel. The server persists
// the bit on the participant record and re-broadcasts the participant list
// so other server members can render a "watch stream" indicator in the
// sidebar voice list.
export const voiceScreenSharePayload = z.object({
  channelId: z.string().uuid(),
  isScreenSharing: z.boolean(),
}).passthrough();

export const leaveDmCallPayload = z.object({
  dmChannelId: z.string().uuid(),
}).passthrough();

export const declineDmCallPayload = z.object({
  dmChannelId: z.string().uuid(),
}).passthrough();

export const setActivityPayload = z.object({
  type: z.enum(['detected_game', 'custom', 'spotify']),
  name: z.string().min(1).max(128),
  details: z.string().max(256).optional(),
  state: z.string().max(128).optional(),
  durationMs: z.number().int().min(0).max(3600000).optional(),
  /**
   * For detected_game: Steam appid when known, used to derive store header
   * art URLs. For other types this is set by server-side polls.
   */
  platformId: z.string().max(64).optional(),
}).passthrough();

export const voiceE2eeDistributePayload = z.object({
  channelId: z.string().uuid(),
  targetUserId: z.string().uuid(),
  encryptedKey: z.string().min(1).max(512),
  nonce: z.string().min(1).max(512),
  keyFormat: z.string().max(64).optional(), // defaults to "sframe.v1" if missing
}).passthrough();

export const voiceE2eeRequestKeyPayload = z.object({
  channelId: z.string().uuid(),
  publicKey: z.string().min(1).max(512),
  /** Optional client-elected target; server forwards here if the user is in
   *  the channel, else falls back to oldest-first. */
  targetUserId: z.string().uuid().optional(),
  // Client-advertised capabilities carried through so leader can pick a dialect.
  // Also optional — a pre-versioning client won't send it.
  capabilities: z.array(z.string().max(64)).max(32).optional(),
}).passthrough();

// Stage host attestation — signed by the host, verified client-side by the
// audience against a pinned AIK. Stays .strict() so extra fields can't change
// what the signature covers; bump `v` to evolve (mirrors signedVoiceJoinBlob).
export const stageHostBlob = z.object({
  v: z.literal(1),
  channelId: z.string().uuid(),
  pub: z.string().min(1).max(512),
  sigPub: z.string().min(1).max(512),
}).strict();

export const stageE2eeDistributePayload = z.object({
  channelId: z.string().uuid(),
  targetUserId: z.string().uuid(),
  encryptedKey: z.string().min(1).max(512),
  nonce: z.string().min(1).max(512),
  keyFormat: z.string().max(64).optional(),
  // Signed host attestation, relayed verbatim so the audience can verify the
  // distributor against a pinned AIK. The server does not interpret it.
  hostBlob: stageHostBlob.optional(),
  hostSignature: z.string().min(1).max(512).optional(),
}).passthrough();

// Audience-side stage key request. Mirrors voiceE2eeRequestKeyPayload:
// a participant (speaker or audience) who never received the SFrame session key
// (host push lost, host mid-reconnect, host abruptly left) asks the server to
// re-trigger distribution from the current stage leader.
export const stageE2eeRequestKeyPayload = z.object({
  channelId: z.string().uuid(),
  publicKey: z.string().min(1).max(512),
  // Client-advertised capabilities carried through so the host can pick a
  // dialect. Optional — a pre-versioning client won't send it.
  capabilities: z.array(z.string().max(64)).max(32).optional(),
}).passthrough();

// Viewer tracking schemas

const streamContextSchema = z.object({
  kind: z.enum(['voice', 'dm', 'stage']),
  scopeId: z.string().uuid(),
}).passthrough();

export const viewerSubscribePayload = z.object({
  context: streamContextSchema,
  streamOwnerId: z.string().uuid(),
  streamType: z.literal('screen'),
}).passthrough();

export const viewerUnsubscribePayload = viewerSubscribePayload;

export const viewerListPayload = z.object({
  context: streamContextSchema,
  streamOwnerId: z.string().uuid(),
  streamType: z.literal('screen'),
  page: z.number().int().min(0).max(10_000).optional(),
}).passthrough();

export type ViewerSubscribePayload = z.infer<typeof viewerSubscribePayload>;
export type ViewerUnsubscribePayload = z.infer<typeof viewerUnsubscribePayload>;
export type ViewerListPayload = z.infer<typeof viewerListPayload>;

// MLS DS push events. Additive .passthrough(); epoch is a
// decimal string (uint64). See docs/PROTOCOL_CHANGES.md.
export const mlsCommitPayload = z
  .object({
    groupId: z.string().uuid(),
    epoch: z.string().regex(/^\d+$/),
    commit: z.string().min(1), // base64 MLSMessage, relayed verbatim
  })
  .passthrough();

export const mlsWelcomePayload = z
  .object({
    groupId: z.string().uuid(),
    epoch: z.string().regex(/^\d+$/),
  })
  .passthrough();

export const mlsKeypackagesLowPayload = z
  .object({
    deviceId: z.string().uuid(),
    remaining: z.number().int().min(0),
  })
  .passthrough();

// Server -> client `new-dm-channel` push (and the GET /dms list entry shape).
// Additive `mlsGroupId`: saved-tier MLS group id for this DM channel,
// or null/absent when none exists. Mapping convenience only; it cannot drive
// client protocol selection. The rest of the payload varies by 1:1 vs group and
// is intentionally not re-validated here — .passthrough() keeps this additive
// and old-client safe per docs/PROTOCOL_CHANGES.md.
export const newDmChannelPayload = z
  .object({
    id: z.string().uuid(),
    encrypted: z.boolean().optional(),
    mlsGroupId: z.string().uuid().nullable().optional(),
  })
  .passthrough();

// OTR ephemeral delivery. Additive .passthrough(); ciphertext is a
// base64 MLS application message, bounded well under the 50KB socket cap.
export const otrMessagePayload = z
  .object({
    dmChannelId: z.string().uuid(),
    mlsGroupId: z.string().uuid(),
    clientMsgId: z.string().uuid(),
    ciphertext: z.string().min(1).max(32_000),
  })
  .passthrough();

export const otrAckPayload = z
  .object({ clientMsgId: z.string().uuid() })
  .passthrough();

export const otrPullPayload = z.object({}).passthrough();

