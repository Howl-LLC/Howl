// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, X, Trash2, Settings, Shield, Check, AlertTriangle, Menu } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { ChannelCategory } from '../../types';

type TabId = 'overview' | 'permissions' | 'delete';

/* ── Props ──────────────────────────────────────────────── */

interface CategorySettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  category: ChannelCategory;
  serverId: string;
  onUpdateCategory: (serverId: string, categoryId: string, data: { name?: string; isPrivate?: boolean }) => Promise<any>;
  onDeleteCategory?: (serverId: string, categoryId: string) => Promise<void>;
  serverRoles?: Array<{ id: string; name: string; color: string }>;
  serverMembers?: Array<{ id: string; username: string; discriminator?: string; avatar?: string | null }>;
  channelCount?: number;
}

/* ── Lazy-load PermissionOverrideEditor ─────────────────── */

const PermissionOverrideEditor = React.lazy(() => import('./PermissionOverrideEditor'));

/* ── Component ──────────────────────────────────────────── */

export const CategorySettingsModal: React.FC<CategorySettingsModalProps> = ({
  isOpen, onClose, category, serverId,
  onUpdateCategory, onDeleteCategory,
  serverRoles = [], serverMembers = [],
  channelCount = 0,
}) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();

  /* ── Tab state ───────────────────────────────────────── */
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  /* ── Local form state ────────────────────────────────── */
  const [name, setName] = useState(category.name);
  const [isPrivate, setIsPrivate] = useState(category.isPrivate ?? false);

  /* ── Save indicator ──────────────────────────────────── */
  const [saved, setSaved] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ── Delete state ────────────────────────────────────── */
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /* ── Sync local state when category prop changes ─────── */
  useEffect(() => {
    setName(category.name);
    setIsPrivate(category.isPrivate ?? false);
    setActiveTab('overview');
    setDeleteConfirm(false);
  }, [category]);

  /* ── Auto-save with debounce ─────────────────────────── */
  const scheduleSave = useCallback((data: { name?: string; isPrivate?: boolean }) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        await onUpdateCategory(serverId, category.id, data);
        setSaved(true);
        if (savedFadeRef.current) clearTimeout(savedFadeRef.current);
        savedFadeRef.current = setTimeout(() => setSaved(false), 2000);
      } catch {
        /* save failed silently */
      }
    }, 500);
  }, [onUpdateCategory, serverId, category.id]);

  /* ── Cleanup timers ──────────────────────────────────── */
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (savedFadeRef.current) clearTimeout(savedFadeRef.current);
    };
  }, []);

  /* ── Field change helpers ────────────────────────────── */
  const changeName = (v: string) => { setName(v); scheduleSave({ name: v }); };
  const changeIsPrivate = (v: boolean) => { setIsPrivate(v); scheduleSave({ isPrivate: v }); };

  /* ── Escape to close ─────────────────────────────────── */
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  /* ── Shared input styles ─────────────────────────────── */
  const inputClass = 'w-full bg-fill-hover border border-[var(--glass-border)] rounded-xl px-4 py-3 text-sm text-t-primary outline-none focus:border-[var(--cyan-accent)]/50 placeholder:text-t-secondary transition-colors';
  const labelClass = 'block text-[11px] font-semibold uppercase tracking-wider mb-2';

  /* ── Tab definitions ─────────────────────────────────── */
  const tabs: Array<{ id: TabId; label: string; icon: React.ReactNode; danger?: boolean }> = [
    { id: 'overview', label: t('categorySettings.overview', 'Overview'), icon: <Settings size={16} /> },
    { id: 'permissions', label: t('categorySettings.permissions', 'Permissions'), icon: <Shield size={16} /> },
    { id: 'delete', label: t('categorySettings.deleteCategory', 'Delete Category'), icon: <Trash2 size={16} />, danger: true },
  ];

  /* ── Sidebar ─────────────────────────────────────────── */
  const sidebar = (
    <div className="flex flex-col gap-1">
      {tabs.map((tab) => (
        <React.Fragment key={tab.id}>
          {tab.danger && <div className="h-px bg-fill-active my-2" />}
          <button
            onClick={() => { setActiveTab(tab.id); if (isMobile) setMobileNavOpen(false); }}
            className={`w-full flex items-center px-4 py-3 rounded-xl transition-all group ${
              activeTab === tab.id
                ? tab.danger
                  ? 'bg-red-500/10 text-red-400 relative overflow-hidden'
                  : 'bg-[var(--cyan-accent)]/[0.08] text-white relative overflow-hidden'
                : tab.danger
                  ? 'text-red-500/60 hover:bg-red-500/5 hover:text-red-400'
                  : 'text-slate-500 hover:bg-fill-hover hover:text-slate-300'
            }`}
          >
            <span className={`mr-3 transition-colors ${
              activeTab === tab.id
                ? tab.danger ? 'text-red-400' : 'text-white'
                : tab.danger ? 'text-red-500/50' : 'text-slate-600 group-hover:text-slate-400'
            }`}>
              {tab.icon}
            </span>
            <span className="text-[11px] font-semibold truncate">{tab.label}</span>
            {activeTab === tab.id && !tab.danger && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-b-lg" style={{ background: 'var(--cyan-accent)' }} />
            )}
            {activeTab === tab.id && tab.danger && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-b-lg bg-red-500" />
            )}
          </button>
        </React.Fragment>
      ))}
    </div>
  );

  /* ── Overview tab content ────────────────────────────── */
  const overviewContent = (
    <div className="space-y-6">
      {/* Category Name */}
      <div>
        <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
          {t('categorySettings.categoryName', 'Category Name')}
        </label>
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-t-secondary"><FolderOpen size={16} /></span>
          <input
            type="text"
            value={name}
            onChange={(e) => changeName(e.target.value.slice(0, 100))}
            maxLength={100}
            className={`${inputClass} pl-10`}
            placeholder={t('categorySettings.categoryNamePlaceholder', 'Category name')}
          />
        </div>
      </div>

      {/* Private Category toggle */}
      <label className="flex items-center justify-between cursor-pointer py-1">
        <div className="mr-4">
          <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            {t('categorySettings.privateCategory', 'Private Category')}
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
            {t('categorySettings.privateCategoryDesc', 'Only selected members and roles can view this category')}
          </div>
        </div>
        <div
          className={`w-10 h-6 rounded-full p-0.5 transition-colors cursor-pointer shrink-0 ${isPrivate ? 'bg-[var(--cyan-accent)]' : 'bg-fill-active'}`}
          onClick={() => changeIsPrivate(!isPrivate)}
        >
          <div className={`w-5 h-5 rounded-full bg-white transition-transform ${isPrivate ? 'translate-x-4' : ''}`} />
        </div>
      </label>
    </div>
  );

  /* ── Permissions tab content ─────────────────────────── */
  const permissionsContent = (
    <React.Suspense fallback={<div className="flex items-center justify-center py-12 text-t-secondary text-sm">{t('common.loading', 'Loading...')}</div>}>
      <PermissionOverrideEditor
        categoryId={category.id}
        serverId={serverId}
        channelType="text"
        roles={serverRoles}
        members={serverMembers}
      />
    </React.Suspense>
  );

  /* ── Delete tab content ──────────────────────────────── */
  const deleteContent = (
    <div className="space-y-6">
      <div className="p-6 bg-red-500/5 border border-red-500/20 rounded-2xl flex flex-col items-center text-center">
        <Trash2 size={48} className="text-red-500 mb-4" />
        <h3 className="text-lg font-semibold text-white mb-2">{t('categorySettings.deleteTitle', 'Delete Category')}</h3>
        <p className="text-sm text-slate-400">
          {t('categorySettings.deleteConfirmation', 'Are you sure you want to delete "{{categoryName}}"? This action cannot be undone.', { categoryName: category.name })}
        </p>
      </div>

      {channelCount > 0 && (
        <div className="flex items-start gap-3 p-4 bg-amber-500/5 border border-amber-500/20 rounded-xl">
          <AlertTriangle size={18} className="text-amber-500 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-400/80">
            {t('categorySettings.channelsWarning', 'This category has {{count}} channel(s). They will become uncategorized.', { count: channelCount })}
          </p>
        </div>
      )}

      {!deleteConfirm ? (
        <button
          type="button"
          onClick={() => setDeleteConfirm(true)}
          className="btn-cta-danger w-full py-3 font-semibold text-sm rounded-xl transition-colors"
        >
          {t('categorySettings.deleteCategory', 'Delete Category')}
        </button>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-red-400 text-center font-medium">
            {t('categorySettings.deleteDoubleConfirm', 'Click again to permanently delete this category')}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setDeleteConfirm(false)}
              className="py-3 bg-fill-hover text-sm font-semibold rounded-xl hover:bg-fill-active transition-colors"
              style={{ color: 'var(--text-secondary)' }}
            >
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              type="button"
              disabled={deleting || !onDeleteCategory}
              onClick={async () => {
                if (!onDeleteCategory) return;
                setDeleting(true);
                try {
                  await onDeleteCategory(serverId, category.id);
                  onClose();
                } catch {
                  setDeleting(false);
                }
              }}
              className="btn-cta-danger py-3 font-semibold text-sm rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {deleting ? t('common.deleting', 'Deleting...') : t('categorySettings.confirmDelete', 'Yes, Delete')}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  /* ── Tab content map ─────────────────────────────────── */
  const tabContent: Record<TabId, React.ReactNode> = {
    overview: overviewContent,
    permissions: permissionsContent,
    delete: deleteContent,
  };

  /* ── Render ──────────────────────────────────────────── */
  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose} />

      {/* Modal */}
      <div
        className={`relative spring-pop-in ${
          isMobile
            ? 'fixed inset-0 flex flex-col'
            : 'w-full max-w-5xl h-[min(92vh,860px)] rounded-2xl border shadow-2xl flex overflow-hidden'
        }`}
        style={{
          backgroundColor: isMobile ? 'var(--bg-primary)' : 'var(--bg-panel)',
          borderColor: isMobile ? undefined : 'var(--border-subtle)',
          backdropFilter: isMobile ? undefined : 'blur(40px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mobile header */}
        {isMobile && (
          <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setMobileNavOpen(!mobileNavOpen)}
                className="p-1.5 rounded-lg hover:bg-fill-active"
                style={{ color: 'var(--text-secondary)' }}
              >
                <Menu size={18} />
              </button>
              <span className="text-t-secondary"><FolderOpen size={16} /></span>
              <h2 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                {category.name}
              </h2>
            </div>
            <div className="flex items-center gap-2">
              {saved && (
                <span className="flex items-center gap-1 text-xs text-green-400 animate-in fade-in duration-200">
                  <Check size={12} /> {t('common.saved', 'Saved')}
                </span>
              )}
              <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-fill-active" style={{ color: 'var(--text-secondary)' }}>
                <X size={18} />
              </button>
            </div>
          </div>
        )}

        {/* Mobile nav panel */}
        {isMobile && mobileNavOpen && (
          <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-panel)' }}>
            {sidebar}
          </div>
        )}

        {/* Desktop sidebar */}
        {!isMobile && (
          <div className="w-[210px] shrink-0 border-r flex flex-col" style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-chat)' }}>
            {/* Sidebar header */}
            <div className="px-4 pt-5 pb-3">
              <div className="flex items-center gap-2 text-t-secondary mb-1">
                <FolderOpen size={16} />
                <span className="text-xs font-medium truncate">{category.name}</span>
              </div>
              <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                {t('categorySettings.title', 'Category Settings')}
              </h2>
            </div>

            {/* Sidebar tabs */}
            <div className="flex-1 px-3 py-2 overflow-y-auto">
              {sidebar}
            </div>
          </div>
        )}

        {/* Content area */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Desktop header with close + saved indicator */}
          {!isMobile && (
            <div className="flex items-center justify-between px-6 pt-5 pb-3">
              <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                {tabs.find(t => t.id === activeTab)?.label}
              </h3>
              <div className="flex items-center gap-3">
                {saved && (
                  <span className="flex items-center gap-1 text-xs text-green-400 animate-in fade-in duration-200">
                    <Check size={12} /> {t('common.saved', 'Saved')}
                  </span>
                )}
                <button onClick={onClose} className="p-2 rounded-lg hover:bg-fill-active transition-colors" style={{ color: 'var(--text-secondary)' }}>
                  <X size={18} />
                </button>
              </div>
            </div>
          )}

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto px-6 pb-6">
            {tabContent[activeTab]}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default CategorySettingsModal;
