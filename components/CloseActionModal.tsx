// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect } from 'react';
import { BellRing, XCircle } from 'lucide-react';

export const CloseActionModal: React.FC = () => {
  const [visible, setVisible] = useState(false);
  const [selected, setSelected] = useState<'tray' | 'quit'>('tray');
  const [remember, setRemember] = useState(true);

  useEffect(() => {
    if (!window.electron?.onShowCloseActionModal) return;
    const cleanup = window.electron.onShowCloseActionModal(() => {
      setVisible(true);
    });
    return cleanup;
  }, []);

  if (!visible) return null;

  const handleConfirm = () => {
    window.electron?.closeActionChosen?.(selected, remember);
    setVisible(false);
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center" style={{ backgroundColor: 'var(--overlay-backdrop, rgba(2,6,23,0.65))', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
      <div className="w-full max-w-[420px] mx-4 p-6 rounded-2xl shadow-2xl spring-pop-in" style={{
        backgroundColor: 'var(--glass-bg, rgba(15,22,35,0.72))',
        border: '1px solid var(--glass-border, rgba(255,255,255,0.08))',
        backdropFilter: 'blur(32px) saturate(1.6)',
        WebkitBackdropFilter: 'blur(32px) saturate(1.6)',
        boxShadow: '0 0 0 1px var(--border-subtle) inset, 0 25px 50px -12px rgba(0,0,0,0.5)',
      }}>
        {/* Title */}
        <h2 className="text-lg font-semibold text-center mb-1" style={{ color: 'var(--text-primary)' }}>
          Keep Howl Running?
        </h2>
        <p className="text-xs text-center mb-5" style={{ color: 'var(--text-secondary)' }}>
          Choose what happens when you close the window
        </p>

        {/* Option cards */}
        <div className="space-y-3 mb-5">
          {/* Minimize to Tray */}
          <button
            type="button"
            onClick={() => setSelected('tray')}
            className={`w-full text-left p-4 rounded-xl border-2 transition-all ${
              selected === 'tray'
                ? 'btn-cta-selected'
                : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)]'
            }`}
          >
            <div className="flex items-start gap-3">
              <BellRing size={20} className="shrink-0 mt-0.5" style={{ color: selected === 'tray' ? '#fff' : 'var(--text-secondary)' }} />
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Minimize to Tray</p>
                <p className="text-[11px] mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  Howl stays running in the background so you can receive notifications and stay in voice calls
                </p>
              </div>
            </div>
          </button>

          {/* Close Howl */}
          <button
            type="button"
            onClick={() => setSelected('quit')}
            className={`w-full text-left p-4 rounded-xl border-2 transition-all ${
              selected === 'quit'
                ? 'btn-cta-selected'
                : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)]'
            }`}
          >
            <div className="flex items-start gap-3">
              <XCircle size={20} className="shrink-0 mt-0.5" style={{ color: selected === 'quit' ? '#fff' : 'var(--text-secondary)' }} />
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Close Howl</p>
                <p className="text-[11px] mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  Fully quit Howl and end all connections
                </p>
              </div>
            </div>
          </button>
        </div>

        {/* Remember checkbox */}
        <label className="flex items-center gap-2 mb-1 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={remember}
            onChange={e => setRemember(e.target.checked)}
            className="w-4 h-4 rounded-lg accent-[var(--cyan-accent)]"
          />
          <span className="text-xs" style={{ color: 'var(--text-primary)' }}>Remember my choice</span>
        </label>
        <p className="text-[10px] mb-5 ml-6" style={{ color: 'var(--text-secondary)' }}>
          You can change this later in Settings &gt; Advanced
        </p>

        {/* Confirm button */}
        <button
          type="button"
          onClick={handleConfirm}
          className="btn-cta w-full py-2.5 rounded-xl text-sm transition-all"
        >
          Continue
        </button>
      </div>
    </div>
  );
};
