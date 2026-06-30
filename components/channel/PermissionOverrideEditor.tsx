// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Search, Plus, X, Shield, User, Check, Minus, Users } from 'lucide-react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { apiClient } from '../../services/api';
import { LetterAvatar } from '../LetterAvatar';
import type { PermissionOverride } from '../../types';

// Props

interface PermissionOverrideEditorProps {
  serverId: string;
  channelId?: string;
  categoryId?: string;
  channelType: 'text' | 'voice' | 'stage' | 'forum' | 'role_picker';
  roles: Array<{ id: string; name: string; color: string }>;
  members: Array<{ id: string; username: string; discriminator?: string; avatar?: string | null }>;
}

type TriState = true | false | null;

interface SelectedTarget {
  type: 'role' | 'member';
  id: string;
}

// Permission definitions per channel type

interface PermissionDef {
  key: string;
  name: string;
  description: string;
}

interface PermissionGroup {
  category: string;
  permissions: PermissionDef[];
}

const GENERAL_PERMS: PermissionDef[] = [
  { key: 'viewChannels', name: 'View Channels', description: 'Allows members to view this channel' },
  { key: 'manageChannels', name: 'Manage Channels', description: 'Allows members to edit and delete this channel' },
  { key: 'manageRoles', name: 'Manage Permissions', description: 'Allows members to change permission overrides for this channel' },
];

const MEMBERSHIP_PERMS: PermissionDef[] = [
  { key: 'createInvite', name: 'Create Invite', description: 'Allows members to create invites to this channel' },
];

const TEXT_PERMS: PermissionDef[] = [
  { key: 'sendMessages', name: 'Send Messages', description: 'Allows members to send messages in this channel' },
  { key: 'sendMessagesInThreads', name: 'Send Messages in Threads', description: 'Allows members to send messages in threads' },
  { key: 'createPublicThreads', name: 'Create Public Threads', description: 'Allows members to create public threads' },
  { key: 'createPrivateThreads', name: 'Create Private Threads', description: 'Allows members to create invite-only threads' },
  { key: 'embedLinks', name: 'Embed Links', description: 'Allows link previews to be sent in messages' },
  { key: 'attachFiles', name: 'Attach Files', description: 'Allows members to upload files and media' },
  { key: 'addReactions', name: 'Add Reactions', description: 'Allows members to add emoji reactions to messages' },
  { key: 'useExternalEmoji', name: 'Use External Emoji', description: 'Allows members to use emoji from other servers' },
  { key: 'useExternalStickers', name: 'Use External Stickers', description: 'Allows members to use stickers from other servers' },
  { key: 'mentionEveryone', name: 'Mention @everyone', description: 'Allows members to use @everyone and @here mentions' },
  { key: 'manageMessages', name: 'Manage Messages', description: 'Allows members to delete or pin messages by other members' },
  { key: 'readMessageHistory', name: 'Read Message History', description: 'Allows members to read previous messages' },
  { key: 'createPolls', name: 'Create Polls', description: 'Allows members to create polls in this channel' },
];

const VOICE_PERMS: PermissionDef[] = [
  { key: 'connect', name: 'Connect', description: 'Allows members to join the voice channel' },
  { key: 'speak', name: 'Speak', description: 'Allows members to talk in the voice channel' },
  { key: 'video', name: 'Video', description: 'Allows members to share their video feed' },
  { key: 'useSoundboard', name: 'Use Soundboard', description: 'Allows members to play soundboard clips' },
  { key: 'useExternalSounds', name: 'Use External Sounds', description: 'Allows members to use sounds from other servers' },
  { key: 'useVoiceActivity', name: 'Use Voice Activity', description: 'Allows members to speak without push-to-talk' },
  { key: 'prioritySpeaker', name: 'Priority Speaker', description: 'Allows members to be heard more clearly' },
  { key: 'muteMembers', name: 'Mute Members', description: 'Allows members to mute others in voice channels' },
  { key: 'deafenMembers', name: 'Deafen Members', description: 'Allows members to deafen others in voice channels' },
  { key: 'moveMembers', name: 'Move Members', description: 'Allows members to move others between voice channels' },
  { key: 'setVoiceChannelStatus', name: 'Set Channel Status', description: 'Allows members to set the voice channel status' },
];

const EVENTS_PERMS: PermissionDef[] = [
  { key: 'createEvents', name: 'Create Events', description: 'Allows members to create scheduled events' },
  { key: 'manageEvents', name: 'Manage Events', description: 'Allows members to edit and cancel events' },
];

const FORUM_PERMS: PermissionDef[] = [
  { key: 'createPosts', name: 'Create Posts', description: 'Allows members to create new forum posts' },
  { key: 'sendMessagesInPosts', name: 'Send Messages in Posts', description: 'Allows members to reply in forum posts' },
  { key: 'embedLinks', name: 'Embed Links', description: 'Allows link previews to be sent in messages' },
  { key: 'attachFiles', name: 'Attach Files', description: 'Allows members to upload files and media' },
  { key: 'addReactions', name: 'Add Reactions', description: 'Allows members to add emoji reactions' },
  { key: 'useExternalEmoji', name: 'Use External Emoji', description: 'Allows members to use emoji from other servers' },
  { key: 'useExternalStickers', name: 'Use External Stickers', description: 'Allows members to use stickers from other servers' },
  { key: 'mentionEveryone', name: 'Mention @everyone', description: 'Allows members to use @everyone and @here' },
  { key: 'manageMessages', name: 'Manage Messages', description: 'Allows members to delete or pin messages by others' },
  { key: 'managePosts', name: 'Manage Posts', description: 'Allows members to lock, archive, or delete posts' },
  { key: 'readMessageHistory', name: 'Read Message History', description: 'Allows members to read previous messages' },
  { key: 'createPolls', name: 'Create Polls', description: 'Allows members to create polls' },
];

const STAGE_PERMS: PermissionDef[] = [
  { key: 'connect', name: 'Connect', description: 'Allows members to join the stage channel' },
  { key: 'speak', name: 'Speak', description: 'Allows members to become a speaker on stage' },
  { key: 'manageStages', name: 'Manage Stage', description: 'Allows members to start, end, and manage stage sessions' },
  { key: 'requestToSpeak', name: 'Request to Speak', description: 'Allows members to request to become a speaker' },
  { key: 'muteMembers', name: 'Mute Members', description: 'Allows members to mute others on stage' },
  { key: 'moveMembers', name: 'Move Members', description: 'Allows members to disconnect others from the stage' },
];

function getPermissionGroups(channelType: string): PermissionGroup[] {
  switch (channelType) {
    case 'voice':
      return [
        { category: 'General', permissions: GENERAL_PERMS },
        { category: 'Membership', permissions: MEMBERSHIP_PERMS },
        { category: 'Voice', permissions: VOICE_PERMS },
        { category: 'Events', permissions: EVENTS_PERMS },
      ];
    case 'forum':
      return [
        { category: 'General', permissions: GENERAL_PERMS },
        { category: 'Membership', permissions: MEMBERSHIP_PERMS },
        { category: 'Forum', permissions: FORUM_PERMS },
      ];
    case 'stage':
      return [
        { category: 'General', permissions: GENERAL_PERMS },
        { category: 'Membership', permissions: MEMBERSHIP_PERMS },
        { category: 'Stage', permissions: STAGE_PERMS },
      ];
    default: // text
      return [
        { category: 'General', permissions: GENERAL_PERMS },
        { category: 'Membership', permissions: MEMBERSHIP_PERMS },
        { category: 'Text', permissions: TEXT_PERMS },
      ];
  }
}

// Tri-state segmented pill

interface TriStatePillProps {
  value: TriState;
  onChange: (value: TriState) => void;
}

const TriStatePill: React.FC<TriStatePillProps> = ({ value, onChange }) => (
  <div className="h-7 rounded-full bg-fill-hover flex items-center overflow-hidden shrink-0">
    <button
      type="button"
      onClick={() => onChange(false)}
      className={`w-8 h-full flex items-center justify-center cursor-pointer transition-colors ${
        value === false ? 'bg-red-500/20 text-red-400' : 'text-white/20 hover:text-white/40'
      }`}
      aria-label="Deny"
    >
      <X size={14} strokeWidth={2.5} />
    </button>
    <button
      type="button"
      onClick={() => onChange(null)}
      className={`w-8 h-full flex items-center justify-center cursor-pointer transition-colors ${
        value === null ? 'bg-fill-active text-slate-400' : 'text-white/20 hover:text-white/40'
      }`}
      aria-label="Neutral"
    >
      <Minus size={14} strokeWidth={2.5} />
    </button>
    <button
      type="button"
      onClick={() => onChange(true)}
      className={`w-8 h-full flex items-center justify-center cursor-pointer transition-colors ${
        value === true ? 'bg-emerald-500/20 text-emerald-400' : 'text-white/20 hover:text-white/40'
      }`}
      aria-label="Allow"
    >
      <Check size={14} strokeWidth={2.5} />
    </button>
  </div>
);

// Main component

const PermissionOverrideEditor: React.FC<PermissionOverrideEditorProps> = ({
  serverId,
  channelId,
  categoryId,
  channelType,
  roles,
  members,
}) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();

  // State
  const [selectedTarget, setSelectedTarget] = useState<SelectedTarget | null>(null);
  const [overrides, setOverrides] = useState<PermissionOverride[]>([]);
  const [localPermissions, setLocalPermissions] = useState<Record<string, boolean | null>>({});
  const [saving, setSaving] = useState(false);
  const [showAddDropdown, setShowAddDropdown] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const addDropdownRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Virtual @everyone role + real roles
  const allRoles = useMemo(() => {
    const everyoneRole = { id: 'everyone', name: '@everyone', color: '#99aab5' };
    return [everyoneRole, ...roles];
  }, [roles]);

  // Permission groups for this channel type
  const permissionGroups = useMemo(() => getPermissionGroups(channelType), [channelType]);

  // Fetch overrides
  const fetchOverrides = useCallback(async () => {
    try {
      let data: PermissionOverride[];
      if (channelId) {
        data = await apiClient.getChannelPermissions(serverId, channelId);
      } else if (categoryId) {
        data = await apiClient.getCategoryPermissions(serverId, categoryId);
      } else {
        return;
      }
      setOverrides(data);
    } catch {
      // API may not be wired yet; keep empty state
    }
  }, [serverId, channelId, categoryId]);

  useEffect(() => {
    fetchOverrides();
  }, [fetchOverrides]);

  // Sync local permissions when target or overrides change
  useEffect(() => {
    if (!selectedTarget) {
      setLocalPermissions({});
      return;
    }
    const override = overrides.find(
      (o) => o.targetType === selectedTarget.type && o.targetId === selectedTarget.id,
    );
    setLocalPermissions(override?.permissions ?? {});
  }, [selectedTarget, overrides]);

  // Debounced save
  const savePermissions = useCallback(
    (perms: Record<string, boolean | null>) => {
      if (!selectedTarget) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        setSaving(true);
        try {
          let updated: PermissionOverride;
          if (channelId) {
            updated = await apiClient.setChannelPermissionOverride(
              serverId, channelId, selectedTarget.type, selectedTarget.id, perms,
            );
          } else if (categoryId) {
            updated = await apiClient.setCategoryPermissionOverride(
              serverId, categoryId, selectedTarget.type, selectedTarget.id, perms,
            );
          } else {
            return;
          }
          setOverrides((prev) => {
            const idx = prev.findIndex(
              (o) => o.targetType === selectedTarget.type && o.targetId === selectedTarget.id,
            );
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = updated;
              return next;
            }
            return [...prev, updated];
          });
        } catch {
          // Silently fail — user can retry
        } finally {
          setSaving(false);
        }
      }, 300);
    },
    [serverId, channelId, categoryId, selectedTarget],
  );

  // Cleanup debounce on unmount
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const handlePermissionChange = useCallback(
    (key: string, value: TriState) => {
      setLocalPermissions((prev) => {
        const next = { ...prev, [key]: value };
        savePermissions(next);
        return next;
      });
    },
    [savePermissions],
  );

  // Close dropdown on outside click or Escape
  useEffect(() => {
    if (!showAddDropdown) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        addDropdownRef.current && !addDropdownRef.current.contains(target) &&
        addButtonRef.current && !addButtonRef.current.contains(target)
      ) {
        setShowAddDropdown(false);
        setAddSearch('');
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowAddDropdown(false);
        setAddSearch('');
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showAddDropdown]);

  // Position dropdown relative to button
  useEffect(() => {
    if (!showAddDropdown || !addButtonRef.current) return;
    const rect = addButtonRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const dropdownHeight = 280;
    const top = spaceBelow > dropdownHeight ? rect.bottom + 4 : rect.top - dropdownHeight - 4;
    setDropdownPos({ top: Math.max(8, top), left: rect.left, width: rect.width });
  }, [showAddDropdown]);

  // Targets that already have overrides
  const overrideTargets = useMemo(() => {
    const targets: SelectedTarget[] = [];
    for (const o of overrides) {
      targets.push({ type: o.targetType, id: o.targetId });
    }
    return targets;
  }, [overrides]);

  // Targets shown in the sidebar (overrides + the currently selected)
  const sidebarRoles = useMemo(() => {
    const ids = new Set(overrideTargets.filter((t) => t.type === 'role').map((t) => t.id));
    return allRoles.filter((r) => ids.has(r.id));
  }, [allRoles, overrideTargets]);

  const sidebarMembers = useMemo(() => {
    const ids = new Set(overrideTargets.filter((t) => t.type === 'member').map((t) => t.id));
    return members.filter((m) => ids.has(m.id));
  }, [members, overrideTargets]);

  // Add dropdown filtering
  const existingIds = useMemo(() => new Set(overrideTargets.map((t) => t.id)), [overrideTargets]);
  const filteredAddRoles = useMemo(
    () => allRoles.filter((r) => !existingIds.has(r.id) && r.name.toLowerCase().includes(addSearch.toLowerCase())),
    [allRoles, existingIds, addSearch],
  );
  const filteredAddMembers = useMemo(
    () => members.filter((m) => !existingIds.has(m.id) && m.username.toLowerCase().includes(addSearch.toLowerCase())),
    [members, existingIds, addSearch],
  );

  const handleAddTarget = useCallback(
    (target: SelectedTarget) => {
      setSelectedTarget(target);
      setShowAddDropdown(false);
      setAddSearch('');
      // Create a blank override entry locally so it shows in sidebar
      setOverrides((prev) => {
        if (prev.some((o) => o.targetType === target.type && o.targetId === target.id)) return prev;
        return [
          ...prev,
          {
            id: `pending-${target.type}-${target.id}`,
            targetType: target.type,
            targetId: target.id,
            permissions: {},
            createdAt: new Date().toISOString(),
            ...(channelId ? { channelId } : {}),
            ...(categoryId ? { categoryId } : {}),
          },
        ];
      });
    },
    [channelId, categoryId],
  );

  // Render helpers

  const renderRoleItem = (role: { id: string; name: string; color: string }) => {
    const isSelected = selectedTarget?.type === 'role' && selectedTarget.id === role.id;
    return (
      <button
        key={role.id}
        type="button"
        onClick={() => setSelectedTarget({ type: 'role', id: role.id })}
        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-sm transition-colors ${
          isSelected ? 'bg-fill-active' : 'hover:bg-fill-hover'
        }`}
        style={{ color: 'var(--text-primary)' }}
      >
        {role.id === 'everyone' ? (
          <Users size={13} className="shrink-0" style={{ color: '#99aab5' }} />
        ) : (
          <span
            className="w-3 h-3 rounded-full shrink-0"
            style={{ backgroundColor: role.color || '#99aab5' }}
          />
        )}
        <span className="truncate">{role.name}</span>
      </button>
    );
  };

  const renderMemberItem = (member: { id: string; username: string; discriminator?: string; avatar?: string | null }) => {
    const isSelected = selectedTarget?.type === 'member' && selectedTarget.id === member.id;
    return (
      <button
        key={member.id}
        type="button"
        onClick={() => setSelectedTarget({ type: 'member', id: member.id })}
        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-sm transition-colors ${
          isSelected ? 'bg-fill-active' : 'hover:bg-fill-hover'
        }`}
        style={{ color: 'var(--text-primary)' }}
      >
        <LetterAvatar avatar={member.avatar ?? null} username={member.username} size={20} className="rounded-full shrink-0" />
        <span className="truncate">
          {member.username}
          {member.discriminator && <span style={{ color: 'var(--text-muted)' }}>#{member.discriminator}</span>}
        </span>
      </button>
    );
  };

  const renderPermissionRow = (perm: PermissionDef) => {
    const value: TriState = localPermissions[perm.key] ?? null;
    return (
      <div
        key={perm.key}
        className="flex items-center justify-between gap-4 px-4 py-3 rounded-xl border hover:bg-fill-hover transition-colors"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <div className="min-w-0">
          <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            {t(`permissions.${perm.key}.name`, perm.name)}
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {t(`permissions.${perm.key}.description`, perm.description)}
          </div>
        </div>
        <TriStatePill value={value} onChange={(v) => handlePermissionChange(perm.key, v)} />
      </div>
    );
  };

  // Sidebar content (shared between desktop & mobile layouts)

  const sidebarContent = (
    <div className="flex flex-col gap-1">
      {/* Roles section */}
      {sidebarRoles.length > 0 && (
        <>
          <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
            {t('permissions.roles', 'Roles')}
          </div>
          {sidebarRoles.map(renderRoleItem)}
        </>
      )}

      {/* Members section */}
      {sidebarMembers.length > 0 && (
        <>
          <div className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
            {t('permissions.members', 'Members')}
          </div>
          {sidebarMembers.map(renderMemberItem)}
        </>
      )}

      {/* Empty state */}
      {sidebarRoles.length === 0 && sidebarMembers.length === 0 && (
        <div className="px-3 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
          {t('permissions.noOverrides', 'No permission overrides yet')}
        </div>
      )}

      {/* Add button */}
      <div className="px-2 pt-2">
        <button
          ref={addButtonRef}
          type="button"
          onClick={() => setShowAddDropdown((v) => !v)}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors hover:bg-fill-hover"
          style={{ color: 'var(--cyan-accent)', border: '1px dashed var(--border-subtle)' }}
        >
          <Plus size={14} />
          {t('permissions.addOverride', 'Add role or member')}
        </button>
      </div>

      {/* Portal dropdown */}
      {showAddDropdown && dropdownPos && createPortal(
        <div
          ref={addDropdownRef}
          className="fixed rounded-xl border shadow-2xl overflow-hidden"
          style={{
            top: dropdownPos.top,
            left: dropdownPos.left,
            width: dropdownPos.width,
            backgroundColor: 'var(--bg-floating)',
            borderColor: 'var(--border-subtle)',
            zIndex: 9999,
          }}
        >
          {/* Search input */}
          <div className="p-2">
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg" style={{ backgroundColor: 'var(--bg-app)' }}>
              <Search size={14} style={{ color: 'var(--text-muted)' }} />
              <input
                type="text"
                value={addSearch}
                onChange={(e) => setAddSearch(e.target.value)}
                placeholder={t('permissions.searchPlaceholder', 'Search roles or members...')}
                autoFocus
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-white/30"
                style={{ color: 'var(--text-primary)' }}
              />
            </div>
          </div>

          <div className="max-h-48 overflow-y-auto px-1 pb-1">
            {/* Roles */}
            {filteredAddRoles.length > 0 && (
              <>
                <div className="px-2 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                  {t('permissions.roles', 'Roles')}
                </div>
                {filteredAddRoles.map((role) => (
                  <button
                    key={role.id}
                    type="button"
                    onClick={() => handleAddTarget({ type: 'role', id: role.id })}
                    className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left text-xs hover:bg-fill-hover transition-colors"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {role.id === 'everyone' ? (
                      <Users size={12} style={{ color: '#99aab5' }} />
                    ) : (
                      <Shield size={12} style={{ color: role.color || '#99aab5' }} />
                    )}
                    <span className="truncate">{role.name}</span>
                  </button>
                ))}
              </>
            )}

            {/* Members */}
            {filteredAddMembers.length > 0 && (
              <>
                <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                  {t('permissions.members', 'Members')}
                </div>
                {filteredAddMembers.map((member) => (
                  <button
                    key={member.id}
                    type="button"
                    onClick={() => handleAddTarget({ type: 'member', id: member.id })}
                    className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left text-xs hover:bg-fill-hover transition-colors"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    <User size={12} style={{ color: 'var(--text-secondary)' }} />
                    <span className="truncate">{member.username}</span>
                  </button>
                ))}
              </>
            )}

            {/* No results */}
            {filteredAddRoles.length === 0 && filteredAddMembers.length === 0 && (
              <div className="px-3 py-4 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                {t('permissions.noResults', 'No roles or members found')}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );

  // Permission list content

  const permissionListContent = selectedTarget ? (
    <div className="flex flex-col gap-6">
      {/* Target header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {selectedTarget.type === 'role' ? (
            <>
              {selectedTarget.id === 'everyone' ? (
                <Users size={14} style={{ color: '#99aab5' }} />
              ) : (
                <span
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: allRoles.find((r) => r.id === selectedTarget.id)?.color || '#99aab5' }}
                />
              )}
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                {allRoles.find((r) => r.id === selectedTarget.id)?.name ?? t('permissions.unknownRole', 'Unknown Role')}
              </span>
            </>
          ) : (
            <>
              <LetterAvatar
                avatar={members.find((m) => m.id === selectedTarget.id)?.avatar ?? null}
                username={members.find((m) => m.id === selectedTarget.id)?.username ?? '?'}
                size={20}
                className="rounded-full"
              />
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                {members.find((m) => m.id === selectedTarget.id)?.username ?? t('permissions.unknownMember', 'Unknown Member')}
              </span>
            </>
          )}
          {saving && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-fill-hover" style={{ color: 'var(--text-muted)' }}>
              {t('permissions.saving', 'Saving...')}
            </span>
          )}
        </div>
      </div>

      {/* Permission groups */}
      {permissionGroups.map((group) => (
        <div key={group.category}>
          <div
            className="text-[11px] font-semibold uppercase tracking-wider mb-2 px-1"
            style={{ color: 'var(--text-muted)' }}
          >
            {t(`permissions.category.${group.category.toLowerCase()}`, group.category)}
          </div>
          <div className="flex flex-col gap-1">
            {group.permissions.map(renderPermissionRow)}
          </div>
        </div>
      ))}
    </div>
  ) : (
    <div className="flex flex-col items-center justify-center py-16 gap-3">
      <Shield size={40} className="opacity-20" style={{ color: 'var(--text-muted)' }} />
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        {t('permissions.selectTarget', 'Select a role or member to edit permissions')}
      </p>
    </div>
  );

  // Mobile layout: stacked

  if (isMobile) {
    return (
      <div className="flex flex-col gap-4">
        {/* Role/member selector */}
        <div
          className="rounded-xl border p-3"
          style={{ backgroundColor: 'var(--fill-hover)', borderColor: 'var(--border-subtle)' }}
        >
          {sidebarContent}
        </div>

        {/* Permissions list */}
        <div className="flex flex-col gap-4">
          {permissionListContent}
        </div>
      </div>
    );
  }

  // Desktop layout: sidebar + panel

  return (
    <div className="flex gap-4 min-h-0">
      {/* Left sidebar */}
      <div
        className="w-[180px] shrink-0 rounded-xl border overflow-y-auto"
        style={{ backgroundColor: 'var(--fill-hover)', borderColor: 'var(--border-subtle)' }}
      >
        <div className="py-2">
          {sidebarContent}
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {permissionListContent}
      </div>
    </div>
  );
};

export default PermissionOverrideEditor;
