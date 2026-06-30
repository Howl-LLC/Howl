// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  BarChart3,
  Layers,
  Users,
  Server,
  Link,
  Flag,
  ShieldAlert,
  MessageSquarePlus,
  MessageSquare,
  BarChart,
  FileText,
  Download,
  Lock,
  User,
  LogOut,
  Compass,
  ServerCog,
  ShieldCheck,
} from 'lucide-react';
import { adminApi, type AuthUser } from '../api';

// Nav structure

interface NavItem {
  path: string;
  label: string;
  icon: React.FC<{ size?: number; className?: string }>;
  badge?: number;
  /** Only visible for these roles */
  roles?: string[];
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

function buildNavGroups(pendingReports: number): NavGroup[] {
  return [
    {
      label: 'General',
      items: [
        { path: '/', label: 'Overview', icon: LayoutDashboard },
        { path: '/analytics', label: 'Analytics', icon: BarChart3 },
        { path: '/protocol-distribution', label: 'Protocol Distribution', icon: Layers },
      ],
    },
    {
      label: 'Management',
      items: [
        { path: '/users', label: 'Users', icon: Users },
        { path: '/servers', label: 'Servers', icon: Server },
        { path: '/invites', label: 'Invites', icon: Link },
      ],
    },
    {
      label: 'Moderation',
      items: [
        { path: '/reports', label: 'Reports', icon: Flag, badge: pendingReports > 0 ? pendingReports : undefined },
        { path: '/server-reports', label: 'Server Reports', icon: ServerCog },
        { path: '/content-safety', label: 'Content Safety', icon: ShieldAlert },
        { path: '/forums', label: 'Forums', icon: MessageSquarePlus },
        { path: '/threads', label: 'Threads', icon: MessageSquare },
        { path: '/polls', label: 'Polls', icon: BarChart },
      ],
    },
    {
      label: 'Community',
      items: [
        { path: '/discovery', label: 'Discovery Queue', icon: Compass },
        { path: '/verification-requests', label: 'Verification Requests', icon: ShieldCheck },
      ],
    },
    {
      label: 'Compliance',
      items: [
        { path: '/audit-log', label: 'Audit Log', icon: FileText },
        { path: '/data-requests', label: 'Data Requests', icon: Download },
      ],
    },
    {
      label: 'System',
      items: [
        { path: '/security', label: 'Security', icon: Lock },
        { path: '/accounts', label: 'Accounts', icon: User, roles: ['owner', 'superadmin'] },
      ],
    },
  ];
}

// Role badge styling

const ROLE_BADGE_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  owner:      { bg: 'bg-amber-500/20', text: 'text-amber-400', label: 'Owner' },
  superadmin: { bg: 'bg-violet-500/20', text: 'text-violet-400', label: 'Super Admin' },
  admin:      { bg: 'bg-slate-500/20', text: 'text-slate-400', label: 'Admin' },
};

// AdminLayout

interface AdminLayoutProps {
  user: AuthUser;
  onLogout: () => void;
}

export const AdminLayout: React.FC<AdminLayoutProps> = ({ user, onLogout }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [pendingReports, setPendingReports] = useState(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Step-up password prompt
  // Sensitive admin actions (change email, grant plan, suspend) require a
  // fresh password prove-up within the last 5 minutes — `requireAdminStepUp`
  // middleware on the backend. Pop a modal, collect the password, resolve
  // the pending admin action. Re-prompt on wrong password (up to 3 attempts
  // — enforced api-side).
  const [stepUpPromptState, setStepUpPromptState] = useState<{ resolve: (pw: string | null) => void; lastError?: string } | null>(null);
  const [stepUpPwd, setStepUpPwd] = useState('');

  useEffect(() => {
    adminApi.onStepUpRequired((lastError?: string) => new Promise<string | null>((resolve) => {
      setStepUpPwd('');
      setStepUpPromptState({ resolve, lastError });
    }));
    return () => adminApi.onStepUpRequired(async () => null);
  }, []);

  const submitStepUp = () => {
    if (!stepUpPromptState || !stepUpPwd) return;
    stepUpPromptState.resolve(stepUpPwd);
    setStepUpPromptState(null);
    setStepUpPwd('');
  };
  const cancelStepUp = () => {
    if (stepUpPromptState) stepUpPromptState.resolve(null);
    setStepUpPromptState(null);
    setStepUpPwd('');
  };

  // Fetch pending report count

  const fetchReportStats = useCallback(async () => {
    try {
      const stats = await adminApi.getReportStats();
      setPendingReports(stats.pending);
    } catch {
      // silent — badge just won't show
    }
  }, []);

  useEffect(() => {
    fetchReportStats();
    // Re-fetch every 60 seconds
    const interval = setInterval(fetchReportStats, 60_000);
    return () => clearInterval(interval);
  }, [fetchReportStats]);

  // 30-minute idle timeout

  useEffect(() => {
    const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

    const resetTimer = () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(onLogout, IDLE_TIMEOUT_MS);
    };

    const events: Array<keyof WindowEventMap> = ['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll'];
    events.forEach((e) => window.addEventListener(e, resetTimer, { passive: true }));
    resetTimer();

    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      events.forEach((e) => window.removeEventListener(e, resetTimer));
    };
  }, [onLogout]);

  // Nav active check

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  const navGroups = buildNavGroups(pendingReports);
  const roleBadge = ROLE_BADGE_STYLE[user.role || 'admin'] || ROLE_BADGE_STYLE.admin;
  const userInitial = (user.username || 'A')[0].toUpperCase();

  return (
    <div className="min-h-screen flex" style={{ background: 'linear-gradient(180deg, #060918 0%, #080d1c 100%)' }}>
      {/* Ambient orbs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
        <div
          className="absolute -top-40 -left-40 rounded-full opacity-[0.03]"
          style={{
            width: 600,
            height: 600,
            background: 'radial-gradient(circle, #076FA0 0%, transparent 70%)',
            filter: 'blur(80px)',
          }}
        />
        <div
          className="absolute top-1/3 -right-32 rounded-full opacity-[0.025]"
          style={{
            width: 500,
            height: 500,
            background: 'radial-gradient(circle, #8b5cf6 0%, transparent 70%)',
            filter: 'blur(80px)',
          }}
        />
        <div
          className="absolute -bottom-20 left-1/3 rounded-full opacity-[0.02]"
          style={{
            width: 400,
            height: 400,
            background: 'radial-gradient(circle, #14b8a6 0%, transparent 70%)',
            filter: 'blur(80px)',
          }}
        />
      </div>

      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <aside
        className="fixed top-0 left-0 bottom-0 z-40 flex flex-col border-r border-white/[0.06]"
        style={{
          width: 232,
          backgroundColor: 'rgba(2, 6, 23, 0.92)',
          backdropFilter: 'blur(20px) saturate(1.3)',
        }}
      >
        {/* Logo area */}
        <div className="px-4 pt-5 pb-4 flex items-center gap-3">
          <img
            src="/howl-logo.png"
            alt="Howl"
            className="shrink-0"
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              boxShadow: '0 0 16px rgba(7,111,160,0.2)',
            }}
          />
          <div>
            <span className="text-white font-bold text-[15px] tracking-tight">Howl Admin</span>
          </div>
        </div>

        {/* Nav groups */}
        <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-5">
          {navGroups.map((group) => {
            const visibleItems = group.items.filter(
              (item) => !item.roles || item.roles.includes(user.role || 'admin')
            );
            if (visibleItems.length === 0) return null;

            return (
              <div key={group.label}>
                <div
                  className="px-2.5 mb-2 select-none"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: '#475569',
                  }}
                >
                  {group.label}
                </div>
                <div className="space-y-0.5">
                  {visibleItems.map((item) => {
                    const active = isActive(item.path);
                    const Icon = item.icon;

                    return (
                      <button
                        key={item.path}
                        onClick={() => navigate(item.path)}
                        className="w-full flex items-center gap-2.5 transition-all duration-150"
                        style={{
                          padding: '8px 10px',
                          borderRadius: active ? '0 10px 10px 0' : '10px',
                          color: active ? '#076FA0' : 'rgba(148,163,184,0.85)',
                          fontSize: 13,
                          fontWeight: 500,
                          background: active ? 'rgba(7,111,160,0.12)' : 'transparent',
                          boxShadow: active ? 'inset 3px 0 0 #076FA0' : 'none',
                          marginLeft: active ? '-12px' : '0',
                          paddingLeft: active ? '22px' : '10px',
                        }}
                        onMouseEnter={(e) => {
                          if (!active) {
                            e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                            e.currentTarget.style.color = '#e2e8f0';
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!active) {
                            e.currentTarget.style.background = 'transparent';
                            e.currentTarget.style.color = 'rgba(148,163,184,0.85)';
                          }
                        }}
                      >
                        <Icon size={16} className="shrink-0" />
                        <span className="truncate">{item.label}</span>
                        {item.badge !== undefined && item.badge > 0 && (
                          <span
                            className="ml-auto shrink-0 flex items-center justify-center text-white font-bold"
                            style={{
                              background: '#ef4444',
                              fontSize: 10,
                              paddingLeft: 7,
                              paddingRight: 7,
                              paddingTop: 1,
                              paddingBottom: 1,
                              borderRadius: 9999,
                              minWidth: 18,
                              lineHeight: '16px',
                            }}
                          >
                            {item.badge > 99 ? '99+' : item.badge}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        {/* Footer: user + logout */}
        <div className="px-3 py-4 border-t border-white/[0.06]">
          <div className="flex items-center gap-2.5 px-2">
            {/* Initials avatar with gradient border */}
            <div
              className="shrink-0 flex items-center justify-center"
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                background: 'linear-gradient(135deg, #076FA0, #8b5cf6)',
                padding: 2,
              }}
            >
              <div
                className="w-full h-full flex items-center justify-center"
                style={{
                  borderRadius: 8,
                  background: 'rgba(2, 6, 23, 0.95)',
                }}
              >
                <span className="text-white font-bold text-xs">{userInitial}</span>
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-white text-[13px] font-semibold truncate">{user.username}</div>
              <span
                className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${roleBadge.bg} ${roleBadge.text}`}
              >
                {roleBadge.label}
              </span>
            </div>
            <button
              onClick={onLogout}
              className="p-2 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all duration-200"
              title="Sign out"
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Content area ────────────────────────────────────────────────────── */}
      <main
        className="flex-1 overflow-y-auto"
        style={{ marginLeft: 232 }}
      >
        <div className="p-6 lg:p-8">
          <Outlet />
        </div>
      </main>

      {/* ── Step-up password prompt ──────────────────────────────────────────── */}
      {stepUpPromptState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-[380px] rounded-xl border border-white/10 bg-[#0b1120] p-6 shadow-2xl">
            <h2 className="text-base font-semibold text-white mb-1">Confirm your password</h2>
            <p className="text-xs text-slate-400 mb-4">
              This action requires you to re-enter your admin password. Your approval lasts 5 minutes.
            </p>
            <input
              type="password"
              autoFocus
              value={stepUpPwd}
              onChange={(e) => setStepUpPwd(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitStepUp(); if (e.key === 'Escape') cancelStepUp(); }}
              placeholder="Admin password"
              className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white outline-none focus:border-cyan-400/60 mb-3"
            />
            {stepUpPromptState.lastError && <p className="text-xs text-red-400 mb-3">{stepUpPromptState.lastError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={cancelStepUp}
                className="px-4 py-2 rounded-lg text-xs font-medium text-slate-300 hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitStepUp}
                disabled={!stepUpPwd}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-cyan-500 text-[#020617] hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
