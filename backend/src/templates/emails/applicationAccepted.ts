// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { escapeHtml, emailWrapper, htmlToText, type RenderedEmail } from './_shared.js';

export interface ApplicationAcceptedParams {
  applicantName: string;
  serverName: string;
  serverUrl: string;
  /** Optional moderator-supplied message to the applicant, included in the
   *  email body. Same field as the rejection email's `note` — the reviewer
   *  fills one applicant-facing message regardless of decision. */
  note?: string;
}

export function applicationAccepted(params: ApplicationAcceptedParams): RenderedEmail {
  const subject = `Howl - You're in: "${params.serverName}" accepted your application`;
  const noteBlock = params.note && params.note.trim().length > 0
    ? `
        <div style="background: #1e293b; border-radius: 12px; padding: 16px; text-align: left; margin: 16px 0;">
          <p style="color: #94a3b8; font-size: 13px; margin: 0 0 4px;"><strong style="color: #f1f5f9;">Note from the moderators:</strong></p>
          <p style="color: #e2e8f0; font-size: 13px; margin: 0; white-space: pre-wrap;">${escapeHtml(params.note)}</p>
        </div>`
    : '';
  const html = emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 20px; margin: 0 0 8px;">Welcome to ${escapeHtml(params.serverName)}!</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px;">Hi ${escapeHtml(params.applicantName)},</p>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 24px;">Your application to join <strong style="color: #076FA0;">${escapeHtml(params.serverName)}</strong> was accepted. You can jump in now.</p>
        ${noteBlock}
        <a href="${escapeHtml(params.serverUrl)}" style="display: inline-block; background: #076FA0; color: #f1f5f9; font-size: 14px; font-weight: 700; text-decoration: none; padding: 12px 32px; border-radius: 12px;">Open server</a>
        <p style="color: #64748b; font-size: 12px; margin: 24px 0 0;">Have fun, and remember: every server has its own rules. Check the welcome screen first.</p>
  `);
  return { subject, html, text: htmlToText(html) };
}
