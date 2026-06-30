// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Headphones, ChevronDown, ChevronUp, Play, Square } from 'lucide-react';
import { Dropdown } from '../ui/dropdown';
import { apiClient, type UserPreferences } from '../../services/api';
import { Toggle, SettingsSection } from './SettingsWidgets';
import { playNotificationPreview } from '../../utils/notificationSound';

export interface NotificationsTabProps {
  onNavigate: (page: string) => void;
}

export const NotificationsTab: React.FC<NotificationsTabProps> = ({ onNavigate }) => {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [prefsLoading, setPrefsLoading] = useState(false);
  const [prefsError, setPrefsError] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const fetchPrefs = useCallback(() => {
    setPrefsLoading(true);
    setPrefsError(false);
    apiClient.getPreferences()
      .then(setPrefs)
      .catch(() => setPrefsError(true))
      .finally(() => setPrefsLoading(false));
  }, []);

  useEffect(() => {
    if (!prefs && !prefsLoading && !prefsError) {
      fetchPrefs();
    }
  }, [prefs, prefsLoading, prefsError, fetchPrefs]);

  const updatePref = useCallback(async (key: keyof UserPreferences, value: boolean) => {
    const previous = prefs;
    setPrefs((p) => p ? { ...p, [key]: value } : p);
    try {
      const updated = await apiClient.updatePreferences({ [key]: value });
      setPrefs(updated);
      window.dispatchEvent(new Event('howl-prefs-change'));
    } catch {
      setPrefs(previous);
    }
  }, [prefs]);

  const [previewingKey, setPreviewingKey] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPreview = useCallback(() => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.currentTime = 0;
      previewAudioRef.current = null;
    }
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    setPreviewingKey(null);
  }, []);

  useEffect(() => () => stopPreview(), [stopPreview]);

  if (!prefs) return (
    <div className="max-w-3xl mx-auto py-8 text-center">
      {prefsError ? (
        <>
          <p className="text-sm mb-3 text-t-secondary">{t('settings.notifications.failedToLoadPreferences')}</p>
          <button type="button" onClick={fetchPrefs} className="text-xs px-4 py-2 rounded-lg bg-fill-hover hover:bg-fill-active text-t-accent">{t('common.retry')}</button>
        </>
      ) : (
        <p className="text-sm text-t-secondary">{t('settings.notifications.loadingPreferences')}</p>
      )}
    </div>
  );

  const handleDesktopToggle = async (v: boolean) => {
    if (v && typeof Notification !== 'undefined') {
      if (Notification.permission === 'default') {
        const result = await Notification.requestPermission();
        if (result === 'denied') return;
      }
      if (Notification.permission === 'denied') return;
    }
    updatePref('notifyDesktop', v);
  };

  const togglePreview = (key: string) => {
    if (previewingKey === key) {
      stopPreview();
      return;
    }
    stopPreview();
    setPreviewingKey(key);
    if (key === 'notifySoundIncomingRing') {
      const audio = new Audio('/sounds/ringtone.mp3');
      audio.volume = 0.5;
      const clear = () => setPreviewingKey((p) => (p === key ? null : p));
      audio.onended = clear;
      audio.onerror = clear;
      audio.play().catch(clear);
      previewAudioRef.current = audio;
    } else {
      playNotificationPreview();
      // Chime is ~150ms; auto-clear so the button flips back without manual stop.
      previewTimerRef.current = setTimeout(() => {
        setPreviewingKey((p) => (p === key ? null : p));
        previewTimerRef.current = null;
      }, 200);
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2 text-t-primary">{t('settings.notificationsTab')}</h2>
      <p className="text-xs mb-8 text-t-secondary">{t('settings.fineTuneAlerts')}</p>

      <SettingsSection title={t('settings.notifications.overview')} className="mb-6">
        <div id="setting-enable-desktop-notifications" className="flex items-center justify-between py-3 border-b border-[var(--glass-border)]">
          <div>
            <p className="text-xs font-medium text-t-primary">{t('settings.enableDesktopNotifications')}</p>
            <p className="text-[11px] mt-0.5 text-t-secondary">{t('settings.notifications.perChannelDesc')}</p>
            {typeof Notification !== 'undefined' && Notification.permission === 'denied' && prefs.notifyDesktop && (
              <p className="text-[10px] mt-1 text-amber-400">{t('settings.notifications.browserPermissionDenied')}</p>
            )}
          </div>
          <Toggle checked={prefs.notifyDesktop} onChange={handleDesktopToggle} />
        </div>
        <div className="py-3 border-b border-[var(--glass-border)]">
          <p className="text-xs font-medium mb-3 text-t-primary">{t('settings.notifications.notifyMeWhen')}</p>
          <div className="space-y-2 pl-2">
            <div id="setting-notify-people-streaming" className="flex items-center justify-between py-2">
              <span className="text-[11px] text-t-secondary">{t('settings.notifications.peopleStreaming')}</span>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-lg bg-fill-hover text-t-secondary">{t('settings.notifications.soon')}</span>
                <Toggle checked={false} onChange={() => {}} disabled />
              </div>
            </div>
            <div id="setting-notify-friends-join-voice" className="flex items-center justify-between py-2">
              <span className="text-[11px] text-t-secondary">{t('settings.notifications.friendsJoinVoice')}</span>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-lg bg-fill-hover text-t-secondary">{t('settings.notifications.soon')}</span>
                <Toggle checked={false} onChange={() => {}} disabled />
              </div>
            </div>
            <div id="setting-notify-someone-reacts" className="flex items-center justify-between py-2">
              <span className="text-[11px] text-t-secondary">{t('settings.notifications.someoneReacts')}</span>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-lg bg-fill-hover text-t-secondary">{t('settings.notifications.soon')}</span>
                <Dropdown
                  options={[
                    { value: 'all', label: t('settings.notifications.allMessages') },
                    { value: 'dms', label: t('settings.notifications.dmsOnly') },
                    { value: 'off', label: t('settings.notifications.off') },
                  ]}
                  value="all"
                  onChange={() => {}}
                  disabled
                  size="sm"
                />
              </div>
            </div>
            <div id="setting-notify-friends-update-profile" className="flex items-center justify-between py-2">
              <span className="text-[11px] text-t-secondary">{t('settings.notifications.friendsUpdateProfile')}</span>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-lg bg-fill-hover text-t-secondary">{t('settings.notifications.soon')}</span>
                <Toggle checked={false} onChange={() => {}} disabled />
              </div>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.sounds')} className="mb-6">
        <div className="space-y-3">
          {([
            { label: t('settings.notifications.newMessage'), key: 'notifySoundNewMessage' as const, preview: true, soundId: 'sound-new-message', previewId: 'preview-sound-new-message' },
            { label: t('settings.notifications.newMessageCurrentChannel'), key: 'notifySoundCurrentChannel' as const, preview: true, soundId: 'sound-current-channel', previewId: 'preview-sound-current-channel' },
            { label: t('settings.notifications.incomingRing'), key: 'notifySoundIncomingRing' as const, preview: true, soundId: 'sound-incoming-ring', previewId: 'preview-sound-incoming-ring' },
          ] as const).map((row) => {
            const isPlaying = previewingKey === row.key;
            return (
              <div key={row.label} id={`setting-${row.soundId}`} className="flex items-center justify-between py-2 border-b border-[var(--glass-border)]">
                <div className="flex items-center gap-2.5">
                  <span className="text-xs font-medium text-t-primary">{row.label}</span>
                  {row.preview && (
                    <button
                      id={`setting-${row.previewId}`}
                      type="button"
                      onClick={() => togglePreview(row.key)}
                      aria-label={isPlaying ? t('settings.stop') : t('settings.preview')}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider border transition-all ${
                        isPlaying
                          ? 'bg-red-500/15 text-red-400 border-red-500/40 hover:bg-red-500/25'
                          : 'bg-[var(--cyan-accent)]/10 text-[var(--cyan-accent)] border-[var(--cyan-accent)]/30 hover:bg-[var(--cyan-accent)]/20'
                      }`}
                    >
                      {isPlaying ? <Square size={9} fill="currentColor" /> : <Play size={9} fill="currentColor" />}
                      {isPlaying ? t('settings.stop') : t('settings.preview')}
                    </button>
                  )}
                </div>
                <Toggle checked={prefs[row.key]} onChange={(v) => updatePref(row.key, v)} />
              </div>
            );
          })}
          <div id="setting-disable-all-sounds" className="flex items-center justify-between py-2">
            <div>
              <p className="text-xs font-medium text-t-primary">{t('settings.notifications.disableAllSounds')}</p>
              <p className="text-[11px] mt-0.5 max-w-sm text-t-secondary">{t('settings.notifications.disableAllSoundsDesc')}</p>
            </div>
            <Toggle checked={prefs.notifyDisableAllSounds} onChange={(v) => updatePref('notifyDisableAllSounds', v)} />
          </div>
        </div>
      </SettingsSection>

      <button id="setting-navigate-voice-video" type="button" onClick={() => onNavigate('voice-video')} className="mb-6 p-4 rounded-xl border border-[var(--glass-border)] flex items-center gap-4 w-full text-left hover:border-[var(--cyan-accent)]/30 transition-colors cursor-pointer bg-panel">
        <Headphones size={20} className="text-[var(--cyan-accent)] shrink-0" />
        <div className="min-w-0">
          <p className="text-xs font-bold text-t-primary">{t('settings.voiceVideo')}</p>
          <p className="text-[11px] mt-0.5 text-t-secondary">{t('settings.voiceVideoSoundsDesc')}</p>
        </div>
        <ChevronDown size={18} className="text-slate-500 shrink-0 rotate-[-90deg]" />
      </button>

      <SettingsSection title={t('settings.notifications.badges')} className="mb-6">
        <div id="setting-enable-unread-badge" className="flex items-center justify-between py-3 border-b border-[var(--glass-border)]">
          <div>
            <p className="text-xs font-medium text-t-primary">{t('settings.notifications.enableUnreadBadge')}</p>
            <p className="text-[11px] mt-0.5 text-t-secondary">{t('settings.notifications.enableUnreadBadgeDesc')}</p>
          </div>
          <Toggle checked={prefs.notifyUnreadBadge} onChange={(v) => updatePref('notifyUnreadBadge', v)} />
        </div>
        <div id="setting-enable-taskbar-flash" className="flex items-center justify-between py-3">
          <div>
            <p className="text-xs font-medium text-t-primary">{t('settings.notifications.enableTaskbarFlash')}</p>
            <p className="text-[11px] mt-0.5 text-t-secondary">{t('settings.notifications.enableTaskbarFlashDesc')}</p>
          </div>
          <Toggle checked={prefs.notifyTaskbarFlash} onChange={(v) => updatePref('notifyTaskbarFlash', v)} />
        </div>
      </SettingsSection>

      <div id="setting-advanced-settings-toggle" className="border border-[var(--glass-border)] rounded-2xl overflow-hidden bg-panel">
        <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="w-full p-4 flex items-center justify-between text-left hover:bg-fill-hover transition-colors">
          <div>
            <p className="text-xs font-bold text-t-primary">{t('settings.notifications.advancedSettings')}</p>
            <p className="text-[11px] mt-0.5 text-t-secondary">{showAdvanced ? t('settings.notifications.hideAdvanced') : t('settings.notifications.showAdvanced')}</p>
          </div>
          {showAdvanced ? <ChevronUp size={16} className="text-slate-500 shrink-0" /> : <ChevronDown size={16} className="text-slate-500 shrink-0" />}
        </button>
        {showAdvanced && (
          <div className="px-4 pb-4 space-y-4 border-t border-[var(--glass-border)]">
            <div id="setting-mobile-notification-delay" className="flex items-center justify-between py-3">
              <div>
                <p className="text-xs font-medium text-t-primary">{t('settings.notifications.mobileDelay')}</p>
                <p className="text-[11px] mt-0.5 max-w-sm text-t-secondary">{t('settings.notifications.mobileDelayDesc')}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-lg bg-fill-hover text-t-secondary">{t('settings.notifications.soon')}</span>
                <Dropdown
                  options={[{ value: '10min', label: '10 minutes' }]}
                  value="10min"
                  onChange={() => {}}
                  disabled
                  size="sm"
                />
              </div>
            </div>
            <div id="setting-tts-command" className="flex items-center justify-between py-3 border-t border-[var(--glass-border)]">
              <div>
                <p className="text-xs font-medium text-t-primary">{t('settings.notifications.ttsCommand')}</p>
                <p className="text-[11px] mt-0.5 max-w-sm text-t-secondary">{t('settings.notifications.ttsCommandDesc')}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-lg bg-fill-hover text-t-secondary">{t('settings.notifications.soon')}</span>
                <Toggle checked={false} onChange={() => {}} disabled />
              </div>
            </div>
            <div id="setting-speak-all-messages" className="py-3 border-t border-[var(--glass-border)]">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs font-medium text-t-primary">{t('settings.notifications.speakAllMessages')}</p>
                  <p className="text-[11px] mt-0.5 max-w-sm text-t-secondary">{t('settings.notifications.speakAllMessagesDesc')}</p>
                </div>
                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-lg bg-fill-hover shrink-0 text-t-secondary">{t('settings.notifications.soon')}</span>
              </div>
              <div className="mt-3 space-y-2 pl-2">
                {(['forAllChannels', 'currentChannelOnly', 'never'] as const).map((opt) => (
                  <label key={opt} className="flex items-center gap-2 cursor-not-allowed opacity-40">
                    <input type="radio" name="tts-speak" checked={opt === 'never'} disabled readOnly className="accent-[var(--cyan-accent)]" />
                    <span className="text-[11px] text-t-primary">{t(`settings.notifications.${opt}`)}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default NotificationsTab;
