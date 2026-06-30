// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Channel, ChannelCategory, Server } from '../types';
import { Hash, Volume2, ChevronDown, ChevronRight, PhoneOff, MessageCirclePlus, Radio } from 'lucide-react';
import type { Thread } from '../types';
import { ServerIcon } from './ServerIcon';
import { ForumIcon } from './channel/ForumIcon';
import { LetterAvatar } from './LetterAvatar';
import { UserAvatar } from './UserAvatar';
import { VoiceMuteOverlay, hasMuteState } from './voice/VoiceMuteOverlay';
import { RoleNameStyle, type RoleStyle } from './RoleNameStyle';
import { getAvatarEffectClass } from '../shared/planPerks';
import { GLASS_DROPDOWN_STYLE } from '../utils/contextMenuStyles';
import { useNotificationStore } from '../stores/notificationStore';
import { isChannelMuted } from '../utils/mutedChannelStorage';
import { useVoiceStore } from '../stores/voiceStore';
import { AudioLevelMeter } from './AudioLevelMeter';

/** Side-panel speaking indicator — reads the participant's stream by userId
 * from voiceStore so we don't have to thread MediaStream refs through props.
 * For the current user, pulls the local mic stream (which isn't in the
 * per-participant bridge). Shows three dots when idle, bouncing bars when
 * the user is actively speaking. */
function PanelSpeakingBar({ userId, isCurrentUser }: { userId: string; isCurrentUser: boolean }) {
  const stream = useVoiceStore(s => {
    if (isCurrentUser) return s.localVoiceStream;
    return s.voiceChannelParticipants.find(p => p.userId === userId)?.stream ?? null;
  });
  if (!stream) return null;
  return <AudioLevelMeter stream={stream} size="md" />;
}

/** Renders the red mention badge, white unread dot, or nothing for a channel row. */
function ChannelNotificationBadge({ channelId, mentionCounts, unreadIds }: { channelId: string; mentionCounts: Record<string, number>; unreadIds: Set<string> }) {
  const muted = isChannelMuted(channelId);
  const mention = muted ? 0 : (mentionCounts[channelId] ?? 0);
  const unread = !muted && unreadIds.has(channelId);
  if (mention > 0) {
    return <span className="min-w-[16px] h-[16px] rounded-full bg-red-500 text-white text-[9px] font-black px-1 flex items-center justify-center shrink-0 shadow-[0_0_6px_rgba(239,68,68,0.3)]">{mention > 99 ? '99+' : mention}</span>;
  }
  if (unread) {
    return <div className="w-1.5 h-1.5 rounded-full bg-[var(--text-primary)] shrink-0 shadow-[0_0_4px_var(--text-primary)]" />;
  }
  return null;
}

const S_TEXT_SECONDARY: React.CSSProperties = { color: 'var(--text-secondary)' };
const S_TEXT_PRIMARY: React.CSSProperties = { color: 'var(--text-primary)' };

export type PanelView = 'activity' | 'voice' | 'text' | 'pinned';

export const PANEL_LAYOUT_KEY = 'howl_panel_layout';
const VALID_VIEWS: PanelView[] = ['activity', 'voice', 'text', 'pinned'];

export function loadPanelLayout(): { top: PanelView; bottom: PanelView } {
  try {
    const raw = localStorage.getItem(PANEL_LAYOUT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { top?: string; bottom?: string };
      const top = VALID_VIEWS.includes(parsed.top as PanelView) ? (parsed.top as PanelView) : 'activity';
      const bottom = VALID_VIEWS.includes(parsed.bottom as PanelView) ? (parsed.bottom as PanelView) : 'voice';
      return { top, bottom };
    }
  } catch { /* ignore */ }
  return { top: 'activity', bottom: 'voice' };
}

export function savePanelLayout(top: PanelView, bottom: PanelView) {
  try { localStorage.setItem(PANEL_LAYOUT_KEY, JSON.stringify({ top, bottom })); } catch { /* ignore */ }
}

export const PanelTextContent: React.FC<{
  channels: Channel[];
  categories?: ChannelCategory[];
  activeChannelId?: string;
  onSelectChannel?: (id: string) => void;
  channelThreads?: Record<string, Thread[]>;
  activeThreadId?: string | null;
  onThreadSelect?: (thread: Thread) => void;
  unreadThreadIds?: Set<string>;
  unreadThreadCounts?: Record<string, number>;
  onChannelContextMenu?: (channel: Channel, e: React.MouseEvent) => void;
  onCategoryContextMenu?: (category: ChannelCategory, e: React.MouseEvent) => void;
}> = ({ channels, categories = [], activeChannelId, onSelectChannel, channelThreads = {}, activeThreadId, onThreadSelect, unreadThreadIds, unreadThreadCounts = {}, onChannelContextMenu, onCategoryContextMenu }) => {
  const { t } = useTranslation();
  const textChannels = useMemo(() => channels.filter((c) => c.type === 'text' || c.type === 'forum').sort((a, b) => a.position - b.position), [channels]);
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const channelMentionCounts = useNotificationStore(s => s.channelMentionCounts);
  const channelUnreadIds = useNotificationStore(s => s.channelUnreadIds);

  const groups = useMemo(() => {
    const catMap = new Map<string | null, Channel[]>();
    for (const ch of textChannels) {
      const key = ch.categoryId;
      if (!catMap.has(key)) catMap.set(key, []);
      catMap.get(key)!.push(ch);
    }
    const result: Array<{ category: ChannelCategory | null; channels: Channel[] }> = [];
    const uncat = catMap.get(null) ?? [];
    if (uncat.length > 0) result.push({ category: null, channels: uncat });
    for (const cat of categories) result.push({ category: cat, channels: catMap.get(cat.id) ?? [] });
    return result;
  }, [textChannels, categories]);

  if (textChannels.length === 0) {
    return <p className="px-2 py-4 text-sm" style={S_TEXT_SECONDARY}>{t('channels.noTextChannels')}</p>;
  }

  const toggleCollapse = (id: string) => setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="space-y-1">
      {groups.map((group) => {
        const isCollapsed = group.category ? collapsed.has(group.category.id) : false;
        if (!group.channels.length) return null;
        return (
          <div key={group.category?.id ?? '__uncat'}>
            {group.category && (
              <button
                type="button"
                onClick={() => toggleCollapse(group.category!.id)}
                onContextMenu={onCategoryContextMenu ? (e) => { e.preventDefault(); onCategoryContextMenu(group.category!, e); } : undefined}
                className="w-full flex items-center gap-1 px-2 py-1 text-left"
              >
                <ChevronDown size={8} className={`shrink-0 transition-transform duration-150 ${isCollapsed ? '-rotate-90' : ''}`} style={{ color: 'var(--text-secondary)' }} />
                <span className="text-[9px] font-bold uppercase tracking-wider truncate" style={{ color: 'var(--text-secondary)' }}>{group.category.name}</span>
                {isCollapsed && <span className="text-[8px] ml-auto" style={{ color: 'var(--text-tertiary)' }}>{group.channels.length}</span>}
              </button>
            )}
            {!isCollapsed && (
              <ul className="space-y-0.5">
                {group.channels.map((ch) => {
                  const isActive = ch.id === activeChannelId;
                  const threads = (channelThreads[ch.id] ?? []).slice(0, 5);
                  const muted = isChannelMuted(ch.id);
                  const hasMention = !muted && (channelMentionCounts[ch.id] ?? 0) > 0;
                  const hasUnread = !muted && channelUnreadIds.has(ch.id);
                  return (
                    <React.Fragment key={ch.id}>
                    <li>
                      <button
                        type="button"
                        onClick={() => onSelectChannel?.(ch.id)}
                        onContextMenu={onChannelContextMenu ? (e) => { e.preventDefault(); onChannelContextMenu(ch, e); } : undefined}
                        className={`w-full flex items-center gap-2 ${group.category ? 'pl-4 pr-2.5' : 'px-2.5'} py-1.5 rounded-lg text-left transition-colors ${isActive ? 'bg-fill-active' : 'hover:bg-fill-hover'}`}
                        style={{ fontWeight: (hasMention || hasUnread) ? 600 : 400, opacity: muted && !isActive ? 0.5 : 1 }}
                      >
                        <div className="w-4 h-4 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: isActive ? 'color-mix(in srgb, var(--cyan-accent) 18%, transparent)' : 'var(--fill-hover)' }}>
                          {ch.type === 'forum' ? <ForumIcon size={10} color={isActive ? 'var(--cyan-accent)' : 'var(--text-secondary)'} /> : <Hash size={10} style={{ color: isActive ? 'var(--cyan-accent)' : 'var(--text-secondary)' }} />}
                        </div>
                        <span className="text-sm truncate flex-1" style={{ color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{ch.name}</span>
                        <ChannelNotificationBadge channelId={ch.id} mentionCounts={channelMentionCounts} unreadIds={channelUnreadIds} />
                      </button>
                    </li>
                    {threads.map((thread) => {
                      const isThreadActive = activeThreadId === thread.id;
                      const threadUnread = unreadThreadIds?.has(thread.id);
                      const threadCount = unreadThreadCounts[thread.id] ?? 0;
                      return (
                        <li key={thread.id}>
                          <button
                            type="button"
                            onClick={() => onThreadSelect?.(thread)}
                            className={`w-full flex items-center gap-2 ${group.category ? 'pl-7' : 'pl-5'} pr-2.5 py-1 rounded-lg text-left transition-colors ${isThreadActive ? 'bg-fill-active' : 'hover:bg-fill-hover'}`}
                          >
                            <MessageCirclePlus size={10} className="shrink-0 opacity-50" style={{ color: isThreadActive ? 'var(--cyan-accent)' : 'var(--text-secondary)' }} />
                            <span className="text-xs truncate flex-1" style={{ color: isThreadActive ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>{thread.name}</span>
                            {threadUnread && threadCount > 0 && (
                              <span className="text-[9px] font-bold px-1 py-0.5 rounded-full shrink-0" style={{ backgroundColor: 'var(--cyan-accent)', color: 'var(--text-on-accent)' }}>
                                {threadCount > 99 ? '99+' : threadCount}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                    </React.Fragment>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
};

export const PanelPinnedContent: React.FC<{
  channels: Channel[];
  categories?: ChannelCategory[];
  pinnedChannelIds: string[];
  pinnedCategoryIds?: string[];
  activeChannelId?: string;
  onSelectChannel?: (id: string) => void;
  onJoinVoiceChannel?: (id: string) => void;
  connectedVoiceChannelId?: string | null;
  channelThreads?: Record<string, Thread[]>;
  activeThreadId?: string | null;
  onThreadSelect?: (thread: Thread) => void;
  onChannelContextMenu?: (channel: Channel, e: React.MouseEvent) => void;
  onCategoryContextMenu?: (category: ChannelCategory, e: React.MouseEvent) => void;
}> = ({ channels, categories = [], pinnedChannelIds, pinnedCategoryIds = [], activeChannelId, onSelectChannel, onJoinVoiceChannel, connectedVoiceChannelId, channelThreads = {}, activeThreadId, onThreadSelect, onChannelContextMenu, onCategoryContextMenu }) => {
  const { t } = useTranslation();
  const pinnedChannelSet = useMemo(() => new Set(pinnedChannelIds), [pinnedChannelIds]);
  const pinnedCategorySet = useMemo(() => new Set(pinnedCategoryIds), [pinnedCategoryIds]);
  const channelMentionCounts = useNotificationStore(s => s.channelMentionCounts);
  const channelUnreadIds = useNotificationStore(s => s.channelUnreadIds);

  // Channels from pinned categories (ALL channels in those categories)
  const pinnedCatGroups = useMemo(() => {
    return categories
      .filter(cat => pinnedCategorySet.has(cat.id))
      .map(cat => ({
        category: cat,
        channels: channels.filter(ch => ch.categoryId === cat.id).sort((a, b) => a.position - b.position),
      }))
      .filter(g => g.channels.length > 0);
  }, [categories, channels, pinnedCategorySet]);

  // Channel IDs already covered by pinned categories
  const coveredByPinnedCats = useMemo(() => {
    const ids = new Set<string>();
    for (const g of pinnedCatGroups) for (const ch of g.channels) ids.add(ch.id);
    return ids;
  }, [pinnedCatGroups]);

  // Individually pinned channels NOT already shown via a pinned category
  const individualPinned = useMemo(() => {
    return channels.filter(ch => pinnedChannelSet.has(ch.id) && !coveredByPinnedCats.has(ch.id)).sort((a, b) => a.position - b.position);
  }, [channels, pinnedChannelSet, coveredByPinnedCats]);

  // Group individual pinned channels by their category
  const individualGroups = useMemo(() => {
    const catMap = new Map<string | null, Channel[]>();
    for (const ch of individualPinned) {
      const key = ch.categoryId;
      if (!catMap.has(key)) catMap.set(key, []);
      catMap.get(key)!.push(ch);
    }
    const result: Array<{ category: ChannelCategory | null; channels: Channel[] }> = [];
    const uncat = catMap.get(null) ?? [];
    if (uncat.length > 0) result.push({ category: null, channels: uncat });
    for (const cat of categories) {
      const chs = catMap.get(cat.id);
      if (chs?.length) result.push({ category: cat, channels: chs });
    }
    return result;
  }, [individualPinned, categories]);

  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const toggleCollapse = (id: string) => setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const hasAnything = pinnedCatGroups.length > 0 || individualGroups.length > 0;
  if (!hasAnything) {
    return <p className="px-2 py-4 text-sm" style={S_TEXT_SECONDARY}>{t('channels.noPinnedChannels')}</p>;
  }

  const renderChannel = (ch: Channel, _indent: boolean) => {
    const isVoice = ch.type === 'voice';
    const isStage = ch.type === 'stage';
    const isForum = ch.type === 'forum';
    const isActive = isVoice || isStage ? ch.id === connectedVoiceChannelId : ch.id === activeChannelId;
    const threads = (!isVoice && !isStage ? (channelThreads[ch.id] ?? []).slice(0, 5) : []);
    const muted = isChannelMuted(ch.id);
    const hasMention = !muted && (channelMentionCounts[ch.id] ?? 0) > 0;
    const hasUnread = !muted && channelUnreadIds.has(ch.id);
    return (
      <React.Fragment key={ch.id}>
      <li>
        <button
          type="button"
          onClick={() => isVoice ? onJoinVoiceChannel?.(ch.id) : onSelectChannel?.(ch.id)}
          onContextMenu={onChannelContextMenu ? (e) => { e.preventDefault(); onChannelContextMenu(ch, e); } : undefined}
          className={`w-full flex items-center gap-2 pl-4 pr-2.5 py-1.5 rounded-lg text-left transition-colors ${isActive ? 'bg-fill-active' : 'hover:bg-fill-hover'}`}
          style={{ fontWeight: (hasMention || hasUnread) ? 600 : 400, opacity: muted && !isActive ? 0.5 : 1 }}
        >
          <div className="w-4 h-4 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: isActive ? 'color-mix(in srgb, var(--cyan-accent) 18%, transparent)' : 'var(--fill-hover)' }}>
            {isVoice ? <Volume2 size={10} style={{ color: isActive ? 'var(--cyan-accent)' : 'var(--text-secondary)' }} /> : isStage ? <Radio size={10} style={{ color: isActive ? 'var(--cyan-accent)' : 'var(--text-secondary)' }} /> : isForum ? <ForumIcon size={10} color={isActive ? 'var(--cyan-accent)' : 'var(--text-secondary)'} /> : <Hash size={10} style={{ color: isActive ? 'var(--cyan-accent)' : 'var(--text-secondary)' }} />}
          </div>
          <span className="text-sm truncate flex-1 min-w-0" style={{ color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{ch.name}</span>
          {isVoice && ch.id === connectedVoiceChannelId && (
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" style={{ boxShadow: '0 0 4px rgba(52,211,153,0.5)' }} />
          )}
          <ChannelNotificationBadge channelId={ch.id} mentionCounts={channelMentionCounts} unreadIds={channelUnreadIds} />
          <span className="text-[9px] font-medium uppercase tracking-wider shrink-0" style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>
            {isVoice ? 'Voice' : isStage ? 'Stage' : isForum ? 'Forum' : 'Text'}
          </span>
        </button>
      </li>
      {threads.map((thread) => {
        const isThreadActive = activeThreadId === thread.id;
        return (
          <li key={thread.id}>
            <button
              type="button"
              onClick={() => onThreadSelect?.(thread)}
              className={`w-full flex items-center gap-2 pl-7 pr-2.5 py-1 rounded-lg text-left transition-colors ${isThreadActive ? 'bg-fill-active' : 'hover:bg-fill-hover'}`}
            >
              <MessageCirclePlus size={10} className="shrink-0 opacity-50" style={{ color: isThreadActive ? 'var(--cyan-accent)' : 'var(--text-secondary)' }} />
              <span className="text-xs truncate" style={{ color: isThreadActive ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>{thread.name}</span>
            </button>
          </li>
        );
      })}
      </React.Fragment>
    );
  };

  const renderCatHeader = (cat: ChannelCategory | null, catChannels: Channel[], keyPrefix: string) => {
    const collapseKey = cat ? `${keyPrefix}${cat.id}` : `${keyPrefix}__uncat`;
    const isCollapsed = cat ? collapsed.has(collapseKey) : false;
    return (
      <div key={collapseKey}>
        {cat && (
          <button type="button" onClick={() => toggleCollapse(collapseKey)}
            onContextMenu={onCategoryContextMenu ? (e) => { e.preventDefault(); onCategoryContextMenu(cat, e); } : undefined}
            className="w-full flex items-center gap-1.5 px-2 py-1 text-left">
            <ChevronDown size={8} className={`shrink-0 transition-transform duration-150 ${isCollapsed ? '-rotate-90' : ''}`} style={{ color: 'var(--text-secondary)' }} />
            <span className="text-[9px] font-bold uppercase tracking-wider truncate" style={{ color: 'var(--text-secondary)' }}>{cat.name}</span>
            {isCollapsed && <span className="text-[8px] ml-auto" style={{ color: 'var(--text-tertiary)' }}>{catChannels.length}</span>}
          </button>
        )}
        {!isCollapsed && <ul className="space-y-0.5">{catChannels.map(ch => renderChannel(ch, !!cat))}</ul>}
      </div>
    );
  };

  return (
    <div className="space-y-1">
      {pinnedCatGroups.map(({ category, channels: catChannels }) => renderCatHeader(category, catChannels, 'pcat-'))}
      {pinnedCatGroups.length > 0 && individualGroups.length > 0 && (
        <div className="h-px my-1 mx-1" style={{ backgroundColor: 'var(--border-subtle)' }} />
      )}
      {individualGroups.map(({ category, channels: catChannels }) => renderCatHeader(category, catChannels, 'ind-'))}
    </div>
  );
};

export interface PanelVoiceContentProps {
  connectedVoiceChannel: { id: string; name: string; type: string } | null;
  connectedVoiceServerName: string | null;
  voiceChannelParticipants: Array<{
    id: string;
    username: string;
    discriminator?: string;
    avatar?: string | null;
    // Pro effects — mirrored from voiceStore.VoiceParticipantInfo so the
    // voice panel reflects what's shown in the call itself.
    nameColor?: string;
    nameFont?: string;
    nameEffect?: string;
    avatarEffect?: string;
    effectivePlan?: string;
    roleColor?: string;
    roleStyle?: string;
    // Mute/deafen — surfaced as an avatar overlay matching the call cards.
    isMuted?: boolean;
    isDeafened?: boolean;
    serverMuted?: boolean;
    serverDeafened?: boolean;
  }>;
  onLeaveVoiceChannel?: () => void;
  onSwitchVoiceChannel?: (channelId: string) => void;
  voiceSwitcherOpen: boolean;
  setVoiceSwitcherOpen: React.Dispatch<React.SetStateAction<boolean>>;
  voiceSwitcherRef: React.RefObject<HTMLDivElement | null>;
  voiceSwitcherTriggerRef: React.RefObject<HTMLDivElement | null>;
  switcherServerId: string | null;
  setSwitcherServerId: React.Dispatch<React.SetStateAction<string | null>>;
  servers: Server[];
  allVoiceParticipants: Record<string, Array<{ id: string; username: string; discriminator?: string; avatar?: string }>>;
  onUserClick?: (user: any, event: React.MouseEvent) => void;
  onUserRightClick?: (user: any, event: React.MouseEvent) => void;
  currentUserId?: string;
  t: (key: string, options?: Record<string, string | number>) => string;
}

export const PanelVoiceContent: React.FC<PanelVoiceContentProps> = ({
  connectedVoiceChannel,
  connectedVoiceServerName,
  voiceChannelParticipants,
  onLeaveVoiceChannel,
  onSwitchVoiceChannel,
  voiceSwitcherOpen,
  setVoiceSwitcherOpen,
  voiceSwitcherRef,
  voiceSwitcherTriggerRef,
  switcherServerId,
  setSwitcherServerId,
  servers,
  allVoiceParticipants,
  onUserClick,
  onUserRightClick,
  currentUserId,
  t,
}) => {
  if (!connectedVoiceChannel) {
    return (
      <div className="px-2">
        <div ref={(el) => { (voiceSwitcherRef as React.MutableRefObject<HTMLDivElement | null>).current = el; (voiceSwitcherTriggerRef as React.MutableRefObject<HTMLDivElement | null>).current = el; }} className="relative">
          <button
            type="button"
            onClick={() => onSwitchVoiceChannel && setVoiceSwitcherOpen((o) => !o)}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors"
            style={{ backgroundColor: 'var(--accent-subtle)' }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--accent-muted)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--accent-subtle)'; }}
          >
            <div className="w-4 h-4 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: 'var(--accent-muted)' }}>
              <Volume2 size={10} style={{ color: 'var(--cyan-accent)' }} />
            </div>
            <span className="text-sm italic flex-1 truncate" style={{ color: 'var(--cyan-accent)', fontWeight: 500 }}>{t('chat.joinVoiceChannel')}</span>
            {onSwitchVoiceChannel && (
              <ChevronDown size={12} className={`ml-auto shrink-0 transition-transform duration-150 ${voiceSwitcherOpen ? 'rotate-180' : ''}`} style={{ color: 'var(--cyan-accent)', opacity: 0.7 }} />
            )}
          </button>

          {voiceSwitcherOpen && onSwitchVoiceChannel && createPortal(
            <div
              id="voice-switcher-portal"
              className="rounded-2xl border shadow-2xl spring-pop-in"
              style={{
                position: 'fixed',
                top: (voiceSwitcherTriggerRef.current?.getBoundingClientRect().bottom ?? 0) + 6,
                left: voiceSwitcherTriggerRef.current?.getBoundingClientRect().left ?? 0,
                width: voiceSwitcherTriggerRef.current?.getBoundingClientRect().width ?? 200,
                zIndex: 'var(--z-max)' as unknown as number,
                ...GLASS_DROPDOWN_STYLE,
              }}
            >
              {!switcherServerId && (
                <>
                  <div className="px-3 pt-2.5 pb-1">
                    <p className="text-[10px] font-bold uppercase tracking-widest" style={S_TEXT_SECONDARY}>{t('chat.selectServer')}</p>
                  </div>
                  <div className="max-h-64 overflow-y-auto pb-2">
                    {servers.filter(s => s.channels.some(c => c.type === 'voice')).map((server) => {
                      const voiceCount = server.channels.filter(c => c.type === 'voice').length;
                      const activeCount = server.channels.filter(c => c.type === 'voice' && (allVoiceParticipants[c.id]?.length ?? 0) > 0).length;
                      return (
                        <button
                          key={server.id}
                          type="button"
                          onClick={() => setSwitcherServerId(server.id)}
                          className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-fill-hover"
                        >
                          <div className="w-8 h-8 rounded-lg shrink-0 overflow-hidden">
                            <ServerIcon icon={server.icon} name={server.name} size={32} className="w-full h-full rounded-lg" />
                          </div>
                          <div className="flex flex-col min-w-0 flex-1">
                            <span className="text-sm font-semibold truncate" style={S_TEXT_PRIMARY}>{server.name}</span>
                            <span className="text-[10px]" style={S_TEXT_SECONDARY}>
                              {voiceCount === 1 ? t('chat.voiceChannelCount', { count: voiceCount }) : t('chat.voiceChannelCountPlural', { count: voiceCount })}
                              {activeCount > 0 && <span className="text-emerald-400 ml-1">{t('chat.activeCount', { count: activeCount })}</span>}
                            </span>
                          </div>
                          <ChevronRight size={14} className="shrink-0 opacity-40" />
                        </button>
                      );
                    })}
                    {servers.every(s => !s.channels.some(c => c.type === 'voice')) && (
                      <p className="px-3 py-3 text-xs" style={S_TEXT_SECONDARY}>{t('chat.noVoiceChannels')}</p>
                    )}
                  </div>
                </>
              )}
              {switcherServerId && (() => {
                const server = servers.find(s => s.id === switcherServerId);
                if (!server) return null;
                const voiceChannels = server.channels.filter(c => c.type === 'voice');
                return (
                  <>
                    <div className="flex items-center gap-2 px-2 pt-2 pb-1 border-b border-default">
                      <button type="button" onClick={() => setSwitcherServerId(null)} className="p-1 rounded-lg hover:bg-fill-active transition-colors" title={t('common.back')}>
                        <ChevronDown size={13} className="rotate-90" style={S_TEXT_SECONDARY} />
                      </button>
                      <div className="w-5 h-5 rounded-lg shrink-0 overflow-hidden">
                        <ServerIcon icon={server.icon} name={server.name} size={20} className="w-full h-full rounded-lg" />
                      </div>
                      <span className="text-xs font-bold truncate" style={S_TEXT_PRIMARY}>{server.name}</span>
                    </div>
                    <div className="max-h-72 overflow-y-auto pb-2">
                      {voiceChannels.map((vc) => {
                        const participants = allVoiceParticipants[vc.id] ?? [];
                        return (
                          <div key={vc.id}>
                            <button
                              type="button"
                              onClick={() => { if (onSwitchVoiceChannel) onSwitchVoiceChannel(vc.id); setVoiceSwitcherOpen(false); }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-fill-hover"
                            >
                              <Volume2 size={13} className="shrink-0 opacity-50" style={{ color: 'var(--text-secondary)' }} />
                              <span className="text-sm font-medium flex-1 truncate" style={S_TEXT_PRIMARY}>{vc.name}</span>
                              {participants.length > 0 && (
                                <span className="text-[10px] text-emerald-400 shrink-0">{t('chat.participantsInCall', { count: participants.length })}</span>
                              )}
                            </button>
                            {participants.length > 0 && (
                              <div className="flex items-center gap-1.5 px-4 pt-0.5 pb-2 flex-wrap">
                                {participants.slice(0, 8).map((p) => (
                                  <UserAvatar key={p.id} user={p} size={20} className="group/tip">
                                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-1.5 py-0.5 rounded-lg bg-black/80 text-[9px] text-white whitespace-nowrap opacity-0 group-hover/tip:opacity-100 pointer-events-none transition-opacity z-10">
                                      {p.username}
                                    </div>
                                  </UserAvatar>
                                ))}
                                {participants.length > 8 && (
                                  <span className="text-[10px]" style={S_TEXT_SECONDARY}>+{participants.length - 8}</span>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                );
              })()}
            </div>
          , document.body)}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col h-full min-h-0">
      <div ref={(el) => { (voiceSwitcherRef as React.MutableRefObject<HTMLDivElement | null>).current = el; (voiceSwitcherTriggerRef as React.MutableRefObject<HTMLDivElement | null>).current = el; }} className="relative mb-2 shrink-0">
        {/* Connected pill — shares surface shape with the disconnected Join button
            (accent-subtle + cyan-accent text + accent-muted icon tile) so the two
            states read as the same object across connect/disconnect transitions.
            Connected-state signaled by the pulsing emerald dot overlaid on the
            icon tile, cyan border, and server/channel two-line text. */}
        <div
          className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-colors"
          style={{
            backgroundColor: 'var(--accent-subtle)',
            border: '1px solid color-mix(in srgb, var(--cyan-accent) 18%, transparent)',
          }}
        >
          <div
            className="relative shrink-0 flex items-center justify-center"
            style={{ width: 18, height: 18, borderRadius: 12, backgroundColor: 'var(--accent-muted)' }}
          >
            <Volume2 size={11} style={{ color: 'var(--cyan-accent)' }} />
            <span
              className="absolute rounded-full bg-emerald-400 animate-pulse"
              style={{ width: 5, height: 5, top: -1, right: -1, boxShadow: '0 0 6px rgba(52,211,153,0.6)' }}
              aria-hidden
            />
          </div>
          <button
            type="button"
            onClick={() => onSwitchVoiceChannel && setVoiceSwitcherOpen((o) => !o)}
            className={`flex-1 min-w-0 flex items-center gap-1 text-left rounded-lg transition-colors ${onSwitchVoiceChannel ? 'cursor-pointer' : 'cursor-default'}`}
            title={onSwitchVoiceChannel ? t('chat.switchVoiceChannel') : undefined}
          >
            <div className="flex flex-col gap-0.5 min-w-0 flex-1">
              {connectedVoiceServerName && (
                <span
                  className="text-[9px] font-semibold uppercase tracking-wider truncate"
                  style={{ color: 'var(--cyan-accent)', opacity: 0.65 }}
                >
                  {connectedVoiceServerName}
                </span>
              )}
              <span className="text-sm italic truncate" style={{ color: 'var(--cyan-accent)', fontWeight: 500 }}>
                {connectedVoiceChannel.name}
              </span>
            </div>
            {onSwitchVoiceChannel && (
              <ChevronDown
                size={12}
                className={`shrink-0 transition-transform duration-150 ${voiceSwitcherOpen ? 'rotate-180' : ''}`}
                style={{ color: 'var(--cyan-accent)', opacity: 0.7 }}
              />
            )}
          </button>
          {onLeaveVoiceChannel && (
            <>
              <span
                className="shrink-0"
                style={{
                  width: 1,
                  height: 14,
                  backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 20%, transparent)',
                }}
                aria-hidden
              />
              <button
                type="button"
                onClick={onLeaveVoiceChannel}
                className="shrink-0 p-1 min-w-[32px] min-h-[32px] flex items-center justify-center rounded-lg hover:bg-red-500/20 text-red-400/90 hover:text-red-400 transition-colors focus:outline-none focus:ring-1 focus:ring-red-500/50"
                title={t('chat.leaveVoiceChannel')}
              >
                <PhoneOff size={14} />
              </button>
            </>
          )}
        </div>

        {voiceSwitcherOpen && onSwitchVoiceChannel && createPortal(
          <div
            id="voice-switcher-portal"
            className="rounded-2xl border shadow-2xl spring-pop-in"
            style={{
              position: 'fixed',
              top: (voiceSwitcherTriggerRef.current?.getBoundingClientRect().bottom ?? 0) + 6,
              left: voiceSwitcherTriggerRef.current?.getBoundingClientRect().left ?? 0,
              width: voiceSwitcherTriggerRef.current?.getBoundingClientRect().width ?? 200,
              zIndex: 'var(--z-max)' as unknown as number,
              ...GLASS_DROPDOWN_STYLE,
            }}
          >
            {!switcherServerId && (
              <>
                <div className="px-3 pt-2.5 pb-1">
                  <p className="text-[10px] font-bold uppercase tracking-widest" style={S_TEXT_SECONDARY}>{t('chat.selectServer')}</p>
                </div>
                <div className="max-h-64 overflow-y-auto pb-2">
                  {servers.filter(s => s.channels.some(c => c.type === 'voice')).map((server) => {
                    const voiceCount = server.channels.filter(c => c.type === 'voice').length;
                    const activeCount = server.channels.filter(c => c.type === 'voice' && (allVoiceParticipants[c.id]?.length ?? 0) > 0).length;
                    return (
                      <button
                        key={server.id}
                        type="button"
                        onClick={() => setSwitcherServerId(server.id)}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-fill-hover"
                      >
                        <div className="w-8 h-8 rounded-lg shrink-0 overflow-hidden">
                          <ServerIcon icon={server.icon} name={server.name} size={32} className="w-full h-full rounded-lg" />
                        </div>
                        <div className="flex flex-col min-w-0 flex-1">
                          <span className="text-sm font-semibold truncate" style={S_TEXT_PRIMARY}>{server.name}</span>
                          <span className="text-[10px]" style={S_TEXT_SECONDARY}>
                            {voiceCount === 1 ? t('chat.voiceChannelCount', { count: voiceCount }) : t('chat.voiceChannelCountPlural', { count: voiceCount })}
                            {activeCount > 0 && <span className="text-emerald-400 ml-1">{t('chat.activeCount', { count: activeCount })}</span>}
                          </span>
                        </div>
                        <ChevronRight size={14} className="shrink-0 opacity-40" />
                      </button>
                    );
                  })}
                  {servers.every(s => !s.channels.some(c => c.type === 'voice')) && (
                    <p className="px-3 py-3 text-xs" style={S_TEXT_SECONDARY}>{t('chat.noVoiceChannels')}</p>
                  )}
                </div>
              </>
            )}
            {switcherServerId && (() => {
              const server = servers.find(s => s.id === switcherServerId);
              if (!server) return null;
              const voiceChannels = server.channels.filter(c => c.type === 'voice');
              return (
                <>
                  <div className="flex items-center gap-2 px-2 pt-2 pb-1 border-b border-default">
                    <button type="button" onClick={() => setSwitcherServerId(null)} className="p-1 rounded-lg hover:bg-fill-active transition-colors" title={t('common.back')}>
                      <ChevronDown size={13} className="rotate-90" style={S_TEXT_SECONDARY} />
                    </button>
                    <div className="w-5 h-5 rounded-lg shrink-0 overflow-hidden">
                      <ServerIcon icon={server.icon} name={server.name} size={20} className="w-full h-full rounded-lg" />
                    </div>
                    <span className="text-xs font-bold truncate" style={S_TEXT_PRIMARY}>{server.name}</span>
                  </div>
                  <div className="max-h-72 overflow-y-auto pb-2">
                    {voiceChannels.map((vc) => {
                      const isCurrent = vc.id === connectedVoiceChannel?.id;
                      const participants = allVoiceParticipants[vc.id] ?? [];
                      return (
                        <div key={vc.id}>
                          <button
                            type="button"
                            onClick={() => { if (!isCurrent && onSwitchVoiceChannel) onSwitchVoiceChannel(vc.id); setVoiceSwitcherOpen(false); }}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${isCurrent ? 'bg-[var(--cyan-accent)]/10' : 'hover:bg-fill-hover'}`}
                          >
                            <Volume2 size={13} className={`shrink-0 ${isCurrent ? 'text-[var(--cyan-accent)]' : 'opacity-50'}`} style={{ color: isCurrent ? undefined : 'var(--text-secondary)' }} />
                            <span className={`text-sm font-medium flex-1 truncate ${isCurrent ? 'text-[var(--cyan-accent)]' : ''}`} style={{ color: isCurrent ? undefined : 'var(--text-primary)' }}>
                              {vc.name}
                            </span>
                            {participants.length > 0 && (
                              <span className="text-[10px] text-emerald-400 shrink-0">{t('chat.participantsInCall', { count: participants.length })}</span>
                            )}
                          </button>
                          {participants.length > 0 && (
                            <div className="flex items-center gap-1.5 px-4 pt-0.5 pb-2 flex-wrap">
                              {participants.slice(0, 8).map((p) => (
                                <UserAvatar key={p.id} user={p} size={20} className="group/tip">
                                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-1.5 py-0.5 rounded-lg bg-black/80 text-[9px] text-white whitespace-nowrap opacity-0 group-hover/tip:opacity-100 pointer-events-none transition-opacity z-10">
                                    {p.username}
                                  </div>
                                </UserAvatar>
                              ))}
                              {participants.length > 8 && (
                                <span className="text-[10px]" style={S_TEXT_SECONDARY}>+{participants.length - 8}</span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })()}
          </div>
        , document.body)}
      </div>
      <div className="text-[10px] font-semibold uppercase tracking-wider px-2 mb-1 flex items-center gap-1.5 shrink-0" style={S_TEXT_SECONDARY}>
        <span>{t('chat.inChannel')}</span>
        {voiceChannelParticipants.length > 0 && (
          <span style={{ opacity: 0.6 }}>· {voiceChannelParticipants.length}</span>
        )}
      </div>
      {voiceChannelParticipants.length > 0 ? (
        // Participant list fills remaining space and scrolls. The flex-1 +
        // min-h-0 combination is required so the list can shrink past its
        // content size (without it the list would push past the panel into
        // the typing area below).
        <div className="flex-1 min-h-0 overflow-y-auto">
          <ul className="space-y-0.5">
            {voiceChannelParticipants.map((p) => {
              const participantAsUser = { id: p.id, username: p.username, discriminator: p.discriminator, avatar: p.avatar ?? null, status: 'online' as const };
              const isClickable = !!(onUserClick || onUserRightClick);
              const isPro = p.effectivePlan === 'pro' || p.effectivePlan === 'essential';
              const avatarEffectCls = isPro ? getAvatarEffectClass(p.avatarEffect) : '';
              const nameNode = (p.nameColor || p.nameFont || p.nameEffect || p.roleColor) ? (
                <RoleNameStyle
                  name={p.username}
                  color={p.roleColor}
                  style={(p.roleStyle as RoleStyle | undefined) ?? 'solid'}
                  overrideColor={p.nameColor}
                  overrideFont={p.nameFont}
                  nameEffect={p.nameEffect}
                  className="text-sm truncate"
                />
              ) : (
                <span className="text-sm truncate">{p.username}</span>
              );
              const muted = hasMuteState(p);
              const avatarNode = (
                <div className={`shrink-0 rounded-[var(--radius-lg)] overflow-visible relative ${avatarEffectCls}`} style={{ width: 24, height: 24 }}>
                  <LetterAvatar avatar={p.avatar} username={p.username} size={24} className={`rounded-full ${muted ? 'opacity-60' : ''}`} />
                  <VoiceMuteOverlay
                    isMuted={p.isMuted}
                    isDeafened={p.isDeafened}
                    serverMuted={p.serverMuted}
                    serverDeafened={p.serverDeafened}
                    size={12}
                  />
                </div>
              );
              const innerRow = (
                <>
                  {avatarNode}
                  {nameNode}
                  {p.id === currentUserId && (
                    <span className="text-[8px] font-bold shrink-0 px-1.5 py-0.5 rounded-lg" style={{ backgroundColor: 'rgba(52,211,153,0.1)', color: '#34d399' }}>YOU</span>
                  )}
                  <span className="ml-auto flex items-center shrink-0">
                    <PanelSpeakingBar userId={p.id} isCurrentUser={p.id === currentUserId} />
                  </span>
                </>
              );
              // Bare row — no border / no glass surface. Hover-only fill matches
              // the text channel list above for a unified sidebar aesthetic.
              return (
                <li key={p.id}>
                  {isClickable ? (
                    <button
                      type="button"
                      onClick={(e) => onUserClick?.(participantAsUser, e)}
                      onContextMenu={(e) => { e.preventDefault(); onUserRightClick?.(participantAsUser, e); }}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors hover:bg-fill-hover focus:outline-none focus:ring-1 focus:ring-[var(--cyan-accent)]/30"
                    >
                      {innerRow}
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg">
                      {innerRow}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="px-2 pt-3 pb-2 text-xs text-center shrink-0" style={S_TEXT_SECONDARY}>{t('chat.noOneInChannel')}</p>
      )}
    </div>
  );
};
