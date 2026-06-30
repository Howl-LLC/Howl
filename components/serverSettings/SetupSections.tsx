// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Megaphone, UserPlus, Lock, Mail, Globe, Plus, Trash2 } from 'lucide-react';
import { Server, ServerSettings } from '../../types';
import { apiClient } from '../../services/api';
import { SectionHeader, Card, Toggle, SettingRow, SelectField } from '../settings/SettingsWidgets';

interface SetupSectionProps {
  server: Server;
  serverSettings: ServerSettings | null;
  saveSettings: (data: Partial<ServerSettings>) => Promise<void>;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

// EngagementSection

export const EngagementSection: React.FC<SetupSectionProps> = ({
  server,
  serverSettings,
  saveSettings,
}) => {
  const { t } = useTranslation();

  const [defaultNotifications, setDefaultNotifications] = useState('all');
  const [welcomeEnabled, setWelcomeEnabled] = useState(false);
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [welcomeChannelId, setWelcomeChannelId] = useState('');
  const [onboardingEnabled, setOnboardingEnabled] = useState(false);
  const [hasPicker, setHasPicker] = useState<boolean | null>(null);

  useEffect(() => {
    if (serverSettings) {
      setDefaultNotifications(serverSettings.defaultNotifications);
      setWelcomeEnabled(serverSettings.welcomeEnabled);
      setWelcomeMessage(serverSettings.welcomeMessage ?? '');
      setWelcomeChannelId(serverSettings.welcomeChannelId ?? '');
      setOnboardingEnabled(serverSettings.onboardingEnabled ?? false);
    }
  }, [serverSettings]);

  // Onboarding requires a role picker; detect it best-effort so the toggle can
  // explain why it's disabled when no picker exists yet.
  useEffect(() => {
    let cancelled = false;
    apiClient.rolePickersList(server.id)
      .then((r) => { if (!cancelled) setHasPicker(!!r.picker); })
      .catch(() => { if (!cancelled) setHasPicker(false); });
    return () => { cancelled = true; };
  }, [server.id]);

  // Text channels are the only valid destinations for the welcome message.
  const textChannels = (server.channels ?? []).filter((c) => c.type === 'text');

  return (
    <div className="max-w-2xl space-y-6">
      <SectionHeader title={t('serverSettings.alerts')} desc={t('serverSettings.alertsDesc')} icon={<Megaphone size={24} />} />
      <Card>
        <SelectField label={t('serverSettings.defaultAlertLevel')} value={defaultNotifications}
          onChange={(v) => { setDefaultNotifications(v); saveSettings({ defaultNotifications: v }); }}
          options={[{ value: 'all', label: t('serverSettings.everyMessage') }, { value: 'mentions_only', label: t('serverSettings.onlyWhenMentioned') }]} />
        <p className="text-[11px] mt-2" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.defaultAlertDesc')}</p>
      </Card>
      <Card>
        <SettingRow title={t('serverSettings.greeting')} desc={t('serverSettings.greetingDesc')}>
          <Toggle checked={welcomeEnabled} onChange={(v) => { setWelcomeEnabled(v); saveSettings({ welcomeEnabled: v }); }} />
        </SettingRow>
        {welcomeEnabled && (
          <>
            <textarea value={welcomeMessage} onChange={(e) => setWelcomeMessage(e.target.value)} rows={3} maxLength={2000} placeholder={t('serverSettings.welcomePlaceholder')}
              onBlur={() => saveSettings({ welcomeMessage })}
              className="w-full rounded-xl px-4 py-3 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 resize-none mt-3 transition-all"
              style={{ backgroundColor: 'var(--bg-app)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
            <p className="text-[11px] mt-2" style={{ color: 'var(--text-secondary)' }}>
              {t('serverSettings.welcomeTokensHint', { defaultValue: "Tip: {user} is replaced with the new member's name and {server} with your server name when the message is posted." })}
            </p>
            <div className="mt-3">
              <SelectField
                label={t('serverSettings.welcomeChannel', { defaultValue: 'Welcome channel' })}
                value={welcomeChannelId}
                onChange={(v) => { setWelcomeChannelId(v); saveSettings({ welcomeChannelId: v || null }); }}
                options={[
                  { value: '', label: t('serverSettings.welcomeChannelDefault', { defaultValue: 'Default: first text channel' }) },
                  ...textChannels.map((c) => ({ value: c.id, label: `# ${c.name}` })),
                ]}
              />
            </div>
          </>
        )}
      </Card>
      <Card>
        <SettingRow title={t('serverSettings.onboarding', { defaultValue: 'Onboarding' })} desc={t('serverSettings.onboardingDesc', { defaultValue: 'Walk new members through your role picker before they can browse the server.' })}>
          <Toggle checked={onboardingEnabled} disabled={hasPicker === false} onChange={(v) => { setOnboardingEnabled(v); saveSettings({ onboardingEnabled: v }); }} />
        </SettingRow>
        {hasPicker === false && (
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {t('serverSettings.onboardingNoPicker', { defaultValue: 'Create a role picker first (Self Roles tab) to enable onboarding.' })}
          </p>
        )}
      </Card>
    </div>
  );
};

// AccessSection

type JoinMethod = 'invite_only' | 'apply_to_join' | 'discoverable';

export const AccessSection: React.FC<SetupSectionProps> = ({
  serverSettings,
  saveSettings,
}) => {
  const { t } = useTranslation();

  const [joinMethod, setJoinMethod] = useState<JoinMethod>('invite_only');
  const [serverRulesEnabled, setServerRulesEnabled] = useState(false);
  const [rules, setRules] = useState<string[]>([]);
  const [ruleDraft, setRuleDraft] = useState('');

  const EXAMPLE_RULES = [t('serverSettings.exampleRule1'), t('serverSettings.exampleRule2'), t('serverSettings.exampleRule3'), t('serverSettings.exampleRule4')];

  useEffect(() => {
    if (serverSettings) {
      setJoinMethod(serverSettings.joinMethod as JoinMethod);
      setRules(Array.isArray(serverSettings.rules) ? serverSettings.rules : []);
      setServerRulesEnabled(Array.isArray(serverSettings.rules) && serverSettings.rules.length > 0);
    }
  }, [serverSettings]);

  // Open Door is gated on the server already being publicly listed on
  // Discover. Mirrors the backend `open_door_requires_discovery` 422 in
  // serverSettings.ts so owners can't pick a tile that the server would reject.
  const openDoorAvailable = !!(serverSettings?.communityEnabled && serverSettings?.discoveryEnabled);

  return (
    <div className="max-w-2xl space-y-6">
      <SectionHeader title={t('serverSettings.entryRules')} desc={t('serverSettings.entryRulesDesc')} icon={<UserPlus size={24} />} />
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.howPeopleGetIn')}</p>
        <div className="grid grid-cols-3 gap-3">
          {([
            { id: 'invite_only' as JoinMethod, icon: <Lock size={20} />, label: t('serverSettings.inviteOnly'), desc: t('serverSettings.inviteOnlyDesc'), disabled: false },
            { id: 'apply_to_join' as JoinMethod, icon: <Mail size={20} />, label: t('serverSettings.application'), desc: t('serverSettings.applicationDesc'), disabled: false },
            { id: 'discoverable' as JoinMethod, icon: <Globe size={20} />, label: t('serverSettings.openDoor'), desc: t('serverSettings.openDoorDesc'), disabled: !openDoorAvailable },
          ] as const).map((opt) => (
            <button key={opt.id} type="button"
              disabled={opt.disabled}
              title={opt.disabled ? t('serverSettings.openDoorRequiresDiscovery', 'Available once your server is on Discover. Enable Community Mode and Discovery first.') : undefined}
              onClick={() => { if (opt.disabled) return; setJoinMethod(opt.id); saveSettings({ joinMethod: opt.id }); }}
              className="flex flex-col items-center gap-2 p-4 rounded-2xl border text-center transition-all hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
              style={{ backgroundColor: joinMethod === opt.id ? 'var(--cta-bg, #02385A)' : 'var(--bg-app)', borderColor: joinMethod === opt.id ? 'var(--cta-bg, #02385A)' : 'var(--border-subtle)' }}>
              <span style={{ color: joinMethod === opt.id ? '#fff' : 'var(--text-secondary)' }}>{opt.icon}</span>
              <span className="font-semibold text-[13px]" style={{ color: joinMethod === opt.id ? '#fff' : 'var(--text-primary)' }}>{opt.label}</span>
              <span className="text-[10px]" style={{ color: joinMethod === opt.id ? 'rgba(255,255,255,0.75)' : 'var(--text-secondary)' }}>{opt.desc}</span>
            </button>
          ))}
        </div>
        {!openDoorAvailable && (
          <p className="text-[11px] mt-2" style={{ color: 'var(--text-tertiary)' }}>
            {t('serverSettings.openDoorRequiresDiscoveryHint', 'Open Door requires your server to be listed on Discover. Enable Community Mode and Discovery in Setup → Engagement first.')}
          </p>
        )}
      </div>
      <Card>
        <SettingRow title={t('serverSettings.houseRules')} desc={t('serverSettings.houseRulesDesc')}>
          <Toggle checked={serverRulesEnabled} onChange={setServerRulesEnabled} />
        </SettingRow>
        {serverRulesEnabled && (
          <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="flex gap-2 mb-3">
              <input value={ruleDraft} onChange={(e) => setRuleDraft(e.target.value)} maxLength={500} placeholder={t('serverSettings.typeRulePlaceholder')}
                onKeyDown={(e) => { if (e.key === 'Enter' && ruleDraft.trim()) { const next = [...rules, ruleDraft.trim()]; setRules(next); setRuleDraft(''); saveSettings({ rules: next }); } }}
                className="flex-1 rounded-xl px-4 py-2.5 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all"
                style={{ backgroundColor: 'var(--bg-app)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
              <button type="button" onClick={() => { if (ruleDraft.trim()) { const next = [...rules, ruleDraft.trim()]; setRules(next); setRuleDraft(''); saveSettings({ rules: next }); } }}
                className="p-2.5 rounded-xl hover:bg-fill-active transition-all" style={{ color: 'var(--text-secondary)' }}><Plus size={16} /></button>
            </div>
            {rules.length > 0 && (
              <div className="space-y-1 mb-4">
                {rules.map((rule, i) => (
                  <div key={i} className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-fill-hover group transition-all">
                    <span className="text-[10px] font-mono w-5 text-right font-bold" style={{ color: 'var(--cyan-accent)', opacity: 0.5 }}>{i + 1}</span>
                    <span className="flex-1 text-sm" style={{ color: 'var(--text-primary)' }}>{rule}</span>
                    <button type="button" onClick={() => { const next = rules.filter((_, j) => j !== i); setRules(next); saveSettings({ rules: next }); }}
                      className="p-1 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-red-500/20 transition-all" style={{ color: 'var(--text-secondary)' }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.suggestions')}</p>
            <div className="flex flex-wrap gap-2">
              {EXAMPLE_RULES.filter((rule) => !rules.includes(rule)).map((text) => (
                <button key={text} type="button" onClick={() => { const next = [...rules, text]; setRules(next); saveSettings({ rules: next }); }}
                  className="px-3 py-1.5 rounded-xl text-[10px] border hover:bg-fill-hover transition-all"
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)', backgroundColor: 'var(--bg-app)' }}>
                  + {text}
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
};

export default EngagementSection;
