// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, Settings, Folder, VolumeX, Volume2, Trash2 } from 'lucide-react';
import { GLASS_MENU_CLASS, ContextMenuContainer } from '../../utils/contextMenuStyles';
import type { ServerFolder } from '../../services/api/serverFolders';

export interface FolderContextMenuProps {
  menu: { x: number; y: number; folder: ServerFolder };
  onClose: () => void;
  onMarkFolderRead: () => void;
  onOpenFolderSettings: () => void;
  onCloseAllFolders: () => void;
  onToggleMute?: () => void;
  onDeleteFolder?: () => void;
}

export const FolderContextMenu: React.FC<FolderContextMenuProps> = ({
  menu,
  onClose,
  onMarkFolderRead,
  onOpenFolderSettings,
  onCloseAllFolders,
  onToggleMute,
  onDeleteFolder,
}) => {
  const { t } = useTranslation();

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[var(--z-popover)]"
        aria-hidden
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <ContextMenuContainer
        x={menu.x}
        y={menu.y}
        estWidth={220}
        estHeight={180}
        className={`fixed z-[var(--z-popover)] py-2 min-w-[220px] glass ${GLASS_MENU_CLASS}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-2">
          <button
            type="button"
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
            style={{ color: 'var(--text-primary)' }}
            onClick={onMarkFolderRead}
          >
            <Check size={16} className="shrink-0 opacity-80" />
            {t('sidebar.markFolderAsRead')}
          </button>
        </div>
        <div className="h-px bg-fill-active my-2" />
        <div className="px-2">
          <button
            type="button"
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
            style={{ color: 'var(--text-primary)' }}
            onClick={onOpenFolderSettings}
          >
            <Settings size={16} className="shrink-0 opacity-80" />
            {t('sidebar.folderSettings')}
          </button>
          <button
            type="button"
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
            style={{ color: 'var(--text-primary)' }}
            onClick={onCloseAllFolders}
          >
            <Folder size={16} className="shrink-0 opacity-80" />
            {t('sidebar.closeAllFolders')}
          </button>
          {onToggleMute && (
            <button
              type="button"
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
              style={{ color: 'var(--text-primary)' }}
              onClick={onToggleMute}
            >
              {menu.folder.muted
                ? <Volume2 size={16} className="shrink-0 opacity-80" />
                : <VolumeX size={16} className="shrink-0 opacity-80" />}
              {menu.folder.muted ? t('sidebar.unmuteFolder', 'Unmute Folder') : t('sidebar.muteFolder', 'Mute Folder')}
            </button>
          )}
        </div>
        {onDeleteFolder && (
          <>
            <div className="h-px bg-fill-active my-2" />
            <div className="px-2">
              <button
                type="button"
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
                style={{ color: 'var(--red-accent, #ef4444)' }}
                onClick={onDeleteFolder}
              >
                <Trash2 size={16} className="shrink-0 opacity-80" />
                {t('sidebar.deleteFolder', 'Delete Folder')}
              </button>
            </div>
          </>
        )}
      </ContextMenuContainer>
    </>,
    document.body
  );
};
