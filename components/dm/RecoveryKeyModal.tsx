// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Check, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface RecoveryKeyModalProps {
  recoveryKey: string;
  onConfirm: () => void;
  onClose?: () => void;
  showPassphraseHint?: boolean;
}

export const RecoveryKeyModal: React.FC<RecoveryKeyModalProps> = ({ recoveryKey, onConfirm, onClose, showPassphraseHint }) => {
  const { t } = useTranslation();
  const [enteredKey, setEnteredKey] = useState('');
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);

  const normalise = (s: string) => s.replace(/[-\s]/g, '').toUpperCase();
  const keysMatch = normalise(enteredKey) === normalise(recoveryKey);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(recoveryKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-key-dialog-title"
        tabIndex={-1}
        className="rounded-2xl border border-[var(--glass-border)] p-7 w-full max-w-md flex flex-col shadow-2xl spring-pop-in outline-none"
        style={{ backgroundColor: 'var(--bg-panel)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <ShieldAlert size={18} className="text-amber-400" />
          <span id="recovery-key-dialog-title" className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('dm.recoveryKeyTitle', 'Save Your Recovery Key')}
          </span>
        </div>

        {/* Warning */}
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 mb-4">
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {t('dm.recoveryKeyWarning', 'If you lose this key and forget your password, your encrypted messages will be permanently unreadable. Save it somewhere safe.')}
          </p>
        </div>

        {/* Passphrase = password hint */}
        {showPassphraseHint && (
          <div className="rounded-xl border border-[var(--cyan-accent)]/20 bg-[var(--cyan-accent)]/5 p-3 mb-4">
            <p className="text-xs font-semibold" style={{ color: 'var(--cyan-accent)' }}>
              Your encryption passphrase is your account password
            </p>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-secondary)' }}>
              Whenever Howl asks for your encryption passphrase — on a new device, after clearing browser data, or in Settings — enter the same password you use to log in.
            </p>
          </div>
        )}

        {/* Recovery key display */}
        <div className="relative bg-black/40 border border-[var(--glass-border)] rounded-lg p-4 mb-4 font-mono text-sm text-emerald-300 break-all select-all">
          {recoveryKey}
          <button
            type="button"
            onClick={handleCopy}
            className="absolute top-2 right-2 p-1.5 rounded-md hover:bg-fill-active transition-colors"
          >
            {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} className="text-t-secondary" />}
          </button>
        </div>

        {/* Re-enter key */}
        <label className="text-xs font-medium mb-2 block" style={{ color: 'var(--text-secondary)' }}>
          {t('dm.recoveryKeyReenter', 'Re-enter your recovery key to confirm:')}
        </label>
        <input
          type="text"
          value={enteredKey}
          onChange={(e) => setEnteredKey(e.target.value)}
          placeholder={t('dm.recoveryKeyReenterPlaceholder', 'Paste or type your recovery key')}
          className="w-full px-3 py-2.5 rounded-lg bg-black/30 border border-[var(--glass-border)] text-sm text-t-primary placeholder-t-tertiary mb-4 outline-none focus:border-[var(--cyan-accent)]/50 font-mono"
          autoComplete="off"
          spellCheck={false}
        />

        {/* Confirm button */}
        <button
          type="button"
          onClick={onConfirm}
          disabled={!keysMatch}
          className="btn-cta w-full py-2.5 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed text-sm transition-all"
        >
          {t('dm.recoveryKeySaved', "I've saved my key")}
        </button>

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-t-tertiary hover:text-t-secondary mt-3"
          >
            {t('dm.recoveryKeyCloseWithoutVerifying', 'Close without verifying')}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
};
