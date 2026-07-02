// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { create } from 'zustand';
import type { Channel } from '../types';
import type { UserWithRole, ForwardPayload, ProfileFriendStatus, ServerContextAction } from './types';

interface UiState {
  userProfileTarget: { user: UserWithRole; anchorRect: { left: number; top: number } } | null;
  profileFriendStatus: ProfileFriendStatus | null;
  userContextMenuTarget: { user: UserWithRole; x: number; y: number; dmChannelId?: string } | null;
  fullProfileTarget: { user: UserWithRole; serverId?: string; serverJoinedAt?: string; initialTab?: 'showcase' | 'activity' | 'friends' | 'servers' } | null;
  modViewTarget: { serverId: string; userId: string } | null;
  dmRemoveFriendConfirm: { userId: string; username: string } | null;
  destructiveConfirm: { title: string; desc: string; confirmLabel: string; danger: boolean; onConfirm: () => void } | null;
  forwardPayload: ForwardPayload | null;
  reportModal: { messageId: string; messageType: 'dm' | 'channel'; channelId?: string; dmChannelId?: string; authorId: string; content: string; attachmentUrl?: string } | null;
  recoveryKeyModal: string | null;
  recoveryKeyShowHint: boolean;
  e2ePassphraseModal: 'setup' | 'unlock' | null;
  showRecoveryReminder: boolean;
  deleteChannelConfirm: { channel: Channel; serverId: string } | null;
  openChannelSettingsId: string | null;
  /** Set by Classic-mode category right-click to ask ChannelList to open the
   *  CategorySettingsModal for the given category id. ChannelList consumes
   *  the value and clears it. */
  openCategorySettingsId: string | null;
  /** Set by Classic-mode chevron in the extended subheader pill to open the
   *  server menu (invite, settings, leave, etc.) anchored at the supplied
   *  rect rather than the deck bar trigger (which is hidden in Classic).
   *  ChannelList opens the menu, then clears this value when it closes. */
  serverMenuOpenAnchor: { left: number; bottom: number } | null;
  serverContextAction: { serverId: string; action: ServerContextAction } | null;
  /** Set by the user-context-menu "Change Nickname" item. AppLayout renders
   *  the NicknameModal when this is non-null and clears it on close. The
   *  `target` carries the full member record so the modal's live preview
   *  can render avatar + Pro cosmetics + role color exactly as they
   *  appear in the member list. */
  nicknameModal: {
    serverId: string;
    serverName?: string;
    target: {
      id: string;
      username: string;
      avatar?: string | null;
      discriminator?: string;
      roleColor?: string;
      roleStyle?: 'solid' | 'gradient' | 'holographic';
      nameColor?: string;
      nameFont?: string;
      nameEffect?: string;
      avatarEffect?: string;
      effectivePlan?: string;
      stripePlan?: string;
    };
    currentNickname: string | null;
    isSelf: boolean;
  } | null;
  /** Set by Classic-mode "+" button next to a category to request opening the
   *  CreateChannelModal pre-filled with the given category. ChannelList
   *  consumes the value and clears it. Carries the same shape as the other
   *  modal-trigger slots above. */
  createChannelRequest: {
    serverId: string;
    categoryId: string | null;
    categoryName: string | null;
    initialType?: 'text' | 'voice' | 'stage' | 'forum';
  } | null;
  pollModalOpen: boolean;
  threadCreationModal: { parentMessageId: string; parentContent: string } | null;
  threadBrowserOpen: boolean;
  /** When true, the full-screen Howl Navigator overlay is open. Only meaningful
   *  in the `default` server layout on desktop (the rail-less mode); the top-left
   *  logo trigger sets it true and the overlay's close/Escape sets it false.
   *  Ephemeral (uiStore has no persist) — correct for an overlay. */
  launcherOpen: boolean;
  e2eLocked: boolean;
  /** Monotonic tick bumped on every MLS lock-state event ('mls-locked'/'mls-ready').
   *  Consumers that read mlsCoordinator.isActive()/isReadyForChannel() synchronously
   *  subscribe to this so their MLS-locked UI re-renders when the shared worker is
   *  torn down by a sibling tab (or crashes) and again when it recovers. */
  mlsReadyTick: number;
  /** Per-channel "MLS commit failed to apply; this conversation needs resync" hint.
   *  Bounded by the user's open DM channels and self-heals: cleared on the next epoch
   *  advance for the channel (App.tsx onEpochChange). In-memory, per-tab (each tab gets
   *  the worker broadcast independently). */
  resyncNeededChannels: Record<string, true>;
  markChannelNeedsResync(dmChannelId: string): void;
  clearChannelResync(dmChannelId: string): void;
  /** Per-channel typed MLS establish-failure reason: 'peer-unprovisioned' (the peer
   *  has published no MLS KeyPackages, so the group can't be formed) or
   *  'key-change-blocked' (the peer's AIK changed without an attested rotation and the
   *  user hasn't acknowledged it yet). `userId` names the offending member so the UI
   *  can say who to wait on / whose key to review. Self-heals: cleared when the channel
   *  becomes ready (App.tsx onReadyChannel) or on a successful re-establish. In-memory,
   *  per-tab. */
  establishFailureReasons: Record<string, { reason: 'peer-unprovisioned' | 'key-change-blocked'; userId?: string }>;
  setEstablishFailureReason(dmChannelId: string, reason: 'peer-unprovisioned' | 'key-change-blocked', userId?: string): void;
  clearEstablishFailure(dmChannelId: string): void;
  /** Per-USER pending key-change alerts (AIK pin rejections awaiting the user's
   *  accept/reject decision), keyed by the peer's userId (`self: true` = this account's
   *  own userId under a stale self-pin). Fed by mlsCoordinator.onKeyChange and hydrated
   *  from the persisted trust store on mls-ready; cleared on accept. Bounded by the
   *  user's DM peers. */
  keyChangeAlerts: Record<string, { candidateAik: string; pinnedAik: string; self: boolean }>;
  setKeyChangeAlert(userId: string, alert: { candidateAik: string; pinnedAik: string; self: boolean }): void;
  clearKeyChangeAlert(userId: string): void;
  showE2eInfoBanner: boolean;
  encryptionChoicePassword: string | null;
  /** Action to run after the user completes the E2E passphrase modal (unlock or setup). */
  pendingE2eAction: (() => void) | null;
  /** When true, the active DM/group call is in panel-fullscreen mode (chevron expanded).
   *  DMView reads this to hide the chat section and let the call fill the DM panel. */
  dmCallPanelFullscreen: boolean;

  setUserProfileTarget(v: UiState['userProfileTarget']): void;
  setProfileFriendStatus(v: UiState['profileFriendStatus']): void;
  setUserContextMenuTarget(v: UiState['userContextMenuTarget']): void;
  setFullProfileTarget(v: UiState['fullProfileTarget']): void;
  setModViewTarget(v: UiState['modViewTarget']): void;
  setDmRemoveFriendConfirm(v: UiState['dmRemoveFriendConfirm']): void;
  setDestructiveConfirm(v: UiState['destructiveConfirm']): void;
  setForwardPayload(v: UiState['forwardPayload']): void;
  setReportModal(v: UiState['reportModal']): void;
  setRecoveryKeyModal(v: UiState['recoveryKeyModal']): void;
  setRecoveryKeyShowHint(v: boolean): void;
  setE2ePassphraseModal(v: UiState['e2ePassphraseModal']): void;
  setShowRecoveryReminder(v: boolean): void;
  setDeleteChannelConfirm(v: UiState['deleteChannelConfirm']): void;
  setOpenChannelSettingsId(v: string | null): void;
  setOpenCategorySettingsId(v: string | null): void;
  setServerMenuOpenAnchor(v: UiState['serverMenuOpenAnchor']): void;
  setServerContextAction(v: UiState['serverContextAction']): void;
  setNicknameModal(v: UiState['nicknameModal']): void;
  setCreateChannelRequest(v: UiState['createChannelRequest']): void;
  setPollModalOpen(v: boolean): void;
  setThreadCreationModal(v: UiState['threadCreationModal']): void;
  setThreadBrowserOpen(v: boolean): void;
  setLauncherOpen(v: boolean): void;
  setE2eLocked(v: boolean): void;
  bumpMlsReadyTick(): void;
  setShowE2eInfoBanner(v: boolean): void;
  setEncryptionChoicePassword(v: string | null): void;
  setPendingE2eAction(v: (() => void) | null): void;
  setDmCallPanelFullscreen(v: boolean): void;
  clearAllModals(): void;
}

export const useUiStore = create<UiState>()((set) => ({
  userProfileTarget: null,
  profileFriendStatus: null,
  userContextMenuTarget: null,
  fullProfileTarget: null,
  modViewTarget: null,
  dmRemoveFriendConfirm: null,
  destructiveConfirm: null,
  forwardPayload: null,
  reportModal: null,
  recoveryKeyModal: null,
  recoveryKeyShowHint: false,
  e2ePassphraseModal: null,
  showRecoveryReminder: false,
  deleteChannelConfirm: null,
  openChannelSettingsId: null,
  openCategorySettingsId: null,
  serverMenuOpenAnchor: null,
  serverContextAction: null,
  nicknameModal: null,
  createChannelRequest: null,
  pollModalOpen: false,
  threadCreationModal: null,
  threadBrowserOpen: false,
  launcherOpen: false,
  e2eLocked: false,
  mlsReadyTick: 0,
  resyncNeededChannels: {},
  establishFailureReasons: {},
  keyChangeAlerts: {},
  showE2eInfoBanner: false,
  encryptionChoicePassword: null,
  pendingE2eAction: null,
  dmCallPanelFullscreen: false,

  // The left-click profile card and the right-click context menu are mutually
  // exclusive surfaces: opening one closes the other so they can never overlap
  // (e.g. right-clicking a user in chat must not leave an open profile card behind).
  setUserProfileTarget(v) { set(v ? { userProfileTarget: v, userContextMenuTarget: null } : { userProfileTarget: v }); },
  setProfileFriendStatus(v) { set({ profileFriendStatus: v }); },
  setUserContextMenuTarget(v) { set(v ? { userContextMenuTarget: v, userProfileTarget: null, profileFriendStatus: null } : { userContextMenuTarget: v }); },
  setFullProfileTarget(v) { set({ fullProfileTarget: v }); },
  setModViewTarget(v) { set({ modViewTarget: v }); },
  setDmRemoveFriendConfirm(v) { set({ dmRemoveFriendConfirm: v }); },
  setDestructiveConfirm(v) { set({ destructiveConfirm: v }); },
  setForwardPayload(v) { set({ forwardPayload: v }); },
  setReportModal(v) { set({ reportModal: v }); },
  setRecoveryKeyModal(v) { set({ recoveryKeyModal: v }); },
  setRecoveryKeyShowHint(v) { set({ recoveryKeyShowHint: v }); },
  setE2ePassphraseModal(v) { set({ e2ePassphraseModal: v }); },
  setShowRecoveryReminder(v) { set({ showRecoveryReminder: v }); },
  setDeleteChannelConfirm(v) { set({ deleteChannelConfirm: v }); },
  setOpenChannelSettingsId(v) { set({ openChannelSettingsId: v }); },
  setOpenCategorySettingsId(v) { set({ openCategorySettingsId: v }); },
  setServerMenuOpenAnchor(v) { set({ serverMenuOpenAnchor: v }); },
  setServerContextAction(v) { set({ serverContextAction: v }); },
  setNicknameModal(v) { set({ nicknameModal: v }); },
  setCreateChannelRequest(v) { set({ createChannelRequest: v }); },
  setPollModalOpen(v) { set({ pollModalOpen: v }); },
  setThreadCreationModal(v) { set({ threadCreationModal: v }); },
  setThreadBrowserOpen(v) { set({ threadBrowserOpen: v }); },
  setLauncherOpen(v) { set({ launcherOpen: v }); },
  setE2eLocked(v) { set({ e2eLocked: v }); },
  bumpMlsReadyTick() { set((s) => ({ mlsReadyTick: s.mlsReadyTick + 1 })); },
  markChannelNeedsResync(dmChannelId) {
    set((s) => (s.resyncNeededChannels[dmChannelId] ? s : { resyncNeededChannels: { ...s.resyncNeededChannels, [dmChannelId]: true } }));
  },
  clearChannelResync(dmChannelId) {
    set((s) => {
      if (!s.resyncNeededChannels[dmChannelId]) return s;
      const next = { ...s.resyncNeededChannels };
      delete next[dmChannelId];
      return { resyncNeededChannels: next };
    });
  },
  setEstablishFailureReason(dmChannelId, reason, userId) {
    set((s) => {
      const prev = s.establishFailureReasons[dmChannelId];
      if (prev && prev.reason === reason && prev.userId === userId) return s;
      return { establishFailureReasons: { ...s.establishFailureReasons, [dmChannelId]: { reason, userId } } };
    });
  },
  clearEstablishFailure(dmChannelId) {
    set((s) => {
      if (!s.establishFailureReasons[dmChannelId]) return s;
      const next = { ...s.establishFailureReasons };
      delete next[dmChannelId];
      return { establishFailureReasons: next };
    });
  },
  setKeyChangeAlert(userId, alert) {
    set((s) => {
      const prev = s.keyChangeAlerts[userId];
      if (prev && prev.candidateAik === alert.candidateAik && prev.pinnedAik === alert.pinnedAik && prev.self === alert.self) return s;
      return { keyChangeAlerts: { ...s.keyChangeAlerts, [userId]: alert } };
    });
  },
  clearKeyChangeAlert(userId) {
    set((s) => {
      if (!s.keyChangeAlerts[userId]) return s;
      const next = { ...s.keyChangeAlerts };
      delete next[userId];
      return { keyChangeAlerts: next };
    });
  },
  setShowE2eInfoBanner(v) { set({ showE2eInfoBanner: v }); },
  setEncryptionChoicePassword(v) { set({ encryptionChoicePassword: v }); },
  setPendingE2eAction(v) { set({ pendingE2eAction: v }); },
  setDmCallPanelFullscreen(v) { set({ dmCallPanelFullscreen: v }); },

  clearAllModals() {
    set({
      userProfileTarget: null,
      profileFriendStatus: null,
      userContextMenuTarget: null,
      fullProfileTarget: null,
      modViewTarget: null,
      dmRemoveFriendConfirm: null,
      destructiveConfirm: null,
      forwardPayload: null,
      reportModal: null,
      recoveryKeyModal: null,
      recoveryKeyShowHint: false,
      e2ePassphraseModal: null,
      showRecoveryReminder: false,
      deleteChannelConfirm: null,
      openChannelSettingsId: null,
      openCategorySettingsId: null,
      serverMenuOpenAnchor: null,
      serverContextAction: null,
      nicknameModal: null,
      createChannelRequest: null,
      pollModalOpen: false,
      threadCreationModal: null,
      threadBrowserOpen: false,
      launcherOpen: false,
      e2eLocked: false,
      showE2eInfoBanner: false,
      encryptionChoicePassword: null,
      pendingE2eAction: null,
    });
  },
}));
