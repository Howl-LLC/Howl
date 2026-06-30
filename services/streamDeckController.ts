// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Renderer-side Stream Deck controller.
// Covers: pair-request IPC and action / list / subscribe dispatch; state-push
// plumbing and voice action wiring (state.voice subscription); voice.hangup/ptt
// and call.answer/decline/end handler registration plus the state.call provider
// pattern; navigation + presence actions with state.presence/unread/dm-presence/
// focused-channel pipelines and list.* commands for the Property Inspector;
// reaction/thread/stage actions with state.thread-stage + state.e2ee pipelines
// and the E2EE vault-state provider pattern (no crypto imports — boundary safe).

import type { Topic } from '../shared/streamdeck/types';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useDmStore } from '../stores/dmStore';
import { useServerStore } from '../stores/serverStore';
import { useMessageStore } from '../stores/messageStore';
import { useSocialStore } from '../stores/socialStore';
import { useUiStore } from '../stores/uiStore';
import { useThreadPollStore } from '../stores/threadPollStore';
import { isChannelEncrypted } from './encryptionFlags';
import { apiClient } from './api';
import { switchVoiceChannel } from '../utils/voiceActions';
import { setSelfStatus } from '../utils/selfStatus';

type ElectronSD = {
  onPairRequest: (cb: (info: PairRequestInfo) => void) => () => void;
  sendPairDecision: (requestId: string, decision: 'allow' | 'deny') => void;
  onAction: (cb: (payload: ActionPayload) => void) => () => void;
  replyAction: (replyChannel: string, data: unknown) => void;
  onList: (cb: (payload: ListPayload) => void) => () => void;
  replyList: (replyChannel: string, data: unknown) => void;
  onSubscribe: (cb: (payload: SubscribePayload) => void) => () => void;
  replySubscribe: (replyChannel: string, data: unknown) => void;
  pushState: (topic: string, data: unknown) => void;
};

export interface PairRequestInfo {
  requestId: string;
  pluginId: string;
  displayName: string;
  version: string;
  fingerprint: { words: string[]; display: string };
  isOfficialId: boolean;
}

export interface ActionPayload { replyChannel: string; pluginId: string; action: string; params: Record<string, unknown>; }
export interface ListPayload { replyChannel: string; pluginId: string; resource: string; params: Record<string, unknown>; }
export interface SubscribePayload { replyChannel: string; pluginId: string; topics: Topic[]; }

type PairDecisionCallback = (info: PairRequestInfo) => void;

let _onPairRequestExternal: PairDecisionCallback | null = null;

export function setPairRequestListener(cb: PairDecisionCallback | null) {
  _onPairRequestExternal = cb;
}

// Handler registration hooks
// App.tsx registers callbacks on mount; the controller invokes them when the
// matching Stream Deck action fires. Same pattern as setPairRequestListener.

type VoidHandler = () => Promise<void> | void;
type PTTHandler = (phase: 'down' | 'up') => void;

let _hangupHandler: VoidHandler | null = null;
let _pttHandler: PTTHandler | null = null;
let _callAnswerHandler: VoidHandler | null = null;
let _callDeclineHandler: VoidHandler | null = null;
let _callEndHandler: VoidHandler | null = null;

export function setHangupHandler(cb: VoidHandler | null) { _hangupHandler = cb; }
export function setPTTHandler(cb: PTTHandler | null) { _pttHandler = cb; }
export function setCallAnswerHandler(cb: VoidHandler | null) { _callAnswerHandler = cb; }
export function setCallDeclineHandler(cb: VoidHandler | null) { _callDeclineHandler = cb; }
export function setCallEndHandler(cb: VoidHandler | null) { _callEndHandler = cb; }

// Navigation + device-switcher handler registration
// Navigation requires React Router (or similar) which lives in component scope.
// App.tsx registers a navigate callback; the controller invokes it.

type NavigateHandler = (path: string) => void;
type DeviceSwitcherHandler = (kind: 'input' | 'output' | 'both') => void;

let _navigateHandler: NavigateHandler | null = null;
let _deviceSwitcherHandler: DeviceSwitcherHandler | null = null;

export function setNavigateHandler(cb: NavigateHandler | null) { _navigateHandler = cb; }
export function setDeviceSwitcherHandler(cb: DeviceSwitcherHandler | null) { _deviceSwitcherHandler = cb; }

// Reaction, thread, stage handler registration
// Thread and stage actions require React-level context (routing, modal APIs)
// that the controller cannot access directly. App.tsx registers handlers.

type ThreadStartHandler = () => Promise<{ threadId: string } | { code: string }>;
type ThreadLockHandler = () => Promise<void | { code: string }>;
type StageStartEndHandler = () => Promise<void | { code: string }>;
type StageRemoveSpeakerHandler = (userId: string) => Promise<void | { code: string }>;

let _threadStartHandler: ThreadStartHandler | null = null;
let _threadLockHandler: ThreadLockHandler | null = null;
let _stageStartEndHandler: StageStartEndHandler | null = null;
let _stageRemoveSpeakerHandler: StageRemoveSpeakerHandler | null = null;

export function setThreadStartHandler(cb: ThreadStartHandler | null) { _threadStartHandler = cb; }
export function setThreadLockHandler(cb: ThreadLockHandler | null) { _threadLockHandler = cb; }
export function setStageStartEndHandler(cb: StageStartEndHandler | null) { _stageStartEndHandler = cb; }
export function setStageRemoveSpeakerHandler(cb: StageRemoveSpeakerHandler | null) { _stageRemoveSpeakerHandler = cb; }

// E2EE vault-state provider pattern
// The controller MUST NOT import dmKeyManager (boundary violation).
// Instead, App.tsx registers a provider that returns the E2EE vault state.
// The provider also exposes isChannelUnlocked() for the reaction action.

export interface E2eeStateData {
  unlocked: boolean;
  lockedChannels: string[];
}

type E2eeStateProvider = () => E2eeStateData;
type ChannelUnlockedCheck = (channelId: string) => boolean;

let _e2eeStateProvider: E2eeStateProvider | null = null;
let _isChannelUnlockedCheck: ChannelUnlockedCheck | null = null;

export function setE2eeStateProvider(
  get: E2eeStateProvider | null,
  isChannelUnlocked?: ChannelUnlockedCheck | null,
) {
  _e2eeStateProvider = get;
  _isChannelUnlockedCheck = isChannelUnlocked ?? null;
}

// state.call provider pattern
// DM call state lives in React local state (useDmCallState hook) rather than
// a Zustand store, so we can't subscribe to it from here. Instead, App.tsx
// registers a provider function that returns the current call state snapshot.
// App.tsx is also responsible for calling pushState('state.call', data)
// whenever the call state changes (in a useEffect).

export interface CallStateData {
  incoming: boolean;
  active: boolean;
  caller: { userId: string; name: string; avatar?: string } | null;
  startedAt: number | null;
}

type CallStateProvider = () => CallStateData;
let _callStateProvider: CallStateProvider | null = null;

export function setCallStateProvider(get: CallStateProvider | null) {
  _callStateProvider = get;
}

let _unsub: Array<() => void> = [];

// State-push helpers

function getSD(): ElectronSD | undefined {
  return (window as unknown as { electron?: { streamdeck?: ElectronSD } }).electron?.streamdeck;
}

/** Push a state event to all connected Stream Deck plugins. */
export function pushState(topic: Topic, data: unknown): void {
  getSD()?.pushState(topic, data);
}

const _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Debounced variant for high-frequency topics. */
export function pushStateDebounced(topic: Topic, data: unknown, ms = 250): void {
  const existing = _debounceTimers.get(topic);
  if (existing) clearTimeout(existing);
  _debounceTimers.set(topic, setTimeout(() => {
    _debounceTimers.delete(topic);
    pushState(topic, data);
  }, ms));
}

// Voice state snapshot builder

function buildVoiceSnapshot() {
  const v = useVoiceStore.getState();
  return {
    muted: v.isMuted,
    deafened: v.isDeafened,
    cameraOn: v.isCameraOn,
    connectedChannelId: v.connectedVoiceChannelId,
    connectedStageChannelId: v.connectedStageChannelId,
  };
}

// Default call state (no active call)

function buildDefaultCallState(): CallStateData {
  return { incoming: false, active: false, caller: null, startedAt: null };
}

// Presence rotation order

const PRESENCE_CYCLE: Array<'online' | 'idle' | 'dnd' | 'invisible'> = ['online', 'idle', 'dnd', 'invisible'];

// State snapshot builders

function buildPresenceSnapshot() {
  return { status: useAuthStore.getState().currentUserStatus };
}

function buildUnreadSnapshot() {
  const ns = useNotificationStore.getState();
  // Merge channel mention counts and DM unread counts into a single map.
  // For server channels, use channelMentionCounts (mention-level granularity).
  // Also include channels that are unread (no mention count but in channelUnreadIds).
  const result: Record<string, number> = {};
  // Server channel unreads — channelUnreadIds gives us boolean unread,
  // channelMentionCounts gives mention count. Prefer mention count if > 0.
  for (const chId of ns.channelUnreadIds) {
    result[chId] = ns.channelMentionCounts[chId] ?? 1;
  }
  // DM unreads
  for (const [dmId, count] of Object.entries(ns.dmUnreadCounts)) {
    if (count > 0) result[dmId] = count;
  }
  return result;
}

function buildDmPresenceSnapshot() {
  const dms = useDmStore.getState().dmChannels;
  const result: Record<string, string> = {};
  for (const ch of dms) {
    if (ch.otherUser?.id && ch.otherUser.status) {
      result[ch.otherUser.id] = ch.otherUser.status;
    }
    // Group DM participants
    if (ch.otherUsers) {
      for (const u of ch.otherUsers) {
        if (u.id && u.status) result[u.id] = u.status;
      }
    }
  }
  // Also include friend presence for DM keys that are "pinned" to a userId
  const friends = useSocialStore.getState().homeFriends;
  for (const f of friends) {
    if (f.id && f.status) result[f.id] = f.status;
  }
  return result;
}

function buildFocusedChannelSnapshot() {
  const nav = useNavigationStore.getState();
  const channelId = nav.activeDmChannelId ?? nav.activeChannelId ?? null;
  if (!channelId) {
    return { channelId: null, type: null, latestMessageId: null, hasEncryption: false };
  }

  // Determine type: 'dm' if activeDmChannelId is set, else 'server'
  const isDm = !!nav.activeDmChannelId;
  const type: 'server' | 'dm' = isDm ? 'dm' : 'server';

  // Get latest message ID from the appropriate store.
  // For encrypted DMs, the message IDs are opaque server IDs — safe to expose.
  const ms = useMessageStore.getState();
  let latestMessageId: string | null = null;
  if (isDm) {
    const msgs = ms.dmMessages[channelId];
    if (msgs && msgs.length > 0) latestMessageId = msgs[msgs.length - 1].id;
  } else {
    const msgs = ms.messages[channelId];
    if (msgs && msgs.length > 0) latestMessageId = msgs[msgs.length - 1].id;
  }

  const hasEncryption = isDm && isChannelEncrypted(channelId);

  return { channelId, type, latestMessageId, hasEncryption };
}

// Thread + stage + E2EE snapshot builders

function buildThreadStageSnapshot() {
  const tp = useThreadPollStore.getState();
  const v = useVoiceStore.getState();
  const auth = useAuthStore.getState();
  const currentUserId = auth.currentUser?.id ?? null;

  // Thread state
  const focusedThread = tp.activeThread;
  const focusedThreadId = focusedThread?.id ?? null;
  // Thread interface has no 'locked' field — always false until feature ships
  const threadIsLocked = false;
  // Thread moderator: thread author or server owner can moderate
  const isThreadModerator = !!(focusedThread && currentUserId && (
    focusedThread.authorId === currentUserId
  ));

  // Stage state
  const stageChannelId = v.connectedStageChannelId;
  const stageSession = stageChannelId ? v.activeStageSessions[stageChannelId] ?? null : null;
  const stageIsLive = !!stageSession && !stageSession.endedAt;
  const isStageModerator = !!(stageSession && currentUserId && stageSession.startedById === currentUserId);
  const currentSpeakers: Array<{ userId: string; name: string }> = stageSession?.speakers
    ? stageSession.speakers.map((s) => ({ userId: s.userId, name: s.username }))
    : [];

  return {
    focusedThreadId,
    threadIsLocked,
    isThreadModerator,
    stageChannelId,
    stageIsLive,
    isStageModerator,
    currentSpeakers,
  };
}

function buildE2eeSnapshot(): E2eeStateData {
  if (_e2eeStateProvider) return _e2eeStateProvider();
  // Fallback: derive from uiStore (e2eLocked) + dmStore + encryptionFlags.
  // uiStore.e2eLocked is maintained by App.tsx from dmKeyManager.isUnlocked().
  const vaultLocked = useUiStore.getState().e2eLocked;
  const unlocked = !vaultLocked;
  const lockedChannels: string[] = [];
  if (vaultLocked) {
    // When vault is locked, all encrypted DM channels are locked
    const dms = useDmStore.getState().dmChannels;
    for (const ch of dms) {
      if (isChannelEncrypted(ch.id)) lockedChannels.push(ch.id);
    }
  }
  return { unlocked, lockedChannels };
}

// List command cap

const LIST_CAP = 1000;

// Action dispatch

async function handleAction(payload: ActionPayload): Promise<unknown> {
  const { action } = payload;

  switch (action) {
    case 'voice.mute': {
      const vs = useVoiceStore.getState();
      vs.setIsMuted(!vs.isMuted);
      return { data: { muted: useVoiceStore.getState().isMuted } };
    }
    case 'voice.deafen': {
      const vs = useVoiceStore.getState();
      vs.setIsDeafened(!vs.isDeafened);
      return { data: { deafened: useVoiceStore.getState().isDeafened } };
    }
    case 'voice.camera': {
      const vs = useVoiceStore.getState();
      vs.setIsCameraOn(!vs.isCameraOn);
      return { data: { cameraOn: useVoiceStore.getState().isCameraOn } };
    }
    case 'voice.hangup':
      if (_hangupHandler) {
        _hangupHandler();
        return { data: {} };
      }
      return { code: 'not-implemented' };
    case 'voice.ptt': {
      const phase = payload.params?.phase;
      if (phase !== 'down' && phase !== 'up') {
        return { code: 'invalid-params' };
      }
      if (_pttHandler) {
        _pttHandler(phase);
        return { data: {} };
      }
      return { code: 'not-implemented' };
    }
    case 'call.answer':
      if (_callAnswerHandler) {
        _callAnswerHandler();
        return { data: {} };
      }
      return { code: 'not-implemented' };
    case 'call.decline':
      if (_callDeclineHandler) {
        _callDeclineHandler();
        return { data: {} };
      }
      return { code: 'not-implemented' };
    case 'call.end':
      if (_callEndHandler) {
        _callEndHandler();
        return { data: {} };
      }
      return { code: 'not-implemented' };

    // Navigation actions

    case 'channel.switch': {
      const { serverId, channelId } = payload.params as { serverId?: string; channelId?: string };
      if (!serverId || !channelId) return { code: 'invalid-params' };
      if (!_navigateHandler) return { code: 'not-implemented' };
      _navigateHandler(`/channels/${serverId}/${channelId}`);
      return { data: {} };
    }

    case 'voice.switch-channel': {
      const { channelId } = payload.params as { channelId?: string };
      if (!channelId) return { code: 'invalid-params' };
      switchVoiceChannel(channelId);
      return { data: {} };
    }

    case 'dm.open-pinned': {
      const { userId } = payload.params as { userId?: string };
      if (!userId) return { code: 'invalid-params' };
      if (!_navigateHandler) return { code: 'not-implemented' };
      // Find existing DM channel with this user, or navigate to @me with userId
      const dms = useDmStore.getState().dmChannels;
      const existing = dms.find((ch) => ch.otherUser?.id === userId);
      if (existing) {
        _navigateHandler(`/channels/@me/${existing.id}`);
      } else {
        // No existing DM channel found — can't open without creating one.
        // Creating a DM is an async E2EE operation that requires dmKeyManager.
        // The controller must NOT import crypto modules, so return a specific code
        // and let the plugin prompt the user to open Howl and start the DM from there.
        return { code: 'no-dm-channel' };
      }
      return { data: {} };
    }

    case 'indicator.unread-summary': {
      if (!_navigateHandler) return { code: 'not-implemented' };
      // Navigate to the first unread channel or DM.
      const ns = useNotificationStore.getState();

      // Check DM unreads first (higher priority — personal messages)
      for (const dmChId of ns.unreadDmChannelIds) {
        _navigateHandler(`/channels/@me/${dmChId}`);
        return { data: { navigatedTo: dmChId, type: 'dm' } };
      }

      // Then check server channel unreads
      for (const chId of ns.channelUnreadIds) {
        // Find the server this channel belongs to
        const servers = useServerStore.getState().servers;
        const server = servers.find((s) => s.channels.some((c) => c.id === chId));
        if (server) {
          _navigateHandler(`/channels/${server.id}/${chId}`);
          return { data: { navigatedTo: chId, type: 'server' } };
        }
      }

      // Nothing unread
      return { data: { navigatedTo: null, type: null } };
    }

    // Presence actions

    case 'presence.rotate': {
      const current = useAuthStore.getState().currentUserStatus;
      const idx = PRESENCE_CYCLE.indexOf(current as typeof PRESENCE_CYCLE[number]);
      const next = PRESENCE_CYCLE[(idx + 1) % PRESENCE_CYCLE.length];
      // Manual choice — clear auto-idle, apply across all surfaces, sync now.
      try { localStorage.removeItem('howl_auto_idle'); } catch { /* storage unavailable */ }
      setSelfStatus(next, { immediate: true });
      return { data: { status: next } };
    }

    case 'presence.set': {
      const { status } = payload.params as { status?: string };
      if (!status || !PRESENCE_CYCLE.includes(status as typeof PRESENCE_CYCLE[number])) {
        return { code: 'invalid-params' };
      }
      const validStatus = status as 'online' | 'idle' | 'dnd' | 'invisible';
      try { localStorage.removeItem('howl_auto_idle'); } catch { /* storage unavailable */ }
      setSelfStatus(validStatus, { immediate: true });
      return { data: { status: validStatus } };
    }

    // Device switcher

    case 'voice.device-switcher': {
      const { kind } = payload.params as { kind?: string };
      if (kind !== 'input' && kind !== 'output' && kind !== 'both') {
        return { code: 'invalid-params' };
      }
      if (_deviceSwitcherHandler) {
        _deviceSwitcherHandler(kind);
        return { data: {} };
      }
      return { code: 'not-implemented' };
    }

    // Reaction action

    case 'reaction.react-focused': {
      const { emoji } = payload.params as { emoji?: string };
      if (!emoji) return { code: 'invalid-params' };

      const nav = useNavigationStore.getState();
      const channelId = nav.activeDmChannelId ?? nav.activeChannelId ?? null;
      if (!channelId) return { code: 'no-focused-channel' };

      const isDm = !!nav.activeDmChannelId;

      // Get latest message ID from the appropriate store
      const ms = useMessageStore.getState();
      let messageId: string | null = null;
      if (isDm) {
        const msgs = ms.dmMessages[channelId];
        if (msgs && msgs.length > 0) messageId = msgs[msgs.length - 1].id;
      } else {
        const msgs = ms.messages[channelId];
        if (msgs && msgs.length > 0) messageId = msgs[msgs.length - 1].id;
      }
      if (!messageId) return { code: 'no-focused-message' };

      // E2EE locked check for encrypted DM channels
      if (isDm && isChannelEncrypted(channelId)) {
        // Check via provider first, then fallback to uiStore.e2eLocked
        const channelUnlocked = _isChannelUnlockedCheck
          ? _isChannelUnlockedCheck(channelId)
          : !useUiStore.getState().e2eLocked;
        if (!channelUnlocked) return { code: 'e2ee-locked' };
      }

      // Delegate to existing reaction paths — these handle encryption internally
      const currentUserId = useAuthStore.getState().currentUser?.id ?? '';
      if (!currentUserId) return { code: 'not-authenticated' };

      if (isDm) {
        // Uses the same path as AppLayout's adaptedReactDm → dmActions.reactDmMessage
        // which calls apiClient.reactDMMessage (encryption handled by the DM layer)
        const { reactDmMessage } = await import('../utils/dmActions');
        reactDmMessage(channelId, messageId, emoji, currentUserId);
      } else {
        const { reactChannelMessage } = await import('../utils/messageActions');
        reactChannelMessage(channelId, messageId, emoji, currentUserId);
      }

      return { data: { messageId, emoji } };
    }

    // Thread actions

    case 'thread.start-from-focused': {
      if (!_threadStartHandler) return { code: 'not-implemented' };
      // Handler is async — but action dispatch is sync. We return a promise
      // marker and the caller resolves via the replyChannel.
      try {
        const result = await _threadStartHandler();
        if ('code' in result) return result;
        return { data: { threadId: result.threadId } };
      } catch {
        return { code: 'action-failed' };
      }
    }

    case 'thread.lock-toggle': {
      if (!_threadLockHandler) return { code: 'not-implemented' };
      try {
        const result = await _threadLockHandler();
        if (result && 'code' in result) return result;
        return { data: {} };
      } catch {
        return { code: 'action-failed' };
      }
    }

    // Stage actions

    case 'stage.start-end': {
      if (!_stageStartEndHandler) return { code: 'not-implemented' };
      try {
        const result = await _stageStartEndHandler();
        if (result && 'code' in result) return result;
        return { data: {} };
      } catch {
        return { code: 'action-failed' };
      }
    }

    case 'stage.remove-speaker': {
      const { userId } = payload.params as { userId?: string };
      if (!userId) return { code: 'invalid-params' };
      if (!_stageRemoveSpeakerHandler) return { code: 'not-implemented' };
      try {
        const result = await _stageRemoveSpeakerHandler(userId);
        if (result && 'code' in result) return result;
        return { data: {} };
      } catch {
        return { code: 'action-failed' };
      }
    }

    default:
      return { code: 'not-implemented' };
  }
}

// Subscribe handler

function handleSubscribe(payload: SubscribePayload): Array<{ topic: Topic; data: unknown }> {
  const snapshots: Array<{ topic: Topic; data: unknown }> = [];

  for (const topic of payload.topics) {
    switch (topic) {
      case 'state.voice':
        snapshots.push({ topic: 'state.voice', data: buildVoiceSnapshot() });
        break;
      case 'state.call':
        snapshots.push({ topic: 'state.call', data: _callStateProvider ? _callStateProvider() : buildDefaultCallState() });
        break;
      case 'state.presence':
        snapshots.push({ topic: 'state.presence', data: buildPresenceSnapshot() });
        break;
      case 'state.unread':
        snapshots.push({ topic: 'state.unread', data: buildUnreadSnapshot() });
        break;
      case 'state.dm-presence':
        snapshots.push({ topic: 'state.dm-presence', data: buildDmPresenceSnapshot() });
        break;
      case 'state.focused-channel':
        snapshots.push({ topic: 'state.focused-channel', data: buildFocusedChannelSnapshot() });
        break;
      case 'state.thread-stage':
        snapshots.push({ topic: 'state.thread-stage', data: buildThreadStageSnapshot() });
        break;
      case 'state.e2ee':
        snapshots.push({ topic: 'state.e2ee', data: buildE2eeSnapshot() });
        break;
      default:
        break;
    }
  }

  return snapshots;
}

// List handler

function handleList(payload: ListPayload): unknown {
  switch (payload.resource) {
    case 'servers': {
      const servers = useServerStore.getState().servers;
      return servers.slice(0, LIST_CAP).map((s) => ({
        id: s.id,
        name: s.name,
        iconUrl: s.icon,
      }));
    }

    case 'channels': {
      const { serverId } = payload.params as { serverId?: string };
      if (!serverId) return [];
      const server = useServerStore.getState().servers.find((s) => s.id === serverId);
      if (!server) return [];
      return server.channels.slice(0, LIST_CAP).map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        voice: c.type === 'voice' || c.type === 'stage',
      }));
    }

    case 'dms': {
      const dms = useDmStore.getState().dmChannels;
      return dms.slice(0, LIST_CAP).map((ch) => {
        const participants: Array<{ userId: string; name: string; avatarUrl: string | null }> = [];
        if (ch.otherUser) {
          participants.push({
            userId: ch.otherUser.id,
            name: ch.otherUser.username,
            avatarUrl: ch.otherUser.avatar ?? null,
          });
        }
        if (ch.otherUsers) {
          for (const u of ch.otherUsers) {
            participants.push({
              userId: u.id,
              name: u.username,
              avatarUrl: u.avatar ?? null,
            });
          }
        }
        return { channelId: ch.id, participants };
      });
    }

    case 'pinned-dms': {
      const dms = useDmStore.getState().dmChannels;
      // DmChannelEntry has pinned?: boolean — filter to pinned only
      const pinned = dms.filter((ch) => ch.pinned);
      // If no pinned DMs tracked, fall back to all DMs with a comment
      // (pinned DM tracking is available via ch.pinned field)
      const source = pinned.length > 0 ? pinned : dms;
      return source.slice(0, LIST_CAP).map((ch) => {
        const participants: Array<{ userId: string; name: string; avatarUrl: string | null }> = [];
        if (ch.otherUser) {
          participants.push({
            userId: ch.otherUser.id,
            name: ch.otherUser.username,
            avatarUrl: ch.otherUser.avatar ?? null,
          });
        }
        if (ch.otherUsers) {
          for (const u of ch.otherUsers) {
            participants.push({
              userId: u.id,
              name: u.username,
              avatarUrl: u.avatar ?? null,
            });
          }
        }
        return { channelId: ch.id, participants };
      });
    }

    case 'custom-emoji': {
      // Custom emoji are fetched on-demand via apiClient.getServerEmojis(),
      // not held in a Zustand store. The list command must be async-safe,
      // so we issue the API call and reply asynchronously via a separate
      // replyList. For now, return an empty array — the Property Inspector
      // should call this only after the user selects a server, at which
      // point the emoji will have been fetched into the API client cache.
      // A future pass can make list handlers async.
      const { serverId } = payload.params as { serverId?: string };
      if (!serverId) return [];
      // Try the cached result synchronously
      const cached = apiClient.getCached<Array<{ id: string; name: string; imageUrl: string; serverId?: string }>>(`emojis:${serverId}`);
      if (cached) {
        return cached.slice(0, LIST_CAP).map((e) => ({
          id: e.id,
          name: e.name,
          url: e.imageUrl,
          serverId,
        }));
      }
      // Trigger async fetch so next call gets cached data
      apiClient.getServerEmojis(serverId).catch(() => {});
      return [];
    }

    default:
      return [];
  }
}

// Init / teardown

export function initStreamDeckController() {
  const sd = getSD();
  if (!sd) return;

  // Pair request forwarding
  _unsub.push(sd.onPairRequest((info) => {
    if (_onPairRequestExternal) _onPairRequestExternal(info);
    else sd.sendPairDecision(info.requestId, 'deny');
  }));

  // Action dispatch
  _unsub.push(sd.onAction((payload) => {
    void handleAction(payload).then((result) => {
      sd.replyAction(payload.replyChannel, result);
    });
  }));

  // List dispatch — read-only data for Property Inspector pickers
  _unsub.push(sd.onList((payload) => {
    sd.replyList(payload.replyChannel, handleList(payload));
  }));

  // Subscribe dispatch — return snapshots for requested topics
  _unsub.push(sd.onSubscribe((payload) => {
    const snapshots = handleSubscribe(payload);
    sd.replySubscribe(payload.replyChannel, snapshots);
  }));

  // state.voice subscription
  // Push immediately on any voice-relevant state change (no debounce —
  // latency matters for the mute indicator on the hardware button).
  const unsubVoice = useVoiceStore.subscribe((state, prevState) => {
    if (
      state.isMuted !== prevState.isMuted ||
      state.isDeafened !== prevState.isDeafened ||
      state.isCameraOn !== prevState.isCameraOn ||
      state.connectedVoiceChannelId !== prevState.connectedVoiceChannelId ||
      state.connectedStageChannelId !== prevState.connectedStageChannelId
    ) {
      pushState('state.voice', {
        muted: state.isMuted,
        deafened: state.isDeafened,
        cameraOn: state.isCameraOn,
        connectedChannelId: state.connectedVoiceChannelId,
        connectedStageChannelId: state.connectedStageChannelId,
      });
    }
  });
  _unsub.push(unsubVoice);

  // state.presence subscription
  const unsubPresence = useAuthStore.subscribe((state, prevState) => {
    if (state.currentUserStatus !== prevState.currentUserStatus) {
      pushStateDebounced('state.presence', { status: state.currentUserStatus }, 250);
    }
  });
  _unsub.push(unsubPresence);

  // state.unread subscription
  // Subscribe to notificationStore for unread changes. Multiple fields can
  // change; debounce coalesces rapid-fire unread updates.
  const unsubUnread = useNotificationStore.subscribe((state, prevState) => {
    if (
      state.channelUnreadIds !== prevState.channelUnreadIds ||
      state.channelMentionCounts !== prevState.channelMentionCounts ||
      state.dmUnreadCounts !== prevState.dmUnreadCounts ||
      state.unreadDmChannelIds !== prevState.unreadDmChannelIds
    ) {
      pushStateDebounced('state.unread', buildUnreadSnapshot(), 250);
    }
  });
  _unsub.push(unsubUnread);

  // state.dm-presence subscription
  // DM participant presence lives in dmStore (otherUser.status fields)
  // and friend presence in socialStore. Subscribe to both.
  const unsubDmPresence = useDmStore.subscribe((state, prevState) => {
    if (state.dmChannels !== prevState.dmChannels) {
      pushStateDebounced('state.dm-presence', buildDmPresenceSnapshot(), 250);
    }
  });
  _unsub.push(unsubDmPresence);

  const unsubFriendPresence = useSocialStore.subscribe((state, prevState) => {
    if (state.homeFriends !== prevState.homeFriends) {
      pushStateDebounced('state.dm-presence', buildDmPresenceSnapshot(), 250);
    }
  });
  _unsub.push(unsubFriendPresence);

  // state.focused-channel subscription
  // Navigation changes come from navigationStore. Message changes come
  // from messageStore (for latestMessageId). Debounce both.
  const unsubFocusedNav = useNavigationStore.subscribe((state, prevState) => {
    if (
      state.activeChannelId !== prevState.activeChannelId ||
      state.activeDmChannelId !== prevState.activeDmChannelId
    ) {
      pushStateDebounced('state.focused-channel', buildFocusedChannelSnapshot(), 250);
    }
  });
  _unsub.push(unsubFocusedNav);

  const unsubFocusedMsg = useMessageStore.subscribe((state, prevState) => {
    // Only push if the active channel's messages changed (latest ID might have updated)
    const nav = useNavigationStore.getState();
    const chId = nav.activeDmChannelId ?? nav.activeChannelId;
    if (!chId) return;

    const isDm = !!nav.activeDmChannelId;
    const curMsgs = isDm ? state.dmMessages[chId] : state.messages[chId];
    const prevMsgs = isDm ? prevState.dmMessages[chId] : prevState.messages[chId];
    if (curMsgs !== prevMsgs) {
      pushStateDebounced('state.focused-channel', buildFocusedChannelSnapshot(), 250);
    }
  });
  _unsub.push(unsubFocusedMsg);

  // state.thread-stage subscription
  // Subscribe to threadPollStore (activeThread) and voiceStore (stage state).
  const unsubThreadStage1 = useThreadPollStore.subscribe((state, prevState) => {
    if (state.activeThread !== prevState.activeThread) {
      pushStateDebounced('state.thread-stage', buildThreadStageSnapshot(), 250);
    }
  });
  _unsub.push(unsubThreadStage1);

  const unsubThreadStage2 = useVoiceStore.subscribe((state, prevState) => {
    if (
      state.connectedStageChannelId !== prevState.connectedStageChannelId ||
      state.activeStageSessions !== prevState.activeStageSessions
    ) {
      pushStateDebounced('state.thread-stage', buildThreadStageSnapshot(), 250);
    }
  });
  _unsub.push(unsubThreadStage2);

  // state.e2ee subscription
  // uiStore.e2eLocked is maintained by App.tsx from dmKeyManager state.
  // When it changes, push the E2EE state snapshot.
  const unsubE2ee = useUiStore.subscribe((state, prevState) => {
    if (state.e2eLocked !== prevState.e2eLocked) {
      pushStateDebounced('state.e2ee', buildE2eeSnapshot(), 250);
    }
  });
  _unsub.push(unsubE2ee);

  // Also subscribe to dmStore changes — new encrypted DMs may appear
  const unsubE2eeDm = useDmStore.subscribe((state, prevState) => {
    if (state.dmChannels !== prevState.dmChannels) {
      // Only push if vault is locked (lockedChannels changes)
      if (useUiStore.getState().e2eLocked) {
        pushStateDebounced('state.e2ee', buildE2eeSnapshot(), 250);
      }
    }
  });
  _unsub.push(unsubE2eeDm);
}

export function teardownStreamDeckController() {
  for (const u of _unsub) { try { u(); } catch { /* noop */ } }
  _unsub = [];
  _onPairRequestExternal = null;
  // Clear call/voice handler registrations
  _hangupHandler = null;
  _pttHandler = null;
  _callAnswerHandler = null;
  _callDeclineHandler = null;
  _callEndHandler = null;
  _callStateProvider = null;
  // Clear navigation handler registrations
  _navigateHandler = null;
  _deviceSwitcherHandler = null;
  // Clear thread/stage/E2EE handler registrations
  _threadStartHandler = null;
  _threadLockHandler = null;
  _stageStartEndHandler = null;
  _stageRemoveSpeakerHandler = null;
  _e2eeStateProvider = null;
  _isChannelUnlockedCheck = null;
  // Clear any pending debounce timers
  for (const timer of _debounceTimers.values()) clearTimeout(timer);
  _debounceTimers.clear();
}
