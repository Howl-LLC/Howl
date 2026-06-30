// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  MoreHorizontal,
  Pin,
  Lock,
  Unlock,
  Trash2,
  Pencil,
  Send,
  Paperclip,
  Smile,
  Loader2,
} from 'lucide-react';
import type { ForumPost, ForumMessage, Channel, User } from '../../types';
import { apiClient } from '../../services/api';
import { socketService } from '../../services/socket';
import { MentionText } from '../MentionText';
import { MessageAttachment } from '../ChatArea';
import { AuthImage } from '../AuthImage';
import { RoleNameStyle } from '../RoleNameStyle';
import { LexicalChatEditor, type LexicalChatEditorHandle } from '../LexicalChatEditor';
import { useIsMobile } from '../../hooks/useIsMobile';
import { relativeTime } from '../../utils/relativeTime';
import { getAvatarEffectClass } from '../../shared/planPerks';
import { LazyGif } from '../LazyGif';
import { getFrameUrl } from '../../utils/getFrameUrl';

/* ── Props ───────────────────────────────────────────────── */

interface ForumPostViewProps {
  serverId: string;
  channelId: string;
  postId: string;
  channel: Channel;
  currentUser: User;
  uploadFile: (file: File) => Promise<{
    url: string;
    name: string;
    contentType: string;
    size: number;
    width?: number | null;
    height?: number | null;
  }>;
  onBack: () => void;
  canManagePosts?: boolean;
  canDeleteMessages?: boolean;
}

/* ── Helpers ─────────────────────────────────────────────── */

const COMMON_EMOJIS = ['\u{1F44D}', '\u2764\uFE0F', '\u{1F602}', '\u{1F389}', '\u{1F62E}', '\u{1F622}'];
const GROUP_THRESHOLD_MS = 7 * 60 * 1000; // 7 minutes

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    return `rgba(128, 128, 128, ${alpha})`;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function authorDisplayName(
  author?: { username: string; discriminator?: string } | null,
): string {
  if (!author) return 'Deleted User';
  return author.username;
}

function shouldGroup(prev: ForumMessage | undefined, cur: ForumMessage): boolean {
  if (!prev) return false;
  const prevId = prev.authorId || prev.author?.id;
  const curId = cur.authorId || cur.author?.id;
  if (!prevId || !curId || prevId !== curId) return false;
  const diff =
    new Date(cur.createdAt).getTime() - new Date(prev.createdAt).getTime();
  return diff < GROUP_THRESHOLD_MS;
}

/* ── Avatar ──────────────────────────────────────────────── */

function UserAvatar({
  author,
  size = 28,
}: {
  author?: { username: string; avatar?: string | null; avatarEffect?: string | null; stripePlan?: string | null } | null;
  size?: number;
}) {
  const initial = (author?.username?.[0] ?? '?').toUpperCase();
  const avatarUrl = author?.avatar ? apiClient.resolveAssetUrl(author.avatar) : null;
  const isPro = author?.stripePlan === 'pro';

  const img = avatarUrl ? (
    <LazyGif src={avatarUrl} frameSrc={getFrameUrl(avatarUrl)} alt="" className="shrink-0 rounded-[var(--radius-lg)] object-cover" style={{ width: size, height: size }} />
  ) : (
    <div className="flex shrink-0 items-center justify-center rounded-[var(--radius-lg)] text-[var(--text-on-accent)] font-semibold"
      style={{ width: size, height: size, fontSize: size * 0.4, backgroundColor: 'var(--accent-emphasis)' }}>
      {initial}
    </div>
  );

  if (isPro && author?.avatarEffect) {
    return <div className={`${getAvatarEffectClass(author.avatarEffect)} rounded-[var(--radius-lg)]`} style={{ width: size, height: size }}>{img}</div>;
  }
  return img;
}

/* ── Component ───────────────────────────────────────────── */

export function ForumPostView({
  serverId,
  channelId,
  postId,
  currentUser,
  uploadFile,
  onBack,
  canManagePosts = false,
  canDeleteMessages = false,
}: ForumPostViewProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();

  /* ── State ───────────────────────────────────────────────── */

  const [post, setPost] = useState<ForumPost | null>(null);
  const [messages, setMessages] = useState<ForumMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sending, setSending] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<{
    url: string;
    name: string;
    contentType: string;
    size: number;
    width?: number | null;
    height?: number | null;
  } | null>(null);
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);
  const [coverImgError, setCoverImgError] = useState(false);
  // Stable token accessor so MessageAttachment can tokened-fetch forum media.
  const getToken = useCallback(() => apiClient.getToken(), []);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  /* ── Refs ─────────────────────────────────────────────────── */

  const editorRef = useRef<LexicalChatEditorHandle>(null);
  const editEditorRef = useRef<LexicalChatEditorHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const reactionRef = useRef<HTMLDivElement>(null);

  /* ── Data fetching ───────────────────────────────────────── */

  useEffect(() => {
    setLoading(true);
    setDeleted(false);
    setCoverImgError(false);
    Promise.all([
      apiClient.getForumPost(serverId, channelId, postId),
      apiClient.getForumMessages(serverId, channelId, postId, { limit: 50 }),
    ])
      .then(([postData, msgData]) => {
        setPost(postData);
        setMessages(msgData.messages);
        setHasMore(msgData.hasMore);
      })
      .catch((err) => {
        console.error('[ForumPostView] Failed to load post:', err?.message || err);
        setDeleted(true);
      })
      .finally(() => setLoading(false));
  }, [serverId, channelId, postId]);

  /* ── Load older messages ─────────────────────────────────── */

  const loadOlder = useCallback(async () => {
    if (loadingMore || !hasMore || messages.length === 0) return;
    setLoadingMore(true);
    try {
      const data = await apiClient.getForumMessages(serverId, channelId, postId, {
        limit: 50,
        before: messages[0].id,
      });
      setMessages((prev) => [...data.messages, ...prev]);
      setHasMore(data.hasMore);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, messages, serverId, channelId, postId]);

  /* ── Socket events ───────────────────────────────────────── */

  useEffect(() => {
    const sock = socketService.getSocket();
    if (!sock) return;

    const onMessageCreated = (payload: {
      serverId: string;
      channelId: string;
      postId: string;
      message: ForumMessage;
    }) => {
      if (payload.postId !== postId) return;
      setMessages((prev) => {
        if (prev.some((m) => m.id === payload.message.id)) return prev;
        return [...prev, payload.message];
      });
      // Auto-scroll if near bottom
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 150) {
          el.scrollTop = el.scrollHeight;
        }
      });
    };

    const onMessageUpdated = (payload: {
      serverId: string;
      channelId: string;
      postId: string;
      message: ForumMessage;
    }) => {
      if (payload.postId !== postId) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === payload.message.id ? payload.message : m)),
      );
    };

    const onMessageDeleted = (payload: {
      serverId: string;
      channelId: string;
      postId: string;
      messageId: string;
    }) => {
      if (payload.postId !== postId) return;
      setMessages((prev) => prev.filter((m) => m.id !== payload.messageId));
    };

    const onPostUpdated = (payload: {
      serverId: string;
      channelId: string;
      post: ForumPost;
    }) => {
      if (payload.post.id !== postId) return;
      setPost(payload.post);
    };

    const onPostDeleted = (payload: {
      serverId: string;
      channelId: string;
      postId: string;
    }) => {
      if (payload.postId !== postId) return;
      setDeleted(true);
    };

    sock.on('forum-message-created', onMessageCreated);
    sock.on('forum-message-updated', onMessageUpdated);
    sock.on('forum-message-deleted', onMessageDeleted);
    sock.on('forum-post-updated', onPostUpdated);
    sock.on('forum-post-deleted', onPostDeleted);

    return () => {
      sock.off('forum-message-created', onMessageCreated);
      sock.off('forum-message-updated', onMessageUpdated);
      sock.off('forum-message-deleted', onMessageDeleted);
      sock.off('forum-post-updated', onPostUpdated);
      sock.off('forum-post-deleted', onPostDeleted);
    };
  }, [postId]);

  /* ── Close dropdowns on outside click ────────────────────── */

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        showActions &&
        actionsRef.current &&
        !actionsRef.current.contains(e.target as Node)
      ) {
        setShowActions(false);
      }
      if (
        reactionPickerMessageId &&
        reactionRef.current &&
        !reactionRef.current.contains(e.target as Node)
      ) {
        setReactionPickerMessageId(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showActions, reactionPickerMessageId]);

  /* ── Send message ────────────────────────────────────────── */

  const handleSend = useCallback(async () => {
    const text = content.trim();
    if ((!text && !attachment) || sending || post?.locked) return;
    setSending(true);
    try {
      await apiClient.createForumMessage(serverId, channelId, postId, {
        content: text,
        ...(attachment && {
          attachmentUrl: attachment.url,
          attachmentName: attachment.name,
          attachmentContentType: attachment.contentType,
          attachmentWidth: attachment.width ?? undefined,
          attachmentHeight: attachment.height ?? undefined,
        }),
      });
      setContent('');
      setAttachment(null);
      editorRef.current?.clear();
      // Scroll to bottom
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    } finally {
      setSending(false);
    }
  }, [content, attachment, sending, post?.locked, serverId, channelId, postId]);

  /* ── Edit message ────────────────────────────────────────── */

  const startEdit = useCallback((msg: ForumMessage) => {
    setEditingMessageId(msg.id);
    setEditContent(msg.content);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editingMessageId) return;
    const text = editContent.trim();
    if (!text) return;
    try {
      await apiClient.editForumMessage(
        serverId,
        channelId,
        postId,
        editingMessageId,
        text,
      );
    } finally {
      setEditingMessageId(null);
      setEditContent('');
    }
  }, [editingMessageId, editContent, serverId, channelId, postId]);

  const cancelEdit = useCallback(() => {
    setEditingMessageId(null);
    setEditContent('');
  }, []);

  /* ── Delete message ──────────────────────────────────────── */

  const confirmDelete = useCallback(async () => {
    if (!deletingMessageId) return;
    try {
      await apiClient.deleteForumMessage(
        serverId,
        channelId,
        postId,
        deletingMessageId,
      );
    } finally {
      setDeletingMessageId(null);
    }
  }, [deletingMessageId, serverId, channelId, postId]);

  /* ── Post actions ────────────────────────────────────────── */

  const togglePin = useCallback(async () => {
    if (!post) return;
    setShowActions(false);
    await apiClient.updateForumPost(serverId, channelId, postId, {
      pinned: !post.pinned,
    });
  }, [post, serverId, channelId, postId]);

  const toggleLock = useCallback(async () => {
    if (!post) return;
    setShowActions(false);
    await apiClient.updateForumPost(serverId, channelId, postId, {
      locked: !post.locked,
    });
  }, [post, serverId, channelId, postId]);

  const deletePost = useCallback(async () => {
    setShowActions(false);
    await apiClient.deleteForumPost(serverId, channelId, postId);
    onBack();
  }, [serverId, channelId, postId, onBack]);

  /* ── Reactions ───────────────────────────────────────────── */

  const handleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      const msg = messages.find((m) => m.id === messageId);
      const existing = msg?.reactions?.find((r) => r.emoji === emoji);
      const alreadyReacted = existing?.userIds.includes(currentUser.id);

      if (alreadyReacted) {
        await apiClient.removeForumReaction(
          serverId,
          channelId,
          postId,
          messageId,
          emoji,
        );
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== messageId) return m;
            const reactions = (m.reactions ?? [])
              .map((r) =>
                r.emoji === emoji
                  ? { ...r, userIds: r.userIds.filter((id) => id !== currentUser.id) }
                  : r,
              )
              .filter((r) => r.userIds.length > 0);
            return { ...m, reactions };
          }),
        );
      } else {
        const result = await apiClient.addForumReaction(
          serverId,
          channelId,
          postId,
          messageId,
          emoji,
        );
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId ? { ...m, reactions: result.reactions } : m,
          ),
        );
      }
      setReactionPickerMessageId(null);
    },
    [messages, currentUser.id, serverId, channelId, postId],
  );

  /* ── File attach ─────────────────────────────────────────── */

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const result = await uploadFile(file);
        setAttachment(result);
      } catch {
        // upload failed — silently ignore
      }
      // Reset input so the same file can be re-selected
      e.target.value = '';
    },
    [uploadFile],
  );

  /* ── Derived ─────────────────────────────────────────────── */

  const isAuthor = post?.authorId === currentUser.id;
  const canShowActions = isAuthor || canManagePosts;

  const tagPills = useMemo(
    () =>
      post?.tags?.map((tag) => (
        <span
          key={tag.id}
          className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] leading-tight whitespace-nowrap"
          style={{
            backgroundColor: hexToRgba(tag.color, 0.15),
            color: tag.color,
          }}
        >
          {tag.emoji && <span className="text-[10px]">{tag.emoji}</span>}
          {tag.name}
        </span>
      )),
    [post?.tags],
  );

  /* ── Loading state ───────────────────────────────────────── */

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={24} className="animate-spin text-t-secondary" />
      </div>
    );
  }

  /* ── Deleted state ───────────────────────────────────────── */

  if (deleted || !post) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-t-secondary">
          {t('forum.postDeleted', 'This post was deleted')}
        </p>
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg bg-fill-hover px-4 py-2 text-xs text-t-secondary hover:bg-fill-active transition-colors"
        >
          {t('forum.goBack', 'Go back')}
        </button>
      </div>
    );
  }

  /* ── Render ──────────────────────────────────────────────── */

  return (
    <div className="flex h-full flex-col">
      {/* ── 1. Header ─────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-default bg-[var(--bg-panel)]/80 backdrop-blur-xl px-4 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex h-9 w-9 items-center justify-center rounded-full text-t-secondary hover:bg-fill-hover hover:text-t-primary transition-colors cursor-pointer"
        >
          <ArrowLeft size={18} />
        </button>

        <span className="text-sm font-medium text-t-primary truncate flex-1 min-w-0">
          {post.title}
        </span>

        {tagPills && tagPills.length > 0 && (
          <div className="hidden sm:flex items-center gap-1 shrink-0">
            {tagPills}
          </div>
        )}

        {canShowActions && (
          <div className="relative" ref={actionsRef}>
            <button
              type="button"
              onClick={() => setShowActions((v) => !v)}
              className="flex h-9 w-9 items-center justify-center rounded-full text-t-secondary hover:bg-fill-hover hover:text-t-primary transition-colors cursor-pointer"
            >
              <MoreHorizontal size={16} />
            </button>

            {showActions && (
              <div className="absolute right-0 top-full mt-1 min-w-[160px] rounded-xl border border-[var(--glass-border)] bg-[var(--bg-panel)] p-1 shadow-xl z-50">
                {canManagePosts && (
                  <button
                    type="button"
                    onClick={togglePin}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-t-primary hover:bg-fill-hover transition-colors"
                  >
                    <Pin size={14} />
                    {post.pinned
                      ? t('forum.unpin', 'Unpin')
                      : t('forum.pin', 'Pin')}
                  </button>
                )}
                {canManagePosts && (
                  <button
                    type="button"
                    onClick={toggleLock}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-t-primary hover:bg-fill-hover transition-colors"
                  >
                    {post.locked ? (
                      <Unlock size={14} />
                    ) : (
                      <Lock size={14} />
                    )}
                    {post.locked
                      ? t('forum.unlock', 'Unlock')
                      : t('forum.lock', 'Lock')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => { setShowActions(false); setShowDeleteConfirm(true); }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-red-400 hover:bg-fill-hover transition-colors"
                >
                  <Trash2 size={14} />
                  {t('forum.delete', 'Delete')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── 2. Scrollable content ─────────────────────────────── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {/* ── Post body ─────────────────────────────────────────── */}
        <div className="px-4 py-4">
          <div className="flex items-center gap-2.5">
            <UserAvatar author={post.author} size={32} />
            <div className="flex items-baseline gap-2 min-w-0">
              <RoleNameStyle
                name={authorDisplayName(post.author)}
                overrideColor={post.author?.nameColor}
                overrideFont={post.author?.nameFont}
                nameEffect={post.author?.nameEffect}
                className="text-sm"
              />
              <span className="text-xs text-t-tertiary shrink-0">
                {new Date(post.createdAt).toLocaleDateString()}
              </span>
            </div>
          </div>

          {post.imageUrl && !coverImgError && (
            <AuthImage
              src={post.imageUrl}
              className="mt-3 w-full rounded-xl max-h-[300px] object-cover"
              onError={() => setCoverImgError(true)}
            />
          )}

          <div className="mt-3">
            <MentionText
              content={post.content}
              className="text-sm text-t-primary leading-relaxed"
            />
          </div>
        </div>

        {/* ── Divider with reply count ──────────────────────────── */}
        <div className="my-4 flex items-center gap-3 px-4">
          <div className="flex-1 h-px bg-fill-hover" />
          <span className="text-xs text-t-tertiary shrink-0">
            {messages.length > 0
              ? t('forum.replyCount', '{{count}} replies', {
                  count: messages.length,
                })
              : t('forum.noReplies', 'No replies yet')}
          </span>
          <div className="flex-1 h-px bg-fill-hover" />
        </div>

        {/* ── Load more button ──────────────────────────────────── */}
        {hasMore && (
          <div className="flex justify-center px-4 pb-3">
            <button
              type="button"
              onClick={loadOlder}
              disabled={loadingMore}
              className="rounded-lg bg-fill-hover px-4 py-1.5 text-xs text-t-secondary hover:bg-fill-active hover:text-t-primary transition-colors disabled:opacity-50"
            >
              {loadingMore ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                t('forum.loadOlder', 'Load older replies')
              )}
            </button>
          </div>
        )}

        {/* ── Message list ──────────────────────────────────────── */}
        <div className="px-4 pb-4 space-y-0.5">
          {messages.length === 0 && (
            <p className="py-8 text-center text-xs text-t-tertiary">
              {t('forum.beFirstReply', 'Be the first to reply')}
            </p>
          )}
          {messages.map((msg, idx) => {
            const grouped = shouldGroup(messages[idx - 1], msg);
            const isOwnMessage = msg.authorId === currentUser.id || msg.author?.id === currentUser.id;
            const isEditing = editingMessageId === msg.id;
            const isDeleting = deletingMessageId === msg.id;
            const isHovered = hoveredMessageId === msg.id;
            const authorChanged = idx > 0 && !grouped;

            return (
              <div
                key={msg.id}
                className={`group relative rounded-lg transition-colors ${
                  isHovered && !isMobile ? 'bg-fill-hover' : ''
                } ${grouped ? 'pl-[42px] py-[1px]' : `flex gap-2.5 ${authorChanged ? 'mt-4' : 'mt-1'}`}`}
                onMouseEnter={() => !isMobile && setHoveredMessageId(msg.id)}
                onMouseLeave={() => !isMobile && setHoveredMessageId(null)}
              >
                {/* Avatar — only for non-grouped */}
                {!grouped && (
                  <div className="shrink-0 mt-0.5">
                    <UserAvatar author={msg.author} size={32} />
                  </div>
                )}

                {/* Content column */}
                <div className="flex-1 min-w-0">
                  {/* Header — only for non-grouped */}
                  {!grouped && (
                    <div className="flex items-baseline gap-2 mb-0.5">
                      <RoleNameStyle
                        name={authorDisplayName(msg.author)}
                        overrideColor={msg.author?.nameColor}
                        overrideFont={msg.author?.nameFont}
                        nameEffect={msg.author?.nameEffect}
                        className="text-xs"
                      />
                      <span className="text-[10px] text-t-tertiary">
                        {relativeTime(msg.createdAt)}
                      </span>
                    </div>
                  )}

                  {/* Message content / Edit */}
                  {isEditing ? (
                    <div className="py-1">
                      <LexicalChatEditor
                        ref={editEditorRef}
                        placeholder={t('forum.editPlaceholder', 'Edit message...')}
                        onTextChange={setEditContent}
                        onSubmit={saveEdit}
                        className="rounded-lg border border-[var(--glass-border)] bg-fill-hover px-3 py-2 text-sm text-t-primary"
                      />
                      <div className="mt-1.5 flex items-center gap-2">
                        <button type="button" onClick={cancelEdit}
                          className="rounded-md px-2.5 py-1 text-[11px] text-t-secondary hover:text-t-primary transition-colors">
                          {t('common.cancel', 'Cancel')}
                        </button>
                        <button type="button" onClick={saveEdit}
                          className="btn-cta rounded-md px-2.5 py-1 text-[11px] transition-all">
                          {t('common.save', 'Save')}
                        </button>
                        <span className="text-[10px] text-t-tertiary">Ctrl+Enter</span>
                      </div>
                    </div>
                  ) : (
                    <>
                      <MentionText content={msg.content} className="text-sm text-t-primary" />
                      {msg.editedAt && (
                        <span className="text-[10px] text-t-tertiary ml-1">({t('forum.edited', 'edited')})</span>
                      )}
                    </>
                  )}

                  {/* Attachment */}
                  {msg.attachmentUrl && !isEditing && (
                    <MessageAttachment
                      attachmentUrl={msg.attachmentUrl}
                      attachmentName={msg.attachmentName}
                      attachmentContentType={msg.attachmentContentType}
                      getToken={getToken}
                    />
                  )}

                  {/* Reactions */}
                  {msg.reactions && msg.reactions.length > 0 && !isEditing && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {msg.reactions.map((r) => {
                        const userReacted = r.userIds.includes(currentUser.id);
                        return (
                          <button key={r.emoji} type="button" onClick={() => handleReaction(msg.id, r.emoji)}
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs cursor-pointer transition-colors hover:bg-fill-hover ${
                              userReacted ? 'border-[var(--cyan-accent)]/40 bg-[var(--cyan-accent)]/10' : 'border-default bg-fill-hover'
                            }`}>
                            <span>{r.emoji}</span>
                            <span className="text-t-secondary">{r.userIds.length}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Hover actions */}
                  {isHovered && !isMobile && !isEditing && !isDeleting && (
                    <div className="absolute -top-1 right-1 flex items-center gap-0.5 rounded-lg border border-default bg-[var(--bg-app)] px-1 py-0.5 shadow-lg">
                      {isOwnMessage && (
                        <button type="button" onClick={() => startEdit(msg)}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-t-secondary hover:bg-fill-hover hover:text-t-primary transition-colors">
                          <Pencil size={14} />
                        </button>
                      )}
                      {(isOwnMessage || canDeleteMessages) && (
                        <button type="button" onClick={() => setDeletingMessageId(msg.id)}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-t-secondary hover:bg-fill-hover hover:text-red-400 transition-colors">
                          <Trash2 size={14} />
                        </button>
                      )}
                      <div className="relative" ref={reactionPickerMessageId === msg.id ? reactionRef : undefined}>
                        <button type="button" onClick={() => setReactionPickerMessageId((prev) => prev === msg.id ? null : msg.id)}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-t-secondary hover:bg-fill-hover hover:text-t-primary transition-colors">
                          <Smile size={14} />
                        </button>
                        {reactionPickerMessageId === msg.id && (
                          <div className="absolute right-0 top-full mt-1 flex items-center gap-0.5 rounded-xl border border-[var(--glass-border)] bg-[var(--bg-panel)] p-1.5 shadow-xl z-50">
                            {COMMON_EMOJIS.map((emoji) => (
                              <button key={emoji} type="button" onClick={() => handleReaction(msg.id, emoji)}
                                className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-fill-active transition-colors text-sm">
                                {emoji}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Inline delete confirmation */}
                  {isDeleting && (
                    <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-[var(--glass-border)] bg-[var(--bg-panel)]/80 px-3 py-2">
                      <span className="text-xs text-t-secondary">{t('forum.deleteConfirm', 'Delete this message?')}</span>
                      <button type="button" onClick={() => setDeletingMessageId(null)}
                        className="rounded-md px-2 py-0.5 text-[11px] text-t-secondary hover:text-t-primary transition-colors">
                        {t('common.cancel', 'Cancel')}
                      </button>
                      <button type="button" onClick={confirmDelete}
                        className="btn-cta-danger rounded-xl px-2 py-0.5 text-[11px] transition-colors">
                        {t('common.delete', 'Delete')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── 3. Message input / Locked banner ──────────────────── */}
      {post.locked ? (
        <div className="shrink-0 border-t border-default bg-fill-hover px-4 py-3 text-center">
          <div className="flex items-center justify-center gap-1.5 text-xs text-t-secondary">
            <Lock size={12} />
            <span>
              {t('forum.lockedBanner', 'This post is locked. No new replies.')}
            </span>
          </div>
        </div>
      ) : (
        <div className="shrink-0 border-t border-default bg-[var(--bg-panel)]/60 px-4 py-3">
          {/* ── Pending attachment preview ────────────────────────── */}
          {attachment && (
            <div className="mb-2 flex items-center gap-2 rounded-lg bg-fill-hover px-3 py-1.5">
              {attachment.contentType.startsWith('image/') ? (
                <img
                  src={attachment.url}
                  alt=""
                  className="h-8 w-8 rounded-lg object-cover"
                />
              ) : (
                <Paperclip size={14} className="text-t-secondary" />
              )}
              <span className="text-xs text-t-secondary truncate flex-1 min-w-0">
                {attachment.name}
              </span>
              <button
                type="button"
                onClick={() => setAttachment(null)}
                className="text-t-secondary hover:text-t-primary text-xs transition-colors"
              >
                &times;
              </button>
            </div>
          )}

          <div className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFileSelect}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-t-secondary hover:bg-fill-hover hover:text-t-primary transition-colors"
            >
              <Paperclip size={18} />
            </button>

            <div className="flex-1 min-w-0">
              <LexicalChatEditor
                ref={editorRef}
                placeholder={t('forum.replyPlaceholder', 'Reply to this post...')}
                onTextChange={setContent}
                onSubmit={handleSend}
                className="rounded-xl border border-[var(--glass-border)] bg-fill-hover px-3 py-2.5 text-sm text-t-primary max-h-32 overflow-y-auto"
              />
            </div>

            <button
              type="button"
              onClick={handleSend}
              disabled={(!content.trim() && !attachment) || sending}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--cyan-accent)] text-[var(--text-on-accent)] hover:opacity-90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {sending ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <Send size={18} />
              )}
            </button>
          </div>
        </div>
      )}

      {showDeleteConfirm && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center" style={{ backgroundColor: 'var(--overlay-backdrop)', backdropFilter: 'blur(8px)' }}>
          <div className="rounded-2xl border p-5 max-w-sm mx-4 shadow-2xl" style={{ backgroundColor: 'var(--glass-bg)', borderColor: 'var(--glass-border)', backdropFilter: 'blur(24px) saturate(1.3)' }}>
            <p className="text-sm font-medium text-t-primary">{t('forum.deletePostTitle', 'Delete this post?')}</p>
            <p className="mt-1 text-xs text-t-secondary">{t('forum.deletePostWarning', 'This action cannot be undone. All replies will also be deleted.')}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setShowDeleteConfirm(false)}
                className="px-3 py-1.5 rounded-lg text-xs text-t-secondary hover:bg-fill-hover transition-colors cursor-pointer">
                {t('common.cancel', 'Cancel')}
              </button>
              <button type="button" onClick={() => { setShowDeleteConfirm(false); deletePost(); }}
                className="btn-cta-danger px-3 py-1.5 rounded-xl text-xs transition-colors cursor-pointer">
                {t('forum.deletePost', 'Delete Post')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
