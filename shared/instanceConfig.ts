// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
export interface InstanceConfig {
  instanceName: string;
  selfHost: boolean;
  registrationMode: 'open' | 'closed';
  voiceEnabled: boolean;
  livekitUrl: string;
  billingEnabled: boolean;
  emailEnabled: boolean;
  needsBootstrap?: boolean;
}

// Selectors default to the permissive hosted behavior when config is null
// (config has not loaded, or an older backend lacks the endpoint).
export function registrationOpen(c: InstanceConfig | null): boolean {
  return c?.registrationMode !== 'closed';
}
export function billingVisible(c: InstanceConfig | null): boolean {
  return c?.billingEnabled !== false;
}
export function voiceVisible(c: InstanceConfig | null): boolean {
  return c?.voiceEnabled !== false;
}

// Self-host builds ship no marketing site, so the web root should go straight to
// the app/login instead of the hosted landing page. This is keyed off the
// build-time VITE_SELF_HOST flag (passed in as `selfHostBuild`) rather than the
// async runtime config, so there is no landing-page flash before the redirect.
// Returns the redirect target, or null to render the normal landing.
export function selfHostRootRedirect(selfHostBuild: boolean, pathname: string): string | null {
  return selfHostBuild && pathname === '/' ? '/login' : null;
}
