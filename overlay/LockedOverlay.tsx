// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type {
  OverlayServer, OverlayChannel, OverlayMessage,
  OverlayUnreads, OverlayVoiceState,
} from './types';

/* ── Inline SVGs ────────────────────────────────────────────────── */

function ChatBubbleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path
        d="M4 4h12a1 1 0 011 1v8a1 1 0 01-1 1h-3l-3 3-3-3H4a1 1 0 01-1-1V5a1 1 0 011-1z"
        stroke="var(--ov-t1)" strokeWidth="1.4" strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2.5 3.5L5 6.5L7.5 3.5" stroke="var(--ov-t2)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function HashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M2.5 4.5h7M2.5 7.5h7M4.5 2l-1 8M7.5 2l-1 8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M2 4.5h1.5L6 2.5v7L3.5 7.5H2a.5.5 0 01-.5-.5V5a.5.5 0 01.5-.5z" fill="currentColor" />
      <path d="M8 3.5c.8.7 1.2 1.5 1.2 2.5S8.8 7.8 8 8.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

/* ── Helpers ─────────────────────────────────────────────────────── */

function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function avatarColor(name: string): string {
  const colors = [
    'var(--warning)', 'var(--danger)', '#8b5cf6', 'var(--cyan-accent)',
    'var(--success)', '#ec4899', '#3b82f6', '#f97316',
  ];
  return colors[hashString(name) % colors.length];
}

function formatKeybind(raw: string): string {
  return raw
    .split('+')
    .map(p => {
      const u = p.toUpperCase();
      if (u === 'SHIFT') return 'Shift';
      if (u === 'CTRL' || u === 'CONTROL') return 'Ctrl';
      if (u === 'ALT') return 'Alt';
      if (u === 'BACKQUOTE' || u === 'TILDE') return '`';
      if (u === 'ESCAPE') return 'Esc';
      if (u === 'SPACE') return 'Space';
      if (u === 'TAB') return 'Tab';
      if (u === 'ENTER') return 'Enter';
      // Single letter / digit — capitalize first letter
      if (p.length === 1) return p.toUpperCase();
      return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
    })
    .join(' + ');
}

/* ── Props ───────────────────────────────────────────────────────── */

interface LockedOverlayProps {
  servers: OverlayServer[];
  channels: OverlayChannel[];
  messages: OverlayMessage[];
  unreads: OverlayUnreads | null;
  voiceState: OverlayVoiceState | null;
  activeServerId: string | null;
  activeChannelId: string | null;
  lockKeybind: string;
  onSwitchServer: (serverId: string) => void;
  onSwitchChannel: (channelId: string) => void;
  onSendMessage: (channelId: string, content: string) => void;
}

/* ── Component ───────────────────────────────────────────────────── */

export function LockedOverlay({
  servers,
  channels,
  messages,
  unreads,
  voiceState,
  activeServerId,
  activeChannelId,
  lockKeybind,
  onSwitchServer,
  onSwitchChannel,
  onSendMessage,
}: LockedOverlayProps) {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [messageInput, setMessageInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages]);

  const activeChannel = channels.find(c => c.id === activeChannelId) ?? null;
  const channelDisplayName = activeChannel?.name ?? 'general';

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && messageInput.trim() && activeChannelId) {
      e.preventDefault();
      onSendMessage(activeChannelId, messageInput.trim());
      setMessageInput('');
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    }
  }, [messageInput, activeChannelId, onSendMessage]);

  const handleChannelSelect = useCallback((channelId: string) => {
    onSwitchChannel(channelId);
    setIsDropdownOpen(false);
  }, [onSwitchChannel]);

  // Group channels by category for dropdown (memoized to avoid recomputing on every render)
  const channelsByCategory = useMemo(() => {
    const grouped: Record<string, OverlayChannel[]> = {};
    for (const ch of channels) {
      const cat = ch.category || '';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(ch);
    }
    return grouped;
  }, [channels]);

  return (
    <div
      className="ov-locked-enter"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2,6,23,0.55)',
        // No backdrop-filter here — the overlay window is transparent and OS-composited,
        // so blur can only affect content within this BrowserWindow (negligible).
        // Removing it saves a full-screen GPU compositor pass per frame.
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      {/* Inner panel */}
      <div style={{
        width: '90%',
        maxWidth: 720,
        maxHeight: '80vh',
        background: 'var(--ov-glass)',
        border: '1px solid var(--ov-glass-border)',
        borderRadius: 16,
        display: 'flex',
        overflow: 'hidden',
        position: 'relative',
      }}>
        {/* ── Left: Server icon rail ─────────────────────────────── */}
        <div
          className="ov-scroll"
          style={{
            width: 52,
            minWidth: 52,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            padding: 8,
            gap: 6,
            overflowY: 'auto',
            overflowX: 'hidden',
            borderRight: '1px solid var(--ov-glass-border)',
          }}
        >
          {/* DM button */}
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              background: 'var(--ov-glass)',
              border: '1px solid var(--ov-glass-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              position: 'relative',
              flexShrink: 0,
            }}
          >
            <ChatBubbleIcon />
            {unreads && unreads.dmUnreadCount > 0 && (
              <div style={{
                position: 'absolute',
                top: 0,
                right: 0,
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: 'var(--ov-cyan)',
              }} />
            )}
          </div>

          {/* Separator */}
          <div style={{
            width: 24,
            height: 1,
            background: 'var(--ov-glass-border)',
            flexShrink: 0,
          }} />

          {/* Server icons */}
          {servers.length === 0 && (
            <div style={{ fontSize: 9, color: 'var(--ov-t3)', textAlign: 'center', padding: '4px 0' }}>
              No servers
            </div>
          )}
          {servers.map(server => {
            const isActive = server.id === activeServerId;
            const hasUnread = unreads?.serverUnreadIds.includes(server.id) ?? false;
            const mentionCount = unreads?.serverMentionCounts[server.id] ?? 0;

            return (
              <div
                key={server.id}
                onClick={() => onSwitchServer(server.id)}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: server.color,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  position: 'relative',
                  flexShrink: 0,
                  border: isActive ? '2px solid var(--ov-cyan)' : '2px solid transparent',
                  overflow: 'visible',
                }}
              >
                {server.icon ? (
                  <img
                    src={server.icon}
                    alt={server.name}
                    style={{ width: '100%', height: '100%', borderRadius: 6, objectFit: 'cover' }}
                  />
                ) : (
                  <span style={{ fontSize: 14, fontWeight: 600, color: '#fff', userSelect: 'none' }}>
                    {server.initial}
                  </span>
                )}

                {/* Mention badge (takes priority over unread dot) */}
                {mentionCount > 0 ? (
                  <div style={{
                    position: 'absolute',
                    top: -4,
                    right: -4,
                    minWidth: 16,
                    height: 16,
                    borderRadius: 8,
                    background: 'var(--ov-danger)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 9,
                    fontWeight: 700,
                    color: '#fff',
                    padding: '0 4px',
                  }}>
                    {mentionCount > 99 ? '99+' : mentionCount}
                  </div>
                ) : hasUnread ? (
                  <div style={{
                    position: 'absolute',
                    top: -1,
                    right: -1,
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'var(--ov-cyan)',
                  }} />
                ) : null}
              </div>
            );
          })}
        </div>

        {/* ── Right: Main area ───────────────────────────────────── */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          position: 'relative',
        }}>
          {/* Top bar */}
          <div style={{
            height: 40,
            minHeight: 40,
            background: 'var(--bg-chat)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 12px',
            position: 'relative',
          }}>
            {/* Channel selector pill */}
            <div
              onClick={() => setIsDropdownOpen(prev => !prev)}
              style={{
                background: 'var(--fill-hover)',
                borderRadius: 6,
                padding: '4px 10px',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--ov-t1)', fontWeight: 500 }}>
                # {channelDisplayName}
              </span>
              <ChevronDownIcon />
            </div>

            {/* Right side: server name + voice indicator */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {voiceState?.channelId && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  background: 'var(--fill-hover)',
                  borderRadius: 6,
                  padding: '2px 8px',
                }}>
                  <div style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: 'var(--ov-cyan)',
                  }} />
                  <span style={{ fontSize: 10, color: 'var(--ov-t2)' }}>
                    {voiceState.participants.length}
                  </span>
                </div>
              )}
              <span style={{ fontSize: 10, color: 'var(--ov-t3)' }}>
                {servers.find(s => s.id === activeServerId)?.name ?? ''}
              </span>
            </div>
          </div>

          {/* Channel dropdown */}
          {isDropdownOpen && (
            <>
              {/* Backdrop to catch clicks outside */}
              <div
                onClick={() => setIsDropdownOpen(false)}
                style={{
                  position: 'fixed',
                  inset: 0,
                  zIndex: 9,
                  background: 'transparent',
                }}
              />
              <div
                className="ov-scroll"
                style={{
                  position: 'absolute',
                  top: 40,
                  left: 12,
                  width: 220,
                  maxHeight: 300,
                  overflowY: 'auto',
                  background: 'var(--ov-glass)',
                  border: '1px solid var(--ov-glass-border)',
                  borderRadius: 12,
                  padding: '6px 0',
                  zIndex: 10,
                }}
              >
                {channels.length === 0 && (
                  <div style={{
                    padding: '12px 14px',
                    fontSize: 11,
                    color: 'var(--ov-t3)',
                    textAlign: 'center',
                  }}>
                    No channels
                  </div>
                )}
                {Object.entries(channelsByCategory).map(([category, chs]) => (
                  <div key={category}>
                    {category && (
                      <div style={{
                        padding: '8px 14px 4px',
                        fontSize: 9,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        color: 'var(--ov-t3)',
                      }}>
                        {category}
                      </div>
                    )}
                    {chs.map(ch => {
                      const isUnread = unreads?.channelUnreadIds.includes(ch.id) ?? ch.unread;
                      const isCurrentChannel = ch.id === activeChannelId;
                      return (
                        <div
                          key={ch.id}
                          onClick={() => handleChannelSelect(ch.id)}
                          style={{
                            padding: '5px 14px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            cursor: 'pointer',
                            background: isCurrentChannel ? 'var(--fill-hover)' : 'transparent',
                            fontSize: 12,
                            color: isUnread ? 'var(--ov-t1)' : 'var(--ov-t2)',
                            fontWeight: isUnread ? 600 : 400,
                          }}
                          onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--fill-hover)'; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = isCurrentChannel ? 'var(--fill-hover)' : 'transparent'; }}
                        >
                          {/* Channel type icon */}
                          <span style={{ display: 'flex', alignItems: 'center', color: 'var(--ov-t3)' }}>
                            {ch.type === 'voice' || ch.type === 'stage' ? <SpeakerIcon /> : <HashIcon />}
                          </span>
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {ch.name}
                          </span>
                          {(ch.type === 'voice' || ch.type === 'stage') && ch.voiceParticipantCount != null && ch.voiceParticipantCount > 0 && (
                            <span style={{ fontSize: 10, color: 'var(--ov-t3)' }}>
                              {ch.voiceParticipantCount}
                            </span>
                          )}
                          {isUnread && (
                            <div style={{
                              width: 6,
                              height: 6,
                              borderRadius: '50%',
                              background: 'var(--ov-cyan)',
                              flexShrink: 0,
                            }} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Chat panel */}
          <div
            className="ov-scroll"
            style={{
              flex: 1,
              overflowY: 'auto',
              overflowX: 'hidden',
              padding: '4px 0',
            }}
          >
            {messages.length === 0 ? (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                minHeight: 120,
                fontSize: 11,
                color: 'var(--ov-t3)',
              }}>
                No messages yet
              </div>
            ) : (
              messages.map(msg => (
                <div
                  key={msg.id}
                  style={{
                    display: 'flex',
                    gap: 8,
                    padding: '6px 12px',
                    alignItems: 'flex-start',
                  }}
                >
                  {/* Avatar */}
                  <div style={{
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    flexShrink: 0,
                    overflow: 'hidden',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: msg.authorAvatar ? 'transparent' : avatarColor(msg.authorName),
                  }}>
                    {msg.authorAvatar ? (
                      <img
                        src={msg.authorAvatar}
                        alt=""
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    ) : (
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#fff', userSelect: 'none' }}>
                        {(msg.authorName[0] ?? '?').toUpperCase()}
                      </span>
                    )}
                  </div>

                  {/* Text column */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <span style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: msg.authorColor || 'var(--ov-t1)',
                      }}>
                        {msg.authorName}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--ov-t3)' }}>
                        {msg.timestamp}
                      </span>
                    </div>
                    <div style={{
                      fontSize: 12,
                      color: 'var(--ov-t2)',
                      wordBreak: 'break-word',
                      lineHeight: 1.4,
                      marginTop: 1,
                    }}>
                      {msg.content}
                    </div>
                  </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Message input */}
          <div style={{
            background: 'var(--fill-hover)',
            borderTop: '1px solid var(--ov-glass-border)',
          }}>
            <input
              type="text"
              value={messageInput}
              onChange={e => setMessageInput(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder={activeChannel ? `Message #${activeChannel.name}...` : 'Message...'}
              style={{
                width: '100%',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'var(--ov-t1)',
                fontSize: 13,
                padding: '10px 14px',
                fontFamily: 'inherit',
              }}
            />
          </div>
        </div>

        {/* Keybind hint */}
        <div style={{
          position: 'absolute',
          bottom: 4,
          right: 10,
          fontSize: 9,
          color: 'var(--ov-t3)',
          padding: '4px 0',
          pointerEvents: 'none',
          userSelect: 'none',
        }}>
          {formatKeybind(lockKeybind)} to unlock
        </div>
      </div>
    </div>
  );
}
