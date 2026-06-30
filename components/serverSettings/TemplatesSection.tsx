// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { LayoutTemplate, Copy, Check, Trash2, RefreshCw, Eye, Link2, X, Hash, Volume2, ChevronDown } from 'lucide-react';
import type { Server, ServerTemplate } from '../../types';
import { apiClient } from '../../services/api';
import { socketService } from '../../services/socket';
import { SectionHeader, Card, InputField, PrimaryButton, EmptyState, ConfirmDialog } from '../settings/SettingsWidgets';

export interface TemplatesSectionProps {
  server: Server;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

/* ── Template Preview Modal ─────────────────────────────────────────────────── */

const TemplatePreviewModal: React.FC<{ template: ServerTemplate; onClose: () => void; showToast: (msg: string, type?: 'success' | 'error') => void }> = ({ template, onClose, showToast }) => {
  const { t } = useTranslation();

  const categories = template.categorySnapshot ?? [];
  const flatChannels = template.channelSnapshot ?? [];
  const roles = (template.roleSnapshot ?? []) as Array<{ name: string; color: string; permissions?: Record<string, boolean> }>;

  const totalChannels = categories.length > 0
    ? categories.reduce((sum, cat) => sum + cat.channels.length, 0)
    : flatChannels.length;

  const getRoleLabel = (role: { name: string; permissions?: Record<string, boolean> }) => {
    const p = role.permissions ?? {};
    if (p.administrator) return 'Admin';
    const labels: string[] = [];
    if (p.kickMembers) labels.push('Kick');
    if (p.banMembers) labels.push('Ban');
    if (p.manageMessages) labels.push('Manage');
    if (p.manageChannels) labels.push('Channels');
    if (p.manageRoles) labels.push('Roles');
    return labels.length > 0 ? labels.join(', ') : 'Default';
  };

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/60 backdrop-blur-md animate-in fade-in duration-300" onClick={onClose} />
      <div
        className="w-full max-w-[480px] max-h-[90vh] overflow-y-auto rounded-lg relative spring-pop-in glass"
        style={{
          border: '1px solid var(--glass-border)',
          boxShadow: '0 0 0 1px var(--fill-hover), var(--glass-shadow)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-1 flex items-start justify-between">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/30 mb-1">{t('serverSettings.templatePreview')}</p>
            <h2 className="text-lg font-bold text-white/90 tracking-tight truncate">{template.name}</h2>
            {template.description && <p className="text-xs text-white/40 mt-0.5">{template.description}</p>}
          </div>
          <button onClick={onClose} className="p-1.5 text-white/30 hover:text-white hover:bg-fill-active rounded-lg transition-all mt-0.5 shrink-0"><X size={18} /></button>
        </div>

        <div className="px-6 pt-4 pb-2">
          {/* Channel sidebar mockup */}
          <div className="mb-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/30 mb-2">{t('serverSettings.categoriesAndChannels')}</p>
            <div className="bg-fill-hover border border-default rounded-xl p-3 max-h-[200px] overflow-y-auto">
              {categories.length > 0 ? categories.map((cat, ci) => (
                <div key={ci} className={ci > 0 ? 'mt-2.5' : ''}>
                  <div className="flex items-center gap-1 mb-1">
                    <ChevronDown size={10} className="text-white/25" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-white/35">{cat.name}</span>
                  </div>
                  {cat.channels.map((ch, chi) => (
                    <div
                      key={chi}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] ${ci === 0 && chi === 0 ? 'bg-fill-hover text-white/70' : 'text-white/35 hover:text-white/50'}`}
                    >
                      {ch.type === 'voice' ? <Volume2 size={12} className="shrink-0 opacity-50" /> : <Hash size={12} className="shrink-0 opacity-50" />}
                      <span className="truncate">{ch.name}</span>
                    </div>
                  ))}
                </div>
              )) : flatChannels.map((ch, i) => (
                <div
                  key={i}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] ${i === 0 ? 'bg-fill-hover text-white/70' : 'text-white/35'}`}
                >
                  {ch.type === 'voice' ? <Volume2 size={12} className="shrink-0 opacity-50" /> : <Hash size={12} className="shrink-0 opacity-50" />}
                  <span className="truncate">{ch.name}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Roles */}
          {roles.length > 0 && (
            <div className="mb-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/30 mb-2">{t('serverSettings.roles')}</p>
              <div className="flex flex-wrap gap-2">
                {roles.map((role, i) => (
                  <div key={i} className="flex items-center gap-2 bg-fill-hover border border-default rounded-lg px-3 py-1.5">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: role.color || '#99aab5' }} />
                    <div className="min-w-0">
                      <p className="text-[11px] font-medium text-white/60 truncate">{role.name}</p>
                      <p className="text-[9px] text-white/25">{getRoleLabel(role)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Summary grid */}
          <div className="mb-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/30 mb-2">{t('serverSettings.summary')}</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { label: t('serverSettings.categories'), value: categories.length },
                { label: t('serverSettings.channels'), value: totalChannels },
                { label: t('serverSettings.roles'), value: roles.length },
                { label: t('serverSettings.timesUsed'), value: template.usageCount },
              ].map((stat) => (
                <div key={stat.label} className="bg-fill-hover border border-default rounded-lg px-3 py-2 text-center">
                  <p className="text-base font-bold text-white/70">{stat.value}</p>
                  <p className="text-[9px] text-white/30 uppercase tracking-wider">{stat.label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="px-6 py-4 border-t border-default flex items-center justify-between">
          <p className="text-[10px] text-white/25">
            {t('serverSettings.createdOn', { date: new Date(template.createdAt).toLocaleDateString() })}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(`https://howlpro.com/template/${template.code}`);
                showToast(t('serverSettings.linkCopied'));
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white/50 hover:text-white/80 bg-fill-hover border border-default rounded-lg hover:bg-fill-active transition-all"
            >
              <Link2 size={12} />
              {t('serverSettings.copyLink')}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-fill-active hover:bg-fill-strong text-white/80 transition-all"
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

/* ── TemplatesSection ───────────────────────────────────────────────────────── */

export const TemplatesSection: React.FC<TemplatesSectionProps> = ({ server, showToast }) => {
  const { t } = useTranslation();

  const [templates, setTemplates] = useState<ServerTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templateName, setTemplateName] = useState('');
  const [templateDesc, setTemplateDesc] = useState('');
  const [copyFeedbackId, setCopyFeedbackId] = useState<string | null>(null);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; desc: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void } | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<ServerTemplate | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setTemplates(await apiClient.getServerTemplates(server.id));
      } catch { /* ignore */ }
      setTemplatesLoading(false);
    })();
  }, [server.id]);

  // Live sync: template create/update/delete from another admin emits
  // `server-templates-updated`. Refetch the list.
  useEffect(() => {
    const sock = socketService.getSocket();
    if (!sock) return;
    const handler = (payload: { serverId: string }) => {
      if (payload.serverId !== server.id) return;
      apiClient.getServerTemplates(server.id).then(setTemplates).catch(() => {});
    };
    sock.on('server-templates-updated', handler);
    return () => { sock.off('server-templates-updated', handler); };
  }, [server.id]);

  const handleCopy = (id: string, text: string, feedbackMsg: string) => {
    navigator.clipboard.writeText(text);
    setCopyFeedbackId(id);
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
    copyFeedbackTimerRef.current = setTimeout(() => setCopyFeedbackId(null), 2000);
    showToast(feedbackMsg);
  };

  const handleSync = async (tmpl: ServerTemplate) => {
    try {
      await apiClient.syncServerTemplate(server.id, tmpl.id);
      setTemplates(await apiClient.getServerTemplates(server.id));
      showToast(t('serverSettings.templateSynced'));
    } catch {
      showToast(t('serverSettings.failedToSyncTemplate'), 'error');
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <SectionHeader title={t('serverSettings.templates')} desc={t('serverSettings.templatesDesc')} icon={<LayoutTemplate size={24} />} />

      {/* What copies / doesn't explainer */}
      <div className="flex flex-wrap gap-1.5 mb-1">
        {[t('serverSettings.willCopyChannels'), t('serverSettings.willCopyRoles'), t('serverSettings.willCopyCategories'), t('serverSettings.willCopySettings')].map((label) => (
          <span key={label} className="px-2.5 py-1 rounded-md text-[11px] font-medium"
            style={{ backgroundColor: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.15)', color: 'rgba(34,197,94,0.8)' }}>
            {label}
          </span>
        ))}
        {[t('serverSettings.wontCopyMessages'), t('serverSettings.wontCopyMembers'), t('serverSettings.wontCopyPerks')].map((label) => (
          <span key={label} className="px-2.5 py-1 rounded-md text-[11px] font-medium"
            style={{ backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.12)', color: 'rgba(239,68,68,0.7)' }}>
            {label}
          </span>
        ))}
      </div>

      {/* Create template form */}
      <Card>
        <div className="space-y-3">
          <div className="flex gap-3 flex-col sm:flex-row">
            <div className="flex-1">
              <InputField label={t('serverSettings.templateTitle')} value={templateName} onChange={(e) => setTemplateName((e.target as HTMLInputElement).value)} placeholder={t('serverSettings.templateNamePlaceholder')} />
            </div>
            <div className="flex-1">
              <label className="block text-[11px] font-medium mb-2 text-t-secondary">{t('serverSettings.description')}</label>
              <input value={templateDesc} onChange={(e) => setTemplateDesc(e.target.value)} placeholder={t('serverSettings.templateDescPlaceholder')}
                className="w-full rounded-xl px-4 py-3 text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all bg-app-surface text-t-primary" />
            </div>
          </div>
          <PrimaryButton disabled={!templateName.trim()} onClick={async () => {
            try {
              await apiClient.createServerTemplate(server.id, templateName, templateDesc || undefined);
              setTemplateName(''); setTemplateDesc('');
              setTemplates(await apiClient.getServerTemplates(server.id));
              showToast(t('serverSettings.templateCreated'));
            } catch { showToast(t('serverSettings.failedToCreateTemplate'), 'error'); }
          }}>{t('serverSettings.generateTemplate')}</PrimaryButton>
        </div>
      </Card>

      {/* Template list */}
      {templatesLoading ? <EmptyState icon={<span className="inline-block w-8 h-8 border-2 border-[var(--border-strong)] border-t-white rounded-full animate-spin" />} title={t('serverSettings.loading')} desc="" /> :
        templates.length === 0 ? <EmptyState icon={<LayoutTemplate size={40} />} title={t('serverSettings.noTemplates')} desc={t('serverSettings.noTemplatesDesc')} /> :
        <div className="space-y-3">
          {templates.map((tmpl) => {
            const categories = tmpl.categorySnapshot ?? [];
            const flatChannels = (tmpl.channelSnapshot ?? []) as Array<{ name: string; type: string }>;
            const roles = (tmpl.roleSnapshot ?? []) as Array<{ name: string; color: string }>;
            const linkUrl = `https://howlpro.com/template/${tmpl.code}`;

            return (
              <Card key={tmpl.id}>
                {/* Header row */}
                <div className="flex items-start justify-between mb-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold truncate text-t-primary">{tmpl.name}</p>
                      <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium bg-app-surface text-t-secondary">
                        {tmpl.usageCount} {tmpl.usageCount !== 1 ? t('serverSettings.usesPlural', { count: tmpl.usageCount }) : t('serverSettings.uses', { count: tmpl.usageCount })}
                      </span>
                    </div>
                    {tmpl.description && <p className="text-xs mt-0.5 text-t-secondary">{tmpl.description}</p>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-3">
                    <button type="button" onClick={() => handleSync(tmpl)} title={t('serverSettings.syncTemplate')}
                      className="p-2 rounded-lg hover:bg-fill-hover transition-all text-t-secondary">
                      <RefreshCw size={14} />
                    </button>
                    <button type="button" onClick={() => setPreviewTemplate(tmpl)} title={t('serverSettings.previewTemplate')}
                      className="p-2 rounded-lg hover:bg-fill-hover transition-all text-t-secondary">
                      <Eye size={14} />
                    </button>
                  </div>
                </div>

                {/* Template link row */}
                <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg bg-app-surface border border-default">
                  <Link2 size={12} className="shrink-0 text-t-secondary" />
                  <span className="flex-1 min-w-0 text-[11px] font-mono truncate text-t-secondary">{linkUrl}</span>
                  <button type="button" onClick={() => handleCopy(`link-${tmpl.id}`, linkUrl, t('serverSettings.linkCopied'))}
                    className="p-1 rounded-lg hover:bg-fill-hover transition-all shrink-0 text-t-secondary">
                    {copyFeedbackId === `link-${tmpl.id}` ? <Check size={12} className="text-t-accent" /> : <Copy size={12} />}
                  </button>
                  <button type="button" onClick={() => handleCopy(`code-${tmpl.id}`, tmpl.code, t('serverSettings.codeCopied'))}
                    className="px-2 py-0.5 rounded-lg text-[9px] font-medium hover:bg-fill-hover transition-all shrink-0 text-t-secondary border border-default">
                    {copyFeedbackId === `code-${tmpl.id}` ? <Check size={12} className="text-t-accent" /> : 'UUID'}
                  </button>
                </div>

                {/* Category / channel preview */}
                {(categories.length > 0 || flatChannels.length > 0) && (
                  <div className="mb-3 pt-2 border-t border-default">
                    {categories.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {categories.map((cat, ci) => (
                          <div key={ci} className="px-2.5 py-1.5 rounded-lg bg-app-surface">
                            <p className="text-[9px] font-semibold uppercase tracking-wider mb-0.5 text-t-secondary">{cat.name}</p>
                            <div className="flex flex-col gap-px">
                              {cat.channels.map((ch, chi) => (
                                <span key={chi} className="text-[10px] text-t-secondary">
                                  {ch.type === 'voice' ? '\u{1F50A}' : '#'} {ch.name}
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {flatChannels.map((ch, i) => (
                          <span key={i} className="px-2 py-0.5 rounded-lg text-[10px] bg-app-surface text-t-secondary">
                            {ch.type === 'voice' ? '\u{1F50A}' : '#'} {ch.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Roles preview */}
                {roles.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {roles.map((role, i) => (
                      <span key={i} className="flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-[10px] bg-app-surface text-t-secondary">
                        <span className="w-2 h-2 rounded-full inline-block shrink-0" style={{ backgroundColor: role.color || '#99aab5' }} />
                        {role.name}
                      </span>
                    ))}
                  </div>
                )}

                {/* Action row */}
                <div className="flex items-center justify-end pt-2 border-t border-default">
                  <button type="button" onClick={() => setConfirmDialog({
                    title: t('serverSettings.deleteTemplate'),
                    desc: t('serverSettings.deleteTemplateConfirm', { name: tmpl.name }),
                    confirmLabel: t('common.delete'),
                    danger: true,
                    onConfirm: async () => {
                      try {
                        await apiClient.deleteServerTemplate(server.id, tmpl.id);
                        setTemplates(await apiClient.getServerTemplates(server.id));
                        showToast(t('serverSettings.templateDeleted'));
                      } catch { showToast(t('serverSettings.failedToDelete'), 'error'); }
                      setConfirmDialog(null);
                    },
                  })}
                    className="btn-cta-danger flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] transition-all"
                  >
                    <Trash2 size={12} />
                    {t('serverSettings.deleteTemplate')}
                  </button>
                </div>
              </Card>
            );
          })}
        </div>
      }
      {confirmDialog && <ConfirmDialog title={confirmDialog.title} desc={confirmDialog.desc} confirmLabel={confirmDialog.confirmLabel} danger={confirmDialog.danger} onConfirm={confirmDialog.onConfirm} onCancel={() => setConfirmDialog(null)} />}
      {previewTemplate && <TemplatePreviewModal template={previewTemplate} onClose={() => setPreviewTemplate(null)} showToast={showToast} />}
    </div>
  );
};

export default TemplatesSection;
