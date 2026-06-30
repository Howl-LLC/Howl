// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useCallback } from 'react';
import { Monitor, EyeOff } from 'lucide-react';

const STORAGE_KEY = 'howl_autostart_prompt_shown';

interface AutostartPromptModalProps {
  onDismiss: () => void;
}

/**
 * First-run modal shown ONCE after initial login in Electron.
 * Asks the user whether they want Howl to launch at system login,
 * and if so whether to start visible or hidden in the tray.
 *
 * Hidden from web builds — the parent component gates rendering on
 * `window.electron?.getAutostart` being available.
 */
export const AutostartPromptModal: React.FC<AutostartPromptModalProps> = ({ onDismiss }) => {
  const [enableAutostart, setEnableAutostart] = useState(true);
  const [startHidden, setStartHidden] = useState(true);

  const handleConfirm = useCallback(() => {
    // Persist "shown" flag so it never appears again for this install
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch { /* ignore */ }

    // Apply the user's choice via Electron IPC
    window.electron?.setAutostart?.({
      enabled: enableAutostart,
      startHidden: enableAutostart ? startHidden : false,
    });

    onDismiss();
  }, [enableAutostart, startHidden, onDismiss]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{
        backgroundColor: 'var(--overlay-backdrop, rgba(2,6,23,0.65))',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      <div
        className="w-full max-w-[440px] mx-4 p-6 rounded-2xl shadow-2xl spring-pop-in"
        style={{
          backgroundColor: 'var(--glass-bg, rgba(15,22,35,0.72))',
          border: '1px solid var(--glass-border, rgba(255,255,255,0.08))',
          backdropFilter: 'blur(32px) saturate(1.6)',
          WebkitBackdropFilter: 'blur(32px) saturate(1.6)',
          boxShadow: '0 0 0 1px var(--border-subtle) inset, 0 25px 50px -12px rgba(0,0,0,0.5)',
        }}
      >
        {/* Title */}
        <h2
          className="text-lg font-semibold text-center mb-1"
          style={{ color: 'var(--text-primary)' }}
        >
          Start Howl automatically?
        </h2>
        <p
          className="text-xs text-center mb-5"
          style={{ color: 'var(--text-secondary)' }}
        >
          Keep Howl ready so you never miss a message
        </p>

        {/* Yes / No option cards */}
        <div className="space-y-3 mb-4">
          {/* Yes */}
          <button
            type="button"
            onClick={() => setEnableAutostart(true)}
            className={`w-full text-left p-4 rounded-xl border-2 transition-all ${
              enableAutostart
                ? 'btn-cta-selected'
                : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)]'
            }`}
          >
            <p
              className="text-sm font-semibold"
              style={{ color: enableAutostart ? '#fff' : 'var(--text-primary)' }}
            >
              Yes, launch at login
            </p>
            <p
              className="text-[11px] mt-1 leading-relaxed"
              style={{ color: enableAutostart ? 'rgba(255,255,255,0.7)' : 'var(--text-secondary)' }}
            >
              Howl will start automatically when you sign in to your computer
            </p>
          </button>

          {/* No */}
          <button
            type="button"
            onClick={() => setEnableAutostart(false)}
            className={`w-full text-left p-4 rounded-xl border-2 transition-all ${
              !enableAutostart
                ? 'btn-cta-selected'
                : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)]'
            }`}
          >
            <p
              className="text-sm font-semibold"
              style={{ color: !enableAutostart ? '#fff' : 'var(--text-primary)' }}
            >
              No thanks
            </p>
            <p
              className="text-[11px] mt-1 leading-relaxed"
              style={{ color: !enableAutostart ? 'rgba(255,255,255,0.7)' : 'var(--text-secondary)' }}
            >
              {"I'll open Howl myself when I need it"}
            </p>
          </button>
        </div>

        {/* Nested start-mode choice (only when autostart enabled) */}
        {enableAutostart && (
          <div
            className="pl-4 mb-4 border-l-2"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <p
              className="text-[10px] font-bold uppercase tracking-widest mb-2"
              style={{ color: 'var(--text-secondary)', opacity: 0.6 }}
            >
              Start mode
            </p>

            <button
              type="button"
              onClick={() => setStartHidden(true)}
              className="flex items-center gap-3 py-2 w-full text-left group"
            >
              <div
                className={`w-4 h-4 rounded-full border-[1.5px] flex items-center justify-center shrink-0 transition-colors ${
                  startHidden
                    ? 'border-[var(--cyan-accent)] bg-[var(--cyan-accent)]'
                    : 'border-[var(--border-strong)]'
                }`}
              >
                {startHidden && (
                  <div className="w-2 h-2 rounded-full bg-white" />
                )}
              </div>
              <EyeOff
                size={16}
                className="shrink-0"
                style={{
                  color: startHidden
                    ? 'var(--cyan-accent)'
                    : 'var(--text-secondary)',
                }}
              />
              <div>
                <p
                  className="text-sm font-medium"
                  style={{ color: 'var(--text-primary)' }}
                >
                  Start hidden (in tray)
                </p>
                <p
                  className="text-[11px] mt-0.5"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Runs silently until you click the tray icon
                </p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setStartHidden(false)}
              className="flex items-center gap-3 py-2 w-full text-left group"
            >
              <div
                className={`w-4 h-4 rounded-full border-[1.5px] flex items-center justify-center shrink-0 transition-colors ${
                  !startHidden
                    ? 'border-[var(--cyan-accent)] bg-[var(--cyan-accent)]'
                    : 'border-[var(--border-strong)]'
                }`}
              >
                {!startHidden && (
                  <div className="w-2 h-2 rounded-full bg-white" />
                )}
              </div>
              <Monitor
                size={16}
                className="shrink-0"
                style={{
                  color: !startHidden
                    ? 'var(--cyan-accent)'
                    : 'var(--text-secondary)',
                }}
              />
              <div>
                <p
                  className="text-sm font-medium"
                  style={{ color: 'var(--text-primary)' }}
                >
                  Show main window
                </p>
                <p
                  className="text-[11px] mt-0.5"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Opens the Howl window immediately
                </p>
              </div>
            </button>
          </div>
        )}

        <p
          className="text-[10px] mb-4 text-center"
          style={{ color: 'var(--text-secondary)' }}
        >
          You can change this later in Settings &gt; Advanced
        </p>

        {/* Confirm button */}
        <button
          type="button"
          onClick={handleConfirm}
          className="btn-cta w-full py-2.5 rounded-xl text-sm font-semibold transition-all"
        >
          Continue
        </button>
      </div>
    </div>
  );
};
