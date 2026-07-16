// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { defineCollection, z } from 'astro:content'
import { glob } from 'astro/loaders'

// The publish-ready copy lives in docs/marketing/ (single source of truth).
// The site reads it in place; no copies. Only the seven public pages are
// loaded — anything else in that directory stays out of the build.
const marketing = defineCollection({
  loader: glob({
    pattern: [
      'compare-discord.md',
      'compare-fluxer.md',
      'compare-stoat.md',
      'compare-matrix.md',
      'migrate-from-discord.md',
      'self-hosted-discord-alternatives.md',
      'security-page.md',
    ],
    base: '../docs/marketing',
  }),
  schema: z.object({
    slug: z.string(),
    title: z.string().max(60),
    description: z.string().max(155),
    lastVerified: z.coerce.date(),
  }),
})

export const collections = { marketing }
