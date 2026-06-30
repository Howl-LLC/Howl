// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

/** Check if a server's myPermissions includes a specific permission (or administrator). */
export function serverHasPerm(server: { myRole?: string; myPermissions?: Record<string, boolean> } | null | undefined, perm: string): boolean {
  if (!server) return false;
  if (server.myRole === 'owner') return true;
  const p = server.myPermissions;
  if (!p) return false;
  if (p.administrator === true) return true;
  return p[perm] === true;
}

/** Floating server notification (voice join/leave, new message in other channel) */
export type ServerNotification = {
  id: string;
  type: 'voice_join' | 'voice_leave' | 'text_activity';
  message: string;
  timestamp: number;
  groupKey?: string;
  usernames?: string[];
  channelName?: string;
  count?: number;
};

export interface GameActivity {
  type: 'steam_game' | 'detected_game' | 'custom' | 'bio' | 'spotify' | 'twitch_live' | 'youtube_live';
  name: string;
  details?: string | null;
  state?: string | null;
  largeImage?: string | null;
  smallImage?: string | null;
  startedAt: string;
  platform?: string | null;
  platformId?: string | null;
  durationMs?: number | null;
}

export interface ActivityHistoryEntry {
  id: string;
  type: string;
  name: string;
  details?: string | null;
  largeImage?: string | null;
  smallImage?: string | null;
  platformId?: string | null;
  platform?: string | null;
  startedAt: string;
  endedAt?: string | null;
}

export interface MutualFriend {
  id: string;
  username: string;
  discriminator?: string;
  avatar: string | null;
  status: 'online' | 'idle' | 'dnd' | 'invisible' | 'offline';
  badges?: string[];
  effectivePlan?: string | null;
  nameColor?: string | null;
  nameFont?: string | null;
  nameEffect?: string | null;
  avatarEffect?: string | null;
}

export interface MutualServer {
  id: string;
  name: string;
  icon: string | null;
  memberCount: number;
}

export interface MutualsResponse {
  mutualFriends: MutualFriend[];
  mutualServers: MutualServer[];
}

export interface UserProfileData {
  createdAt: string;
  bio: string | null;
  connections: Array<{ provider: string; displayName: string | null; providerId?: string }>;
  serverJoinedAt?: string;
  /** Every role the user has in the requested server, sorted by hierarchy
   *  (lower `position` = higher rank, like Discord). `@everyone` is filtered
   *  out server-side. */
  serverRoles?: Array<{ id?: string; name: string; color: string | null; style?: string; position?: number }>;
  banner?: string | null;
  bannerPositionY?: number | null;
  bannerZoom?: number | null;
  avatar?: string | null;
  nameColor?: string | null;
  nameFont?: string | null;
  nameEffect?: string | null;
  avatarEffect?: string | null;
  effectivePlan?: string | null;
  private?: boolean;
}

export interface User {
  id: string;
  username: string;
  /** 4-digit discriminator (e.g. "1234") for display as username#1234 */
  discriminator?: string;
  /** User's email (from /auth/me); may be omitted in some contexts. */
  email?: string;
  avatar: string | null;
  /** Profile banner image URL (optional). */
  banner?: string | null;
  /** Banner vertical position as percentage (0=top, 50=center, 100=bottom). */
  bannerPositionY?: number | null;
  /** Banner zoom level as percentage (100=normal, 200=max). */
  bannerZoom?: number | null;
  status: 'online' | 'idle' | 'dnd' | 'invisible' | 'offline';
  rawStatus?: 'online' | 'idle' | 'dnd' | 'invisible' | 'offline';
  customStatus?: string;
  /** Currently active game/activity (from server polling or client detection) */
  activity?: GameActivity | null;
  /** Secondary concurrent activity (e.g. Spotify while gaming) */
  secondaryActivity?: GameActivity | null;
  activityBio?: string | null;
  isBot?: boolean;
  /** Subscription plan: null | 'essential' | 'pro' */
  stripePlan?: string | null;
  /** Stripe subscription status (active, trialing, past_due, canceled, etc.). null when no plan. */
  stripeStatus?: string | null;
  /** ISO timestamp of the current period end (for active subs / gift expiry). null when no plan. */
  stripePeriodEnd?: string | null;
  /** Computed effective plan accounting for expiry/admin grants */
  effectivePlan?: string | null;
  /** Hex color for username display (Pro only) */
  nameColor?: string | null;
  /** Font key for username display (Pro only) */
  nameFont?: string | null;
  /** Name effect key (Pro only) */
  nameEffect?: string | null;
  /** Avatar effect key (Pro only) */
  avatarEffect?: string | null;
  /** Profile badges (e.g. 'beta', 'pro_essential', 'pro') */
  badges?: string[];
  /** Whether the user has MFA enabled */
  mfaEnabled?: boolean;
  hasPassword?: boolean;
  /** Background image URL (server-stored, plan-gated) */
  backgroundImage?: string | null;
  /** Background opacity (0.05–0.5) */
  backgroundOpacity?: number;
  /** Background blur in px (0–20) */
  backgroundBlur?: number;
  /** Whether GIF backgrounds always play */
  bgGifAlwaysPlay?: boolean;
  /** Whether this user still needs to provide date of birth (SSO users) */
  needsDateOfBirth?: boolean;
  /** Whether this user needs to complete onboarding (ToS + DOB) — SSO-created accounts */
  needsOnboarding?: boolean;
  /** Whether the user's email has been verified */
  emailVerified?: boolean;
  /** Whether the user is under 18 (used for GDPR-K / AADC ad compliance) */
  isMinor?: boolean;
  /** Whether the user has linked a Spotify account (derived from connectedApps) */
  hasSpotify?: boolean;
}

/** Format display name as username#discriminator when discriminator is present */
export function formatUsername(user: { username: string; discriminator?: string | null }): string {
  return user.discriminator ? `${user.username}#${user.discriminator}` : user.username;
}

export interface FriendActivity {
  id: string;
  userId: string;
  activity: string;
  startTime: Date;
  image: string;
}

/** Minimal reference to a message being replied to (for display above the reply) */
export interface MessageReplyTo {
  id: string;
  authorId: string;
  authorUsername?: string | null;
  content: string;
  /**
   * MLS: the reply quote's original ciphertext, preserved while `content`
   * holds the lock placeholder (the reply was transiently undecryptable). Lets
   * the re-decrypt sweep (useMlsRedecrypt) retry the reply preview in place,
   * mirroring the parent message's `_encryptedEnvelope`. Client-only; never sent.
   */
  _encryptedContent?: string;
}

export interface Message {
  id: string;
  authorId: string;
  content: string;
  timestamp: Date;
  /** "message" (default), "system" (e.g. "X pinned a message"), or "imported" (Discord import) */
  type?: 'message' | 'system' | 'imported';
  /** For system messages or imported messages with Discord author metadata */
  systemPayload?: { kind?: string; messageId?: string; pollId?: string; discordAuthor?: string; discordAuthorAvatar?: string | null; discordAuthorId?: string; discordMessageId?: string; discordReplyTo?: string | null; giftId?: string; plan?: string; durationMonths?: number; claimedAt?: string };
  /** The ID of the message being replied to (persists even if the target is deleted) */
  replyToMessageId?: string | null;
  /** When set, this message is a reply; contains the referenced message snippet */
  replyTo?: MessageReplyTo | null;
  /** Set by API/socket when author is resolved */
  authorUsername?: string;
  authorDiscriminator?: string | null;
  authorAvatar?: string | null;
  authorRoleColor?: string | null;
  authorRoleStyle?: 'solid' | 'gradient' | 'holographic';
  authorStripePlan?: string | null;
  authorNameColor?: string | null;
  authorNameFont?: string | null;
  authorNameEffect?: string | null;
  authorAvatarEffect?: string | null;
  /** File attachment (URL is relative to API base, e.g. /api/uploads/xxx) */
  attachmentUrl?: string | null;
  attachmentName?: string | null;
  attachmentContentType?: string | null;
  /** MLS-authenticated plaintext byte size (sealed in the message envelope).
   *  Passed to fetchAndDecryptFile to cross-check the decrypted length and reject
   *  a tampered (truncated/duplicated) encrypted blob. */
  attachmentSize?: number | null;
  /** Server-extracted image dimensions (null for encrypted, video, or external media) */
  attachmentWidth?: number | null;
  attachmentHeight?: number | null;
  /**
   * Per-attachment spoiler marker. Always blurs until clicked. Distinct
   * from `Channel.ageRestricted` — spoilers are not NSFW gates. For E2EE
   * DMs the flag is plaintext metadata the client volunteers; server
   * stores+forwards but never inspects ciphertext.
   */
  attachmentIsSpoiler?: boolean;
  /** Alt text for accessibility (screen readers). Max 500 chars. */
  attachmentAlt?: string | null;
  /** When true, this message was forwarded from elsewhere */
  forwarded?: boolean;
  /** Emoji reactions on this message */
  reactions?: Array<{ emoji: string; userIds: string[] }>;
  /** ISO timestamp when the message was last edited, null if never edited */
  editedAt?: string | null;
  /** E2E file decryption key (set client-side after decrypting envelope, never from server) */
  _encryptedFileKey?: string;
  /**
   * MLS: true when the MLS decrypt path substituted the lock placeholder
   * for this message (channel transiently not-ready, or genuinely undecryptable).
   * Set/cleared client-side only — never from the server. Drives the re-decrypt
   * sweep (useMlsRedecrypt) and lets render/enumeration test a flag rather than
   * string-matching the placeholder content.
   */
  undecryptable?: boolean;
  /**
   * MLS: original ciphertext envelope preserved while `undecryptable` is
   * true, so the re-decrypt sweep can retry in place without a refetch. `content`
   * still holds the placeholder for every other consumer. Client-only; never sent.
   */
  _encryptedEnvelope?: string;
}

export interface ChannelCategory {
  id: string;
  name: string;
  position: number;
  isPrivate?: boolean;
}

export interface Channel {
  id: string;
  name: string;
  /** Optional topic/description for text channels */
  description?: string | null;
  type: 'text' | 'voice' | 'stage' | 'forum' | 'role_picker';
  categoryId: string | null;
  position: number;
  isPrivate?: boolean;
  ageRestricted?: boolean;
  slowMode?: number;
  userLimit?: number;
  hideAfterInactivity?: number | null;
  // Forum-specific
  postGuidelines?: string | null;
  defaultReaction?: string | null;
  defaultSortOrder?: 'recent_activity' | 'creation_date';
  defaultLayout?: 'list' | 'gallery';
  requireTags?: boolean;
  postSlowMode?: number;
  messageSlowMode?: number;
}

export interface PermissionOverride {
  id: string;
  channelId?: string;
  categoryId?: string;
  targetType: 'role' | 'member';
  targetId: string;
  permissions: Record<string, boolean | null>;
  createdAt: string;
}

export interface ForumPost {
  id: string;
  channelId: string;
  authorId: string;
  title: string;
  content: string;
  imageUrl?: string | null;
  pinned: boolean;
  locked: boolean;
  lastActivityAt: string;
  messageCount: number;
  createdAt: string;
  author?: {
    id: string;
    username: string;
    discriminator?: string;
    avatar?: string | null;
    nameColor?: string | null;
    nameFont?: string | null;
    nameEffect?: string | null;
    avatarEffect?: string | null;
    stripePlan?: string | null;
    badges?: string[];
  };
  tags?: Array<{ id: string; name: string; color: string; emoji?: string | null }>;
}

export interface ForumTag {
  id: string;
  channelId: string;
  name: string;
  emoji?: string | null;
  color: string;
  position: number;
}

export interface ForumMessage {
  id: string;
  forumPostId: string;
  authorId: string;
  content: string;
  attachmentUrl?: string | null;
  attachmentName?: string | null;
  attachmentContentType?: string | null;
  /** MLS-authenticated plaintext byte size (sealed in the message envelope).
   *  Passed to fetchAndDecryptFile to cross-check the decrypted length and reject
   *  a tampered (truncated/duplicated) encrypted blob. */
  attachmentSize?: number | null;
  attachmentWidth?: number | null;
  attachmentHeight?: number | null;
  createdAt: string;
  editedAt?: string | null;
  author?: {
    id: string;
    username: string;
    discriminator?: string;
    avatar?: string | null;
    nameColor?: string | null;
    nameFont?: string | null;
    nameEffect?: string | null;
    avatarEffect?: string | null;
    stripePlan?: string | null;
    badges?: string[];
  };
  reactions?: Array<{ emoji: string; userIds: string[] }>;
}

export interface Server {
  id: string;
  name: string;
  icon: string | null;
  /** Server banner image URL (optional). */
  banner?: string | null;
  bannerPositionY?: number | null;
  bannerZoom?: number | null;
  channels: Channel[];
  categories?: ChannelCategory[];
  /** Current user's role on this server (from API) */
  myRole?: string;
  /** Resolved permissions for the current user on this server */
  myPermissions?: Record<string, boolean>;
  powerUpCount?: number;
  memberCount?: number;
  description?: string | null;
  /** Channel IDs the current user has accepted the 18+ gate for in this
   *  server. Populated from the caller's ServerMember row. */
  acceptedAgeRestrictedChannelIds?: string[];
}

export interface ServerSettings {
  id: string;
  serverId: string;
  description?: string | null;
  verificationLevel: string;
  contentFilter: string;
  dmSpamFilter: boolean;
  welcomeMessage?: string | null;
  welcomeEnabled: boolean;
  defaultNotifications: string;
  joinMethod: string;
  rules?: string[] | null;
  communityEnabled: boolean;
  discoveryEnabled: boolean;
  blockedNicknames?: string[] | null;
  region?: string;
  rulesChannelId?: string | null;
  updatesChannelId?: string | null;
  welcomeChannelId?: string | null;
  onboardingEnabled?: boolean;
}

export interface ServerBan {
  id: string;
  userId: string;
  username: string;
  discriminator?: string;
  avatar?: string | null;
  reason?: string | null;
  bannedById: string;
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  serverId: string;
  actorId: string;
  actorUsername?: string;
  actorAvatar?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown> | null;
  createdAt: string;
}

export interface CustomEmoji {
  id: string;
  serverId: string;
  name: string;
  imageUrl: string;
  uploadedById: string;
  createdAt: string;
}

export interface ServerSticker {
  id: string;
  serverId: string;
  name: string;
  imageUrl: string;
  description?: string | null;
  uploadedById: string;
  createdAt: string;
}

export interface SoundboardSound {
  id: string;
  serverId: string;
  name: string;
  audioUrl: string;
  emoji?: string | null;
  volume: number;
  uploadedById: string;
  createdAt: string;
}

export interface AutomodRule {
  id: string;
  serverId: string;
  name: string;
  type: string;
  enabled: boolean;
  config?: Record<string, unknown> | null;
  createdAt: string;
}

export interface ServerTemplate {
  id: string;
  serverId: string;
  name: string;
  description?: string | null;
  code: string;
  channelSnapshot?: Array<{ name: string; type: string }> | null;
  roleSnapshot?: Array<{ name: string; color: string; permissions?: unknown }> | null;
  categorySnapshot?: Array<{
    name: string;
    position: number;
    channels: Array<{ name: string; type: string; position: number }>;
  }> | null;
  settingsSnapshot?: {
    description?: string;
    verificationLevel?: string;
    defaultNotifications?: string;
  } | null;
  createdById: string;
  usageCount: number;
  createdAt: string;
}

// Calendar Events

export interface EventInvitee {
  id: string;
  scope: 'EVERYONE' | 'ROLE' | 'USER';
  targetId: string | null;
}

export type RecurrenceRule = 'NONE' | 'DAILY' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'CUSTOM';

export interface ServerEvent {
  id: string;
  serverId: string;
  title: string;
  description: string | null;
  startTime: string;
  endTime: string;
  allDay: boolean;
  color: string;
  timezone: string;
  reminderChannelId: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  reminders: EventReminder[];
  invitees: EventInvitee[];
  recurrenceRule: RecurrenceRule;
  recurrenceDays: number[] | null;
  recurrenceEndDate: string | null;
  voiceChannelId: string | null;
  reminderMentions?: {
    everyone?: boolean;
    here?: boolean;
    roleIds?: string[];
  } | null;
  rsvpCounts: { going: number; interested: number; declined: number };
  myRsvp: 'GOING' | 'INTERESTED' | 'DECLINED' | null;
  rsvpGoingUserIds?: string[];
}

export interface EventReminder {
  id: string;
  timing: 'AT_START' | '15_MIN' | '1_HOUR' | '1_DAY' | '1_WEEK';
  sent: boolean;
}

export const EVENT_COLORS = ['#378ADD', '#1D9E75', '#7F77DD', '#D4537E', '#D85A30', '#BA7517', '#639922', '#5F5E5A'] as const;
export const EVENT_REMINDER_TIMINGS = ['AT_START', '15_MIN', '1_HOUR', '1_DAY', '1_WEEK'] as const;
export type EventColor = typeof EVENT_COLORS[number];
export type EventReminderTiming = typeof EVENT_REMINDER_TIMINGS[number];

// Polls

export interface Poll {
  id: string;
  channelId?: string | null;
  dmChannelId?: string | null;
  serverId?: string | null;
  authorId: string;
  question: string;
  allowMultiple: boolean;
  anonymous: boolean;
  duration: number | null;
  expiresAt: string | null;
  closedAt: string | null;
  createdAt: string;
  options: PollOption[];
  votes: PollVoteAgg[];
  myVotes?: string[];
  totalVotes: number;
}

export interface PollOption {
  id: string;
  text: string;
  emoji?: string | null;
  position: number;
  voteCount: number;
}

export interface PollVoteAgg {
  optionId: string;
  count: number;
  voters?: Array<{ id: string; username: string; avatar?: string | null }>;
}

// Threads

export interface Thread {
  id: string;
  channelId: string;
  parentMessageId: string;
  serverId: string;
  name: string;
  authorId: string;
  archived: boolean;
  autoArchive: boolean;
  autoArchiveDuration: number;
  lastActivityAt: string;
  createdAt: string;
  messageCount?: number;
  lastMessage?: ThreadMessage | null;
  participants?: Array<{ id: string; username: string; avatar?: string | null }>;
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  authorId: string;
  content: string;
  type: 'message' | 'system';
  systemPayload?: Record<string, unknown>;
  replyToMessageId?: string | null;
  replyToMessage?: ThreadMessage | null;
  attachmentUrl?: string | null;
  attachmentName?: string | null;
  attachmentContentType?: string | null;
  /** MLS-authenticated plaintext byte size (sealed in the message envelope).
   *  Passed to fetchAndDecryptFile to cross-check the decrypted length and reject
   *  a tampered (truncated/duplicated) encrypted blob. */
  attachmentSize?: number | null;
  attachmentWidth?: number | null;
  attachmentHeight?: number | null;
  createdAt: string;
  editedAt?: string | null;
  reactions?: Array<{ emoji: string; count: number; me: boolean }>;
}

// Stages

export interface StageSession {
  id: string;
  channelId: string;
  serverId: string;
  topic: string | null;
  maxSpeakers: number;
  textChatEnabled: boolean;
  allowEmojis: boolean;
  allowStickers: boolean;
  allowGifs: boolean;
  invitedSpeakerUserIds: string[];
  invitedRoleIds: string[];
  startedById: string;
  startedAt: string;
  endedAt: string | null;
  speakers: StageSpeaker[];
  audienceCount: number;
  audienceMembers?: StageAudienceMember[];
  handRaises: Array<{ userId: string; username: string; avatar?: string | null }>;
  maxVideoParticipants: number;
  maxScreenShares: number;
  videoAudienceCap: number;
  maxTotalParticipants: number;
  maxHandRaises: number;
}

export interface StageSpeaker {
  userId: string;
  username: string;
  discriminator?: string;
  avatar?: string | null;
  banner?: string | null;
  bannerPositionY?: number;
  bannerZoom?: number;
  nameColor?: string | null;
  nameFont?: string | null;
  nameEffect?: string | null;
  avatarEffect?: string | null;
  effectivePlan?: string;
  isMuted: boolean;
  isHost: boolean;
  serverMuted?: boolean;
  serverDeafened?: boolean;
}

export interface StageAudienceMember {
  userId: string;
  username: string;
  discriminator?: string;
  avatar?: string | null;
  nameColor?: string | null;
  nameFont?: string | null;
  nameEffect?: string | null;
  avatarEffect?: string | null;
  effectivePlan?: string;
}

export type NavigationTarget = 'home' | 'account' | 'friends' | 'dm' | string;

export interface AppState {
  currentUser: User;
  servers: Server[];
  activeServerId: NavigationTarget;
  activeChannelId: string;
  messages: Record<string, Message[]>;
  members: Record<string, User[]>;
}
