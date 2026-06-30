// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Signup-time Terms of Service summary: the condensed, plain-language
 * version shown inside the "I agree to the Terms" popup at account
 * creation. This is the SINGLE SOURCE OF TRUTH for the summary: anywhere
 * the app needs to display the signup-time summary (Login, SsoOnboarding,
 * an EU consent banner, etc.), import from this module.
 *
 * Keep this in sync with the full Terms of Service when sections are
 * added, removed, or materially changed. The full terms live at:
 *   - public/_legal-terms-of-service.html  (served to users at /terms-of-service)
 */

export interface TermsSummaryClause {
  heading: string;
  body: string;
}

export const TERMS_SUMMARY_EFFECTIVE_DATE = 'March 4, 2026';
export const TERMS_SUMMARY_LAST_UPDATED = 'June 16, 2026';

export const TERMS_SUMMARY_INTRO =
  'Welcome to Howl. These Terms of Service ("Terms") govern your access to and use of the Howl platform. By creating an account, you agree to be bound by these Terms.';

export const TERMS_SUMMARY_CLAUSES: readonly TermsSummaryClause[] = [
  {
    heading: '1. Acceptance of Terms',
    body: 'By registering for an account, you confirm that you have read, understood, and agree to be bound by these Terms and our Privacy Policy.',
  },
  {
    heading: '2. Eligibility',
    body: 'You must be at least 13 years old to use the Service. If you are between 13 and 18, you may only use the Service with parental consent.',
  },
  {
    heading: '3. Account Security',
    body: 'You are responsible for the confidentiality of your credentials and all activity under your account. Use strong, unique passwords and enable two-factor authentication. Notify us immediately of unauthorized use. One person may not operate multiple accounts without permission, and accounts may not be sold or transferred.',
  },
  {
    heading: '4. Service Description',
    body: 'Howl provides real-time messaging, voice and video calls, screen sharing, and community servers. We may add, modify, suspend, or discontinue features at our discretion, with reasonable notice for material changes.',
  },
  {
    heading: '5. Client Software',
    body: 'The Howl desktop and mobile apps are licensed to you for personal use only. No reverse engineering, no commercial redistribution, no bypassing security. The apps may update themselves automatically to deliver security and bug fixes.',
  },
  {
    heading: '6. Acceptable Use',
    body: 'Do not: violate the law; post illegal, harmful, or obscene content; engage in hate speech or harassment; distribute malware; attempt unauthorized access; scrape or data-mine; spam; impersonate others; exploit minors; or circumvent security features. CSAM will be reported to authorities.',
  },
  {
    heading: '7. End-to-End Encryption',
    body: 'All direct messages, group DMs, and DM calls are end-to-end encrypted by default, using the MLS protocol (RFC 9420). You choose how your keys are backed up. In Maximum Privacy mode (the default), only you hold your keys, so we cannot read your content; if you lose both your passphrase and your recovery key, your E2E-encrypted data is permanently unrecoverable. In Secure & Easy mode, Howl stores a password-protected backup of your keys tied to your account password, so after a password reset you can complete the server-recovery flow on next login to regain access to your data; this also means Howl could, in principle, access your content if compelled by valid legal process combined with your account password.',
  },
  {
    heading: '8. Voice & Video',
    body: 'Server voice channels and stages use SFrame end-to-end encryption over a DTLS-SRTP transport. DM voice and video calls are also end-to-end encrypted, with a per-call key derived from the conversation\'s end-to-end-encrypted (MLS) group. You must get consent from all participants before recording. We do not actively monitor voice or video content.',
  },
  {
    heading: '9. Emergency Services',
    body: 'The Service is not a substitute for emergency services. If you or someone else is in immediate danger, contact local emergency services directly (911 in the US, 999 in the UK, 112 in most of the EU, or your local equivalent). Howl cannot contact law enforcement or emergency responders on your behalf.',
  },
  {
    heading: '10. User Content',
    body: 'You retain ownership of the content you create. By posting, you grant Howl a non-exclusive license to use it solely to operate, improve, and promote the Service. You are responsible for your content. We may remove content that violates these Terms.',
  },
  {
    heading: '11. Privacy & Data',
    body: 'We do not sell, trade, or rent your personal information. We collect only data necessary to provide the Service. You may request a copy or deletion of your data at any time. See our Privacy Policy for details.',
  },
  {
    heading: '12. Security Reports',
    body: 'Found a vulnerability? Email support@howlpro.com (subject: "Security Report") before public disclosure. Good-faith security research within our published scope will not be met with enforcement action.',
  },
  {
    heading: '13. Payments & Refunds',
    body: 'Subscriptions auto-renew at the disclosed price until you cancel. Refunds follow our Refund Policy. Donations are voluntary and non-refundable. Server boosts and gift subscriptions are subject to terms presented at purchase.',
  },
  {
    heading: '14. Termination',
    body: 'You may delete your account at any time through Settings. We may suspend or terminate accounts that violate these Terms, break the law, or harm other users. Long-inactive accounts may be reclaimed after two years of complete inactivity, with prior notice.',
  },
  {
    heading: '15. Appeals',
    body: 'If you believe an enforcement action was in error, email support@howlpro.com with subject "Account Appeal" within 90 days (or 6 months in the European Union). Appeals do not apply to CSAM terminations, court-ordered closures, or sanctions-based terminations.',
  },
  {
    heading: '16. Export Controls',
    body: 'The Service is subject to U.S., EU, and UK export-control and sanctions laws. You must not be located in, nor a national of, an embargoed country (Cuba, Iran, North Korea, Syria, Crimea/Donetsk/Luhansk) and must not appear on any applicable restricted-parties list.',
  },
  {
    heading: '17. Disclaimers & Liability',
    body: 'THE SERVICE IS PROVIDED "AS IS" WITHOUT WARRANTIES. Howl is not liable for indirect or consequential damages, outages, or loss of data. Our total liability is capped at the amount you have paid us in the prior 12 months or $100, whichever is greater.',
  },
  {
    heading: '18. Disputes',
    body: 'Disputes are settled by binding arbitration under AAA Consumer Rules. You waive class-action participation in both arbitration and court proceedings. You may opt out of arbitration (but not the class-action waiver) within 30 days of first accepting these Terms by emailing support@howlpro.com with subject "Arbitration Opt-Out". Claims must be filed within one year. Small-claims actions and IP injunctions are excepted. EU/UK consumers may sue in their country of residence.',
  },
  {
    heading: '19. Changes',
    body: 'We may modify these Terms at any time. Material changes will be notified through the Service. Continued use after the effective date constitutes acceptance. If you disagree with a change, stop using the Service.',
  },
];

export const TERMS_SUMMARY_FULL_LINK_LABEL = 'Terms of Service';
export const TERMS_SUMMARY_FULL_LINK_HREF = '/terms-of-service';
export const TERMS_SUMMARY_SUPPORT_EMAIL = 'support@howlpro.com';
