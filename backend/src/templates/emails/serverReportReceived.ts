// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { escapeHtml, emailWrapper, htmlToText, type RenderedEmail } from './_shared.js';

export interface ServerReportReceivedParams {
  /** Display name for the addressee on the admin distribution list. */
  adminName: string;
  serverName: string;
  reporterName: string;
  reason: string;
  reportUrl: string;
}

/**
 * Internal admin-queue notification fired when a Howl user files a report
 * against a community server. Sent to the address configured in
 * `ADMIN_NOTIFY_EMAIL`. Body deliberately omits message contents (DMs are
 * E2E encrypted; reports must reference message IDs only) — reviewers click
 * through to the admin panel.
 */
export function serverReportReceived(params: ServerReportReceivedParams): RenderedEmail {
  const subject = `[Howl T&S] New server report: "${params.serverName}"`;
  const html = emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 20px; margin: 0 0 8px;">New server report</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px;">Hi ${escapeHtml(params.adminName)},</p>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px;">A user filed a report against a community server. Details:</p>
        <div style="background: #1e293b; border-radius: 12px; padding: 16px; text-align: left; margin: 16px 0;">
          <p style="color: #94a3b8; font-size: 13px; margin: 0 0 6px;"><strong style="color: #f1f5f9;">Server:</strong> ${escapeHtml(params.serverName)}</p>
          <p style="color: #94a3b8; font-size: 13px; margin: 0 0 6px;"><strong style="color: #f1f5f9;">Reporter:</strong> ${escapeHtml(params.reporterName)}</p>
          <p style="color: #94a3b8; font-size: 13px; margin: 0 0 6px;"><strong style="color: #f1f5f9;">Reason:</strong></p>
          <p style="color: #e2e8f0; font-size: 13px; margin: 0; white-space: pre-wrap;">${escapeHtml(params.reason)}</p>
        </div>
        <a href="${escapeHtml(params.reportUrl)}" style="display: inline-block; background: #076FA0; color: #f1f5f9; font-size: 14px; font-weight: 700; text-decoration: none; padding: 12px 32px; border-radius: 12px;">Review report</a>
        <p style="color: #64748b; font-size: 12px; margin: 24px 0 0;">This is an automated Trust &amp; Safety notification. Do not forward.</p>
  `);
  return { subject, html, text: htmlToText(html) };
}
