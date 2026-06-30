// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Audit-log action constants. `AuditLog.action` is a free-form String
 * column; this enum is the source of truth and the schema's inline
 * comment mirrors these values. When adding a new action, update both
 * (no migration required — String column).
 */

export const AuditAction = {
  // Community feature toggle
  COMMUNITY_ENABLE: 'community_enable',
  COMMUNITY_DISABLE: 'community_disable',
  COMMUNITY_UPDATE: 'community_update',

  // Vanity URL
  VANITY_SET: 'vanity_set',
  VANITY_CLEARED: 'vanity_cleared',

  // Welcome screen
  WELCOME_SCREEN_UPDATE: 'welcome_screen_update',
  WELCOME_CHANNEL_ADD: 'welcome_channel_add',
  WELCOME_CHANNEL_UPDATE: 'welcome_channel_update',
  WELCOME_CHANNEL_DELETE: 'welcome_channel_delete',

  // Membership applications
  APPLICATIONS_QUESTIONS_UPDATE: 'applications_questions_update',
  APPLICATION_SUBMIT: 'application_submit',
  APPLICATION_WITHDRAW: 'application_withdraw',
  APPLICATION_DECIDED: 'application_decided',

  // Discovery / admin lifecycle
  SERVER_FEATURE: 'server_feature',
  SERVER_UNFEATURE: 'server_unfeature',
  SERVER_VERIFY: 'server_verify',
  SERVER_UNVERIFY: 'server_unverify',
  SERVER_HIDE: 'server_hide',
  SERVER_UNHIDE: 'server_unhide',
  SERVER_SUSPEND: 'server_suspend',
  SERVER_UNSUSPEND: 'server_unsuspend',
  SERVER_DISCOVERY_OVERRIDE_GRANT: 'server_discovery_override_grant',
  SERVER_DISCOVERY_OVERRIDE_REVOKE: 'server_discovery_override_revoke',

  // "Verified by Howl" application lifecycle
  SERVER_VERIFY_REQUEST_SUBMIT: 'server_verify_request_submit',
  SERVER_VERIFY_REQUEST_WITHDRAW: 'server_verify_request_withdraw',
  SERVER_VERIFY_REQUEST_APPROVE: 'server_verify_request_approve',
  SERVER_VERIFY_REQUEST_REJECT: 'server_verify_request_reject',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];
