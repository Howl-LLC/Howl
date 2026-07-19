// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../../contexts/SettingsContext';
import { MENTION_HIGHLIGHT_PRESETS } from '../../utils/uiDensityStorage';
import { LetterAvatar } from '../LetterAvatar';

/**
 * Single live preview that reflects every appearance setting in real time:
 * theme variables, UI density, chat font size, message-group spacing, mention
 * highlight color, and the server-layout setting (Default vs Classic) — the
 * mini channel column re-renders to match whichever layout is active in the
 * dedicated Server Layout card below.
 */
export const AppearancePreview = React.memo(function AppearancePreview() {
  const { t } = useTranslation();
  const {
    chatFontSize, messageGroupSpacing, chatMessageDisplay,
    mentionHighlightColor, serverLayout,
  } = useSettings();
  const preset = MENTION_HIGHLIGHT_PRESETS[mentionHighlightColor] ?? MENTION_HIGHLIGHT_PRESETS.cyan;
  const rgb = preset.rgb;
  const isClassic = serverLayout === 'classic';
  const isCompactDisplay = chatMessageDisplay === 'compact';

  return (
    <div
      className="rounded-xl border overflow-hidden border-default"
      style={{ backgroundColor: 'var(--bg-chat)' }}
    >
      <div className="grid grid-cols-[160px_1fr] min-h-[260px]">
        {/* Mini channel-column — reflects Default vs Classic */}
        <div className="border-r border-default p-2 overflow-hidden flex flex-col gap-2 bg-app/40">
          <div className="rounded-lg border border-default overflow-hidden">
            <div className="h-10 relative" style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--cyan-accent) 30%, #0c1729) 0%, #0c1729 70%)' }}>
              <span className="absolute left-2 bottom-1 text-[10px] font-bold text-white drop-shadow">Howl Beta</span>
            </div>
            <div className="px-2 py-1 text-[10px] border-t border-default text-t-primary">
              <span className="text-t-secondary mr-1">#</span>general
            </div>
          </div>
          <div className="flex-1 min-h-0 rounded-lg border border-default bg-panel/60 p-1.5 overflow-hidden">
            {isClassic ? (
              <div className="flex flex-col gap-0.5">
                <div className="text-[8px] font-bold uppercase tracking-wider text-t-secondary mt-1 px-1">▾ TEXT</div>
                <div className="px-2 py-0.5 rounded-lg text-[10px] bg-[var(--cyan-accent)]/10 text-[var(--cyan-accent)]"># general</div>
                <div className="px-2 py-0.5 rounded-lg text-[10px] text-t-secondary"># off-topic</div>
                <div className="text-[8px] font-bold uppercase tracking-wider text-t-secondary mt-2 px-1">▾ VOICE</div>
                <div className="px-2 py-0.5 rounded-lg text-[10px] text-t-secondary">🔊 Lounge</div>
                <div className="pl-5 flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-full bg-gradient-to-br from-blue-900 to-slate-900 shrink-0" />
                  <span className="text-[9px] text-t-secondary">Alice</span>
                </div>
                <div className="pl-5 flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-full bg-gradient-to-br from-blue-900 to-slate-900 shrink-0" />
                  <span className="text-[9px] text-t-secondary">Bob</span>
                </div>
                <div className="px-2 py-0.5 rounded-lg text-[10px] text-t-secondary">🔊 Rainforest</div>
              </div>
            ) : (
              <div>
                <div className="flex gap-0.5 p-0.5 rounded-lg bg-white/[0.04] mb-1.5">
                  <div className="flex-1 text-center text-[8px] font-bold py-0.5 rounded-lg bg-[var(--cyan-accent)]/15 text-[var(--cyan-accent)]">Activity</div>
                  <div className="flex-1 text-center text-[8px] font-bold py-0.5 rounded-lg text-t-secondary">Voice</div>
                </div>
                <div className="flex items-center gap-1.5 px-1 py-0.5">
                  <span className="w-3 h-3 rounded-full bg-gradient-to-br from-blue-900 to-slate-900 shrink-0" />
                  <span className="text-[9px] text-t-primary truncate">Alice · Working</span>
                </div>
                <div className="flex items-center gap-1.5 px-1 py-0.5">
                  <span className="w-3 h-3 rounded-full bg-gradient-to-br from-blue-900 to-slate-900 shrink-0" />
                  <span className="text-[9px] text-t-primary truncate">Bob · Reading</span>
                </div>
                <div className="my-1.5 h-px bg-white/[0.05]" />
                <div className="px-1 py-0.5 text-[10px] text-t-secondary">🔊 Lounge · 2</div>
                <div className="px-1 py-0.5 text-[10px] text-t-secondary">🔊 Rainforest</div>
              </div>
            )}
          </div>
        </div>

        {/* Chat preview */}
        <div className="p-3 overflow-hidden min-w-0 flex flex-col" style={{ gap: `${messageGroupSpacing}px` }}>
          <PreviewMsg
            name="Alice"
            time="2:26 PM"
            avatarTone="violet"
            text={t('settings.appearance.mentionPreviewNormal')}
            fontSize={chatFontSize}
            compact={isCompactDisplay}
          />
          <PreviewMsg
            name="Bob"
            time="2:30 PM"
            avatarTone="emerald"
            mentionRgb={rgb}
            mentionHex={preset.hex}
            text={
              <>
                {t('settings.appearance.mentionPreviewHey')}{' '}
                <span
                  className="px-1 rounded-lg font-medium"
                  style={{ backgroundColor: `rgba(${rgb}, 0.2)`, color: preset.hex }}
                >
                  @you
                </span>{' '}
                {t('settings.appearance.mentionPreviewCheck')}
              </>
            }
            fontSize={chatFontSize}
            compact={isCompactDisplay}
          />
          <PreviewMsg
            name="Super"
            time="2:31 PM"
            avatarTone="cyan"
            text={t('settings.appearance.mentionPreviewNormal')}
            fontSize={chatFontSize}
            compact={isCompactDisplay}
          />
        </div>
      </div>
    </div>
  );
});

interface PreviewMsgProps {
  name: string;
  time: string;
  text: React.ReactNode;
  fontSize: number;
  compact: boolean;
  mentionRgb?: string;
  mentionHex?: string;
  avatarTone?: 'violet' | 'emerald' | 'cyan';
}

function PreviewMsg({ name, time, text, fontSize, compact, mentionRgb, avatarTone = 'cyan' }: PreviewMsgProps) {
  const nameColor = avatarTone === 'violet' ? '#a78bfa' : avatarTone === 'emerald' ? '#4ade80' : 'var(--cyan-accent)';
  const isMention = !!mentionRgb;
  if (compact) {
    return (
      <div
        className="rounded-lg px-2 py-0.5 relative"
        style={isMention ? {
          backgroundColor: `rgba(${mentionRgb}, 0.045)`,
          borderLeft: `2px solid rgba(${mentionRgb}, 0.6)`,
        } : undefined}
      >
        <div className="flex items-baseline gap-1.5 flex-wrap min-w-0">
          <span className="text-sm font-semibold shrink-0" style={{ color: nameColor }}>{name}</span>
          <span className="text-xs shrink-0 text-t-secondary">{time}</span>
          <span className="min-w-0 break-words text-t-primary" style={{ fontSize }}>{text}</span>
        </div>
      </div>
    );
  }
  return (
    <div
      className="rounded-2xl px-3 py-2 relative"
      style={isMention ? {
        backgroundColor: `rgba(${mentionRgb}, 0.045)`,
      } : undefined}
    >
      {isMention && (
        <span
          aria-hidden
          className="absolute left-0 top-0 bottom-0 w-0.5 rounded-l"
          style={{
            background: `rgba(${mentionRgb}, 0.6)`,
            boxShadow: `0 0 8px rgba(${mentionRgb}, 0.25), 2px 0 12px rgba(${mentionRgb}, 0.1)`,
          }}
        />
      )}
      <div className="flex items-start gap-3 min-w-0">
        <LetterAvatar avatar={null} username={name} size={32} className="rounded-full shrink-0" />
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold" style={{ color: nameColor }}>{name}</span>
            <span className="text-xs text-t-secondary">{time}</span>
          </div>
          <p className="leading-relaxed mt-1 text-t-primary break-words" style={{ fontSize }}>
            {text}
          </p>
        </div>
      </div>
    </div>
  );
}
