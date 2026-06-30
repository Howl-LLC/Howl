// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Plus, Trash2 } from 'lucide-react';
import type { Server, AutomodRule } from '../../types';
import { apiClient } from '../../services/api';
import { socketService } from '../../services/socket';
import { SectionHeader, Card, InputField, SelectField, Toggle, PrimaryButton, EmptyState, ConfirmDialog } from '../settings/SettingsWidgets';

export interface AutoModSectionProps {
  server: Server;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

export const AutoModSection: React.FC<AutoModSectionProps> = ({ server, showToast }) => {
  const { t } = useTranslation();

  const [automodRules, setAutomodRules] = useState<AutomodRule[]>([]);
  const [automodLoading, setAutomodLoading] = useState(true);
  const [automodName, setAutomodName] = useState('');
  const [automodType, setAutomodType] = useState('keyword_filter');
  const [automodKeywords, setAutomodKeywords] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; desc: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setAutomodRules(await apiClient.getAutomodRules(server.id));
      } catch { /* ignore */ }
      setAutomodLoading(false);
    })();
  }, [server.id]);

  // Live sync: another admin creating/updating/deleting a rule emits
  // `server-automod-updated`. Refetch the list.
  useEffect(() => {
    const sock = socketService.getSocket();
    if (!sock) return;
    const handler = (payload: { serverId: string }) => {
      if (payload.serverId !== server.id) return;
      apiClient.getAutomodRules(server.id).then(setAutomodRules).catch(() => {});
    };
    sock.on('server-automod-updated', handler);
    return () => { sock.off('server-automod-updated', handler); };
  }, [server.id]);

  return (
    <div className="max-w-3xl space-y-6">
      <SectionHeader title={t('serverSettings.autoFilter')} desc={t('serverSettings.autoFilterDesc')} icon={<Bot size={24} />} />
      <Card>
        <p className="text-[11px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.newRule')}</p>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <InputField label={t('serverSettings.name')} value={automodName} onChange={(e) => setAutomodName((e.target as HTMLInputElement).value)} placeholder={t('serverSettings.ruleName')} />
          <SelectField label={t('serverSettings.type')} value={automodType} onChange={setAutomodType}
            options={[{ value: 'keyword_filter', label: t('serverSettings.blockedWords') }, { value: 'spam_filter', label: t('serverSettings.spamCatcher') }, { value: 'mention_spam', label: t('serverSettings.massPingGuard') }, { value: 'link_filter', label: t('serverSettings.linkBlocker') }]} />
        </div>
        {automodType === 'keyword_filter' && (
          <InputField label={t('serverSettings.keywordsLabel')} value={automodKeywords} onChange={(e) => setAutomodKeywords((e.target as HTMLInputElement).value)} placeholder={t('serverSettings.keywordsPlaceholder')} />
        )}
        <PrimaryButton className="mt-3" disabled={!automodName.trim()} onClick={async () => {
          try {
            const config: Record<string, unknown> = {};
            if (automodType === 'keyword_filter') config.keywords = automodKeywords.split(',').map((k) => k.trim()).filter(Boolean);
            await apiClient.createAutomodRule(server.id, { name: automodName, type: automodType, config });
            setAutomodName(''); setAutomodKeywords('');
            setAutomodRules(await apiClient.getAutomodRules(server.id));
            showToast(t('serverSettings.ruleCreated'));
          } catch { showToast(t('serverSettings.failedToCreateRule'), 'error'); }
        }}><Plus size={14} className="inline mr-1" /> {t('serverSettings.createRuleButton')}</PrimaryButton>
      </Card>
      {automodLoading ? <EmptyState icon={<span className="inline-block w-8 h-8 border-2 border-[var(--border-strong)] border-t-white rounded-full animate-spin" />} title={t('serverSettings.loading')} desc="" /> :
        automodRules.length === 0 ? <EmptyState icon={<Bot size={40} />} title={t('serverSettings.noFilterRules')} desc={t('serverSettings.createFirstRule')} /> :
        <div className="space-y-2">
          {automodRules.map((r) => (
            <div key={r.id} className="flex items-center gap-4 px-4 py-3.5 rounded-xl border hover:bg-fill-hover transition-all" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: 'var(--bg-app)' }}>
                <Bot size={14} style={{ color: 'var(--text-secondary)' }} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{r.name}</p>
                <p className="text-[10px] capitalize" style={{ color: 'var(--text-secondary)' }}>{r.type.replace(/_/g, ' ')}</p>
              </div>
              <Toggle checked={r.enabled} onChange={async (v) => {
                try { await apiClient.updateAutomodRule(server.id, r.id, { enabled: v }); setAutomodRules(await apiClient.getAutomodRules(server.id)); }
                catch { showToast(t('serverSettings.failedToUpdateRule'), 'error'); }
              }} />
              <button type="button" onClick={() => setConfirmDialog({ title: t('serverSettings.deleteRuleTitle'), desc: t('serverSettings.removeConfirm', { name: r.name }), confirmLabel: t('common.delete'), danger: true, onConfirm: async () => { try { await apiClient.deleteAutomodRule(server.id, r.id); setAutomodRules(await apiClient.getAutomodRules(server.id)); showToast(t('serverSettings.ruleDeleted')); } catch { showToast(t('serverSettings.failedToDeleteRule'), 'error'); } setConfirmDialog(null); } })}
                className="p-2 rounded-lg hover:bg-red-500/20 transition-all" style={{ color: 'var(--text-secondary)' }}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      }
      {confirmDialog && <ConfirmDialog title={confirmDialog.title} desc={confirmDialog.desc} confirmLabel={confirmDialog.confirmLabel} danger={confirmDialog.danger} onConfirm={confirmDialog.onConfirm} onCancel={() => setConfirmDialog(null)} />}
    </div>
  );
};

export default AutoModSection;
