// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link2, Plus, Copy, Check, Trash2, Pencil } from 'lucide-react';
import { Dropdown } from '../ui/dropdown';
import { Server, serverHasPerm } from '../../types';
import type { ServerInvite } from '../../types/server';
import { socketService } from '../../services/socket';
import { SectionHeader, PrimaryButton, EmptyState, ConfirmDialog } from '../settings/SettingsWidgets';
import { sanitizeImgSrc } from '../../utils/sanitizeImgSrc';
import { LazyGif } from '../LazyGif';
import { getFrameUrl } from '../../utils/getFrameUrl';

// Props

export interface InvitesSectionProps {
  server: Server;
  showToast: (message: string, type?: 'success' | 'error') => void;
  currentUserId?: string;
  onCreateInvite?: (serverId: string, options?: { expireAfter?: number | null; maxUses?: number | null; temporary?: boolean; label?: string; shareable?: boolean }) => Promise<{ id: string; code: string; link: string; label?: string; shareable: boolean }>;
  onDeleteInvite?: (serverId: string, inviteId: string) => Promise<void>;
  onUpdateInvite?: (serverId: string, inviteId: string, data: { label?: string | null; shareable?: boolean }) => Promise<ServerInvite>;
  getServerInvites?: (serverId: string) => Promise<ServerInvite[]>;
}

// Component

export const InvitesSection: React.FC<InvitesSectionProps> = ({
  server, showToast, currentUserId, onCreateInvite, onDeleteInvite, onUpdateInvite, getServerInvites,
}) => {
  const { t } = useTranslation();
  const canManageServer = serverHasPerm(server, 'manageServer');
  const gridCols = canManageServer ? 'grid-cols-[1fr_auto_auto_auto_auto_auto]' : 'grid-cols-[1fr_auto_auto_auto_auto]';

  // State
  const [invites, setInvites] = useState<ServerInvite[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(false);
  const [inviteCreateLoading, setInviteCreateLoading] = useState(false);
  const [inviteCreateError, setInviteCreateError] = useState<string | null>(null);
  const [copyFeedbackId, setCopyFeedbackId] = useState<string | null>(null);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteExpiry, setInviteExpiry] = useState<number>(86400); // seconds (default 1 day)
  const [inviteMaxUses, setInviteMaxUses] = useState<number>(0); // 0 = no limit
  const [inviteTemporary, setInviteTemporary] = useState(false);
  const [inviteLabel, setInviteLabel] = useState<string>('');
  const [inviteShareable, setInviteShareable] = useState<boolean>(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState<string>('');
  const [editShareable, setEditShareable] = useState<boolean>(false);
  const [editSaving, setEditSaving] = useState<boolean>(false);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; desc: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void } | null>(null);
  const [createdInvite, setCreatedInvite] = useState<{ code: string; link: string } | null>(null);

  // Load invites on mount
  useEffect(() => {
    if (getServerInvites) {
      setInvitesLoading(true);
      getServerInvites(server.id).then(setInvites).catch(() => showToast(t('serverSettings.failedToLoadInvites'), 'error')).finally(() => setInvitesLoading(false));
    }
  }, [server.id, getServerInvites]);

  // Live invite updates over socket
  useEffect(() => {
    const sock = socketService.getSocket();
    if (!sock) return;
    const handleUpdated = (payload: { serverId: string; invite: ServerInvite }) => {
      if (payload.serverId !== server.id) return;
      setInvites((prev) => {
        const idx = prev.findIndex((inv) => inv.id === payload.invite.id);
        if (idx === -1) return prev;
        const cur = prev[idx]!;
        if (cur.label === payload.invite.label
          && cur.shareable === payload.invite.shareable
          && cur.useCount === payload.invite.useCount
          && cur.maxUses === payload.invite.maxUses
          && cur.expiresAt === payload.invite.expiresAt) return prev;
        const next = [...prev];
        next[idx] = { ...cur, ...payload.invite };
        return next;
      });
    };
    const handleCreated = (payload: { serverId: string; invite: ServerInvite }) => {
      if (payload.serverId !== server.id) return;
      setInvites((prev) => prev.some((i) => i.id === payload.invite.id) ? prev : [payload.invite, ...prev]);
    };
    const handleDeleted = (payload: { serverId: string; inviteId: string }) => {
      if (payload.serverId !== server.id) return;
      setInvites((prev) => prev.filter((i) => i.id !== payload.inviteId));
    };
    sock.on('server-invite-updated', handleUpdated);
    sock.on('server-invite-created', handleCreated);
    sock.on('server-invite-deleted', handleDeleted);
    return () => {
      sock.off('server-invite-updated', handleUpdated);
      sock.off('server-invite-created', handleCreated);
      sock.off('server-invite-deleted', handleDeleted);
    };
  }, [server.id]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
    };
  }, []);

  return (
    <>
      <div className="max-w-3xl space-y-6">
        <SectionHeader title={t('serverSettings.invites')} desc={t('serverSettings.invitesDesc')} icon={<Link2 size={24} />} />

        <div className="flex items-center gap-3">
          <PrimaryButton onClick={() => { setShowInviteModal(true); setInviteExpiry(86400); setInviteMaxUses(0); setInviteTemporary(false); setInviteLabel(''); setInviteShareable(false); setInviteCreateError(null); setCreatedInvite(null); }}>
            <Plus size={14} className="inline mr-1" /> {t('serverSettings.createInvite')}
          </PrimaryButton>
        </div>

        {/* Create invite modal */}
        {showInviteModal && (
          <div className="rounded-xl border border-default p-5 space-y-4 bg-floating">
            <p className="text-sm font-semibold text-t-primary">{t('serverSettings.createInviteLink')}</p>

            {!createdInvite && (<>
            <div>
              <label className="block text-[11px] font-medium mb-1.5 text-t-secondary">{t('serverSettings.expireAfter')}</label>
              <Dropdown<number>
                options={[
                  { value: 1800, label: t('serverSettings.duration30min') },
                  { value: 3600, label: t('serverSettings.duration1hour') },
                  { value: 21600, label: t('serverSettings.duration6hours') },
                  { value: 43200, label: t('serverSettings.duration12hours') },
                  { value: 86400, label: t('serverSettings.duration1day') },
                  { value: 604800, label: t('serverSettings.duration7days') },
                  { value: 0, label: t('serverSettings.durationNever') },
                ]}
                value={inviteExpiry}
                onChange={(v) => setInviteExpiry(v)}
                size="md"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium mb-1.5 text-t-secondary">{t('serverSettings.maxUses')}</label>
              <Dropdown<number>
                options={[
                  { value: 0, label: t('serverSettings.noLimit') },
                  { value: 1, label: t('serverSettings.uses1') },
                  { value: 5, label: t('serverSettings.uses5') },
                  { value: 10, label: t('serverSettings.uses10') },
                  { value: 25, label: t('serverSettings.uses25') },
                  { value: 50, label: t('serverSettings.uses50') },
                  { value: 100, label: t('serverSettings.uses100') },
                ]}
                value={inviteMaxUses}
                onChange={(v) => setInviteMaxUses(v)}
                size="md"
              />
            </div>

            <label className={`flex items-center gap-2 ${inviteExpiry > 0 ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
              <input
                type="checkbox"
                checked={inviteTemporary && inviteExpiry > 0}
                disabled={inviteExpiry === 0}
                onChange={(e) => setInviteTemporary(e.target.checked)}
                className="accent-[var(--cyan-accent)]"
              />
              <span className="text-sm text-t-primary">{t('serverSettings.grantTempMembership')}</span>
            </label>
            <p className="text-[10px] -mt-2 ml-6 text-t-secondary">{t('serverSettings.tempMembershipDesc')}</p>

            {canManageServer && (
              <>
                <div>
                  <label className="block text-[11px] font-medium mb-1.5 text-t-secondary">{t('serverSettings.inviteLabel', { defaultValue: 'Label (optional)' })}</label>
                  <input
                    type="text"
                    value={inviteLabel}
                    maxLength={32}
                    onChange={(e) => setInviteLabel(e.target.value)}
                    placeholder={t('serverSettings.inviteLabelPlaceholder', { defaultValue: 'e.g. General, VIPs' })}
                    className="w-full px-3 py-2 text-sm rounded-lg border-0 outline-none"
                    style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-primary)' }}
                  />
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={inviteShareable} onChange={(e) => setInviteShareable(e.target.checked)} className="accent-[var(--cyan-accent)]" />
                  <span className="text-sm text-t-primary">{t('serverSettings.inviteShareable', { defaultValue: 'Available to all members' })}</span>
                </label>
                <p className="text-[10px] -mt-2 ml-6 text-t-secondary">{t('serverSettings.inviteShareableDesc', { defaultValue: 'Members without Create Invite permission can use this link to invite friends.' })}</p>
              </>
            )}

            {inviteCreateError && <p className="text-xs text-red-400">{inviteCreateError}</p>}

            <div className="flex items-center gap-2 pt-1">
              <PrimaryButton loading={inviteCreateLoading} onClick={async () => {
                if (!onCreateInvite) return;
                setInviteCreateLoading(true); setInviteCreateError(null);
                try {
                  const result = await onCreateInvite(server.id, {
                    expireAfter: inviteExpiry || null,
                    maxUses: inviteMaxUses || null,
                    temporary: inviteTemporary,
                    label: canManageServer && inviteLabel.trim() ? inviteLabel.trim() : undefined,
                    shareable: canManageServer ? inviteShareable : undefined,
                  });
                  setCreatedInvite({ code: result.code, link: result.link });
                } catch (e) { setInviteCreateError(e instanceof Error ? e.message : t('common.failed')); }
                setInviteCreateLoading(false);
              }}>{t('common.create')}</PrimaryButton>
              <button type="button" onClick={() => { setShowInviteModal(false); setCreatedInvite(null); }} className="px-4 py-2 rounded-lg text-sm hover:bg-fill-hover transition-all text-t-secondary">{t('common.cancel')}</button>
            </div>
            </>)}

            {createdInvite && (
              <div className="space-y-3 pt-3 border-t border-default">
                <p className="text-xs font-semibold text-t-accent">{t('serverSettings.inviteLinkReady')}</p>
                <div className="relative">
                  <input
                    readOnly
                    value={createdInvite.link}
                    className="w-full bg-black/40 border border-[var(--glass-border)] rounded-xl px-4 py-3 text-xs font-mono pr-12 truncate outline-none text-t-accent"
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(createdInvite.link);
                      showToast(t('serverSettings.inviteLinkCopied'));
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-2 hover:bg-fill-hover rounded-lg transition-all text-t-secondary"
                  >
                    <Copy size={14} />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => { setCreatedInvite(null); setShowInviteModal(false); }}
                  className="w-full py-2 text-xs font-semibold rounded-lg hover:bg-fill-hover transition-all text-t-secondary"
                >
                  {t('common.done')}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Invite list header */}
        {!invitesLoading && invites.length > 0 && (
          <div className={`grid ${gridCols} gap-4 px-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-t-secondary`}>
            <span>{t('serverSettings.inviter')}</span>
            {canManageServer && <span className="w-32">{t('serverSettings.inviteLabelHeader', { defaultValue: 'Label' })}</span>}
            <span className="w-40 text-center">{t('serverSettings.inviteLink')}</span>
            <span className="w-14 text-center">{t('serverSettings.uses')}</span>
            <span className="w-28 text-center">{t('serverSettings.expires')}</span>
            <span className="w-10" />
          </div>
        )}

        {invitesLoading ? <EmptyState icon={<span className="inline-block w-8 h-8 border-2 border-[var(--border-strong)] border-t-white rounded-full animate-spin" />} title={t('serverSettings.loading')} desc="" /> :
          invites.length === 0 ? <EmptyState icon={<Link2 size={40} />} title={t('serverSettings.noInvites')} desc={t('serverSettings.createInviteDesc')} /> :
          <div className="space-y-1">
            {invites.map((inv) => {
              const remaining = inv.expiresAt ? Math.max(0, Math.floor((new Date(inv.expiresAt).getTime() - Date.now()) / 1000)) : null;
              let expiryText = t('serverSettings.neverExpires');
              if (remaining !== null) {
                if (remaining <= 0) expiryText = t('serverSettings.expired');
                else if (remaining < 3600) expiryText = t('serverSettings.remainingMinutes', { minutes: Math.floor(remaining / 60) });
                else if (remaining < 86400) expiryText = t('serverSettings.remainingHoursMinutes', { hours: Math.floor(remaining / 3600), minutes: Math.floor((remaining % 3600) / 60) });
                else expiryText = t('serverSettings.remainingDaysHours', { days: Math.floor(remaining / 86400), hours: Math.floor((remaining % 86400) / 3600) });
              }

              return (
                <div key={inv.id} className={`grid ${gridCols} gap-4 items-center px-4 py-2.5 rounded-xl border border-default hover:bg-fill-hover transition-all`}>
                  <div className="flex items-center gap-2 min-w-0">
                    {inv.createdBy?.avatar ? (
                      <LazyGif src={sanitizeImgSrc(inv.createdBy.avatar)} frameSrc={getFrameUrl(inv.createdBy.avatar)} alt="" className="w-6 h-6 rounded-[var(--radius-lg)] object-cover flex-shrink-0" />
                    ) : (
                      <div className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-bold bg-floating text-t-secondary">
                        {inv.createdBy?.username?.[0]?.toUpperCase() ?? '?'}
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate text-t-primary">{inv.createdBy?.username ?? 'Unknown'}</p>
                      {inv.temporary && <p className="text-[9px] text-t-accent">{t('serverSettings.temporary')}</p>}
                    </div>
                  </div>
                  {canManageServer && (
                    <span className="w-32 text-xs truncate text-t-primary" title={inv.label ?? ''}>
                      {inv.label ?? <span className="text-t-tertiary italic">{t('serverSettings.unlabeled', { defaultValue: 'Unlabeled' })}</span>}
                    </span>
                  )}
                  <span className="w-40 text-center text-[10px] font-mono truncate text-t-primary" title={inv.link}>{inv.link?.replace(/^https?:\/\//, '') || inv.code}</span>
                  <span className="w-14 text-center text-xs text-t-secondary">
                    {inv.useCount}{inv.maxUses ? `/${inv.maxUses}` : ''}
                  </span>
                  <span className="w-28 text-center text-[10px] text-t-secondary">{expiryText}</span>
                  <div className={`${canManageServer ? 'w-16' : 'w-10'} flex items-center gap-1`}>
                    {canManageServer && (
                      <button type="button" onClick={() => {
                        setEditingId(inv.id);
                        setEditLabel(inv.label ?? '');
                        setEditShareable(inv.shareable);
                      }} className="p-1.5 rounded-lg hover:bg-fill-hover transition-all text-t-secondary" title={t('serverSettings.editInvite', { defaultValue: 'Edit invite' })}>
                        <Pencil size={12} />
                      </button>
                    )}
                    <button type="button" onClick={() => { navigator.clipboard.writeText(inv.link); setCopyFeedbackId(inv.id); if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current); copyFeedbackTimerRef.current = setTimeout(() => setCopyFeedbackId(null), 2000); }}
                      className="p-1.5 rounded-lg hover:bg-fill-hover transition-all text-t-secondary" title={t('serverSettings.copyLink')}>
                      {copyFeedbackId === inv.id ? <Check size={12} className="text-t-accent" /> : <Copy size={12} />}
                    </button>
                    {(canManageServer || (currentUserId && inv.createdBy?.id === currentUserId)) && (
                      <button type="button" onClick={() => setConfirmDialog({
                        title: t('serverSettings.deleteInvite', 'Delete Invite'),
                        desc: t('serverSettings.deleteInviteConfirm', { code: inv.code }),
                        confirmLabel: t('common.delete'),
                        danger: true,
                        onConfirm: async () => {
                          if (!onDeleteInvite) return;
                          try {
                            await onDeleteInvite(server.id, inv.id);
                            setInvites((prev) => prev.filter((i) => i.id !== inv.id));
                            showToast(t('serverSettings.inviteDeleted', 'Invite deleted'));
                          } catch (e) { showToast(e instanceof Error ? e.message : t('serverSettings.failedToDeleteInvite', 'Failed to delete invite'), 'error'); }
                          setConfirmDialog(null);
                        },
                      })} className="p-1.5 rounded-lg hover:bg-red-500/20 transition-all text-t-secondary" title={t('serverSettings.deleteInvite', 'Delete invite')}>
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        }
      </div>
      {editingId && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4" onClick={() => !editSaving && setEditingId(null)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative w-full max-w-sm rounded-2xl border border-default bg-floating p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-semibold text-t-primary">{t('serverSettings.editInvite', { defaultValue: 'Edit invite' })}</p>
            <div>
              <label className="block text-[11px] font-medium mb-1.5 text-t-secondary">{t('serverSettings.inviteLabel', { defaultValue: 'Label (optional)' })}</label>
              <input
                type="text"
                value={editLabel}
                maxLength={32}
                onChange={(e) => setEditLabel(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border-0 outline-none"
                style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-primary)' }}
              />
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={editShareable} onChange={(e) => setEditShareable(e.target.checked)} className="accent-[var(--cyan-accent)]" />
              <span className="text-sm text-t-primary">{t('serverSettings.inviteShareable', { defaultValue: 'Available to all members' })}</span>
            </label>
            <div className="flex items-center gap-2 pt-2">
              <PrimaryButton loading={editSaving} onClick={async () => {
                if (!onUpdateInvite || !editingId) return;
                setEditSaving(true);
                try {
                  const updated = await onUpdateInvite(server.id, editingId, {
                    label: editLabel.trim() ? editLabel.trim() : null,
                    shareable: editShareable,
                  });
                  setInvites((prev) => prev.map((inv) => inv.id === updated.id ? { ...inv, ...updated } : inv));
                  setEditingId(null);
                  showToast(t('serverSettings.inviteUpdated', { defaultValue: 'Invite updated' }));
                } catch (e) {
                  showToast(e instanceof Error ? e.message : t('common.failed'), 'error');
                }
                setEditSaving(false);
              }}>{t('common.save', { defaultValue: 'Save' })}</PrimaryButton>
              <button type="button" disabled={editSaving} onClick={() => setEditingId(null)} className="px-4 py-2 rounded-lg text-sm hover:bg-fill-hover transition-all text-t-secondary">{t('common.cancel')}</button>
            </div>
          </div>
        </div>
      )}
      {confirmDialog && <ConfirmDialog {...confirmDialog} onCancel={() => setConfirmDialog(null)} />}
    </>
  );
};

export default InvitesSection;
