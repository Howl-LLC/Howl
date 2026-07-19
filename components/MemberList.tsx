// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useMemo, useState, useCallback } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { User } from '../types';
import { Crown, ChevronUp, ChevronDown, Users, Gamepad2, Music, Activity } from 'lucide-react';
import { RoleNameStyle } from './RoleNameStyle';
import type { RoleStyle } from './RoleNameStyle';
import type { UserWithRole } from './UserProfilePopup';
import { useLongPress } from '../hooks/useLongPress';
import { getAvatarEffectClass } from '../shared/planPerks';
import { useTranslation } from 'react-i18next';
import { LetterAvatar } from './LetterAvatar';
import { isValidCssColor } from '../utils/securityUtils';
import { useServerStore } from '../stores/serverStore';
import { useTypingStore } from '../stores/typingStore';
import { useNavigationStore } from '../stores/navigationStore';
import { TypingStatusDot } from './TypingStatusDot';

function ActivityIcon({ type, size }: { type: string; size: number }) {
  switch (type) {
    case 'spotify':
    case 'listening':
      return <Music size={size} />;
    case 'bio':
      return null;
    case 'twitch_live':
    case 'youtube_live':
      return <span className="inline-block rounded-full bg-red-500 animate-pulse" style={{ width: size, height: size }} />;
    case 'steam_game':
    case 'detected_game':
    case 'custom':
      return <Gamepad2 size={size} />;
    default:
      return <Activity size={size} />;
  }
}

export type MemberWithRole = User & {
  role?: string;
  roleColor?: string | null;
  roleStyle?: RoleStyle;
  /** Multi-role array surfaced by the API. The grouping logic uses
   *  `displaySeparately` here to decide which section a member hoists into. */
  roles?: Array<{ id?: string; name: string; color?: string; style?: string; position?: number; displaySeparately?: boolean }>;
  serverAvatar?: string | null;
  serverBanner?: string | null;
};

const EMPTY_MEMBERS: (User | MemberWithRole)[] = [];

interface MemberListProps {
  /** When provided, overrides the store-derived members (used in DM / popover contexts). */
  members?: (User | MemberWithRole)[];
  /** When provided, overrides the store-derived ownerId (used in DM / popover contexts). */
  ownerId?: string;
  /** When provided, typing dot looks at typingByChannel[typingChannelId] instead of typingByServer[activeServerId] — used for group DMs where activeServerId === 'home'. */
  typingChannelId?: string;
  onMemberClick?: (member: UserWithRole, e: React.MouseEvent) => void;
  onMemberRightClick?: (member: UserWithRole, e: React.MouseEvent) => void;
  embedded?: boolean;
  uiDensity?: 'compact' | 'default' | 'spacious';
  roleColorMode?: 'in-names' | 'next-to-names' | 'hidden';
}

export const MemberList: React.FC<MemberListProps> = ({ members: membersProp, ownerId: ownerIdProp, typingChannelId, onMemberClick, onMemberRightClick, embedded, uiDensity = 'default', roleColorMode = 'in-names' }) => {
  const { t } = useTranslation();

  // Store selectors — used as fallback when props aren't provided (server context)
  const storeMembers = useServerStore(s => s.serverMembers);
  const storeOwnerId = useServerStore(s => s.serverOwnerId);
  const members = membersProp ?? (storeMembers.length > 0 ? storeMembers : EMPTY_MEMBERS);
  const ownerId = ownerIdProp ?? storeOwnerId ?? undefined;
  const d = uiDensity;
  const headerPy = d === 'compact' ? 'py-1.5' : d === 'spacious' ? 'py-2.5' : 'py-2';
  const listP = d === 'compact' ? 'p-1.5' : d === 'spacious' ? 'p-3' : 'p-2';
  const itemSpace = d === 'compact' ? 'space-y-0.5' : d === 'spacious' ? 'space-y-1.5' : 'space-y-1';

  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const toggleSection = useCallback((key: string) => setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] })), []);

  const { byRoleOnline, offlineMembers, totalOnline } = useMemo(() => {
    const visibleStatus = (s: string | undefined): 'online' | 'idle' | 'dnd' | 'offline' =>
      s === 'online' || s === 'idle' || s === 'dnd' ? s : 'offline';
    const normalized = members.map((m) => ({ ...m, status: visibleStatus(m.status) }));
    const online = normalized.filter((m) => m.status !== 'offline');
    const offline = normalized.filter((m) => m.status === 'offline');

    // Group online members by their highest hoist-able role. A role hoists
    // when displaySeparately is true; "highest" means lowest position number
    // (Owner=0 is rank 0). Members with no displaySeparately role fall into
    // a single catch-all "Online" section so we don't show every legacy
    // role bucket. The Owner-by-virtue-of-being-server-owner shortcut is
    // gone — if Owner role has displaySeparately=false, owners flow into
    // their next-highest hoist role (e.g. Founders) just like anyone else.
    type Section = { label: string; position: number; members: MemberWithRole[] };
    const sectionsMap = new Map<string, Section>();
    const ONLINE_KEY = '__online';
    online.forEach((m) => {
      const withRole = m as MemberWithRole;
      const memberRoles = withRole.roles ?? [];
      const hoisted = memberRoles.filter((r) => r.displaySeparately === true);
      const top = hoisted.length > 0
        ? hoisted.reduce((best, r) => ((r.position ?? 999) < (best.position ?? 999) ? r : best))
        : null;
      const sectionKey = top ? (top.id ?? top.name) : ONLINE_KEY;
      const sectionLabel = top ? top.name : t('members.online', { defaultValue: 'Online' });
      const sectionPosition = top ? (top.position ?? 998) : Number.MAX_SAFE_INTEGER - 1;
      if (!sectionsMap.has(sectionKey)) {
        sectionsMap.set(sectionKey, { label: sectionLabel, position: sectionPosition, members: [] });
      }
      sectionsMap.get(sectionKey)!.members.push({
        ...m,
        avatar: m.avatar,
        // Keep `role` as the legacy string for any consumer that still reads
        // it — section grouping no longer depends on it.
        role: withRole.role ?? (m.id === ownerId ? 'owner' : 'member'),
        roleColor: withRole.roleColor ?? top?.color,
        roleStyle: withRole.roleStyle ?? 'solid',
      });
    });

    const sorted = Array.from(sectionsMap.entries())
      .sort(([, a], [, b]) => a.position - b.position)
      .filter(([, sec]) => sec.members.length > 0)
      .map(([key, sec]) => [key, sec.label, sec.members] as const);
    return { byRoleOnline: sorted, offlineMembers: offline, totalOnline: online.length };
  }, [members, ownerId, t]);

  const panelStyle: React.CSSProperties = {
    backgroundColor: 'var(--bg-chat)',
    backdropFilter: 'blur(24px) saturate(1.1)',
    WebkitBackdropFilter: 'blur(24px) saturate(1.1)',
    border: '2px solid var(--border-subtle)',
    boxShadow: '0 4px 6px -1px rgba(0,0,0,0.12), 0 24px 48px -12px rgba(0,0,0,0.2)',
  };

  const allSections = [
    ...byRoleOnline.map(([key, label, roleMembers]) => ({ key, label, members: roleMembers, isOffline: false })),
    ...(offlineMembers.length > 0 ? [{ key: '__offline', label: t('members.offline'), members: offlineMembers as MemberWithRole[], isOffline: true }] : []),
  ];

  return (
    <div className={`perf-glass-layer flex flex-col overflow-hidden rounded-2xl ${embedded ? 'w-full h-full' : 'w-60 shrink-0 hidden lg:block'}`} style={{ contain: 'layout style paint', ...panelStyle }}>
      {/* Top header — matches activity/voice panel header style */}
      <div className={`w-full px-3 ${headerPy} shrink-0 flex items-center justify-between gap-2`}>
        <span className="flex items-center gap-2">
          <Users size={13} style={{ color: 'var(--text-secondary)', opacity: 0.7 }} />
          <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
            {t('members.title', { defaultValue: 'Members' })}
          </span>
        </span>
        <span className="text-[10px] font-medium tabular-nums" style={{ color: 'var(--text-faint)' }}>
          {totalOnline} / {members.length}
        </span>
      </div>

      {/* Scrollable sections — virtualized for large member lists */}
      <MemberVirtualList
        allSections={allSections}
        collapsedSections={collapsedSections}
        toggleSection={toggleSection}
        headerPy={headerPy}
        listP={listP}
        itemSpace={itemSpace}
        ownerId={ownerId}
        onMemberClick={onMemberClick}
        onMemberRightClick={onMemberRightClick}
        roleColorMode={roleColorMode}
        typingChannelId={typingChannelId}
      />
    </div>
  );
};


const MemberItem: React.FC<{
  member: MemberWithRole;
  isOwner?: boolean;
  onClick?: (member: UserWithRole, e: React.MouseEvent) => void;
  onRightClick?: (member: UserWithRole, e: React.MouseEvent) => void;
  roleColorMode?: 'in-names' | 'next-to-names' | 'hidden';
  typingChannelId?: string;
}> = React.memo(({ member, isOwner, onClick, onRightClick, roleColorMode = 'in-names', typingChannelId }) => {
  const { t } = useTranslation();
  const activeServerId = useNavigationStore(s => s.activeServerId);
  const isTyping = useTypingStore(
    useCallback(
      (s: { typingByChannel: Record<string, Record<string, { username: string; expires: number }>>; typingByServer: Record<string, Record<string, { username: string; expires: number }>> }) => {
        if (typingChannelId) return !!(s.typingByChannel[typingChannelId]?.[member.id]);
        return typeof activeServerId === 'string' && activeServerId !== 'home'
          ? !!(s.typingByServer[activeServerId]?.[member.id])
          : false;
      },
      [activeServerId, member.id, typingChannelId]
    )
  );
  const handleClick = (e: React.MouseEvent) => onClick?.(member as UserWithRole, e);
  const handleContextMenu = onRightClick ? (e: React.MouseEvent) => {
    e.preventDefault();
    onRightClick(member as UserWithRole, e);
  } : undefined;
  const longPress = useLongPress(handleContextMenu);
  const isClickable = !!(onClick || onRightClick);
  const hasSubtitle = !!(member.activity || member.customStatus);
  const nameLineHeight = hasSubtitle ? '1.25' : '32px';

  return (
    <div
      role={isClickable ? 'button' : 'listitem'}
      tabIndex={isClickable ? 0 : undefined}
      aria-label={member.username}
      onClick={onClick ? handleClick : undefined}
      onKeyDown={isClickable ? (e: React.KeyboardEvent) => { if ((e.key === 'Enter' || e.key === ' ') && onClick) { e.preventDefault(); onClick(member as UserWithRole, e as unknown as React.MouseEvent); } } : undefined}
      {...longPress}
      className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg transition-colors ${isClickable ? 'cursor-pointer hover:bg-fill-hover focus:outline-none focus:ring-1 focus:ring-[var(--cyan-accent)]/30' : ''}`}
    >
      <div className={`relative shrink-0 w-8 h-8 overflow-visible rounded-full ${(member.effectivePlan ?? member.stripePlan) === 'pro' ? getAvatarEffectClass(member.avatarEffect) : ''}`}>
        <LetterAvatar
          avatar={(member as MemberWithRole).serverAvatar || member.avatar}
          username={member.username}
          size={32}
          className={`rounded-full transition-all ${member.status === 'offline' ? 'opacity-50' : ''}`}
        />
        <TypingStatusDot
          status={member.status}
          isTyping={isTyping}
          size={8}
          className="absolute bottom-0 right-0"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {(() => {
            const displayName = (member as any).nickname || member.username;
            const isPro = (member.effectivePlan ?? member.stripePlan) === 'pro';
            if (member.status === 'offline') {
              return isPro ? (
                <span data-personal-info className="min-w-0 opacity-50" style={{ lineHeight: nameLineHeight }}>
                  <RoleNameStyle name={displayName} color="var(--text-secondary)" style="solid" className="text-[13px] truncate font-medium block" overrideFont={member.nameFont} nameEffect={member.nameEffect} overrideColor={member.nameColor} />
                </span>
              ) : (
                <span className="text-[13px] font-medium truncate" data-personal-info style={{ color: 'var(--text-secondary)', lineHeight: nameLineHeight }}>{displayName}</span>
              );
            }
            if ((member as MemberWithRole).roleColor && roleColorMode === 'next-to-names') {
              return isPro ? (
                <span className="inline-flex items-center gap-1.5 min-w-0" data-personal-info>
                  <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: isValidCssColor((member as MemberWithRole).roleColor) ? (member as MemberWithRole).roleColor! : undefined }} />
                  <RoleNameStyle name={displayName} color="var(--text-primary)" style="solid" className="text-[13px] truncate font-medium" overrideFont={member.nameFont} nameEffect={member.nameEffect} overrideColor={member.nameColor} />
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 min-w-0" data-personal-info>
                  <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: isValidCssColor((member as MemberWithRole).roleColor) ? (member as MemberWithRole).roleColor! : undefined }} />
                  <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)', lineHeight: nameLineHeight }}>{displayName}</span>
                </span>
              );
            }
            if ((member as MemberWithRole).roleColor && roleColorMode !== 'hidden') {
              return (
                <span data-personal-info className="min-w-0" style={{ lineHeight: nameLineHeight }}>
                  <RoleNameStyle name={displayName} color={(member as MemberWithRole).roleColor} style={(member as MemberWithRole).roleStyle ?? 'solid'} className="text-[13px] truncate font-medium block" overrideFont={isPro ? member.nameFont : undefined} nameEffect={isPro ? member.nameEffect : undefined} overrideColor={isPro ? member.nameColor : undefined} />
                </span>
              );
            }
            return isPro ? (
              <span data-personal-info className="min-w-0" style={{ lineHeight: nameLineHeight }}>
                <RoleNameStyle name={displayName} color="var(--text-primary)" style="solid" className="text-[13px] truncate font-medium block" overrideFont={member.nameFont} nameEffect={member.nameEffect} overrideColor={member.nameColor} />
              </span>
            ) : (
              <span className="text-[13px] font-medium truncate" data-personal-info style={{ color: 'var(--text-primary)', lineHeight: nameLineHeight }}>{displayName}</span>
            );
          })()}
          {isOwner && <Crown size={10} className="text-amber-400/70 shrink-0" aria-label={t('members.serverOwner')} />}
          {member.isBot && (
            <span className="text-[8px] font-bold uppercase px-1 py-0.5 rounded-lg bg-violet-500/15 text-violet-300 shrink-0">{t('members.bot')}</span>
          )}
        </div>
        {member.activity ? (
          <div className="flex items-center gap-1 mt-px">
            {member.activity.type !== 'bio' && (
              <span className="shrink-0" style={{ color: 'var(--cyan-accent)', opacity: 0.7 }}>
                <ActivityIcon type={member.activity.type} size={9} />
              </span>
            )}
            <span className="text-[10px] font-medium truncate" style={{ color: 'var(--text-secondary)' }}>
              {member.activity.type === 'spotify' && member.activity.details
                ? <>{member.activity.details} · {member.activity.name}</>
                : (member.activity.type === 'twitch_live' || member.activity.type === 'youtube_live') && member.activity.state
                ? <>{member.activity.name} · {member.activity.state}</>
                : member.activity.name}
            </span>
          </div>
        ) : member.customStatus ? (
          <div className="text-[9px] truncate mt-0.5" style={{ color: 'var(--text-secondary)', opacity: 0.7 }}>{member.customStatus}</div>
        ) : null}
      </div>
    </div>
  );
});

type FlatItem =
  | { type: 'header'; key: string; label: string; count: number; isOffline: boolean }
  | { type: 'member'; member: MemberWithRole; isOffline: boolean };

interface MemberVirtualListProps {
  allSections: { key: string; label: string; members: MemberWithRole[]; isOffline: boolean }[];
  collapsedSections: Record<string, boolean>;
  toggleSection: (key: string) => void;
  headerPy: string;
  listP: string;
  itemSpace: string;
  ownerId?: string;
  onMemberClick?: (member: UserWithRole, e: React.MouseEvent) => void;
  onMemberRightClick?: (member: UserWithRole, e: React.MouseEvent) => void;
  roleColorMode?: 'in-names' | 'next-to-names' | 'hidden';
  typingChannelId?: string;
}

const MemberVirtualList: React.FC<MemberVirtualListProps> = React.memo(({
  allSections,
  collapsedSections,
  toggleSection,
  headerPy,
  listP,
  itemSpace: _itemSpace,
  ownerId,
  onMemberClick,
  onMemberRightClick,
  roleColorMode,
  typingChannelId,
}) => {
  const flatItems = useMemo(() => {
    const items: FlatItem[] = [];
    for (const section of allSections) {
      items.push({ type: 'header', key: section.key, label: section.label, count: section.members.length, isOffline: section.isOffline });
      if (!collapsedSections[section.key]) {
        for (const member of section.members) {
          items.push({ type: 'member', member, isOffline: section.isOffline });
        }
      }
    }
    return items;
  }, [allSections, collapsedSections]);

  const renderItem = useCallback((_index: number, item: FlatItem) => {
    if (item.type === 'header') {
      return (
        <button
          onClick={() => toggleSection(item.key)}
          className={`w-full flex items-center justify-between px-3 ${headerPy} cursor-pointer hover:bg-fill-hover transition-colors`}
          style={{ borderTop: '1px solid var(--border-subtle)' }}
        >
          <span className="text-[10px] font-semibold uppercase tracking-wider mt-4 first:mt-0" style={{ color: item.isOffline ? 'var(--text-secondary)' : 'var(--text-secondary)' }}>
            {item.label} · {item.count}
          </span>
          {collapsedSections[item.key] ? <ChevronDown size={12} style={{ color: 'var(--text-secondary)' }} /> : <ChevronUp size={12} style={{ color: 'var(--text-secondary)' }} />}
        </button>
      );
    }
    return (
      <div className={listP}>
        <MemberItem
          member={item.member}
          isOwner={item.member.id === ownerId}
          onClick={onMemberClick}
          onRightClick={onMemberRightClick}
          roleColorMode={roleColorMode}
          typingChannelId={typingChannelId}
        />
      </div>
    );
  }, [toggleSection, headerPy, listP, collapsedSections, ownerId, onMemberClick, onMemberRightClick, roleColorMode, typingChannelId]);

  // For small lists, skip virtualization overhead
  if (flatItems.length <= 50) {
    return (
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {flatItems.map((item, i) => (
          <div key={item.type === 'header' ? `h-${item.key}` : `m-${(item as Extract<FlatItem, { type: 'member' }>).member.id}`}>
            {renderItem(i, item)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <Virtuoso
      className="flex-1 overflow-x-hidden"
      data={flatItems}
      itemContent={renderItem}
      computeItemKey={(index, item) =>
        item.type === 'header' ? `h-${item.key}` : `m-${item.member.id}`
      }
      overscan={200}
    />
  );
});
