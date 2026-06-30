// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield, Lock, Plus, Search, ChevronLeft, ChevronRight, X, GripVertical, ChevronUp, ChevronDown } from 'lucide-react';
import { Server } from '../../types';
import type { ServerMemberWithRole, ServerRole, ServerRoleFromAPI, RoleStyle } from '../../types/server';
import { apiRoleToServerRole } from '../../types/server';
import { apiClient } from '../../services/api';
import { socketService } from '../../services/socket';
import { SectionHeader, Card, Toggle, SettingRow, InputField, PrimaryButton, DangerButton, EmptyState, ConfirmDialog } from '../settings/SettingsWidgets';
import { LetterAvatar } from '../LetterAvatar';
import { isValidCssColor } from '../../utils/securityUtils';
import { useIsMobile } from '../../hooks/useIsMobile';

// Constants

type RolePermissionGroup = { title: string; permissions: { id: string; label: string; description: string }[] };
const ROLE_PERMISSION_GROUPS: RolePermissionGroup[] = [
  {
    title: 'Server Management',
    permissions: [
      { id: 'viewChannels', label: 'Browse Channels', description: 'See channels in the sidebar (private channels excluded).' },
      { id: 'manageChannels', label: 'Edit Channels', description: 'Create, rename, reorder, or delete channels.' },
      { id: 'manageRoles', label: 'Edit Roles', description: 'Create, modify, or remove roles ranked below theirs.' },
      { id: 'createExpressions', label: 'Upload Media', description: 'Add custom emoji, stickers, and soundboard clips.' },
      { id: 'manageExpressions', label: 'Curate Media', description: 'Edit or remove existing emoji, stickers, and sounds.' },
      { id: 'viewAuditLog', label: 'View Change Log', description: 'See a record of who changed what in the server.' },
      { id: 'manageWebhooks', label: 'Manage Webhooks', description: 'Set up, edit, or delete webhook integrations.' },
      { id: 'manageServer', label: 'Manage Server', description: 'Modify server name, icon, banner, and view all invites.' },
    ],
  },
  {
    title: 'People',
    permissions: [
      { id: 'createInvite', label: 'Send Invites', description: 'Generate invite links to bring new members in.' },
      { id: 'changeNickname', label: 'Set Own Nickname', description: 'Choose a display name just for this server.' },
      { id: 'manageNicknames', label: 'Rename Others', description: 'Change other members\' server nicknames.' },
      { id: 'kickMembers', label: 'Kick', description: 'Remove members from the server (they can rejoin).' },
      { id: 'banMembers', label: 'Ban', description: 'Permanently block members from rejoining.' },
      { id: 'timeoutMembers', label: 'Timeout', description: 'Temporarily silence members from chatting or speaking.' },
    ],
  },
  {
    title: 'Text',
    permissions: [
      { id: 'sendMessages', label: 'Send Messages', description: 'Post messages and create forum topics.' },
      { id: 'embedLinks', label: 'Embed Links', description: 'URLs they paste will generate rich previews.' },
      { id: 'attachFiles', label: 'Upload Files', description: 'Attach images, videos, and other files to messages.' },
      { id: 'addReactions', label: 'React', description: 'Add emoji reactions to any message.' },
      { id: 'useExternalEmoji', label: 'Use External Emoji', description: 'Use emoji from other servers in messages and reactions.' },
      { id: 'useExternalStickers', label: 'Use External Stickers', description: 'Use stickers from other servers.' },
      { id: 'mentionEveryone', label: 'Broadcast Mention', description: 'Use @everyone, @here, and ping all roles.' },
      { id: 'manageMessages', label: 'Moderate Messages', description: 'Delete or pin messages from other members.' },
      { id: 'readMessageHistory', label: 'Read History', description: 'Scroll back through older messages.' },
    ],
  },
  {
    title: 'Voice',
    permissions: [
      { id: 'connect', label: 'Join', description: 'Enter voice channels.' },
      { id: 'speak', label: 'Speak', description: 'Transmit audio in voice channels.' },
      { id: 'video', label: 'Stream', description: 'Share camera or screen in voice channels.' },
      { id: 'useVoiceActivity', label: 'Open Mic', description: 'Talk freely without holding a push-to-talk key.' },
      { id: 'useSoundboard', label: 'Use Soundboard', description: 'Play soundboard clips in voice channels.' },
      { id: 'useExternalSounds', label: 'External Sounds', description: 'Play soundboard clips from other servers.' },
      { id: 'prioritySpeaker', label: 'Priority Speaker', description: 'Reduce the volume of others while speaking.' },
      { id: 'muteMembers', label: 'Force Mute', description: 'Server-mute other members in voice.' },
      { id: 'deafenMembers', label: 'Force Deafen', description: 'Server-deafen other members in voice.' },
      { id: 'moveMembers', label: 'Move Members', description: 'Drag members between voice channels.' },
      { id: 'setVoiceChannelStatus', label: 'Set Voice Status', description: 'Set the status/topic on voice channels.' },
    ],
  },
  {
    title: 'Calendar',
    permissions: [
      { id: 'viewCalendar', label: 'View Calendar', description: 'See the server calendar and event details. Disabling this hides the calendar icon entirely.' },
      { id: 'manageCalendar', label: 'Manage Calendar', description: 'Create, edit, and delete events, and configure which channels receive reminders.' },
    ],
  },
  {
    title: 'Events',
    permissions: [
      { id: 'createEvents', label: 'Create Events', description: 'Create scheduled events in the server.' },
      { id: 'manageEvents', label: 'Manage Events', description: 'Edit or delete scheduled events from any author.' },
    ],
  },
  {
    title: 'Polls',
    permissions: [
      { id: 'createPolls', label: 'Create Polls', description: 'Post polls in text channels for members to vote on.' },
    ],
  },
  {
    title: 'Threads',
    permissions: [
      { id: 'createThreads', label: 'Create Threads', description: 'Start new discussion threads from messages.' },
      { id: 'createPublicThreads', label: 'Create Public Threads', description: 'Start threads visible to everyone with channel access.' },
      { id: 'createPrivateThreads', label: 'Create Private Threads', description: 'Start invite-only threads.' },
      { id: 'sendMessagesInThreads', label: 'Reply in Threads', description: 'Respond inside threads and forum replies.' },
    ],
  },
  {
    title: 'Forum Posts',
    permissions: [
      { id: 'createPosts', label: 'Create Posts', description: 'Start new forum posts in forum channels.' },
      { id: 'sendMessagesInPosts', label: 'Reply in Posts', description: 'Reply to existing forum posts.' },
      { id: 'managePosts', label: 'Manage Posts', description: 'Archive, lock, pin, or delete posts from any author.' },
    ],
  },
  {
    title: 'Stages',
    permissions: [
      { id: 'manageStages', label: 'Manage Stages', description: 'Start, end, and moderate stage sessions. Invite or remove speakers.' },
      { id: 'requestToSpeak', label: 'Raise Hand', description: 'Request to speak in active stage sessions.' },
    ],
  },
  {
    title: 'Elevated',
    permissions: [
      { id: 'administrator', label: 'Administrator', description: 'Unrestricted access. Grants every permission above — read history, manage channels, manage roles, moderate, everything. Assign with caution.' },
    ],
  },
];
const ALL_PERMISSION_IDS = ROLE_PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.id));
const OWNER_DEFAULT_PERMISSIONS = Object.fromEntries(ALL_PERMISSION_IDS.map((id) => [id, true]));
const ROLE_COLOR_SWATCHES = [
  '#99aab5', '#57f287', '#fee75c', '#ed4245', '#eb459e', '#5865f2', '#ffffff',
  '#3ca374', '#faa61a', '#f04747', '#7351bc', '#206694', '#879596', '#e67e22',
];

// Props

export interface RolesSectionProps {
  server: Server;
  localMembers: ServerMemberWithRole[];
  setLocalMembers: React.Dispatch<React.SetStateAction<ServerMemberWithRole[]>>;
  showToast: (message: string, type?: 'success' | 'error') => void;
  getServerRoles?: (serverId: string) => Promise<ServerRoleFromAPI[]>;
  onUpdateRole?: (serverId: string, roleId: string, data: Partial<ServerRole>) => Promise<void>;
  onCreateRole?: (serverId: string, data: Partial<ServerRole>) => Promise<ServerRoleFromAPI>;
  onDeleteRole?: (serverId: string, roleId: string) => Promise<void>;
  onAddMemberToRole?: (serverId: string, roleId: string, userId: string) => Promise<void>;
  onRemoveMemberFromRole?: (serverId: string, roleId: string, userId: string) => Promise<void>;
  onRolesUpdated?: () => void;
}

// Component

export const RolesSection: React.FC<RolesSectionProps> = ({
  server, localMembers, setLocalMembers, showToast,
  getServerRoles, onUpdateRole, onCreateRole, onDeleteRole,
  onAddMemberToRole, onRemoveMemberFromRole, onRolesUpdated,
}) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();

  // State
  const [roles2, setRoles2] = useState<ServerRole[]>([]);
  const [rolesLoading, setRolesLoading] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [roleEditName, setRoleEditName] = useState('');
  const [roleEditColor, setRoleEditColor] = useState('#99aab5');
  const [roleEditStyle, setRoleEditStyle] = useState<RoleStyle>('solid');
  const [roleEditIcon, setRoleEditIcon] = useState('');
  const [roleEditPermissions, setRoleEditPermissions] = useState<Record<string, boolean>>({});
  const [roleEditDisplaySep, setRoleEditDisplaySep] = useState(false);
  const [roleEditAllowMention, setRoleEditAllowMention] = useState(false);
  const [roleEditSelfAssignable, setRoleEditSelfAssignable] = useState(false);
  const [roleEditHidden, setRoleEditHidden] = useState(false);
  const [roleEditBlocksSelf, setRoleEditBlocksSelf] = useState(false);
  const [roleSaving, setRoleSaving] = useState(false);
  const [roleDetailTab, setRoleDetailTab] = useState<'display' | 'permissions' | 'members'>('display');
  const [roleMemberSearch, setRoleMemberSearch] = useState('');
  const [roleMemberLoading, setRoleMemberLoading] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; desc: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void } | null>(null);

  // Drag-and-drop state for the roles list
  // The drag pool is "orderable roles" — every role except @everyone. Owner
  // is in the pool but pinned to index 0 (server enforces); we just refuse
  // drops above it client-side too. Tracking the dragged id + a per-target
  // before/after marker mirrors how ChannelsSection.tsx handles its DnD.
  //
  // dragRoleIdRef shadows the state so handlers read the live value even
  // before React has reconciled the next render — avoids the "drop fires
  // with the previous closure" trap that makes drops appear to do nothing.
  const [dragRoleId, setDragRoleId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; before: boolean } | null>(null);
  const dragRoleIdRef = useRef<string | null>(null);
  const dropTargetRef = useRef<{ id: string; before: boolean } | null>(null);
  // Snapshot of the pre-drop state, for rollback if the API call fails.
  const preDropSnapshotRef = useRef<ServerRole[] | null>(null);

  // Load roles on mount
  useEffect(() => {
    if (getServerRoles) {
      setRolesLoading(true);
      getServerRoles(server.id).then((r) => {
        setRoles2(r.map(apiRoleToServerRole));
      }).catch(() => showToast(t('serverSettings.failedToLoadRoles'), 'error')).finally(() => setRolesLoading(false));
    }
  }, [server.id, getServerRoles]);

  // Live sync: another admin creating, editing, deleting, or reordering
  // roles emits `server-role-{created,updated,deleted}` or
  // `server-roles-reordered` to the server room. Refetch the canonical role
  // list so this tab stays in sync without a refresh.
  useEffect(() => {
    if (!getServerRoles) return;
    const sock = socketService.getSocket();
    if (!sock) return;
    const handler = (payload: { serverId: string }) => {
      if (payload.serverId !== server.id) return;
      getServerRoles(server.id).then((r) => setRoles2(r.map(apiRoleToServerRole))).catch(() => {});
    };
    sock.on('server-role-created', handler);
    sock.on('server-role-updated', handler);
    sock.on('server-role-deleted', handler);
    sock.on('server-roles-reordered', handler);
    return () => {
      sock.off('server-role-created', handler);
      sock.off('server-role-updated', handler);
      sock.off('server-role-deleted', handler);
      sock.off('server-roles-reordered', handler);
    };
  }, [server.id, getServerRoles]);

  const selectedRole = selectedRoleId ? roles2.find((r) => r.id === selectedRoleId) : null;

  // Sync selected role into edit fields
  useEffect(() => {
    if (selectedRole) {
      setRoleEditName(selectedRole.name);
      setRoleEditColor(selectedRole.color);
      setRoleEditStyle(selectedRole.style ?? 'solid');
      setRoleEditIcon(selectedRole.icon ?? '');
      // Owner gets all perms shown as "granted" (read-only); @everyone and all other roles
      // use their actual stored perms (@everyone is EDITABLE despite being locked).
      setRoleEditPermissions(selectedRole.locked && selectedRole.name === 'Owner' && !selectedRole.isEveryone
        ? OWNER_DEFAULT_PERMISSIONS
        : { ...(selectedRole.permissions ?? {}) });
      setRoleEditDisplaySep(selectedRole.displaySeparately ?? false);
      setRoleEditAllowMention(selectedRole.allowMention ?? false);
      setRoleEditSelfAssignable(selectedRole.selfAssignable ?? false);
      setRoleEditHidden(selectedRole.hidden ?? false);
      setRoleEditBlocksSelf(selectedRole.blocksSelfRoles ?? false);
    }
  }, [selectedRole]);

  // Reorder helpers
  // The server keeps @everyone pinned to a high fixed position outside the
  // user-controlled range, and Owner pinned to index 0. On the client we just
  // refuse drops involving either, and ship the new order of all *non-everyone*
  // roles (Owner included, always at index 0).
  const isOrderable = useCallback((r: ServerRole) => !r.isEveryone, []);
  const isFixedTop = useCallback((r: ServerRole) => r.locked && r.name.toLowerCase() === 'owner', []);

  // Apply a new order optimistically and call the API; revert on failure.
  // The new order is the full top-to-bottom list of orderable role IDs (i.e.
  // every role except @everyone). We compute it from the dragged + target
  // role IDs so the call site only needs to know "drop this role above/below
  // that one" rather than re-deriving the whole list.
  const commitReorder = useCallback(async (draggedId: string, targetId: string, before: boolean) => {
    if (draggedId === targetId) return;
    const orderable = roles2.filter(isOrderable);
    const draggedIdx = orderable.findIndex((r) => r.id === draggedId);
    const draggedRole = orderable[draggedIdx];
    if (draggedIdx < 0 || !draggedRole || isFixedTop(draggedRole)) return;

    // Compute insertion index. If the target is @everyone (not in the
    // orderable pool, but is a real drop target on screen because it's an
    // existing row), we treat it as "place at the bottom of the orderable
    // list" — that matches the canonical state where @everyone always sits
    // at the very end. Without this special case, dropping anywhere near
    // @everyone silently no-ops, which is exactly the failure mode users
    // hit when their server still has @everyone at a stale low position
    // mid-list.
    const targetIsEveryone = roles2.find((r) => r.id === targetId)?.isEveryone === true;
    const without = orderable.filter((r) => r.id !== draggedId);
    let insertAt: number;
    if (targetIsEveryone) {
      insertAt = without.length;
    } else {
      const targetIdx = orderable.findIndex((r) => r.id === targetId);
      const targetRole = orderable[targetIdx];
      if (targetIdx < 0 || !targetRole) return;
      // Refuse drops above Owner — Owner is always at index 0. Server
      // enforces independently; this keeps the UI from flashing invalid state.
      if (isFixedTop(targetRole) && before) return;
      insertAt = without.findIndex((r) => r.id === targetId);
      if (!before) insertAt += 1;
    }
    const reorderedOrderable = [
      ...without.slice(0, insertAt),
      draggedRole,
      ...without.slice(insertAt),
    ];
    const orderedRoleIds = reorderedOrderable.map((r) => r.id);

    // No-op short-circuit: if the new order is identical to the old, skip
    // the round-trip. Saves a server hit and a needless re-render.
    const oldOrderedIds = orderable.map((r) => r.id);
    if (orderedRoleIds.length === oldOrderedIds.length && orderedRoleIds.every((id, i) => id === oldOrderedIds[i])) {
      return;
    }

    // Optimistic: apply new positions to local state. @everyone keeps its
    // position; orderable roles get sequential positions matching the
    // submitted order.
    const everyone = roles2.find((r) => r.isEveryone);
    const optimistic: ServerRole[] = [
      ...reorderedOrderable.map((r, i) => ({ ...r, position: i })),
      ...(everyone ? [everyone] : []),
    ];
    preDropSnapshotRef.current = roles2;
    setRoles2(optimistic);

    try {
      await apiClient.reorderServerRoles(server.id, orderedRoleIds);
      preDropSnapshotRef.current = null;
      onRolesUpdated?.();
    } catch (e) {
      // Rollback. Surface the message verbatim if it's an Error so 403
      // (hierarchy violation) lands on the user with the right context.
      if (preDropSnapshotRef.current) setRoles2(preDropSnapshotRef.current);
      preDropSnapshotRef.current = null;
      const msg = e instanceof Error ? e.message : t('serverSettings.failedToReorderRoles', { defaultValue: 'Failed to reorder roles' });
      showToast(msg, 'error');
    }
  }, [roles2, server.id, isOrderable, isFixedTop, onRolesUpdated, showToast, t]);

  const handleDragStart = useCallback((e: React.DragEvent, roleId: string) => {
    dragRoleIdRef.current = roleId;
    setDragRoleId(roleId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', roleId);
  }, []);

  // Read from the ref, not from state, so this still works on the first
  // dragOver after dragstart (before React commits the new state). Setting
  // both keeps the indicator visuals reactive while the ref drives the
  // hot-path branching.
  const handleDragOver = useCallback((e: React.DragEvent, roleId: string) => {
    const draggedId = dragRoleIdRef.current;
    if (!draggedId || draggedId === roleId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const next = { id: roleId, before };
    dropTargetRef.current = next;
    setDropTarget((prev) => (prev && prev.id === next.id && prev.before === next.before ? prev : next));
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const dragged = dragRoleIdRef.current;
    if (!dragged) return;
    const dt = dropTargetRef.current;
    const before = dt && dt.id === targetId ? dt.before : true;
    dragRoleIdRef.current = null;
    dropTargetRef.current = null;
    setDragRoleId(null);
    setDropTarget(null);
    commitReorder(dragged, targetId, before);
  }, [commitReorder]);

  const clearDrag = useCallback(() => {
    dragRoleIdRef.current = null;
    dropTargetRef.current = null;
    setDragRoleId(null);
    setDropTarget(null);
  }, []);

  // Mobile fallback: bump a role one slot up or down. Skips locked-Owner moves
  // and refuses to walk past the @everyone pin (the latter is filtered out of
  // the orderable pool anyway).
  const bumpRole = useCallback((roleId: string, direction: -1 | 1) => {
    const orderable = roles2.filter(isOrderable);
    const idx = orderable.findIndex((r) => r.id === roleId);
    if (idx < 0) return;
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= orderable.length) return;
    if (isFixedTop(orderable[idx])) return;
    if (direction === -1 && isFixedTop(orderable[targetIdx])) return;
    const targetRole = orderable[targetIdx];
    // Bumping up = drop "before" the role at the new slot; bumping down = drop "after".
    commitReorder(roleId, targetRole.id, direction === -1);
  }, [roles2, isOrderable, isFixedTop, commitReorder]);

  // Roles list view
  if (!selectedRoleId) {
    return (
      <>
        <div className="max-w-3xl space-y-6">
          <SectionHeader title={t('serverSettings.roles')} desc={t('serverSettings.rolesDesc')} icon={<Shield size={24} />} />
          <PrimaryButton onClick={async () => {
            if (!onCreateRole) return;
            try {
              const r = await onCreateRole(server.id, { name: t('serverSettings.newRoleName') });
              setRoles2((prev) => [...prev, apiRoleToServerRole(r)]);
              setSelectedRoleId(r.id); setRoleDetailTab('display'); setRoleMemberSearch('');
              showToast(t('serverSettings.roleCreated'));
            } catch { showToast(t('serverSettings.failedToCreateRole'), 'error'); }
          }}><Plus size={14} className="inline mr-1" /> {t('serverSettings.createRole')}</PrimaryButton>
          {rolesLoading ? <EmptyState icon={<span className="inline-block w-8 h-8 border-2 border-[var(--border-strong)] border-t-white rounded-full animate-spin" />} title={t('serverSettings.loading')} desc="" /> : (() => {
            // Hierarchy guidance: the list is rendered top-to-bottom by
            // `position` (lower = higher authority). Owner stays pinned at the
            // top, @everyone at the bottom. Members get the union of all their
            // roles' permissions; the highest hoisted role decides the
            // member-list section color.
            const orderableRoles = roles2.filter(isOrderable);
            const orderableIdxOf = (id: string) => orderableRoles.findIndex((r) => r.id === id);
            return (
              <div className="space-y-2">
                <p className="text-[11px] text-t-tertiary">
                  {t('serverSettings.rolesHierarchyHint', {
                    defaultValue: 'Drag to reorder. Roles higher in this list outrank roles below them — they decide member colors, hoisted sections in the member list, and who can manage whom.',
                  })}
                </p>
                {roles2.map((r) => {
                  const isFixed = isFixedTop(r) || r.isEveryone;
                  const isDraggingThis = dragRoleId === r.id;
                  const isDropTarget = dropTarget?.id === r.id && dragRoleId !== null && dragRoleId !== r.id;
                  const showLineBefore = isDropTarget && dropTarget!.before;
                  const showLineAfter = isDropTarget && !dropTarget!.before;
                  const oIdx = orderableIdxOf(r.id);
                  const canMobileMoveUp = !isFixed && oIdx > 0 && !isFixedTop(orderableRoles[oIdx - 1]);
                  const canMobileMoveDown = !isFixed && oIdx < orderableRoles.length - 1;

                  return (
                    <div key={r.id} className="relative">
                      {showLineBefore && (
                        <div className="absolute left-0 right-0 -top-1 h-0.5 rounded-full pointer-events-none" style={{ backgroundColor: 'var(--cyan-accent)', boxShadow: '0 0 6px var(--cyan-accent)' }} />
                      )}
                      <div
                        role="button"
                        tabIndex={0}
                        draggable={!isMobile && !isFixed}
                        onDragStart={!isMobile && !isFixed ? (e) => handleDragStart(e, r.id) : undefined}
                        onDragOver={!isMobile ? (e) => handleDragOver(e, r.id) : undefined}
                        onDrop={!isMobile ? (e) => handleDrop(e, r.id) : undefined}
                        onDragEnd={!isMobile ? clearDrag : undefined}
                        onClick={() => { setSelectedRoleId(r.id); setRoleDetailTab(r.isEveryone ? 'permissions' : 'display'); setRoleMemberSearch(''); }}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedRoleId(r.id); setRoleDetailTab(r.isEveryone ? 'permissions' : 'display'); setRoleMemberSearch(''); } }}
                        className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl border border-default hover:bg-fill-hover transition-all text-left group cursor-pointer"
                        style={{ opacity: isDraggingThis ? 0.4 : 1 }}
                      >
                        {/* Drag handle / mobile bump buttons / fixed-position spacer */}
                        {!isMobile ? (
                          isFixed ? (
                            <span className="w-3.5 shrink-0" aria-hidden />
                          ) : (
                            <GripVertical size={14} className="shrink-0 cursor-grab active:cursor-grabbing text-t-tertiary group-hover:text-t-secondary transition-colors" />
                          )
                        ) : (
                          <div className="flex flex-col shrink-0 -my-1" onClick={(e) => e.stopPropagation()}>
                            <button type="button" disabled={!canMobileMoveUp}
                              onClick={(e) => { e.stopPropagation(); bumpRole(r.id, -1); }}
                              className="p-0.5 rounded-lg text-t-secondary disabled:opacity-30 hover:text-t-primary"
                              aria-label={t('common.moveUp', { defaultValue: 'Move up' })}>
                              <ChevronUp size={12} />
                            </button>
                            <button type="button" disabled={!canMobileMoveDown}
                              onClick={(e) => { e.stopPropagation(); bumpRole(r.id, 1); }}
                              className="p-0.5 rounded-lg text-t-secondary disabled:opacity-30 hover:text-t-primary"
                              aria-label={t('common.moveDown', { defaultValue: 'Move down' })}>
                              <ChevronDown size={12} />
                            </button>
                          </div>
                        )}
                        <div className="w-4 h-4 rounded-full shrink-0 ring-2 ring-white/10" style={{ backgroundColor: isValidCssColor(r.color) ? r.color : '#99aab5' }} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate text-t-primary">{r.name}</p>
                          <p className="text-[10px] text-t-secondary">{t('serverSettings.members', { count: r.memberCount })}</p>
                        </div>
                        {r.locked && <Lock size={13} className="opacity-30 text-t-secondary" />}
                        <ChevronRight size={14} className="opacity-30 group-hover:opacity-70 transition-opacity text-t-secondary" />
                      </div>
                      {showLineAfter && (
                        <div className="absolute left-0 right-0 -bottom-1 h-0.5 rounded-full pointer-events-none" style={{ backgroundColor: 'var(--cyan-accent)', boxShadow: '0 0 6px var(--cyan-accent)' }} />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
        {confirmDialog && <ConfirmDialog {...confirmDialog} onCancel={() => setConfirmDialog(null)} />}
      </>
    );
  }

  // Roles detail view
  if (!selectedRole) return null;

  // Multi-role: prefer the roles[] array (id-matched). Falls back to the
  // legacy single display-role name match for members fetched before the
  // backend started returning roles[] (e.g. cached rows).
  const memberHasSelectedRole = (m: typeof localMembers[number]): boolean => {
    if (m.roles && m.roles.length > 0) return m.roles.some(r => r.id === selectedRole.id);
    return (m.role ?? '').toLowerCase() === selectedRole.name.toLowerCase();
  };
  const roleMembersInRole = localMembers.filter(memberHasSelectedRole);
  const filteredRoleMembers = roleMemberSearch
    ? roleMembersInRole.filter(m => m.username.toLowerCase().includes(roleMemberSearch.toLowerCase()))
    : roleMembersInRole;
  // Multi-role world: the server owner can hold custom roles too (Founders,
  // etc.) — server ownership is tracked separately via Server.ownerId, so
  // assigning a hoist role doesn't change who owns the server. The Owner
  // role itself is locked (selectedRole.locked) and the locked check on the
  // remove button below prevents touching members in locked roles.
  const nonRoleMembers = localMembers.filter(m => !memberHasSelectedRole(m));
  const filteredNonRoleMembers = roleMemberSearch
    ? nonRoleMembers.filter(m => m.username.toLowerCase().includes(roleMemberSearch.toLowerCase()))
    : nonRoleMembers;

  return (
    <>
      <div className="max-w-3xl space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <button type="button" onClick={() => setSelectedRoleId(null)}
            className="p-2 rounded-lg hover:bg-fill-hover transition-all text-t-secondary">
            <ChevronLeft size={18} />
          </button>
          <div className="w-4 h-4 rounded-full ring-2 ring-white/10" style={{ backgroundColor: isValidCssColor(selectedRole.color) ? selectedRole.color : '#99aab5' }} />
          <h1 className="text-xl font-semibold tracking-tight text-t-primary">{selectedRole.name}</h1>
          {selectedRole.locked && <Lock size={13} className="opacity-40 text-t-secondary" />}
        </div>

        {/* Tabs — @everyone only exposes the Permissions tab (no display/members). */}
        <div className="flex gap-1 p-1 rounded-xl bg-app-surface">
          {((selectedRole.isEveryone ? ['permissions'] : ['display', 'permissions', 'members']) as Array<'display' | 'permissions' | 'members'>).map(tab => (
            <button key={tab} type="button" onClick={() => setRoleDetailTab(tab)}
              className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-all ${roleDetailTab === tab ? 'bg-floating text-t-primary shadow-sm' : 'text-t-secondary hover:bg-fill-hover'}`}>
              {tab === 'display' ? t('serverSettings.roleTabDisplay') : tab === 'permissions' ? t('serverSettings.roleTabPermissions') : t('serverSettings.roleTabMembers', { count: roleMembersInRole.length })}
            </button>
          ))}
        </div>

        {/* Display tab — editable even for locked roles (Owner). The lock
            only prevents permissions + members changes, which the server
            enforces separately. */}
        {roleDetailTab === 'display' && (
          <Card>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <InputField label={t('serverSettings.roleName')} value={roleEditName} onChange={(e) => setRoleEditName((e.target as HTMLInputElement).value)} />
              <div>
                <label className="block text-[11px] font-medium mb-2 text-t-secondary">{t('serverSettings.color')}</label>
                <div className="flex flex-wrap gap-1.5">
                  {ROLE_COLOR_SWATCHES.map((c) => (
                    <button key={c} type="button" onClick={() => setRoleEditColor(c)}
                      className={`w-6 h-6 rounded-full border-2 transition-all ${roleEditColor === c ? 'border-white scale-110' : 'border-transparent hover:scale-105'}`}
                      style={{ backgroundColor: c }} />
                  ))}
                </div>
              </div>
            </div>
            <div className="space-y-1 pt-3 border-t border-default">
              <SettingRow title={t('serverSettings.ownSection')} desc={t('serverSettings.ownSectionDesc')}>
                <Toggle checked={roleEditDisplaySep} onChange={setRoleEditDisplaySep} />
              </SettingRow>
              <SettingRow title={t('serverSettings.mentionable')} desc={t('serverSettings.mentionableDesc')}>
                <Toggle checked={roleEditAllowMention} onChange={setRoleEditAllowMention} />
              </SettingRow>
              {!selectedRole.locked && !selectedRole.isEveryone && (
                <SettingRow
                  title={t('serverSettings.selfAssignable', { defaultValue: 'Self-assignable' })}
                  desc={t('serverSettings.selfAssignableDesc', {
                    defaultValue: 'Members can claim this role themselves from the role-picker channel.',
                  })}
                >
                  <Toggle checked={roleEditSelfAssignable} onChange={setRoleEditSelfAssignable} />
                </SettingRow>
              )}
              {!selectedRole.isEveryone && (
                <SettingRow
                  title={t('serverSettings.hiddenRole', { defaultValue: 'Hidden role' })}
                  desc={t('serverSettings.hiddenRoleDesc', {
                    defaultValue: 'Only members with Manage Roles can see this role. Its permissions still apply.',
                  })}
                >
                  <Toggle checked={roleEditHidden} onChange={setRoleEditHidden} />
                </SettingRow>
              )}
              {!selectedRole.isEveryone && (
                <SettingRow
                  title={t('serverSettings.blockSelfRoles', { defaultValue: 'Block self-roles' })}
                  desc={t('serverSettings.blockSelfRolesDesc', {
                    defaultValue: 'Members holding this role cannot claim any self-role from the picker.',
                  })}
                >
                  <Toggle checked={roleEditBlocksSelf} onChange={setRoleEditBlocksSelf} />
                </SettingRow>
              )}
            </div>
          </Card>
        )}

        {/* Permissions tab */}
        {roleDetailTab === 'permissions' && (
          <div>
            <div className="space-y-3">
              {ROLE_PERMISSION_GROUPS.map((group) => (
                <Card key={group.title}>
                  <p className={`text-[11px] font-semibold uppercase tracking-wider mb-3 ${group.title === 'Dangerous' ? 'text-red-500' : 'text-t-secondary'}`}>{t('serverSettings.permGroup' + group.title.replace(/\s+/g, ''))}</p>
                  <div className="space-y-1">
                    {group.permissions.map((perm) => (
                      <div key={perm.id} className="flex items-center justify-between py-2 group/perm">
                        <div className="min-w-0 mr-4">
                          <p className="text-[13px] font-medium text-t-primary">{t(`serverSettings.perm.${perm.id}`)}</p>
                          <p className="text-[10px] opacity-0 group-hover/perm:opacity-100 transition-opacity text-t-secondary">{t(`serverSettings.permDesc.${perm.id}`)}</p>
                        </div>
                        <Toggle checked={!!roleEditPermissions[perm.id]} onChange={(v) => setRoleEditPermissions((p) => ({ ...p, [perm.id]: v }))} disabled={selectedRole.locked && !selectedRole.isEveryone} />
                      </div>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Members tab */}
        {roleDetailTab === 'members' && (
          <div className="space-y-4">
            <div className="relative">
              <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-t-secondary" />
              <input value={roleMemberSearch} onChange={(e) => setRoleMemberSearch(e.target.value)}
                placeholder={t('serverSettings.searchMembers')}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all bg-app-surface text-t-primary" />
            </div>

            {/* Current members in this role */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-2 text-t-secondary">
                {t('serverSettings.membersInRole')} — {roleMembersInRole.length}
              </p>
              {filteredRoleMembers.length === 0 ? (
                <Card>
                  <p className="text-sm text-center py-6 text-t-secondary">
                    {roleMemberSearch ? t('serverSettings.noMatchingMembersInRole') : t('serverSettings.noMembersInRole')}
                  </p>
                </Card>
              ) : (
                <div className="space-y-1">
                  {filteredRoleMembers.map(m => (
                    <div key={m.id} className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-default hover:bg-fill-hover transition-all">
                      <LetterAvatar avatar={m.avatar} username={m.username} size={32} className="rounded-full shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate text-t-primary">{m.username}</p>
                        {m.discriminator && <p className="text-[10px] text-t-secondary">#{m.discriminator}</p>}
                      </div>
                      {!selectedRole.locked && (
                        <button type="button" disabled={roleMemberLoading}
                          className="p-1.5 rounded-lg hover:bg-red-400/10 transition-all group/rm"
                          title={t('serverSettings.removeFromRole')}
                          onClick={async () => {
                            setRoleMemberLoading(true);
                            try {
                              await onRemoveMemberFromRole?.(server.id, selectedRole.id, m.id);
                              setLocalMembers(prev => prev.map(mem => mem.id === m.id ? { ...mem, roles: (mem.roles ?? []).filter(r => r.id !== selectedRole.id) } : mem));
                              onRolesUpdated?.();
                              if (getServerRoles) { const r = await getServerRoles(server.id); setRoles2(r.map(apiRoleToServerRole)); }
                              showToast(t('serverSettings.memberRemovedFromRole', { member: m.username, role: selectedRole.name }));
                            } catch { showToast(t('serverSettings.failedToRemoveMember'), 'error'); }
                            setRoleMemberLoading(false);
                          }}>
                          <X size={14} className="text-red-400 opacity-40 group-hover/rm:opacity-100 transition-opacity" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Add members */}
            {!selectedRole.locked && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-2 text-t-secondary">
                  {t('serverSettings.addMembers')}
                </p>
                {filteredNonRoleMembers.length === 0 ? (
                  <Card>
                    <p className="text-sm text-center py-6 text-t-secondary">
                      {roleMemberSearch ? t('serverSettings.noMatchingMembersToAdd') : t('serverSettings.allMembersHaveRole')}
                    </p>
                  </Card>
                ) : (
                  <div className="space-y-1 max-h-64 overflow-y-auto">
                    {filteredNonRoleMembers.map(m => (
                      <div key={m.id} className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-default hover:bg-fill-hover transition-all">
                        <LetterAvatar avatar={m.avatar} username={m.username} size={32} className="rounded-full shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate text-t-primary">{m.username}</p>
                          <p className="text-[10px] text-t-secondary">
                            {t('serverSettings.currentRole', { role: m.role ?? t('serverSettings.memberRole') })}
                          </p>
                        </div>
                        <button type="button" disabled={roleMemberLoading}
                          className="btn-cta px-3 py-1 rounded-xl text-xs transition-all"
                          onClick={async () => {
                            setRoleMemberLoading(true);
                            try {
                              await onAddMemberToRole?.(server.id, selectedRole.id, m.id);
                              // Local optimistic: append the role to the member's multi-role list
                              // without disturbing their display role. The socket event from the
                              // backend (useServerMemberSocketEvents) will reconcile with the
                              // authoritative ID list, so a race where the emitted list arrives
                              // before/after this optimistic update still converges correctly.
                              setLocalMembers(prev => prev.map(mem => mem.id === m.id
                                ? { ...mem, roles: [...(mem.roles ?? []).filter(r => r.id !== selectedRole.id), { id: selectedRole.id, name: selectedRole.name, color: selectedRole.color, style: selectedRole.style, position: selectedRole.position, displaySeparately: selectedRole.displaySeparately }] }
                                : mem));
                              onRolesUpdated?.();
                              if (getServerRoles) { const r = await getServerRoles(server.id); setRoles2(r.map(apiRoleToServerRole)); }
                              showToast(t('serverSettings.memberAddedToRole', { member: m.username, role: selectedRole.name }));
                            } catch { showToast(t('serverSettings.failedToAddMember'), 'error'); }
                            setRoleMemberLoading(false);
                          }}>
                          <Plus size={12} className="inline mr-1" />{t('common.add')}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-3 pt-4 border-t border-default">
          {roleDetailTab !== 'members' && (
            <PrimaryButton loading={roleSaving} disabled={selectedRole.locked && !selectedRole.isEveryone && roleDetailTab === 'permissions'} onClick={async () => {
              if (!onUpdateRole) return;
              // Owner role (locked, not @everyone) accepts Display updates only.
              // @everyone (locked but isEveryone) accepts Permissions edits only — backend strips name/position/color/etc.
              if (selectedRole.locked && !selectedRole.isEveryone && roleDetailTab === 'permissions') return;
              setRoleSaving(true);
              try {
                const payload: Parameters<NonNullable<typeof onUpdateRole>>[2] = selectedRole.isEveryone
                  ? { permissions: roleEditPermissions }
                  : selectedRole.locked
                  ? { name: roleEditName, color: roleEditColor, style: roleEditStyle, icon: roleEditIcon || undefined, displaySeparately: roleEditDisplaySep, allowMention: roleEditAllowMention, selfAssignable: roleEditSelfAssignable, hidden: roleEditHidden, blocksSelfRoles: roleEditBlocksSelf }
                  : { name: roleEditName, color: roleEditColor, style: roleEditStyle, icon: roleEditIcon || undefined, permissions: roleEditPermissions, displaySeparately: roleEditDisplaySep, allowMention: roleEditAllowMention, selfAssignable: roleEditSelfAssignable, hidden: roleEditHidden, blocksSelfRoles: roleEditBlocksSelf };
                await onUpdateRole(server.id, selectedRole.id, payload);
                if (getServerRoles) { const r = await getServerRoles(server.id); setRoles2(r.map(apiRoleToServerRole)); }
                onRolesUpdated?.();
                showToast(t('serverSettings.roleSaved'));
              } catch (err) { showToast(err instanceof Error ? err.message : t('serverSettings.failedToSaveRole'), 'error'); }
              setRoleSaving(false);
            }}>{t('serverSettings.saveChanges')}</PrimaryButton>
          )}
          {!selectedRole.locked && (
            <DangerButton onClick={() => setConfirmDialog({ title: t('serverSettings.deleteRole'), desc: t('serverSettings.deleteRoleConfirm', { name: selectedRole.name }), confirmLabel: t('common.delete'), danger: true, onConfirm: async () => {
              if (!onDeleteRole) return;
              try {
                await onDeleteRole(server.id, selectedRole.id);
                setSelectedRoleId(null);
                if (getServerRoles) { const r = await getServerRoles(server.id); setRoles2(r.map(apiRoleToServerRole)); }
                onRolesUpdated?.();
                showToast(t('serverSettings.roleDeleted'));
              } catch { showToast(t('serverSettings.failedToDeleteRole'), 'error'); }
              setConfirmDialog(null);
            }})}>{t('serverSettings.deleteRole')}</DangerButton>
          )}
        </div>
      </div>
      {confirmDialog && <ConfirmDialog {...confirmDialog} onCancel={() => setConfirmDialog(null)} />}
    </>
  );
};

export default RolesSection;
