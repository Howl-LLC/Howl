// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * SharedWorker entry. Hosts mlsCoordinatorCore as the single MLS writer
 * for this origin. Thin: it only wires real MessagePorts to the testable host
 * (mlsWorkerHost). MUST NOT import encryptionFlags / api / mlsClient / socket
 * (main-thread / localStorage; encryptionFlags fails SILENTLY OPEN here).
 */
import * as core from './mlsCoordinatorCore';
import { createWorkerHost, type HostPort, type CoreApi } from './mlsWorkerHost';

// Worker scope typed via globalThis to avoid lib.dom's `self` collision;
// SharedWorkerGlobalScope is not in the project's tsconfig lib. Mirrors
// services/call/videoPipeline.worker.ts.
const workerScope = globalThis as unknown as {
  onconnect: ((e: MessageEvent) => void) | null;
};

const host = createWorkerHost(core as unknown as CoreApi);

workerScope.onconnect = (e: MessageEvent) => {
  host.handleConnect(e.ports[0] as unknown as HostPort);
};
