// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { decodeMlsMessage } from 'ts-mls';
import { copyBytes } from './serialization.js';

export type CommitClassification =
  | { ok: true; wireformat: 'mls_private_message' | 'mls_public_message'; baseEpoch: bigint }
  | { ok: false; reason: 'malformed' | 'wrong_wireformat' };

/**
 * Decode a submitted commit from a COPIED buffer (move-not-borrow), classify its
 * wireformat, and extract the authoritative base epoch from the wire (NOT a
 * client-supplied integer). Member commits arrive as mls_private_message, whose
 * header carries epoch (PrivateMessage.epoch). External Commits arrive as
 * mls_public_message, whose FramedContent carries content.epoch. Admission is
 * well-formedness + wireformat + epoch extraction only; full crypto membership
 * validation is member-side. decodeMlsMessage returns undefined on bad input.
 */
export function classifyCommit(commitBytes: Uint8Array): CommitClassification {
  let decoded: ReturnType<typeof decodeMlsMessage>;
  try {
    decoded = decodeMlsMessage(copyBytes(commitBytes), 0);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!decoded) return { ok: false, reason: 'malformed' };
  const [msg] = decoded;
  if (msg.wireformat === 'mls_private_message') {
    return { ok: true, wireformat: msg.wireformat, baseEpoch: msg.privateMessage.epoch };
  }
  if (msg.wireformat === 'mls_public_message') {
    return { ok: true, wireformat: msg.wireformat, baseEpoch: msg.publicMessage.content.epoch };
  }
  return { ok: false, reason: 'wrong_wireformat' };
}
