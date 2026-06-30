// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * mlsClient — typed client for the MLS REST surface and the two MLS
 * socket events. Wire encoding per the contract: opaque artifacts base64,
 * epochs decimal strings, idempotencyKey >= 8 chars (caller-supplied).
 *
 * All REST goes through apiClient.request (token + API_BASE_URL + 401-refresh),
 * EXCEPT submitCommit's conflict branch, which needs the full 409 body
 * (`recovery`, `currentEpoch`) that request() discards on a thrown error. That
 * one branch issues a raw fetch using apiClient.getToken() + API_BASE_URL.
 *
 * Endpoints are relative to API_BASE_URL, which already includes `/api/v1`, so
 * the MLS prefix here is `/mls/...` (mirrors how dmKeys uses `/dms/keys/...`).
 */
import { apiClient } from '../api';
import { socketService } from '../socket';
import { API_BASE_URL } from '../../config';
import { toBase64 } from '../cryptoHelpers';
import type { MlsTier } from './roomKey';

/**
 * Deterministic idempotency key for a logical commit: base64(sha256(colon-joined)).
 * The SAME logical commit yields the SAME key, so a network-timeout resubmit reuses
 * it and the server returns the original outcome; a genuine rebase onto a new
 * baseEpoch yields a new key. Consumed by mlsCoordinator (createDmGroup +
 * the CAS rebase loop). Output is 44 base64 chars (>= the contract's 8-char floor).
 */
export async function idempotencyKeyFor(
  groupId: string,
  baseEpoch: string,
  kind: string,
  recipientId?: string,
): Promise<string> {
  const input = `${groupId}:${baseEpoch}:${kind}:${recipientId ?? ''}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toBase64(new Uint8Array(digest));
}

// KeyPackages

export interface PublishResult {
  published: number;
  remaining: number;
}

export function publishKeyPackages(
  deviceId: string,
  kps: { keyPackage: string; isLastResort: boolean }[],
): Promise<PublishResult> {
  return apiClient.request<PublishResult>('/mls/keypackages', {
    method: 'POST',
    body: JSON.stringify({ deviceId, keyPackages: kps }),
  });
}

export function keyPackageCount(deviceId: string): Promise<{ remaining: number; hasLastResort: boolean }> {
  return apiClient.request<{ remaining: number; hasLastResort: boolean }>(
    `/mls/keypackages/count?deviceId=${encodeURIComponent(deviceId)}`,
  );
}

export interface ConsumedKeyPackage {
  deviceId: string;
  keyPackage: string;
  keyPackageRef: string;
  isLastResort: boolean;
}

export async function consumeKeyPackages(targetUserId: string): Promise<ConsumedKeyPackage[]> {
  const res = await apiClient.request<{ keyPackages: ConsumedKeyPackage[] }>(
    `/mls/keypackages/${targetUserId}`,
  );
  return res.keyPackages;
}

// Groups

export function createGroup(
  dmChannelId: string,
  groupInfoB64: string,
  tier: MlsTier = 'saved',
): Promise<{ groupId: string; currentEpoch: string }> {
  return apiClient.request<{ groupId: string; currentEpoch: string }>('/mls/groups', {
    method: 'POST',
    body: JSON.stringify({ dmChannelId, tier, groupInfo: groupInfoB64 }),
  });
}

export function getGroupInfo(groupId: string): Promise<{ groupInfo: string; groupInfoEpoch: string }> {
  return apiClient.request<{ groupInfo: string; groupInfoEpoch: string }>(
    `/mls/groups/${groupId}/group-info`,
  );
}

// Commits (CAS)

export interface SubmitCommitArgs {
  groupId: string;
  baseEpoch: string;
  mode: 'member' | 'external';
  commitB64: string;
  groupInfoB64: string;
  idempotencyKey: string;
  welcomes?: { recipientId: string; welcomeData: string }[];
  removedUserIds?: string[];
}

export type SubmitCommitResult =
  | { ok: true; epoch: string; commitId: string; idempotent?: boolean }
  | { ok: false; conflict: 'rebase' | 'refetch_group_info'; currentEpoch: string | null };

export async function submitCommit(args: SubmitCommitArgs): Promise<SubmitCommitResult> {
  const body = {
    baseEpoch: args.baseEpoch,
    mode: args.mode,
    commit: args.commitB64,
    groupInfo: args.groupInfoB64,
    idempotencyKey: args.idempotencyKey,
    ...(args.welcomes ? { welcomes: args.welcomes } : {}),
    ...(args.removedUserIds ? { removedUserIds: args.removedUserIds } : {}),
  };
  try {
    // Happy path (incl. idempotent 200) returns through normal JSON.
    const res = await apiClient.request<{ epoch: string; commitId: string; idempotent?: boolean }>(
      `/mls/groups/${args.groupId}/commits`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return res.idempotent
      ? { ok: true, epoch: res.epoch, commitId: res.commitId, idempotent: true }
      : { ok: true, epoch: res.epoch, commitId: res.commitId };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 409) throw err; // never swallow non-conflict failures

    // Re-read the full 409 body (recovery + currentEpoch) via a raw fetch; the
    // shared request() helper only surfaces the `error` string on a throw.
    const token = apiClient.getToken();
    const res = await fetch(`${API_BASE_URL}/mls/groups/${args.groupId}/commits`, {
      method: 'POST',
      credentials: 'include',
      // Bound the hang so a stalled conflict re-read cannot hold the auth token in
      // an open request indefinitely (the happy path goes through apiClient).
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as {
      error?: string;
      recovery?: 'rebase' | 'refetch_group_info';
      currentEpoch?: string | null;
      epoch?: string;
      commitId?: string;
      idempotent?: boolean;
    };
    // A same-key resubmit can win the second time (idempotent 200) between the
    // first throw and this re-read; treat that as success.
    if (res.ok && data.epoch && data.commitId) {
      return { ok: true, epoch: data.epoch, commitId: data.commitId, idempotent: data.idempotent };
    }
    return {
      ok: false,
      conflict: data.recovery ?? (args.mode === 'external' ? 'refetch_group_info' : 'rebase'),
      currentEpoch: data.currentEpoch ?? null,
    };
  }
}

// Catch-up

export interface CatchupCommit {
  baseEpoch: string;
  resultingEpoch: string;
  commit: string;
  idempotencyKey: string;
}

export async function catchUp(groupId: string, sinceEpoch: string, limit?: number): Promise<CatchupCommit[]> {
  const query = limit === undefined ? `?sinceEpoch=${sinceEpoch}` : `?sinceEpoch=${sinceEpoch}&limit=${limit}`;
  const res = await apiClient.request<{ commits: CatchupCommit[] }>(`/mls/groups/${groupId}/commits${query}`);
  return res.commits;
}

// Welcomes

export interface PulledWelcome {
  groupId: string;
  epoch: string;
  welcomeData: string;
}

export async function getWelcomes(limit?: number): Promise<PulledWelcome[]> {
  const query = limit === undefined ? '' : `?limit=${limit}`;
  const res = await apiClient.request<{ welcomes: PulledWelcome[] }>(`/mls/welcomes${query}`);
  return res.welcomes;
}

/** Fetch a peer's AIK rotation-attestation chain (public AIKs + detached sigs). */
export function getAikChain(userId: string): Promise<{
  chain: { seq: number; oldAik: string; newAik: string; signature: string }[];
  head: { seq: number; aik: string; signature: string } | null;
}> {
  return apiClient.getAikChain(userId);
}

// Socket subscriptions
// Both are notify-style. onSocketCreated bridges the connect()->listeners gap so
// a subscription registered before the socket exists still binds (mirrors the
// existing socket-event hooks). The returned fn unsubscribes.

export function onMlsCommit(cb: (e: { groupId: string; epoch: string; commit: string }) => void): () => void {
  const handler = (e: { groupId: string; epoch: string; commit: string }) => cb(e);
  // Capture the onSocketCreated remover so a teardown BEFORE the socket exists
  // cancels the queued .on binding (otherwise it would bind permanently later —
  // a listener leak across activate/deactivate cycles).
  const removeCreated = socketService.onSocketCreated(() => {
    socketService.socket?.on('mls-commit', handler);
  });
  return () => {
    removeCreated();
    socketService.socket?.off('mls-commit', handler);
  };
}

export function onMlsWelcome(cb: (e: { groupId: string; epoch: string }) => void): () => void {
  const handler = (e: { groupId: string; epoch: string }) => cb(e);
  const removeCreated = socketService.onSocketCreated(() => {
    socketService.socket?.on('mls-welcome', handler);
  });
  return () => {
    removeCreated();
    socketService.socket?.off('mls-welcome', handler);
  };
}
