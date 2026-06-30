// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Shared protocol handshake headers for all REST requests.
 *
 * Every fetch() call — whether it goes through APIClient.request() or is a
 * direct fetch() (token refresh, SSO exchange, uploads, etc.) — MUST include
 * these headers. Without them, the server's version gate
 * (ENFORCE_VERSION_GATE=true) returns 426 and the client cannot recover.
 *
 * Spread `...await getProtocolHeaders()` at every direct-fetch site so the
 * headers are never dropped.
 */
import { CURRENT_PROTOCOL_VERSION, KNOWN_CAPABILITIES } from '../../shared/protocol';
import { resolveBuildDate } from '../buildDate';

export async function getProtocolHeaders(): Promise<Record<string, string>> {
  return {
    'X-Client-Build-Date': await resolveBuildDate(),
    'X-Protocol-Version': String(CURRENT_PROTOCOL_VERSION),
    'X-Client-Capabilities': KNOWN_CAPABILITIES.join(','),
  };
}
