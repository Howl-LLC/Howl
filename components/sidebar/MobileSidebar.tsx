// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, MessageSquare, Monitor, Plus, X, Home } from 'lucide-react';
import { LetterAvatar } from '../LetterAvatar';
import { ServerIcon } from '../ServerIcon';
import type { Server, NavigationTarget, User } from '../../types';
import { longPressBindings } from '../../hooks/useLongPress';
import { useKeyboardAware } from '../../hooks/useKeyboardAware';
import { useIsMobile } from '../../hooks/useIsMobile';

export interface MobileSidebarProps {
  servers: Server[];
  activeId: NavigationTarget;
  currentUser?: User;
  friendsBadgeCount: number;
  messagesBadgeCount: number;
  serverMentionCounts: Record<string, number>;
  onNavSelect: (id: NavigationTarget) => void;
  onServerSelect: (id: string) => void;
  onOpenCreateModal: () => void;
  drawerOpen: boolean;
  onDrawerOpenChange: (open: boolean) => void;
  drawerPanelRef?: React.RefObject<HTMLDivElement | null>;
  backdropRef?: React.RefObject<HTMLDivElement | null>;
  onServerLongPress?: (server: Server, e: React.MouseEvent) => void;
  children?: React.ReactNode;
}

const MOBILE_NAV_ITEMS: NavigationTarget[] = ['home', 'friends', 'dm', 'account'];

export const MobileSidebar: React.FC<MobileSidebarProps> = ({
  servers,
  activeId,
  currentUser,
  friendsBadgeCount,
  messagesBadgeCount,
  serverMentionCounts,
  onNavSelect,
  onServerSelect,
  onOpenCreateModal,
  drawerOpen,
  onDrawerOpenChange,
  drawerPanelRef,
  backdropRef,
  onServerLongPress,
  children,
}) => {
  const { t } = useTranslation();
  const drawerRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const { keyboardOpen } = useKeyboardAware(isMobile && drawerOpen);

  // Close drawer on back button / escape
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDrawerOpenChange(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  // Prevent body scroll when drawer is open — but release when keyboard opens
  // so the focused input can scroll into view via the visual viewport.
  useEffect(() => {
    if (drawerOpen && !keyboardOpen) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [drawerOpen, keyboardOpen]);

  // Publish the rendered tab-bar wrapper height (pill + padding + safe-area)
  // as a CSS variable on <html> so MessageInput can anchor its mobile composer
  // above the tab bar instead of overlapping it. ResizeObserver keeps it
  // accurate on text scaling / orientation change. Cleared on unmount so
  // landing/auth pages without MobileSidebar fall back to env(safe-area-inset-bottom).
  const tabBarWrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = tabBarWrapperRef.current;
    if (!el) return;
    const publishHeight = () => {
      const height = el.getBoundingClientRect().height;
      document.documentElement.style.setProperty('--mobile-tab-bar-height', `${Math.round(height)}px`);
    };
    publishHeight();
    const ro = new ResizeObserver(publishHeight);
    ro.observe(el);
    window.addEventListener('resize', publishHeight);
    window.addEventListener('orientationchange', publishHeight);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', publishHeight);
      window.removeEventListener('orientationchange', publishHeight);
      document.documentElement.style.removeProperty('--mobile-tab-bar-height');
    };
  }, []);

  const getIcon = (id: NavigationTarget) => {
    switch (id) {
      case 'home': return <Home size={22} />;
      case 'account': return <LetterAvatar avatar={currentUser?.avatar} username={currentUser?.username || '?'} size={24} className="rounded-full" />;
      case 'friends': return <Users size={22} />;
      case 'dm': return <MessageSquare size={22} />;
      default: return null;
    }
  };

  const getLabel = (id: NavigationTarget) => {
    switch (id) {
      case 'home': return t('sidebar.home');
      case 'account': return t('sidebar.you', 'You');
      case 'friends': return t('sidebar.friends');
      case 'dm': return t('sidebar.messages');
      default: return '';
    }
  };

  const getBadge = (id: NavigationTarget) => {
    if (id === 'friends' && friendsBadgeCount > 0) return friendsBadgeCount;
    if (id === 'dm' && messagesBadgeCount > 0) return messagesBadgeCount;
    return 0;
  };

  const isServerSelected = typeof activeId === 'string' && !MOBILE_NAV_ITEMS.includes(activeId);
  const totalServerMentions = servers.reduce((sum, s) => sum + (serverMentionCounts[s.id] ?? 0), 0);

  return (
    <>
      {children}

      {/* Bottom tab bar */}
      <div
        ref={tabBarWrapperRef}
        className="w-full shrink-0 z-50"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 6px)', paddingLeft: 10, paddingRight: 10, paddingTop: 6 }}
      >
        <div
          className="flex items-stretch"
          style={{
            backgroundColor: 'var(--bg-chat)',
            backdropFilter: 'blur(24px) saturate(1.1)',
            WebkitBackdropFilter: 'blur(24px) saturate(1.1)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 12,
            minHeight: 52,
            padding: '4px 0',
          }}
        >
        {MOBILE_NAV_ITEMS.map((id) => {
          const isActive = activeId === id && !drawerOpen;
          const badge = getBadge(id);
          return (
            <button
              key={id}
              type="button"
              onClick={() => { onNavSelect(id); onDrawerOpenChange(false); }}
              className="flex-1 flex flex-col items-center justify-center gap-0.5 relative transition-colors"
              style={{ color: isActive ? 'var(--cyan-accent)' : 'var(--text-secondary)' }}
            >
              {getIcon(id)}
              <span className="text-[10px] font-semibold uppercase tracking-wide">{getLabel(id)}</span>
              {isActive && (
                <div
                  className="rounded-full mt-0.5"
                  style={{ width: 16, height: 2, backgroundColor: 'var(--cyan-accent)' }}
                />
              )}
              {badge > 0 && (
                <span className="absolute top-0 right-[calc(50%-46px)] min-w-[44px] min-h-[44px] flex items-center justify-center pointer-events-none">
                  <span className="min-w-[16px] h-4 flex items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-black px-1 badge-pop" style={{ boxShadow: '0 0 8px rgba(239,68,68,0.4)' }}>
                    {badge > 99 ? '99+' : badge}
                  </span>
                </span>
              )}
            </button>
          );
        })}

        {/* Servers tab — opens sliding drawer */}
        <button
          type="button"
          onClick={() => onDrawerOpenChange(!drawerOpen)}
          className="flex-1 flex flex-col items-center justify-center gap-0.5 relative transition-colors"
          style={{ color: isServerSelected || drawerOpen ? 'var(--cyan-accent)' : 'var(--text-secondary)' }}
        >
          <Monitor size={22} />
          <span className="text-[10px] font-semibold uppercase tracking-wide">{t('sidebar.servers')}</span>
          {(isServerSelected || drawerOpen) && (
            <div
              className="rounded-full mt-0.5"
              style={{ width: 16, height: 2, backgroundColor: 'var(--cyan-accent)' }}
            />
          )}
          {totalServerMentions > 0 && (
            <span className="absolute top-0 right-[calc(50%-46px)] min-w-[44px] min-h-[44px] flex items-center justify-center pointer-events-none">
              <span className="min-w-[16px] h-4 flex items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-black px-1" style={{ boxShadow: '0 0 8px rgba(239,68,68,0.4)' }}>
                {totalServerMentions > 99 ? '99+' : totalServerMentions}
              </span>
            </span>
          )}
        </button>
        </div>
      </div>

      {/* Sliding left drawer overlay */}
      <div
        className="fixed inset-0 z-[var(--z-overlay)]"
        style={{ visibility: drawerOpen ? 'visible' : 'hidden', transitionProperty: 'visibility', transitionDuration: '0ms', transitionDelay: drawerOpen ? '0ms' : '300ms' }}
      >
        {/* Backdrop */}
        <div
          ref={backdropRef}
          className="absolute inset-0 transition-opacity duration-300"
          style={{ backgroundColor: 'var(--overlay-backdrop)', opacity: drawerOpen ? 1 : 0 }}
          onClick={() => onDrawerOpenChange(false)}
        />

        {/* Drawer panel */}
        <div
          ref={drawerPanelRef ?? drawerRef}
          className="absolute top-0 left-0 bottom-0 w-[min(280px,85vw)] flex flex-col transition-transform duration-300 ease-out safe-area-bottom safe-area-left safe-area-top"
          style={{
            transform: drawerOpen ? 'translateX(0)' : 'translateX(-100%)',
            backgroundColor: 'var(--bg-sidebar)',
            borderRight: '1px solid var(--border-subtle)',
            boxShadow: drawerOpen ? '4px 0 24px rgba(0,0,0,0.4)' : 'none',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Drawer header */}
          <div className="flex items-center justify-between px-4 h-14 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="flex items-center gap-2">
              <Monitor size={16} style={{ color: 'var(--cyan-accent)' }} />
              <span className="text-xs font-black uppercase tracking-wider" style={{ color: 'var(--text-primary)' }}>
                {t('sidebar.servers')}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => { onOpenCreateModal(); onDrawerOpenChange(false); }}
                className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-fill-active"
                style={{ color: 'var(--cyan-accent)' }}
                aria-label="Create server"
              >
                <Plus size={18} />
              </button>
              <button
                type="button"
                onClick={() => onDrawerOpenChange(false)}
                className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-fill-active"
                style={{ color: 'var(--text-secondary)' }}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
          </div>

          {/* Server list */}
          <div className="flex-1 overflow-y-auto py-2 px-2">
            {servers.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center px-4">
                <Monitor size={32} className="mb-3 opacity-20" style={{ color: 'var(--text-secondary)' }} />
                <p className="text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('servers.noServersYet')}</p>
                <p className="text-[10px] opacity-50" style={{ color: 'var(--text-secondary)' }}>{t('servers.createOrJoinToStart')}</p>
              </div>
            )}
            {servers.map((s) => {
              const isActive = activeId === s.id;
              const mention = serverMentionCounts[s.id] ?? 0;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => { onServerSelect(s.id); onDrawerOpenChange(false); }}
                  {...(onServerLongPress ? longPressBindings((e) => { e.preventDefault(); onServerLongPress(s, e); }) : {})}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all mb-0.5 relative"
                  style={{
                    backgroundColor: isActive ? 'color-mix(in srgb, var(--cyan-accent) 10%, transparent)' : 'transparent',
                  }}
                >
                  {isActive && (
                    <div
                      className="absolute bottom-0 left-1/2 -translate-x-1/2 rounded-t-sm"
                      style={{ width: 24, height: 3, backgroundColor: 'var(--cyan-accent)' }}
                    />
                  )}
                  <div
                    className="relative w-10 h-10 rounded-xl overflow-hidden flex items-center justify-center shrink-0 transition-all"
                    style={{
                      backgroundColor: isActive ? 'color-mix(in srgb, var(--cyan-accent) 20%, transparent)' : 'var(--fill-hover)',
                      border: isActive ? '2px solid var(--cyan-accent)' : '1px solid var(--glass-border)',
                    }}
                  >
                    {s.icon
                      ? <ServerIcon icon={s.icon} name={s.name} active={isActive} />
                      : <span className="text-xs font-black" style={{ color: isActive ? 'var(--cyan-accent)' : 'var(--text-primary)' }}>{s.name.slice(0, 2).toUpperCase()}</span>
                    }
                  </div>
                  <div className="flex-1 min-w-0 text-left">
                    <p className="text-[13px] font-semibold truncate" style={{ color: isActive ? 'var(--cyan-accent)' : 'var(--text-primary)' }}>
                      {s.name}
                    </p>
                  </div>
                  {mention > 0 && (
                    <span className="min-w-[20px] h-5 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-black px-1.5">
                      {mention > 99 ? '99+' : mention}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Create server button at bottom */}
          <div className="shrink-0 p-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
            <button
              type="button"
              onClick={() => { onOpenCreateModal(); onDrawerOpenChange(false); }}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-semibold transition-colors hover:bg-fill-hover"
              style={{ color: 'var(--cyan-accent)', border: '1px dashed color-mix(in srgb, var(--cyan-accent) 30%, transparent)' }}
            >
              <Plus size={16} />
              {t('sidebar.createServer', 'Create / Join Server')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
