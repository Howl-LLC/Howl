// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Radio } from 'lucide-react';
import { LetterAvatar } from './LetterAvatar';

export interface StageSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: {
    topic?: string; maxSpeakers: number; textChatEnabled: boolean;
    allowEmojis: boolean; allowStickers: boolean; allowGifs: boolean;
    invitedSpeakerUserIds?: string[]; invitedRoleIds?: string[];
  }) => Promise<void>;
  mode: 'start' | 'edit';
  initialTopic?: string;
  initialMaxSpeakers?: number;
  initialTextChatEnabled?: boolean;
  initialAllowEmojis?: boolean;
  initialAllowStickers?: boolean;
  initialAllowGifs?: boolean;
  // Member/role picker (start mode only)
  serverMembers?: Array<{ id: string; username: string; avatar?: string | null; discriminator?: string }>;
  serverRoles?: Array<{ id: string; name: string; color: string }>;
  loadServerRoles?: () => Promise<Array<{ id: string; name: string; color: string }>>;
  currentUserId?: string;
}

export const StageSettingsModal: React.FC<StageSettingsModalProps> = ({
  isOpen, onClose, onSubmit, mode,
  initialTopic = '', initialMaxSpeakers = 10, initialTextChatEnabled = false,
  initialAllowEmojis = false, initialAllowStickers = false, initialAllowGifs = false,
  serverMembers, serverRoles: serverRolesProp, loadServerRoles, currentUserId,
}) => {
  const { t } = useTranslation();
  const topicRef = useRef<HTMLInputElement>(null);
  const [topic, setTopic] = useState(initialTopic);
  const [maxSpeakers, setMaxSpeakers] = useState(initialMaxSpeakers);
  const [textChatEnabled, setTextChatEnabled] = useState(initialTextChatEnabled);
  const [allowEmojis, setAllowEmojis] = useState(initialAllowEmojis);
  const [allowStickers, setAllowStickers] = useState(initialAllowStickers);
  const [allowGifs, setAllowGifs] = useState(initialAllowGifs);
  const [submitting, setSubmitting] = useState(false);

  // Picker state (start mode only)
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerTab, setPickerTab] = useState<'members' | 'roles'>('members');
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);

  const [loadedRoles, setLoadedRoles] = useState<Array<{ id: string; name: string; color: string }>>([]);
  const serverRoles = serverRolesProp ?? loadedRoles;

  // Load roles async when opening in start mode
  useEffect(() => {
    if (isOpen && mode === 'start' && !serverRolesProp?.length && loadServerRoles) {
      loadServerRoles().then(setLoadedRoles).catch(() => {});
    }
  }, [isOpen, mode, serverRolesProp, loadServerRoles]);

  const toggleUser = (id: string) => setSelectedUserIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleRole = (id: string) => setSelectedRoleIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const filteredMembers = useMemo(() => {
    const q = pickerSearch.toLowerCase();
    return (serverMembers ?? [])
      .filter(m => m.id !== currentUserId)
      .filter(m => !q || m.username.toLowerCase().includes(q))
      .slice(0, 50);
  }, [serverMembers, pickerSearch, currentUserId]);

  const filteredRoles = useMemo(() => {
    const q = pickerSearch.toLowerCase();
    return (serverRoles ?? [])
      .filter(r => !q || r.name.toLowerCase().includes(q))
      .slice(0, 20);
  }, [serverRoles, pickerSearch]);

  useEffect(() => {
    if (isOpen) {
      setTopic(initialTopic);
      setMaxSpeakers(initialMaxSpeakers);
      setTextChatEnabled(initialTextChatEnabled);
      setAllowEmojis(initialAllowEmojis);
      setAllowStickers(initialAllowStickers);
      setAllowGifs(initialAllowGifs);
      setSubmitting(false);
      setPickerSearch('');
      setPickerTab('members');
      setSelectedUserIds([]);
      setSelectedRoleIds([]);
      setTimeout(() => topicRef.current?.focus(), 100);
    }
  }, [isOpen, initialTopic, initialMaxSpeakers, initialTextChatEnabled, initialAllowEmojis, initialAllowStickers, initialAllowGifs]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await onSubmit({
        topic: topic.trim() || undefined,
        maxSpeakers,
        textChatEnabled,
        allowEmojis,
        allowStickers,
        allowGifs,
        ...(mode === 'start' ? { invitedSpeakerUserIds: selectedUserIds, invitedRoleIds: selectedRoleIds } : {}),
      });
      onClose();
    } catch {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4" style={{ backgroundColor: 'var(--overlay-backdrop)' }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-sm rounded-2xl border shadow-2xl overflow-hidden max-h-[90vh] flex flex-col" style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-2">
            <Radio size={18} style={{ color: 'var(--cyan-accent)' }} />
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              {mode === 'start' ? t('stages.startStage') : t('stages.stageSettings')}
            </h2>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-fill-active" style={{ color: 'var(--text-secondary)' }}><X size={18} /></button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('stages.topic')}</label>
            <input
              ref={topicRef}
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value.slice(0, 200))}
              placeholder={t('stages.topicPlaceholder')}
              className="w-full px-3 py-2.5 rounded-xl border text-sm outline-none focus:border-[var(--cyan-accent)]/50"
              style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              {t('stages.maxSpeakers')}: {maxSpeakers}
            </label>
            <input
              type="range"
              min={1} max={25}
              value={maxSpeakers}
              onChange={(e) => setMaxSpeakers(Number(e.target.value))}
              className="w-full accent-[var(--cyan-accent)]"
            />
          </div>

          <label className="flex items-center justify-between cursor-pointer py-1">
            <div className="min-w-0">
              <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{t('stages.textChat')}</div>
              <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('stages.textChatDescription')}</div>
            </div>
            <div
              className={`w-10 h-6 rounded-full p-0.5 transition-colors cursor-pointer shrink-0 ${textChatEnabled ? 'bg-[var(--cyan-accent)]' : 'bg-fill-active'}`}
              onClick={() => setTextChatEnabled((v) => !v)}
            >
              <div className={`w-5 h-5 rounded-full bg-white transition-transform ${textChatEnabled ? 'translate-x-4' : ''}`} />
            </div>
          </label>

          {/* Chat media settings */}
          <div className="pt-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="mb-2">
              <div className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('stages.chatMediaSettings')}</div>
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{t('stages.chatMediaDesc')}</div>
            </div>
            {mode === 'start' ? (
              <div className="text-[10px] px-2 py-2 rounded-lg" style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--text-tertiary)' }}>
                {t('stages.chatMediaSummary', { emojis: allowEmojis ? '\u2713' : '\u2717', stickers: allowStickers ? '\u2713' : '\u2717', gifs: allowGifs ? '\u2713' : '\u2717' })}
                <span className="block mt-0.5">{t('stages.chatMediaChangeHint')}</span>
              </div>
            ) : (
              <>
                {([
                  { label: t('stages.emojis'), desc: t('stages.emojisDesc'), value: allowEmojis, set: setAllowEmojis },
                  { label: t('stages.stickers'), desc: t('stages.stickersDesc'), value: allowStickers, set: setAllowStickers },
                  { label: t('stages.gifs'), desc: t('stages.gifsDesc'), value: allowGifs, set: setAllowGifs },
                ] as const).map((toggle) => (
                  <label key={toggle.label} className="flex items-center justify-between cursor-pointer py-1">
                    <div className="min-w-0">
                      <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{toggle.label}</div>
                      <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{toggle.desc}</div>
                    </div>
                    <div
                      className={`w-10 h-6 rounded-full p-0.5 transition-colors cursor-pointer shrink-0 ${toggle.value ? 'bg-[var(--cyan-accent)]' : 'bg-fill-active'}`}
                      onClick={() => toggle.set((v: boolean) => !v)}
                    >
                      <div className={`w-5 h-5 rounded-full bg-white transition-transform ${toggle.value ? 'translate-x-4' : ''}`} />
                    </div>
                  </label>
                ))}
              </>
            )}
          </div>

          {/* Member/Role picker (start mode only) */}
          {mode === 'start' && (
            <div className="pt-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('stages.inviteSpeakers')}</div>
              <div className="text-[10px] mb-2" style={{ color: 'var(--text-tertiary)' }}>
                {t('stages.inviteSpeakersDesc')}
              </div>

              {/* Search input */}
              <input
                type="text"
                value={pickerSearch}
                onChange={(e) => setPickerSearch(e.target.value)}
                placeholder={t('stages.searchMembersPlaceholder')}
                className="w-full px-3 py-2 rounded-xl border text-sm outline-none focus:border-[var(--cyan-accent)]/50 mb-2"
                style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
              />

              {/* Tab selector */}
              <div className="flex gap-1 mb-2">
                <button
                  type="button"
                  onClick={() => setPickerTab('members')}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${pickerTab === 'members' ? 'btn-cta-selected' : 'hover:bg-fill-hover text-[var(--text-secondary)]'}`}
                >
                  {t('stages.members')}
                </button>
                <button
                  type="button"
                  onClick={() => setPickerTab('roles')}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${pickerTab === 'roles' ? 'btn-cta-selected' : 'hover:bg-fill-hover text-[var(--text-secondary)]'}`}
                >
                  {t('stages.roles')}
                </button>
              </div>

              {/* Scrollable list */}
              <div className="max-h-[160px] overflow-y-auto space-y-0.5 rounded-xl border p-1" style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-input)' }}>
                {pickerTab === 'members' && filteredMembers.map((m) => (
                  <label key={m.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-fill-hover cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedUserIds.includes(m.id)}
                      onChange={() => toggleUser(m.id)}
                      className="accent-[var(--cyan-accent)]"
                    />
                    <LetterAvatar avatar={m.avatar ?? null} username={m.username} size={20} className="rounded-full" />
                    <span className="text-xs truncate" style={{ color: 'var(--text-primary)' }}>{m.username}</span>
                  </label>
                ))}
                {pickerTab === 'roles' && filteredRoles.map((r) => (
                  <label key={r.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-fill-hover cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedRoleIds.includes(r.id)}
                      onChange={() => toggleRole(r.id)}
                      className="accent-[var(--cyan-accent)]"
                    />
                    <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: r.color }} />
                    <span className="text-xs truncate" style={{ color: 'var(--text-primary)' }}>{r.name}</span>
                  </label>
                ))}
                {pickerTab === 'members' && filteredMembers.length === 0 && (
                  <p className="text-[10px] text-center py-3" style={{ color: 'var(--text-tertiary)' }}>{t('stages.noMembersFound')}</p>
                )}
                {pickerTab === 'roles' && filteredRoles.length === 0 && (
                  <p className="text-[10px] text-center py-3" style={{ color: 'var(--text-tertiary)' }}>{t('stages.noRolesFound')}</p>
                )}
              </div>

              {/* Selected pills */}
              {(selectedUserIds.length > 0 || selectedRoleIds.length > 0) && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {selectedUserIds.map((uid) => {
                    const m = serverMembers?.find(x => x.id === uid);
                    return m ? (
                      <span key={uid} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 12%, transparent)', color: 'var(--cyan-accent)' }}>
                        {m.username}
                        <button type="button" onClick={() => toggleUser(uid)} className="hover:text-white ml-0.5">&times;</button>
                      </span>
                    ) : null;
                  })}
                  {selectedRoleIds.map((rid) => {
                    const r = serverRoles?.find(x => x.id === rid);
                    return r ? (
                      <span key={rid} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ backgroundColor: `color-mix(in srgb, ${r.color} 15%, transparent)`, color: r.color }}>
                        @{r.name}
                        <button type="button" onClick={() => toggleRole(rid)} className="hover:text-white ml-0.5">&times;</button>
                      </span>
                    ) : null;
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium hover:bg-fill-active transition-colors" style={{ color: 'var(--text-secondary)' }}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="btn-cta px-4 py-2 rounded-xl text-sm font-semibold transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? t('common.loading') : mode === 'start' ? t('stages.startStage') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
};
