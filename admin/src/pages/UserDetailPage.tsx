// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ChevronLeft, ChevronRight, Check, AlertTriangle, X,
  Shield, Crown, Server, Hash, ShieldCheck, ShieldOff,
  LogOut, Key, Mail, Smartphone, UserX, UserCheck,
  BarChart3, FileText, Copy, Zap, RefreshCw,
  Star, Bug, Heart, CheckCircle, Users, Scale, AppWindow, Sparkles,
} from 'lucide-react';
import {
  adminApi,
  type AdminUserDetail,
  type AdminAuditEntry,
  type BillingHistory,
} from '../api';
import { INPUT_CLS, BTN_PRIMARY, BTN_GHOST, CARD, SELECT_CLS } from '../components/styles';
import { ConfirmModal, AdminAvatar } from '../components';
import {
  formatDate, formatRelative, planBadge, statusDot,
  actionLabel, actionColor,
} from '../utils';

interface ConfirmModalState {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  danger?: boolean;
}

const UserDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [selectedUser, setSelectedUser] = useState<AdminUserDetail | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);

  // Billing
  const [billingHistory, setBillingHistory] = useState<BillingHistory | null>(null);
  const [billingLoading, setBillingLoading] = useState(false);
  const [adminRefundTarget, setAdminRefundTarget] = useState<{ chargeId: string; amount: number; currency: string } | null>(null);
  const [adminRefundType, setAdminRefundType] = useState<'subscription' | 'gift' | 'power_up'>('subscription');
  const [adminRefundOverride, setAdminRefundOverride] = useState(false);
  const [adminRefundOverrideReason, setAdminRefundOverrideReason] = useState('');
  const [adminRefundReason, setAdminRefundReason] = useState('');
  const [adminRefundLoading, setAdminRefundLoading] = useState(false);
  const [adminRefundError, setAdminRefundError] = useState<string | null>(null);

  // Per-user audit log
  const [userAuditEntries, setUserAuditEntries] = useState<AdminAuditEntry[]>([]);
  const [userAuditPage, setUserAuditPage] = useState(1);
  const [userAuditPages, setUserAuditPages] = useState(1);
  const [userAuditTotal, setUserAuditTotal] = useState(0);

  // Shared UI state
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);

  // Badge management
  const [badgeToManage, setBadgeToManage] = useState('beta');
  const [badgeLoading, setBadgeLoading] = useState(false);

  // Edit forms
  const [editEmail, setEditEmail] = useState('');
  const [editUsername, setEditUsername] = useState('');
  const [editDiscriminator, setEditDiscriminator] = useState('');
  const [editPlan, setEditPlan] = useState<string>('none');
  const [editPlanDuration, setEditPlanDuration] = useState<number>(0);

  useEffect(() => {
    if (!tempPassword) return;
    const timer = setTimeout(() => setTempPassword(null), 30_000);
    return () => clearTimeout(timer);
  }, [tempPassword]);

  const loadUserAudit = useCallback(async (userId: string, page: number) => {
    try {
      const data = await adminApi.getUserAuditLog(userId, page);
      setUserAuditEntries(data.entries);
      setUserAuditPage(data.page);
      setUserAuditPages(data.pages);
      setUserAuditTotal(data.total);
    } catch { /* ignore */ }
  }, []);

  const selectUser = useCallback(async (userId: string) => {
    setLoadingUser(true);
    setSelectedUser(null);
    setBillingHistory(null);
    setTempPassword(null);
    setActionResult(null);
    try {
      const u = await adminApi.getUser(userId);
      setSelectedUser(u);
      setEditEmail(u.email);
      setEditUsername(u.username);
      setEditDiscriminator(u.discriminator);
      setEditPlan(u.stripePlan || 'none');
    } catch {
      setActionResult({ type: 'error', message: 'Failed to load user' });
    }
    setLoadingUser(false);
  }, []);

  const refreshUser = async (userId: string) => {
    try {
      const u = await adminApi.getUser(userId);
      setSelectedUser(u);
      setEditEmail(u.email);
      setEditUsername(u.username);
      setEditDiscriminator(u.discriminator);
      setEditPlan(u.stripePlan || 'none');
    } catch { /* keep existing state */ }
  };

  useEffect(() => { if (id) selectUser(id); }, [id, selectUser]);
  useEffect(() => { if (selectedUser) { setUserAuditPage(1); loadUserAudit(selectedUser.id, 1); } }, [selectedUser?.id, loadUserAudit]);

  const runAction = async (name: string, fn: () => Promise<void>) => {
    setActionLoading(name);
    setActionResult(null);
    try {
      await fn();
      setActionResult({ type: 'success', message: `${name} completed` });
      if (selectedUser) refreshUser(selectedUser.id);
    } catch (e: any) {
      setActionResult({ type: 'error', message: e?.message || `${name} failed` });
    }
    setActionLoading(null);
  };

  const copyToClipboard = (text: string) => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  if (loadingUser) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-500 text-sm">
        <RefreshCw size={16} className="animate-spin mr-2" /> Loading user...
      </div>
    );
  }

  if (!selectedUser) {
    return (
      <div className="text-center py-20">
        {actionResult && (
          <div className={`mb-5 px-5 py-3.5 rounded-xl border text-sm flex items-center gap-2.5 ${actionResult.type === 'error' ? 'bg-red-500/10 border-red-500/25 text-red-300' : ''}`}>
            <AlertTriangle size={16} /> {actionResult.message}
          </div>
        )}
        <button onClick={() => navigate('/users')} className="text-sm text-slate-400 hover:text-white flex items-center gap-2 mx-auto">
          <ChevronLeft size={16} /> Back to users
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '64rem', margin: '0 auto' }}>
      <button onClick={() => navigate('/users')}
        className="flex items-center gap-2 text-sm text-slate-400 hover:text-white mb-5 -ml-1 transition-colors"><ChevronLeft size={16} /> Back to users</button>

      {actionResult && (
        <div className={`mb-5 px-5 py-3.5 rounded-xl border text-sm flex items-center gap-2.5 ${actionResult.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300' : 'bg-red-500/10 border-red-500/25 text-red-300'}`}>
          {actionResult.type === 'success' ? <Check size={16} /> : <AlertTriangle size={16} />} {actionResult.message}
          <button onClick={() => setActionResult(null)} className="ml-auto opacity-60 hover:opacity-100 transition-opacity"><X size={14} /></button>
        </div>
      )}

      {tempPassword && (
        <div className="mb-5 px-5 py-4 rounded-xl border bg-amber-500/10 border-amber-500/25 text-amber-200 text-sm">
          <div className="font-semibold mb-2">Temporary Password Generated</div>
          <div className="flex items-center gap-2">
            <code className="bg-black/30 px-4 py-1.5 rounded-lg font-mono text-white text-sm">{tempPassword}</code>
            <button onClick={() => copyToClipboard(tempPassword)} className="p-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors">
              {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
            </button>
          </div>
          <div className="text-xs text-amber-400/60 mt-2">Share this securely. All sessions have been revoked.</div>
        </div>
      )}

      {/* Header card */}
      <div className={`${CARD} p-6 mb-5`}>
        <div className="flex items-start gap-5">
          <div className="shrink-0"><AdminAvatar src={selectedUser.avatar} name={selectedUser.username} size={72} /></div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-2xl font-bold text-white tracking-tight">{selectedUser.username}<span className="text-slate-500 font-normal">#{selectedUser.discriminator}</span></h2>
              {selectedUser.suspended && <span className="px-2.5 py-1 rounded-lg bg-red-500/15 text-red-400 text-[10px] font-bold uppercase tracking-wider border border-red-500/20">Suspended</span>}
              {planBadge(selectedUser.stripePlan)}
              <div className="flex items-center gap-2">{statusDot(selectedUser.status)}<span className="text-xs text-slate-400 capitalize">{selectedUser.status}</span></div>
            </div>
            <div className="mt-2 text-sm text-slate-400">{selectedUser.email}</div>
            <div className="mt-2 flex items-center gap-5 text-xs text-slate-500 flex-wrap">
              <span>ID: <code className="bg-white/5 px-2 py-0.5 rounded-md font-mono text-slate-400">{selectedUser.id}</code></span>
              <span>Joined {formatDate(selectedUser.createdAt)}</span>
              <span>DOB: {selectedUser.dateOfBirth ? (
                <>
                  <span className="text-slate-400">{new Date(selectedUser.dateOfBirth).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</span>
                  {' '}
                  <span className="text-slate-500">({Math.floor((Date.now() - new Date(selectedUser.dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000))} yrs)</span>
                </>
              ) : <span className="text-slate-600">Not set</span>}</span>
              <span>{selectedUser.emailVerified ? <span className="text-emerald-400 flex items-center gap-1"><ShieldCheck size={12} /> Verified</span> : <span className="text-amber-400 flex items-center gap-1"><AlertTriangle size={12} /> Unverified</span>}</span>
            </div>
          </div>
        </div>
      </div>

      {selectedUser.suspended && (
        <div className="mb-5 px-5 py-4 rounded-xl bg-red-500/10 border border-red-500/20 flex items-start gap-3">
          <AlertTriangle size={18} className="text-red-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold text-red-300">This account is suspended</p>
            {selectedUser.suspendedAt && <p className="text-xs text-red-400/70 mt-1">Suspended on {new Date(selectedUser.suspendedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>}
            {selectedUser.suspendReason && <p className="text-xs text-slate-400 mt-1">Reason: {selectedUser.suspendReason}</p>}
          </div>
        </div>
      )}

      {/* Info grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
        <div className={`${CARD} p-5`}>
          <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2.5"><div className="w-7 h-7 rounded-lg bg-amber-500/15 flex items-center justify-center"><Shield size={14} className="text-amber-400" /></div> Security</h3>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between items-center"><span className="text-slate-400">MFA</span><span className={`font-medium ${selectedUser.mfaEnabled ? 'text-emerald-400' : 'text-slate-500'}`}>{selectedUser.mfaEnabled ? 'Enabled' : 'Disabled'}</span></div>
            {selectedUser.hasMfaTotp && <div className="flex justify-between items-center"><span className="text-slate-400">TOTP</span><span className="text-emerald-400 font-medium">Configured</span></div>}
            {selectedUser.hasMfaPhone && <div className="flex justify-between items-center"><span className="text-slate-400">Phone</span><span className="text-emerald-400 font-medium">***{selectedUser.phoneLast4}</span></div>}
            <div>
              <div className="flex justify-between items-center"><span className="text-slate-400">SSO Accounts</span><span className="text-slate-300">{selectedUser.ssoAccounts?.length || 0}</span></div>
              {selectedUser.ssoAccounts && selectedUser.ssoAccounts.length > 0 && (
                <div className="mt-2 space-y-1.5 pl-1">
                  {selectedUser.ssoAccounts.map((sso) => (
                    <div key={sso.id} className="flex items-center gap-2 py-1 px-2.5 rounded-lg bg-white/[0.03]">
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                        sso.provider === 'google' ? 'bg-blue-500/15 text-blue-400' :
                        sso.provider === 'apple' ? 'bg-slate-500/15 text-slate-300' :
                        sso.provider === 'steam' ? 'bg-slate-600/15 text-slate-400' :
                        'bg-white/10 text-slate-400'
                      }`}>{sso.provider}</span>
                      <span className="text-xs text-slate-400 truncate">{sso.email || 'No email'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-between items-center"><span className="text-slate-400">Active Sessions</span><span className="text-slate-300">{selectedUser.sessions?.length || 0}</span></div>
          </div>
        </div>
        <div className={`${CARD} p-5`}>
          <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2.5"><div className="w-7 h-7 rounded-lg bg-violet-500/15 flex items-center justify-center"><Crown size={14} className="text-violet-400" /></div> Subscription</h3>
          {(() => {
            const hasStripe = !!selectedUser.stripeSubscriptionId;
            const hasAnyPlan = !!selectedUser.stripePlan;
            const isAdminGranted = selectedUser.stripeStatus === 'admin_granted';
            const periodEnd = selectedUser.stripePeriodEnd ? new Date(selectedUser.stripePeriodEnd) : null;
            const now = new Date();
            const daysUntilBilling = periodEnd ? Math.max(0, Math.ceil((periodEnd.getTime() - now.getTime()) / 86_400_000)) : null;
            const isPastDue = periodEnd ? periodEnd.getTime() < now.getTime() : false;
            const tierLabel = selectedUser.stripePlan === 'pro' ? 'Howl Pro' : selectedUser.stripePlan === 'essential' ? 'Howl Essential' : null;

            return (
              <div className="space-y-3 text-sm">
                <div className="flex justify-between items-center">
                  <span className="text-slate-400">Active Subscription</span>
                  <span className={`font-semibold ${hasStripe ? 'text-emerald-400' : isAdminGranted ? 'text-violet-400' : hasAnyPlan ? 'text-amber-400' : 'text-slate-500'}`}>
                    {hasStripe ? 'Yes (Stripe)' : isAdminGranted ? 'Yes (Admin Granted)' : hasAnyPlan ? 'Yes (No Stripe)' : 'No'}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-400">Plan Tier</span>
                  {tierLabel ? <span className="font-semibold text-white">{tierLabel}</span> : <span className="text-slate-500">Free</span>}
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-400">Stripe Status</span>
                  <span className={`font-medium capitalize ${selectedUser.stripeStatus === 'active' ? 'text-emerald-400' : selectedUser.stripeStatus === 'admin_granted' ? 'text-violet-400' : selectedUser.stripeStatus === 'past_due' ? 'text-red-400' : selectedUser.stripeStatus === 'trialing' ? 'text-cyan-400' : 'text-slate-500'}`}>
                    {selectedUser.stripeStatus === 'admin_granted' ? 'Admin Granted' : selectedUser.stripeStatus || 'None'}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-400">Stripe Subscription</span>
                  <span className={`font-medium ${hasStripe ? 'text-amber-400' : 'text-slate-500'}`}>{hasStripe ? 'Active' : 'None'}</span>
                </div>
                {hasAnyPlan && (
                  <div className="flex justify-between items-center">
                    <span className="text-slate-400">Next Billing Date</span>
                    {periodEnd
                      ? <span className={`font-medium ${isPastDue ? 'text-red-400' : 'text-slate-300'}`}>{periodEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                      : <span className="text-violet-400 font-medium">Permanent</span>
                    }
                  </div>
                )}
                {hasAnyPlan && daysUntilBilling !== null && (
                  <div className="flex justify-between items-center">
                    <span className="text-slate-400">Days Until Billing</span>
                    <span className={`font-bold text-base tabular-nums ${isPastDue ? 'text-red-400' : daysUntilBilling <= 3 ? 'text-amber-400' : 'text-emerald-400'}`}>
                      {isPastDue ? 'Past due' : daysUntilBilling === 0 ? 'Today' : `${daysUntilBilling} day${daysUntilBilling !== 1 ? 's' : ''}`}
                    </span>
                  </div>
                )}
                {selectedUser.stripeCustomerId && (
                  <div className="flex justify-between items-center pt-2 border-t border-white/[0.06]">
                    <span className="text-slate-400">Stripe Customer</span>
                    <span className="text-slate-500 text-xs font-mono">{selectedUser.stripeCustomerId}</span>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
        <div className={`${CARD} p-5`}>
          <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2.5"><div className="w-7 h-7 rounded-lg bg-indigo-500/15 flex items-center justify-center"><Server size={14} className="text-indigo-400" /></div> Servers ({selectedUser.serverMembers?.length || 0})</h3>
          <div className="space-y-2 text-sm max-h-36 overflow-y-auto pr-1">
            {selectedUser.serverMembers?.map((sm) => (
              <div key={sm.serverId} className="flex justify-between items-center py-1">
                <span className="text-slate-300 truncate">{sm.server.name}</span>
                <span className="text-xs text-slate-500 capitalize ml-2 shrink-0">{sm.role}</span>
              </div>
            ))}
            {(!selectedUser.serverMembers || selectedUser.serverMembers.length === 0) && <div className="text-slate-500 py-2">No servers</div>}
          </div>
        </div>
        <div className={`${CARD} p-5`}>
          <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2.5"><div className="w-7 h-7 rounded-lg bg-cyan-500/15 flex items-center justify-center"><Smartphone size={14} className="text-cyan-400" /></div> Recent Sessions</h3>
          <div className="space-y-2 text-sm max-h-36 overflow-y-auto pr-1">
            {selectedUser.sessions?.map((s) => (
              <div key={s.id} className="flex justify-between items-center py-1">
                <span className="text-slate-300 truncate">{s.deviceName} ({s.os})</span>
                <span className="text-xs text-slate-500 ml-2 shrink-0">{formatRelative(s.lastActiveAt)}</span>
              </div>
            ))}
            {(!selectedUser.sessions || selectedUser.sessions.length === 0) && <div className="text-slate-500 py-2">No sessions</div>}
          </div>
        </div>
      </div>

      {/* Billing & Purchase History */}
      <div className={`${CARD} p-5 mb-5`}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold text-white flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/15 flex items-center justify-center"><BarChart3 size={14} className="text-emerald-400" /></div>
            Billing & Purchase History
          </h3>
          {!billingHistory && (
            <button
              onClick={async () => {
                setBillingLoading(true);
                try {
                  const data = await adminApi.getBillingHistory(selectedUser.id);
                  setBillingHistory(data);
                } catch { /* ignore */ }
                setBillingLoading(false);
              }}
              disabled={billingLoading}
              className={`${BTN_PRIMARY} text-xs !py-1.5 !px-3`}
            >
              {billingLoading ? 'Loading...' : 'Load History'}
            </button>
          )}
        </div>

        {!billingHistory ? (
          <p className="text-xs text-slate-500">Click &quot;Load History&quot; to fetch billing data from Stripe and local records.</p>
        ) : (
          <div className="space-y-5">
            {/* Stripe Charges */}
            <div>
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                Stripe Charges ({billingHistory.stripeCharges.length})
                {billingHistory.stripeCustomerId && <span className="ml-2 font-mono text-slate-600 normal-case">{billingHistory.stripeCustomerId}</span>}
              </h4>
              {billingHistory.stripeCharges.length === 0 ? (
                <p className="text-xs text-slate-600">No charges found</p>
              ) : (
                <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                  {billingHistory.stripeCharges.map((c) => (
                    <div key={c.id} className="flex items-center gap-3 py-1.5 px-3 rounded-lg bg-white/[0.02] text-xs">
                      <span className="text-slate-500 shrink-0 w-24">{new Date(c.created * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                      <span className={`font-semibold tabular-nums shrink-0 w-20 ${c.refunded ? 'text-red-400 line-through' : 'text-emerald-400'}`}>
                        ${(c.amount / 100).toFixed(2)} {c.currency.toUpperCase()}
                      </span>
                      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                        c.status === 'succeeded' ? 'bg-emerald-500/15 text-emerald-400' :
                        c.status === 'failed' ? 'bg-red-500/15 text-red-400' :
                        c.status === 'pending' ? 'bg-amber-500/15 text-amber-400' :
                        'bg-slate-500/15 text-slate-400'
                      }`}>{c.refunded ? 'Refunded' : c.status}</span>
                      <span className="text-slate-500 truncate flex-1">{c.description || 'Subscription charge'}</span>
                      <span className="text-slate-600 font-mono shrink-0">{c.id.slice(0, 16)}...</span>
                      {!c.refunded && (
                        <button
                          onClick={() => {
                            setAdminRefundTarget({ chargeId: c.id, amount: c.amount, currency: c.currency });
                            setAdminRefundType('subscription');
                            setAdminRefundOverride(false);
                            setAdminRefundOverrideReason('');
                            setAdminRefundReason('');
                          }}
                          className="shrink-0 px-2 py-1 rounded text-[10px] font-bold bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
                        >
                          Refund
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
              {adminRefundTarget && (
                <div className="mt-3 p-4 rounded-xl bg-red-500/5 border border-red-500/20">
                  <h5 className="text-xs font-bold text-red-400 mb-3">
                    Refund Charge: {adminRefundTarget.chargeId.slice(0, 20)}... — ${(adminRefundTarget.amount / 100).toFixed(2)} {adminRefundTarget.currency.toUpperCase()}
                  </h5>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="text-[10px] text-slate-500 block mb-1">Type</label>
                      <select value={adminRefundType} onChange={(e) => setAdminRefundType(e.target.value as any)}
                        className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-white">
                        <option value="subscription">Subscription</option>
                        <option value="gift">Gift</option>
                        <option value="power_up">Power-Up</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 block mb-1">Reason (optional)</label>
                      <input value={adminRefundReason} onChange={(e) => setAdminRefundReason(e.target.value)} maxLength={500}
                        className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-white" placeholder="Customer request..." />
                    </div>
                  </div>
                  <div className="flex items-center gap-3 mb-3">
                    <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                      <input type="checkbox" checked={adminRefundOverride} onChange={(e) => setAdminRefundOverride(e.target.checked)}
                        className="rounded bg-slate-800 border-slate-600" />
                      Override limits (bypass 5-day window + one-per-category)
                    </label>
                  </div>
                  {adminRefundOverride && (
                    <div className="mb-3">
                      <label className="text-[10px] text-slate-500 block mb-1">Override reason (required)</label>
                      <input value={adminRefundOverrideReason} onChange={(e) => setAdminRefundOverrideReason(e.target.value)} maxLength={500}
                        className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-white" placeholder="e.g. Customer locked out of account, billing error..." />
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button onClick={() => { setAdminRefundTarget(null); setAdminRefundError(null); }}
                      className="px-3 py-1.5 rounded text-xs bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors">
                      Cancel
                    </button>
                    <button
                      onClick={async () => {
                        if (adminRefundOverride && !adminRefundOverrideReason.trim()) return;
                        setAdminRefundLoading(true);
                        setAdminRefundError(null);
                        try {
                          await adminApi.refundCharge(selectedUser!.id, {
                            chargeId: adminRefundTarget.chargeId,
                            type: adminRefundType,
                            override: adminRefundOverride || undefined,
                            overrideReason: adminRefundOverride ? adminRefundOverrideReason : undefined,
                            reason: adminRefundReason || undefined,
                          });
                          const data = await adminApi.getBillingHistory(selectedUser!.id);
                          setBillingHistory(data);
                          setAdminRefundTarget(null);
                        } catch (err: any) {
                          setAdminRefundError(err?.message || 'Unknown error');
                        }
                        setAdminRefundLoading(false);
                      }}
                      disabled={adminRefundLoading || (adminRefundOverride && !adminRefundOverrideReason.trim())}
                      className="px-3 py-1.5 rounded text-xs font-bold bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors disabled:opacity-40"
                    >
                      {adminRefundLoading ? 'Processing...' : 'Issue Refund'}
                    </button>
                  </div>
                  {adminRefundError && (
                    <div className="mt-3 px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-xs flex items-center gap-2">
                      <AlertTriangle size={13} className="shrink-0" />
                      <span>Refund failed: {adminRefundError}</span>
                    </div>
                  )}
                </div>
              )}

            {/* Gifts Sent */}
            <div>
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Gifts Sent ({billingHistory.giftsSent.length})</h4>
              {billingHistory.giftsSent.length === 0 ? (
                <p className="text-xs text-slate-600">No gifts sent</p>
              ) : (
                <div className="space-y-1 max-h-36 overflow-y-auto pr-1">
                  {billingHistory.giftsSent.map((g) => (
                    <div key={g.id} className="flex items-center gap-3 py-1.5 px-3 rounded-lg bg-white/[0.02] text-xs">
                      <span className="text-slate-500 shrink-0 w-24">{new Date(g.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                      <span className="font-semibold text-violet-400 shrink-0">{g.plan === 'pro' ? 'Pro' : 'Essential'} ({g.durationMonths}mo)</span>
                      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                        g.status === 'redeemed' ? 'bg-emerald-500/15 text-emerald-400' :
                        g.status === 'pending' ? 'bg-amber-500/15 text-amber-400' :
                        'bg-red-500/15 text-red-400'
                      }`}>{g.status}</span>
                      <span className="text-slate-500 truncate flex-1">{'\u2192'} {g.recipient ? `${g.recipient.username}#${g.recipient.discriminator}` : g.recipientUsername || 'Unclaimed'}</span>
                      <code className="text-slate-600 font-mono shrink-0">{g.code}</code>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Gifts Received */}
            <div>
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Gifts Received ({billingHistory.giftsReceived.length})</h4>
              {billingHistory.giftsReceived.length === 0 ? (
                <p className="text-xs text-slate-600">No gifts received</p>
              ) : (
                <div className="space-y-1 max-h-36 overflow-y-auto pr-1">
                  {billingHistory.giftsReceived.map((g) => (
                    <div key={g.id} className="flex items-center gap-3 py-1.5 px-3 rounded-lg bg-white/[0.02] text-xs">
                      <span className="text-slate-500 shrink-0 w-24">{new Date(g.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                      <span className="font-semibold text-violet-400 shrink-0">{g.plan === 'pro' ? 'Pro' : 'Essential'} ({g.durationMonths}mo)</span>
                      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                        g.status === 'redeemed' ? 'bg-emerald-500/15 text-emerald-400' :
                        g.status === 'pending' ? 'bg-amber-500/15 text-amber-400' :
                        'bg-red-500/15 text-red-400'
                      }`}>{g.status}</span>
                      <span className="text-slate-500 truncate flex-1">{'\u2190'} {g.sender ? `${g.sender.username}#${g.sender.discriminator}` : 'Unknown'}</span>
                      <code className="text-slate-600 font-mono shrink-0">{g.code}</code>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Trial Attempts */}
            {billingHistory.trialAttempts.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Trial Attempts ({billingHistory.trialAttempts.length})</h4>
                <div className="space-y-1 max-h-36 overflow-y-auto pr-1">
                  {billingHistory.trialAttempts.map((tr) => (
                    <div key={tr.id} className="flex items-center gap-3 py-1.5 px-3 rounded-lg bg-white/[0.02] text-xs">
                      <span className="text-slate-500 shrink-0 w-24">{new Date(tr.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                      <span className="font-semibold text-cyan-400 shrink-0">{tr.plan === 'pro' ? 'Pro' : 'Essential'} trial</span>
                      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                        tr.trialResult === 'started' ? 'bg-emerald-500/15 text-emerald-400' :
                        tr.trialResult === 'card_ineligible' ? 'bg-red-500/15 text-red-400' :
                        tr.status === 'pending' ? 'bg-amber-500/15 text-amber-400' :
                        'bg-slate-500/15 text-slate-400'
                      }`}>{tr.trialResult || tr.status}</span>
                      {tr.fingerprint && <span className="text-slate-600 font-mono">FP: {tr.fingerprint.slice(0, 8)}...</span>}
                      {tr.resultMessage && <span className="text-slate-500 truncate flex-1">{tr.resultMessage}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── 1. Identity Card ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
        <div className={`${CARD} p-5`}>
          <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2.5"><div className="w-7 h-7 rounded-lg bg-slate-500/15 flex items-center justify-center"><Shield size={14} className="text-slate-400" /></div> Identity</h3>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Platform Role</span>
              <span className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider border ${
                selectedUser.role === 'ADMIN' ? 'bg-red-500/15 text-red-400 border-red-500/20' :
                selectedUser.role === 'MODERATOR' ? 'bg-amber-500/15 text-amber-400 border-amber-500/20' :
                'bg-slate-500/15 text-slate-400 border-slate-500/20'
              }`}>{selectedUser.role}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Onboarding</span>
              <span className={`font-medium ${selectedUser.needsOnboarding ? 'text-amber-400' : 'text-emerald-400'}`}>
                {selectedUser.needsOnboarding ? 'Incomplete' : 'Complete'}
              </span>
            </div>
          </div>
          {selectedUser.deactivated && (
            <div className="mt-4 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-2.5">
              <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-bold text-amber-300">Account deactivated</p>
                {selectedUser.deactivatedAt && <p className="text-[11px] text-amber-400/70 mt-0.5">on {new Date(selectedUser.deactivatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</p>}
              </div>
            </div>
          )}
        </div>

      {/* ── 2. Badges Card ──────────────────────────────────────────────── */}
        <div className={`${CARD} p-5`}>
          <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2.5"><div className="w-7 h-7 rounded-lg bg-pink-500/15 flex items-center justify-center"><Sparkles size={14} className="text-pink-400" /></div> Badges</h3>
          {selectedUser.computedBadges && selectedUser.computedBadges.length > 0 ? (
            <div className="flex flex-wrap gap-2 mb-4">
              {selectedUser.computedBadges.map((badge) => {
                const cfg: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
                  pro: { label: 'Howl Pro', cls: 'bg-gradient-to-r from-cyan-500/20 to-blue-500/20 text-cyan-300 border-cyan-500/30', icon: <Crown size={12} /> },
                  pro_essential: { label: 'Essential', cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25', icon: <Zap size={12} /> },
                  beta: { label: 'Beta', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/25', icon: <Shield size={12} /> },
                  staff: { label: 'Staff', cls: 'bg-violet-500/15 text-violet-400 border-violet-500/25', icon: <Shield size={12} /> },
                  bug_hunter: { label: 'Bug Hunter', cls: 'bg-green-500/15 text-green-400 border-green-500/25', icon: <Bug size={12} /> },
                  early_supporter: { label: 'Early Supporter', cls: 'bg-gradient-to-r from-pink-500/20 to-rose-500/20 text-pink-300 border-pink-500/30', icon: <Heart size={12} /> },
                  verified: { label: 'Verified', cls: 'bg-blue-500/15 text-blue-400 border-blue-500/25', icon: <CheckCircle size={12} /> },
                };
                const c = cfg[badge] || { label: badge, cls: 'bg-slate-500/15 text-slate-400 border-slate-500/25', icon: <Star size={12} /> };
                return (
                  <span key={badge} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border ${c.cls}`}>
                    {c.icon} {c.label}
                  </span>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-slate-500 mb-4">No badges</p>
          )}
          <div className="pt-3 border-t border-white/[0.06]">
            <label className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider block mb-2">Manage Badges</label>
            <div className="flex gap-2 items-center">
              <select value={badgeToManage} onChange={(e) => setBadgeToManage(e.target.value)}
                className={`flex-1 ${SELECT_CLS} text-xs !py-1.5`}>
                <option value="beta">Beta</option>
                <option value="staff">Staff</option>
                <option value="bug_hunter">Bug Hunter</option>
                <option value="early_supporter">Early Supporter</option>
                <option value="verified">Verified</option>
              </select>
              <button
                disabled={badgeLoading}
                onClick={async () => {
                  setBadgeLoading(true);
                  try {
                    await adminApi.manageBadge(selectedUser.id, 'add', badgeToManage);
                    await refreshUser(selectedUser.id);
                    setActionResult({ type: 'success', message: `Badge "${badgeToManage}" granted` });
                  } catch (e: any) { setActionResult({ type: 'error', message: e?.message || 'Failed to grant badge' }); }
                  setBadgeLoading(false);
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/25 disabled:opacity-30 transition-all"
              >Grant</button>
              <button
                disabled={badgeLoading}
                onClick={async () => {
                  setBadgeLoading(true);
                  try {
                    await adminApi.manageBadge(selectedUser.id, 'remove', badgeToManage);
                    await refreshUser(selectedUser.id);
                    setActionResult({ type: 'success', message: `Badge "${badgeToManage}" revoked` });
                  } catch (e: any) { setActionResult({ type: 'error', message: e?.message || 'Failed to revoke badge' }); }
                  setBadgeLoading(false);
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/15 text-red-400 border border-red-500/25 hover:bg-red-500/25 disabled:opacity-30 transition-all"
              >Revoke</button>
            </div>
          </div>
        </div>
      </div>

      {/* ── 3. Legal Compliance Card ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
        <div className={`${CARD} p-5`}>
          <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2.5"><div className="w-7 h-7 rounded-lg bg-blue-500/15 flex items-center justify-center"><Scale size={14} className="text-blue-400" /></div> Legal Compliance</h3>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-slate-400">ToS Accepted</span>
              {selectedUser.tosAcceptedAt
                ? <span className="text-slate-300 font-medium">{new Date(selectedUser.tosAcceptedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                : <span className="text-amber-400 font-medium">Not accepted</span>
              }
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Privacy Policy Accepted</span>
              {selectedUser.privacyPolicyAcceptedAt
                ? <span className="text-slate-300 font-medium">{new Date(selectedUser.privacyPolicyAcceptedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                : <span className="text-amber-400 font-medium">Not accepted</span>
              }
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Consent Version</span>
              <span className={`font-medium ${selectedUser.legalConsentVersion ? 'text-slate-300' : 'text-slate-500'}`}>{selectedUser.legalConsentVersion || 'N/A'}</span>
            </div>
          </div>
        </div>

      {/* ── 4. Connected Apps Card ─────────────────────────────────────── */}
        <div className={`${CARD} p-5`}>
          <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2.5"><div className="w-7 h-7 rounded-lg bg-orange-500/15 flex items-center justify-center"><AppWindow size={14} className="text-orange-400" /></div> Connected Apps</h3>
          {selectedUser.connectedApps && selectedUser.connectedApps.length > 0 ? (
            <div className="space-y-2 text-sm">
              {selectedUser.connectedApps.map((app) => {
                const dotColor: Record<string, string> = {
                  spotify: 'bg-green-400', twitch: 'bg-violet-400', youtube: 'bg-red-400',
                  github: 'bg-slate-400', reddit: 'bg-orange-400',
                };
                return (
                  <div key={app.id} className="flex items-center gap-3 py-1.5 px-3 rounded-lg bg-white/[0.02]">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor[app.provider.toLowerCase()] || 'bg-slate-500'}`} />
                    <span className="text-slate-300 font-medium capitalize">{app.provider}</span>
                    <span className="text-xs text-slate-500 ml-auto shrink-0">{new Date(app.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-slate-500">No connected apps</p>
          )}
        </div>
      </div>

      {/* ── 5. Family Safety Card ──────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
        <div className={`${CARD} p-5`}>
          <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2.5"><div className="w-7 h-7 rounded-lg bg-teal-500/15 flex items-center justify-center"><Users size={14} className="text-teal-400" /></div> Family Safety</h3>
          {(selectedUser.familyLinksAsParent?.length > 0 || selectedUser.familyLinksAsChild?.length > 0) ? (
            <div className="space-y-3 text-sm">
              {selectedUser.familyLinksAsParent?.map((link) => (
                <div key={link.id} className="flex items-center gap-3 py-1.5 px-3 rounded-lg bg-white/[0.02]">
                  <span className="text-slate-400 text-xs shrink-0">Parent of</span>
                  <div className="flex items-center gap-2 min-w-0">
                    <AdminAvatar src={link.child.avatar} name={link.child.username} size={20} rounded={9999} />
                    <span className="text-slate-300 truncate">{link.child.username}<span className="text-slate-500">#{link.child.discriminator}</span></span>
                  </div>
                  <span className={`ml-auto shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                    link.status === 'active' ? 'bg-emerald-500/15 text-emerald-400' :
                    link.status === 'pending' ? 'bg-amber-500/15 text-amber-400' :
                    'bg-slate-500/15 text-slate-400'
                  }`}>{link.status}</span>
                </div>
              ))}
              {selectedUser.familyLinksAsChild?.map((link) => (
                <div key={link.id} className="flex items-center gap-3 py-1.5 px-3 rounded-lg bg-white/[0.02]">
                  <span className="text-slate-400 text-xs shrink-0">Child of</span>
                  <div className="flex items-center gap-2 min-w-0">
                    <AdminAvatar src={link.parent.avatar} name={link.parent.username} size={20} rounded={9999} />
                    <span className="text-slate-300 truncate">{link.parent.username}<span className="text-slate-500">#{link.parent.discriminator}</span></span>
                  </div>
                  <span className={`ml-auto shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                    link.status === 'active' ? 'bg-emerald-500/15 text-emerald-400' :
                    link.status === 'pending' ? 'bg-amber-500/15 text-amber-400' :
                    'bg-slate-500/15 text-slate-400'
                  }`}>{link.status}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500">No family links</p>
          )}
        </div>

      {/* ── 6. Power-ups Card ──────────────────────────────────────────── */}
        <div className={`${CARD} p-5`}>
          <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2.5"><div className="w-7 h-7 rounded-lg bg-violet-500/15 flex items-center justify-center"><Zap size={14} className="text-violet-400" /></div> Power-ups</h3>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Subscription ID</span>
              <span className={`font-medium ${selectedUser.powerUpSubscriptionId ? 'text-slate-300 font-mono text-xs' : 'text-slate-500'}`}>
                {selectedUser.powerUpSubscriptionId || 'None'}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Paid Slots</span>
              <span className="text-slate-300 font-semibold">{selectedUser.powerUpPaidSlots}</span>
            </div>
            <div className="pt-2 border-t border-white/[0.06]">
              <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider block mb-2">Refund Eligibility</span>
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-slate-400">Subscription Refund</span>
                  {selectedUser.hasUsedSubscriptionRefund
                    ? <span className="text-red-400 flex items-center gap-1"><X size={13} /> Used</span>
                    : <span className="text-emerald-400 flex items-center gap-1"><Check size={13} /> Available</span>
                  }
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-400">Gift Refund</span>
                  {selectedUser.hasUsedGiftRefund
                    ? <span className="text-red-400 flex items-center gap-1"><X size={13} /> Used</span>
                    : <span className="text-emerald-400 flex items-center gap-1"><Check size={13} /> Available</span>
                  }
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-400">Power-Up Refund</span>
                  {selectedUser.hasUsedPowerUpRefund
                    ? <span className="text-red-400 flex items-center gap-1"><X size={13} /> Used</span>
                    : <span className="text-emerald-400 flex items-center gap-1"><Check size={13} /> Available</span>
                  }
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Edit forms */}
      <div className={`${CARD} p-5 mb-5`}>
        <h3 className="text-sm font-bold text-white mb-5 flex items-center gap-2">Edit User</h3>
        <div className="space-y-5">
          <div>
            <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block mb-2">Email</label>
            <div className="flex gap-2">
              <input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} className={`flex-1 ${INPUT_CLS}`} />
              <button disabled={editEmail === selectedUser.email || actionLoading !== null} onClick={() => setConfirmModal({ title: 'Change Email', message: `Change email for ${selectedUser.username} from "${selectedUser.email}" to "${editEmail}"?`, confirmLabel: 'Change Email', onConfirm: () => runAction('Change email', async () => { await adminApi.changeEmail(selectedUser.id, editEmail); }) })} className={`${BTN_PRIMARY} shrink-0`}>{actionLoading === 'Change email' ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block mb-2">Username & Discriminator</label>
            <div className="flex gap-2">
              <input type="text" value={editUsername} onChange={(e) => setEditUsername(e.target.value)} className={`flex-1 ${INPUT_CLS}`} />
              <div className="flex items-center gap-1.5 shrink-0">
                <Hash size={14} className="text-slate-500" />
                <input type="text" value={editDiscriminator} onChange={(e) => setEditDiscriminator(e.target.value.replace(/\D/g, '').slice(0, 4))} maxLength={4} className={`w-20 ${INPUT_CLS} text-center`} />
              </div>
              <button disabled={(editUsername === selectedUser.username && editDiscriminator === selectedUser.discriminator) || actionLoading !== null} onClick={() => {
                const changes: string[] = [];
                if (editUsername !== selectedUser.username) changes.push(`Username: "${selectedUser.username}" \u2192 "${editUsername}"`);
                if (editDiscriminator !== selectedUser.discriminator) changes.push(`Discriminator: #${selectedUser.discriminator} \u2192 #${editDiscriminator}`);
                setConfirmModal({ title: 'Change Username', message: `Apply the following changes?\n\n${changes.join('\n')}`, confirmLabel: 'Change', onConfirm: () => runAction('Change username', async () => { const d: { username?: string; discriminator?: string } = {}; if (editUsername !== selectedUser.username) d.username = editUsername; if (editDiscriminator !== selectedUser.discriminator) d.discriminator = editDiscriminator; await adminApi.changeUsername(selectedUser.id, d); }) });
              }} className={`${BTN_PRIMARY} shrink-0`}>{actionLoading === 'Change username' ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block mb-2">Subscription Plan</label>
            {selectedUser.stripeSubscriptionId && (
              <div className="mb-3 px-4 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs flex items-center gap-2">
                <AlertTriangle size={13} /> This user has an active Stripe subscription ({selectedUser.stripePlan}). Admin changes will override the database but the Stripe subscription remains active. The next webhook may revert changes.
              </div>
            )}
            <div className="flex gap-2 items-end">
              <select value={editPlan} onChange={(e) => setEditPlan(e.target.value)} className={`flex-1 ${SELECT_CLS}`}>
                <option value="none">Free</option><option value="essential">Howl Essential</option><option value="pro">Howl Pro</option>
              </select>
              {editPlan !== 'none' && (
                <div className="flex flex-col gap-1 shrink-0">
                  <label className="text-[10px] text-slate-500 font-medium uppercase">Duration</label>
                  <select value={editPlanDuration} onChange={(e) => setEditPlanDuration(parseInt(e.target.value))} className={`w-36 ${SELECT_CLS}`}>
                    <option value={0}>Permanent</option>
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                      <option key={m} value={m}>{m} month{m > 1 ? 's' : ''}</option>
                    ))}
                  </select>
                </div>
              )}
              <button disabled={(editPlan === (selectedUser.stripePlan || 'none')) || actionLoading !== null} onClick={() => {
                const planLabel = editPlan === 'none' ? 'Free' : editPlan === 'pro' ? 'Howl Pro' : 'Howl Essential';
                const durationLabel = editPlan !== 'none' ? (editPlanDuration === 0 ? ' (Permanent)' : ` (${editPlanDuration} month${editPlanDuration > 1 ? 's' : ''})`) : '';
                const stripeWarning = selectedUser.stripeSubscriptionId ? '\n\n\u26A0\uFE0F Warning: This user has an active Stripe subscription. This admin change will override the database value, but the Stripe subscription will remain active.' : '';
                setConfirmModal({ title: 'Change Plan', message: `Change ${selectedUser.username}'s plan from "${selectedUser.stripePlan || 'Free'}" to "${planLabel}"${durationLabel}?${stripeWarning}`, confirmLabel: 'Change Plan', danger: editPlan === 'none' && !!selectedUser.stripePlan, onConfirm: () => runAction('Change plan', async () => { await adminApi.setPlan(selectedUser.id, editPlan === 'none' ? null : editPlan, editPlan !== 'none' ? editPlanDuration : undefined); }) });
              }} className={`${BTN_PRIMARY} shrink-0`}>{actionLoading === 'Change plan' ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className={`${CARD} p-5`}>
        <h3 className="text-sm font-bold text-white mb-5 flex items-center gap-2">Quick Actions</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          <button disabled={actionLoading !== null} onClick={() => setConfirmModal({ title: 'Reset Password', message: `Generate a temporary password for ${selectedUser.username}? Current password and all sessions will be invalidated.`, confirmLabel: 'Generate Temp Password', danger: true, onConfirm: () => runAction('Reset password', async () => { const r = await adminApi.resetPassword(selectedUser.id); setTempPassword(r.temporaryPassword); }) })}
            className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-amber-500/10 text-amber-300 border border-amber-500/15 text-sm font-medium hover:bg-amber-500/20 hover:border-amber-500/30 disabled:opacity-30 transition-all duration-200"><Key size={15} /> Temp Password</button>

          <button disabled={actionLoading !== null} onClick={() => setConfirmModal({ title: 'Send Reset Email', message: `Send a password reset email to ${selectedUser.email}?`, confirmLabel: 'Send Email', onConfirm: () => runAction('Send reset email', async () => { await adminApi.sendResetEmail(selectedUser.id); }) })}
            className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-cyan-500/10 text-cyan-300 border border-cyan-500/15 text-sm font-medium hover:bg-cyan-500/20 hover:border-cyan-500/30 disabled:opacity-30 transition-all duration-200"><Mail size={15} /> Send Reset Email</button>

          {selectedUser.mfaEnabled && (
            <button disabled={actionLoading !== null} onClick={() => setConfirmModal({ title: 'Disable MFA', message: `Disable all MFA methods for ${selectedUser.username}?`, confirmLabel: 'Disable MFA', danger: true, onConfirm: () => runAction('Disable MFA', async () => { await adminApi.disableMfa(selectedUser.id); }) })}
              className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-amber-500/10 text-amber-300 border border-amber-500/15 text-sm font-medium hover:bg-amber-500/20 hover:border-amber-500/30 disabled:opacity-30 transition-all duration-200"><ShieldOff size={15} /> Disable MFA</button>
          )}

          {!selectedUser.emailVerified && (
            <button disabled={actionLoading !== null} onClick={() => setConfirmModal({ title: 'Verify Email', message: `Manually verify ${selectedUser.username}'s email (${selectedUser.email})?`, confirmLabel: 'Verify', onConfirm: () => runAction('Verify email', async () => { await adminApi.verifyEmail(selectedUser.id); }) })}
              className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-emerald-500/10 text-emerald-300 border border-emerald-500/15 text-sm font-medium hover:bg-emerald-500/20 hover:border-emerald-500/30 disabled:opacity-30 transition-all duration-200"><ShieldCheck size={15} /> Verify Email</button>
          )}

          <button disabled={actionLoading !== null} onClick={() => setConfirmModal({ title: 'Revoke All Sessions', message: `Log ${selectedUser.username} out of all devices?`, confirmLabel: 'Revoke Sessions', onConfirm: () => runAction('Revoke sessions', async () => { await adminApi.revokeSessions(selectedUser.id); }) })}
            className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-slate-500/10 text-slate-300 border border-slate-500/15 text-sm font-medium hover:bg-slate-500/20 hover:border-slate-500/30 disabled:opacity-30 transition-all duration-200"><LogOut size={15} /> Revoke Sessions</button>

          {selectedUser.suspended ? (
            <button disabled={actionLoading !== null} onClick={() => setConfirmModal({ title: 'Unsuspend User', message: `Unsuspend ${selectedUser.username}? They will be able to log in again.`, confirmLabel: 'Unsuspend', onConfirm: () => runAction('Unsuspend user', async () => { await adminApi.unsuspendUser(selectedUser.id); }) })}
              className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-emerald-500/10 text-emerald-300 border border-emerald-500/15 text-sm font-medium hover:bg-emerald-500/20 hover:border-emerald-500/30 disabled:opacity-30 transition-all duration-200"><UserCheck size={15} /> Unsuspend User</button>
          ) : (
            <button disabled={actionLoading !== null} onClick={() => setConfirmModal({ title: 'Suspend User', message: `Suspend ${selectedUser.username}? All sessions will be revoked and they won't be able to log in.`, confirmLabel: 'Suspend', danger: true, onConfirm: () => runAction('Suspend user', async () => { await adminApi.suspendUser(selectedUser.id); }) })}
              className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-red-500/10 text-red-300 border border-red-500/15 text-sm font-medium hover:bg-red-500/20 hover:border-red-500/30 disabled:opacity-30 transition-all duration-200"><UserX size={15} /> Suspend User</button>
          )}
        </div>
      </div>

      {/* Per-user Audit Log */}
      <div className={`${CARD} p-5`}>
        <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2"><FileText size={15} className="text-cyan-400" /> Admin Activity for This User</h3>
        {userAuditEntries.length === 0 ? (
          <p className="text-sm text-slate-500 py-4 text-center">No admin actions recorded for this user</p>
        ) : (
          <div className="space-y-2.5">
            {userAuditEntries.map((e) => (
              <div key={e.id} className="flex items-start gap-3 px-4 py-3 rounded-xl bg-white/[0.02] border border-white/[0.04]">
                <div className="shrink-0 mt-0.5">
                  <span className={`inline-block px-2 py-0.5 text-[10px] font-semibold rounded-md border ${actionColor(e.action)}`}>{actionLabel(e.action)}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-slate-300">
                    <span className="font-medium text-white">{e.admin.username}</span>
                    {e.details && <span className="text-slate-500 ml-2">— {JSON.stringify(e.details)}</span>}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1">{formatRelative(e.createdAt)} · {new Date(e.createdAt).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        {userAuditPages > 1 && (
          <div className="flex items-center justify-center gap-3 mt-4">
            <button disabled={userAuditPage <= 1} onClick={() => { const p = userAuditPage - 1; setUserAuditPage(p); loadUserAudit(selectedUser.id, p); }} className={`${BTN_GHOST} disabled:opacity-20`}><ChevronLeft size={14} /></button>
            <span className="text-xs text-slate-500">Page {userAuditPage} of {userAuditPages} ({userAuditTotal} entries)</span>
            <button disabled={userAuditPage >= userAuditPages} onClick={() => { const p = userAuditPage + 1; setUserAuditPage(p); loadUserAudit(selectedUser.id, p); }} className={`${BTN_GHOST} disabled:opacity-20`}><ChevronRight size={14} /></button>
          </div>
        )}
      </div>

      {/* Confirm modal */}
      <ConfirmModal
        open={!!confirmModal}
        onClose={() => setConfirmModal(null)}
        onConfirm={() => { if (confirmModal) confirmModal.onConfirm(); }}
        title={confirmModal?.title || ''}
        message={confirmModal?.message || ''}
        confirmText={confirmModal?.confirmLabel}
        danger={confirmModal?.danger}
      />
    </div>
  );
};

export default UserDetailPage;
