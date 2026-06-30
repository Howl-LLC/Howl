// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ServerFolder } from '../../services/api/serverFolders';

const FOLDER_COLORS = [
  '#5865f2', '#57f287', '#3ba55d', '#00b0f4', '#7289da',
  '#eb459e', '#ed4245', '#fee75c', '#faa61a', '#747f8d',
  '#4a5568', '#99aab5', '#43b581', '#f04747', '#e67e22',
  '#9b59b6', '#1abc9c', '#e74c3c', '#2ecc71', '#3498db',
];

export interface FolderSettingsModalProps {
  folder: ServerFolder;
  onClose: () => void;
  onSave: (name: string, color: string | undefined) => void;
}

export const FolderSettingsModal: React.FC<FolderSettingsModalProps> = ({ folder, onClose, onSave }) => {
  const { t } = useTranslation();
  const [name, setName] = useState(folder.name);
  const [color, setColor] = useState<string | undefined>(folder.color ?? undefined);
  return (
    <>
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9010]" aria-hidden onClick={onClose} />
      <div
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[9011] w-[340px] max-w-[calc(100vw-1.5rem)] rounded-2xl border shadow-2xl overflow-hidden glass"
        style={{
          backgroundColor: 'var(--bg-panel)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--glass-border)]">
          <h3 className="text-lg font-semibold text-t-primary">{t('sidebar.folderSettings')}</h3>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-fill-active transition-colors text-t-secondary">
            <X size={20} />
          </button>
        </div>
        <div className="p-5 space-y-5">
          <div>
            <label className="block text-sm font-medium text-t-primary mb-2">{t('sidebar.folderName')}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 32))}
              maxLength={32}
              className="w-full px-3 py-2 rounded-lg bg-fill-hover border border-[var(--glass-border)] text-t-primary placeholder-t-tertiary focus:outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50"
              placeholder={t('sidebar.folderName')}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-t-primary mb-2">{t('sidebar.folderColor')}</label>
            <div className="grid grid-cols-5 gap-2">
              {FOLDER_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="w-full aspect-square rounded-lg border-2 transition-all hover:scale-105 focus:outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50"
                  style={{
                    backgroundColor: c,
                    borderColor: color === c ? 'var(--text-primary)' : 'transparent',
                    boxShadow: color === c ? `0 0 0 2px ${c}` : undefined,
                  }}
                  onClick={() => setColor(c)}
                  title={c}
                />
              ))}
            </div>
            <button
              type="button"
              className="mt-2 text-xs text-t-secondary hover:text-t-primary"
              onClick={() => setColor(undefined)}
            >
              {t('sidebar.clearColor')}
            </button>
          </div>
        </div>
        <div className="px-5 pb-5">
          <button
            type="button"
            className="btn-cta w-full py-2.5 rounded-xl text-sm transition-all"
            onClick={() => onSave(name.trim() || folder.name, color)}
          >
            {t('common.done')}
          </button>
        </div>
      </div>
    </>
  );
};
