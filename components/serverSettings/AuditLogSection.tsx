// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Server, AuditLogEntry } from '../../types';
import { apiClient } from '../../services/api';
import { sanitizeImgSrc } from '../../utils/sanitizeImgSrc';
import { SectionHeader, SelectField, EmptyState } from '../settings/SettingsWidgets';
import { LazyGif } from '../LazyGif';
import { getFrameUrl } from '../../utils/getFrameUrl';

const AUDIT_ACTION_LABELS: Record<string, string> = {
  server_update: 'Server edited', member_kick: 'Member removed', member_ban: 'Member banned', member_unban: 'Ban lifted',
  role_create: 'Role added', role_update: 'Role modified', role_delete: 'Role deleted',
  channel_create: 'Channel created', invite_create: 'Invite generated',
  emoji_create: 'Emoji uploaded', emoji_delete: 'Emoji deleted',
  sticker_create: 'Sticker uploaded', sticker_delete: 'Sticker deleted',
  sound_create: 'Sound uploaded', sound_delete: 'Sound deleted',
  automod_create: 'Filter rule added', automod_update: 'Filter rule changed', automod_delete: 'Filter rule removed',
  settings_update: 'Settings changed', template_create: 'Template created', template_delete: 'Template deleted',
};

export interface AuditLogSectionProps {
  server: Server;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

export const AuditLogSection: React.FC<AuditLogSectionProps> = ({ server, showToast }) => {
  const { t } = useTranslation();

  const [auditEntries, setAuditEntries] = useState<AuditLogEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditPage, setAuditPage] = useState(1);
  const [auditPages, setAuditPages] = useState(1);
  const [auditFilter, setAuditFilter] = useState('');

  useEffect(() => {
    (async () => {
      setAuditLoading(true);
      try {
        const res = await apiClient.getAuditLog(server.id, auditPage, auditFilter || undefined);
        setAuditEntries(res.entries ?? res);
        if (res.pages) setAuditPages(res.pages);
      } catch (e) {
        showToast(e instanceof Error ? e.message : t('serverSettings.failedToLoadAuditLog', { defaultValue: 'Failed to load audit log' }), 'error');
      }
      setAuditLoading(false);
    })();
  }, [server.id, auditPage, auditFilter]);

  return (
    <div className="max-w-4xl space-y-6">
      <SectionHeader title={t('serverSettings.changeLog')} desc={t('serverSettings.changeLogDesc')} icon={<FileText size={24} />} />
      <div className="flex items-center gap-3">
        <SelectField value={auditFilter} onChange={(v) => { setAuditFilter(v); setAuditPage(1); }}
          options={[{ value: '', label: t('serverSettings.allActions') }, ...Object.entries(AUDIT_ACTION_LABELS).map(([k, v]) => ({ value: k, label: t(`serverSettings.auditAction.${k}`, { defaultValue: v }) }))]} />
      </div>
      {auditLoading ? <EmptyState icon={<span className="inline-block w-8 h-8 border-2 border-[var(--border-strong)] border-t-[var(--text-primary)] rounded-full animate-spin" />} title={t('serverSettings.loading')} desc="" /> :
        auditEntries.length === 0 ? <EmptyState icon={<FileText size={40} />} title={t('serverSettings.noEntries')} desc={t('serverSettings.entriesDesc')} /> :
        <div className="space-y-2">
          {auditEntries.map((e) => (
            <div key={e.id} className="flex items-start gap-4 px-4 py-3 rounded-xl border hover:bg-fill-hover transition-all" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5" style={{ backgroundColor: 'var(--bg-app)' }}>
                {e.actorAvatar ? <LazyGif src={sanitizeImgSrc(e.actorAvatar)} frameSrc={getFrameUrl(e.actorAvatar)} alt="" className="w-full h-full rounded-lg object-cover" /> :
                  <span className="text-xs font-bold" style={{ color: 'var(--text-secondary)' }}>{(e.actorUsername || '?')[0]}</span>}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                  <span className="font-medium">{e.actorUsername || t('serverSettings.unknown')}</span>{' '}
                  <span style={{ color: 'var(--text-secondary)' }}>{t(`serverSettings.auditAction.${e.action}`, { defaultValue: AUDIT_ACTION_LABELS[e.action] ?? e.action })}</span>
                </p>
                {e.details && (
                  <p className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--text-secondary)' }}>
                    {Object.entries(e.details as Record<string, unknown>).map(([k, v]) => `${k}: ${v}`).join(', ')}
                  </p>
                )}
              </div>
              <span className="text-[10px] shrink-0 mt-0.5" style={{ color: 'var(--text-secondary)' }}>{new Date(e.createdAt).toLocaleString()}</span>
            </div>
          ))}
        </div>
      }
      {auditPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button type="button" disabled={auditPage <= 1} onClick={() => setAuditPage((p) => p - 1)}
            className="p-2 rounded-lg hover:bg-fill-active disabled:opacity-20 transition-all" style={{ color: 'var(--text-secondary)' }}><ChevronLeft size={16} /></button>
          <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{auditPage} / {auditPages}</span>
          <button type="button" disabled={auditPage >= auditPages} onClick={() => setAuditPage((p) => p + 1)}
            className="p-2 rounded-lg hover:bg-fill-active disabled:opacity-20 transition-all" style={{ color: 'var(--text-secondary)' }}><ChevronRight size={16} /></button>
        </div>
      )}
    </div>
  );
};

export default AuditLogSection;
