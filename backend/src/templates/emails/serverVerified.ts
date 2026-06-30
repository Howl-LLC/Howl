// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { escapeHtml, emailWrapper, htmlToText, type RenderedEmail } from './_shared.js';

export interface ServerVerifiedParams {
  ownerName: string;
  serverName: string;
  manageUrl: string;
}

export function serverVerified(params: ServerVerifiedParams): RenderedEmail {
  const subject = `Howl - "${params.serverName}" has been verified`;
  const html = emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 20px; margin: 0 0 8px;">Your server is now verified</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px;">Hi ${escapeHtml(params.ownerName)},</p>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 24px;"><strong style="color: #076FA0;">${escapeHtml(params.serverName)}</strong> just received the verified badge on Howl. The badge is now visible to members and in the discovery directory.</p>
        <a href="${escapeHtml(params.manageUrl)}" style="display: inline-block; background: #076FA0; color: #f1f5f9; font-size: 14px; font-weight: 700; text-decoration: none; padding: 12px 32px; border-radius: 12px;">Manage server</a>
        <p style="color: #64748b; font-size: 12px; margin: 24px 0 0;">Verification recognizes authentic, well-moderated communities. Keep up the great work.</p>
  `);
  return { subject, html, text: htmlToText(html) };
}
