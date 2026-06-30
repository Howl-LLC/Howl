// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Shared export data builder — used by both the sync GDPR export route
 * and the async export worker to ensure identical export contents.
 */

import { prisma } from '../db.js';
import { decryptSecret } from './mfaCrypto.js';
import { decryptMessageContent } from './dmCrypto.js';

const MESSAGE_BATCH_SIZE = 5000;
const MESSAGE_EXPORT_LIMIT = 50000;

async function fetchMessagesBatched<T>(
  fetcher: (cursor: Date | null, batchSize: number) => Promise<T[]>,
  limit: number,
): Promise<T[]> {
  const results: T[] = [];
  let cursor: Date | null = null;
  while (results.length < limit) {
    const batch = await fetcher(cursor, Math.min(MESSAGE_BATCH_SIZE, limit - results.length));
    if (batch.length === 0) break;
    results.push(...batch);
    cursor = (batch[batch.length - 1] as any).createdAt;
  }
  return results;
}

export async function buildExportData(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, username: true, discriminator: true, email: true,
      avatar: true, banner: true, status: true, createdAt: true,
      emailVerified: true, mfaEnabled: true, role: true,
      nameColor: true, nameFont: true, nameEffect: true, avatarEffect: true,
      stripePlan: true, dateOfBirth: true, stripeCustomerId: true,
      stripeSubscriptionId: true, stripeStatus: true, stripePeriodEnd: true,
      hasUsedTrial: true, trialStartedAt: true,
      backgroundImage: true, backgroundOpacity: true, backgroundBlur: true,
      bgGifAlwaysPlay: true, badges: true,
      suspended: true, suspendedAt: true, suspendReason: true,
      showcaseLayout: true,
      gameAccounts: { select: { game: true, provider: true, platformId: true, platform: true, displayName: true, verified: true, createdAt: true } },
      tosAcceptedAt: true, privacyPolicyAcceptedAt: true, legalConsentVersion: true,
      notifyDesktop: true, notifyUnreadBadge: true, notifyTaskbarFlash: true,
      notifySoundNewMessage: true, notifySoundCurrentChannel: true,
      notifySoundIncomingRing: true, notifyDisableAllSounds: true,
      allowDmFromServerMembers: true, messageRequestsFilter: true,
      friendRequestsEveryone: true, friendRequestsFriendsOfFriends: true,
      friendRequestsServerMembers: true,
    },
  });
  if (!user) throw new Error('User not found');

  const [
    serverMemberships,
    dmParticipations,
    friendsSent,
    friendsReceived,
    blocks,
    blockedBy,
    sessions,
    ssoAccounts,
    passkeys,
    pushSubscriptions,
    familyLinksParent,
    familyLinksChild,
    serverPowerUps,
  ] = await Promise.all([
    prisma.serverMember.findMany({
      where: { userId },
      include: { server: { select: { id: true, name: true } } },
      take: 500,
    }),
    prisma.dMParticipant.findMany({
      where: { userId },
      select: { dmChannelId: true, joinedAt: true, lastReadAt: true, pinned: true, pinnedAt: true },
      take: 5000,
    }),
    prisma.friendRequest.findMany({
      where: { fromUserId: userId },
      select: { toUserId: true, status: true, createdAt: true },
      take: 5000,
    }),
    prisma.friendRequest.findMany({
      where: { toUserId: userId },
      select: { fromUserId: true, status: true, createdAt: true },
      take: 5000,
    }),
    prisma.block.findMany({
      where: { blockerId: userId },
      select: { blockedUserId: true, createdAt: true },
      take: 5000,
    }),
    prisma.block.findMany({
      where: { blockedUserId: userId },
      select: { blockerId: true, createdAt: true },
      take: 5000,
    }),
    prisma.session.findMany({
      where: { userId },
      select: { id: true, deviceName: true, deviceType: true, os: true, ip: true, createdAt: true, lastActiveAt: true },
      take: 200,
    }),
    prisma.ssoAccount.findMany({
      where: { userId },
      select: { provider: true, email: true },
      take: 50,
    }),
    prisma.passkeyCredential.findMany({
      where: { userId },
      select: { id: true, name: true, deviceType: true, createdAt: true },
      take: 100,
    }),
    prisma.pushSubscription.findMany({
      where: { userId },
      select: { endpoint: true, userAgent: true, createdAt: true },
      take: 200,
    }),
    prisma.familyLink.findMany({
      where: { parentId: userId },
      select: { childId: true, status: true, createdAt: true },
      take: 100,
    }),
    prisma.familyLink.findMany({
      where: { childId: userId },
      select: { parentId: true, status: true, createdAt: true },
      take: 100,
    }),
    prisma.serverPowerUp.findMany({
      where: { userId },
      select: { serverId: true, createdAt: true },
      take: 500,
    }),
  ]);

  const [
    giftsSent,
    giftsReceived,
    messageReports,
    reportsAgainstMe,
    imageHashes,
  ] = await Promise.all([
    prisma.giftSubscription.findMany({
      where: { senderId: userId },
      select: { id: true, plan: true, durationMonths: true, status: true, createdAt: true },
      take: 500,
    }),
    prisma.giftSubscription.findMany({
      where: { recipientId: userId },
      select: { id: true, plan: true, durationMonths: true, status: true, redeemedAt: true },
      take: 500,
    }),
    prisma.messageReport.findMany({
      where: { reporterId: userId },
      select: { id: true, messageType: true, reason: true, status: true, createdAt: true },
      take: 1000,
    }),
    prisma.messageReport.findMany({
      where: { authorId: userId },
      select: { id: true, messageType: true, reason: true, status: true, actionTaken: true, createdAt: true },
      take: 1000,
    }),
    prisma.imageHash.findMany({
      where: { uploaderId: userId },
      select: { id: true, createdAt: true },
      take: 10000,
    }).catch(() => []),
  ]);

  // Additional models with user data
  const [
    channelPins,
    dmPins,
    invitesCreated,
    emojisUploaded,
    stickersUploaded,
    soundsUploaded,
    templatesCreated,
    serverBans,
    pendingTrialSetups,
    trialCardFingerprints,
    familyRestrictions,
    gifFavorites,
  ] = await Promise.all([
    prisma.channelPinnedMessage.findMany({
      where: { pinnedById: userId },
      select: { id: true, channelId: true, messageId: true, pinnedAt: true },
      take: 5000,
    }),
    prisma.dMPinnedMessage.findMany({
      where: { pinnedById: userId },
      select: { id: true, dmChannelId: true, messageId: true, pinnedAt: true },
      take: 5000,
    }),
    prisma.invite.findMany({
      where: { createdById: userId },
      select: { id: true, code: true, serverId: true, expiresAt: true, maxUses: true, useCount: true, createdAt: true },
      take: 5000,
    }),
    prisma.customEmoji.findMany({
      where: { uploadedById: userId },
      select: { id: true, serverId: true, name: true, createdAt: true },
      take: 5000,
    }),
    prisma.sticker.findMany({
      where: { uploadedById: userId },
      select: { id: true, serverId: true, name: true, createdAt: true },
      take: 5000,
    }),
    prisma.soundboardSound.findMany({
      where: { uploadedById: userId },
      select: { id: true, serverId: true, name: true, createdAt: true },
      take: 2000,
    }),
    prisma.serverTemplate.findMany({
      where: { createdById: userId },
      select: { id: true, serverId: true, name: true, code: true, createdAt: true },
      take: 500,
    }),
    prisma.serverBan.findMany({
      where: { userId },
      select: { id: true, serverId: true, reason: true, createdAt: true },
      take: 1000,
    }),
    prisma.pendingTrialSetup.findMany({
      where: { userId },
      select: { id: true, plan: true, status: true, createdAt: true },
      take: 100,
    }),
    prisma.trialCardFingerprint.findMany({
      where: { userId },
      select: { id: true, plan: true, createdAt: true },
      take: 100,
    }),
    prisma.familyLink.findMany({
      where: { childId: userId },
      select: { id: true, restriction: { select: { id: true, blockDmFromNonFriends: true, blockServerJoin: true, dailyTimeLimitMinutes: true } } },
      take: 100,
    }).then(links => links.map(l => l.restriction).filter(Boolean)).catch(() => []),
    prisma.gifFavorite.findMany({
      where: { userId },
      select: { gifUrl: true, previewUrl: true, title: true, createdAt: true },
      take: 5000,
    }),
  ]);

  // Forum posts and messages
  const [
    forumPosts,
    forumMessages,
  ] = await Promise.all([
    prisma.forumPost.findMany({
      where: { authorId: userId },
      select: { id: true, title: true, content: true, channelId: true, createdAt: true },
      take: 50000,
    }),
    prisma.forumMessage.findMany({
      where: { authorId: userId },
      select: { id: true, content: true, forumPostId: true, createdAt: true },
      take: 50000,
    }),
  ]);

  // New feature data: polls, threads
  const [
    pollsCreated,
    pollVotes,
    threadsCreated,
    threadMessages,
  ] = await Promise.all([
    prisma.poll.findMany({
      where: { authorId: userId },
      select: { id: true, question: true, channelId: true, dmChannelId: true, createdAt: true, closedAt: true },
      take: 5000,
    }),
    prisma.pollVote.findMany({
      where: { userId },
      select: { id: true, pollId: true, optionId: true, createdAt: true },
      take: 10000,
    }),
    prisma.thread.findMany({
      where: { authorId: userId },
      select: { id: true, name: true, channelId: true, serverId: true, createdAt: true, archived: true },
      take: 5000,
    }),
    fetchMessagesBatched(
      (cursor, size) => prisma.threadMessage.findMany({
        where: { authorId: userId, ...(cursor ? { createdAt: { lt: cursor } } : {}) },
        select: { id: true, threadId: true, content: true, type: true, replyToMessageId: true, attachmentUrl: true, attachmentName: true, attachmentContentType: true, createdAt: true, editedAt: true },
        orderBy: { createdAt: 'desc' },
        take: size,
      }),
      MESSAGE_EXPORT_LIMIT,
    ),
  ]);

  // Fetch messages with expanded fields
  const [serverMessages, dmMessages] = await Promise.all([
    fetchMessagesBatched(
      (cursor, size) => prisma.message.findMany({
        where: { authorId: userId, ...(cursor ? { createdAt: { lt: cursor } } : {}) },
        select: { id: true, channelId: true, content: true, type: true, replyToMessageId: true, attachmentUrl: true, attachmentName: true, attachmentContentType: true, forwarded: true, createdAt: true, editedAt: true },
        orderBy: { createdAt: 'desc' },
        take: size,
      }),
      MESSAGE_EXPORT_LIMIT,
    ),
    fetchMessagesBatched(
      (cursor, size) => prisma.dMMessage.findMany({
        where: { authorId: userId, ...(cursor ? { createdAt: { lt: cursor } } : {}) },
        select: { id: true, dmChannelId: true, content: true, contentIv: true, type: true, replyToMessageId: true, attachmentUrl: true, attachmentName: true, attachmentContentType: true, forwarded: true, createdAt: true, editedAt: true },
        orderBy: { createdAt: 'desc' },
        take: size,
      }),
      MESSAGE_EXPORT_LIMIT,
    ),
  ]);

  let plainEmail: string;
  try { plainEmail = decryptSecret(user.email); } catch { plainEmail = user.email; }

  return {
    exportedAt: new Date().toISOString(),
    profile: {
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      email: plainEmail,
      avatar: user.avatar,
      banner: user.banner,
      status: user.status,
      createdAt: user.createdAt,
      emailVerified: user.emailVerified,
      mfaEnabled: user.mfaEnabled,
      role: user.role,
      nameColor: user.nameColor,
      nameFont: user.nameFont,
      nameEffect: user.nameEffect,
      avatarEffect: user.avatarEffect,
      stripePlan: user.stripePlan,
      dateOfBirth: user.dateOfBirth,
      stripeCustomerId: user.stripeCustomerId,
      stripeSubscriptionId: user.stripeSubscriptionId,
      stripeStatus: user.stripeStatus,
      stripePeriodEnd: user.stripePeriodEnd,
      hasUsedTrial: user.hasUsedTrial,
      trialStartedAt: user.trialStartedAt,
      backgroundImage: user.backgroundImage,
      backgroundOpacity: user.backgroundOpacity,
      backgroundBlur: user.backgroundBlur,
      bgGifAlwaysPlay: user.bgGifAlwaysPlay,
      badges: user.badges,
      gameAccounts: user.gameAccounts,
      showcaseLayout: user.showcaseLayout,
      suspended: user.suspended,
      suspendedAt: user.suspendedAt,
      suspendReason: user.suspendReason,
      tosAcceptedAt: user.tosAcceptedAt,
      privacyPolicyAcceptedAt: user.privacyPolicyAcceptedAt,
      legalConsentVersion: user.legalConsentVersion,
      preferences: {
        notifyDesktop: user.notifyDesktop,
        notifyUnreadBadge: user.notifyUnreadBadge,
        notifyTaskbarFlash: user.notifyTaskbarFlash,
        notifySoundNewMessage: user.notifySoundNewMessage,
        notifySoundCurrentChannel: user.notifySoundCurrentChannel,
        notifySoundIncomingRing: user.notifySoundIncomingRing,
        notifyDisableAllSounds: user.notifyDisableAllSounds,
        allowDmFromServerMembers: user.allowDmFromServerMembers,
        messageRequestsFilter: user.messageRequestsFilter,
        friendRequestsEveryone: user.friendRequestsEveryone,
        friendRequestsFriendsOfFriends: user.friendRequestsFriendsOfFriends,
        friendRequestsServerMembers: user.friendRequestsServerMembers,
      },
    },
    servers: serverMemberships.map(m => ({
      serverId: m.serverId,
      serverName: m.server.name,
      role: m.role,
      nickname: m.nickname,
      serverAvatar: m.serverAvatar,
      serverBanner: m.serverBanner,
      allowDirectMessages: m.allowDirectMessages,
      isTemporary: m.isTemporary,
      serverMuted: m.serverMuted,
      serverDeafened: m.serverDeafened,
      joinedAt: m.joinedAt,
    })),
    dmChannels: dmParticipations,
    friends: {
      sent: friendsSent,
      received: friendsReceived,
    },
    blocks: {
      initiated: blocks,
      received: blockedBy,
    },
    sessions,
    ssoAccounts,
    passkeys,
    pushSubscriptions,
    familyLinks: {
      asParent: familyLinksParent,
      asChild: familyLinksChild,
    },
    familyRestrictions,
    serverPowerUps,
    giftSubscriptions: {
      sent: giftsSent,
      received: giftsReceived,
    },
    messageReports,
    reportsAgainstMe,
    imageHashes,
    channelPins,
    dmPins,
    invitesCreated,
    emojisUploaded,
    stickersUploaded,
    soundsUploaded,
    templatesCreated,
    serverBans,
    pendingTrialSetups,
    trialCardFingerprints,
    gifFavorites,
    serverMessages: {
      count: serverMessages.length,
      truncated: serverMessages.length >= MESSAGE_EXPORT_LIMIT,
      messages: serverMessages,
    },
    dmMessages: {
      count: dmMessages.length,
      truncated: dmMessages.length >= MESSAGE_EXPORT_LIMIT,
      messages: dmMessages.map(m => {
        const content = decryptMessageContent(m);
        // E2E messages pass through server decryption unchanged — detect and redact
        try {
          const parsed = JSON.parse(content);
          if (parsed?.v === 2 && typeof parsed?.iv === 'string' && typeof parsed?.ct === 'string') {
            return { ...m, content: '[E2E encrypted message — decrypt locally]' };
          }
        } catch { /* not JSON, keep as-is */ }
        return { ...m, content };
      }),
    },
    pollsCreated,
    pollVotes,
    threadsCreated,
    threadMessages: {
      count: threadMessages.length,
      truncated: threadMessages.length >= MESSAGE_EXPORT_LIMIT,
      messages: threadMessages,
    },
    forumPosts,
    forumMessages,
  };
}
