// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Main-thread implementations of the four core seams. Used by the in-process
 * fallback path (no SharedWorker) AND as the RPC target the worker's network
 * proxy calls into. NEVER imported by mlsWorker.ts / mlsCoordinatorCore.ts in
 * worker scope (it pulls in mlsClient/apiClient/encryptionFlags = main-thread).
 */
import * as mlsClient from './mlsClient';
import { apiClient } from '../api';
import { setChannelProtocol } from '../encryptionFlags';
import { acquireLeadership, isLeader, releaseLeadership } from './mlsTabLock';
import type { MlsNetwork, CommitWelcomeSource, ClassificationSink, LeadershipGate, MlsDmSummary } from './mlsWorkerProtocol';

export function mainNetwork(): MlsNetwork {
  return {
    publishKeyPackages: (deviceId, kps) => mlsClient.publishKeyPackages(deviceId, kps),
    keyPackageCount: (deviceId) => mlsClient.keyPackageCount(deviceId),
    consumeKeyPackages: (targetUserId) => mlsClient.consumeKeyPackages(targetUserId),
    createGroup: (dmChannelId, groupInfoB64, tier) => mlsClient.createGroup(dmChannelId, groupInfoB64, tier),
    getGroupInfo: (groupId) => mlsClient.getGroupInfo(groupId),
    submitCommit: (args) => mlsClient.submitCommit(args),
    catchUp: (groupId, since, limit) => mlsClient.catchUp(groupId, since, limit),
    getWelcomes: (limit) => mlsClient.getWelcomes(limit),
    getAikChain: (userId) => mlsClient.getAikChain(userId),
    getDMs: async (): Promise<MlsDmSummary[]> => {
      const dms = await apiClient.getDMs();
      return dms.map((d) => ({ id: d.id, mlsGroupId: d.mlsGroupId, otrMlsGroupId: (d as { otrMlsGroupId?: string | null }).otrMlsGroupId ?? null }));
    },
    idempotencyKeyFor: (groupId, baseEpoch, kind, recipientId) => mlsClient.idempotencyKeyFor(groupId, baseEpoch, kind, recipientId),
  };
}

export function mainCommitWelcomeSource(): CommitWelcomeSource {
  return {
    onCommit: (cb) => mlsClient.onMlsCommit(cb),
    onWelcome: (cb) => mlsClient.onMlsWelcome(cb),
  };
}

export function mainClassificationSink(): ClassificationSink {
  return { markMls: (channelId) => setChannelProtocol(channelId, 'mls') };
}

export function mainLeadershipGate(): LeadershipGate {
  return { isLeader, acquire: acquireLeadership, release: releaseLeadership };
}
