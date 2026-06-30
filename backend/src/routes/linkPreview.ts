// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import { Readable } from 'node:stream';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { logger } from '../logger.js';
import { redis } from '../redis.js';
import { isPrivateOrReservedIP, safeFetch } from '../utils/safeFetch.js';
import { getClientIp } from '../utils/clientIp.js';

const router = Router();
const log = logger.child({ module: 'linkPreview' });

const previewLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:link-preview:'),
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
  message: { error: 'Rate limit exceeded' },
  standardHeaders: true,
  legacyHeaders: false,
});

// OG Tag Parsing (multiline-safe)

interface LinkPreviewData {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  favicon: string | null;
  /** Raw oEmbed HTML snippet (if the provider returned one). */
  html?: string;
  /** Standalone iframe embed URL extracted from oEmbed response (e.g. TikTok embed/v2). */
  videoEmbedUrl?: string;
}

function parseOpenGraphTags(html: string, baseUrl: string): LinkPreviewData {
  // Extract all <meta> tags (handles multiline attributes)
  const metaTags: string[] = [];
  const metaRe = /<meta\s[\s\S]*?>/gi;
  let mt;
  while ((mt = metaRe.exec(html)) !== null) metaTags.push(mt[0]);

  const get = (property: string): string | null => {
    for (const tag of metaTags) {
      // Property values are hardcoded OG names (og:title, og:description, etc.)
      // eslint-disable-next-line security/detect-non-literal-regexp
      const propRe = new RegExp(`(?:property|name)\\s*=\\s*["']${property}["']`, 'i');
      if (!propRe.test(tag)) continue;
      const cm = tag.match(/content\s*=\s*["']([^"']{0,1000})["']/i);
      if (cm) return cm[1]!.trim() || null;
    }
    return null;
  };

  let title = get('og:title');
  if (!title) {
    const tm = html.match(/<title[^>]*>([\s\S]{0,500}?)<\/title>/i);
    title = tm ? tm[1]!.trim() : null;
  }

  let description = get('og:description');
  if (!description) description = get('description');

  const image = get('og:image');
  const siteName = get('og:site_name');

  // Favicon: extract <link> tags (multiline-safe)
  let favicon: string | null = null;
  const linkRe = /<link\s[\s\S]*?>/gi;
  let lt;
  while ((lt = linkRe.exec(html)) !== null) {
    const tag = lt[0];
    // eslint-disable-next-line security/detect-unsafe-regex
    if (/rel\s*=\s*["'](?:shortcut\s+)?icon["']/i.test(tag)) {
      const hm = tag.match(/href\s*=\s*["']([^"']{0,500})["']/i);
      if (hm) { favicon = hm[1]!; break; }
    }
  }

  const resolve = (u: string | null): string | null => {
    if (!u) return null;
    try { return new URL(u, baseUrl).href; } catch { return u; }
  };

  return {
    url: baseUrl,
    title: title ? title.slice(0, 300) : null,
    description: description ? description.slice(0, 500) : null,
    image: resolve(image),
    siteName: siteName ? siteName.slice(0, 100) : null,
    favicon: resolve(favicon) ?? `${new URL(baseUrl).origin}/favicon.ico`,
  };
}

// Schema

const linkPreviewSchema = z.object({
  query: z.object({
    url: z.string().url().max(2000).refine(
      (url) => {
        try {
          const parsed = new URL(url);
          return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch { return false; }
      },
      { message: 'Only http and https URLs are allowed' }
    ),
  }),
});

const imageProxySchema = z.object({
  query: z.object({
    url: z.string().url().max(2000).refine(
      (url) => {
        try {
          const parsed = new URL(url);
          return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch { return false; }
      },
      { message: 'Only http and https URLs are allowed' }
    ),
  }),
});

// Cache

const CACHE_TTL = 3600;
// v2: bumped after Tenor AAAAN→AAAAC fix. Users who hit broken URLs
// pre-fix had static PNGs cached for up to 1 hour — the bump orphans those.
const CACHE_PREFIX = 'link-preview:v2:';
const NEGATIVE_CACHE_TTL = 300;

// eslint-disable-next-line security/detect-unsafe-regex -- anchored both ends, no nested quantifiers
const TENOR_VIEW_RE = /^https?:\/\/(?:www\.)?tenor\.com\/(?:[a-z]{2}\/)?view\/[\w-]+-\d+$/i;
const GIPHY_VIEW_RE = /^https?:\/\/(?:www\.)?giphy\.com\/gifs\//i;

const TIKTOK_VIDEO_RE = /^https?:\/\/(?:www\.|m\.)?tiktok\.com\/@[\w.-]+\/video\/(\d+)/i;
const TIKTOK_SHORT_RE = /^https?:\/\/(?:vm\.tiktok\.com|(?:www\.|m\.)?tiktok\.com\/t)\//i;

function isGifProviderUrl(url: string): boolean {
  return TENOR_VIEW_RE.test(url) || GIPHY_VIEW_RE.test(url);
}

// Route

router.get(
  '/link-preview',
  authenticateToken,
  previewLimiter,
  validate(linkPreviewSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const url = req.query.url as string;

    try {
      const parsed = new URL(url);
      if (isPrivateOrReservedIP(parsed.hostname)) {
        return res.status(400).json({ error: 'URL not allowed' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    // Check cache
    if (redis) {
      try {
        const cached = await redis.get(CACHE_PREFIX + url);
        if (cached) {
          const parsed = JSON.parse(cached);
          // Bust stale cache for GIF providers — if a previous HTML scrape cached
          // {image: null}, delete it and fall through to oEmbed for a fresh attempt.
          if (!parsed.image && isGifProviderUrl(url)) {
            try { await redis.del(CACHE_PREFIX + url); } catch { /* ignore */ }
          } else {
            res.set('Cache-Control', 'public, max-age=3600');
            return res.json(parsed);
          }
        }
      } catch { /* cache miss */ }
    }

    // TikTok oEmbed shortcut
    if (TIKTOK_VIDEO_RE.test(url) || TIKTOK_SHORT_RE.test(url)) {
      try {
        const oembedRes = await safeFetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, 'application/json');
        if (oembedRes.ok) {
          const oembedText = await oembedRes.text();
          const oembed = JSON.parse(oembedText) as {
            title?: string;
            author_name?: string;
            author_url?: string;
            thumbnail_url?: string;
            provider_name?: string;
            html?: string;
          };

          // Extract video ID from the URL for the standalone embed player URL.
          const tiktokVideoMatch = url.match(TIKTOK_VIDEO_RE);
          const tiktokVideoId = tiktokVideoMatch?.[1];

          const preview: LinkPreviewData = {
            url,
            title: oembed.title?.slice(0, 300) ?? null,
            description: oembed.author_name ? `@${oembed.author_name}` : null,
            image: oembed.thumbnail_url ?? null,
            siteName: oembed.provider_name?.slice(0, 100) ?? 'TikTok',
            favicon: 'https://www.tiktok.com/favicon.ico',
            ...(oembed.html ? { html: oembed.html.slice(0, 2000) } : {}),
            ...(tiktokVideoId ? { videoEmbedUrl: `https://www.tiktok.com/embed/v2/${tiktokVideoId}` } : {}),
          };

          if (redis) {
            try { await redis.setex(CACHE_PREFIX + url, CACHE_TTL, JSON.stringify(preview)); } catch { /* ignore */ }
          }

          log.info({ url, provider: 'TikTok', image: preview.image }, 'oEmbed resolved TikTok preview');
          res.set('Cache-Control', 'public, max-age=3600');
          return res.json(preview);
        } else {
          log.warn({ url, provider: 'TikTok', status: oembedRes.status }, 'TikTok oEmbed endpoint returned non-OK status');
        }
      } catch (err) {
        log.warn({ url, error: (err as Error).message }, 'TikTok oEmbed fetch failed, falling through to HTML scraping');
      }
    }

    // GIF oEmbed shortcuts (Giphy + Tenor)
    // Both providers' page HTML is JS-rendered / returns non-image responses.
    // Their oEmbed endpoints return reliable JSON with the direct media URL.
    const gifOembed = TENOR_VIEW_RE.test(url)
      ? { endpoint: `https://tenor.com/oembed?url=${encodeURIComponent(url)}`, provider: 'Tenor', favicon: 'https://tenor.com/favicon.ico' }
      : GIPHY_VIEW_RE.test(url)
        ? { endpoint: `https://giphy.com/services/oembed?url=${encodeURIComponent(url)}`, provider: 'GIPHY', favicon: 'https://giphy.com/favicon.ico' }
        : null;

    if (gifOembed) {
      try {
        const oembedRes = await safeFetch(gifOembed.endpoint, 'application/json');
        if (oembedRes.ok) {
          const oembedText = await oembedRes.text();
          const oembed = JSON.parse(oembedText) as {
            title?: string;
            thumbnail_url?: string;
            url?: string;
            provider_name?: string;
          };

          const imageUrl = oembed.url || oembed.thumbnail_url;
          if (imageUrl) {
            let gifUrl = imageUrl;
            // Tenor oEmbed: modern response returns the `AAAAN/<slug>.png`
            // tiny-static-preview (~13 KB). Swap to `AAAAC/<slug>.gif` for
            // the full animated version (~1 MB). Handles current URL shape
            // where filename is a slug (e.g., "funny-cat.png"), not literal
            // "tenor".
            if (gifOembed.provider === 'Tenor') {
              gifUrl = gifUrl.replace(/AAAAN(\/[^/]+)\.png$/i, 'AAAAC$1.gif');
            }
            // Legacy Tenor URLs where the filename was literally "tenor".
            if (gifUrl.includes('/tenor.png')) {
              gifUrl = gifUrl.replace('/tenor.png', '/tenor.gif');
            }

            const preview: LinkPreviewData = {
              url,
              title: oembed.title?.slice(0, 300) ?? null,
              description: null,
              image: gifUrl,
              siteName: oembed.provider_name?.slice(0, 100) ?? gifOembed.provider,
              favicon: gifOembed.favicon,
            };

            if (redis) {
              try { await redis.setex(CACHE_PREFIX + url, CACHE_TTL, JSON.stringify(preview)); } catch { /* ignore */ }
            }

            log.info({ url, provider: gifOembed.provider, image: gifUrl }, 'oEmbed resolved GIF media URL');
            res.set('Cache-Control', 'public, max-age=3600');
            return res.json(preview);
          }
        } else {
          log.warn({ url, provider: gifOembed.provider, status: oembedRes.status }, 'oEmbed endpoint returned non-OK status');
        }
      } catch (err) {
        log.warn({ url, error: (err as Error).message }, `${gifOembed.provider} oEmbed fetch failed, falling through to HTML scraping`);
      }
    }

    try {
      const response = await safeFetch(url);

      if (!response.ok) {
        if (redis) { try { await redis.setex(CACHE_PREFIX + url, NEGATIVE_CACHE_TTL, JSON.stringify({ error: 'fetch_failed' })); } catch { /* ignore */ } }
        return res.status(502).json({ error: 'Failed to fetch URL' });
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        return res.status(400).json({ error: 'URL does not return HTML' });
      }

      const reader = response.body?.getReader();
      if (!reader) return res.status(502).json({ error: 'No response body' });

      let html = '';
      const decoder = new TextDecoder();
      const MAX_BYTES = 50 * 1024;
      let bytesRead = 0;

      while (bytesRead < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        bytesRead += value.byteLength;
      }
      reader.cancel().catch(() => { /* ignore */ });

      const preview = parseOpenGraphTags(html, url);

      if (!preview.title && !preview.description) {
        return res.status(404).json({ error: 'No preview data found' });
      }

      if (redis) {
        try { await redis.setex(CACHE_PREFIX + url, CACHE_TTL, JSON.stringify(preview)); } catch { /* ignore */ }
      }

      res.set('Cache-Control', 'public, max-age=3600');
      return res.json(preview);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith('SSRF:')) {
        return res.status(400).json({ error: 'URL not allowed' });
      }
      if ((err as Error).name === 'AbortError' || (err as Error).name === 'TimeoutError') {
        log.warn({ url }, 'Link preview fetch timed out');
        return res.status(504).json({ error: 'Request timed out' });
      }
      if (msg === 'Too many redirects') {
        return res.status(400).json({ error: 'Too many redirects' });
      }
      log.error({ url, error: msg }, 'Link preview fetch failed');
      return res.status(502).json({ error: 'Failed to fetch URL' });
    }
  })
);

// Image Proxy

const IMAGE_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

const imageProxyLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:img-proxy:'),
  windowMs: 60_000,
  max: 120,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
  message: { error: 'Rate limit exceeded' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get(
  '/link-preview/image',
  authenticateToken,
  imageProxyLimiter,
  validate(imageProxySchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const url = req.query.url as string;

    try {
      const parsed = new URL(url);
      if (isPrivateOrReservedIP(parsed.hostname)) {
        return res.status(400).json({ error: 'URL not allowed' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    // Abort the upstream fetch if the HTTP client disconnects (e.g. chat list
    // virtualization unmounts the preview mid-fetch during fast scroll).
    const clientAbort = new AbortController();
    req.on('close', () => clientAbort.abort());

    try {
      const response = await safeFetch(url, 'image/*', clientAbort.signal);

      if (!response.ok) {
        return res.status(502).json({ error: 'Failed to fetch image' });
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.startsWith('image/') || contentType.startsWith('image/svg+xml')) {
        return res.status(400).json({ error: 'URL does not return a valid image' });
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > IMAGE_MAX_BYTES) {
        return res.status(413).json({ error: 'Image exceeds maximum size of 2MB' });
      }

      if (!response.body) {
        return res.status(502).json({ error: 'No response body' });
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');

      if (contentLength) {
        // Known size within limit — stream directly
        const nodeStream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
        nodeStream.pipe(res);
      } else {
        // Unknown size — stream with byte counter
        const reader = response.body.getReader();
        let bytesRead = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytesRead += value.byteLength;
            if (bytesRead > IMAGE_MAX_BYTES) {
              reader.cancel().catch(() => { /* ignore */ });
              if (!res.headersSent) {
                return res.status(413).json({ error: 'Image exceeds maximum size of 2MB' });
              }
              res.destroy();
              return;
            }
            res.write(value);
          }
          res.end();
        } catch {
          reader.cancel().catch(() => { /* ignore */ });
          if (!res.headersSent) {
            return res.status(502).json({ error: 'Stream error' });
          }
          res.destroy();
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      // Client disconnected — response socket is gone, don't attempt to write.
      if (clientAbort.signal.aborted) {
        return;
      }
      if (msg.startsWith('SSRF:')) {
        return res.status(400).json({ error: 'URL not allowed' });
      }
      if ((err as Error).name === 'AbortError' || (err as Error).name === 'TimeoutError') {
        log.warn({ url }, 'Image proxy fetch timed out');
        return res.status(504).json({ error: 'Request timed out' });
      }
      if (msg === 'Too many redirects') {
        return res.status(400).json({ error: 'Too many redirects' });
      }
      log.error({ url, error: msg }, 'Image proxy fetch failed');
      return res.status(502).json({ error: 'Failed to fetch image' });
    }
  })
);

export default router;
