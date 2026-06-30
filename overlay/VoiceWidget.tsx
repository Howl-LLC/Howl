// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useMemo } from 'react';
import type {
  OverlayVoiceState,
  OverlayVoiceParticipant,
  OverlaySettings,
} from './types';

// Helpers

function cornerStyle(corner: string): React.CSSProperties {
  const margin = 14;
  switch (corner) {
    case 'top-left':     return { top: margin, left: margin };
    case 'top-right':    return { top: margin, right: margin };
    case 'bottom-left':  return { bottom: margin, left: margin };
    case 'bottom-right': return { bottom: margin, right: margin };
    default:             return { top: margin, left: margin };
  }
}

const GRADIENTS = [
  'linear-gradient(135deg, #667eea, #764ba2)',
  'linear-gradient(135deg, #f093fb, #f5576c)',
  'linear-gradient(135deg, #4facfe, #00f2fe)',
  'linear-gradient(135deg, #43e97b, #38f9d7)',
  'linear-gradient(135deg, #fa709a, #fee140)',
  'linear-gradient(135deg, #a18cd1, #fbc2eb)',
  'linear-gradient(135deg, #fccb90, #d57eeb)',
  'linear-gradient(135deg, #e0c3fc, #8ec5fc)',
];

function generateAvatarGradient(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash + userId.charCodeAt(i)) % GRADIENTS.length;
  }
  return GRADIENTS[hash];
}

const AVATAR_SIZES = { small: 20, medium: 24, large: 32 } as const;
const COMPACT_AVATAR_SIZE = 28;

// Inline SVG Icons

function MutedMicIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--ov-danger)"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.35 2.17" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function DeafenedIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--ov-danger)"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <line x1="2" y1="2" x2="22" y2="22" />
      <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

// Avatar Component

interface AvatarProps {
  participant: OverlayVoiceParticipant;
  size: number;
}

function Avatar({ participant, size }: AvatarProps) {
  const bg = participant.roleColor
    ? participant.roleColor
    : generateAvatarGradient(participant.userId);

  const borderColor = participant.isSpeaking ? 'var(--ov-cyan)' : 'transparent';
  const borderWidth = participant.isSpeaking ? 2 : 1;

  const style: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    border: `${borderWidth}px solid ${borderColor}`,
    boxShadow: participant.isSpeaking ? '0 0 6px var(--ov-glow)' : 'none',
    background: participant.avatar ? 'var(--ov-glass)' : bg,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: Math.max(9, Math.round(size * 0.4)),
    fontWeight: 600,
    color: '#fff',
    overflow: 'hidden',
    flexShrink: 0,
    position: 'relative',
  };

  return (
    <div style={style}>
      {participant.avatar ? (
        <img
          src={participant.avatar}
          alt=""
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            borderRadius: '50%',
          }}
        />
      ) : (
        <span>{participant.username.charAt(0).toUpperCase()}</span>
      )}
    </div>
  );
}

// Muted Badge (compact mode)

function MutedBadge() {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: -1,
        right: -1,
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: 'var(--ov-danger)',
        border: '1.5px solid rgba(6, 10, 22, 0.9)',
      }}
    />
  );
}

// Compact Mode

interface CompactModeProps {
  participants: OverlayVoiceParticipant[];
}

function CompactMode({ participants }: CompactModeProps) {
  if (participants.length === 0) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {participants.map((p, i) => (
        <div
          key={p.userId}
          style={{
            position: 'relative',
            marginLeft: i === 0 ? 0 : -6,
            zIndex: participants.length - i,
          }}
        >
          <Avatar participant={p} size={COMPACT_AVATAR_SIZE} />
          {p.isMuted && <MutedBadge />}
        </div>
      ))}
    </div>
  );
}

// Detailed Mode

interface DetailedModeProps {
  voiceState: OverlayVoiceState;
  participants: OverlayVoiceParticipant[];
  settings: OverlaySettings;
}

function DetailedMode({ voiceState, participants, settings }: DetailedModeProps) {
  const avatarSize = AVATAR_SIZES[settings.avatarSize];

  return (
    <div
      style={{
        background: 'var(--ov-glass)',
        border: '1px solid var(--ov-glass-border)',
        borderRadius: 8,
        backdropFilter: 'blur(16px) saturate(1.1)',
        WebkitBackdropFilter: 'blur(16px) saturate(1.1)',
        maxWidth: 200,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ padding: '8px 10px' }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--ov-t2)',
            lineHeight: 1.3,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {voiceState.channelName}
        </div>
        <div
          style={{
            fontSize: 9,
            color: 'var(--ov-t3)',
            lineHeight: 1.3,
            marginTop: 1,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {voiceState.serverName}
        </div>
      </div>

      {/* Separator */}
      {participants.length > 0 && (
        <div
          style={{
            height: 1,
            background: 'var(--ov-glass-border)',
          }}
        />
      )}

      {/* Participant List */}
      {participants.map((p) => {
        const showName =
          settings.displayNames === 'always' ||
          (settings.displayNames === 'speaking-only' && p.isSpeaking);

        return (
          <div
            key={p.userId}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
            }}
          >
            <Avatar participant={p} size={avatarSize} />
            {showName && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: p.isSpeaking ? 'var(--ov-t1)' : 'var(--ov-t2)',
                  ...(p.roleColor ? { color: p.roleColor } : {}),
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  minWidth: 0,
                  flex: 1,
                  lineHeight: 1.3,
                }}
              >
                {p.username}
              </span>
            )}
            {p.isMuted && <MutedMicIcon />}
            {p.isDeafened && <DeafenedIcon />}
          </div>
        );
      })}
    </div>
  );
}

// Main Widget

interface VoiceWidgetProps {
  voiceState: OverlayVoiceState;
  settings: OverlaySettings;
}

export function VoiceWidget({ voiceState, settings }: VoiceWidgetProps) {
  const participants = useMemo(() => {
    if (settings.maxUsersDisplayed === 0) return null;

    if (settings.showUsers === 'never') return null;

    let filtered: OverlayVoiceParticipant[] =
      settings.showUsers === 'speaking-only'
        ? voiceState.participants.filter((p) => p.isSpeaking)
        : voiceState.participants;

    filtered = filtered.slice(0, settings.maxUsersDisplayed);
    return filtered;
  }, [voiceState.participants, settings.showUsers, settings.maxUsersDisplayed]);

  // maxUsersDisplayed === 0 means don't render
  if (participants === null) return null;

  // Compact mode: nothing to show if empty after filtering
  if (settings.widgetMode === 'compact' && participants.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        pointerEvents: 'none',
        zIndex: 1000,
        ...cornerStyle(settings.widgetCorner),
      }}
    >
      {settings.widgetMode === 'compact' ? (
        <CompactMode participants={participants} />
      ) : (
        <DetailedMode
          voiceState={voiceState}
          participants={participants}
          settings={settings}
        />
      )}
    </div>
  );
}
