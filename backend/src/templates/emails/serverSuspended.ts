// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { escapeHtml, emailWrapper, htmlToText, type RenderedEmail } from './_shared.js';

export interface ServerSuspendedParams {
  ownerName: string;
  serverName: string;
  reason: string;
  appealUrl: string;
}

export function serverSuspended(params: ServerSuspendedParams): RenderedEmail {
  const subject = `Howl - "${params.serverName}" has been suspended`;
  const html = emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 20px; margin: 0 0 8px;">Your server has been suspended</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px;">Hi ${escapeHtml(params.ownerName)},</p>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px;">Howl Trust &amp; Safety has suspended <strong style="color: #f87171;">${escapeHtml(params.serverName)}</strong>. While suspended, members cannot access the server and it does not appear in discovery.</p>
        <div style="background: #1e293b; border-radius: 12px; padding: 16px; text-align: left; margin: 16px 0;">
          <p style="color: #94a3b8; font-size: 13px; margin: 0 0 4px;"><strong style="color: #f1f5f9;">Reason:</strong></p>
          <p style="color: #e2e8f0; font-size: 13px; margin: 0; white-space: pre-wrap;">${escapeHtml(params.reason)}</p>
        </div>
        <p style="color: #94a3b8; font-size: 13px; margin: 24px 0 12px;">If you believe this is a mistake, you can submit an appeal:</p>
        <a href="${escapeHtml(params.appealUrl)}" style="display: inline-block; background: #f87171; color: #0f172a; font-size: 14px; font-weight: 700; text-decoration: none; padding: 12px 32px; border-radius: 12px;">Appeal suspension</a>
        <p style="color: #64748b; font-size: 12px; margin: 24px 0 0;">Repeated or severe violations may result in permanent removal of the server.</p>
  `);
  return { subject, html, text: htmlToText(html) };
}
