// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
type PagesContext = {
  request: Request;
  next: () => Promise<Response>;
  env: { CANONICAL_HOST?: string };
};

export const onRequest = async (context: PagesContext): Promise<Response> => {
  const url = new URL(context.request.url);
  const canonicalHost = context.env.CANONICAL_HOST;

  // Cloudflare Pages assigns a fresh *.pages.dev hostname per deploy. When a
  // canonical host is configured, redirect those preview hostnames to it.
  // Leave CANONICAL_HOST unset to disable the redirect (fork-safe default).
  if (canonicalHost && url.hostname.endsWith('.pages.dev')) {
    const target = new URL(url.pathname + url.search, `https://${canonicalHost}`);
    return Response.redirect(target.toString(), 301);
  }

  return context.next();
};
