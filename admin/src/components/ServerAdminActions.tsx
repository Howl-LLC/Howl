// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useCallback, useState } from 'react';
import { Star, ShieldCheck, EyeOff, Ban, Globe, Sparkles, AlertTriangle, X as XIcon } from 'lucide-react';
import {
  ADMIN_SERVER_ACTION_LABEL,
  adminServerActionIsDestructive,
  adminServerActionRequiresReason,
  performAdminServerAction,
  type AdminServerActionKind,
} from '../utils/adminServerActions';
import { CARD } from './styles';
import type { AdminServerDetail } from '../api';

/** Boolean snapshot of a server's admin-moderation flags. Hydrated from
 *  AdminServerDetail and toggled in place by ServerAdminActionButtons. */
export interface ServerAdminFlagsState {
  featured: boolean;
  verified: boolean;
  hidden: boolean;
  suspended: boolean;
  discoveryOverride: boolean;
}

/** Pull the moderation-flag snapshot out of an AdminServerDetail. The
 *  base /admin/servers/:id payload already has these fields after Unit
 *  10; falsy fallbacks cover older backends. */
export function hydrateFlagsFromServer(server: AdminServerDetail): ServerAdminFlagsState {
  return {
    featured: server.featured ?? false,
    verified: server.verified ?? false,
    hidden: server.hiddenFromDiscovery ?? false,
    suspended: server.suspended ?? false,
    discoveryOverride: server.discoveryListingOverride ?? false,
  };
}

/** Inline pill row showing which moderation flags are currently active.
 *  Render next to a server name (e.g. in a header) so admins see live
 *  state at a glance. Order matters: positive (Featured/Verified/
 *  Override) first, restrictive (Hidden/Suspended) last. */
export const ServerAdminStatusBadges: React.FC<{ flags: ServerAdminFlagsState }> = ({ flags }) => (
  <>
    {flags.featured && <span className="text-[10px] font-bold px-2 py-0.5 rounded border border-amber-500/40 bg-amber-500/15 text-amber-300 inline-flex items-center gap-1"><Star size={10} fill="currentColor" /> Featured</span>}
    {flags.verified && <span className="text-[10px] font-bold px-2 py-0.5 rounded border border-cyan-500/40 bg-cyan-500/15 text-cyan-300 inline-flex items-center gap-1"><ShieldCheck size={10} /> Verified</span>}
    {flags.discoveryOverride && <span className="text-[10px] font-bold px-2 py-0.5 rounded border border-violet-500/40 bg-violet-500/15 text-violet-300 inline-flex items-center gap-1"><Globe size={10} /> Discovery override</span>}
    {flags.hidden && <span className="text-[10px] font-bold px-2 py-0.5 rounded border border-slate-500/40 bg-slate-500/15 text-slate-300 inline-flex items-center gap-1"><EyeOff size={10} /> Hidden</span>}
    {flags.suspended && <span className="text-[10px] font-bold px-2 py-0.5 rounded border border-red-500/40 bg-red-500/15 text-red-300 inline-flex items-center gap-1"><Ban size={10} /> Suspended</span>}
  </>
);

interface ServerAdminActionButtonsProps {
  serverId: string;
  serverName: string;
  flags: ServerAdminFlagsState;
  /** Called with the new flags object after a successful action. */
  onFlagsChange: (flags: ServerAdminFlagsState) => void;
  /** Called when an action succeeds or fails — parent shows the banner. */
  onActionResult: (result: { type: 'success' | 'error'; message: string }) => void;
}

/** Five-button moderation row + inline confirmation modal. The modal is
 *  inline rather than reusing the shared ConfirmModal because destructive
 *  actions (suspend) require a reason textarea, which the shared modal
 *  doesn't support. */
export const ServerAdminActionButtons: React.FC<ServerAdminActionButtonsProps> = ({
  serverId, serverName, flags, onFlagsChange, onActionResult,
}) => {
  const [pendingAction, setPendingAction] = useState<{ kind: AdminServerActionKind } | null>(null);
  const [reason, setReason] = useState('');

  const beginAction = useCallback((kind: AdminServerActionKind) => {
    setPendingAction({ kind });
    setReason('');
  }, []);

  const performAction = useCallback(async () => {
    if (!pendingAction) return;
    const { kind } = pendingAction;
    const requireReason = adminServerActionRequiresReason(kind);
    if (requireReason && !reason.trim()) {
      onActionResult({ type: 'error', message: 'A reason is required.' });
      return;
    }
    try {
      await performAdminServerAction(serverId, kind, reason.trim() || undefined);
      const next: ServerAdminFlagsState = (() => {
        switch (kind) {
          case 'feature':   return { ...flags, featured: true };
          case 'unfeature': return { ...flags, featured: false };
          case 'verify':    return { ...flags, verified: true };
          case 'unverify':  return { ...flags, verified: false };
          case 'hide':      return { ...flags, hidden: true };
          case 'unhide':    return { ...flags, hidden: false };
          case 'suspend':   return { ...flags, suspended: true };
          case 'unsuspend': return { ...flags, suspended: false };
          case 'grantDiscoveryOverride':  return { ...flags, discoveryOverride: true };
          case 'revokeDiscoveryOverride': return { ...flags, discoveryOverride: false };
        }
      })();
      onFlagsChange(next);
      onActionResult({ type: 'success', message: `${ADMIN_SERVER_ACTION_LABEL[kind]} succeeded` });
      setPendingAction(null);
      setReason('');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : `Failed to ${ADMIN_SERVER_ACTION_LABEL[kind].toLowerCase()}`;
      onActionResult({ type: 'error', message: msg });
    }
  }, [serverId, pendingAction, reason, flags, onFlagsChange, onActionResult]);

  return (
    <>
      <div className={`${CARD} p-5 mb-5`}>
        <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-cyan-500/15 flex items-center justify-center"><Sparkles size={14} className="text-cyan-400" /></div>
          Moderation Actions
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <ActionButton
            label={flags.featured ? 'Unfeature' : 'Feature'}
            description="Promote on discovery home"
            icon={<Star size={14} />}
            color="amber"
            onClick={() => beginAction(flags.featured ? 'unfeature' : 'feature')}
          />
          <ActionButton
            label={flags.verified ? 'Unverify' : 'Verify'}
            description="Add the verified checkmark"
            icon={<ShieldCheck size={14} />}
            color="cyan"
            onClick={() => beginAction(flags.verified ? 'unverify' : 'verify')}
          />
          <ActionButton
            label={flags.hidden ? 'Restore' : 'Hide'}
            description="Remove from public listings"
            icon={<EyeOff size={14} />}
            color="slate"
            onClick={() => beginAction(flags.hidden ? 'unhide' : 'hide')}
          />
          <ActionButton
            label={flags.suspended ? 'Unsuspend' : 'Suspend'}
            description="Disable the server entirely"
            icon={<Ban size={14} />}
            color="red"
            onClick={() => beginAction(flags.suspended ? 'unsuspend' : 'suspend')}
          />
          <ActionButton
            label={flags.discoveryOverride ? 'Revoke override' : 'Discovery override'}
            description="Bypass size/age/activity gates"
            icon={<Globe size={14} />}
            color="violet"
            onClick={() => beginAction(flags.discoveryOverride ? 'revokeDiscoveryOverride' : 'grantDiscoveryOverride')}
          />
        </div>
      </div>

      {pendingAction && (() => {
        const { kind } = pendingAction;
        const requireReason = adminServerActionRequiresReason(kind);
        const danger = adminServerActionIsDestructive(kind);
        const label = ADMIN_SERVER_ACTION_LABEL[kind];
        return (
          <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/70 backdrop-blur-md" onClick={() => { setPendingAction(null); setReason(''); }}>
            <div className="bg-[#0c1225] rounded-2xl border border-white/[0.08] p-7 max-w-md w-full mx-4 shadow-2xl shadow-black/40" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
                {danger && <AlertTriangle size={18} className="text-red-400" />}
                {label}: {serverName}
              </h3>
              <p className="text-sm text-slate-400 mb-5 leading-relaxed">
                {`Are you sure you want to ${label.toLowerCase()} for "${serverName}"?`}
                {requireReason && ' A reason is required.'}
              </p>
              {requireReason && (
                <div className="mb-5">
                  <label className="text-xs text-slate-400 block mb-1.5">Reason (required)</label>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={3}
                    className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500/40 resize-none"
                    placeholder="Why are you taking this action?"
                    autoFocus
                  />
                </div>
              )}
              <div className="flex justify-end gap-3">
                <button onClick={() => { setPendingAction(null); setReason(''); }} className="px-5 py-2.5 rounded-xl bg-white/5 text-slate-300 text-sm font-medium hover:bg-white/10">
                  <XIcon size={14} className="inline mr-1" /> Cancel
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
    </>
  );
};

const ACTION_COLORS: Record<string, string> = {
  amber: 'border-amber-500/25 bg-amber-500/[0.08] text-amber-300 hover:bg-amber-500/[0.18]',
  cyan: 'border-cyan-500/25 bg-cyan-500/[0.08] text-cyan-300 hover:bg-cyan-500/[0.18]',
  slate: 'border-slate-500/25 bg-slate-500/[0.08] text-slate-300 hover:bg-slate-500/[0.18]',
  red: 'border-red-500/25 bg-red-500/[0.08] text-red-300 hover:bg-red-500/[0.18]',
  violet: 'border-violet-500/25 bg-violet-500/[0.08] text-violet-300 hover:bg-violet-500/[0.18]',
};

const ActionButton: React.FC<{
  label: string;
  description: string;
  icon: React.ReactNode;
  color: string;
  onClick: () => void;
}> = ({ label, description, icon, color, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`text-left flex flex-col gap-1.5 p-4 rounded-xl border transition-all ${ACTION_COLORS[color] || ACTION_COLORS.slate}`}
  >
    <div className="flex items-center gap-2">
      {icon}
      <span className="text-xs font-bold uppercase tracking-wider">{label}</span>
    </div>
    <span className="text-[11px] text-slate-400">{description}</span>
  </button>
);
