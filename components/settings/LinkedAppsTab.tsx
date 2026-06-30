// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Loader2, ChevronDown, ChevronUp, Music, Clock, Headphones, Users, Gamepad2, Shield, Link2, AlertTriangle } from 'lucide-react';
import { apiClient, type UserPreferences } from '../../services/api';
import type { GameAccountData } from '../../services/api/gameAccounts';
import { getBackendOrigin } from '../../config';
import { Toggle } from './SettingsWidgets';
import { APP_ICON_MAP } from '../icons/AppIcons';
import { SteamIcon, RiotIcon, EpicIcon, PLATFORM_ICON_MAP } from '../icons/GamePlatformIcons';
import { Dropdown } from '../ui/dropdown';


type SsoAccount = { id: string; provider: string; email: string | null; displayName: string | null; avatarUrl: string | null };
type ConnectedAppInfo = { id: string; provider: string; displayName: string | null; avatarUrl: string | null; scopes: string | null; createdAt: string };

interface LinkedAppConfig {
  id: string;
  label: string;
  icon: string | null;
  color: string;
  available: boolean;
  descriptionKey: string;
  activityToggleKey?: keyof UserPreferences;
  activityLabelKey?: string;
  activityDescKey?: string;
  connectionType?: 'sso' | 'app';
  expandable?: boolean;
}

const LINKED_APPS: LinkedAppConfig[] = [
  {
    id: 'spotify',
    label: 'Spotify',
    icon: null,
    color: '#1DB954',
    available: true,
    descriptionKey: 'settings.linkedApps.spotifyDesc',
    activityToggleKey: 'shareSpotifyActivity',
    activityLabelKey: 'settings.linkedApps.shareSpotifyActivity',
    activityDescKey: 'settings.linkedApps.shareSpotifyActivityDesc',
    connectionType: 'app',
    expandable: true,
  },
  {
    id: 'twitch',
    label: 'Twitch',
    icon: null,
    color: '#9146FF',
    available: true,
    descriptionKey: 'settings.linkedApps.twitchDesc',
    activityToggleKey: 'shareTwitchActivity',
    activityLabelKey: 'settings.linkedApps.shareTwitchActivity',
    activityDescKey: 'settings.linkedApps.shareTwitchActivityDesc',
    connectionType: 'app',
    expandable: true,
  },
  {
    id: 'youtube',
    label: 'YouTube',
    icon: null,
    color: '#FF0000',
    available: true,
    descriptionKey: 'settings.linkedApps.youtubeDesc',
    activityToggleKey: 'shareYouTubeActivity',
    activityLabelKey: 'settings.linkedApps.shareYouTubeActivity',
    activityDescKey: 'settings.linkedApps.shareYouTubeActivityDesc',
    connectionType: 'app',
    expandable: true,
  },
  {
    id: 'github',
    label: 'GitHub',
    icon: null,
    color: '#24292e',
    available: true,
    descriptionKey: 'settings.linkedApps.githubDesc',
    connectionType: 'app',
    expandable: true,
  },
  {
    id: 'reddit',
    label: 'Reddit',
    icon: null,
    color: '#FF5700',
    available: false,
    descriptionKey: 'settings.linkedApps.redditDesc',
    connectionType: 'app',
    expandable: true,
  },
];

export const LinkedAppsTab: React.FC = () => {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<SsoAccount[]>([]);
  const [connectedApps, setConnectedApps] = useState<ConnectedAppInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedApp, setExpandedApp] = useState<string | null>(null);
  const [gameAccounts, setGameAccounts] = useState<GameAccountData[]>([]);
  const [linkingGame, setLinkingGame] = useState<string | null>(null);
  const [gameForm, setGameForm] = useState<{ game: string; platformId: string; platform: string } | null>(null);
  const [gameFormError, setGameFormError] = useState<string | null>(null);
  const [refreshingProfile, setRefreshingProfile] = useState<string | null>(null);

  const refreshGameAccounts = useCallback(() => {
    apiClient.getGameAccounts().then(setGameAccounts).catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([
      apiClient.getSsoAccounts(),
      apiClient.getPreferences(),
      apiClient.getConnectedApps(),
      apiClient.getGameAccounts(),
    ]).then(([accs, p, apps, games]) => {
      setAccounts(accs);
      setPrefs(p);
      setConnectedApps(apps);
      setGameAccounts(games);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  // Detect SSO link / app link result from URL params (redirect back from OAuth)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ssoLinked = params.get('sso_linked');
    const ssoError = params.get('sso_error');
    const appLinked = params.get('app_linked');
    const appConnected = params.get('app_connected');
    const appError = params.get('app_error');

    if (ssoLinked) {
      setLoading(true);
      apiClient.getSsoAccounts().then(setAccounts).catch(() => {}).finally(() => setLoading(false));
    }
    if (ssoError) {
      setError(t('settings.linkedApps.linkError', { defaultValue: 'Failed to link account. Please try again.' }));
    }
    if (appLinked) {
      setLoading(true);
      apiClient.getConnectedApps().then(setConnectedApps).catch(() => {}).finally(() => setLoading(false));
    }
    if (appConnected) {
      // Riot/Epic OAuth callback — refresh both connected apps and game accounts
      setLoading(true);
      Promise.all([
        apiClient.getConnectedApps().then(setConnectedApps),
        apiClient.getGameAccounts().then(setGameAccounts),
      ]).catch(() => {}).finally(() => { setLoading(false); window.dispatchEvent(new CustomEvent('game-accounts-changed')); });
    }
    if (appError) {
      const errorMessages: Record<string, string> = {
        spotify_denied: t('settings.linkedApps.spotifyDenied', { defaultValue: 'Spotify link was denied.' }),
        riot_denied: t('settings.linkedApps.riotDenied', { defaultValue: 'Riot Games link was denied.' }),
        epic_denied: t('settings.linkedApps.epicDenied', { defaultValue: 'Epic Games link was denied.' }),
        twitch_denied: t('settings.linkedApps.twitchDenied', { defaultValue: 'Twitch link was denied.' }),
        youtube_denied: t('settings.linkedApps.youtubeDenied', { defaultValue: 'YouTube link was denied.' }),
        github_denied: t('settings.linkedApps.githubDenied', { defaultValue: 'GitHub link was denied.' }),
        reddit_denied: t('settings.linkedApps.redditDenied', { defaultValue: 'Reddit link was denied.' }),
        not_configured: t('settings.linkedApps.notConfigured', { defaultValue: 'This integration isn\'t configured on the server yet. Please contact an admin.' }),
        invalid_connect_token: t('settings.linkedApps.sessionExpired', { defaultValue: 'Your connect session expired. Try again.' }),
        missing_session: t('settings.linkedApps.sessionExpired', { defaultValue: 'Your connect session expired. Try again.' }),
        invalid_session: t('settings.linkedApps.sessionExpired', { defaultValue: 'Your connect session expired. Try again.' }),
        invalid_state: t('settings.linkedApps.sessionExpired', { defaultValue: 'Your connect session expired. Try again.' }),
        token_exchange_failed: t('settings.linkedApps.providerRejected', { defaultValue: 'The provider rejected the login. Try again.' }),
        profile_fetch_failed: t('settings.linkedApps.providerRejected', { defaultValue: 'The provider rejected the login. Try again.' }),
        already_linked_other: t('settings.linkedApps.alreadyLinkedOther', { defaultValue: 'That account is already linked to a different Howl user.' }),
      };
      setError(errorMessages[appError] || t('settings.linkedApps.connectError', { defaultValue: 'Failed to link app. Please try again.' }));
    }

    // Clean URL params
    if (ssoLinked || ssoError || appLinked || appConnected || appError) {
      const url = new URL(window.location.href);
      url.searchParams.delete('sso_linked');
      url.searchParams.delete('sso_error');
      url.searchParams.delete('app_linked');
      url.searchParams.delete('app_connected');
      url.searchParams.delete('app_error');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    }
  }, [t]);

  // Electron: listen for SSO/app link result from deep link callback
  useEffect(() => {
    if (!(window as any).electron?.onSsoSettingsCallback) return;
    const cleanup = (window as any).electron.onSsoSettingsCallback((data: Record<string, string>) => {
      const ssoLinked = data.sso_linked;
      const ssoError = data.sso_error;
      const appLinked = data.app_linked;
      const appConnected = data.app_connected;
      const appError = data.app_error;

      if (ssoLinked) {
        setLoading(true);
        apiClient.getSsoAccounts().then(setAccounts).catch(() => {}).finally(() => setLoading(false));
      }
      if (ssoError) {
        setError(t('settings.linkedApps.linkError', { defaultValue: 'Failed to link account. Please try again.' }));
      }
      if (appLinked || appConnected || appError) {
        // Any deep-link callback supersedes the polling fallback — cancel it
        // so a stale poll doesn't overwrite the authoritative result.
        if (pollCancelRef.current) { pollCancelRef.current.cancelled = true; pollCancelRef.current = null; }
        setConnecting(null);
      }
      if (appLinked) {
        setLoading(true);
        apiClient.getConnectedApps().then(setConnectedApps).catch(() => {}).finally(() => setLoading(false));
      }
      if (appConnected) {
        setLoading(true);
        Promise.all([
          apiClient.getConnectedApps().then(setConnectedApps),
          apiClient.getGameAccounts().then(setGameAccounts),
        ]).catch(() => {}).finally(() => { setLoading(false); window.dispatchEvent(new CustomEvent('game-accounts-changed')); });
      }
      if (appError) {
        const errorMessages: Record<string, string> = {
          spotify_denied: t('settings.linkedApps.spotifyDenied', { defaultValue: 'Spotify link was denied.' }),
          riot_denied: t('settings.linkedApps.riotDenied', { defaultValue: 'Riot Games link was denied.' }),
          epic_denied: t('settings.linkedApps.epicDenied', { defaultValue: 'Epic Games link was denied.' }),
          twitch_denied: t('settings.linkedApps.twitchDenied', { defaultValue: 'Twitch link was denied.' }),
          youtube_denied: t('settings.linkedApps.youtubeDenied', { defaultValue: 'YouTube link was denied.' }),
          github_denied: t('settings.linkedApps.githubDenied', { defaultValue: 'GitHub link was denied.' }),
          reddit_denied: t('settings.linkedApps.redditDenied', { defaultValue: 'Reddit link was denied.' }),
        };
        // Unknown error codes (missing_code, connect_failed, …) still surface
        // the error text along with the raw code so it's reportable.
        const friendly = errorMessages[appError]
          ?? `${t('settings.linkedApps.connectError', { defaultValue: 'Failed to link app. Please try again.' })} (${appError})`;
        setError(friendly);
      }
    });
    return cleanup;
  }, [t]);

  // Cancel any in-flight poll on unmount so the component doesn't update
  // state after it's gone.
  useEffect(() => () => {
    if (pollCancelRef.current) { pollCancelRef.current.cancelled = true; pollCancelRef.current = null; }
  }, []);

  const handleConnect = useCallback(async (provider: string) => {
    setConnecting(provider);
    setError(null);
    try {
      const { linkToken } = await apiClient.getSsoLinkToken(provider);
      // Electron: use IPC
      if ((window as any).electron?.startSsoLink) {
        (window as any).electron.startSsoLink({ provider, linkToken });
        setConnecting(null);
        return;
      }
      // Web: direct navigation (unchanged)
      const sanitizedProvider = provider.replace(/[^a-z0-9-]/gi, '');
      const base = getBackendOrigin();
      const target = `${base}/api/auth/sso/${sanitizedProvider}?link_token=${encodeURIComponent(linkToken)}`;
      const parsed = new URL(target);
      if (parsed.protocol === 'https:' || parsed.hostname === 'localhost') {
        window.location.href = target;
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('settings.linkedApps.linkError', { defaultValue: 'Failed to link' }));
      setConnecting(null);
    }
  }, [t]);

  // Cancel flag for the Electron polling fallback — set when the deep-link
  // callback arrives (or the user starts a new connect) so an in-flight poll
  // stops clobbering the connected-apps list.
  const pollCancelRef = useRef<{ cancelled: boolean } | null>(null);

  const pollForAppLink = useCallback((provider: string) => {
    // The howl:// deep link can silently fail on Windows if the protocol
    // client isn't registered (or is registered but routed to a stale
    // install). Poll the server for the provider to appear as a fallback,
    // so the user gets confirmation of a successful link even when the
    // IPC notify path never fires.
    if (pollCancelRef.current) pollCancelRef.current.cancelled = true;
    const cancel = { cancelled: false };
    pollCancelRef.current = cancel;
    const startedAt = Date.now();
    const POLL_EVERY_MS = 3000;
    const POLL_MAX_MS = 90_000;
    const tick = async () => {
      if (cancel.cancelled) return;
      try {
        const apps = await apiClient.getConnectedApps();
        if (cancel.cancelled) return;
        const linked = apps.some((a) => a.provider === provider);
        if (linked) {
          setConnectedApps(apps);
          setConnecting(null);
          pollCancelRef.current = null;
          return;
        }
      } catch { /* network hiccup — try again */ }
      if (Date.now() - startedAt >= POLL_MAX_MS) {
        if (!cancel.cancelled) {
          setConnecting(null);
          pollCancelRef.current = null;
        }
        return;
      }
      setTimeout(tick, POLL_EVERY_MS);
    };
    setTimeout(tick, POLL_EVERY_MS);
  }, []);

  const handleConnectApp = useCallback(async (provider: string) => {
    setConnecting(provider);
    setError(null);
    try {
      // Get the provider-specific connect token
      const tokenGetters: Record<string, () => Promise<{ connectToken: string }>> = {
        spotify: () => apiClient.getSpotifyConnectToken(),
        riot: () => apiClient.getRiotConnectToken(),
        epic: () => apiClient.getEpicConnectToken(),
        twitch: () => apiClient.getTwitchConnectToken(),
        youtube: () => apiClient.getYouTubeConnectToken(),
        github: () => apiClient.getGitHubConnectToken(),
        reddit: () => apiClient.getRedditConnectToken(),
      };
      const getter = tokenGetters[provider];
      if (!getter) throw new Error('Unknown provider');
      const { connectToken } = await getter();
      // Electron: use IPC + poll for the linked app as a fallback for when
      // howl:// deep links fail (unregistered protocol, routing issues, etc.)
      if ((window as any).electron?.startAppConnect) {
        (window as any).electron.startAppConnect({ provider, connectToken });
        pollForAppLink(provider);
        return;
      }
      // Web: direct navigation (unchanged)
      const sanitizedProvider = provider.replace(/[^a-z0-9-]/gi, '');
      const base = getBackendOrigin();
      const target = `${base}/api/v1/connected-apps/${sanitizedProvider}/connect?connect_token=${encodeURIComponent(connectToken)}`;
      const parsed = new URL(target);
      if (parsed.protocol === 'https:' || parsed.hostname === 'localhost') {
        window.location.href = target;
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('settings.linkedApps.connectError', { defaultValue: 'Failed to link app' }));
      setConnecting(null);
    }
  }, [t, pollForAppLink]);

  const handleUnlink = useCallback(async (accountId: string) => {
    setUnlinking(accountId);
    try {
      await apiClient.unlinkSsoAccount(accountId);
      setAccounts((prev) => prev.filter((a) => a.id !== accountId));
    } catch { /* ignore */ }
    setUnlinking(null);
  }, []);

  const handleDisconnectApp = useCallback(async (accountId: string) => {
    setUnlinking(accountId);
    try {
      await apiClient.disconnectApp(accountId);
      setConnectedApps((prev) => prev.filter((a) => a.id !== accountId));
      setExpandedApp(null);
      refreshGameAccounts(); // Riot/Epic disconnect removes game accounts
    } catch { /* ignore */ }
    setUnlinking(null);
  }, [refreshGameAccounts]);

  const handleLinkSteamGames = useCallback(async () => {
    setLinkingGame('steam');
    setError(null);
    try {
      await apiClient.linkSteamGames();
      refreshGameAccounts();
      window.dispatchEvent(new CustomEvent('game-accounts-changed'));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('linkedApps.failedToLinkSteamGames', { defaultValue: 'Failed to link Steam games' }));
    }
    setLinkingGame(null);
  }, [refreshGameAccounts]);

  const handleLinkUsernameGame = useCallback(async (game: string, platformId: string, platform?: string | null) => {
    setLinkingGame(game);
    setGameFormError(null);
    try {
      await apiClient.linkGameAccount({ game, platformId, platform, displayName: platformId });
      refreshGameAccounts();
      window.dispatchEvent(new CustomEvent('game-accounts-changed'));
      setGameForm(null);
    } catch (err: unknown) {
      setGameFormError(err instanceof Error ? err.message : t('linkedApps.failedToLinkAccount', { defaultValue: 'Failed to link account' }));
    }
    setLinkingGame(null);
  }, [refreshGameAccounts]);

  const handleUnlinkGame = useCallback(async (id: string) => {
    setUnlinking(id);
    try {
      await apiClient.unlinkGameAccount(id);
      setGameAccounts((prev) => prev.filter((a) => a.id !== id));
      window.dispatchEvent(new CustomEvent('game-accounts-changed'));
    } catch { /* ignore */ }
    setUnlinking(null);
  }, []);

  const updatePref = useCallback(async (key: keyof UserPreferences, value: boolean | string) => {
    const previous = prefs;
    setPrefs((p) => p ? { ...p, [key]: value } as UserPreferences : p);
    try {
      const updated = await apiClient.updatePreferences({ [key]: value } as Partial<UserPreferences>);
      setPrefs(updated);
    } catch {
      setPrefs(previous);
    }
  }, [prefs]);

  const linkedMap = new Map(accounts.map((a) => [a.provider, a]));
  const connectedAppMap = new Map(connectedApps.map((a) => [a.provider, a]));
  const gameAccountMap = new Map(gameAccounts.map((a) => [a.game, a]));
  const steamSso = linkedMap.get('steam');

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto">
        <p className="text-sm py-4 text-t-secondary">{t('common.loading')}</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2 text-t-primary">
        {t('settings.linkedAppsTab', { defaultValue: 'Linked Apps' })}
      </h2>
      <p className="text-xs mb-8 text-t-secondary">
        {t('settings.linkedApps.description', { defaultValue: 'Manage your linked accounts and their activity settings.' })}
      </p>

      {error && <div className="text-sm text-red-400 mb-4 text-center">{error}</div>}

      <p className="text-[10px] font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>
        {t('settings.linkedApps.apps', { defaultValue: 'Apps' })}
      </p>

      <div className="space-y-3">
        {LINKED_APPS.map((app) => {
          const isAppType = app.connectionType === 'app';
          const ssoLinked = linkedMap.get(app.id);
          const appLinked = connectedAppMap.get(app.id);
          const linked = isAppType ? appLinked : ssoLinked;
          const isComingSoon = !app.available;
          const isExpanded = expandedApp === app.id;

          const isSpotifyDevMode = app.id === 'spotify' && !linked;
          return (
            <div
              key={app.id}
              id={`setting-link-${app.id}`}
              className={`rounded-2xl border p-5 transition-colors bg-panel relative ${isSpotifyDevMode ? 'pb-20' : ''}`}
              style={{
                borderColor: linked ? 'rgba(16,185,129,0.25)' : 'var(--border-subtle)',
              }}
            >
              {/* Spotify integration runs in limited/developer-quota mode; this overlay marks the Link button as restricted. */}
              {isSpotifyDevMode && (
                <div
                  aria-hidden="true"
                  className="absolute inset-0 rounded-2xl pointer-events-none flex items-end justify-center p-3"
                  style={{ backgroundColor: 'rgba(15, 17, 23, 0.3)' }}
                >
                  <div
                    className="flex items-start gap-2 w-full px-3 py-2 rounded-lg"
                    style={{ backgroundColor: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.28)' }}
                  >
                    <AlertTriangle size={13} className="text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-[11px] leading-relaxed text-t-secondary">
                      {t('settings.linkedApps.spotifyDevQuotaNotice', { defaultValue: "Spotify linking is currently limited while our integration is in review. Check back soon." })}
                    </p>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-3.5">
                {/* Icon */}
                <div className="w-11 h-11 rounded-full shrink-0 overflow-hidden flex items-center justify-center text-white" style={{ backgroundColor: app.color }}>
                  {(() => {
                    const IconComp = APP_ICON_MAP[app.id];
                    return IconComp ? (
                      <IconComp size={22} />
                    ) : (
                      <span className="font-bold text-sm">{app.label[0]}</span>
                    );
                  })()}
                </div>

                {/* Name + badge + description */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold truncate text-t-primary">
                      {linked?.displayName || app.label}
                    </span>
                    {linked && (
                      <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full shrink-0" style={{ backgroundColor: 'rgba(16,185,129,0.15)', color: '#10b981' }}>
                        {t('common.connected', { defaultValue: 'Linked' })}
                      </span>
                    )}
                    {isComingSoon && (
                      <span className="text-[8px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-lg shrink-0 text-t-secondary" style={{ backgroundColor: 'var(--fill-active)' }}>
                        {t('settings.linkedApps.comingSoon', { defaultValue: 'Coming soon' })}
                      </span>
                    )}
                  </div>
                  {linked ? (
                    <p className="text-[11px] mt-0.5 text-t-secondary">{app.label}</p>
                  ) : (
                    <p className="text-[11px] mt-0.5 text-t-secondary">
                      {t(app.descriptionKey, { defaultValue: app.label })}
                    </p>
                  )}
                </div>

                {/* Expand chevron */}
                {linked && app.expandable && (
                  <button
                    type="button"
                    onClick={() => setExpandedApp(isExpanded ? null : app.id)}
                    className="shrink-0 p-2 rounded-lg hover:bg-fill-hover transition-colors text-t-secondary"
                  >
                    {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                )}

                {/* Action button */}
                {linked ? (
                  <button
                    type="button"
                    onClick={() => isAppType ? handleDisconnectApp(linked.id) : handleUnlink((linked as SsoAccount).id)}
                    disabled={unlinking === linked.id}
                    className="shrink-0 p-2 rounded-lg border border-red-500/20 text-red-400 hover:bg-red-500/10 hover:border-red-500/40 transition-all disabled:opacity-50"
                    title={t('settings.linkedApps.disconnect', { defaultValue: 'Unlink' })}
                  >
                    {unlinking === linked.id ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => isAppType ? handleConnectApp(app.id) : handleConnect(app.id)}
                    disabled={isComingSoon || connecting === app.id}
                    className="btn-cta shrink-0 text-[10px] font-semibold px-4 py-1.5 rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {connecting === app.id
                      ? t('settings.linkedApps.linking', { defaultValue: 'Linking...' })
                      : t('settings.linkedApps.link', { defaultValue: 'Link' })
                    }
                  </button>
                )}
              </div>

              {/* Per-app activity toggle (SSO apps like Steam) */}
              {linked && !isAppType && app.activityToggleKey && prefs && (
                <div className="flex items-center justify-between py-3 mt-4 border-t border-[var(--glass-border)]">
                  <div>
                    <p className="text-xs font-medium text-t-primary">
                      {t(app.activityLabelKey!, { defaultValue: 'Show activity' })}
                    </p>
                    <p className="text-[11px] mt-0.5 text-t-secondary">
                      {t(app.activityDescKey!, { defaultValue: 'Display activity as your status.' })}
                    </p>
                  </div>
                  <Toggle checked={!!prefs[app.activityToggleKey]} onChange={(v) => updatePref(app.activityToggleKey!, v)} />
                </div>
              )}

              {/* Spotify expanded settings panel */}
              {linked && isAppType && app.id === 'spotify' && isExpanded && prefs && (
                <div className="mt-4 border-t border-[var(--glass-border)] pt-4 space-y-4">
                  {/* Activity sharing toggle */}
                  <div id="setting-share-spotify-activity" className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium text-t-primary">
                        {t('settings.linkedApps.shareSpotifyActivity', { defaultValue: 'Share Spotify Activity' })}
                      </p>
                      <p className="text-[11px] mt-0.5 text-t-secondary">
                        {t('settings.linkedApps.shareSpotifyActivityDesc', { defaultValue: 'Display your current track as your activity status.' })}
                      </p>
                    </div>
                    <Toggle checked={!!prefs.shareSpotifyActivity} onChange={(v) => updatePref('shareSpotifyActivity', v)} />
                  </div>

                  {/* Feature info section */}
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider mb-2.5 text-t-secondary">
                      {t('settings.linkedApps.spotifyFeatures', { defaultValue: 'Profile Features' })}
                    </p>
                    <div className="space-y-2">
                      {[
                        { icon: Music, text: t('settings.linkedApps.spotifyTopArtistsInfo', { defaultValue: 'Top Artists & Tracks — Visible on your profile' }) },
                        { icon: Clock, text: t('settings.linkedApps.spotifyRecentInfo', { defaultValue: 'Recently Played — Shown in activity history' }) },
                        { icon: Headphones, text: t('settings.linkedApps.spotifyListenAlongInfo', { defaultValue: 'Listen Along — Friends can open your tracks' }) },
                        { icon: Users, text: t('settings.linkedApps.spotifySharedTastesInfo', { defaultValue: 'Shared Tastes — Compare music with friends' }) },
                      ].map(({ icon: Icon, text }) => (
                        <div key={text} className="flex items-center gap-2.5 px-3 py-2 rounded-lg" style={{ backgroundColor: 'var(--fill-hover)' }}>
                          <Icon size={13} style={{ color: '#1DB954', opacity: 0.7 }} />
                          <span className="text-[11px] text-t-secondary">{text}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Twitch expanded settings panel */}
              {linked && isAppType && app.id === 'twitch' && isExpanded && prefs && (
                <div className="mt-4 border-t border-[var(--glass-border)] pt-4 space-y-4">
                  <div id="setting-share-twitch-activity" className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium text-t-primary">
                        {t('settings.linkedApps.shareTwitchActivity', { defaultValue: 'Share Twitch Activity' })}
                      </p>
                      <p className="text-[11px] mt-0.5 text-t-secondary">
                        {t('settings.linkedApps.shareTwitchActivityDesc', { defaultValue: 'Show when you\'re live on Twitch as your activity status.' })}
                      </p>
                    </div>
                    <Toggle checked={!!prefs.shareTwitchActivity} onChange={(v) => updatePref('shareTwitchActivity', v)} />
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider mb-2.5 text-t-secondary">
                      {t('settings.linkedApps.twitchFeatures', { defaultValue: 'Profile Features' })}
                    </p>
                    <div className="space-y-2">
                      {[
                        { icon: Users, text: t('settings.linkedApps.twitchFollowersInfo', { defaultValue: 'Follower count & partner status on your profile' }) },
                        { icon: Gamepad2, text: t('settings.linkedApps.twitchLiveInfo', { defaultValue: 'Live stream status visible to friends' }) },
                      ].map(({ icon: Icon, text }) => (
                        <div key={text} className="flex items-center gap-2.5 px-3 py-2 rounded-lg" style={{ backgroundColor: 'var(--fill-hover)' }}>
                          <Icon size={13} style={{ color: '#9146FF', opacity: 0.7 }} />
                          <span className="text-[11px] text-t-secondary">{text}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  {/* Manual profile refresh */}
                  <div id="setting-refresh-twitch-profile" className="pt-3 border-t border-[var(--glass-border)]">
                    <button
                      type="button"
                      onClick={async () => {
                        if (!linked) return;
                        setRefreshingProfile(app.id);
                        try { await apiClient.refreshConnectedAppProfile(linked.id); } catch { /* ignore */ }
                        setRefreshingProfile(null);
                      }}
                      disabled={refreshingProfile === app.id}
                      className="text-[10px] font-semibold px-3 py-1.5 rounded-lg border transition-all disabled:opacity-40"
                      style={{ borderColor: 'var(--glass-border)', color: 'var(--text-secondary)' }}
                    >
                      {refreshingProfile === app.id ? (
                        <span className="flex items-center gap-1.5"><Loader2 size={10} className="animate-spin" /> {t('common.refreshing', { defaultValue: 'Refreshing...' })}</span>
                      ) : t('linkedApps.refreshProfileData', { defaultValue: 'Refresh Profile Data' })}
                    </button>
                  </div>
                </div>
              )}

              {/* YouTube expanded settings panel */}
              {linked && isAppType && app.id === 'youtube' && isExpanded && prefs && (
                <div className="mt-4 border-t border-[var(--glass-border)] pt-4 space-y-4">
                  <div id="setting-share-youtube-activity" className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium text-t-primary">
                        {t('settings.linkedApps.shareYouTubeActivity', { defaultValue: 'Share YouTube Activity' })}
                      </p>
                      <p className="text-[11px] mt-0.5 text-t-secondary">
                        {t('settings.linkedApps.shareYouTubeActivityDesc', { defaultValue: 'Show when you\'re live on YouTube as your activity status.' })}
                      </p>
                    </div>
                    <Toggle checked={!!prefs.shareYouTubeActivity} onChange={(v) => updatePref('shareYouTubeActivity', v)} />
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider mb-2.5 text-t-secondary">
                      {t('settings.linkedApps.youtubeFeatures', { defaultValue: 'Profile Features' })}
                    </p>
                    <div className="space-y-2">
                      {[
                        { icon: Users, text: t('settings.linkedApps.youtubeSubsInfo', { defaultValue: 'Subscriber count & video stats on your profile' }) },
                        { icon: Gamepad2, text: t('settings.linkedApps.youtubeLiveInfo', { defaultValue: 'Live stream status visible to friends' }) },
                      ].map(({ icon: Icon, text }) => (
                        <div key={text} className="flex items-center gap-2.5 px-3 py-2 rounded-lg" style={{ backgroundColor: 'var(--fill-hover)' }}>
                          <Icon size={13} style={{ color: '#FF0000', opacity: 0.7 }} />
                          <span className="text-[11px] text-t-secondary">{text}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  {/* Manual profile refresh */}
                  <div id="setting-refresh-linked-profile" className="pt-3 border-t border-[var(--glass-border)]">
                    <button
                      type="button"
                      onClick={async () => {
                        if (!linked) return;
                        setRefreshingProfile(app.id);
                        try { await apiClient.refreshConnectedAppProfile(linked.id); } catch { /* ignore */ }
                        setRefreshingProfile(null);
                      }}
                      disabled={refreshingProfile === app.id}
                      className="text-[10px] font-semibold px-3 py-1.5 rounded-lg border transition-all disabled:opacity-40"
                      style={{ borderColor: 'var(--glass-border)', color: 'var(--text-secondary)' }}
                    >
                      {refreshingProfile === app.id ? (
                        <span className="flex items-center gap-1.5"><Loader2 size={10} className="animate-spin" /> {t('common.refreshing', { defaultValue: 'Refreshing...' })}</span>
                      ) : t('linkedApps.refreshProfileData', { defaultValue: 'Refresh Profile Data' })}
                    </button>
                  </div>
                </div>
              )}

              {/* GitHub expanded settings panel */}
              {linked && isAppType && app.id === 'github' && isExpanded && (
                <div className="mt-4 border-t border-[var(--glass-border)] pt-4">
                  <p className="text-[10px] font-semibold uppercase tracking-wider mb-2.5 text-t-secondary">
                    {t('settings.linkedApps.githubFeatures', { defaultValue: 'Profile Features' })}
                  </p>
                  <div className="space-y-2">
                    {[
                      { icon: Gamepad2, text: t('settings.linkedApps.githubContribInfo', { defaultValue: 'Contribution graph & streak on your profile' }) },
                      { icon: Users, text: t('settings.linkedApps.githubReposInfo', { defaultValue: 'Top languages & public repos displayed' }) },
                    ].map(({ icon: Icon, text }) => (
                      <div key={text} className="flex items-center gap-2.5 px-3 py-2 rounded-lg" style={{ backgroundColor: 'var(--fill-hover)' }}>
                        <Icon size={13} style={{ color: '#e6edf3', opacity: 0.7 }} />
                        <span className="text-[11px] text-t-secondary">{text}</span>
                      </div>
                    ))}
                  </div>
                  {/* Manual profile refresh */}
                  <div id="setting-refresh-github-profile" className="mt-3 pt-3 border-t border-[var(--glass-border)]">
                    <button
                      type="button"
                      onClick={async () => {
                        if (!linked) return;
                        setRefreshingProfile(app.id);
                        try { await apiClient.refreshConnectedAppProfile(linked.id); } catch { /* ignore */ }
                        setRefreshingProfile(null);
                      }}
                      disabled={refreshingProfile === app.id}
                      className="text-[10px] font-semibold px-3 py-1.5 rounded-lg border transition-all disabled:opacity-40"
                      style={{ borderColor: 'var(--glass-border)', color: 'var(--text-secondary)' }}
                    >
                      {refreshingProfile === app.id ? (
                        <span className="flex items-center gap-1.5"><Loader2 size={10} className="animate-spin" /> {t('common.refreshing', { defaultValue: 'Refreshing...' })}</span>
                      ) : t('linkedApps.refreshProfileData', { defaultValue: 'Refresh Profile Data' })}
                    </button>
                  </div>
                </div>
              )}

              {/* Reddit expanded settings panel */}
              {linked && isAppType && app.id === 'reddit' && isExpanded && (
                <div className="mt-4 border-t border-[var(--glass-border)] pt-4">
                  <p className="text-[10px] font-semibold uppercase tracking-wider mb-2.5 text-t-secondary">
                    {t('settings.linkedApps.redditFeatures', { defaultValue: 'Profile Features' })}
                  </p>
                  <div className="space-y-2">
                    {[
                      { icon: Users, text: t('settings.linkedApps.redditKarmaInfo', { defaultValue: 'Karma score & trophies on your profile' }) },
                      { icon: Shield, text: t('settings.linkedApps.redditModInfo', { defaultValue: 'Moderated subreddits displayed' }) },
                    ].map(({ icon: Icon, text }) => (
                      <div key={text} className="flex items-center gap-2.5 px-3 py-2 rounded-lg" style={{ backgroundColor: 'var(--fill-hover)' }}>
                        <Icon size={13} style={{ color: '#FF5700', opacity: 0.7 }} />
                        <span className="text-[11px] text-t-secondary">{text}</span>
                      </div>
                    ))}
                  </div>
                  {/* Manual profile refresh */}
                  <div className="mt-3 pt-3 border-t border-[var(--glass-border)]">
                    <button
                      type="button"
                      onClick={async () => {
                        if (!linked) return;
                        setRefreshingProfile(app.id);
                        try { await apiClient.refreshConnectedAppProfile(linked.id); } catch { /* ignore */ }
                        setRefreshingProfile(null);
                      }}
                      disabled={refreshingProfile === app.id}
                      className="text-[10px] font-semibold px-3 py-1.5 rounded-lg border transition-all disabled:opacity-40"
                      style={{ borderColor: 'var(--glass-border)', color: 'var(--text-secondary)' }}
                    >
                      {refreshingProfile === app.id ? (
                        <span className="flex items-center gap-1.5"><Loader2 size={10} className="animate-spin" /> {t('common.refreshing', { defaultValue: 'Refreshing...' })}</span>
                      ) : t('linkedApps.refreshProfileData', { defaultValue: 'Refresh Profile Data' })}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Games Section ────────────────────────────────────────────────── */}
      <p className="text-[10px] font-bold uppercase tracking-widest mt-10 mb-3" style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>
        {t('settings.linkedApps.games', { defaultValue: 'Games' })}
      </p>

      <div className="space-y-3">
        {/* ── Riot Games (OAuth — Valorant, LoL, TFT) ── */}
        {(() => {
          const riotApp = connectedAppMap.get('riot');
          const riotLinked = !!riotApp;
          const riotGames = ['valorant', 'lol', 'tft'].filter(g => gameAccountMap.has(g));
          return (
            <div id="setting-link-riot-games" className="rounded-2xl border p-5 transition-colors bg-panel" style={{ borderColor: riotLinked ? 'rgba(16,185,129,0.25)' : 'var(--border-subtle)' }}>
              <div className="flex items-center gap-3.5">
                <div className="w-11 h-11 rounded-full shrink-0 overflow-hidden flex items-center justify-center" style={{ backgroundColor: '#D32936' }}>
                  <RiotIcon size={20} className="text-white" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold truncate text-t-primary">
                      {riotApp?.displayName || t('linkedApps.riotGames', { defaultValue: 'Riot Games' })}
                    </span>
                    {riotLinked && (
                      <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full shrink-0" style={{ backgroundColor: 'rgba(16,185,129,0.15)', color: '#10b981' }}>
                        <Shield size={8} className="inline -mt-px mr-0.5" />{t('linkedApps.verified', { defaultValue: 'Verified' })}
                      </span>
                    )}
                    {!riotLinked && (
                      <span className="text-[8px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-lg shrink-0 text-t-secondary" style={{ backgroundColor: 'var(--fill-active)' }}>
                        {t('settings.comingSoon')}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] mt-0.5 text-t-secondary">
                    {riotLinked ? t('linkedApps.coversRiot', { defaultValue: 'Covers: Valorant, League of Legends, TFT' }) : t('linkedApps.linkToAddRiot', { defaultValue: 'Link to add Valorant, League of Legends, TFT' })}
                  </p>
                </div>
                {riotLinked ? (
                  <button type="button" onClick={() => handleDisconnectApp(riotApp!.id)} disabled={unlinking === riotApp!.id}
                    className="shrink-0 p-2 rounded-lg border border-red-500/20 text-red-400 hover:bg-red-500/10 hover:border-red-500/40 transition-all disabled:opacity-50"
                    title={t('linkedApps.unlink', { defaultValue: 'Unlink' })}>
                    {unlinking === riotApp!.id ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
                  </button>
                ) : (
                  <button type="button" disabled
                    className="shrink-0 text-[10px] font-semibold px-4 py-1.5 rounded-lg border transition-all disabled:opacity-40 disabled:cursor-not-allowed border-default text-t-secondary">
                    {t('settings.linkedApps.link', { defaultValue: 'Link' })}
                  </button>
                )}
              </div>
              {riotLinked && riotGames.length > 0 && (
                <div className="flex gap-2 mt-3 ml-14">
                  {riotGames.map(g => {
                    const ga = gameAccountMap.get(g)!;
                    return (
                      <span key={g} className="text-[10px] px-2 py-0.5 rounded-full" style={{ backgroundColor: 'var(--fill-hover)' }}>
                        {g.toUpperCase()}{ga.rank ? ` · ${ga.rank.tier}${ga.rank.division ? ' ' + ga.rank.division : ''}` : ''}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}

        {/* ── Epic Games (OAuth — Fortnite) ── */}
        {(() => {
          const epicApp = connectedAppMap.get('epic');
          const epicLinked = !!epicApp;
          const fortnite = gameAccountMap.get('fortnite');
          return (
            <div id="setting-link-epic-games" className="rounded-2xl border p-5 transition-colors bg-panel" style={{ borderColor: epicLinked ? 'rgba(16,185,129,0.25)' : 'var(--border-subtle)' }}>
              <div className="flex items-center gap-3.5">
                <div className="w-11 h-11 rounded-full shrink-0 overflow-hidden flex items-center justify-center" style={{ backgroundColor: '#2F2F2F' }}>
                  <EpicIcon size={20} className="text-white" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold truncate text-t-primary">
                      {epicApp?.displayName || t('linkedApps.epicGames', { defaultValue: 'Epic Games' })}
                    </span>
                    {epicLinked && (
                      <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full shrink-0" style={{ backgroundColor: 'rgba(16,185,129,0.15)', color: '#10b981' }}>
                        <Shield size={8} className="inline -mt-px mr-0.5" />{t('linkedApps.verified', { defaultValue: 'Verified' })}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] mt-0.5 text-t-secondary">
                    {epicLinked ? t('linkedApps.coversEpic', { defaultValue: 'Covers: Fortnite' }) : t('linkedApps.linkToAddEpic', { defaultValue: 'Link to add Fortnite' })}
                  </p>
                </div>
                {epicLinked ? (
                  <button type="button" onClick={() => handleDisconnectApp(epicApp!.id)} disabled={unlinking === epicApp!.id}
                    className="shrink-0 p-2 rounded-lg border border-red-500/20 text-red-400 hover:bg-red-500/10 hover:border-red-500/40 transition-all disabled:opacity-50"
                    title={t('linkedApps.unlink', { defaultValue: 'Unlink' })}>
                    {unlinking === epicApp!.id ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
                  </button>
                ) : (
                  <button type="button" onClick={() => handleConnectApp('epic')} disabled={connecting === 'epic'}
                    className="btn-cta shrink-0 text-[10px] font-semibold px-4 py-1.5 rounded-xl transition-all">
                    {connecting === 'epic' ? t('settings.linkedApps.linking', { defaultValue: 'Linking...' }) : t('settings.linkedApps.link', { defaultValue: 'Link' })}
                  </button>
                )}
              </div>
              {fortnite && (
                <div className="flex gap-2 mt-3 ml-14">
                  <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ backgroundColor: 'var(--fill-hover)' }}>
                    FORTNITE{fortnite.rank ? ` · ${fortnite.rank.tier}` : ''}
                  </span>
                </div>
              )}
              <p className="text-[8px] mt-2 ml-14" style={{ color: 'var(--text-secondary)' }}>
                Fortnite data by <a href="https://fortnite-api.com" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--text-secondary)' }}>Fortnite-API.com</a>
              </p>
            </div>
          );
        })()}

        {/* ── Steam Game Linking (from SSO) ── */}
        {(() => {
          const steamGames = ['cs2', 'dota2'].filter(g => gameAccountMap.has(g));
          const hasLinked = steamGames.length > 0;
          return (
            <div id="setting-link-steam-games" className="rounded-2xl border p-5 transition-colors bg-panel" style={{ borderColor: hasLinked ? 'rgba(16,185,129,0.25)' : 'var(--border-subtle)' }}>
              <div className="flex items-center gap-3.5">
                <div className="w-11 h-11 rounded-full shrink-0 overflow-hidden flex items-center justify-center" style={{ backgroundColor: '#1B2838' }}>
                  <SteamIcon size={20} className="text-white" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold truncate text-t-primary">{t('linkedApps.steamGames', { defaultValue: 'Steam Games' })}</span>
                    {hasLinked && (
                      <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full shrink-0" style={{ backgroundColor: 'rgba(16,185,129,0.15)', color: '#10b981' }}>
                        <Shield size={8} className="inline -mt-px mr-0.5" />{t('linkedApps.verified', { defaultValue: 'Verified' })}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] mt-0.5 text-t-secondary">
                    {hasLinked ? t('linkedApps.coversSteam', { defaultValue: 'Covers: CS2, Dota 2' }) : steamSso ? t('linkedApps.linkSteamGamesDesc', { defaultValue: 'Link your Steam games for stats tracking' }) : t('linkedApps.linkSteamSsoFirst', { defaultValue: 'Link Steam via SSO first' })}
                  </p>
                </div>
                {!hasLinked && steamSso && (
                  <button type="button" onClick={handleLinkSteamGames} disabled={linkingGame === 'steam'}
                    className="btn-cta shrink-0 text-[10px] font-semibold px-4 py-1.5 rounded-xl transition-all">
                    {linkingGame === 'steam' ? t('settings.linkedApps.linking', { defaultValue: 'Linking...' }) : t('linkedApps.linkGames', { defaultValue: 'Link Games' })}
                  </button>
                )}
                {!hasLinked && !steamSso && (
                  <span className="shrink-0 text-[10px] font-semibold px-4 py-1.5 rounded-lg border transition-all" style={{ borderColor: 'var(--glass-border)', color: 'var(--text-secondary)', opacity: 0.5 }}>
                    {t('linkedApps.ssoRequired', { defaultValue: 'SSO Required' })}
                  </span>
                )}
              </div>
              {hasLinked && (
                <div className="flex gap-2 mt-3 ml-14">
                  {steamGames.map(g => {
                    const ga = gameAccountMap.get(g)!;
                    return (
                      <span key={g} className="text-[10px] px-2 py-0.5 rounded-full" style={{ backgroundColor: 'var(--fill-hover)' }}>
                        {g.toUpperCase()}{ga.rank ? ` · ${ga.rank.tier}${ga.rank.division ? ' ' + ga.rank.division : ''}` : ''}
                      </span>
                    );
                  })}
                </div>
              )}
              {steamSso && prefs && (
                <div id="setting-share-steam-activity-linked" className="flex items-center justify-between py-3 mt-3 ml-14 border-t border-[var(--glass-border)]">
                  <div>
                    <p className="text-xs font-medium text-t-primary">
                      {t('settings.linkedApps.shareSteamActivity', { defaultValue: 'Share Steam Activity' })}
                    </p>
                    <p className="text-[11px] mt-0.5 text-t-secondary">
                      {t('settings.linkedApps.shareSteamActivityDesc', { defaultValue: 'Display your current Steam game as your activity status.' })}
                    </p>
                  </div>
                  <Toggle checked={!!prefs.shareSteamActivity} onChange={(v) => updatePref('shareSteamActivity', v)} />
                </div>
              )}
              <p className="text-[8px] mt-2 ml-14" style={{ color: 'var(--text-secondary)' }}>
                Dota 2 data by <a href="https://opendota.com" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--text-secondary)' }}>OpenDota</a>
                {' · CS2 via Steam Web API'}
              </p>
            </div>
          );
        })()}

        {/* ── Username-Entry Games (Apex, Marvel Rivals, R6 Siege) ── */}
        {([
          { game: 'apex', label: 'Apex Legends', color: '#CD3333', hasPlatform: true },
          { game: 'marvel_rivals', label: 'Marvel Rivals', color: '#E63946', hasPlatform: false },
          { game: 'r6_siege', label: 'Rainbow Six Siege', color: '#2E6EA6', hasPlatform: true },
        ] as const).map(({ game, label, color, hasPlatform }) => {
          const ga = gameAccountMap.get(game);
          const isFormOpen = gameForm?.game === game;
          return (
            <div key={game} id={`setting-${game === 'apex' ? 'link-username-game' : game === 'marvel_rivals' ? 'link-marvel-rivals' : 'link-r6-siege'}`} className="rounded-2xl border p-5 transition-colors bg-panel" style={{ borderColor: ga ? 'rgba(16,185,129,0.25)' : 'var(--border-subtle)' }}>
              <div className="flex items-center gap-3.5">
                <div className="w-11 h-11 rounded-full shrink-0 overflow-hidden flex items-center justify-center" style={{ backgroundColor: color }}>
                  {(() => { const I = PLATFORM_ICON_MAP[game]; return I ? <I size={20} className="text-white" /> : <Gamepad2 size={20} className="text-white" />; })()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold truncate text-t-primary">
                      {ga?.displayName || label}
                    </span>
                    {ga && (
                      <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full shrink-0" style={{ backgroundColor: 'rgba(148,163,184,0.15)', color: '#94a3b8' }}>
                        <Link2 size={8} className="inline -mt-px mr-0.5" />{t('linkedApps.linked', { defaultValue: 'Linked' })}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] mt-0.5 text-t-secondary">
                    {ga ? label : t('linkedApps.enterUsernameToLink', { defaultValue: `Enter your ${label} username to link`, game: label })}
                  </p>
                </div>
                {ga ? (
                  <button type="button" onClick={() => handleUnlinkGame(ga.id)} disabled={unlinking === ga.id}
                    className="shrink-0 p-2 rounded-lg border border-red-500/20 text-red-400 hover:bg-red-500/10 hover:border-red-500/40 transition-all disabled:opacity-50"
                    title={t('linkedApps.unlink', { defaultValue: 'Unlink' })}>
                    {unlinking === ga.id ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
                  </button>
                ) : (
                  <button type="button" onClick={() => setGameForm(isFormOpen ? null : { game, platformId: '', platform: 'pc' })}
                    className="btn-cta shrink-0 text-[10px] font-semibold px-4 py-1.5 rounded-xl transition-all">
                    {isFormOpen ? t('common.cancel', { defaultValue: 'Cancel' }) : t('settings.linkedApps.link', { defaultValue: 'Link' })}
                  </button>
                )}
              </div>
              {/* Inline link form */}
              {isFormOpen && (
                <div className="mt-4 border-t border-[var(--glass-border)] pt-4">
                  <div className="flex gap-2 items-end">
                    <div id={game === 'apex' ? 'setting-apex-username-input' : undefined} className="flex-1">
                      <label className="text-[10px] font-medium text-t-secondary block mb-1">{t('common.username', { defaultValue: 'Username' })}</label>
                      <input
                        type="text" autoFocus maxLength={64}
                        value={gameForm.platformId}
                        onChange={(e) => setGameForm({ ...gameForm, platformId: e.target.value })}
                        className="w-full px-3 py-1.5 rounded-lg text-sm bg-transparent border border-[var(--glass-border)] text-t-primary outline-none focus:border-[var(--cyan-accent)]"
                        placeholder={t('linkedApps.gameUsernamePlaceholder', { defaultValue: `${label} username`, game: label })}
                      />
                    </div>
                    {hasPlatform && (
                      <div id={game === 'apex' ? 'setting-apex-platform-selector' : game === 'r6_siege' ? 'setting-r6-platform-selector' : undefined}>
                        <label className="text-[10px] font-medium text-t-secondary block mb-1">{t('common.platform', { defaultValue: 'Platform' })}</label>
                        <Dropdown
                          options={[
                            { value: 'pc', label: 'PC' },
                            { value: 'psn', label: t('linkedApps.playstation', { defaultValue: 'PlayStation' }) },
                            { value: 'xbox', label: t('linkedApps.xbox', { defaultValue: 'Xbox' }) },
                          ]}
                          value={gameForm.platform}
                          onChange={(v) => setGameForm({ ...gameForm, platform: v })}
                          size="sm"
                        />
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => handleLinkUsernameGame(game, gameForm.platformId, hasPlatform ? gameForm.platform : null)}
                      disabled={!gameForm.platformId.trim() || linkingGame === game}
                      className="btn-cta px-4 py-1.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40"
                    >
                      {linkingGame === game ? <Loader2 size={14} className="animate-spin" /> : t('settings.linkedApps.link', { defaultValue: 'Link' })}
                    </button>
                  </div>
                  {gameFormError && <p className="text-[11px] text-red-400 mt-2">{gameFormError}</p>}
                </div>
              )}
              {ga?.rank && (
                <div className="flex gap-2 mt-3 ml-14">
                  <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ backgroundColor: 'var(--fill-hover)' }}>
                    {ga.rank.tier}{ga.rank.division ? ` ${ga.rank.division}` : ''}{ga.rank.rating != null ? ` · ${ga.rank.rating}` : ''}
                  </span>
                </div>
              )}
              <p className="text-[8px] mt-2 ml-14" style={{ color: 'var(--text-secondary)' }}>
                Data {game === 'apex' ? 'provided' : 'by'}{' '}
                <a href={game === 'apex' ? 'https://apexlegendsstatus.com' : game === 'marvel_rivals' ? 'https://marvelrivalsapi.com' : 'https://r6data.eu'} target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--text-secondary)' }}>
                  {game === 'apex' ? 'Apex Legends Status' : game === 'marvel_rivals' ? 'MarvelRivalsAPI' : 'R6Data'}
                </a>
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default LinkedAppsTab;
