// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import crypto from 'crypto';
import { redis } from '../redis.js';
import { cappedMapSet } from '../socketHandlers/infrastructure.js';

export type SsoSessionEntry = { kind: 'session'; token: string; refreshToken: string; deviceToken?: string };
export type SsoMfaEntry = { kind: 'mfa'; mfaToken: string; methods: string[] };
export type SsoCodeEntry = (SsoSessionEntry | SsoMfaEntry) & { expiresAt?: number };

const MAX_SSO_CODES = 10_000;
const pendingSsoCodes = new Map<string, SsoCodeEntry>();
const SSO_CODE_TTL_MS = 60_000;

setInterval(() => {
  const now = Date.now();
  for (const [code, data] of pendingSsoCodes) {
    if (now > data.expiresAt!) pendingSsoCodes.delete(code);
  }
}, 30_000).unref();

export async function storeSsoCode(result: SsoSessionEntry | SsoMfaEntry): Promise<string> {
  const code = crypto.randomBytes(32).toString('base64url');

  if (redis) {
    await redis.set(`sso-code:${code}`, JSON.stringify(result), 'EX', 60);
  } else {
    cappedMapSet(pendingSsoCodes, code, { ...result, expiresAt: Date.now() + SSO_CODE_TTL_MS }, MAX_SSO_CODES);
  }
  return code;
}

export async function consumeSsoCode(code: string): Promise<SsoCodeEntry | null> {
  if (redis) {
    const raw = await redis.get(`sso-code:${code}`);
    if (raw) {
      await redis.del(`sso-code:${code}`); // single-use
      return JSON.parse(raw) as SsoCodeEntry;
    }
    return null;
  }
  const memEntry = pendingSsoCodes.get(code);
  if (memEntry && Date.now() < memEntry.expiresAt!) {
    pendingSsoCodes.delete(code); // single-use
    return memEntry;
  }
  pendingSsoCodes.delete(code);
  return null;
}
