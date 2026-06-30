// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Tag, Plus, Trash2, Lock, X, Smile, Upload, Sparkles } from 'lucide-react';
import type { Server } from '../../types';
import type { ServerRoleFromAPI } from '../../types/server';
import { apiClient } from '../../services/api';
import { socketService } from '../../services/socket';
import { useAuthStore } from '../../stores/authStore';
import { getBackendOrigin } from '../../config';
import { sanitizeImgSrc } from '../../utils/sanitizeImgSrc';
import type { RolePickerTree, RolePickerCategory, RolePickerEntry, ConditionRequirements } from '../../services/api/rolePickers';
import { Card, Toggle } from '../settings/SettingsWidgets';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/modal';
import { Button } from '../ui/button';
import { RoleConditionsPopover } from './RoleConditionsPopover';

const EmojiPicker = React.lazy(() => import('../EmojiPicker').then(m => ({ default: m.EmojiPicker })));

// Mirrors backend powerUpTier(); custom role icons unlock at tier 1.
function computePowerUpTier(count: number): number {
  if (count >= 14) return 3;
  if (count >= 7) return 2;
  if (count >= 2) return 1;
  return 0;
}

export interface SelfRolesPickersProps {
  server: Server;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

export const SelfRolesPickers: React.FC<SelfRolesPickersProps> = ({ server, showToast }) => {
  const { t } = useTranslation();
  const serverId = server.id;

  const [picker, setPicker] = useState<RolePickerTree | null>(null);
  const [pickerSummaryNull, setPickerSummaryNull] = useState(false);
  const [loading, setLoading] = useState(true);
  const [allRoles, setAllRoles] = useState<ServerRoleFromAPI[]>([]);
  const [showAddRoleModal, setShowAddRoleModal] = useState<{ categoryId: string } | null>(null);
  const [conditionsOpen, setConditionsOpen] = useState<{ entryId: string; anchorRect: DOMRect | null } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await apiClient.rolePickersList(serverId);
      if (!list.picker) {
        setPicker(null);
        setPickerSummaryNull(true);
        setLoading(false);
        return;
      }
      const tree = await apiClient.rolePickerGet(serverId, list.picker.id);
      setPicker(tree);
      setPickerSummaryNull(false);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('selfRoles.loadFailed', { defaultValue: 'Failed to load picker' }), 'error');
    } finally {
      setLoading(false);
    }
  }, [serverId, showToast, t]);

  // Roles list for the "add role" modal — fetched once on mount.
  const refreshRoles = useCallback(async () => {
    try {
      const r = await apiClient.getServerRoles(serverId);
      setAllRoles(r);
    } catch { /* best-effort */ }
  }, [serverId]);

  useEffect(() => {
    refresh();
    refreshRoles();
  }, [refresh, refreshRoles]);

  // Live refresh on co-admin changes.
  useEffect(() => {
    const sock = socketService.getSocket();
    if (!sock) return;
    const handler = (payload: { serverId: string }) => {
      if (payload.serverId !== serverId) return;
      refresh();
      refreshRoles();
    };
    sock.on('role-picker-updated', handler);
    sock.on('server-role-created', handler);
    sock.on('server-role-updated', handler);
    sock.on('server-role-deleted', handler);
    return () => {
      sock.off('role-picker-updated', handler);
      sock.off('server-role-created', handler);
      sock.off('server-role-updated', handler);
      sock.off('server-role-deleted', handler);
    };
  }, [serverId, refresh, refreshRoles]);

  // Hero local-edit state — declared at the top level so React's hook order
  // is stable across the loading / empty / editor renders. Sync runs on
  // every render via the effect below; cheap to set primitives.
  const [heroTitle, setHeroTitle] = useState('');
  const [heroDescription, setHeroDescription] = useState('');
  useEffect(() => {
    setHeroTitle(picker?.heroTitle ?? '');
    setHeroDescription(picker?.heroDescription ?? '');
  }, [picker?.id, picker?.heroTitle, picker?.heroDescription]);

  if (loading) {
    return (
      <div className="py-12 flex items-center justify-center">
        <span className="text-sm text-t-secondary">{t('common.loading')}</span>
      </div>
    );
  }

  // Empty state — no picker on this server.
  if (!picker || pickerSummaryNull) {
    return (
      <Card>
        <div className="text-center py-8">
          <Tag size={40} className="mx-auto mb-3 text-[var(--cyan-accent)]/60" />
          <h3 className="text-base font-semibold text-t-primary mb-1">
            {t('selfRoles.noPicker', { defaultValue: 'No role picker yet' })}
          </h3>
          <p className="text-sm text-t-secondary mb-5 max-w-sm mx-auto">
            {t('selfRoles.noPickerDesc', {
              defaultValue: 'Create a role-picker channel to let members claim roles on their own. One picker per server.',
            })}
          </p>
          <button
            type="button"
            onClick={async () => {
              try {
                const r = await apiClient.createChannel(serverId, 'roles', 'role_picker', null, false);
                showToast(t('selfRoles.pickerCreated', { defaultValue: 'Picker channel created' }));
                // Live refresh fires via socket; explicit refresh as fallback.
                refresh();
                void r;
              } catch (e) {
                showToast(e instanceof Error ? e.message : t('selfRoles.createPickerFailed', { defaultValue: 'Failed to create picker' }), 'error');
              }
            }}
            className="btn-cta px-5 py-2 rounded-xl text-sm transition-all inline-flex items-center gap-2"
          >
            <Plus size={14} />
            {t('selfRoles.createPicker', { defaultValue: 'Create role-picker channel' })}
          </button>
        </div>
      </Card>
    );
  }

  // Hero update (debounced via blur).
  const updateHero = async (data: { heroTitle?: string | null; heroDescription?: string | null }) => {
    try {
      await apiClient.rolePickerUpdate(serverId, picker.id, data);
      // Refresh handled via socket round-trip; local optimistic update for snappiness:
      setPicker((p) => p ? { ...p, ...data } : p);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('selfRoles.saveFailed', { defaultValue: 'Failed to save' }), 'error');
    }
  };

  const createCategory = async () => {
    try {
      await apiClient.rolePickerCategoryCreate(serverId, picker.id, { name: 'New category', pickMode: 'multi' });
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('selfRoles.createFailed', { defaultValue: 'Failed to create' }), 'error');
    }
  };

  const renameCategory = async (catId: string, name: string) => {
    try {
      await apiClient.rolePickerCategoryUpdate(serverId, picker.id, catId, { name });
      setPicker((p) => p ? { ...p, categories: p.categories.map((c) => c.id === catId ? { ...c, name } : c) } : p);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('selfRoles.saveFailed'), 'error');
    }
  };

  const setPickMode = async (catId: string, pickMode: 'single' | 'multi') => {
    try {
      await apiClient.rolePickerCategoryUpdate(serverId, picker.id, catId, { pickMode });
      setPicker((p) => p ? { ...p, categories: p.categories.map((c) => c.id === catId ? { ...c, pickMode } : c) } : p);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('selfRoles.saveFailed'), 'error');
    }
  };

  const setRequired = async (catId: string, required: boolean) => {
    try {
      await apiClient.rolePickerCategoryUpdate(serverId, picker.id, catId, { required });
      setPicker((p) => p ? { ...p, categories: p.categories.map((c) => c.id === catId ? { ...c, required } : c) } : p);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('selfRoles.saveFailed'), 'error');
    }
  };

  const deleteCategory = async (catId: string) => {
    if (!confirm(t('selfRoles.deleteCategoryConfirm', { defaultValue: 'Delete this category? All its roles will be removed from the picker.' }))) return;
    try {
      await apiClient.rolePickerCategoryDelete(serverId, picker.id, catId);
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('selfRoles.deleteFailed', { defaultValue: 'Failed to delete' }), 'error');
    }
  };

  const addEntry = async (catId: string, roleId: string) => {
    try {
      await apiClient.rolePickerEntryCreate(serverId, picker.id, catId, { roleId });
      await refresh();
      setShowAddRoleModal(null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('selfRoles.addRoleFailed', { defaultValue: 'Failed to add role' }), 'error');
    }
  };

  const updateEntry = async (entryId: string, data: { emoji?: string | null; iconUrl?: string | null; description?: string | null; requirements?: ConditionRequirements | null }) => {
    try {
      await apiClient.rolePickerEntryUpdate(serverId, picker.id, entryId, data);
      setPicker((p) => p ? {
        ...p,
        categories: p.categories.map((c) => ({
          ...c,
          entries: c.entries.map((e) => e.id === entryId ? { ...e, ...data } as RolePickerEntry : e),
        })),
      } : p);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('selfRoles.saveFailed'), 'error');
    }
  };

  const deleteEntry = async (entryId: string) => {
    try {
      await apiClient.rolePickerEntryDelete(serverId, picker.id, entryId);
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('selfRoles.deleteFailed'), 'error');
    }
  };

  const conditionsAnchorEntry = conditionsOpen
    ? picker.categories.flatMap((c) => c.entries).find((e) => e.id === conditionsOpen.entryId)
    : null;

  return (
    <div className="space-y-4">
      {/* Hero editor */}
      <Card>
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] font-medium mb-2 text-t-secondary">{t('selfRoles.heroTitle', { defaultValue: 'Hero title' })}</label>
            <input
              value={heroTitle}
              onChange={(e) => setHeroTitle(e.target.value.slice(0, 80))}
              onBlur={() => heroTitle !== (picker.heroTitle ?? '') && updateHero({ heroTitle: heroTitle.trim() || null })}
              placeholder="Pick the roles that fit you"
              className="w-full rounded-xl px-4 py-3 text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all bg-app-surface text-t-primary"
              maxLength={80}
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium mb-2 text-t-secondary">{t('selfRoles.heroDescription', { defaultValue: 'Hero description' })}</label>
            <textarea
              value={heroDescription}
              onChange={(e) => setHeroDescription(e.target.value.slice(0, 280))}
              onBlur={() => heroDescription !== (picker.heroDescription ?? '') && updateHero({ heroDescription: heroDescription.trim() || null })}
              rows={2}
              maxLength={280}
              placeholder="Roles control how you appear in the member list..."
              className="w-full rounded-xl px-4 py-3 text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all resize-none bg-app-surface text-t-primary"
            />
            <p className="text-[11px] text-t-secondary mt-1 text-right tabular-nums">{heroDescription.length} / 280</p>
          </div>
        </div>
      </Card>

      {/* Categories */}
      {picker.categories.map((cat) => (
        <CategoryBlock
          key={cat.id}
          category={cat}
          server={server}
          allEntryRoleIds={new Set(picker.categories.flatMap((c) => c.entries.map((e) => e.roleId)))}
          onRename={(name) => renameCategory(cat.id, name)}
          onSetPickMode={(mode) => setPickMode(cat.id, mode)}
          onSetRequired={(required) => setRequired(cat.id, required)}
          onDelete={() => deleteCategory(cat.id)}
          onAddRole={() => setShowAddRoleModal({ categoryId: cat.id })}
          onUpdateEntry={updateEntry}
          onDeleteEntry={deleteEntry}
          onOpenConditions={(entryId, anchorRect) => setConditionsOpen({ entryId, anchorRect })}
          onUploadFailed={(msg) => showToast(msg, 'error')}
        />
      ))}

      <button
        type="button"
        onClick={createCategory}
        className="w-full py-4 px-3 rounded-xl border-2 border-dashed border-default text-sm font-medium text-t-secondary hover:border-[var(--cyan-accent)]/40 hover:text-[var(--cyan-accent)] hover:bg-[rgba(7,111,160,0.04)] transition-all flex items-center justify-center gap-2"
      >
        <Plus size={14} />
        {t('selfRoles.addCategory', { defaultValue: 'Add category' })}
      </button>

      {/* Add-role modal */}
      {showAddRoleModal && (() => {
        const usedRoleIds = new Set(picker.categories.flatMap((c) => c.entries.map((e) => e.roleId)));
        const eligible = allRoles.filter((r) => r.selfAssignable && !r.locked && !r.isEveryone && !usedRoleIds.has(r.id));
        return (
          <Modal open onClose={() => setShowAddRoleModal(null)} size="md">
            <ModalHeader>
              <h3 className="text-lg font-semibold text-t-primary">{t('selfRoles.addRole', { defaultValue: 'Add role to picker' })}</h3>
            </ModalHeader>
            <ModalBody>
              {eligible.length === 0 ? (
                <p className="text-sm text-t-secondary py-4">
                  {t('selfRoles.noEligibleRoles', {
                    defaultValue: 'No self-assignable roles available. Mark a role "self-assignable" in the Roles tab first.',
                  })}
                </p>
              ) : (
                <div className="space-y-1 max-h-[400px] overflow-y-auto">
                  {eligible.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => addEntry(showAddRoleModal.categoryId, r.id)}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-fill-hover transition-colors text-left"
                    >
                      <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: r.color }} />
                      <span className="flex-1 text-sm font-medium text-t-primary">{r.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </ModalBody>
            <ModalFooter>
              <Button variant="ghost" size="md" onClick={() => setShowAddRoleModal(null)}>{t('common.cancel')}</Button>
            </ModalFooter>
          </Modal>
        );
      })()}

      {/* Conditions popover */}
      {conditionsOpen && conditionsAnchorEntry && (
        <RoleConditionsPopover
          anchorRect={conditionsOpen.anchorRect}
          requirements={conditionsAnchorEntry.requirements ?? {}}
          allRoles={allRoles}
          onClose={() => setConditionsOpen(null)}
          onSave={async (req) => {
            await updateEntry(conditionsOpen.entryId, { requirements: req });
            setConditionsOpen(null);
          }}
        />
      )}
    </div>
  );
};

// Category block

interface CategoryBlockProps {
  category: RolePickerCategory;
  server: Server;
  allEntryRoleIds: Set<string>;
  onRename: (name: string) => void;
  onSetPickMode: (mode: 'single' | 'multi') => void;
  onSetRequired: (required: boolean) => void;
  onDelete: () => void;
  onAddRole: () => void;
  onUpdateEntry: (entryId: string, data: { emoji?: string | null; iconUrl?: string | null; description?: string | null; requirements?: ConditionRequirements | null }) => void;
  onDeleteEntry: (entryId: string) => void;
  onOpenConditions: (entryId: string, anchorRect: DOMRect | null) => void;
  onUploadFailed: (message: string) => void;
}

const CategoryBlock: React.FC<CategoryBlockProps> = ({
  category, server, onRename, onSetPickMode, onSetRequired, onDelete, onAddRole,
  onUpdateEntry, onDeleteEntry, onOpenConditions, onUploadFailed,
}) => {
  const { t } = useTranslation();
  const [name, setName] = useState(category.name);
  useEffect(() => { setName(category.name); }, [category.name]);

  return (
    <div className="rounded-xl border border-default bg-floating overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-default bg-fill-hover">
        <input
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 40))}
          onBlur={() => name.trim() && name !== category.name && onRename(name.trim())}
          className="flex-1 bg-transparent border-none outline-none text-sm font-semibold text-t-primary"
          maxLength={40}
        />
        <select
          value={category.pickMode}
          onChange={(e) => onSetPickMode(e.target.value as 'single' | 'multi')}
          className="text-[11px] font-medium px-2 py-1 rounded-md bg-app-surface border border-default text-t-secondary outline-none cursor-pointer"
        >
          <option value="multi">{t('selfRoles.pickAny', { defaultValue: 'Pick any' })}</option>
          <option value="single">{t('selfRoles.pickOne', { defaultValue: 'Pick one' })}</option>
        </select>
        <label className="flex items-center gap-1.5 text-[11px] font-medium text-t-secondary cursor-pointer" title={t('selfRoles.requiredTitle', { defaultValue: 'Members must pick a role from this category during onboarding' })}>
          {t('selfRoles.required', { defaultValue: 'Required' })}
          <Toggle checked={category.required} onChange={onSetRequired} />
        </label>
        <button type="button" onClick={onDelete} className="p-1.5 rounded-md hover:bg-red-500/10 text-t-secondary hover:text-red-400 transition-colors" title={t('common.delete')}>
          <Trash2 size={14} />
        </button>
      </div>
      <div className="p-3 space-y-2">
        {category.entries.map((entry) => (
          <RoleRow
            key={entry.id}
            entry={entry}
            server={server}
            onUpdate={(data) => onUpdateEntry(entry.id, data)}
            onDelete={() => onDeleteEntry(entry.id)}
            onOpenConditions={(anchor) => onOpenConditions(entry.id, anchor)}
            onUploadFailed={onUploadFailed}
          />
        ))}
        <button
          type="button"
          onClick={onAddRole}
          className="w-full py-2 px-3 rounded-lg border border-dashed border-default text-xs text-t-secondary hover:border-[var(--cyan-accent)]/40 hover:text-[var(--cyan-accent)] transition-colors flex items-center justify-center gap-2"
        >
          <Plus size={12} />
          {t('selfRoles.addRoleToCategory', { defaultValue: 'Add role to' })} {category.name}
        </button>
      </div>
    </div>
  );
};

// Role row

interface RoleRowProps {
  entry: RolePickerEntry;
  server: Server;
  onUpdate: (data: { emoji?: string | null; iconUrl?: string | null; description?: string | null; requirements?: ConditionRequirements | null }) => void;
  onDelete: () => void;
  onOpenConditions: (anchor: DOMRect | null) => void;
  onUploadFailed: (message: string) => void;
}

const RoleRow: React.FC<RoleRowProps> = ({ entry, server, onUpdate, onDelete, onOpenConditions, onUploadFailed }) => {
  const { t } = useTranslation();
  const [desc, setDesc] = useState(entry.description ?? '');
  const conditionsBtnRef = React.useRef<HTMLButtonElement>(null);

  useEffect(() => { setDesc(entry.description ?? ''); }, [entry.id, entry.description]);

  const condChips = useMemo(() => {
    const r = entry.requirements;
    if (!r) return [];
    const chips: string[] = [];
    if (r.accountAgeDays) chips.push(`Account ${r.accountAgeDays}d+`);
    if (r.tenureDays) chips.push(`Server ${r.tenureDays}d+`);
    if (r.hasRoleIds && r.hasRoleIds.length > 0) chips.push(`Has ${r.hasRoleIds.length} role${r.hasRoleIds.length > 1 ? 's' : ''}`);
    if (r.messageCount) chips.push(`${r.messageCount}+ msgs`);
    if (r.manualApproval) chips.push('Approval');
    return chips;
  }, [entry.requirements]);

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-default bg-app-surface">
      <RoleEntryIconPicker
        entry={entry}
        server={server}
        onUpdate={onUpdate}
        onUploadFailed={onUploadFailed}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm font-semibold text-t-primary">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: entry.role.color }} />
          {entry.role.name}
        </div>
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value.slice(0, 200))}
          onBlur={() => desc !== (entry.description ?? '') && onUpdate({ description: desc || null })}
          placeholder={t('selfRoles.descriptionPlaceholder', { defaultValue: 'Optional description' })}
          maxLength={200}
          className="w-full bg-transparent border-none outline-none text-[12px] text-t-secondary mt-1 placeholder:text-t-tertiary"
        />
        {condChips.length > 0 && (
          <div className="flex gap-1 flex-wrap mt-1.5">
            {condChips.map((c) => (
              <span key={c} className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">{c}</span>
            ))}
          </div>
        )}
      </div>
      <button
        ref={conditionsBtnRef}
        type="button"
        onClick={() => onOpenConditions(conditionsBtnRef.current?.getBoundingClientRect() ?? null)}
        className={`p-2 rounded-lg transition-colors ${condChips.length > 0 ? 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25' : 'hover:bg-fill-hover text-t-secondary hover:text-t-primary'}`}
        title={t('selfRoles.conditions', { defaultValue: 'Conditions' })}
      >
        <Lock size={14} />
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="p-2 rounded-lg hover:bg-red-500/10 text-t-secondary hover:text-red-400 transition-colors"
        title={t('common.delete')}
      >
        <X size={14} />
      </button>
    </div>
  );
};

// Role entry icon picker
// 48×48 button that opens a 3-action popover: pick emoji, upload image,
// or clear. Image upload is gated behind server power-up tier 1.

interface RoleEntryIconPickerProps {
  entry: RolePickerEntry;
  server: Server;
  onUpdate: (data: { emoji?: string | null; iconUrl?: string | null }) => void;
  onUploadFailed: (message: string) => void;
}

const ICON_UPLOAD_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const ICON_UPLOAD_MAX_BYTES = 4 * 1024 * 1024; // 4 MB — small icons only.

const RoleEntryIconPicker: React.FC<RoleEntryIconPickerProps> = ({ entry, server, onUpdate, onUploadFailed }) => {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const currentUser = useAuthStore((s) => s.currentUser);

  const tier = computePowerUpTier(server.powerUpCount ?? 0);
  const canUpload = tier >= 1;
  const hasIcon = !!entry.iconUrl || !!entry.emoji;

  const handlePickEmoji = useCallback((emoji: string) => {
    setEmojiOpen(false);
    setMenuOpen(false);
    onUpdate({ emoji, iconUrl: null });
  }, [onUpdate]);

  const handleUploadClick = useCallback(() => {
    if (!canUpload) return;
    fileInputRef.current?.click();
  }, [canUpload]);

  const handleFile = useCallback(async (file: File | null | undefined) => {
    if (!file) return;
    if (!ICON_UPLOAD_ALLOWED_MIME.includes(file.type)) {
      onUploadFailed(t('selfRoles.iconBadType', { defaultValue: 'Image must be PNG, JPEG, GIF, or WebP.' }));
      return;
    }
    if (file.size > ICON_UPLOAD_MAX_BYTES) {
      onUploadFailed(t('selfRoles.iconTooLarge', { defaultValue: 'Icon must be 4 MB or smaller.' }));
      return;
    }
    setUploading(true);
    try {
      const r = await apiClient.uploadFile(file);
      const url = r.url.startsWith('/') ? getBackendOrigin() + r.url : r.url;
      onUpdate({ emoji: null, iconUrl: url });
      setMenuOpen(false);
    } catch (e) {
      onUploadFailed(e instanceof Error ? e.message : t('selfRoles.iconUploadFailed', { defaultValue: 'Icon upload failed' }));
    } finally {
      setUploading(false);
    }
  }, [onUpdate, onUploadFailed, t]);

  const handleClear = useCallback(() => {
    onUpdate({ emoji: null, iconUrl: null });
    setMenuOpen(false);
  }, [onUpdate]);

  // Close menu on outside click / escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (buttonRef.current?.contains(target ?? null)) return;
      const popoverEl = document.getElementById(`role-icon-menu-${entry.id}`);
      if (popoverEl?.contains(target ?? null)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, entry.id]);

  const buttonRect = menuOpen ? buttonRef.current?.getBoundingClientRect() ?? null : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setMenuOpen((o) => !o)}
        className="w-12 h-12 rounded-lg bg-fill-hover border border-default flex items-center justify-center text-xl outline-none hover:border-[var(--cyan-accent)]/40 transition-colors shrink-0 overflow-hidden"
        title={t('selfRoles.changeIcon', { defaultValue: 'Change icon' })}
      >
        {entry.iconUrl ? (
          <img src={sanitizeImgSrc(entry.iconUrl)} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />
        ) : entry.emoji ? (
          <span>{entry.emoji}</span>
        ) : (
          <Tag size={18} className="text-t-tertiary" />
        )}
      </button>

      {menuOpen && buttonRect && createPortal(
        <div
          id={`role-icon-menu-${entry.id}`}
          className="rounded-xl border border-default bg-floating shadow-xl py-1 min-w-[220px]"
          style={{
            position: 'fixed',
            top: buttonRect.bottom + 6,
            left: buttonRect.left,
            zIndex: 'var(--z-popover)' as unknown as number,
          }}
        >
          <button
            type="button"
            onClick={() => { setEmojiOpen(true); }}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm text-t-primary hover:bg-fill-hover transition-colors text-left"
          >
            <Smile size={14} className="text-t-secondary" />
            <span className="flex-1">{t('selfRoles.iconPickEmoji', { defaultValue: 'Choose emoji' })}</span>
          </button>
          <button
            type="button"
            onClick={handleUploadClick}
            disabled={!canUpload || uploading}
            className={`w-full flex items-center gap-3 px-3 py-2 text-sm text-left transition-colors ${
              canUpload
                ? 'text-t-primary hover:bg-fill-hover'
                : 'text-t-tertiary cursor-not-allowed'
            }`}
            title={canUpload ? undefined : t('selfRoles.iconUploadLockedTitle', { defaultValue: 'Boost this server to power-up tier 1 (2 boosts) to upload custom icons.' })}
          >
            {canUpload ? <Upload size={14} className="text-t-secondary" /> : <Lock size={14} className="text-t-tertiary" />}
            <span className="flex-1">
              {uploading
                ? t('selfRoles.iconUploading', { defaultValue: 'Uploading…' })
                : t('selfRoles.iconUploadImage', { defaultValue: 'Upload image' })}
            </span>
            {!canUpload && (
              <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-[var(--cyan-accent)]/15 text-[var(--cyan-accent)] border border-[var(--cyan-accent)]/30">
                <Sparkles size={9} />
                {t('selfRoles.iconUploadTierBadge', { defaultValue: 'Tier 1' })}
              </span>
            )}
          </button>
          {!canUpload && (
            <p className="px-3 pb-2 pt-0 text-[11px] text-t-tertiary leading-snug">
              {t('selfRoles.iconUploadLocked', { defaultValue: 'Custom icons unlock at power-up tier 1 (2 server boosts).' })}
            </p>
          )}
          {hasIcon && (
            <>
              <div className="my-1 border-t border-default" />
              <button
                type="button"
                onClick={handleClear}
                className="w-full flex items-center gap-3 px-3 py-2 text-sm text-t-secondary hover:bg-red-500/10 hover:text-red-400 transition-colors text-left"
              >
                <Trash2 size={14} />
                <span className="flex-1">{t('selfRoles.iconClear', { defaultValue: 'Remove icon' })}</span>
              </button>
            </>
          )}
        </div>,
        document.body,
      )}

      {emojiOpen && (
        <React.Suspense fallback={null}>
          <EmojiPicker
            open
            onClose={() => setEmojiOpen(false)}
            onSelect={handlePickEmoji}
            anchorRef={buttonRef}
            activeServerId={server.id}
            servers={[server]}
            userPlan={currentUser?.stripePlan}
            userId={currentUser?.id}
          />
        </React.Suspense>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ''; }}
      />
    </>
  );
};
