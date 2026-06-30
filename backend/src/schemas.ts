// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Shared Zod schemas used across route files.
 *
 * Naming convention: <entity><Action>Schema
 * All max lengths, enums, and format rules are defined here once.
 */

import { z } from 'zod';
import safe from 'safe-regex2';
import { validateUsername, errorMessageForReason } from './utils/usernameValidator.js';
import { BADGE_KEYS } from './utils/badgeKeys.js';

// Unicode control / BiDi stripping (security)

// eslint-disable-next-line no-misleading-character-class -- intentional Unicode control/BiDi ranges
const CONTROL_CHAR_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD\u034F\u180E\uFFF9-\uFFFB]/g;
export const stripControlChars = (s: string) => s.replace(CONTROL_CHAR_RE, '');

// Canonical permissions list (shared with routes/servers.ts)

export const VALID_PERMISSIONS = [
  'administrator', 'manageServer', 'manageChannels', 'manageRoles', 'manageExpressions',
  'viewAuditLog', 'manageWebhooks', 'createInvite', 'changeNickname', 'manageNicknames',
  'kickMembers', 'banMembers', 'timeoutMembers', 'sendMessages', 'sendMessagesInThreads',
  'embedLinks', 'attachFiles', 'addReactions', 'mentionEveryone', 'manageMessages',
  'readMessageHistory', 'connect', 'speak', 'video', 'useVoiceActivity', 'muteMembers',
  'moveMembers', 'viewChannels', 'createExpressions', 'viewCalendar', 'manageCalendar',
  'createPolls', 'createThreads', 'manageStages', 'requestToSpeak',
  'createPublicThreads', 'createPrivateThreads',
  'useExternalEmoji', 'useExternalStickers', 'useExternalSounds', 'useSoundboard',
  'prioritySpeaker', 'deafenMembers', 'setVoiceChannelStatus',
  'createPosts', 'sendMessagesInPosts', 'managePosts',
  'createEvents', 'manageEvents',
] as const;

// Reusable URL validator (blocks javascript:, data:, etc.)

const safeUrlSchema = z.string().max(2048).refine(
  (url) => {
    if (!url) return true;
    if (url.startsWith('//')) return false;
    try {
      const parsed = new URL(url, 'https://placeholder.invalid');
      return ['https:', 'http:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  },
  { message: 'Must be a valid HTTP(S) URL' }
);

// URL schemas for user-generated image/audio uploads (emoji, stickers,
// soundboard, role icons). Extension allowlist + SVG block prevents an
// uploaded .mp4 / .mp3 / .svg from being accepted via the central upload
// endpoint AND closes the external-URL escape hatch (external URLs still
// pass isSafeExternalUrl SSRF check but must now end in an allowed extension).
// Anchor the extension to the path end and test against the
// query/fragment-stripped URL. The serve route ignores a ?query/#fragment, so a
// `(\?|#|$)` alternation would let `<uuid>.enc?x.png` pass while the server
// serves the unscanned `.enc` blob — defeating the encrypted-upload `.enc` forcing.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif)$/i;
const AUDIO_EXT_RE = /\.(mp3|ogg|wav|m4a|webm|opus)$/i;
const stripUrlSuffix = (url: string) => url.split(/[?#]/)[0];

const imageUploadUrlSchema = safeUrlSchema.refine(
  (url) => IMAGE_EXT_RE.test(stripUrlSuffix(url)),
  { message: 'Must be an image URL (.png, .jpg, .gif, .webp, .avif)' }
);

const audioUploadUrlSchema = safeUrlSchema.refine(
  (url) => AUDIO_EXT_RE.test(stripUrlSuffix(url)),
  { message: 'Must be an audio URL (.mp3, .ogg, .wav, .m4a, .webm, .opus)' }
);

// Primitives

export const uuidParam = z.string().uuid('Invalid ID format');

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  page: z.coerce.number().int().min(1).default(1),
});

export const userSearchQuery = z.object({
  q: z.string().max(100, 'Search query too long').trim().default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// User

// Reject HTML metacharacters at the input boundary. React escapes everything
// in the SPA today, but that discipline must hold for every future renderer
// (email templates, share cards, notifications, admin panel, webhooks).
// Refusing the bytes here eliminates the entire class of regressions.
//
// ASCII-only at the username layer (homoglyph / RTL-injection / zero-width
// defense). Per-server nicknames remain Unicode-permissive for legitimate
// international identity expression. The trailing `validateUsername` refine
// enforces a curated severe-slur blocklist, reserved-name list, repetition
// cap, and punctuation rules — see `utils/usernameValidator.ts`.
export const usernameSchema = z.string()
  .min(2, 'Username must be at least 2 characters')
  .max(32, 'Username must be at most 32 characters')
  .refine((s) => !/[<>"'&]/.test(s), 'Username may not contain the characters < > " \' &')
  .trim()
  .transform(stripControlChars)
  .refine(
    (s) => validateUsername(s).ok,
    {
      error: (issue) => {
        const r = validateUsername(issue.input as string);
        return r.ok ? '' : errorMessageForReason(r.reason);
      },
    },
  );

export const passwordSchema = z.string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Z]/, 'Must contain an uppercase letter')
  .regex(/[0-9]/, 'Must contain a number')
  .regex(/[^a-zA-Z0-9]/, 'Must contain a symbol');

export const emailSchema = z.string().email('Invalid email address').max(254).trim().toLowerCase();

export const discriminatorSchema = z.string().regex(/^\d{4}$/, 'Discriminator must be exactly 4 digits');

export const statusEnum = z.enum(['online', 'idle', 'dnd', 'invisible']);

export const userPreferencesSchema = z.object({
  notifyDesktop: z.boolean().optional(),
  notifyUnreadBadge: z.boolean().optional(),
  notifyTaskbarFlash: z.boolean().optional(),
  notifySoundNewMessage: z.boolean().optional(),
  notifySoundCurrentChannel: z.boolean().optional(),
  notifySoundIncomingRing: z.boolean().optional(),
  notifyDisableAllSounds: z.boolean().optional(),
  allowDmFromServerMembers: z.boolean().optional(),
  messageRequestsFilter: z.boolean().optional(),
  friendRequestsEveryone: z.boolean().optional(),
  friendRequestsFriendsOfFriends: z.boolean().optional(),
  friendRequestsServerMembers: z.boolean().optional(),
  showOnlineStatus: z.enum(['everyone', 'friends_only']).optional(),
  showJoinDate: z.boolean().optional(),
  showBadges: z.boolean().optional(),
  badgeDisplay: z.object({
    hidden: z.array(z.enum(BADGE_KEYS)).max(7),
    order: z.array(z.enum(BADGE_KEYS)).max(7),
  }).optional(),
  showCurrentActivity: z.enum(['everyone', 'friends_only', 'nobody']).optional(),
  shareDetectedGames: z.boolean().optional(),
  shareSteamActivity: z.boolean().optional(),
  shareSpotifyActivity: z.boolean().optional(),
  shareTwitchActivity: z.boolean().optional(),
  shareYouTubeActivity: z.boolean().optional(),
  activitySharingEnabled: z.boolean().optional(),
  activityShareScope: z.enum(['everyone', 'friends_small_servers', 'friends_only']).optional(),
  activitySourcePriority: z.string().max(256).regex(/^[a-z,]+$/).optional(),
  shareActivityBio: z.boolean().optional(),
  profilePrivate: z.boolean().optional(),
  // New-device login email opt-out
  notifyOnNewDevice: z.boolean().optional(),
});

// Auth

export const registerSchema = z.object({
  body: z.object({
    username: usernameSchema,
    email: emailSchema,
    password: passwordSchema,
    captchaToken: z.string().max(2048).optional(),
    // Self-host first-admin claim: the one-time setup token (BOOTSTRAP_TOKEN)
    // that setup.sh generates. Only checked on the very first registration of a
    // fresh self-hosted instance; ignored on the hosted service and afterwards.
    bootstrapToken: z.string().max(256).optional(),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be YYYY-MM-DD').refine(
      (dob) => {
        const d = new Date(dob + 'T00:00:00Z');
        if (isNaN(d.getTime())) return false;
        // Reject invalid calendar dates (e.g. Feb 30) by round-trip check
        const [y, m, day] = dob.split('-').map(Number);
        if (d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== m || d.getUTCDate() !== day) return false;
        const minAge = 13;
        const maxYear = new Date().getFullYear() - minAge;
        return y >= 1900 && y <= maxYear;
      },
      { message: 'You must be at least 13 years old to register' },
    ),
    agreedToTerms: z.literal(true, { error: 'You must agree to the Terms of Service and Privacy Policy' }),
    // ToS §3 requires parental/guardian consent for ages 13–17. The route
    // enforces presence (must be true) when computed age < 18; for adults
    // it's optional (server treats as true regardless). Recording the bit
    // gives us a clear "user affirmed consent at signup" answer to NCMEC
    // and to a regulator without us claiming verified parental consent —
    // it's an attestation, not a verification.
    parentalConsentAcknowledged: z.boolean().optional(),
  }).strict(),
});

export const loginSchema = z.object({
  body: z.object({
    email: emailSchema,
    password: z.string().min(1, 'Password is required').max(128),
    captchaToken: z.string().max(2048).optional(),
  }).strict(),
});

export const verifyEmailSchema = z.object({
  body: z.object({
    userId: z.string().uuid('Invalid user ID format'),
    code: z.string().min(1, 'Verification code is required').max(10),
    captchaToken: z.string().min(1).max(4096).optional(),
  }).strict(),
});

export const resendVerificationSchema = z.object({
  body: z.object({
    userId: z.string().uuid('Invalid user ID format'),
    captchaToken: z.string().min(1).max(4096).optional(),
  }).strict(),
});

const hexColorSchema = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Color must be a hex value (#RGB or #RRGGBB)').optional();

export const updateProfileSchema = z.object({
  body: z.object({
    username: usernameSchema.optional(),
    avatar: safeUrlSchema.nullable().optional(),
    banner: safeUrlSchema.nullable().optional(),
    nameColor: hexColorSchema.nullable(),
    nameFont: z.enum(['default', 'serif', 'mono', 'cursive', 'handwritten', 'impact', 'rounded', 'pixel', 'elegant', 'display', 'bold', 'futuristic', 'spaced', 'script', 'verdana', 'comic-sans', 'dyslexie']).nullable().optional(),
    nameEffect: z.enum(['none', 'glow', 'rainbow', 'shimmer', 'fire', 'neon', 'pulse', 'gradient']).nullable().optional(),
    avatarEffect: z.enum(['none', 'glow-cyan', 'glow-purple', 'glow-gold', 'glow-rose', 'glow-emerald', 'ring-animated', 'ring-rainbow', 'ring-fire', 'sparkle', 'breathe', 'shadow-neon']).nullable().optional(),
    bannerPositionY: z.number().int().min(0).max(100).optional(),
    bannerZoom: z.number().int().min(100).max(200).optional(),
    backgroundImage: safeUrlSchema.nullable().optional(),
    backgroundOpacity: z.number().min(0.05).max(0.5).optional(),
    backgroundBlur: z.number().int().min(0).max(20).optional(),
    bgGifAlwaysPlay: z.boolean().optional(),
    activityBio: z.string().max(128).transform(stripControlChars).nullable().optional(),
  }).strict(),
});

export const completeOnboardingSchema = z.object({
  body: z.object({
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be YYYY-MM-DD').refine(
      (dob) => {
        const d = new Date(dob + 'T00:00:00Z');
        if (isNaN(d.getTime())) return false;
        const [y, m, day] = dob.split('-').map(Number);
        if (d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== m || d.getUTCDate() !== day) return false;
        const minAge = 13;
        const maxYear = new Date().getFullYear() - minAge;
        return y >= 1900 && y <= maxYear;
      },
      { message: 'You must be at least 13 years old' },
    ),
    agreedToTerms: z.literal(true, { error: 'You must agree to the Terms of Service and Privacy Policy' }),
    password: passwordSchema.optional(),
    // Only meaningful for SSO providers that don't expose an email (Steam).
    // The backend accepts it, verifies uniqueness, and stores it in place of
    // the synthetic <provider>_<id>@sso.local placeholder assigned at signup.
    email: emailSchema.optional(),
  }).strict(),
});

export const setDateOfBirthSchema = z.object({
  body: z.object({
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be YYYY-MM-DD').refine(
      (dob) => {
        const d = new Date(dob + 'T00:00:00Z');
        if (isNaN(d.getTime())) return false;
        const [y, m, day] = dob.split('-').map(Number);
        if (d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== m || d.getUTCDate() !== day) return false;
        const minAge = 13;
        const maxYear = new Date().getFullYear() - minAge;
        return y >= 1900 && y <= maxYear;
      },
      { message: 'You must be at least 13 years old' },
    ),
  }).strict(),
});

export const updateStatusSchema = z.object({
  body: z.object({
    status: statusEnum,
  }).strict(),
});

export const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().max(128).optional(),
    newPassword: passwordSchema,
    // First-time password install on an SSO-only account uses one of these as
    // a second-factor proof that the session holder controls either the email
    // or the enrolled MFA device.
    mfaCode: z.string().length(6).regex(/^\d+$/).optional(),
    emailCode: z.string().length(6).regex(/^\d+$/).optional(),
  }).strict(),
});

export const changeEmailSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newEmail: emailSchema,
    mfaCode: z.string().length(6).regex(/^\d+$/, 'MFA code must be 6 digits').optional(),
  }).strict(),
});

export const confirmEmailCodeSchema = z.object({
  body: z.object({
    // Require TWO codes — one sent to the OLD address (proves current owner),
    // one to the NEW address (proves destination is reachable). The
    // legacy single-`code` field is still accepted so in-flight clients don't
    // break, but new flows must supply both.
    code: z.string().min(1).max(10).optional(),
    codeOld: z.string().min(1).max(10).optional(),
    codeNew: z.string().min(1).max(10).optional(),
  }).strict().refine(
    (v) => (v.codeOld && v.codeNew) || v.code,
    { message: 'Both codeOld and codeNew are required' },
  ),
});

export const deleteAccountSchema = z.object({
  body: z.object({
    password: z.string().min(1, 'Password is required').max(128),
  }).strict(),
});

export const forgotPasswordSchema = z.object({
  body: z.object({
    email: emailSchema,
    captchaToken: z.string().max(2048).optional(),
  }).strict(),
});

export const resetPasswordSchema = z.object({
  body: z.object({
    email: emailSchema,
    code: z.string().min(1, 'Code is required').max(10),
    newPassword: passwordSchema,
    captchaToken: z.string().max(2048).optional(),
  }).strict(),
});

export const updateDiscriminatorSchema = z.object({
  body: z.object({
    discriminator: discriminatorSchema,
  }).strict(),
});

export const updatePreferencesSchema = z.object({
  body: userPreferencesSchema.strict(),
});

// User content / discovery preferences

export const updateUserContentPreferencesSchema = z.object({
  body: z.object({
    discoveryOptOut: z.boolean().optional(),
  }).strict(),
});

// Activity

export const setActivitySchema = z.object({
  body: z.object({
    type: z.enum(['detected_game', 'custom']),
    // Strip BiDi/zero-width — broadcast via socket.io to friends + channels.
    name: z.string().min(1).max(128).transform(stripControlChars),
    details: z.string().max(256).transform(stripControlChars).optional(),
    state: z.string().max(128).transform(stripControlChars).optional(),
    largeImage: safeUrlSchema.optional(),
    smallImage: safeUrlSchema.optional(),
    platformId: z.string().max(64).optional(),
    platform: z.enum(['electron', 'manual']).optional(),
  }).strict(),
});

export const getActivityParamsSchema = z.object({
  params: z.object({
    userId: uuidParam,
  }),
});

const customGameEntry = z.object({
  exeName: z.string().min(1).max(128).regex(/^[\w.-]+$/),
  // Strip BiDi/zero-width control characters.
  displayName: z.string().min(1).max(128).transform(stripControlChars),
});

export const setCustomGamesSchema = z.object({
  body: z.object({
    customGames: z.array(customGameEntry).max(50),
  }).strict(),
});

export const setServerActivitySchema = z.object({
  params: z.object({ serverId: uuidParam }),
  body: z.object({
    shareActivity: z.boolean().nullable(),
  }).strict(),
});

// DM list

export const dmListQuery = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
});

// Server members

export const serverMembersQuery = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(500).default(200),
    offset: z.coerce.number().int().min(0).default(0),
  }),
});

// Messages

const maxMessageLength = 4000;

export const sendMessageSchema = z.object({
  body: z.object({
    content: z.string().max(maxMessageLength).transform(stripControlChars).optional(),
    replyToMessageId: z.string().uuid().optional(),
    attachmentUrl: z.string().max(2048).refine(
      (url) => /^\/api\/uploads\//.test(url) || /^https?:\/\//.test(url),
      { message: 'Attachment URL must be a server upload path or https URL' },
    ).optional(),
    attachmentName: z.string().max(255).transform(stripControlChars).optional(),
    attachmentContentType: z.string().max(100).regex(/^(image|video|audio|application|text)\/[a-zA-Z0-9.+_-]{1,80}$/, 'Invalid content type format').optional(),
    attachmentWidth: z.number().int().min(1).max(65536).optional(),
    attachmentHeight: z.number().int().min(1).max(65536).optional(),
    // Per-attachment spoiler marker. Sender-set; always blurs until clicked.
    attachmentIsSpoiler: z.boolean().optional(),
    // Alt text for accessibility. Empty string treated as null.
    attachmentAlt: z.string().max(500).transform(stripControlChars).optional(),
    forwarded: z.boolean().optional(),
  }).strict().refine(
    (d) => (d.content && d.content.trim().length > 0) || !!d.attachmentUrl,
    { message: 'Message content or attachment is required' },
  ),
});

export const editMessageSchema = z.object({
  body: z.object({
    content: z.string().min(1, 'Content is required').max(maxMessageLength).transform(stripControlChars),
  }).strict(),
});

export const getMessagesQuery = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).default(100),
    before: z.string().uuid().optional(),
    /** Jump-to-message: load a window of `limit` messages centered on this message ID.
     *  Mutually exclusive with `before`. */
    around: z.string().uuid().optional(),
  }).refine((q) => !(q.before && q.around), {
    message: 'Cannot specify both `before` and `around`',
    path: ['around'],
  }),
});

export const searchMessagesSchema = z.object({
  query: z.object({
    q: z.string().max(200).default(''),
    serverId: z.string().uuid().optional(),
    channelId: z.string().uuid().optional(),
    authorId: z.string().uuid().optional(),
    has: z.enum(['file', 'image', 'video', 'link', 'embed', 'sticker', 'sound', 'attachment']).optional(),
    before: z.string().datetime().optional(),
    after: z.string().datetime().optional(),
    mentions: z.string().uuid().optional(),
    pinned: z.enum(['true', 'false']).optional(),
    offset: z.coerce.number().int().min(0).max(10000).default(0),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  }),
});

export const searchDmMessagesSchema = z.object({
  query: z.object({
    q: z.string().max(200).default(''),
    dmChannelId: z.string().uuid('dmChannelId is required'),
    authorId: z.string().uuid().optional(),
    has: z.enum(['file', 'image', 'video', 'link', 'embed', 'sticker', 'sound', 'attachment']).optional(),
    before: z.string().datetime().optional(),
    after: z.string().datetime().optional(),
    mentions: z.string().uuid().optional(),
    pinned: z.enum(['true', 'false']).optional(),
    offset: z.coerce.number().int().min(0).max(10000).default(0),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  }),
});

// Servers

export const createServerSchema = z.object({
  body: z.object({
    name: z.string().max(100).trim().transform(stripControlChars).optional().default('New Server'),
    icon: safeUrlSchema.optional(),
    template: z.string().max(50).optional(),
  }).strict(),
});

export const updateServerSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).trim().transform(stripControlChars).optional(),
    icon: safeUrlSchema.nullable().optional(),
    banner: safeUrlSchema.nullable().optional(),
  }).strict(),
});

export const createChannelSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Channel name is required').max(100).trim().transform(stripControlChars),
    type: z.enum(['text', 'voice', 'stage', 'forum', 'role_picker']).default('text'),
    categoryId: z.string().uuid().nullable().optional(),
    isPrivate: z.boolean().default(false).optional(),
  }).strict(),
});

// Per-channel age-gate acceptance — POST /api/v1/channels/:id/age-gate/accept.
// No body needed; the channelId param + authenticated caller are the inputs.
export const acceptChannelAgeGateSchema = z.object({
  params: z.object({ channelId: uuidParam }),
});

export const updateChannelSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).trim().transform(stripControlChars).optional(),
    description: z.string().max(1024).transform(stripControlChars).nullable().optional(),
    slowMode: z.number().int().min(0).max(21600).optional(),
    isPrivate: z.boolean().optional(),
    ageRestricted: z.boolean().optional(),
    userLimit: z.number().int().min(0).max(99).optional(),
    hideAfterInactivity: z.number().int().min(1).max(30).nullable().optional(),
    postGuidelines: z.string().max(4096).transform(stripControlChars).nullable().optional(),
    defaultReaction: z.string().max(64).optional(),
    defaultSortOrder: z.enum(['recent_activity', 'creation_date']).optional(),
    defaultLayout: z.enum(['list', 'gallery']).optional(),
    requireTags: z.boolean().optional(),
    postSlowMode: z.number().int().min(0).max(86400).optional(),
    messageSlowMode: z.number().int().min(0).max(21600).optional(),
  }).strict(),
});

export const createCategorySchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Category name is required').max(100).trim().transform(stripControlChars),
  }).strict(),
});

export const updateCategorySchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).trim().transform(stripControlChars).optional(),
    position: z.number().int().min(0).max(500).optional(),
    isPrivate: z.boolean().optional(),
  }).strict(),
});

export const reorderChannelsSchema = z.object({
  body: z.object({
    channels: z.array(z.object({
      id: z.string().uuid(),
      position: z.number().int().min(0).max(999),
      categoryId: z.string().uuid().nullable(),
    }).strict()).min(1).max(500),
  }).strict(),
});

export const reorderCategoriesSchema = z.object({
  body: z.object({
    categories: z.array(z.object({
      id: z.string().uuid(),
      position: z.number().int().min(0).max(500),
    }).strict()).min(1).max(50),
  }).strict(),
});

// Per-user reorder of the far-left sidebar. Max 200 mirrors the cap in
// loadUserServers (and the MAX_SERVERS_PRO ceiling). Strict array of UUIDs;
// the route maps array index → ServerMember.position.
export const setServerOrderSchema = z.object({
  body: z.object({
    serverIds: z.array(z.string().uuid()).min(1).max(200),
  }).strict(),
});

export const transferOwnershipSchema = z.object({
  body: z.object({
    newOwnerId: z.string().uuid(),
  }).strict(),
});

export const updateServerProfileSchema = z.object({
  body: z.object({
    nickname: z.string().trim().min(1).max(32).transform(stripControlChars).nullable().optional(),
    serverAvatar: safeUrlSchema.nullable().optional(),
    serverBanner: safeUrlSchema.nullable().optional(),
  }).strict(),
});

export const updatePrivacySchema = z.object({
  body: z.object({
    allowDirectMessages: z.boolean().nullable().optional(),
  }).strict(),
});

// Roles

const roleStyleEnum = z.enum(['solid', 'gradient', 'animated']).default('solid');

const permissionsObject = z.object(
  Object.fromEntries(VALID_PERMISSIONS.map(k => [k, z.boolean().optional()]))
).strict().optional();

export const createRoleSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Role name is required').max(100).trim().transform(stripControlChars),
    color: hexColorSchema,
    style: roleStyleEnum.optional(),
    icon: imageUploadUrlSchema.nullable().optional(),
    permissions: permissionsObject,
    displaySeparately: z.boolean().optional(),
    allowMention: z.boolean().optional(),
    selfAssignable: z.boolean().optional(),
    hidden: z.boolean().optional(),
    blocksSelfRoles: z.boolean().optional(),
  }).strict(),
});

export const updateRoleSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).trim().transform(stripControlChars).optional(),
    color: hexColorSchema.optional(),
    style: roleStyleEnum.optional(),
    icon: imageUploadUrlSchema.nullable().optional(),
    permissions: permissionsObject,
    displaySeparately: z.boolean().optional(),
    allowMention: z.boolean().optional(),
    selfAssignable: z.boolean().optional(),
    hidden: z.boolean().optional(),
    blocksSelfRoles: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
  }).strict(),
});

export const addRoleMemberSchema = z.object({
  body: z.object({
    userId: z.string().uuid(),
  }).strict(),
});

export const reorderRolesSchema = z.object({
  body: z.object({
    // Top-to-bottom ordered list of all non-@everyone role IDs. Owner must
    // be at index 0; the server enforces. Cap at 100 to match the role
    // findMany limit so we never silently truncate state.
    orderedRoleIds: z.array(z.string().uuid()).min(1).max(100),
  }).strict(),
});

// Member Moderation

export const timeoutMemberSchema = z.object({
  body: z.object({
    durationSeconds: z.number().int().min(60).max(60 * 60 * 24 * 28),
    reason: z.string().max(512).optional(),
  }).strict(),
});

export const manageNicknameSchema = z.object({
  body: z.object({
    nickname: z.string().trim().min(1).max(32).transform(stripControlChars).nullable(),
  }).strict(),
});

// Invite Pagination

export const inviteListQuery = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(100).default(50),
  }),
});

// Invites

export const createInviteSchema = z.object({
  body: z.object({
    customCode: z.string().min(3).max(32).regex(/^[A-Za-z0-9_-]+$/, 'Invalid code format').optional(),
    expireAfter: z.number().int().min(0).nullable().optional(),
    maxUses: z.number().int().min(1).max(1000).nullable().optional(),
    temporary: z.boolean().optional(),
    quickInvite: z.boolean().optional(),
    label: z.string().trim().min(1).max(32).optional(),
    shareable: z.boolean().optional(),
  }).strict().refine(
    (b) => !b.temporary || (typeof b.expireAfter === 'number' && b.expireAfter > 0),
    { message: 'Temporary invites must have an expireAfter (in seconds) greater than zero', path: ['expireAfter'] },
  ),
});

export const updateInviteSchema = z.object({
  body: z.object({
    label: z.string().trim().max(32).nullable().optional(),
    shareable: z.boolean().optional(),
  }).strict().refine((b) => b.label !== undefined || b.shareable !== undefined, {
    message: 'At least one of label or shareable is required',
  }),
});

export const joinInviteSchema = z.object({
  body: z.object({
    code: z.string().min(1, 'Invite code is required').max(32).trim(),
    ageConfirmed: z.boolean().optional(),
  }).strict(),
});

export const invitePreviewSchema = z.object({
  params: z.object({
    code: z.string().min(3).max(32),
  }).strict(),
});

// Vanity URLs
//
// Slug format is enforced canonically by `utils/vanitySlug.ts::validateSlug`
// (which also applies the reserved-name denylist). The Zod layer is a cheap
// pre-filter to reject obviously oversized/wrong-type bodies before they
// reach the route handler.

export const setVanitySchema = z.object({
  body: z.object({
    slug: z.string().min(3).max(32),
  }).strict(),
});

export const vanityCheckQuery = z.object({
  query: z.object({
    slug: z.string().min(1).max(64),
  }).strict(),
});

// Server Settings

export const updateServerSettingsSchema = z.object({
  body: z.object({
    description: z.string().max(2048).transform(stripControlChars).optional(),
    verificationLevel: z.enum(['none', 'low', 'medium', 'high']).optional(),
    contentFilter: z.enum(['off', 'scan_no_roles', 'scan_all']).optional(),
    dmSpamFilter: z.boolean().optional(),
    welcomeMessage: z.string().max(1000).transform(stripControlChars).nullable().optional(),
    welcomeEnabled: z.boolean().optional(),
    defaultNotifications: z.enum(['all', 'mentions']).optional(),
    joinMethod: z.enum(['invite_only', 'apply_to_join', 'discoverable']).optional(),
    rules: z.array(z.string().trim().min(1).max(500).transform(stripControlChars)).max(50).nullable().optional(),
    communityEnabled: z.boolean().optional(),
    discoveryEnabled: z.boolean().optional(),
    blockedNicknames: z.array(z.string().trim().min(1).max(64)).max(200).nullable().optional(),
    region: z.string().max(50).optional(),
    rulesChannelId: z.string().uuid().nullable().optional(),
    updatesChannelId: z.string().uuid().nullable().optional(),
    onboardingEnabled: z.boolean().optional(),
    welcomeChannelId: z.string().uuid().nullable().optional(),
  }).strict(),
});

// Community Servers
//
// Discovery categories — fixed top-level taxonomy. Free-form `subcategory`
// lives alongside as ≤32 chars so curators can refine ("gaming" → "speedrun").
// Order matches the directory landing page.
export const COMMUNITY_CATEGORIES = [
  'gaming',
  'music',
  'education',
  'science',
  'technology',
  'art',
  'entertainment',
  'lifestyle',
  'sports',
  'anime',
  'finance',
  'business',
  'community',
  'support',
  'social',
  'roleplay',
  'writing',
  'food',
  'travel',
  'other',
] as const;

// ISO 639-1 — top ~30 spoken languages by count of native speakers, plus a
// catch-all "other" so curators of niche-language communities aren't forced
// to pick the wrong code.
export const COMMUNITY_LANGUAGES = [
  'en', 'es', 'pt', 'fr', 'de', 'it', 'nl', 'pl', 'ru', 'uk',
  'tr', 'ar', 'fa', 'he', 'hi', 'bn', 'ur', 'id', 'vi', 'th',
  'zh', 'ja', 'ko', 'sv', 'no', 'da', 'fi', 'cs', 'el', 'ro',
  'other',
] as const;

export const communityEnableSchema = z.object({
  body: z.object({
    discoveryEnabled: z.boolean().optional(),
  }).strict(),
});

export const communityUpdateSchema = z.object({
  body: z.object({
    category: z.enum(COMMUNITY_CATEGORIES).nullable().optional(),
    subcategory: z.string().trim().max(32).transform(stripControlChars).nullable().optional(),
    // 2-32 chars, lowercase + dashes only. Up to 5 — Discord-parity.
    tags: z
      .array(z.string().regex(/^[a-z0-9-]+$/, 'Tags must be lowercase letters/digits with dashes').min(2).max(32))
      .max(5)
      .nullable()
      .optional(),
    language: z.enum(COMMUNITY_LANGUAGES).nullable().optional(),
    longDescription: z.string().max(4096).transform(stripControlChars).nullable().optional(),
    bannerSplash: safeUrlSchema.max(512).nullable().optional(),
    // Allow flipping discovery on/off through the community PATCH so the
    // settings panel can toggle it without going through the lifecycle
    // enable/disable endpoints. When the handler sees this go false → true
    // it auto-promotes invite_only joinMethod to discoverable so the public
    // join endpoint stops returning join_method_mismatch.
    discoveryEnabled: z.boolean().optional(),
  }).strict(),
});

// "Verified by Howl" verification requests
//
// Owner-initiated application for the blue verified badge. Admins review in
// queue; approval flips Server.verified=true. v1 has no structured proof
// (admin manually verifies via the supplied website URL), so the schema
// stays small.

export const submitVerificationRequestSchema = z.object({
  body: z.object({
    organizationName: z.string().min(2).max(120).transform(stripControlChars),
    websiteUrl: safeUrlSchema.max(512),
    additionalNotes: z.string().max(2048).transform(stripControlChars).optional(),
  }).strict(),
});

export const decideVerificationRequestSchema = z.object({
  body: z.object({
    decisionNote: z.string().max(2048).transform(stripControlChars).optional(),
  }).strict(),
});

export const listVerificationRequestsQuery = z.object({
  query: z.object({
    status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).default('pending'),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  }).strict(),
});

// Welcome Screen
//
// Two surfaces: the screen-level toggle/description on `ServerSettings`, and
// the curated channel grid (≤5 entries) on `ServerWelcomeChannel`. Bounds
// match Discord's: 300 chars description, 200 chars per channel description,
// ≤16 chars emoji (single shortcode or compound unicode glyph), position 0–4
// (5 slots, zero-indexed).

export const updateWelcomeScreenSchema = z.object({
  body: z.object({
    welcomeScreenEnabled: z.boolean().optional(),
    welcomeScreenDescription: z.string().max(300).transform(stripControlChars).nullable().optional(),
  }).strict(),
});

export const createWelcomeChannelSchema = z.object({
  body: z.object({
    channelId: z.string().uuid(),
    description: z.string().min(1).max(200).transform(stripControlChars),
    emoji: z.string().max(16).transform(stripControlChars).nullable().optional(),
  }).strict(),
});

export const updateWelcomeChannelSchema = z.object({
  body: z.object({
    description: z.string().min(1).max(200).transform(stripControlChars).optional(),
    emoji: z.string().max(16).transform(stripControlChars).nullable().optional(),
    // Position is bounded to the welcome-screen cap (5 slots → 0..4).
    position: z.number().int().min(0).max(4).optional(),
  }).strict(),
});


export const createBanSchema = z.object({
  body: z.object({
    userId: z.string().uuid(),
    reason: z.string().max(512).transform(stripControlChars).optional(),
  }).strict(),
});

// Auto-assign roles config (onboarding). `.max(5)` agrees with the join-path
// `take: 5` in utils/joinWelcome.ts. REST body, so `.strict()` is allowed.
export const updateAutoRolesSchema = z.object({
  body: z.object({
    roleIds: z.array(z.string().uuid()).max(5),
  }).strict(),
});

// Server Insights
//
// Owner-facing time-series read of DailyServerStats. `range` is bounded to
// 90 days; the route caps the response at 90 rows regardless of range.
export const serverInsightsQuery = z.object({
  query: z.object({
    range: z.enum(['7d', '30d', '90d']).default('7d'),
  }).strict(),
});

export const auditLogQuery = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    action: z.string().max(100).optional(),
  }),
});

export const createEmojiSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(32).trim().transform(stripControlChars),
    imageUrl: imageUploadUrlSchema,
  }).strict(),
});

export const createStickerSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(32).trim().transform(stripControlChars),
    imageUrl: imageUploadUrlSchema,
    description: z.string().max(200).transform(stripControlChars).optional(),
  }).strict(),
});

export const createSoundboardSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(32).trim().transform(stripControlChars),
    audioUrl: audioUploadUrlSchema,
    emoji: z.string().max(10).optional(),
    volume: z.number().min(0).max(1).default(0.5),
  }).strict(),
});

const automodConfigSchema = z.object({
  keywords: z.array(z.string().max(100).transform(stripControlChars).transform(s => s.trim()).pipe(z.string().min(1))).max(1000).optional(),
  regex: z.array(
    z.string().max(500).refine((r) => {
      // eslint-disable-next-line security/detect-non-literal-regexp -- user regex validated by safe-regex2
      try { new RegExp(r); } catch { return false; }
      return safe(r);
    }, 'Invalid or unsafe regex pattern')
  ).max(50).optional(),
  threshold: z.number().int().min(1).max(100).optional(),
  action: z.enum(['warn', 'delete', 'mute', 'kick', 'ban']).optional(),
  duration: z.number().int().min(0).max(2592000).optional(),
  exemptRoles: z.array(z.string().uuid()).max(50).optional(),
  exemptChannels: z.array(z.string().uuid()).max(50).optional(),
}).strict();

export const createAutomodSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(100).trim().transform(stripControlChars),
    type: z.enum(['keyword', 'keyword_filter', 'spam', 'spam_filter', 'mention_spam', 'link_filter']),
    enabled: z.boolean().default(true),
    config: automodConfigSchema.optional(),
  }).strict(),
});

export const updateAutomodSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).trim().transform(stripControlChars).optional(),
    enabled: z.boolean().optional(),
    config: automodConfigSchema.optional(),
  }).strict(),
});

export const createTemplateSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(100).trim().transform(stripControlChars),
    // Strip BiDi/zero-width control characters.
    description: z.string().max(500).transform(stripControlChars).optional(),
  }).strict(),
});

export const updateTemplateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).trim().transform(stripControlChars).optional(),
    // Strip BiDi/zero-width control characters.
    description: z.string().max(500).transform(stripControlChars).optional(),
  }).strict(),
});

export const createServerFromTemplateSchema = z.object({
  body: z.object({
    code: z.string().uuid('Invalid template code'),
    name: z.string().max(100).trim().transform(stripControlChars).optional(),
    icon: safeUrlSchema.optional(),
  }).strict(),
});

// DMs

// 1:1 DM creation is keyless. MLS (Welcome / External Commit) is the sole key
// distribution; the route writes no X25519 dead-drop. The legacy
// encryptedKey/nonce/senderPublicKey/signature/signedPayloadV fields were
// removed with the protocol v3 break (see docs/PROTOCOL_CHANGES.md).
export const createDmSchema = z.object({
  body: z.object({
    otherUserId: z.string().uuid(),
  }).strict(),
});

// Group DMs are MLS-only; the Welcome is the sole key distribution. The body
// carries only memberIds (the legacy X25519 encryptedKeys/senderPublicKey
// fields were removed).
export const createGroupDmSchema = z.object({
  body: z.object({
    memberIds: z.array(z.string().uuid('Each member ID must be a valid UUID')).min(1, 'At least one member is required').max(14, 'Group DMs are limited to 15 members.'),
  }).strict(),
});

export const updateGroupDmSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).trim().transform(stripControlChars).optional(),
    icon: safeUrlSchema.nullable().optional(),
  }).strict(),
});

const maxEncryptedMessageLength = 8000; // base64 ciphertext is ~33% larger + JSON wrapper for attachment metadata

export const sendDmMessageSchema = z.object({
  body: z.object({
    content: z.string().max(maxEncryptedMessageLength).optional(),
    replyToMessageId: z.string().uuid().optional(),
    attachmentUrl: z.string().max(2048).refine(
      (url) => /^\/api\/uploads\//.test(url) || /^https?:\/\//.test(url),
      { message: 'Attachment URL must be a server upload path or https URL' },
    ).optional(),
    attachmentName: z.string().max(255).transform(stripControlChars).optional(),
    attachmentContentType: z.string().max(100).regex(/^(image|video|audio|application|text)\/[a-zA-Z0-9.+_-]{1,80}$/, 'Invalid content type format').optional(),
    attachmentWidth: z.number().int().min(1).max(65536).optional(),
    attachmentHeight: z.number().int().min(1).max(65536).optional(),
    // Per-attachment spoiler marker. DMs are E2EE; server stores+forwards
    // this plaintext metadata flag without inspecting ciphertext.
    attachmentIsSpoiler: z.boolean().optional(),
    // Alt text for accessibility (plaintext metadata; see above). Strip
    // zero-width / BiDi controls just like attachmentName — these fields
    // are sender-set plaintext metadata, not message ciphertext.
    attachmentAlt: z.string().max(500).transform(stripControlChars).optional(),
    forwarded: z.boolean().optional(),
    encrypted: z.boolean().optional(),
  }).strict().refine(
    (d) => (d.content && d.content.trim().length > 0) || !!d.attachmentUrl,
    { message: 'Message content or attachment is required' },
  ),
});

export const editDmMessageSchema = z.object({
  body: z.object({
    content: z.string().min(1, 'Content is required').max(maxEncryptedMessageLength),
    encrypted: z.boolean().optional(),
  }).strict(),
});

// Friends

export const friendRequestSchema = z.object({
  body: z.object({
    usernameDiscriminator: z.string().max(40).optional(),
    username: z.string().max(32).optional(),
  }).strict().refine(
    (d) => !!d.usernameDiscriminator || !!d.username,
    { message: 'Username or username#discriminator is required' },
  ),
});

export const blockUserSchema = z.object({
  body: z.object({
    userId: z.string().uuid(),
  }).strict(),
});

// Billing

export const createCheckoutSchema = z.object({
  body: z.object({
    plan: z.enum(['essential', 'pro']),
  }).strict(),
});

export const startTrialSchema = z.object({
  body: z.object({
    plan: z.enum(['essential', 'pro']),
  }).strict(),
});

export const giftSchema = z.object({
  body: z.object({
    plan: z.enum(['essential', 'pro']),
    durationMonths: z.number().int().min(1).max(12),
    recipientUsername: z.string().max(40).optional(),
  }).strict(),
});

export const assignGiftSchema = z.object({
  params: z.object({ giftId: z.string().uuid() }),
  body: z.object({ recipientUsername: z.string().min(3).max(40) }).strict(),
});

export const powerUpCheckoutSchema = z.object({
  body: z.object({ quantity: z.number().int().min(1).max(50) }).strict(),
});

export const redeemSchema = z.object({
  body: z.object({
    code: z.string().min(1, 'Code is required').max(50).trim(),
  }).strict(),
});

export const claimGiftSchema = z.object({
  params: z.object({ giftId: z.string().uuid() }),
});

export const refundSchema = z.object({
  body: z.object({
    type: z.enum(['subscription', 'gift', 'power_up']),
    reason: z.string().max(500).optional(),
  }).strict(),
});

export const adminRefundSchema = z.object({
  params: z.object({ userId: z.string().uuid() }),
  body: z.object({
    chargeId: z.string().min(1).max(100),
    type: z.enum(['subscription', 'gift', 'power_up']),
    override: z.boolean().optional(),
    overrideReason: z.string().max(500).optional(),
    reason: z.string().max(500).optional(),
  }).strict().refine(
    (data) => !data.override || (data.overrideReason && data.overrideReason.length > 0),
    { message: 'Override reason is required when override is true', path: ['overrideReason'] }
  ),
});


// Family

export const createFamilyLinkSchema = z.object({
  body: z.object({
    childUsername: z.string().min(1, 'Child username is required').max(32),
    childDiscriminator: discriminatorSchema,
  }).strict(),
});

export const updateFamilyRestrictionsSchema = z.object({
  body: z.object({
    blockDmFromNonFriends: z.boolean().optional(),
    blockServerJoin: z.boolean().optional(),
    dailyTimeLimitMinutes: z.number().int().min(0).max(1440).nullable().optional(),
  }).strict(),
});

// MFA

export const mfaCodeSchema = z.object({
  body: z.object({
    code: z.string().min(1, 'Code is required').max(10),
    setupToken: z.string().max(4096).optional(),
  }).strict(),
});

export const mfaTokenSchema = z.object({
  body: z.object({
    mfaToken: z.string().max(2048),
  }).strict(),
});

export const mfaTokenCodeSchema = z.object({
  body: z.object({
    mfaToken: z.string().max(2048),
    code: z.string().min(1, 'Code is required').max(10),
  }).strict(),
});

// Device-verification challenge for new-device logins. Paired JWT
// (verifyToken) carries the userId + purpose='device-verify'; the server
// verifies the JWT and runs its own single-use check.
export const verifyDeviceSendSchema = z.object({
  body: z.object({
    verifyToken: z.string().min(20).max(2048),
    method: z.enum(['email', 'sms']),
  }).strict(),
});

export const verifyDeviceConfirmSchema = z.object({
  body: z.object({
    verifyToken: z.string().min(20).max(2048),
    code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
    trustDevice: z.boolean(),
  }).strict(),
});

export const phoneSetupSchema = z.object({
  body: z.object({
    phoneNumber: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Invalid phone number (E.164 format required)'),
  }).strict(),
});

const webauthnCredentialSchema = z.object({
  id: z.string().max(1024),
  rawId: z.string().max(2048),
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: z.string().max(8192),
    attestationObject: z.string().max(65536).optional(),
    authenticatorData: z.string().max(8192).optional(),
    signature: z.string().max(2048).optional(),
    userHandle: z.string().max(1024).nullable().optional(),
  }),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults: z.record(z.string().max(64), z.unknown()).optional(),
}).strict();

// Passkey enrollment re-auth fields: either `password` or `mfaCode`
// is required at the handler level (not via Zod) because the required factor
// depends on whether the account is SSO-only or has a password. Shared by
// /passkey/register-options and /passkey/register-session. The header fallback
// (`x-confirm-password`) mirrors the `/totp/setup` pattern.
export const passkeyEnrollmentReauthSchema = z.object({
  body: z.object({
    password: z.string().min(1).max(128).optional(),
    mfaCode: z.string().min(1).max(10).optional(),
  }).strict(),
});

export const passkeyRegisterSchema = z.object({
  body: z.object({
    challengeToken: z.string().max(2048),
    credential: webauthnCredentialSchema,
    name: z.string().max(100).transform(stripControlChars).optional(),
    password: z.string().min(1).max(128).optional(),
    mfaCode: z.string().min(1).max(10).optional(),
  }).strict(),
});

export const passkeyAuthVerifySchema = z.object({
  body: z.object({
    challengeToken: z.string().max(2048),
    credential: webauthnCredentialSchema,
  }).strict(),
});

export const passkeyLoginVerifySchema = z.object({
  body: z.object({
    challengeToken: z.string().max(2048),
    credential: webauthnCredentialSchema,
  }).strict(),
});

export const disableMfaSchema = z.object({
  body: z.object({
    password: z.string().min(1, 'Password is required').max(128),
  }).strict(),
});

// Admin

export const adminUserSearchQuery = z.object({
  query: z.object({
    q: z.string().max(200).default(''),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    plan: z.enum(['free', 'essential', 'pro']).optional(),
    status: z.enum(['online', 'offline']).optional(),
    verified: z.enum(['true', 'false']).optional(),
  }).strict(),
});

export const adminAuditLogQuery = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    action: z.string().max(100).optional(),
    adminId: z.string().uuid().optional(),
    targetUserId: z.string().uuid().optional(),
    targetName: z.string().max(100).optional(),
  }).strict(),
});

export const adminUpdatePlanSchema = z.object({
  body: z.object({
    plan: z.enum(['essential', 'pro']).nullable(),
    durationMonths: z.number().int().min(0).max(12).optional(),
  }).strict(),
});

export const adminUpdateEmailSchema = z.object({
  body: z.object({
    email: emailSchema,
  }).strict(),
});

export const adminUpdateUsernameSchema = z.object({
  body: z.object({
    username: usernameSchema.optional(),
    discriminator: discriminatorSchema.optional(),
  }).strict().refine(
    (d) => d.username !== undefined || d.discriminator !== undefined,
    { message: 'Username or discriminator is required' },
  ),
});

export const adminSuspendSchema = z.object({
  body: z.object({
    reason: z.string().max(500).optional(),
  }).strict(),
});

// Power-Ups


// LiveKit

export const livekitTokenSchema = z.object({
  body: z.object({
    roomName: z.string().min(1, 'Room name is required').max(200).transform(stripControlChars),
    participantName: z.string().min(1, 'Participant name is required').max(100).transform(stripControlChars),
  }).strict(),
});

// SSO

export const appleCallbackSchema = z.object({
  body: z.object({
    id_token: z.string().min(1, 'ID token is required').max(8192),
    user: z.string().max(8192).optional(),
    state: z.string().max(256).optional(),
  }).strict(),
});

export const ssoLinkTokenSchema = z.object({
  body: z.object({
    provider: z.enum(['google', 'apple', 'steam']),
  }).strict(),
});

export const ssoExchangeCodeSchema = z.object({
  body: z.object({
    code: z.string().min(1, 'Missing code').max(2048),
  }).strict(),
});

export const gdprExportSchema = z.object({
  body: z.object({
    password: z.string().max(256).optional(),
    confirmSsoExport: z.boolean().optional(),
  }).strict(),
});

export const gdprDeleteSchema = z.object({
  body: z.object({
    password: z.string().max(256).optional(),
    confirmSsoDelete: z.boolean().optional(),
  }).strict(),
});

export const gdprDeactivateSchema = z.object({
  body: z.object({
    password: z.string().max(256).optional(),
    confirmSsoDeactivate: z.boolean().optional(),
  }).strict(),
});

export const adminLoginSchema = z.object({
  body: z.object({
    email: z.string().min(1, 'Email or username is required').max(254),
    password: z.string().min(1, 'Password is required').max(256),
  }).strict(),
});

export const adminServerSearchQuery = z.object({
  query: z.object({
    q: z.string().max(200).default(''),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    powerUpTier: z.coerce.number().int().min(0).max(3).optional(),
    minMembers: z.coerce.number().int().min(0).optional(),
  }).strict(),
});

export const adminDataRequestsQuery = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    status: z.enum(['pending', 'processing', 'ready', 'failed', 'expired']).optional(),
  }).strict(),
});

export const adminReportsQuery = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    status: z.enum(['pending', 'reviewed', 'actioned', 'dismissed']).optional(),
  }).strict(),
});

// Community/Public Servers: server-level T&S reports.
// User-submission body for POST /api/v1/servers/:serverId/report.
export const SERVER_REPORT_REASONS = [
  'spam',
  'harassment',
  'illegal',
  'nsfw_undeclared',
  'impersonation',
  'other',
] as const;

export const SERVER_REPORT_ACTIONS = [
  'none',
  'warn',
  'hide',
  'suspend',
  'remove',
] as const;

export const submitServerReportSchema = z.object({
  body: z.object({
    reason: z.enum(SERVER_REPORT_REASONS),
    details: z.string().max(2000).transform(stripControlChars).optional(),
    captchaToken: z.string().min(1).max(2048),
  }).strict(),
});

// Admin queue: page-based listing with optional status filter.
export const adminServerReportsQuery = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(50),
    status: z.enum(['pending', 'reviewed', 'actioned', 'dismissed']).optional(),
  }).strict(),
});

export const adminServerReportUpdateSchema = z.object({
  body: z.object({
    status: z.enum(['pending', 'reviewed', 'actioned', 'dismissed']),
    actionTaken: z.enum(SERVER_REPORT_ACTIONS).optional(),
    reviewNote: z.string().max(1000).transform(stripControlChars).optional(),
  }).strict(),
});

export const adminFlaggedHashesQuery = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    reason: z.enum(['csam', 'illegal', 'other']).optional(),
  }).strict(),
});

export const adminImageHashesQuery = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    hash: z.string().regex(/^[0-9a-f]{64}$/i, 'Must be a 64-character hex string').optional(),
    flagMatch: z.enum(['true', 'false']).optional(),
  }).strict(),
});

export const adminUserAuditLogQuery = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }).strict(),
});

// Reactions

export const reactMessageSchema = z.object({
  body: z.object({
    emoji: z.string().min(1).max(32).transform(s => s.trim()),
  }).strict(),
});

export const addGroupDmMembersSchema = z.object({
  body: z.object({
    memberIds: z.array(z.string().uuid()).min(1).max(14),
  }).strict(),
});

// Admin MFA

export const adminMfaEnableSchema = z.object({
  body: z.object({
    setupToken: z.string().min(1).max(4096),
    code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
  }).strict(),
});

export const adminMfaDisableSchema = z.object({
  body: z.object({
    password: z.string().min(1).max(256),
    code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
  }).strict(),
});

// DM E2E Encryption key-management schemas

const base64String = z.string().max(65536).regex(/^[A-Za-z0-9+/=]*$/, 'Invalid base64');

export const dmKeysSetupSchema = z.object({
  body: z.object({
    publicKey: base64String,
    // Optional on setup for backward-compat with pre-migration clients;
    // required in practice for new bundles (client always sends it).
    signingPublicKey: base64String.optional(),
    encryptedBlob: base64String,
    blobSalt: base64String,
    recoveryBlob: base64String,
    recoveryNonce: base64String,
    recoveryMode: z.enum(['key', 'passphrase']).optional(),
    recoveryPassphraseSalt: base64String.optional(),
  }).strict(),
});

// PUT /dms/keys/signing-key — lazy upload from legacy bundles.
export const dmKeysSigningKeyUpdateSchema = z.object({
  body: z.object({
    signingPublicKey: base64String,
    encryptedBlob: base64String,
    blobVersion: z.number().int().min(1),
    rawBlobForEscrow: base64String.optional(),
  }).strict(),
});

// Move-to-Private - rotate the roaming identity. Updates the X25519 box public
// key + Ed25519 signing public key + re-sealed blob atomically (blobVersion +
// signingPublicKey CAS). When the Ed25519 AIK rotates, aikRotation/aikHead carry the
// predecessor-signed attestation appended in the SAME transaction.
const aikRotationLinkSchema = z.object({
  seq: z.number().int().min(1),
  oldAik: base64String,
  newAik: base64String,
  signature: base64String,
}).strict();

const aikHeadSchema = z.object({
  seq: z.number().int().min(1),
  aik: base64String,
  signature: base64String,
}).strict();

export const dmKeysRoamingIdentitySchema = z.object({
  body: z.object({
    publicKey: base64String,
    signingPublicKey: base64String,
    encryptedBlob: base64String,
    blobVersion: z.number().int().min(1),
    rawBlobForEscrow: base64String.optional(),
    aikRotation: aikRotationLinkSchema.optional(),
    aikHead: aikHeadSchema.optional(),
  }).strict(),
});

export const dmKeyBlobUpdateSchema = z.object({
  body: z.object({
    encryptedBlob: base64String,
    blobVersion: z.number().int().min(1),
    rawBlobForEscrow: base64String.optional(),
  }).strict(),
});

export const dmKeyPasswordChangeSchema = z.object({
  body: z.object({
    encryptedBlob: base64String,
    blobSalt: base64String,
    blobVersion: z.number().int().min(1),
    recoveryBlob: base64String,
    recoveryNonce: base64String,
    recoveryMode: z.enum(['key', 'passphrase', 'server-escrowed']).optional(),
    recoveryPassphraseSalt: base64String.optional(),
    // Optional: the Ed25519 AIK public matching the privateSigningKey inside the
    // re-sealed blob. Written atomically with the blob so the signingPublicKey column
    // can never lag the blob's AIK (closes the column != blob divergence class).
    signingPublicKey: base64String.optional(),
    rawBlobForEscrow: base64String.optional(),
  }).strict(),
});

export const dmKeysRecoverSchema = z.object({
  body: z.object({
    encryptedBlob: base64String,
    blobSalt: base64String,
    recoveryBlob: base64String.optional(),
    recoveryNonce: base64String.optional(),
    recoveryMode: z.enum(['key', 'passphrase', 'server-escrowed']).optional(),
    recoveryPassphraseSalt: base64String.optional(),
    // Optional: the Ed25519 AIK public matching the privateSigningKey inside the
    // recovered blob. Written atomically with the blob so recovery heals a column that
    // diverged from the blob's AIK (e.g. after a roaming-identity rotation).
    signingPublicKey: base64String.optional(),
    rawBlobForEscrow: base64String.optional(),
  }).strict(),
});

export const enablePasswordDerivedSchema = z.object({
  body: z.object({
    rawBlobForEscrow: base64String,
  }).strict(),
});

// MLS — DS/AS request schemas.
// Opaque MLS artifacts ride as base64 strings; epochs ride as decimal strings
// (uint64 > 2^53 loses precision as a JSON number). REST bodies use .strict().
const mlsBytes = z
  .string()
  .min(1)
  .max(262144) // 256 KiB base64 ~= 192 KiB binary; GroupInfo embeds the public ratchet tree
  .regex(/^[A-Za-z0-9+/=]*$/, 'Invalid base64');

const epochString = z.string().regex(/^\d+$/, 'epoch must be a decimal string').max(20);

const idempotencyKey = z.string().min(8).max(200);

export const mlsPublishKeyPackagesSchema = z.object({
  body: z
    .object({
      deviceId: z.string().uuid(),
      keyPackages: z
        .array(
          z
            .object({
              keyPackage: mlsBytes,
              isLastResort: z.boolean().optional().default(false),
            })
            .strict(),
        )
        .min(1)
        .max(50)
        .refine(
          (arr) => arr.filter((k) => k.isLastResort).length <= 1,
          { message: 'A batch may contain at most one last-resort KeyPackage' },
        ),
    })
    .strict(),
});

export const mlsKeyPackageUserParamSchema = z.object({
  params: z.object({ userId: z.string().uuid() }).strict(),
});

export const mlsKeyPackageCountQuerySchema = z.object({
  query: z.object({ deviceId: z.string().uuid() }).strict(),
});

export const mlsCreateGroupSchema = z.object({
  body: z
    .object({
      dmChannelId: z.string().uuid(),
      tier: z.enum(['saved', 'otr']).optional().default('saved'),
      groupInfo: mlsBytes,
    })
    .strict(),
});

export const mlsGroupIdParamSchema = z.object({
  params: z.object({ groupId: z.string().uuid() }).strict(),
});

// Manual teardown of a stranded 1:1 MLS group (recovery for the pre-attestation cohort).
// expectedEpoch binds the caller's view (TOCTOU): the server only deletes the exact
// group state the caller saw.
export const mlsGroupResetSchema = z.object({
  params: z.object({ groupId: z.string().uuid() }).strict(),
  body: z.object({ expectedEpoch: epochString }).strict(),
});

// Body-only (no params): the groupId path param is validated by validateUuidParams('groupId') at the route.
export const mlsSubmitCommitSchema = z.object({
  body: z
    .object({
      baseEpoch: epochString,
      mode: z.enum(['member', 'external']),
      commit: mlsBytes,
      groupInfo: mlsBytes,
      idempotencyKey,
      welcomes: z
        .array(z.object({ recipientId: z.string().uuid(), welcomeData: mlsBytes }).strict())
        .max(50)
        .optional(),
      removedUserIds: z.array(z.string().uuid()).max(50).optional(),
    })
    .strict(),
});

// Query-only (no params): groupId path param validated by validateUuidParams('groupId') at the route.
export const mlsCommitCatchupSchema = z.object({
  query: z
    .object({
      sinceEpoch: epochString,
      limit: z.coerce.number().int().min(1).max(200).default(100),
    })
    .strict(),
});

export const mlsWelcomesQuerySchema = z.object({
  query: z
    .object({ limit: z.coerce.number().int().min(1).max(100).default(100) })
    .strict(),
});

// Cross-device DM history archive (REST; .strict() per the REST rule).
const archiveCiphertext = z.string().min(1).max(32768).regex(/^[A-Za-z0-9+/=]*$/, 'Invalid base64');
const archiveEnvelopeHash = z.string().regex(/^[0-9a-f]{1,128}$/, 'Invalid envelope hash');

export const dmHistoryArchivePostSchema = z.object({
  body: z.object({
    items: z
      .array(
        z.object({
          dmChannelId: z.string().uuid(),
          envelopeHash: archiveEnvelopeHash,
          ciphertext: archiveCiphertext,
          keyVersion: z.number().int().min(1).max(1_000_000),
          messageId: z.string().uuid(),
          msgCreatedAt: z.string().datetime(),
        }).strict(),
      )
      .min(1)
      .max(50),
  }).strict(),
});

export const dmHistoryArchivePreviewsSchema = z.object({
  query: z.object({
    cursor: z.string().uuid().optional(), // last dmChannelId from the previous page
  }).strict(),
});

export const dmHistoryArchiveChannelSchema = z.object({
  query: z.object({
    cursor: z.string().uuid().optional(), // last row id from the previous page
  }).strict(),
});

// Bulk wipe of the caller archive (move-to-Private re-seal). The optional
// keyVersion raises the per-user minArchiveKeyVersion floor so a stale sibling
// tab cannot re-upload rows sealed under the old escrow-exposed archiveKey.
export const dmHistoryArchiveBulkDeleteSchema = z.object({
  query: z.object({
    // Same upper bound as the POST items' keyVersion so the floor can track any
    // future generation (avoids a latent wedge where the floor caps below an
    // accepted upload keyVersion).
    keyVersion: z.coerce.number().int().min(1).max(1_000_000).optional(),
  }).strict(),
});

export const serverRecoverSchema = z.object({
  body: z.object({
    password: z.string().min(1).max(256),
  }).strict(),
});

export const adminMfaVerifySchema = z.object({
  body: z.object({
    mfaToken: z.string().min(1).max(4096),
    code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
  }).strict(),
});

export const adminChangePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1).max(256),
    newPassword: passwordSchema,
  }).strict(),
});

// Admin Passkey (WebAuthn, mandatory second factor after TOTP)

export const adminPasskeyRegisterBeginSchema = z.object({
  body: z.object({}).strict().optional(),
});

export const adminPasskeyRegisterFinishSchema = z.object({
  body: z.object({
    challengeToken: z.string().max(4096),
    credential: webauthnCredentialSchema,
    friendlyName: z.string().min(1).max(100).transform(stripControlChars),
  }).strict(),
});

export const adminPasskeyLoginBeginSchema = z.object({
  body: z.object({
    passkeyToken: z.string().min(1).max(4096),
  }).strict(),
});

export const adminPasskeyLoginFinishSchema = z.object({
  body: z.object({
    challengeToken: z.string().max(4096),
    credential: webauthnCredentialSchema,
  }).strict(),
});

export const adminPasskeyDeleteSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const adminEnrollmentCompleteSchema = z.object({
  body: z.object({
    enrollmentToken: z.string().min(1).max(4096),
  }).strict(),
});

// Admin-side MFA reset (recovery): superadmin/owner clears another admin's
// TOTP + passkeys so they can re-enroll. Different from adminMfaDisableSchema
// which is the admin-disables-own-mfa path (unused once full MFA is enforced).
export const adminDisableTargetMfaSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

// Admin Account Management

export const adminCreateAccountSchema = z.object({
  body: z.object({
    email: z.string().email().max(256),
    username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/, 'Username must be alphanumeric with underscores only'),
    password: passwordSchema,
    role: z.enum(['admin', 'superadmin']),
  }).strict(),
});

export const adminAccountIdSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const listenAlongSchema = z.object({
  body: z.object({
    targetUserId: z.string().uuid(),
  }).strict(),
});

export const spotifyPlayPauseSchema = z.object({
  body: z.object({
    action: z.enum(['play', 'pause']),
  }).strict(),
});

export const spotifyShuffleSchema = z.object({
  body: z.object({
    state: z.boolean(),
  }).strict(),
});

export const spotifyRepeatSchema = z.object({
  body: z.object({
    state: z.enum(['off', 'track', 'context']),
  }).strict(),
});

export const adminChangeRoleSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    role: z.enum(['admin', 'superadmin']),
  }).strict(),
});

// Calendar Events

export const EVENT_COLORS = ['#378ADD', '#1D9E75', '#7F77DD', '#D4537E', '#D85A30', '#BA7517', '#639922', '#5F5E5A'] as const;
export const EVENT_REMINDER_TIMINGS = ['AT_START', '15_MIN', '1_HOUR', '1_DAY', '1_WEEK'] as const;

export const EVENT_INVITE_SCOPES = ['EVERYONE', 'ROLE', 'USER'] as const;
export const RECURRENCE_RULES = ['NONE', 'DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'CUSTOM'] as const;

const eventInviteeSchema = z.object({
  scope: z.enum(EVENT_INVITE_SCOPES),
  targetId: z.string().uuid().optional(),
}).strict();

export const createEventSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(100).trim().transform(stripControlChars),
    description: z.string().max(2000).trim().transform(stripControlChars).optional(),
    startTime: z.string().datetime(),
    endTime: z.string().datetime(),
    allDay: z.boolean().optional(),
    color: z.enum(EVENT_COLORS).optional(),
    timezone: z.string().max(50).optional(),
    reminderChannelId: z.string().uuid().optional(),
    reminders: z.array(z.enum(EVENT_REMINDER_TIMINGS)).max(5).optional(),
    invitees: z.array(eventInviteeSchema).max(50).optional(),
    recurrenceRule: z.enum(RECURRENCE_RULES).optional(),
    recurrenceDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    recurrenceEndDate: z.string().datetime().nullable().optional(),
    voiceChannelId: z.string().uuid().nullable().optional(),
    reminderMentions: z.object({
      everyone: z.boolean().optional(),
      here: z.boolean().optional(),
      roleIds: z.array(z.string().uuid()).max(25).optional(),
    }).strict().nullable().optional(),
  }).strict(),
});

export const updateEventSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(100).trim().transform(stripControlChars).optional(),
    description: z.string().max(2000).trim().transform(stripControlChars).nullable().optional(),
    startTime: z.string().datetime().optional(),
    endTime: z.string().datetime().optional(),
    allDay: z.boolean().optional(),
    color: z.enum(EVENT_COLORS).optional(),
    timezone: z.string().max(50).optional(),
    reminderChannelId: z.string().uuid().nullable().optional(),
    reminders: z.array(z.enum(EVENT_REMINDER_TIMINGS)).max(5).optional(),
    invitees: z.array(eventInviteeSchema).max(50).optional(),
    recurrenceRule: z.enum(RECURRENCE_RULES).optional(),
    recurrenceDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    recurrenceEndDate: z.string().datetime().nullable().optional(),
    voiceChannelId: z.string().uuid().nullable().optional(),
    reminderMentions: z.object({
      everyone: z.boolean().optional(),
      here: z.boolean().optional(),
      roleIds: z.array(z.string().uuid()).max(25).optional(),
    }).strict().nullable().optional(),
  }).strict(),
});

export const eventMonthQuery = z.object({
  query: z.object({
    month: z.coerce.number().int().min(1).max(12).optional(),
    year: z.coerce.number().int().min(2020).max(2100).optional(),
  }).strict(),
});

export const eventRsvpSchema = z.object({
  body: z.object({
    status: z.enum(['GOING', 'INTERESTED', 'DECLINED']),
  }).strict(),
});

// Polls

export const createPollSchema = z.object({
  body: z.object({
    // Strip BiDi/zero-width — poll text is broadcast to every channel viewer.
    question: z.string().min(1).max(300).trim().transform(stripControlChars),
    options: z.array(
      z.union([
        z.string().min(1).max(80).trim().transform(stripControlChars),
        z.object({
          text: z.string().min(1).max(80).trim().transform(stripControlChars),
          emoji: z.string().max(64).trim().optional(),
        }).strict(),
      ])
    ).min(2).max(15),
    allowMultiple: z.boolean().optional().default(false),
    anonymous: z.boolean().optional().default(false),
    duration: z.enum(['15', '30', '60', '240', '480', '1440', '4320', '10080', 'none']).optional().default('1440'),
  }).strict(),
});

export const editPollSchema = z.object({
  body: z.object({
    // Strip BiDi/zero-width control characters.
    question: z.string().min(1).max(300).trim().transform(stripControlChars).optional(),
    allowMultiple: z.boolean().optional(),
    anonymous: z.boolean().optional(),
    duration: z.enum(['15', '30', '60', '240', '480', '1440', '4320', '10080', 'none']).optional(),
    closePoll: z.boolean().optional(),
  }).strict(),
});

export const pollVoteSchema = z.object({
  body: z.object({
    optionId: z.string().uuid(),
  }).strict(),
});

// Threads

export const createThreadSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).trim(),
    parentMessageId: z.string().uuid(),
    autoArchive: z.boolean().optional().default(true),
    autoArchiveDuration: z.enum(['15', '30', '1440', '4320', '10080', '21600', '43200']).optional().default('1440'),
  }).strict(),
});

export const editThreadSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).trim().optional(),
    archived: z.boolean().optional(),
    autoArchive: z.boolean().optional(),
    autoArchiveDuration: z.enum(['15', '30', '1440', '4320', '10080', '21600', '43200']).optional(),
  }).strict(),
});

export const editThreadMessageSchema = z.object({
  body: z.object({
    content: z.string().min(1).max(4000),
  }).strict(),
});

export const sendThreadMessageSchema = z.object({
  body: z.object({
    content: z.string().max(4000),
    replyToMessageId: z.string().uuid().optional(),
    attachment: z.object({
      url: safeUrlSchema,
      name: z.string().max(255),
      contentType: z.string().max(100).optional(),
      width: z.number().int().positive().max(10000).nullable().optional(),
      height: z.number().int().positive().max(10000).nullable().optional(),
    }).strict().optional(),
  }).strict(),
});

export const getThreadMessagesQuery = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.string().uuid().optional(),
    after: z.string().uuid().optional(),
  }).strict(),
});

// Stages

export const startStageSchema = z.object({
  body: z.object({
    topic: z.string().max(200).trim().optional(),
    maxSpeakers: z.number().int().min(1).max(25).optional().default(10),
    textChatEnabled: z.boolean().optional().default(false),
    allowEmojis: z.boolean().optional().default(false),
    allowStickers: z.boolean().optional().default(false),
    allowGifs: z.boolean().optional().default(false),
    invitedSpeakerUserIds: z.array(z.string().uuid()).max(50).optional().default([]),
    invitedRoleIds: z.array(z.string().uuid()).max(20).optional().default([]),
  }).strict(),
});

export const editStageSchema = z.object({
  body: z.object({
    topic: z.string().max(200).trim().optional(),
    maxSpeakers: z.number().int().min(1).max(25).optional(),
    textChatEnabled: z.boolean().optional(),
    allowEmojis: z.boolean().optional(),
    allowStickers: z.boolean().optional(),
    allowGifs: z.boolean().optional(),
  }).strict(),
});

export const stageUserActionSchema = z.object({
  body: z.object({
    userId: z.string().uuid(),
  }).strict(),
});

export const stageLowerHandSchema = z.object({
  body: z.object({
    userId: z.string().uuid().optional(),
  }).strict(),
});

// Notifications

export const notificationListQuery = z.object({
  query: z.object({
    serverId: z.string().uuid().optional(),
    unreadOnly: z.enum(['true', 'false']).default('true'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.string().datetime().optional(),
  }).strict(),
});

export const notificationReadAllSchema = z.object({
  body: z.object({
    serverId: z.string().uuid().optional(),
  }).strict(),
});

// Channel Permissions

// targetId: UUID for real roles/members, or literal 'everyone' for the @everyone virtual role
const permissionTargetId = z.string().refine(
  (v) => v === 'everyone' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  { message: 'Must be a UUID or "everyone"' },
);

export const channelPermissionOverrideSchema = z.object({
  body: z.object({
    targetType: z.enum(['role', 'member']),
    targetId: permissionTargetId,
    permissions: z.record(
      z.string().refine((k) => (VALID_PERMISSIONS as readonly string[]).includes(k), { message: 'Invalid permission key' }),
      z.boolean().nullable(),
    ).refine((obj) => Object.keys(obj).length > 0 && Object.keys(obj).length <= 60, { message: 'Permissions must have 1-60 entries' }),
  }).strict(),
});

export const categoryPermissionOverrideSchema = z.object({
  body: z.object({
    targetType: z.enum(['role', 'member']),
    targetId: permissionTargetId,
    permissions: z.record(
      z.string().refine((k) => (VALID_PERMISSIONS as readonly string[]).includes(k), { message: 'Invalid permission key' }),
      z.boolean().nullable(),
    ).refine((obj) => Object.keys(obj).length > 0 && Object.keys(obj).length <= 60, { message: 'Permissions must have 1-60 entries' }),
  }).strict(),
});

// Forum

export const createForumPostSchema = z.object({
  body: z.object({
    title: z.string().min(1, 'Title is required').max(100).trim().transform(stripControlChars),
    content: z.string().min(1, 'Content is required').max(4000).transform(stripControlChars),
    imageUrl: z.string().max(512).optional(),
    tagIds: z.array(z.string().uuid()).max(5).optional(),
  }).strict(),
});

export const updateForumPostSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(100).trim().transform(stripControlChars).optional(),
    content: z.string().min(1).max(4000).transform(stripControlChars).optional(),
    imageUrl: z.string().max(512).nullable().optional(),
    pinned: z.boolean().optional(),
    locked: z.boolean().optional(),
    tagIds: z.array(z.string().uuid()).max(5).optional(),
  }).strict(),
});

export const createForumMessageSchema = z.object({
  body: z.object({
    content: z.string().min(1, 'Content is required').max(4000).transform(stripControlChars),
    attachmentUrl: z.string().max(512).optional(),
    attachmentName: z.string().max(255).transform(stripControlChars).optional(),
    attachmentContentType: z.string().max(127).optional(),
    attachmentWidth: z.number().int().min(1).max(20000).optional(),
    attachmentHeight: z.number().int().min(1).max(20000).optional(),
  }).strict(),
});

export const updateForumMessageSchema = z.object({
  body: z.object({
    content: z.string().min(1).max(4000).transform(stripControlChars),
  }).strict(),
});

export const forumPostListQuery = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    before: z.string().uuid().optional(),
    sortBy: z.enum(['recent_activity', 'creation_date']).default('recent_activity'),
    tagId: z.string().uuid().optional(),
  }),
});

export const forumMessageListQuery = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.string().uuid().optional(),
  }),
});

export const forumReactionSchema = z.object({
  body: z.object({
    emoji: z.string().min(1).max(64),
  }).strict(),
});

export const createForumTagSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Tag name is required').max(20).trim().transform(stripControlChars),
    emoji: z.string().max(64).optional(),
    color: hexColorSchema,
  }).strict(),
});

export const updateForumTagSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(20).trim().transform(stripControlChars).optional(),
    emoji: z.string().max(64).nullable().optional(),
    color: hexColorSchema,
    position: z.number().int().min(0).max(100).optional(),
  }).strict(),
});

export const reorderForumTagsSchema = z.object({
  body: z.object({
    tags: z.array(z.object({
      id: z.string().uuid(),
      position: z.number().int().min(0).max(100),
    }).strict()).min(1).max(20),
  }).strict(),
});

// Showcase / Game Accounts

export const VALID_GAMES = ['cs2', 'dota2', 'valorant', 'lol', 'tft', 'fortnite', 'apex', 'marvel_rivals', 'r6_siege'] as const;
export const VALID_GAME_PROVIDERS = ['steam', 'riot', 'epic', 'ea', 'ubisoft', 'marvel_rivals'] as const;
export const VALID_PLATFORMS = ['pc', 'psn', 'xbox'] as const;

export const VALID_SHOWCASE_CARD_TYPES = [
  'game_rank', 'game_stats', 'spotify_artists', 'spotify_tracks',
  'spotify_now_playing', 'steam_playtime', 'steam_recent_activity',
  'rank_timeline', 'custom_text',
  'twitch_stats', 'youtube_stats', 'github_stats', 'reddit_stats',
] as const;

export const VALID_SHOWCASE_SIZES = ['1x1', '2x1', '3x1', '1x2', '2x2', '1x3', '2x3', '3x2'] as const;

// Which games belong to which provider
export const GAME_PROVIDER_MAP: Record<string, string> = {
  cs2: 'steam',
  dota2: 'steam',
  valorant: 'riot',
  lol: 'riot',
  tft: 'riot',
  fortnite: 'epic',
  apex: 'ea',
  marvel_rivals: 'marvel_rivals',
  r6_siege: 'ubisoft',
};

export const linkGameAccountSchema = z.object({
  body: z.object({
    game: z.enum(VALID_GAMES),
    // Strip BiDi/zero-width control characters.
    platformId: z.string().min(1).max(128).trim().transform(stripControlChars),
    platform: z.enum(VALID_PLATFORMS).nullable().optional(),
    displayName: z.string().min(1).max(64).trim().transform(stripControlChars).optional(),
  }).strict(),
});

const showcaseCardSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(VALID_SHOWCASE_CARD_TYPES),
  game: z.enum(VALID_GAMES).nullable().optional(),
  size: z.enum(VALID_SHOWCASE_SIZES),
  position: z.number().int().min(0).max(50),
  color: z.string().max(32).nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional().default({}),
});

export const updateShowcaseLayoutSchema = z.object({
  body: z.object({
    layout: z.array(showcaseCardSchema).max(30),
  }).strict(),
});

// Server Folders

export const createServerFolderSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(32).trim(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    serverIds: z.array(z.string().uuid()).max(200).default([]),
  }).strict(),
});

export const updateServerFolderSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(32).trim().optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    serverIds: z.array(z.string().uuid()).max(200).optional(),
    muted: z.boolean().optional(),
  }).strict(),
});

export const reorderServerFoldersSchema = z.object({
  body: z.object({
    folderIds: z.array(z.string().uuid()).max(20),
  }).strict(),
});

export const importServerFoldersSchema = z.object({
  body: z.object({
    folders: z.array(z.object({
      name: z.string().min(1).max(32).trim(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      serverIds: z.array(z.string().uuid()).max(200),
      muted: z.boolean().default(false),
    }).strict()).max(20),
  }).strict(),
});

// Admin: Analytics

export const adminAnalyticsQuery = z.object({
  query: z.object({
    range: z.enum(['24h', '7d', '30d', '3mo', '6mo']).default('24h'),
  }).strict(),
});

export const adminProtocolDistributionQuery = z.object({
  query: z.object({
    range: z.enum(['24h', '7d', '14d', '30d', '60d']).optional(),
    thresholdBuildDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).strict(),
});

// Admin: Badge Management

export const adminManageBadgeSchema = z.object({
  params: z.object({ userId: z.string().uuid() }),
  body: z.object({
    action: z.enum(['add', 'remove']),
    badge: z.string().min(1).max(50),
  }).strict(),
});

// Admin: Forum Moderation

export const adminForumsQuery = z.object({
  query: z.object({
    q: z.string().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    serverId: z.string().uuid().optional(),
  }).strict(),
});
export const adminForumActionSchema = z.object({
  params: z.object({ postId: z.string().uuid() }),
});

// Admin: Thread Moderation

export const adminThreadsQuery = z.object({
  query: z.object({
    q: z.string().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    serverId: z.string().uuid().optional(),
    archived: z.enum(['true', 'false']).optional(),
  }).strict(),
});
export const adminThreadActionSchema = z.object({
  params: z.object({ threadId: z.string().uuid() }),
});

// Admin: Poll Moderation

export const adminPollsQuery = z.object({
  query: z.object({
    q: z.string().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    status: z.enum(['active', 'closed', 'all']).default('all'),
  }).strict(),
});
export const adminPollActionSchema = z.object({
  params: z.object({ pollId: z.string().uuid() }),
});

// Admin: Invites

export const adminInvitesQuery = z.object({
  query: z.object({
    q: z.string().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
  }).strict(),
});

// Admin: Server Moderation

export const adminServerBansQuery = z.object({
  params: z.object({ serverId: z.string().uuid() }),
  query: z.object({ page: z.coerce.number().int().min(1).default(1) }).strict(),
});
export const adminServerAuditQuery = z.object({
  params: z.object({ serverId: z.string().uuid() }),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    action: z.string().max(50).optional(),
  }).strict(),
});
export const adminServerAutomodQuery = z.object({
  params: z.object({ serverId: z.string().uuid() }),
});
export const adminServerSettingsQuery = z.object({
  params: z.object({ serverId: z.string().uuid() }),
});

// User self-service security event feed

export const listSecurityEventsQuery = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    /**
     * Forward-cursor pagination. `cursor` is the `createdAt` of the last
     * event seen; the route returns rows strictly older than it. ISO-8601
     * datetime enforced so callers can't inject arbitrary strings.
     */
    cursor: z.string().datetime().optional(),
  }).strict(),
});

// Community discovery directory
// Shared between authenticated `/api/v1/discover` and anonymous
// `/api/v1/public/discover`. Express `req.query` only delivers strings (or
// arrays of strings for repeated keys), so each numeric/array field uses the
// appropriate coercion or `union(z.string(), z.array(z.string()))` shape.

const DISCOVERY_CATEGORY_ENUM = z.enum([
  'gaming', 'music', 'education', 'science', 'technology', 'art', 'entertainment',
  'lifestyle', 'sports', 'anime', 'finance', 'business', 'community', 'support', 'other',
]);

// Tag entry — must match the normaliser in utils/discoveryFilters.ts so a
// well-formed cursor never gets stripped by the filter step.
const DISCOVERY_TAG_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Coerce repeatable `?tag=foo&tag=bar` into a string array regardless of
// whether Express delivered a single string or an array. Caps at 5 entries.
const repeatableTagSchema = z.preprocess(
  (v) => {
    if (v == null) return undefined;
    if (Array.isArray(v)) return v;
    return [v];
  },
  z.array(z.string().regex(DISCOVERY_TAG_REGEX, 'invalid tag').min(1).max(32)).max(5).optional(),
);

export const discoveryListQuery = z.object({
  query: z.object({
    cursor: z.string().min(1).max(256).optional(),
    category: DISCOVERY_CATEGORY_ENUM.optional(),
    tag: repeatableTagSchema,
    // Anchored, length-bounded ISO-639-1 + optional subtag. The eslint-plugin
    // pessimistically flags this as unsafe due to the alternation, but every
    // branch is finite + non-overlapping, so worst-case match is O(n).
    // eslint-disable-next-line security/detect-unsafe-regex
    language: z.string().regex(/^[a-z]{2}(-[A-Za-z0-9]{1,8})?$/, 'invalid language code').optional(),
    q: z.string().max(200).optional(),
    nsfw: z.enum(['exclude', 'include', 'only']).default('exclude'),
    sort: z.enum(['relevance', 'new', 'members', 'active']).default('relevance'),
  }).strict(),
});

export const discoveryFeaturedQuery = z.object({
  query: z.object({}).strict(),
});

export const discoveryCategoriesQuery = z.object({
  query: z.object({}).strict(),
});

// Apply-to-join: server application questions + submissions

/**
 * Schema for a single application question. Owners configure these on
 * ServerSettings.applicationQuestions; applicants answer them when joinMethod
 * is 'apply_to_join'. Limits are intentionally tight to keep payloads small
 * and avoid unbounded prompt/text storage.
 */
const applicationQuestionSchema = z.object({
  id: z.string().min(1).max(64),
  prompt: z.string().min(1).max(200).transform(stripControlChars),
  type: z.enum(['short_text', 'long_text', 'multiple_choice']),
  required: z.boolean(),
  maxLength: z.number().int().min(1).max(2000),
  choices: z.array(z.string().min(1).max(200).transform(stripControlChars)).max(10).optional(),
}).strict();

export const updateApplicationQuestionsSchema = z.object({
  params: z.object({ serverId: z.string().uuid() }).strict(),
  body: z.object({
    questions: z.array(applicationQuestionSchema).max(5),
  }).strict(),
});

export const getApplicationQuestionsSchema = z.object({
  params: z.object({ serverId: z.string().uuid() }).strict(),
});

// Answer body accepts either `value` (current frontend shape) or `answer`
// (the original spec — kept additive per docs/PROTOCOL_CHANGES.md so any
// out-of-tree client still works). The handler normalises to `value`.
const submitApplicationAnswerSchema = z.object({
  questionId: z.string().min(1).max(64),
  value: z.string().max(2000).transform(stripControlChars).optional(),
  answer: z.string().max(2000).transform(stripControlChars).optional(),
}).refine((a) => a.value !== undefined || a.answer !== undefined, {
  message: 'Each answer must include a `value` field.',
});

export const submitApplicationSchema = z.object({
  params: z.object({ serverId: z.string().uuid() }).strict(),
  body: z.object({
    answers: z.array(submitApplicationAnswerSchema).max(5),
    captchaToken: z.string().min(1).max(2048).optional(),
  }).strict(),
});

export const withdrawApplicationSchema = z.object({
  params: z.object({ serverId: z.string().uuid() }).strict(),
});

export const listApplicationsSchema = z.object({
  params: z.object({ serverId: z.string().uuid() }).strict(),
  query: z.object({
    status: z.enum(['pending', 'accepted', 'rejected', 'withdrawn']).optional(),
    cursor: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  }).strict(),
});

export const decideApplicationSchema = z.object({
  params: z.object({
    serverId: z.string().uuid(),
    appId: z.string().uuid(),
  }).strict(),
  body: z.object({
    decision: z.enum(['accept', 'reject']),
    // Applicant-facing message included in the decision email (both accept
    // and reject). Surfaced to the applicant — keep this for things they
    // should see ("welcome aboard, head to #intros", "we're looking for X
    // more years of experience").
    note: z.string().max(500).transform(stripControlChars).optional(),
    // Moderator-only note saved to the row for the rest of the team. NEVER
    // sent to the applicant. Use for internal bookkeeping / vouches.
    internalNote: z.string().max(1000).transform(stripControlChars).optional(),
  }).strict(),
});

// Admin: Server T&S actions
//
// The four flag flips (feature/unfeature, verify/unverify, unhide, unsuspend)
// accept an optional moderator note. `hide` requires a non-empty reason —
// admins must justify suppressing a server from discovery — and `suspend`
// requires a non-empty reason since the suspension reason is surfaced to the
// owner verbatim (and stored on `Server.suspensionReason`).

export const adminServerActionWithReasonSchema = z.object({
  params: z.object({ serverId: z.string().uuid() }).strict(),
  body: z.object({
    reason: z.string().max(1000).transform(stripControlChars).optional(),
  }).strict().optional(),
});

export const adminServerHideSchema = z.object({
  params: z.object({ serverId: z.string().uuid() }).strict(),
  body: z.object({
    reason: z.string().min(1, 'Reason is required').max(1000).transform(stripControlChars),
  }).strict(),
});

export const adminServerSuspendSchema = z.object({
  params: z.object({ serverId: z.string().uuid() }).strict(),
  body: z.object({
    reason: z.string().min(1, 'Reason is required').max(1000).transform(stripControlChars),
  }).strict(),
});

export const adminDiscoveryQueueQuery = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    // Bounded ≤50: every list query must have a take cap.
    limit: z.coerce.number().int().min(1).max(50).default(25),
  }).strict(),
});

// Self Roles

const conditionRequirementsSchema = z.object({
  accountAgeDays: z.number().int().min(0).max(36500).optional(),
  tenureDays: z.number().int().min(0).max(36500).optional(),
  hasRoleIds: z.array(z.string().uuid()).max(10).optional(),
  excludeRoleIds: z.array(z.string().uuid()).max(10).optional(),
  messageCount: z.number().int().min(0).max(1_000_000).optional(),
  manualApproval: z.boolean().optional(),
});

export const updateRolePickerSchema = z.object({
  body: z.object({
    heroTitle: z.string().trim().max(80).nullable().optional(),
    heroDescription: z.string().trim().max(280).nullable().optional(),
  }),
});

export const createPickerCategorySchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(40),
    pickMode: z.enum(['single', 'multi']).default('multi'),
    required: z.boolean().optional(),
  }),
});

export const updatePickerCategorySchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(40).optional(),
    pickMode: z.enum(['single', 'multi']).optional(),
    position: z.number().int().min(0).optional(),
    required: z.boolean().optional(),
  }),
});

export const completeServerOnboardingSchema = z.object({
  body: z.object({ completed: z.literal(true) }).strict(),
});

export const createPickerEntrySchema = z.object({
  body: z.object({
    roleId: z.string().uuid(),
    emoji: z.string().trim().max(8).nullable().optional(),
    iconUrl: z.string().trim().url().max(2048).nullable().optional(),
    description: z.string().trim().max(200).nullable().optional(),
    requirements: conditionRequirementsSchema.nullable().optional(),
  }),
});

export const updatePickerEntrySchema = z.object({
  body: z.object({
    emoji: z.string().trim().max(8).nullable().optional(),
    iconUrl: z.string().trim().url().max(2048).nullable().optional(),
    description: z.string().trim().max(200).nullable().optional(),
    requirements: conditionRequirementsSchema.nullable().optional(),
  }),
});

export const movePickerEntrySchema = z.object({
  body: z.object({
    categoryId: z.string().uuid().optional(),
    position: z.number().int().min(0),
  }),
});

export const submitClaimRequestSchema = z.object({
  body: z.object({
    applicantMessage: z.string().trim().max(500).optional(),
  }),
});

export const decideClaimRequestSchema = z.object({
  body: z.object({
    decision: z.enum(['approve', 'reject']),
    decisionNote: z.string().trim().max(500).optional(),
  }),
});

export const listClaimRequestsSchema = z.object({
  query: z.object({
    status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  }),
});

export const createInstanceUserSchema = z.object({
  body: z.object({
    username: usernameSchema,
    email: emailSchema,
    password: passwordSchema,
  }).strict(),
});

export const resetInstanceUserPasswordSchema = z.object({
  params: z.object({ userId: z.string().uuid() }),
  body: z.object({ newPassword: passwordSchema }).strict(),
});

