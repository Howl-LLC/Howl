// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, Pencil, Bell, ChevronRight, LogOut, Pin } from 'lucide-react';
import type { DMChannelItem } from './DMView';
import { useContextMenuPosition, getSubmenuPosition, GLASS_MENU_CLASS } from '../utils/contextMenuStyles';

export type MuteDuration = '15m' | '1h' | '3h' | '8h' | '24h' | 'forever';

const MUTE_OPTION_KEYS: { value: MuteDuration; key: string }[] = [
  { value: '15m', key: 'groupMenu.for15Minutes' },
  { value: '1h', key: 'groupMenu.for1Hour' },
  { value: '3h', key: 'groupMenu.for3Hours' },
  { value: '8h', key: 'groupMenu.for8Hours' },
  { value: '24h', key: 'groupMenu.for24Hours' },
  { value: 'forever', key: 'groupMenu.iDecideWhenToUnmute' },
];

interface GroupChatContextMenuProps {
  dm: DMChannelItem;
  x: number;
  y: number;
  isUnread?: boolean;
  onClose: () => void;
  onMarkAsRead: (dmChannelId: string) => void;
  onEditGroup: (dmChannelId: string) => void;
  isPinned?: boolean;
  onPinConversation?: (dmChannelId: string) => void;
  onUnpinConversation?: (dmChannelId: string) => void;
  onMute?: (dmChannelId: string, duration: MuteDuration) => void;
  onLeaveGroup: (dmChannelId: string) => void;
}

export const GroupChatContextMenu: React.FC<GroupChatContextMenuProps> = ({
  dm,
  x,
  y,
  isUnread,
  onClose,
  onMarkAsRead,
  onEditGroup,
  isPinned,
  onPinConversation,
  onUnpinConversation,
  onMute,
  onLeaveGroup,
}) => {
  const { t } = useTranslation();
  const [muteSubmenu, setMuteSubmenu] = useState(false);

  const { menuRef, style: posStyle } = useContextMenuPosition(x, y);
  const muteTriggerRef = useRef<HTMLDivElement>(null);
  const [muteSubPos, setMuteSubPos] = useState<{ left: number; top: number } | null>(null);

  const handleMuteEnter = () => {
    setMuteSubmenu(true);
    requestAnimationFrame(() => {
      if (muteTriggerRef.current) {
        const rect = muteTriggerRef.current.getBoundingClientRect();
        setMuteSubPos(getSubmenuPosition(rect, 220, MUTE_OPTION_KEYS.length * 40 + 16));
      }
    });
  };

  const item = (
    label: string,
    onClick: () => void,
    icon?: React.ReactNode,
    red?: boolean,
    arrow?: boolean
  ) => (
    <button
      type="button"
      onClick={() => {
        onClick();
        onClose();
      }}
      className={`w-full flex items-center gap-3 px-3 py-2 mx-1.5 rounded-lg text-left text-[13px] font-medium tracking-tight transition-colors ${red ? 'text-red-400 hover:bg-red-500/10' : 'hover:bg-fill-hover'}`}
      style={{ color: red ? undefined : 'var(--text-primary)' }}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {arrow && <ChevronRight size={14} className="opacity-60" />}
    </button>
  );

  const sep = () => <div className="h-px my-1 mx-3" style={{ backgroundColor: 'var(--border-subtle)' }} />;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[var(--z-popover)]" onClick={onClose} aria-hidden />
      <div
        ref={menuRef}
        className={`fixed z-[var(--z-popover)] py-1.5 min-w-[220px] flex glass ${GLASS_MENU_CLASS}`}
        style={posStyle}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={() => { if (isUnread) { onMarkAsRead(dm.id); onClose(); } }}
            disabled={!isUnread}
            className={`w-full flex items-center gap-3 px-3 py-2 mx-1.5 rounded-lg text-left text-[13px] font-medium tracking-tight transition-colors ${isUnread ? 'hover:bg-fill-hover cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
            style={{ color: 'var(--text-primary)' }}
          >
            <Check size={16} className="opacity-70 shrink-0" />
            <span className="flex-1">{t('groupMenu.markAsRead')}</span>
          </button>
          {sep()}
          {item(t('groupMenu.editGroup'), () => onEditGroup(dm.id), <Pencil size={16} className="opacity-70 shrink-0" />)}
          {isPinned && onUnpinConversation
            ? item(t('groupMenu.unpinConversation'), () => onUnpinConversation(dm.id), <Pin size={16} className="opacity-70 shrink-0" />)
            : onPinConversation && item(t('groupMenu.pinConversation'), () => onPinConversation(dm.id), <Pin size={16} className="opacity-70 shrink-0" />)}
          {sep()}
          {onMute && (
            <>
              <div
                ref={muteTriggerRef}
                onMouseEnter={handleMuteEnter}
                onMouseLeave={() => setMuteSubmenu(false)}
              >
                <button
                  type="button"
                  className="w-full flex items-center gap-3 px-3 py-2 mx-1.5 rounded-lg text-left text-[13px] font-medium tracking-tight hover:bg-fill-hover transition-colors"
                  style={{ color: 'var(--text-primary)' }}
                  onClick={() => setMuteSubmenu(prev => !prev)}
                >
                  <Bell size={16} className="opacity-70 shrink-0" />
                  <span className="flex-1">{t('groupMenu.muteConversation')}</span>
                  <ChevronRight size={14} className="opacity-60" />
                </button>
              </div>
            </>
          )}
          {onMute && sep()}
          {item(t('groupMenu.leaveGroup'), () => onLeaveGroup(dm.id), <LogOut size={16} className="opacity-70 shrink-0" />, true)}
        </div>
      </div>
      {onMute && muteSubmenu && muteSubPos && (
        <div
          className={`fixed z-[var(--z-popover)] py-1.5 min-w-[200px] glass ${GLASS_MENU_CLASS}`}
          style={{ left: muteSubPos.left, top: muteSubPos.top }}
          onMouseEnter={() => setMuteSubmenu(true)}
          onMouseLeave={() => setMuteSubmenu(false)}
        >
          {MUTE_OPTION_KEYS.map(({ value, key }) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                onMute!(dm.id, value);
                onClose();
              }}
              className="w-full px-3 py-2 mx-1.5 rounded-lg text-left text-[13px] font-medium tracking-tight hover:bg-fill-hover transition-colors"
              style={{ color: 'var(--text-primary)' }}
            >
              {t(key)}
            </button>
          ))}
        </div>
      )}
    </>,
    document.body
  );
};
