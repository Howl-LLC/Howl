// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState } from 'react';
import type { OverlayNotification } from './types';

// Inline SVG Icons

function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <line x1="3" y1="3" x2="11" y2="11" />
      <line x1="11" y1="3" x2="3" y2="11" />
    </svg>
  );
}

function ChatBubbleIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="var(--ov-cyan)"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 14l-2 3v-12a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4z" />
      <line x1="7" y1="7" x2="13" y2="7" />
      <line x1="7" y1="10" x2="11" y2="10" />
    </svg>
  );
}

function GamepadIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--ov-cyan)"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="6" width="20" height="12" rx="3" />
      <line x1="8" y1="10" x2="8" y2="14" />
      <line x1="6" y1="12" x2="10" y2="12" />
      <circle cx="16" cy="10" r="1" fill="var(--ov-cyan)" stroke="none" />
      <circle cx="18" cy="12" r="1" fill="var(--ov-cyan)" stroke="none" />
    </svg>
  );
}

function MusicNoteIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--ov-cyan)"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" fill="none" />
      <circle cx="18" cy="16" r="3" fill="none" />
    </svg>
  );
}

// Helpers

function cornerStyle(corner: string): React.CSSProperties {
  const margin = 14;
  switch (corner) {
    case 'top-left':     return { top: margin, left: margin };
    case 'top-right':    return { top: margin, right: margin };
    case 'bottom-left':  return { bottom: margin, left: margin };
    case 'bottom-right': return { bottom: margin, right: margin };
    default:             return { bottom: margin, right: margin };
  }
}

function isBottomCorner(corner: string): boolean {
  return corner === 'bottom-left' || corner === 'bottom-right';
}

// Toast Card

interface ToastCardProps {
  notification: OverlayNotification;
  clickableRegions: boolean;
  onDismiss: (id: string) => void;
  onReply: (channelId: string, content: string) => void;
}

function ToastCard({ notification, clickableRegions, onDismiss, onReply }: ToastCardProps) {
  const { id, type, serverName, serverIcon, channelName, channelId, authorName, authorAvatar, content } = notification;

  if (type === 'message') {
    return (
      <MessageToast
        id={id}
        serverName={serverName}
        serverIcon={serverIcon}
        channelName={channelName}
        channelId={channelId}
        authorName={authorName}
        authorAvatar={authorAvatar}
        content={content}
        clickableRegions={clickableRegions}
        onDismiss={onDismiss}
        onReply={onReply}
      />
    );
  }

  if (type === 'welcome') {
    return (
      <GenericToast
        id={id}
        icon={<ChatBubbleIcon />}
        title="Howl"
        subtitle={
          <span>
            {'Overlay active. Press '}
            <span style={{
              display: 'inline-block',
              padding: '1px 5px',
              fontSize: 9,
              fontWeight: 600,
              background: 'var(--fill-active)',
              borderRadius: 4,
              border: '1px solid var(--glass-border)',
              color: 'var(--ov-t1)',
            }}>
              Shift
            </span>
            {' + '}
            <span style={{
              display: 'inline-block',
              padding: '1px 5px',
              fontSize: 9,
              fontWeight: 600,
              background: 'var(--fill-active)',
              borderRadius: 4,
              border: '1px solid var(--glass-border)',
              color: 'var(--ov-t1)',
            }}>
              `
            </span>
            {' to lock'}
          </span>
        }
        clickableRegions={clickableRegions}
        onDismiss={onDismiss}
      />
    );
  }

  if (type === 'go-live') {
    const avatarEl = authorAvatar ? (
      <img
        src={authorAvatar}
        alt=""
        style={{ width: 20, height: 20, borderRadius: '50%', objectFit: 'cover' }}
      />
    ) : (
      <div style={{
        width: 20, height: 20, borderRadius: '50%',
        background: 'linear-gradient(135deg, #667eea, #764ba2)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 9, fontWeight: 600, color: '#fff',
      }}>
        {(authorName || '?').charAt(0).toUpperCase()}
      </div>
    );
    return (
      <GenericToast
        id={id}
        icon={avatarEl}
        title={authorName || 'Someone'}
        subtitle="Started streaming"
        clickableRegions={clickableRegions}
        onDismiss={onDismiss}
      />
    );
  }

  if (type === 'game-activity') {
    return (
      <GenericToast
        id={id}
        icon={<GamepadIcon />}
        title="Game Activity"
        subtitle={content || ''}
        clickableRegions={clickableRegions}
        onDismiss={onDismiss}
      />
    );
  }

  if (type === 'now-playing') {
    return (
      <GenericToast
        id={id}
        icon={<MusicNoteIcon />}
        title="Now Playing"
        subtitle={content || ''}
        clickableRegions={clickableRegions}
        onDismiss={onDismiss}
      />
    );
  }

  return null;
}

// Generic Toast (non-message types)

interface GenericToastProps {
  id: string;
  icon: React.ReactNode;
  title: string;
  subtitle: React.ReactNode;
  clickableRegions: boolean;
  onDismiss: (id: string) => void;
}

function GenericToast({ id, icon, title, subtitle, clickableRegions, onDismiss }: GenericToastProps) {
  return (
    <div
      className="ov-toast-enter"
      style={{
        background: 'var(--ov-glass)',
        backdropFilter: 'blur(16px) saturate(1.1)',
        WebkitBackdropFilter: 'blur(16px) saturate(1.1)',
        border: '1px solid var(--ov-glass-border)',
        borderRadius: 12,
        padding: '10px 12px',
        pointerEvents: 'auto',
        position: 'relative',
      }}
    >
      {/* Dismiss button */}
      <button
        onClick={() => onDismiss(id)}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          background: 'none',
          border: 'none',
          color: 'var(--ov-t3)',
          cursor: 'pointer',
          padding: 2,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          lineHeight: 1,
          pointerEvents: clickableRegions ? 'auto' : 'none',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ov-t1)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ov-t3)'; }}
      >
        <CloseIcon />
      </button>

      {/* Content row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {icon}
        </div>
        <div style={{ minWidth: 0, flex: 1, paddingRight: 16 }}>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--ov-t1)',
            lineHeight: 1.3,
          }}>
            {title}
          </div>
          <div style={{
            fontSize: 10,
            color: 'var(--ov-t2)',
            lineHeight: 1.4,
            marginTop: 2,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {subtitle}
          </div>
        </div>
      </div>
    </div>
  );
}

// Message Toast

interface MessageToastProps {
  id: string;
  serverName?: string;
  serverIcon?: string;
  channelName?: string;
  channelId?: string;
  authorName?: string;
  authorAvatar?: string;
  content?: string;
  clickableRegions: boolean;
  onDismiss: (id: string) => void;
  onReply: (channelId: string, content: string) => void;
}

function MessageToast({
  id, serverName, serverIcon, channelName, channelId,
  authorName, authorAvatar, content,
  clickableRegions, onDismiss, onReply,
}: MessageToastProps) {
  const [replyText, setReplyText] = useState('');

  const handleFocus = () => {
    window.overlayBridge?.toggleLock(true);
  };

  const handleBlur = () => {
    if (!replyText.trim()) {
      window.overlayBridge?.toggleLock(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && replyText.trim() && channelId) {
      onReply(channelId, replyText.trim());
      setReplyText('');
      window.overlayBridge?.toggleLock(false);
      (e.target as HTMLInputElement).blur();
    }
    if (e.key === 'Escape') {
      setReplyText('');
      window.overlayBridge?.toggleLock(false);
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <div
      className="ov-toast-enter"
      style={{
        background: 'var(--ov-glass)',
        backdropFilter: 'blur(16px) saturate(1.1)',
        WebkitBackdropFilter: 'blur(16px) saturate(1.1)',
        border: '1px solid var(--ov-glass-border)',
        borderRadius: 12,
        padding: '10px 12px',
        pointerEvents: 'auto',
        position: 'relative',
      }}
    >
      {/* Dismiss button */}
      <button
        onClick={() => onDismiss(id)}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          background: 'none',
          border: 'none',
          color: 'var(--ov-t3)',
          cursor: 'pointer',
          padding: 2,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          lineHeight: 1,
          pointerEvents: clickableRegions ? 'auto' : 'none',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ov-t1)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ov-t3)'; }}
      >
        <CloseIcon />
      </button>

      {/* Server + channel row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingRight: 18 }}>
        {/* Server icon */}
        {serverIcon ? (
          <img
            src={serverIcon}
            alt=""
            style={{
              width: 20, height: 20, borderRadius: 4, objectFit: 'cover', flexShrink: 0,
            }}
          />
        ) : (
          <div style={{
            width: 20, height: 20, borderRadius: 4,
            background: 'linear-gradient(135deg, #4facfe, #00f2fe)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, fontWeight: 700, color: '#fff', flexShrink: 0,
          }}>
            {(serverName || '?').charAt(0).toUpperCase()}
          </div>
        )}
        <div style={{
          fontSize: 10, lineHeight: 1.3, minWidth: 0,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          <span style={{ color: 'var(--ov-t2)' }}>{serverName || 'Server'}</span>
          {channelName && (
            <span style={{ color: 'var(--ov-t3)' }}>{' \u00B7 #'}{channelName}</span>
          )}
        </div>
      </div>

      {/* Author + content row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
        {/* Author avatar */}
        {authorAvatar ? (
          <img
            src={authorAvatar}
            alt=""
            style={{
              width: 20, height: 20, borderRadius: '50%', objectFit: 'cover', flexShrink: 0,
            }}
          />
        ) : (
          <div style={{
            width: 20, height: 20, borderRadius: '50%',
            background: 'linear-gradient(135deg, #667eea, #764ba2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 9, fontWeight: 600, color: '#fff', flexShrink: 0,
          }}>
            {(authorName || '?').charAt(0).toUpperCase()}
          </div>
        )}
        <div style={{
          minWidth: 0, flex: 1,
          fontSize: 11, lineHeight: 1.3,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          <span style={{ fontWeight: 600, color: 'var(--ov-t1)' }}>{authorName || 'User'}</span>
          {content && (
            <span style={{ color: 'var(--ov-t2)' }}>: {content}</span>
          )}
        </div>
      </div>

      {/* Reply input */}
      <input
        type="text"
        placeholder="Reply..."
        value={replyText}
        onChange={(e) => setReplyText(e.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        style={{
          width: '100%',
          height: 28,
          marginTop: 8,
          padding: '0 8px',
          fontSize: 10,
          color: 'var(--ov-t1)',
          background: 'var(--fill-hover)',
          border: '1px solid var(--ov-glass-border)',
          borderRadius: 6,
          outline: 'none',
          pointerEvents: clickableRegions ? 'auto' : 'none',
          fontFamily: 'inherit',
        }}
      />
    </div>
  );
}

// Toast Manager

interface OverlayToastManagerProps {
  notifications: OverlayNotification[];
  corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  clickableRegions: boolean;
  onDismiss: (id: string) => void;
  onReply: (channelId: string, content: string) => void;
}

export function OverlayToastManager({
  notifications,
  corner,
  clickableRegions,
  onDismiss,
  onReply,
}: OverlayToastManagerProps) {
  if (notifications.length === 0) return null;

  const visible = notifications.slice(-3);
  const bottom = isBottomCorner(corner);

  return (
    <div
      style={{
        position: 'absolute',
        ...cornerStyle(corner),
        display: 'flex',
        flexDirection: bottom ? 'column-reverse' : 'column',
        gap: 8,
        maxWidth: 340,
        width: 340,
        pointerEvents: 'none',
      }}
    >
      {visible.map((notif) => (
        <ToastCard
          key={notif.id}
          notification={notif}
          clickableRegions={clickableRegions}
          onDismiss={onDismiss}
          onReply={onReply}
        />
      ))}
    </div>
  );
}
