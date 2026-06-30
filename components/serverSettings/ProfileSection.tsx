// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings, Upload, Check, Users, Zap } from 'lucide-react';
import { Server, ServerSettings } from '../../types';
import { apiClient } from '../../services/api';
import { getBackendOrigin } from '../../config';
import { sanitizeCssUrl } from '../../utils/securityUtils';
import { sanitizeImgSrc } from '../../utils/sanitizeImgSrc';
import { powerUpTier } from '../../utils/powerUpTier';
import { SectionHeader, InputField, SelectField, PrimaryButton } from '../settings/SettingsWidgets';

const BANNER_COLORS = [
  '#1a1a2e', '#16213e', '#0f3460', '#533483', '#e94560',
  '#1b4332', '#2d6a4f', '#774936', '#d62828', '#003049',
];

export interface ProfileSectionProps {
  server: Server;
  memberCount: number;
  serverSettings: ServerSettings | null;
  onUpdateServer?: (server: Server) => void;
  showToast: (message: string, type?: 'success' | 'error') => void;
  saveSettings: (data: Partial<ServerSettings>) => Promise<void>;
}

export const ProfileSection: React.FC<ProfileSectionProps> = ({
  server,
  memberCount,
  serverSettings,
  onUpdateServer,
  showToast,
  saveSettings,
}) => {
  const { t } = useTranslation();

  // Local state
  const [nameDraft, setNameDraft] = useState(server.name);
  const [iconDraft, setIconDraft] = useState(server.icon);
  const serverBannerIsColor = server.banner?.startsWith('#');
  const [bannerDraft, setBannerDraft] = useState<string | undefined>(serverBannerIsColor ? undefined : (server.banner ?? undefined));
  const [bannerColor, setBannerColor] = useState(serverBannerIsColor ? server.banner! : BANNER_COLORS[0]);
  const [iconUploading, setIconUploading] = useState(false);
  const [bannerUploading, setBannerUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [descriptionDraft, setDescriptionDraft] = useState(serverSettings?.description ?? '');
  const [region, setRegion] = useState(serverSettings?.region ?? 'automatic');
  const [availableRegions, setAvailableRegions] = useState<{ id: string; name: string }[]>([]);
  const [saveFeedback, setSaveFeedback] = useState(false);

  // Refs
  const iconFileInputRef = useRef<HTMLInputElement>(null);
  const bannerFileInputRef = useRef<HTMLInputElement>(null);
  const saveFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync description/region when serverSettings loads/changes
  useEffect(() => {
    setDescriptionDraft(serverSettings?.description ?? '');
    setRegion(serverSettings?.region ?? 'automatic');
  }, [serverSettings]);

  // Fetch available LiveKit regions
  useEffect(() => {
    const fetchRegions = async () => {
      try {
        const data = await apiClient.request<{ regions: { id: string; name: string }[] }>('/livekit/regions');
        setAvailableRegions(data.regions ?? []);
      } catch {
        // Silently fail — just show "Automatic" option
      }
    };
    fetchRegions();
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (saveFeedbackTimerRef.current) clearTimeout(saveFeedbackTimerRef.current);
    };
  }, []);

  // Computed
  const serverPowerUpTier = powerUpTier(server.powerUpCount ?? 0);

  // Handlers
  const handleIconUpload = async (file: File) => {
    if (file.size > 50 * 1024 * 1024) { setUploadError(t('serverSettings.fileTooLarge')); return; }
    const allowedTypes = ['image/png', 'image/jpeg', 'image/gif'];
    if (!allowedTypes.includes(file.type)) {
      setUploadError(t('serverSettings.onlyPngJpgGif'));
      return;
    }
    const isAnimated = file.type === 'image/gif';
    if (isAnimated && serverPowerUpTier < 1) {
      setUploadError(t('serverSettings.animatedIconsTier1'));
      return;
    }
    setIconUploading(true); setUploadError(null);
    try {
      const r = await apiClient.uploadFile(file);
      const url = r.url.startsWith('/') ? getBackendOrigin() + r.url : r.url;
      setIconDraft(url);
    } catch (e) { setUploadError(e instanceof Error ? e.message : t('serverSettings.uploadFailed')); }
    setIconUploading(false);
  };

  const handleBannerUpload = async (file: File) => {
    if (file.size > 50 * 1024 * 1024) { setUploadError(t('serverSettings.fileTooLarge')); return; }
    const allowedTypes = ['image/png', 'image/jpeg', 'image/gif'];
    if (!allowedTypes.includes(file.type)) {
      setUploadError(t('serverSettings.onlyPngJpgGif'));
      return;
    }
    if (serverPowerUpTier < 2) {
      setUploadError(t('serverSettings.bannersTier2'));
      return;
    }
    if (file.type === 'image/gif' && serverPowerUpTier < 3) {
      setUploadError(t('serverSettings.animatedBannersTier3'));
      return;
    }
    setBannerUploading(true); setUploadError(null);
    try {
      const r = await apiClient.uploadFile(file);
      const url = r.url.startsWith('/') ? getBackendOrigin() + r.url : r.url;
      setBannerDraft(url);
    } catch (e) { setUploadError(e instanceof Error ? e.message : t('serverSettings.uploadFailed')); }
    setBannerUploading(false);
  };

  const saveProfile = async () => {
    if (!onUpdateServer) return;
    try {
      const updates: Partial<ServerSettings> = {};
      if (descriptionDraft !== (serverSettings?.description ?? '')) updates.description = descriptionDraft;
      if (Object.keys(updates).length > 0) {
        await saveSettings(updates);
      }
      await onUpdateServer({ ...server, name: nameDraft.trim() || server.name, icon: iconDraft, banner: bannerDraft ?? bannerColor });
      setSaveFeedback(true);
      showToast(t('serverSettings.profileSaved'));
      if (saveFeedbackTimerRef.current) clearTimeout(saveFeedbackTimerRef.current);
      saveFeedbackTimerRef.current = setTimeout(() => setSaveFeedback(false), 2000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('serverSettings.failedToSaveProfile');
      showToast(msg, 'error');
      setIconDraft(server.icon);
      const origIsColor = server.banner?.startsWith('#');
      setBannerDraft(origIsColor ? undefined : (server.banner ?? undefined));
      if (origIsColor) setBannerColor(server.banner!);
    }
  };

  // Render
  return (
    <div className="max-w-3xl space-y-6">
      <SectionHeader title={t('serverSettings.overview')} desc={t('serverSettings.overviewDesc')} icon={<Settings size={24} />} />
      <div className="flex gap-8 flex-col lg:flex-row">
        <div className="flex-1 min-w-0 space-y-5">
          <InputField label={t('serverSettings.name')} value={nameDraft} onChange={(e) => setNameDraft((e.target as HTMLInputElement).value)} placeholder={t('serverSettings.yourServerName')} maxLength={100} />
          <div>
            <label className="block text-[11px] font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.description')}</label>
            <textarea value={descriptionDraft} onChange={(e) => setDescriptionDraft(e.target.value)} rows={3} maxLength={1024} placeholder={t('serverSettings.whatIsAbout')}
              className="w-full rounded-xl px-4 py-3 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 resize-none transition-all"
              style={{ backgroundColor: 'var(--bg-app)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
          </div>
          <div>
            <SelectField
              label={t('serverSettings.serverRegion')}
              value={region}
              onChange={(v) => {
                setRegion(v);
                saveSettings({ region: v });
              }}
              options={[
                { value: 'automatic', label: t('serverSettings.automatic') },
                ...availableRegions
                  .filter(r => r.id !== 'default')
                  .map(r => ({ value: r.id, label: r.name })),
              ]}
            />
            <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
              {t('serverSettings.regionDesc')}
            </p>
          </div>
          {/* Frozen asset warnings */}
          {server.icon?.match(/\.gif(\?|$)/i) && serverPowerUpTier < 1 && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg mb-3" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--cyan-accent) 20%, transparent)' }}>
              <Zap size={14} className="text-[var(--cyan-accent)] shrink-0" />
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.gifIconFrozen')}</span>
            </div>
          )}
          {server.banner?.match(/\.gif(\?|$)/i) && serverPowerUpTier >= 2 && serverPowerUpTier < 3 && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg mb-3" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--cyan-accent) 20%, transparent)' }}>
              <Zap size={14} className="text-[var(--cyan-accent)] shrink-0" />
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.gifBannerFrozen')}</span>
            </div>
          )}
          <div>
            <label className="block text-[11px] font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.icon')}</label>
            <div className="flex items-center gap-4">
              <div className="w-20 h-20 rounded-2xl border-2 border-dashed flex items-center justify-center overflow-hidden cursor-pointer hover:border-[var(--cyan-accent)]/50 transition-all group"
                style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-app)' }}
                onClick={() => iconFileInputRef.current?.click()}>
                {iconDraft ? <img src={sanitizeImgSrc(iconDraft)} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" /> :
                  <Upload size={22} className="opacity-30 group-hover:opacity-60 transition-opacity" style={{ color: 'var(--text-secondary)' }} />}
              </div>
              <input ref={iconFileInputRef} type="file" accept={serverPowerUpTier >= 1 ? 'image/png,image/jpeg,image/gif,.png,.jpg,.jpeg,.gif' : 'image/png,image/jpeg,.png,.jpg,.jpeg'} className="hidden" onChange={(e) => { if (e.target.files?.[0]) handleIconUpload(e.target.files[0]); }} />
              <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {iconUploading ? <span className="animate-pulse">{t('serverSettings.uploading')}</span> : serverPowerUpTier >= 1 ? t('serverSettings.clickToUpload') + ' (PNG, JPG, GIF)' : t('serverSettings.clickToUpload') + ' (PNG, JPG)'}
                {serverPowerUpTier < 1 && (
                  <div className="flex items-center gap-1.5 mt-2 px-2.5 py-1.5 rounded-lg border border-[var(--cyan-accent)]/20" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 8%, transparent)' }}>
                    <Zap size={11} className="text-[var(--cyan-accent)] shrink-0" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--cyan-accent)]">{t('serverSettings.tier1GifIcons')}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.banner')}</label>
            <div className="h-28 rounded-xl border-2 border-dashed flex items-center justify-center overflow-hidden cursor-pointer hover:border-[var(--cyan-accent)]/50 transition-all group"
              style={{ borderColor: 'var(--border-subtle)', backgroundColor: bannerDraft ? '#0a0f1a' : bannerColor }}
              onClick={() => bannerFileInputRef.current?.click()}>
              {bannerDraft ? <img src={sanitizeImgSrc(bannerDraft)} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" /> :
                <div className="flex flex-col items-center gap-1">
                  <Upload size={20} className="opacity-40 group-hover:opacity-70 transition-opacity" style={{ color: 'var(--text-secondary)' }} />
                  <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{bannerUploading ? t('serverSettings.uploading') : t('serverSettings.uploadBanner')}</span>
                  {serverPowerUpTier < 2 && (
                    <div className="flex items-center gap-1.5 mt-1 px-2.5 py-1.5 rounded-lg border border-[var(--cyan-accent)]/20" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 8%, transparent)' }}>
                      <Zap size={11} className="text-[var(--cyan-accent)] shrink-0" />
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--cyan-accent)]">{t('serverSettings.tier2Banners')}</span>
                    </div>
                  )}
                  {serverPowerUpTier >= 2 && serverPowerUpTier < 3 && (
                    <div className="flex items-center gap-1.5 mt-1 px-2.5 py-1.5 rounded-lg border border-[var(--cyan-accent)]/20" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 8%, transparent)' }}>
                      <Zap size={11} className="text-[var(--cyan-accent)] shrink-0" />
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--cyan-accent)]">{t('serverSettings.tier3GifBanners')}</span>
                    </div>
                  )}
                </div>}
            </div>
            <input ref={bannerFileInputRef} type="file" accept="image/png,image/jpeg,image/gif,.png,.jpg,.jpeg,.gif" className="hidden" onChange={(e) => { if (e.target.files?.[0]) handleBannerUpload(e.target.files[0]); }} />
            <div className="flex gap-1.5 mt-2">
              {BANNER_COLORS.map((c) => (
                <button key={c} type="button" onClick={() => { setBannerColor(c); setBannerDraft(undefined); }}
                  className={`w-5 h-5 rounded-full border-2 transition-all ${bannerColor === c && !bannerDraft ? 'border-white scale-110' : 'border-transparent hover:scale-105'}`}
                  style={{ backgroundColor: c }} />
              ))}
            </div>
            {bannerDraft && !bannerDraft.startsWith('#') && (
              <button
                type="button"
                onClick={() => setBannerDraft(undefined)}
                className="mt-2 text-xs hover:underline transition-colors"
                style={{ color: 'var(--text-secondary)' }}
              >
                {t('serverSettings.removeBanner', { defaultValue: 'Remove banner' })}
              </button>
            )}
          </div>
          {uploadError && <p className="text-xs text-red-400">{uploadError}</p>}
        </div>
        <div className="w-72 shrink-0">
          <div className="sticky top-0">
            <p className="text-[10px] font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.preview')}</p>
            <div className="rounded-2xl overflow-hidden border" style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-floating)' }}>
              <div className="h-20 relative" style={{ background: bannerDraft && sanitizeCssUrl(bannerDraft) ? `${sanitizeCssUrl(bannerDraft)} center/cover` : bannerColor }}>
                <div className="absolute -bottom-5 left-4">
                  <div className="w-12 h-12 rounded-xl border-[3px] overflow-hidden" style={{ borderColor: 'var(--bg-floating)', backgroundColor: 'var(--bg-app)' }}>
                    {iconDraft ? <img src={sanitizeImgSrc(iconDraft)} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" /> :
                      <div className="w-full h-full flex items-center justify-center text-base font-bold" style={{ color: 'var(--text-secondary)' }}>{(nameDraft || server.name).charAt(0)}</div>}
                  </div>
                </div>
              </div>
              <div className="pt-7 pb-4 px-4">
                <p className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>{nameDraft || server.name}</p>
                {descriptionDraft && <p className="text-[11px] mt-1 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{descriptionDraft}</p>}
                <div className="flex items-center gap-3 mt-3">
                  <span className="text-[10px] flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}><Users size={10} /> {t('serverSettings.members', { count: memberCount })}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <PrimaryButton onClick={saveProfile} loading={false}>
        {saveFeedback ? <><Check size={14} className="inline mr-1" /> {t('serverSettings.saved')}</> : t('serverSettings.saveChanges')}
      </PrimaryButton>
    </div>
  );
};

export default ProfileSection;
