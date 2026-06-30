// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { LogOut } from 'lucide-react';
import { GLASS_MENU_CLASS, GLASS_MENU_STYLE } from '../utils/contextMenuStyles';
import * as dmKeyManager from '../services/dmKeyManager';

interface LogoutConfirmModalProps {
  onConfirm: (keepEncryptionKeys: boolean) => void;
  onCancel: () => void;
}

const LogoutConfirmModal: React.FC<LogoutConfirmModalProps> = ({ onConfirm, onCancel }) => {
  const { t } = useTranslation();
  // Mirror the Settings → "Remember on this device" preference. A user who
  // opted out of device persistence in settings should see this default OFF;
  // an opted-in user keeps the seamless next-login experience.
  const [keepKeys, setKeepKeys] = useState(false);
  // Gate the destructive "Log Out" action on the probe settling. Until then
  // `keepKeys` is the stale `false` default, so confirming early would wipe a
  // remembered device's keys. Settle on success OR failure so a rejected probe
  // never permanently wedges the button (failure keeps the safe `false` => wipe).
  const [probeReady, setProbeReady] = useState(false);
  useEffect(() => {
    void dmKeyManager
      .isRememberedOnDevice()
      .then(setKeepKeys)
      .catch(() => { /* probe failed: keep the safe default (false => wipe) */ })
      .finally(() => setProbeReady(true));
  }, []);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
      {/* Backdrop — 75% black + small blur so the account page visibly
          recedes instead of bleeding through the glass panel. */}
      <div
        className="absolute inset-0 bg-black/75 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="logout-dialog-title"
        tabIndex={-1}
        /* Frosted-glass surface matching Howl's context-menu idiom:
           --glass-bg (rgba(10,15,30,0.72)) + backdrop-blur(20px) saturate(1.3)
           + --glass-shadow (inner ring + drop). Denser than --bg-panel alone
           so the content behind actually looks frosted, not translucent. */
        className={`relative p-6 w-full max-w-sm outline-none ${GLASS_MENU_CLASS}`}
        style={GLASS_MENU_STYLE}
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: 'var(--bg-input)' }}>
            <LogOut size={18} style={{ color: 'var(--text-secondary)' }} />
          </div>
          <h3 id="logout-dialog-title" className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('settings.logout', 'Log Out')}
          </h3>
        </div>

        {/* Trust-toggle pattern reused from Login.tsx deviceVerifyStep —
            pill-thumb switch sits right of a title+description block.
            Matches Howl's ToggleRow pattern; replaces a bare native
            checkbox (which reads as AI-slop in this design system). */}
        <button
          type="button"
          role="switch"
          aria-checked={keepKeys}
          onClick={() => setKeepKeys((v) => !v)}
          className="w-full flex items-start justify-between gap-3 px-4 py-3 rounded-[var(--radius-md)] border border-[var(--glass-border)] bg-input-surface text-left transition-colors hover:border-[var(--border-strong)]"
        >
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-semibold text-t-primary">
              {t('settings.logoutKeepKeys', 'Keep encryption keys on this device')}
            </span>
            <span className="block text-xs mt-1 text-t-secondary leading-relaxed">
              {t('settings.logoutKeepKeysDesc', 'Your encrypted messages will remain readable next time you sign in on this browser. Uncheck on shared or public computers.')}
            </span>
          </span>
          <span
            className="relative shrink-0 w-10 h-[22px] rounded-full transition-colors duration-200 mt-0.5"
            style={{ backgroundColor: keepKeys ? 'var(--cyan-accent)' : 'var(--fill-active)' }}
          >
            <span
              className="absolute top-[2px] left-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform duration-200"
              style={{ transform: keepKeys ? 'translateX(18px)' : 'translateX(0)' }}
            />
          </span>
        </button>

        <div className="flex items-center justify-end gap-3 mt-6">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-xl text-sm font-medium hover:bg-fill-active transition-all"
            style={{ color: 'var(--text-secondary)' }}
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(keepKeys)}
            disabled={!probeReady}
            aria-disabled={!probeReady}
            className="btn-cta-danger px-4 py-2 rounded-xl text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('settings.logout', 'Log Out')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default LogoutConfirmModal;
