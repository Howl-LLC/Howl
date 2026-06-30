// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { decodeMlsMessage } from 'ts-mls';
import { ratchetTreeFromExtension } from 'ts-mls/groupInfo.js';
import { copyBytes } from './serialization.js';
import { decodeMlsIdentity } from './credential.js';

export type ParseRemovedResult =
  | { ok: true; leaves: number[] }
  | { ok: false; reason: 'malformed_commit' | 'not_public' | 'not_commit' | 'by_ref_proposal' };

/**
 * Read the inline Remove proposals' target leaf indices from a PublicMessage
 * member commit. Returns { leaves: [] } for a commit that removes nobody
 * (Add/Update). Fails closed on a private commit, a non-commit, or a
 * by-reference proposal (Howl only ever sends inline proposals, so a by-ref
 * proposal we cannot see is treated as unauthorizable).
 */
export function parseRemovedLeaves(commitBytes: Uint8Array): ParseRemovedResult {
  let decoded: ReturnType<typeof decodeMlsMessage>;
  try {
    decoded = decodeMlsMessage(copyBytes(commitBytes), 0);
  } catch {
    return { ok: false, reason: 'malformed_commit' };
  }
  if (!decoded) return { ok: false, reason: 'malformed_commit' };
  const [msg] = decoded;
  if (msg.wireformat !== 'mls_public_message') return { ok: false, reason: 'not_public' };
  const content = msg.publicMessage.content;
  if (content.contentType !== 'commit') return { ok: false, reason: 'not_commit' };
  const leaves: number[] = [];
  for (const por of content.commit.proposals) {
    if (por.proposalOrRefType !== 'proposal') return { ok: false, reason: 'by_ref_proposal' };
    if (por.proposal.proposalType === 'remove') leaves.push(por.proposal.remove.removed);
  }
  return { ok: true, leaves };
}

export type MapLeavesResult =
  | { ok: true; userIds: string[] }
  | { ok: false; reason: 'malformed_groupinfo' | 'not_groupinfo' | 'no_tree' | 'leaf_not_found' | 'non_basic_credential' };

/**
 * Resolve each leaf index to the userId portion of its basic credential, using
 * the ratchet tree embedded in the supplied (pre-commit, epoch-N) GroupInfo
 * MLSMessage. A leaf at logical index i sits at node-array position 2*i (mirrors
 * services/mls/mlsEngine.ts resolveLeafIndex). Fails closed on any leaf it
 * cannot resolve.
 */
export function mapLeafIndicesToUserIds(groupInfoBytes: Uint8Array, leafIndices: number[]): MapLeavesResult {
  let decoded: ReturnType<typeof decodeMlsMessage>;
  try {
    decoded = decodeMlsMessage(copyBytes(groupInfoBytes), 0);
  } catch {
    return { ok: false, reason: 'malformed_groupinfo' };
  }
  if (!decoded) return { ok: false, reason: 'malformed_groupinfo' };
  const [msg] = decoded;
  if (msg.wireformat !== 'mls_group_info') return { ok: false, reason: 'not_groupinfo' };
  let tree: ReturnType<typeof ratchetTreeFromExtension>;
  try {
    tree = ratchetTreeFromExtension(msg.groupInfo);
  } catch {
    // ratchetTreeFromExtension lazily re-decodes the ratchet_tree extension's
    // inner bytes (treated as opaque by decodeMlsMessage) and throws a
    // CodecError if they are corrupt/truncated. group.groupInfo is
    // client-uploaded and not crypto-validated for its embedded tree, so a
    // corrupt embedded tree is a malformed groupinfo: fail closed.
    return { ok: false, reason: 'malformed_groupinfo' };
  }
  if (!tree) return { ok: false, reason: 'no_tree' };
  const userIds: string[] = [];
  for (const leafIndex of leafIndices) {
    const node = tree[2 * leafIndex];
    if (!node || node.nodeType !== 'leaf') return { ok: false, reason: 'leaf_not_found' };
    const cred = node.leaf.credential;
    if (cred.credentialType !== 'basic') return { ok: false, reason: 'non_basic_credential' };
    try {
      userIds.push(decodeMlsIdentity(cred.identity).userId);
    } catch {
      return { ok: false, reason: 'non_basic_credential' };
    }
  }
  return { ok: true, userIds };
}

export type ParseAddedResult =
  | { ok: true; userIds: string[] }
  | { ok: false; reason: 'malformed_commit' | 'not_public' | 'not_commit' | 'by_ref_proposal' | 'non_basic_credential' };

/**
 * Read the inline Add proposals' added userIds from a PublicMessage member
 * commit. Each Add embeds the new member's full KeyPackage, so the credential is
 * in-band (no GroupInfo/ratchet-tree lookup, unlike Remove). Fails closed on a
 * private commit, a non-commit, a by-reference proposal, or a non-basic credential.
 */
export function parseAddedLeaves(commitBytes: Uint8Array): ParseAddedResult {
  let decoded: ReturnType<typeof decodeMlsMessage>;
  try {
    decoded = decodeMlsMessage(copyBytes(commitBytes), 0);
  } catch {
    return { ok: false, reason: 'malformed_commit' };
  }
  if (!decoded) return { ok: false, reason: 'malformed_commit' };
  const [msg] = decoded;
  if (msg.wireformat !== 'mls_public_message') return { ok: false, reason: 'not_public' };
  const content = msg.publicMessage.content;
  if (content.contentType !== 'commit') return { ok: false, reason: 'not_commit' };
  const userIds: string[] = [];
  for (const por of content.commit.proposals) {
    if (por.proposalOrRefType !== 'proposal') return { ok: false, reason: 'by_ref_proposal' };
    if (por.proposal.proposalType !== 'add') continue;
    const cred = por.proposal.add.keyPackage.leafNode.credential;
    if (cred.credentialType !== 'basic') return { ok: false, reason: 'non_basic_credential' };
    try {
      userIds.push(decodeMlsIdentity(cred.identity).userId);
    } catch {
      return { ok: false, reason: 'non_basic_credential' };
    }
  }
  return { ok: true, userIds };
}
