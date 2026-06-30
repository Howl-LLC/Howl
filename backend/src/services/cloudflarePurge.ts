// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Cloudflare CDN cache-purge helper.
 *
 * `/api/uploads/:filename` can leave a cached redirect target on the browser
 * and Cloudflare edge even after the underlying R2 object is deleted. On
 * deletion we purge the CDN URL for the file so the cache entry goes away.
 *
 * This helper is a no-op when CLOUDFLARE_ZONE_ID / CLOUDFLARE_API_TOKEN are
 * unset (dev, or Cloudflare-less deployments). It is fire-and-forget: any failure
 * is logged and swallowed — the orphan cache entry is a degraded state, not a
 * blocker on the delete path.
 */

import { logger } from '../logger.js';

const log = logger.child({ module: 'cloudflarePurge' });

const CF_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID || '';
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';

export const cloudflarePurgeEnabled = !!(CF_ZONE_ID && CF_API_TOKEN);

/**
 * Purge one or more fully-qualified URLs from the Cloudflare cache.
 * Max 30 URLs per call (Cloudflare API limit).
 */
export async function purgeCdnUrls(urls: string[]): Promise<void> {
  if (!cloudflarePurgeEnabled) return;
  if (urls.length === 0) return;

  // Split into chunks of 30 (CF limit).
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += 30) {
    chunks.push(urls.slice(i, i + 30));
  }

  for (const chunk of chunks) {
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
        redirect: 'manual',
        headers: {
          'Authorization': `Bearer ${CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files: chunk }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        log.warn({ status: res.status, text: text.slice(0, 500), count: chunk.length }, 'CF purge returned non-2xx');
      }
    } catch (err) {
      log.warn({ error: (err as Error).message, count: chunk.length }, 'CF purge failed');
    }
  }
}
