// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Upload, FileText, Check, AlertTriangle } from 'lucide-react';
import type { Server } from '../../types';
import { apiClient } from '../../services/api';
import { socketService } from '../../services/socket';
import { SectionHeader, Card, PrimaryButton } from '../settings/SettingsWidgets';
import { useAuthStore } from '../../stores/authStore';
import { getPlanPerks, type PlanTier } from '../../shared/planPerks';

export interface ImportHistorySectionProps {
  server: Server;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

export const ImportHistorySection: React.FC<ImportHistorySectionProps> = ({ server, showToast }) => {
  const { t } = useTranslation();
  const currentUser = useAuthStore((s) => s.currentUser);
  const effectivePlan = (currentUser?.effectivePlan ?? currentUser?.stripePlan ?? null) as PlanTier;
  const maxImportMB = getPlanPerks(effectivePlan).maxImportMB;

  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [importResults, setImportResults] = useState<{ channelName: string; channelId: string; messagesImported: number; channelCreated: boolean }[]>([]);
  const [importError, setImportError] = useState<string | null>(null);

  // Listen for the worker's completion signal on the socket so the spinner
  // reflects the actual backend state. Previously the UI marked the import
  // "done" the moment the HTTP 202 response came back (literally the second
  // after the upload finished), but the background job could still run for
  // many minutes — leaving the user confused about whether it worked.
  useEffect(() => {
    const socket = socketService.getSocket();
    if (!socket) return;
    const handleComplete = (data: {
      serverId: string;
      channelId: string;
      channelName: string;
      messagesImported: number;
    }) => {
      if (data.serverId !== server.id) return;
      setImportResults((prev) => [...prev, {
        channelName: data.channelName,
        channelId: data.channelId,
        messagesImported: data.messagesImported,
        channelCreated: false, // worker doesn't currently track this; route did
      }]);
      setImportLoading(false);
      setImportFiles([]);
      showToast(t('serverSettings.importedMessages', { count: data.messagesImported }));
    };
    const handleFailed = (data: { serverId: string; error?: string }) => {
      if (data.serverId !== server.id) return;
      setImportLoading(false);
      setImportError(data.error || t('serverSettings.uploadFailed'));
    };
    socket.on('server-import-complete', handleComplete);
    socket.on('server-import-failed', handleFailed);
    return () => {
      socket.off('server-import-complete', handleComplete);
      socket.off('server-import-failed', handleFailed);
    };
  }, [server.id, showToast, t]);

  return (
    <div className="max-w-2xl space-y-6">
      <SectionHeader title={t('serverSettings.importTitle')} desc={t('serverSettings.importDesc')} icon={<Download size={24} />} />

      <Card>
        <div className="space-y-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.howItWorks')}</p>
          <div className="space-y-3">
            {[
              { step: '1', title: t('serverSettings.exportFromDiscord'), desc: <>{t('serverSettings.exportFromDiscordDesc1')} <a href="https://github.com/Tyrrrz/DiscordChatExporter" target="_blank" rel="noopener noreferrer" className="underline hover:opacity-80" style={{ color: 'var(--cyan-accent)' }}>DiscordChatExporter</a> {t('serverSettings.exportFromDiscordDesc2')}</> },
              { step: '2', title: t('serverSettings.uploadHere'), desc: t('serverSettings.uploadHereDesc') },
              { step: '3', title: t('serverSettings.messagesAppear'), desc: t('serverSettings.messagesAppearDesc') },
            ].map((item) => (
              <div key={item.step} className="flex gap-3 items-start">
                <span className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold" style={{ backgroundColor: 'var(--cyan-accent)', color: '#000' }}>{item.step}</span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{item.title}</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <div className="space-y-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.uploadExportFiles')}</p>
          <label className="flex flex-col items-center justify-center py-8 border-2 border-dashed rounded-xl cursor-pointer hover:bg-fill-hover transition-all"
            style={{ borderColor: 'var(--border-subtle)' }}>
            <Upload size={28} className="mb-2 opacity-40" style={{ color: 'var(--text-secondary)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{t('serverSettings.clickToSelectJson')}</span>
            <span className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.jsonFormatOnly')}</span>
            <input type="file" accept=".json" multiple className="hidden" onChange={(e) => {
              if (e.target.files) {
                const MAX_IMPORT_SIZE = maxImportMB * 1024 * 1024;
                const files = Array.from(e.target.files);
                const oversized = files.find(f => f.size > MAX_IMPORT_SIZE);
                if (oversized) {
                  setImportError(`File "${oversized.name}" exceeds your plan's ${maxImportMB} MB import limit.`);
                  return;
                }
                setImportFiles(files);
                setImportResults([]);
                setImportError(null);
              }
            }} />
          </label>

          {importFiles.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.filesSelected', { count: importFiles.length })}</p>
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {importFiles.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs" style={{ backgroundColor: 'var(--bg-app)', color: 'var(--text-primary)' }}>
                    <FileText size={14} className="shrink-0 opacity-50" />
                    <span className="truncate flex-1">{f.name}</span>
                    <span style={{ color: 'var(--text-secondary)' }}>{(f.size / 1024).toFixed(0)} KB</span>
                  </div>
                ))}
              </div>
              <PrimaryButton disabled={importLoading} onClick={async () => {
                setImportLoading(true);
                setImportError(null);
                try {
                  // Fire uploads sequentially. For each file the backend
                  // returns 202 once the upload is buffered and enqueued —
                  // the real completion signal comes via the
                  // `server-import-complete` / `server-import-failed` socket
                  // events wired up in the useEffect above. We keep the
                  // spinner running after these requests resolve so it
                  // accurately reflects background-job progress.
                  for (const file of importFiles) {
                    await apiClient.importDiscordHistory(server.id, file);
                  }
                } catch (err: unknown) {
                  setImportError(err instanceof Error ? err.message : t('serverSettings.uploadFailed'));
                  setImportLoading(false);
                }
              }}>
                {importLoading ? (
                  <span className="flex items-center gap-2">
                    <span className="inline-block w-4 h-4 border-2 border-[var(--border-strong)] border-t-white rounded-full animate-spin" />
                    {t('serverSettings.importing')}
                  </span>
                ) : t('serverSettings.importFiles', { count: importFiles.length })}
              </PrimaryButton>
            </div>
          )}

          {importError && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs" style={{ backgroundColor: 'var(--danger-subtle)', color: 'var(--danger)' }}>
              <AlertTriangle size={14} className="shrink-0" />
              {importError}
            </div>
          )}
        </div>
      </Card>

      {importResults.length > 0 && (
        <Card>
          <div className="space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.importResults')}</p>
            {importResults.map((r, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2.5 rounded-lg" style={{ backgroundColor: 'var(--bg-app)' }}>
                <Check size={16} style={{ color: 'var(--cyan-accent)' }} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>#{r.channelName}</p>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {t('serverSettings.messagesImported', { count: r.messagesImported })}
                    {r.channelCreated ? ` ${t('serverSettings.newChannelCreated')}` : ` ${t('serverSettings.addedToExisting')}`}
                  </p>
                </div>
              </div>
            ))}
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {t('serverSettings.importTotal', { messages: importResults.reduce((sum, r) => sum + r.messagesImported, 0), channels: importResults.length })}
            </p>
          </div>
        </Card>
      )}
    </div>
  );
};

export default ImportHistorySection;
