// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { ClientState } from 'ts-mls';

/** ts-mls's ClientState is the in-memory MLS group state we thread through the engine. */
export type MlsClientState = ClientState;
/** A DM channel id (uuid). One MLS group per DMChannel. */
export type MlsChannelId = string;
/** A server-assigned MLS group id (uuid). */
export type MlsGroupId = string;
/** A decimal uint64 epoch, transported as a string. */
export type EpochString = string;

/** The self-describing application-message envelope version for MLS. */
export const MLS_ENVELOPE_VERSION = 4 as const;

/** v:4 envelope. `m` is base64 of a wire-format MLSMessage (mls_private_message). */
export interface MlsEnvelopeV4 {
  v: 4;
  m: string;
}

/** Base64-encode raw bytes using the browser-native btoa over a binary string. */
function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode base64 to raw bytes using the browser-native atob. Throws on bad input. */
function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Wrap wire-format MLSMessage bytes into the JSON string stored as message
 * `content`. The transport relays `content` verbatim.
 */
export function encodeMlsEnvelope(mlsMessageBytes: Uint8Array): string {
  const envelope: MlsEnvelopeV4 = { v: MLS_ENVELOPE_VERSION, m: bytesToB64(mlsMessageBytes) };
  return JSON.stringify(envelope);
}

/**
 * Return the MLSMessage bytes iff `content` is a well-formed v:4 envelope,
 * else null. Never throws: malformed JSON, wrong version, missing/mistyped `m`,
 * or non-base64 `m` all return null so callers can fail closed.
 */
export function tryParseMlsEnvelope(content: string): Uint8Array | null {
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  if (rec.v !== MLS_ENVELOPE_VERSION) return null;
  if (typeof rec.m !== 'string') return null;
  try {
    return b64ToBytes(rec.m);
  } catch {
    return null;
  }
}

/** True iff `content` parses as a well-formed v:4 envelope. */
export function isMlsEnvelopeV4(content: string): boolean {
  return tryParseMlsEnvelope(content) !== null;
}
