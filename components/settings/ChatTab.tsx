// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React from 'react';
import { useTranslation } from 'react-i18next';
import { SectionCard, ToggleRow, RadioOption } from './SettingsWidgets';
import { useSettings } from '../../contexts/SettingsContext';
import type { ChatSettings, SpoilerMode } from '../../utils/settingsStorage';

export interface ChatTabProps {}

export const ChatTab: React.FC<ChatTabProps> = () => {
  const { chatSettings: chatPageSettings, updateChatSettings: onChatPageSettingsChange } = useSettings();
  const { t } = useTranslation();

  const cs = chatPageSettings ?? { displayImagesLinks: true, displayImagesUploaded: true, imageDescriptions: false, showEmbeds: true, showEmojiReactions: true, convertEmoticons: true, dmSearchAll: false, spoilerMode: 'on-click' as const, previewTextBox: true };
  const setCS = (patch: Partial<ChatSettings>) => onChatPageSettingsChange?.(patch);

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>{t('settings.messages')}</h2>
      <p className="text-xs mb-8" style={{ color: 'var(--text-secondary)' }}>{t('settings.controlHowMessages')}</p>

      <SectionCard title={t('settings.mediaRendering')}>
        <div id="setting-display-images-links"><ToggleRow label={t('settings.whenPostedAsLinks')} checked={cs.displayImagesLinks} onChange={v => setCS({ displayImagesLinks: v })} /></div>
        <div id="setting-display-images-uploaded"><ToggleRow label={t('settings.whenUploadedDirectly')} checked={cs.displayImagesUploaded} onChange={v => setCS({ displayImagesUploaded: v })} /></div>
        <div id="setting-image-descriptions"><ToggleRow label={t('settings.withImageDescriptions')} checked={cs.imageDescriptions} onChange={v => setCS({ imageDescriptions: v })} /></div>
      </SectionCard>

      <SectionCard title={t('settings.chat.embedsTitle')}>
        <div id="setting-show-embeds"><ToggleRow label={t('settings.showEmbeds')} checked={cs.showEmbeds} onChange={v => setCS({ showEmbeds: v })} /></div>
      </SectionCard>

      <SectionCard title={t('settings.chat.emojiTitle')}>
        <div id="setting-show-emoji-reactions"><ToggleRow label={t('settings.showEmojiReactions')} checked={cs.showEmojiReactions} onChange={v => setCS({ showEmojiReactions: v })} /></div>
        <div id="setting-auto-convert-emoticons"><ToggleRow label={t('settings.autoConvertEmoticons')} checked={cs.convertEmoticons} onChange={v => setCS({ convertEmoticons: v })} /></div>
      </SectionCard>

      <div id="setting-dm-search-scope">
      <SectionCard title={t('settings.chat.defaultDmSearchTitle')}>
        <RadioOption label={t('settings.searchOnlySelectedDM')} value="false" selected={!cs.dmSearchAll} onChange={() => setCS({ dmSearchAll: false })} />
        <RadioOption label={t('settings.searchAcrossAllDMs')} value="true" selected={cs.dmSearchAll} onChange={() => setCS({ dmSearchAll: true })} />
      </SectionCard>
      </div>

      <div id="setting-spoiler-mode">
      <SectionCard title={t('settings.chat.showSpoilerTitle')}>
        <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>{t('settings.showSpoilerContent')}</p>
        <RadioOption label={t('settings.onClick')} value="on-click" selected={cs.spoilerMode === 'on-click'} onChange={v => setCS({ spoilerMode: v as SpoilerMode })} />
        <RadioOption label={t('settings.onServersIModerate')} value="on-servers-i-moderate" selected={cs.spoilerMode === 'on-servers-i-moderate'} onChange={v => setCS({ spoilerMode: v as SpoilerMode })} />
        <RadioOption label={t('common.always')} value="always" selected={cs.spoilerMode === 'always'} onChange={v => setCS({ spoilerMode: v as SpoilerMode })} />
      </SectionCard>
      </div>

      <SectionCard title={t('settings.chat.textBoxTitle')}>
        <div id="setting-preview-markdown"><ToggleRow label={t('settings.chat.previewMarkdown')} checked={cs.previewTextBox} onChange={v => setCS({ previewTextBox: v })} /></div>
      </SectionCard>
    </div>
  );
};

export default ChatTab;
