// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useState } from 'react';
import { Modal, ModalBody, ModalFooter } from '../ui/modal';
import { Button } from '../ui/button';
import { assetPath } from '../../utils/assetPath';
import { setPairRequestListener, type PairRequestInfo } from '../../services/streamDeckController';

const ALLOW_BUTTON_DISABLED_MS = 1500;

export function StreamDeckPairModal() {
  const [info, setInfo] = useState<PairRequestInfo | null>(null);
  const [allowEnabled, setAllowEnabled] = useState(false);

  useEffect(() => {
    setPairRequestListener((i) => {
      setInfo(i);
      setAllowEnabled(false);
    });
    return () => setPairRequestListener(null);
  }, []);

  useEffect(() => {
    if (!info) return;
    const t = setTimeout(() => setAllowEnabled(true), ALLOW_BUTTON_DISABLED_MS);
    return () => clearTimeout(t);
  }, [info]);

  function decide(decision: 'allow' | 'deny') {
    if (!info) return;
    const sd = (window as unknown as { electron: { streamdeck: { sendPairDecision: (r: string, d: 'allow' | 'deny') => void } } }).electron?.streamdeck;
    sd?.sendPairDecision(info.requestId, decision);
    setInfo(null);
  }

  if (!info) return null;

  const isOfficial = info.isOfficialId;

  return (
    <Modal open onClose={() => decide('deny')} size="md" showClose={false}>
      <ModalBody className="pt-7">
        {/* Title row: Howl squircle icon + title + description */}
        <div className="flex items-center gap-4 pb-5 mb-5 border-b border-[var(--glass-border)]">
          <div
            className="shrink-0 w-14 h-14 flex items-center justify-center bg-[#020617] border border-[var(--cyan-accent)]/25 overflow-hidden"
            style={{
              borderRadius: '28%',
              boxShadow: '0 8px 20px -8px rgba(7,111,160,0.35)',
            }}
          >
            <img
              src={assetPath('/howl-logo.png')}
              alt=""
              className="w-10 h-10"
              width={40}
              height={40}
            />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-[19px] font-semibold tracking-tight text-t-primary leading-tight">
              Stream Deck plugin wants to pair
            </h2>
            <p className="mt-1.5 text-[13px] text-t-secondary leading-snug">
              Allow this plugin to control voice, calls, reactions, and presence.
            </p>
          </div>
        </div>

        {/* Third-party warning (only when pluginId is not official) */}
        {!isOfficial && (
          <div className="mb-5 rounded-xl border border-red-500/40 bg-red-950/30 p-4 text-sm text-red-200">
            <div className="font-semibold text-red-300 mb-1">This is not the official Howl plugin.</div>
            <div className="text-[13px] leading-relaxed">
              The official plugin ID is <code className="font-mono text-red-100">com.howlpro.streamdeck</code>.
              This plugin identifies as <code className="font-mono text-red-100">{info.pluginId}</code>.
              If you did not deliberately install a third-party Howl plugin, click Deny.
            </div>
          </div>
        )}

        {/* Plugin section */}
        <div>
          <div className="font-black uppercase tracking-[0.08em] text-[11px] text-[var(--cyan-accent)] mb-2.5">
            Plugin
          </div>
          <div className="rounded-xl border border-[var(--glass-border)] bg-panel p-4">
            <div className="text-[15px] font-bold text-t-primary mb-1.5">{info.displayName}</div>
            <div className="flex items-center gap-2 flex-wrap text-xs text-t-secondary">
              <span className="inline-block px-2 py-0.5 rounded-md bg-[var(--cyan-accent)]/10 border border-[var(--cyan-accent)]/25 text-[var(--cyan-accent)] font-mono font-semibold text-[11px]">
                v{info.version}
              </span>
              <code className="font-mono text-[11px] text-t-tertiary">{info.pluginId}</code>
            </div>
          </div>
        </div>
      </ModalBody>

      <ModalFooter>
        {/* Deny on the left, Allow on the right. Allow is intentionally not
            autoFocused: the 1.5 s disable + lack of focus together prevent
            an accidental Enter / Space submit. */}
        <Button variant="ghost" size="md" onClick={() => decide('deny')}>
          Deny
        </Button>
        <Button
          variant="primary"
          size="md"
          disabled={!allowEnabled}
          onClick={() => decide('allow')}
        >
          {allowEnabled ? 'Allow' : 'Allow (wait…)'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
