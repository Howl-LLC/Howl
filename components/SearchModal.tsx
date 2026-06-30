// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { motion } from 'motion/react';
import { Search, X, Hash, MessageSquare, Loader2, FileText, ArrowDown, Pin, Lock, HelpCircle, Calendar, Paperclip, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '../services/api';
import { LetterAvatar } from './LetterAvatar';
import { UserAvatar } from './UserAvatar';
import { RoleNameStyle } from './RoleNameStyle';
import { useIsMobile } from '../hooks/useIsMobile';
import { useSettings } from '../contexts/SettingsContext';
import { searchDmMessagesHybrid, type DMSearchResult } from '../services/dmSearchIndex';
import { useServerStore } from '../stores/serverStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useDmStore } from '../stores/dmStore';
import { parseSearchTokens, serializeFilters, type SearchFilters } from '../utils/searchTokenParser';
import type { Message, Server } from '../types';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface SearchResult {
  id: string;
  channelId: string;
  channelName: string | null;
  serverId: string | null;
  authorId: string;
  authorUsername: string | null;
  authorAvatar: string | null;
  authorNameColor?: string | null;
  authorNameFont?: string | null;
  authorNameEffect?: string | null;
  authorAvatarEffect?: string | null;
  authorEffectivePlan?: string | null;
  content: string;
  createdAt: string;
  attachmentUrl: string | null;
  attachmentName: string | null;
  attachmentContentType?: string | null;
}

type RightPanelMode = 'search' | 'pinned';

interface RightPanelProps {
  mode: RightPanelMode | null;
  onClose: () => void;
  onSetMode: (mode: RightPanelMode) => void;
  serverId?: string;
  channelId?: string;
  /** When true, search uses the client-side encrypted DM search index instead of the server API. */
  encrypted?: boolean;
  /** DM channel ID for DM-specific search (server API or encrypted local). */
  dmChannelId?: string;
  onNavigateToMessage?: (channelId: string, messageId: string) => void;
  pinnedList: Array<Message & { pinnedAt: string; pinnedById: string }>;
  pinnedListLoading: boolean;
  pinnedCount?: number;
  onUnpinMessage?: (messageId: string) => void;
  onRemovePinnedFromList?: (messageId: string) => void;
  usersById: Map<string, { id: string; username: string; discriminator?: string; avatar?: string | null; nameColor?: string | null; nameFont?: string | null; nameEffect?: string | null; avatarEffect?: string | null; stripePlan?: string | null; effectivePlan?: string | null }>;
  showPinned?: boolean;
}

const DEFAULT_PANEL_WIDTH = 340;
const MIN_PANEL_WIDTH = 260;
const MAX_PANEL_WIDTH = 520;
const PANEL_WIDTH_KEY = 'howl_right_panel_width';

function loadPanelWidth(): number {
  // On mobile, skip localStorage — panel is always full-width (controlled by isMobile style override)
  // This prevents a brief flash of desktop width before the mobile override kicks in
  if (typeof window !== 'undefined' && window.innerWidth < 768) return window.innerWidth;
  try {
    const v = parseInt(localStorage.getItem(PANEL_WIDTH_KEY) ?? '', 10);
    if (v >= MIN_PANEL_WIDTH && v <= MAX_PANEL_WIDTH) return v;
  } catch { /* ignore */ }
  return DEFAULT_PANEL_WIDTH;
}

// Autocomplete types & constants

type AutocompleteType = 'from' | 'in' | 'mentions' | 'has' | 'before' | 'after' | null;

interface AutocompleteItem {
  id: string;
  label: string;
  icon?: string;
}

const KNOWN_FILTER_KEYS = new Set(['from', 'in', 'has', 'before', 'after', 'mentions', 'pinned', 'during']);

const HAS_OPTIONS: AutocompleteItem[] = [
  { id: 'file', label: 'file' },
  { id: 'image', label: 'image' },
  { id: 'video', label: 'video' },
  { id: 'link', label: 'link' },
  { id: 'sticker', label: 'sticker' },
  { id: 'sound', label: 'sound' },
  { id: 'attachment', label: 'attachment' },
];

const DATE_QUICK_PICKS: AutocompleteItem[] = [
  { id: 'today', label: 'today' },
  { id: 'yesterday', label: 'yesterday' },
  { id: 'last week', label: 'last week' },
  { id: 'last month', label: 'last month' },
];

const SEARCH_HELP_ENTRIES = [
  { syntax: 'from:user', description: 'Messages from a user' },
  { syntax: 'in:channel', description: 'Messages in a channel' },
  { syntax: 'has:image', description: 'Messages with images' },
  { syntax: 'before:date', description: 'Before a date' },
  { syntax: 'after:date', description: 'After a date' },
  { syntax: 'during:today', description: 'Messages from today' },
  { syntax: 'mentions:user', description: 'Messages mentioning a user' },
  { syntax: 'pinned:true', description: 'Pinned messages only' },
];

// FilterPill component

function FilterPill({ label, value, onRemove }: { label: string; value: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--fill-active)] text-[var(--text-primary)]">
      <span className="text-[var(--text-secondary)]">{label}:</span> {value}
      <button type="button" onClick={onRemove} className="ml-0.5 hover:text-[var(--danger)] transition-colors p-0.5" aria-label={`Remove ${label} filter`}>
        <X size={10} />
      </button>
    </span>
  );
}

// Helpers

/** Find the word at cursor position and check if it's a filter token being typed. */
function detectAutocompleteAtCursor(
  input: string,
  cursorPos: number,
): { type: AutocompleteType; partial: string; tokenStart: number; tokenEnd: number } | null {
  if (cursorPos <= 0) return null;

  // Walk backward from cursor to find the start of the current word
  let wordStart = cursorPos;
  while (wordStart > 0 && input[wordStart - 1] !== ' ') {
    wordStart--;
  }

  const word = input.substring(wordStart, cursorPos);
  const colonIdx = word.indexOf(':');
  if (colonIdx === -1) return null;

  const key = word.substring(0, colonIdx).toLowerCase();
  if (!KNOWN_FILTER_KEYS.has(key)) return null;

  // Only autocomplete types we support dropdown for
  const autocompleteKeys = new Set(['from', 'in', 'mentions', 'has', 'before', 'after']);
  if (!autocompleteKeys.has(key)) return null;

  const partial = word.substring(colonIdx + 1);

  // Find end of token (to the next space or end of string)
  let tokenEnd = cursorPos;
  while (tokenEnd < input.length && input[tokenEnd] !== ' ') {
    tokenEnd++;
  }

  return {
    type: key as AutocompleteType,
    partial,
    tokenStart: wordStart,
    tokenEnd,
  };
}

/** Format a filter value for display in a pill. */
function formatFilterDisplay(key: string, value: string): string {
  if (key === 'before' || key === 'after') {
    try {
      const d = new Date(value);
      if (!isNaN(d.getTime())) {
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      }
    } catch { /* fall through */ }
  }
  return value;
}

// Recent searches helpers

const RECENT_SEARCHES_KEY = 'howl_recent_searches';
const MAX_RECENT = 5;

function getRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
    return raw ? JSON.parse(raw).slice(0, MAX_RECENT) : [];
  } catch { return []; }
}

function saveRecentSearch(query: string, isEncryptedDm = false): void {
  if (!query.trim()) return;
  // Don't persist search queries for encrypted DM channels
  if (isEncryptedDm) return;
  try {
    const recent = getRecentSearches().filter(s => s !== query);
    recent.unshift(query);
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
  } catch { /* ignore */ }
}

// Main component

export const RightPanel: React.FC<RightPanelProps> = ({
  mode,
  onClose,
  onSetMode,
  serverId,
  channelId,
  encrypted = false,
  dmChannelId,
  onNavigateToMessage,
  pinnedList,
  pinnedListLoading,
  pinnedCount = 0,
  onUnpinMessage,
  onRemovePinnedFromList,
  usersById,
  showPinned = true,
}) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { chatSettings } = useSettings();
  const open = mode !== null;

  // When dmSearchAll is true, search across ALL DMs (don't filter by channel)
  const effectiveDmChannelId = chatSettings.dmSearchAll ? undefined : dmChannelId;

  // Store data for autocomplete
  const serverMembers = useServerStore(s => s.serverMembers);
  const activeServerId = useNavigationStore(s => s.activeServerId);
  const servers = useServerStore(s => s.servers);
  const dmChannels = useDmStore(s => s.dmChannels);

  // Get text channels for the active server
  const serverTextChannels = useMemo(() => {
    if (!activeServerId || activeServerId === 'home') return [];
    const server = servers.find((s: Server) => s.id === activeServerId);
    if (!server) return [];
    return server.channels.filter(ch => ch.type === 'text').slice(0, 100);
  }, [activeServerId, servers]);

  // Get DM participants for autocomplete when in DM context
  const dmParticipants = useMemo(() => {
    if (!dmChannelId) return [];
    const dm = dmChannels.find(d => d.id === dmChannelId);
    if (!dm) return [];
    const participants: Array<{ id: string; username: string; avatar?: string }> = [];
    if (dm.otherUser) {
      participants.push({ id: dm.otherUser.id, username: dm.otherUser.username, avatar: dm.otherUser.avatar });
    }
    if (dm.otherUsers) {
      for (const u of dm.otherUsers) {
        participants.push({ id: u.id, username: u.username, avatar: u.avatar });
      }
    }
    return participants;
  }, [dmChannelId, dmChannels]);

  // Resize state
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef({ startX: 0, startW: 0 });

  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: panelWidth };
    setIsDragging(true);
    const onMove = (ev: MouseEvent) => {
      const delta = dragRef.current.startX - ev.clientX;
      const next = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, dragRef.current.startW + delta));
      setPanelWidth(next);
    };
    const cleanup = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', cleanup);
      resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = cleanup;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', cleanup);
  }, [panelWidth]);

  useEffect(() => {
    return () => { resizeCleanupRef.current?.(); };
  }, []);

  useEffect(() => {
    if (!isDragging) {
      try { localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth)); } catch { /* ignore */ }
    }
  }, [panelWidth, isDragging]);

  // Search state
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [offset, setOffset] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Filter & autocomplete state (C1)
  const [activeFilters, setActiveFilters] = useState<SearchFilters>({ query: '' });
  const [autocompleteType, setAutocompleteType] = useState<AutocompleteType>(null);
  const [_autocompleteQuery, setAutocompleteQuery] = useState('');
  const [autocompleteResults, setAutocompleteResults] = useState<AutocompleteItem[]>([]);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [showSearchHelp, setShowSearchHelp] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [inputFocused, setInputFocused] = useState(false);

  // Track the token position for replacement when accepting autocomplete
  const autocompleteTokenRef = useRef<{ start: number; end: number } | null>(null);

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track whether IDB "older" results have been fetched for the current encrypted search
  const olderFetcherRef = useRef<(() => Promise<DMSearchResult[]>) | null>(null);
  const [olderFetched, setOlderFetched] = useState(false);

  useEffect(() => {
    return () => { if (focusTimerRef.current) clearTimeout(focusTimerRef.current); };
  }, []);

  useEffect(() => {
    if (mode === 'search') {
      setQuery('');
      setResults([]);
      setTotal(0);
      setHasMore(false);
      setSearched(false);
      setOffset(0);
      setOlderFetched(false);
      olderFetcherRef.current = null;
      setActiveFilters({ query: '' });
      setAutocompleteType(null);
      setAutocompleteQuery('');
      setAutocompleteResults([]);
      setAutocompleteIndex(0);
      setShowSearchHelp(false);
      setSearchError(null);
      setRecentSearches(getRecentSearches());
      setInputFocused(false);
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
      focusTimerRef.current = setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [mode]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      // Only close on Escape if autocomplete and search help are not open
      if (e.key === 'Escape' && !autocompleteType && !showSearchHelp) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose, autocompleteType, showSearchHelp]);

  // Resolve username to user ID
  const resolveUsername = useCallback((username: string): string | null => {
    const lower = username.toLowerCase();
    // Try server members first
    const member = serverMembers.find(m =>
      m.username.toLowerCase() === lower ||
      (m.nickname && m.nickname.toLowerCase() === lower)
    );
    if (member) return member.id;
    // Try DM participants
    const dmUser = dmParticipants.find(p => p.username.toLowerCase() === lower);
    if (dmUser) return dmUser.id;
    // Try usersById map
    for (const [, u] of usersById) {
      if (u.username.toLowerCase() === lower) return u.id;
    }
    return null;
  }, [serverMembers, dmParticipants, usersById]);

  // Resolve channel name to ID
  const resolveChannelName = useCallback((name: string): string | null => {
    const lower = name.toLowerCase();
    const ch = serverTextChannels.find(c => c.name.toLowerCase() === lower);
    return ch?.id ?? null;
  }, [serverTextChannels]);

  // Autocomplete data computation (C4)
  const computeAutocomplete = useCallback((type: AutocompleteType, partial: string): AutocompleteItem[] => {
    if (!type) return [];
    const lower = partial.toLowerCase();

    if (type === 'from' || type === 'mentions') {
      // Use DM participants in DM context, server members otherwise
      const source = dmChannelId ? dmParticipants : serverMembers;
      return source
        .filter(m => {
          const username = m.username.toLowerCase();
          const nickname = ('nickname' in m && m.nickname) ? m.nickname.toLowerCase() : '';
          return username.includes(lower) || nickname.includes(lower);
        })
        .slice(0, 8)
        .map(m => ({
          id: m.username,
          label: m.username,
          icon: ('avatar' in m ? m.avatar : undefined) ?? undefined,
        }));
    }

    if (type === 'in') {
      return serverTextChannels
        .filter(ch => ch.name.toLowerCase().includes(lower))
        .slice(0, 8)
        .map(ch => ({
          id: ch.name,
          label: ch.name,
        }));
    }

    if (type === 'has') {
      return HAS_OPTIONS.filter(o => o.label.includes(lower));
    }

    if (type === 'before' || type === 'after') {
      return DATE_QUICK_PICKS.filter(o => o.label.includes(lower));
    }

    return [];
  }, [dmChannelId, dmParticipants, serverMembers, serverTextChannels]);

  // Execute search with filter resolution (D1)
  const doSearch = useCallback(async (rawInput: string, filters: SearchFilters, newOffset: number) => {
    setSearchError(null);

    // Check if there's anything to search (query text or any filter)
    const hasFilters = filters.from || filters.in || filters.has || filters.before || filters.after || filters.mentions || filters.pinned;
    if (!filters.query.trim() && !hasFilters) return;

    // Resolve usernames/channel names to IDs (D1)
    let authorId: string | undefined;
    if (filters.from) {
      const resolved = resolveUsername(filters.from);
      if (!resolved) {
        setSearchError(`User '${filters.from}' not found`);
        return;
      }
      authorId = resolved;
    }

    let resolvedChannelId: string | undefined;
    if (filters.in) {
      const resolved = resolveChannelName(filters.in);
      if (!resolved) {
        setSearchError(`Channel '${filters.in}' not found`);
        return;
      }
      resolvedChannelId = resolved;
    }

    let mentionsUserId: string | undefined;
    if (filters.mentions) {
      const resolved = resolveUsername(filters.mentions);
      if (!resolved) {
        setSearchError(`User '${filters.mentions}' not found`);
        return;
      }
      mentionsUserId = resolved;
    }

    // The search query text (without filter tokens)
    const qText = filters.query.trim() || '';

    // Encrypted DM: client-side search (Part E)
    if (encrypted && dmChannelId) {
      setLoading(true);
      try {
        const hybrid = searchDmMessagesHybrid(qText || '*', effectiveDmChannelId, 50);
        let mapped: SearchResult[] = hybrid.instant.results.map(r => ({
          id: r.id,
          channelId: r.dmChannelId,
          channelName: null,
          serverId: null,
          authorId: r.authorId,
          authorUsername: r.authorUsername ?? null,
          authorAvatar: null,
          content: r.content,
          createdAt: new Date(r.timestamp).toISOString(),
          attachmentUrl: null,
          attachmentName: null,
          attachmentContentType: null,
        }));

        // Apply client-side filters for encrypted DMs
        if (authorId) {
          mapped = mapped.filter(m => m.authorId === authorId);
        }
        if (filters.has) {
          mapped = mapped.filter(m => {
            if (filters.has === 'image') return m.attachmentContentType?.startsWith('image/');
            if (filters.has === 'video') return m.attachmentContentType?.startsWith('video/');
            if (filters.has === 'link') return /https?:\/\//.test(m.content || '');
            if (filters.has === 'file' || filters.has === 'attachment') return !!m.attachmentUrl;
            if (filters.has === 'sound') return m.attachmentContentType?.startsWith('audio/');
            return true;
          });
        }
        if (filters.before) {
          const beforeDate = new Date(filters.before);
          mapped = mapped.filter(m => new Date(m.createdAt) < beforeDate);
        }
        if (filters.after) {
          const afterDate = new Date(filters.after);
          mapped = mapped.filter(m => new Date(m.createdAt) > afterDate);
        }
        if (mentionsUserId) {
          const mentionMember = serverMembers.find(sm => sm.id === mentionsUserId)
            || dmParticipants.find(p => p.id === mentionsUserId);
          if (mentionMember) {
            mapped = mapped.filter(m => (m.content || '').includes(`@${mentionMember.username}`));
          }
        }

        setResults(mapped);
        setTotal(mapped.length);
        setHasMore(hybrid.instant.mayBeIncomplete);
        olderFetcherRef.current = hybrid.fetchOlder;
        setOlderFetched(false);
        setSearched(true);
        saveRecentSearch(rawInput, true);
        setRecentSearches(getRecentSearches());
      } catch {
        setSearched(true);
      } finally {
        setLoading(false);
      }
      return;
    }

    // Unencrypted DM: server API (D2)
    if (dmChannelId && !serverId) {
      setLoading(true);
      try {
        const res = await apiClient.searchDmMessages({
          q: qText || '*',
          dmChannelId: effectiveDmChannelId,
          authorId,
          has: filters.has as 'file' | 'image' | 'attachment' | undefined,
          before: filters.before,
          after: filters.after,
          mentions: mentionsUserId,
          pinned: filters.pinned,
          offset: newOffset,
          limit: 25,
        });
        const mapped: SearchResult[] = res.results.map(r => ({
          id: r.id,
          channelId: r.dmChannelId,
          channelName: null,
          serverId: null,
          authorId: r.authorId,
          authorUsername: r.authorUsername,
          authorAvatar: r.authorAvatar,
          content: r.content,
          createdAt: r.createdAt,
          attachmentUrl: r.attachmentUrl,
          attachmentName: r.attachmentName,
        }));
        if (newOffset === 0) {
          setResults(mapped);
        } else {
          setResults(prev => [...prev, ...mapped]);
        }
        setTotal(res.total);
        setHasMore(res.hasMore);
        setSearched(true);
        saveRecentSearch(rawInput);
        setRecentSearches(getRecentSearches());
      } catch {
        setSearched(true);
      } finally {
        setLoading(false);
      }
      return;
    }

    // Server channel search
    if (!serverId && !channelId) return;
    setLoading(true);
    try {
      const res = await apiClient.searchMessages({
        q: qText || '*',
        serverId,
        channelId: resolvedChannelId ?? channelId,
        authorId,
        has: filters.has as 'file' | 'image' | 'attachment' | undefined,
        before: filters.before,
        after: filters.after,
        mentions: mentionsUserId,
        pinned: filters.pinned,
        offset: newOffset,
        limit: 25,
      });
      if (newOffset === 0) {
        setResults(res.results);
      } else {
        setResults(prev => [...prev, ...res.results]);
      }
      setTotal(res.total);
      setHasMore(res.hasMore);
      setSearched(true);
      saveRecentSearch(rawInput);
      setRecentSearches(getRecentSearches());
    } catch {
      setSearched(true);
    } finally {
      setLoading(false);
    }
  }, [serverId, channelId, encrypted, dmChannelId, effectiveDmChannelId, resolveUsername, resolveChannelName, serverMembers, dmParticipants]);

  // Input change handler (C2)
  const handleInputChange = useCallback((value: string) => {
    setQuery(value);
    setOffset(0);
    setSearchError(null);
    setShowSearchHelp(false);

    // Parse filters from the full input
    const filters = parseSearchTokens(value);
    setActiveFilters(filters);

    // Detect autocomplete at cursor position
    const cursorPos = inputRef.current?.selectionStart ?? value.length;
    const detection = detectAutocompleteAtCursor(value, cursorPos);

    if (detection) {
      setAutocompleteType(detection.type);
      setAutocompleteQuery(detection.partial);
      autocompleteTokenRef.current = { start: detection.tokenStart, end: detection.tokenEnd };
      const items = computeAutocomplete(detection.type, detection.partial);
      setAutocompleteResults(items);
      setAutocompleteIndex(0);
    } else {
      setAutocompleteType(null);
      setAutocompleteQuery('');
      setAutocompleteResults([]);
      setAutocompleteIndex(0);
      autocompleteTokenRef.current = null;
    }

    // Debounced search — only fire when autocomplete is not active
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!detection) {
      const hasFilters = filters.from || filters.in || filters.has || filters.before || filters.after || filters.mentions || filters.pinned;
      if (filters.query.trim().length >= 2 || hasFilters) {
        debounceRef.current = setTimeout(() => doSearch(value, filters, 0), 300);
      } else {
        setResults([]);
        setTotal(0);
        setHasMore(false);
        setSearched(false);
      }
    }
  }, [doSearch, computeAutocomplete]);

  // Select autocomplete item (C4)
  const selectAutocompleteItem = useCallback((item: AutocompleteItem) => {
    const token = autocompleteTokenRef.current;
    if (!token || !autocompleteType) return;

    // Replace the partial token with the completed value
    const before = query.substring(0, token.start);
    const after = query.substring(token.end);
    // Quote values with spaces
    const completedValue = item.label.includes(' ') ? `"${item.label}"` : item.label;
    const newQuery = `${before}${autocompleteType}:${completedValue}${after ? after : ' '}`;

    setQuery(newQuery);
    setAutocompleteType(null);
    setAutocompleteQuery('');
    setAutocompleteResults([]);
    setAutocompleteIndex(0);
    autocompleteTokenRef.current = null;

    // Re-parse and search
    const filters = parseSearchTokens(newQuery);
    setActiveFilters(filters);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    const hasFilters = filters.from || filters.in || filters.has || filters.before || filters.after || filters.mentions || filters.pinned;
    if (filters.query.trim().length >= 2 || hasFilters) {
      debounceRef.current = setTimeout(() => doSearch(newQuery, filters, 0), 300);
    }

    // Re-focus input
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [query, autocompleteType, doSearch]);

  // Remove a filter pill (C3)
  const removeFilter = useCallback((key: keyof SearchFilters) => {
    const newFilters = { ...activeFilters };
    if (key === 'pinned') {
      delete newFilters.pinned;
    } else if (key === 'query') {
      newFilters.query = '';
    } else {
      delete newFilters[key];
    }

    const newQuery = serializeFilters(newFilters);
    setQuery(newQuery);
    setActiveFilters(newFilters);
    setOffset(0);

    // Re-search
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const hasFilters = newFilters.from || newFilters.in || newFilters.has || newFilters.before || newFilters.after || newFilters.mentions || newFilters.pinned;
    if (newFilters.query.trim().length >= 2 || hasFilters) {
      debounceRef.current = setTimeout(() => doSearch(newQuery, newFilters, 0), 300);
    } else {
      setResults([]);
      setTotal(0);
      setHasMore(false);
      setSearched(false);
    }

    requestAnimationFrame(() => inputRef.current?.focus());
  }, [activeFilters, doSearch]);

  const showRecentSearches = inputFocused && !query && !autocompleteType && recentSearches.length > 0;

  // Keyboard navigation (C5)
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // Autocomplete navigation
    if (autocompleteType && autocompleteResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAutocompleteIndex(prev => (prev + 1) % autocompleteResults.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAutocompleteIndex(prev => (prev - 1 + autocompleteResults.length) % autocompleteResults.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        selectAutocompleteItem(autocompleteResults[autocompleteIndex]);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        selectAutocompleteItem(autocompleteResults[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAutocompleteType(null);
        setAutocompleteResults([]);
        return;
      }
    }

    // Search help
    if (showSearchHelp && e.key === 'Escape') {
      e.preventDefault();
      setShowSearchHelp(false);
      return;
    }

    // Recent searches dropdown
    if (showRecentSearches && e.key === 'Escape') {
      e.preventDefault();
      setInputFocused(false);
      return;
    }

    // Escape to close panel (when no autocomplete/help open)
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }

    // Enter to execute search
    if (e.key === 'Enter' && !autocompleteType) {
      e.preventDefault();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      const filters = parseSearchTokens(query);
      setActiveFilters(filters);
      setOffset(0);
      doSearch(query, filters, 0);
      return;
    }

    // Backspace on empty input: remove last filter
    if (e.key === 'Backspace' && query === '') {
      const filterKeys: Array<keyof SearchFilters> = ['mentions', 'after', 'before', 'has', 'in', 'from', 'pinned'];
      for (const key of filterKeys) {
        if (key === 'query') continue;
        if (key === 'pinned' && activeFilters.pinned) {
          removeFilter('pinned');
          return;
        }
        if (key !== 'pinned' && activeFilters[key]) {
          removeFilter(key);
          return;
        }
      }
    }
  }, [autocompleteType, autocompleteResults, autocompleteIndex, showSearchHelp, showRecentSearches, query, activeFilters, selectAutocompleteItem, removeFilter, onClose, doSearch]);

  const handleLoadMore = useCallback(async () => {
    // Encrypted DM: fetch older results from IDB
    if (encrypted && olderFetcherRef.current && !olderFetched) {
      setLoading(true);
      try {
        const older = await olderFetcherRef.current();
        const mapped: SearchResult[] = older.map(r => ({
          id: r.id,
          channelId: r.dmChannelId,
          channelName: null,
          serverId: null,
          authorId: r.authorId,
          authorUsername: r.authorUsername ?? null,
          authorAvatar: null,
          content: r.content,
          createdAt: new Date(r.timestamp).toISOString(),
          attachmentUrl: null,
          attachmentName: null,
        }));
        setResults(prev => [...prev, ...mapped]);
        setTotal(prev => prev + mapped.length);
        setHasMore(false);
        setOlderFetched(true);
      } catch {
        // Silently handle
      } finally {
        setLoading(false);
      }
      return;
    }

    const newOffset = offset + 25;
    setOffset(newOffset);
    doSearch(query, activeFilters, newOffset);
  }, [offset, query, activeFilters, doSearch, encrypted, olderFetched]);

  const formatDate = useCallback((iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }, []);

  const highlightMatch = useCallback((text: string, q: string) => {
    // Only highlight the query portion, not filter tokens
    if (!q.trim()) return text;
    const words = q.trim().split(/\s+/).filter(Boolean);
    const pattern = `(${words.map(escapeRegExp).join('|')})`;
    // eslint-disable-next-line security/detect-non-literal-regexp
    const splitRegex = new RegExp(pattern, 'gi');
    // Use a separate non-global regex for .test() — global regexes advance
    // lastIndex between calls, causing intermittent missed highlights.
    // eslint-disable-next-line security/detect-non-literal-regexp
    const testRegex = new RegExp(pattern, 'i');
    const parts = text.split(splitRegex);
    return parts.map((part, i) =>
      testRegex.test(part)
        ? <mark key={i} className="bg-[var(--cyan-accent)]/20 text-t-primary rounded-lg px-0.5">{part}</mark>
        : part
    );
  }, []);

  // Collect active filter entries for pills
  const activeFilterEntries = useMemo(() => {
    const entries: Array<{ key: keyof SearchFilters; label: string; value: string }> = [];
    if (activeFilters.from) entries.push({ key: 'from', label: 'from', value: activeFilters.from });
    if (activeFilters.in) entries.push({ key: 'in', label: 'in', value: activeFilters.in });
    if (activeFilters.has) entries.push({ key: 'has', label: 'has', value: activeFilters.has });
    if (activeFilters.before) entries.push({ key: 'before', label: 'before', value: formatFilterDisplay('before', activeFilters.before) });
    if (activeFilters.after) entries.push({ key: 'after', label: 'after', value: formatFilterDisplay('after', activeFilters.after) });
    if (activeFilters.mentions) entries.push({ key: 'mentions', label: 'mentions', value: activeFilters.mentions });
    if (activeFilters.pinned) entries.push({ key: 'pinned', label: 'pinned', value: 'true' });
    return entries;
  }, [activeFilters]);

  // Close search help when clicking outside
  const searchHelpRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showSearchHelp) return;
    const handler = (e: MouseEvent) => {
      if (searchHelpRef.current && !searchHelpRef.current.contains(e.target as Node)) {
        setShowSearchHelp(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSearchHelp]);

  const currentWidth = open ? panelWidth : 0;

  return (
    <motion.div
      initial={{ x: 30, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.15, ease: [0.25, 0.46, 0.45, 0.94] }}
      className={`shrink-0 flex h-full overflow-hidden relative ${isMobile ? 'absolute inset-0 z-50' : ''}`}
      style={isMobile ? {
        width: '100%',
        minWidth: '100%',
        opacity: 1,
      } : {
        width: currentWidth,
        minWidth: currentWidth,
        opacity: open ? 1 : 0,
        transition: isDragging ? 'none' : 'width 0.25s ease-out, min-width 0.25s ease-out, opacity 0.15s ease-out',
        paddingBottom: 12,
        paddingRight: 12,
        paddingLeft: 4,
      }}
    >
      {/* Resize handle — hidden on mobile */}
      {open && !isMobile && (
        <div
          className="absolute left-0 top-0 bottom-0 w-1.5 z-10 cursor-col-resize flex items-center justify-center hover:bg-[var(--cyan-accent)]/20 transition-colors"
          onMouseDown={onResizeStart}
        >
          <div className="w-0.5 h-8 rounded-full bg-white/0 group-hover:bg-[var(--cyan-accent)]/40 transition-colors" />
        </div>
      )}
    <div className={`flex flex-col h-full overflow-hidden ${isMobile ? '' : 'rounded-2xl'} flex-1 min-w-0`} style={{
      backgroundColor: isMobile ? 'var(--bg-chat)' : 'var(--glass-bg)',
      backdropFilter: isMobile ? undefined : 'blur(24px) saturate(1.3)',
      WebkitBackdropFilter: isMobile ? undefined : 'blur(24px) saturate(1.3)',
      boxShadow: isMobile ? undefined : 'var(--glass-shadow)',
      border: isMobile ? 'none' : (open ? '1px solid var(--glass-border)' : 'none'),
      borderRadius: isMobile ? 0 : undefined,
    } as React.CSSProperties}>
      {open && (
        <>
          {/* Tab bar with close */}
          <div className="shrink-0 flex items-center gap-1 px-2 pt-2 pb-1">
            {showPinned && (
              <button
                type="button"
                onClick={() => onSetMode('pinned')}
                className={`relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-colors ${mode === 'pinned' ? 'bg-fill-active text-t-accent' : 'hover:bg-fill-hover text-t-secondary'}`}
              >
                <Pin size={13} />
                {t('chat.pinnedMessages')}
                {pinnedCount > 0 && (
                  <span className="min-w-[16px] h-[16px] flex items-center justify-center rounded-full text-[9px] font-bold px-1" style={{ backgroundColor: 'var(--cyan-accent)', color: 'var(--text-on-accent)' }}>
                    {pinnedCount > 99 ? '99+' : pinnedCount}
                  </span>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => onSetMode('search')}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-colors ${mode === 'search' ? 'bg-fill-active text-t-accent' : 'hover:bg-fill-hover text-t-secondary'}`}
            >
              <Search size={13} />
              {t('search.placeholder', 'Search')}
            </button>
            <div className="flex-1" />
            <button type="button" onClick={onClose} className="p-1 rounded-lg hover:bg-fill-hover transition-colors shrink-0 text-t-secondary">
              <X size={13} />
            </button>
          </div>

          {/* Search input (only in search mode) */}
          {mode === 'search' && (
            <div className="shrink-0 relative mx-2 mb-1">
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ backgroundColor: 'var(--fill-hover)' }}>
                <Search size={14} className="shrink-0 text-t-secondary opacity-50" />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={e => handleInputChange(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => setTimeout(() => setInputFocused(false), 200)}
                  placeholder={t('search.hintDetail', 'Type at least 2 characters...')}
                  className="flex-1 bg-transparent text-xs placeholder:text-t-secondary outline-none min-w-0 text-t-primary"
                  maxLength={200}
                  autoComplete="off"
                  spellCheck={false}
                  role="combobox"
                  aria-expanded={!!autocompleteType && autocompleteResults.length > 0}
                  aria-haspopup="listbox"
                  aria-controls="search-autocomplete-listbox"
                  aria-activedescendant={autocompleteType && autocompleteResults.length > 0 ? `autocomplete-item-${autocompleteIndex}` : undefined}
                />
                {loading && <Loader2 size={12} className="shrink-0 animate-spin text-t-accent" />}
                {/* Search help button (C6) */}
                <div className="relative" ref={searchHelpRef}>
                  <button
                    type="button"
                    onClick={() => setShowSearchHelp(prev => !prev)}
                    className={`p-1 rounded-lg transition-colors ${showSearchHelp ? 'text-t-accent' : 'text-t-secondary opacity-50 hover:opacity-100'}`}
                    title="Search options"
                    aria-label="Search options"
                  >
                    <HelpCircle size={13} />
                  </button>
                  {/* Search help popup */}
                  {showSearchHelp && (
                    <div className={`absolute ${isMobile ? 'left-0 right-0' : 'right-0'} top-full mt-2 bg-[var(--bg-panel)] border border-[var(--glass-border)] rounded-lg shadow-lg z-50 p-3 ${isMobile ? 'w-[calc(100vw-2rem)]' : 'w-64'}`}>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-t-secondary mb-2">{t('search.filtersTitle')}</p>
                      <div className="space-y-1.5">
                        {SEARCH_HELP_ENTRIES.map(entry => (
                          <div key={entry.syntax} className="flex items-baseline gap-2">
                            <code className="text-[10px] font-mono text-t-accent whitespace-nowrap">{entry.syntax}</code>
                            <span className="text-[10px] text-t-secondary">{entry.description}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Autocomplete dropdown (C4) */}
              {autocompleteType && autocompleteResults.length > 0 && (
                <div
                  id="search-autocomplete-listbox"
                  role="listbox"
                  aria-label="Search filter suggestions"
                  className="absolute left-0 right-0 top-full mt-1 bg-[var(--bg-panel)] border border-[var(--glass-border)] rounded-lg shadow-lg z-50 max-h-[240px] overflow-y-auto"
                >
                  {autocompleteResults.map((item, i) => (
                    <button
                      key={item.id}
                      id={`autocomplete-item-${i}`}
                      type="button"
                      role="option"
                      aria-selected={i === autocompleteIndex}
                      className={`w-full flex items-center gap-2 px-3 text-sm text-left transition-colors ${
                        i === autocompleteIndex ? 'bg-[var(--fill-active)]' : 'hover:bg-[var(--fill-hover)]'
                      }`}
                      style={{ minHeight: isMobile ? 44 : 36, paddingTop: isMobile ? 10 : 8, paddingBottom: isMobile ? 10 : 8 }}
                      onClick={() => selectAutocompleteItem(item)}
                    >
                      {/* Icon based on autocomplete type */}
                      {(autocompleteType === 'from' || autocompleteType === 'mentions') && (
                        item.icon ? (
                          <img src={item.icon} alt="" className="w-5 h-5 rounded-[var(--radius-lg)] shrink-0" />
                        ) : (
                          <div className="w-5 h-5 shrink-0">
                            <LetterAvatar username={item.label} size={20} />
                          </div>
                        )
                      )}
                      {autocompleteType === 'in' && (
                        <Hash size={14} className="shrink-0 text-t-secondary" />
                      )}
                      {autocompleteType === 'has' && (
                        <Paperclip size={14} className="shrink-0 text-t-secondary" />
                      )}
                      {(autocompleteType === 'before' || autocompleteType === 'after') && (
                        <Calendar size={14} className="shrink-0 text-t-secondary" />
                      )}
                      <span className="text-xs text-t-primary truncate">{item.label}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Recent searches dropdown */}
              {showRecentSearches && (
                <div className="absolute left-0 right-0 top-full mt-1 bg-[var(--bg-panel)] border border-[var(--glass-border)] rounded-lg shadow-lg z-50 max-h-[240px] overflow-y-auto">
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--glass-border)]">
                    <span className="text-xs text-[var(--text-secondary)] font-medium uppercase tracking-wide">{t('search.recentSearches')}</span>
                    <button
                      type="button"
                      onClick={() => { localStorage.removeItem(RECENT_SEARCHES_KEY); setRecentSearches([]); }}
                      className="text-xs text-[var(--text-secondary)] hover:text-[var(--danger)] transition-colors"
                    >
                      {t('common.clear')}
                    </button>
                  </div>
                  {recentSearches.map((search, i) => (
                    <button
                      key={i}
                      type="button"
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-[var(--fill-hover)] transition-colors"
                      style={isMobile ? { minHeight: 44 } : undefined}
                      onClick={() => {
                        setQuery(search);
                        setInputFocused(false);
                        const filters = parseSearchTokens(search);
                        setActiveFilters(filters);
                        if (debounceRef.current) clearTimeout(debounceRef.current);
                        doSearch(search, filters, 0);
                      }}
                    >
                      <Clock size={14} className="text-[var(--text-secondary)] shrink-0" />
                      <span className="truncate text-[var(--text-primary)]">{search}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Filter pills bar (C3) */}
          {mode === 'search' && activeFilterEntries.length > 0 && (
            <div className={`shrink-0 px-3 py-1 flex items-center gap-1.5 ${isMobile ? 'overflow-x-auto flex-nowrap' : 'flex-wrap'}`}>
              {activeFilterEntries.map(entry => (
                <FilterPill
                  key={entry.key}
                  label={entry.label}
                  value={entry.value}
                  onRemove={() => removeFilter(entry.key)}
                />
              ))}
            </div>
          )}

          {/* Search error */}
          {mode === 'search' && searchError && (
            <div className="shrink-0 px-3 py-1 mx-2">
              <p className="text-[10px] text-red-400 font-medium">{searchError}</p>
            </div>
          )}

          {/* Encrypted DM indicator */}
          {mode === 'search' && encrypted && (
            <div className="shrink-0 flex items-center gap-1.5 px-3 py-1 mx-2 mb-1">
              <Lock size={10} className="text-emerald-400" />
              <span className="text-[10px] text-emerald-400/80 font-medium">Searching locally (E2E encrypted)</span>
            </div>
          )}

          {/* Results count */}
          {mode === 'search' && searched && results.length > 0 && (
            <div className="shrink-0 px-3 py-1 flex items-center">
              <span className="text-[10px] font-bold uppercase tracking-wider text-t-secondary">
                {total.toLocaleString()} {total === 1 ? 'result' : 'results'}
              </span>
            </div>
          )}

          {/* Content area */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {/* Search content */}
            {mode === 'search' && (
              <>
                {!searched && !loading && (
                  <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
                    <Search size={32} className="mb-3" style={{ color: 'var(--fill-active)' }} />
                    <p className="text-xs font-medium text-t-secondary">{encrypted ? 'Search encrypted messages locally' : t('search.hint', 'Search message history')}</p>
                  </div>
                )}

                {searched && results.length === 0 && !loading && (
                  <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
                    <MessageSquare size={32} className="mb-3" style={{ color: 'var(--fill-active)' }} />
                    <p className="text-xs font-medium text-t-secondary">{t('search.noResults', 'No messages found')}</p>
                  </div>
                )}

                {results.map(r => (
                  <button
                    key={r.id}
                    type="button"
                    className="w-full text-left px-3 py-2.5 hover:bg-fill-hover transition-colors rounded-lg group"
                    onClick={() => { onNavigateToMessage?.(r.channelId, r.id); onClose(); }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <UserAvatar
                        user={{ avatar: r.authorAvatar, username: r.authorUsername ?? '?', avatarEffect: r.authorAvatarEffect, effectivePlan: r.authorEffectivePlan }}
                        size={20}
                      />
                      <span className="text-xs font-semibold truncate text-t-primary">{(r.authorNameColor || r.authorNameFont || r.authorNameEffect)
                        ? <RoleNameStyle name={r.authorUsername ?? 'Unknown'} overrideColor={r.authorNameColor} overrideFont={r.authorNameFont} nameEffect={r.authorNameEffect} />
                        : (r.authorUsername ?? 'Unknown')}</span>
                      <span className="text-[9px] ml-auto shrink-0 text-t-secondary opacity-50">{formatDate(r.createdAt)}</span>
                    </div>
                    <p className="text-xs leading-relaxed line-clamp-2 mb-0.5 text-t-secondary">
                      {highlightMatch(r.content, activeFilters.query)}
                    </p>
                    <div className="flex items-center gap-1.5">
                      {r.channelName && (
                        <span className="flex items-center gap-0.5 text-[9px] text-t-secondary opacity-50">
                          <Hash size={8} />{r.channelName}
                        </span>
                      )}
                      {r.attachmentName && (
                        <span className="flex items-center gap-0.5 text-[9px] text-t-accent opacity-60">
                          <FileText size={8} /><span className="truncate max-w-[120px]">{r.attachmentName}</span>
                        </span>
                      )}
                    </div>
                  </button>
                ))}

                {hasMore && (
                  <button
                    type="button"
                    onClick={handleLoadMore}
                    disabled={loading}
                    className="w-full py-2.5 flex items-center justify-center gap-1.5 text-xs font-medium hover:bg-fill-hover transition-colors disabled:opacity-50 text-t-accent"
                  >
                    <ArrowDown size={12} />
                    {loading ? t('search.loading', 'Loading...') : t('search.loadMore', 'Load more')}
                  </button>
                )}
              </>
            )}

            {/* Pinned content */}
            {mode === 'pinned' && (
              <div className="p-2">
                {pinnedListLoading ? (
                  <div className="flex items-center justify-center py-16 text-t-secondary">
                    <Loader2 size={20} className="animate-spin" />
                  </div>
                ) : pinnedList.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
                    <Pin size={32} className="mb-3" style={{ color: 'var(--fill-active)' }} />
                    <p className="text-xs font-medium text-t-secondary">{t('chat.noPinnedMessages')}</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {pinnedList.map((msg) => {
                      const author = usersById.get(msg.authorId) ?? { id: msg.authorId, username: msg.authorUsername ?? 'Unknown', discriminator: '' as string | undefined };
                      return (
                        <div
                          key={msg.id}
                          className="p-3 rounded-xl border flex flex-col gap-1.5"
                          style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--fill-hover)' }}
                        >
                          <div className="flex items-center gap-2">
                            <UserAvatar user={author as { avatar?: string | null; username: string; avatarEffect?: string | null; effectivePlan?: string | null; stripePlan?: string | null }} size={20} />
                            <span className="text-xs font-semibold truncate text-t-primary">{(() => {
                              const plan = (author as { effectivePlan?: string | null; stripePlan?: string | null }).effectivePlan || (author as { stripePlan?: string | null }).stripePlan;
                              const nc = (author as { nameColor?: string | null }).nameColor;
                              const nf = (author as { nameFont?: string | null }).nameFont;
                              const ne = (author as { nameEffect?: string | null }).nameEffect;
                              return plan === 'pro' && (nc || nf || ne)
                                ? <RoleNameStyle name={author.username ?? 'Unknown'} overrideColor={nc} overrideFont={nf} nameEffect={ne} />
                                : (author.username ?? 'Unknown');
                            })()}</span>
                            <span className="text-[9px] ml-auto shrink-0 text-t-secondary opacity-50">
                              {formatDate(typeof msg.timestamp === 'string' ? msg.timestamp : new Date(msg.timestamp).toISOString())}
                            </span>
                          </div>
                          <p className="text-xs leading-relaxed break-words text-t-secondary">{msg.content || '(attachment)'}</p>
                          {msg.attachmentUrl && (
                            <div className="flex items-center gap-1 text-[9px] text-t-accent opacity-60">
                              <FileText size={10} /><span className="truncate">{msg.attachmentName || 'Attachment'}</span>
                            </div>
                          )}
                          {onUnpinMessage && (
                            <button
                              type="button"
                              onClick={() => { onUnpinMessage(msg.id); onRemovePinnedFromList?.(msg.id); }}
                              className="text-[9px] font-bold uppercase tracking-wider self-start mt-0.5 transition-colors hover:text-red-500 text-t-secondary"
                            >
                              {t('chat.unpin')}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
    </motion.div>
  );
};

export { DEFAULT_PANEL_WIDTH as RIGHT_PANEL_WIDTH };

/** @deprecated Use RightPanel */
export const SearchPanel = RightPanel;
/** @deprecated Use RightPanel */
export const SearchModal = RightPanel;
