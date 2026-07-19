// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { escapeHtml, emailWrapper, htmlToText, type RenderedEmail } from './_shared.js';

export interface ServerVerificationRejectedParams {
  ownerName: string;
  serverName: string;
  /** Optional admin note shown to the applicant. */
  decisionNote?: string;
  /** Number of days until the owner can re-apply. */
  cooldownDays: number;
}

export function serverVerificationRejected(params: ServerVerificationRejectedParams): RenderedEmail {
  const subject = `Howl - Update on your verification request for "${params.serverName}"`;
  const noteBlock = params.decisionNote && params.decisionNote.trim().length > 0
    ? `
        <div style="background: #1e293b; border-radius: 12px; padding: 16px; text-align: left; margin: 16px 0;">
          <p style="color: #94a3b8; font-size: 13px; margin: 0 0 4px;"><strong style="color: #f1f5f9;">Note from the review team:</strong></p>
          <p style="color: #e2e8f0; font-size: 13px; margin: 0; white-space: pre-wrap;">${escapeHtml(params.decisionNote)}</p>
        </div>
    `
    : '';
  const html = emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 20px; margin: 0 0 8px;">Your verification request wasn't accepted</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px;">Hi ${escapeHtml(params.ownerName)},</p>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px;">Thanks for applying for the Verified by Howl badge for <strong style="color: #f1f5f9;">${escapeHtml(params.serverName)}</strong>. After review, we weren't able to verify the application this time.</p>
        ${noteBlock}
        <p style="color: #64748b; font-size: 12px; margin: 24px 0 0;">You can submit a new application in ${params.cooldownDays} day${params.cooldownDays === 1 ? '' : 's'}. Verification is reserved for official organizations and brands. Make sure your website clearly shows ownership of the community before re-applying.</p>
  `);
  return { subject, html, text: htmlToText(html) };
}
