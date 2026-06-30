// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useCallback } from 'react';
import { X, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigationStore } from '../../stores/navigationStore';

interface MicSilenceBannerProps {
  onDismiss: () => void;
}

export const MicSilenceBanner: React.FC<MicSilenceBannerProps> = ({ onDismiss }) => {
  const { t } = useTranslation();
  const setActiveServerId = useNavigationStore(s => s.setActiveServerId);
  const setAccountDeepLink = useNavigationStore(s => s.setAccountDeepLink);

  const openVoiceSettings = useCallback(() => {
    setAccountDeepLink({ page: 'voice-video' });
    setActiveServerId('account');
  }, [setAccountDeepLink, setActiveServerId]);

  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-xl px-4 py-2.5 border border-amber-500/30 bg-amber-500/10 text-amber-200 text-sm"
    >
      <div className="flex-1 flex flex-col gap-0.5 min-w-0">
        <span className="font-medium">
          {t('voiceCall.micSilence.bannerText', "We're not picking up audio from your mic.")}
        </span>
        <span className="text-xs opacity-75">
          {t('voiceCall.micSilence.disableHint', 'You can disable these warnings in Settings → Voice & Video.')}
        </span>
      </div>
      <button
        type="button"
        onClick={openVoiceSettings}
        className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 transition-colors shrink-0"
      >
        <Settings size={14} />
        {t('voiceCall.micSilence.changeDevice', 'Change Device')}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="p-1 rounded-lg hover:bg-amber-500/20 transition-colors shrink-0"
        aria-label={t('common.dismiss', 'Dismiss')}
      >
        <X size={16} />
      </button>
    </div>
  );
};
