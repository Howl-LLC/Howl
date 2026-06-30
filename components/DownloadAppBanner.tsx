// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Monitor, Apple, Terminal, Download, X } from 'lucide-react';
import { isElectron as detectElectron } from '../config';

type DesktopOS = 'windows' | 'mac' | 'linux';

const DOWNLOAD_BASE = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_DOWNLOAD_BASE_URL)
  || 'https://releases.howlpro.com';

const DOWNLOAD_URLS: Record<DesktopOS, string | null> = {
  windows: `${DOWNLOAD_BASE}/Howl-Setup.exe`,
  // macOS build pending code-signing/notarization — null renders a
  // disabled "Coming soon" pill instead of a dead download link.
  mac: null,
  linux: `${DOWNLOAD_BASE}/Howl-amd64.deb`,
};

const OS_LABEL: Record<DesktopOS, string> = {
  windows: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
};

const OS_ICON: Record<DesktopOS, React.FC<{ size?: number; className?: string }>> = {
  windows: Monitor,
  mac: Apple,
  linux: Terminal,
};

/**
 * Detect the user's desktop OS for download targeting. Returns null on
 * mobile / unknown platforms so the banner hides rather than linking to a
 * .exe on an iPhone.
 */
function detectDesktopOS(): DesktopOS | null {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator.platform || '').toLowerCase();
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('android')) return null;
  if (platform.includes('mac') && navigator.maxTouchPoints > 1) return null; // iPad in desktop UA
  if (ua.includes('mac') || platform.includes('mac')) return 'mac';
  if (ua.includes('linux') || platform.includes('linux')) return 'linux';
  if (ua.includes('win') || platform.includes('win')) return 'windows';
  return null;
}

const DISMISS_KEY = 'howl_download_banner_dismissed';

/**
 * Home/lobby banner prompting web users to download the desktop app. Hidden
 * in Electron (we're already in the native app) and hidden on mobile (no
 * desktop build to offer). Dismissible — localStorage flag persists the
 * choice.
 */
export const DownloadAppBanner: React.FC = () => {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  });

  if (detectElectron()) return null;
  const os = detectDesktopOS();
  if (!os) return null;
  if (dismissed) return null;

  const Icon = OS_ICON[os];

  const handleDismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* storage unavailable */ }
    setDismissed(true);
  };

  return (
    <div
      className="relative flex flex-wrap items-center gap-4 rounded-2xl border border-[var(--glass-border)] p-4 pr-12"
      style={{
        background: 'linear-gradient(135deg, color-mix(in srgb, var(--cyan-accent) 12%, transparent), color-mix(in srgb, var(--cyan-accent) 4%, transparent))',
      }}
    >
      <div
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
        style={{ background: 'color-mix(in srgb, var(--cyan-accent) 18%, transparent)', color: 'var(--cyan-accent)' }}
      >
        <Icon size={20} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-t-primary">
          {t('home.downloadAppTitle', 'Get the Howl Desktop app')}
        </p>
        <p className="text-xs text-t-secondary mt-0.5">
          {t('home.downloadAppSubtitle', 'Native notifications, voice, and game overlay on {{os}}.', { os: OS_LABEL[os] })}
        </p>
      </div>
      {DOWNLOAD_URLS[os] ? (
        <a
          href={DOWNLOAD_URLS[os]!}
          className="btn-cta shrink-0 inline-flex items-center gap-2 rounded-xl px-4 py-3.5 text-[15px] font-semibold transition-all"
        >
          <Download size={14} />
          {t('home.downloadForOs', 'Download for {{os}}', { os: OS_LABEL[os] })}
        </a>
      ) : (
        <span
          className="btn-cta shrink-0 inline-flex items-center gap-2 rounded-xl px-4 py-3.5 text-[15px] font-semibold cursor-not-allowed"
          aria-disabled="true"
        >
          {t('home.downloadComingSoon', '{{os}} app — Coming soon', { os: OS_LABEL[os] })}
        </span>
      )}
      <button
        type="button"
        onClick={handleDismiss}
        aria-label={t('common.dismiss', 'Dismiss')}
        className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-lg text-t-secondary transition-colors hover:bg-[var(--fill-hover)] hover:text-t-primary"
      >
        <X size={14} />
      </button>
    </div>
  );
};
