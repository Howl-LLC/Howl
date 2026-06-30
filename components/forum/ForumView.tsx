// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { getWebOrigin } from '../../config';
import { Plus, Search, ChevronDown, ArrowUpDown, Pin, Lock, Unlock, Trash2, Pencil, Link2, Loader2 } from 'lucide-react';
import { GLASS_MENU_STYLE, GLASS_MENU_CLASS, getContextMenuPosition } from '../../utils/contextMenuStyles';
import { ForumIcon } from '../channel/ForumIcon';
import { ForumPostCard } from './ForumPostCard';
import { NewPostForm } from './NewPostForm';
import { ForumPostView } from './ForumPostView';
import { useIsMobile } from '../../hooks/useIsMobile';
import { apiClient } from '../../services/api';
import { socketService } from '../../services/socket';
import { useNotificationStore } from '../../stores/notificationStore';
import { useNavigationStore } from '../../stores/navigationStore';
import type { Channel, ForumPost, ForumTag, User } from '../../types';

// Props

interface ForumViewProps {
  serverId: string;
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
  canManagePosts?: boolean;
  canDeleteMessages?: boolean;
}

// Constants

const PAGE_SIZE = 25;
const SKELETON_COUNT = 5;

type SortOption = 'active' | 'latest' | 'oldest';

interface SortDef {
  value: SortOption;
  labelKey: string;
  fallback: string;
}

const SORT_OPTIONS: SortDef[] = [
  { value: 'active', labelKey: 'forum.sortActive', fallback: 'Recent Activity' },
  { value: 'latest', labelKey: 'forum.sortNewest', fallback: 'Newest' },
  { value: 'oldest', labelKey: 'forum.sortOldest', fallback: 'Oldest' },
];

// Helpers

/** Build a subtle background from a hex color at 15 % opacity. */
function tagBgColor(hex: string): string {
  return `${hex}26`;
}

// Component

export function ForumView({
  serverId,
  channel,
  currentUser,
  uploadFile,
  canManagePosts,
  canDeleteMessages,
}: ForumViewProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();

  // State

  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [tags, setTags] = useState<ForumTag[]>([]);
  const [activeTagId, setActiveTagId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortOption>(
    channel.defaultSortOrder === 'creation_date' ? 'latest' : 'active',
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activePostId, setActivePostId] = useState<string | null>(null);

  // Sync the active post into navigationStore so the global notification hook
  // can suppress per-post unread bumps for the post the user is viewing,
  // and clear any existing unread for it the moment they open it.
  useEffect(() => {
    useNavigationStore.getState().setActiveForumPostId(activePostId);
    if (activePostId) useNotificationStore.getState().clearForumPostUnread(activePostId);
    return () => { useNavigationStore.getState().setActiveForumPostId(null); };
  }, [activePostId]);
  const [showNewPostForm, setShowNewPostForm] = useState(false);
  const [showSortDropdown, setShowSortDropdown] = useState(false);
  const [newPostIndicator, setNewPostIndicator] = useState(false);
  const [postMenu, setPostMenu] = useState<{ post: ForumPost; x: number; y: number } | null>(null);
  const [deleteConfirmPostId, setDeleteConfirmPostId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Refs

  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const sortDropdownRef = useRef<HTMLDivElement>(null);

  // Data fetching

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setPosts([]);
    setNewPostIndicator(false);

    Promise.all([
      apiClient.getForumTags(serverId, channel.id),
      apiClient.getForumPosts(serverId, channel.id, {
        sort: sortBy,
        tag: activeTagId ?? undefined,
        limit: PAGE_SIZE,
      }),
    ])
      .then(([tagData, postData]) => {
        if (cancelled) return;
        setTags(tagData);
        setPosts(postData.posts);
        setHasMore(postData.hasMore);
      })
      .catch(() => {
        /* errors surfaced by apiClient interceptors */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [serverId, channel.id, sortBy, activeTagId]);

  // Load more (infinite scroll)

  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore || loading) return;

    const lastPost = posts[posts.length - 1];
    if (!lastPost) return;

    setLoadingMore(true);
    apiClient
      .getForumPosts(serverId, channel.id, {
        sort: sortBy,
        tag: activeTagId ?? undefined,
        limit: PAGE_SIZE,
        before: lastPost.id,
      })
      .then((data) => {
        setPosts((prev) => {
          const existingIds = new Set(prev.map((p) => p.id));
          const fresh = data.posts.filter((p) => !existingIds.has(p.id));
          return [...prev, ...fresh];
        });
        setHasMore(data.hasMore);
      })
      .catch(() => {
        /* swallow — user can scroll again to retry */
      })
      .finally(() => setLoadingMore(false));
  }, [hasMore, loadingMore, loading, posts, serverId, channel.id, sortBy, activeTagId]);

  // IntersectionObserver for infinite scroll sentinel

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMore();
        }
      },
      { rootMargin: '200px' },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore]);

  // Socket integration

  useEffect(() => {
    const sock = socketService.getSocket();
    if (!sock) return;

    const onPostCreated = (data: {
      serverId: string;
      channelId: string;
      post: ForumPost;
    }) => {
      if (data.channelId !== channel.id) return;
      setPosts((prev) => {
        if (prev.some((p) => p.id === data.post.id)) return prev;
        return [data.post, ...prev];
      });
      // Show new-post indicator when the list is scrolled
      if (listRef.current && listRef.current.scrollTop > 80) {
        setNewPostIndicator(true);
      }
    };

    const onPostUpdated = (data: {
      serverId: string;
      channelId: string;
      post: ForumPost;
    }) => {
      if (data.channelId !== channel.id) return;
      setPosts((prev) => prev.map((p) => (p.id === data.post.id ? data.post : p)));
    };

    const onPostDeleted = (data: {
      serverId: string;
      channelId: string;
      postId: string;
    }) => {
      if (data.channelId !== channel.id) return;
      setPosts((prev) => prev.filter((p) => p.id !== data.postId));
      // If viewing the deleted post, go back
      setActivePostId((cur) => (cur === data.postId ? null : cur));
    };

    // Forum tag real-time events
    const onTagCreated = (data: { channelId: string; tag: ForumTag }) => {
      if (data.channelId !== channel.id) return;
      setTags((prev) => {
        if (prev.some((t) => t.id === data.tag.id)) return prev;
        return [...prev, data.tag];
      });
    };

    const onTagUpdated = (data: { channelId: string; tag: ForumTag }) => {
      if (data.channelId !== channel.id) return;
      setTags((prev) => prev.map((t) => (t.id === data.tag.id ? data.tag : t)));
    };

    const onTagDeleted = (data: { channelId: string; tagId: string }) => {
      if (data.channelId !== channel.id) return;
      setTags((prev) => prev.filter((t) => t.id !== data.tagId));
      // If filtering by the deleted tag, clear the filter
      setActiveTagId((cur) => (cur === data.tagId ? null : cur));
    };

    const onTagsReordered = (data: { channelId: string; tags: ForumTag[] }) => {
      if (data.channelId !== channel.id) return;
      setTags(data.tags);
    };

    sock.on('forum-post-created', onPostCreated);
    sock.on('forum-post-updated', onPostUpdated);
    sock.on('forum-post-deleted', onPostDeleted);
    sock.on('forum-tag-created', onTagCreated);
    sock.on('forum-tag-updated', onTagUpdated);
    sock.on('forum-tag-deleted', onTagDeleted);
    sock.on('forum-tags-reordered', onTagsReordered);

    return () => {
      sock.off('forum-post-created', onPostCreated);
      sock.off('forum-post-updated', onPostUpdated);
      sock.off('forum-post-deleted', onPostDeleted);
      sock.off('forum-tag-created', onTagCreated);
      sock.off('forum-tag-updated', onTagUpdated);
      sock.off('forum-tag-deleted', onTagDeleted);
      sock.off('forum-tags-reordered', onTagsReordered);
    };
  }, [channel.id]);

  // Close sort dropdown on click outside

  useEffect(() => {
    if (!showSortDropdown) return;

    const handleClick = (e: MouseEvent) => {
      if (
        sortDropdownRef.current &&
        !sortDropdownRef.current.contains(e.target as Node)
      ) {
        setShowSortDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSortDropdown]);

  // Close post context menu on Escape

  useEffect(() => {
    if (!postMenu) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPostMenu(null);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [postMenu]);

  // Derived display posts

  const displayPosts = useMemo(() => {
    let filtered = posts;

    // Client-side search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.content.toLowerCase().includes(q),
      );
    }

    // Pinned posts first; preserve API sort order otherwise
    return [...filtered].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return 0;
    });
  }, [posts, searchQuery]);

  // Handlers

  const handlePostCreated = useCallback((post: ForumPost) => {
    setPosts((prev) => {
      if (prev.some((p) => p.id === post.id)) return prev;
      return [post, ...prev];
    });
    setShowNewPostForm(false);
  }, []);

  const handleSortChange = useCallback((value: SortOption) => {
    setSortBy(value);
    setShowSortDropdown(false);
  }, []);

  const handleTagSelect = useCallback((tagId: string | null) => {
    setActiveTagId(tagId);
  }, []);

  const handleScrollToTop = useCallback(() => {
    listRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    setNewPostIndicator(false);
  }, []);

  const handleBackFromPost = useCallback(() => {
    setActivePostId(null);
  }, []);

  const handlePostContextMenu = useCallback((post: ForumPost, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPostMenu({ post, x: e.clientX, y: e.clientY });
  }, []);

  const handlePinPost = useCallback(async (post: ForumPost) => {
    setPostMenu(null);
    try {
      await apiClient.updateForumPost(serverId, channel.id, post.id, { pinned: !post.pinned });
    } catch { /* handled by socket update */ }
  }, [serverId, channel.id]);

  const handleLockPost = useCallback(async (post: ForumPost) => {
    setPostMenu(null);
    try {
      await apiClient.updateForumPost(serverId, channel.id, post.id, { locked: !post.locked });
    } catch { /* handled by socket update */ }
  }, [serverId, channel.id]);

  const handleDeletePost = useCallback(async (postId: string) => {
    setDeleteLoading(true);
    try {
      await apiClient.deleteForumPost(serverId, channel.id, postId);
    } catch { /* error handled by interceptor */ }
    setDeleteLoading(false);
    setDeleteConfirmPostId(null);
  }, [serverId, channel.id]);

  const handleEditPost = useCallback((postId: string) => {
    setPostMenu(null);
    setActivePostId(postId);
  }, []);

  const handleCopyLink = useCallback((postId: string) => {
    setPostMenu(null);
    const url = `${getWebOrigin()}/channels/${serverId}/${channel.id}/post/${postId}`;
    navigator.clipboard.writeText(url).catch(() => {});
  }, [serverId, channel.id]);

  // Current sort label

  const currentSortLabel = useMemo(() => {
    const opt = SORT_OPTIONS.find((o) => o.value === sortBy);
    return opt ? t(opt.labelKey, opt.fallback) : t('forum.sortActive', 'Recent Activity');
  }, [sortBy, t]);

  // Search results empty?

  const hasSearchQuery = searchQuery.trim().length > 0;
  const noSearchResults = hasSearchQuery && displayPosts.length === 0 && !loading;
  const noPostsAtAll = !hasSearchQuery && posts.length === 0 && !loading;

  // Mode 2 — Post View

  if (activePostId) {
    return (
      <ForumPostView
        serverId={serverId}
        channelId={channel.id}
        postId={activePostId}
        channel={channel}
        currentUser={currentUser}
        uploadFile={uploadFile}
        onBack={handleBackFromPost}
        canManagePosts={canManagePosts}
        canDeleteMessages={canDeleteMessages}
      />
    );
  }

  // Mode 1 — Post List

  return (
    <div className="flex h-full flex-col">
      {/* ── 1a. Header bar ─────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-2.5 border-b border-default px-4 py-3 text-t-primary">
        <ForumIcon size={18} />
        <span className="text-sm font-semibold">{channel.name}</span>
        {!isMobile && channel.description && (
          <span className="ml-2 flex-1 truncate text-xs text-t-secondary">
            {channel.description}
          </span>
        )}
      </div>

      {/* ── 1b. Search + New Post bar ──────────────────────── */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-3">
        <div className="relative flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-t-secondary"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('forum.searchPlaceholder', 'Search posts...')}
            className="w-full rounded-xl border border-default bg-fill-hover py-2 pl-8 pr-3.5 text-sm text-t-primary placeholder-t-secondary focus:border-[var(--cyan-accent)]/40 focus:outline-none transition-colors"
          />
        </div>
        <button
          type="button"
          onClick={() => setShowNewPostForm(true)}
          className="btn-cta flex shrink-0 items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors cursor-pointer"
        >
          <Plus size={16} />
          {!isMobile && t('forum.newPost', 'New Post')}
        </button>
      </div>

      {/* ── 1c. Sort & Tag filter bar ──────────────────────── */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 pb-3">
        {/* Sort dropdown */}
        <div className="relative" ref={sortDropdownRef}>
          <button
            type="button"
            onClick={() => setShowSortDropdown((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg border border-default bg-fill-hover px-3 py-1.5 text-xs text-t-secondary hover:bg-fill-hover cursor-pointer transition-colors"
          >
            <ArrowUpDown size={12} />
            {currentSortLabel}
            <ChevronDown
              size={12}
              className={`transition-transform ${showSortDropdown ? 'rotate-180' : ''}`}
            />
          </button>

          {showSortDropdown && (
            <div className="absolute left-0 top-full z-50 mt-1 rounded-xl border border-[var(--glass-border)] bg-[var(--bg-panel)] p-1">
              {SORT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleSortChange(opt.value)}
                  className={`flex w-full items-center rounded-lg px-3 py-1.5 text-xs transition-colors cursor-pointer whitespace-nowrap ${
                    sortBy === opt.value
                      ? 'bg-fill-active text-t-primary'
                      : 'text-t-secondary hover:bg-fill-hover hover:text-t-primary'
                  }`}
                >
                  {t(opt.labelKey, opt.fallback)}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Tag pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          {/* "All" pill */}
          <button
            type="button"
            onClick={() => handleTagSelect(null)}
            className={`rounded-lg px-2.5 py-1 text-xs cursor-pointer transition-colors ${
              activeTagId === null
                ? 'bg-fill-active text-t-primary'
                : 'bg-fill-hover text-t-secondary hover:bg-fill-hover'
            }`}
          >
            {t('forum.allTags', 'All')}
          </button>

          {tags.map((tag) => {
            const isActive = activeTagId === tag.id;
            return (
              <button
                key={tag.id}
                type="button"
                onClick={() => handleTagSelect(tag.id)}
                className={`rounded-lg px-2.5 py-1 text-xs cursor-pointer transition-colors ${
                  isActive
                    ? ''
                    : 'bg-fill-hover text-t-secondary hover:bg-fill-hover'
                }`}
                style={
                  isActive
                    ? { backgroundColor: tagBgColor(tag.color), color: tag.color }
                    : undefined
                }
              >
                {tag.emoji && <span className="mr-1">{tag.emoji}</span>}
                {tag.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── 1d. Post grid ──────────────────────────────────── */}
      <div ref={listRef} className="relative flex-1 overflow-y-auto">
        {/* New post indicator floating banner */}
        {newPostIndicator && (
          <div className="sticky top-2 z-40 flex justify-center px-4">
            <button
              type="button"
              onClick={handleScrollToTop}
              className="rounded-xl border border-[var(--cyan-accent)]/30 bg-[var(--cyan-accent)]/20 px-3 py-1 text-xs text-[var(--cyan-accent)] cursor-pointer hover:bg-[var(--cyan-accent)]/30 transition-colors"
            >
              {t('forum.newPostIndicator', 'New post')}
            </button>
          </div>
        )}

        {/* Loading skeletons */}
        {loading && (
          <div
            className="px-4 pt-3 pb-3"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: '10px',
            }}
          >
            {Array.from({ length: SKELETON_COUNT }, (_, i) => (
              <div
                key={i}
                className="h-[80px] animate-pulse rounded-xl bg-fill-hover"
              />
            ))}
          </div>
        )}

        {/* Empty state — no posts at all */}
        {noPostsAtAll && (
          <div className="flex h-full flex-col items-center justify-center">
            <ForumIcon size={48} className="text-t-secondary opacity-40" />
            <p className="mt-3 text-sm text-t-secondary">
              {t('forum.noPosts', 'No posts yet')}
            </p>
            <p className="text-xs text-t-tertiary">
              {t('forum.startConversation', 'Start the conversation!')}
            </p>
            <button
              type="button"
              onClick={() => setShowNewPostForm(true)}
              className="btn-cta mt-4 flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors cursor-pointer"
            >
              <Plus size={16} />
              {t('forum.createFirstPost', 'Create the first post')}
            </button>
          </div>
        )}

        {/* No search results */}
        {noSearchResults && (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-t-secondary">
              {t('forum.noSearchResults', 'No posts match your search')}
            </p>
          </div>
        )}

        {/* Post cards — CSS grid layout */}
        {!loading && displayPosts.length > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: '10px',
              padding: '12px 16px',
            }}
          >
            {displayPosts.map((post) => (
              <ForumPostCard
                key={post.id}
                post={post}
                onClick={() => setActivePostId(post.id)}
                onContextMenu={(e) => handlePostContextMenu(post, e)}
              />
            ))}
          </div>
        )}

        {/* Loading more indicator */}
        {loadingMore && (
          <div className="flex justify-center py-4">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--glass-border)] border-t-[var(--cyan-accent)]" />
          </div>
        )}

        {/* Infinite scroll sentinel */}
        <div ref={sentinelRef} className="h-1 shrink-0" />
      </div>

      {/* ── NewPostForm modal ──────────────────────────────── */}
      <NewPostForm
        isOpen={showNewPostForm}
        onClose={() => setShowNewPostForm(false)}
        serverId={serverId}
        channel={channel}
        tags={tags}
        uploadFile={uploadFile}
        onPostCreated={handlePostCreated}
      />

      {/* ── Post context menu ───────────────────────────── */}
      {postMenu && createPortal(
        <>
          <div className="fixed inset-0 z-[var(--z-popover)]" onClick={() => setPostMenu(null)} onContextMenu={(e) => { e.preventDefault(); setPostMenu(null); }} aria-hidden />
          <div
            className={`fixed z-[var(--z-popover)] py-2 min-w-[200px] ${GLASS_MENU_CLASS}`}
            style={{
              ...getContextMenuPosition(postMenu.x, postMenu.y, 220, 280),
              ...GLASS_MENU_STYLE,
            }}
          >
            {(postMenu.post.authorId === currentUser.id) && (
              <button type="button" onClick={() => handleEditPost(postMenu.post.id)}
                className="w-full px-4 py-2.5 text-left text-sm rounded-lg hover:bg-fill-active flex items-center gap-2 cursor-pointer transition-colors text-t-primary">
                <Pencil size={16} className="opacity-60" /> {t('forum.editPost', 'Edit Post')}
              </button>
            )}

            <button type="button" onClick={() => handleCopyLink(postMenu.post.id)}
              className="w-full px-4 py-2.5 text-left text-sm rounded-lg hover:bg-fill-active flex items-center gap-2 cursor-pointer transition-colors text-t-primary">
              <Link2 size={16} className="opacity-60" /> {t('forum.copyLink', 'Copy Link')}
            </button>

            {canManagePosts && (
              <>
                <div className="h-px my-1 mx-3" style={{ backgroundColor: 'var(--border-subtle)' }} />

                <button type="button" onClick={() => handlePinPost(postMenu.post)}
                  className="w-full px-4 py-2.5 text-left text-sm rounded-lg hover:bg-fill-active flex items-center gap-2 cursor-pointer transition-colors text-t-primary">
                  <Pin size={16} className="opacity-60" />
                  {postMenu.post.pinned ? t('forum.unpin', 'Unpin Post') : t('forum.pin', 'Pin Post')}
                </button>

                <button type="button" onClick={() => handleLockPost(postMenu.post)}
                  className="w-full px-4 py-2.5 text-left text-sm rounded-lg hover:bg-fill-active flex items-center gap-2 cursor-pointer transition-colors text-t-primary">
                  {postMenu.post.locked ? <Unlock size={16} className="opacity-60" /> : <Lock size={16} className="opacity-60" />}
                  {postMenu.post.locked ? t('forum.unlock', 'Unlock Post') : t('forum.lock', 'Lock Post')}
                </button>
              </>
            )}

            {(postMenu.post.authorId === currentUser.id || canManagePosts) && (
              <>
                <div className="h-px my-1 mx-3" style={{ backgroundColor: 'var(--border-subtle)' }} />
                <button type="button" onClick={() => { setPostMenu(null); setDeleteConfirmPostId(postMenu.post.id); }}
                  className="w-full px-4 py-2.5 text-left text-sm rounded-lg hover:bg-fill-active flex items-center gap-2 cursor-pointer transition-colors text-red-400">
                  <Trash2 size={16} className="opacity-80" /> {t('forum.deletePost', 'Delete Post')}
                </button>
              </>
            )}
          </div>
        </>,
        document.body
      )}

      {/* ── Delete confirmation modal ────────────────────── */}
      {deleteConfirmPostId && createPortal(
        <div className="fixed inset-0 z-[var(--z-max)] flex items-center justify-center" style={{ backgroundColor: 'var(--overlay-backdrop)', backdropFilter: 'blur(8px)' }}>
          <div className="rounded-2xl border p-5 max-w-sm mx-4 shadow-2xl" style={{ backgroundColor: 'var(--glass-bg)', borderColor: 'var(--glass-border)', backdropFilter: 'blur(24px) saturate(1.3)' }}>
            <p className="text-sm font-medium text-t-primary">{t('forum.deletePostTitle', 'Delete this post?')}</p>
            <p className="mt-1.5 text-xs text-t-secondary">{t('forum.deletePostWarning', 'This action cannot be undone. All replies will also be deleted.')}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setDeleteConfirmPostId(null)} disabled={deleteLoading}
                className="px-3 py-1.5 rounded-lg text-xs text-t-secondary hover:bg-fill-hover transition-colors cursor-pointer disabled:opacity-50">
                {t('common.cancel', 'Cancel')}
              </button>
              <button type="button" onClick={() => handleDeletePost(deleteConfirmPostId)} disabled={deleteLoading}
                className="btn-cta-danger px-3 py-1.5 rounded-xl text-xs transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5">
                {deleteLoading && <Loader2 size={12} className="animate-spin" />}
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
