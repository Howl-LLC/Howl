// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Check, Search, SpellCheck2 } from 'lucide-react';
import { SectionCard, ToggleRow, RadioOption, SliderRow } from './SettingsWidgets';
import { useSettings } from '../../contexts/SettingsContext';
import type { AccessibilitySettings, RoleColorMode, StickerAnimation } from '../../utils/settingsStorage';

export interface AccessibilityTabProps {}

export const AccessibilityTab: React.FC<AccessibilityTabProps> = () => {
  const { accessibilitySettings, updateAccessibility: onAccessibilityChange } = useSettings();
  const { t } = useTranslation();

  const a11y = accessibilitySettings ?? { saturation: 100, saturationCustomColors: false, alwaysUnderlineLinks: false, roleColorMode: 'in-names' as const, syncMotionWithOS: true, reducedMotion: false, autoplayGifs: true, playAnimatedEmoji: true, stickerAnimation: 'always' as const, showSendButton: false, legacyChatInput: false, ttsRate: 100, showOnOffIndicators: false, composerSpellcheck: true, spellcheckLanguages: [] };
  const setA = (patch: Partial<AccessibilitySettings>) => onAccessibilityChange?.(patch);

  // Spellcheck language picker (Electron-only)
  // Chromium's bundled Hunspell engine ships ~50 locales. We fetch the
  // actual list from main on mount via IPC so the picker only shows
  // codes that have a dictionary on the user's install.
  const electronSpellcheck = (window as { electron?: { spellcheck?: { getAvailableLanguages?: () => Promise<string[]> } } }).electron?.spellcheck;
  const [availableLanguages, setAvailableLanguages] = useState<string[]>([]);
  useEffect(() => {
    if (!electronSpellcheck?.getAvailableLanguages) return;
    electronSpellcheck.getAvailableLanguages().then((langs) => {
      if (Array.isArray(langs)) setAvailableLanguages(langs);
    }).catch(() => { /* unsupported */ });
  }, [electronSpellcheck]);

  // Pretty-print locale codes via the standard Intl API. Falls back to
  // the raw code if the runtime can't render the display name.
  const langDisplay = useMemo(() => {
    try {
      const dn = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
      return (code: string) => dn.of(code) ?? code;
    } catch {
      return (code: string) => code;
    }
  }, []);

  const [langSearch, setLangSearch] = useState('');
  const filteredLanguages = useMemo(() => {
    const q = langSearch.trim().toLowerCase();
    if (!q) return availableLanguages;
    return availableLanguages.filter((code) =>
      code.toLowerCase().includes(q) || langDisplay(code).toLowerCase().includes(q),
    );
  }, [availableLanguages, langSearch, langDisplay]);

  const selectedLanguages = a11y.spellcheckLanguages ?? [];
  const toggleLanguage = (code: string) => {
    const next = selectedLanguages.includes(code)
      ? selectedLanguages.filter((c) => c !== code)
      : [...selectedLanguages, code];
    setA({ spellcheckLanguages: next });
  };

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2 text-t-primary">{t('settings.accessibility')}</h2>
      <p className="text-xs mb-8 text-t-secondary">{t('settings.adjustMotionContrast')}</p>

      <SectionCard title={t('settings.saturation')}>
        <p className="text-xs mb-4 text-t-secondary">{t('settings.reduceSaturationDesc')}</p>
        <div id="setting-saturation"><SliderRow label={t('settings.saturation')} value={a11y.saturation} min={0} max={100} step={1} unit="%" onChange={v => setA({ saturation: v })} /></div>
        <div id="setting-apply-to-custom-colors"><ToggleRow label={t('settings.applyToCustomColors')} description={t('settings.applyToCustomColors')} checked={a11y.saturationCustomColors} onChange={v => setA({ saturationCustomColors: v })} /></div>
        <div id="setting-always-underline-links"><ToggleRow label={t('settings.alwaysUnderlineLinks')} description={t('settings.alwaysUnderlineLinks')} checked={a11y.alwaysUnderlineLinks} onChange={v => setA({ alwaysUnderlineLinks: v })} /></div>
      </SectionCard>

      <SectionCard title={t('settings.highContrast.title', { defaultValue: 'High contrast' })}>
        <p className="text-xs mb-4 text-t-secondary">{t('settings.highContrast.desc', { defaultValue: 'Increase text and border contrast using a high-contrast palette. Applies across themes.' })}</p>
        <div id="setting-high-contrast"><ToggleRow label={t('settings.highContrast.enable', { defaultValue: 'Enable high contrast' })} checked={a11y.highContrast} onChange={v => setA({ highContrast: v })} /></div>
      </SectionCard>

      <div id="setting-role-color-mode">
      <SectionCard title={t('settings.roleColors')}>
        <p className="text-xs mb-4 text-t-secondary">{t('settings.roleColors')}</p>
        <RadioOption label={t('settings.showInNames')} value="in-names" selected={a11y.roleColorMode === 'in-names'} onChange={v => setA({ roleColorMode: v as RoleColorMode })} />
        <RadioOption label={t('settings.showNextToNames')} value="next-to-names" selected={a11y.roleColorMode === 'next-to-names'} onChange={v => setA({ roleColorMode: v as RoleColorMode })} />
        <RadioOption label={t('settings.dontShowRoleColors')} value="hidden" selected={a11y.roleColorMode === 'hidden'} onChange={v => setA({ roleColorMode: v as RoleColorMode })} />
      </SectionCard>
      </div>

      <SectionCard title={t('settings.reducedMotion')}>
        <div id="setting-sync-motion-with-os"><ToggleRow label={t('settings.syncWithComputer')} checked={a11y.syncMotionWithOS} onChange={v => setA({ syncMotionWithOS: v })} /></div>
        <div id="setting-reduced-motion"><ToggleRow label={t('settings.enableReducedMotion')} checked={a11y.reducedMotion} onChange={v => setA({ reducedMotion: v })} /></div>
        <div id="setting-autoplay-gifs"><ToggleRow label={t('settings.automaticallyPlayGifs')} checked={a11y.autoplayGifs} onChange={v => setA({ autoplayGifs: v })} /></div>
        <div id="setting-play-animated-emoji"><ToggleRow label={t('settings.playAnimatedEmoji')} checked={a11y.playAnimatedEmoji} onChange={v => setA({ playAnimatedEmoji: v })} /></div>
      </SectionCard>

      <div id="setting-sticker-animation">
      <SectionCard title={t('settings.stickersSection')}>
        <p className="text-xs mb-3 text-t-secondary">{t('settings.controlsWhenStickersAnimate')}</p>
        <RadioOption label={t('settings.alwaysAnimate')} value="always" selected={a11y.stickerAnimation === 'always'} onChange={v => setA({ stickerAnimation: v as StickerAnimation })} />
        <RadioOption label={t('settings.animateOnInteraction')} description={t('settings.animateOnInteractionDesc')} value="interaction" selected={a11y.stickerAnimation === 'interaction'} onChange={v => setA({ stickerAnimation: v as StickerAnimation })} />
        <RadioOption label={t('settings.neverAnimate')} value="never" selected={a11y.stickerAnimation === 'never'} onChange={v => setA({ stickerAnimation: v as StickerAnimation })} />
      </SectionCard>
      </div>

      <SectionCard title={t('settings.chatInput')}>
        <div id="setting-show-send-button"><ToggleRow label={t('settings.showSendButton')} checked={a11y.showSendButton} onChange={v => setA({ showSendButton: v })} /></div>
        <div id="setting-legacy-chat-input"><ToggleRow label={t('settings.useLegacyInput')} description={t('settings.legacyInputDesc')} checked={a11y.legacyChatInput} onChange={v => setA({ legacyChatInput: v })} /></div>
        <div id="setting-show-on-off-indicators"><ToggleRow label={t('settings.showOnOffIndicators')} checked={a11y.showOnOffIndicators} onChange={v => setA({ showOnOffIndicators: v })} /></div>
      </SectionCard>

      <SectionCard title={t('settings.spellcheck.title', { defaultValue: 'Spellcheck' })}>
        <div id="setting-spellcheck-enable"><ToggleRow
          label={t('settings.spellcheck.enable', { defaultValue: 'Spellcheck' })}
          description={t('settings.spellcheck.enableDesc', { defaultValue: 'Underline misspelt words in the message composer.' })}
          checked={a11y.composerSpellcheck ?? true}
          onChange={v => setA({ composerSpellcheck: v })}
        /></div>
        {electronSpellcheck ? (
          <div id="setting-spellcheck-languages" className="mt-4">
            <p className="text-[11px] font-bold uppercase tracking-widest mb-2 text-t-secondary flex items-center gap-2">
              <SpellCheck2 size={12} className="text-[var(--cyan-accent)]" />
              {t('settings.spellcheck.languages', { defaultValue: 'Languages' })}
            </p>
            <p className="text-xs mb-3 text-t-secondary">
              {t('settings.spellcheck.languagesDesc', { defaultValue: 'Pick the languages Howl checks against. Multiple selections work for bilingual users. Leaving everything unchecked falls back to your operating system language.' })}
            </p>
            {availableLanguages.length === 0 ? (
              <p className="text-xs text-t-secondary opacity-60">
                {t('settings.spellcheck.loading', { defaultValue: 'Loading available languages…' })}
              </p>
            ) : (
              <>
                <div className="relative mb-2">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-t-secondary" />
                  <input
                    type="text"
                    value={langSearch}
                    onChange={(e) => setLangSearch(e.target.value)}
                    placeholder={t('settings.spellcheck.searchPlaceholder', { defaultValue: 'Search languages…' })}
                    className="w-full bg-fill-hover border border-[var(--glass-border)] rounded-lg pl-9 pr-3 py-2 text-sm text-t-primary outline-none focus:border-[var(--cyan-accent)]/50 transition-colors"
                  />
                </div>
                <div
                  className="rounded-xl border border-[var(--glass-border)] max-h-[260px] overflow-y-auto"
                  style={{ backgroundColor: 'var(--bg-input)' }}
                >
                  {filteredLanguages.length === 0 ? (
                    <p className="text-xs text-t-secondary opacity-60 px-4 py-6 text-center">
                      {t('settings.spellcheck.noMatches', { defaultValue: 'No languages match your search.' })}
                    </p>
                  ) : (
                    filteredLanguages.map((code) => {
                      const checked = selectedLanguages.includes(code);
                      return (
                        <button
                          key={code}
                          type="button"
                          onClick={() => toggleLanguage(code)}
                          className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-fill-hover transition-colors border-b last:border-b-0"
                          style={{ borderColor: 'var(--glass-border)', borderBottomWidth: 1 }}
                        >
                          <span
                            className="shrink-0 inline-flex items-center justify-center rounded-lg border transition-colors"
                            style={{
                              width: 16, height: 16,
                              backgroundColor: checked ? 'var(--cyan-accent)' : 'transparent',
                              borderColor: checked ? 'var(--cyan-accent)' : 'var(--glass-border)',
                            }}
                          >
                            {checked && <Check size={11} className="text-black" strokeWidth={3} />}
                          </span>
                          <span className="flex-1 text-sm text-t-primary">{langDisplay(code)}</span>
                          <span className="text-[10px] font-mono tabular-nums opacity-50">{code}</span>
                        </button>
                      );
                    })
                  )}
                </div>
                {selectedLanguages.length > 0 && (
                  <p className="text-[10px] mt-2 text-t-secondary opacity-70">
                    {t('settings.spellcheck.selectedCount', {
                      count: selectedLanguages.length,
                      defaultValue: '{{count}} languages selected',
                    })}
                  </p>
                )}
              </>
            )}
          </div>
        ) : (
          <p className="text-xs mt-4 text-t-secondary opacity-70">
            {t('settings.spellcheck.webNote', { defaultValue: 'Spellcheck languages are managed by your browser on the web. Open the Howl desktop app to pick specific languages.' })}
          </p>
        )}
      </SectionCard>

      <SectionCard title={t('settings.textToSpeech')}>
        <p className="text-xs mb-4 text-t-secondary">{t('settings.controlTTSRate')}</p>
        <div id="setting-tts-rate"><SliderRow label={t('settings.ttsRate')} value={a11y.ttsRate} min={50} max={200} step={10} unit="%" onChange={v => setA({ ttsRate: v })} /></div>
        <div id="setting-tts-preview"><button type="button" onClick={() => {
          const u = new SpeechSynthesisUtterance(t('settings.ttsPreview'));
          u.rate = a11y.ttsRate / 100;
          speechSynthesis.speak(u);
        }} className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-[var(--cyan-accent)]/20 text-[var(--cyan-accent)] border border-[var(--cyan-accent)]/30 hover:bg-[var(--cyan-accent)]/30 transition-all">
          <Play size={14} /> {t('settings.preview')}
        </button></div>
      </SectionCard>
    </div>
  );
};

export default AccessibilityTab;
