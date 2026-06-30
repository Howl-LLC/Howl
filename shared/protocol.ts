// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// AUTO-SYNCED: keep byte-identical to backend/src/protocol.ts below the header line.
// The check-schema-compat.ts CI lint enforces this.

export const CURRENT_PROTOCOL_VERSION = 3;
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1;
export const COMPAT_WINDOW_DAYS = 60;
export const SOFT_WARNING_DAYS = 45;
export const KNOWN_CAPABILITIES = ['sframe.v1', 'livekit.e2ee.v1'] as const;
export type Capability = (typeof KNOWN_CAPABILITIES)[number];

export type HandshakeFields = {
  buildDate: string; // ISO date: "2026-04-19"
  protocolVersion: number;
  capabilities: string[];
};

export type MustUpdateReason = 'buildDate' | 'protocolVersion';

export type MustUpdatePayload = {
  reason: MustUpdateReason;
  autoUpdateHint: boolean;
  softWarningOnly?: false;
};

export type UpdateRecommendedPayload = {
  reason: 'buildDate';
  softWarningOnly: true;
};

export type ProtocolContext = {
  buildDate: string | null;
  protocolVersion: number | null;
  capabilities: string[];
};

/**
 * Parses raw protocol handshake fields from either a Socket.IO auth payload
 * or HTTP headers. Returns a ProtocolContext with null/[] for missing or
 * malformed fields. Enforcement is layered on top of this parsed shape.
 */
export function parseProtocolContext(raw: {
  buildDate: unknown;
  protocolVersion: unknown;
  capabilities: unknown;
}): ProtocolContext {
  const { buildDate: rawBuildDate, protocolVersion: rawProtoVer, capabilities: rawCaps } = raw;

  const buildDate = typeof rawBuildDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawBuildDate)
    ? rawBuildDate
    : null;

  let protocolVersion: number | null = null;
  if (typeof rawProtoVer === 'number' && Number.isInteger(rawProtoVer) && rawProtoVer >= 1) {
    protocolVersion = rawProtoVer;
  } else if (typeof rawProtoVer === 'string' && /^\d+$/.test(rawProtoVer)) {
    const parsed = parseInt(rawProtoVer, 10);
    if (parsed >= 1) protocolVersion = parsed;
  }

  const capabilities = Array.isArray(rawCaps) && rawCaps.every((c: unknown) => typeof c === 'string')
    ? (rawCaps as string[])
    : [];

  return { buildDate, protocolVersion, capabilities };
}

/**
 * Enforcement flag — when true, the server rejects clients with missing
 * handshake fields or past the 60-day window. Keep false until telemetry
 * confirms ≥95% of active users are on a version that sends handshake
 * fields; flipping too early kicks every existing user.
 *
 * Resolved via getter so tests can flip process.env at runtime.
 */
export function isEnforceVersionGate(): boolean {
  return (typeof process !== 'undefined' && process.env?.ENFORCE_VERSION_GATE === 'true');
}

export function isHandshakeInsideWindow(
  buildDate: string | null,
  protocolVersion: number | null,
): { ok: true } | { ok: false; reason: 'buildDate' | 'protocolVersion' } {
  if (buildDate === null) return { ok: false, reason: 'buildDate' };
  if (protocolVersion === null) return { ok: false, reason: 'protocolVersion' };
  if (protocolVersion < MIN_SUPPORTED_PROTOCOL_VERSION) return { ok: false, reason: 'protocolVersion' };
  const date = Date.parse(buildDate);
  if (Number.isNaN(date)) return { ok: false, reason: 'buildDate' };
  const ageDays = (Date.now() - date) / 86_400_000;
  if (ageDays > COMPAT_WINDOW_DAYS) return { ok: false, reason: 'buildDate' };
  return { ok: true };
}

export function isHandshakeSoftWarning(buildDate: string | null): boolean {
  if (!buildDate) return false;
  const date = Date.parse(buildDate);
  if (Number.isNaN(date)) return false;
  const ageDays = (Date.now() - date) / 86_400_000;
  return ageDays > SOFT_WARNING_DAYS && ageDays <= COMPAT_WINDOW_DAYS;
}
