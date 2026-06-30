// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X, FileText, ChevronDown, ChevronUp, ImagePlus, Loader2 } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useIsMobile } from '../../hooks/useIsMobile';
import { apiClient } from '../../services/api';
import { ForumIcon } from '../channel/ForumIcon';
import { LexicalChatEditor, type LexicalChatEditorHandle } from '../LexicalChatEditor';
import type { Channel, ForumTag, ForumPost } from '../../types';

// Constants

const MAX_TITLE = 100;

// Props

interface NewPostFormProps {
  isOpen: boolean;
  onClose: () => void;
  serverId: string;
  channel: Channel;
  tags: ForumTag[];
  uploadFile: (file: File) => Promise<{
    url: string;
    name: string;
    contentType: string;
    size: number;
    width?: number | null;
    height?: number | null;
  }>;
  onPostCreated: (post: ForumPost) => void;
}

// Helpers

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

// Component

export function NewPostForm({
  isOpen,
  onClose,
  serverId,
  channel,
  tags,
  uploadFile,
  onPostCreated,
}: NewPostFormProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const dialogRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<LexicalChatEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(dialogRef, isOpen);

  // State

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [coverImageUrl, setCoverImageUrl] = useState<string | null>(null);
  const [coverUploading, setCoverUploading] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guidelinesExpanded, setGuidelinesExpanded] = useState(true);

  // Reset state when modal closes

  useEffect(() => {
    if (!isOpen) {
      setTitle('');
      setContent('');
      setSelectedTagIds([]);
      setCoverImageUrl(null);
      setCoverUploading(false);
      setCoverError(null);
      setSubmitting(false);
      setError(null);
      setGuidelinesExpanded(true);
    }
  }, [isOpen]);

  // Escape key closes modal

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  // Tag toggling

  const toggleTag = useCallback((tagId: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
    );
  }, []);

  // Cover image upload

  const handleCoverUpload = useCallback(
    async (file: File) => {
      if (!isImageFile(file)) {
        setCoverError('Only image files are allowed');
        return;
      }
      setCoverError(null);
      setCoverUploading(true);
      try {
        const result = await uploadFile(file);
        setCoverImageUrl(result.url);
      } catch (err: any) {
        setCoverError(err?.message || 'Failed to upload image');
      } finally {
        setCoverUploading(false);
      }
    },
    [uploadFile],
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleCoverUpload(file);
      // Reset so re-selecting same file triggers change
      e.target.value = '';
    },
    [handleCoverUpload],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const file = e.dataTransfer.files[0];
      if (file && isImageFile(file)) {
        handleCoverUpload(file);
      } else if (file) {
        setCoverError('Only image files are allowed');
      }
    },
    [handleCoverUpload],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const removeCoverImage = useCallback(() => {
    setCoverImageUrl(null);
    setCoverError(null);
  }, []);

  // Submission

  const canSubmit =
    title.trim().length > 0 &&
    content.trim().length > 0 &&
    !(channel.requireTags && selectedTagIds.length === 0) &&
    !(channel.requireTags && tags.length === 0) &&
    !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;

    const payload: {
      title: string;
      content: string;
      tagIds?: string[];
      imageUrl?: string;
    } = {
      title: title.trim(),
      content,
      tagIds: selectedTagIds.length > 0 ? selectedTagIds : undefined,
      imageUrl: coverImageUrl || undefined,
    };

    setSubmitting(true);
    setError(null);

    try {
      const post = await apiClient.createForumPost(serverId, channel.id, payload);
      onPostCreated(post);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to create post');
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, title, content, selectedTagIds, coverImageUrl, serverId, channel.id, onPostCreated, onClose]);

  // Content change handler

  const handleTextChange = useCallback((text: string) => {
    setContent(text);
  }, []);

  // Don't render when closed

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-max)] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        className={`relative flex flex-col overflow-hidden bg-[var(--bg-panel)] border border-[var(--glass-border)] ${
          isMobile
            ? 'fixed inset-0 rounded-none'
            : 'w-full max-w-2xl max-h-[85vh] rounded-2xl'
        }`}
      >
        {/* ── Header ───────────────────────────────────────── */}
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-default shrink-0">
          <ForumIcon size={18} />
          <span className="text-sm font-medium text-t-primary truncate">
            {t('forum.newPostIn', { channel: channel.name, defaultValue: `New post in #${channel.name}` })}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto flex items-center justify-center w-7 h-7 rounded-lg text-t-secondary hover:text-t-primary hover:bg-fill-hover transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* ── Scrollable body ──────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

          {/* Post Guidelines banner */}
          {channel.postGuidelines && (
            <div className="bg-[var(--accent-subtle)] border border-[var(--cyan-accent)]/[0.12] rounded-xl p-3.5">
              <button
                type="button"
                onClick={() => setGuidelinesExpanded((v) => !v)}
                className="flex items-center gap-2 w-full text-left"
              >
                <FileText size={14} className="text-[var(--cyan-accent)] shrink-0" />
                <span className="text-xs font-medium text-[var(--cyan-accent)]">
                  {t('forum.postGuidelines', 'Post guidelines')}
                </span>
                <span className="ml-auto text-[var(--cyan-accent)]/60">
                  {guidelinesExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </span>
              </button>
              {guidelinesExpanded && (
                <p className="mt-2 text-xs text-t-secondary whitespace-pre-wrap leading-relaxed">
                  {channel.postGuidelines}
                </p>
              )}
            </div>
          )}

          {/* Title input */}
          <div className="relative">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, MAX_TITLE))}
              placeholder={t('forum.postTitlePlaceholder', 'Give your post a title')}
              maxLength={MAX_TITLE}
              disabled={submitting}
              className="w-full bg-fill-hover border border-default rounded-xl px-4 py-3 text-sm text-t-primary placeholder-t-secondary focus:border-[var(--cyan-accent)]/40 focus:outline-none transition-colors disabled:opacity-50"
            />
            <span className="absolute top-3 right-3 text-[10px] text-t-secondary pointer-events-none">
              {title.length}/{MAX_TITLE}
            </span>
          </div>

          {/* Tags selector */}
          {tags.length > 0 && (
            <div>
              <div className="flex items-baseline gap-1.5 mb-1.5">
                <span className="text-xs font-medium text-t-secondary">
                  {t('forum.tags', 'Tags')}
                </span>
                {channel.requireTags && (
                  <span className="text-[10px] text-[var(--cyan-accent)]/60">
                    ({t('forum.required', 'required')})
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => {
                  const selected = selectedTagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => toggleTag(tag.id)}
                      disabled={submitting}
                      className={`px-2.5 py-1 rounded-xl text-xs cursor-pointer transition-colors ${
                        selected
                          ? 'btn-cta-selected'
                          : 'bg-fill-hover text-t-secondary border border-default hover:bg-fill-hover'
                      }`}
                    >
                      {tag.emoji && <span className="mr-1">{tag.emoji}</span>}
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tags required but none available */}
          {channel.requireTags && tags.length === 0 && (
            <div className="text-xs text-amber-400/60 bg-amber-400/[0.06] border border-amber-400/[0.12] rounded-xl p-3">
              {t('forum.noTagsWarning', 'No tags available. An admin needs to create tags first.')}
            </div>
          )}

          {/* Cover image */}
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileInputChange}
            />
            {coverImageUrl ? (
              <div className="relative rounded-xl overflow-hidden">
                <img
                  src={apiClient.resolveAssetUrl(coverImageUrl) || coverImageUrl}
                  alt="Cover"
                  className="w-full max-h-48 object-cover rounded-xl"
                />
                <button
                  type="button"
                  onClick={removeCoverImage}
                  disabled={submitting}
                  className="absolute top-2 right-2 flex items-center justify-center w-7 h-7 rounded-full bg-black/60 text-white/70 hover:text-white hover:bg-black/80 transition-colors"
                  aria-label="Remove cover image"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div
                role="button"
                tabIndex={0}
                onClick={() => fileInputRef.current?.click()}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                className="border-2 border-dashed border-[var(--glass-border)] rounded-xl p-6 text-center cursor-pointer hover:border-[var(--border-strong)] transition-colors"
              >
                {coverUploading ? (
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 size={24} className="text-t-secondary animate-spin" />
                    <span className="text-xs text-t-secondary">
                      {t('forum.uploading', 'Uploading...')}
                    </span>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-1.5">
                    <ImagePlus size={24} className="text-t-secondary" />
                    <span className="text-xs text-t-secondary">
                      {t('forum.coverImageOptional', 'Cover image (optional)')}
                    </span>
                    <span className="text-[10px] text-t-secondary">
                      {t('forum.clickOrDrag', 'Click to upload or drag and drop')}
                    </span>
                  </div>
                )}
              </div>
            )}
            {coverError && (
              <p className="mt-1.5 text-xs text-red-400">{coverError}</p>
            )}
          </div>

          {/* Message body */}
          <div>
            <span className="text-xs font-medium text-t-secondary mb-1.5 block">
              {t('forum.body', 'Body')}
            </span>
            <div className="bg-fill-hover border border-default rounded-xl px-3 py-2 min-h-[120px]">
              <LexicalChatEditor
                ref={editorRef}
                placeholder={t('forum.bodyPlaceholder', 'Write the body of your post...')}
                maxLines={12}
                disabled={submitting}
                onTextChange={handleTextChange}
                onSubmit={handleSubmit}
              />
            </div>
          </div>
        </div>

        {/* ── Footer ───────────────────────────────────────── */}
        <div className="shrink-0 border-t border-default">
          {/* Error display */}
          {error && (
            <div className="px-5 pt-3">
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}
          <div className={`flex items-center gap-3 px-5 py-4 ${isMobile ? 'flex-col' : 'justify-end'}`}>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className={`px-4 py-2 rounded-xl text-sm text-t-secondary hover:text-t-primary hover:bg-fill-hover transition-colors ${
                isMobile ? 'w-full order-2' : ''
              }`}
            >
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className={`btn-cta px-5 py-2.5 rounded-xl text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${
                isMobile ? 'w-full order-1' : ''
              }`}
            >
              {submitting ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  {t('forum.posting', 'Posting...')}
                </span>
              ) : (
                t('forum.post', 'Post')
              )}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
