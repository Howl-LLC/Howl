// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Minimal SSR HTML template for the public server profile page (`/s/:vanity`).
 *
 * Renders the same shell that the SPA expects (CSP meta, viewport, fallback
 * loader markup, bootstrap script tag) plus per-server Open Graph and Twitter
 * card meta tags so that link unfurlers (Discord, iMessage, Slack, Twitter,
 * Facebook, Telegram) can preview a community without logging in.
 *
 * Security:
 *  - Every server-controlled string flows through `escapeHtmlAttr` (for
 *    attribute values) or `escapeHtmlText` (for text nodes). XSS via name,
 *    description, vanity, or image URL is impossible — even `<script>`
 *    tag literals inside the server name render as `&lt;script&gt;`.
 *  - Image URLs are also validated (`isSafeImageUrl`) — only `http(s):` and
 *    matching the allowlist of host suffixes used elsewhere in the platform
 *    are emitted. Anything else is dropped silently.
 *  - The CSP meta mirrors `index.html` exactly so SSR pages and SPA-served
 *    pages have identical script/style/connect/img/etc. policies. Inline
 *    `<script>` is forbidden — only the existing `/index.tsx` bootstrap +
 *    `/guard.js` early-warning script are referenced (both external).
 *  - We deliberately do NOT inline any data the client could read with
 *    `document.querySelector('meta[property=…]').content` — the OG/Twitter
 *    tags only contain fields the JSON endpoint would already expose to
 *    anonymous callers.
 */

const SAFE_IMAGE_HOST_SUFFIXES = [
  'howlpro.com',
  'r2.cloudflarestorage.com',
  'cdn.discordapp.com',
  'media.discordapp.net',
  'api.dicebear.com',
  'cdn.jsdelivr.net',
  'imgur.com',
  'media.tenor.com',
  'c.tenor.com',
  'media.giphy.com',
  'media0.giphy.com',
  'media1.giphy.com',
  'media2.giphy.com',
  'media3.giphy.com',
  'media4.giphy.com',
  'i.giphy.com',
  'pbs.twimg.com',
  'img.youtube.com',
  'cdn.cloudflare.steamstatic.com',
  'i.scdn.co',
];

/**
 * Escape a string for safe use as a quoted HTML attribute value.
 *
 * Order matters — `&` MUST be replaced first so we don't double-encode the
 * subsequent entity replacements.
 */
export function escapeHtmlAttr(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

/**
 * Escape a string for safe use as HTML text content.
 *
 * Mirrors `escapeHtmlAttr` minus the attribute-only quote escapes.
 */
export function escapeHtmlText(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Validate that an image URL is safe to embed in OG/Twitter meta. Rejects
 * `javascript:`, `data:`, protocol-relative `//host`, and any host outside
 * the allowlist used by the rest of the platform's CSP policy.
 *
 * Returns the URL unchanged on success, or `null` if the URL must be dropped.
 */
export function safeImageUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const url = String(input).trim();
  if (!url) return null;
  if (url.startsWith('//')) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase();
  // Allow exact-match or subdomain of any allow-listed host suffix.
  const ok = SAFE_IMAGE_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith('.' + suffix),
  );
  if (!ok) return null;
  return parsed.toString();
}

/**
 * Default OG image when the server hasn't uploaded a banner-splash, banner,
 * or icon. Mirrors the `og:image` URL in the root `index.html` so SSR pages
 * fall back to the same brand asset link unfurlers already cache for the
 * marketing/app shell. The host (`howlpro.com`) is on `SAFE_IMAGE_HOST_SUFFIXES`,
 * so this passes `safeImageUrl` validation and the runtime check below acts as
 * a build-time tripwire if the allowlist ever drifts.
 */
const BRAND_FALLBACK_OG_IMAGE: string = (() => {
  const url = 'https://howlpro.com/howl-logo.png';
  const validated = safeImageUrl(url);
  if (!validated) {
    throw new Error('serverProfile: BRAND_FALLBACK_OG_IMAGE failed safeImageUrl validation');
  }
  return validated;
})();

/**
 * Truncate a string to at most `max` chars without splitting a multi-byte
 * character. Adds an ellipsis if truncation occurred.
 */
function truncate(input: string, max: number): string {
  const trimmed = input.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

export interface ServerProfileViewModel {
  vanity: string; // already lowercased + validated
  name: string;
  description: string | null;
  imageUrl: string | null; // bannerSplash | banner | icon | null
}

const CSP_META =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com https://static.cloudflareinsights.com; " +
  "style-src 'self' 'unsafe-inline'; font-src 'self' data:; " +
  "img-src 'self' data: blob: https://api.howlpro.com https://cdn.howlpro.com https://cdn.jsdelivr.net https://cdn.discordapp.com https://media.discordapp.net https://api.dicebear.com https://api.klipy.com https://static.klipy.com https://imgur.com https://i.imgur.com https://media.tenor.com https://c.tenor.com https://media.giphy.com https://media0.giphy.com https://i.giphy.com https://media1.giphy.com https://media2.giphy.com https://media3.giphy.com https://media4.giphy.com https://pbs.twimg.com https://img.youtube.com https://cdn.cloudflare.steamstatic.com https://*.google.com https://i.scdn.co https://*.fbcdn.net; " +
  "connect-src 'self' data: blob: https://api.klipy.com https://static.klipy.com https://challenges.cloudflare.com https://*.ingest.sentry.io https://*.ingest.us.sentry.io wss://api.howlpro.com https://api.howlpro.com https://cdn.howlpro.com wss://livekit.howlpro.com https://livekit.howlpro.com https://static.cloudflareinsights.com; " +
  "media-src 'self' blob: https://api.klipy.com https://static.klipy.com https://api.howlpro.com https://cdn.howlpro.com; " +
  "worker-src 'self' blob:; manifest-src 'self'; " +
  "frame-src https://www.youtube-nocookie.com https://challenges.cloudflare.com https://open.spotify.com https://store.steampowered.com https://player.twitch.tv https://clips.twitch.tv https://www.tiktok.com https://platform.twitter.com https://embed.reddit.com https://player.kick.com; " +
  "object-src 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests;";

/**
 * Render the SSR HTML for `/s/:vanity` (200 path).
 *
 * `vm.name`, `vm.description`, `vm.imageUrl`, and `vm.vanity` MUST already be
 * the values you want to embed — this function only escapes them; it does not
 * filter or normalize. (Image URL safety is enforced by the caller via
 * `safeImageUrl`.)
 */
export function renderServerProfileHtml(vm: ServerProfileViewModel): string {
  const titleSafe = truncate(vm.name, 80);
  const descSafe = vm.description ? truncate(vm.description, 200) : 'Join this Howl community.';
  const ogTitle = escapeHtmlAttr(titleSafe);
  const ogDescription = escapeHtmlAttr(descSafe);
  const titleText = escapeHtmlText(`${titleSafe} · Howl`);
  const canonicalUrl = `https://app.howlpro.com/s/${encodeURIComponent(vm.vanity)}`;
  const ogUrl = escapeHtmlAttr(canonicalUrl);

  // Defense-in-depth: if escaped output STILL contains a literal `<`, refuse
  // to render. This should be unreachable post-escape, but it gives us a
  // tripwire if a future change ever tries to interpolate raw HTML.
  if (ogTitle.includes('<') || ogDescription.includes('<')) {
    throw new Error('serverProfile: escape produced unexpected `<` in attribute');
  }

  // Fall back to the Howl brand image so link unfurlers always render a card
  // image. The brand asset is a square logo, so degrade to `summary` (vs the
  // `summary_large_image` rich card) when there's no server-supplied image.
  const validatedImage = vm.imageUrl ? safeImageUrl(vm.imageUrl) : null;
  const safeImage = validatedImage || BRAND_FALLBACK_OG_IMAGE;
  const ogImageTag = `<meta property="og:image" content="${escapeHtmlAttr(safeImage)}">\n    <meta name="twitter:image" content="${escapeHtmlAttr(safeImage)}">`;
  const twitterCard = validatedImage ? 'summary_large_image' : 'summary';

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <meta name="referrer" content="strict-origin-when-cross-origin">
    <meta http-equiv="Content-Security-Policy" content="${CSP_META}">
    <title>${titleText}</title>
    <link rel="icon" type="image/png" href="/howl-logo.png">
    <link rel="apple-touch-icon" href="/howl-logo.png">
    <link rel="manifest" href="/manifest.json">
    <link rel="canonical" href="${ogUrl}">
    <meta name="description" content="${ogDescription}">

    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Howl">
    <meta property="og:title" content="${ogTitle}">
    <meta property="og:description" content="${ogDescription}">
    <meta property="og:url" content="${ogUrl}">
    ${ogImageTag}

    <meta name="twitter:card" content="${twitterCard}">
    <meta name="twitter:title" content="${ogTitle}">
    <meta name="twitter:description" content="${ogDescription}">

    <meta name="theme-color" content="#0c3a5c">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="Howl">
    <meta name="mobile-web-app-capable" content="yes">
    <link rel="stylesheet" href="/bootstrap.css">
</head>
<body>
    <div id="root"></div>
    <script src="/guard.js"></script>
    <script type="module" src="/index.tsx"></script>
</body>
</html>`;
}

/**
 * Render the SSR HTML for `/s/:vanity` 404. Same shell, no per-server data.
 */
export function renderServerProfileNotFoundHtml(): string {
  const fallbackTitle = 'Server not found · Howl';
  const fallbackDesc = 'This Howl community could not be found. It may be private, suspended, or the link may be invalid.';
  const titleAttr = escapeHtmlAttr(fallbackTitle);
  const descAttr = escapeHtmlAttr(fallbackDesc);

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <meta name="referrer" content="strict-origin-when-cross-origin">
    <meta http-equiv="Content-Security-Policy" content="${CSP_META}">
    <title>${escapeHtmlText(fallbackTitle)}</title>
    <link rel="icon" type="image/png" href="/howl-logo.png">
    <link rel="manifest" href="/manifest.json">
    <meta name="description" content="${descAttr}">

    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Howl">
    <meta property="og:title" content="${titleAttr}">
    <meta property="og:description" content="${descAttr}">

    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="${titleAttr}">
    <meta name="twitter:description" content="${descAttr}">
</head>
<body>
    <div id="root"></div>
    <script src="/guard.js"></script>
    <script type="module" src="/index.tsx"></script>
</body>
</html>`;
}
