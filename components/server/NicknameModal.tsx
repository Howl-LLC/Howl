// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Smile, X, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '../../services/api';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { LetterAvatar } from '../LetterAvatar';
import { RoleNameStyle } from '../RoleNameStyle';
import { getAvatarEffectClass } from '../../shared/planPerks';

const EmojiPicker = React.lazy(() => import('../EmojiPicker').then(m => ({ default: m.EmojiPicker })));

/** Target-user shape that the preview needs. Most callers pass a member
 *  record from `membersForList` which already has all of these — they're
 *  optional so the modal also works for skinnier callers. */
export interface NicknameTarget {
  id: string;
  username: string;
  avatar?: string | null;
  discriminator?: string;
  roleColor?: string;
  roleStyle?: 'solid' | 'gradient' | 'holographic';
  nameColor?: string;
  nameFont?: string;
  nameEffect?: string;
  avatarEffect?: string;
  effectivePlan?: string;
  stripePlan?: string;
}

export interface NicknameModalProps {
  open: boolean;
  /** ID of the server the nickname is being set in. */
  serverId: string;
  /** Server name — surfaces in the subheader pill so the editor sees scope. */
  serverName?: string;
  /** Target user (full record so the live preview can show avatar + Pro
   *  cosmetics + role color exactly as they'll appear in the member list). */
  target: NicknameTarget;
  /** Current nickname for this user in this server (or null). */
  currentNickname: string | null;
  /** True when the user is editing their own nickname; false for admin edits. */
  isSelf: boolean;
  onClose: () => void;
  onSaved?: (nickname: string | null) => void;
}

/** Modal for setting a server-scoped nickname. Howl-flavored: a live
 *  preview tile shows exactly how the chosen name will render in the
 *  member list — avatar effect, role color, name color/font/effect — so the
 *  editor (especially when they're a Pro user with cosmetics) can pick a
 *  name that reads well with their styling, and admin editors see whose
 *  name they're touching. */
export const NicknameModal: React.FC<NicknameModalProps> = ({
  open, serverId, serverName, target, currentNickname, isSelf, onClose, onSaved,
}) => {
  const { t } = useTranslation();
  const [nickname, setNickname] = useState(currentNickname ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  // Cache cursor position so emoji insertion lands at the right spot even
  // after focus moves to the picker.
  const cursorPosRef = useRef<number>(0);
  const servers = useServerStore(s => s.servers);
  const currentUser = useAuthStore(s => s.currentUser);

  // Reset local state every time the modal opens for a different target.
  useEffect(() => {
    if (open) {
      setNickname(currentNickname ?? '');
      setError(null);
      setSaving(false);
    }
  }, [open, currentNickname, target.id]);

  // Escape key closes the modal (consistent with other modals).
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const insertEmoji = useCallback((emoji: string) => {
    setNickname((prev) => {
      const pos = Math.min(cursorPosRef.current, prev.length);
      const next = prev.slice(0, pos) + emoji + prev.slice(pos);
      // Server enforces 32-char nickname limit (matches Discord).
      if (next.length > 32) return prev;
      const newPos = pos + emoji.length;
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        try { el.setSelectionRange(newPos, newPos); } catch { /* unsupported */ }
        cursorPosRef.current = newPos;
      });
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    setError(null);
    setSaving(true);
    // Trim whitespace; an empty value resets to the default username.
    const trimmed = nickname.trim();
    const value: string | null = trimmed.length === 0 ? null : trimmed;
    try {
      if (isSelf) {
        await apiClient.updateMyServerProfile(serverId, { nickname: value });
      } else {
        await apiClient.setMemberNickname(serverId, target.id, value);
      }
      onSaved?.(value);
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to update nickname.';
      setError(message);
    } finally {
      setSaving(false);
    }
  }, [nickname, isSelf, serverId, target.id, onSaved, onClose]);

  const handleReset = useCallback(() => {
    setNickname('');
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  if (!open) return null;

  // Plan / cosmetics resolution mirrors what MemberList does so the preview
  // is pixel-accurate to where the name will actually appear.
  const isPro = (target.effectivePlan ?? target.stripePlan) === 'pro';
  // Live name to show in the preview: trimmed nickname if any, otherwise
  // the underlying username. Uses the live `nickname` state so each
  // keystroke updates the preview tile in real time.
  const previewName = nickname.trim().length > 0 ? nickname : target.username;
  const usernameTag = target.discriminator ? `${target.username}#${target.discriminator}` : target.username;

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
        onClick={onClose}
      />
      <div
        className="w-full max-w-md rounded-2xl border shadow-2xl relative spring-pop-in overflow-hidden"
        style={{
          backgroundColor: 'var(--bg-panel)',
          borderColor: 'var(--border-subtle)',
          backdropFilter: 'blur(40px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Subtle cyan glow strip along the top — Howl signature accent that
            other primary-action modals share. */}
        <div className="absolute inset-x-0 top-0 h-px" style={{ background: 'linear-gradient(90deg, transparent, var(--cyan-accent), transparent)', opacity: 0.4 }} />

        <div className="px-6 pt-6 pb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>
              {t('nickname.title', 'Change Nickname')}
            </h2>
            {serverName && (
              <p className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-secondary)' }}>
                {isSelf
                  ? t('nickname.scopeSelf', { serverName, defaultValue: 'in {{serverName}}' })
                  : t('nickname.scopeOther', { username: target.username, serverName, defaultValue: 'for {{username}} in {{serverName}}' })}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 hover:bg-fill-active transition-colors rounded-lg shrink-0"
            style={{ color: 'var(--text-secondary)' }}
            aria-label={t('common.close', 'Close')}
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 pb-6">
          {/* Live preview tile — renders as a member-list row. The avatar
              gets the user's avatarEffect (Pro), and RoleNameStyle applies
              role color/style + Pro name color/font/effect. Updates on
              every keystroke so the editor sees the final result before
              committing. */}
          <div className="mb-5">
            <p className="text-[10px] font-medium uppercase tracking-wider mb-2" style={{ color: 'var(--text-secondary)', opacity: 0.7 }}>
              {t('nickname.previewLabel', 'Preview')}
            </p>
            <div
              className="relative rounded-xl px-4 py-3.5 flex items-center gap-3 border overflow-hidden"
              style={{
                backgroundColor: 'var(--bg-input)',
                borderColor: 'var(--border-subtle)',
              }}
            >
              {/* Faint cyan radial glow behind the avatar — keeps the tile
                  from feeling flat and matches Howl's existing hero-style
                  panel treatments. */}
              <div
                className="absolute pointer-events-none"
                style={{
                  left: -20, top: -20, width: 140, height: 140,
                  background: 'radial-gradient(circle, rgba(7, 111, 160, 0.10), transparent 70%)',
                }}
              />
              <div
                className={`relative shrink-0 rounded-full overflow-visible w-10 h-10 ${isPro ? getAvatarEffectClass(target.avatarEffect) : ''}`}
              >
                <LetterAvatar
                  avatar={target.avatar ?? null}
                  username={target.username}
                  size={40}
                  className="rounded-full"
                />
              </div>
              <div className="min-w-0 flex-1 relative">
                <div className="truncate">
                  <RoleNameStyle
                    name={previewName}
                    color={target.roleColor ?? 'var(--text-primary)'}
                    style={target.roleStyle ?? 'solid'}
                    className="text-[15px] font-semibold"
                    overrideFont={isPro ? target.nameFont : undefined}
                    nameEffect={isPro ? target.nameEffect : undefined}
                    overrideColor={isPro ? target.nameColor : undefined}
                  />
                </div>
                <p className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-secondary)', opacity: 0.7 }}>
                  @{usernameTag}
                </p>
              </div>
            </div>
          </div>

          <label className="text-[11px] font-medium uppercase tracking-wider mb-2 block" style={{ color: 'var(--text-secondary)' }}>
            {t('nickname.label', 'Nickname')}
          </label>
          <div className="relative">
            <input
              ref={inputRef}
              autoFocus
              type="text"
              value={nickname}
              maxLength={32}
              onChange={(e) => setNickname(e.target.value.slice(0, 32))}
              onSelect={(e) => { cursorPosRef.current = e.currentTarget.selectionStart ?? nickname.length; }}
              onKeyUp={(e) => { cursorPosRef.current = e.currentTarget.selectionStart ?? nickname.length; }}
              onClick={(e) => { cursorPosRef.current = e.currentTarget.selectionStart ?? nickname.length; }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !saving) {
                  e.preventDefault();
                  void handleSave();
                }
              }}
              placeholder={target.username}
              className="w-full bg-fill-hover border border-[var(--glass-border)] rounded-xl pl-5 pr-12 py-3 text-sm text-t-primary focus:border-[var(--cyan-accent)]/50 outline-none transition-colors"
            />
            <button
              ref={emojiButtonRef}
              type="button"
              onClick={() => {
                cursorPosRef.current = inputRef.current?.selectionStart ?? nickname.length;
                setEmojiOpen((o) => !o);
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg hover:bg-fill-active text-t-secondary hover:text-t-primary transition-colors"
              aria-label={t('channels.insertEmoji', 'Insert emoji')}
              title={t('channels.insertEmoji', 'Insert emoji')}
            >
              <Smile size={16} />
            </button>
          </div>

          {/* Footer row: reset link on the left, char counter on the right. */}
          <div className="flex items-center justify-between mt-2.5">
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--cyan-accent)] hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline transition-opacity"
              disabled={saving || nickname.length === 0}
            >
              <RotateCcw size={11} />
              {t('nickname.useDefault', { username: target.username, defaultValue: 'Use @{{username}}' })}
            </button>
            <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-secondary)', opacity: 0.6 }}>
              {nickname.length}/32
            </span>
          </div>

          {error && (
            <p className="text-xs text-red-400 mt-3 px-3 py-2 rounded-lg border border-red-500/20 bg-red-500/5">
              {error}
            </p>
          )}

          {/* Action row — Save weighted heavier (col-span-2) since it's the
              primary action; Cancel sits to its left. */}
          <div className="grid grid-cols-3 gap-2 mt-6">
            <button
              type="button"
              onClick={onClose}
              className="py-3 rounded-xl text-sm font-semibold text-t-primary bg-fill-hover hover:bg-fill-active active:scale-[0.98] transition-all"
              disabled={saving}
            >
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              type="button"
              onClick={() => { void handleSave(); }}
              className="btn-cta col-span-2 py-3 text-sm rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={saving}
            >
              {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
            </button>
          </div>
        </div>
      </div>
      {emojiOpen && (
        <React.Suspense fallback={null}>
          <EmojiPicker
            open
            onClose={() => { setEmojiOpen(false); requestAnimationFrame(() => inputRef.current?.focus()); }}
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
    document.body,
  );
};

export default NicknameModal;
