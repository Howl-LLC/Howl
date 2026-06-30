// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import crypto from 'crypto';
import { Resend } from 'resend';
import { logger } from '../logger.js';
import { escapeHtml, emailWrapper, htmlToText } from '../templates/emails/_shared.js';
import { serverVerified, type ServerVerifiedParams } from '../templates/emails/serverVerified.js';
import { serverSuspended, type ServerSuspendedParams } from '../templates/emails/serverSuspended.js';
import { serverUnsuspended, type ServerUnsuspendedParams } from '../templates/emails/serverUnsuspended.js';
import { applicationAccepted, type ApplicationAcceptedParams } from '../templates/emails/applicationAccepted.js';
import { applicationRejected, type ApplicationRejectedParams } from '../templates/emails/applicationRejected.js';
import { serverVerificationRejected, type ServerVerificationRejectedParams } from '../templates/emails/serverVerificationRejected.js';
import { serverReportReceived, type ServerReportReceivedParams } from '../templates/emails/serverReportReceived.js';

const log = logger.child({ module: 'email' });

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM_EMAIL = process.env.EMAIL_FROM || 'Howl <noreply@howlpro.com>';

export function generateVerificationCode(): string {
  const num = crypto.randomBytes(4).readUInt32BE(0);
  return (100000 + (num % 900000)).toString();
}

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!resend) {
    log.info({ to, subject }, 'Email sending skipped (RESEND_API_KEY not set)');
    return;
  }

  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject,
    html,
    text: htmlToText(html),
  });

  if (error) {
    log.error({ to, subject, error }, 'Resend email failed');
    throw new Error(`Email send failed: ${error.message}`);
  }
}

export async function sendVerificationEmail(to: string, code: string): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && !process.env.RESEND_API_KEY) {
    log.info({ to, code }, 'DEV email verification code (no RESEND_API_KEY set)');
    return;
  }

  await sendEmail(to, 'Howl - Verify your email', emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 20px; margin: 0 0 8px;">Verify your email</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 24px;">Enter this code on the registration screen to complete your signup:</p>
        <div style="background: #1e293b; border-radius: 12px; padding: 16px; display: inline-block; min-width: 200px;">
          <span style="color: #076FA0; font-size: 36px; font-weight: 900; letter-spacing: 8px; font-family: monospace;">${escapeHtml(code)}</span>
        </div>
        <p style="color: #64748b; font-size: 12px; margin: 24px 0 0;">This code expires in 15 minutes. If you didn't request this, ignore this email.</p>
  `));
}

/**
 * Device-verification challenge (new-device login on an account without
 * TOTP/passkey MFA). Carries a 6-digit code the user enters on the
 * verification modal; the modal then either marks the device trusted for
 * 90 days (if the user checks the "Trust this device" box) or treats this
 * as a one-shot login.
 */
export async function sendDeviceVerificationEmail(
  to: string,
  params: { code: string; deviceLabel: string; ipMasked: string },
): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && !process.env.RESEND_API_KEY) {
    log.info({ to, code: params.code, device: params.deviceLabel }, 'DEV device verification code');
    return;
  }

  await sendEmail(to, 'Howl - Verify your new device', emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 20px; margin: 0 0 8px;">Verify your new device</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 24px;">Someone just tried to sign in to your Howl account from a device we haven't seen before. If that was you, enter this code on the verification screen:</p>
        <div style="background: #1e293b; border-radius: 12px; padding: 16px; display: inline-block; min-width: 200px;">
          <span style="color: #076FA0; font-size: 36px; font-weight: 900; letter-spacing: 8px; font-family: monospace;">${escapeHtml(params.code)}</span>
        </div>
        <div style="background: #1e293b; border-radius: 12px; padding: 16px; margin-top: 20px; text-align: left;">
          <p style="color: #94a3b8; font-size: 13px; margin: 0 0 4px;"><strong style="color: #f1f5f9;">Device:</strong> ${escapeHtml(params.deviceLabel)}</p>
          <p style="color: #94a3b8; font-size: 13px; margin: 0;"><strong style="color: #f1f5f9;">IP:</strong> ${escapeHtml(params.ipMasked)}</p>
        </div>
        <p style="color: #f87171; font-size: 13px; margin: 24px 0 0;">If this wasn't you, change your password immediately — someone may know it.</p>
        <p style="color: #64748b; font-size: 12px; margin: 16px 0 0;">This code expires in 10 minutes.</p>
  `));
}

export async function sendPasswordResetEmail(to: string, code: string): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && !process.env.RESEND_API_KEY) {
    log.info({ to, code }, 'DEV password reset code');
    return;
  }

  await sendEmail(to, 'Howl - Reset your password', emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 20px; margin: 0 0 8px;">Reset your password</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 24px;">Your password reset code is:</p>
        <div style="background: #1e293b; border-radius: 12px; padding: 16px; display: inline-block; min-width: 200px;">
          <span style="color: #076FA0; font-size: 36px; font-weight: 900; letter-spacing: 8px; font-family: monospace;">${escapeHtml(code)}</span>
        </div>
        <p style="color: #94a3b8; font-size: 13px; margin: 20px 0 0;">Go to the Howl login page, click <strong style="color: #f1f5f9;">Forgot Password</strong>, enter your email, then type this code along with your new password.</p>
        <p style="color: #64748b; font-size: 12px; margin: 16px 0 0;">This code expires in 15 minutes. If you didn't request this, you can safely ignore this email.</p>
  `));
}

export async function sendDataExportReadyEmail(to: string, downloadUrl: string): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && !process.env.RESEND_API_KEY) {
    log.info({ to, downloadUrl }, 'DEV data export ready');
    return;
  }

  await sendEmail(to, 'Howl - Your Data Export is Ready', emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 20px; margin: 0 0 8px;">Your data export is ready</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 24px;">Your Howl data export has been prepared and is ready for download.</p>
        <a href="${escapeHtml(downloadUrl)}" style="display: inline-block; background: #076FA0; color: #f1f5f9; font-size: 14px; font-weight: 700; text-decoration: none; padding: 12px 32px; border-radius: 12px;">Download My Data</a>
        <p style="color: #64748b; font-size: 12px; margin: 24px 0 0;">This download link expires in 48 hours.</p>
  `));
}

export async function sendEmailChangedNotification(to: string, newEmail: string): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && !process.env.RESEND_API_KEY) {
    log.info({ to }, 'DEV email changed notification');
    return;
  }

  // Mask the new email: show first char + domain (e.g. "t***@example.com")
  const [localPart, domain] = newEmail.split('@');
  const masked = localPart && domain
    ? `${localPart[0]}${'*'.repeat(Math.max(Math.min(localPart.length - 1, 5), 2))}@${domain}`
    : '(unknown)';

  await sendEmail(to, 'Howl - Your email address was changed', emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 20px; margin: 0 0 8px;">Your email address was changed</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px;">The email address associated with your Howl account has been changed to:</p>
        <div style="background: #1e293b; border-radius: 12px; padding: 12px 16px; display: inline-block;">
          <span style="color: #f1f5f9; font-size: 16px; font-family: monospace;">${escapeHtml(masked)}</span>
        </div>
        <p style="color: #f87171; font-size: 13px; margin: 24px 0 0;">If you did not make this change, your account may be compromised. Please contact support immediately.</p>
        <p style="color: #64748b; font-size: 12px; margin: 16px 0 0;">All other sessions have been signed out as a precaution.</p>
  `));
}

// Admin-action notifications
//
// When a platform admin performs a destructive action on a user's account
// (reset their password, disable MFA, change email, delete sessions), the user
// is told. Otherwise these actions are silent from the user's perspective, and
// three chained admin actions amount to a silent total takeover. These
// notifications cannot be reverted by the user (admin actions are authoritative);
// they're informational so the user can contact support if the action was
// unexpected.

function adminNoticeFooter(): string {
  return `<p style="color: #64748b; font-size: 12px; margin: 24px 0 0;">If this action was unexpected, contact support immediately.</p>`;
}

export async function sendAdminDisabledMfaEmail(to: string): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && !process.env.RESEND_API_KEY) {
    log.info({ to }, 'DEV admin-disabled-mfa notification');
    return;
  }
  await sendEmail(to, 'Howl - Two-factor authentication was disabled on your account', emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 20px; margin: 0 0 8px;">Two-factor authentication disabled</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px;">A Howl platform admin has disabled two-factor authentication on your account. You can re-enable it at any time from your account settings.</p>
        ${adminNoticeFooter()}
  `));
}

export async function sendAdminChangedEmailNotification(to: string, addressee: 'old' | 'new', newEmail: string): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && !process.env.RESEND_API_KEY) {
    log.info({ to, addressee }, 'DEV admin-changed-email notification');
    return;
  }
  const [localPart, domain] = newEmail.split('@');
  const masked = localPart && domain
    ? `${localPart[0]}${'*'.repeat(Math.max(Math.min(localPart.length - 1, 5), 2))}@${domain}`
    : '(unknown)';
  const heading = addressee === 'old'
    ? 'Your account email was changed by an administrator'
    : 'Your email is now associated with a Howl account';
  await sendEmail(to, `Howl - ${heading}`, emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 20px; margin: 0 0 8px;">${escapeHtml(heading)}</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px;">A Howl platform admin changed the email address on this account to:</p>
        <div style="background: #1e293b; border-radius: 12px; padding: 12px 16px; display: inline-block;">
          <span style="color: #f1f5f9; font-size: 16px; font-family: monospace;">${escapeHtml(masked)}</span>
        </div>
        ${adminNoticeFooter()}
  `));
}

export async function sendAdminDeletedSessionsEmail(to: string): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && !process.env.RESEND_API_KEY) {
    log.info({ to }, 'DEV admin-deleted-sessions notification');
    return;
  }
  await sendEmail(to, 'Howl - Your active sessions were revoked', emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 20px; margin: 0 0 8px;">Your sessions were revoked</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px;">A Howl platform admin signed out all of your active sessions. You'll need to log in again on each device.</p>
        ${adminNoticeFooter()}
  `));
}

/** Notify the account holder after a password is installed on an
 *  SSO-only account. No revert link: if this wasn't the owner, they should
 *  log in (they still can, via SSO), rotate it via the in-app flow, and
 *  contact support. */
export async function sendPasswordInstalledEmail(to: string): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && !process.env.RESEND_API_KEY) {
    log.info({ to }, 'DEV password-installed notification');
    return;
  }
  await sendEmail(to, 'Howl - A password was added to your account', emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 20px; margin: 0 0 8px;">A password was added to your account</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px;">Your Howl account (previously SSO-only) now has a password set. You can still sign in with your SSO provider.</p>
        <p style="color: #f87171; font-size: 13px; margin: 24px 0 0;">If this wasn't you, sign in via SSO, change the password in your account security settings, and contact support.</p>
  `));
}

export async function sendAdminPasswordResetEmail(to: string): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && !process.env.RESEND_API_KEY) {
    log.info({ to }, 'DEV admin-password-reset notification');
    return;
  }
  await sendEmail(to, 'Howl - Your password was reset by an administrator', emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 20px; margin: 0 0 8px;">Your password was reset</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px;">A Howl platform admin reset the password on your account. Use the "Forgot password" link on the login page to set a new one.</p>
        ${adminNoticeFooter()}
  `));
}

/** Sent to the OLD address after an email change commits. Contains a
 *  one-click revert link valid for 24h. This is the real safety net: if the
 *  change wasn't owner-initiated, the legit owner clicks the link and the
 *  account email is restored + all sessions killed. */
export async function sendEmailChangedWithRevertEmail(to: string, newEmail: string, revertUrl: string): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && !process.env.RESEND_API_KEY) {
    log.info({ to, revertUrl }, 'DEV email-changed-with-revert notification');
    return;
  }

  const [localPart, domain] = newEmail.split('@');
  const masked = localPart && domain
    ? `${localPart[0]}${'*'.repeat(Math.max(Math.min(localPart.length - 1, 5), 2))}@${domain}`
    : '(unknown)';

  await sendEmail(to, 'Howl - Your email address was changed (revert available for 24 hours)', emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 20px; margin: 0 0 8px;">Your email address was changed</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px;">The email address on your Howl account was changed to:</p>
        <div style="background: #1e293b; border-radius: 12px; padding: 12px 16px; display: inline-block;">
          <span style="color: #f1f5f9; font-size: 16px; font-family: monospace;">${escapeHtml(masked)}</span>
        </div>
        <p style="color: #94a3b8; font-size: 13px; margin: 24px 0 12px;">If this wasn't you, click below within the next 24 hours to revert the change and sign out of all devices.</p>
        <a href="${escapeHtml(revertUrl)}" style="display: inline-block; background: #f87171; color: #0f172a; font-size: 14px; font-weight: 700; text-decoration: none; padding: 12px 32px; border-radius: 12px;">Revert email change</a>
        <p style="color: #64748b; font-size: 12px; margin: 16px 0 0;">All other sessions have already been signed out as a precaution.</p>
  `));
}

/**
 * Sent on successful login from a previously-unseen device fingerprint
 * (hashed IP + UA). Carries a revoke-sessions link (24 h) so the real owner
 * can kill the session immediately if the login wasn't theirs.
 *
 * Opt-out via `User.notifyOnNewDevice = false`.
 */
export async function sendNewDeviceLoginEmail(
  to: string,
  params: { deviceName: string; ipMasked: string; loginAt: Date; revokeUrl: string },
): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && !process.env.RESEND_API_KEY) {
    log.info({ to, device: params.deviceName }, 'DEV new-device login notification');
    return;
  }
  const when = params.loginAt.toUTCString();
  await sendEmail(to, 'Howl - New login to your account', emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 22px; font-weight: 700; line-height: 1.3; margin: 0 0 10px;">New login detected</h2>
        <p style="color: #94a3b8; font-size: 15px; line-height: 1.6; margin: 0 0 24px;">We noticed a login to your Howl account from a device we haven't seen before.</p>
        <div style="background: #0b1220; border: 1px solid rgba(7,111,160,0.18); border-radius: 12px; padding: 20px 22px;">
          <p style="margin: 0 0 14px;"><span style="display: block; color: #64748b; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; margin: 0 0 3px;">Device</span><span style="color: #f1f5f9; font-size: 14px;">${escapeHtml(params.deviceName)}</span></p>
          <p style="margin: 0 0 14px;"><span style="display: block; color: #64748b; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; margin: 0 0 3px;">IP</span><span style="color: #f1f5f9; font-size: 14px;">${escapeHtml(params.ipMasked)}</span></p>
          <p style="margin: 0;"><span style="display: block; color: #64748b; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; margin: 0 0 3px;">Time</span><span style="color: #f1f5f9; font-size: 14px;">${escapeHtml(when)}</span></p>
        </div>
        <p style="color: #94a3b8; font-size: 14px; line-height: 1.6; margin: 28px 0 16px;">If this was you, you can ignore this email. If not, click below to sign out of all sessions.</p>
        <a href="${escapeHtml(params.revokeUrl)}" style="display: inline-block; background: #02385A; color: #ffffff; font-size: 14px; font-weight: 600; text-decoration: none; padding: 12px 32px; border-radius: 12px; box-shadow: 0 8px 24px rgba(7,111,160,0.30);">Sign out of all sessions</a>
        <p style="color: #64748b; font-size: 12px; line-height: 1.6; margin: 28px 0 0;">You can turn off new-device emails under Settings → Privacy &amp; Security.</p>
  `));
}

/**
 * Sent by an automated cleanup script (username sanitization, severe-slur
 * enforcement, etc.) when a user's account-level username was rewritten to a
 * placeholder. No revert link: the user picks a new username themselves in
 * account settings on next login. Old username is included so the recipient
 * can identify the account.
 */
export async function sendUsernameResetRequiredEmail(
  to: string,
  params: { oldUsername: string; newUsername: string; reason: 'profanity' | 'sanitization' },
): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && !process.env.RESEND_API_KEY) {
    log.info({ to, oldUsername: params.oldUsername, newUsername: params.newUsername, reason: params.reason }, 'DEV username-reset-required notification');
    return;
  }
  const explanation = params.reason === 'profanity'
    ? 'Your previous username conflicted with our community guidelines and has been changed automatically.'
    : 'Your previous username contained characters that are no longer accepted and has been changed automatically.';
  await sendEmail(to, 'Howl - Your username was changed', emailWrapper(`
        <h2 style="color: #f1f5f9; font-size: 20px; margin: 0 0 8px;">Your username was changed</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px;">${escapeHtml(explanation)} Your account is unaffected — your messages, friends, and servers are still there.</p>
        <div style="background: #1e293b; border-radius: 12px; padding: 12px 16px; display: inline-block;">
          <span style="color: #94a3b8; font-size: 13px; margin-right: 8px;">Old:</span>
          <span style="color: #f87171; font-size: 14px; font-family: monospace; text-decoration: line-through;">${escapeHtml(params.oldUsername)}</span>
        </div>
        <div style="background: #1e293b; border-radius: 12px; padding: 12px 16px; display: inline-block; margin-top: 8px;">
          <span style="color: #94a3b8; font-size: 13px; margin-right: 8px;">New:</span>
          <span style="color: #076FA0; font-size: 14px; font-family: monospace;">${escapeHtml(params.newUsername)}</span>
        </div>
        <p style="color: #94a3b8; font-size: 13px; margin: 24px 0 0;">Log in and pick a new username from <strong style="color: #f1f5f9;">Account Settings</strong> at any time.</p>
  `));
}

// Community / Public Server lifecycle (Discord-parity)
//
// Templates under `src/templates/emails/*` pre-render `{ subject, html, text }`,
// so the senders below never derive the plaintext fallback twice. `dispatch`
// handles the dev-mode short-circuit that's repeated across every sender in
// this file.

async function dispatch(
  to: string,
  rendered: { subject: string; html: string; text: string },
  devTag: string,
  devLogFields: Record<string, unknown> = {},
): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && !process.env.RESEND_API_KEY) {
    log.info({ to, ...devLogFields }, devTag);
    return;
  }
  if (!resend) {
    log.info({ to, subject: rendered.subject }, 'Email sending skipped (RESEND_API_KEY not set)');
    return;
  }
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
  if (error) {
    log.error({ to, subject: rendered.subject, error }, 'Resend email failed');
    throw new Error(`Email send failed: ${error.message}`);
  }
}

/** Confirmation to a server owner once their server gets the verified badge. */
export async function sendServerVerifiedEmail(to: string, params: ServerVerifiedParams): Promise<void> {
  await dispatch(to, serverVerified(params), 'DEV server-verified email', { serverName: params.serverName });
}

/** Sent to a server owner when Trust & Safety suspends their server. */
export async function sendServerSuspendedEmail(to: string, params: ServerSuspendedParams): Promise<void> {
  await dispatch(to, serverSuspended(params), 'DEV server-suspended email', { serverName: params.serverName });
}

/** Sent to a server owner when a prior suspension is lifted. */
export async function sendServerUnsuspendedEmail(to: string, params: ServerUnsuspendedParams): Promise<void> {
  await dispatch(to, serverUnsuspended(params), 'DEV server-unsuspended email', { serverName: params.serverName });
}

/** Sent to a membership applicant once their application is accepted. */
export async function sendApplicationAcceptedEmail(to: string, params: ApplicationAcceptedParams): Promise<void> {
  await dispatch(to, applicationAccepted(params), 'DEV application-accepted email', { serverName: params.serverName });
}

/** Sent to a membership applicant once their application is rejected. */
export async function sendApplicationRejectedEmail(to: string, params: ApplicationRejectedParams): Promise<void> {
  await dispatch(to, applicationRejected(params), 'DEV application-rejected email', { serverName: params.serverName });
}

/** Sent to a server owner when their "Verified by Howl" application is rejected. */
export async function sendServerVerificationRejectedEmail(
  to: string,
  params: ServerVerificationRejectedParams,
): Promise<void> {
  await dispatch(
    to,
    serverVerificationRejected(params),
    'DEV server-verification-rejected email',
    { serverName: params.serverName },
  );
}

/**
 * Internal Trust & Safety queue notification when a user reports a server.
 * Goes to the address in `ADMIN_NOTIFY_EMAIL`; if unset, the call is a no-op
 * so test/dev environments don't blow up.
 */
export async function sendServerReportReceivedEmail(params: ServerReportReceivedParams): Promise<void> {
  const to = process.env.ADMIN_NOTIFY_EMAIL;
  if (!to) {
    log.warn({ serverName: params.serverName }, 'ADMIN_NOTIFY_EMAIL not set — server report email skipped');
    return;
  }
  await dispatch(to, serverReportReceived(params), 'DEV server-report-received email', { serverName: params.serverName });
}

export async function sendMfaSmsCode(phone: string, code: string): Promise<void> {
  // SMS MFA requires a provider like Twilio. For now, log in dev and reject in prod.
  if (process.env.NODE_ENV !== 'production') {
    log.info({ phone, code }, 'DEV MFA SMS code');
    return;
  }
  // TODO: Implement Twilio or another SMS provider
  log.warn({ phone }, 'SMS MFA not configured — no provider set');
  throw new Error('SMS MFA is not available. Use authenticator app instead.');
}
