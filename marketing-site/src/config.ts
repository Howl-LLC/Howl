// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Site-wide constants. Keep URLs here so an owner decision (domain split,
// public repo location) is a one-line change.
export const SITE_URL = 'https://howlpro.com'
export const APP_URL = 'https://app.howlpro.com'

export const REPO_URL = 'https://github.com/Howl-LLC/Howl'

export const SITE_NAME = 'Howl'
export const OG_IMAGE = `${SITE_URL}/howl-logo.png`

// Nav + footer links double as the interlinking the SEO playbook asks for
// (every page links to /security and the migration guide).
export const NAV_LINKS = [
  { href: '/security', label: 'Security' },
  { href: '/docs/migrate-from-discord', label: 'Move from Discord' },
  { href: '/pricing', label: 'Pricing' },
] as const

export const COMPARE_LINKS = [
  { href: '/compare/discord', label: 'Howl vs Discord' },
  { href: '/compare/fluxer', label: 'Howl vs Fluxer' },
  { href: '/compare/stoat', label: 'Howl vs Stoat' },
  { href: '/compare/matrix', label: 'Howl vs Matrix' },
  { href: '/blog/self-hosted-discord-alternatives', label: 'Self-hosted alternatives (2026)' },
] as const
