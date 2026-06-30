// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useCallback, useEffect, useState } from 'react';
import { SectionCard, ToggleRow, EmptyState, DangerButton } from './SettingsWidgets';

interface Pairing {
  pluginId: string;
  displayName: string;
  version: string;
  pairedAt: number;
  lastUsedAt: number;
}

interface AppSettings {
  closeAction?: string;
  startMinimized?: boolean;
  streamdeckEnabled?: boolean;
  streamdeckAllowMobile?: boolean;
}

const sd = () => (window as unknown as { electron?: { streamdeck?: {
  isRunning: () => Promise<boolean>;
  setEnabled: (e: boolean) => Promise<{ ok: boolean; running: boolean }>;
  listPairings: () => Promise<Pairing[]>;
  revokePairing: (pluginId: string) => Promise<void>;
} } }).electron?.streamdeck;

const electronApi = () => (window as unknown as { electron?: {
  getAppSettings: () => Promise<AppSettings>;
  setAppSettings: (s: Partial<AppSettings>) => Promise<AppSettings>;
} }).electron;

const MARKETPLACE_URL = 'https://marketplace.elgato.com/search?q=Howl';
const OFFICIAL_PLUGIN_ID = 'com.howlpro.streamdeck';

export function StreamDeckTab() {
  const [enabled, setEnabled] = useState(false);
  const [allowMobile, setAllowMobile] = useState(false);
  const [pairings, setPairings] = useState<Pairing[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api = sd();
    if (!api) return;
    try {
      const running = await api.isRunning();
      setEnabled(running);
      if (running) setPairings(await api.listPairings()); else setPairings([]);
    } catch (err) {
      setError((err as Error).message || String(err));
    }
  }, []);

  useEffect(() => {
    const el = electronApi();
    if (!el?.getAppSettings) return;
    el.getAppSettings().then((s) => {
      setAllowMobile(!!s.streamdeckAllowMobile);
    }).catch(() => { /* best effort */ });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function toggle(next: boolean) {
    const api = sd();
    if (!api) return;
    setBusy(true); setError(null);
    try {
      await api.setEnabled(next);
      await refresh();
    } catch (err) {
      setError((err as Error).message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleAllowMobile(next: boolean) {
    const el = electronApi();
    if (!el?.setAppSettings) return;
    setBusy(true); setError(null);
    try {
      const updated = await el.setAppSettings({ streamdeckAllowMobile: next });
      setAllowMobile(!!updated.streamdeckAllowMobile);
    } catch (err) {
      setError((err as Error).message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(pluginId: string) {
    const api = sd();
    if (!api) return;
    setBusy(true);
    try { await api.revokePairing(pluginId); await refresh(); }
    finally { setBusy(false); }
  }

  const api = sd();
  // Web fallback: settings tab is reachable from the browser app where
  // window.electron is undefined. Show a clear "desktop only" message
  // instead of broken controls.
  if (!api) {
    return (
      <div className="max-w-3xl mx-auto">
        <h2 className="text-lg font-semibold tracking-tight mb-2 text-t-primary">Stream Deck</h2>
        <p className="text-xs mb-8 text-t-secondary">
          Control voice, calls, reactions, and more from an Elgato Stream Deck.
        </p>
        <SectionCard>
          <EmptyState
            icon={<DesktopOnlyIcon />}
            title="Desktop only"
            desc="The Stream Deck integration is only available in the Howl desktop app. Sign in there to pair a Stream Deck."
          />
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2 text-t-primary">Stream Deck</h2>
      <p className="text-xs mb-8 text-t-secondary">
        Control voice, calls, reactions, and more from an Elgato Stream Deck.
        When paired with desktop hardware, the connection stays on your machine,
        nothing about your messages, channels, or contacts leaves your computer.
      </p>

      {error && (
        <div className="mb-6 rounded-xl border border-red-500/40 bg-red-950/30 p-4 text-sm text-red-200">
          {error}
        </div>
      )}

      <SectionCard title="Integration">
        <p className="text-xs mb-4 text-t-secondary leading-relaxed">
          Turn this on to run the local bridge. The Howl Stream Deck plugin will
          discover it and prompt you to pair the first time it connects.
        </p>
        <div id="setting-streamdeck-enable"><ToggleRow
          label="Enable Stream Deck integration"
          description="Starts a local bridge on 127.0.0.1 that the plugin connects to."
          checked={enabled}
          onChange={(v) => { if (!busy) toggle(v); }}
        /></div>
        <div id="setting-streamdeck-allow-mobile"><ToggleRow
          label="Allow Stream Deck Mobile (iOS / Android)"
          description="Stream Deck Mobile relays key content through Elgato's cloud service. Channel names and avatars will transit Elgato's servers. Leave off for desktop-only."
          checked={allowMobile}
          onChange={(v) => { if (!busy && enabled) toggleAllowMobile(v); }}
        /></div>
      </SectionCard>

      <SectionCard title="Paired plugins">
        <div id="setting-streamdeck-revoke-pairing">{!enabled ? (
          <EmptyState
            icon={<StreamDeckIcon />}
            title="Integration is off"
            desc="Enable the integration above to pair a Stream Deck plugin."
          />
        ) : pairings.length === 0 ? (
          <EmptyState
            icon={<StreamDeckIcon />}
            title="No plugins paired yet"
            desc="Install the official Howl Stream Deck plugin from the Elgato Marketplace. Approve the pairing prompt when it appears."
          />
        ) : (
          <ul className="space-y-3">
            {pairings.map((p) => (
              <li
                key={p.pluginId}
                className="flex items-start justify-between gap-4 rounded-xl border border-[var(--glass-border)] bg-floating p-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-t-primary">{p.displayName}</span>
                    <span className="inline-block px-2 py-0.5 rounded-md bg-[var(--cyan-accent)]/10 border border-[var(--cyan-accent)]/25 text-[var(--cyan-accent)] font-mono font-semibold text-[10px]">
                      v{p.version}
                    </span>
                  </div>
                  <code className="block font-mono text-[11px] text-t-tertiary mb-1">{p.pluginId}</code>
                  <div className="text-[11px] text-t-tertiary">
                    Paired {new Date(p.pairedAt).toLocaleString()} · Last used {new Date(p.lastUsedAt).toLocaleString()}
                  </div>
                </div>
                <DangerButton
                  disabled={busy}
                  onClick={() => revoke(p.pluginId)}
                >
                  Revoke
                </DangerButton>
              </li>
            ))}
          </ul>
        )}</div>
      </SectionCard>

      <SectionCard title="Official plugin">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] font-medium text-t-secondary mb-1">Plugin ID</div>
            <code className="block font-mono text-sm text-t-primary truncate">{OFFICIAL_PLUGIN_ID}</code>
          </div>
          <a
            href={MARKETPLACE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 px-3.5 py-2 rounded-lg text-xs font-bold text-[var(--cyan-accent)] bg-[var(--cyan-accent)]/8 border border-[var(--cyan-accent)]/25 hover:bg-[var(--cyan-accent)]/15 transition-colors"
          >
            Open in Marketplace →
          </a>
        </div>
      </SectionCard>
    </div>
  );
}

// Stream Deck-style 5x3 grid icon for the empty state
function StreamDeckIcon() {
  return (
    <div
      className="w-12 h-12 rounded-xl border-2 border-dashed border-t-tertiary/30 flex items-center justify-center"
      aria-hidden="true"
    >
      <div className="grid grid-cols-3 gap-0.5 w-7 h-7">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="bg-t-tertiary/30 rounded-sm" />
        ))}
      </div>
    </div>
  );
}

function DesktopOnlyIcon() {
  return (
    <div
      className="w-12 h-12 rounded-xl border-2 border-dashed border-t-tertiary/30 flex items-center justify-center text-2xl text-t-tertiary"
      aria-hidden="true"
    >
      ▢
    </div>
  );
}
