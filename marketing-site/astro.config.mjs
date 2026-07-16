// @ts-check
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'

// Canonical domain for the static marketing site. The app lives on
// app.howlpro.com; this site owns the apex domain howlpro.com.
export default defineConfig({
  site: 'https://howlpro.com',
  trailingSlash: 'never',
  integrations: [sitemap()],
  build: {
    format: 'file',
  },
})
