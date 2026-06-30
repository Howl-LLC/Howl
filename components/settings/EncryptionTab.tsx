// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import { Shield, Lock, Unlock, KeyRound, Copy, Check, Loader2, ChevronDown, AlertTriangle } from 'lucide-react';
import { Dropdown } from '../ui/dropdown';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import * as dmKeyManager from '../../services/dmKeyManager';
import { withOtrServerRecoveryGuard } from '../../utils/otrServerRecoveryGuard';
import { EncryptionSetupModal } from '../dm/EncryptionSetupModal';
import { getIdleLockMinutes, setIdleLockMinutes } from '../../hooks/useIdleAutoLock';

interface EncryptionTabProps {
  user: { id: string };
}

type SetupState = 'loading' | 'not-setup' | 'locked' | 'unlocked';

export const EncryptionTab: React.FC<EncryptionTabProps> = ({ user }) => {
  const { t } = useTranslation();
  const [setupState, setSetupState] = useState<SetupState>('loading');
  const [isRemembered, setIsRemembered] = useState(false);
  const [idleLockMin, setIdleLockMinState] = useState<number>(() => getIdleLockMinutes());
  const [unlockOnLogin, setUnlockOnLoginState] = useState(() => dmKeyManager.getUnlockOnLogin());
  const [autoUnlockEnabled, setAutoUnlockEnabledState] = useState(() => dmKeyManager.getAutoUnlockEnabled());
  const [expandedSection, setExpandedSection] = useState<'password' | 'recovery' | 'reset' | null>(null);
  const [showSetupModal, setShowSetupModal] = useState(false);

  // Password change form
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  // Recovery key regeneration
  const [recoveryPw, setRecoveryPw] = useState('');
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [usePassphrase, setUsePassphrase] = useState(false);
  const [customPassphrase, setCustomPassphrase] = useState('');

  // Recovery key modal
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [recoveryMode, setRecoveryMode] = useState<'key' | 'passphrase'>('key');
  const [recoveryKeyCopied, setRecoveryKeyCopied] = useState(false);
  const [recoverySaved, setRecoverySaved] = useState(false);

  // Reset
  const [resetConfirm, setResetConfirm] = useState('');
  const [resetLoading, setResetLoading] = useState(false);

  // Unlock form (inline in locked banner)
  const [unlockPw, setUnlockPw] = useState('');
  const [unlockLoading, setUnlockLoading] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  // Device trust password prompt
  const [devicePwPrompt, setDevicePwPrompt] = useState(false);
  const [devicePw, setDevicePw] = useState('');
  const [devicePwLoading, setDevicePwLoading] = useState(false);
  const [devicePwError, setDevicePwError] = useState<string | null>(null);

  const [passwordDerived, setPasswordDerived] = useState(false);

  // Enable PD confirmation modal
  const [showEnablePdModal, setShowEnablePdModal] = useState(false);
  const [enablePdPw, setEnablePdPw] = useState('');
  const [enablePdLoading, setEnablePdLoading] = useState(false);
  const [enablePdError, setEnablePdError] = useState<string | null>(null);

  // Disable PD new-passphrase modal
  const [showDisablePdModal, setShowDisablePdModal] = useState(false);
  const [disablePdNewPw, setDisablePdNewPw] = useState('');
  const [disablePdConfirmPw, setDisablePdConfirmPw] = useState('');
  const [disablePdLoading, setDisablePdLoading] = useState(false);
  const [disablePdError, setDisablePdError] = useState<string | null>(null);

  const refreshState = useCallback(async () => {
    const hasBundle = await dmKeyManager.checkSetup();
    if (!hasBundle) {
      setSetupState('not-setup');
    } else if (dmKeyManager.isUnlocked()) {
      setSetupState('unlocked');
    } else {
      setSetupState('locked');
    }
    void dmKeyManager.isRememberedOnDevice().then(setIsRemembered);
    setUnlockOnLoginState(dmKeyManager.getUnlockOnLogin());
    setAutoUnlockEnabledState(dmKeyManager.getAutoUnlockEnabled());
    setPasswordDerived(dmKeyManager.isPasswordDerived());
  }, []);

  useEffect(() => { refreshState(); }, [refreshState]);

  const handleUnlock = async () => {
    if (!unlockPw) return;
    setUnlockLoading(true);
    setUnlockError(null);
    try {
      await dmKeyManager.unlock(unlockPw);
      setUnlockPw('');
      setUnlockOnLoginState(dmKeyManager.getUnlockOnLogin());
      await refreshState();
    } catch {
      setUnlockError(t('dm.secureUnlockFailed'));
    } finally {
      setUnlockLoading(false);
    }
  };

  const handleChangePassword = async () => {
    if (!currentPw || !newPw || !confirmPw) return;
    if (newPw.length < 8) { setPwError(t('dm.securePasswordTooShort')); return; }
    if (newPw !== confirmPw) { setPwError(t('dm.securePasswordMismatch')); return; }
    setPwLoading(true);
    setPwError(null);
    try {
      const { recoveryKey: key } = await dmKeyManager.changePassword(currentPw, newPw);
      setRecoveryKey(key);
      setRecoveryMode('key');
      setShowRecoveryModal(true);
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
      setExpandedSection(null);
    } catch (e) {
      setPwError(e instanceof Error ? e.message : t('dm.encryption.passwordChangeFailed'));
    } finally {
      setPwLoading(false);
    }
  };

  const handleRegenerateRecovery = async () => {
    if (!recoveryPw) return;
    if (usePassphrase && customPassphrase.length < 24) {
      setRecoveryError(t('dm.encryption.recoveryPassphraseTooShort'));
      return;
    }
    setRecoveryLoading(true);
    setRecoveryError(null);
    try {
      const result = await dmKeyManager.regenerateRecoveryKey(
        recoveryPw,
        usePassphrase ? customPassphrase : undefined,
      );
      setRecoveryKey(result.recoveryKey);
      setRecoveryMode(result.mode);
      setShowRecoveryModal(true);
      setRecoveryPw('');
      setCustomPassphrase('');
      setExpandedSection(null);
    } catch (e) {
      setRecoveryError(e instanceof Error ? e.message : t('dm.encryption.recoveryRegenerateFailed'));
    } finally {
      setRecoveryLoading(false);
    }
  };

  const handleUnlockOnLoginToggle = () => {
    const next = !unlockOnLogin;
    dmKeyManager.setUnlockOnLogin(next);
    setUnlockOnLoginState(next);
  };

  const handleAutoUnlockToggle = () => {
    const next = !autoUnlockEnabled;
    dmKeyManager.setAutoUnlockEnabled(next);
    setAutoUnlockEnabledState(next);
    // Disabling clears the device credential — reflect that in local state
    // so the device-trust toggle UI reads false on next render without a
    // round trip to settings.
    if (!next) setIsRemembered(false);
  };

  const handleDeviceToggle = () => {
    if (isRemembered) {
      void dmKeyManager.forgetDevice();
      setIsRemembered(false);
      setDevicePwPrompt(false);
      return;
    }
    // Need password to remember on device
    setDevicePwPrompt(true);
  };

  const handleDeviceRemember = async () => {
    if (!devicePw) return;
    setDevicePwLoading(true);
    setDevicePwError(null);
    try {
      // Verify password by attempting unlock (already unlocked, so this validates it)
      await dmKeyManager.unlock(devicePw);
      await dmKeyManager.rememberOnDevice(devicePw);
      setIsRemembered(true);
      setDevicePw('');
      setDevicePwPrompt(false);
    } catch {
      setDevicePwError(t('dm.secureUnlockFailed'));
    } finally {
      setDevicePwLoading(false);
    }
  };

  const handleEnablePasswordDerived = () => {
    setShowEnablePdModal(true);
    setEnablePdPw('');
    setEnablePdError(null);
  };

  const handleConfirmEnablePd = async () => {
    if (!enablePdPw) return;
    setEnablePdLoading(true);
    setEnablePdError(null);
    try {
      await dmKeyManager.unlock(enablePdPw);
      const proceed = await withOtrServerRecoveryGuard(() => dmKeyManager.enablePasswordDerived());
      if (!proceed) { setEnablePdLoading(false); return; }
      setPasswordDerived(true);
      setShowEnablePdModal(false);
      setEnablePdPw('');
    } catch (e) {
      setEnablePdError(e instanceof Error ? e.message : t('dm.encryption.enablePdFailed'));
    } finally {
      setEnablePdLoading(false);
    }
  };

  const handleDisablePasswordDerived = () => {
    setShowDisablePdModal(true);
    setDisablePdNewPw('');
    setDisablePdConfirmPw('');
    setDisablePdError(null);
  };

  const handleConfirmDisablePd = async () => {
    if (disablePdNewPw.length < 8) {
      setDisablePdError(t('dm.encryption.passphraseTooShort'));
      return;
    }
    if (disablePdNewPw !== disablePdConfirmPw) {
      setDisablePdError(t('dm.encryption.passphraseMismatch'));
      return;
    }
    setDisablePdLoading(true);
    setDisablePdError(null);
    try {
      const { recoveryKey: key } = await dmKeyManager.disablePasswordDerived(disablePdNewPw, user.id);
      setPasswordDerived(false);
      setShowDisablePdModal(false);
      setDisablePdNewPw('');
      setDisablePdConfirmPw('');
      setRecoveryKey(key);
      setRecoveryMode('key');
      setShowRecoveryModal(true);
    } catch (e) {
      setDisablePdError(e instanceof Error ? e.message : t('dm.encryption.disablePdFailed'));
    } finally {
      setDisablePdLoading(false);
    }
  };

  const handleReset = async () => {
    if (resetConfirm !== 'RESET') return;
    setResetLoading(true);
    try {
      const { apiClient } = await import('../../services/api');
      await apiClient.deleteDmKeyBundle();
      await dmKeyManager.reset();
      void dmKeyManager.forgetDevice();
      setResetConfirm('');
      setExpandedSection(null);
      await refreshState();
    } catch {
      // If 404, bundle already gone
      await dmKeyManager.reset();
      await refreshState();
    } finally {
      setResetLoading(false);
    }
  };

  const handleRecoveryModalClose = () => {
    setShowRecoveryModal(false);
    setRecoveryKey('');
    setRecoverySaved(false);
    setRecoveryKeyCopied(false);
  };

  const isLocked = setupState === 'locked';

  if (setupState === 'loading') {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin" style={{ color: 'var(--text-secondary)' }} />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2 text-t-primary">{t('settings.encryption')}</h2>
      <p className="text-xs mb-8 text-t-secondary">{t('settings.encryptionDesc')}</p>

      <div className="space-y-4">
      {/* Status Banner */}
      {setupState === 'not-setup' && (
        <div
          id="setting-setup-encryption"
          className="flex items-center gap-3 p-4 rounded-xl border"
          style={{ backgroundColor: 'rgba(234, 179, 8, 0.08)', borderColor: 'rgba(234, 179, 8, 0.2)' }}
        >
          <Shield size={20} className="text-yellow-400 shrink-0" />
          <div className="flex-1">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('dm.encryption.statusNotSetUp')}</div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('dm.encryption.statusNotSetUpDesc')}</div>
          </div>
          <button
            onClick={() => setShowSetupModal(true)}
            className="btn-cta px-4 py-2 rounded-xl text-xs transition-all"
          >
            {t('dm.setupSecureDms')}
          </button>
        </div>
      )}

      {setupState === 'locked' && (
        <div
          id="setting-unlock-encryption"
          className="flex flex-col gap-3 p-4 rounded-xl border"
          style={{ backgroundColor: 'rgba(245, 158, 11, 0.08)', borderColor: 'rgba(245, 158, 11, 0.2)' }}
        >
          <div className="flex items-center gap-3">
            <Lock size={20} className="text-amber-400 shrink-0" />
            <div className="flex-1">
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('dm.encryption.statusLocked')}</div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('dm.encryption.statusLockedDesc')}</div>
            </div>
          </div>
          <div className={`flex gap-2 ${unlockError ? 'animate-[shake_0.35s_ease-in-out]' : ''}`}>
            <input
              type="password"
              placeholder={t('dm.securePasswordPlaceholder')}
              value={unlockPw}
              onChange={(e) => { setUnlockPw(e.target.value); if (unlockError) setUnlockError(null); }}
              onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
              className={`flex-1 px-3 py-2 rounded-lg bg-black/30 border text-sm text-t-primary placeholder-t-secondary outline-none transition-colors ${unlockError ? 'border-red-500/70 focus:border-red-500' : 'border-[var(--glass-border)] focus:border-[var(--cyan-accent)]/50'}`}
              autoFocus
              aria-invalid={!!unlockError}
            />
            <button
              onClick={handleUnlock}
              disabled={unlockLoading || !unlockPw}
              className="btn-cta px-4 py-2 rounded-xl disabled:opacity-50 text-xs transition-all flex items-center gap-1.5"
            >
              {unlockLoading ? <Loader2 size={12} className="animate-spin" /> : <Unlock size={12} />}
              {t('dm.secureUnlockButton')}
            </button>
          </div>
          {unlockError && (
            <div role="alert" className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30">
              <AlertTriangle size={13} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-[12px] text-red-300 leading-snug">{unlockError}</p>
            </div>
          )}
        </div>
      )}

      {setupState === 'unlocked' && (
        <div
          className="flex items-center gap-3 p-4 rounded-xl border"
          style={{ backgroundColor: 'rgba(34, 197, 94, 0.08)', borderColor: 'rgba(34, 197, 94, 0.2)' }}
        >
          <Shield size={20} className="text-emerald-400 shrink-0" />
          <div className="flex-1">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('dm.encryption.statusUnlocked')}</div>
            <div className="text-[11px] mt-1 font-medium" style={{ color: 'var(--cyan-accent)' }}>
              {passwordDerived
                ? t('dm.encryption.statusPdActive')
                : t('dm.encryption.statusManualActive')
              }
            </div>
          </div>
          <div className="px-3 py-1 rounded-full text-xs font-semibold" style={{ backgroundColor: 'rgba(34, 197, 94, 0.15)', color: '#22c55e' }}>
            {t('dm.encryption.statusUnlockedDesc')}
          </div>
        </div>
      )}

      {/* ── Security Card ── */}
      {setupState !== 'not-setup' && (
        <div className="rounded-xl border border-[var(--glass-border)] overflow-hidden" style={{ backgroundColor: 'var(--bg-panel)' }}>
          <div className="px-5 pt-4 pb-2">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('dm.encryption.securityHeading')}</h3>
          </div>

          {/* ── Mode group ── */}
          <div className="px-5 pt-3 pb-1 text-[10px] uppercase tracking-wider font-semibold border-t border-default" style={{ color: 'var(--text-secondary)' }}>
            {t('dm.encryption.groupMode', 'Mode')}
          </div>

          {/* Row: Password-Derived Mode */}
          <div id="setting-password-derived-mode" className="px-5 py-3">
            <div className="flex items-center justify-between">
              <div className="flex-1 mr-4">
                <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                  {t('dm.encryption.pdModeLabel')}
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  {t('dm.encryption.pdModeDesc')}
                </div>
              </div>
              <button
                onClick={passwordDerived ? handleDisablePasswordDerived : handleEnablePasswordDerived}
                disabled={isLocked}
                className={`relative w-10 rounded-full transition-all duration-200 shrink-0 disabled:opacity-40 ${passwordDerived ? 'bg-[var(--cyan-accent)]' : 'bg-fill-active'}`}
                style={{ minWidth: '2.5rem', height: '1.375rem' }}
                aria-label="Toggle password-derived mode"
              >
                <span
                  className={`absolute top-0.5 left-0.5 rounded-full bg-white shadow transition-transform duration-200 ${passwordDerived ? 'translate-x-[1.125rem]' : 'translate-x-0'}`}
                  style={{ width: '1.125rem', height: '1.125rem' }}
                />
              </button>
            </div>
            {!passwordDerived && !isLocked && (
              <div
                className="mt-3 flex items-start gap-2.5 p-3.5 rounded-lg"
                style={{ backgroundColor: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.22)' }}
              >
                <AlertTriangle size={15} className="text-amber-400 shrink-0 mt-px" />
                <p className="text-[12px] leading-relaxed flex-1" style={{ color: 'var(--text-secondary)' }}>
                  {t('dm.encryption.pdModeWarning')}
                </p>
              </div>
            )}
          </div>

          {/* ── Credentials group ── */}
          <div className="px-5 pt-3 pb-1 text-[10px] uppercase tracking-wider font-semibold border-t border-default" style={{ color: 'var(--text-secondary)' }}>
            {t('dm.encryption.groupCredentials', 'Credentials')}
          </div>

          {/* Row 1: Encryption Password */}
          <div id="setting-change-encryption-password" className="px-5 py-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium" style={{ color: passwordDerived ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
                  {t('dm.encryption.passwordLabel')}
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  {passwordDerived
                    ? t('dm.encryption.passwordPdDesc')
                    : t('dm.encryption.passwordDesc')
                  }
                </div>
              </div>
              <button
                onClick={() => setExpandedSection(expandedSection === 'password' ? null : 'password')}
                disabled={isLocked || passwordDerived}
                className="px-3 py-1.5 rounded-lg bg-fill-hover hover:bg-fill-active disabled:opacity-30 text-xs font-medium transition-colors flex items-center gap-1"
                style={{ color: 'var(--text-primary)' }}
              >
                {t('dm.encryption.passwordChange')}
                <ChevronDown size={12} className={`transition-transform ${expandedSection === 'password' ? 'rotate-180' : ''}`} />
              </button>
            </div>

            {!passwordDerived && expandedSection === 'password' && (
              <div className="mt-3 space-y-2.5">
                <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>{t('dm.encryption.passwordHelper')}</p>
                <input
                  type="password"
                  placeholder={t('dm.encryption.passwordCurrentLabel')}
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-black/30 border border-[var(--glass-border)] text-sm text-t-primary placeholder-t-secondary outline-none focus:border-[var(--cyan-accent)]/50"
                  autoFocus
                />
                <input
                  type="password"
                  placeholder={t('dm.encryption.passwordNewLabel')}
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-black/30 border border-[var(--glass-border)] text-sm text-t-primary placeholder-t-secondary outline-none focus:border-[var(--cyan-accent)]/50"
                />
                <input
                  type="password"
                  placeholder={t('dm.encryption.passwordConfirmLabel')}
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleChangePassword()}
                  className="w-full px-3 py-2 rounded-lg bg-black/30 border border-[var(--glass-border)] text-sm text-t-primary placeholder-t-secondary outline-none focus:border-[var(--cyan-accent)]/50"
                />
                {pwError && (
                  <div role="alert" className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 animate-[shake_0.35s_ease-in-out]">
                    <AlertTriangle size={13} className="text-red-400 shrink-0 mt-0.5" />
                    <p className="text-[12px] text-red-300 leading-snug">{pwError}</p>
                  </div>
                )}
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => { setExpandedSection(null); setCurrentPw(''); setNewPw(''); setConfirmPw(''); setPwError(null); }}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-fill-hover transition-colors"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {t('dm.encryption.cancel')}
                  </button>
                  <button
                    onClick={handleChangePassword}
                    disabled={pwLoading || !currentPw || !newPw || !confirmPw}
                    className="btn-cta px-4 py-1.5 rounded-xl disabled:opacity-50 text-xs transition-all flex items-center gap-1.5"
                  >
                    {pwLoading && <Loader2 size={12} className="animate-spin" />}
                    {t('dm.encryption.save')}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Row 2: Recovery Key */}
          {!passwordDerived && (
          <div id="setting-regenerate-recovery-key" className="px-5 py-3 border-t border-default">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{t('dm.encryption.recoveryLabel')}</div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('dm.encryption.recoveryDesc')}</div>
              </div>
              <button
                onClick={() => setExpandedSection(expandedSection === 'recovery' ? null : 'recovery')}
                disabled={isLocked}
                className="px-3 py-1.5 rounded-lg bg-fill-hover hover:bg-fill-active disabled:opacity-40 text-xs font-medium transition-colors"
                style={{ color: 'var(--text-primary)' }}
              >
                {t('dm.encryption.recoveryRegenerate')}
              </button>
            </div>

            {expandedSection === 'recovery' && (
              <div className="mt-3 space-y-2.5">
                <p className="text-[10px] text-amber-400">{t('dm.encryption.recoveryWarning')}</p>
                <input
                  type="password"
                  placeholder={t('dm.encryption.recoveryEnterPassword')}
                  value={recoveryPw}
                  onChange={(e) => setRecoveryPw(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-black/30 border border-[var(--glass-border)] text-sm text-t-primary placeholder-t-secondary outline-none focus:border-[var(--cyan-accent)]/50"
                  autoFocus
                />
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={usePassphrase}
                    onChange={(e) => setUsePassphrase(e.target.checked)}
                    className="w-3.5 h-3.5 rounded-lg border-[var(--border-strong)] bg-black/30"
                  />
                  <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    {t('dm.encryption.recoveryUsePassphrase')}
                  </span>
                </label>
                {usePassphrase && (
                  <input
                    type="text"
                    placeholder={t('dm.encryption.recoveryPassphrasePlaceholder')}
                    value={customPassphrase}
                    onChange={(e) => setCustomPassphrase(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-black/30 border border-[var(--glass-border)] text-sm text-t-primary placeholder-t-secondary outline-none focus:border-[var(--cyan-accent)]/50"
                  />
                )}
                {recoveryError && (
                  <div role="alert" className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 animate-[shake_0.35s_ease-in-out]">
                    <AlertTriangle size={13} className="text-red-400 shrink-0 mt-0.5" />
                    <p className="text-[12px] text-red-300 leading-snug">{recoveryError}</p>
                  </div>
                )}
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => { setExpandedSection(null); setRecoveryPw(''); setCustomPassphrase(''); setRecoveryError(null); setUsePassphrase(false); }}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-fill-hover transition-colors"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {t('dm.encryption.cancel')}
                  </button>
                  <button
                    onClick={handleRegenerateRecovery}
                    disabled={recoveryLoading || !recoveryPw}
                    className="btn-cta px-4 py-1.5 rounded-xl disabled:opacity-50 text-xs transition-all flex items-center gap-1.5"
                  >
                    {recoveryLoading && <Loader2 size={12} className="animate-spin" />}
                    {t('dm.encryption.recoveryRegenerate')}
                  </button>
                </div>
              </div>
            )}
          </div>
          )}

          {/* ── Convenience group ── */}
          <div className="px-5 pt-3 pb-1 text-[10px] uppercase tracking-wider font-semibold border-t border-default" style={{ color: 'var(--text-secondary)' }}>
            {t('dm.encryption.groupConvenience', 'Convenience')}
          </div>

          {/* Row: Unlock on Login (modal vs. inline banner) */}
          <div id="setting-unlock-on-login" className="px-5 py-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{t('dm.encryption.unlockOnLoginLabel', 'Show unlock prompt at login')}</div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('dm.encryption.unlockOnLoginDesc', 'When enabled, a modal opens at login. When disabled, the locked banner above DMs shows the password input instead.')}</div>
              </div>
              <button
                onClick={handleUnlockOnLoginToggle}
                className={`relative w-10 h-5.5 rounded-full transition-all duration-200 shrink-0 ${unlockOnLogin ? 'bg-[var(--cyan-accent)]' : 'bg-fill-active'}`}
                style={{ minWidth: '2.5rem', height: '1.375rem' }}
                aria-label="Toggle unlock on login"
              >
                <span className={`absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform duration-200 ${unlockOnLogin ? 'translate-x-[1.125rem]' : 'translate-x-0'}`} style={{ width: '1.125rem', height: '1.125rem' }} />
              </button>
            </div>
          </div>

          {/* Row: Auto-unlock with device credential */}
          <div id="setting-auto-unlock" className="px-5 py-3 border-t border-default">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{t('dm.encryption.autoUnlockLabel', 'Auto-unlock with stored device credential')}</div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('dm.encryption.autoUnlockDesc', 'When enabled, a remembered device password unlocks DMs silently at login. Turn off to be prompted every time, even if "Remember on device" is on.')}</div>
              </div>
              <button
                onClick={handleAutoUnlockToggle}
                className={`relative w-10 h-5.5 rounded-full transition-all duration-200 shrink-0 ${autoUnlockEnabled ? 'bg-[var(--cyan-accent)]' : 'bg-fill-active'}`}
                style={{ minWidth: '2.5rem', height: '1.375rem' }}
                aria-label="Toggle auto-unlock"
              >
                <span className={`absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform duration-200 ${autoUnlockEnabled ? 'translate-x-[1.125rem]' : 'translate-x-0'}`} style={{ width: '1.125rem', height: '1.125rem' }} />
              </button>
            </div>
          </div>

          {/* Row 3: Device Trust */}
          <div id="setting-device-trust" className="px-5 py-3 border-t border-default">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{t('dm.encryption.deviceLabel')}</div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('dm.encryption.deviceDesc')}</div>
                {isRemembered && (
                  <div className="text-[10px] mt-1" style={{ color: 'var(--text-secondary)', opacity: 0.7 }}>
                    {passwordDerived
                      ? t('dm.encryption.deviceExpiryNoteServer', 'Remembered on this device. Server recovery keeps this active.')
                      : t('dm.encryption.deviceExpiryNote', 'Remembered for 30 days. Each unlock extends this.')}
                  </div>
                )}
              </div>
              <button
                onClick={handleDeviceToggle}
                disabled={isLocked}
                className={`relative w-10 h-5.5 rounded-full transition-all duration-200 shrink-0 disabled:opacity-40 ${isRemembered ? 'bg-[var(--cyan-accent)]' : 'bg-fill-active'}`}
                style={{ minWidth: '2.5rem', height: '1.375rem' }}
              >
                <span className={`absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform duration-200 ${isRemembered ? 'translate-x-[1.125rem]' : 'translate-x-0'}`} style={{ width: '1.125rem', height: '1.125rem' }} />
              </button>
            </div>
            {devicePwPrompt && (
              <div className="mt-3 space-y-2">
                <div className="flex gap-2">
                  <input
                    type="password"
                    placeholder={t('dm.encryption.passwordCurrentLabel')}
                    value={devicePw}
                    onChange={(e) => setDevicePw(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleDeviceRemember()}
                    className="flex-1 px-3 py-2 rounded-lg bg-black/30 border border-[var(--glass-border)] text-sm text-t-primary placeholder-t-secondary outline-none focus:border-[var(--cyan-accent)]/50"
                    autoFocus
                  />
                  <button
                    onClick={handleDeviceRemember}
                    disabled={devicePwLoading || !devicePw}
                    className="btn-cta px-3 py-2 rounded-xl disabled:opacity-50 text-xs transition-all flex items-center gap-1.5"
                  >
                    {devicePwLoading && <Loader2 size={12} className="animate-spin" />}
                    {t('dm.encryption.save')}
                  </button>
                </div>
                {devicePwError && (
                  <div role="alert" className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 animate-[shake_0.35s_ease-in-out]">
                    <AlertTriangle size={13} className="text-red-400 shrink-0 mt-0.5" />
                    <p className="text-[12px] text-red-300 leading-snug">{devicePwError}</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Row 4: Idle auto-lock */}
          <div id="setting-idle-auto-lock" className="px-5 py-3 border-t border-default">
            <div className="flex items-center justify-between">
              <div>
                <div
                  className="text-xs font-medium"
                  style={{ color: isRemembered ? 'var(--text-secondary)' : 'var(--text-primary)', opacity: isRemembered ? 0.6 : 1 }}
                >
                  {t('dm.encryption.idleLockLabel', 'Auto-lock when idle')}
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)', opacity: isRemembered ? 0.6 : 1 }}>
                  {isRemembered
                    ? t('dm.encryption.idleLockDisabledByRemember', 'Auto-lock is disabled while Remember on this device is enabled')
                    : t('dm.encryption.idleLockDesc', 'Lock keys and require the passphrase again after a period of inactivity.')
                  }
                </div>
              </div>
              <Dropdown<number>
                options={[
                  { value: 0, label: t('common.off', 'Off') },
                  { value: 5, label: '5 min' },
                  { value: 15, label: '15 min' },
                  { value: 30, label: '30 min' },
                  { value: 60, label: '1 hr' },
                  { value: 240, label: '4 hr' },
                ]}
                value={idleLockMin}
                onChange={(v) => {
                  setIdleLockMinutes(v);
                  setIdleLockMinState(v);
                }}
                disabled={isRemembered}
                size="sm"
              />
            </div>
          </div>

        </div>
      )}

      {/* ── Danger Zone ── */}
      {setupState !== 'not-setup' && (
        <div
          id="setting-reset-encryption"
          className="rounded-xl border overflow-hidden"
          style={{ backgroundColor: 'rgba(239, 68, 68, 0.04)', borderColor: 'rgba(239, 68, 68, 0.2)' }}
        >
          <div className="px-5 py-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-red-400">{t('dm.encryption.resetLabel')}</div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('dm.encryption.resetDesc')}</div>
              </div>
              <button
                onClick={() => setExpandedSection(expandedSection === 'reset' ? null : 'reset')}
                className="btn-cta-danger px-3 py-1.5 rounded-xl text-xs transition-colors"
              >
                {t('dm.encryption.resetButtonLabel')}
              </button>
            </div>

            {expandedSection === 'reset' && (
              <div className="mt-3 space-y-2.5">
                <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                  <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-red-300">{t('dm.encryption.resetWarning')}</p>
                </div>
                <input
                  type="text"
                  placeholder={t('dm.encryption.resetConfirmPrompt')}
                  value={resetConfirm}
                  onChange={(e) => setResetConfirm(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-black/30 border border-red-500/20 text-sm text-t-primary placeholder-t-secondary outline-none focus:border-red-500/50"
                  autoFocus
                />
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => { setExpandedSection(null); setResetConfirm(''); }}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-fill-hover transition-colors"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {t('dm.encryption.cancel')}
                  </button>
                  <button
                    onClick={handleReset}
                    disabled={resetLoading || resetConfirm !== 'RESET'}
                    className="btn-cta-danger px-4 py-1.5 rounded-xl disabled:opacity-50 text-xs transition-colors flex items-center gap-1.5"
                  >
                    {resetLoading && <Loader2 size={12} className="animate-spin" />}
                    {t('dm.encryption.resetButton')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Recovery Key Modal ── */}
      {showRecoveryModal && createPortal(
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div
            className="rounded-2xl border border-[var(--glass-border)] p-7 w-full max-w-md flex flex-col shadow-2xl spring-pop-in"
            style={{ backgroundColor: 'var(--bg-panel)' }}
          >
            <div className="flex items-center gap-2 mb-4">
              <KeyRound size={18} className="text-emerald-400" />
              <span className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                {t('dm.encryption.passwordSuccess')}
              </span>
            </div>

            {recoveryMode === 'key' ? (
              <>
                <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
                  {t('dm.encryption.recoveryKeySavePrompt')}
                </p>
                <div className="relative bg-black/40 border border-[var(--glass-border)] rounded-lg p-4 mb-4 font-mono text-sm text-emerald-300 break-all select-all">
                  {recoveryKey}
                  <button
                    type="button"
                    onClick={() => { navigator.clipboard.writeText(recoveryKey); setRecoveryKeyCopied(true); setTimeout(() => setRecoveryKeyCopied(false), 2000); }}
                    className="absolute top-2 right-2 p-1.5 rounded-md hover:bg-fill-active transition-colors"
                  >
                    {recoveryKeyCopied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} className="text-t-secondary" />}
                  </button>
                </div>
              </>
            ) : (
              <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>
                {t('dm.encryption.recoveryPassphraseSet')}
              </p>
            )}

            <label className="flex items-center gap-2 mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={recoverySaved}
                onChange={(e) => setRecoverySaved(e.target.checked)}
                className="w-4 h-4 rounded-lg border-[var(--border-strong)] bg-black/30"
              />
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('dm.encryption.recoverySaved')}</span>
            </label>
            <button
              type="button"
              onClick={handleRecoveryModalClose}
              disabled={!recoverySaved}
              className="btn-cta w-full py-2.5 rounded-xl disabled:opacity-50 text-sm transition-all"
            >
              {t('dm.secureDone')}
            </button>
          </div>
        </div>,
        document.body,
      )}
      {showEnablePdModal && createPortal(
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div
            className="rounded-2xl border border-[var(--glass-border)] p-7 w-full max-w-md flex flex-col shadow-2xl"
            style={{ backgroundColor: 'var(--bg-panel)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-4">
              <Shield size={18} className="text-[var(--cyan-accent)]" />
              <span className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                {t('dm.encryption.enablePdTitle')}
              </span>
            </div>

            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 mb-4">
              <p className="text-xs font-semibold text-amber-400 mb-1">{t('dm.encryption.whatThisDoes')}</p>
              <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {t('dm.encryption.enablePdExplainer')}
              </p>
              <ul className="text-[11px] mt-1.5 space-y-1" style={{ color: 'var(--text-secondary)' }}>
                <li className="flex items-start gap-1.5">
                  <span className="text-emerald-400 mt-0.5">✓</span>
                  <span>{t('dm.encryption.enablePdPro1')}</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <span className="text-emerald-400 mt-0.5">✓</span>
                  <span>{t('dm.encryption.enablePdPro2')}</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <span className="text-amber-400 mt-0.5">⚠</span>
                  <span>{t('dm.encryption.enablePdCon1')}</span>
                </li>
              </ul>
            </div>

            <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--text-secondary)' }}>
              {t('dm.encryption.enablePdPasswordLabel')}
            </label>
            <p className="text-[10px] mb-2" style={{ color: 'var(--text-secondary)' }}>
              {t('dm.encryption.enablePdPasswordHint')}
            </p>
            <input
              type="password"
              placeholder={t('dm.encryption.passphrasePlaceholder')}
              value={enablePdPw}
              onChange={(e) => setEnablePdPw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleConfirmEnablePd()}
              className="w-full px-3 py-2.5 rounded-lg bg-black/30 border border-[var(--glass-border)] text-sm text-t-primary placeholder-t-secondary outline-none focus:border-[var(--cyan-accent)]/50 mb-3"
              autoFocus
            />
            {enablePdError && (
              <div role="alert" className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 mb-3 animate-[shake_0.35s_ease-in-out]">
                <AlertTriangle size={13} className="text-red-400 shrink-0 mt-0.5" />
                <p className="text-[12px] text-red-300 leading-snug">{enablePdError}</p>
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => { setShowEnablePdModal(false); setEnablePdPw(''); setEnablePdError(null); }}
                className="flex-1 py-2.5 rounded-lg text-xs font-medium hover:bg-fill-hover transition-colors"
                style={{ color: 'var(--text-secondary)' }}
              >
                {t('dm.encryption.cancel')}
              </button>
              <button
                onClick={handleConfirmEnablePd}
                disabled={enablePdLoading || !enablePdPw}
                className="btn-cta flex-1 py-2.5 rounded-xl disabled:opacity-50 text-xs transition-all flex items-center justify-center gap-1.5"
              >
                {enablePdLoading && <Loader2 size={12} className="animate-spin" />}
                {t('dm.encryption.enableButton')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {showDisablePdModal && createPortal(
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div
            className="rounded-2xl border border-[var(--glass-border)] p-7 w-full max-w-md flex flex-col shadow-2xl"
            style={{ backgroundColor: 'var(--bg-panel)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-4">
              <KeyRound size={18} className="text-amber-400" />
              <span className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                {t('dm.encryption.disablePdTitle')}
              </span>
            </div>

            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 mb-4">
              <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {t('dm.encryption.disablePdExplainer')}
              </p>
            </div>

            <div className="space-y-2.5 mb-3">
              <input
                type="password"
                placeholder={t('dm.encryption.newPassphrasePlaceholder')}
                value={disablePdNewPw}
                onChange={(e) => setDisablePdNewPw(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg bg-black/30 border border-[var(--glass-border)] text-sm text-t-primary placeholder-t-secondary outline-none focus:border-[var(--cyan-accent)]/50"
                autoFocus
              />
              <input
                type="password"
                placeholder={t('dm.encryption.confirmPassphrasePlaceholder')}
                value={disablePdConfirmPw}
                onChange={(e) => setDisablePdConfirmPw(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleConfirmDisablePd()}
                className="w-full px-3 py-2.5 rounded-lg bg-black/30 border border-[var(--glass-border)] text-sm text-t-primary placeholder-t-secondary outline-none focus:border-[var(--cyan-accent)]/50"
              />
              {disablePdNewPw.length > 0 && disablePdNewPw.length < 8 && (
                <p className="text-xs text-amber-400">{t('dm.encryption.passphraseTooShort')}</p>
              )}
              {disablePdConfirmPw.length > 0 && disablePdNewPw !== disablePdConfirmPw && (
                <p className="text-xs text-amber-400">{t('dm.encryption.passphraseMismatch')}</p>
              )}
            </div>
            {disablePdError && (
              <div role="alert" className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 mb-3 animate-[shake_0.35s_ease-in-out]">
                <AlertTriangle size={13} className="text-red-400 shrink-0 mt-0.5" />
                <p className="text-[12px] text-red-300 leading-snug">{disablePdError}</p>
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => { setShowDisablePdModal(false); setDisablePdNewPw(''); setDisablePdConfirmPw(''); setDisablePdError(null); }}
                className="flex-1 py-2.5 rounded-lg text-xs font-medium hover:bg-fill-hover transition-colors"
                style={{ color: 'var(--text-secondary)' }}
              >
                {t('dm.encryption.cancel')}
              </button>
              <button
                onClick={handleConfirmDisablePd}
                disabled={disablePdLoading || disablePdNewPw.length < 8 || disablePdNewPw !== disablePdConfirmPw}
                className="flex-1 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-[var(--text-on-accent)] text-xs font-semibold transition-all flex items-center justify-center gap-1.5"
              >
                {disablePdLoading && <Loader2 size={12} className="animate-spin" />}
                {t('dm.encryption.disablePdButton')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      <EncryptionSetupModal
        isOpen={showSetupModal}
        onClose={() => setShowSetupModal(false)}
        onSetupComplete={() => { setShowSetupModal(false); refreshState(); }}
      />
      </div>
    </div>
  );
};
