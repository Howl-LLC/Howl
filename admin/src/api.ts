// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
const API_BASE = import.meta.env.VITE_API_URL || '/api';

/** Resolve a relative asset URL (e.g. `/api/uploads/foo.png`) to an absolute URL using the configured API base. */
export function resolveUrl(url: string | null | undefined): string {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:') || url.startsWith('blob:')) return url;
  if (url.startsWith('/api/') && API_BASE !== '/api') {
    return API_BASE + url.slice(4);
  }
  return url;
}

export interface AdminStats {
  totalUsers: number;
  onlineUsers: number;
  proUsers: number;
  essentialUsers: number;
  mfaUsers: number;
  unverifiedUsers: number;
  suspendedUsers: number;
  deactivatedUsers: number;
  trialUsers: number;
  newUsers24h: number;
  totalServers: number;
  pendingReports: number;
}

export interface AdminUserSummary {
  id: string;
  username: string;
  discriminator: string;
  email: string;
  avatar: string | null;
  status: string;
  stripePlan: string | null;
  createdAt: string;
  mfaEnabled: boolean;
  emailVerified: boolean;
}

export interface ConnectedApp {
  id: string;
  provider: string;
  createdAt: string;
}

export interface FamilyLinkAsParent {
  id: string;
  childId: string;
  status: string;
  createdAt: string;
  child: { username: string; discriminator: string; avatar: string | null };
}

export interface FamilyLinkAsChild {
  id: string;
  parentId: string;
  status: string;
  createdAt: string;
  parent: { username: string; discriminator: string; avatar: string | null };
}

export interface AdminUserDetail extends AdminUserSummary {
  suspended: boolean;
  suspendedAt: string | null;
  suspendReason: string | null;
  dateOfBirth: string | null;
  banner: string | null;
  stripeStatus: string | null;
  stripePeriodEnd: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  hasMfaTotp: boolean;
  hasMfaPhone: boolean;
  phoneLast4: string | null;
  mfaPhoneVerified: boolean;
  nameColor: string | null;
  nameFont: string | null;
  nameEffect: string | null;
  avatarEffect: string | null;
  lastDiscriminatorChange: string | null;
  role: string;
  deactivated: boolean;
  deactivatedAt: string | null;
  needsOnboarding: boolean;
  tosAcceptedAt: string | null;
  privacyPolicyAcceptedAt: string | null;
  legalConsentVersion: string | null;
  powerUpSubscriptionId: string | null;
  powerUpPaidSlots: number;
  hasUsedSubscriptionRefund: boolean;
  hasUsedGiftRefund: boolean;
  hasUsedPowerUpRefund: boolean;
  badges: string[];
  computedBadges: string[];
  ssoAccounts: Array<{ id: string; provider: string; email: string | null }>;
  sessions: Array<{ id: string; deviceName: string; os: string; lastActiveAt: string; createdAt: string }>;
  serverMembers: Array<{ serverId: string; role: string; server: { name: string } }>;
  _count: { friendRequestsSent: number; friendRequestsReceived: number; blockedUsers: number };
  connectedApps: ConnectedApp[];
  familyLinksAsParent: FamilyLinkAsParent[];
  familyLinksAsChild: FamilyLinkAsChild[];
}

export interface BillingHistoryCharge {
  id: string;
  amount: number;
  currency: string;
  status: string;
  description: string | null;
  created: number;
  refunded: boolean;
  refundedAmount: number;
  paymentMethod: string | null;
  invoiceId: string | null;
}

export interface BillingHistoryGift {
  id: string;
  code: string;
  plan: string;
  durationMonths: number;
  status: string;
  createdAt: string;
  redeemedAt: string | null;
  expiresAt: string | null;
  stripePaymentIntentId: string | null;
  recipientUsername?: string | null;
  recipient?: { username: string; discriminator: string } | null;
  sender?: { username: string; discriminator: string } | null;
}

export interface BillingHistoryTrial {
  id: string;
  plan: string;
  status: string;
  trialResult: string | null;
  resultMessage: string | null;
  fingerprint: string | null;
  createdAt: string;
}

export interface BillingHistory {
  stripeCustomerId: string | null;
  stripeCharges: BillingHistoryCharge[];
  giftsSent: BillingHistoryGift[];
  giftsReceived: BillingHistoryGift[];
  trialAttempts: BillingHistoryTrial[];
}

export interface AdminServerSummary {
  id: string;
  name: string;
  icon: string | null;
  powerUpCount: number;
  powerUpTier: number;
  powerUpStatus: string | null;
  powerUpPeriodEnd: string | null;
  memberCount: number;
  channelCount: number;
  createdAt: string;
}

export interface AdminServerRole {
  id: string;
  name: string;
  color: string;
  position: number;
  locked: boolean;
  memberCount: number;
}

export interface AdminServerDetail extends AdminServerSummary {
  banner: string | null;
  realPowerUpCount: number;
  /** T&S flag snapshot — populated by GET /admin/servers/:id so the Server
   *  Actions page can hydrate its button labels (Grant vs Revoke) instead
   *  of starting from an all-false default. Optional for older backends. */
  featured?: boolean;
  verified?: boolean;
  hiddenFromDiscovery?: boolean;
  suspended?: boolean;
  discoveryListingOverride?: boolean;
  channels: Array<{ id: string; name: string; type: string }>;
  roles: AdminServerRole[];
  powerUps: Array<{ id: string; createdAt: string; user: { id: string; username: string; discriminator: string; avatar: string | null } }>;
  members: Array<{ id: string; username: string; discriminator: string; avatar: string | null; status: string; role: string; serverRole: { id: string; name: string; color: string; position: number } | null; joinedAt: string | null }>;
}

export interface AdminAuditEntry {
  id: string;
  adminId: string;
  action: string;
  targetUserId: string;
  details: Record<string, unknown> | null;
  createdAt: string;
  admin: { id: string; username: string; email: string };
  targetUser: { id: string; username: string; discriminator: string; avatar: string | null } | null;
}

export interface AuditLogFilters {
  action?: string;
  adminId?: string;
  targetUserId?: string;
  targetName?: string;
}

export interface AdminDataRequest {
  id: string;
  userId: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  error: string | null;
  user: {
    id: string;
    username: string;
    discriminator: string;
    email: string;
    avatar: string | null;
  };
}

export interface AdminReport {
  id: string;
  reporterId: string | null;
  messageType: string;
  messageId: string;
  channelId: string | null;
  dmChannelId: string | null;
  authorId: string | null;
  content: string;
  attachmentUrl: string | null;
  reason: string;
  details: string | null;
  status: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNotes: string | null;
  actionTaken: string | null;
  ncmecReportId: string | null;
  contentSource: 'server' | 'reporter_disclosed' | 'unavailable';
  // §2258A forensic + identity-snapshot fields. Populated for CSAM-tagged
  // reports either at upload-block time (gold standard) or at admin-action
  // time (best-effort lookup, may be unavailable past 90-day session window).
  uploaderIp: string | null;
  uploaderUserAgent: string | null;
  sha256: string | null;
  intendedSource: string | null;
  intendedSourceId: string | null;
  evidenceSource: 'upload-block' | 'action-time-lookup' | 'action-time-unavailable' | null;
  evidenceCapturedAt: string | null;
  preservedAt: string | null;
  authorUsernameSnapshot: string | null;
  authorDiscriminatorSnapshot: string | null;
  authorEmailHashSnapshot: string | null;
  authorRegisteredAtSnapshot: string | null;
  createdAt: string;
  updatedAt: string;
  reporter: { id: string; username: string; discriminator: string; avatar: string | null } | null;
  author: { id: string; username: string; discriminator: string; avatar: string | null } | null;
}

export interface ReportStats {
  pending: number;
  reviewed: number;
  actioned: number;
  dismissed: number;
  total: number;
  csamPending: number;
}

export interface ServerFilters {
  powerUpTier?: string;
  minMembers?: string;
}

export interface AuthUser {
  id: string;
  username: string;
  email?: string;
  role?: string;
  forcePasswordChange?: boolean;
}

export interface AdminAccount {
  id: string;
  username: string;
  email: string;
  role: string;
  mfaEnabled: boolean;
  forcePasswordChange: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface UserFilters {
  plan?: string;
  status?: string;
  verified?: string;
}

// Analytics

export interface AnalyticsSnapshot {
  id: string;
  timestamp: string;
  region: string;
  onlineCount: number;
  /** Only present for aggregated (30d/3mo/6mo) snapshots */
  date?: string;
}

export interface AnalyticsResponse {
  snapshots: AnalyticsSnapshot[];
  currentByRegion: Record<string, number>;
  totalOnline: number;
}

export interface ProtocolDistributionResponse {
  snapshots: Array<{
    timestamp: string;
    date?: string; // present for 30d/60d daily aggregation
    buildDate: string | null;
    platform: string;
    protocolVersion: number | null;
    count: number;
  }>;
  current: {
    byPlatform: Record<string, { total: number; byBuildDate: Record<string, number> }>;
    atOrAboveThreshold?: Record<string, { total: number; meeting: number; pct: number }>;
  };
}

// Server Moderation

export interface AdminServerSettings {
  id: string;
  serverId: string;
  description: string | null;
  verificationLevel: string;
  contentFilter: string;
  dmSpamFilter: boolean;
  welcomeMessage: string | null;
  welcomeEnabled: boolean;
  defaultNotifications: string;
  joinMethod: string;
  rules: string[] | null;
  communityEnabled: boolean;
  discoveryEnabled: boolean;
  messageRetentionDays: number | null;
  auditLogRetentionDays: number;
  blockedNicknames: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminServerBan {
  id: string;
  userId: string;
  reason: string | null;
  createdAt: string;
  user: { id: string; username: string; discriminator: string; avatar: string | null } | null;
  bannedBy: { id: string; username: string; discriminator: string; avatar: string | null } | null;
}

export interface AdminServerAuditEntry {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
  actor: { id: string; username: string; avatar: string | null } | null;
}

export interface AdminAutomodRule {
  id: string;
  serverId: string;
  name: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown> | null;
  createdAt: string;
}

// Forums

export interface AdminForumPost {
  id: string;
  title: string;
  locked: boolean;
  pinned: boolean;
  messageCount: number;
  createdAt: string;
  lastActivityAt: string;
  author: { id: string; username: string; discriminator: string; avatar: string | null } | null;
  channel: { id: string; name: string };
  server: { id: string; name: string } | null;
}

// Threads

export interface AdminThread {
  id: string;
  name: string;
  archived: boolean;
  archivedAt: string | null;
  messageCount: number;
  lastActivityAt: string;
  createdAt: string;
  author: { id: string; username: string; discriminator: string; avatar: string | null } | null;
  channel: { id: string; name: string };
  server: { id: string; name: string };
}

// Polls

export interface AdminPollLocation {
  type: 'server' | 'dm' | 'unknown';
  channelId?: string;
  channelName?: string;
  serverId?: string;
  serverName?: string;
  dmChannelId?: string;
}

export interface AdminPoll {
  id: string;
  question: string;
  allowMultiple: boolean;
  anonymous: boolean;
  expiresAt: string | null;
  closedAt: string | null;
  createdAt: string;
  voteCount: number;
  optionCount: number;
  author: { id: string; username: string; discriminator: string; avatar: string | null } | null;
  location: AdminPollLocation;
}

// Invites

export interface AdminInvite {
  id: string;
  code: string;
  serverId: string;
  expiresAt: string | null;
  maxUses: number | null;
  useCount: number;
  temporary: boolean;
  createdAt: string;
  server: { id: string; name: string; icon: string | null };
  inviter: { id: string; username: string; discriminator: string; avatar: string | null } | null;
}

// Community / Discovery / Server T&S types

export interface AdminDiscoveryServer {
  id: string;
  name: string;
  icon: string | null;
  banner: string | null;
  memberCount: number;
  ownerId: string;
  owner: { id: string; username: string; discriminator: string; avatar: string | null } | null;
  description: string | null;
  /** When the server first opted into discovery. */
  optedInAt: string;
  /** Whether the server is currently visible in discovery. */
  discoveryVisible: boolean;
  /** Admin flags — used to badge already-actioned rows. */
  featured: boolean;
  verified: boolean;
  hidden: boolean;
  suspended: boolean;
  /** Pending T&S report count (used to triage). */
  pendingReportCount: number;
  createdAt: string;
}

export interface AdminServerInsights {
  serverId: string;
  windowDays: number;
  /** Distinct users who sent at least one message in the window. */
  activeMembers: number;
  /** New joins during the window. */
  newJoins: number;
  /** Total messages sent in the window (all channels). */
  messagesSent: number;
  /** Server retention rate (returning vs joined) over the window. */
  retentionRate: number;
  /** Visits to the public profile page in the window. */
  publicProfileVisits: number;
  /** Number of currently-live community features (welcome screen, rules, etc.) */
  communityFeaturesActive: number;
  generatedAt: string;
}

export interface AdminServerReport {
  id: string;
  reporterId: string;
  serverId: string;
  reason: string;
  details: string | null;
  status: 'pending' | 'reviewed' | 'actioned' | 'dismissed';
  actionTaken: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  createdAt: string;
  reporter: { id: string; username: string; discriminator: string; avatar: string | null } | null;
  server: { id: string; name: string; icon: string | null } | null;
}

export interface AdminVerificationRequest {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  organizationName: string;
  websiteUrl: string;
  additionalNotes: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  server: {
    id: string;
    name: string;
    icon: string | null;
    alreadyVerified: boolean;
    createdAt: string;
    memberCount: number;
  };
  submitter: {
    id: string;
    username: string;
    discriminator: string;
    avatar: string | null;
  };
}

/**
 * Prompt handler for sensitive actions that require a fresh password re-entry
 * (email/plan/role changes). Returns the typed password, or null if cancelled.
 * `lastError` is passed on retry so the modal can show "Wrong password".
 * Set from AdminLayout; called transparently by request().
 */
export type StepUpPrompt = (lastError?: string) => Promise<string | null>;

class AdminAPI {
  private token: string | null = null;
  private refreshPromise: Promise<boolean> | null = null;
  private sessionExpiredCallback: (() => void) | null = null;
  private stepUpPrompt: StepUpPrompt | null = null;

  setToken(token: string) {
    this.token = token;
  }

  getToken() {
    return this.token;
  }

  clearToken() {
    this.token = null;
  }

  onSessionExpired(callback: () => void) {
    this.sessionExpiredCallback = callback;
  }

  onStepUpRequired(prompt: StepUpPrompt) {
    this.stepUpPrompt = prompt;
  }

  async stepUp(password: string): Promise<{ success: boolean }> {
    return this.request('/admin/auth/step-up', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  }

  async refreshAccessToken(): Promise<boolean> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        const res = await fetch(`${API_BASE}/admin/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok) return false;
        const data = await res.json();
        if (data.token) {
          this.token = data.token;
          return true;
        }
        return false;
      } catch {
        return false;
      } finally {
        this.refreshPromise = null;
      }
    })();
    return this.refreshPromise;
  }

  private async request<T>(endpoint: string, options: RequestInit & { _retried?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    };
    const token = this.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    let res: Response;
    try {
      res = await fetch(`${API_BASE}${endpoint}`, {
        ...options, headers, credentials: 'include', signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Request timed out. Please check your connection and try again.');
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    // 401 handling — could be either an expired access token OR a fresh
    // step-up requirement. Peek at the JSON body to distinguish; only
    // expired tokens should trigger the silent refresh+retry.
    if (res.status === 401 && !options._retried) {
      let body: { requiresStepUp?: boolean; error?: string } | null = null;
      const text = await res.clone().text().catch(() => '');
      try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }

      if (body?.requiresStepUp && this.stepUpPrompt && !(endpoint === '/admin/auth/step-up')) {
        // Sensitive action (e.g. change email/plan/role). Prompt for password,
        // grant step-up, replay the original request. Up to 3 attempts so a
        // typo doesn't force the user to re-click the original action.
        let lastError: string | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          const password = await this.stepUpPrompt(lastError);
          if (!password) throw new Error('Step-up cancelled');
          try {
            await this.stepUp(password);
            return this.request<T>(endpoint, { ...options, _retried: true });
          } catch (err) {
            lastError = err instanceof Error ? err.message : 'Wrong password';
          }
        }
        throw new Error('Too many failed step-up attempts. Try again later.');
      }

      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        return this.request<T>(endpoint, { ...options, _retried: true });
      }
      this.sessionExpiredCallback?.();
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = `Request failed (${res.status})`;
      try {
        const body = text ? JSON.parse(text) : null;
        if (body?.error) message = body.error;
      } catch {
        if (text && text.length < 200) message = text;
      }
      throw new Error(message);
    }
    if (res.status === 204) return undefined as T;
    return res.json();
  }

  async login(email: string, password: string): Promise<{
    mfaRequired?: boolean;
    mfaToken?: string;
    enrollmentRequired?: boolean;
    enrollmentToken?: string;
    mfaEnabled?: boolean;
    passkeyCount?: number;
  }> {
    return this.request('/admin/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  }

  async verifyMfaLogin(mfaToken: string, code: string): Promise<{ passkeyRequired: true; passkeyToken: string }> {
    return this.request('/admin/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ mfaToken, code }),
    });
  }

  async passkeyLoginBegin(passkeyToken: string): Promise<{ options: any; challengeToken: string }> {
    return this.request('/admin/auth/passkey/login/begin', {
      method: 'POST',
      body: JSON.stringify({ passkeyToken }),
    });
  }

  async passkeyLoginFinish(challengeToken: string, credential: any): Promise<{ user: AuthUser; token: string }> {
    return this.request('/admin/auth/passkey/login/finish', {
      method: 'POST',
      body: JSON.stringify({ challengeToken, credential }),
    });
  }

  /**
   * During enrollment the browser holds an enrollmentToken instead of a
   * real admin JWT. passkey/register endpoints + mfa/setup + mfa/enable
   * all accept either; this override swaps the Authorization header for
   * one call. Separate method so we don't accidentally leak enrollment
   * tokens through setToken() + clearToken().
   */
  private async requestWithToken<T>(endpoint: string, token: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(options.headers as Record<string, string> || {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = `Request failed (${res.status})`;
      try {
        const body = text ? JSON.parse(text) : null;
        if (body?.error) message = body.error;
      } catch {
        if (text && text.length < 200) message = text;
      }
      throw new Error(message);
    }
    if (res.status === 204) return undefined as T;
    return res.json();
  }

  async enrollmentSetupMfa(enrollmentToken: string): Promise<{ setupToken: string; uri: string; qrCodeDataUrl: string }> {
    return this.requestWithToken('/admin/auth/mfa/setup', enrollmentToken, { method: 'POST' });
  }

  async enrollmentEnableMfa(enrollmentToken: string, setupToken: string, code: string): Promise<{ success: boolean }> {
    return this.requestWithToken('/admin/auth/mfa/enable', enrollmentToken, {
      method: 'POST',
      body: JSON.stringify({ setupToken, code }),
    });
  }

  async enrollmentPasskeyRegisterBegin(enrollmentToken: string): Promise<{ options: any; challengeToken: string }> {
    return this.requestWithToken('/admin/auth/passkey/register/begin', enrollmentToken, { method: 'POST' });
  }

  async enrollmentPasskeyRegisterFinish(enrollmentToken: string, challengeToken: string, credential: any, friendlyName: string): Promise<{ success: boolean }> {
    return this.requestWithToken('/admin/auth/passkey/register/finish', enrollmentToken, {
      method: 'POST',
      body: JSON.stringify({ challengeToken, credential, friendlyName }),
    });
  }

  async enrollmentComplete(enrollmentToken: string): Promise<{ user: AuthUser; token: string }> {
    return this.request('/admin/auth/enrollment/complete', {
      method: 'POST',
      body: JSON.stringify({ enrollmentToken }),
    });
  }

  async passkeyRegisterBegin(): Promise<{ options: any; challengeToken: string }> {
    return this.request('/admin/auth/passkey/register/begin', { method: 'POST' });
  }

  async passkeyRegisterFinish(challengeToken: string, credential: any, friendlyName: string): Promise<{ success: boolean }> {
    return this.request('/admin/auth/passkey/register/finish', {
      method: 'POST',
      body: JSON.stringify({ challengeToken, credential, friendlyName }),
    });
  }

  async listPasskeys(): Promise<{ passkeys: Array<{ id: string; friendlyName: string; deviceType: string | null; backedUp: boolean; lastUsedAt: string | null; createdAt: string }> }> {
    return this.request('/admin/auth/passkey');
  }

  async deletePasskey(id: string): Promise<{ success: boolean }> {
    return this.request(`/admin/auth/passkey/${id}`, { method: 'DELETE' });
  }

  async getMfaStatus(): Promise<{ mfaEnabled: boolean }> {
    return this.request('/admin/auth/mfa/status');
  }

  async setupMfa(): Promise<{ setupToken: string; uri: string; qrCodeDataUrl: string }> {
    return this.request('/admin/auth/mfa/setup', { method: 'POST' });
  }

  async enableMfa(setupToken: string, code: string): Promise<{ success: boolean }> {
    return this.request('/admin/auth/mfa/enable', {
      method: 'POST',
      body: JSON.stringify({ setupToken, code }),
    });
  }

  async disableAdminMfa(password: string, code: string): Promise<{ success: boolean }> {
    return this.request('/admin/auth/mfa/disable', {
      method: 'POST',
      body: JSON.stringify({ password, code }),
    });
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<{ success: boolean }> {
    return this.request('/admin/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  }

  async logout(): Promise<void> {
    await this.request('/admin/auth/logout', { method: 'POST' }).catch(() => {});
  }

  async me(): Promise<AuthUser> {
    return this.request('/admin/auth/me');
  }

  async getStats(): Promise<AdminStats> {
    return this.request('/admin/stats');
  }

  async searchUsers(q: string, page?: number, filters?: UserFilters): Promise<{ users: AdminUserSummary[]; total: number; page: number; pages: number }> {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (page) params.set('page', String(page));
    if (filters?.plan) params.set('plan', filters.plan);
    if (filters?.status) params.set('status', filters.status);
    if (filters?.verified) params.set('verified', filters.verified);
    const qs = params.toString();
    return this.request(`/admin/users${qs ? `?${qs}` : ''}`);
  }

  async getUser(userId: string): Promise<AdminUserDetail> {
    return this.request(`/admin/users/${userId}`);
  }

  async getBillingHistory(userId: string): Promise<BillingHistory> {
    return this.request(`/admin/users/${userId}/billing-history`);
  }

  async refundCharge(userId: string, data: {
    chargeId: string;
    type: 'subscription' | 'gift' | 'power_up';
    override?: boolean;
    overrideReason?: string;
    reason?: string;
  }): Promise<{ success: boolean; refundId: string; stripeRefundId: string; amount: number; currency: string; type: string }> {
    return this.request(`/admin/users/${userId}/refund`, { method: 'POST', body: JSON.stringify(data) });
  }

  async resetPassword(userId: string): Promise<{ success: boolean; temporaryPassword: string }> {
    return this.request(`/admin/users/${userId}/reset-password`, { method: 'POST' });
  }

  async disableMfa(userId: string): Promise<{ success: boolean }> {
    return this.request(`/admin/users/${userId}/disable-mfa`, { method: 'POST' });
  }

  async setPlan(userId: string, plan: string | null, durationMonths?: number): Promise<{ success: boolean; plan: string | null; periodEnd: string | null; permanent?: boolean; hadStripeSubscription?: boolean }> {
    return this.request(`/admin/users/${userId}/plan`, { method: 'PATCH', body: JSON.stringify({ plan, durationMonths }) });
  }

  async sendResetEmail(userId: string): Promise<{ success: boolean }> {
    return this.request(`/admin/users/${userId}/send-reset-email`, { method: 'POST' });
  }

  async changeEmail(userId: string, email: string): Promise<{ success: boolean; email: string }> {
    return this.request(`/admin/users/${userId}/email`, { method: 'PATCH', body: JSON.stringify({ email }) });
  }

  async changeUsername(userId: string, data: { username?: string; discriminator?: string }): Promise<{ success: boolean; username: string; discriminator: string }> {
    return this.request(`/admin/users/${userId}/username`, { method: 'PATCH', body: JSON.stringify(data) });
  }

  async suspendUser(userId: string, reason?: string): Promise<{ success: boolean }> {
    return this.request(`/admin/users/${userId}/suspend`, { method: 'POST', body: JSON.stringify({ reason }) });
  }

  async unsuspendUser(userId: string): Promise<{ success: boolean }> {
    return this.request(`/admin/users/${userId}/unsuspend`, { method: 'POST' });
  }

  async verifyEmail(userId: string): Promise<{ success: boolean }> {
    return this.request(`/admin/users/${userId}/verify-email`, { method: 'POST' });
  }

  async revokeSessions(userId: string): Promise<{ success: boolean; revokedCount: number }> {
    return this.request(`/admin/users/${userId}/sessions`, { method: 'DELETE' });
  }

  async getServers(q?: string, page?: number): Promise<{ servers: AdminServerSummary[]; total: number; page: number; pages: number }> {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (page) params.set('page', String(page));
    const qs = params.toString();
    return this.request(`/admin/servers${qs ? `?${qs}` : ''}`);
  }

  async getServer(serverId: string): Promise<AdminServerDetail> {
    return this.request(`/admin/servers/${serverId}`);
  }

  async setServerPowerUpTier(serverId: string, tier: number, durationMonths?: number): Promise<{ success: boolean; powerUpCount: number; powerUpTier: number; periodEnd: string | null; permanent: boolean; powerUpStatus: string | null }> {
    return this.request(`/admin/servers/${serverId}/power-up-tier`, { method: 'PATCH', body: JSON.stringify({ tier, durationMonths }) });
  }

  async getAuditLog(page?: number, filters?: AuditLogFilters): Promise<{ entries: AdminAuditEntry[]; total: number; page: number; pages: number }> {
    const params = new URLSearchParams();
    if (page) params.set('page', String(page));
    if (filters?.action) params.set('action', filters.action);
    if (filters?.adminId) params.set('adminId', filters.adminId);
    if (filters?.targetUserId) params.set('targetUserId', filters.targetUserId);
    if (filters?.targetName) params.set('targetName', filters.targetName);
    const qs = params.toString();
    return this.request(`/admin/audit-log${qs ? `?${qs}` : ''}`);
  }

  async getUserAuditLog(userId: string, page?: number): Promise<{ entries: AdminAuditEntry[]; total: number; page: number; pages: number }> {
    const params = new URLSearchParams();
    if (page) params.set('page', String(page));
    const qs = params.toString();
    return this.request(`/admin/users/${userId}/audit-log${qs ? `?${qs}` : ''}`);
  }

  async getServersFiltered(q?: string, page?: number, filters?: ServerFilters): Promise<{ servers: AdminServerSummary[]; total: number; page: number; pages: number }> {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (page) params.set('page', String(page));
    if (filters?.powerUpTier) params.set('powerUpTier', filters.powerUpTier);
    if (filters?.minMembers) params.set('minMembers', filters.minMembers);
    const qs = params.toString();
    return this.request(`/admin/servers${qs ? `?${qs}` : ''}`);
  }

  async getDataRequests(page?: number, status?: string): Promise<{ requests: AdminDataRequest[]; total: number; page: number; pages: number }> {
    const params = new URLSearchParams();
    if (page) params.set('page', String(page));
    if (status) params.set('status', status);
    const qs = params.toString();
    return this.request(`/admin/data-requests${qs ? `?${qs}` : ''}`);
  }

  async approveDataRequest(requestId: string): Promise<{ success: boolean }> {
    return this.request(`/admin/data-requests/${requestId}/approve`, { method: 'POST' });
  }

  async deleteDataRequest(requestId: string): Promise<{ success: boolean }> {
    return this.request(`/admin/data-requests/${requestId}`, { method: 'DELETE' });
  }

  async getReports(page?: number, status?: string): Promise<{ reports: AdminReport[]; total: number; page: number; pages: number }> {
    const params = new URLSearchParams();
    if (page) params.set('page', String(page));
    if (status) params.set('status', status);
    const qs = params.toString();
    return this.request(`/admin/reports${qs ? `?${qs}` : ''}`);
  }

  async getReport(reportId: string): Promise<AdminReport> {
    return this.request(`/admin/reports/${reportId}`);
  }

  async updateReport(reportId: string, data: { status?: string; actionTaken?: string; reviewNotes?: string; ncmecReportId?: string }): Promise<AdminReport> {
    return this.request(`/admin/reports/${reportId}`, { method: 'PATCH', body: JSON.stringify(data) });
  }

  async getReportStats(): Promise<ReportStats> {
    return this.request('/admin/reports/stats/summary');
  }

  async getFlaggedHashes(page = 1, reason?: string) {
    const params = new URLSearchParams({ page: String(page) });
    if (reason) params.set('reason', reason);
    return this.request(`/admin/flagged-hashes?${params}`);
  }

  async addFlaggedHash(hash: string, reason: string, notes?: string) {
    return this.request('/admin/flagged-hashes', {
      method: 'POST',
      body: JSON.stringify({ hash, reason, notes }),
    });
  }

  async removeFlaggedHash(id: string) {
    return this.request(`/admin/flagged-hashes/${id}`, { method: 'DELETE' });
  }

  async flagHashFromReport(reportId: string, reason = 'csam') {
    return this.request('/admin/flagged-hashes/from-report', {
      method: 'POST',
      body: JSON.stringify({ reportId, reason }),
    });
  }

  async runHashSweep(): Promise<{ message: string }> {
    return this.request('/admin/flagged-hashes/sweep', { method: 'POST' });
  }

  async getImageHashes(page = 1, flagMatch?: boolean) {
    const params = new URLSearchParams({ page: String(page) });
    if (flagMatch !== undefined) params.set('flagMatch', String(flagMatch));
    return this.request(`/admin/image-hashes?${params}`);
  }

  // Admin Account Management

  async getAdminAccounts(): Promise<AdminAccount[]> {
    return this.request('/admin/accounts');
  }

  async createAdminAccount(email: string, username: string, password: string, role: string): Promise<AdminAccount> {
    return this.request('/admin/accounts', {
      method: 'POST',
      body: JSON.stringify({ email, username, password, role }),
    });
  }

  async deleteAdminAccount(id: string): Promise<{ success: boolean }> {
    return this.request(`/admin/accounts/${id}`, { method: 'DELETE' });
  }

  async resetAdminPassword(id: string): Promise<{ temporaryPassword: string }> {
    return this.request(`/admin/accounts/${id}/reset-password`, { method: 'POST' });
  }

  async changeAdminRole(id: string, role: string): Promise<{ success: boolean }> {
    return this.request(`/admin/accounts/${id}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
  }

  // Analytics

  async getAnalytics(range?: '24h' | '7d' | '30d' | '3mo' | '6mo'): Promise<AnalyticsResponse> {
    const params = new URLSearchParams();
    if (range) params.set('range', range);
    const qs = params.toString();
    return this.request(`/admin/analytics${qs ? `?${qs}` : ''}`);
  }

  async getProtocolDistribution(
    range: '24h' | '7d' | '14d' | '30d' | '60d' = '14d',
    thresholdBuildDate?: string,
  ): Promise<ProtocolDistributionResponse> {
    const params = new URLSearchParams();
    params.set('range', range);
    if (thresholdBuildDate) params.set('thresholdBuildDate', thresholdBuildDate);
    return this.request(`/admin/analytics/protocol-distribution?${params.toString()}`);
  }

  // Badge Management

  async manageBadge(userId: string, action: 'add' | 'remove', badge: string): Promise<{ success: boolean; badges: string[]; computedBadges: string[] }> {
    return this.request(`/admin/users/${userId}/badges`, {
      method: 'PATCH',
      body: JSON.stringify({ action, badge }),
    });
  }

  // Server Moderation

  async getServerSettings(serverId: string): Promise<{ settings: AdminServerSettings | null }> {
    return this.request(`/admin/servers/${serverId}/settings`);
  }

  async getServerBans(serverId: string, page?: number): Promise<{ bans: AdminServerBan[]; total: number; page: number; pages: number }> {
    const params = new URLSearchParams();
    if (page) params.set('page', String(page));
    const qs = params.toString();
    return this.request(`/admin/servers/${serverId}/bans${qs ? `?${qs}` : ''}`);
  }

  async getServerAuditLog(serverId: string, page?: number, action?: string): Promise<{ entries: AdminServerAuditEntry[]; total: number; page: number; pages: number }> {
    const params = new URLSearchParams();
    if (page) params.set('page', String(page));
    if (action) params.set('action', action);
    const qs = params.toString();
    return this.request(`/admin/servers/${serverId}/audit-log${qs ? `?${qs}` : ''}`);
  }

  async getServerAutomodRules(serverId: string): Promise<{ rules: AdminAutomodRule[] }> {
    return this.request(`/admin/servers/${serverId}/automod-rules`);
  }

  // Forum Moderation

  async getForums(q?: string, page?: number, serverId?: string): Promise<{ posts: AdminForumPost[]; total: number; page: number; pages: number }> {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (page) params.set('page', String(page));
    if (serverId) params.set('serverId', serverId);
    const qs = params.toString();
    return this.request(`/admin/forums${qs ? `?${qs}` : ''}`);
  }

  async lockForumPost(postId: string): Promise<{ success: boolean; locked: boolean }> {
    return this.request(`/admin/forums/${postId}/lock`, { method: 'PATCH' });
  }

  async deleteForumPost(postId: string): Promise<{ success: boolean }> {
    return this.request(`/admin/forums/${postId}`, { method: 'DELETE' });
  }

  // Thread Moderation

  async getThreads(q?: string, page?: number, serverId?: string, archived?: string): Promise<{ threads: AdminThread[]; total: number; page: number; pages: number }> {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (page) params.set('page', String(page));
    if (serverId) params.set('serverId', serverId);
    if (archived) params.set('archived', archived);
    const qs = params.toString();
    return this.request(`/admin/threads${qs ? `?${qs}` : ''}`);
  }

  async archiveThread(threadId: string): Promise<{ success: boolean }> {
    return this.request(`/admin/threads/${threadId}/archive`, { method: 'PATCH' });
  }

  async deleteThread(threadId: string): Promise<{ success: boolean }> {
    return this.request(`/admin/threads/${threadId}`, { method: 'DELETE' });
  }

  // Poll Moderation

  async getPolls(q?: string, page?: number, status?: string): Promise<{ polls: AdminPoll[]; total: number; page: number; pages: number }> {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (page) params.set('page', String(page));
    if (status) params.set('status', status);
    const qs = params.toString();
    return this.request(`/admin/polls${qs ? `?${qs}` : ''}`);
  }

  async closePoll(pollId: string): Promise<{ success: boolean }> {
    return this.request(`/admin/polls/${pollId}/close`, { method: 'PATCH' });
  }

  async deletePoll(pollId: string): Promise<{ success: boolean }> {
    return this.request(`/admin/polls/${pollId}`, { method: 'DELETE' });
  }

  // Invites

  async getInvites(q?: string, page?: number): Promise<{ invites: AdminInvite[]; total: number; page: number; pages: number }> {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (page) params.set('page', String(page));
    const qs = params.toString();
    return this.request(`/admin/invites${qs ? `?${qs}` : ''}`);
  }

  // Community / Discovery / Server T&S
  // Server reports + server T&S endpoints. If the backend route 404s in this
  // worktree, the request() throws — calling pages catch the error and render
  // an empty state.

  async adminDiscoveryQueue(page?: number): Promise<{ servers: AdminDiscoveryServer[]; total: number; page: number; pages: number }> {
    const params = new URLSearchParams();
    if (page) params.set('page', String(page));
    const qs = params.toString();
    return this.request(`/admin/servers/discovery-queue${qs ? `?${qs}` : ''}`);
  }

  async adminServerFeature(serverId: string, reason?: string): Promise<{ success: boolean }> {
    return this.request(`/admin/servers/${serverId}/feature`, { method: 'POST', body: JSON.stringify({ reason }) });
  }
  async adminServerUnfeature(serverId: string, reason?: string): Promise<{ success: boolean }> {
    return this.request(`/admin/servers/${serverId}/unfeature`, { method: 'POST', body: JSON.stringify({ reason }) });
  }
  async adminServerVerify(serverId: string, reason?: string): Promise<{ success: boolean }> {
    return this.request(`/admin/servers/${serverId}/verify`, { method: 'POST', body: JSON.stringify({ reason }) });
  }
  async adminServerUnverify(serverId: string, reason?: string): Promise<{ success: boolean }> {
    return this.request(`/admin/servers/${serverId}/unverify`, { method: 'POST', body: JSON.stringify({ reason }) });
  }
  async adminServerHide(serverId: string, reason: string): Promise<{ success: boolean }> {
    return this.request(`/admin/servers/${serverId}/hide`, { method: 'POST', body: JSON.stringify({ reason }) });
  }
  async adminServerUnhide(serverId: string, reason?: string): Promise<{ success: boolean }> {
    return this.request(`/admin/servers/${serverId}/unhide`, { method: 'POST', body: JSON.stringify({ reason }) });
  }
  async adminServerSuspend(serverId: string, reason: string): Promise<{ success: boolean }> {
    return this.request(`/admin/servers/${serverId}/suspend`, { method: 'POST', body: JSON.stringify({ reason }) });
  }
  async adminServerUnsuspend(serverId: string, reason?: string): Promise<{ success: boolean }> {
    return this.request(`/admin/servers/${serverId}/unsuspend`, { method: 'POST', body: JSON.stringify({ reason }) });
  }
  async adminServerGrantDiscoveryOverride(serverId: string, reason?: string): Promise<{ success: boolean }> {
    return this.request(`/admin/servers/${serverId}/grant-discovery-override`, { method: 'POST', body: JSON.stringify({ reason }) });
  }
  async adminServerRevokeDiscoveryOverride(serverId: string, reason?: string): Promise<{ success: boolean }> {
    return this.request(`/admin/servers/${serverId}/revoke-discovery-override`, { method: 'POST', body: JSON.stringify({ reason }) });
  }

  async adminServerInsights(serverId: string): Promise<AdminServerInsights | null> {
    return this.request(`/admin/servers/${serverId}/insights`);
  }

  async adminServerReportsList(page?: number, status?: string): Promise<{ reports: AdminServerReport[]; total: number; page: number; pages: number }> {
    const params = new URLSearchParams();
    if (page) params.set('page', String(page));
    if (status) params.set('status', status);
    const qs = params.toString();
    return this.request(`/admin/server-reports${qs ? `?${qs}` : ''}`);
  }

  async adminServerReportPatch(reportId: string, data: { status?: string; actionTaken?: string; reviewNote?: string }): Promise<AdminServerReport> {
    return this.request(`/admin/server-reports/${reportId}`, { method: 'PATCH', body: JSON.stringify(data) });
  }

  // "Verified by Howl" application queue

  async adminVerificationRequestsList(
    page?: number,
    status?: string,
  ): Promise<{ requests: AdminVerificationRequest[]; total: number; page: number; pages: number }> {
    const params = new URLSearchParams();
    if (page) params.set('page', String(page));
    if (status) params.set('status', status);
    const qs = params.toString();
    return this.request(`/admin/verification-requests${qs ? `?${qs}` : ''}`);
  }

  async adminVerificationRequestApprove(
    requestId: string,
    decisionNote?: string,
  ): Promise<{ ok: true }> {
    return this.request(`/admin/verification-requests/${requestId}/approve`, {
      method: 'POST',
      body: JSON.stringify(decisionNote ? { decisionNote } : {}),
    });
  }

  async adminVerificationRequestReject(
    requestId: string,
    decisionNote: string,
  ): Promise<{ ok: true }> {
    return this.request(`/admin/verification-requests/${requestId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ decisionNote }),
    });
  }
}

export const adminApi = new AdminAPI();
