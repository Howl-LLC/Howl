// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { escapeHtml, emailWrapper, htmlToText, type RenderedEmail } from './_shared.js';

export interface ApplicationRejectedParams {
  applicantName: string;
  serverName: string;
  /** Optional moderator note shown to the applicant. */
  note?: string;
}

export function applicationRejected(params: ApplicationRejectedParams): RenderedEmail {
  const subject = `Howl - Update on your application to "${params.serverName}"`;
  const noteBlock = params.note && params.note.trim().length > 0
    ? `
        <div style="background: #1e293b; border-radius: 12px; padding: 16px; text-align: left; margin: 16px 0;">
          <p style="color: #94a3b8; font-size: 13px; margin: 0 0 4px;"><strong style="color: #f1f5f9;">Note from the moderators:</strong></p>
          <p style="color: #e2e8f0; font-size: 13px; margin: 0; white-space: pre-wrap;">${escapeHtml(params.note)}</p>
        </div>
    `
    : '';
  const html = emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 20px; margin: 0 0 8px;">Your application wasn't accepted</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px;">Hi ${escapeHtml(params.applicantName)},</p>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px;">Thanks for your interest in <strong style="color: #f1f5f9;">${escapeHtml(params.serverName)}</strong>. The moderators have decided not to accept your application at this time.</p>
        ${noteBlock}
        <p style="color: #64748b; font-size: 12px; margin: 24px 0 0;">Don't take it personally. Every community sets its own bar. There are plenty more servers to explore on Howl.</p>
  `);
  return { subject, html, text: htmlToText(html) };
}
