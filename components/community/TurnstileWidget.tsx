// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useRef } from 'react';

const TURNSTILE_SITE_KEY = (import.meta.env?.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? '';

// Global Window.turnstile type lives in electron.d.ts so it's shared across
// every component that needs the captcha widget (Login.tsx + this one).

/**
 * Minimal Cloudflare Turnstile widget. Mirrors the implementation in
 * `components/Login.tsx`. Extracted here so any non-auth flow that needs
 * captcha (e.g. apply-to-join applications) can reuse the same loader
 * + dark-theme settings without duplicating the script-tag boilerplate.
 *
 * Renders nothing if `VITE_TURNSTILE_SITE_KEY` is unset (dev environments).
 * Callers should treat an empty captchaToken as "not present" and let the
 * server enforce.
 */
export function TurnstileWidget({
  onToken,
  resetKey,
}: {
  onToken: (token: string) => void;
  resetKey?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);

  // Reset the widget when the parent bumps `resetKey`.
  useEffect(() => {
    if (!widgetId.current || !window.turnstile) return;
    window.turnstile.reset(widgetId.current);
    onToken('');
    // We intentionally do NOT depend on `onToken` to avoid resetting on
    // every render; parents typically wrap onToken in useState setter.
  }, [resetKey]);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !containerRef.current) return;

    const tryRender = () => {
      if (!window.turnstile || widgetId.current) return;
      widgetId.current = window.turnstile.render(containerRef.current!, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: onToken,
        'expired-callback': () => onToken(''),
        theme: 'dark',
      });
    };

    if (window.turnstile) {
      tryRender();
    } else if (!document.querySelector('script[src*="turnstile"]')) {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.onload = () => setTimeout(tryRender, 100);
      document.head.appendChild(script);
    } else {
      const iv = setInterval(() => {
        if (window.turnstile) {
          clearInterval(iv);
          tryRender();
        }
      }, 100);
      return () => clearInterval(iv);
    }

    return () => {
      if (widgetId.current && window.turnstile) {
        try { window.turnstile.remove(widgetId.current); } catch { /* ignored */ }
        widgetId.current = null;
      }
    };
  }, [onToken]);

  if (!TURNSTILE_SITE_KEY) return null;
  return <div ref={containerRef} className="flex justify-center mt-3" />;
}

export default TurnstileWidget;
