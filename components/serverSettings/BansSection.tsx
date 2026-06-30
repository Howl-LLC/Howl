// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Ban, Search } from 'lucide-react';
import type { Server, ServerBan } from '../../types';
import { apiClient } from '../../services/api';
import { socketService } from '../../services/socket';
import { LetterAvatar } from '../LetterAvatar';
import { SectionHeader, EmptyState, ConfirmDialog } from '../settings/SettingsWidgets';

export interface BansSectionProps {
  server: Server;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

export const BansSection: React.FC<BansSectionProps> = ({ server, showToast }) => {
  const { t } = useTranslation();

  const [bans, setBans] = useState<ServerBan[]>([]);
  const [bansLoading, setBansLoading] = useState(true);
  const [banSearch, setBanSearch] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; desc: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setBans(await apiClient.getServerBans(server.id));
      } catch (e) {
        showToast(e instanceof Error ? e.message : t('serverSettings.failedToLoadBans', { defaultValue: 'Failed to load bans' }), 'error');
      }
      setBansLoading(false);
    })();
  }, [server.id]);

  // Live sync: ban add/remove from another admin emits `server-ban-added`
  // or `server-ban-removed`. Refetch the list.
  useEffect(() => {
    const sock = socketService.getSocket();
    if (!sock) return;
    const handler = (payload: { serverId: string }) => {
      if (payload.serverId !== server.id) return;
      apiClient.getServerBans(server.id).then(setBans).catch(() => {});
    };
    sock.on('server-ban-added', handler);
    sock.on('server-ban-removed', handler);
    return () => {
      sock.off('server-ban-added', handler);
      sock.off('server-ban-removed', handler);
    };
  }, [server.id]);

  return (
    <div className="max-w-3xl space-y-6">
      <SectionHeader title={t('serverSettings.banList')} desc={t('serverSettings.banListDesc')} icon={<Ban size={24} />} />
      <div className="relative">
        <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-t-secondary" />
        <input value={banSearch} onChange={(e) => setBanSearch(e.target.value)} placeholder={t('serverSettings.searchBanned')}
          className="w-full pl-10 pr-4 py-2.5 rounded-xl text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all bg-app-surface text-t-primary" />
      </div>
      {bansLoading ? <EmptyState icon={<span className="inline-block w-8 h-8 border-2 border-[var(--border-strong)] border-t-white rounded-full animate-spin" />} title={t('serverSettings.loading')} desc="" /> : (() => {
        const filtered = bans.filter((b) => !banSearch.trim() || b.username.toLowerCase().includes(banSearch.toLowerCase()));
        return filtered.length === 0 ? <EmptyState icon={<Ban size={40} />} title={bans.length === 0 ? t('serverSettings.noBans') : t('serverSettings.noResults')} desc={t('serverSettings.bannedUsersDesc')} /> :
          <div className="space-y-2">
            {filtered.map((b) => (
              <div key={b.id} className="flex items-center gap-4 px-4 py-3 rounded-xl border border-default hover:bg-fill-hover transition-all">
                <LetterAvatar avatar={b.avatar} username={b.username} size={32} className="rounded-full" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-t-primary">{b.username}{b.discriminator ? `#${b.discriminator}` : ''}</p>
                  <p className="text-[10px] text-t-secondary">
                    {b.reason || t('serverSettings.noReason')} · {new Date(b.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <button type="button" onClick={() => setConfirmDialog({ title: t('serverSettings.liftBan'), desc: t('serverSettings.liftBanConfirm', { username: b.username }), confirmLabel: t('serverSettings.liftBan'), onConfirm: async () => {
                  try { await apiClient.unbanServerMember(server.id, b.userId); setBans(await apiClient.getServerBans(server.id)); showToast(t('serverSettings.banLifted')); }
                  catch { showToast(t('serverSettings.failedToUnban'), 'error'); }
                  setConfirmDialog(null);
                }})}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-default hover:bg-fill-hover transition-all text-t-accent">
                  {t('serverSettings.unban')}
                </button>
              </div>
            ))}
          </div>;
      })()}
      {confirmDialog && <ConfirmDialog title={confirmDialog.title} desc={confirmDialog.desc} confirmLabel={confirmDialog.confirmLabel} danger={confirmDialog.danger} onConfirm={confirmDialog.onConfirm} onCancel={() => setConfirmDialog(null)} />}
    </div>
  );
};

export default BansSection;
