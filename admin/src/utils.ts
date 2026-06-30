// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';

// Avatar colors

export const AVATAR_COLORS = [
  '#5b3a3a', '#5b3a4f', '#4a3560', '#3d2d5e',
  '#2d4a6b', '#264d5e', '#2a5450', '#24504a',
  '#35593e', '#2e5038', '#6b5630', '#5e5335',
];

export function letterAvatar(name: string, size: number) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const bg = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  const letter = (name || '?')[0].toUpperCase();
  return React.createElement('div', {
    className: 'flex items-center justify-center font-extrabold select-none shrink-0 overflow-hidden',
    style: { width: size, height: size, backgroundColor: bg, color: 'rgba(255,255,255,0.85)', fontSize: Math.round(size * 0.44), borderRadius: size > 40 ? 16 : 10 },
  }, letter);
}

// Color validation

const VALID_HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function safeColor(c: string | null | undefined, fallback = '#99aab5'): string {
  if (!c) return fallback;
  const trimmed = c.trim();
  return VALID_HEX.test(trimmed) ? trimmed : fallback;
}

// Time formatting

export function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export function formatDate(d: string): string {
  return new Date(d).toLocaleString();
}

export function formatRelative(d: string): string {
  const diff = Date.now() - new Date(d).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 604800_000) return `${Math.floor(diff / 86400_000)}d ago`;
  return new Date(d).toLocaleDateString();
}

// Plan badge

export function planBadge(plan: string | null) {
  if (!plan)
    return React.createElement('span', {
      className: 'px-2.5 py-1 text-[11px] font-bold uppercase rounded-lg border bg-slate-500/10 text-slate-500 border-slate-500/20 tracking-wide',
    }, 'Free');
  const c = plan === 'pro'
    ? 'bg-violet-500/15 text-violet-300 border-violet-500/30'
    : 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30';
  return React.createElement('span', {
    className: `px-2.5 py-1 text-[11px] font-bold uppercase rounded-lg border ${c} tracking-wide`,
  }, plan === 'pro' ? 'Pro' : 'Essential');
}

// Status dot

export function statusDot(status: string) {
  const c: Record<string, string> = {
    online: 'bg-emerald-400 shadow-emerald-400/50',
    idle: 'bg-amber-400 shadow-amber-400/50',
    dnd: 'bg-red-400 shadow-red-400/50',
    offline: 'bg-slate-500',
  };
  return React.createElement('span', {
    className: `inline-block w-2.5 h-2.5 rounded-full ${c[status] || c.offline}`,
    style: {
      boxShadow: status !== 'offline'
        ? `0 0 6px ${status === 'online' ? '#34d399' : status === 'idle' ? '#fbbf24' : '#f87171'}`
        : undefined,
    },
  });
}

// Audit log constants & helpers

export const AUDIT_ACTIONS = [
  { value: '', label: 'All Actions' },
  { value: 'reset_password', label: 'Reset Password' },
  { value: 'send_reset_email', label: 'Send Reset Email' },
  { value: 'disable_mfa', label: 'Disable MFA' },
  { value: 'grant_plan', label: 'Change Plan' },
  { value: 'change_email', label: 'Change Email' },
  { value: 'change_username', label: 'Change Username' },
  { value: 'suspend_user', label: 'Suspend User' },
  { value: 'unsuspend_user', label: 'Unsuspend User' },
  { value: 'verify_email', label: 'Verify Email' },
  { value: 'revoke_sessions', label: 'Revoke Sessions' },
  { value: 'manage_badge', label: 'Manage Badge' },
  { value: 'set_boost_tier', label: 'Set Power-up Tier' },
  { value: 'approve_data_export', label: 'Approve Export' },
  { value: 'delete_data_export', label: 'Delete Export' },
  { value: 'report_review', label: 'Review Report' },
  { value: 'flagged_hash_add', label: 'Flag Hash' },
  { value: 'flagged_hash_remove', label: 'Unflag Hash' },
  { value: 'flagged_hash_from_report', label: 'Flag Hash (Report)' },
  { value: 'create_admin_account', label: 'Create Admin' },
  { value: 'delete_admin_account', label: 'Delete Admin' },
  { value: 'reset_admin_password', label: 'Reset Admin Password' },
  { value: 'change_admin_role', label: 'Change Admin Role' },
  { value: 'lock_forum_post', label: 'Lock Forum Post' },
  { value: 'delete_forum_post', label: 'Delete Forum Post' },
  { value: 'archive_thread', label: 'Archive Thread' },
  { value: 'delete_thread', label: 'Delete Thread' },
  { value: 'close_poll', label: 'Close Poll' },
  { value: 'delete_poll', label: 'Delete Poll' },
];

export function actionLabel(action: string): string {
  const entry = AUDIT_ACTIONS.find(a => a.value === action);
  return entry?.label || action;
}

export function actionColor(action: string): string {
  const colors: Record<string, string> = {
    reset_password: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
    send_reset_email: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/25',
    disable_mfa: 'bg-red-500/15 text-red-300 border-red-500/25',
    grant_plan: 'bg-violet-500/15 text-violet-300 border-violet-500/25',
    change_email: 'bg-blue-500/15 text-blue-300 border-blue-500/25',
    change_username: 'bg-blue-500/15 text-blue-300 border-blue-500/25',
    suspend_user: 'bg-red-500/15 text-red-300 border-red-500/25',
    unsuspend_user: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
    verify_email: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
    revoke_sessions: 'bg-slate-500/15 text-slate-300 border-slate-500/25',
    manage_badge: 'bg-violet-500/15 text-violet-300 border-violet-500/25',
    set_boost_tier: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/25',
    approve_data_export: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
    delete_data_export: 'bg-red-500/15 text-red-300 border-red-500/25',
    report_review: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
    flagged_hash_add: 'bg-red-500/15 text-red-300 border-red-500/25',
    flagged_hash_remove: 'bg-slate-500/15 text-slate-300 border-slate-500/25',
    flagged_hash_from_report: 'bg-red-500/15 text-red-300 border-red-500/25',
    create_admin_account: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/25',
    delete_admin_account: 'bg-red-500/15 text-red-300 border-red-500/25',
    reset_admin_password: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
    change_admin_role: 'bg-violet-500/15 text-violet-300 border-violet-500/25',
    lock_forum_post: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
    delete_forum_post: 'bg-red-500/15 text-red-300 border-red-500/25',
    archive_thread: 'bg-slate-500/15 text-slate-300 border-slate-500/25',
    delete_thread: 'bg-red-500/15 text-red-300 border-red-500/25',
    close_poll: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
    delete_poll: 'bg-red-500/15 text-red-300 border-red-500/25',
  };
  return colors[action] || 'bg-white/5 text-slate-300 border-white/10';
}

// Password rules

export const PW_RULES = [
  { test: (p: string) => p.length >= 12, label: '12+ characters' },
  { test: (p: string) => /[A-Z]/.test(p), label: 'Uppercase letter' },
  { test: (p: string) => /[0-9]/.test(p), label: 'Number' },
  { test: (p: string) => /[^a-zA-Z0-9]/.test(p), label: 'Symbol' },
];

// Admin role badge

export const ROLE_BADGE: Record<string, { cls: string; label: string }> = {
  owner: { cls: 'bg-amber-500/20 text-amber-400 border-amber-500/30', label: 'Owner' },
  superadmin: { cls: 'bg-violet-500/20 text-violet-400 border-violet-500/30', label: 'Super Admin' },
  admin: { cls: 'bg-slate-500/20 text-slate-400 border-slate-500/30', label: 'Admin' },
};

// Temp password generator

export function generateClientTempPassword(): string {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const symbols = '!@#$%^&*-_=+';
  const all = upper + lower + digits + symbols;
  const chars: string[] = [];
  const secureRandom = (max: number) => {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return arr[0] % max;
  };
  const pick = (set: string, n: number) => { for (let i = 0; i < n; i++) chars.push(set[secureRandom(set.length)]); };
  pick(upper, 3); pick(lower, 3); pick(digits, 3); pick(symbols, 2); pick(all, 5);
  for (let i = chars.length - 1; i > 0; i--) { const j = secureRandom(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}
