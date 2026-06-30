// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { escapeHtml, emailWrapper, htmlToText, type RenderedEmail } from './_shared.js';

export interface ServerUnsuspendedParams {
  ownerName: string;
  serverName: string;
}

export function serverUnsuspended(params: ServerUnsuspendedParams): RenderedEmail {
  const subject = `Howl - "${params.serverName}" suspension lifted`;
  const html = emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 20px; margin: 0 0 8px;">Your server's suspension has been lifted</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px;">Hi ${escapeHtml(params.ownerName)},</p>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 24px;">The suspension on <strong style="color: #076FA0;">${escapeHtml(params.serverName)}</strong> has been lifted. Members can rejoin and the server is once again eligible for discovery.</p>
        <p style="color: #64748b; font-size: 12px; margin: 0;">Please continue to follow the Howl Community Guidelines so we don't have to do this again.</p>
  `);
  return { subject, html, text: htmlToText(html) };
}
