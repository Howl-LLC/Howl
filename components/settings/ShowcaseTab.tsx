// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X, RefreshCw, Loader2, ExternalLink, Palette, GripVertical, Lock } from 'lucide-react';
import { apiClient } from '../../services/api';
import { renderCardContent, GAME_COLORS, type SpotifyData, type GameAccount } from '../showcase/cardRenderers';
import { useBreakpoint } from '../../hooks/useIsMobile';
import { useLongPressDrag } from '../../hooks/useLongPressDrag';
import { MobileCardEditor } from '../showcase/MobileCardEditor';
import { GAME_ICON_MAP } from '../icons/GamePlatformIcons';
import type { SteamPlaytimeEntry } from '../../services/api/gameAccounts';
import type { ShowcaseCard, GameAccountData } from '../../services/api/gameAccounts';
import { SettingsSection } from './SettingsWidgets';
import { getPlanPerks, type PlanTier } from '../../shared/planPerks';
import { Dropdown } from '../ui/dropdown';
import { DropdownMulti } from '../ui/dropdown-multi';

const VALID_SIZES = ['1x1', '2x1', '3x1', '1x2', '2x2', '1x3', '2x3', '3x2'] as const;

const COLOR_PRESETS: (string | null)[] = [
  null,
  '#FF4655', '#FFA500', '#0078D7', '#1DB954', '#9146FF',
  '#E24B4A', '#1D9E75', '#D4537E', '#BA7517', '#3C3489',
  '#0F6E56', '#5865F2',
];

export function getMaxSeasons(size: string): number {
  const [cols, rows] = size.split('x').map(Number);
  if (cols >= 3 && rows >= 2) return 6;
  if (cols >= 3) return 3;
  if (cols >= 2 && rows >= 2) return 4;
  if (rows >= 3) return 5;
  if (cols >= 2) return 2;
  if (rows >= 2) return 4;
  return 1;
}

export function getMaxStats(size: string): number {
  const [cols] = size.split('x').map(Number);
  if (cols >= 3) return 6;
  if (cols >= 2) return 5;
  return 3;
}

const GAME_NAMES: Record<string, string> = {
  valorant: 'Valorant', cs2: 'CS2', lol: 'League of Legends', tft: 'TFT',
  dota2: 'Dota 2', fortnite: 'Fortnite', apex: 'Apex Legends',
  marvel_rivals: 'Marvel Rivals', r6_siege: 'Rainbow Six Siege',
};

export const AVAILABLE_STATS: Record<string, Array<{ key: string; label: string }>> = {
  cs2: [
    { key: 'kd', label: 'K/D' }, { key: 'headshotPct', label: 'HS%' },
    { key: 'wins', label: 'Wins' }, { key: 'rounds', label: 'Rounds' },
    { key: 'mvps', label: 'MVPs' }, { key: 'hoursPlayed', label: 'Hours' },
  ],
  dota2: [
    { key: 'wins', label: 'Wins' }, { key: 'losses', label: 'Losses' },
    { key: 'winRate', label: 'Win%' }, { key: 'matches', label: 'Matches' }, { key: 'mmr', label: 'MMR' },
  ],
  valorant: [{ key: 'rr', label: 'RR' }, { key: 'elo', label: 'ELO' }],
  lol: [
    { key: 'wins', label: 'Wins' }, { key: 'losses', label: 'Losses' },
    { key: 'winRate', label: 'Win%' }, { key: 'matches', label: 'Matches' },
    { key: 'lp', label: 'LP' }, { key: 'level', label: 'Level' },
  ],
  tft: [
    { key: 'wins', label: 'Wins' }, { key: 'losses', label: 'Losses' },
    { key: 'winRate', label: 'Win%' }, { key: 'matches', label: 'Matches' }, { key: 'lp', label: 'LP' },
  ],
  fortnite: [
    { key: 'wins', label: 'Wins' }, { key: 'kd', label: 'K/D' },
    { key: 'winRate', label: 'Win%' }, { key: 'matches', label: 'Matches' },
    { key: 'hoursPlayed', label: 'Hours' }, { key: 'level', label: 'Level' },
  ],
  apex: [
    { key: 'kd', label: 'K/D' }, { key: 'kills', label: 'Kills' },
    { key: 'wins', label: 'Wins' }, { key: 'damage', label: 'Damage' },
    { key: 'matches', label: 'Matches' }, { key: 'level', label: 'Level' },
  ],
  marvel_rivals: [
    { key: 'kd', label: 'K/D' }, { key: 'winRate', label: 'Win%' },
    { key: 'matches', label: 'Matches' }, { key: 'kills', label: 'Kills' },
    { key: 'wins', label: 'Wins' }, { key: 'assists', label: 'Assists' },
  ],
  r6_siege: [
    { key: 'kd', label: 'K/D' }, { key: 'winRate', label: 'Win%' },
    { key: 'rankPoints', label: 'RP' }, { key: 'matches', label: 'Matches' },
    { key: 'kills', label: 'Kills' }, { key: 'peakRank', label: 'Peak' },
  ],
};

interface ShowcaseTabProps {
  userId: string;
}

/**
 * Steam-playtime refresh row for the Game Stats Refresh section. Same
 * visual rhythm as the per-game-account refresh rows (label + "last
 * updated" subtitle on the left, icon button on the right) so the user
 * sees all refresh controls in one place. Pulls fresh playtime +
 * recent-activity from the Steam Web API via POST /showcase/refresh-steam.
 */
const SteamRefreshRow: React.FC<{
  onRefreshed: (data: { steamPlaytime: SteamPlaytimeEntry[]; steamRecentActivity: SteamPlaytimeEntry[] }) => void;
}> = ({ onRefreshed }) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const iv = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(iv);
  }, [cooldown]);

  const handleClick = useCallback(async () => {
    if (loading || cooldown > 0) return;
    setError(null);
    setLoading(true);
    try {
      const resp = await apiClient.refreshSteamShowcase();
      onRefreshed({ steamPlaytime: resp.steamPlaytime, steamRecentActivity: resp.steamRecentActivity });
      setLastFetched(new Date(resp.fetchedAt));
      setCooldown(60);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Refresh failed';
      setError(msg);
      const match = /wait\s+(\d+)s/i.exec(msg);
      if (match) setCooldown(parseInt(match[1], 10));
      setTimeout(() => setError(null), 5000);
    } finally {
      setLoading(false);
    }
  }, [loading, cooldown, onRefreshed]);

  const disabled = loading || cooldown > 0;
  const agoText = lastFetched
    ? (() => {
        const mins = Math.round((Date.now() - lastFetched.getTime()) / 60000);
        const label = mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`;
        return t('showcase.lastUpdatedAgo', { defaultValue: `Last updated ${label} ago`, time: label });
      })()
    : t('showcase.steamClickToRefresh', { defaultValue: 'Click to refresh now' });

  return (
    <div className="flex items-center justify-between py-2">
      <div className="min-w-0">
        <p className="text-xs font-medium text-t-primary">{t('showcase.steamPlaytime', { defaultValue: 'Steam Playtime' })}</p>
        <p className="text-[10px] text-t-secondary">
          {agoText}
          {error && <span className="text-red-400 ml-1">· {error}</span>}
        </p>
      </div>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className="flex items-center gap-1.5 text-[10px] font-semibold px-3 py-1.5 rounded-lg border transition-all disabled:opacity-40"
        style={{
          borderColor: 'rgba(var(--cyan-accent-rgb, 0 200 255), 0.2)',
          color: 'var(--cyan-accent)',
        }}
        title={cooldown > 0 ? t('showcase.steamRefreshCooldown', { count: cooldown, defaultValue: `Available in ${cooldown}s` }) : undefined}
      >
        {loading
          ? <Loader2 size={11} className="animate-spin" />
          : <RefreshCw size={11} />}
        {cooldown > 0 ? `${cooldown}s` : t('common.refresh', { defaultValue: 'Refresh' })}
      </button>
    </div>
  );
};

export const ShowcaseTab: React.FC<ShowcaseTabProps> = ({ userId }) => {
  const { t } = useTranslation();
  const [layout, setLayout] = useState<ShowcaseCard[]>([]);
  const [gameAccounts, setGameAccounts] = useState<GameAccountData[]>([]);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editingCard, setEditingCard] = useState<string | null>(null);
  const [colorPickerCard, setColorPickerCard] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draggedCardId, setDraggedCardId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [loadingData, setLoadingData] = useState(true);
  const [subscription, setSubscription] = useState<{ plan: string | null; status: string | null; currentPeriodEnd: string | null } | null>(null);
  const [spotifyData, setSpotifyData] = useState<SpotifyData | null>(null);
  const [steamPlaytime, setSteamPlaytime] = useState<SteamPlaytimeEntry[]>([]);
  const [steamRecentActivity, setSteamRecentActivity] = useState<SteamPlaytimeEntry[]>([]);
  const breakpoint = useBreakpoint();
  const isMobile = breakpoint === 'mobile' || breakpoint === 'tablet';
  const [showDragHint, setShowDragHint] = useState(() => {
    if (typeof window === 'undefined') return true;
    return !localStorage.getItem('howl_drag_hint_seen');
  });
  const [editingMobileLayout, setEditingMobileLayout] = useState(false);
  const [mobileLayout, setMobileLayout] = useState<ShowcaseCard[]>([]);

  const effectivePlan = useMemo((): PlanTier => {
    if (!subscription?.plan) return null;
    if (subscription.status === 'active' || subscription.status === 'trialing' || subscription.status === 'admin_granted') return subscription.plan as PlanTier;
    if (subscription.currentPeriodEnd && new Date(subscription.currentPeriodEnd) > new Date()) return subscription.plan as PlanTier;
    return null;
  }, [subscription]);

  const perks = useMemo(() => getPlanPerks(effectivePlan), [effectivePlan]);

  const availableSizes = useMemo(() => {
    if (effectivePlan === 'pro') return [...VALID_SIZES];
    if (effectivePlan === 'essential') return VALID_SIZES.filter(s => s !== '3x2');
    return ['1x1', '2x1'] as string[];
  }, [effectivePlan]);

  const [linkedProviders, setLinkedProviders] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    Promise.all([
      apiClient.getShowcase(userId),
      apiClient.getGameAccounts(),
      apiClient.getSubscription().catch(() => null),
      apiClient.getSpotifyProfile(userId).catch(() => null),
      apiClient.getConnectedApps().catch(() => [] as Array<{ provider: string }>),
      apiClient.getSsoAccounts().catch(() => [] as Array<{ provider: string }>),
    ]).then(([showcase, accounts, sub, spotify, connected, sso]) => {
      const providers = new Set<string>();
      for (const a of connected) providers.add(a.provider);
      for (const a of sso) providers.add(a.provider);
      setLinkedProviders(providers);
      // Auto-clean invalid stat keys from game_stats cards
      const cleaned = showcase.layout.map(card => {
        if (card.type !== 'game_stats' || !card.game) return card;
        const available = AVAILABLE_STATS[card.game];
        if (!available) return card;
        const validKeys = new Set(available.map(s => s.key));
        const currentStats = (card.config?.stats as string[]) || [];
        const filtered = currentStats.filter(k => validKeys.has(k));
        const stats = filtered.length > 0 ? filtered : available.slice(0, getMaxStats(card.size)).map(s => s.key);
        if (stats.length !== currentStats.length || stats.some((s, i) => s !== currentStats[i])) {
          return { ...card, config: { ...card.config, stats } };
        }
        return card;
      });
      setLayout(cleaned);
      setMobileLayout(showcase.mobileLayout ?? []);
      setGameAccounts(accounts);
      setSteamPlaytime(showcase.steamPlaytime ?? []);
      setSteamRecentActivity(showcase.steamRecentActivity ?? []);
      if (sub) setSubscription(sub);
      if (spotify) setSpotifyData(spotify);
    }).catch(() => {}).finally(() => setLoadingData(false));
  }, [userId]);

  useEffect(() => {
    const handler = () => {
      Promise.all([
        apiClient.getShowcase(userId),
        apiClient.getGameAccounts(),
      ]).then(([showcase, accounts]) => {
        setLayout(showcase.layout);
        setMobileLayout(showcase.mobileLayout ?? []);
        setGameAccounts(accounts);
        setSteamPlaytime(showcase.steamPlaytime ?? []);
        setSteamRecentActivity(showcase.steamRecentActivity ?? []);
      }).catch(() => {});
    };
    window.addEventListener('game-accounts-changed', handler);
    return () => window.removeEventListener('game-accounts-changed', handler);
  }, [userId]);

  // Layout operations

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveLayout = useCallback((newLayout: ShowcaseCard[]) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaving(true);
    setError(null);
    saveTimerRef.current = setTimeout(async () => {
      try {
        const result = await apiClient.updateShowcaseLayout(newLayout);
        setLayout(result.layout);
      } catch (err) {
        setError((err as Error).message || t('toast.failedToSave', { defaultValue: 'Failed to save' }));
      }
      setSaving(false);
    }, 2000);
  }, [t]);

  useEffect(() => {
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, []);

  const saveMobileLayout = useCallback((newLayout: ShowcaseCard[]) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaving(true);
    setError(null);
    saveTimerRef.current = setTimeout(async () => {
      try {
        const result = await apiClient.updateMobileShowcaseLayout(newLayout);
        setMobileLayout(result.mobileLayout);
      } catch (err) {
        setError((err as Error).message || t('toast.failedToSave', { defaultValue: 'Failed to save' }));
      }
      setSaving(false);
    }, 2000);
  }, [t]);

  const activeLayout = editingMobileLayout ? mobileLayout : layout;

  const updateLayout = useCallback((updater: (current: ShowcaseCard[]) => ShowcaseCard[]) => {
    if (editingMobileLayout) {
      setMobileLayout(prev => {
        const next = updater(prev);
        saveMobileLayout(next);
        return next;
      });
    } else {
      setLayout(prev => {
        const next = updater(prev);
        saveLayout(next);
        return next;
      });
    }
  }, [editingMobileLayout, saveMobileLayout, saveLayout]);

  const moveCard = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    updateLayout(current => {
      const newLayout = [...current];
      const [card] = newLayout.splice(fromIndex, 1);
      newLayout.splice(toIndex, 0, card);
      return newLayout.map((c, i) => ({ ...c, position: i }));
    });
  }, [updateLayout]);

  const longPressDrag = useLongPressDrag({
    delay: 300,
    onDragOver: (fromIndex, toIndex) => { moveCard(fromIndex, toIndex); },
  });

  const dismissDragHint = useCallback(() => {
    setShowDragHint(false);
    try { localStorage.setItem('howl_drag_hint_seen', '1'); } catch { /* ignore */ }
  }, []);

  // Copy desktop layout when first switching to mobile editing
  useEffect(() => {
    if (editingMobileLayout && mobileLayout.length === 0 && layout.length > 0) {
      const copied = layout.map(card => {
        const [cols, rows] = card.size.split('x').map(Number);
        const cappedSize = cols > 2 ? `2x${rows}` : card.size;
        return { ...card, size: cappedSize };
      });
      setMobileLayout(copied);
    }
  }, [editingMobileLayout]);

  const addCard = useCallback((type: string, game?: string, size = '1x1') => {
    let defaultConfig: Record<string, unknown> = {};
    if (type === 'game_stats' && game && AVAILABLE_STATS[game]) {
      defaultConfig = { stats: AVAILABLE_STATS[game].slice(0, 3).map(s => s.key) };
    }
    updateLayout(current => [...current, {
      id: crypto.randomUUID(),
      type,
      game: game || null,
      size,
      position: current.length,
      color: null,
      config: defaultConfig,
    }]);
    setAddOpen(false);
  }, [updateLayout]);

  const removeCard = useCallback((cardId: string) => {
    updateLayout(current => current.filter(c => c.id !== cardId).map((c, i) => ({ ...c, position: i })));
  }, [updateLayout]);

  const resizeCard = useCallback((cardId: string, newSize: string) => {
    updateLayout(current => {
      const card = current.find(c => c.id === cardId);
      if (card?.type === 'rank_timeline' && newSize === '1x1') return current;
      return current.map(c => {
        if (c.id !== cardId) return c;
        const updated = { ...c, size: newSize };
        if (c.type === 'game_stats' && c.config?.stats) {
          const maxStats = getMaxStats(newSize);
          const currentStats = c.config.stats as string[];
          if (currentStats.length > maxStats) {
            updated.config = { ...c.config, stats: currentStats.slice(0, maxStats) };
          }
        }
        return updated;
      });
    });
  }, [updateLayout]);

  // Drag-and-drop reordering

  const handleDragStart = useCallback((e: React.DragEvent, cardId: string) => {
    setDraggedCardId(cardId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', cardId);
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-card-id="${cardId}"]`) as HTMLElement;
      if (el) el.style.opacity = '0.4';
    });
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent, targetCardId: string) => {
    e.preventDefault();
    if (targetCardId !== draggedCardId) {
      setDropTargetId(targetCardId);
    }
  }, [draggedCardId]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    const relatedTarget = e.relatedTarget as HTMLElement;
    const currentTarget = e.currentTarget as HTMLElement;
    if (!currentTarget.contains(relatedTarget)) {
      setDropTargetId(null);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetCardId: string) => {
    e.preventDefault();
    setDropTargetId(null);
    if (!draggedCardId || draggedCardId === targetCardId) return;

    updateLayout(current => {
      const dragIdx = current.findIndex(c => c.id === draggedCardId);
      const dropIdx = current.findIndex(c => c.id === targetCardId);
      if (dragIdx < 0 || dropIdx < 0) return current;
      const newLayout = [...current];
      const [moved] = newLayout.splice(dragIdx, 1);
      newLayout.splice(dropIdx, 0, moved);
      return newLayout.map((c, i) => ({ ...c, position: i }));
    });
  }, [draggedCardId, updateLayout]);

  const handleDragEnd = useCallback(() => {
    setDraggedCardId(null);
    setDropTargetId(null);
    document.querySelectorAll('[data-card-id]').forEach(el => {
      (el as HTMLElement).style.opacity = '';
    });
  }, []);

  const updateCardColor = useCallback((cardId: string, color: string | null) => {
    updateLayout(current => current.map(c => c.id === cardId ? { ...c, color } : c));
    setColorPickerCard(null);
  }, [updateLayout]);


  // Refresh

  const handleRefresh = useCallback(async (gameAccountId: string) => {
    setRefreshing(gameAccountId);
    try {
      const result = await apiClient.refreshGameAccount(gameAccountId);
      setGameAccounts(prev => prev.map(a => a.id === gameAccountId ? {
        ...a, rank: result.rank, stats: result.stats,
        lastFetched: result.lastFetched, nextRefreshAt: result.nextRefreshAt,
        fetchError: result.fetchError, errorRetryCount: result.errorRetryCount ?? 0,
        errorTransient: result.errorTransient ?? false,
      } : a));
    } catch (err) {
      setError((err as Error).message || t('showcase.refreshFailed', { defaultValue: 'Refresh failed' }));
    }
    setRefreshing(null);
  }, []);

  // Helpers

  const linkedGames = gameAccounts.map(a => a.game);

  const updateCardConfig = useCallback((cardId: string, config: Record<string, unknown>) => {
    updateLayout(current => current.map(c => c.id === cardId ? { ...c, config: { ...c.config, ...config } } : c));
  }, [updateLayout]);

  // Convert GameAccountData[] to GameAccount[] shape for cardRenderers
  const rendererAccounts: GameAccount[] = gameAccounts.map(a => ({
    id: a.id, game: a.game, provider: a.provider, displayName: a.displayName,
    verified: a.verified, rank: a.rank, stats: a.stats,
    lastFetched: a.lastFetched, fetchError: a.fetchError,
    errorRetryCount: a.errorRetryCount ?? null,
    errorTransient: a.errorTransient ?? null,
  }));

  // Render

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight mb-2 text-t-primary">
          {t('settings.showcase', { defaultValue: 'Showcase' })}
        </h2>
        <p className="text-xs text-t-secondary">
          {t('settings.showcaseDesc', { defaultValue: 'Customize what appears on your profile showcase.' })}
        </p>
      </div>

      {error && <div className="text-sm text-red-400 text-center py-2">{error}</div>}

      {loadingData && (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={20} className="animate-spin text-t-secondary" style={{ opacity: 0.3 }} />
        </div>
      )}

      {!loadingData && (<>
      {/* Rest of content wrapped in loading guard */}

      {/* ── Grid Editor ──────────────────────────────────────────────────── */}
      <SettingsSection title={t('settings.showcaseCards', { defaultValue: 'Your Cards' })}>
        <div className="flex items-center justify-between mb-4">
          <span className="text-[11px] text-t-secondary">
            {activeLayout.length} / {perks.maxShowcaseCards} cards
            {editingMobileLayout && <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded-lg" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 10%, transparent)', color: 'var(--cyan-accent)' }}>Mobile</span>}
            {effectivePlan && <span className="ml-1.5" style={{ color: 'var(--cyan-accent)', opacity: 0.6 }}>{effectivePlan === 'pro' ? 'Pro' : 'Essential'}</span>}
            {saving && <span className="ml-2 text-[var(--cyan-accent)]">{t('common.saving', { defaultValue: 'Saving...' })}</span>}
          </span>
          <div id="setting-add-showcase-card">
          <button
            type="button"
            onClick={() => setAddOpen(!addOpen)}
            disabled={activeLayout.length >= perks.maxShowcaseCards}
            className="btn-cta flex items-center gap-1.5 text-[10px] px-3 py-1.5 rounded-xl transition-all disabled:opacity-30"
          >
            <Plus size={12} /> {activeLayout.length >= perks.maxShowcaseCards ? t('showcase.upgradeForMore', { defaultValue: 'Upgrade for more' }) : t('settings.showcaseAdd', { defaultValue: 'Add card' })}
          </button>
          </div>
        </div>

        {/* Add card dropdown */}
        {addOpen && (
          <div className="mb-4 p-3 rounded-xl border border-[var(--glass-border)]" style={{ backgroundColor: 'var(--fill-hover)' }}>
            {/* Game Cards section */}
            <p className="text-[9px] font-bold uppercase tracking-widest mb-2 text-t-secondary" style={{ opacity: 0.4 }}>{t('showcase.gameCards', { defaultValue: 'Game Cards' })}</p>
            {linkedGames.length > 0 ? (
              <div className="grid grid-cols-2 gap-1.5 mb-4">
                {linkedGames.map(game => (
                  <React.Fragment key={game}>
                    <button type="button"
                      onClick={() => addCard('game_rank', game, '1x1')}
                      className="text-left px-3 py-2 rounded-lg text-[11px] transition-colors hover:bg-fill-hover border border-transparent hover:border-[var(--glass-border)] flex items-center gap-1.5"
                    >
                      {GAME_ICON_MAP[game] && React.createElement(GAME_ICON_MAP[game], { size: 12 })}
                      <span className="font-semibold text-t-primary">{t('showcase.rank', { defaultValue: 'Rank' })}</span>
                      <span className="text-t-secondary">— {GAME_NAMES[game] || game}</span>
                    </button>
                    <button type="button"
                      onClick={() => addCard('game_stats', game, '2x1')}
                      className="text-left px-3 py-2 rounded-lg text-[11px] transition-colors hover:bg-fill-hover border border-transparent hover:border-[var(--glass-border)] flex items-center gap-1.5"
                    >
                      {GAME_ICON_MAP[game] && React.createElement(GAME_ICON_MAP[game], { size: 12 })}
                      <span className="font-semibold text-t-primary">{t('showcase.stats', { defaultValue: 'Stats' })}</span>
                      <span className="text-t-secondary">— {GAME_NAMES[game] || game}</span>
                    </button>
                    {(game === 'r6_siege' || game === 'marvel_rivals') && (
                      <button type="button"
                        onClick={() => addCard('rank_timeline', game, '2x1')}
                        className="text-left px-3 py-2 rounded-lg text-[11px] transition-colors hover:bg-fill-hover border border-transparent hover:border-[var(--glass-border)] flex items-center gap-1.5"
                      >
                        {GAME_ICON_MAP[game] && React.createElement(GAME_ICON_MAP[game], { size: 12 })}
                        <span className="font-semibold text-t-primary">{t('showcase.timeline', { defaultValue: 'Timeline' })}</span>
                        <span className="text-t-secondary">— {GAME_NAMES[game] || game}</span>
                      </button>
                    )}
                  </React.Fragment>
                ))}
              </div>
            ) : (
              <p className="text-[10px] text-t-secondary mb-4" style={{ opacity: 0.4 }}>
                {t('showcase.linkGameAccountsHint', { defaultValue: 'Link game accounts in Settings \u2192 Linked Apps to add game cards' })}
              </p>
            )}

            {/* Spotify section */}
            <p className="text-[9px] font-bold uppercase tracking-widest mb-2 text-t-secondary" style={{ opacity: 0.4 }}>{t('showcase.spotify', { defaultValue: 'Spotify' })}</p>
            <div className="grid grid-cols-2 gap-1.5 mb-4">
              {[
                { type: 'spotify_artists', labelKey: 'showcase.topArtists', label: 'Top Artists', size: '2x1' },
                { type: 'spotify_tracks', labelKey: 'showcase.topTracks', label: 'Top Tracks', size: '1x2' },
                { type: 'spotify_now_playing', labelKey: 'showcase.nowPlaying', label: 'Now Playing', size: '1x1' },
              ].map(opt => {
                const linked = linkedProviders.has('spotify');
                return (
                  <button key={opt.type} type="button"
                    onClick={() => linked && addCard(opt.type, undefined, opt.size)}
                    disabled={!linked}
                    title={linked ? undefined : t('showcase.linkProviderFirst', { provider: 'Spotify', defaultValue: 'Link Spotify in Linked Apps to use this card' })}
                    className="text-left px-3 py-2 rounded-lg text-[11px] font-semibold transition-colors hover:bg-fill-hover border border-transparent hover:border-[var(--glass-border)] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                  >
                    <span className="text-t-primary flex-1">{t(opt.labelKey, { defaultValue: opt.label })}</span>
                    {!linked && <Lock size={10} className="text-t-secondary" />}
                  </button>
                );
              })}
            </div>

            {/* Platform Profiles section */}
            <p className="text-[9px] font-bold uppercase tracking-widest mb-2 text-t-secondary" style={{ opacity: 0.4 }}>{t('showcase.platformProfiles', { defaultValue: 'Platform Profiles' })}</p>
            <div className="grid grid-cols-2 gap-1.5 mb-4">
              {[
                { type: 'twitch_stats', provider: 'twitch', labelKey: 'showcase.twitchStats', label: 'Twitch Stats', size: '1x1' },
                { type: 'youtube_stats', provider: 'youtube', labelKey: 'showcase.youtubeStats', label: 'YouTube Stats', size: '2x1' },
                { type: 'github_stats', provider: 'github', labelKey: 'showcase.githubStats', label: 'GitHub Stats', size: '2x2' },
                { type: 'reddit_stats', provider: 'reddit', labelKey: 'showcase.redditStats', label: 'Reddit Stats', size: '1x1' },
              ].map(opt => {
                const linked = linkedProviders.has(opt.provider);
                const providerLabel = opt.provider.charAt(0).toUpperCase() + opt.provider.slice(1);
                return (
                  <button key={opt.type} type="button"
                    onClick={() => linked && addCard(opt.type, undefined, opt.size)}
                    disabled={!linked}
                    title={linked ? undefined : t('showcase.linkProviderFirst', { provider: providerLabel, defaultValue: `Link ${providerLabel} in Linked Apps to use this card` })}
                    className="text-left px-3 py-2 rounded-lg text-[11px] font-semibold transition-colors hover:bg-fill-hover border border-transparent hover:border-[var(--glass-border)] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                  >
                    <span className="text-t-primary flex-1">{t(opt.labelKey, { defaultValue: opt.label })}</span>
                    {!linked && <Lock size={10} className="text-t-secondary" />}
                  </button>
                );
              })}
            </div>

            {/* Other section */}
            <p className="text-[9px] font-bold uppercase tracking-widest mb-2 text-t-secondary" style={{ opacity: 0.4 }}>{t('showcase.other', { defaultValue: 'Other' })}</p>
            <div className="grid grid-cols-2 gap-1.5">
              {(() => {
                const steamLinked = linkedProviders.has('steam');
                const steamAllowed = perks.showcaseSteamPlaytime && steamLinked;
                return (
                  <>
                    <button type="button"
                      onClick={() => { if (steamAllowed) addCard('steam_playtime', undefined, '1x2'); }}
                      disabled={!steamAllowed}
                      title={!perks.showcaseSteamPlaytime
                        ? t('showcase.upgradeForCard', { defaultValue: 'Upgrade for this card' })
                        : !steamLinked
                          ? t('showcase.linkProviderFirst', { provider: 'Steam', defaultValue: 'Link Steam in Linked Apps to use this card' })
                          : undefined}
                      className="text-left px-3 py-2 rounded-lg text-[11px] font-semibold transition-colors hover:bg-fill-hover border border-transparent hover:border-[var(--glass-border)] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                    >
                      <span className="text-t-primary flex-1">{t('showcase.steamPlaytime', { defaultValue: 'Steam Playtime' })}</span>
                      {!steamAllowed && <Lock size={10} className="text-t-secondary" />}
                      {!perks.showcaseSteamPlaytime && <span className="text-[8px] font-bold uppercase px-1 py-0.5 rounded-lg" style={{ backgroundColor: 'var(--fill-active)', color: 'var(--text-secondary)' }}>Essential+</span>}
                    </button>
                    <button type="button"
                      onClick={() => { if (steamAllowed) addCard('steam_recent_activity', undefined, '1x2'); }}
                      disabled={!steamAllowed}
                      title={!perks.showcaseSteamPlaytime
                        ? t('showcase.upgradeForCard', { defaultValue: 'Upgrade for this card' })
                        : !steamLinked
                          ? t('showcase.linkProviderFirst', { provider: 'Steam', defaultValue: 'Link Steam in Linked Apps to use this card' })
                          : undefined}
                      className="text-left px-3 py-2 rounded-lg text-[11px] font-semibold transition-colors hover:bg-fill-hover border border-transparent hover:border-[var(--glass-border)] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                    >
                      <span className="text-t-primary flex-1">{t('showcase.steamRecentActivity', { defaultValue: 'Steam Recent Activity' })}</span>
                      {!steamAllowed && <Lock size={10} className="text-t-secondary" />}
                      {!perks.showcaseSteamPlaytime && <span className="text-[8px] font-bold uppercase px-1 py-0.5 rounded-lg" style={{ backgroundColor: 'var(--fill-active)', color: 'var(--text-secondary)' }}>Essential+</span>}
                    </button>
                  </>
                );
              })()}
              <button type="button"
                onClick={() => !perks.showcaseCustomText || addCard('custom_text', undefined, '1x1')}
                disabled={!perks.showcaseCustomText}
                className="text-left px-3 py-2 rounded-lg text-[11px] font-semibold transition-colors hover:bg-fill-hover border border-transparent hover:border-[var(--glass-border)] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                <span className="text-t-primary">{t('showcase.customText', { defaultValue: 'Custom Text' })}</span>
                {!perks.showcaseCustomText && <Lock size={10} className="text-t-secondary" />}
                {!perks.showcaseCustomText && <span className="text-[8px] font-bold uppercase px-1 py-0.5 rounded-lg" style={{ backgroundColor: 'var(--fill-active)', color: 'var(--text-secondary)' }}>Pro</span>}
              </button>
            </div>
          </div>
        )}

        {/* Mobile layout toggle */}
        {perks.showcaseMobileLayout ? (
          <div id="setting-showcase-layout-toggle" className="flex items-center gap-2 mb-4">
            <button type="button" onClick={() => setEditingMobileLayout(false)}
              className="text-[10px] font-semibold px-3 py-1.5 rounded-lg transition-all"
              style={{
                backgroundColor: !editingMobileLayout ? 'color-mix(in srgb, var(--cyan-accent) 12%, transparent)' : 'var(--fill-hover)',
                color: !editingMobileLayout ? 'var(--cyan-accent)' : 'var(--text-secondary)',
                border: `1px solid ${!editingMobileLayout ? 'color-mix(in srgb, var(--cyan-accent) 20%, transparent)' : 'var(--border-subtle)'}`,
              }}>
              {t('showcase.desktopLayout', { defaultValue: 'Desktop layout' })}
            </button>
            <button type="button" onClick={() => setEditingMobileLayout(true)}
              className="text-[10px] font-semibold px-3 py-1.5 rounded-lg transition-all"
              style={{
                backgroundColor: editingMobileLayout ? 'color-mix(in srgb, var(--cyan-accent) 12%, transparent)' : 'var(--fill-hover)',
                color: editingMobileLayout ? 'var(--cyan-accent)' : 'var(--text-secondary)',
                border: `1px solid ${editingMobileLayout ? 'color-mix(in srgb, var(--cyan-accent) 20%, transparent)' : 'var(--border-subtle)'}`,
              }}>
              {t('showcase.mobileLayout', { defaultValue: 'Mobile layout' })}
            </button>
          </div>
        ) : (
          <div id="setting-showcase-layout-toggle" className="flex items-center gap-2 mb-4 opacity-50 cursor-not-allowed">
            <span className="text-[10px] text-t-secondary">{t('showcase.mobileLayoutCustomization', { defaultValue: 'Mobile layout customization' })}</span>
            <Lock size={10} className="text-t-secondary" />
            <span className="text-[8px] font-bold uppercase px-1 py-0.5 rounded-lg" style={{ backgroundColor: 'var(--fill-active)', color: 'var(--text-secondary)' }}>Essential+</span>
          </div>
        )}

        {/* Grid preview with drag-and-drop + edit overlays */}
        {activeLayout.length > 0 ? (
          <>
          <div id="setting-reorder-cards" style={{
            display: 'grid', gridTemplateColumns: `repeat(${isMobile || editingMobileLayout ? 2 : 3}, 1fr)`,
            gap: isMobile ? '6px' : '10px', gridAutoRows: isMobile ? '90px' : '110px', gridAutoFlow: 'dense',
          }}>
            {[...activeLayout].sort((a, b) => a.position - b.position).map((card, index) => {
              const [cols, rows] = (card.size.split('x').map(Number)) as [number, number];
              const cappedCols = (isMobile || editingMobileLayout) ? Math.min(cols || 1, 2) : (cols || 1);
              const accentColor = card.color || (card.game ? GAME_COLORS[card.game] || 'var(--text-faint)' : 'var(--text-faint)');
              const isEditing = editingCard === card.id;
              const isDropTarget = dropTargetId === card.id;
              const touchProps = isMobile ? longPressDrag.getItemProps(index) : null;
              return (
                <div
                  key={card.id}
                  data-card-id={card.id}
                  data-drag-index={index}
                  draggable={!isMobile}
                  onClick={isMobile ? () => setEditingCard(card.id) : undefined}
                  onDragStart={!isMobile ? (e) => handleDragStart(e, card.id) : undefined}
                  onDragOver={!isMobile ? handleDragOver : undefined}
                  onDragEnter={!isMobile ? (e) => handleDragEnter(e, card.id) : undefined}
                  onDragLeave={!isMobile ? handleDragLeave : undefined}
                  onDrop={!isMobile ? (e) => handleDrop(e, card.id) : undefined}
                  onDragEnd={!isMobile ? handleDragEnd : undefined}
                  onMouseEnter={!isMobile ? () => { if (!draggedCardId) setEditingCard(card.id); } : undefined}
                  onMouseLeave={!isMobile ? () => { if (!draggedCardId) { setEditingCard(null); setColorPickerCard(null); } } : undefined}
                  onTouchStart={touchProps?.onTouchStart}
                  onTouchMove={touchProps?.onTouchMove}
                  onTouchEnd={touchProps?.onTouchEnd}
                  className="group relative rounded-xl"
                  style={{
                    gridColumn: `span ${cappedCols}`,
                    gridRow: `span ${rows || 1}`,
                    background: `color-mix(in srgb, ${accentColor} 5%, transparent)`,
                    border: `1px solid ${isDropTarget ? 'var(--cyan-accent)' : `color-mix(in srgb, ${accentColor} 15%, transparent)`}`,
                    borderRadius: '12px',
                    padding: isMobile ? '10px' : '14px',
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column',
                    cursor: isMobile ? 'pointer' : 'grab',
                    transition: 'border-color 0.15s, opacity 0.15s, box-shadow 0.15s',
                    boxShadow: isDropTarget ? '0 0 12px var(--accent-muted)' : 'none',
                    ...(touchProps?.style || {}),
                  }}
                >
                  {/* Mobile size badge */}
                  {isMobile && (
                    <span className="absolute top-1 right-1 text-[7px] px-1.5 py-0.5 rounded-lg z-[5]"
                      style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--text-secondary)' }}>
                      {card.size}
                    </span>
                  )}

                  {renderCardContent(card, rendererAccounts, spotifyData, null, steamPlaytime, steamRecentActivity)}

                  {/* Edit overlay on hover (desktop only) */}
                  {!isMobile && isEditing && !draggedCardId && (
                    <div className="absolute inset-0 rounded-xl flex items-start justify-between p-1.5 z-10" style={{ background: 'var(--overlay-backdrop)' }}>
                      {/* Drag handle */}
                      <div className="cursor-grab active:cursor-grabbing p-1" title="Drag to reorder">
                        <GripVertical size={12} className="text-white/40" />
                      </div>
                      <div className="flex gap-0.5">
                        {/* Size picker */}
                        <div id="setting-edit-card-size">
                        <Dropdown
                          options={VALID_SIZES.map(s => {
                            const isBlocked = !availableSizes.includes(s);
                            const isTimelineBlocked = card.type === 'rank_timeline' && s === '1x1';
                            return { value: s, label: s + (isBlocked ? ' 🔒' : isTimelineBlocked ? ' ⛔' : ''), disabled: isBlocked || isTimelineBlocked };
                          })}
                          value={card.size}
                          onChange={(v) => resizeCard(card.id, v)}
                          size="tiny"
                        />
                        </div>
                        {/* Color picker */}
                        <button id="setting-edit-card-color" type="button" onClick={() => setColorPickerCard(colorPickerCard === card.id ? null : card.id)} className="p-1 rounded-lg hover:bg-fill-active" title="Color">
                          <Palette size={11} className="text-white/60" />
                        </button>
                        {/* Remove */}
                        <button id="setting-remove-card" type="button" onClick={() => removeCard(card.id)} className="p-1 rounded-lg hover:bg-red-500/30" title="Remove">
                          <X size={11} className="text-red-400" />
                        </button>
                      </div>
                      {/* Color presets dropdown */}
                      {colorPickerCard === card.id && (
                        <div className="absolute top-8 right-0 p-2 rounded-lg border border-[var(--glass-border)] z-20 flex flex-wrap gap-1.5 w-36" style={{ backgroundColor: 'rgba(15,20,35,0.95)' }}>
                          {COLOR_PRESETS.map((c, i) => (
                            <button key={i} type="button" onClick={() => updateCardColor(card.id, c)}
                              className="w-5 h-5 rounded-full border transition-transform hover:scale-110"
                              style={{ backgroundColor: c || 'var(--fill-active)', borderColor: card.color === c ? 'white' : 'var(--border-strong)' }}
                              title={c || 'Default'}
                            />
                          ))}
                        </div>
                      )}
                      {/* Season selector for any game with season data (1x1 rank cards) */}
                      {card.type === 'game_rank' && card.size === '1x1' && (() => {
                        const account = rendererAccounts.find(a => a.game === card.game);
                        const seasonsJson = account?.stats?.seasons as string | undefined;
                        if (!seasonsJson) return null;
                        try {
                          const seasonsList = JSON.parse(seasonsJson) as Array<{ seasonId: number; seasonName?: string | null; seasonFullName?: string | null; rankName: string | null; rankPoints?: number; rankScore?: number }>;
                          if (seasonsList.length <= 1) return null;
                          return (
                            <div id="setting-card-season-selector" className="mt-1">
                              <Dropdown
                                options={seasonsList.map(s => ({
                                  value: s.seasonId,
                                  label: `${s.seasonName || `S${s.seasonId}`}: ${s.rankName || 'Unranked'}${s.seasonFullName ? ` (${s.seasonFullName})` : ''}${s.rankPoints ? ` · ${s.rankPoints.toLocaleString()} pts` : ''}`,
                                }))}
                                value={(card.config?.seasonId as number) || seasonsList[0]?.seasonId}
                                onChange={(v) => updateCardConfig(card.id, { seasonId: v })}
                                size="tiny"
                              />
                            </div>
                          );
                        } catch { /* ignore */ return null; }
                      })()}
                      {/* Steam game selector for steam_playtime cards */}
                      {card.type === 'steam_playtime' && steamPlaytime.length > 0 && (
                        <div id="setting-card-steam-game-selector" className="absolute bottom-1 left-1.5 z-10">
                          <Dropdown
                            options={[
                              { value: 0, label: t('showcase.allGamesList', { defaultValue: 'All games (list)' }) },
                              ...steamPlaytime.map(g => ({ value: g.appId, label: `${g.name} — ${g.hours.toLocaleString()}h`, icon: g.iconUrl ?? undefined })),
                            ]}
                            value={(card.config?.selectedAppId as number) || 0}
                            onChange={(v) => updateCardConfig(card.id, { selectedAppId: v || undefined })}
                            searchable
                            size="tiny"
                          />
                        </div>
                      )}
                      {/* Season picker for multi-rank game_rank cards */}
                      {card.type === 'game_rank' && (() => {
                        const [cardCols, cardRows] = (card.size || '1x1').split('x').map(Number);
                        const isMultiSize = cardCols > 1 || cardRows > 1;
                        if (!isMultiSize) return null;
                        const account = rendererAccounts.find(a => a.game === card.game);
                        const seasonsJson = account?.stats?.seasons as string | undefined;
                        if (!seasonsJson) return null;
                        try {
                          const seasonsList = JSON.parse(seasonsJson) as Array<{ seasonId: number; seasonName?: string | null; seasonFullName?: string | null; rankName: string | null; rankPoints?: number; rankScore?: number }>;
                          if (seasonsList.length <= 1) return null;
                          const maxSeasons = getMaxSeasons(card.size);
                          const selectedSeasons = (card.config?.selectedSeasons as number[]) || [];
                          const effectiveSelected = selectedSeasons.length > 0 ? selectedSeasons : seasonsList.slice(0, maxSeasons).map(s => s.seasonId);

                          return (
                            <div id="setting-card-multi-season-selector" className="absolute bottom-0 left-0 right-0 p-2 z-10" style={{ background: 'linear-gradient(transparent, var(--overlay-backdrop) 30%)' }}>
                              <DropdownMulti
                                options={seasonsList.map(s => {
                                  const isCurrent = s.seasonId === seasonsList[0]?.seasonId;
                                  return {
                                    value: s.seasonId,
                                    label: `${s.seasonName || `S${s.seasonId}`}${isCurrent ? ' · NOW' : ''}: ${s.rankName || 'Unranked'}${s.seasonFullName ? ` (${s.seasonFullName})` : ''}${s.rankPoints ? ` · ${s.rankPoints.toLocaleString()} pts` : ''}`,
                                  };
                                })}
                                values={effectiveSelected}
                                onChange={(next) => updateCardConfig(card.id, { selectedSeasons: next })}
                                placeholder={`${effectiveSelected.length}/${maxSeasons} seasons`}
                                size="tiny"
                              />
                            </div>
                          );
                        } catch { /* ignore */ return null; }
                      })()}
                      {/* Stat selector for game_stats cards */}
                      {card.type === 'game_stats' && card.game && AVAILABLE_STATS[card.game] && (
                        <div id="setting-card-stat-selector" className="absolute bottom-0 left-0 right-0 p-2 z-10" style={{ background: 'linear-gradient(transparent, var(--overlay-backdrop) 30%)' }}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[7px]" style={{ color: 'var(--text-secondary)' }}>
                              {((card.config?.stats as string[]) || []).length}/{getMaxStats(card.size)} stats
                            </span>
                          </div>
                          <div id="setting-select-card-stats" className="flex flex-wrap gap-1">
                          {AVAILABLE_STATS[card.game].map(s => {
                            const selected = ((card.config?.stats as string[]) || []).includes(s.key);
                            return (
                              <button key={s.key} type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const current = (card.config?.stats as string[]) || [];
                                  const maxStats = getMaxStats(card.size);
                                  const next = selected ? current.filter(k => k !== s.key) : current.length < maxStats ? [...current, s.key] : current;
                                  updateCardConfig(card.id, { stats: next });
                                }}
                                className="text-[8px] px-1.5 py-0.5 rounded-lg transition-colors"
                                style={{
                                  backgroundColor: selected ? 'var(--cta-bg, #02385A)' : 'var(--fill-hover)',
                                  color: selected ? '#fff' : 'var(--text-secondary)',
                                  border: '1px solid transparent',
                                }}
                              >
                                {s.label}
                              </button>
                            );
                          })}
                          </div>
                        </div>
                      )}
                      {/* Text input for custom_text cards */}
                      {card.type === 'custom_text' && (
                        <div id="setting-card-custom-text-input" className="absolute bottom-0 left-0 right-0 p-2 z-10" style={{ background: 'linear-gradient(transparent, var(--overlay-backdrop) 30%)' }}>
                          <textarea
                            maxLength={200}
                            rows={2}
                            value={(card.config?.text as string) || ''}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => updateCardConfig(card.id, { text: e.target.value })}
                            className="w-full text-[10px] bg-black/40 text-white/70 rounded-lg px-2 py-1 border border-[var(--glass-border)] outline-none resize-none"
                            placeholder={t('showcase.enterTextPlaceholder', { defaultValue: 'Enter your text...' })}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Mobile drag hint */}
          {isMobile && showDragHint && activeLayout.length > 1 && (
            <div className="flex items-center gap-2 mt-2 px-3 py-2 rounded-lg text-[11px]"
              style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--cyan-accent) 15%, transparent)' }}>
              <span style={{ color: 'var(--cyan-accent)', opacity: 0.7 }}>{t('showcase.dragHint', { defaultValue: 'Long-press and drag cards to reorder \u00b7 Tap to edit' })}</span>
              <button type="button" onClick={dismissDragHint}
                className="ml-auto shrink-0 w-5 h-5 rounded-lg flex items-center justify-center hover:bg-fill-hover">
                <X size={10} className="text-t-secondary" />
              </button>
            </div>
          )}

          {/* Mobile card editor bottom sheet */}
          {isMobile && editingCard && (() => {
            const card = activeLayout.find(c => c.id === editingCard);
            if (!card) return null;
            const cardIndex = activeLayout.findIndex(c => c.id === editingCard);
            const account = rendererAccounts.find(a => a.game === card.game);
            let seasons: Array<{ seasonId: number; rankName: string | null; rankPoints?: number; rankScore?: number; seasonName?: string | null }> = [];
            if (account?.stats?.seasons) {
              try { seasons = JSON.parse(account.stats.seasons as string); } catch { /* ignore */ }
            }
            return (
              <div id="setting-card-move-up">
              <span id="setting-card-move-down" />
              <MobileCardEditor
                card={card}
                allowedSizes={availableSizes}
                isMobileGrid={editingMobileLayout}
                seasons={seasons}
                availableStats={card.game ? AVAILABLE_STATS[card.game] : undefined}
                maxStats={getMaxStats(card.size)}
                maxSeasons={getMaxSeasons(card.size)}
                onSizeChange={(size) => { resizeCard(card.id, size); }}
                onColorChange={(color) => { updateCardColor(card.id, color ?? ''); }}
                onConfigChange={(config) => { updateCardConfig(card.id, config); }}
                onMoveUp={() => { moveCard(cardIndex, Math.max(0, cardIndex - 1)); }}
                onMoveDown={() => { moveCard(cardIndex, Math.min(activeLayout.length - 1, cardIndex + 1)); }}
                onDelete={() => { removeCard(card.id); setEditingCard(null); }}
                onClose={() => setEditingCard(null)}
                isFirst={cardIndex === 0}
                isLast={cardIndex === activeLayout.length - 1}
              />
              </div>
            );
          })()}
          </>
        ) : (
          <div className="py-8 text-center">
            <p className="text-sm text-t-secondary" style={{ opacity: 0.3 }}>
              {t('settings.showcaseNoCards', { defaultValue: 'No cards yet. Click "Add card" to get started.' })}
            </p>
          </div>
        )}
      </SettingsSection>

      {/* ── Refresh Section ──────────────────────────────────────────────── */}
      {(gameAccounts.length > 0 || steamPlaytime.length > 0 || gameAccounts.some(a => a.provider === 'steam')) && (
        <SettingsSection title={t('settings.showcaseRefresh', { defaultValue: 'Game Stats Refresh' })}>
          <div id="setting-refresh-game-stats" className="space-y-3">
            {(steamPlaytime.length > 0 || gameAccounts.some(a => a.provider === 'steam')) && (
              <div id="setting-refresh-steam-playtime">
              <SteamRefreshRow
                onRefreshed={(data) => {
                  setSteamPlaytime(data.steamPlaytime);
                  setSteamRecentActivity(data.steamRecentActivity);
                }}
              />
              </div>
            )}
            {gameAccounts.map(a => {
              const ago = a.lastFetched ? Math.round((Date.now() - new Date(a.lastFetched).getTime()) / 60000) : null;
              return (
                <div key={a.id} className="flex items-center justify-between py-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-t-primary">{GAME_NAMES[a.game] || a.game}</p>
                    <p className="text-[10px] text-t-secondary">
                      {ago != null ? t('showcase.lastUpdatedAgo', { defaultValue: `Last updated ${ago < 60 ? `${ago}m` : `${Math.round(ago / 60)}h`} ago`, time: ago < 60 ? `${ago}m` : `${Math.round(ago / 60)}h` }) : t('showcase.neverRefreshed', { defaultValue: 'Never refreshed' })}
                      {a.fetchError && (
                        <span className="text-red-400 ml-1 break-words">
                          ({a.fetchError})
                          {a.errorTransient
                            ? <span className="text-amber-400 ml-1">· Provider issues — retry later</span>
                            : (a.errorRetryCount ?? 0) < 5
                              ? <span className="text-amber-400 ml-1">· Retry {a.errorRetryCount ?? 0}/5</span>
                              : <span className="text-red-500 ml-1">· Retries exhausted</span>
                          }
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex flex-col items-end">
                    <button
                      type="button"
                      onClick={() => a.hasDisplayedCards !== false && handleRefresh(a.id)}
                      disabled={refreshing === a.id || a.hasDisplayedCards === false}
                      className="flex items-center gap-1.5 text-[10px] font-semibold px-3 py-1.5 rounded-lg border transition-all disabled:opacity-40"
                      style={{
                        borderColor: a.hasDisplayedCards === false ? 'var(--border-subtle)' : 'rgba(var(--cyan-accent-rgb, 0 200 255), 0.2)',
                        color: a.hasDisplayedCards === false ? 'var(--text-secondary)' : 'var(--cyan-accent)',
                        cursor: a.hasDisplayedCards === false ? 'not-allowed' : undefined,
                      }}
                      title={a.hasDisplayedCards === false ? 'Add a card for this game to enable refresh' : undefined}
                    >
                      {refreshing === a.id ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                      {a.hasDisplayedCards === false ? t('showcase.noCardsDisplayed', { defaultValue: 'No cards displayed' }) : t('common.refresh', { defaultValue: 'Refresh' })}
                    </button>
                    {a.hasDisplayedCards === false && (
                      <p className="text-[8px] text-t-secondary mt-0.5" style={{ opacity: 0.4 }}>
                        {t('showcase.addCardToEnableRefresh', { defaultValue: 'Add a showcase card for this game to enable refresh' })}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[8px] mt-3 text-t-secondary" style={{ opacity: 0.4 }}>
            Auto refresh every {perks.showcaseAutoRefreshHours}h · Manual refresh once per {perks.showcaseManualRefreshHours}h
            {effectivePlan && ` (${effectivePlan === 'pro' ? 'Pro' : 'Essential'})`}
          </p>
          <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <p className="text-[8px]" style={{ color: 'var(--text-secondary)' }}>
              {t('showcase.gameStatsProvidedBy', { defaultValue: 'Game stats provided by ' })}
              <a href="https://apexlegendsstatus.com" target="_blank" rel="noopener noreferrer" className="underline">Apex Legends Status</a>
              {', '}
              <a href="https://opendota.com" target="_blank" rel="noopener noreferrer" className="underline">OpenDota</a>
              {', '}
              <a href="https://fortnite-api.com" target="_blank" rel="noopener noreferrer" className="underline">Fortnite-API</a>
              {', '}
              <a href="https://marvelrivalsapi.com" target="_blank" rel="noopener noreferrer" className="underline">MarvelRivalsAPI</a>
              {', '}
              <a href="https://r6data.eu" target="_blank" rel="noopener noreferrer" className="underline">R6Data</a>
            </p>
          </div>
        </SettingsSection>
      )}

      {/* ── Preview Link ─────────────────────────────────────────────────── */}
      <div className="text-center">
        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('open-profile', { detail: { userId } }));
          }}
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-4 py-2 rounded-lg transition-colors hover:bg-fill-hover text-t-secondary"
        >
          <ExternalLink size={12} /> {t('settings.showcasePreview', { defaultValue: 'Open full profile preview' })}
        </button>
      </div>
      </>)}
    </div>
  );
};

export default ShowcaseTab;
