// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlert, Plus, X } from 'lucide-react';
import type { Server, ServerSettings } from '../../types';
import { SectionHeader, Card, SelectField, Toggle, SettingRow } from '../settings/SettingsWidgets';

export interface SafetySectionProps {
  server: Server;
  serverSettings: ServerSettings | null;
  saveSettings: (data: Partial<ServerSettings>) => Promise<void>;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

export const SafetySection: React.FC<SafetySectionProps> = ({ serverSettings, saveSettings }) => {
  const { t } = useTranslation();

  const [verificationLevel, setVerificationLevel] = useState('none');
  const [contentFilter, setContentFilter] = useState('off');
  const [dmSpamFilter, setDmSpamFilter] = useState(false);
  const [blockedNicknames, setBlockedNicknames] = useState<string[]>([]);
  const [blockedNickInput, setBlockedNickInput] = useState('');

  useEffect(() => {
    if (serverSettings) {
      setVerificationLevel(serverSettings.verificationLevel || 'none');
      setContentFilter(serverSettings.contentFilter || 'off');
      setDmSpamFilter(serverSettings.dmSpamFilter ?? false);
      setBlockedNicknames(serverSettings.blockedNicknames ?? []);
    }
  }, [serverSettings]);

  return (
    <div className="max-w-2xl space-y-6">
      <SectionHeader title={t('serverSettings.safety')} desc={t('serverSettings.safetyDesc')} icon={<ShieldAlert size={24} />} />
      <Card>
        <SelectField label={t('serverSettings.memberVerification')} value={verificationLevel}
          onChange={(v) => { setVerificationLevel(v); saveSettings({ verificationLevel: v }); }}
          options={[
            { value: 'none', label: t('serverSettings.verificationOff') },
            { value: 'low', label: t('serverSettings.verificationLow') },
            { value: 'medium', label: t('serverSettings.verificationMedium') },
            { value: 'high', label: t('serverSettings.verificationHigh') },
          ]} />
        <p className="text-[11px] mt-2" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.verificationDesc')}</p>
      </Card>
      <Card>
        <SelectField label={t('serverSettings.mediaScanning')} value={contentFilter}
          onChange={(v) => { setContentFilter(v); saveSettings({ contentFilter: v }); }}
          options={[
            { value: 'off', label: t('serverSettings.mediaScanOff') },
            { value: 'scan_no_roles', label: t('serverSettings.mediaScanNoRoles') },
            { value: 'scan_all', label: t('serverSettings.mediaScanAll') },
          ]} />
        <p className="text-[11px] mt-2" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.mediaScanDesc')}</p>
      </Card>
      <Card>
        <SettingRow title={t('serverSettings.dmProtection')} desc={t('serverSettings.dmProtectionDesc')}>
          <Toggle checked={dmSpamFilter} onChange={(v) => { setDmSpamFilter(v); saveSettings({ dmSpamFilter: v }); }} />
        </SettingRow>
      </Card>

      {/* Blocked Nicknames */}
      <Card>
        <p className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>{t('serverSettings.blockedNicknames')}</p>
        <p className="text-[11px] mb-3" style={{ color: 'var(--text-secondary)' }}>
          {t('serverSettings.blockedNicknamesDesc')}
        </p>
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={blockedNickInput}
            onChange={(e) => setBlockedNickInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && blockedNickInput.trim()) {
                const term = blockedNickInput.trim();
                if (!blockedNicknames.includes(term)) {
                  const updated = [...blockedNicknames, term];
                  setBlockedNicknames(updated);
                  saveSettings({ blockedNicknames: updated });
                }
                setBlockedNickInput('');
              }
            }}
            placeholder={t('serverSettings.blockedNickPlaceholder')}
            maxLength={64}
            className="flex-1 rounded-xl px-3 py-2 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all"
            style={{ backgroundColor: 'var(--bg-app)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
          />
          <button
            type="button"
            disabled={!blockedNickInput.trim()}
            onClick={() => {
              const term = blockedNickInput.trim();
              if (term && !blockedNicknames.includes(term)) {
                const updated = [...blockedNicknames, term];
                setBlockedNicknames(updated);
                saveSettings({ blockedNicknames: updated });
              }
              setBlockedNickInput('');
            }}
            className="px-4 py-2 rounded-xl bg-[var(--cyan-accent)] hover:bg-[var(--cyan-accent)] text-black disabled:opacity-40 transition-all"
          >
            <Plus size={14} />
          </button>
        </div>
        {blockedNicknames.length === 0 ? (
          <p className="text-[11px] py-4 text-center" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.noBlockedTerms')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {blockedNicknames.map((term) => (
              <span key={term} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border" style={{ backgroundColor: 'var(--bg-app)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
                {term}
                <button
                  type="button"
                  onClick={() => {
                    const updated = blockedNicknames.filter((t) => t !== term);
                    setBlockedNicknames(updated);
                    saveSettings({ blockedNicknames: updated });
                  }}
                  className="hover:text-red-400 transition-colors"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};

export default SafetySection;
