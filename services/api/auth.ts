// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';
import type { User } from '../../types';
import type { BackendUser, AuthResponse } from '../apiTypes';
import type { RegisterResult, LoginResult, MfaStatus, TrustedDeviceInfo } from '../apiTypes';

declare module './core' {
  interface APIClient {
    register(username: string, email: string, password: string, captchaToken?: string, dateOfBirth?: string, parentalConsentAcknowledged?: boolean, setupToken?: string): Promise<RegisterResult>;
    verifyEmail(userId: string, code: string, captchaToken?: string): Promise<User>;
    resendVerification(userId: string, captchaToken?: string): Promise<void>;
    login(email: string, password: string, captchaToken?: string): Promise<LoginResult>;
    mfaTotpSetup(): Promise<{ secret: string; qrCodeUrl: string; setupToken: string }>;
    mfaTotpEnable(code: string, setupToken: string): Promise<{ success: boolean; mfaEnabled: boolean }>;
    mfaTotpVerify(mfaToken: string, code: string): Promise<User>;
    mfaPasskeyAuthOptions(mfaToken: string): Promise<{ options: unknown; challengeToken: string }>;
    mfaPasskeyAuthVerify(challengeToken: string, credential: unknown): Promise<User>;
    mfaPasskeyRegisterOptions(): Promise<{ options: unknown; challengeToken: string }>;
    mfaPasskeyRegisterVerify(challengeToken: string, credential: unknown, name?: string): Promise<{ success: boolean }>;
    mfaPasskeyRegisterSession(): Promise<{ sessionToken: string }>;
    mfaPhoneSetup(phoneNumber: string): Promise<{ success: boolean }>;
    mfaPhoneVerifySetup(code: string): Promise<{ success: boolean; mfaEnabled: boolean }>;
    mfaPhoneSend(mfaToken: string): Promise<{ success: boolean }>;
    mfaPhoneVerify(mfaToken: string, code: string): Promise<User>;
    mfaDisable(password: string): Promise<{ success: boolean }>;
    mfaTotpDisable(password: string): Promise<{ success: boolean }>;
    mfaPhoneDisable(password: string): Promise<{ success: boolean }>;
    mfaStatus(): Promise<MfaStatus>;
    forgotPassword(email: string, captchaToken?: string): Promise<{ success: boolean }>;
    resetPassword(email: string, code: string, newPassword: string, captchaToken?: string): Promise<{ success: boolean }>;
    generateRecoveryCodes(password: string): Promise<{ codes: string[] }>;
    verifyRecoveryCode(mfaToken: string, code: string): Promise<LoginResult>;
    verifyEmailAuthenticated(code: string): Promise<User>;
    resendVerificationAuthenticated(): Promise<void>;
    completeOnboarding(dateOfBirth: string, password?: string, email?: string): Promise<{ success: boolean }>;
    passkeyLoginOptions(): Promise<{ options: unknown; challengeToken: string }>;
    passkeyLoginVerify(challengeToken: string, credential: unknown): Promise<LoginResult>;
    passkeyLoginForCode(challengeToken: string, credential: unknown): Promise<{ code: string }>;
    passkeyMfaVerifyForCode(challengeToken: string, credential: unknown): Promise<{ code: string }>;
    deletePasskey(passkeyId: string, password: string): Promise<{ success: boolean }>;
    // Device-verification (new-device login challenge for no-MFA users)
    verifyDeviceSend(verifyToken: string, method: 'email' | 'sms'): Promise<{ ok: true }>;
    verifyDeviceConfirm(verifyToken: string, code: string, trustDevice: boolean): Promise<User>;
    listTrustedDevices(): Promise<TrustedDeviceInfo[]>;
    revokeTrustedDevice(id: string): Promise<{ ok: boolean }>;
    revokeAllTrustedDevices(): Promise<{ ok: boolean; count: number }>;
    // One-click security-email actions (token in the URL is the auth; no login required)
    revokeSessions(token: string): Promise<{ success: boolean; revokedCount?: number }>;
    revertEmail(token: string): Promise<{ success: boolean; alreadyReverted?: boolean }>;
  }
}

APIClient.prototype.register = async function(this: APIClient, username: string, email: string, password: string, captchaToken?: string, dateOfBirth?: string, parentalConsentAcknowledged?: boolean, setupToken?: string): Promise<RegisterResult> {
  const data = await this.request<{ requiresVerification?: boolean; userId?: string; user?: BackendUser; token?: string }>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, email, password, captchaToken, dateOfBirth, agreedToTerms: true, ...(parentalConsentAcknowledged !== undefined ? { parentalConsentAcknowledged } : {}), ...(setupToken ? { bootstrapToken: setupToken } : {}) }),
  });
  if (data.requiresVerification) {
    return { requiresVerification: true, userId: data.userId ?? '' };
  }
  if (data.token && data.user) {
    this.setToken(data.token);
    return { requiresVerification: false, user: this.normalizeUser(data.user) };
  }
  throw new Error('Unexpected register response');
};

APIClient.prototype.verifyEmail = async function(this: APIClient, userId: string, code: string, captchaToken?: string): Promise<User> {
  const data = await this.request<AuthResponse>('/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ userId, code, captchaToken }),
  });
  this.setToken(data.token);
  return this.normalizeUser(data.user);
};

APIClient.prototype.resendVerification = async function(this: APIClient, userId: string, captchaToken?: string): Promise<void> {
  await this.request('/auth/resend-verification', { method: 'POST', body: JSON.stringify({ userId, captchaToken }) });
};

APIClient.prototype.login = async function(this: APIClient, email: string, password: string, captchaToken?: string): Promise<LoginResult> {
  const data = await this.request<AuthResponse & { mfaRequired?: boolean; mfaToken?: string; methods?: string[]; requiresVerification?: boolean; userId?: string; verificationRequired?: boolean; verifyToken?: string; emailMasked?: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password, captchaToken }),
  });
  if (data.mfaRequired && data.mfaToken) {
    return { mfaRequired: true, mfaToken: data.mfaToken, methods: data.methods || [] };
  }
  if (data.verificationRequired && data.verifyToken) {
    return {
      verificationRequired: true,
      verifyToken: data.verifyToken,
      methods: data.methods || ['email'],
      emailMasked: data.emailMasked || '',
    };
  }
  if (data.requiresVerification && data.userId) {
    return { requiresVerification: true, userId: data.userId };
  }
  this.setToken(data.token);
  return { user: this.normalizeUser(data.user) };
};

APIClient.prototype.mfaTotpSetup = async function(this: APIClient): Promise<{ secret: string; qrCodeUrl: string; setupToken: string }> {
  return this.request('/auth/mfa/totp/setup', { method: 'POST' });
};

APIClient.prototype.mfaTotpEnable = async function(this: APIClient, code: string, setupToken: string): Promise<{ success: boolean; mfaEnabled: boolean }> {
  return this.request('/auth/mfa/totp/enable', { method: 'POST', body: JSON.stringify({ code, setupToken }) });
};

APIClient.prototype.mfaTotpVerify = async function(this: APIClient, mfaToken: string, code: string): Promise<User> {
  const data = await this.request<AuthResponse>('/auth/mfa/totp/verify', {
    method: 'POST',
    body: JSON.stringify({ mfaToken, code }),
  });
  this.setToken(data.token);
  return this.normalizeUser(data.user);
};

APIClient.prototype.mfaPasskeyAuthOptions = async function(this: APIClient, mfaToken: string): Promise<{ options: unknown; challengeToken: string }> {
  return this.request('/auth/mfa/passkey/auth-options', { method: 'POST', body: JSON.stringify({ mfaToken }) });
};

APIClient.prototype.mfaPasskeyAuthVerify = async function(this: APIClient, challengeToken: string, credential: unknown): Promise<User> {
  const data = await this.request<AuthResponse>('/auth/mfa/passkey/auth-verify', {
    method: 'POST',
    body: JSON.stringify({ challengeToken, credential }),
  });
  this.setToken(data.token);
  return this.normalizeUser(data.user);
};

APIClient.prototype.mfaPasskeyRegisterOptions = async function(this: APIClient): Promise<{ options: unknown; challengeToken: string }> {
  return this.request('/auth/mfa/passkey/register-options', { method: 'POST' });
};

APIClient.prototype.mfaPasskeyRegisterVerify = async function(this: APIClient, challengeToken: string, credential: unknown, name?: string): Promise<{ success: boolean }> {
  return this.request('/auth/mfa/passkey/register-verify', { method: 'POST', body: JSON.stringify({ challengeToken, credential, name }) });
};

APIClient.prototype.mfaPasskeyRegisterSession = async function(this: APIClient): Promise<{ sessionToken: string }> {
  return this.request('/auth/mfa/passkey/register-session', { method: 'POST' });
};

APIClient.prototype.mfaPhoneSetup = async function(this: APIClient, phoneNumber: string): Promise<{ success: boolean }> {
  return this.request('/auth/mfa/phone/setup', { method: 'POST', body: JSON.stringify({ phoneNumber }) });
};

APIClient.prototype.mfaPhoneVerifySetup = async function(this: APIClient, code: string): Promise<{ success: boolean; mfaEnabled: boolean }> {
  return this.request('/auth/mfa/phone/verify-setup', { method: 'POST', body: JSON.stringify({ code }) });
};

APIClient.prototype.mfaPhoneSend = async function(this: APIClient, mfaToken: string): Promise<{ success: boolean }> {
  return this.request('/auth/mfa/phone/send', { method: 'POST', body: JSON.stringify({ mfaToken }) });
};

APIClient.prototype.mfaPhoneVerify = async function(this: APIClient, mfaToken: string, code: string): Promise<User> {
  const data = await this.request<AuthResponse>('/auth/mfa/phone/verify', {
    method: 'POST',
    body: JSON.stringify({ mfaToken, code }),
  });
  this.setToken(data.token);
  return this.normalizeUser(data.user);
};

APIClient.prototype.mfaDisable = async function(this: APIClient, password: string): Promise<{ success: boolean }> {
  return this.request('/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ password }) });
};

APIClient.prototype.mfaTotpDisable = async function(this: APIClient, password: string): Promise<{ success: boolean }> {
  return this.request('/auth/mfa/totp/disable', { method: 'POST', body: JSON.stringify({ password }) });
};

APIClient.prototype.mfaPhoneDisable = async function(this: APIClient, password: string): Promise<{ success: boolean }> {
  return this.request('/auth/mfa/phone/disable', { method: 'POST', body: JSON.stringify({ password }) });
};

APIClient.prototype.mfaStatus = async function(this: APIClient): Promise<MfaStatus> {
  return this.request('/auth/mfa/status');
};

APIClient.prototype.forgotPassword = async function(this: APIClient, email: string, captchaToken?: string): Promise<{ success: boolean }> {
  return this.request('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email, captchaToken }),
  });
};

APIClient.prototype.resetPassword = async function(this: APIClient, email: string, code: string, newPassword: string, captchaToken?: string): Promise<{ success: boolean }> {
  return this.request('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ email, code, newPassword, captchaToken }),
  });
};

APIClient.prototype.revokeSessions = async function(this: APIClient, token: string): Promise<{ success: boolean; revokedCount?: number }> {
  return this.request('/auth/revoke-sessions', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
};

APIClient.prototype.revertEmail = async function(this: APIClient, token: string): Promise<{ success: boolean; alreadyReverted?: boolean }> {
  return this.request('/auth/email/revert', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
};

APIClient.prototype.generateRecoveryCodes = async function(this: APIClient, password: string): Promise<{ codes: string[] }> {
  return this.request('/auth/mfa/recovery-codes/generate', { method: 'POST', body: JSON.stringify({ password }) });
};

APIClient.prototype.verifyEmailAuthenticated = async function(this: APIClient, code: string): Promise<User> {
  const data = await this.request<{ user: BackendUser; alreadyVerified?: boolean }>('/auth/verify-email-authenticated', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  if (data.alreadyVerified) {
    // Re-fetch the full user
    return this.me();
  }
  return this.normalizeUser(data.user);
};

APIClient.prototype.resendVerificationAuthenticated = async function(this: APIClient): Promise<void> {
  await this.request('/auth/resend-verification-authenticated', { method: 'POST' });
};

APIClient.prototype.completeOnboarding = async function(this: APIClient, dateOfBirth: string, password?: string, email?: string): Promise<{ success: boolean }> {
  return this.request('/auth/complete-onboarding', {
    method: 'POST',
    body: JSON.stringify({ dateOfBirth, agreedToTerms: true, ...(password ? { password } : {}), ...(email ? { email } : {}) }),
  });
};

APIClient.prototype.passkeyLoginOptions = async function(this: APIClient): Promise<{ options: unknown; challengeToken: string }> {
  return this.request('/auth/mfa/passkey/login-options', { method: 'POST' });
};

APIClient.prototype.passkeyLoginVerify = async function(this: APIClient, challengeToken: string, credential: unknown): Promise<LoginResult> {
  const data = await this.request<AuthResponse>('/auth/mfa/passkey/login-verify', {
    method: 'POST',
    body: JSON.stringify({ challengeToken, credential }),
  });
  this.setToken(data.token);
  return { user: this.normalizeUser(data.user) };
};

APIClient.prototype.passkeyLoginForCode = async function(this: APIClient, challengeToken: string, credential: unknown): Promise<{ code: string }> {
  return this.request('/auth/mfa/passkey/login-for-code', {
    method: 'POST',
    body: JSON.stringify({ challengeToken, credential }),
  });
};

APIClient.prototype.passkeyMfaVerifyForCode = async function(this: APIClient, challengeToken: string, credential: unknown): Promise<{ code: string }> {
  return this.request('/auth/mfa/passkey/auth-verify-for-code', {
    method: 'POST',
    body: JSON.stringify({ challengeToken, credential }),
  });
};

APIClient.prototype.deletePasskey = async function(this: APIClient, passkeyId: string, password: string): Promise<{ success: boolean }> {
  return this.request(`/auth/mfa/passkey/${passkeyId}`, { method: 'DELETE', body: JSON.stringify({ password }) });
};

APIClient.prototype.verifyDeviceSend = async function(this: APIClient, verifyToken: string, method: 'email' | 'sms'): Promise<{ ok: true }> {
  return this.request('/auth/verify-device/send', {
    method: 'POST',
    body: JSON.stringify({ verifyToken, method }),
  });
};

APIClient.prototype.verifyDeviceConfirm = async function(this: APIClient, verifyToken: string, code: string, trustDevice: boolean): Promise<User> {
  const data = await this.request<AuthResponse>('/auth/verify-device/confirm', {
    method: 'POST',
    body: JSON.stringify({ verifyToken, code, trustDevice }),
  });
  this.setToken(data.token);
  return this.normalizeUser(data.user);
};

APIClient.prototype.listTrustedDevices = async function(this: APIClient): Promise<TrustedDeviceInfo[]> {
  const data = await this.request<{ devices: TrustedDeviceInfo[] }>('/auth/trusted-devices');
  return data.devices;
};

APIClient.prototype.revokeTrustedDevice = async function(this: APIClient, id: string): Promise<{ ok: boolean }> {
  return this.request(`/auth/trusted-devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
};

APIClient.prototype.revokeAllTrustedDevices = async function(this: APIClient): Promise<{ ok: boolean; count: number }> {
  return this.request('/auth/trusted-devices', { method: 'DELETE' });
};

APIClient.prototype.verifyRecoveryCode = async function(this: APIClient, mfaToken: string, code: string): Promise<LoginResult> {
  const data = await this.request<AuthResponse & { mfaRequired?: boolean; mfaToken?: string; methods?: string[] }>('/auth/mfa/recovery/verify', {
    method: 'POST',
    body: JSON.stringify({ mfaToken, code }),
  });
  if (data.token) {
    this.setToken(data.token);
  }
  if (data.user) {
    return { user: this.normalizeUser(data.user as unknown as BackendUser) };
  }
  throw new Error('Recovery code verification failed');
};
