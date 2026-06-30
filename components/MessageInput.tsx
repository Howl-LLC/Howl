// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useEffect, useMemo, useCallback, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Channel, Message, User, ServerSticker, CustomEmoji } from '../types';
import { Zap, ShieldCheck, Users, X, Paperclip, Smile, Sticker, ImagePlay, Plus, Code2, BarChart3, MessageCirclePlus, Hash, Volume2, Radio, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
import { ModifyAttachmentModal } from './composer/ModifyAttachmentModal';
import { useIsMobile } from '../hooks/useIsMobile';
import { useKeyboardAware } from '../hooks/useKeyboardAware';
import type { UserWithRole } from './UserProfilePopup';
import { getMentionSuggestions } from '../utils/mentionUtils';
import { $getRoot } from 'lexical';
import { apiClient } from '../services/api';
import type { LinkPreviewData } from '../services/api/linkPreview';
import { LexicalChatEditor, type LexicalChatEditorHandle, type MentionPillData, type ChannelLinkData, type CustomEmojiData, CODE_LANGUAGES } from './LexicalChatEditor';
import { SLASH_COMMANDS, type SlashCommand, type SlashCommandContext } from './lexical/SlashCommandRegistry';
const EmojiPicker = React.lazy(() => import('./EmojiPicker').then(m => ({ default: m.EmojiPicker })));
const StickerPicker = React.lazy(() => import('./StickerPicker').then(m => ({ default: m.StickerPicker })));
const GifPicker = React.lazy(() => import('./GifPicker').then(m => ({ default: m.GifPicker })));
import type { Server } from '../types';
import { useAppStore } from '../stores/appStore';

const S_TEXT_SECONDARY: React.CSSProperties = { color: 'var(--text-secondary)' };
const S_TEXT_PRIMARY: React.CSSProperties = { color: 'var(--text-primary)' };
const S_CYAN_ACCENT: React.CSSProperties = { color: 'var(--cyan-accent)' };

/** Heuristic: does this multi-line text look like pasted code? */
function looksLikeCode(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length < 3) return false;
  if (text.trimStart().startsWith('```')) return false;

  let score = 0;
  const nonEmpty = lines.filter(l => l.trim().length > 0);
  if (nonEmpty.length < 3) return false;

  for (const line of nonEmpty) {
    const trimmed = line.trimEnd();
    if (/[;{}\]):]$/.test(trimmed)) score += 2;
    if (/^\s*(import |from |export |const |let |var |function |def |class |if\s*\(|for\s*\(|while\s*\(|return |#include|package |using |pub |fn |async |await |try |catch |module |require\(|interface |type |enum )/.test(line)) score += 2;
    if (/^\s*(\/\/|\/\*|\*|#(?!!)|--|%)/.test(line)) score += 1;
    if (/^(\t| {2,})/.test(line)) score += 1;
    if (/=>|->|===|!==|\|\||&&|!=|::|\.\.\.|\+\+|--/.test(line)) score += 1;
  }

  return (score / nonEmpty.length) > 1.2;
}

function ReplyBarPortal({ docked, children }: { docked: boolean; children: React.ReactNode }) {
  if (docked) return createPortal(children, document.body);
  return <>{children}</>;
}

const EMOTICON_MAP: Record<string, string> = { ':)': '\u{1F642}', ':-)': '\u{1F642}', ':(': '\u{1F641}', ':-(': '\u{1F641}', ':D': '\u{1F604}', ':-D': '\u{1F604}', ';)': '\u{1F609}', ';-)': '\u{1F609}', ':P': '\u{1F61B}', ':-P': '\u{1F61B}', '<3': '\u{2764}\u{FE0F}', 'O:)': '\u{1F607}', '>:(': '\u{1F620}', ":'(": '\u{1F622}', ':O': '\u{1F62E}', 'B)': '\u{1F60E}', ':/': '\u{1F615}', ':-/': '\u{1F615}' };

export interface MessageInputProps {
  channel: Channel;
  users: User[];
  encrypted?: boolean;
  sendDisabled?: boolean;
  blockBanner?: string | null;
  /** Disabled-composer placeholder reason. Falls back to blockBanner when unset. */
  composerPlaceholder?: string | null;
  rateLimitBanner?: boolean;
  messageSendError?: string | null;
  onSendMessage: (content: string, replyToMessageId?: string, attachment?: { url: string; name: string; contentType?: string; width?: number | null; height?: number | null; isSpoiler?: boolean; alt?: string | null }) => void;
  onTyping?: () => void;
  uploadFile?: (file: File) => Promise<{ url: string; name: string; contentType: string; size: number; width?: number | null; height?: number | null }>;
  activeServerId?: string;
  servers?: Server[];
  userPlan?: string | null;
  zoomLevel?: number;
  replyingTo: Message | null;
  onCancelReply: () => void;
  convertEmoticons?: boolean;
  showSendBtn?: boolean;
  maxAttachmentMB: number;
  statusBarDocked?: boolean;
  onBarHeightChange?: (height: number) => void;
  dmContainerRef?: React.RefObject<HTMLDivElement | null>;
  typingUsers?: Array<{ userId: string; username: string }>;
  headerUser?: boolean;
  headerGroup?: boolean;
  isDM: boolean;
  /** When set (empty 1:1 OTR room), overrides the active-state composer placeholder
   *  with a start-this-chat invite prompt. */
  otrEmptyPlaceholder?: string;
  chatContainerRef?: React.RefObject<HTMLDivElement | null>;
  /** When true, render inline inside parent container instead of portaling to body.
   *  Used by QuickTextPanel so its MessageInput stays inside the popout card. */
  inline?: boolean;
  uiDensity: string;
  currentUserId?: string;
  canMentionEveryone?: boolean;
  onCreatePoll?: () => void;
  onCreateThread?: () => void;
  canCreatePoll?: boolean;
  canCreateThread?: boolean;
  onEditLastMessage?: () => void;
  customEmojis?: CustomEmoji[];
  onSlashCommand?: (command: string, args: Record<string, string>) => void;
  disableEmojis?: boolean;
  disableStickers?: boolean;
  disableGifs?: boolean;
}

export interface MessageInputHandle {
  attachFile: (file: File) => void;
}

export const MessageInput = React.memo(forwardRef<MessageInputHandle, MessageInputProps>(({
  channel, users, encrypted: _encrypted, sendDisabled, blockBanner, composerPlaceholder, rateLimitBanner = false, messageSendError = null,
  onSendMessage, onTyping, uploadFile, activeServerId, servers = [], userPlan, zoomLevel,
  replyingTo, onCancelReply, convertEmoticons = true, showSendBtn = false,
  maxAttachmentMB, statusBarDocked = false, onBarHeightChange, dmContainerRef,
  typingUsers = [], headerUser, headerGroup, isDM, otrEmptyPlaceholder, chatContainerRef, uiDensity: d, currentUserId, canMentionEveryone,
  onCreatePoll, onCreateThread, canCreatePoll, canCreateThread, onEditLastMessage, customEmojis = [], onSlashCommand,
  disableEmojis, disableStickers, disableGifs, inline = false,
}, ref) => {
  const { t } = useTranslation();
  const sidebarWidth = useAppStore(s => s.sidebarWidth);
  const maxMessageLength = (userPlan === 'essential' || userPlan === 'pro') ? 4000 : 2000;
  const MAX_ATTACHMENT_BYTES = maxAttachmentMB * 1024 * 1024;

  const replyBarRef = useRef<HTMLDivElement>(null);
  const fixedBarRef = useRef<HTMLDivElement>(null);
  const [containerRight, setContainerRight] = useState(0);
  const [_dmContainerLeft, setDmContainerLeft] = useState(0);
  const isMobile = useIsMobile();
  const { keyboardOpen } = useKeyboardAware(isMobile);
  // Pin composer to visual-viewport bottom when mobile keyboard is open.
  // On iOS/Android the soft keyboard shrinks the visual viewport but leaves the
  // layout viewport unchanged — a `position: fixed; bottom: 0` bar would sit
  // under the keyboard. We track `innerHeight - vv.height - vv.offsetTop` and
  // raise the bar by that amount. Desktop (>=768px) is a no-op.
  const [vvBottomInset, setVvBottomInset] = useState(0);
  useEffect(() => {
    if (!isMobile || !keyboardOpen) { setVvBottomInset(0); return; }
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
        setVvBottomInset(inset);
      });
    };
    update();
    vv.addEventListener('resize', update, { passive: true });
    vv.addEventListener('scroll', update, { passive: true });
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      cancelAnimationFrame(raf);
    };
  }, [isMobile, keyboardOpen]);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const plusMenuPortalRef = useRef<HTMLDivElement>(null);

  const shouldPortalReplyBar = !inline;

  useEffect(() => {
    if (!shouldPortalReplyBar) return;
    const el = chatContainerRef?.current;
    if (!el) return;
    const measure = () => setContainerRight(el.getBoundingClientRect().right);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [shouldPortalReplyBar, chatContainerRef]);

  useEffect(() => {
    if (!shouldPortalReplyBar) { onBarHeightChange?.(0); return; }
    // Measure the full fixed container (status bar + input + padding),
    // not just the input portion, so the spacer fully clears the overlay.
    const el = fixedBarRef.current;
    if (!el) return;
    const measure = () => {
      onBarHeightChange?.(el.getBoundingClientRect().height);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shouldPortalReplyBar, onBarHeightChange]);

  useEffect(() => {
    if (!isDM || !dmContainerRef?.current) { setDmContainerLeft(0); return; }
    const el = dmContainerRef.current;
    const measure = () => setDmContainerLeft(el.getBoundingClientRect().left);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [isDM, dmContainerRef]);

  const [inputValue, setInputValue] = useState('');
  const editorRef = useRef<LexicalChatEditorHandle>(null);

  // Draft Persistence
  const DRAFT_KEY_PREFIX = 'howl:draft:';
  const DRAFT_MAX_SIZE = 10240;
  const saveDraftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (saveDraftTimerRef.current) clearTimeout(saveDraftTimerRef.current);
    const channelId = channel.id;
    saveDraftTimerRef.current = setTimeout(() => {
      try {
        if (inputValue && inputValue.length <= DRAFT_MAX_SIZE) {
          localStorage.setItem(DRAFT_KEY_PREFIX + channelId, inputValue);
        } else if (!inputValue) {
          localStorage.removeItem(DRAFT_KEY_PREFIX + channelId);
        }
      } catch { /* localStorage full or unavailable */ }
    }, 500);
    return () => { if (saveDraftTimerRef.current) clearTimeout(saveDraftTimerRef.current); };
  }, [inputValue, channel.id]);

  const prevChannelIdRef = useRef(channel.id);
  useEffect(() => {
    if (channel.id === prevChannelIdRef.current) return;
    prevChannelIdRef.current = channel.id;
    try {
      const draft = localStorage.getItem(DRAFT_KEY_PREFIX + channel.id);
      if (draft) {
        editorRef.current?.setTextContent(draft);
      } else {
        editorRef.current?.clear();
      }
    } catch { /* silently skip */ }
    setLinkPreviews(new Map());
    fetchedUrlsRef.current.clear();
    setDismissedUrls(new Set());
    // Reset all autocomplete/slash state to prevent stale popups in the new channel
    setMentionOpen(false);
    setChannelOpen(false);
    setEmojiAutoOpen(false);
    setSlashOpen(false);
    setCodeBlockOpen(false);
    setSelectedCommand(null);
    // Clear pending attachment so it doesn't attach to the wrong channel
    setPendingAttachment(null);
    setPendingAttachmentPreview(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
  }, [channel.id]);

  // Restore draft on initial mount
  useEffect(() => {
    try {
      const draft = localStorage.getItem(DRAFT_KEY_PREFIX + channel.id);
      if (draft) {
        requestAnimationFrame(() => editorRef.current?.setTextContent(draft));
      }
    } catch { /* localStorage unavailable */ }
  }, []); // mount-only: restore draft for initial channel

  const fileInputRef = useRef<HTMLInputElement>(null);
  const sendingRef = useRef(false);
  const lastSendRef = useRef(0);
  const MIN_SEND_INTERVAL = 500; // ms — client-side rate limit to prevent accidental double-sends
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const stickerButtonRef = useRef<HTMLButtonElement>(null);
  const [stickerOpen, setStickerOpen] = useState(false);
  const gifButtonRef = useRef<HTMLButtonElement>(null);
  const [gifOpen, setGifOpen] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<{ url: string; name: string; contentType?: string; width?: number | null; height?: number | null } | null>(null);
  const [pendingAttachmentPreview, setPendingAttachmentPreview] = useState<string | null>(null);
  const [pendingAttachmentIsSpoiler, setPendingAttachmentIsSpoiler] = useState(false);
  const [pendingAttachmentAlt, setPendingAttachmentAlt] = useState<string>('');
  const [modifyModalOpen, setModifyModalOpen] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showTextFilePrompt, setShowTextFilePrompt] = useState(false);
  const [showCodePasteSuggestion, setShowCodePasteSuggestion] = useState(false);
  const pendingCodePasteRef = useRef<boolean>(false);

  // Link Previews
  const URL_REGEX = /https?:\/\/[^\s<>"]+/g;
  const [linkPreviews, setLinkPreviews] = useState<Map<string, LinkPreviewData>>(new Map());
  const [dismissedUrls, setDismissedUrls] = useState<Set<string>>(new Set());
  const previewFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchedUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (previewFetchTimerRef.current) clearTimeout(previewFetchTimerRef.current);
    const urls = [...inputValue.matchAll(URL_REGEX)].map(m => m[0]);
    const newUrls = urls.filter(u => !fetchedUrlsRef.current.has(u) && !dismissedUrls.has(u));
    if (newUrls.length === 0) return;
    const toFetch = newUrls.slice(0, 3);
    previewFetchTimerRef.current = setTimeout(async () => {
      for (const url of toFetch) {
        if (fetchedUrlsRef.current.has(url)) continue;
        fetchedUrlsRef.current.add(url);
        try {
          const preview = await apiClient.getLinkPreview(url);
          if (preview) setLinkPreviews(prev => new Map(prev).set(url, preview));
        } catch { /* silently skip */ }
      }
    }, 800);
    return () => { if (previewFetchTimerRef.current) clearTimeout(previewFetchTimerRef.current); };
  }, [inputValue, dismissedUrls]);

  useImperativeHandle(ref, () => ({
    attachFile: (file: File) => {
      if (!uploadFile || uploading || sendDisabled || pendingAttachment) return;
      uploadAndAttach(file);
    },
  }), [uploadFile, uploading, sendDisabled, pendingAttachment]);

  // Close plus menu on outside click
  useEffect(() => {
    if (!plusMenuOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        plusMenuRef.current && !plusMenuRef.current.contains(target) &&
        (!plusMenuPortalRef.current || !plusMenuPortalRef.current.contains(target))
      ) {
        setPlusMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [plusMenuOpen]);

  const showPlusButton = !!uploadFile || (!!canCreatePoll && !!onCreatePoll) || (!!canCreateThread && !!onCreateThread);

  // Revoke blob URL on unmount to prevent memory leaks
  useEffect(() => () => { if (pendingAttachmentPreview) URL.revokeObjectURL(pendingAttachmentPreview); }, [pendingAttachmentPreview]);

  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStartPos, setMentionStartPos] = useState(0);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const roles = useMemo(() => isDM ? undefined : [...new Set(users.map((u) => (u as UserWithRole).role).filter(Boolean))] as string[] | undefined, [isDM, users]);
  const showEveryoneHere = canMentionEveryone !== false && (!headerUser || !!headerGroup);
  const mentionSuggestions = useMemo(() => {
    if (!mentionOpen) return [];
    return getMentionSuggestions(mentionQuery, users, {
      roles,
      showEveryone: showEveryoneHere,
      showHere: showEveryoneHere,
    });
  }, [mentionOpen, mentionQuery, users, roles, showEveryoneHere]);

  const lastTypingEmitRef = useRef(0);

  const BLOCKED_EXTENSIONS = /\.(exe|bat|cmd|com|scr|pif|msi|vbs|vbe|js|jse|wsf|wsh|ps1|reg|cpl|hta|inf|lnk)$/i;

  const uploadAndAttach = (file: File) => {
    if (!uploadFile) return;
    setUploadError(null);
    if (BLOCKED_EXTENSIONS.test(file.name)) {
      setUploadError(t('chat.fileTypeNotAllowed', 'This file type is not allowed.'));
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setUploadError(t('chat.fileMustBeUnder', { maxMB: maxAttachmentMB, upgradeMessage: !userPlan ? t('chat.upgradeForLargerUploads') : '' }));
      return;
    }
    if (file.type.startsWith('image/')) {
      const objectUrl = URL.createObjectURL(file);
      setPendingAttachmentPreview(objectUrl);
    }
    setUploading(true);
    uploadFile(file)
      .then((res) => setPendingAttachment({ url: res.url, name: res.name, contentType: res.contentType, width: res.width, height: res.height }))
      .catch((err) => {
        setUploadError(err instanceof Error ? err.message : t('chat.uploadFailed'));
        setPendingAttachmentPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
      })
      .finally(() => setUploading(false));
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !uploadFile) return;
    uploadAndAttach(file);
  };

  const handleFormatAsCode = () => {
    setShowCodePasteSuggestion(false);
    pendingCodePasteRef.current = false;
    const trimmed = inputValue.trimEnd();
    const wrapped = `\`\`\`\n${trimmed}\n\`\`\``;
    editorRef.current?.setTextContent(wrapped);
    requestAnimationFrame(() => editorRef.current?.focus());
  };

  const handleDismissCodePaste = () => {
    setShowCodePasteSuggestion(false);
    pendingCodePasteRef.current = false;
  };

  // Slash & code block open state declared early for mutual exclusion in callbacks below
  const [slashOpen, setSlashOpen] = useState(false);
  const [codeBlockOpen, setCodeBlockOpen] = useState(false);

  // Lexical Editor Callbacks
  const handleEditorTextChange = useCallback((text: string) => {
    setInputValue(text);
    if (onTyping && text.trim()) {
      const now = Date.now();
      if (now - lastTypingEmitRef.current > 2500) {
        lastTypingEmitRef.current = now;
        onTyping();
      }
    }
  }, [onTyping]);

  const handleMentionQuery = useCallback((query: string, startPos: number) => {
    if (slashOpen || codeBlockOpen) return;
    setMentionStartPos(startPos);
    setMentionQuery(query);
    setMentionOpen(true);
    setSelectedMentionIndex(0);
  }, [slashOpen, codeBlockOpen]);

  const handleMentionDismiss = useCallback(() => {
    setMentionOpen(false);
  }, []);

  const insertMentionPill = useCallback((suggestion: typeof mentionSuggestions[0]) => {
    const mentionName = suggestion.value.startsWith('@') ? suggestion.value.slice(1) : suggestion.value;
    const needsWrap = mentionName.includes(' ') && !['everyone', 'here'].includes(mentionName.toLowerCase());
    const mentionText = needsWrap ? `@<${mentionName}>` : suggestion.value;
    const user = users.find(u => u.id === suggestion.userId);
    const pillData: MentionPillData = {
      mentionText,
      displayName: mentionName,
      mentionType: suggestion.type,
      userId: suggestion.userId,
      roleColor: (user as UserWithRole)?.roleColor ?? null,
      avatar: user?.avatar ?? null,
    };
    editorRef.current?.insertMentionPill(pillData, mentionStartPos);
    setMentionOpen(false);
  }, [users, mentionStartPos]);

  const handleMentionKeyDown = useCallback((key: string): boolean => {
    if (!mentionOpen || mentionSuggestions.length === 0) return false;
    if (key === 'ArrowDown') {
      setSelectedMentionIndex((i) => (i + 1) % mentionSuggestions.length);
      return true;
    }
    if (key === 'ArrowUp') {
      setSelectedMentionIndex((i) => (i - 1 + mentionSuggestions.length) % mentionSuggestions.length);
      return true;
    }
    if (key === 'Enter' || key === 'Tab') {
      const suggestion = mentionSuggestions[selectedMentionIndex];
      if (suggestion) insertMentionPill(suggestion);
      return true;
    }
    if (key === 'Escape') {
      setMentionOpen(false);
      return true;
    }
    return false;
  }, [mentionOpen, mentionSuggestions, selectedMentionIndex, insertMentionPill]);

  // Channel Autocomplete
  const [channelOpen, setChannelOpen] = useState(false);
  const [channelQuery, setChannelQuery] = useState('');
  const [channelStartPos, setChannelStartPos] = useState(0);
  const [selectedChannelIndex, setSelectedChannelIndex] = useState(0);

  const activeServerChannels = useMemo(() => {
    if (!activeServerId || !servers?.length) return [];
    const server = servers.find(s => s.id === activeServerId);
    return server?.channels ?? [];
  }, [activeServerId, servers]);

  const channelSuggestions = useMemo(() => {
    if (!channelOpen) return [];
    const q = channelQuery.toLowerCase();
    return activeServerChannels.filter(c => !q || c.name.toLowerCase().includes(q)).slice(0, 10);
  }, [channelOpen, channelQuery, activeServerChannels]);

  const handleChannelQuery = useCallback((query: string, startPos: number) => {
    if (mentionOpen || slashOpen || codeBlockOpen) return; // don't overlap
    setChannelStartPos(startPos);
    setChannelQuery(query);
    setChannelOpen(true);
    setSelectedChannelIndex(0);
  }, [mentionOpen, slashOpen, codeBlockOpen]);

  const handleChannelDismiss = useCallback(() => {
    setChannelOpen(false);
  }, []);

  const insertChannelPill = useCallback((ch: Channel) => {
    const pillData: ChannelLinkData = { channelId: ch.id, channelName: ch.name, channelType: ch.type };
    editorRef.current?.insertChannelPill(pillData, channelStartPos);
    setChannelOpen(false);
  }, [channelStartPos]);

  const handleChannelKeyDown = useCallback((key: string): boolean => {
    if (!channelOpen || channelSuggestions.length === 0) return false;
    if (key === 'ArrowDown') { setSelectedChannelIndex(i => (i + 1) % channelSuggestions.length); return true; }
    if (key === 'ArrowUp') { setSelectedChannelIndex(i => (i - 1 + channelSuggestions.length) % channelSuggestions.length); return true; }
    if (key === 'Enter' || key === 'Tab') { insertChannelPill(channelSuggestions[selectedChannelIndex]); return true; }
    if (key === 'Escape') { setChannelOpen(false); return true; }
    return false;
  }, [channelOpen, channelSuggestions, selectedChannelIndex, insertChannelPill]);

  // Emoji Autocomplete
  const [emojiAutoOpen, setEmojiAutoOpen] = useState(false);
  const [emojiAutoQuery, setEmojiAutoQuery] = useState('');
  const [emojiAutoStartPos, setEmojiAutoStartPos] = useState(0);
  const [selectedEmojiAutoIndex, setSelectedEmojiAutoIndex] = useState(0);

  const emojiAutoSuggestions = useMemo(() => {
    if (!emojiAutoOpen || !customEmojis.length) return [];
    const q = emojiAutoQuery.toLowerCase();
    return customEmojis.filter(e => e.name.toLowerCase().includes(q)).slice(0, 10);
  }, [emojiAutoOpen, emojiAutoQuery, customEmojis]);

  const handleEmojiQuery = useCallback((query: string, startPos: number) => {
    if (mentionOpen || channelOpen || slashOpen || codeBlockOpen) return; // don't overlap
    setEmojiAutoStartPos(startPos);
    setEmojiAutoQuery(query);
    setEmojiAutoOpen(true);
    setSelectedEmojiAutoIndex(0);
  }, [mentionOpen, channelOpen, slashOpen, codeBlockOpen]);

  const handleEmojiDismiss = useCallback(() => {
    setEmojiAutoOpen(false);
  }, []);

  const insertCustomEmoji = useCallback((emoji: CustomEmoji) => {
    const emojiData: CustomEmojiData = { emojiId: emoji.id, name: emoji.name, imageUrl: emoji.imageUrl, serverId: emoji.serverId };
    editorRef.current?.insertCustomEmoji(emojiData, emojiAutoStartPos);
    setEmojiAutoOpen(false);
  }, [emojiAutoStartPos]);

  const handleEmojiKeyDown = useCallback((key: string): boolean => {
    if (!emojiAutoOpen || emojiAutoSuggestions.length === 0) return false;
    if (key === 'ArrowDown') { setSelectedEmojiAutoIndex(i => (i + 1) % emojiAutoSuggestions.length); return true; }
    if (key === 'ArrowUp') { setSelectedEmojiAutoIndex(i => (i - 1 + emojiAutoSuggestions.length) % emojiAutoSuggestions.length); return true; }
    if (key === 'Enter' || key === 'Tab') { insertCustomEmoji(emojiAutoSuggestions[selectedEmojiAutoIndex]); return true; }
    if (key === 'Escape') { setEmojiAutoOpen(false); return true; }
    return false;
  }, [emojiAutoOpen, emojiAutoSuggestions, selectedEmojiAutoIndex, insertCustomEmoji]);

  // Code Block Language Selector
  const [codeBlockQuery, setCodeBlockQuery] = useState('');
  const [selectedCodeBlockIndex, setSelectedCodeBlockIndex] = useState(0);

  const codeBlockSuggestions = useMemo(() => {
    if (!codeBlockOpen) return [];
    const q = codeBlockQuery.toLowerCase().trim();
    if (!q) return CODE_LANGUAGES.slice(0, 15);
    return CODE_LANGUAGES.filter(lang =>
      lang.name.toLowerCase().startsWith(q) || lang.value.startsWith(q) || lang.aliases.some(a => a.startsWith(q))
    ).slice(0, 10);
  }, [codeBlockOpen, codeBlockQuery]);

  const handleCodeBlockQuery = useCallback((query: string) => {
    if (mentionOpen || channelOpen || emojiAutoOpen || slashOpen) return;
    setCodeBlockQuery(query);
    if (!codeBlockOpen) { setCodeBlockOpen(true); setSelectedCodeBlockIndex(0); }
  }, [mentionOpen, channelOpen, emojiAutoOpen, slashOpen, codeBlockOpen]);

  const handleCodeBlockDismiss = useCallback(() => { setCodeBlockOpen(false); }, []);

  const handleCodeBlockSelect = useCallback((lang: { value: string }) => {
    editorRef.current?.setTextContent(`\`\`\`${lang.value}\n\n\`\`\``);
    const editor = editorRef.current?.getEditor();
    if (editor) {
      setTimeout(() => {
        editor.update(() => {
          const root = $getRoot();
          const secondPara = root.getChildAtIndex(1);
          if (secondPara) secondPara.selectStart();
        });
      }, 0);
    }
    setCodeBlockOpen(false);
  }, []);

  const handleCodeBlockKeyDown = useCallback((key: string): boolean => {
    if (!codeBlockOpen || codeBlockSuggestions.length === 0) {
      // No suggestions but code block trigger active — Enter inserts plain code block
      if (key === 'Enter' && codeBlockOpen) {
        editorRef.current?.setTextContent('```\n\n```');
        const editor = editorRef.current?.getEditor();
        if (editor) { setTimeout(() => { if (!editor.getRootElement()) return; editor.update(() => { const root = $getRoot(); const p = root.getChildAtIndex(1); if (p) p.selectStart(); }); }, 0); }
        setCodeBlockOpen(false);
        return true;
      }
      if (key === 'Escape') { setCodeBlockOpen(false); return true; }
      return false;
    }
    if (key === 'ArrowDown') { setSelectedCodeBlockIndex(i => (i + 1) % codeBlockSuggestions.length); return true; }
    if (key === 'ArrowUp') { setSelectedCodeBlockIndex(i => (i - 1 + codeBlockSuggestions.length) % codeBlockSuggestions.length); return true; }
    if (key === 'Tab' || key === 'Enter') { handleCodeBlockSelect(codeBlockSuggestions[selectedCodeBlockIndex]); return true; }
    if (key === 'Escape') { setCodeBlockOpen(false); return true; }
    return false;
  }, [codeBlockOpen, codeBlockSuggestions, selectedCodeBlockIndex, handleCodeBlockSelect]);

  // Slash Command Autocomplete
  const [slashQuery, setSlashQuery] = useState('');
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [selectedCommand, setSelectedCommand] = useState<SlashCommand | null>(null);

  const slashSuggestions = useMemo(() => {
    if (!slashOpen || selectedCommand) return [];
    const q = slashQuery.split(' ')[0]?.toLowerCase() ?? '';
    return SLASH_COMMANDS.filter(cmd => {
      if (cmd.serverOnly && isDM) return false;
      return cmd.name.startsWith(q) || cmd.name.includes(q);
    });
  }, [slashOpen, slashQuery, selectedCommand, isDM]);

  const handleSlashQuery = useCallback((query: string) => {
    if (mentionOpen || channelOpen || emojiAutoOpen || codeBlockOpen) return;
    setSlashQuery(query);
    if (!slashOpen) {
      setSlashOpen(true);
      setSelectedSlashIndex(0);
      setSelectedCommand(null);
    }
  }, [mentionOpen, channelOpen, emojiAutoOpen, codeBlockOpen, slashOpen]);

  const handleSlashDismiss = useCallback(() => {
    setSlashOpen(false);
    setSelectedCommand(null);
  }, []);

  /** Direct send for slash commands — reads text from editor synchronously, bypasses handleSubmit RAF timing. */
  const slashSend = useCallback(() => {
    const content = editorRef.current?.getTextContent()?.trim();
    if (!content) return;
    onSendMessage(content, replyingTo?.id, pendingAttachment ? { ...pendingAttachment, isSpoiler: pendingAttachmentIsSpoiler, alt: pendingAttachmentAlt || null } : undefined);
    editorRef.current?.clear();
    try { localStorage.removeItem(DRAFT_KEY_PREFIX + channel.id); } catch { /* ignore */ }
    setPendingAttachment(null);
    setPendingAttachmentIsSpoiler(false);
    setPendingAttachmentAlt('');
    if (pendingAttachmentPreview) { URL.revokeObjectURL(pendingAttachmentPreview); setPendingAttachmentPreview(null); }
    onCancelReply();
    setLinkPreviews(new Map());
    fetchedUrlsRef.current.clear();
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [onSendMessage, replyingTo?.id, pendingAttachment, pendingAttachmentIsSpoiler, pendingAttachmentAlt, pendingAttachmentPreview, onCancelReply, channel.id]);

  const handleSlashSelect = useCallback((cmd: SlashCommand) => {
    const context: SlashCommandContext = {
      editorRef,
      onSendMessage: (content) => onSendMessage(content, replyingTo?.id),
      onCreatePoll,
      onCreateThread,
      onSlashCommand,
      activeServerId,
      isDM,
    };

    const allArgsOptional = cmd.args.length > 0 && cmd.args.every(a => !a.required);
    if (cmd.immediate || cmd.args.length === 0 || allArgsOptional) {
      if (cmd.action) {
        cmd.action({}, context);
        editorRef.current?.clear();
        setSlashOpen(false);
        setSelectedCommand(null);
        setPendingAttachment(null);
        setPendingAttachmentIsSpoiler(false);
        setPendingAttachmentAlt('');
        if (pendingAttachmentPreview) { URL.revokeObjectURL(pendingAttachmentPreview); setPendingAttachmentPreview(null); }
      } else if (cmd.execute) {
        const result = cmd.execute({}, context);
        if (result === 'send') {
          // Defer send — execute() calls editor.update() which is queued inside Lexical command handlers.
          // slashSend() must wait for the update to apply before reading the editor content.
          setTimeout(() => slashSend(), 0);
        } else if (result === 'clear') {
          editorRef.current?.clear();
        }
        setSlashOpen(false);
        setSelectedCommand(null);
      }
      return;
    }

    // Command with args — enter arg mode
    setSelectedCommand(cmd);
    editorRef.current?.setTextContent(`/${cmd.name} `);
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [onSendMessage, replyingTo?.id, onCreatePoll, onCreateThread, onSlashCommand, activeServerId, isDM, slashSend]);

  const handleSlashArgExecute = useCallback(() => {
    if (!selectedCommand) return false;
    const afterCommand = inputValue.slice(selectedCommand.name.length + 2); // skip "/name "
    const argTokens = afterCommand.split(/\s+/).filter(Boolean);
    const args: Record<string, string> = {};

    for (let i = 0; i < selectedCommand.args.length; i++) {
      const argDef = selectedCommand.args[i];
      if (i === selectedCommand.args.length - 1 && argDef.type === 'string') {
        args[argDef.name] = argTokens.slice(i).join(' ');
      } else {
        args[argDef.name] = argTokens[i] ?? '';
      }
    }

    for (const argDef of selectedCommand.args) {
      if (argDef.required && !args[argDef.name]) return false;
    }

    const context: SlashCommandContext = {
      editorRef,
      onSendMessage: (content) => onSendMessage(content, replyingTo?.id),
      onCreatePoll,
      onCreateThread,
      onSlashCommand,
      activeServerId,
      isDM,
    };

    if (selectedCommand.action) {
      selectedCommand.action(args, context);
      editorRef.current?.clear();
    } else if (selectedCommand.execute) {
      const result = selectedCommand.execute(args, context);
      if (result === 'send') {
        setTimeout(() => slashSend(), 0);
      } else if (result === 'clear') {
        editorRef.current?.clear();
      }
    }
    setSelectedCommand(null);
    setSlashOpen(false);
    return true;
  }, [selectedCommand, inputValue, onSendMessage, replyingTo?.id, onCreatePoll, onCreateThread, onSlashCommand, activeServerId, isDM, slashSend]);

  // Slash Arg Sub-Autocomplete
  const [selectedSubIndex, setSelectedSubIndex] = useState(0);

  const currentArgIndex = useMemo(() => {
    if (!selectedCommand) return -1;
    const afterCmd = inputValue.slice(selectedCommand.name.length + 2);
    const tokens = afterCmd.split(/\s+/);
    return Math.min(Math.max(tokens.length - 1, 0), selectedCommand.args.length - 1);
  }, [selectedCommand, inputValue]);

  const currentArgDef = selectedCommand?.args[currentArgIndex] ?? null;

  const slashArgQuery = useMemo(() => {
    if (!currentArgDef || !selectedCommand) return '';
    const afterCmd = inputValue.slice(selectedCommand.name.length + 2);
    const tokens = afterCmd.split(/\s+/);
    return tokens[currentArgIndex] ?? '';
  }, [currentArgDef, selectedCommand, inputValue, currentArgIndex]);

  const slashArgUserSuggestions = useMemo(() => {
    if (!currentArgDef || currentArgDef.type !== 'user' || !slashArgQuery) return [];
    return getMentionSuggestions(slashArgQuery, users, { roles: undefined, showEveryone: false, showHere: false })
      .filter(s => s.type === 'user').slice(0, 8);
  }, [currentArgDef, slashArgQuery, users]);

  const slashArgChannelSuggestions = useMemo(() => {
    if (!currentArgDef || currentArgDef.type !== 'channel' || !slashArgQuery) return [];
    return activeServerChannels.filter(c => c.name.toLowerCase().includes(slashArgQuery.toLowerCase())).slice(0, 8);
  }, [currentArgDef, slashArgQuery, activeServerChannels]);

  const subSuggestions = slashArgUserSuggestions.length > 0 ? slashArgUserSuggestions : slashArgChannelSuggestions;
  const hasSubAutocomplete = subSuggestions.length > 0;

  useEffect(() => { setSelectedSubIndex(0); }, [currentArgIndex, slashArgQuery]);

  const insertSlashArgValue = useCallback((value: string) => {
    if (!selectedCommand) return;
    const afterCmd = inputValue.slice(selectedCommand.name.length + 2);
    const tokens = afterCmd.split(/\s+/).filter(Boolean);
    // Replace current arg token(s) — preserve tokens before currentArgIndex, replace from currentArgIndex onward
    const before = tokens.slice(0, currentArgIndex);
    const newText = `/${selectedCommand.name} ${[...before, value].join(' ')} `;
    editorRef.current?.setTextContent(newText);
    requestAnimationFrame(() => editorRef.current?.focus());
    setSelectedSubIndex(0);
  }, [selectedCommand, inputValue, currentArgIndex]);

  const handleSlashKeyDown = useCallback((key: string): boolean => {
    // Sub-autocomplete takes priority in arg mode
    if (selectedCommand && hasSubAutocomplete) {
      if (key === 'ArrowDown') { setSelectedSubIndex(i => (i + 1) % subSuggestions.length); return true; }
      if (key === 'ArrowUp') { setSelectedSubIndex(i => (i - 1 + subSuggestions.length) % subSuggestions.length); return true; }
      if (key === 'Tab') {
        const s = subSuggestions[selectedSubIndex];
        if (s) insertSlashArgValue('label' in s ? (s as { label: string }).label : (s as { name: string }).name);
        return true;
      }
      if (key === 'Enter') {
        const s = subSuggestions[selectedSubIndex];
        if (s) { insertSlashArgValue('label' in s ? (s as { label: string }).label : (s as { name: string }).name); return true; }
      }
      if (key === 'Escape') { setSlashOpen(false); setSelectedCommand(null); return true; }
      return false;
    }
    // In arg mode without sub-autocomplete, Enter executes
    if (selectedCommand) {
      if (key === 'Enter') return handleSlashArgExecute();
      if (key === 'Escape') { setSlashOpen(false); setSelectedCommand(null); return true; }
      return false;
    }
    if (!slashOpen) return false;
    if (slashSuggestions.length === 0) {
      if (key === 'Escape') { setSlashOpen(false); return true; }
      return false;
    }
    if (key === 'ArrowDown') { setSelectedSlashIndex(i => (i + 1) % slashSuggestions.length); return true; }
    if (key === 'ArrowUp') { setSelectedSlashIndex(i => (i - 1 + slashSuggestions.length) % slashSuggestions.length); return true; }
    if (key === 'Tab' || key === 'Enter') { handleSlashSelect(slashSuggestions[selectedSlashIndex]); return true; }
    if (key === 'Escape') { setSlashOpen(false); return true; }
    return false;
  }, [slashOpen, slashSuggestions, selectedSlashIndex, selectedCommand, handleSlashSelect, handleSlashArgExecute, hasSubAutocomplete, subSuggestions, selectedSubIndex, insertSlashArgValue]);

  const handleSubmitRef = useRef<(e: React.FormEvent) => void>(() => {});
  const handleEditorSubmit = useCallback(() => {
    handleSubmitRef.current({ preventDefault: () => {} } as React.FormEvent);
  }, []);

  useEffect(() => {
    if (inputValue.length <= maxMessageLength) setShowTextFilePrompt(false);
  }, [inputValue, maxMessageLength]);

  // Auto-dismiss code paste suggestion after 8 seconds or if input is cleared
  useEffect(() => {
    if (!showCodePasteSuggestion) return;
    if (!inputValue.trim()) {
      setShowCodePasteSuggestion(false);
      pendingCodePasteRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      setShowCodePasteSuggestion(false);
      pendingCodePasteRef.current = false;
    }, 8000);
    return () => clearTimeout(timer);
  }, [showCodePasteSuggestion, inputValue]);

  const handleUploadAsTextFile = async () => {
    if (!uploadFile) return;
    setShowTextFilePrompt(false);
    const blob = new Blob([inputValue], { type: 'text/plain' });
    const file = new File([blob], 'message.txt', { type: 'text/plain' });
    try {
      setUploading(true);
      const res = await uploadFile(file);
      onSendMessage('(attachment)', replyingTo?.id, {
        url: res.url,
        name: res.name,
        contentType: res.contentType,
        width: null,
        height: null,
      });
      editorRef.current?.clear();
      try { localStorage.removeItem(DRAFT_KEY_PREFIX + channel.id); } catch { /* ignore */ }
      onCancelReply();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : t('chat.uploadFailed'));
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (sendingRef.current) return;
    if (uploading) return; // Block send while file is uploading
    const now = Date.now();
    if (now - lastSendRef.current < MIN_SEND_INTERVAL) return;
    lastSendRef.current = now;
    const hasText = !!inputValue.trim();
    const hasAttachment = !!pendingAttachment;
    if (!hasText && !hasAttachment) return;
    if (mentionOpen || channelOpen || emojiAutoOpen || codeBlockOpen) return;
    if (inputValue.length > maxMessageLength) {
      setShowTextFilePrompt(true);
      return;
    }
    sendingRef.current = true;
    let content = inputValue.trim();
    if (convertEmoticons && hasText) {
      // Split on code spans to avoid converting emoticons inside backticks
      const parts = content.split(/(`[^`]*`)/);
      content = parts.map((part, i) =>
        i % 2 === 1 ? part : part.replace(/(?<!\w)([:;B><O][-']?[)D(P/O]|<3|O:\))(?!\w)/g, (m) => EMOTICON_MAP[m] ?? m)
      ).join('');
    }
    onSendMessage(content, replyingTo?.id, pendingAttachment ? { ...pendingAttachment, isSpoiler: pendingAttachmentIsSpoiler, alt: pendingAttachmentAlt || null } : undefined);
    editorRef.current?.clear();
    try { localStorage.removeItem(DRAFT_KEY_PREFIX + channel.id); } catch { /* ignore */ }
    requestAnimationFrame(() => editorRef.current?.focus());
    setPendingAttachment(null);
    setPendingAttachmentIsSpoiler(false);
    setPendingAttachmentAlt('');
    if (pendingAttachmentPreview) { URL.revokeObjectURL(pendingAttachmentPreview); setPendingAttachmentPreview(null); }
    setUploadError(null);
    onCancelReply();
    setMentionOpen(false);
    setLinkPreviews(new Map());
    fetchedUrlsRef.current.clear();
    setDismissedUrls(new Set());
    queueMicrotask(() => { sendingRef.current = false; });
  };
  handleSubmitRef.current = handleSubmit;

  return (
    <>
      <ReplyBarPortal docked={shouldPortalReplyBar}>
      <div
        ref={fixedBarRef}
        className="shrink-0"
        style={{
          contain: 'layout style',
          padding: statusBarDocked
            ? (d === 'compact' ? '4px 0 8px 8px' : d === 'spacious' ? '6px 0 14px 14px' : '5px 0 10px 10px')
            : (d === 'compact' ? '4px 8px 8px' : d === 'spacious' ? '6px 14px 14px' : '5px 10px 10px'),
          // Mobile-only: small bottom padding (safe-area handled by MobileSidebar tab bar).
          ...(isMobile ? { paddingBottom: '8px' } : {}),
          transition: 'padding 0.45s cubic-bezier(0.34, 1.56, 0.64, 1)',
          display: 'flex',
          alignItems: 'flex-end',
          ...(shouldPortalReplyBar ? {
            position: 'fixed' as const,
            bottom: isMobile && vvBottomInset === 0
              ? 'var(--mobile-tab-bar-height, env(safe-area-inset-bottom, 0px))'
              : vvBottomInset,
            left: isMobile ? 0 : (statusBarDocked ? 0 : (sidebarWidth ?? 0)),
            zIndex: 'var(--z-dropdown)' as unknown as number,
            ...(containerRight > 0 ? { width: containerRight - (isMobile ? 0 : (statusBarDocked ? 0 : (sidebarWidth ?? 0))) } : {}),
          } : {
            position: 'relative' as const,
            zIndex: 'var(--z-dropdown)' as unknown as number,
          }),
        }}
      >
        {/* Status portal — own glass element, never grows */}
        {statusBarDocked && (
          <div
            style={{
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              alignSelf: 'flex-end',
              minHeight: 62,
              backgroundColor: 'var(--bg-statusbar)',
              backdropFilter: 'blur(24px) saturate(1.1)',
              WebkitBackdropFilter: 'blur(24px) saturate(1.1)',
              borderRadius: '12px 0 0 12px',
              borderTop: '1px solid var(--border-subtle)',
              borderBottom: '1px solid var(--border-subtle)',
              borderLeft: '1px solid var(--border-subtle)',
              borderRight: 'none',
              boxShadow: '0 4px 6px -1px rgba(0,0,0,0.12), 0 24px 48px -12px rgba(0,0,0,0.2)',
            } as React.CSSProperties}
          >
            <div id="docked-status-portal" style={{ display: 'flex', alignItems: 'center' }} />
          </div>
        )}
        {/* Measuring wrapper for spacer height */}
        <div ref={replyBarRef} style={{ flex: '1 1 0%', minWidth: 0 }}>
          {/* Typing indicator — flow-positioned above the glass so it claims
              its own vertical space. Because it lives inside fixedBarRef, its
              height is folded into onBarHeightChange → the Virtuoso footer
              grows → the last message scrolls up out of the way instead of
              being overlaid.

              The container is ALWAYS rendered (even when nobody is typing) so
              its height is permanently reserved — without that, the chat area
              jitters up/down every time a typing event starts or stops. The
              dots + text fade in/out via opacity inside the reserved slot. */}
          <div
            className="pointer-events-none flex items-center gap-1.5 text-[11px] px-5 pb-1"
            style={{
              color: 'var(--text-secondary)',
              // Matches the rendered height of the active indicator
              // (text-[11px] line-height ≈ 16px + pb-1 4px = 20px). Keeping
              // it pinned avoids a 20px shift in the chat list every time a
              // typing-state event flips.
              minHeight: 20,
              opacity: typingUsers.length > 0 ? 1 : 0,
              transition: 'opacity 120ms ease-out',
            }}
            aria-hidden={typingUsers.length === 0}
          >
            {typingUsers.length > 0 && (
              <>
                <span className="flex gap-0.5">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </span>
                <span className="min-w-0 truncate" style={S_TEXT_PRIMARY}>
                  {typingUsers.length === 1
                    ? t('chat.typingOne', { user: typingUsers[0].username })
                    : typingUsers.length === 2
                      ? t('chat.typingTwo', { user1: typingUsers[0].username, user2: typingUsers[1].username })
                      : typingUsers.length === 3
                        ? t('chat.typingThree', { user1: typingUsers[0].username, user2: typingUsers[1].username, user3: typingUsers[2].username })
                        : t('chat.typingMany', { user1: typingUsers[0].username, user2: typingUsers[1].username, count: typingUsers.length - 2 })}
                </span>
              </>
            )}
          </div>
          {/* Typing area — own glass element, grows freely */}
          <div
            className="perf-glass-layer"
            style={{
              backgroundColor: 'var(--bg-chat)',
              backdropFilter: 'blur(24px) saturate(1.1)',
              WebkitBackdropFilter: 'blur(24px) saturate(1.1)',
              borderRadius: statusBarDocked ? (inputValue.includes('\n') ? '16px 16px 16px 0' : '0 16px 16px 0') : '16px',
              borderTop: '1px solid var(--border-subtle)',
              borderBottom: '1px solid var(--border-subtle)',
              borderRight: '1px solid var(--border-subtle)',
              borderLeft: statusBarDocked ? 'none' : '1px solid var(--border-subtle)',
              boxShadow: '0 4px 6px -1px rgba(0,0,0,0.12), 0 24px 48px -12px rgba(0,0,0,0.2)',
            } as React.CSSProperties}
          >
      <div className="flex-1 flex flex-col min-w-0 px-4 py-2 relative">
        {replyingTo && (
          <div
            className="absolute bottom-full left-0 right-0 flex items-center justify-between gap-2 py-1.5 px-4 mb-1 rounded-t-xl min-w-0"
            style={{
              backgroundColor: 'var(--bg-floating)',
              boxShadow: '0 -1px 4px rgba(0,0,0,0.15)',
              borderTop: '1px solid var(--border-subtle)',
              borderLeft: '1px solid var(--border-subtle)',
              borderRight: '1px solid var(--border-subtle)',
            }}
          >
            <span className="text-xs font-medium truncate min-w-0" style={S_TEXT_SECONDARY}>
              {t('chat.replyingTo')} <span style={S_CYAN_ACCENT}>{replyingTo.authorUsername ?? t('common.unknown')}</span>
              {replyingTo.content && (
                <span className="ml-1 truncate opacity-80">{'\u2014'} {replyingTo.content.slice(0, 40)}{replyingTo.content.length > 40 ? '\u2026' : ''}</span>
              )}
            </span>
            <button type="button" onClick={onCancelReply} className="shrink-0 p-1 rounded-lg hover:bg-fill-active transition-colors" style={S_TEXT_SECONDARY} aria-label={t('chat.cancelReply')}>
              <X size={14} />
            </button>
          </div>
        )}
        <div className="w-full min-w-0 relative">
          {rateLimitBanner && (
            <div
              className="absolute bottom-full left-0 right-0 mb-1 px-3 py-2 rounded-lg text-sm font-medium border"
              style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
            >
              {t('chat.rateLimitBanner')}
            </div>
          )}
          {!rateLimitBanner && messageSendError && (
            <div
              className="absolute bottom-full left-0 right-0 mb-1 px-3 py-2 rounded-lg text-sm font-medium border"
              style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--danger)', color: 'var(--danger)' }}
            >
              {messageSendError}
            </div>
          )}
          {(pendingAttachment || pendingAttachmentPreview || uploading) && (
            // In normal flow (not absolute) so the preview claims its own vertical
            // space: its height folds into onBarHeightChange → the Virtuoso footer
            // grows → the most recent message scrolls up out of the way instead of
            // being hidden behind the preview. Same mechanism as the typing indicator.
            <div
              className="mb-2 p-3 rounded-xl border shadow-lg"
              style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}
            >
              <div className="relative inline-block group">
                {(pendingAttachmentPreview || pendingAttachment?.contentType?.startsWith('image/')) ? (
                  <img
                    src={pendingAttachmentPreview || pendingAttachment?.url}
                    alt={pendingAttachment?.name ?? 'preview'}
                    className="max-h-48 max-w-xs object-contain rounded-lg"
                    loading="lazy"
                    decoding="async"
                  />
                ) : pendingAttachment ? (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ backgroundColor: 'var(--bg-input)' }}>
                    <Paperclip size={16} style={S_TEXT_SECONDARY} />
                    <span className="text-sm truncate max-w-[200px]" style={S_TEXT_PRIMARY}>{pendingAttachment.name}</span>
                  </div>
                ) : null}
                {uploading && (
                  <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/50">
                    <span className="text-xs font-medium text-white/80">{t('chat.uploading')}</span>
                  </div>
                )}
                {/* V2 hover-bubble cluster: three floating action buttons */}
                {!uploading && (
                  <div
                    className="absolute flex gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                    style={{ top: '6px', right: '6px' }}
                  >
                    {/* Eye toggle (spoiler) */}
                    <button
                      type="button"
                      onClick={() => setPendingAttachmentIsSpoiler(v => !v)}
                      className="flex items-center justify-center rounded-full transition-all"
                      style={{
                        width: '26px',
                        height: '26px',
                        background: 'rgba(14, 20, 22, 0.92)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        backdropFilter: 'blur(6px)',
                        WebkitBackdropFilter: 'blur(6px)',
                        color: pendingAttachmentIsSpoiler ? '#98c5ac' : 'rgba(255,255,255,0.6)',
                      } as React.CSSProperties}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(20, 28, 32, 0.95)';
                        e.currentTarget.style.transform = 'scale(1.06)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(14, 20, 22, 0.92)';
                        e.currentTarget.style.transform = 'scale(1)';
                      }}
                      aria-label={t('composer.markAsSpoiler', 'Mark as spoiler')}
                      title={t('composer.markAsSpoiler', 'Mark as spoiler')}
                    >
                      {pendingAttachmentIsSpoiler ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                    {/* Pencil (modify) */}
                    <button
                      type="button"
                      onClick={() => setModifyModalOpen(true)}
                      className="flex items-center justify-center rounded-full transition-all"
                      style={{
                        width: '26px',
                        height: '26px',
                        background: 'rgba(14, 20, 22, 0.92)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        backdropFilter: 'blur(6px)',
                        WebkitBackdropFilter: 'blur(6px)',
                        color: 'rgba(255,255,255,0.6)',
                      } as React.CSSProperties}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(20, 28, 32, 0.95)';
                        e.currentTarget.style.transform = 'scale(1.06)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(14, 20, 22, 0.92)';
                        e.currentTarget.style.transform = 'scale(1)';
                      }}
                      aria-label={t('composer.modifyAttachment', 'Modify attachment')}
                      title={t('composer.modifyAttachment', 'Modify attachment')}
                    >
                      <Pencil size={13} />
                    </button>
                    {/* Trash (remove) */}
                    <button
                      type="button"
                      onClick={() => {
                        setPendingAttachment(null);
                        setPendingAttachmentIsSpoiler(false);
                        setPendingAttachmentAlt('');
                        if (pendingAttachmentPreview) { URL.revokeObjectURL(pendingAttachmentPreview); setPendingAttachmentPreview(null); }
                        setUploadError(null);
                      }}
                      className="flex items-center justify-center rounded-full transition-all"
                      style={{
                        width: '26px',
                        height: '26px',
                        background: 'rgba(14, 20, 22, 0.92)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        backdropFilter: 'blur(6px)',
                        WebkitBackdropFilter: 'blur(6px)',
                        color: 'rgba(255,255,255,0.6)',
                      } as React.CSSProperties}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(220, 60, 60, 0.30)';
                        e.currentTarget.style.color = '#ff9c9c';
                        e.currentTarget.style.borderColor = 'rgba(220, 60, 60, 0.5)';
                        e.currentTarget.style.transform = 'scale(1.06)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(14, 20, 22, 0.92)';
                        e.currentTarget.style.color = 'rgba(255,255,255,0.6)';
                        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
                        e.currentTarget.style.transform = 'scale(1)';
                      }}
                      aria-label={t('composer.removeAttachment', 'Remove attachment')}
                      title={t('composer.removeAttachment', 'Remove attachment')}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </div>
              {pendingAttachment?.name && !uploading && (
                <p className="text-xs mt-1.5 truncate max-w-xs" style={S_TEXT_SECONDARY}>{pendingAttachment.name}</p>
              )}
            </div>
          )}
          {linkPreviews.size > 0 && [...linkPreviews.entries()].some(([url]) => !dismissedUrls.has(url)) && (
            <div className="absolute bottom-full left-0 right-0 mb-2 flex flex-col gap-1.5 z-40">
              {[...linkPreviews.entries()].filter(([url]) => !dismissedUrls.has(url)).map(([url, preview]) => (
                <div
                  key={url}
                  className="flex items-start gap-3 px-3 py-2.5 rounded-xl border relative group"
                  style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}
                >
                  {preview.favicon && (
                    <img src={preview.favicon} alt="" className="w-4 h-4 rounded-sm shrink-0 mt-0.5" loading="lazy" decoding="async" width={16} height={16} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  )}
                  <div className="flex-1 min-w-0">
                    {preview.siteName && <p className="text-[10px] uppercase tracking-wide mb-0.5" style={{ color: 'var(--text-secondary)', opacity: 0.6 }}>{preview.siteName}</p>}
                    {preview.title && <p className="text-sm font-medium truncate" style={S_CYAN_ACCENT}>{preview.title}</p>}
                    {preview.description && <p className="text-xs mt-0.5 line-clamp-2" style={S_TEXT_SECONDARY}>{preview.description}</p>}
                  </div>
                  {preview.image && (
                    <img src={preview.image} alt="" className="w-16 h-16 rounded-lg object-cover shrink-0" loading="lazy" decoding="async" width={64} height={64} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  )}
                  <button type="button" onClick={() => setDismissedUrls(prev => new Set(prev).add(url))}
                    className="absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-fill-active"
                    style={{ color: 'var(--text-secondary)' }}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {mentionOpen && mentionSuggestions.length > 0 && (
            <div
              role="listbox"
              aria-label={t('chat.mentionSuggestions', 'Mention suggestions')}
              className="absolute bottom-full left-0 right-0 mb-1 py-1 rounded-xl border shadow-xl max-h-48 overflow-y-auto z-50"
              style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}
            >
              {mentionSuggestions.map((s, i) => (
                <button
                  key={`${s.type}-${s.value}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={i === selectedMentionIndex}
                  onClick={() => insertMentionPill(s)}
                  className={`w-full px-3 py-2 text-left flex items-center gap-2 text-sm ${i === selectedMentionIndex ? 'bg-[var(--cyan-accent)]/20' : 'hover:bg-fill-active'}`}
                  style={S_TEXT_PRIMARY}
                >
                  {s.type === 'user' && <Users size={14} style={S_TEXT_SECONDARY} />}
                  {s.type === 'role' && <ShieldCheck size={14} style={S_TEXT_SECONDARY} />}
                  {s.type === 'everyone' && <Users size={14} style={S_CYAN_ACCENT} />}
                  {s.type === 'here' && <Zap size={14} style={S_CYAN_ACCENT} />}
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          )}
          {codeBlockOpen && codeBlockSuggestions.length > 0 && (
            <div
              role="listbox"
              aria-label="Code block language"
              className="absolute bottom-full left-0 right-0 mb-1 py-1 rounded-xl border shadow-xl max-h-48 overflow-y-auto z-50"
              style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}
            >
              {codeBlockSuggestions.map((lang, i) => (
                <button
                  key={lang.value}
                  type="button"
                  role="option"
                  aria-selected={i === selectedCodeBlockIndex}
                  onClick={() => handleCodeBlockSelect(lang)}
                  className={`w-full px-3 py-2 text-left flex items-center gap-2 text-sm ${i === selectedCodeBlockIndex ? 'bg-[var(--cyan-accent)]/20' : 'hover:bg-fill-active'}`}
                  style={S_TEXT_PRIMARY}
                >
                  <Code2 size={14} style={S_CYAN_ACCENT} />
                  <span className="font-medium">{lang.name}</span>
                  {lang.value !== lang.name.toLowerCase() && (
                    <span className="text-xs opacity-50">{lang.value}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {slashOpen && !selectedCommand && slashSuggestions.length > 0 && (
            <div
              role="listbox"
              aria-label="Slash commands"
              className="absolute bottom-full left-0 right-0 mb-1 py-1 rounded-xl border shadow-xl max-h-64 overflow-y-auto z-50"
              style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}
            >
              {slashSuggestions.map((cmd, i) => (
                <button
                  key={cmd.name}
                  type="button"
                  role="option"
                  aria-selected={i === selectedSlashIndex}
                  onClick={() => handleSlashSelect(cmd)}
                  className={`w-full px-3 py-2 text-left flex items-center gap-3 text-sm ${i === selectedSlashIndex ? 'bg-[var(--cyan-accent)]/20' : 'hover:bg-fill-active'}`}
                  style={S_TEXT_PRIMARY}
                >
                  <span style={S_TEXT_SECONDARY}>{cmd.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">/{cmd.name}</span>
                      {cmd.args.length > 0 && (
                        <span className="text-xs opacity-50">
                          {cmd.args.map(a => a.required ? `<${a.name}>` : `[${a.name}]`).join(' ')}
                        </span>
                      )}
                    </div>
                    <span className="text-xs" style={S_TEXT_SECONDARY}>{cmd.description}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
          {slashOpen && selectedCommand && (
            <div
              className="absolute bottom-full left-0 right-0 mb-1 py-2 px-3 rounded-xl border shadow-xl z-50"
              style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}
            >
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium" style={S_CYAN_ACCENT}>/{selectedCommand.name}</span>
                {selectedCommand.args.map((arg, i) => (
                  <span key={arg.name} className="px-1.5 py-0.5 rounded-lg text-xs" style={{
                    backgroundColor: i === currentArgIndex ? 'var(--cyan-accent)' : 'var(--fill-hover)',
                    color: i === currentArgIndex ? 'var(--text-on-accent)' : 'var(--text-secondary)',
                  }}>
                    {arg.required ? `<${arg.name}>` : `[${arg.name}]`}
                  </span>
                ))}
              </div>
              <p className="text-xs mt-1" style={S_TEXT_SECONDARY}>
                {currentArgDef?.description ?? 'Press Enter to execute'}
              </p>
              {slashArgUserSuggestions.length > 0 && (
                <div className="mt-1.5 py-1 border-t max-h-32 overflow-y-auto" style={{ borderColor: 'var(--border-subtle)' }}>
                  {slashArgUserSuggestions.map((s, i) => (
                    <button key={s.userId ?? s.value} type="button" role="option" aria-selected={i === selectedSubIndex}
                      onClick={() => insertSlashArgValue(s.label)}
                      className={`w-full px-2 py-1.5 text-left flex items-center gap-2 text-xs rounded-lg ${i === selectedSubIndex ? 'bg-[var(--cyan-accent)]/20' : 'hover:bg-fill-active'}`}
                      style={S_TEXT_PRIMARY}>
                      <Users size={12} style={S_TEXT_SECONDARY} /><span>{s.label}</span>
                    </button>
                  ))}
                </div>
              )}
              {slashArgChannelSuggestions.length > 0 && (
                <div className="mt-1.5 py-1 border-t max-h-32 overflow-y-auto" style={{ borderColor: 'var(--border-subtle)' }}>
                  {slashArgChannelSuggestions.map((c, i) => (
                    <button key={c.id} type="button" role="option" aria-selected={i === selectedSubIndex}
                      onClick={() => insertSlashArgValue(c.name)}
                      className={`w-full px-2 py-1.5 text-left flex items-center gap-2 text-xs rounded-lg ${i === selectedSubIndex ? 'bg-[var(--cyan-accent)]/20' : 'hover:bg-fill-active'}`}
                      style={S_TEXT_PRIMARY}>
                      <Hash size={12} style={S_TEXT_SECONDARY} /><span>#{c.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {channelOpen && channelSuggestions.length > 0 && (
            <div
              role="listbox"
              aria-label={t('chat.channelSuggestions', 'Channel suggestions')}
              className="absolute bottom-full left-0 right-0 mb-1 py-1 rounded-xl border shadow-xl max-h-48 overflow-y-auto z-50"
              style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}
            >
              {channelSuggestions.map((ch, i) => {
                const Icon = ch.type === 'voice' ? Volume2 : ch.type === 'stage' ? Radio : Hash;
                return (
                  <button
                    key={ch.id}
                    type="button"
                    role="option"
                    aria-selected={i === selectedChannelIndex}
                    onClick={() => insertChannelPill(ch)}
                    className={`w-full px-3 py-2 text-left flex items-center gap-2 text-sm ${i === selectedChannelIndex ? 'bg-[var(--cyan-accent)]/20' : 'hover:bg-fill-active'}`}
                    style={S_TEXT_PRIMARY}
                  >
                    <Icon size={14} style={S_TEXT_SECONDARY} />
                    <span>{ch.name}</span>
                  </button>
                );
              })}
            </div>
          )}
          {emojiAutoOpen && emojiAutoSuggestions.length > 0 && (
            <div
              role="listbox"
              aria-label={t('chat.emojiSuggestions', 'Emoji suggestions')}
              className="absolute bottom-full left-0 right-0 mb-1 py-1 rounded-xl border shadow-xl max-h-48 overflow-y-auto z-50"
              style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}
            >
              {emojiAutoSuggestions.map((emoji, i) => (
                <button
                  key={emoji.id}
                  type="button"
                  role="option"
                  aria-selected={i === selectedEmojiAutoIndex}
                  onClick={() => insertCustomEmoji(emoji)}
                  className={`w-full px-3 py-2 text-left flex items-center gap-2 text-sm ${i === selectedEmojiAutoIndex ? 'bg-[var(--cyan-accent)]/20' : 'hover:bg-fill-active'}`}
                  style={S_TEXT_PRIMARY}
                >
                  <img src={emoji.imageUrl} alt={emoji.name} className="w-6 h-6" draggable={false} loading="lazy" decoding="async" width={24} height={24} />
                  <span>:{emoji.name}:</span>
                </button>
              ))}
            </div>
          )}
          {emojiOpen && createPortal(
            <React.Suspense fallback={null}><EmojiPicker open onClose={() => { setEmojiOpen(false); requestAnimationFrame(() => editorRef.current?.focus()); }} onSelect={(emoji: string) => { editorRef.current?.insertText(emoji); requestAnimationFrame(() => editorRef.current?.focus()); }} anchorRef={emojiButtonRef} activeServerId={activeServerId} servers={servers} zoomLevel={zoomLevel} userPlan={userPlan} userId={currentUserId} /></React.Suspense>,
            document.body
          )}
          {stickerOpen && createPortal(
            <React.Suspense fallback={null}><StickerPicker open onClose={() => { setStickerOpen(false); requestAnimationFrame(() => editorRef.current?.focus()); }} onSelect={(sticker: ServerSticker) => {
              onSendMessage('', undefined, { url: sticker.imageUrl, name: `${sticker.name}.png`, contentType: 'image/png' });
              setStickerOpen(false); requestAnimationFrame(() => editorRef.current?.focus());
            }} anchorRef={stickerButtonRef} activeServerId={activeServerId} servers={servers} zoomLevel={zoomLevel} userPlan={userPlan} /></React.Suspense>,
            document.body
          )}
          {gifOpen && createPortal(
            <React.Suspense fallback={null}><GifPicker open onClose={() => { setGifOpen(false); requestAnimationFrame(() => editorRef.current?.focus()); }} onSelect={(gifUrl, _preview, width, height) => {
              const gifFilename = gifUrl.split('/').pop()?.split('?')[0] || 'gif.gif';
              onSendMessage('', undefined, { url: gifUrl, name: gifFilename, contentType: 'image/gif', width: width ?? null, height: height ?? null });
              setGifOpen(false); requestAnimationFrame(() => editorRef.current?.focus());
            }} anchorRef={gifButtonRef} zoomLevel={zoomLevel} /></React.Suspense>,
            document.body
          )}
          <div className="relative">
          <form
            onSubmit={handleSubmit}
            className={`flex items-center min-h-[44px] ${isMobile ? 'pl-2 pr-2 gap-1' : 'pl-4 pr-3 gap-2'} rounded-2xl border-2 transition-all focus-within:border-[var(--cyan-accent)]/30 focus-within:shadow-[0_0_0_3px_color-mix(in srgb, var(--cyan-accent) 8%, transparent)] min-w-0`}
            style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border-subtle)', boxShadow: '0 2px 12px rgba(0,0,0,0.2)' }}
          >
            {/* Hidden file input — always in DOM */}
            {uploadFile && (
              <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileSelect} disabled={sendDisabled || uploading} />
            )}
            {/* Left: Plus menu */}
            {showPlusButton && (
              <div className="relative shrink-0" ref={plusMenuRef}>
                <button
                  type="button"
                  onClick={() => { setPlusMenuOpen((o) => !o); setEmojiOpen(false); setStickerOpen(false); setGifOpen(false); }}
                  disabled={sendDisabled}
                  className={`shrink-0 ${isMobile ? 'p-1.5' : 'p-2'} rounded-lg hover:bg-fill-active disabled:opacity-50 transition-transform ${plusMenuOpen ? 'rotate-45' : ''}`}
                  style={{ color: plusMenuOpen ? 'var(--cyan-accent)' : 'var(--text-secondary)' }}
                  aria-label={t('input.plusMenu')}
                  aria-expanded={plusMenuOpen}
                >
                  <Plus size={isMobile ? 16 : 20} />
                </button>
                {plusMenuOpen && createPortal(
                  <div
                    ref={plusMenuPortalRef}
                    className="fixed py-1 rounded-xl border shadow-xl z-[var(--z-dropdown)]"
                    style={{
                      backgroundColor: 'var(--bg-floating)',
                      borderColor: 'var(--border-subtle)',
                      width: 200,
                      left: plusMenuRef.current ? plusMenuRef.current.getBoundingClientRect().left : 0,
                      top: plusMenuRef.current ? plusMenuRef.current.getBoundingClientRect().top - (plusMenuRef.current.querySelector('[aria-label]') ? 8 : 0) : 0,
                      transform: 'translateY(-100%)',
                    }}
                  >
                    {uploadFile && (
                      <button
                        type="button"
                        onClick={() => { fileInputRef.current?.click(); setPlusMenuOpen(false); }}
                        className={`w-full flex items-center gap-2.5 px-3 ${isMobile ? 'py-2.5 min-h-[44px]' : 'py-2.5'} text-left text-sm rounded-lg hover:bg-fill-active transition-colors`}
                        style={S_TEXT_PRIMARY}
                      >
                        <Paperclip size={18} style={S_TEXT_SECONDARY} /> {t('input.uploadFile')}
                      </button>
                    )}
                    {canCreatePoll && onCreatePoll && (
                      <button
                        type="button"
                        onClick={() => { onCreatePoll(); setPlusMenuOpen(false); }}
                        className={`w-full flex items-center gap-2.5 px-3 ${isMobile ? 'py-2.5 min-h-[44px]' : 'py-2.5'} text-left text-sm rounded-lg hover:bg-fill-active transition-colors`}
                        style={S_TEXT_PRIMARY}
                      >
                        <BarChart3 size={18} style={S_TEXT_SECONDARY} /> {t('input.createPoll')}
                      </button>
                    )}
                    {canCreateThread && onCreateThread && (
                      <button
                        type="button"
                        onClick={() => { onCreateThread(); setPlusMenuOpen(false); }}
                        disabled={sendDisabled}
                        className={`w-full flex items-center gap-2.5 px-3 ${isMobile ? 'py-2.5 min-h-[44px]' : 'py-2.5'} text-left text-sm rounded-lg hover:bg-fill-active transition-colors`}
                        style={S_TEXT_PRIMARY}
                      >
                        <MessageCirclePlus size={18} style={S_TEXT_SECONDARY} /> {t('input.createThread')}
                      </button>
                    )}
                  </div>,
                  document.body
                )}
              </div>
            )}
            {/* Center: Lexical Editor */}
            <div className="flex-1 min-w-0 relative">
              <LexicalChatEditor
                ref={editorRef}
                disabled={sendDisabled}
                placeholder={sendDisabled
                  ? composerPlaceholder ?? blockBanner ?? t('chat.cantSend')
                  : otrEmptyPlaceholder ?? (() => {
                      const name = headerGroup ? (channel.name.length > 30 ? 'Group' : channel.name) : channel.name;
                      return isDM
                        ? t('chat.replyPlaceholderDm', { name, defaultValue: 'Reply to {{name}}' })
                        : t('chat.replyPlaceholder', { channelName: name });
                    })()}
                maxLines={24}
                onTextChange={handleEditorTextChange}
                onSubmit={handleEditorSubmit}
                onImagePaste={(file) => { if (uploadFile && !uploading && !sendDisabled && !pendingAttachment) uploadAndAttach(file); }}
                onTextPaste={(text) => { if (text && looksLikeCode(text)) { pendingCodePasteRef.current = true; requestAnimationFrame(() => setShowCodePasteSuggestion(true)); } }}
                onMentionQuery={handleMentionQuery}
                onMentionDismiss={handleMentionDismiss}
                onMentionKeyDown={handleMentionKeyDown}
                mentionActive={mentionOpen && mentionSuggestions.length > 0}
                onChannelQuery={handleChannelQuery}
                onChannelDismiss={handleChannelDismiss}
                onChannelKeyDown={handleChannelKeyDown}
                channelActive={channelOpen && channelSuggestions.length > 0}
                onEmojiQuery={handleEmojiQuery}
                onEmojiDismiss={handleEmojiDismiss}
                onEmojiKeyDown={handleEmojiKeyDown}
                emojiAutoActive={emojiAutoOpen && emojiAutoSuggestions.length > 0}
                onArrowUpEmpty={onEditLastMessage}
                onSlashQuery={handleSlashQuery}
                onSlashDismiss={handleSlashDismiss}
                onSlashKeyDown={handleSlashKeyDown}
                slashActive={slashOpen}
                onCodeBlockQuery={handleCodeBlockQuery}
                onCodeBlockDismiss={handleCodeBlockDismiss}
                onCodeBlockKeyDown={handleCodeBlockKeyDown}
                codeBlockActive={codeBlockOpen && codeBlockSuggestions.length > 0}
                anyDropdownOpen={mentionOpen || channelOpen || emojiAutoOpen || slashOpen || codeBlockOpen}
                onEditorBlur={() => { setMentionOpen(false); setChannelOpen(false); setEmojiAutoOpen(false); setCodeBlockOpen(false); }}
                className="relative z-10 flex-1 w-full min-w-0 bg-transparent border-none outline-none py-0 px-2 text-sm leading-tight"
                style={{ color: 'var(--text-primary)', caretColor: 'var(--cyan-accent)' }}
              />
            </div>
            {/* Right: Emoji */}
            <button
              ref={emojiButtonRef}
              type="button"
              onClick={disableEmojis ? undefined : () => { setEmojiOpen((o) => !o); setStickerOpen(false); setGifOpen(false); setPlusMenuOpen(false); }}
              disabled={sendDisabled}
              className={`shrink-0 ${isMobile ? 'p-1.5' : 'p-2'} rounded-lg ${disableEmojis ? 'cursor-not-allowed' : 'hover:bg-fill-active'} disabled:opacity-50`}
              style={{ color: emojiOpen ? 'var(--cyan-accent)' : 'var(--text-secondary)', opacity: disableEmojis ? 0.3 : undefined, pointerEvents: disableEmojis ? 'none' as const : undefined }}
              aria-label={t('chat.insertEmoji')}
              aria-expanded={emojiOpen}
              title={disableEmojis ? 'Emojis disabled by host' : undefined}
            >
              <Smile size={isMobile ? 16 : 18} />
            </button>
            {/* Desktop: Sticker + GIF buttons */}
            {!isMobile && (
              <>
                <button
                  ref={stickerButtonRef}
                  type="button"
                  onClick={disableStickers ? undefined : () => { setStickerOpen((o) => !o); setEmojiOpen(false); setGifOpen(false); setPlusMenuOpen(false); }}
                  disabled={sendDisabled}
                  className={`shrink-0 p-2 rounded-lg ${disableStickers ? 'cursor-not-allowed' : 'hover:bg-fill-active'} disabled:opacity-50`}
                  style={{ color: stickerOpen ? 'var(--cyan-accent)' : 'var(--text-secondary)', opacity: disableStickers ? 0.3 : undefined, pointerEvents: disableStickers ? 'none' as const : undefined }}
                  aria-label={t('chat.sendSticker')}
                  aria-expanded={stickerOpen}
                  title={disableStickers ? 'Stickers disabled by host' : undefined}
                >
                  <Sticker size={18} />
                </button>
                <button
                  ref={gifButtonRef}
                  type="button"
                  onClick={disableGifs ? undefined : () => { setGifOpen((o) => !o); setEmojiOpen(false); setStickerOpen(false); setPlusMenuOpen(false); }}
                  disabled={sendDisabled}
                  className={`shrink-0 p-2 rounded-lg ${disableGifs ? 'cursor-not-allowed' : 'hover:bg-fill-active'} disabled:opacity-50`}
                  style={{ color: gifOpen ? 'var(--cyan-accent)' : 'var(--text-secondary)', opacity: disableGifs ? 0.3 : undefined, pointerEvents: disableGifs ? 'none' as const : undefined }}
                  aria-label={t('chat.sendGif')}
                  aria-expanded={gifOpen}
                  title={disableGifs ? 'GIFs disabled by host' : undefined}
                >
                  <ImagePlay size={18} />
                </button>
              </>
            )}
            {/* Mobile: show sticker + GIF inline (same as desktop) */}
            {isMobile && (
              <>
                <button
                  ref={stickerButtonRef}
                  type="button"
                  onClick={disableStickers ? undefined : () => { setStickerOpen((o) => !o); setEmojiOpen(false); setGifOpen(false); }}
                  disabled={sendDisabled}
                  className={`p-1.5 rounded-lg ${disableStickers ? 'cursor-not-allowed' : 'hover:bg-fill-active'} disabled:opacity-50`}
                  style={{ color: stickerOpen ? 'var(--cyan-accent)' : 'var(--text-secondary)', opacity: disableStickers ? 0.3 : undefined, pointerEvents: disableStickers ? 'none' as const : undefined }}
                  aria-label={t('chat.sendSticker')}
                  title={disableStickers ? 'Stickers disabled by host' : undefined}
                >
                  <Sticker size={16} />
                </button>
                <button
                  ref={gifButtonRef}
                  type="button"
                  onClick={disableGifs ? undefined : () => { setGifOpen((o) => !o); setEmojiOpen(false); setStickerOpen(false); }}
                  disabled={sendDisabled}
                  className={`p-1.5 rounded-lg ${disableGifs ? 'cursor-not-allowed' : 'hover:bg-fill-active'} disabled:opacity-50`}
                  style={{ color: gifOpen ? 'var(--cyan-accent)' : 'var(--text-secondary)', opacity: disableGifs ? 0.3 : undefined, pointerEvents: disableGifs ? 'none' as const : undefined }}
                  aria-label={t('chat.sendGif')}
                  title={disableGifs ? 'GIFs disabled by host' : undefined}
                >
                  <ImagePlay size={16} />
                </button>
              </>
            )}
            {inputValue.length > maxMessageLength - 200 && (
              <span className="text-[10px] font-mono tabular-nums shrink-0 select-none" style={{ color: inputValue.length > maxMessageLength ? 'var(--danger)' : 'var(--warning)' }}>
                {inputValue.length}/{maxMessageLength}
              </span>
            )}
            {showSendBtn && (
              <button
                type="submit"
                disabled={(!inputValue.trim() && !pendingAttachment) || sendDisabled}
                className="rounded-full shrink-0 flex items-center justify-center w-8 h-8 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed overflow-visible"
                style={{
                  backgroundColor: (inputValue.trim() || pendingAttachment) && !sendDisabled ? 'var(--cyan-accent)' : 'var(--fill-active)',
                }}
              >
                <Zap size={16} fill={(inputValue.trim() || pendingAttachment) && !sendDisabled ? 'currentColor' : 'none'} style={{ color: (inputValue.trim() || pendingAttachment) && !sendDisabled ? 'var(--text-on-accent)' : 'var(--text-secondary)' }} />
              </button>
            )}
          </form>
          {showTextFilePrompt && (
            <div className="absolute left-4 right-4 z-20" style={{ bottom: 'calc(100% + 4px)' }}>
              <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl border text-sm glass"
                style={{ color: 'var(--text-primary)' }}>
                <span>{t('chat.messageTooLong', { limit: maxMessageLength })}</span>
                <div className="flex gap-2 shrink-0">
                  <button type="button" onClick={() => setShowTextFilePrompt(false)}
                    className="px-3 py-1 rounded-lg text-xs font-medium hover:bg-fill-active transition-colors"
                    style={S_TEXT_SECONDARY}>
                    {t('common.cancel')}
                  </button>
                  <button type="button" onClick={handleUploadAsTextFile}
                    className="btn-cta px-3 py-1 rounded-lg text-xs font-medium">
                    {t('chat.uploadAsFile')}
                  </button>
                </div>
              </div>
            </div>
          )}
          {showCodePasteSuggestion && (
            <div className="absolute left-4 right-4 z-20" style={{ bottom: 'calc(100% + 4px)' }}>
              <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl border text-sm glass"
                style={{ color: 'var(--text-primary)' }}>
                <div className="flex items-center gap-2 min-w-0">
                  <Code2 size={16} style={{ color: 'var(--cyan-accent)', flexShrink: 0 }} />
                  <span className="truncate">{t('chat.looksLikeCode', 'Pasted code? Format it!')}</span>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button type="button" onClick={handleDismissCodePaste}
                    className="px-3 py-1 rounded-lg text-xs font-medium hover:bg-fill-active transition-colors"
                    style={S_TEXT_SECONDARY}>
                    {t('common.dismiss', 'Dismiss')}
                  </button>
                  <button type="button" onClick={handleFormatAsCode}
                    className="btn-cta px-3 py-1 rounded-lg text-xs font-medium">
                    {t('chat.formatAsCode', 'Format')}
                  </button>
                </div>
              </div>
            </div>
          )}
          </div>
          {uploadError && (
            <div className="mt-1.5 px-1 text-sm" style={{ color: 'var(--danger)' }}>{uploadError}</div>
          )}
        </div>
      </div>
      </div>
      </div>
      </div>
      </ReplyBarPortal>
      <ModifyAttachmentModal
        open={modifyModalOpen}
        filename={pendingAttachment?.name ?? ''}
        alt={pendingAttachmentAlt}
        isSpoiler={pendingAttachmentIsSpoiler}
        previewUrl={pendingAttachmentPreview}
        contentType={pendingAttachment?.contentType}
        onSave={(next) => {
          setPendingAttachment((prev) => prev ? { ...prev, name: next.filename } : prev);
          setPendingAttachmentAlt(next.alt);
          setPendingAttachmentIsSpoiler(next.isSpoiler);
          setModifyModalOpen(false);
        }}
        onCancel={() => setModifyModalOpen(false)}
      />
    </>
  );
}));
