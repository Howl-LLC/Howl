// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../../contexts/SettingsContext';
import type { ServerLayout } from '../../utils/uiDensityStorage';

/** localStorage key gating whether the picker has been shown for this
 *  account on this device. Re-exported from settingsSync — the canonical
 *  definition lives there because SettingsContext needs to write the flag
 *  on inbound server sync (cross-device persistence) and importing it
 *  from this modal would create a cycle (modal → useSettings → context).
 *  The settings blob also carries `hasSeenLayoutPicker` for the
 *  server-side mirror. */
export { LAYOUT_PICKER_SEEN_KEY } from '../../utils/settingsSync';

export interface LayoutPickerModalProps {
  /** Fired when the user confirms their pick. Parent should write the
   *  seen flag and unmount the modal. */
  onComplete: (picked: ServerLayout) => void;
}

/** First-run modal new accounts see right after EncryptionChoiceModal,
 *  before AppLayout mounts. Asks the user to pick Default or Classic
 *  server layout, with live wireframe previews of each option.
 *
 *  Pre-selects whatever serverLayout the SettingsContext currently holds
 *  (typically `'default'`) so the user can hit Continue without picking. */
export const LayoutPickerModal: React.FC<LayoutPickerModalProps> = ({ onComplete }) => {
  const { t } = useTranslation();
  const { serverLayout, setServerLayout } = useSettings();
  const [picked, setPicked] = useState<ServerLayout>(serverLayout);

  const handleContinue = () => {
    // Commit the pick (no-op if it already matches the current setting).
    setServerLayout(picked);
    onComplete(picked);
  };

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" />
      <div
        className="w-full max-w-xl rounded-2xl border shadow-2xl relative spring-pop-in overflow-hidden"
        style={{
          backgroundColor: 'var(--bg-panel)',
          borderColor: 'var(--border-subtle)',
          backdropFilter: 'blur(40px)',
        }}
      >
        <div className="px-7 pt-7 pb-5">
          <h2 className="text-[22px] font-semibold tracking-tight mb-1.5" style={{ color: 'var(--text-primary)' }}>
            {t('layoutPicker.title', 'Pick your layout')}
          </h2>
          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {t('layoutPicker.subtitle', 'How would you like channels organized?')}{' '}
            {t('layoutPicker.subtitleHint', 'You can change this anytime in')}{' '}
            <strong style={{ color: 'var(--text-primary)' }}>
              {t('layoutPicker.settingsPath', 'Settings › Appearance')}
            </strong>
            .
          </p>
        </div>

        <div className="px-7 pb-6">
          <div className="grid grid-cols-2 gap-3.5">
            <LayoutCard
              option="default"
              active={picked === 'default'}
              onSelect={() => setPicked('default')}
              label={t('layoutPicker.default.label', 'Navigator')}
              description={t('layoutPicker.default.desc', 'Servers open from the Howl logo; activity, voice, text & pinned as tabs')}
            />
            <LayoutCard
              option="classic"
              active={picked === 'classic'}
              onSelect={() => setPicked('classic')}
              label={t('layoutPicker.classic.label', 'Classic')}
              description={t('layoutPicker.classic.desc', 'Channels in a sidebar grouped by category, Discord-style.')}
            />
          </div>
        </div>

        <div className="px-7 pb-7 flex flex-col gap-3">
          <button
            type="button"
            onClick={handleContinue}
            className="btn-cta w-full py-3.5 text-sm rounded-xl transition-all"
          >
            {t('common.continue', 'Continue')}
          </button>
          <p className="text-[11px] text-center" style={{ color: 'var(--text-secondary)', opacity: 0.7 }}>
            {t('layoutPicker.footnote', 'Change anytime in')}{' '}
            <strong style={{ color: 'var(--text-secondary)', opacity: 0.95 }}>
              {t('layoutPicker.settingsPath', 'Settings › Appearance')}
            </strong>
            .
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
};

interface LayoutCardProps {
  option: ServerLayout;
  active: boolean;
  onSelect: () => void;
  label: string;
  description: string;
}

/** A single layout option card with a wireframe preview, label, and
 *  description. Active state uses the flat btn-cta-selected treatment
 *  (no outer glow) shared with AppearanceTab's serverLayout picker. */
const LayoutCard: React.FC<LayoutCardProps> = ({ option, active, onSelect, label, description }) => (
  <button
    type="button"
    onClick={onSelect}
    aria-pressed={active}
    className={`relative text-left p-3.5 rounded-2xl border transition-all ${
      active
        ? 'btn-cta-selected'
        : 'border-[var(--glass-border)] bg-black/20 hover:border-[var(--cyan-accent)]/25'
    }`}
  >
    {/* Check medallion appears in the top-right corner when this card is
        active. Springs in via a CSS transition on transform/opacity. */}
    <div
      className={`absolute top-2.5 right-2.5 w-[22px] h-[22px] rounded-full flex items-center justify-center transition-all duration-200 ${
        active ? 'opacity-100 scale-100' : 'opacity-0 scale-50'
      }`}
      style={{
        backgroundColor: 'var(--cyan-accent)',
        color: 'var(--text-on-accent, #0a0e12)',
      }}
    >
      <Check size={13} strokeWidth={3} />
    </div>

    {/* Wireframe preview: simplified visual representation of each
        layout. Navigator = rail-less full-bleed content with a floating
        Howl logo and fanned launcher tiles. Classic = vertical channel
        tree on the left. */}
    <div
      className="w-full rounded-lg mb-3 relative overflow-hidden"
      style={{
        height: 130,
        background: 'linear-gradient(135deg, #0d1219 0%, #060a0d 100%)',
        border: active ? '1px solid rgba(7, 111, 160, 0.18)' : '1px solid rgba(255,255,255,0.04)',
      }}
    >
      {option === 'default' ? <DefaultPreview /> : <ClassicPreview />}
    </div>

    <div
      className="text-[13px] font-bold mb-1 tracking-tight"
      style={{ color: active ? '#fff' : 'var(--text-primary)' }}
    >
      {label}
    </div>
    <div className="text-[11px] leading-snug" style={{ color: active ? 'rgba(255,255,255,0.7)' : 'var(--text-secondary)' }}>
      {description}
    </div>
  </button>
);

/** Navigator-mode wireframe: rail-less. A full-bleed content panel with
 *  a single floating cyan Howl-logo square pinned top-left and a few
 *  fanned launcher tiles beside it. No server rail, no channel-tab bar. */
const DefaultPreview: React.FC = () => (
  <div className="absolute inset-0 p-1">
    {/* Full-bleed content panel underneath the floating launcher mark. */}
    <div className="absolute inset-1 rounded-lg bg-white/[0.03] flex flex-col gap-0.5 p-2.5">
      <div className="h-[3px] rounded-sm bg-white/[0.08]" style={{ width: '70%' }} />
      <div className="h-[3px] rounded-sm bg-white/[0.08]" style={{ width: '50%' }} />
      <div className="h-[3px] rounded-sm bg-white/[0.08]" />
      <div className="h-[3px] rounded-sm bg-white/[0.08]" style={{ width: '60%' }} />
      <div className="h-[3px] rounded-sm bg-white/[0.08]" style={{ width: '40%' }} />
    </div>
    {/* Floating Howl-logo square top-left (opens the Navigator overlay). */}
    <div className="absolute top-2 left-2 w-3.5 h-3.5 rounded-md" style={{ backgroundColor: 'var(--cyan-accent)' }} />
    {/* A couple of fanned launcher tiles next to the mark. */}
    <div className="absolute top-2 w-2.5 h-2.5 rounded-md bg-white/[0.10]" style={{ left: 26 }} />
    <div className="absolute w-2.5 h-2.5 rounded-md bg-white/[0.06]" style={{ top: 24, left: 18 }} />
  </div>
);

/** Classic-mode wireframe: server-icon column, vertical channel-tree
 *  sidebar with category headers, then chat and members. */
const ClassicPreview: React.FC = () => (
  <div className="absolute inset-0 grid items-stretch p-1 gap-0.5" style={{ gridTemplateColumns: '18px 30% 1fr 26%' }}>
    <div className="flex flex-col items-center gap-0.5 py-1">
      <div className="w-3 h-3 rounded-md" style={{ backgroundColor: 'var(--cyan-accent)' }} />
      <div className="w-3 h-3 rounded-md bg-white/[0.08]" />
      <div className="w-3 h-3 rounded-md bg-white/[0.08]" />
    </div>
    <div className="rounded-lg bg-white/[0.025] flex flex-col gap-0.5 p-1">
      <div className="text-[5px] uppercase tracking-wider px-0.5" style={{ color: 'rgba(255,255,255,0.4)', letterSpacing: '0.04em' }}>
        ▾ general
      </div>
      <PreviewChannel active />
      <PreviewChannel />
      <div className="text-[5px] uppercase tracking-wider px-0.5 mt-0.5" style={{ color: 'rgba(255,255,255,0.4)', letterSpacing: '0.04em' }}>
        ▾ voice
      </div>
      <PreviewChannel />
    </div>
    <div className="rounded-lg bg-white/[0.03] flex flex-col gap-0.5 p-1">
      <div className="h-[3px] rounded-sm bg-white/[0.08]" style={{ width: '80%' }} />
      <div className="h-[3px] rounded-sm bg-white/[0.08]" style={{ width: '60%' }} />
      <div className="h-[3px] rounded-sm bg-white/[0.08]" />
      <div className="h-[3px] rounded-sm bg-white/[0.08]" style={{ width: '60%' }} />
    </div>
    <div className="rounded-lg bg-white/[0.025] flex flex-col gap-0.5 p-0.5">
      <PreviewMember />
      <PreviewMember />
      <PreviewMember />
    </div>
  </div>
);

const PreviewChannel: React.FC<{ active?: boolean }> = ({ active }) => (
  <div className="flex items-center gap-0.5 py-[1px] px-1 rounded-sm" style={active ? { backgroundColor: 'rgba(7, 111, 160, 0.15)' } : undefined}>
    <div className="w-[3px] h-[3px] rounded-[1px]" style={{ backgroundColor: active ? 'var(--cyan-accent)' : 'rgba(255,255,255,0.25)' }} />
    <div className="flex-1 h-[2px] rounded-[1px]" style={{ backgroundColor: active ? 'var(--cyan-accent)' : 'rgba(255,255,255,0.18)' }} />
  </div>
);

const PreviewMember: React.FC = () => (
  <div className="flex items-center gap-0.5">
    <div className="w-[5px] h-[5px] rounded-full bg-white/[0.15]" />
    <div className="flex-1 h-[2px] rounded-[1px] bg-white/[0.08]" />
  </div>
);

export default LayoutPickerModal;
