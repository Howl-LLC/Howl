// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import type { RecoverabilityState } from '../utils/recoverabilityState';

interface Props {
  state: RecoverabilityState;
  peerName: string;
  onGoOtr: () => void;
  onOpenRecoverySettings: () => void;
}

/**
 * Header chip + popover summarizing who can recover a DM's history. Private
 * (ShieldCheck, cyan) means the chat is unrecoverable by anyone but its
 * participants; Recoverable (ShieldAlert, neutral) means it can be recovered
 * from Howl's servers. The popover offers an OTR nudge in the private case and,
 * when the local user is the cause (recoverable-self), a link to switch to Self
 * recovery. Click toggles; outside-click and Escape close.
 */
export const DmRecoverabilityIndicator: React.FC<Props> = ({ state, peerName, onGoOtr, onOpenRecoverySettings }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const isPrivate = state === 'private';
  const label = isPrivate
    ? t('chat.recoverabilityPrivateLabel', 'Private')
    : t('chat.recoverabilityServerLabel', 'Recoverable');
  const Icon = isPrivate ? ShieldCheck : ShieldAlert;
  const accent = isPrivate ? 'var(--cyan-accent)' : 'var(--text-secondary)';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-fill-active transition-colors"
        title={label}
        aria-label={label}
        aria-expanded={open}
      >
        <Icon size={15} style={{ color: accent }} aria-hidden="true" />
        <span className="text-[11px] font-semibold" style={{ color: accent }}>{label}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className="absolute right-0 top-full mt-1 z-[70] w-64 p-3 rounded-lg border border-default shadow-xl"
          style={{ backgroundColor: 'var(--bg-elevated)' }}
        >
          <p className="text-xs leading-relaxed text-t-primary">
            {isPrivate
              ? t('chat.recoverabilityPrivateBody', 'Your chats with {{name}} are unable to be recovered by anybody but the users in this chat.', { name: peerName })
              : t('chat.recoverabilityServerBody', "Your chats with {{name}} are able to be recovered from Howl's servers.", { name: peerName })}
          </p>
          {isPrivate && (
            <div className="mt-2">
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('chat.recoverabilityOtrNudge', 'Sharing a password or something that should disappear? Go Off the Record.')}
              </p>
              <button
                type="button"
                onClick={() => { setOpen(false); onGoOtr(); }}
                className="mt-1.5 text-xs font-semibold"
                style={{ color: 'var(--cyan-accent)' }}
              >
                {t('chat.recoverabilityOtrNudgeAction', 'Go Off the Record')}
              </button>
            </div>
          )}
          {state === 'recoverable-self' && (
            <div className="mt-2">
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('chat.recoverabilitySelfFixBody', "This is because you're on Server recovery.")}
              </p>
              <button
                type="button"
                onClick={() => { setOpen(false); onOpenRecoverySettings(); }}
                className="mt-1.5 text-xs font-semibold"
                style={{ color: 'var(--cyan-accent)' }}
              >
                {t('chat.recoverabilitySelfFixAction', 'Switch to Self recovery')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

DmRecoverabilityIndicator.displayName = 'DmRecoverabilityIndicator';
