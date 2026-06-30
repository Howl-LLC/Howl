// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Hash, Volume2, Radio, X, ChevronDown, Lock, Smile, Tag } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigationStore } from '../../stores/navigationStore';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { useAppStore } from '../../stores/appStore';
import { voiceVisible } from '../../shared/instanceConfig';

const EmojiPicker = React.lazy(() => import('../EmojiPicker').then(m => ({ default: m.EmojiPicker })));

type ChannelType = 'text' | 'voice' | 'stage' | 'forum' | 'role_picker';

interface CreateChannelModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateChannel: (name: string, type: ChannelType, categoryId?: string | null, isPrivate?: boolean) => Promise<void>;
  initialType?: ChannelType;
  categoryId?: string | null;
  categoryName?: string | null;
  categories?: Array<{ id: string; name: string; position: number }>;
  /** When true, the role_picker option is disabled (one already exists). */
  hasRolePicker?: boolean;
}

export const CreateChannelModal: React.FC<CreateChannelModalProps> = ({ isOpen, onClose, onCreateChannel, initialType = 'text', categoryId, categories = [], hasRolePicker = false }) => {
  const { t } = useTranslation();
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelType, setNewChannelType] = useState<ChannelType>(initialType);
  const [isPrivate, setIsPrivate] = useState(false);
  const [createChannelError, setCreateChannelError] = useState<string | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(categoryId ?? '');
  const [catDropdownOpen, setCatDropdownOpen] = useState(false);
  const catDropdownRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  // Cursor position is captured at button-click time. Once focus moves to
  // the picker, the input loses its selectionStart so we cache it here.
  const cursorPosRef = useRef<number>(0);
  const activeServerId = useNavigationStore(s => s.activeServerId) ?? undefined;
  const servers = useServerStore(s => s.servers);
  const currentUser = useAuthStore(s => s.currentUser);
  // Self-host instances with voice disabled hide the Voice channel-type option.
  // Default-permissive: null instanceConfig (hosted / older backend) keeps it visible.
  const showVoice = voiceVisible(useAppStore(s => s.instanceConfig));

  const insertEmoji = useCallback((emoji: string) => {
    setNewChannelName((prev) => {
      const pos = Math.min(cursorPosRef.current, prev.length);
      const next = prev.slice(0, pos) + emoji + prev.slice(pos);
      // Schedule cursor restore for after React commits the new value.
      const newPos = pos + emoji.length;
      requestAnimationFrame(() => {
        const el = nameInputRef.current;
        if (!el) return;
        el.focus();
        try { el.setSelectionRange(newPos, newPos); } catch { /* unsupported on some input types */ }
        cursorPosRef.current = newPos;
      });
      return next;
    });
  }, []);

  const uniqueCategories = useMemo(() => {
    const seen = new Set<string>();
    return categories.filter(cat => {
      if (seen.has(cat.id)) return false;
      seen.add(cat.id);
      return true;
    });
  }, [categories]);

  const selectedCategoryName = selectedCategoryId ? uniqueCategories.find(c => c.id === selectedCategoryId)?.name ?? '' : t('categories.noCategory');

  useEffect(() => {
    setNewChannelType(initialType);
  }, [initialType]);

  useEffect(() => {
    setSelectedCategoryId(categoryId ?? '');
  }, [categoryId]);

  useEffect(() => {
    if (!catDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (catDropdownRef.current && !catDropdownRef.current.contains(e.target as Node)) setCatDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [catDropdownOpen]);

  if (!isOpen) return null;

  const handleCreate = async () => {
    const name = newChannelName.trim();
    if (!name) return;
    setCreateChannelError(null);
    try {
      await onCreateChannel(name, newChannelType, selectedCategoryId || null, isPrivate);
      setNewChannelName('');
      setNewChannelType('text');
      setIsPrivate(false);
      setSelectedCategoryId(categoryId ?? '');
    } catch (e) {
      setCreateChannelError(e instanceof Error ? e.message : 'Failed to create channel.');
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose} />
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border shadow-2xl relative spring-pop-in" style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
         <div className="p-6 pb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>{t('sidebar.createChannel')}</h2>
            <button onClick={onClose} className="p-2 hover:bg-fill-active transition-colors rounded-lg" style={{ color: 'var(--text-secondary)' }}><X size={18} /></button>
         </div>
         <div className="p-6 pt-2">
          <div className="space-y-6">
            <div className="flex flex-col gap-1.5">
              {([
                { type: 'text' as const, icon: <Hash size={20} />, label: t('channels.text', 'Text'), desc: t('channels.textDesc', 'Send messages, images, GIFs, emoji, and more') },
                { type: 'voice' as const, icon: <Volume2 size={20} />, label: t('channels.voice', 'Voice'), desc: t('channels.voiceDesc', 'Hang out with voice, video, and screen share') },
                { type: 'stage' as const, icon: <Radio size={20} />, label: t('stages.stage', 'Stage'), desc: t('channels.stageDesc', 'Host events with speakers and an audience') },
                { type: 'forum' as const, icon: (
                  <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="7" height="7" rx="1.5"/>
                    <rect x="14" y="3" width="7" height="7" rx="1.5"/>
                    <rect x="3" y="14" width="7" height="7" rx="1.5"/>
                    <rect x="14" y="14" width="7" height="7" rx="1.5"/>
                  </svg>
                ), label: t('channels.forum', 'Forum'), desc: t('channels.forumDesc', 'Organized discussions with posts and tags') },
                { type: 'role_picker' as const, icon: <Tag size={20} />, label: t('channels.roles', 'Roles'), desc: t('channels.rolesDesc', 'Let members pick their own roles from a list'), disabled: hasRolePicker, disabledHint: t('channels.rolesOnePerServer', 'Only one Roles channel per server') },
              ]).filter(opt => showVoice || opt.type !== 'voice').map(opt => {
                const selected = newChannelType === opt.type;
                const disabled = ('disabled' in opt && opt.disabled) === true;
                return (
                  <button
                    key={opt.type}
                    type="button"
                    disabled={disabled}
                    title={disabled ? ('disabledHint' in opt ? opt.disabledHint : undefined) : undefined}
                    onClick={() => !disabled && setNewChannelType(opt.type)}
                    className={`flex items-center gap-3 p-3 rounded-xl transition-all ${
                      disabled
                        ? 'opacity-40 cursor-not-allowed border border-transparent'
                        : selected
                        ? 'cursor-pointer btn-cta-selected'
                        : 'cursor-pointer border border-transparent hover:bg-fill-hover'
                    }`}
                  >
                    <div className={`w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors ${selected && !disabled ? 'border-white' : 'border-[var(--border-strong)]'}`}>
                      {selected && !disabled && <div className="w-2 h-2 rounded-full bg-white" />}
                    </div>
                    <div className={`shrink-0 transition-colors ${selected && !disabled ? 'text-white' : 'text-t-secondary'}`}>
                      {opt.icon}
                    </div>
                    <div className="text-left min-w-0">
                      <div className={`text-sm font-medium ${selected && !disabled ? 'text-white' : 'text-t-primary'}`}>{opt.label}</div>
                      <div className={`text-[11px] leading-snug ${selected && !disabled ? 'text-white/70' : 'text-t-secondary'}`}>
                        {disabled && 'disabledHint' in opt ? opt.disabledHint : opt.desc}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            {uniqueCategories.length > 0 && (
              <div>
                <label className="text-[11px] font-medium text-t-secondary mb-2 block">{t('categories.categoryLabel')}</label>
                <div ref={catDropdownRef} className="relative">
                  <button
                    type="button"
                    onClick={() => setCatDropdownOpen(o => !o)}
                    className="w-full bg-fill-hover border border-[var(--glass-border)] rounded-xl px-5 py-3 text-sm text-t-primary text-left flex items-center justify-between hover:border-[var(--border-strong)] transition-colors"
                  >
                    <span>{selectedCategoryName}</span>
                    <ChevronDown size={14} className={`shrink-0 transition-transform ${catDropdownOpen ? 'rotate-180' : ''}`} style={{ color: 'var(--text-tertiary)' }} />
                  </button>
                  {catDropdownOpen && (
                    <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-xl border py-1 max-h-48 overflow-y-auto no-scrollbar"
                      style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--glass-border)', boxShadow: 'var(--shadow-lg)' }}>
                      <button key="__none" type="button"
                        onClick={() => { setSelectedCategoryId(''); setCatDropdownOpen(false); }}
                        className={`w-full text-left px-4 py-2 text-sm transition-colors ${!selectedCategoryId ? 'bg-[var(--cyan-accent)]/15 text-[var(--cyan-accent)]' : 'text-t-primary hover:bg-fill-hover'}`}>
                        {t('categories.noCategory')}
                      </button>
                      {uniqueCategories.map(cat => (
                        <button
                          key={cat.id}
                          type="button"
                          onClick={() => { setSelectedCategoryId(cat.id); setCatDropdownOpen(false); }}
                          className={`w-full text-left px-4 py-2 text-sm transition-colors ${selectedCategoryId === cat.id ? 'bg-[var(--cyan-accent)]/15 text-[var(--cyan-accent)]' : 'text-t-primary hover:bg-fill-hover'}`}
                        >
                          {cat.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            <div>
              <label className="text-[11px] font-medium text-t-secondary mb-2 block">{t('channels.channelName')}</label>
              <div className="relative">
                <input
                  ref={nameInputRef}
                  autoFocus
                  type="text"
                  value={newChannelName}
                  onChange={e => setNewChannelName(e.target.value)}
                  onSelect={(e) => { cursorPosRef.current = e.currentTarget.selectionStart ?? newChannelName.length; }}
                  onKeyUp={(e) => { cursorPosRef.current = e.currentTarget.selectionStart ?? newChannelName.length; }}
                  onClick={(e) => { cursorPosRef.current = e.currentTarget.selectionStart ?? newChannelName.length; }}
                  placeholder={t('channels.newChannelPlaceholder')}
                  className="w-full bg-fill-hover border border-[var(--glass-border)] rounded-xl pl-5 pr-12 py-3 text-sm text-t-primary focus:border-[var(--cyan-accent)]/50 outline-none mono"
                />
                <button
                  ref={emojiButtonRef}
                  type="button"
                  onClick={() => {
                    cursorPosRef.current = nameInputRef.current?.selectionStart ?? newChannelName.length;
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
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                <Lock size={16} className="shrink-0 text-t-secondary" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-t-primary">{t('channels.privateChannel', 'Private Channel')}</div>
                  <div className="text-[11px] text-t-secondary leading-snug">{t('channels.privateChannelDesc', 'Only selected members and roles can view this channel')}</div>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={isPrivate}
                onClick={() => setIsPrivate(p => !p)}
                className="shrink-0 relative rounded-full transition-colors"
                style={{ width: 40, height: 22, backgroundColor: isPrivate ? 'var(--cyan-accent)' : 'var(--fill-active)' }}
              >
                <div
                  className="absolute top-[3px] w-4 h-4 rounded-full bg-white shadow-sm transition-transform"
                  style={{ left: isPrivate ? 21 : 3 }}
                />
              </button>
            </div>
            {createChannelError && <p className="text-xs text-red-400 -mt-1 mb-1">{createChannelError}</p>}
            <button
              type="button"
              disabled={!newChannelName.trim()}
              onClick={(e) => { e.stopPropagation(); handleCreate(); }}
              className="btn-cta w-full py-3 text-sm rounded-xl transition-all disabled:opacity-30"
            >
              {t('channels.initializeChannel')}
            </button>
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
            activeServerId={activeServerId}
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
