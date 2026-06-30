// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronUp, ChevronDown, Plus, X, Search, Loader2 } from 'lucide-react';
import { Dropdown } from '../ui/dropdown';
import { apiClient, type UserPreferences } from '../../services/api';
import { Toggle, SettingsSection } from './SettingsWidgets';
import { LetterAvatar } from '../LetterAvatar';

const isElectron = !!(window as any).electron?.isElectron;

type ServerActivity = { serverId: string; serverName: string; serverIcon: string | null; memberCount: number; shareActivity: boolean | null };
type CustomGame = { exeName: string; displayName: string };

const SOURCE_IDS = ['steam', 'spotify', 'detected', 'custom', 'bio'] as const;
const SOURCE_LABELS: Record<string, string> = { steam: 'Steam Games', spotify: 'Spotify Listening', detected: 'Local Detection', custom: 'Custom Games', bio: 'About Me' };

export interface ActivitySharingTabProps { servers?: Array<{ id: string; name: string; icon?: string | null }>; onNavigate?: (page: string) => void }

export const ActivitySharingTab: React.FC<ActivitySharingTabProps> = ({ onNavigate }) => {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [activityServers, setActivityServers] = useState<ServerActivity[]>([]);
  const [serverSearch, setServerSearch] = useState('');
  const [customGames, setCustomGames] = useState<CustomGame[]>([]);
  const [addGameOpen, setAddGameOpen] = useState(false);
  const [newExe, setNewExe] = useState('');
  const [newDisplay, setNewDisplay] = useState('');
  const [runningProcs, setRunningProcs] = useState<string[]>([]);
  const [procsLoading, setProcsLoading] = useState(false);

  useEffect(() => {
    Promise.allSettled([
      apiClient.getPreferences(),
      apiClient.getActivityServers(),
      apiClient.getCustomGames(),
    ]).then(([prefsResult, serversResult, cgResult]) => {
      if (prefsResult.status === 'fulfilled') setPrefs(prefsResult.value);
      if (serversResult.status === 'fulfilled') setActivityServers(serversResult.value);
      if (cgResult.status === 'fulfilled') setCustomGames(cgResult.value.customGames ?? []);
    }).finally(() => setLoading(false));
  }, []);

  const updatePref = useCallback(async (key: keyof UserPreferences, value: boolean | string) => {
    const previous = prefs;
    setPrefs((p) => p ? { ...p, [key]: value } as UserPreferences : p);
    try {
      const updated = await apiClient.updatePreferences({ [key]: value } as Partial<UserPreferences>);
      setPrefs(updated);
    } catch { setPrefs(previous); }
  }, [prefs]);

  const priorityOrder = useMemo(() => {
    const raw = prefs?.activitySourcePriority || 'steam,detected,custom,bio';
    const stored = raw.split(',').filter(s => SOURCE_IDS.includes(s as any));
    // Append any new source IDs that aren't in the user's stored priority (e.g. bio for existing users)
    for (const id of SOURCE_IDS) {
      if (!stored.includes(id)) stored.push(id);
    }
    return stored;
  }, [prefs?.activitySourcePriority]);

  const movePriority = useCallback((idx: number, dir: -1 | 1) => {
    const arr = [...priorityOrder];
    const target = idx + dir;
    if (target < 0 || target >= arr.length) return;
    [arr[idx], arr[target]] = [arr[target], arr[idx]];
    updatePref('activitySourcePriority', arr.join(','));
  }, [priorityOrder, updatePref]);

  const handleAddCustomGame = useCallback(async () => {
    const exe = newExe.trim();
    const display = newDisplay.trim();
    if (!exe || !display) return;
    if (!/^[\w.-]+$/.test(exe)) return;
    const updated = [...customGames, { exeName: exe.slice(0, 128), displayName: display.slice(0, 128) }];
    setCustomGames(updated);
    setNewExe(''); setNewDisplay(''); setAddGameOpen(false);
    apiClient.setCustomGames(updated).catch(() => {});
    if (isElectron) window.electron?.addCustomGame({ exeName: exe, displayName: display });
  }, [newExe, newDisplay, customGames]);

  const handleRemoveCustomGame = useCallback(async (exeName: string) => {
    const updated = customGames.filter(g => g.exeName !== exeName);
    setCustomGames(updated);
    apiClient.setCustomGames(updated).catch(() => {});
    if (isElectron) window.electron?.removeCustomGame(exeName);
  }, [customGames]);

  const loadRunningProcesses = useCallback(async () => {
    if (!isElectron) return;
    setProcsLoading(true);
    try {
      const procs = await window.electron!.getRunningProcesses();
      setRunningProcs(procs);
    } catch { /* ignore */ }
    setProcsLoading(false);
  }, []);

  const handleSetServerActivity = useCallback(async (serverId: string, value: boolean | null) => {
    setActivityServers(prev => prev.map(s => s.serverId === serverId ? { ...s, shareActivity: value } : s));
    apiClient.setServerActivitySharing(serverId, value).catch(() => {});
  }, []);

  const filteredServers = useMemo(() => {
    const q = serverSearch.toLowerCase();
    return q ? activityServers.filter(s => s.serverName.toLowerCase().includes(q)) : activityServers;
  }, [activityServers, serverSearch]);

  const masterOff = prefs && !prefs.activitySharingEnabled;

  if (loading) {
    return <div className="max-w-3xl mx-auto"><p className="text-sm py-4 text-t-secondary">{t('common.loading')}</p></div>;
  }
  if (!prefs) {
    return <div className="max-w-3xl mx-auto"><p className="text-sm py-4 text-t-secondary">{t('common.errorLoading', { defaultValue: 'Failed to load preferences. Please try again.' })}</p></div>;
  }

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2 text-t-primary">
        {t('settings.activitySharing', { defaultValue: 'Activity Sharing' })}
      </h2>
      <p className="text-xs mb-8 text-t-secondary">
        {t('settings.activitySharing.description', { defaultValue: 'Control how your activity is shared with friends and servers.' })}
      </p>

      {/* Section 1: Master toggle */}
      <SettingsSection title={t('settings.activitySharing.shareMyActivity', { defaultValue: 'Share my activity' })} className="mb-6">
        <div id="setting-activity-sharing-enabled" className="flex items-center justify-between py-3">
          <div>
            <p className="text-xs font-medium text-t-primary">{t('settings.activitySharing.shareMyActivity', { defaultValue: 'Share my activity' })}</p>
            <p className="text-[11px] mt-0.5 text-t-secondary">{t('settings.activitySharing.shareMyActivityDesc', { defaultValue: 'Share activity information from games and connected apps.' })}</p>
          </div>
          <Toggle checked={prefs.activitySharingEnabled} onChange={(v) => updatePref('activitySharingEnabled', v)} />
        </div>
      </SettingsSection>

      {/* Section 2: Activity Sources */}
      <div style={{ opacity: masterOff ? 0.5 : 1, pointerEvents: masterOff ? 'none' : undefined }}>
        <SettingsSection title={t('settings.activitySharing.sources', { defaultValue: 'Activity Sources' })} className="mb-6">
          <div id="setting-share-steam-activity" className="flex items-center justify-between py-3 border-b border-[var(--glass-border)]">
            <div>
              <p className="text-xs font-medium text-t-primary">{t('settings.activitySharing.steamActivity', { defaultValue: 'Steam Game Activity' })}</p>
              <p className="text-[11px] mt-0.5 text-t-secondary">{t('settings.activitySharing.steamActivityDesc', { defaultValue: 'Show your current Steam game when playing.' })}</p>
            </div>
            <Toggle checked={prefs.shareSteamActivity} onChange={(v) => updatePref('shareSteamActivity', v)} />
          </div>
          <div id="setting-share-spotify-activity-sharing" className="flex items-center justify-between py-3 border-b border-[var(--glass-border)]">
            <div>
              <p className="text-xs font-medium text-t-primary">{t('settings.activitySharing.spotifyActivity', { defaultValue: 'Spotify Listening Activity' })}</p>
              <p className="text-[11px] mt-0.5 text-t-secondary">{t('settings.activitySharing.spotifyActivityDesc', { defaultValue: 'Show what you\'re currently listening to on Spotify.' })}</p>
            </div>
            <Toggle checked={!!prefs.shareSpotifyActivity} onChange={(v) => updatePref('shareSpotifyActivity', v)} />
          </div>
          <div id="setting-share-detected-games" className="flex items-center justify-between py-3 border-b border-[var(--glass-border)]">
            <div>
              <p className="text-xs font-medium text-t-primary">{t('settings.activitySharing.localDetection', { defaultValue: 'Local Game Detection' })}</p>
              <p className="text-[11px] mt-0.5 text-t-secondary">
                {isElectron ? t('settings.activitySharing.localDetectionDesc', { defaultValue: 'Automatically detect games running on your desktop.' }) : t('settings.activitySharing.localDetectionWebDesc', { defaultValue: 'Game detection requires the Howl desktop app.' })}
              </p>
            </div>
            <Toggle checked={prefs.shareDetectedGames} onChange={(v) => updatePref('shareDetectedGames', v)} disabled={!isElectron} />
          </div>

          {/* Custom Games */}
          <div id="setting-custom-games-manage" className="py-3">
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="text-xs font-medium text-t-primary">{t('settings.activitySharing.customGames', { defaultValue: 'Custom Games' })}</p>
                <p className="text-[11px] mt-0.5 text-t-secondary">{t('settings.activitySharing.customGamesDesc', { defaultValue: 'Games you\'ve manually added for detection.' })}</p>
              </div>
              <button id="setting-add-custom-game" type="button" onClick={() => { setAddGameOpen(true); loadRunningProcesses(); }} className="flex items-center gap-1 text-[10px] font-semibold px-3 py-1.5 rounded-lg border border-[var(--cyan-accent)]/30 hover:bg-[var(--cyan-accent)]/10 transition-all text-t-accent">
                <Plus size={12} /> {t('settings.activitySharing.addGame', { defaultValue: 'Add Game' })}
              </button>
            </div>
            {customGames.length === 0 ? (
              <p className="text-[11px] py-2 text-t-secondary" style={{ opacity: 0.6 }}>{t('settings.activitySharing.noCustomGames', { defaultValue: 'No custom games added yet.' })}</p>
            ) : (
              <div className="space-y-1.5 mt-2">
                {customGames.map((g) => (
                  <div key={g.exeName} className="flex items-center justify-between px-3 py-2 rounded-lg border border-[var(--glass-border)] bg-input-surface">
                    <div className="min-w-0">
                      <span className="text-xs font-mono truncate block text-t-secondary">{g.exeName}</span>
                      <span className="text-xs font-medium truncate block text-t-primary">{g.displayName}</span>
                    </div>
                    <button id="setting-remove-custom-game" type="button" onClick={() => handleRemoveCustomGame(g.exeName)} className="shrink-0 p-1 rounded-lg text-red-400 hover:bg-red-500/10 transition-colors"><X size={12} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* About Me toggle */}
          <div id="setting-share-activity-bio" className="flex items-center justify-between py-3 border-t border-[var(--glass-border)]">
            <div>
              <p className="text-xs font-medium text-t-primary">{t('settings.activitySharing.bioActivity', { defaultValue: 'About Me' })}</p>
              <p className="text-[11px] mt-0.5 text-t-secondary">{t('settings.activitySharing.bioActivityDesc', { defaultValue: 'Show your About Me when no game is detected.' })}</p>
            </div>
            <Toggle checked={prefs.shareActivityBio} onChange={(v) => updatePref('shareActivityBio', v)} />
          </div>
        </SettingsSection>

        {/* Section 3: Priority */}
        <SettingsSection title={t('settings.activitySharing.priority', { defaultValue: 'Activity Priority' })} className="mb-6">
          <p className="text-[11px] mb-3 text-t-secondary">{t('settings.activitySharing.priorityDesc', { defaultValue: 'When multiple activities are detected, the highest priority source wins.' })}</p>
          <div id="setting-activity-source-priority" className="space-y-1">
            {priorityOrder.map((sourceId, idx) => (
              <div key={sourceId} className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-[var(--glass-border)] bg-input-surface">
                <span className="text-[11px] font-bold w-5 text-center text-t-secondary">{idx + 1}</span>
                <span className="flex items-center gap-2 text-xs font-medium flex-1 text-t-primary">
                  {SOURCE_LABELS[sourceId] || sourceId}
                </span>
                <button type="button" disabled={idx === 0} onClick={() => movePriority(idx, -1)} className="p-1 rounded-lg hover:bg-fill-hover disabled:opacity-20 transition-colors text-t-secondary" title={t('settings.activitySharing.moveUp', { defaultValue: 'Move up' })}><ChevronUp size={14} /></button>
                <button type="button" disabled={idx === priorityOrder.length - 1} onClick={() => movePriority(idx, 1)} className="p-1 rounded-lg hover:bg-fill-hover disabled:opacity-20 transition-colors text-t-secondary" title={t('settings.activitySharing.moveDown', { defaultValue: 'Move down' })}><ChevronDown size={14} /></button>
              </div>
            ))}
          </div>
        </SettingsSection>

        {/* Section 4: Scope radio */}
        <div id="setting-activity-share-scope">
        <SettingsSection title={t('settings.activitySharing.autoShare', { defaultValue: 'Automatically share my activity with' })} className="mb-6">
          {(['everyone', 'friends_small_servers', 'friends_only'] as const).map((scope) => {
            const labels: Record<string, { label: string; desc: string }> = {
              everyone: { label: t('settings.activitySharing.friendsAllServers', { defaultValue: 'Friends & All Servers' }), desc: t('settings.activitySharing.friendsAllServersDesc', { defaultValue: 'Your activity is shared with friends and any server you join.' }) },
              friends_small_servers: { label: t('settings.activitySharing.friendsSmallServers', { defaultValue: 'Friends & Small Servers Only' }), desc: t('settings.activitySharing.friendsSmallServersDesc', { defaultValue: 'Shared with friends and servers with 200 or fewer members.' }) },
              friends_only: { label: t('settings.activitySharing.friendsOnly', { defaultValue: 'Friends Only' }), desc: t('settings.activitySharing.friendsOnlyDesc', { defaultValue: 'Your activity is only shared with friends.' }) },
            };
            const { label, desc } = labels[scope];
            return (
              <button key={scope} type="button" onClick={() => updatePref('activityShareScope', scope)} className="flex items-start gap-3 py-3 w-full text-left border-b border-[var(--glass-border)] last:border-b-0">
                <div className={`w-4 h-4 mt-0.5 rounded-full border-[1.5px] flex items-center justify-center shrink-0 transition-colors ${prefs.activityShareScope === scope ? 'border-[var(--cyan-accent)] bg-[var(--cyan-accent)]' : 'border-[var(--border-strong)]'}`}>
                  {prefs.activityShareScope === scope && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                </div>
                <div>
                  <p className="text-xs font-medium text-t-primary">{label}</p>
                  <p className="text-[11px] mt-0.5 text-t-secondary">{desc}</p>
                </div>
              </button>
            );
          })}
        </SettingsSection>
        </div>

        {/* Section 5: Per-server overrides */}
        <SettingsSection title={t('settings.activitySharing.myServers', { defaultValue: 'My Servers' })} className="mb-6">
          {masterOff && <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-400/70 mb-3">{t('settings.activitySharing.serverSettingsIgnored', { defaultValue: 'Server settings ignored when not sharing' })}</p>}
          <div className="flex items-center gap-2 mb-3">
            <div id="setting-server-activity-search" className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--glass-border)] bg-input-surface">
              <Search size={14} className="text-t-secondary" />
              <input type="text" value={serverSearch} onChange={e => setServerSearch(e.target.value)} placeholder={t('settings.activitySharing.searchServers', { defaultValue: 'Search my servers' })} className="flex-1 bg-transparent outline-none text-xs text-t-primary" />
            </div>
            <button id="setting-toggle-all-servers-off" type="button" onClick={() => { activityServers.forEach(s => handleSetServerActivity(s.serverId, false)); }} className="text-[9px] font-bold uppercase tracking-wide shrink-0 px-2 py-1.5 rounded-lg hover:bg-fill-hover transition-colors text-t-secondary">
              {t('settings.activitySharing.toggleAllOff', { defaultValue: 'Toggle All Off' })}
            </button>
          </div>
          <div className="space-y-1 max-h-[320px] overflow-y-auto">
            {filteredServers.map(s => (
              <div key={s.serverId} id={`setting-per-server-activity-toggle-${s.serverId}`} className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-[var(--glass-border)] bg-input-surface">
                <LetterAvatar avatar={s.serverIcon} username={s.serverName} size={28} className="rounded-lg shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate text-t-primary">{s.serverName}</p>
                  <p className="text-[10px] text-t-secondary">{t('settings.activitySharing.members', { defaultValue: '{{count}} Members', count: s.memberCount })}</p>
                </div>
                <Toggle checked={s.shareActivity !== false} onChange={(v) => handleSetServerActivity(s.serverId, v ? null : false)} />
              </div>
            ))}
          </div>
        </SettingsSection>
      </div>

      {/* Add Game Modal */}
      {addGameOpen && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md border border-[var(--glass-border)] rounded-2xl shadow-2xl p-6 bg-floating">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold text-t-primary">{t('settings.activitySharing.addGameTitle', { defaultValue: 'Add Custom Game' })}</h3>
              <button type="button" onClick={() => setAddGameOpen(false)} className="p-1 rounded-lg hover:bg-fill-hover text-t-secondary"><X size={16} /></button>
            </div>

            {isElectron && (
              <div id="setting-pick-from-running" className="mb-4">
                <p className="text-[11px] font-medium mb-1.5 text-t-secondary">{t('settings.activitySharing.pickFromRunning', { defaultValue: 'Pick from running programs' })}</p>
                {procsLoading ? (
                  <div className="flex items-center gap-2 py-2"><Loader2 size={14} className="animate-spin text-t-secondary" /></div>
                ) : (
                  <Dropdown
                    options={runningProcs.map(p => ({ value: p, label: p }))}
                    value={null}
                    onChange={(v) => { setNewExe(v); setNewDisplay(v.replace(/\.exe$/i, '')); }}
                    placeholder={t('settings.activitySharing.runningProcesses', { defaultValue: 'Running Processes' })}
                    size="sm"
                    className="w-full"
                  />
                )}
              </div>
            )}

            <div className="space-y-3 mb-4">
              <div id="setting-add-game-exe-name">
                <label className="text-[11px] font-medium block mb-1 text-t-secondary">{t('settings.activitySharing.exeName', { defaultValue: 'Executable name' })}</label>
                <input type="text" value={newExe} onChange={e => setNewExe(e.target.value)} placeholder={t('settings.activitySharing.exeNamePlaceholder', { defaultValue: 'e.g. MyGame.exe' })} maxLength={128} className="w-full px-3 py-2 rounded-lg border border-[var(--glass-border)] text-xs bg-input-surface text-t-primary outline-none" />

              </div>
              <div id="setting-add-game-display-name">
                <label className="text-[11px] font-medium block mb-1 text-t-secondary">{t('settings.activitySharing.displayName', { defaultValue: 'Display name' })}</label>
                <input type="text" value={newDisplay} onChange={e => setNewDisplay(e.target.value)} placeholder={t('settings.activitySharing.displayNamePlaceholder', { defaultValue: 'e.g. My Custom Game' })} maxLength={128} className="w-full px-3 py-2 rounded-lg border border-[var(--glass-border)] text-xs bg-input-surface text-t-primary outline-none" />

              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setAddGameOpen(false)} className="btn-secondary text-[11px] px-4 py-2">{t('common.cancel')}</button>
              <button type="button" onClick={handleAddCustomGame} disabled={!newExe.trim() || !newDisplay.trim()} className="btn-cta text-[11px] font-semibold px-4 py-2 rounded-xl disabled:opacity-40 disabled:cursor-not-allowed transition-all">{t('settings.activitySharing.addGame', { defaultValue: 'Add Game' })}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Showcase Link ──────────────────────────────────────────────── */}
      <SettingsSection title={t('settings.showcase', { defaultValue: 'Showcase' })}>
        <p className="text-xs mb-3 text-t-secondary">
          {t('settings.showcaseActivityDesc', { defaultValue: 'Customize what game stats and music appear on your profile.' })}
        </p>
        {onNavigate && (
          <button
            id="setting-edit-showcase-link"
            type="button"
            onClick={() => onNavigate('showcase')}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
            style={{ color: 'var(--cyan-accent)', background: 'color-mix(in srgb, var(--cyan-accent) 8%, transparent)' }}
          >
            {t('settings.editShowcase', { defaultValue: 'Edit showcase \u2192' })}
          </button>
        )}
      </SettingsSection>
    </div>
  );
};

export default ActivitySharingTab;
