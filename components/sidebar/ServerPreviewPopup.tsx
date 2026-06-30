// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useRef, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Users, Zap, Headphones, Volume2 } from 'lucide-react';
import { LetterAvatar } from '../LetterAvatar';
import { getBackendOrigin } from '../../config';
import { sanitizeImgSrc } from '../../utils/sanitizeImgSrc';
import { toOriginalUploadPath, retryOnExpired } from '../../utils/signedImageRetry';
import { LazyGif } from '../LazyGif';
import { getFrameUrl } from '../../utils/getFrameUrl';
import type { Server } from '../../types';
import { powerUpTier } from '../../utils/powerUpTier';

type VoiceParticipantInfo = { userId: string; username: string; avatar?: string };

export interface ServerPreviewPopupProps {
  anchor: { top: number; left: number };
  server: Server;
  voiceData?: Record<string, VoiceParticipantInfo[]>;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export const ServerPreviewPopup: React.FC<ServerPreviewPopupProps> = ({
  anchor, server, voiceData, onMouseEnter, onMouseLeave,
}) => {
  const popupRef = useRef<HTMLDivElement>(null);
  const [clampedTop, setClampedTop] = useState(anchor.top);

  const resolveUrl = (url?: string | null) => {
    if (!url) return undefined;
    return url.startsWith('/') ? getBackendOrigin() + url : url;
  };

  const bannerSrc = server.banner ? sanitizeImgSrc(resolveUrl(server.banner)) : null;
  const iconSrc = server.icon ? sanitizeImgSrc(resolveUrl(server.icon)) : null;
  const tier = powerUpTier(server.powerUpCount ?? 0);
  const memberCount = Math.max(server.memberCount ?? 1, 1);

  const voiceEntries = voiceData ? Object.entries(voiceData).filter(([, p]) => p.length > 0) : [];
  const hasVoice = voiceEntries.length > 0;
  const channelMap = new Map(server.channels.map(c => [c.id, c.name]));

  // Clamp to viewport after first paint
  useLayoutEffect(() => {
    if (!popupRef.current) return;
    const h = popupRef.current.offsetHeight;
    const maxTop = window.innerHeight - h - 8;
    setClampedTop(Math.max(8, Math.min(anchor.top, maxTop)));
  }, [anchor.top]);

  return createPortal(
    <div
      ref={popupRef}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="fixed z-[var(--z-max)] overflow-hidden animate-in slide-in-from-left-2 fade-in duration-150 glass"
      style={{
        top: clampedTop,
        left: anchor.left,
        width: 252,
        maxHeight: 400,
        borderRadius: 12,
      }}
    >
      {/* Banner */}
      <div className="relative" style={{ height: 68 }}>
        {bannerSrc ? (
          <img
            src={bannerSrc}
            alt=""
            className="w-full h-full object-cover"
            draggable={false}
            data-original-src={toOriginalUploadPath(bannerSrc)}
            onError={retryOnExpired}
          />
        ) : (
          <div
            className="w-full h-full"
            style={{ background: 'linear-gradient(135deg, var(--accent-subtle) 0%, rgba(15,23,42,0.9) 100%)' }}
          />
        )}
        {/* Bottom fade */}
        <div
          className="absolute inset-x-0 bottom-0"
          style={{ height: 28, background: 'linear-gradient(to top, rgba(15,23,42,0.85), transparent)' }}
        />
      </div>

      {/* Icon + Name */}
      <div className="flex items-center gap-2.5 px-3 -mt-4 relative">
        <div
          className="rounded-xl overflow-hidden shrink-0"
          style={{
            width: 40,
            height: 40,
            border: '3px solid rgba(15, 23, 42, 0.85)',
          }}
        >
          {iconSrc ? (
            <LazyGif src={iconSrc} frameSrc={getFrameUrl(iconSrc)} alt="" className="w-full h-full object-cover" draggable={false} />
          ) : (
            <LetterAvatar avatar={null} username={server.name} size={34} className="rounded-lg" />
          )}
        </div>
        <span
          className="text-sm font-semibold truncate"
          style={{ color: 'var(--text-primary)', maxWidth: 170 }}
        >
          {server.name}
        </span>
      </div>

      {/* Description */}
      {server.description && (
        <p
          className="px-3 mt-1.5 text-[11px] leading-[1.4] line-clamp-2"
          style={{ color: 'var(--text-tertiary)' }}
        >
          {server.description}
        </p>
      )}

      {/* Stats */}
      <div className="flex items-center gap-3 px-3 mt-2 mb-2">
        <div className="flex items-center gap-1">
          <Users size={12} style={{ color: 'var(--text-tertiary)' }} />
          <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            {memberCount.toLocaleString()}
          </span>
        </div>
        {tier > 0 && (
          <div className="flex items-center gap-1">
            <Zap size={12} style={{ color: '#a78bfa' }} />
            <span className="text-[11px] font-medium" style={{ color: '#a78bfa' }}>
              Level {tier}
            </span>
          </div>
        )}
      </div>

      {/* Voice section */}
      {hasVoice && (
        <>
          <div style={{ height: 1, backgroundColor: 'var(--border-subtle)' }} />
          <div className="py-2 overflow-y-auto" style={{ maxHeight: 200 }}>
            <div className="px-3 pb-1 flex items-center gap-1.5" style={{ opacity: 0.5 }}>
              <Headphones size={11} strokeWidth={2.5} style={{ color: 'var(--cyan-accent, #076FA0)' }} />
              <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                In voice
              </span>
            </div>
            {voiceEntries.map(([channelId, participants]) => (
              <div key={channelId} className="px-3 py-1">
                <div className="flex items-center gap-1.5 mb-1">
                  <Volume2 size={11} strokeWidth={2.5} style={{ color: 'var(--cyan-accent, #076FA0)', opacity: 0.7 }} />
                  <span className="text-[11px] font-semibold truncate" style={{ color: 'var(--text-primary)', opacity: 0.85 }}>
                    {channelMap.get(channelId) || 'Voice'}
                  </span>
                  <span className="text-[10px] ml-auto shrink-0 tabular-nums" style={{ color: 'var(--text-secondary)', opacity: 0.6 }}>
                    {participants.length}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5 pl-1">
                  {participants.map(p => (
                    <div key={p.userId} className="flex items-center gap-1.5 py-0.5 rounded-md px-1 hover:bg-fill-hover">
                      <div className="w-4 h-4 rounded-[var(--radius-lg)] overflow-hidden shrink-0">
                        <LetterAvatar avatar={resolveUrl(p.avatar)} username={p.username} size={16} className="rounded-full" />
                      </div>
                      <span className="text-[11px] truncate" style={{ color: 'var(--text-primary)', opacity: 0.9 }}>
                        {p.username}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
};
