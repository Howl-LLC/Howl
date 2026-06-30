// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Version-gate test helpers — reusable by any test file.
 *
 * Provides `mockHandshakeAsOldClient` and `mockHandshakeAsExpiredClient` for
 * exercising the Socket.IO version-gate enforcement pipeline end-to-end.
 */

import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { COMPAT_WINDOW_DAYS, CURRENT_PROTOCOL_VERSION, KNOWN_CAPABILITIES } from '../src/protocol.js';

export type { ClientSocket };

/**
 * Build an ISO date string (YYYY-MM-DD) representing `daysAgo` days before now.
 */
function buildDateDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Connect a Socket.IO client whose buildDate is `daysAgo` days old.
 * Default `daysAgo = COMPAT_WINDOW_DAYS - 1` (59) -- just inside the 60-day window.
 * Used to assert the gate ACCEPTS clients near the boundary.
 */
export function mockHandshakeAsOldClient(
  baseUrl: string,
  token: string,
  daysAgo: number = COMPAT_WINDOW_DAYS - 1,
  opts?: { protocolVersion?: number; capabilities?: string[] },
): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      transports: ['websocket'],
      auth: {
        token,
        buildDate: buildDateDaysAgo(daysAgo),
        protocolVersion: opts?.protocolVersion ?? CURRENT_PROTOCOL_VERSION,
        capabilities: opts?.capabilities ?? [...KNOWN_CAPABILITIES],
      },
      forceNew: true,
      reconnection: false,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
    setTimeout(() => reject(new Error('mockHandshakeAsOldClient: connection timeout')), 5000);
  });
}

/**
 * Connect a Socket.IO client whose buildDate is outside the compat window
 * (default COMPAT_WINDOW_DAYS + 1 = 61 days old). Used to assert the gate
 * emits `must-update` and disconnects within ~500ms.
 *
 * Returns both the socket and the captured `must-update` event payload
 * (if one arrives within 2s).
 */
export function mockHandshakeAsExpiredClient(
  baseUrl: string,
  token: string,
  opts?: { daysAgo?: number; protocolVersion?: number; capabilities?: string[] },
): Promise<{ socket: ClientSocket; mustUpdateEvent?: { reason: string; autoUpdateHint: boolean } }> {
  const daysAgo = opts?.daysAgo ?? COMPAT_WINDOW_DAYS + 1;
  return new Promise((resolve) => {
    const socket = ioClient(baseUrl, {
      transports: ['websocket'],
      auth: {
        token,
        buildDate: buildDateDaysAgo(daysAgo),
        protocolVersion: opts?.protocolVersion ?? CURRENT_PROTOCOL_VERSION,
        capabilities: opts?.capabilities ?? [...KNOWN_CAPABILITIES],
      },
      forceNew: true,
      reconnection: false,
    });

    let mustUpdateEvent: { reason: string; autoUpdateHint: boolean } | undefined;
    socket.on('must-update', (data: { reason: string; autoUpdateHint: boolean }) => {
      mustUpdateEvent = data;
    });

    // Resolve once disconnected (expected path) or after 2s timeout (unexpected).
    socket.on('disconnect', () => resolve({ socket, mustUpdateEvent }));
    socket.on('connect_error', () => resolve({ socket, mustUpdateEvent }));
    setTimeout(() => resolve({ socket, mustUpdateEvent }), 2000);
  });
}
