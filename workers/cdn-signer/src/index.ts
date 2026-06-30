// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * cdn-signer Cloudflare Worker
 *
 * Validates HMAC-signed URLs for cdn.howlpro.com and serves objects from
 * the configured R2 bucket (see wrangler.toml bucket_name). URLs are signed by the backend using
 * HMAC-SHA256 over `${key}:${exp}` with the shared secret; this Worker
 * re-computes the signature and rejects mismatched or expired URLs at
 * the edge.
 */

interface Env {
  UPLOADS: R2Bucket;
  HMAC_SIGNING_SECRET: string;
}

const encoder = new TextEncoder();

// Browsers that do cross-origin `fetch()` on CDN URLs (e.g. encrypted DM
// attachments) need CORS headers on 2xx responses, not just 4xx. We echo the
// request Origin if it's on the allowlist rather than using a wildcard so
// credentialed requests can still work if ever enabled.
const ALLOWED_ORIGINS = new Set<string>([
  "https://app.howlpro.com",
  "howl-app://app",
  "http://localhost:3000",
  "http://localhost:5173",
]);

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  // On a cross-origin redirect (e.g. app.howlpro.com → api.howlpro.com → cdn
  // for a signed-URL hop), browsers taint the Origin to "null" on the
  // redirected request. We must echo "null" back so `<img crossOrigin>` and
  // Service-Worker-intercepted fetches don't fail the CORS check with
  // "ACAO does not match supplied origin". Credential-less only — safe.
  if (origin === "null") {
    return {
      "access-control-allow-origin": "null",
      "access-control-expose-headers": "Content-Length, Content-Type, ETag",
      "vary": "Origin",
    };
  }
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return {
      "access-control-allow-origin": origin,
      "access-control-expose-headers": "Content-Length, Content-Type, ETag",
      "vary": "Origin",
    };
  }
  return {};
}

function withCors(response: Response, request: Request): Response {
  const cors = corsHeaders(request);
  if (Object.keys(cors).length === 0) return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function base64urlEncode(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let b64 = "";
  for (let i = 0; i < u8.length; i++) {
    b64 += String.fromCharCode(u8[i]);
  }
  return btoa(b64).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function computeSignature(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return base64urlEncode(sig);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function errorResponse(status: number, reason: string, request: Request): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...corsHeaders(request),
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Preflight for cross-origin reads. The real request is a simple GET with
    // no custom headers, so browsers only preflight when the page code adds
    // headers; respond anyway for robustness.
    if (request.method === "OPTIONS") {
      const cors = corsHeaders(request);
      if (!cors["access-control-allow-origin"]) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-allow-headers": "Content-Type, Range",
          "access-control-max-age": "86400",
        },
      });
    }

    const url = new URL(request.url);

    const rawKey = url.pathname.slice(1);
    if (!rawKey) {
      return errorResponse(403, "missing_params", request);
    }

    let key: string;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      return errorResponse(403, "missing_params", request);
    }

    const exp = url.searchParams.get("exp");
    const sig = url.searchParams.get("sig");
    const now = Math.floor(Date.now() / 1000);

    if (!exp || !sig) {
      return errorResponse(403, "missing_params", request);
    }

    const expNum = Number(exp);
    if (!Number.isFinite(expNum)) {
      return errorResponse(403, "missing_params", request);
    }

    if (expNum < now) {
      return errorResponse(403, "expired", request);
    }

    let expected: string;
    try {
      expected = await computeSignature(env.HMAC_SIGNING_SECRET, `${key}:${exp}`);
    } catch (err) {
      console.log("cdn-signer: hmac_error", String(err));
      return errorResponse(500, "internal_error", request);
    }

    if (!timingSafeEqual(expected, sig)) {
      return errorResponse(403, "bad_signature", request);
    }

    const ttl = Math.max(0, expNum - now);

    // Cache the canonical response without CORS headers; Cloudflare's cache API
    // does not honor `Vary: Origin`, so any per-origin header must be injected
    // on each serve rather than baked into the cached response.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) {
      return withCors(cached, request);
    }

    let object: R2ObjectBody | null;
    try {
      object = await env.UPLOADS.get(key);
    } catch (err) {
      console.log("cdn-signer: r2_error", key, String(err));
      return errorResponse(500, "internal_error", request);
    }

    if (!object) {
      return errorResponse(403, "not_found", request);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", `public, max-age=${ttl}, immutable`);

    const cacheableResponse = new Response(object.body, { status: 200, headers });

    if (ttl > 0) {
      ctx.waitUntil(cache.put(cacheKey, cacheableResponse.clone()));
    }

    return withCors(cacheableResponse, request);
  },
};
