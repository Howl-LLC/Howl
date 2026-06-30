// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// backend/src/selfHost.ts
// Centralized self-host mode flags. Exported as functions (not module-level
// consts) so they re-read process.env at call time, which keeps them testable
// and lets an operator change a flag with a container restart taking effect.

export function isSelfHost(): boolean {
  return process.env.SELF_HOST === 'true';
}

/** Under self-host, all Pro features are unlocked for free unless explicitly disabled. */
export function isAllPro(): boolean {
  return isSelfHost() && process.env.SELF_HOST_ALL_PRO !== 'false';
}

/** Hosted instances keep open self-registration; self-host defaults to closed (private island). */
export function getRegistrationMode(): 'open' | 'closed' {
  if (!isSelfHost()) return 'open';
  return process.env.REGISTRATION_MODE === 'open' ? 'open' : 'closed';
}

export function getInstanceName(): string {
  return process.env.INSTANCE_NAME || 'Howl';
}

/** Email flows are active only when an email provider is configured. */
export function isEmailEnabled(): boolean {
  return !!process.env.RESEND_API_KEY;
}

/** Self-hosting without an email provider: accounts are auto-verified and the login email gate is skipped. */
export function emailVerificationDisabled(): boolean {
  return isSelfHost() && !isEmailEnabled();
}

/** Voice/video is available only when real (non-default) LiveKit credentials are present. */
export function isVoiceEnabled(): boolean {
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.LIVEKIT_WS_URL || process.env.LIVEKIT_URL;
  if (!key || key === 'devkey') return false;
  if (!secret || secret === 'secret') return false;
  if (!url) return false;
  return true;
}

/** Self-host never sells subscriptions; hosted enables billing when Stripe is configured. */
export function isBillingEnabled(): boolean {
  return !isSelfHost() && !!process.env.STRIPE_SECRET_KEY;
}
