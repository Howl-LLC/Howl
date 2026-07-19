// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Tag, Search, Check, Lock, Loader2 } from 'lucide-react';
import type { Channel, Server } from '../../types';
import { apiClient } from '../../services/api';
import { socketService } from '../../services/socket';
import { sanitizeImgSrc } from '../../utils/sanitizeImgSrc';
import type { RolePickerTree, RolePickerCategory, RolePickerEntry, ConditionFailure } from '../../services/api/rolePickers';
import { useGlobalToast } from '../../hooks/useGlobalToast';

export interface RolePickerChannelProps {
  server: Server;
  channel: Channel;
}

/**
 * User-facing role picker rendered for channels with type='role_picker'.
 * Replaces the chat area entirely.
 */
export const RolePickerChannel: React.FC<RolePickerChannelProps> = ({ server, channel }) => {
  const { t } = useTranslation();
  const { showGlobalToast } = useGlobalToast();
  const [tree, setTree] = useState<RolePickerTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [busyEntryId, setBusyEntryId] = useState<string | null>(null);
  const [requestNote, setRequestNote] = useState<{ entryId: string; text: string } | null>(null);

  const loadTree = useCallback(async () => {
    try {
      const list = await apiClient.rolePickersList(server.id);
      if (!list.picker) {
        setTree(null);
        return;
      }
      const r = await apiClient.rolePickerGet(server.id, list.picker.id);
      setTree(r);
    } catch (e) {
      showGlobalToast(e instanceof Error ? e.message : t('rolePicker.loadFailed', { defaultValue: 'Failed to load role picker' }), 'warning');
    } finally {
      setLoading(false);
    }
  }, [server.id, showGlobalToast, t]);

  useEffect(() => { loadTree(); }, [loadTree]);

  // Live updates: admin edits the picker, members claim/release roles.
  useEffect(() => {
    const sock = socketService.getSocket();
    if (!sock) return;
    const onPicker = (payload: { serverId: string }) => {
      if (payload.serverId !== server.id) return;
      loadTree();
    };
    const onRoleChange = (payload: { serverId: string }) => {
      if (payload.serverId !== server.id) return;
      loadTree();
    };
    sock.on('role-picker-updated', onPicker);
    sock.on('role-claim-request-updated', onPicker);
    sock.on('server-member-role-added', onRoleChange);
    sock.on('server-member-role-removed', onRoleChange);
    return () => {
      sock.off('role-picker-updated', onPicker);
      sock.off('role-claim-request-updated', onPicker);
      sock.off('server-member-role-added', onRoleChange);
      sock.off('server-member-role-removed', onRoleChange);
    };
  }, [server.id, loadTree]);

  // Filtered categories — only entries whose role name matches the query.
  const filteredCategories = useMemo(() => {
    if (!tree) return [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return tree.categories;
    return tree.categories
      .map((c) => ({
        ...c,
        entries: c.entries.filter((e) => e.role.name.toLowerCase().includes(q)),
      }))
      .filter((c) => c.entries.length > 0);
  }, [tree, searchQuery]);

  const totalRoles = tree?.categories.reduce((n, c) => n + c.entries.length, 0) ?? 0;
  const claimedCount = tree?.categories.reduce((n, c) => n + c.entries.filter((e) => e.held).length, 0) ?? 0;

  const handleClaim = async (cat: RolePickerCategory, entry: RolePickerEntry) => {
    if (busyEntryId) return;
    if (!tree) return;

    // Self-roles blocked — the member holds a role flagged blocksSelfRoles, so
    // they cannot claim anything. Bail with a toast before hitting the server
    // (which 403s independently). Releasing a role they already hold is still
    // allowed, so only gate the claim path.
    if (tree.selfRolesBlocked && !entry.held) {
      showGlobalToast(t('rolePicker.selfRolesBlocked', { defaultValue: 'You are restricted from claiming self-roles in this server.' }), 'warning');
      return;
    }

    // Manual approval — open the request-message modal first.
    if (entry.requirements?.manualApproval && !entry.held && !entry.pending) {
      setRequestNote({ entryId: entry.id, text: '' });
      return;
    }

    setBusyEntryId(entry.id);
    try {
      if (entry.held) {
        // Release
        await apiClient.rolePickerEntryRelease(server.id, tree.id, entry.id);
        // Optimistic update; reconciled by socket event.
        setTree((prev) => prev ? mapEntry(prev, entry.id, (e) => ({ ...e, held: false })) : prev);
      } else {
        const r = await apiClient.rolePickerEntryClaim(server.id, tree.id, entry.id);
        if (r.status === 'granted' || r.status === 'already_held') {
          setTree((prev) => prev ? mapEntry(prev, entry.id, (e) => ({ ...e, held: true })) : prev);
          // Single-mode category: optimistically clear sibling held flags.
          if (cat.pickMode === 'single') {
            setTree((prev) => prev ? {
              ...prev,
              categories: prev.categories.map((c) => c.id === cat.id ? {
                ...c,
                entries: c.entries.map((e) => e.id === entry.id ? { ...e, held: true } : { ...e, held: false }),
              } : c),
            } : prev);
          }
        } else if (r.status === 'pending_approval') {
          setTree((prev) => prev ? mapEntry(prev, entry.id, (e) => ({ ...e, pending: true })) : prev);
          showGlobalToast(t('rolePicker.requestSent', { defaultValue: 'Request sent. Admins will review.' }));
        }
      }
    } catch (e: unknown) {
      const err = e as { status?: number; message?: string; failed?: ConditionFailure[] };
      if (err.status === 422 && Array.isArray(err.failed)) {
        showGlobalToast(formatFailures(err.failed), 'warning');
      } else {
        showGlobalToast(err.message || t('rolePicker.claimFailed', { defaultValue: 'Failed to update role' }), 'warning');
      }
    } finally {
      setBusyEntryId(null);
    }
  };

  const submitRequest = async () => {
    if (!requestNote || !tree) return;
    setBusyEntryId(requestNote.entryId);
    try {
      await apiClient.rolePickerEntryRequest(server.id, tree.id, requestNote.entryId, { applicantMessage: requestNote.text.trim() || undefined });
      setTree((prev) => prev ? mapEntry(prev, requestNote.entryId, (e) => ({ ...e, pending: true })) : prev);
      showGlobalToast(t('rolePicker.requestSent'));
      setRequestNote(null);
    } catch (e) {
      const err = e as { message?: string };
      showGlobalToast(err.message || t('rolePicker.requestFailed', { defaultValue: 'Failed to submit request' }), 'warning');
    } finally {
      setBusyEntryId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 min-w-0 flex items-center justify-center">
        <Loader2 size={28} className="animate-spin text-[var(--cyan-accent)]" />
      </div>
    );
  }

  if (!tree) {
    return (
      <div className="flex-1 min-w-0 flex items-center justify-center">
        <div className="text-center max-w-md">
          <Tag size={40} className="mx-auto mb-3 text-[var(--cyan-accent)]/50" />
          <h2 className="text-lg font-semibold text-t-primary">{t('rolePicker.notConfigured', { defaultValue: 'No roles available yet' })}</h2>
          <p className="text-sm text-t-secondary mt-1">{t('rolePicker.notConfiguredDesc', { defaultValue: 'A server admin needs to set up the picker.' })}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-default flex items-center gap-3 shrink-0">
        <div className="w-7 h-7 rounded-lg bg-[var(--accent-muted)] text-[var(--cyan-accent)] flex items-center justify-center">
          <Tag size={14} />
        </div>
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-t-primary truncate">{channel.name}</h1>
          <p className="text-xs text-t-secondary">
            {t('rolePicker.subtitle', { defaultValue: 'Pick your roles' })}
            {tree.categories.length > 0 && ` · ${totalRoles} role${totalRoles !== 1 ? 's' : ''} in ${tree.categories.length} categories`}
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-6">
          {/* Hero card. Solid deep logo-blue, same fill as btn-cta / selected
              role cards, so it lines up with the rest of the app. */}
          <div className="mb-6 p-4 rounded-2xl bg-[var(--cta-bg)] flex items-center gap-4">
            <div className="w-11 h-11 rounded-xl bg-white/10 text-white flex items-center justify-center shrink-0 text-lg font-bold">★</div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-white">{tree.heroTitle || t('rolePicker.defaultHero', { defaultValue: 'Pick the roles that fit you' })}</h2>
              <p className="text-xs text-white/70 mt-0.5">
                {tree.heroDescription || t('rolePicker.defaultHeroDesc', {
                  defaultValue: 'Roles control how you appear in the member list and which announcements ping you. Toggle any time. Your changes apply instantly.',
                })}
              </p>
            </div>
          </div>

          {/* Self-roles blocked banner — a held role bars this member from claiming. */}
          {tree.selfRolesBlocked && (
            <p className="text-[11px] text-amber-400 mb-2">
              {t('rolePicker.selfRolesBlocked', { defaultValue: 'You are restricted from claiming self-roles in this server.' })}
            </p>
          )}

          {/* Search */}
          {totalRoles > 0 && (
            <div className="mb-5 flex items-center gap-3 bg-app-surface rounded-xl border border-default px-4 py-2.5">
              <Search size={14} className="text-t-tertiary" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('rolePicker.searchPlaceholder', { defaultValue: 'Search roles' })}
                className="flex-1 bg-transparent border-none outline-none text-sm text-t-primary placeholder:text-t-tertiary"
              />
              <span className="text-[11px] text-t-tertiary shrink-0">{claimedCount} of {totalRoles} picked</span>
            </div>
          )}

          {/* Categories */}
          {filteredCategories.length === 0 ? (
            <div className="py-10 text-center text-sm text-t-secondary">
              {searchQuery
                ? t('rolePicker.noMatch', { defaultValue: 'No roles match your search.' })
                : t('rolePicker.noRoles', { defaultValue: 'No roles available yet.' })}
            </div>
          ) : (
            filteredCategories.map((cat) => (
              <div key={cat.id} className="mb-6">
                <div className="flex items-center justify-between pb-2 mb-3 border-b border-default">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-t-tertiary flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-[var(--cyan-accent)]" />
                    {cat.name}
                  </span>
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-fill-hover border border-default text-t-tertiary">
                    {cat.pickMode === 'single' ? t('selfRoles.pickOne', { defaultValue: 'Pick one' }) : t('selfRoles.pickAny', { defaultValue: 'Pick any' })}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {cat.entries.map((entry) => (
                    <RoleCard
                      key={entry.id}
                      entry={entry}
                      busy={busyEntryId === entry.id}
                      blocked={tree.selfRolesBlocked}
                      onClick={() => handleClaim(cat, entry)}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Manual-approval message modal */}
      {requestNote && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setRequestNote(null)}>
          <div className="bg-floating border border-default rounded-2xl p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-t-primary mb-2">{t('rolePicker.requestRole', { defaultValue: 'Request this role' })}</h3>
            <p className="text-sm text-t-secondary mb-4">
              {t('rolePicker.requestRoleDesc', { defaultValue: 'A moderator will review your request. You can include an optional note.' })}
            </p>
            <textarea
              value={requestNote.text}
              onChange={(e) => setRequestNote({ ...requestNote, text: e.target.value.slice(0, 500) })}
              maxLength={500}
              rows={3}
              placeholder={t('rolePicker.requestNotePlaceholder', { defaultValue: 'Why do you want this role? (optional)' })}
              className="w-full rounded-xl px-4 py-3 text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all resize-none bg-app-surface text-t-primary"
            />
            <div className="flex gap-2 justify-end mt-4">
              <button type="button" onClick={() => setRequestNote(null)} className="px-3 py-1.5 text-xs rounded-md text-t-secondary hover:text-t-primary hover:bg-fill-hover transition-colors">
                {t('common.cancel')}
              </button>
              <button type="button" onClick={submitRequest} disabled={busyEntryId === requestNote.entryId} className="btn-cta px-4 py-1.5 text-xs font-semibold rounded-xl transition-all disabled:opacity-50">
                {t('rolePicker.sendRequest', { defaultValue: 'Send request' })}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Role card

const RoleCard: React.FC<{ entry: RolePickerEntry; busy: boolean; blocked?: boolean; onClick: () => void }> = ({ entry, busy, blocked, onClick }) => {
  const isLocked = !entry.held && hasUnmetCondition(entry);
  const showRequestButton = entry.requirements?.manualApproval && !entry.held && !entry.pending;
  // Blocked members can release roles they already hold, but cannot claim new
  // ones — disable the card only when it would be a claim/request action.
  const blockedClaim = !!blocked && !entry.held;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || blockedClaim}
      className={`flex items-center gap-3 p-3 rounded-xl border transition-all text-left ${
        entry.held
          ? 'btn-cta-selected'
          : 'bg-floating border-default hover:border-[var(--cyan-accent)]/30 hover:bg-fill-hover'
      } disabled:opacity-60 disabled:cursor-wait`}
    >
      <div className="w-9 h-9 rounded-lg bg-fill-hover flex items-center justify-center text-xl shrink-0 overflow-hidden">
        {entry.iconUrl ? (
          <img
            src={sanitizeImgSrc(entry.iconUrl)}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
            decoding="async"
          />
        ) : entry.emoji ? (
          <span>{entry.emoji}</span>
        ) : (
          <Tag size={16} className="text-t-tertiary" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className={`flex items-center gap-2 text-sm font-semibold ${entry.held ? 'text-white' : 'text-t-primary'}`}>
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: entry.role.color }} />
          <span className="truncate">{entry.role.name}</span>
        </div>
        <div className={`text-[11px] line-clamp-1 mt-0.5 ${entry.held ? 'text-white/70' : 'text-t-tertiary'}`}>
          {entry.description ?? `${entry.memberCount} member${entry.memberCount !== 1 ? 's' : ''}`}
        </div>
      </div>
      {entry.pending ? (
        <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400">
          Pending
        </span>
      ) : showRequestButton ? (
        <span className="text-[10px] font-semibold px-2.5 py-1 rounded-md bg-[var(--cyan-accent)]/15 text-[var(--cyan-accent)]">
          Request
        </span>
      ) : isLocked ? (
        <span className="text-amber-400 shrink-0" title="Conditions not met">
          <Lock size={14} />
        </span>
      ) : (
        <span className={`w-6 h-6 rounded-full border-[1.5px] flex items-center justify-center shrink-0 transition-colors ${
          entry.held ? 'bg-[var(--cyan-accent)] border-[var(--cyan-accent)] text-black' : 'border-default'
        }`}>
          {entry.held && <Check size={12} />}
        </span>
      )}
    </button>
  );
};

// Helpers

function mapEntry(tree: RolePickerTree, entryId: string, fn: (e: RolePickerEntry) => RolePickerEntry): RolePickerTree {
  return {
    ...tree,
    categories: tree.categories.map((c) => ({
      ...c,
      entries: c.entries.map((e) => e.id === entryId ? fn(e) : e),
    })),
  };
}

function hasUnmetCondition(entry: RolePickerEntry): boolean {
  // Best-effort heuristic — backend is the source of truth; this is just for
  // the visual lock badge. We don't have the user's tenure/message-count on
  // the frontend, so we render the lock if any non-trivial requirement is set.
  // Backend's 422 surface is the real gate — clicking still tries.
  const r = entry.requirements;
  if (!r) return false;
  if (r.manualApproval) return false; // shows "Request" badge instead
  // Always show lock when conditions exist; user clicks to actually try.
  return !!(r.accountAgeDays || r.tenureDays || r.messageCount || (r.hasRoleIds && r.hasRoleIds.length > 0));
}

function formatFailures(failed: ConditionFailure[]): string {
  return failed
    .map((f) => {
      switch (f.kind) {
        case 'accountAge':
          return `Account must be ${f.required}+ days old (yours: ${f.current})`;
        case 'tenure':
          return `Must be in this server ${f.required}+ days (yours: ${f.current})`;
        case 'hasRole':
          return `Need ${f.missing.length} more role${f.missing.length !== 1 ? 's' : ''} first`;
        case 'excludedRole':
          return 'You hold a role that disqualifies you from this role';
        case 'messageCount':
          return `Need ${f.required}+ messages in this server (yours: ${f.current})`;
        case 'manualApproval':
          return 'Manual approval required';
      }
    })
    .join(' · ');
}
