// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Server, User } from '../../types';
import { Ban } from 'lucide-react';
import { Dropdown } from '../ui/dropdown';
import { apiClient, type UserPreferences } from '../../services/api';
import { Toggle, SettingsSection } from './SettingsWidgets';
import { BadgeDisplaySection, type BadgeDisplayValue } from './BadgeDisplaySection';
import { useSettings } from '../../contexts/SettingsContext';

export interface SocialPrivacyTabProps {
  servers: Server[];
  currentUser?: User;
}

const SocialPrivacyTab: React.FC<SocialPrivacyTabProps> = ({ servers, currentUser }) => {
  const { t } = useTranslation();
  const { chatSettings, updateChatSettings } = useSettings();
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [prefsLoading, setPrefsLoading] = useState(false);
  const [privacyServerId, setPrivacyServerId] = useState<string | null>(null);
  const [serverDmSetting, setServerDmSetting] = useState<boolean | null>(null);
  const [serverDmLoading, setServerDmLoading] = useState(false);

  const [blockedList, setBlockedList] = useState<{ id: string; username: string; tag: string }[]>([]);
  const [blockedLoading, setBlockedLoading] = useState(false);
  const [prefsError, setPrefsError] = useState<string | null>(null);
  const [blockedError, setBlockedError] = useState<string | null>(null);

  // Fetch preferences on mount
  useEffect(() => {
    if (!prefs && !prefsLoading) {
      setPrefsLoading(true);
      setPrefsError(null);
      apiClient.getPreferences().then(setPrefs).catch(() => setPrefsError(t('settings.privacy.failedToLoadPreferences'))).finally(() => setPrefsLoading(false));
    }
  }, []);

  // Fetch blocked users on mount
  useEffect(() => {
    setBlockedLoading(true);
    setBlockedError(null);
    apiClient.getBlocked()
      .then((users) => setBlockedList(users.map((u) => ({
        id: u.id,
        username: u.username,
        tag: u.discriminator ? `${u.username}#${u.discriminator}` : u.username,
      }))))
      .catch(() => setBlockedError(t('settings.privacy.failedToLoadBlocked')))
      .finally(() => setBlockedLoading(false));
  }, []);

  const blockedCount = blockedList.length;

  const updatePref = useCallback(async (key: keyof UserPreferences, value: boolean | string | BadgeDisplayValue) => {
    const previous = prefs;
    setPrefs((p) => p ? { ...p, [key]: value } as UserPreferences : p);
    try {
      const updated = await apiClient.updatePreferences({ [key]: value } as Partial<UserPreferences>);
      setPrefs(updated);
    } catch {
      setPrefs(previous);
    }
  }, [prefs]);

  if (!prefs) {
    return (
      <div className="max-w-3xl mx-auto">
        {prefsError ? (
          <div className="text-sm text-red-400 py-4 text-center">{prefsError}</div>
        ) : (
          <p className="text-sm text-t-secondary">{t('settings.privacy.loadingPreferences')}</p>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2 text-t-primary">{t('settings.socialPrivacy')}</h2>
      <p className="text-xs mb-8 text-t-secondary">{t('settings.manageWho')}</p>

      <SettingsSection title={t('settings.whoCanReachYou')} className="mb-6">
        <div id="setting-privacy-server-selector" className="mb-4">
          <Dropdown
            options={[
              { value: '', label: t('settings.privacy.allServersGlobalDefault') },
              ...(servers ?? []).map((s) => ({ value: s.id, label: s.name })),
            ]}
            value={privacyServerId ?? ''}
            onChange={(v) => {
              const id = v || null;
              setPrivacyServerId(id);
              if (id) {
                setServerDmLoading(true);
                apiClient.getServerPrivacy(id).then((r) => { setServerDmSetting(r.allowDirectMessages); }).catch(() => { setServerDmSetting(null); }).finally(() => setServerDmLoading(false));
              } else {
                setServerDmSetting(null);
              }
            }}
            size="sm"
            className="w-full"
          />
        </div>

        {!privacyServerId ? (
          <>
            <div id="setting-allow-dms-global" className="flex items-center justify-between py-3 border-b border-[var(--glass-border)]">
              <div>
                <p className="text-xs font-medium text-t-primary">{t('settings.directMessages')}</p>
                <p className="text-[11px] mt-0.5 text-t-secondary">{t('settings.privacy.allowDMsGlobalDefault')}</p>
              </div>
              <Toggle checked={prefs.allowDmFromServerMembers} onChange={(v) => updatePref('allowDmFromServerMembers', v)} />
            </div>
            <div id="setting-message-requests-filter" className="flex items-center justify-between py-3">
              <div>
                <p className="text-xs font-medium text-t-primary">{t('settings.privacy.messageRequests')}</p>
                <p className="text-[11px] mt-0.5 text-t-secondary">{t('settings.privacy.messageRequestsDesc')}</p>
              </div>
              <Toggle checked={prefs.messageRequestsFilter} onChange={(v) => updatePref('messageRequestsFilter', v)} />
            </div>
          </>
        ) : (
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-xs font-medium text-t-primary">{t('settings.allowDMsFromMembers')}</p>
              <p className="text-[11px] mt-0.5 text-t-secondary">
                {serverDmSetting === null
                  ? t('settings.privacy.usingGlobalDefault', { status: prefs.allowDmFromServerMembers ? t('settings.privacy.allowed') : t('settings.privacy.blocked') })
                  : serverDmSetting ? t('settings.privacy.allowedForServer') : t('settings.privacy.blockedForServer')}
              </p>
            </div>
            {serverDmLoading ? (
              <div className="w-11 h-6 rounded-full bg-fill-hover animate-pulse" />
            ) : (
              <div className="flex items-center gap-2">
                <Toggle
                  checked={serverDmSetting ?? prefs.allowDmFromServerMembers}
                  onChange={(v) => {
                    const prev = serverDmSetting;
                    setServerDmSetting(v);
                    apiClient.updateServerPrivacy(privacyServerId, { allowDirectMessages: v }).catch(() => {
                      setServerDmSetting(prev);
                    });
                  }}
                />
                {serverDmSetting !== null && (
                  <button
                    id="setting-reset-server-dm-override"
                    type="button"
                    onClick={() => {
                      const prev = serverDmSetting;
                      setServerDmSetting(null);
                      apiClient.updateServerPrivacy(privacyServerId, { allowDirectMessages: null }).catch(() => {
                        setServerDmSetting(prev);
                      });
                    }}
                    className="text-[9px] font-bold uppercase tracking-wide text-slate-400 hover:text-[var(--cyan-accent)] transition-colors"
                  >
                    {t('common.reset')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Privacy & Content" className="mb-6">
        <p className="text-[11px] mb-4 text-t-secondary">
          Control your visibility in public discovery.
        </p>

        {/* Discovery opt-out */}
        <div id="setting-discovery-opt-out" className="flex items-center justify-between py-3">
          <div className="min-w-0 mr-4">
            <p className="text-xs font-medium text-t-primary">
              Hide my activity from public discovery rankings
            </p>
            <p className="text-[11px] mt-0.5 text-t-secondary">
              When you join a public community server, your account won't be counted toward
              "trending" or "popular" lists. Doesn't affect your visibility inside the server.
            </p>
          </div>
          <Toggle
            checked={!!prefs.discoveryOptOut}
            onChange={(v) => updatePref('discoveryOptOut', v)}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.privacy.profileVisibility')} className="mb-6">
        <div id="setting-private-profile" className="flex items-center justify-between py-3 border-b border-[var(--glass-border)]">
          <div className="flex-1 mr-4">
            <p className="text-xs font-medium text-t-primary">{t('settings.privacy.privateProfile')}</p>
            <p className="text-[11px] mt-0.5 text-t-secondary">{t('settings.privacy.privateProfileDesc')}</p>
          </div>
          <Toggle checked={prefs.profilePrivate} onChange={(v) => updatePref('profilePrivate', v)} />
        </div>
        <div id="setting-show-join-date" className="flex items-center justify-between py-3 border-b border-[var(--glass-border)]">
          <div>
            <p className="text-xs font-medium text-t-primary">{t('settings.privacy.showWhenJoined')}</p>
            <p className="text-[11px] mt-0.5 text-t-secondary">{t('settings.privacy.showWhenJoinedDesc')}</p>
          </div>
          <Toggle checked={prefs.showJoinDate} onChange={(v) => updatePref('showJoinDate', v)} />
        </div>
        <div id="setting-show-badges" className="flex items-center justify-between py-3">
          <div>
            <p className="text-xs font-medium text-t-primary">{t('settings.privacy.showBadges')}</p>
            <p className="text-[11px] mt-0.5 text-t-secondary">{t('settings.privacy.showBadgesDesc')}</p>
          </div>
          <Toggle checked={prefs.showBadges} onChange={(v) => updatePref('showBadges', v)} />
        </div>
      </SettingsSection>

      <BadgeDisplaySection
        earned={currentUser?.badges ?? []}
        value={prefs.badgeDisplay ?? { hidden: [], order: [] }}
        disabled={!prefs.showBadges}
        onChange={(next) => updatePref('badgeDisplay', next)}
      />

      <SettingsSection title={t('settings.privacy.dmSidebar', { defaultValue: 'Direct Messages Sidebar' })} className="mb-6">
        <div id="setting-dm-sidebar-show-activity" className="flex items-center justify-between py-2">
          <div className="min-w-0 pr-4">
            <p className="text-xs font-medium text-t-primary">
              {t('settings.privacy.dmSidebarShowActivity', { defaultValue: 'Show activity in DM sidebar' })}
            </p>
            <p className="text-[11px] mt-0.5 text-t-secondary">
              {t('settings.privacy.dmSidebarShowActivityDesc', { defaultValue: 'Display game activity instead of message previews in your DM list.' })}
            </p>
          </div>
          <Toggle
            checked={chatSettings.dmSidebarShowActivity}
            onChange={(v) => updateChatSettings({ dmSidebarShowActivity: v })}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.friendRequestSettings')} className="mb-6">
        <div className="space-y-3">
          <div id="setting-friend-requests-everyone" className="flex items-center justify-between py-2">
            <span className="text-xs font-medium text-t-primary">{t('settings.everyone')}</span>
            <Toggle checked={prefs.friendRequestsEveryone} onChange={(v) => updatePref('friendRequestsEveryone', v)} />
          </div>
          <div id="setting-friend-requests-friends-of-friends" className="flex items-center justify-between py-2">
            <span className="text-xs font-medium text-t-primary">{t('settings.friendsOfFriends')}</span>
            <Toggle checked={prefs.friendRequestsFriendsOfFriends} onChange={(v) => updatePref('friendRequestsFriendsOfFriends', v)} />
          </div>
          <div id="setting-friend-requests-server-members" className="flex items-center justify-between py-2">
            <span className="text-xs font-medium text-t-primary">{t('settings.serverMembers')}</span>
            <Toggle checked={prefs.friendRequestsServerMembers} onChange={(v) => updatePref('friendRequestsServerMembers', v)} />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.blockedUsers')}>
        <p className="text-xs mb-4 text-t-secondary">{t('settings.blockedUsersDesc')}</p>
        <div id="setting-blocked-users-list" className="border border-[var(--glass-border)] rounded-xl p-4 mb-4 flex items-center gap-3 bg-input-surface">
          <Ban size={20} className="text-slate-500 shrink-0" />
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-t-primary">{t('settings.privacy.blockedAccounts')}</p>
            <p className="text-[11px] text-t-secondary">
              {blockedLoading ? t('common.loading') : t('settings.privacy.accountCount', { count: blockedCount })}
            </p>
          </div>
        </div>
        {blockedError ? (
          <div className="text-sm text-red-400 py-4 text-center">{blockedError}</div>
        ) : blockedList.length === 0 ? (
          <p className="text-xs py-4 text-t-secondary">
            {blockedLoading ? t('settings.privacy.loadingBlocked') : t('settings.haventBlockedAnyone')}
          </p>
        ) : (
          <ul className="space-y-2">
            {blockedList.map((b) => (
              <li key={b.id} className="flex items-center justify-between py-3 px-4 rounded-xl border border-[var(--glass-border)] bg-input-surface">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-full bg-fill-hover shrink-0 flex items-center justify-center text-xs font-bold text-t-secondary">{b.username.slice(0, 2).toUpperCase()}</div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate text-t-primary">{b.username}</p>
                    <p className="text-[11px] truncate text-t-secondary">{b.tag}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await apiClient.unblockUser(b.id);
                      setBlockedList(prev => prev.filter(u => u.id !== b.id));
                    } catch {
                      console.error('Failed to unblock user');
                    }
                  }}
                  className="btn-secondary text-[10px] px-4 py-1.5 shrink-0"
                >
                  {t('settings.unblock')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    </div>
  );
};

export default SocialPrivacyTab;
