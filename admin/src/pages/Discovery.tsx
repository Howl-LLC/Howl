// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Sparkles, Star, ShieldCheck, EyeOff, Ban, AlertTriangle, MoreVertical,
  Check, X as XIcon, Compass, Flag, RefreshCw,
} from 'lucide-react';
import { adminApi, type AdminDiscoveryServer } from '../api';
import { BTN_GHOST, CARD } from '../components/styles';
import { AdminAvatar, DataTable, PageHeader, Pagination, type Column } from '../components';
import { formatRelative } from '../utils';
import {
  ADMIN_SERVER_ACTION_LABEL,
  adminServerActionIsDestructive,
  adminServerActionRequiresReason,
  performAdminServerAction,
  type AdminServerActionKind,
} from '../utils/adminServerActions';

interface PendingAction {
  kind: AdminServerActionKind;
  server: AdminDiscoveryServer;
}

const Discovery: React.FC = () => {
  const navigate = useNavigate();
  const [servers, setServers] = useState<AdminDiscoveryServer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState('');
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const fetch = useCallback(async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.adminDiscoveryQueue(p);
      setServers(res.servers);
      setTotal(res.total);
      setPage(res.page);
      setPages(res.pages);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load discovery queue';
      setError(msg);
      setServers([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(1); }, [fetch]);

  // Close action menu on outside click.
  useEffect(() => {
    if (!openMenu) return;
    const onClick = () => setOpenMenu(null);
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [openMenu]);

  const beginAction = useCallback((kind: AdminServerActionKind, server: AdminDiscoveryServer) => {
    setReason('');
    setPendingAction({ kind, server });
    setOpenMenu(null);
  }, []);

  const performAction = useCallback(async () => {
    if (!pendingAction) return;
    const { server, kind } = pendingAction;
    const requireReason = adminServerActionRequiresReason(kind);
    if (requireReason && !reason.trim()) {
      setActionResult({ type: 'error', message: 'A reason is required for this action.' });
      return;
    }
    try {
      await performAdminServerAction(server.id, kind, reason.trim() || undefined);
      setActionResult({ type: 'success', message: `${ADMIN_SERVER_ACTION_LABEL[kind]} succeeded for ${server.name}` });
      setPendingAction(null);
      setReason('');
      fetch(page);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : `Failed to ${ADMIN_SERVER_ACTION_LABEL[kind].toLowerCase()}`;
      setActionResult({ type: 'error', message: msg });
    }
  }, [pendingAction, reason, fetch, page]);

  const columns: Column<AdminDiscoveryServer>[] = [
    {
      key: 'server',
      header: 'Server',
      render: (s) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/discovery/${s.id}`); }}
          className="flex items-center gap-3 hover:opacity-80 transition-opacity"
        >
          <AdminAvatar src={s.icon} name={s.name} size={36} rounded={10} />
          <div className="text-left min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-white font-semibold text-sm truncate">{s.name}</span>
              {s.featured && <Star size={12} className="text-amber-400 shrink-0" fill="currentColor" />}
              {s.verified && <ShieldCheck size={12} className="text-cyan-400 shrink-0" />}
              {s.hidden && <EyeOff size={12} className="text-slate-500 shrink-0" />}
              {s.suspended && <Ban size={12} className="text-red-400 shrink-0" />}
            </div>
            <div className="text-[11px] text-slate-500">{s.memberCount.toLocaleString()} members</div>
          </div>
        </button>
      ),
    },
    {
      key: 'owner',
      header: 'Owner',
      render: (s) => s.owner ? (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/users/${s.owner!.id}`); }}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <AdminAvatar src={s.owner.avatar} name={s.owner.username} size={24} />
          <span className="text-slate-300 text-xs">{s.owner.username}<span className="text-slate-500">#{s.owner.discriminator}</span></span>
        </button>
      ) : <span className="text-slate-500 text-xs">Unknown</span>,
    },
    {
      key: 'optedIn',
      header: 'Opted In',
      render: (s) => (
        <div className="text-xs">
          <div className="text-slate-300">{formatRelative(s.optedInAt)}</div>
          <div className="text-[10px] text-slate-600">{new Date(s.optedInAt).toLocaleDateString()}</div>
        </div>
      ),
    },
    {
      key: 'reports',
      header: 'Pending Reports',
      render: (s) => s.pendingReportCount > 0 ? (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-amber-500/15 border border-amber-500/25 text-amber-300 text-[11px] font-bold">
          <Flag size={11} /> {s.pendingReportCount}
        </span>
      ) : <span className="text-slate-600 text-xs">--</span>,
    },
    {
      key: 'actions',
      header: '',
      className: 'w-12',
      render: (s) => (
        <div className="relative" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === s.id ? null : s.id); }}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-all"
            title="Actions"
          >
            <MoreVertical size={14} />
          </button>
          {openMenu === s.id && (
            <div className="absolute right-0 top-full mt-1 z-20 w-56 rounded-xl border border-white/[0.08] bg-[#0c1225] shadow-2xl shadow-black/40 overflow-hidden">
              <ActionItem
                icon={<Star size={13} />}
                label={s.featured ? 'Unfeature' : 'Feature'}
                color="amber"
                onClick={() => beginAction(s.featured ? 'unfeature' : 'feature', s)}
              />
              <ActionItem
                icon={<ShieldCheck size={13} />}
                label={s.verified ? 'Unverify' : 'Verify'}
                color="cyan"
                onClick={() => beginAction(s.verified ? 'unverify' : 'verify', s)}
              />
              <ActionItem
                icon={<EyeOff size={13} />}
                label={s.hidden ? 'Restore to discovery' : 'Hide from discovery'}
                color="slate"
                onClick={() => beginAction(s.hidden ? 'unhide' : 'hide', s)}
              />
              <div className="h-px bg-white/[0.06]" />
              <ActionItem
                icon={<Ban size={13} />}
                label={s.suspended ? 'Unsuspend' : 'Suspend'}
                color="red"
                onClick={() => beginAction(s.suspended ? 'unsuspend' : 'suspend', s)}
              />
            </div>
          )}
        </div>
      ),
    },
  ];

  return (
    <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
      <PageHeader
        title="Discovery Queue"
        subtitle="Community servers that opted into public discovery — review for featuring, verification, and policy violations."
      >
        <button onClick={() => fetch(page)} className={BTN_GHOST} title="Refresh"><RefreshCw size={16} /></button>
      </PageHeader>

      {actionResult && (
        <div className={`mb-5 px-5 py-3.5 rounded-xl border text-sm flex items-center gap-2.5 ${actionResult.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300' : 'bg-red-500/10 border-red-500/25 text-red-300'}`}>
          {actionResult.type === 'success' ? <Check size={16} /> : <AlertTriangle size={16} />} {actionResult.message}
          <button onClick={() => setActionResult(null)} className="ml-auto opacity-60 hover:opacity-100 transition-opacity"><XIcon size={14} /></button>
        </div>
      )}

      {error && (
        <div className={`${CARD} p-12 flex flex-col items-center justify-center text-center mb-5`}>
          <AlertTriangle size={20} className="text-red-400 mb-3" />
          <p className="text-sm text-slate-300 mb-1">Discovery queue unavailable</p>
          <p className="text-xs text-slate-500 mb-4">{error}</p>
          <button onClick={() => fetch(page)} className="px-4 py-2 rounded-xl bg-cyan-500/15 text-cyan-300 border border-cyan-500/25 text-xs font-bold hover:bg-cyan-500/25 transition-all">Retry</button>
        </div>
      )}

      {!error && (
        <>
          <DataTable
            columns={columns}
            data={servers}
            rowKey={(s) => s.id}
            loading={loading}
            emptyIcon={<Compass size={20} className="mx-auto mb-2 opacity-40" />}
            emptyMessage="No servers in the discovery queue"
            onRowClick={(s) => navigate(`/discovery/${s.id}`)}
          />
          <Pagination page={page} pages={pages} total={total} onPageChange={fetch} label="servers" />
        </>
      )}

      {/* Confirmation modal for actions */}
      {pendingAction && (() => {
        const { kind, server } = pendingAction;
        const requireReason = adminServerActionRequiresReason(kind);
        const danger = adminServerActionIsDestructive(kind);
        const label = ADMIN_SERVER_ACTION_LABEL[kind];
        return (
          <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/70 backdrop-blur-md" onClick={() => { setPendingAction(null); setReason(''); }}>
            <div className="bg-[#0c1225] rounded-2xl border border-white/[0.08] p-7 max-w-md w-full mx-4 shadow-2xl shadow-black/40" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
                <Sparkles size={16} className="text-cyan-400" /> {label}: {server.name}
              </h3>
              <p className="text-sm text-slate-400 mb-5 whitespace-pre-line leading-relaxed">
                {`Are you sure you want to ${label.toLowerCase()} for "${server.name}"?`}
                {requireReason && '\n\nA reason is required and will be recorded in the audit log.'}
              </p>
              {requireReason && (
                <div className="mb-5">
                  <label className="text-xs text-slate-400 block mb-1.5">Reason (required)</label>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={3}
                    className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500/40 transition-colors resize-none"
                    placeholder="Why are you taking this action?"
                    autoFocus
                  />
                </div>
              )}
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => { setPendingAction(null); setReason(''); }}
                  className="px-5 py-2.5 rounded-xl bg-white/5 text-slate-300 text-sm font-medium hover:bg-white/10 transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={performAction}
                  disabled={requireReason && !reason.trim()}
                  className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                    danger
                      ? 'bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30'
                      : 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/30'
                  }`}
                >
                  {label}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

    </div>
  );
};

const ACTION_COLOR: Record<string, string> = {
  amber: 'text-amber-300 hover:bg-amber-500/10',
  cyan: 'text-cyan-300 hover:bg-cyan-500/10',
  slate: 'text-slate-300 hover:bg-white/[0.04]',
  red: 'text-red-300 hover:bg-red-500/10',
};

const ActionItem: React.FC<{ icon: React.ReactNode; label: string; color: string; onClick: () => void }> = ({ icon, label, color, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-medium transition-colors ${ACTION_COLOR[color] || 'text-slate-300 hover:bg-white/[0.04]'}`}
  >
    {icon}
    <span>{label}</span>
  </button>
);

export default Discovery;
