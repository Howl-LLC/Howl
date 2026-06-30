// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { logger } from '../logger.js';

const log = logger.child({ module: 'captcha' });
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyCaptcha(token: string | undefined, ip?: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY || '';
  if (!secret) {
    // No secret configured — only skip in explicit development/test environments
    const env = process.env.NODE_ENV;
    if (env === 'development' || env === 'test') return true;
    if (process.env.SELF_HOST === 'true') return true; // self-host: CAPTCHA is optional
    log.warn('TURNSTILE_SECRET_KEY not set; rejecting captcha');
    return false;
  }

  if (!token) return false;

  try {
    const body: Record<string, string> = { secret, response: token };
    if (ip) body.remoteip = ip;

    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    const data = (await res.json()) as { success: boolean };
    return data.success === true;
  } catch (err) {
    log.error({ err }, 'Turnstile verification error');
    return false;
  }
}
