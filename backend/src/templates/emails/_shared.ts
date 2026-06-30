// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Shared rendering helpers used by every Howl email template (the inline
 * ones in `services/email.ts` and the per-template files in this folder).
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function emailWrapper(content: string): string {
  return `
    <div style="background-color: #000000; padding: 40px 20px; width: 100%;">
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto;">
        <div style="text-align: center; margin-bottom: 32px;">
          <h1 style="color: #076FA0; font-size: 28px; margin: 0;">Howl</h1>
        </div>
        <div style="background: #0f172a; border: 1px solid rgba(7,111,160,0.2); border-radius: 16px; padding: 32px; text-align: center;">
          ${content}
        </div>
      </div>
    </div>
  `;
}

/**
 * Strip HTML to a plaintext alternative — corporate spam filters
 * (Microsoft Defender, Google Workspace Strict, Mimecast) downrank
 * HTML-only transactional mail, so we ship a text/plain part with every
 * send.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|h[1-6]|li)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n')
    .trim();
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}
