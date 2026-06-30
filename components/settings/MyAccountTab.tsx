// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { User, Server, formatUsername } from '../../types';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import {
  Camera, X, Lock, Smartphone, Key, ChevronDown, Crown, MessageSquare, KeyRound, Move,
} from 'lucide-react';
import { apiClient, type MfaStatus } from '../../services/api';
import { LetterAvatar } from '../LetterAvatar';
import { ColorPicker } from '../ColorPicker';
import { getPlanPerks, NAME_FONTS, AVATAR_EFFECTS, NAME_EFFECTS, getAvatarEffectClass, type PlanTier } from '../../shared/planPerks';
import { RoleNameStyle } from '../RoleNameStyle';
import { containsProfanity } from '../../utils/profanityFilter';
import { sanitizeCssUrl } from '../../utils/securityUtils';
import { Dropdown } from '../ui/dropdown';
import * as dmKeyManager from '../../services/dmKeyManager';

export interface MyAccountTabProps {
  user: User;
  onUserUpdate?: (user: User) => void;
  onLogout?: (keepEncryptionKeys?: boolean) => void;
  servers: Server[];
  subscription: { plan: string | null; status: string | null; currentPeriodEnd: string | null } | null;
  initialSubTab?: string;
  initialProfileServerId?: string;
  showToast?: (message: string, type?: 'info' | 'warning') => void;
}

type MyAccountSubTab = 'security' | 'profiles';

function SettingsRow({ label, value, masked, onEdit }: { label: string; value: string; masked?: boolean; onEdit?: () => void }) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  const display = masked && !revealed ? value.replace(/./g, '\u2022') : value;

  return (
    <div
      className={`flex items-center justify-between py-3.5 px-5 border-b border-default last:border-b-0 group rounded-lg transition-all ${onEdit ? 'cursor-pointer hover:bg-fill-hover' : ''}`}
      onClick={onEdit}
    >
      <div className="min-w-0 flex items-center gap-3">
        <span className="text-[11px] font-medium text-t-secondary uppercase w-24 shrink-0">{label}</span>
        <span className="text-sm font-medium truncate text-t-primary">
          {display}
          {masked && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setRevealed(!revealed); }}
              className="ml-2 text-[var(--cyan-accent)] text-[10px] font-bold uppercase hover:underline"
            >
              {revealed ? t('common.hide') : t('common.show')}
            </button>
          )}
        </span>
      </div>
      {onEdit && (
        <span className="shrink-0 ml-3 text-[10px] font-semibold text-[var(--cyan-accent)] opacity-60 group-hover:opacity-100 transition-opacity">
          {t('common.edit')}
        </span>
      )}
    </div>
  );
}

const MyAccountTab: React.FC<MyAccountTabProps> = ({
  user,
  onUserUpdate,
  onLogout,
  servers,
  subscription,
  initialSubTab,
  initialProfileServerId,
  showToast: showToastProp,
}) => {
  const { t } = useTranslation();

  // Use the wired-in global toast if available, otherwise no-op fallback
  const showToast = showToastProp ?? ((_msg: string, _type?: string) => { /* no-op fallback */ });

  // Sub-tab navigation
  const [myAccountSubTab, setMyAccountSubTab] = useState<MyAccountSubTab>((initialSubTab as MyAccountSubTab) || 'security');

  // Server Profiles tab
  const [profileServerId, setProfileServerId] = useState<string>(initialProfileServerId || '');
  const [profileNickname, setProfileNickname] = useState('');
  const [profileAvatar, setProfileAvatar] = useState<string | null>(null);
  const [profileBanner, setProfileBanner] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null);
  const profileSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const profileAvatarInputRef = useRef<HTMLInputElement>(null);
  const profileBannerInputRef = useRef<HTMLInputElement>(null);

  // Account security (password / email / deletion)
  const [secCurrentPassword, setSecCurrentPassword] = useState('');
  const [secNewPassword, setSecNewPassword] = useState('');
  const [secConfirmPassword, setSecConfirmPassword] = useState('');
  const [secNewEmail, setSecNewEmail] = useState('');
  const [secEmailPassword, setSecEmailPassword] = useState('');
  const [secMfaCode, setSecMfaCode] = useState('');
  const [secDeletePassword, setSecDeletePassword] = useState('');
  const [secError, setSecError] = useState<string | null>(null);
  const [secSuccess, setSecSuccess] = useState<string | null>(null);
  const [secSaving, setSecSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showDeactivateConfirm, setShowDeactivateConfirm] = useState(false);
  const [deactivatePassword, setDeactivatePassword] = useState('');

  // MFA state
  const [mfaStatus, setMfaStatus] = useState<MfaStatus | null>(null);
  const [mfaSetupMode, setMfaSetupMode] = useState<'none' | 'totp' | 'passkey' | 'phone'>('none');
  const [mfaTotpData, setMfaTotpData] = useState<{ secret: string; qrCodeUrl: string; setupToken: string } | null>(null);
  const [mfaTotpCode, setMfaTotpCode] = useState('');
  const [passkeyName, setPasskeyName] = useState('');
  const [mfaPhoneNumber, setMfaPhoneNumber] = useState('');
  const [mfaPhoneCode, setMfaPhoneCode] = useState('');
  const [mfaPhoneStep, setMfaPhoneStep] = useState<'number' | 'verify'>('number');
  const [_mfaDisablePassword, _setMfaDisablePassword] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [showRecoveryCodes, setShowRecoveryCodes] = useState(false);
  const [recoveryPasswordPrompt, setRecoveryPasswordPrompt] = useState(false);
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [mfaLoading, setMfaLoading] = useState(false);
  const [passkeysExpanded, setPasskeysExpanded] = useState(false);
  const [passkeyToDelete, setPasskeyToDelete] = useState<{ id: string; name: string } | null>(null);
  const [passkeyDeleting, setPasskeyDeleting] = useState(false);
  const [passkeyDeletePassword, setPasskeyDeletePassword] = useState('');
  const [mfaRemoveTarget, setMfaRemoveTarget] = useState<'totp' | 'phone' | null>(null);
  const [mfaRemovePassword, setMfaRemovePassword] = useState('');
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaSuccess, setMfaSuccess] = useState<string | null>(null);
  // showChangeEmail removed — now handled by editingField === 'email'
  const [showChangePassword, setShowChangePassword] = useState(false);

  // Pro Customization
  const [proNameColor, setProNameColor] = useState(user.nameColor || '');
  const [proNameFont, setProNameFont] = useState(() => {
    const font = user.nameFont || 'default';
    return font === 'cursive' ? 'handwritten' : font === 'impact' ? 'default' : font;
  });
  const [proNameEffect, setProNameEffect] = useState(user.nameEffect || 'none');
  const [proAvatarEffect, setProAvatarEffect] = useState(user.avatarEffect || 'none');

  // Inline field editing (username)
  const [editingField, setEditingField] = useState<'username' | 'email' | null>(null);
  const [fieldDraft, setFieldDraft] = useState('');
  const [discDraft, setDiscDraft] = useState('');
  const [savingField, setSavingField] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Banner / Avatar upload (security subtab profile card)
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [editingBio, setEditingBio] = useState(false);
  const [bioDraft, setBioDraft] = useState('');
  const [bioSaving, setBioSaving] = useState(false);
  const bannerInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [bannerEditMode, setBannerEditMode] = useState(false);
  const [bannerDragY, setBannerDragY] = useState(user.bannerPositionY ?? 50);
  const [bannerZoom, setBannerZoom] = useState(user.bannerZoom ?? 100);
  const bannerDragStartRef = useRef<{ startY: number; startPos: number } | null>(null);
  const [bannerPosSaving, setBannerPosSaving] = useState(false);

  // Cleanup success timer
  useEffect(() => {
    return () => {
      if (profileSuccessTimerRef.current) clearTimeout(profileSuccessTimerRef.current);
    };
  }, []);

  // Auto-select first server for profiles
  useEffect(() => {
    if (servers.length > 0 && !profileServerId) {
      setProfileServerId(servers[0].id);
    }
  }, [servers, profileServerId]);

  // Load server profile when selection changes
  const loadServerProfile = useCallback(async (serverId: string) => {
    if (!serverId) return;
    setProfileLoading(true);
    setProfileError(null);
    try {
      const data = await apiClient.getMyServerProfile(serverId);
      setProfileNickname(data.nickname ?? '');
      setProfileAvatar(data.serverAvatar);
      setProfileBanner(data.serverBanner);
    } catch (e: unknown) {
      setProfileNickname('');
      setProfileAvatar(null);
      setProfileBanner(null);
      const msg = e instanceof Error ? e.message : String(e);
      if (msg && !/not a member/i.test(msg)) {
        setProfileError(msg);
      }
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    if (profileServerId) loadServerProfile(profileServerId);
  }, [profileServerId, loadServerProfile]);

  const [mfaLoadError, setMfaLoadError] = useState<string | null>(null);

  // Fetch MFA status when security subtab is active
  useEffect(() => {
    if (myAccountSubTab === 'security') {
      setMfaLoadError(null);
      apiClient.mfaStatus().then(setMfaStatus).catch(() => setMfaLoadError(t('settings.account.failedToLoadMfa')));
    }
  }, [myAccountSubTab]);

  // Electron: listen for passkey registration result from deep link callback
  useEffect(() => {
    if (!(window as any).electron?.onSsoSettingsCallback) return;
    const cleanup = (window as any).electron.onSsoSettingsCallback((data: Record<string, string>) => {
      if (data.passkey_registered) {
        setMfaSuccess(t('settings.account.passkeyRegistered'));
        setMfaSetupMode('none');
        apiClient.mfaStatus().then(setMfaStatus).catch(() => {});
        if (onUserUpdate && user) onUserUpdate({ ...user, mfaEnabled: true });
      }
    });
    return cleanup;
  }, [t, user, onUserUpdate]);

  // Callbacks

  const handleProfileSave = useCallback(async () => {
    if (!profileServerId) return;
    setProfileSaving(true);
    setProfileError(null);
    setProfileSuccess(null);
    try {
      const data: { nickname?: string | null; serverAvatar?: string | null; serverBanner?: string | null } = {};
      data.nickname = profileNickname.trim() || null;
      if (data.nickname && containsProfanity(data.nickname)) {
        setProfileError(t('settings.account.nicknameProfanity'));
        setProfileSaving(false);
        return;
      }
      data.serverAvatar = profileAvatar;
      data.serverBanner = profileBanner;
      const result = await apiClient.updateMyServerProfile(profileServerId, data);
      setProfileNickname(result.nickname ?? '');
      setProfileAvatar(result.serverAvatar);
      setProfileBanner(result.serverBanner);
      setProfileSuccess(t('settings.serverProfileUpdated'));
      if (profileSuccessTimerRef.current) clearTimeout(profileSuccessTimerRef.current);
      profileSuccessTimerRef.current = setTimeout(() => setProfileSuccess(null), 3000);
    } catch (e: unknown) {
      setProfileError(e instanceof Error ? e.message : t('settings.account.failedToSave'));
    } finally {
      setProfileSaving(false);
    }
  }, [profileServerId, profileNickname, profileAvatar, profileBanner]);

  const handleProfileReset = useCallback(async () => {
    if (!profileServerId) return;
    setProfileSaving(true);
    setProfileError(null);
    try {
      await apiClient.updateMyServerProfile(profileServerId, { nickname: null, serverAvatar: null, serverBanner: null });
      setProfileNickname('');
      setProfileAvatar(null);
      setProfileBanner(null);
      setProfileSuccess(t('settings.serverProfileReset'));
      if (profileSuccessTimerRef.current) clearTimeout(profileSuccessTimerRef.current);
      profileSuccessTimerRef.current = setTimeout(() => setProfileSuccess(null), 3000);
    } catch (e: unknown) {
      setProfileError(e instanceof Error ? e.message : t('settings.account.failedToReset'));
    } finally {
      setProfileSaving(false);
    }
  }, [profileServerId]);

  const handleProfileAvatarUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB
    if (file.size > MAX_UPLOAD_SIZE) { showToast(t('toast.fileTooLarge'), 'warning'); return; }
    const allowedTypes = ['image/png', 'image/jpeg', 'image/gif'];
    if (!allowedTypes.includes(file.type)) { setProfileError(t('settings.account.onlyPngJpgGif')); return; }
    try {
      const res = await apiClient.uploadFile(file);
      setProfileAvatar(res.url);
    } catch (err: unknown) {
      setProfileError(err instanceof Error ? err.message : t('settings.account.uploadFailed'));
    }
  }, [t, showToast]);

  const handleProfileBannerUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB
    if (file.size > MAX_UPLOAD_SIZE) { showToast(t('toast.fileTooLarge'), 'warning'); return; }
    const allowedTypes = ['image/png', 'image/jpeg', 'image/gif'];
    if (!allowedTypes.includes(file.type)) { setProfileError(t('settings.account.onlyPngJpgGif')); return; }
    try {
      const res = await apiClient.uploadFile(file);
      setProfileBanner(res.url);
    } catch (err: unknown) {
      setProfileError(err instanceof Error ? err.message : t('settings.account.uploadFailed'));
    }
  }, [t, showToast]);

  const handleBannerUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB
    if (file.size > MAX_UPLOAD_SIZE) { showToast(t('toast.fileTooLarge'), 'warning'); return; }
    const allowedTypes = ['image/png', 'image/jpeg', 'image/gif'];
    if (!allowedTypes.includes(file.type)) { setUploadError(t('settings.account.onlyPngJpgGif')); return; }
    setUploadError(null);
    setUploadingBanner(true);
    try {
      const { url } = await apiClient.uploadFile(file);
      const updated = await apiClient.updateMeProfile({ banner: url });
      onUserUpdate?.(updated);
      setBannerDragY(50);
      setBannerEditMode(true);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : t('settings.account.failedToUpdateBanner'));
    } finally { setUploadingBanner(false); }
  };

  useEffect(() => {
    if (!bannerEditMode) {
      setBannerDragY(user.bannerPositionY ?? 50);
      setBannerZoom(user.bannerZoom ?? 100);
    }
  }, [user.bannerPositionY, user.bannerZoom, bannerEditMode]);

  const handleBannerDragStart = useCallback((e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('input')) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    bannerDragStartRef.current = { startY: e.clientY, startPos: bannerDragY };
  }, [bannerDragY]);

  const handleBannerDragMove = useCallback((e: React.PointerEvent) => {
    if (!bannerDragStartRef.current) return;
    const el = e.currentTarget as HTMLElement;
    const containerHeight = el.getBoundingClientRect().height;
    const deltaPixels = e.clientY - bannerDragStartRef.current.startY;
    const deltaPercent = (deltaPixels / containerHeight) * 50;
    const newPos = Math.max(0, Math.min(100, bannerDragStartRef.current.startPos - deltaPercent));
    setBannerDragY(Math.round(newPos));
  }, []);

  const handleBannerDragEnd = useCallback(() => {
    bannerDragStartRef.current = null;
  }, []);

  const handleBannerPosSave = useCallback(async () => {
    setBannerPosSaving(true);
    try {
      const updated = await apiClient.updateMeProfile({ bannerPositionY: bannerDragY, bannerZoom });
      onUserUpdate?.(updated);
      setBannerEditMode(false);
    } catch (err) {
      console.error('Failed to save banner position', err);
    }
    setBannerPosSaving(false);
  }, [bannerDragY, bannerZoom, onUserUpdate]);

  const handleBannerPosCancel = useCallback(() => {
    setBannerDragY(user.bannerPositionY ?? 50);
    setBannerZoom(user.bannerZoom ?? 100);
    setBannerEditMode(false);
  }, [user.bannerPositionY, user.bannerZoom]);

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB
    if (file.size > MAX_UPLOAD_SIZE) { showToast(t('toast.fileTooLarge'), 'warning'); return; }
    const allowedTypes = ['image/png', 'image/jpeg', 'image/gif'];
    if (!allowedTypes.includes(file.type)) { setUploadError(t('settings.account.onlyPngJpgGif')); return; }
    setUploadError(null);
    setUploadingAvatar(true);
    try {
      const { url } = await apiClient.uploadFile(file);
      const updated = await apiClient.updateMeProfile({ avatar: url });
      onUserUpdate?.(updated);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : t('settings.account.failedToUpdateAvatar'));
    } finally { setUploadingAvatar(false); }
  };

  const startEditField = (field: 'username') => {
    setEditingField(field);
    setFieldDraft(user.username);
    setDiscDraft(user.discriminator || '');
    setFieldError(null);
  };

  const startEditEmail = () => {
    setEditingField('email');
    setSecNewEmail('');
    setSecEmailPassword('');
    setSecError(null);
    setSecSuccess(null);
  };

  const saveBio = async () => {
    setBioSaving(true);
    try {
      const value = bioDraft.trim() || null;
      const updated = await apiClient.updateMeProfile({ activityBio: value });
      onUserUpdate?.(updated);
      setEditingBio(false);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('toast.failedToSave', { defaultValue: 'Failed to save' }), 'warning');
    }
    setBioSaving(false);
  };

  const saveField = async () => {
    const name = fieldDraft.trim();
    if (name.length < 2 || name.length > 32) { setFieldError(t('settings.mustBe232Chars')); return; }
    const canChangeDisc = getPlanPerks((subscription?.plan ?? null) as PlanTier).canChangeDiscriminator;
    const discChanged = canChangeDisc && discDraft !== (user.discriminator || '');
    if (discChanged && !/^\d{4}$/.test(discDraft)) { setFieldError(t('settings.discriminatorMustBe4Digits')); return; }
    setSavingField(true);
    setFieldError(null);
    try {
      const usernameChanged = name !== user.username;
      let updated = user;
      if (usernameChanged) {
        updated = await apiClient.updateMeProfile({ username: name });
        onUserUpdate?.(updated);
      }
      if (discChanged) {
        const res = await apiClient.changeDiscriminator(discDraft);
        if (res.changed) {
          updated = { ...updated, discriminator: res.discriminator };
          onUserUpdate?.(updated);
        } else if (res.error) {
          setFieldError(res.error);
          setSavingField(false);
          return;
        }
      }
      setEditingField(null);
    } catch (e) {
      setFieldError(e instanceof Error ? e.message : t('settings.account.failedToSave'));
    } finally { setSavingField(false); }
  };

  const cancelEdit = () => { setEditingField(null); setFieldDraft(''); setDiscDraft(''); setFieldError(null); setSecNewEmail(''); setSecEmailPassword(''); setSecError(null); setSecSuccess(null); };

  // Pro Customization auto-save: 600ms debounced, silent (no UI indicator).
  // Skip when draft state matches persisted user state (avoids redundant PATCH on mount/tab focus).
  useEffect(() => {
    const persistedColor = user.nameColor ?? '';
    const persistedFont = user.nameFont ?? 'default';
    const persistedEffect = user.nameEffect ?? 'none';
    const persistedAvatar = user.avatarEffect ?? 'none';
    if (
      proNameColor === persistedColor &&
      proNameFont === persistedFont &&
      proNameEffect === persistedEffect &&
      proAvatarEffect === persistedAvatar
    ) return;

    const timer = setTimeout(async () => {
      const nextFields = {
        nameColor: proNameColor || null,
        nameFont: proNameFont === 'default' ? null : proNameFont,
        nameEffect: proNameEffect === 'none' ? null : proNameEffect,
        avatarEffect: proAvatarEffect === 'none' ? null : proAvatarEffect,
      };
      try {
        await apiClient.updateMeProfile(nextFields);
        onUserUpdate?.({ ...user, ...nextFields });
      } catch {
        // Silent — next change re-attempts. Local state preserves the user's draft selections.
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [proNameColor, proNameFont, proNameEffect, proAvatarEffect, user, onUserUpdate]);

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-4 text-t-primary">{t('settings.myAccount')}</h2>

      {/* Security | Standing tabs */}
      <div className="flex gap-1 border-b border-[var(--glass-border)] mb-6">
        <button
          type="button"
          onClick={() => setMyAccountSubTab('security')}
          className={`px-4 py-2.5 text-[11px] font-semibold border-b-2 transition-colors -mb-px ${myAccountSubTab === 'security' ? 'text-[var(--cyan-accent)] border-[var(--cyan-accent)]' : 'text-slate-500 border-transparent hover:text-slate-300'}`}
        >
          {t('settings.security')}
        </button>
        <button
          type="button"
          onClick={() => setMyAccountSubTab('profiles')}
          className={`px-4 py-2.5 text-[11px] font-semibold border-b-2 transition-colors -mb-px ${myAccountSubTab === 'profiles' ? 'text-[var(--cyan-accent)] border-[var(--cyan-accent)]' : 'text-slate-500 border-transparent hover:text-slate-300'}`}
        >
          {t('settings.profiles')}
        </button>
      </div>

      {myAccountSubTab === 'profiles' && (
        <div className="space-y-6">
          {servers.length === 0 ? (
            <div className="border border-[var(--glass-border)] rounded-2xl p-12 text-center bg-panel">
              <p className="text-sm font-medium mb-1 text-t-primary">{t('settings.noServers')}</p>
              <p className="text-xs max-w-sm mx-auto text-t-secondary">{t('settings.joinServerToCustomize')}</p>
            </div>
          ) : (
            <>
              {/* Server selector */}
              <div id="setting-server-profile-selector" className="flex items-center gap-3">
                <label className="text-xs font-bold uppercase tracking-wider shrink-0 text-t-secondary">{t('settings.account.server')}</label>
                <div className="flex-1">
                  <Dropdown
                    options={servers.map(s => ({ value: s.id, label: s.name }))}
                    value={profileServerId}
                    onChange={(v) => { setProfileServerId(v); setProfileError(null); setProfileSuccess(null); }}
                    size="md"
                    className="w-full"
                  />
                </div>
              </div>

              {profileLoading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="w-6 h-6 border-2 border-[var(--cyan-accent)] border-t-transparent rounded-full animate-spin" />
                </div>
              ) : (
                <>
                  {/* Preview card */}
                  <div className="border border-[var(--glass-border)] rounded-2xl overflow-hidden bg-panel">
                    {/* Banner */}
                    <div
                      id="setting-server-profile-banner"
                      className="h-28 relative group cursor-pointer"
                      onClick={() => profileBannerInputRef.current?.click()}
                      style={{
                        background: profileBanner
                          ? `url(${profileBanner}) center/cover no-repeat`
                          : user.banner && sanitizeCssUrl(user.banner)
                            ? `${sanitizeCssUrl(user.banner)} center/cover no-repeat`
                            : 'linear-gradient(135deg, color-mix(in srgb, var(--cyan-accent) 15%, transparent) 0%, rgba(139,92,246,0.15) 100%)',
                      }}
                    >
                      <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-colors">
                        <Camera size={22} className="opacity-0 group-hover:opacity-80 transition-opacity" style={{ color: 'white' }} />
                      </div>
                      {profileBanner && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setProfileBanner(null); }}
                          className="absolute top-2 right-2 p-1 rounded-full bg-black/60 hover:bg-black/80 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X size={12} style={{ color: 'white' }} />
                        </button>
                      )}
                    </div>
                    <input ref={profileBannerInputRef} type="file" accept="image/png,image/jpeg,image/gif,.png,.jpg,.jpeg,.gif" className="hidden" onChange={handleProfileBannerUpload} />

                    {/* Avatar + info */}
                    <div className="px-5 pb-5 -mt-10 relative">
                      <div
                        id="setting-server-profile-avatar"
                        className="w-20 h-20 rounded-[var(--radius-lg)] border-4 relative group cursor-pointer overflow-hidden"
                        style={{ borderColor: 'var(--bg-panel)' }}
                        onClick={() => profileAvatarInputRef.current?.click()}
                      >
                        <LetterAvatar
                          avatar={profileAvatar ?? user.avatar}
                          username={profileNickname || user.username}
                          size={80}
                          className="rounded-full"
                        />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-colors rounded-[var(--radius-lg)]">
                          <Camera size={18} className="opacity-0 group-hover:opacity-80 transition-opacity" style={{ color: 'white' }} />
                        </div>
                        {profileAvatar && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setProfileAvatar(null); }}
                            className="absolute top-0 right-0 p-0.5 rounded-full bg-black/60 hover:bg-black/80 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <X size={10} style={{ color: 'white' }} />
                          </button>
                        )}
                      </div>
                      <input ref={profileAvatarInputRef} type="file" accept="image/png,image/jpeg,image/gif,.png,.jpg,.jpeg,.gif" className="hidden" onChange={handleProfileAvatarUpload} />

                      <div className="mt-2">
                        <p className="text-base font-bold text-t-primary">
                          {profileNickname || user.username}
                          <span className="text-xs font-normal ml-1 text-t-secondary">
                            #{user.discriminator ?? '0000'}
                          </span>
                        </p>
                        {profileNickname && (
                          <p className="text-xs mt-0.5 text-t-secondary">
                            {t('settings.globalName')} {user.username}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Display name input */}
                  <div id="setting-server-display-name">
                    <label className="block text-xs font-bold uppercase tracking-wider mb-2 text-t-secondary">
                      {t('settings.serverDisplayName')}
                    </label>
                    <input
                      type="text"
                      maxLength={32}
                      value={profileNickname}
                      onChange={(e) => setProfileNickname(e.target.value)}
                      placeholder={user.username}
                      className="w-full rounded-xl px-4 py-2.5 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all bg-input-surface border-default text-t-primary"
                    />
                    <p className="text-[10px] mt-1.5 text-t-secondary">
                      {profileNickname.length}/32 — {t('settings.leaveEmptyForGlobal')}
                    </p>
                  </div>

                  {/* Status messages */}
                  {profileError && (
                    <div className="rounded-xl px-4 py-2.5 text-xs font-medium bg-red-500/10 border border-red-500/20 text-[var(--danger)]">
                      {profileError}
                    </div>
                  )}
                  {profileSuccess && (
                    <div className="rounded-xl px-4 py-2.5 text-xs font-medium bg-emerald-500/10 border border-emerald-500/20" style={{ color: '#10b981' }}>
                      {profileSuccess}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex items-center gap-3">
                    <button
                      id="setting-save-server-profile"
                      type="button"
                      disabled={profileSaving}
                      onClick={handleProfileSave}
                      className="btn-cta text-[11px] px-6 py-2 rounded-xl disabled:opacity-50 transition-all"
                    >
                      {profileSaving ? t('common.saving') : t('common.save')}
                    </button>
                    <button
                      id="setting-reset-server-profile"
                      type="button"
                      disabled={profileSaving}
                      onClick={handleProfileReset}
                      className="text-[11px] font-semibold px-6 py-2 rounded-xl bg-fill-hover hover:bg-fill-active disabled:opacity-50 transition-all text-t-primary"
                    >
                      {t('settings.resetToGlobal')}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {myAccountSubTab === 'security' && (
        <>
      {/* Profile Card */}
      <div className="border border-[var(--glass-border)] rounded-2xl overflow-hidden mb-8 bg-panel">
        <input type="file" ref={bannerInputRef} accept="image/png,image/jpeg,image/gif,.png,.jpg,.jpeg,.gif" className="hidden" onChange={handleBannerUpload} disabled={uploadingBanner} />
        <input type="file" ref={avatarInputRef} accept="image/png,image/jpeg,image/gif,.png,.jpg,.jpeg,.gif" className="hidden" onChange={handleAvatarUpload} disabled={uploadingAvatar} />
        {uploadError && <p className="px-6 pt-4 text-sm text-red-400">{uploadError}</p>}

        {/* Banner */}
        <div
          id="setting-upload-banner"
          className={`h-[360px] relative group ${bannerEditMode ? 'cursor-grab active:cursor-grabbing select-none' : 'bg-gradient-to-r from-fill-hover via-slate-900 to-fill-hover'}`}
          style={{
            ...(user.banner && sanitizeCssUrl(user.banner) ? {
              backgroundImage: sanitizeCssUrl(user.banner),
              backgroundSize: bannerEditMode ? (bannerZoom > 100 ? `${bannerZoom}%` : 'cover') : ((user.bannerZoom ?? 100) > 100 ? `${user.bannerZoom}%` : 'cover'),
              backgroundPosition: `center ${bannerEditMode ? bannerDragY : (user.bannerPositionY ?? 50)}%`,
            } : {
              background: 'linear-gradient(135deg, color-mix(in srgb, var(--cyan-accent) 8%, transparent) 0%, rgba(15,23,42,0.6) 100%)',
            }),
          }}
          {...(bannerEditMode ? {
            onPointerDown: handleBannerDragStart,
            onPointerMove: handleBannerDragMove,
            onPointerUp: handleBannerDragEnd,
            onPointerCancel: handleBannerDragEnd,
          } : {})}
        >
          {/* Edit mode overlay + quick profile preview */}
          {bannerEditMode && (
            <>
              <div className="absolute inset-0 bg-black/40 pointer-events-none">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-2 px-4 py-2 rounded-xl bg-black/60 border border-[var(--glass-border)] backdrop-blur-sm">
                  <Move size={16} className="text-white/80" />
                  <span className="text-xs font-semibold text-white/80">{t('settings.account.dragToReposition')}</span>
                </div>
              </div>
              {/* Zoom slider */}
              <div id="setting-banner-zoom" className="absolute top-3 left-3 z-10 pointer-events-auto flex items-center gap-2 px-3 py-2 rounded-xl bg-black/60 border border-[var(--glass-border)] backdrop-blur-sm">
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                <input
                  type="range"
                  min={100}
                  max={200}
                  step={5}
                  value={bannerZoom}
                  onChange={(e) => setBannerZoom(Number(e.target.value))}
                  className="w-24 h-1 rounded-full appearance-none cursor-pointer"
                  style={{ background: `linear-gradient(to right, var(--cyan-accent) ${(bannerZoom - 100)}%, var(--fill-strong) ${(bannerZoom - 100)}%)`, accentColor: 'var(--cyan-accent)' }}
                />
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
              </div>
              <div className="absolute bottom-14 right-3 z-10 pointer-events-none">
                <div className="rounded-xl overflow-hidden border border-[var(--border-strong)] shadow-2xl" style={{ width: '200px' }}>
                  <div className="text-[8px] font-bold uppercase tracking-widest text-white/50 bg-black/70 px-2 py-1 text-center">
                    {t('settings.account.quickProfilePreview')}
                  </div>
                  <div
                    className="h-[60px]"
                    style={{
                      backgroundImage: sanitizeCssUrl(user.banner) || undefined,
                      backgroundSize: bannerZoom > 100 ? `${bannerZoom}%` : 'cover',
                      backgroundPosition: `center ${bannerDragY}%`,
                    }}
                  />
                </div>
              </div>
              <div className="absolute bottom-3 left-3 flex gap-2 z-10">
                <button type="button" onClick={handleBannerPosCancel}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-black/60 text-white/80 border border-[var(--glass-border)] hover:bg-black/80 transition-all pointer-events-auto">
                  {t('common.cancel')}
                </button>
                <button type="button" onClick={handleBannerPosSave} disabled={bannerPosSaving}
                  className="btn-cta px-3 py-1.5 rounded-xl text-xs transition-all disabled:opacity-50 pointer-events-auto">
                  {bannerPosSaving ? t('common.saving') : t('settings.account.savePosition')}
                </button>
              </div>
            </>
          )}

          {/* Normal mode buttons */}
          {!bannerEditMode && (() => {
            const perks = getPlanPerks((subscription?.plan ?? null) as PlanTier);
            return perks.canUploadBanner ? (
              <div className="absolute top-3 right-3 flex gap-2 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-all">
                {user.banner && (
                  <button id="setting-reposition-banner" type="button" onClick={() => { setBannerDragY(user.bannerPositionY ?? 50); setBannerZoom(user.bannerZoom ?? 100); setBannerEditMode(true); }}
                    className="bg-black/60 p-1.5 rounded-lg text-white/40 hover:text-[var(--cyan-accent)] transition-all border border-[var(--glass-border)]"
                    title={t('settings.account.repositionBanner')}>
                    <Move size={14} />
                  </button>
                )}
                <button type="button" onClick={() => bannerInputRef.current?.click()} disabled={uploadingBanner}
                  className="bg-black/60 p-1.5 rounded-lg text-white/40 hover:text-[var(--cyan-accent)] transition-all border border-[var(--glass-border)] disabled:opacity-50">
                  <Camera size={14} />
                </button>
              </div>
            ) : (
              <div className="absolute top-3 right-3 bg-black/60 px-2 py-1 rounded-lg border border-[var(--glass-border)] opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 flex items-center gap-1.5">
                <Lock size={10} className="text-white/40" />
                <span className="text-[9px] font-bold text-[var(--cyan-accent)]">{t('settings.account.requiresEssentialPlus')}</span>
              </div>
            );
          })()}
        </div>

        {/* Avatar + name row */}
        <div className="flex items-center gap-4 px-6 py-4">
          <div id="setting-upload-avatar" className="relative group shrink-0">
            <button
              type="button"
              onClick={() => avatarInputRef.current?.click()}
              disabled={uploadingAvatar}
              className="block w-16 h-16 rounded-[var(--radius-lg)] shadow-xl overflow-hidden relative focus:outline-none disabled:opacity-70"
            >
              <LetterAvatar avatar={user.avatar} username={user.username} className="group-hover:scale-110 transition-transform pointer-events-none" />
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <Camera size={16} className="text-white/80" />
              </div>
            </button>
            <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-emerald-500 rounded-full" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-black tracking-tight text-t-primary" data-personal-info>{user.username}</h3>
            {user.discriminator && (
              <p className="text-xs font-mono text-t-secondary" data-personal-info>#{user.discriminator}</p>
            )}
          </div>
        </div>

        {/* Info rows */}
        <div className="mx-4 mb-4 rounded-xl overflow-hidden border border-[var(--glass-border)] bg-input-surface">
          {editingField === 'username' ? (() => {
            const canChangeDisc = getPlanPerks((subscription?.plan ?? null) as PlanTier).canChangeDiscriminator;
            return (
            <div id="setting-edit-username" className="p-4 space-y-3 border-t border-default">
              <p className="text-[10px] font-bold uppercase tracking-widest text-t-secondary">{t('settings.username')}</p>
              <p className="text-[10px] text-t-secondary">
                {canChangeDisc
                  ? t('settings.account.editUsernameAndDisc')
                  : t('settings.account.newUsernameRandomDisc')}
              </p>
              <div className="flex items-center gap-1.5">
                <input
                  type="text" value={fieldDraft} onChange={(e) => { setFieldDraft(e.target.value); setFieldError(null); }}
                  className="flex-1 rounded-lg px-3 py-2 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50 bg-app-surface border-default text-t-primary"
                  minLength={2} maxLength={32} disabled={savingField} autoFocus placeholder={t('settings.username')}
                />
                <span className="text-sm font-mono shrink-0 text-t-secondary">#</span>
                <div className="relative">
                  <input
                    type="text" value={discDraft}
                    onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 4); setDiscDraft(v); setFieldError(null); }}
                    className={`w-[72px] rounded-lg px-3 py-2 text-sm font-mono border outline-none transition-all bg-app-surface border-default text-t-primary ${
                      canChangeDisc ? 'focus:ring-2 focus:ring-[var(--cyan-accent)]/50' : 'cursor-not-allowed opacity-40'
                    }`}
                    maxLength={4} disabled={!canChangeDisc || savingField} placeholder="0000"
                  />
                  {!canChangeDisc && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <span className="flex items-center gap-0.5 text-[8px] text-white/30 bg-black/60 px-1.5 py-0.5 rounded-lg">
                        <Lock size={7} />{t('settings.account.essentialPlus')}
                      </span>
                    </div>
                  )}
                </div>
              </div>
              {fieldError && <p className="text-xs text-red-400">{fieldError}</p>}
              <div className="flex gap-2">
                <button type="button" onClick={saveField} disabled={savingField || fieldDraft.trim().length < 2}
                  className="btn-cta text-xs px-4 py-2 rounded-xl disabled:opacity-50 transition-all">
                  {savingField ? t('common.saving') : t('common.save')}
                </button>
                <button type="button" onClick={cancelEdit} disabled={savingField}
                  className="text-xs bg-fill-hover hover:bg-fill-active px-4 py-2 rounded-xl font-semibold transition-all text-t-primary">{t('common.cancel')}</button>
              </div>
            </div>
            );
          })() : (
            <span id="setting-edit-username" data-personal-info><SettingsRow label={t('settings.username')} value={formatUsername(user)} onEdit={() => startEditField('username')} /></span>
          )}

          {editingField === 'email' ? (
            <div id="setting-edit-email" className="p-4 space-y-3 border-t border-default">
              <p className="text-[10px] font-bold uppercase tracking-widest text-t-secondary">{t('settings.changeEmail')}</p>
              {!secSuccess ? (
                <>
                  <input type="email" placeholder={t('settings.newEmailAddress')} value={secNewEmail} onChange={(e) => { setSecNewEmail(e.target.value); setSecError(null); }}
                    className="w-full rounded-lg px-3 py-2 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50 bg-app-surface border-default text-t-primary"
                    autoFocus />
                  <input type="password" placeholder={t('settings.currentPassword')} value={secEmailPassword} onChange={(e) => { setSecEmailPassword(e.target.value); setSecError(null); }} autoComplete="one-time-code"
                    className="w-full rounded-lg px-3 py-2 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50 bg-app-surface border-default text-t-primary" />
                  {mfaStatus?.mfaEnabled && !mfaStatus?.totpConfigured && (
                    <p className="text-xs text-amber-400">{t('settings.mfaRequiresTotp', { defaultValue: 'Email change requires an authenticator app. Please set up TOTP in your security settings.' })}</p>
                  )}
                  {mfaStatus?.totpConfigured && (
                    <input type="text" placeholder={t('settings.mfaCode', { defaultValue: 'Authenticator code' })} value={secMfaCode}
                      onChange={(e) => { setSecMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setSecError(null); }}
                      className="w-full rounded-lg px-3 py-2 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50 bg-app-surface border-default text-t-primary"
                      maxLength={6} inputMode="numeric" autoComplete="one-time-code" />
                  )}
                </>
              ) : (
                <>
                  <p className="text-xs text-emerald-400">{t('settings.emailVerificationSent', { defaultValue: 'A verification code has been sent to your new email address.' })}</p>
                  <input type="text" placeholder={t('settings.verificationCode', { defaultValue: 'Verification code' })} value={fieldDraft} onChange={(e) => { setFieldDraft(e.target.value.replace(/\D/g, '').slice(0, 6)); setSecError(null); }}
                    className="w-full rounded-lg px-3 py-2 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50 bg-app-surface border-default text-t-primary"
                    autoFocus maxLength={6} inputMode="numeric" />
                </>
              )}
              {secError && <p className="text-xs text-red-400">{secError}</p>}
              <div className="flex gap-2">
                {!secSuccess ? (
                  <button type="button" disabled={secSaving || !secNewEmail || !secEmailPassword || (mfaStatus?.mfaEnabled && !mfaStatus?.totpConfigured) || (mfaStatus?.totpConfigured ? secMfaCode.length !== 6 : false)}
                    onClick={async () => {
                      setSecSaving(true); setSecError(null); setSecSuccess(null);
                      try {
                        await apiClient.changeEmail(secEmailPassword, secNewEmail, secMfaCode || undefined);
                        setSecSuccess('verification_pending');
                        setFieldDraft('');
                      } catch (e: unknown) { setSecError(e instanceof Error ? e.message : t('settings.account.failedToChangeEmail')); } finally { setSecSaving(false); }
                    }}
                    className="btn-cta text-xs px-4 py-2 rounded-xl disabled:opacity-50 transition-all">
                    {secSaving ? t('common.saving') : t('settings.sendVerification', { defaultValue: 'Send Verification Code' })}
                  </button>
                ) : (
                  <button type="button" disabled={secSaving || fieldDraft.length < 6}
                    onClick={async () => {
                      setSecSaving(true); setSecError(null);
                      try {
                        const result = await apiClient.confirmEmailChange(fieldDraft);
                        if (onUserUpdate) onUserUpdate({ ...user, email: result.email });
                        setSecNewEmail(''); setSecEmailPassword(''); setSecMfaCode(''); setFieldDraft('');
                        setEditingField(null); setSecSuccess(null); setSecError(null);
                      } catch (e: unknown) { setSecError(e instanceof Error ? e.message : t('settings.account.failedToChangeEmail')); } finally { setSecSaving(false); }
                    }}
                    className="btn-cta text-xs px-4 py-2 rounded-xl disabled:opacity-50 transition-all">
                    {secSaving ? t('common.saving') : t('settings.verifyAndChange', { defaultValue: 'Verify & Change Email' })}
                  </button>
                )}
                <button type="button" onClick={() => { setEditingField(null); setSecNewEmail(''); setSecEmailPassword(''); setSecMfaCode(''); setSecError(null); setSecSuccess(null); setFieldDraft(''); }}
                  className="text-xs bg-fill-hover hover:bg-fill-active px-4 py-2 rounded-xl font-semibold transition-all text-t-primary">{t('common.cancel')}</button>
              </div>
            </div>
          ) : (
            <span id="setting-edit-email" data-personal-info><SettingsRow label={t('settings.email')} value={user.email ?? t('settings.notSet')} masked onEdit={startEditEmail} /></span>
          )}

          {/* About Me */}
          {editingBio ? (
            <div id="setting-edit-activity-bio" className="py-3 border-t border-default">
              <label className="text-[10px] font-semibold uppercase tracking-wider mb-2 block text-t-secondary">
                {t('settings.activityBio', { defaultValue: 'About Me' })}
              </label>
              <input
                type="text"
                value={bioDraft}
                onChange={(e) => setBioDraft(e.target.value)}
                maxLength={128}
                placeholder={t('settings.activityBioPlaceholder', { defaultValue: 'What are you up to?' })}
                className="w-full px-3 py-2 rounded-lg border border-[var(--glass-border)] text-xs outline-none mb-2 bg-input-surface text-t-primary"
                autoFocus
              />
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-t-secondary">{bioDraft.length}/128</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setEditingBio(false)} disabled={bioSaving}
                    className="text-xs bg-fill-hover hover:bg-fill-active px-4 py-2 rounded-xl font-semibold transition-all text-t-primary">{t('common.cancel')}</button>
                  <button type="button" onClick={saveBio} disabled={bioSaving}
                    className="btn-cta text-[10px] px-4 py-1.5 rounded-lg disabled:opacity-50 transition-all">
                    {bioSaving ? t('common.saving') : t('common.save')}</button>
                </div>
              </div>
            </div>
          ) : (
            <div id="setting-edit-activity-bio">
            <SettingsRow
              label={t('settings.activityBio', { defaultValue: 'About Me' })}
              value={user.activityBio || t('settings.notSet', { defaultValue: 'Not set' })}
              onEdit={() => { setBioDraft(user.activityBio || ''); setEditingBio(true); }}
            />
            </div>
          )}
        </div>
      </div>

      {/* Pro Customization */}
      {(() => {
        const isPro = subscription?.plan === 'pro';
        return (
        <div className="relative border rounded-2xl overflow-hidden mb-8 bg-panel" style={{ borderColor: isPro ? 'var(--border-subtle)' : 'color-mix(in srgb, var(--cyan-accent) 15%, transparent)' }}>
          <div className="px-6 py-5 border-b border-default">
            <div className="flex items-center gap-2">
              <Crown size={16} className={isPro ? 'text-[var(--cyan-accent)]' : 'text-[var(--cyan-accent)]/50'} />
              <h3 className="text-sm font-semibold text-t-primary">{t('settings.proCustomization')}</h3>
              {!isPro && <span className="ml-auto text-[9px] font-bold uppercase tracking-widest text-[var(--cyan-accent)] bg-[var(--cyan-accent)]/10 border border-[var(--cyan-accent)]/20 px-2.5 py-1 rounded-lg">{t('settings.howlPro')}</span>}
            </div>
          </div>
          <div className={`relative p-6 space-y-0 overflow-hidden ${!isPro ? 'pointer-events-none select-none' : ''}`}>
            {!isPro && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-b-2xl" style={{ background: 'linear-gradient(180deg, var(--overlay-backdrop) 0%, color-mix(in srgb, var(--overlay-backdrop) 85%, transparent) 100%)' }}>
                <div className="pro-shimmer-badge flex items-center gap-2 px-5 py-3 rounded-2xl border border-[var(--cyan-accent)]/30 mb-3" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 15%, transparent)', backdropFilter: 'blur(8px)' }}>
                  <Crown size={18} className="text-[var(--cyan-accent)]" />
                  <span className="text-sm font-semibold text-[var(--cyan-accent)]">{t('settings.upgradeToPro')}</span>
                </div>
                <p className="text-[10px] text-white/40 max-w-[260px] text-center">{t('settings.personalizeNameColor')}</p>
              </div>
            )}
            <div className={!isPro ? 'opacity-30 blur-[1px]' : ''}>

            {/* Live Preview */}
            <div className="rounded-2xl p-5 mb-5" style={{ background: 'linear-gradient(135deg, var(--accent-subtle), rgba(168,85,247,0.04))', border: '1px solid var(--accent-subtle)' }}>
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] mb-4 text-t-secondary">{t('settings.livePreview')}</p>
              <div className="flex gap-3">
                <div className={`w-11 h-11 shrink-0 rounded-[var(--radius-lg)] ${getAvatarEffectClass(proAvatarEffect)}`}>
                  <div className="rounded-[var(--radius-lg)] overflow-hidden">
                    <LetterAvatar avatar={user.avatar} username={user.username} size={44} className="rounded-full" />
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <RoleNameStyle key={`${proNameEffect}|${proNameColor || ''}|${proNameFont || ''}`} name={user.username} overrideColor={proNameColor || undefined} overrideFont={proNameFont === 'default' ? undefined : proNameFont} nameEffect={proNameEffect === 'none' ? undefined : proNameEffect} className="text-sm" />
                    <span className="text-[10px] opacity-60 text-t-secondary">Today at 3:42 PM</span>
                  </div>
                  <p className="text-[13px] mt-1 text-t-secondary">{t('settings.sampleMessage')}</p>
                </div>
              </div>
            </div>

            {/* Name Color */}
            <div id="setting-name-color" className="mb-5">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] mb-2 text-t-secondary">{t('settings.nameColor')}</p>
              <div className="flex items-center gap-3">
                <ColorPicker value={proNameColor || '#076FA0'} onChange={(hex) => setProNameColor(hex)} />
                {proNameColor && <button type="button" onClick={() => setProNameColor('')} className="text-[9px] text-red-400 hover:underline">{t('settings.clear')}</button>}
              </div>
            </div>

            <div className="border-t border-default my-5" />

            {/* Name Font */}
            <div id="setting-name-font" className="mb-5">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] mb-2 text-t-secondary">{t('settings.nameFont')}</p>
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-2">
                {NAME_FONTS.map((f) => (
                  <button key={f.key} type="button" onClick={() => setProNameFont(f.key)}
                    className={`rounded-xl border py-1.5 px-2 text-xs font-normal text-center transition-all cursor-pointer ${proNameFont === f.key ? 'btn-cta-selected' : 'border-[var(--glass-border)] bg-fill-hover hover:bg-fill-hover'}`}
                    style={{
                      fontFamily: f.family,
                      color: proNameFont !== f.key ? 'var(--text-secondary)' : undefined,
                      ...(f.key === 'pixel' ? { fontSize: '11px' } : {}),
                      ...(f.key === 'spaced' ? { letterSpacing: '0.15em', fontSize: '11px' } : {}),
                      ...(f.key === 'bold' ? { fontWeight: 900 } : {}),
                    }} tabIndex={isPro ? 0 : -1}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-t border-default my-5" />

            {/* Name Effect */}
            <div id="setting-name-effect" className="mb-5">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] mb-2 text-t-secondary">{t('settings.nameEffect')}</p>
              <div className="flex flex-wrap gap-2">
                {NAME_EFFECTS.map((e) => {
                  const previewStyle: React.CSSProperties = {};
                  if (e.key === 'glow') { previewStyle.textShadow = '0 0 6px var(--cyan-accent)'; }
                  else if (e.key === 'rainbow') { Object.assign(previewStyle, { background: 'linear-gradient(90deg, #ff6b6b, #feca57, #48dbfb, #ff9ff3, #ff6b6b)', backgroundSize: '200% auto', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', animation: 'name-rainbow 3s linear infinite' }); }
                  else if (e.key === 'shimmer') { Object.assign(previewStyle, { background: 'linear-gradient(90deg, #94a3b8 40%, #fff 50%, #94a3b8 60%)', backgroundSize: '200% auto', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', animation: 'name-shimmer 2s linear infinite' }); }
                  else if (e.key === 'fire') { Object.assign(previewStyle, { background: 'linear-gradient(180deg, #ff6b35, #ff4500, #ff0000)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }); }
                  else if (e.key === 'neon') { Object.assign(previewStyle, { color: 'var(--cyan-accent)', textShadow: '0 0 4px var(--cyan-accent), 0 0 12px color-mix(in srgb, var(--cyan-accent) 50%, transparent)', animation: 'name-neon-flicker 4s infinite' }); }
                  else if (e.key === 'pulse') { Object.assign(previewStyle, { animation: 'name-pulse-glow 2s ease-in-out infinite', color: 'var(--cyan-accent)' }); }
                  else if (e.key === 'gradient') { Object.assign(previewStyle, { background: 'linear-gradient(90deg, #a78bfa, var(--cyan-accent), #34d399, #a78bfa)', backgroundSize: '200% auto', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', animation: 'name-gradient 4s linear infinite' }); }
                  return (
                    <button key={e.key} type="button" onClick={() => setProNameEffect(e.key)}
                      className={`rounded-xl border py-2 px-4 text-xs font-semibold transition-all cursor-pointer ${proNameEffect === e.key ? 'btn-cta-selected' : 'border-[var(--glass-border)] bg-fill-hover hover:bg-fill-hover'}`}
                      style={{ color: proNameEffect !== e.key && e.key === 'none' ? 'var(--text-secondary)' : undefined }} tabIndex={isPro ? 0 : -1}>
                      <span style={previewStyle}>{e.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="border-t border-default my-5" />

            {/* Avatar Effect */}
            <div id="setting-avatar-effect" className="mb-5">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] mb-2 text-t-secondary">{t('settings.avatarEffect')}</p>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                {AVATAR_EFFECTS.map((e) => (
                  <div key={e.key} className="flex flex-col items-center gap-1.5 cursor-pointer" onClick={() => setProAvatarEffect(e.key)}>
                    <div className={`rounded-[var(--radius-lg)] ${getAvatarEffectClass(e.key)} ${proAvatarEffect === e.key ? 'ring-2 ring-[var(--cyan-accent)]/40' : ''}`}>
                      <div className="rounded-[var(--radius-lg)] overflow-hidden">
                        <LetterAvatar avatar={user.avatar} username={user.username} size={36} className="rounded-full" />
                      </div>
                    </div>
                    <span className="text-[10px] font-medium text-center" style={{ color: proAvatarEffect === e.key ? 'var(--cyan-accent)' : 'var(--text-secondary)' }}>{e.label}</span>
                  </div>
                ))}
              </div>
            </div>

            </div>
          </div>
        </div>
        );
      })()}

      {/* Security & Login */}
      <div className="border border-[var(--glass-border)] rounded-2xl overflow-hidden mb-8 bg-panel">
        <div className="px-6 py-5 border-b border-[var(--glass-border)]">
          <h3 className="text-sm font-semibold text-t-primary">{t('settings.securityLogin')}</h3>
        </div>
        <div className="p-6 space-y-0">
          {secSuccess && <p className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-4 py-2 mb-5">{secSuccess}</p>}
          {secError && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2 mb-5">{secError}</p>}

          {/* PASSWORD subsection */}
          <p className="text-[10px] font-bold uppercase tracking-widest mb-3 text-t-secondary" style={{ opacity: 0.6 }}>
            {t('settings.account.passwordLabel', 'Password')}
          </p>

          <button id="setting-change-password" type="button" onClick={() => { setShowChangePassword(!showChangePassword); setSecError(null); setSecSuccess(null); }}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all hover:bg-fill-hover group"
            style={{ backgroundColor: 'var(--fill-hover)', border: '1px solid var(--border-subtle)' }}>
            <KeyRound size={16} className="shrink-0 text-t-secondary" style={{ opacity: 0.7 }} />
            <div className="text-left min-w-0 flex-1">
              <span className="text-[13px] font-medium block text-t-primary">
                {mfaStatus?.hasPassword ? t('settings.changePassword') : t('settings.account.setPassword')}
              </span>
              <span className="text-[11px] text-t-secondary" style={{ opacity: 0.6 }}>
                {mfaStatus?.hasPassword ? t('settings.account.updateYourPassword') : t('settings.account.setPasswordDescription')}
              </span>
            </div>
            <ChevronDown size={14} className={`shrink-0 transition-transform duration-150 text-t-secondary ${showChangePassword ? 'rotate-0' : 'rotate-[-90deg]'}`} style={{ opacity: 0.3 }} />
          </button>

          {showChangePassword && (
            <div className="space-y-3 border border-[var(--glass-border)] rounded-xl p-4 mt-3 bg-input-surface">
              {mfaStatus?.hasPassword !== false && (
                <div>
                  <input type="password" placeholder={t('settings.currentPassword')} value={secCurrentPassword} onChange={(e) => setSecCurrentPassword(e.target.value)} autoComplete="current-password"
                    className="w-full rounded-lg px-3 py-2 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50 bg-app-surface border-default text-t-primary" />
                  <button type="button" onClick={() => onLogout?.()} className="text-[11px] mt-1.5 font-semibold transition-colors hover:underline" style={{ color: 'var(--cyan-accent)' }}>
                    {t('settings.account.forgotPasswordHint', "Forgot your password? Log out to reset it")}
                  </button>
                </div>
              )}
              <input type="password" placeholder={t('settings.newPassword')} value={secNewPassword} onChange={(e) => setSecNewPassword(e.target.value)} autoComplete="new-password"
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50 bg-app-surface border-default text-t-primary" />
              {secNewPassword && (() => {
                const checks = [
                  { label: t('settings.account.pw12Chars'), ok: secNewPassword.length >= 12 },
                  { label: t('settings.account.pwUppercase'), ok: /[A-Z]/.test(secNewPassword) },
                  { label: t('settings.account.pwNumber'), ok: /[0-9]/.test(secNewPassword) },
                  { label: t('settings.account.pwSymbol'), ok: /[^A-Za-z0-9]/.test(secNewPassword) },
                ];
                const passed = checks.filter(c => c.ok).length;
                const colors = ['var(--danger)', 'var(--warning)', 'var(--warning)', 'var(--success)'];
                const barColor = passed === 0 ? 'rgba(51,65,85,0.5)' : colors[passed - 1];
                return (
                  <div className="space-y-1.5">
                    <div className="flex gap-1">
                      {[0, 1, 2, 3].map(i => (
                        <div key={i} className="h-1 flex-1 rounded-full transition-colors duration-200"
                             style={{ backgroundColor: i < passed ? barColor : 'rgba(51,65,85,0.3)' }} />
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                      {checks.map(c => (
                        <span key={c.label} className="text-[10px]" style={{ color: c.ok ? 'var(--success)' : 'var(--text-secondary)' }}>
                          {c.ok ? '\u2713' : '\u25CB'} {c.label}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })()}
              <input type="password" placeholder={t('settings.confirmNewPassword')} value={secConfirmPassword} onChange={(e) => setSecConfirmPassword(e.target.value)} autoComplete="new-password"
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50 bg-app-surface border-default text-t-primary" />
              <div className="flex gap-2">
                <button type="button" disabled={secSaving || secNewPassword.length < 12 || !/[A-Z]/.test(secNewPassword) || !/[0-9]/.test(secNewPassword) || !/[^A-Za-z0-9]/.test(secNewPassword) || secNewPassword !== secConfirmPassword || (mfaStatus?.hasPassword !== false && !secCurrentPassword)}
                  onClick={async () => {
                    setSecSaving(true); setSecError(null); setSecSuccess(null);
                    try {
                      await apiClient.changePassword(mfaStatus?.hasPassword === false ? undefined : secCurrentPassword, secNewPassword);

                      // If password-derived E2E mode is active, re-encrypt the E2E blob with the new password.
                      // When the keystore is locked this session, unlock on the fly with the current password
                      // the user just supplied — without this, the blob stays wrapped by the old password and
                      // the user is left relying on server-escrow recovery at next login.
                      //
                      // The gating flag is PER-TAB and can drift stale-false (a backgrounded tab
                      // that missed a sibling's mode change). Converge it to the SERVER-authoritative
                      // bundle.passwordDerived first, or a stale tab would SKIP the re-key and leave
                      // encryptedBlob wrapped by the OLD password (server-recovery-only at next login).
                      // checkSetup() refreshes _passwordDerived; a transient failure keeps last-known.
                      try { await dmKeyManager.checkSetup(); } catch { /* transient: keep last-known passwordDerived */ }
                      if (dmKeyManager.isPasswordDerived()) {
                        try {
                          if (!dmKeyManager.isUnlocked() && secCurrentPassword) {
                            await dmKeyManager.unlock(secCurrentPassword);
                          }
                          if (dmKeyManager.isUnlocked()) {
                            await dmKeyManager.changePassword(secCurrentPassword, secNewPassword);
                            dmKeyManager.rememberOnDevice(secNewPassword);
                          }
                        } catch (e2eErr) {
                          console.warn('[E2E] Failed to re-encrypt E2E keys after password change:', (e2eErr as Error).message);
                          // Non-fatal — escrow is still valid, user can recover on next login
                        }
                      }

                      setSecSuccess(t('settings.passwordChanged'));
                      setSecCurrentPassword(''); setSecNewPassword(''); setSecConfirmPassword(''); setShowChangePassword(false);
                    } catch (e: unknown) { setSecError(e instanceof Error ? e.message : t('settings.account.failedToChangePassword')); } finally { setSecSaving(false); }
                  }}
                  className="btn-cta text-xs px-4 py-2 rounded-xl disabled:opacity-50 transition-all">
                  {secSaving ? t('common.saving') : t('common.save')}
                </button>
                <button type="button" onClick={() => { setShowChangePassword(false); setSecCurrentPassword(''); setSecNewPassword(''); setSecConfirmPassword(''); }}
                  className="text-xs bg-fill-hover hover:bg-fill-active px-4 py-2 rounded-xl font-semibold transition-all text-t-primary">{t('common.cancel')}</button>
              </div>
            </div>
          )}

          {/* Divider */}
          <div className="border-t border-default my-6" />

          {/* TWO-FACTOR AUTHENTICATION subsection */}
          {mfaLoadError && <div className="text-sm text-red-400 py-4 text-center">{mfaLoadError}</div>}

          <div className="flex items-center justify-between mb-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-t-secondary" style={{ opacity: 0.6 }}>
              {t('settings.twoFactorAuth')}
            </p>
            <span className={`text-[10px] font-bold uppercase tracking-widest px-2.5 py-0.5 rounded-full ${mfaStatus?.mfaEnabled ? 'bg-emerald-500/12 text-emerald-400' : 'bg-fill-hover text-t-secondary'}`}>
              {mfaStatus?.mfaEnabled ? t('settings.account.enabled') : t('settings.notEnabled')}
            </span>
          </div>

          {mfaError && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2 mb-4">{mfaError}</p>}
          {mfaSuccess && <p className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-4 py-2 mb-4">{mfaSuccess}</p>}

          {/* MFA Methods container */}
          {mfaStatus && mfaSetupMode === 'none' && (
            <div className="rounded-lg overflow-hidden border border-default" style={{ backgroundColor: 'var(--fill-hover)' }}>

              {/* Authenticator App row */}
              <div id="setting-mfa-authenticator" className="flex items-center gap-3 px-4 py-3.5">
                <Smartphone size={16} className="shrink-0 text-t-secondary" style={{ opacity: 0.7 }} />
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium block text-t-primary">
                    {t('settings.setUpAuthenticatorApp')}
                  </span>
                  <span className="text-[11px]" style={{ color: mfaStatus.totpConfigured ? '#34d399' : 'var(--text-secondary)', opacity: mfaStatus.totpConfigured ? 1 : 0.5 }}>
                    {mfaStatus.totpConfigured ? t('settings.account.configured') : t('settings.account.authenticatorDesc')}
                  </span>
                </div>
                {mfaStatus.totpConfigured ? (
                  <button type="button" onClick={() => { setMfaRemoveTarget('totp'); setMfaRemovePassword(''); }} className="text-[11px] font-semibold text-red-400 hover:text-red-300 transition-colors shrink-0">{t('common.remove', 'Remove')}</button>
                ) : (
                  <button type="button" disabled={mfaLoading} onClick={async () => {
                    setMfaError(null); setMfaSuccess(null); setMfaLoading(true);
                    try { const data = await apiClient.mfaTotpSetup(); setMfaTotpData(data); setMfaSetupMode('totp'); } catch (e: unknown) { setMfaError(e instanceof Error ? e.message : t('settings.account.setupFailed')); } finally { setMfaLoading(false); }
                  }}
                    className="text-[11px] font-semibold shrink-0 transition-colors disabled:opacity-50 text-t-accent">
                    {mfaLoading ? t('common.loading') : t('settings.account.setUp')}
                  </button>
                )}
              </div>

              <div className="border-t border-[var(--border-subtle)] mx-4" />

              {/* Passkeys header — clickable to expand/collapse */}
              <div id="setting-mfa-passkeys" className="flex items-center gap-3 px-4 py-3.5 cursor-pointer transition-colors hover:bg-fill-hover"
                onClick={() => setPasskeysExpanded(!passkeysExpanded)}>
                <Key size={16} className="shrink-0 text-t-secondary" style={{ opacity: 0.7 }} />
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium block text-t-primary">
                    {t('settings.account.passkeys', 'Passkeys')}
                  </span>
                  <span className="text-[11px]" style={{ color: mfaStatus.passkeys.length > 0 ? '#34d399' : 'var(--text-secondary)', opacity: mfaStatus.passkeys.length > 0 ? 1 : 0.5 }}>
                    {mfaStatus.passkeys.length > 0
                      ? (mfaStatus.passkeys.length === 1
                        ? t('settings.account.passkeyCount', { count: mfaStatus.passkeys.length })
                        : t('settings.account.passkeyCountPlural', { count: mfaStatus.passkeys.length }))
                      : t('settings.account.passkeyDesc')}
                  </span>
                </div>
                <ChevronDown size={14} className={`shrink-0 transition-transform duration-150 text-t-secondary ${passkeysExpanded ? 'rotate-0' : 'rotate-[-90deg]'}`}
                  style={{ opacity: 0.4 }} />
              </div>

              {/* Passkeys expanded body */}
              {passkeysExpanded && (
                <div style={{ backgroundColor: 'var(--fill-hover)' }} className="border-t border-[var(--border-subtle)]">

                  {/* Existing configured passkeys */}
                  {mfaStatus.passkeys.map((pk) => (
                    <React.Fragment key={pk.id}>
                      <div className="flex items-center gap-2.5 py-3 pr-4" style={{ paddingLeft: '44px' }}>
                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                        <span className="text-xs font-medium flex-1 truncate text-t-primary">{pk.name}</span>
                        <button type="button" onClick={() => setPasskeyToDelete({ id: pk.id, name: pk.name })}
                          className="text-[11px] font-semibold text-red-400 hover:text-red-300 transition-colors shrink-0">
                          {t('common.remove', 'Remove')}
                        </button>
                      </div>
                      <div className="border-t border-[var(--border-subtle)]" style={{ marginLeft: '44px' }} />
                    </React.Fragment>
                  ))}

                  {/* Add passkey button */}
                  {mfaStatus.passkeys.length >= 10 ? (
                    <div className="flex items-center gap-2.5 py-3 pr-4" style={{ paddingLeft: '44px' }}>
                      <span className="text-[11px] text-t-secondary" style={{ opacity: 0.5 }}>{t('settings.account.maxPasskeysReached')}</span>
                    </div>
                  ) : (
                    <button type="button" onClick={() => { setMfaError(null); setMfaSuccess(null); setMfaSetupMode('passkey'); }}
                      className="flex items-center gap-2.5 py-3 pr-4 w-full transition-colors hover:bg-fill-hover" style={{ paddingLeft: '44px' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-t-secondary" style={{ opacity: 0.4 }}>
                        <circle cx="12" cy="12" r="10"/><path d="M12 8v8"/><path d="M8 12h8"/>
                      </svg>
                      <span className="text-xs font-medium text-t-accent">{t('settings.addPasskey')}</span>
                    </button>
                  )}

                </div>
              )}

              <div className="border-t border-[var(--border-subtle)] mx-4" />

              {/* Phone Number row */}
              <div id="setting-mfa-phone" className="flex items-center gap-3 px-4 py-3.5">
                <MessageSquare size={16} className="shrink-0 text-t-secondary" style={{ opacity: 0.7 }} />
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium block text-t-primary">
                    {mfaStatus.phoneConfigured ? t('settings.account.smsConfigured', { last4: mfaStatus.phoneLast4 }) : t('settings.addPhoneNumber')}
                  </span>
                  <span className="text-[11px]" style={{ color: mfaStatus.phoneConfigured ? '#34d399' : 'var(--text-secondary)', opacity: mfaStatus.phoneConfigured ? 1 : 0.5 }}>
                    {mfaStatus.phoneConfigured ? t('settings.account.configured') : t('settings.account.phoneDesc')}
                  </span>
                </div>
                {mfaStatus.phoneConfigured ? (
                  <button type="button" onClick={() => { setMfaRemoveTarget('phone'); setMfaRemovePassword(''); }} className="text-[11px] font-semibold text-red-400 hover:text-red-300 transition-colors shrink-0">{t('common.remove', 'Remove')}</button>
                ) : (
                  <span className="text-[10px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-md border border-default text-t-secondary shrink-0">
                    {t('settings.comingSoon')}
                  </span>
                )}
              </div>

            </div>
          )}

          {/* TOTP / Phone removal dialog */}
          {mfaRemoveTarget && (
            <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => { if (!mfaLoading) { setMfaRemoveTarget(null); setMfaRemovePassword(''); } }} />
              <div className="w-full max-w-sm rounded-2xl border shadow-2xl relative bg-panel border-default" onClick={(e) => e.stopPropagation()}>
                <div className="p-6 text-center space-y-4">
                  <div className="w-12 h-12 mx-auto rounded-full bg-red-500/15 flex items-center justify-center">
                    {mfaRemoveTarget === 'totp' ? <Smartphone size={24} className="text-red-400" /> : <MessageSquare size={24} className="text-red-400" />}
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-t-primary">
                      {mfaRemoveTarget === 'totp' ? t('settings.account.removeAuthenticator') : t('settings.account.removePhone')}
                    </h3>
                    <p className="text-xs mt-2 text-t-secondary">
                      {mfaRemoveTarget === 'totp' ? t('settings.account.removeAuthenticatorDesc') : t('settings.account.removePhoneDesc')}
                    </p>
                  </div>
                  <div className="mt-2">
                    <input
                      type="password"
                      value={mfaRemovePassword}
                      onChange={(e) => setMfaRemovePassword(e.target.value)}
                      placeholder={t('settings.account.enterPasswordToRemove')}
                      className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-input-surface text-t-primary border border-[var(--border-color)]"
                      autoComplete="one-time-code"
                      autoFocus
                    />
                  </div>
                  <div className="flex gap-3 justify-center pt-2">
                    <button
                      type="button"
                      disabled={mfaLoading}
                      onClick={() => { setMfaRemoveTarget(null); setMfaRemovePassword(''); }}
                      className="text-xs font-semibold px-5 py-2.5 rounded-xl transition-all bg-fill-hover hover:bg-fill-active disabled:opacity-50 text-t-primary"
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      disabled={mfaLoading || !mfaRemovePassword}
                      onClick={async () => {
                        setMfaLoading(true); setMfaError(null);
                        try {
                          if (mfaRemoveTarget === 'totp') {
                            await apiClient.mfaTotpDisable(mfaRemovePassword);
                            showToast(t('settings.account.authenticatorRemoved'));
                          } else {
                            await apiClient.mfaPhoneDisable(mfaRemovePassword);
                            showToast(t('settings.account.phoneRemoved'));
                          }
                          setMfaRemoveTarget(null);
                          setMfaRemovePassword('');
                          apiClient.mfaStatus().then(setMfaStatus).catch(() => {});
                        } catch (e: unknown) {
                          setMfaError(e instanceof Error ? e.message : t('common.failed'));
                        } finally {
                          setMfaLoading(false);
                        }
                      }}
                      className="btn-cta-danger text-xs px-5 py-2.5 rounded-xl transition-all disabled:opacity-50"
                    >
                      {mfaLoading ? t('settings.account.removing') : t('common.remove', 'Remove')}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Passkey removal dialog */}
          {passkeyToDelete && (
            <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => { if (!passkeyDeleting) { setPasskeyToDelete(null); setPasskeyDeletePassword(''); } }} />
              <div className="w-full max-w-sm rounded-2xl border shadow-2xl relative bg-panel border-default" onClick={(e) => e.stopPropagation()}>
                <div className="p-6 text-center space-y-4">
                  <div className="w-12 h-12 mx-auto rounded-full bg-red-500/15 flex items-center justify-center">
                    <Key size={24} className="text-red-400" />
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-t-primary">{t('settings.account.deletePasskeyTitle', 'Remove Passkey')}</h3>
                    <p className="text-xs mt-2 text-t-secondary">
                      {t('settings.account.deletePasskeyMessage', { name: passkeyToDelete.name, defaultValue: `Are you sure you want to remove "${passkeyToDelete.name}"? You won't be able to use this passkey to sign in anymore.` })}
                    </p>
                  </div>
                  <div className="mt-2">
                    <input
                      type="password"
                      value={passkeyDeletePassword}
                      onChange={(e) => setPasskeyDeletePassword(e.target.value)}
                      placeholder={t('settings.account.enterPasswordToRemove')}
                      className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-input-surface text-t-primary border border-[var(--border-color)]"
                      autoComplete="one-time-code"
                      autoFocus
                    />
                  </div>
                  <div className="flex gap-3 justify-center pt-2">
                    <button
                      type="button"
                      disabled={passkeyDeleting}
                      onClick={() => { setPasskeyToDelete(null); setPasskeyDeletePassword(''); }}
                      className="text-xs font-semibold px-5 py-2.5 rounded-xl transition-all bg-fill-hover hover:bg-fill-active disabled:opacity-50 text-t-primary"
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      disabled={passkeyDeleting || !passkeyDeletePassword}
                      onClick={async () => {
                        setPasskeyDeleting(true);
                        try {
                          await apiClient.deletePasskey(passkeyToDelete.id, passkeyDeletePassword);
                          showToast(t('settings.account.passkeyDeleted'));
                          setMfaStatus((prev) => {
                            if (!prev) return prev;
                            const updatedPasskeys = prev.passkeys.filter((p) => p.id !== passkeyToDelete.id);
                            const hasOtherMfa = prev.totpConfigured || prev.phoneConfigured || updatedPasskeys.length > 0;
                            return { ...prev, passkeys: updatedPasskeys, mfaEnabled: hasOtherMfa ? prev.mfaEnabled : false };
                          });
                          setPasskeyToDelete(null);
                          setPasskeyDeletePassword('');
                          apiClient.mfaStatus().then(setMfaStatus).catch(() => {});
                        } catch (e: unknown) {
                          showToast(e instanceof Error ? e.message : t('common.failed'), 'warning');
                        } finally {
                          setPasskeyDeleting(false);
                        }
                      }}
                      className="btn-cta-danger text-xs px-5 py-2.5 rounded-xl transition-all disabled:opacity-50"
                    >
                      {passkeyDeleting ? t('settings.account.removing') : t('common.remove', 'Remove')}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* SSO warning */}
          {mfaStatus && !mfaStatus.hasPassword && !mfaStatus.mfaEnabled && (
            <p className="text-[10px] px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 mt-4">{t('settings.account.ssoMfaWarning')}</p>
          )}

          {/* TOTP setup */}
          {mfaSetupMode === 'totp' && mfaTotpData && (
            <div className="space-y-4 border border-[var(--glass-border)] rounded-xl p-4 mt-4 bg-input-surface">
              <h4 className="text-xs font-bold text-t-primary">{t('settings.account.scanQrCode')}</h4>
              <div className="flex justify-center"><img src={mfaTotpData.qrCodeUrl} alt={t('settings.account.totpQrAlt')} className="w-48 h-48 rounded-lg" loading="lazy" decoding="async" width={192} height={192} /></div>
              <p className="text-[10px] text-center font-mono break-all text-t-secondary">{t('settings.manualKey')} {mfaTotpData.secret}</p>
              <input type="text" maxLength={6} placeholder={t('settings.enter6DigitCode')} value={mfaTotpCode} onChange={(e) => setMfaTotpCode(e.target.value.replace(/\D/g, ''))}
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50 text-center font-mono tracking-widest bg-app-surface border-default text-t-primary" />
              <div className="flex gap-2">
                <button type="button" disabled={mfaLoading || mfaTotpCode.length !== 6} onClick={async () => {
                  setMfaLoading(true); setMfaError(null);
                  try { await apiClient.mfaTotpEnable(mfaTotpCode, mfaTotpData!.setupToken); setMfaSuccess(t('settings.account.authenticatorEnabled')); setMfaSetupMode('none'); setMfaTotpCode(''); setMfaTotpData(null); apiClient.mfaStatus().then(setMfaStatus).catch(() => {}) /* Best-effort refresh; MFA status will sync on next page load */; onUserUpdate?.({ ...user, mfaEnabled: true }); } catch (e: unknown) { setMfaError(e instanceof Error ? e.message : t('settings.account.verificationFailed')); } finally { setMfaLoading(false); }
                }} className="btn-cta text-xs px-4 py-2 rounded-xl disabled:opacity-50 transition-all">
                  {mfaLoading ? t('common.verifying') : t('settings.verifyEnable')}
                </button>
                <button type="button" onClick={() => { setMfaSetupMode('none'); setMfaTotpCode(''); setMfaTotpData(null); }} className="text-xs bg-fill-hover hover:bg-fill-active px-4 py-2 rounded-xl font-semibold transition-all text-t-primary">{t('common.cancel')}</button>
              </div>
            </div>
          )}

          {/* Passkey setup */}
          {mfaSetupMode === 'passkey' && (
            <div className="space-y-4 border border-[var(--glass-border)] rounded-xl p-4 mt-4 bg-input-surface">
              <h4 className="text-xs font-bold text-t-primary">{t('settings.registerAPasskey')}</h4>
              <p className="text-[11px] text-t-secondary">{t('settings.useDeviceAuth')}</p>
              {!((window as any).__ELECTRON_WINDOW__) && (
                <input type="text" value={passkeyName} onChange={(e) => setPasskeyName(e.target.value)} maxLength={100} placeholder={t('settings.account.passkeyNamePlaceholder')} className="w-full rounded-lg px-3 py-2 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50 bg-app-surface border-default text-t-primary" />
              )}
              <div className="flex gap-2">
                <button type="button" disabled={mfaLoading} onClick={async () => {
                  setMfaLoading(true); setMfaError(null);
                  try {
                    if ((window as any).__ELECTRON_WINDOW__ && window.electron?.startPasskeyRegister) {
                      // Electron: open system browser for passkey registration (WebAuthn requires web origin)
                      const { sessionToken } = await apiClient.mfaPasskeyRegisterSession();
                      await window.electron.startPasskeyRegister(sessionToken);
                      setMfaLoading(false);
                      return; // Result arrives via onSsoSettingsCallback deep link
                    }
                    const { options, challengeToken } = await apiClient.mfaPasskeyRegisterOptions();
                    const { startRegistration } = await import('@simplewebauthn/browser');
                    const credential = await startRegistration({ optionsJSON: options as PublicKeyCredentialCreationOptionsJSON });
                    await apiClient.mfaPasskeyRegisterVerify(challengeToken, credential, passkeyName.trim() || undefined);
                    setMfaSuccess(t('settings.account.passkeyRegistered')); setMfaSetupMode('none'); apiClient.mfaStatus().then(setMfaStatus).catch(() => {}) /* Best-effort refresh; MFA status will sync on next page load */; onUserUpdate?.({ ...user, mfaEnabled: true });
                  } catch (e: unknown) { setMfaError(e instanceof Error ? e.message : t('settings.account.passkeyRegFailed')); } finally { setMfaLoading(false); }
                }} className="btn-cta text-xs px-4 py-2 rounded-xl disabled:opacity-50 transition-all">
                  {mfaLoading ? t('settings.account.waiting') : (window as any).__ELECTRON_WINDOW__ ? 'Register in browser' : t('settings.registerPasskey')}
                </button>
                <button type="button" onClick={() => setMfaSetupMode('none')} className="text-xs bg-fill-hover hover:bg-fill-active px-4 py-2 rounded-xl font-semibold transition-all text-t-primary">{t('common.cancel')}</button>
              </div>
            </div>
          )}

          {/* Phone setup */}
          {mfaSetupMode === 'phone' && (
            <div className="space-y-4 border border-[var(--glass-border)] rounded-xl p-4 mt-4 bg-input-surface">
              <h4 className="text-xs font-bold text-t-primary">{t('settings.addPhoneForSMS')}</h4>
              {mfaPhoneStep === 'number' ? (
                <>
                  <input type="tel" placeholder="+15551234567" value={mfaPhoneNumber} onChange={(e) => setMfaPhoneNumber(e.target.value)}
                    className="w-full rounded-lg px-3 py-2 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50 bg-app-surface border-default text-t-primary" />
                  <div className="flex gap-2">
                    <button type="button" disabled={mfaLoading || !/^\+\d{10,15}$/.test(mfaPhoneNumber)} onClick={async () => {
                      setMfaLoading(true); setMfaError(null);
                      try { await apiClient.mfaPhoneSetup(mfaPhoneNumber); setMfaPhoneStep('verify'); } catch (e: unknown) { setMfaError(e instanceof Error ? e.message : t('settings.account.phoneSetupFailed')); } finally { setMfaLoading(false); }
                    }} className="btn-cta text-xs px-4 py-2 rounded-xl disabled:opacity-50 transition-all">
                      {mfaLoading ? t('common.sending') : t('settings.sendCode')}
                    </button>
                    <button type="button" onClick={() => { setMfaSetupMode('none'); setMfaPhoneNumber(''); }} className="text-xs bg-fill-hover hover:bg-fill-active px-4 py-2 rounded-xl font-semibold transition-all text-t-primary">{t('common.cancel')}</button>
                  </div>
                </>
              ) : (
                <>
                  <input type="text" maxLength={6} placeholder={t('settings.enter6DigitCode')} value={mfaPhoneCode} onChange={(e) => setMfaPhoneCode(e.target.value.replace(/\D/g, ''))}
                    className="w-full rounded-lg px-3 py-2 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50 text-center font-mono tracking-widest bg-app-surface border-default text-t-primary" />
                  <div className="flex gap-2">
                    <button type="button" disabled={mfaLoading || mfaPhoneCode.length !== 6} onClick={async () => {
                      setMfaLoading(true); setMfaError(null);
                      try { await apiClient.mfaPhoneVerifySetup(mfaPhoneCode); setMfaSuccess(t('settings.phoneVerified')); setMfaSetupMode('none'); setMfaPhoneNumber(''); setMfaPhoneCode(''); apiClient.mfaStatus().then(setMfaStatus).catch(() => {}) /* Best-effort refresh; MFA status will sync on next page load */; onUserUpdate?.({ ...user, mfaEnabled: true }); } catch (e: unknown) { setMfaError(e instanceof Error ? e.message : t('settings.account.phoneVerificationFailed')); } finally { setMfaLoading(false); }
                    }} className="btn-cta text-xs px-4 py-2 rounded-xl disabled:opacity-50 transition-all">
                      {mfaLoading ? t('common.verifying') : t('settings.verify')}
                    </button>
                    <button type="button" onClick={() => { setMfaSetupMode('none'); setMfaPhoneNumber(''); setMfaPhoneCode(''); }} className="text-xs bg-fill-hover hover:bg-fill-active px-4 py-2 rounded-xl font-semibold transition-all text-t-primary">{t('common.cancel')}</button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Recovery Codes */}
          {mfaStatus?.mfaEnabled && mfaSetupMode === 'none' && (
            <>
              <div className="border-t border-default my-5" />
              <div id="setting-mfa-recovery-codes" className="flex items-center gap-3">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-t-secondary" style={{ opacity: 0.7 }}>
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium block text-t-primary">
                    {t('settings.account.recoveryCodes')}
                  </span>
                  <span className="text-[11px] text-t-secondary" style={{ opacity: 0.6 }}>
                    {mfaStatus.hasRecoveryCodes ? t('settings.account.recoveryCodesActive') : t('settings.account.generateBackupCodes')}
                  </span>
                </div>
                {mfaStatus.hasPassword ? (
                  <button type="button" disabled={mfaLoading} onClick={() => { setRecoveryPasswordPrompt(true); setRecoveryPassword(''); }}
                    className="text-[11px] font-semibold px-3.5 py-1.5 rounded-lg transition-all bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 disabled:opacity-50 shrink-0">
                    {mfaStatus.hasRecoveryCodes ? t('settings.account.regenerate') : t('settings.account.generate')}
                  </button>
                ) : (
                  <p className="text-[10px] shrink-0 text-t-secondary">{t('settings.account.ssoRecoveryCodesNote')}</p>
                )}
              </div>

              {/* Recovery password prompt */}
              {recoveryPasswordPrompt && (
                <div className="space-y-2 border border-[var(--glass-border)] rounded-xl p-4 mt-3 bg-input-surface">
                  <p className="text-[10px] font-semibold text-t-secondary">{t('settings.account.confirmPasswordToGenerate')}</p>
                  <input
                    type="password"
                    value={recoveryPassword}
                    onChange={(e) => setRecoveryPassword(e.target.value)}
                    className="w-full rounded-lg px-3 py-2 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50 bg-app-surface border-default text-t-primary"
                    placeholder={t('settings.account.enterPassword')}
                    autoComplete="one-time-code"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button type="button" disabled={mfaLoading || !recoveryPassword} onClick={async () => {
                      setMfaLoading(true); setMfaError(null);
                      try {
                        const { codes } = await apiClient.generateRecoveryCodes(recoveryPassword);
                        setRecoveryCodes(codes);
                        setShowRecoveryCodes(true);
                        setRecoveryPasswordPrompt(false);
                        setRecoveryPassword('');
                        apiClient.mfaStatus().then(setMfaStatus).catch(() => {});
                      } catch (e: unknown) { setMfaError(e instanceof Error ? e.message : t('settings.account.failedToGenerateRecoveryCodes')); } finally { setMfaLoading(false); }
                    }} className="btn-cta text-xs px-4 py-2 rounded-xl disabled:opacity-50 transition-all">
                      {mfaLoading ? t('common.loading') : t('common.confirm')}
                    </button>
                    <button type="button" onClick={() => { setRecoveryPasswordPrompt(false); setRecoveryPassword(''); }} className="text-xs bg-fill-hover hover:bg-fill-active px-4 py-2 rounded-xl font-semibold transition-all text-t-primary">
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              )}

              {/* Recovery codes display */}
              {showRecoveryCodes && recoveryCodes.length > 0 && (
                <div className="rounded-xl border p-4 space-y-3 mt-3 bg-app-surface border-default">
                  <p className="text-[10px] font-semibold text-amber-400">{t('settings.account.recoveryCodesSaveWarning')}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {recoveryCodes.map((code, i) => (
                      <button key={i} type="button" onClick={() => { navigator.clipboard.writeText(code).catch(() => {}); setMfaSuccess(t('settings.account.codeCopied')); }}
                        className="font-mono text-sm text-center py-1.5 rounded-lg cursor-pointer transition-colors hover:bg-fill-hover active:scale-95 select-all bg-fill-hover text-t-primary"
                        title={t('settings.account.clickToCopy')}
                        aria-label={t('settings.account.copyRecoveryCode', { code })}
                      >{code}</button>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => { navigator.clipboard.writeText(recoveryCodes.join('\n')); setMfaSuccess(t('settings.account.recoveryCodesCopied')); }} className="text-xs font-semibold px-4 py-2 rounded-xl transition-all bg-[var(--cyan-accent)]/15 text-[var(--cyan-accent)] border border-[var(--cyan-accent)]/25 hover:bg-[var(--cyan-accent)]/25">
                      {t('settings.account.copyAll')}
                    </button>
                    <button type="button" onClick={() => setShowRecoveryCodes(false)} className="text-xs font-semibold px-4 py-2 rounded-xl transition-all bg-fill-hover hover:bg-fill-active text-t-secondary">
                      {t('common.done')}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Divider */}

        </div>
      </div>

      {/* Account Removal */}
      <div className="border border-red-500/10 rounded-2xl overflow-hidden bg-panel">
        <div className="px-6 py-5 bg-[var(--danger)]">
          <h3 className="text-sm font-semibold text-white">{t('settings.dangerZone')}</h3>
        </div>
        <div className="p-6">
          {showDeactivateConfirm ? (
            <div className="space-y-3">
              <p className="text-xs text-amber-400 font-medium">{t('settings.account.deactivateWarning')}</p>
              <input type="password" placeholder={t('settings.enterPasswordToConfirm')} value={deactivatePassword} onChange={(e) => setDeactivatePassword(e.target.value)} autoComplete="one-time-code"
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none focus:ring-2 focus:ring-amber-500/50 bg-app-surface border-default text-t-primary" />
              {secError && <p className="text-xs text-red-400">{secError}</p>}
              <div className="flex gap-2">
                <button type="button" disabled={secSaving || !deactivatePassword}
                  onClick={async () => {
                    setSecSaving(true); setSecError(null);
                    try {
                      await apiClient.deactivateAccount(deactivatePassword);
                      apiClient.clearToken();
                      onLogout?.();
                    } catch (e: unknown) { setSecError(e instanceof Error ? e.message : t('settings.account.failedToDeactivate')); } finally { setSecSaving(false); }
                  }}
                  className="btn-cta-danger text-xs px-4 py-2 rounded-xl disabled:opacity-50 transition-all">
                  {secSaving ? t('common.saving') : t('settings.deactivate')}
                </button>
                <button type="button" onClick={() => { setShowDeactivateConfirm(false); setDeactivatePassword(''); setSecError(null); }}
                  className="text-xs bg-fill-hover hover:bg-fill-active px-4 py-2 rounded-xl font-semibold transition-all text-t-primary">{t('common.cancel')}</button>
              </div>
            </div>
          ) : !showDeleteConfirm ? (
            <div className="flex gap-3">
              <button id="setting-deactivate-account" type="button" onClick={() => { setShowDeactivateConfirm(true); setSecError(null); setSecSuccess(null); setDeactivatePassword(''); }}
                className="btn-cta-danger text-xs px-5 py-2.5 rounded-xl transition-all">
                {t('settings.deactivate')}
              </button>
              <button id="setting-delete-account" type="button" onClick={() => { setShowDeleteConfirm(true); setSecError(null); setSecSuccess(null); }}
                className="btn-cta-danger text-xs px-5 py-2.5 rounded-xl transition-all">
                {t('settings.deletePermanently')}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-red-400 font-medium">{t('settings.areYouSure')}</p>
              <input type="password" placeholder={t('settings.enterPasswordToConfirm')} value={secDeletePassword} onChange={(e) => setSecDeletePassword(e.target.value)} autoComplete="one-time-code"
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none focus:ring-2 focus:ring-red-500/50 bg-app-surface border-default text-t-primary" />
              {secError && <p className="text-xs text-red-400">{secError}</p>}
              <div className="flex gap-2">
                <button type="button" disabled={secSaving || !secDeletePassword}
                  onClick={async () => {
                    setSecSaving(true); setSecError(null);
                    try {
                      await apiClient.deleteAccount(secDeletePassword);
                      apiClient.clearToken();
                      onLogout?.();
                    } catch (e: unknown) { setSecError(e instanceof Error ? e.message : t('settings.account.failedToDeleteAccount')); } finally { setSecSaving(false); }
                  }}
                  className="btn-cta-danger text-xs px-4 py-2 rounded-xl disabled:opacity-50 transition-all">
                  {secSaving ? t('common.deleting') : t('settings.permanentlyDelete')}
                </button>
                <button type="button" onClick={() => { setShowDeleteConfirm(false); setSecDeletePassword(''); }}
                  className="text-xs bg-fill-hover hover:bg-fill-active px-4 py-2 rounded-xl font-semibold transition-all text-t-primary">{t('common.cancel')}</button>
              </div>
            </div>
          )}
        </div>
      </div>
        </>
      )}
    </div>
  );
};

export default MyAccountTab;
