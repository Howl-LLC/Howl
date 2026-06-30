// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Star, Mic, Radio, Volume2 } from 'lucide-react';
import { User, Server } from '../types';
import { LetterAvatar } from './LetterAvatar';
import { ServerIcon } from './ServerIcon';
import { RoleNameStyle } from './RoleNameStyle';
import { getAvatarEffectClass } from '../shared/planPerks';
import { useIsMobile } from '../hooks/useIsMobile';
import { scheduleSyncToServer } from '../utils/settingsSync';

type VoiceParticipantInfo = {
  userId: string;
  username: string;
  avatar?: string;
  nameColor?: string;
  nameFont?: string;
  nameEffect?: string;
  avatarEffect?: string;
  effectivePlan?: string;
  roleColor?: string;
  roleStyle?: string;
};

interface ServerActivityPanelProps {
  servers: Server[];
  friends: User[];
  serverVoiceSummary: Record<string, Record<string, VoiceParticipantInfo[]>>;
  serverStageSummary: Record<string, Record<string, VoiceParticipantInfo[]>>;
  onServerClick: (serverId: string) => void;
  onUserClick: (user: User, e: React.MouseEvent) => void;
  onUserRightClick: (user: User, e: React.MouseEvent) => void;
}

const STORAGE_KEY = 'howl_pinned_activity_servers';

function readPinnedIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

interface ChannelActivity {
  channelId: string;
  channelName: string;
  channelType: 'voice' | 'stage';
  friends: VoiceParticipantInfo[];
}

interface ServerActivity {
  server: Server;
  channels: ChannelActivity[];
}

const ServerActivityPanel: React.FC<ServerActivityPanelProps> = React.memo(({
  servers,
  friends,
  serverVoiceSummary,
  serverStageSummary,
  onServerClick,
  onUserClick,
  onUserRightClick,
}) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [pinnedIds, setPinnedIds] = useState<string[]>(readPinnedIds);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const starBtnRef = useRef<HTMLDivElement>(null);

  if (isMobile) return null;

  const friendIdSet = useMemo(() => new Set(friends.map(f => f.id)), [friends]);

  const friendMap = useMemo(() => {
    const m = new Map<string, User>();
    for (const f of friends) m.set(f.id, f);
    return m;
  }, [friends]);

  const pinnedSet = useMemo(() => {
    const validIds = new Set(servers.map(s => s.id));
    return new Set(pinnedIds.filter(id => validIds.has(id)));
  }, [pinnedIds, servers]);

  // Clean stale pin IDs when servers change
  useEffect(() => {
    if (servers.length === 0) return;
    const validIds = new Set(servers.map(s => s.id));
    setPinnedIds(prev => {
      const cleaned = prev.filter(id => validIds.has(id));
      if (cleaned.length !== prev.length) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
        scheduleSyncToServer();
      }
      return cleaned.length !== prev.length ? cleaned : prev;
    });
  }, [servers]);

  const { pinnedServers, activeServers } = useMemo(() => {
    const pinned: ServerActivity[] = [];
    const active: ServerActivity[] = [];

    for (const server of servers) {
      const channels: ChannelActivity[] = [];

      // Voice channels
      const voiceData = serverVoiceSummary[server.id];
      if (voiceData) {
        for (const [channelId, participants] of Object.entries(voiceData)) {
          const friendsInChannel = participants.filter(p => friendIdSet.has(p.userId));
          if (friendsInChannel.length > 0) {
            const channel = server.channels.find(c => c.id === channelId && c.type === 'voice');
            channels.push({
              channelId,
              channelName: channel?.name ?? 'Voice Channel',
              channelType: 'voice',
              friends: friendsInChannel,
            });
          }
        }
      }

      // Stage channels
      const stageData = serverStageSummary[server.id];
      if (stageData) {
        for (const [channelId, participants] of Object.entries(stageData)) {
          const friendsInChannel = participants.filter(p => friendIdSet.has(p.userId));
          if (friendsInChannel.length > 0) {
            const channel = server.channels.find(c => c.id === channelId && c.type === 'stage');
            channels.push({
              channelId,
              channelName: channel?.name ?? 'Stage',
              channelType: 'stage',
              friends: friendsInChannel,
            });
          }
        }
      }

      const isPinned = pinnedSet.has(server.id);
      if (isPinned) {
        pinned.push({ server, channels });
      } else if (channels.length > 0) {
        active.push({ server, channels });
      }
    }

    pinned.sort((a, b) => a.server.name.localeCompare(b.server.name));
    active.sort((a, b) => a.server.name.localeCompare(b.server.name));

    return { pinnedServers: pinned, activeServers: active };
  }, [servers, serverVoiceSummary, serverStageSummary, friendIdSet, pinnedSet]);

  const togglePin = useCallback((serverId: string) => {
    setPinnedIds(prev => {
      const next = prev.includes(serverId)
        ? prev.filter(id => id !== serverId)
        : [...prev, serverId];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      scheduleSyncToServer();
      return next;
    });
  }, []);

  // Close popover on outside click or Escape
  useEffect(() => {
    if (!popoverOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        starBtnRef.current && !starBtnRef.current.contains(e.target as Node)
      ) {
        setPopoverOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopoverOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [popoverOpen]);

  const hasPinned = pinnedSet.size > 0;
  const isEmpty = pinnedServers.length === 0 && activeServers.length === 0;

  const sortedServersForPopover = useMemo(
    () => [...servers].sort((a, b) => a.name.localeCompare(b.name)),
    [servers],
  );

  const handleActivate = useCallback((e: React.KeyboardEvent, action: () => void) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      action();
    }
  }, []);

  return (
    <div className="w-[280px] xl:w-[320px] 2xl:w-[360px] shrink-0 p-4 pl-0 self-stretch animate-in fade-in duration-300" aria-label={t('serverActivity.ariaLabel', 'Server activity')}>
      <div className="relative rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-[12px] saturate-[1.1] flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center justify-between px-3 pt-3 pb-2">
          <span className="text-[12px] font-bold text-t-primary">{t('serverActivity.title', 'Server Activity')}</span>
          <div
            ref={starBtnRef}
            role="button"
            tabIndex={0}
            onClick={() => setPopoverOpen(v => !v)}
            onKeyDown={(e) => handleActivate(e, () => setPopoverOpen(v => !v))}
            className="p-1 rounded-md hover:bg-fill-hover cursor-pointer transition-colors duration-150"
            aria-label={t('serverActivity.managePins', 'Manage pinned servers')}
          >
            <Star
              size={14}
              className={`transition-colors duration-150 ${
                popoverOpen
                  ? 'text-[var(--cyan-accent)] fill-[var(--cyan-accent)]'
                  : hasPinned
                    ? 'text-[var(--cyan-accent)] fill-[var(--cyan-accent)] opacity-60'
                    : 'text-[var(--text-secondary)]'
              }`}
            />
          </div>
        </div>

        {/* Pin manager popover */}
        {popoverOpen && (
          <div
            ref={popoverRef}
            className="absolute top-10 right-2 z-10 w-[220px] max-h-[280px] rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-[16px] saturate-[1.1] shadow-2xl animate-[spring-pop-in_180ms_ease-out] flex flex-col"
          >
            <div
              className="overflow-y-auto py-1.5 no-scrollbar"
              style={{ maskImage: 'linear-gradient(to bottom, transparent, black 8px, black calc(100% - 8px), transparent)' }}
            >
              {sortedServersForPopover.map(server => {
                const isPinned = pinnedSet.has(server.id);
                return (
                  <div
                    key={server.id}
                    className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-fill-hover cursor-pointer"
                    role="switch"
                    aria-checked={isPinned}
                    aria-label={t('serverActivity.togglePin', { name: server.name, defaultValue: `Toggle pin for ${server.name}` })}
                    tabIndex={0}
                    onClick={() => togglePin(server.id)}
                    onKeyDown={(e) => handleActivate(e, () => togglePin(server.id))}
                  >
                    <ServerIcon icon={server.icon} name={server.name} size={24} className="rounded-lg shrink-0" />
                    <span className="text-[11px] font-medium text-[var(--text-primary)] truncate flex-1">{server.name}</span>
                    <div className={`w-7 h-4 rounded-full flex items-center transition-colors duration-150 ${isPinned ? 'bg-[var(--cyan-accent)]' : 'bg-fill-active'}`}>
                      <div className={`w-3 h-3 rounded-full bg-white shadow-sm transition-all duration-150 ${isPinned ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1.5 overscroll-contain no-scrollbar" style={{ maxHeight: 'calc(100vh - 200px)' }}>
          {isEmpty ? (
            <div className="flex flex-col items-center justify-center py-8 gap-2">
              <div className="w-10 h-10 rounded-full bg-fill-hover flex items-center justify-center">
                <Volume2 size={18} className="text-t-secondary" />
              </div>
              <span className="text-[11px] text-[var(--text-secondary)] opacity-60">{t('serverActivity.noActivity', 'No friend activity')}</span>
              <span className="text-[10px] text-[var(--text-secondary)] opacity-40 text-center px-4">
                {t('serverActivity.noActivityDescription', 'Friends in voice channels will appear here')}
              </span>
            </div>
          ) : (
            <>
              {/* Pinned servers */}
              {pinnedServers.map(({ server, channels }) => (
                <ServerCard
                  key={server.id}
                  server={server}
                  channels={channels}
                  pinned
                  friendMap={friendMap}
                  onServerClick={onServerClick}
                  onUserClick={onUserClick}
                  onUserRightClick={onUserRightClick}
                  onActivate={handleActivate}
                />
              ))}

              {/* Divider */}
              {pinnedServers.length > 0 && activeServers.length > 0 && (
                <div className="h-px bg-fill-hover mx-1" />
              )}

              {/* Active (unpinned) servers */}
              {activeServers.map(({ server, channels }) => (
                <ServerCard
                  key={server.id}
                  server={server}
                  channels={channels}
                  pinned={false}
                  friendMap={friendMap}
                  onServerClick={onServerClick}
                  onUserClick={onUserClick}
                  onUserRightClick={onUserRightClick}
                  onActivate={handleActivate}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
});

/* ---------- Server Card ---------- */

interface ServerCardProps {
  server: Server;
  channels: ChannelActivity[];
  pinned: boolean;
  friendMap: Map<string, User>;
  onServerClick: (serverId: string) => void;
  onUserClick: (user: User, e: React.MouseEvent) => void;
  onUserRightClick: (user: User, e: React.MouseEvent) => void;
  onActivate: (e: React.KeyboardEvent, action: () => void) => void;
}

const ServerCard: React.FC<ServerCardProps> = React.memo(({
  server,
  channels,
  pinned,
  friendMap,
  onServerClick,
  onUserClick,
  onUserRightClick,
  onActivate,
}) => {
  const { t } = useTranslation();

  return (
    <div className="bg-fill-hover border border-default rounded-lg p-[10px] animate-in fade-in duration-200">
      {/* Server header */}
      <div
        className="flex items-center gap-2 cursor-pointer group"
        role="button"
        tabIndex={0}
        onClick={() => onServerClick(server.id)}
        onKeyDown={(e) => onActivate(e, () => onServerClick(server.id))}
      >
        <ServerIcon icon={server.icon} name={server.name} size={26} className="rounded-lg shrink-0" />
        <span className="text-[11px] font-bold text-t-primary truncate flex-1 group-hover:text-[var(--cyan-accent)] transition-colors duration-150">
          {server.name}
        </span>
        {pinned && <Star size={12} className="text-[var(--cyan-accent)] fill-[var(--cyan-accent)] shrink-0" />}
      </div>

      {/* Voice & stage channels */}
      {channels.length === 0 ? (
        <p className="text-[10px] italic text-[var(--text-secondary)] opacity-40 mt-1.5 ml-1">
          {t('serverActivity.noFriendsInVoice', 'No friends in voice')}
        </p>
      ) : (
        <div className="mt-1.5 space-y-1.5">
          {channels.map(({ channelId, channelName, channelType, friends: channelFriends }) => (
            <div key={channelId}>
              <div className="flex items-center gap-1 mb-0.5">
                {channelType === 'stage'
                  ? <Radio size={11} className="text-[var(--text-secondary)] opacity-60 shrink-0" />
                  : <Mic size={11} className="text-[var(--text-secondary)] opacity-60 shrink-0" />
                }
                <span className="text-[10px] font-semibold text-[var(--text-secondary)] opacity-70 truncate">
                  {channelName}
                </span>
              </div>
              <div className="space-y-0.5 ml-0.5">
                {channelFriends.map(participant => {
                  const fullUser = friendMap.get(participant.userId);
                  return (
                    <div
                      key={participant.userId}
                      className="flex items-center gap-1.5 py-0.5 px-1 rounded-md hover:bg-fill-hover cursor-pointer transition-colors duration-100"
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        if (fullUser) onUserClick(fullUser, e);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        if (fullUser) onUserRightClick(fullUser, e);
                      }}
                      onKeyDown={(e) => {
                        if (fullUser && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          const rect = e.currentTarget.getBoundingClientRect();
                          const synth = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
                          onUserClick(fullUser, synth as unknown as React.MouseEvent);
                        }
                      }}
                    >
                      <LetterAvatar
                        avatar={participant.avatar ?? null}
                        username={participant.username}
                        size={20}
                        className={`rounded-full shrink-0 ${(participant.effectivePlan === 'pro' || participant.effectivePlan === 'essential') && participant.avatarEffect ? getAvatarEffectClass(participant.avatarEffect) : ''}`}
                      />
                      <span className="text-[11px] font-semibold text-t-primary truncate">
                        {(() => {
                          const isPro = participant.effectivePlan === 'pro' || participant.effectivePlan === 'essential';
                          const hasProStyle = isPro && (participant.nameColor || participant.nameFont || participant.nameEffect);
                          if (hasProStyle) return <RoleNameStyle name={participant.username} overrideColor={participant.nameColor} overrideFont={participant.nameFont} nameEffect={participant.nameEffect} />;
                          return participant.username;
                        })()}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

ServerActivityPanel.displayName = 'ServerActivityPanel';
ServerCard.displayName = 'ServerCard';

export { ServerActivityPanel };
