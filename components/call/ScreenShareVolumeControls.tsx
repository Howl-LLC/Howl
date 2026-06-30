// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Volume2, VolumeX } from 'lucide-react';
import { useVoiceStore } from '../../stores/voiceStore';
import VolumePopup from '../VolumePopup';

interface Props {
  userId: string;
  username: string;
  hasAudio: boolean;
}

/** Inline volume mute button + volume bar + popup for a remote screen share.
 * Designed to sit in the screen-share card's footer row (not overlaid on the
 * video), next to the Stop button. Popup opens upward from the footer. */
export const ScreenShareVolumeControls: React.FC<Props> = React.memo(({ userId, username, hasAudio }) => {
  const { t } = useTranslation();
  const screenShareVolumes = useVoiceStore(s => s.screenShareVolumes);
  const setScreenShareVolumes = useVoiceStore(s => s.setScreenShareVolumes);
  const currentVolume = screenShareVolumes[userId] ?? 0.5;
  const [volumeOpen, setVolumeOpen] = useState(false);
  const lastNonZeroRef = useRef<number>(currentVolume > 0 ? currentVolume : 0.5);
  useEffect(() => { if (currentVolume > 0) lastNonZeroRef.current = currentVolume; }, [currentVolume]);

  const handleVolumeChange = useCallback((uid: string, vol: number) => {
    const v = Math.max(0, Math.min(2, vol));
    const prev = useVoiceStore.getState().screenShareVolumes;
    if (prev[uid] !== v) setScreenShareVolumes({ ...prev, [uid]: v });
  }, [setScreenShareVolumes]);

  const isMuted = currentVolume === 0;
  const toggleMute = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const restore = isMuted ? (lastNonZeroRef.current || 0.5) : 0;
    handleVolumeChange(userId, restore);
  }, [isMuted, handleVolumeChange, userId]);

  if (!hasAudio) return null;

  return (
    <div className="relative flex items-center gap-1 shrink-0">
      <button
        type="button"
        onClick={toggleMute}
        className="p-1.5 rounded-full hover:bg-[var(--fill-hover)] transition-colors"
        title={isMuted ? t('volume.unmuteScreenShare', 'Unmute screen share audio') : t('volume.muteScreenShare', 'Mute screen share audio')}
        aria-pressed={isMuted}
      >
        {isMuted
          ? <VolumeX size={13} className="text-red-400" />
          : <Volume2 size={13} className="text-[var(--text-secondary)]" />}
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setVolumeOpen(v => !v); }}
        className="flex items-center gap-1.5 px-2 py-1 rounded-full hover:bg-[var(--fill-hover)] transition-colors"
        title={t('volume.adjustScreenShareAudio', 'Adjust screen share audio volume')}
      >
        <div className="relative w-12 h-1 rounded-full bg-white/15 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${Math.min(100, currentVolume * 100)}%`, background: 'var(--success)' }}
          />
        </div>
        <span className="text-[10px] font-bold tabular-nums text-[var(--text-secondary)]">{Math.round(currentVolume * 100)}%</span>
      </button>
      {volumeOpen && (
        <div className="absolute bottom-full right-0 mb-2 z-50">
          <VolumePopup
            userId={userId}
            username={username}
            volume={currentVolume}
            onChange={handleVolumeChange}
            onClose={() => setVolumeOpen(false)}
            accentColor="var(--success)"
          />
        </div>
      )}
    </div>
  );
});
