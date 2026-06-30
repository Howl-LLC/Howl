// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { User } from '../types';

// Backend response shapes (used internally by APIClient)

export interface BackendUser {
  id: string;
  username: string;
  discriminator?: string;
  email?: string;
  status?: string;
  avatar?: string | null;
  banner?: string | null;
  bannerPositionY?: number | null;
  bannerZoom?: number | null;
  createdAt?: string;
  stripePlan?: string | null;
  effectivePlan?: string | null;
  nameColor?: string | null;
  nameFont?: string | null;
  nameEffect?: string | null;
  avatarEffect?: string | null;
  badges?: string[];
  mfaEnabled?: boolean;
  backgroundImage?: string | null;
  backgroundOpacity?: number;
  backgroundBlur?: number;
  bgGifAlwaysPlay?: boolean;
  activity?: {
    type: string;
    name: string;
    details?: string | null;
    state?: string | null;
    largeImage?: string | null;
    smallImage?: string | null;
    startedAt: string;
    platformId?: string | null;
    platform?: string | null;
    durationMs?: number | null;
  } | null;
  secondaryActivity?: {
    type: string;
    name: string;
    details?: string | null;
    state?: string | null;
    largeImage?: string | null;
    smallImage?: string | null;
    startedAt: string;
    platformId?: string | null;
    platform?: string | null;
    durationMs?: number | null;
  } | null;
  customStatus?: string;
  activityBio?: string | null;
  needsDateOfBirth?: boolean;
  needsOnboarding?: boolean;
  emailVerified?: boolean;
  hasPassword?: boolean;
  /** True when DOB-derived age is < 18. Server-computed in /api/v1/auth/me
   *  (see profile.ts). Used by the per-channel age-gate UI to branch state. */
  isMinor?: boolean;
  connectedApps?: Array<{ id: string; provider: string; displayName: string | null; avatarUrl: string | null }>;
}

export interface AuthResponse {
  user: BackendUser;
  token: string;
}

export interface BackendReplyTo {
  id: string;
  authorId: string;
  authorUsername?: string | null;
  content: string;
}

export interface BackendMessage {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  type?: string;
  systemPayload?: Record<string, unknown> | null;
  replyTo?: BackendReplyTo | null;
  createdAt: string;
  editedAt?: string | null;
  authorUsername?: string | null;
  authorDiscriminator?: string | null;
  authorAvatar?: string | null;
  authorRoleColor?: string | null;
  authorRoleStyle?: string;
  attachmentUrl?: string | null;
  attachmentName?: string | null;
  attachmentContentType?: string | null;
  attachmentWidth?: number | null;
  attachmentHeight?: number | null;
  /** Per-attachment spoiler marker (sender-set, always blurs until clicked). */
  attachmentIsSpoiler?: boolean;
  /** Alt text for accessibility (max 500 chars). */
  attachmentAlt?: string | null;
  forwarded?: boolean;
  authorStripePlan?: string | null;
  authorNameColor?: string | null;
  authorNameFont?: string | null;
  authorNameEffect?: string | null;
  authorAvatarEffect?: string | null;
}

export interface BackendDMMessage {
  id: string;
  dmChannelId: string;
  authorId: string;
  content: string;
  type?: string;
  systemPayload?: { kind: string; messageId?: string } | null;
  replyTo?: BackendReplyTo | null;
  createdAt: string;
  editedAt?: string | null;
  authorUsername?: string | null;
  authorDiscriminator?: string | null;
  authorAvatar?: string | null;
  attachmentUrl?: string | null;
  attachmentName?: string | null;
  attachmentContentType?: string | null;
  attachmentWidth?: number | null;
  attachmentHeight?: number | null;
  /** Per-attachment spoiler marker. DM E2EE: plaintext metadata only. */
  attachmentIsSpoiler?: boolean;
  /** Alt text for accessibility (DM: plaintext metadata, max 500 chars). */
  attachmentAlt?: string | null;
  forwarded?: boolean;
  authorStripePlan?: string | null;
  authorNameColor?: string | null;
  authorNameFont?: string | null;
  authorNameEffect?: string | null;
  authorAvatarEffect?: string | null;
}

// Public API types (exported for consumer use)

export interface UserPreferences {
  notifyDesktop: boolean;
  notifyUnreadBadge: boolean;
  notifyTaskbarFlash: boolean;
  notifySoundNewMessage: boolean;
  notifySoundCurrentChannel: boolean;
  notifySoundIncomingRing: boolean;
  notifyDisableAllSounds: boolean;
  allowDmFromServerMembers: boolean;
  messageRequestsFilter: boolean;
  friendRequestsEveryone: boolean;
  friendRequestsFriendsOfFriends: boolean;
  friendRequestsServerMembers: boolean;
  showOnlineStatus: string;
  showJoinDate: boolean;
  showBadges: boolean;
  badgeDisplay?: { hidden: string[]; order: string[] };
  showCurrentActivity: string;
  shareDetectedGames: boolean;
  shareSteamActivity: boolean;
  activitySharingEnabled: boolean;
  activityShareScope: string;
  activitySourcePriority: string;
  shareActivityBio: boolean;
  shareSpotifyActivity: boolean;
  shareTwitchActivity: boolean;
  shareYouTubeActivity: boolean;
  profilePrivate: boolean;
  /**
   * Hide this user's activity from public discovery rankings
   * (e.g. "trending in your region" lists). Default false.
   */
  discoveryOptOut?: boolean;
}

export interface SessionInfo {
  id: string;
  deviceName: string;
  deviceType: string;
  os: string;
  ip: string | null;
  lastActiveAt: string;
  createdAt: string;
  isCurrent: boolean;
}

export interface TrustedDeviceInfo {
  id: string;
  label: string | null;
  deviceType: string | null;
  lastSeenAt: string;
  expiresAt: string;
  createdAt: string;
  activeSessions: Array<{
    id: string;
    deviceName: string;
    deviceType: string;
    os: string;
    lastActiveAt: string;
  }>;
}

export interface FamilyLinkInfo {
  id: string;
  parentId: string;
  childId: string;
  status: string;
  unlinkRequestedAt: string | null;
  createdAt: string;
  role: 'parent' | 'child';
  parent: { id: string; username: string; discriminator?: string; avatar?: string };
  child: { id: string; username: string; discriminator?: string; avatar?: string };
  restriction: FamilyRestrictions | null;
}

export interface FamilyRestrictions {
  id: string;
  familyLinkId: string;
  blockDmFromNonFriends: boolean;
  blockServerJoin: boolean;
  dailyTimeLimitMinutes: number | null;
}

export interface FamilyActivity {
  childId: string;
  weeklyMessageCount: number;
  serverCount: number;
  recentSessions: Array<{ deviceName: string; os: string; lastActiveAt: string }>;
}

export type RegisterResult =
  | { requiresVerification: true; userId: string; user?: undefined }
  | { requiresVerification: false; user: User; userId?: undefined };

export type LoginResult =
  | { mfaRequired: true; mfaToken: string; methods: string[]; user?: undefined; requiresVerification?: undefined; verificationRequired?: undefined; userId?: undefined; verifyToken?: undefined; emailMasked?: undefined }
  | { requiresVerification: true; userId: string; mfaRequired?: undefined; mfaToken?: undefined; methods?: undefined; user?: undefined; verificationRequired?: undefined; verifyToken?: undefined; emailMasked?: undefined }
  | { verificationRequired: true; verifyToken: string; methods: string[]; emailMasked: string; mfaRequired?: undefined; mfaToken?: undefined; user?: undefined; requiresVerification?: undefined; userId?: undefined }
  | { user: User; mfaRequired?: undefined; mfaToken?: undefined; methods?: undefined; requiresVerification?: undefined; userId?: undefined; verificationRequired?: undefined; verifyToken?: undefined; emailMasked?: undefined };

export interface MfaStatus {
  mfaEnabled: boolean;
  totpConfigured: boolean;
  phoneConfigured: boolean;
  phoneLast4: string | null;
  passkeys: Array<{ id: string; name: string; createdAt: string }>;
  hasRecoveryCodes: boolean;
  hasPassword: boolean;
}

export interface PowerUpStatus {
  totalSlots: number;
  freeSlots: number;
  paidSlots: number;
  used: number;
  available: number;
  powerUps: Array<{
    id: string;
    serverId: string;
    serverName: string;
    serverIcon: string | null;
    serverPowerUpCount: number;
    serverPowerUpTier: number;
    createdAt: string;
  }>;
}

export interface PowerUpableServer {
  id: string;
  name: string;
  icon: string | null;
  powerUpCount: number;
  powerUpTier: number;
  myPowerUpCount: number;
}
