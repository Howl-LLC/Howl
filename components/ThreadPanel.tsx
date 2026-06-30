// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useTranslation } from 'react-i18next';
import { X, Settings, Archive, ChevronDown } from 'lucide-react';
import type { Thread, ThreadMessage, User } from '../types';
import { MessageInput } from './MessageInput';
import { MentionText } from './MentionText';
import { LetterAvatar } from './LetterAvatar';
import { useIsMobile } from '../hooks/useIsMobile';
import { useKeyboardAware } from '../hooks/useKeyboardAware';
import { LazyGif } from './LazyGif';
import { getFrameUrl } from '../utils/getFrameUrl';
import { useThreadPollStore } from '../stores/threadPollStore';
import { useAuthStore } from '../stores/authStore';
import { MessageAttachment } from './ChatArea';
import { apiClient } from '../services/api';

const EMPTY_THREAD_MESSAGES: import('../types').ThreadMessage[] = [];

export interface ThreadPanelProps {
  serverId: string;
  channelId: string;
  users: User[];
  parentMessage?: { content: string; authorUsername: string; authorAvatar?: string | null } | null;
  onClose: () => void;
  onSendMessage: (content: string, replyToMessageId?: string, attachment?: { url: string; name: string; contentType?: string; width?: number | null; height?: number | null }) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  onArchive?: () => void;
  onDelete?: () => void;
  isCreator: boolean;
  canManage: boolean;
  uploadFile?: (file: File) => Promise<{ url: string; name: string; contentType: string; size: number; width?: number | null; height?: number | null }>;
  maxAttachmentMB: number;
  userPlan?: string | null;
}

export const ThreadPanel: React.FC<ThreadPanelProps> = ({
  serverId: _serverId, channelId: _channelId, users,
  parentMessage, onClose, onSendMessage, onLoadMore, hasMore = false,
  onArchive, onDelete, isCreator, canManage, uploadFile, maxAttachmentMB, userPlan,
}) => {
  const thread = useThreadPollStore(s => s.activeThread) as Thread;
  const allThreadMessages = useThreadPollStore(s => s.threadMessages);
  const messages = thread ? (allThreadMessages[thread.id] ?? EMPTY_THREAD_MESSAGES) : EMPTY_THREAD_MESSAGES;
  const _currentUserId = useAuthStore(s => s.currentUser)?.id ?? '';
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { keyboardOpen, viewportHeight } = useKeyboardAware(isMobile);
  // Derive keyboard height from the shrunk visual viewport. No-op on desktop.
  const keyboardHeight = useMemo(() => {
    if (!isMobile || !keyboardOpen || typeof window === 'undefined') return 0;
    const full = window.innerHeight;
    return Math.max(0, full - viewportHeight);
  }, [isMobile, keyboardOpen, viewportHeight]);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // firstItemIndex pattern: keeps Virtuoso anchored when older history is prepended via onLoadMore.
  // Without this, prepended messages cause a scroll jump equal to the prepended batch height.
  const INITIAL_FIRST_INDEX = 100000;
  const firstItemIndexRef = useRef(INITIAL_FIRST_INDEX);
  const [firstItemIndex, setFirstItemIndex] = useState(INITIAL_FIRST_INDEX);
  const prevMessagesRef = useRef<ThreadMessage[] | null>(null);

  // Reset on thread switch (mirrors ChatArea's channel-switch reset).
  useEffect(() => {
    firstItemIndexRef.current = INITIAL_FIRST_INDEX;
    setFirstItemIndex(INITIAL_FIRST_INDEX);
    prevMessagesRef.current = null;
  }, [thread?.id]);

  // Detect prepend by locating the prior first message in the new array.
  useEffect(() => {
    const prev = prevMessagesRef.current;
    prevMessagesRef.current = messages;
    if (!prev || prev.length === 0 || messages.length === 0) return;
    if (messages.length <= prev.length) return;
    const prevFirstId = prev[0]?.id;
    const prependedCount = messages.findIndex((m) => m.id === prevFirstId);
    if (prependedCount > 0) {
      firstItemIndexRef.current -= prependedCount;
      setFirstItemIndex(firstItemIndexRef.current);
    }
  }, [messages]);

  const handleStartReached = useCallback(() => {
    if (hasMore && onLoadMore) onLoadMore();
  }, [hasMore, onLoadMore]);

  // Jump-to-bottom button (mirror of ChatArea's pattern). Uses ref+state so the toggle doesn't
  // re-render the whole tree on every scroll-state flip.
  const isAtBottomRef = useRef(true);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    isAtBottomRef.current = atBottom;
    setShowScrollDown(!atBottom);
  }, []);
  // Reset visibility when switching threads (Virtuoso unmounts via key, but state lives on).
  useEffect(() => {
    isAtBottomRef.current = true;
    setShowScrollDown(false);
  }, [thread?.id]);

  // Keep the thread input visible when the mobile soft keyboard opens.
  useEffect(() => {
    if (keyboardOpen) {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
    }
  }, [keyboardOpen]);

  const usersById = React.useMemo(() => {
    const map = new Map<string, User>();
    for (const u of users) map.set(u.id, u);
    return map;
  }, [users]);

  // Stable token accessor so MessageAttachment can tokened-fetch thread media.
  const getToken = useCallback(() => apiClient.getToken(), []);

  const renderMessage = useCallback((_index: number, msg: ThreadMessage) => {
    const author = usersById.get(msg.authorId);
    const authorName = author?.username ?? 'Unknown';
    const authorAvatar = author?.avatar ?? null;
    const isGrouped = _index > 0 && messages[_index - 1]?.authorId === msg.authorId &&
      new Date(msg.createdAt).getTime() - new Date(messages[_index - 1].createdAt).getTime() < 420000;

    return (
      <div style={{ paddingTop: isGrouped ? 1 : 12 }}>
        {!isGrouped && (
          <div className="flex items-start gap-2.5 px-3">
            <div className="w-8 h-8 rounded-[var(--radius-lg)] overflow-hidden shrink-0 mt-0.5">
              {authorAvatar ? (
                <LazyGif src={authorAvatar} frameSrc={getFrameUrl(authorAvatar)} alt="" className="w-full h-full object-cover" />
              ) : (
                <LetterAvatar username={authorName} size={32} />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-baseline gap-1.5">
                <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{authorName}</span>
                <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                  {new Date(msg.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </span>
                {msg.editedAt && <span className="text-[10px] italic" style={{ color: 'var(--text-tertiary)' }}>{t('chat.edited')}</span>}
              </div>
              <div className="text-sm break-words" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
                <MentionText content={msg.content} messageId={msg.id} memberNames={[]} />
              </div>
              {msg.attachmentUrl && (
                <MessageAttachment
                  attachmentUrl={msg.attachmentUrl}
                  attachmentName={msg.attachmentName}
                  attachmentContentType={msg.attachmentContentType}
                  getToken={getToken}
                />
              )}
            </div>
          </div>
        )}
        {isGrouped && (
          <div className="pl-[54px] pr-3">
            <div className="text-sm break-words" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
              <MentionText content={msg.content} messageId={msg.id} memberNames={[]} />
            </div>
            {msg.attachmentUrl && (
              <MessageAttachment
                attachmentUrl={msg.attachmentUrl}
                attachmentName={msg.attachmentName}
                attachmentContentType={msg.attachmentContentType}
                getToken={getToken}
              />
            )}
          </div>
        )}
      </div>
    );
  }, [messages, usersById, t, getToken]);

  return (
    <div
      className={`flex flex-col h-full overflow-hidden border-l ${isMobile ? 'fixed inset-0 z-50' : 'rounded-2xl'}`}
      style={{
        width: isMobile ? '100%' : 400,
        backgroundColor: isMobile ? 'var(--bg-chat)' : 'var(--glass-bg)',
        backdropFilter: isMobile ? undefined : 'blur(24px) saturate(1.3)',
        WebkitBackdropFilter: isMobile ? undefined : 'blur(24px) saturate(1.3)',
        boxShadow: isMobile ? undefined : '0 0 0 1px var(--fill-hover) inset, 0 8px 32px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3)',
        border: isMobile ? 'none' : '1px solid var(--glass-border)',
        borderColor: 'var(--glass-border)',
      } as React.CSSProperties}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b shrink-0"
        style={{
          borderColor: 'var(--border-subtle)',
          paddingTop: isMobile ? 'calc(0.75rem + env(safe-area-inset-top))' : undefined,
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{t('threads.thread')}</h3>
          <span className="text-xs truncate" style={{ color: 'var(--text-tertiary)' }}>{thread.name}</span>
          {thread.archived && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ backgroundColor: 'var(--fill-active)', color: 'var(--text-tertiary)' }}>
              {t('threads.archived')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {(isCreator || canManage) && (
            <div className="relative">
              <button type="button" onClick={() => setMenuOpen((o) => !o)} className="p-1.5 rounded-lg hover:bg-fill-active" style={{ color: 'var(--text-secondary)' }}>
                <Settings size={16} />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full mt-1 w-40 py-1 rounded-xl border shadow-xl z-50" style={{ backgroundColor: 'var(--bg-floating)', borderColor: 'var(--border-subtle)' }}>
                  {onArchive && (
                    <button type="button" onClick={() => { onArchive(); setMenuOpen(false); }} className="w-full text-left px-3 py-2 text-sm hover:bg-fill-active" style={{ color: 'var(--text-primary)' }}>
                      <Archive size={14} className="inline mr-2" />
                      {thread.archived ? t('threads.unarchiveThread') : t('threads.archiveThread')}
                    </button>
                  )}
                  {onDelete && (
                    <button type="button" onClick={() => { onDelete(); setMenuOpen(false); }} className="w-full text-left px-3 py-2 text-sm hover:bg-fill-active" style={{ color: 'var(--danger)' }}>
                      {t('threads.deleteThread')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-fill-active" style={{ color: 'var(--text-secondary)' }}>
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Parent message */}
      {parentMessage && (
        <div className="px-4 py-2.5 border-b shrink-0" style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-panel)' }}>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-5 h-5 rounded-[var(--radius-lg)] overflow-hidden shrink-0">
              {parentMessage.authorAvatar ? (
                <LazyGif src={parentMessage.authorAvatar} frameSrc={getFrameUrl(parentMessage.authorAvatar)} alt="" className="w-full h-full object-cover" />
              ) : (
                <LetterAvatar username={parentMessage.authorUsername} size={20} />
              )}
            </div>
            <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{parentMessage.authorUsername}</span>
          </div>
          <p className="text-xs line-clamp-2" style={{ color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>
            {parentMessage.content || t('chat.attachment')}
          </p>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 min-h-0 relative">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{t('threads.noMessages')}</span>
          </div>
        ) : (
          <>
            <Virtuoso
              ref={virtuosoRef}
              data={messages}
              defaultItemHeight={60}
              computeItemKey={(_i, msg) => msg.id}
              className="flex-1 min-h-0 no-scrollbar overscroll-contain"
              style={{ paddingLeft: '0.25rem', paddingRight: '0.5rem' }}
              followOutput="auto"
              atBottomThreshold={40}
              atBottomStateChange={handleAtBottomStateChange}
              overscan={200}
              firstItemIndex={firstItemIndex}
              initialTopMostItemIndex={messages.length > 0 ? firstItemIndex + messages.length - 1 : undefined}
              startReached={handleStartReached}
              itemContent={renderMessage}
            />
            {showScrollDown && (
              <button
                type="button"
                onClick={() => {
                  virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' });
                  setShowScrollDown(false);
                }}
                className="absolute bottom-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border border-[var(--glass-border)] shadow-lg transition-colors text-t-primary"
                style={{ backgroundColor: 'color-mix(in srgb, var(--bg-app) 92%, transparent)' }}
                aria-label="Jump to latest"
              >
                <ChevronDown size={12} />
                Jump to latest
              </button>
            )}
          </>
        )}
      </div>

      {/* Input */}
      {!thread.archived && (
        <div
          className="shrink-0 px-3 pb-3"
          style={
            isMobile
              ? {
                  paddingBottom: `calc(0.75rem + ${keyboardHeight}px + env(safe-area-inset-bottom))`,
                }
              : undefined
          }
        >
          <MessageInput
            channel={{ id: thread.channelId, name: thread.name, type: 'text', categoryId: null, position: 0 }}
            users={users}
            onSendMessage={(content, replyToId, attachment) => onSendMessage(content, replyToId, attachment)}
            uploadFile={uploadFile}
            isDM={false}
            uiDensity="default"
            maxAttachmentMB={maxAttachmentMB}
            userPlan={userPlan}
            replyingTo={null}
            onCancelReply={() => {}}
            showSendBtn
          />
        </div>
      )}
      {thread.archived && (
        <div
          className="shrink-0 px-4 py-3 text-center border-t"
          style={{
            borderColor: 'var(--border-subtle)',
            paddingBottom: isMobile ? 'calc(0.75rem + env(safe-area-inset-bottom))' : undefined,
          }}
        >
          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('threads.archived')} — {t('threads.unarchiveThread')}</span>
        </div>
      )}
    </div>
  );
};
