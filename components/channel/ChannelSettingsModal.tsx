// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Hash, Volume2, Radio, X, Trash2, Settings, Shield, Check, Plus, Pencil, XCircle, Menu, Smile } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { Channel, ForumTag } from '../../types';
import { apiClient } from '../../services/api';
import { socketService } from '../../services/socket';
import { Dropdown } from '../ui/dropdown';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';

const EmojiPicker = React.lazy(() => import('../EmojiPicker').then(m => ({ default: m.EmojiPicker })));

/* ── Constants ──────────────────────────────────────────── */

const SLOWMODE_OPTIONS = [
  { value: 0, label: 'Off' }, { value: 5, label: '5s' }, { value: 10, label: '10s' },
  { value: 15, label: '15s' }, { value: 30, label: '30s' }, { value: 60, label: '1m' },
  { value: 120, label: '2m' }, { value: 300, label: '5m' }, { value: 600, label: '10m' },
  { value: 900, label: '15m' }, { value: 1800, label: '30m' }, { value: 3600, label: '1h' },
  { value: 7200, label: '2h' }, { value: 21600, label: '6h' },
];

const TAG_COLORS = [
  '#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245',
  '#00b0f4', '#faa61a', '#3ba55d', '#9b59b6', '#e67e22',
];

type TabId = 'overview' | 'permissions' | 'delete';

/* ── Props ──────────────────────────────────────────────── */

interface ChannelSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  channel: Channel;
  serverId: string;
  onUpdateChannel: (serverId: string, channelId: string, data: Partial<Channel>) => Promise<any>;
  onDeleteChannel?: (serverId: string, channelId: string) => Promise<void>;
  serverRoles?: Array<{ id: string; name: string; color: string }>;
  serverMembers?: Array<{ id: string; username: string; discriminator?: string; avatar?: string | null }>;
}

/* ── Lazy-load PermissionOverrideEditor ─────────────────── */

const PermissionOverrideEditor = React.lazy(() => import('./PermissionOverrideEditor'));

/* ── Component ──────────────────────────────────────────── */

export const ChannelSettingsModal: React.FC<ChannelSettingsModalProps> = ({
  isOpen, onClose, channel, serverId,
  onUpdateChannel, onDeleteChannel,
  serverRoles = [], serverMembers = [],
}) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();

  /* ── Tab state ───────────────────────────────────────── */
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  /* ── Local form state ────────────────────────────────── */
  const [name, setName] = useState(channel.name);
  const [description, setDescription] = useState(channel.description ?? '');
  const [slowMode, setSlowMode] = useState(channel.slowMode ?? 0);
  const [ageRestricted, setAgeRestricted] = useState(channel.ageRestricted ?? false);
  const [userLimit, setUserLimit] = useState(channel.userLimit ?? 0);

  // Forum-specific
  const [postGuidelines, setPostGuidelines] = useState(channel.postGuidelines ?? '');
  const [requireTags, setRequireTags] = useState(channel.requireTags ?? false);
  const [postSlowMode, setPostSlowMode] = useState(channel.postSlowMode ?? 0);
  const [messageSlowMode, setMessageSlowMode] = useState(channel.messageSlowMode ?? 0);
  const [defaultLayout, setDefaultLayout] = useState<'list' | 'gallery'>(channel.defaultLayout ?? 'list');
  const [defaultSortOrder, setDefaultSortOrder] = useState<'recent_activity' | 'creation_date'>(channel.defaultSortOrder ?? 'recent_activity');

  // Forum tags
  const [tags, setTags] = useState<ForumTag[]>([]);
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [editingTagName, setEditingTagName] = useState('');
  const [editingTagColor, setEditingTagColor] = useState(TAG_COLORS[0]);
  const [addingTag, setAddingTag] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState(TAG_COLORS[0]);

  /* ── Save indicator ──────────────────────────────────── */
  const [saved, setSaved] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ── Emoji picker for channel name field ─────────────── */
  const nameInputRef = useRef<HTMLInputElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  // Cursor position is captured at button-click time. Once focus moves to
  // the picker, the input loses its selectionStart so we cache it here.
  const cursorPosRef = useRef<number>(0);
  const servers = useServerStore(s => s.servers);
  const currentUser = useAuthStore(s => s.currentUser);

  /* ── Delete state ────────────────────────────────────── */
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /* ── Sync local state when channel prop changes ──────── */
  useEffect(() => {
    setName(channel.name);
    setDescription(channel.description ?? '');
    setSlowMode(channel.slowMode ?? 0);
    setAgeRestricted(channel.ageRestricted ?? false);
    setUserLimit(channel.userLimit ?? 0);
    setPostGuidelines(channel.postGuidelines ?? '');
    setRequireTags(channel.requireTags ?? false);
    setPostSlowMode(channel.postSlowMode ?? 0);
    setMessageSlowMode(channel.messageSlowMode ?? 0);
    setDefaultLayout(channel.defaultLayout ?? 'list');
    setDefaultSortOrder(channel.defaultSortOrder ?? 'recent_activity');
    setActiveTab('overview');
    setDeleteConfirm(false);
  }, [channel]);

  /* ── Fetch forum tags ────────────────────────────────── */
  useEffect(() => {
    if (!isOpen || channel.type !== 'forum') return;
    apiClient.getForumTags(serverId, channel.id).then(setTags).catch(() => {});
  }, [isOpen, channel.id, channel.type, serverId]);

  /* ── Forum tag real-time sync ───────────────────────── */
  useEffect(() => {
    if (!isOpen || channel.type !== 'forum') return;
    const sock = socketService.getSocket();
    if (!sock) return;

    const onTagCreated = (data: { channelId: string; tag: ForumTag }) => {
      if (data.channelId !== channel.id) return;
      setTags((prev) => {
        if (prev.some((t) => t.id === data.tag.id)) return prev;
        return [...prev, data.tag];
      });
    };
    const onTagUpdated = (data: { channelId: string; tag: ForumTag }) => {
      if (data.channelId !== channel.id) return;
      setTags((prev) => prev.map((t) => (t.id === data.tag.id ? data.tag : t)));
    };
    const onTagDeleted = (data: { channelId: string; tagId: string }) => {
      if (data.channelId !== channel.id) return;
      setTags((prev) => prev.filter((t) => t.id !== data.tagId));
    };
    const onTagsReordered = (data: { channelId: string; tags: ForumTag[] }) => {
      if (data.channelId !== channel.id) return;
      setTags(data.tags);
    };

    sock.on('forum-tag-created', onTagCreated);
    sock.on('forum-tag-updated', onTagUpdated);
    sock.on('forum-tag-deleted', onTagDeleted);
    sock.on('forum-tags-reordered', onTagsReordered);

    return () => {
      sock.off('forum-tag-created', onTagCreated);
      sock.off('forum-tag-updated', onTagUpdated);
      sock.off('forum-tag-deleted', onTagDeleted);
      sock.off('forum-tags-reordered', onTagsReordered);
    };
  }, [isOpen, channel.id, channel.type]);

  /* ── Auto-save with debounce ─────────────────────────── */
  const scheduleSave = useCallback((data: Partial<Channel>) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        await onUpdateChannel(serverId, channel.id, data);
        setSaved(true);
        if (savedFadeRef.current) clearTimeout(savedFadeRef.current);
        savedFadeRef.current = setTimeout(() => setSaved(false), 2000);
      } catch {
        /* save failed silently — user sees no "Saved" indicator */
      }
    }, 500);
  }, [onUpdateChannel, serverId, channel.id]);

  /* ── Cleanup timers ──────────────────────────────────── */
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (savedFadeRef.current) clearTimeout(savedFadeRef.current);
    };
  }, []);

  /* ── Field change helpers (update local + schedule save) */
  const changeName = (v: string) => { setName(v); scheduleSave({ name: v }); };

  /* ── Insert emoji at cursor position in name field ───── */
  // Plain function (not useCallback) — only invoked on emoji-picker selection,
  // not from a hot render path, and changeName is recreated each render so a
  // memoized closure here would just be stale on the next click.
  const insertEmoji = (emoji: string) => {
    const pos = Math.min(cursorPosRef.current, name.length);
    const next = name.slice(0, pos) + emoji + name.slice(pos);
    if (next.length > 100) return;
    changeName(next);
    const newPos = pos + emoji.length;
    requestAnimationFrame(() => {
      const el = nameInputRef.current;
      if (!el) return;
      el.focus();
      try { el.setSelectionRange(newPos, newPos); } catch { /* unsupported on some input types */ }
      cursorPosRef.current = newPos;
    });
  };
  const changeDescription = (v: string) => { setDescription(v); scheduleSave({ description: v || null }); };
  const changeSlowMode = (v: number) => { setSlowMode(v); scheduleSave({ slowMode: v }); };
  const changeAgeRestricted = (v: boolean) => { setAgeRestricted(v); scheduleSave({ ageRestricted: v }); };
  const changeUserLimit = (v: number) => { setUserLimit(v); scheduleSave({ userLimit: v }); };
  const changePostGuidelines = (v: string) => { setPostGuidelines(v); scheduleSave({ postGuidelines: v || null }); };
  const changeRequireTags = (v: boolean) => { setRequireTags(v); scheduleSave({ requireTags: v }); };
  const changePostSlowMode = (v: number) => { setPostSlowMode(v); scheduleSave({ postSlowMode: v }); };
  const changeMessageSlowMode = (v: number) => { setMessageSlowMode(v); scheduleSave({ messageSlowMode: v }); };
  const changeDefaultLayout = (v: 'list' | 'gallery') => { setDefaultLayout(v); scheduleSave({ defaultLayout: v }); };
  const changeDefaultSortOrder = (v: 'recent_activity' | 'creation_date') => { setDefaultSortOrder(v); scheduleSave({ defaultSortOrder: v }); };

  /* ── Escape to close ─────────────────────────────────── */
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  /* ── Channel type icon ───────────────────────────────── */
  const channelIcon = channel.type === 'voice' ? <Volume2 size={16} /> :
    channel.type === 'stage' ? <Radio size={16} /> :
    channel.type === 'forum' ? (
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="7" height="7" rx="1.5"/>
        <rect x="14" y="3" width="7" height="7" rx="1.5"/>
        <rect x="3" y="14" width="7" height="7" rx="1.5"/>
        <rect x="14" y="14" width="7" height="7" rx="1.5"/>
      </svg>
    ) : <Hash size={16} />;

  /* ── Tag management helpers ──────────────────────────── */
  const handleAddTag = async () => {
    if (!newTagName.trim()) return;
    try {
      const tag = await apiClient.createForumTag(serverId, channel.id, { name: newTagName.trim(), color: newTagColor });
      setTags(prev => [...prev, tag]);
      setNewTagName('');
      setNewTagColor(TAG_COLORS[0]);
      setAddingTag(false);
    } catch { /* ignore */ }
  };

  const handleEditTag = async (tagId: string) => {
    if (!editingTagName.trim()) return;
    try {
      const updated = await apiClient.updateForumTag(serverId, channel.id, tagId, { name: editingTagName.trim(), color: editingTagColor });
      setTags(prev => prev.map(t => t.id === tagId ? updated : t));
      setEditingTagId(null);
    } catch { /* ignore */ }
  };

  const handleDeleteTag = async (tagId: string) => {
    try {
      await apiClient.deleteForumTag(serverId, channel.id, tagId);
      setTags(prev => prev.filter(t => t.id !== tagId));
    } catch { /* ignore */ }
  };

  /* ── Shared input styles ─────────────────────────────── */
  const inputClass = 'w-full bg-fill-hover border border-[var(--glass-border)] rounded-xl px-4 py-3 text-sm text-t-primary outline-none focus:border-[var(--cyan-accent)]/50 placeholder:text-t-secondary/30 transition-colors';
  const labelClass = 'block text-[11px] font-semibold uppercase tracking-wider mb-2';

  /* ── Render dropdown ─────────────────────────────────── */
  const renderSelect = (value: string | number, onChange: (v: any) => void, options: Array<{ value: string | number; label: string }>) => (
    <Dropdown
      options={options}
      value={value}
      onChange={onChange}
    />
  );

  // Determine if the parent server has discoveryEnabled. When true, the
  // age-restricted toggle must be disabled (discovery x age-restriction exclusion).
  const [serverDiscoveryEnabled, setServerDiscoveryEnabled] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    apiClient.getServerSettings(serverId).then((settings) => {
      setServerDiscoveryEnabled(settings.discoveryEnabled ?? false);
    }).catch(() => { /* keep false default */ });
  }, [isOpen, serverId]);

  /* ── Toggle switch ───────────────────────────────────── */
  const renderToggle = (enabled: boolean, onChange: (v: boolean) => void, label: string, desc?: string, opts?: { disabled?: boolean; disabledTooltip?: string }) => (
    <label
      className={`flex items-center justify-between py-1 ${opts?.disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
      title={opts?.disabled ? opts.disabledTooltip : undefined}
      style={opts?.disabled ? { opacity: 0.4 } : undefined}
    >
      <div className="mr-4">
        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{label}</div>
        {desc && <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{desc}</div>}
      </div>
      <div
        className={`w-10 h-6 rounded-full p-0.5 transition-colors shrink-0 ${opts?.disabled ? 'cursor-not-allowed' : 'cursor-pointer'} ${enabled ? 'bg-[var(--cyan-accent)]' : 'bg-fill-active'}`}
        onClick={() => { if (!opts?.disabled) onChange(!enabled); }}
      >
        <div className={`w-5 h-5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : ''}`} />
      </div>
    </label>
  );

  /* ── Tab definitions ─────────────────────────────────── */
  const tabs: Array<{ id: TabId; label: string; icon: React.ReactNode; danger?: boolean }> = [
    { id: 'overview', label: t('channelSettings.overview', 'Overview'), icon: <Settings size={16} /> },
    { id: 'permissions', label: t('channelSettings.permissions', 'Permissions'), icon: <Shield size={16} /> },
    { id: 'delete', label: t('channelSettings.deleteChannel', 'Delete Channel'), icon: <Trash2 size={16} />, danger: true },
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
                  : 'bg-[var(--cyan-accent)]/[0.08] text-t-primary relative overflow-hidden'
                : tab.danger
                  ? 'text-red-500/60 hover:bg-red-500/5 hover:text-red-400'
                  : 'text-t-secondary hover:bg-fill-hover hover:text-t-primary'
            }`}
          >
            <span className={`mr-3 transition-colors ${
              activeTab === tab.id
                ? tab.danger ? 'text-red-400' : 'text-t-primary'
                : tab.danger ? 'text-red-500/50' : 'text-t-secondary group-hover:text-t-primary'
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
      {/* Channel Name */}
      <div>
        <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
          {t('channelSettings.channelName', 'Channel Name')}
        </label>
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-t-secondary">{channelIcon}</span>
          <input
            ref={nameInputRef}
            type="text"
            value={name}
            onChange={(e) => changeName(e.target.value.slice(0, 100))}
            onSelect={(e) => { cursorPosRef.current = e.currentTarget.selectionStart ?? name.length; }}
            onKeyUp={(e) => { cursorPosRef.current = e.currentTarget.selectionStart ?? name.length; }}
            onClick={(e) => { cursorPosRef.current = e.currentTarget.selectionStart ?? name.length; }}
            maxLength={100}
            className={`${inputClass} pl-10 pr-12`}
            placeholder={t('channelSettings.channelNamePlaceholder', 'channel-name')}
          />
          <button
            ref={emojiButtonRef}
            type="button"
            onClick={() => {
              cursorPosRef.current = nameInputRef.current?.selectionStart ?? name.length;
              setEmojiOpen((o) => !o);
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg hover:bg-fill-active text-t-secondary hover:text-t-primary transition-colors"
            aria-label={t('channels.insertEmoji', 'Insert emoji')}
            title={t('channels.insertEmoji', 'Insert emoji')}
          >
            <Smile size={16} />
          </button>
        </div>
      </div>

      {/* Text channel fields */}
      {channel.type === 'text' && (
        <>
          <div>
            <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
              {t('channelSettings.description', 'Description')}
            </label>
            <textarea
              value={description}
              onChange={(e) => changeDescription(e.target.value.slice(0, 1024))}
              maxLength={1024}
              rows={3}
              className={`${inputClass} resize-none`}
              placeholder={t('channelSettings.descriptionPlaceholder', 'Describe this channel...')}
            />
          </div>
          <div>
            <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
              {t('channelSettings.slowmode', 'Slowmode')}
            </label>
            {renderSelect(slowMode, changeSlowMode, SLOWMODE_OPTIONS)}
          </div>
          {renderToggle(ageRestricted, changeAgeRestricted, t('channelSettings.ageRestricted', 'Age-Restricted'), t('channelSettings.ageRestrictedDesc', 'Users must be 18+ to view this channel'), { disabled: serverDiscoveryEnabled, disabledTooltip: t('channelSettings.ageRestrictedDisabledByDiscovery', 'Remove this server from Discovery to enable age restrictions.') })}
        </>
      )}

      {/* Voice channel fields */}
      {channel.type === 'voice' && (
        <>
          <div>
            <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
              {t('channelSettings.topic', 'Topic')}
            </label>
            <textarea
              value={description}
              onChange={(e) => changeDescription(e.target.value.slice(0, 1024))}
              placeholder={t('channelSettings.voiceTopicPlaceholder', 'What is this voice channel for?')}
              className={`${inputClass} resize-none`}
              rows={2}
              maxLength={1024}
            />
          </div>
          <div>
            <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
              {t('channelSettings.userLimit', 'User Limit')}: {userLimit === 0 ? t('channelSettings.noLimit', 'No limit') : userLimit}
            </label>
            <input
              type="range"
              min={0}
              max={99}
              value={userLimit}
              onChange={(e) => changeUserLimit(Number(e.target.value))}
              className="w-full accent-[var(--cyan-accent)]"
            />
            <div className="flex justify-between text-[10px] text-t-secondary mt-1">
              <span>{t('channelSettings.noLimit', 'No limit')}</span>
              <span>99</span>
            </div>
          </div>
          {renderToggle(ageRestricted, changeAgeRestricted, t('channelSettings.ageRestricted', 'Age-Restricted'), t('channelSettings.ageRestrictedDesc', 'Users must be 18+ to view this channel'), { disabled: serverDiscoveryEnabled, disabledTooltip: t('channelSettings.ageRestrictedDisabledByDiscovery', 'Remove this server from Discovery to enable age restrictions.') })}
        </>
      )}

      {/* Stage channel fields */}
      {channel.type === 'stage' && (
        <>
          <div>
            <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
              {t('channelSettings.topic', 'Topic')}
            </label>
            <textarea
              value={description}
              onChange={(e) => changeDescription(e.target.value.slice(0, 1024))}
              placeholder={t('channelSettings.topicPlaceholder', 'What is this stage about?')}
              className={`${inputClass} resize-none`}
              rows={2}
              maxLength={1024}
            />
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-secondary)', opacity: 0.6 }}>
              {t('channelSettings.topicDesc', 'Displayed when no stage session is active')}
            </p>
          </div>
          <div>
            <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
              {t('channelSettings.userLimit', 'Audience Limit')}: {userLimit === 0 ? t('channelSettings.noLimit', 'No limit') : userLimit}
            </label>
            <input
              type="range"
              min={0}
              max={99}
              value={userLimit}
              onChange={(e) => changeUserLimit(Number(e.target.value))}
              className="w-full accent-[var(--cyan-accent)]"
            />
            <div className="flex justify-between text-[10px] text-t-secondary mt-1">
              <span>{t('channelSettings.noLimit', 'No limit')}</span>
              <span>99</span>
            </div>
          </div>
          <div>
            <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
              {t('channelSettings.slowmode', 'Slowmode')}
            </label>
            {renderSelect(slowMode, changeSlowMode, SLOWMODE_OPTIONS)}
          </div>
          {renderToggle(ageRestricted, changeAgeRestricted, t('channelSettings.ageRestricted', 'Age-Restricted'), t('channelSettings.ageRestrictedDesc', 'Users must be 18+ to view this channel'), { disabled: serverDiscoveryEnabled, disabledTooltip: t('channelSettings.ageRestrictedDisabledByDiscovery', 'Remove this server from Discovery to enable age restrictions.') })}
        </>
      )}

      {/* Forum channel fields */}
      {channel.type === 'forum' && (
        <>
          <div>
            <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
              {t('channelSettings.postGuidelines', 'Post Guidelines')}
            </label>
            <textarea
              value={postGuidelines}
              onChange={(e) => changePostGuidelines(e.target.value.slice(0, 2048))}
              maxLength={2048}
              rows={3}
              className={`${inputClass} resize-none`}
              placeholder={t('channelSettings.postGuidelinesPlaceholder', 'Guidelines shown when creating a new post...')}
            />
          </div>

          {/* Tags management */}
          <div>
            <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
              {t('channelSettings.tags', 'Tags')}
            </label>
            <div className="space-y-2">
              {tags.map(tag => (
                <div key={tag.id} className="flex items-center gap-2 p-2.5 rounded-xl bg-fill-hover border border-default">
                  {editingTagId === tag.id ? (
                    <>
                      <div className="flex gap-1 shrink-0">
                        {TAG_COLORS.map(c => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => setEditingTagColor(c)}
                            className="w-4 h-4 rounded-full transition-transform hover:scale-110"
                            style={{
                              backgroundColor: c,
                              outline: editingTagColor === c ? '2px solid var(--text-primary)' : 'none',
                              outlineOffset: '1px',
                            }}
                          />
                        ))}
                      </div>
                      <input
                        type="text"
                        value={editingTagName}
                        onChange={(e) => setEditingTagName(e.target.value.slice(0, 32))}
                        className="flex-1 min-w-0 bg-fill-hover border border-[var(--glass-border)] rounded-lg px-2 py-1 text-xs text-t-primary outline-none focus:border-[var(--cyan-accent)]/50"
                        maxLength={32}
                        autoFocus
                        onKeyDown={(e) => { if (e.key === 'Enter') handleEditTag(tag.id); if (e.key === 'Escape') setEditingTagId(null); }}
                      />
                      <button type="button" onClick={() => handleEditTag(tag.id)} className="p-1 rounded-lg hover:bg-fill-active text-green-400"><Check size={14} /></button>
                      <button type="button" onClick={() => setEditingTagId(null)} className="p-1 rounded-lg hover:bg-fill-active text-t-secondary"><X size={14} /></button>
                    </>
                  ) : (
                    <>
                      <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                      <span className="flex-1 text-sm text-t-primary truncate">{tag.name}</span>
                      <button
                        type="button"
                        onClick={() => { setEditingTagId(tag.id); setEditingTagName(tag.name); setEditingTagColor(tag.color); }}
                        className="p-1 rounded-lg hover:bg-fill-active text-t-secondary hover:text-t-primary"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteTag(tag.id)}
                        className="p-1 rounded-lg hover:bg-red-500/10 text-t-secondary hover:text-red-400"
                      >
                        <XCircle size={12} />
                      </button>
                    </>
                  )}
                </div>
              ))}

              {/* Add tag row */}
              {addingTag ? (
                <div className="flex items-center gap-2 p-2.5 rounded-xl bg-fill-hover border border-default">
                  <div className="flex gap-1 shrink-0">
                    {TAG_COLORS.map(c => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setNewTagColor(c)}
                        className="w-4 h-4 rounded-full transition-transform hover:scale-110"
                        style={{
                          backgroundColor: c,
                          outline: newTagColor === c ? '2px solid var(--text-primary)' : 'none',
                          outlineOffset: '1px',
                        }}
                      />
                    ))}
                  </div>
                  <input
                    type="text"
                    value={newTagName}
                    onChange={(e) => setNewTagName(e.target.value.slice(0, 32))}
                    className="flex-1 min-w-0 bg-fill-hover border border-[var(--glass-border)] rounded-lg px-2 py-1 text-xs text-t-primary outline-none focus:border-[var(--cyan-accent)]/50"
                    placeholder={t('channelSettings.tagName', 'Tag name')}
                    maxLength={32}
                    autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddTag(); if (e.key === 'Escape') setAddingTag(false); }}
                  />
                  <button type="button" onClick={handleAddTag} className="p-1 rounded-lg hover:bg-fill-active text-green-400"><Check size={14} /></button>
                  <button type="button" onClick={() => { setAddingTag(false); setNewTagName(''); }} className="p-1 rounded-lg hover:bg-fill-active text-t-secondary"><X size={14} /></button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAddingTag(true)}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium text-t-secondary hover:text-t-primary hover:bg-fill-hover transition-colors"
                >
                  <Plus size={14} />
                  {t('channelSettings.addTag', 'Add Tag')}
                </button>
              )}
            </div>
          </div>

          {renderToggle(requireTags, changeRequireTags, t('channelSettings.requireTags', 'Require Tags'), t('channelSettings.requireTagsDesc', 'Posts must have at least one tag'))}

          <div>
            <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
              {t('channelSettings.postsSlowmode', 'Posts Slowmode')}
            </label>
            {renderSelect(postSlowMode, changePostSlowMode, SLOWMODE_OPTIONS)}
          </div>

          <div>
            <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
              {t('channelSettings.messagesSlowmode', 'Messages Slowmode')}
            </label>
            {renderSelect(messageSlowMode, changeMessageSlowMode, SLOWMODE_OPTIONS)}
          </div>

          <div>
            <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
              {t('channelSettings.defaultLayout', 'Default Layout')}
            </label>
            {renderSelect(defaultLayout, changeDefaultLayout, [
              { value: 'list', label: t('channelSettings.layoutList', 'List') },
              { value: 'gallery', label: t('channelSettings.layoutGallery', 'Gallery') },
            ])}
          </div>

          <div>
            <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
              {t('channelSettings.sortOrder', 'Sort Order')}
            </label>
            {renderSelect(defaultSortOrder, changeDefaultSortOrder, [
              { value: 'recent_activity', label: t('channelSettings.sortRecentActivity', 'Recent Activity') },
              { value: 'creation_date', label: t('channelSettings.sortCreationDate', 'Creation Date') },
            ])}
          </div>

          {renderToggle(ageRestricted, changeAgeRestricted, t('channelSettings.ageRestricted', 'Age-Restricted'), t('channelSettings.ageRestrictedDesc', 'Users must be 18+ to view this channel'), { disabled: serverDiscoveryEnabled, disabledTooltip: t('channelSettings.ageRestrictedDisabledByDiscovery', 'Remove this server from Discovery to enable age restrictions.') })}
        </>
      )}
    </div>
  );

  /* ── Permissions tab content ─────────────────────────── */
  const permissionsContent = (
    <React.Suspense fallback={<div className="flex items-center justify-center py-12 text-t-secondary text-sm">{t('common.loading', 'Loading...')}</div>}>
      <PermissionOverrideEditor
        channelId={channel.id}
        serverId={serverId}
        channelType={channel.type}
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
        <h3 className="text-lg font-semibold text-t-primary mb-2">{t('channelSettings.deleteTitle', 'Delete Channel')}</h3>
        <p className="text-sm text-t-secondary">
          {t('channelSettings.deleteConfirmation', 'Are you sure you want to delete #{{channelName}}? This action cannot be undone.', { channelName: channel.name })}
        </p>
      </div>

      {!deleteConfirm ? (
        <button
          type="button"
          onClick={() => setDeleteConfirm(true)}
          className="btn-cta-danger w-full py-3 font-semibold text-sm rounded-xl transition-colors"
        >
          {t('channelSettings.deleteChannel', 'Delete Channel')}
        </button>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-red-400 text-center font-medium">
            {t('channelSettings.deleteDoubleConfirm', 'Click again to permanently delete this channel')}
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
              disabled={deleting || !onDeleteChannel}
              onClick={async () => {
                if (!onDeleteChannel) return;
                setDeleting(true);
                try {
                  await onDeleteChannel(serverId, channel.id);
                  onClose();
                } catch {
                  setDeleting(false);
                }
              }}
              className="btn-cta-danger py-3 font-semibold text-sm rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {deleting ? t('common.deleting', 'Deleting...') : t('channelSettings.confirmDelete', 'Yes, Delete')}
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
              <span className="text-t-secondary">{channelIcon}</span>
              <h2 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                {channel.name}
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
                {channelIcon}
                <span className="text-xs font-medium truncate">{channel.name}</span>
              </div>
              <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                {t('channelSettings.title', 'Channel Settings')}
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
      {emojiOpen && (
        <React.Suspense fallback={null}>
          <EmojiPicker
            open
            onClose={() => { setEmojiOpen(false); requestAnimationFrame(() => nameInputRef.current?.focus()); }}
            onSelect={(emoji) => insertEmoji(emoji)}
            anchorRef={emojiButtonRef}
            activeServerId={serverId}
            servers={servers}
            userPlan={currentUser?.stripePlan}
            userId={currentUser?.id}
          />
        </React.Suspense>
      )}
    </div>,
    document.body
  );
};

export default ChannelSettingsModal;
