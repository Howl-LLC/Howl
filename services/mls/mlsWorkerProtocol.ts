// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * SharedWorker protocol: the four injected seam interfaces the core
 * depends on, plus the discriminated-union messages the dispatcher and worker
 * exchange. Shared by mlsCoordinatorCore, mlsWorkerHost, mlsWorker, and the
 * dispatcher (mlsCoordinator). Type-only across the worker boundary; safe to
 * import in worker scope (no runtime browser-global access here).
 */
import type { MlsClientState } from './types';
import type { MlsIdentityBundle } from './mlsIdentity';

// Network wire shapes (mirror services/mls/mlsClient.ts exactly)
export interface ConsumedKeyPackage {
  deviceId: string;
  keyPackage: string;
  keyPackageRef: string;
  isLastResort: boolean;
}
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
export interface CatchupCommit {
  baseEpoch: string;
  resultingEpoch: string;
  commit: string;
  idempotencyKey: string;
}
export interface PulledWelcome {
  groupId: string;
  epoch: string;
  welcomeData: string;
}
/** Only the fields the core reads from getDMs (structurally compatible with apiClient.getDMs). */
export interface MlsDmSummary {
  id: string;
  mlsGroupId?: string | null;
  otrMlsGroupId?: string | null;
}

// Seam 1: MlsNetwork (the 9 network calls + the pure idempotencyKeyFor)
export interface MlsNetwork {
  publishKeyPackages(deviceId: string, kps: { keyPackage: string; isLastResort: boolean }[]): Promise<{ published: number; remaining: number }>;
  keyPackageCount(deviceId: string): Promise<{ remaining: number; hasLastResort: boolean }>;
  consumeKeyPackages(targetUserId: string): Promise<ConsumedKeyPackage[]>;
  createGroup(dmChannelId: string, groupInfoB64: string, tier: import('./roomKey').MlsTier): Promise<{ groupId: string; currentEpoch: string }>;
  getGroupInfo(groupId: string): Promise<{ groupInfo: string; groupInfoEpoch: string }>;
  submitCommit(args: SubmitCommitArgs): Promise<SubmitCommitResult>;
  catchUp(groupId: string, sinceEpoch: string, limit?: number): Promise<CatchupCommit[]>;
  getWelcomes(limit?: number): Promise<PulledWelcome[]>;
  getDMs(): Promise<MlsDmSummary[]>;
  // A peer's AIK rotation-attestation chain (public AIKs + detached sigs, ascending by seq).
  getAikChain(userId: string): Promise<AikChainResult>;
  idempotencyKeyFor(groupId: string, baseEpoch: string, kind: string, recipientId?: string): Promise<string>;
}

export interface AikChainLink { seq: number; oldAik: string; newAik: string; signature: string }
export interface AikChainHead { seq: number; aik: string; signature: string }
export interface AikChainResult { chain: AikChainLink[]; head: AikChainHead | null }

// Seam 2: CommitWelcomeSource (the two socket subscriptions). The callbacks are the
// core's async handleIncomingCommit/handleIncomingWelcome (both return Promise<void>),
// so the return type is widened to `void | Promise<void>`: the worker host must AWAIT
// the settled handler before pushing readiness (a live heal-drop shrinks _loadedGroups,
// a Welcome-join grows it, and neither emits mls-ready).
export interface CommitWelcomeSource {
  onCommit(cb: (e: { groupId: string; epoch: string; commit: string }) => void | Promise<void>): () => void;
  onWelcome(cb: (e: { groupId: string; epoch: string }) => void | Promise<void>): () => void;
}

// Seam 3: ClassificationSink (the localStorage-write setChannelProtocol)
export interface ClassificationSink {
  markMls(channelId: string): void;
}

// Seam 4: LeadershipGate (the howl-mls-writer lease, both paths)
export interface LeadershipGate {
  isLeader(): boolean;
  acquire(onLost: () => void): Promise<boolean>;
  release(): void;
}

export interface CoreSeams {
  network: MlsNetwork;
  source: CommitWelcomeSource;
  classification: ClassificationSink;
  leadership: LeadershipGate;
}

// Messages: main (dispatcher) -> worker
export type MainToWorker =
  | { kind: 'init'; correlationId: string; identity: MlsIdentityBundle; atRestKey: CryptoKey; historyKey: CryptoKey | null }
  | { kind: 'rekey'; correlationId: string; atRestKey: CryptoKey; historyKey: CryptoKey | null }
  | { kind: 'lock'; correlationId: string }
  | { kind: 'rpc'; correlationId: string; method: ProxiedMethod; args: unknown[] }
  | { kind: 'socket-event'; event: 'commit'; payload: { groupId: string; epoch: string; commit: string } }
  | { kind: 'socket-event'; event: 'welcome'; payload: { groupId: string; epoch: string } }
  | { kind: 'net-result'; correlationId: string; ok: true; value: unknown }
  | { kind: 'net-result'; correlationId: string; ok: false; error: { name: string; message: string; status?: number } };

// Messages: worker -> main (dispatcher)
export type WorkerToMain =
  | { kind: 'rpc-result'; correlationId: string; ok: true; value: unknown }
  | { kind: 'rpc-result'; correlationId: string; ok: false; error: { name: string; message: string; status?: number; reason?: 'peer-unprovisioned'; unprovisionedUserId?: string } }
  | { kind: 'net-request'; correlationId: string; method: keyof MlsNetwork; args: unknown[] }
  | { kind: 'set-classification'; channelId: string }
  | { kind: 'event'; event: 'mls-ready' | 'mls-locked' }
  | { kind: 'event-epoch'; payload: { dmChannelId: string; groupId: string; epoch: string } }
  | { kind: 'event-apply-failed'; payload: { dmChannelId: string; epoch: string } }
  | { kind: 'readiness'; active: boolean; readyChannelIds: string[] };

/** The async public-coordinator methods the dispatcher proxies into the worker.
 *  reconcileChannelClassifications is intentionally NOT here: it is main-thread on
 *  BOTH paths (the dispatcher re-exports it from mlsReconcile and never proxies it),
 *  so listing it would be a latent trap that could route to the core's stale stub. */
export type ProxiedMethod =
  | 'createDmGroup' | 'createGroupDmGroup' | 'establishChannel' | 'establishGroupDmChannel'
  | 'addGroupMembers' | 'removeGroupMembers' | 'removeAbsentLeaver' | 'handleGroupLeaderElection'
  | 'joinViaExternalCommit' | 'encrypt' | 'decrypt' | 'deriveSframeBaseKey'
  | 'endOtrGroup' | 'listOtrChannels';

// Re-export for convenience (the worker host threads these through generically).
export type { MlsClientState, MlsIdentityBundle };

// Correlation id helper
let _seq = 0;
/** Monotonic per-context correlation id. Math.random is unavailable in workflow
 *  scripts but fine here; uniqueness across contexts is not required (each side
 *  matches its own outstanding requests by id). */
export function newCorrelationId(): string {
  _seq += 1;
  return `c${_seq}`;
}

export interface WorkerRequest { kind: 'rpc'; correlationId: string; method: ProxiedMethod; args: unknown[] }
export interface WorkerResponse { kind: 'rpc-result'; correlationId: string; ok: boolean; value?: unknown }
