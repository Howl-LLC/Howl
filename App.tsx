// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { TitleBar, TITLE_BAR_HEIGHT } from './components/TitleBar';
import { User, Server, Message, Channel, type Thread } from './types';
import { apiClient } from './services/api';
import { socketService } from './services/socket';
import { setChannelEncryptionStatus, clearEncryptionStatus, isChannelEncrypted, setChannelProtocol } from './services/encryptionFlags';
import * as dmKeyManager from './services/dmKeyManager';
import { decryptDMMessages } from './services/dmEncryption';
import * as mlsCoordinator from './services/mls/mlsCoordinator';
import { startHistorySync, stopHistorySync, drainHistoryNow } from './services/mls/mlsHistoryArchiveSync';
import { runEagerPreviewRestore } from './services/mls/mlsHistoryRestore';
import { logger } from './services/logger';
// dmSearchIndex (~80 kB: MiniSearch + idb) is dynamic-imported at each call
// site below so it stays out of the main chunk. All call sites are already
// in async effects or setTimeout/setInterval handlers.
import { setCustomEmojis } from './utils/customEmojiStore';
import { clearMediaCaches } from './components/ChatArea';
import { isRealServerId } from './utils/navigationHelpers';
import { routeEstablishOutcome } from './utils/mlsRetry';
import { useRenderLoopDetector } from './hooks/useRenderLoopDetector';
import { deferStoreUpdate } from './utils/storeHelpers';
import { applySelfStatus, setSelfStatus, syncStatusToServer, primeSentStatus } from './utils/selfStatus';
import { upsertGroupedNotification } from './utils/notificationGrouping';
import { streamerSoundsDisabled, soundNewMessageEnabled, soundCurrentChannelEnabled, allSoundsDisabled, unreadBadgeEnabled, taskbarFlashEnabled, desktopNotificationsEnabled, incomingRingEnabled } from './utils/notificationSoundRef';
import { useVoiceChannel } from './hooks/useVoiceChannel';
import { useVoiceE2ee } from './hooks/useVoiceE2ee';
import { useStageE2ee } from './hooks/useStageE2ee';
import { useStageRoom } from './hooks/useStageRoom';
import { useDMCall } from './hooks/useDMCall';
import { useBreakpoint } from './hooks/useIsMobile';
import { useStreamAttenuation } from './hooks/useStreamAttenuation';
import { getVideoConstraintsForCamera, getVideoConstraintsForDisplay, getScreenShareBitrate, detectBestScreenShareCodec, type ScreenShareQuality } from './utils/videoConstraints';
import { getPlanPerks, type PlanTier } from './shared/planPerks';
import { SsoCallback } from './components/SsoCallback';
import { DateOfBirthPrompt } from './components/DateOfBirthPrompt';
import { SsoOnboarding } from './components/SsoOnboarding';
import { PasswordSetupPrompt } from './components/PasswordSetupPrompt';
import { SsoEmailVerification } from './components/SsoEmailVerification';
import { EncryptionChoiceModal } from './components/dm/EncryptionChoiceModal';
import { LayoutPickerModal, LAYOUT_PICKER_SEEN_KEY } from './components/onboarding/LayoutPickerModal';
import { LAYOUT_PICKER_SEEN_EVENT, scheduleSyncToServer as schedSettingsSync } from './utils/settingsSync';
import { CloseActionModal } from './components/CloseActionModal';
import { AutostartPromptModal } from './components/AutostartPromptModal';
import { CameraPreviewModal } from './components/CameraPreviewModal';
import { UpdateBlockingModal } from './components/UpdateBlockingModal';
import { UpdateRecommendedBanner } from './components/UpdateRecommendedBanner';
import { type UserWithRole } from './components/UserProfilePopup';
import { CookieConsent } from './components/CookieConsent';
import { useSettings } from './contexts/SettingsContext';
import type { KeybindEntry } from './utils/settingsStorage';
import type { SettingsBlob } from './utils/settingsSync';
import { useGlobalKeybinds, type KeybindActions } from './hooks/useGlobalKeybinds';
import { isLegacyCombo, migrateLegacyCombo } from './utils/keybindFormat';
import { useMessageSendFeedback } from './hooks/useMessageSendFeedback';
import { useGlobalToast } from './hooks/useGlobalToast';
import { useServiceWorkerUpdate } from './hooks/useServiceWorkerUpdate';
import { useMembersColumn } from './hooks/useMembersColumn';
import { useSwipeGesture } from './hooks/useSwipeGesture';
import { useBackgroundSettings } from './hooks/useBackgroundSettings';
import { useAutoIdle } from './hooks/useAutoIdle';
import { onVisibilityChange, initAppVisible, isAppVisible } from './hooks/useAppVisible';
import { useDmCallState } from './hooks/useDmCallState';
import { useDmSocketEvents } from './hooks/useDmSocketEvents';
import { useOtrSocketEvents } from './hooks/useOtrSocketEvents';
import { useMlsRedecrypt } from './hooks/useMlsRedecrypt';
import { useMlsHistoryRestore } from './hooks/useMlsHistoryRestore';
import { useChannelSocketEvents } from './hooks/useChannelSocketEvents';
import { usePresenceUpdates } from './hooks/usePresenceUpdates';
import { useActivityUpdates } from './hooks/useActivityUpdates';
import { useGameDetection } from './hooks/useGameDetection';
import { useSpotifyDetection } from './hooks/useSpotifyDetection';
import { useSocialSocketEvents } from './hooks/useSocialSocketEvents';
import { useServerMemberSocketEvents } from './hooks/useServerMemberSocketEvents';
import { useRouteSync } from './hooks/useRouteSync';
import { useServerStructureSocketEvents } from './hooks/useServerStructureSocketEvents';
import { useRolePickerSocketEvents } from './hooks/useRolePickerSocketEvents';
import { useNotificationSocketEvents } from './hooks/useNotificationSocketEvents';
import { useThreadPollSocketEvents } from './hooks/useThreadPollSocketEvents';
import { useStageSocketEvents } from './hooks/useStageSocketEvents';
import { useViewerSocketEvents } from './hooks/useViewerSocketEvents';
import { useCalendarSocketEvents } from './hooks/useCalendarSocketEvents';
import { useVoiceControlSocketEvents } from './hooks/useVoiceControlSocketEvents';
import { useBillingSocketEvents } from './hooks/useBillingSocketEvents';
import { useDiscoverySocketEvents } from './hooks/useDiscoverySocketEvents';
import { normalizeStageSession } from './utils/voiceActions';
import { joinByInvite } from './utils/serverActions';
import { useNavigate, Navigate, Routes, Route, useLocation } from 'react-router-dom';
import { selfHostRootRedirect } from './shared/instanceConfig';
import { useMessageStore } from './stores/messageStore';
import { useTypingStore } from './stores/typingStore';
import { useNotificationStore } from './stores/notificationStore';
import { useServerStore } from './stores/serverStore';
import { useShallow } from 'zustand/react/shallow';
import { useSocialStore } from './stores/socialStore';
import { useDmStore } from './stores/dmStore';
import type { DmChannelEntry } from './stores/types';
import { useAuthStore } from './stores/authStore';
import { useUiStore } from './stores/uiStore';
import { useThreadPollStore } from './stores/threadPollStore';
import { useVoiceStore } from './stores/voiceStore';
import { useServerFolderStore } from './stores/serverFolderStore';
import { useCalendarStore } from './stores/calendarStore';
import { useAppStore } from './stores/appStore';
import { useUpdateStore } from './stores/updateStore';
import { useNavigationStore } from './stores/navigationStore';
import { AppLayout } from './components/AppLayout';
import { ensureE2eUnlockedForCall } from './utils/callE2eeGate';
import { leaveOtherActiveCalls, setDmCallLeaveFn } from './utils/activeCallRegistry';
import { publishBtQualityStatus } from './services/audio/btQualityBus';
import { StreamDeckPairModal } from './components/modals/StreamDeckPairModal';
import { initStreamDeckController, teardownStreamDeckController, setHangupHandler, setPTTHandler, setCallAnswerHandler, setCallDeclineHandler, setCallEndHandler, setCallStateProvider, setNavigateHandler, setDeviceSwitcherHandler, setThreadStartHandler, setThreadLockHandler, setStageStartEndHandler, setStageRemoveSpeakerHandler, setE2eeStateProvider, pushState, type CallStateData, type E2eeStateData } from './services/streamDeckController';

const Login = React.lazy(() => import('./components/Login').then(m => ({ default: m.Login })));
const LandingPage = React.lazy(() => import('./components/LandingPage').then(m => ({ default: m.LandingPage })));
const AboutPage = React.lazy(() => import('./components/AboutPage').then(m => ({ default: m.AboutPage })));
const CreditsPage = React.lazy(() => import('./components/CreditsPage').then(m => ({ default: m.CreditsPage })));
const SecurityActionPage = React.lazy(() => import('./components/SecurityActionPage').then(m => ({ default: m.SecurityActionPage })));
const PasskeyLoginPage = React.lazy(() => import('./components/auth/PasskeyLoginPage').then(m => ({ default: m.PasskeyLoginPage })));
const PasskeyMfaPage = React.lazy(() => import('./components/auth/PasskeyMfaPage').then(m => ({ default: m.PasskeyMfaPage })));
const PasskeyRegisterPage = React.lazy(() => import('./components/auth/PasskeyRegisterPage').then(m => ({ default: m.PasskeyRegisterPage })));
const LegalPage = React.lazy(() => import('./components/LegalPage').then(m => ({ default: m.LegalPage })));
const InviteResolvePage = React.lazy(() => import('./components/InviteResolvePage').then(m => ({ default: m.InviteResolvePage })));
const DiscoverPage = React.lazy(() => import('./components/discovery/DiscoverPage').then(m => ({ default: m.DiscoverPage })));
const PublicServerProfile = React.lazy(() => import('./components/discovery/PublicServerProfile').then(m => ({ default: m.PublicServerProfile })));

export type AppTheme = 'neural' | 'light' | 'matter' | 'void' | 'custom';

/**
 * Catch-all wrapper for unauthenticated routes. Stores the intended URL in
 * sessionStorage when the path looks like an authenticated route, so the user
 * can be redirected there after login.
 */
function UnauthCatchAll({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  React.useEffect(() => {
    const p = location.pathname;
    if (/^\/(home|channels\/|friends|settings|template\/|invite\/)/.test(p)) {
      try { sessionStorage.setItem('howl_returnTo', p); } catch { /* ignore */ }
    }
  }, [location.pathname]);
  return <>{children}</>;
}

/** Max messages kept in memory per channel. Oldest are evicted when exceeded. */
const MAX_MESSAGES_PER_CHANNEL = 1000;
/** Max channel message arrays kept in memory. LRU eviction when exceeded. */
const MAX_CACHED_CHANNELS = 30;
/** Max DM channel message arrays kept in memory. LRU eviction when exceeded. */
const MAX_CACHED_DM_CHANNELS = 30;
/**
 * Servers at or above this member count skip the focus refetch and the 2-min
 * polling interval — the response is multi-MB and ties up a Postgres connection.
 * Member updates arrive over the socket (member-join/leave/update).
 */
const LARGE_SERVER_MEMBER_THRESHOLD = 1000;
/** Min ms between focus-driven member refetches to absorb rapid focus toggles. */
const MEMBERS_FOCUS_REFETCH_MIN_MS = 30_000;
/** Trim a message array to the per-channel cap, keeping the newest messages. */
const capMessages = (arr: Message[]) =>
  arr.length > MAX_MESSAGES_PER_CHANNEL ? arr.slice(-MAX_MESSAGES_PER_CHANNEL) : arr;

/** Retry a fetch with delay between attempts. Used for reconnect resilience. */
async function fetchWithRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 2000): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('unreachable');
}

/**
 * Establish / re-join an mls 1:1 group on open or when MLS becomes
 * ready. Covers IndexedDB eviction / a fresh profile, where the local 'mls'
 * classification is also gone. Re-asserts 'mls' (one-way ratchet) so a
 * not-yet-ready channel fails closed on send instead of routing to legacy.
 * Fire-and-forget: never blocks the message load; on failure the channel stays
 * not-ready and the send seam stays fail-closed. Deduped inside establishChannel.
 * Failures are routed into uiStore (peer-unprovisioned only) and a
 * ready channel clears any stale failure; the gate also admits rowless non-legacy
 * 1:1 channels (a peer-unprovisioned failure mints no server group row,
 * so the channel-open retry must not require mlsGroupId).
 */
function maybeEstablishActiveMlsChannel(channelId: string, dm: DmChannelEntry | undefined): void {
  if (!dm) return;
  // Rowless GROUP DMs can't establish here (joiner-only path).
  if (dm.isGroup && !dm.mlsGroupId) return;
  // Rowless 1:1: every non-legacy DM is MLS by construction, and
  // establishChannel self-resolves a missing group (Welcome -> server lookup ->
  // create). Exclude only confirmed-legacy channels (encrypted === false).
  if (!dm.isGroup && !dm.mlsGroupId && dm.encrypted === false) return;
  if (mlsCoordinator.isReadyForChannel(channelId)) {
    useUiStore.getState().clearEstablishFailure(channelId); // recovered: drop any stale failure
    return;
  }
  setChannelProtocol(channelId, 'mls'); // restores classification after a wipe
  if (dm.isGroup) {
    // Group DM: a joining member resolves via Welcome / External Commit;
    // it never creates (the owner created the group via createGroupDmGroup).
    void mlsCoordinator.establishGroupDmChannel(channelId, dm.mlsGroupId).catch((err) => {
      logger.warn('[mls] establishGroupDmChannel on open failed', { channelId, error: (err as Error)?.message });
      routeEstablishOutcome(channelId, err);
    });
    return;
  }
  const recipientId = dm.otherUser?.id;
  if (!recipientId) return;
  void mlsCoordinator.establishChannel(channelId, recipientId, dm.mlsGroupId).catch((err) => {
    logger.warn('[mls] establishChannel on open failed', { channelId, error: (err as Error)?.message });
    routeEstablishOutcome(channelId, err);
  });
}

/**
 * Module-level Electron detection — synchronous, race-free against the
 * contextBridge cold-start timing. Packaged Electron now serves the renderer
 * from https://app.howlpro.com (same origin as web users), so the URL protocol
 * can't tell them apart anymore. main.js loads the renderer with `?app=1`
 * appended; we read that synchronously here at module-load (before React's
 * first render) and persist the answer to sessionStorage so subsequent in-app
 * navigations — which strip the query string — keep returning true.
 *
 * The previous protocol-based gate broke after Electron switched off the
 * custom `howl-app://` scheme to HTTPS; a short-lived `window.electron`
 * check before that was racy on cold start (landing-page flash before Login
 * took over). The URL/sessionStorage signal closes both gaps.
 */
const __isElectronApp: boolean = (() => {
  if (typeof window === 'undefined') return false;
  try {
    if (sessionStorage.getItem('howl_electron') === '1') return true;
    if (new URLSearchParams(window.location.search).has('app')) {
      try { sessionStorage.setItem('howl_electron', '1'); } catch { /* private mode / quota */ }
      return true;
    }
  } catch { /* sessionStorage blocked */ }
  // Legacy: file:// protocol from older Electron builds that loaded local HTML.
  if (window.location.protocol === 'file:') return true;
  // contextBridge fallback — set by preload.js. Reliable on warm starts but
  // can race with React's first render on cold start, hence the URL signal
  // above is preferred.
  if (window.__ELECTRON_WINDOW__ === true) return true;
  if ((window as { electron?: { isElectron?: boolean } }).electron?.isElectron === true) return true;
  return false;
})();

// Build-time self-host flag (set by deploy/selfhost/Dockerfile.frontend). A
// self-host build has no marketing site, so the web root redirects into the app.
const __selfHostBuild: boolean = import.meta.env.VITE_SELF_HOST === 'true';

const App: React.FC = () => {
  useRenderLoopDetector('App');
  const { t } = useTranslation();
  const breakpointTier = useBreakpoint();
  const isMobile = breakpointTier === 'mobile';
  const navigate = useNavigate();
  const isElectron = !!(window.electron?.isElectron || window.__ELECTRON_WINDOW__);
  const titleBarPad = isElectron ? TITLE_BAR_HEIGHT : 0;
  const {
    keybinds,
    streamerSettings, updateStreamer, voiceSettings, updateVoice,
    advancedSettings,
    applyServerSettings,
    keybindsGlobalMasterEnabled,
    bluetoothAudioSettings,
    btDevicePreferences,
  } = useSettings();
  const currentUser = useAuthStore(s => s.currentUser);
  const activeServerId = useNavigationStore(s => s.activeServerId);
  const _templateUrlCode = useNavigationStore(s => s.templateUrlCode);
  const _accountDeepLink = useNavigationStore(s => s.accountDeepLink);
  const activeChannelId = useNavigationStore(s => s.activeChannelId);
  const calendarActive = useNavigationStore(s => s.calendarActive);
  // Calendar state (from calendarStore — only calendarMonth needed for fetch effect)
  const calendarMonth = useCalendarStore(s => s.calendarMonth);
  // Voice state (from voiceStore)
  const connectedVoiceChannelId = useVoiceStore(s => s.connectedVoiceChannelId);
  const connectedStageChannelId = useVoiceStore(s => s.connectedStageChannelId);

  const dmUpgradeRanRef = useRef(false);

  // Initialize global visibility listeners once (cleanup on unmount)
  useEffect(() => {
    const cleanup = initAppVisible();
    return cleanup;
  }, []);

  // Stream Deck bridge controller (Electron only, no-ops if preload absent)
  useEffect(() => {
    initStreamDeckController();
    return () => teardownStreamDeckController();
  }, []);

  // Desktop-only prefetch of MediaPipe model files. The combined payload is
  // ~20MB (face_landmarker.task 3.7MB + selfie_multiclass_256x256.tflite 16MB)
  // which we don't want to spend on mobile users who may never hit
  // auto-frame / background blur. Detect desktop via (hover: hover) +
  // (pointer: fine) — this is the reliable "has mouse" heuristic that
  // matches actual desktop/laptop regardless of screen size. Mobile users
  // still get the models, but only when they actually enable a feature
  // that needs them (MediaPipe's own lazy loader handles that fetch).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia('(hover: hover) and (pointer: fine)');
    if (!mql.matches) return;
    const base = import.meta.env.BASE_URL ?? '/';
    const files = [
      `${base}mediapipe/models/face_landmarker.task`,
      `${base}mediapipe/models/selfie_multiclass_256x256.tflite`,
    ];
    for (const href of files) {
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.as = 'fetch';
      link.crossOrigin = 'anonymous';
      link.href = href;
      document.head.appendChild(link);
    }
  }, []);

  // Asset URL resolution utilities
  const resolveAsset = (url?: string | null): string | undefined =>
    apiClient.resolveAssetUrl(url ?? undefined) ?? url ?? undefined;

  const resolveVoiceSummary = (p: VoiceParticipantInfo): VoiceParticipantInfo => ({
    ...p,
    avatar: resolveAsset(p.avatar) ?? p.avatar,
  });

  // Stage state (from stores)
  const activeStageSessions = useVoiceStore(useShallow(s => s.activeStageSessions));

  const channelAccessOrder = useRef<string[]>([]);
  const channelFetchTimestamps = useRef<Record<string, number>>({});
  // dmChannels: read via getState() inside effects/callbacks, not at component level
  const dmAccessOrder = useRef<string[]>([]);
  // Tracks DM channels whose initial history fetch has completed. We used to
  // gate the fetch effect on "does the store already have messages for this
  // channel" — but a socket-delivered message arriving before the REST fetch
  // would trip that check and permanently skip the fetch, leaving the channel
  // stuck until hard-refresh.
  const dmFetchedChannels = useRef<Set<string>>(new Set());
  const { messageRateLimitActive, messageSendError, activateMessageRateLimitBanner: _activateMessageRateLimitBanner, showMessageSendError: _showMessageSendError } = useMessageSendFeedback();
  const activeDmChannelId = useNavigationStore(s => s.activeDmChannelId);
  const activeDmTier = useNavigationStore(s => s.activeDmTier);

  useEffect(() => {
    if (activeDmChannelId) {
      try { localStorage.setItem('howl_last_dm_channel', activeDmChannelId); } catch { /* ignored */ }
    }
  }, [activeDmChannelId]);

  // Bidirectional sync: URL ↔ navigation state (Pass 1 routing infrastructure)
  useRouteSync({
    currentUser,
  });

  // Redirect legacy ?invite=CODE to /invite/CODE
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const inviteCode = params.get('invite');
    if (inviteCode) {
      const url = new URL(window.location.href);
      url.searchParams.delete('invite');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
      navigate(`/invite/${inviteCode}`);
    }
  }, [navigate]);

  // Detect /template/:code URL for template preview overlay
  const location = useLocation();
  useEffect(() => {
    const match = location.pathname.match(/^\/template\/([a-f0-9-]+)$/i);
    useNavigationStore.getState().setTemplateUrlCode(match ? match[1] : null);
  }, [location.pathname]);

  // Dynamic document.title based on current view
  const currentUserId = currentUser?.id;
  useEffect(() => {
    if (!currentUserId) return;
    if (activeServerId === 'home') {
      document.title = 'Howl';
    } else if (activeServerId === 'friends') {
      document.title = 'Howl | Friends';
    } else if (activeServerId === 'account') {
      document.title = 'Howl | Settings';
    } else if (activeServerId === 'dm') {
      const dm = useDmStore.getState().dmChannels.find(d => d.id === activeDmChannelId);
      const name = dm?.name || dm?.otherUser?.username || 'DM';
      document.title = `Howl | ${name}`;
    } else if (activeServerId === 'notifications') {
      document.title = 'Howl | Notifications';
    } else {
      const server = useServerStore.getState().servers.find(s => s.id === activeServerId);
      const channel = server?.channels.find((c: Channel) => c.id === activeChannelId);
      if (server && channel) {
        document.title = `Howl | ${server.name} | #${channel.name}`;
      } else if (server) {
        document.title = `Howl | ${server.name}`;
      } else {
        document.title = 'Howl';
      }
    }
  }, [currentUserId, activeServerId, activeChannelId, activeDmChannelId]);

  // Performance: pause infinite CSS animations when app is hidden
  useEffect(() => {
    const unsub = onVisibilityChange((visible) => {
      document.documentElement.classList.toggle('perf-animations-paused', !visible);
    });
    return unsub;
  }, []);

  type ServerMember = User & { role?: string; roleColor?: string; roleStyle?: 'solid' | 'gradient' | 'holographic'; nickname?: string | null; serverAvatar?: string | null; serverBanner?: string | null };
  // serverMembers: read via getState() where needed, not at component level
  const { membersColumnWidth, membersColumnOpen, setMembersColumnOpen, mobileMembersOpen, setMobileMembersOpen, startDrag } = useMembersColumn(activeServerId, activeChannelId);
  const mobileServerDrawerOpen = useNavigationStore(s => s.mobileServerDrawerOpen);
  // Voice participants (from voiceStore)
  type VoiceParticipantInfo = { userId: string; username: string; avatar?: string; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string };
  const calendarDotState = useNotificationStore(s => s.calendarDotState);

  const { globalToast, showGlobalToast, dismissToast } = useGlobalToast();

  const { activeDmCallChannelId, setActiveDmCallChannelId, dmCallWithVideo, setDmCallWithVideo, dmCallDeclinedUserIds, setDmCallDeclinedUserIds, incomingDmCall, setIncomingDmCall, dmCallParticipantIds, setDmCallParticipantIds, declinedDmCallChannelIds, dmCallStartedAt } = useDmCallState(
    currentUser,
    (msg: string) => showGlobalToast(msg, 'info', 5000),
  );

  // Expose a DM-call teardown hook so leaveOtherActiveCalls can disconnect
  // the DM/group call when the user joins a voice channel or stage. DM call
  // state lives in React (useDmCallState) rather than a zustand store, so
  // the registry calls back into App via this function.
  useEffect(() => {
    setDmCallLeaveFn(() => {
      if (activeDmCallChannelId) {
        socketService.leaveDmCall(activeDmCallChannelId);
      }
      setActiveDmCallChannelId(null);
      setDmCallWithVideo(false);
      setDmCallDeclinedUserIds([]);
      useVoiceStore.getState().setDmCallIsInitiator(null);
      useVoiceStore.getState().setDmCallIncomingMlsReady(undefined);
    });
    return () => setDmCallLeaveFn(null);
  }, [activeDmCallChannelId, setActiveDmCallChannelId, setDmCallWithVideo, setDmCallDeclinedUserIds]);

  // Move-to-Private: register the voice-session probe so dmKeyManager can defer
  //    roaming-identity rotation while the user is in a voice channel or stage
  //    (gamer-safe: no live SFrame rekey). DM calls are EXCLUDED (they key off the
  //    MLS exporter, not this identity), so the probe reads voice/stage state only.
  useEffect(() => {
    dmKeyManager.setVoiceSessionActiveProbe(() => {
      const { connectedVoiceChannelId, connectedStageChannelId } = useVoiceStore.getState();
      return !!(connectedVoiceChannelId || connectedStageChannelId);
    });
    return () => dmKeyManager.setVoiceSessionActiveProbe(null);
  }, []);

  // Move-to-Private: finish a deferred roaming-identity rotation when a
  //    voice/stage session ends. zustand fires on EVERY change, so de-dupe on the
  //    set->null transition of either connection field (covers leave, kick/move,
  //    stage-end, call-switch). The userId is read LIVE at fire time (not closed
  //    over) so a stale closure can't misroute the account-scoped, idempotent,
  //    unlock/lease-guarded resume.
  useEffect(() => {
    const readInSession = () => {
      const s = useVoiceStore.getState();
      return !!(s.connectedVoiceChannelId || s.connectedStageChannelId);
    };
    let prevInSession = readInSession();
    // Already in a voice/stage session at mount: stamp the account-scoped cross-tab flag
    // so a SIBLING tab (which can't see this tab's in-memory voice state) also defers the
    // gamer-safe roaming-identity rotation.
    if (prevInSession) {
      const uid = useAuthStore.getState().currentUser?.id;
      if (uid) dmKeyManager.setVoiceSessionActiveFlag(uid);
    }
    const unsub = useVoiceStore.subscribe((s) => {
      const inSession = !!(s.connectedVoiceChannelId || s.connectedStageChannelId);
      const uid = useAuthStore.getState().currentUser?.id;
      if (inSession) {
        // (Re)stamp the cross-tab voice-active flag while in-session so any tab defers
        // identity rotation; re-stamping refreshes the staleness backstop.
        if (uid) dmKeyManager.setVoiceSessionActiveFlag(uid);
      } else if (prevInSession) {
        // Left the session: clear the cross-tab flag and finish any deferred
        // move-to-Private identity rotation (lease-gated + idempotent; userId read live).
        dmKeyManager.setVoiceSessionActiveFlag(null);
        if (uid) void dmKeyManager.resumePendingRotation(uid);
      }
      prevInSession = inSession;
    });
    return unsub;
  }, []);

  // Electron: report voice/call session state for dynamic backgroundThrottling
  const voiceSessionActiveRef = useRef(false);
  useEffect(() => {
    const active = !!(connectedVoiceChannelId || activeDmCallChannelId || connectedStageChannelId);
    if (active === voiceSessionActiveRef.current) return;
    voiceSessionActiveRef.current = active;
    window.electron?.setVoiceSessionState?.(active);
  }, [connectedVoiceChannelId, activeDmCallChannelId, connectedStageChannelId]);
  const { updateAvailable, applyUpdate } = useServiceWorkerUpdate();

  useEffect(() => {
    if (updateAvailable) {
      showGlobalToast(t('toast.updateAvailable'), 'info', 0, { actionLabel: t('toast.refresh'), onAction: applyUpdate });
    }
  }, [updateAvailable, showGlobalToast, applyUpdate]);

  useEffect(() => {
    const handler = (e: Event) => {
      const { message, type } = (e as CustomEvent<{ message: string; type: 'info' | 'warning' }>).detail;
      showGlobalToast(message, type, 4000);
    };
    window.addEventListener('howl:download-toast', handler);
    return () => window.removeEventListener('howl:download-toast', handler);
  }, [showGlobalToast]);

  /** Text channel selected in the voice-screen quick-text panel (null = use first text channel). */
  const selectedQuickTextChannelId = useNavigationStore(s => s.selectedQuickTextChannelId);
  const _isQuickTextOpen = useNavigationStore(s => s.isQuickTextOpen);
  const processServerMembers = useCallback((membersWithRole: ServerMember[]) => {
    deferStoreUpdate(() => {
      useAppStore.getState().setMembersLoadError(null);
      useServerStore.getState().setServerMembers(membersWithRole);
      const owner = membersWithRole.find((m) => (m.role ?? '').toLowerCase() === 'owner');
      useServerStore.getState().setServerOwnerId(owner?.id ?? null);
    });
  }, []);
  // Offline detection
  useEffect(() => {
    const goOffline = () => useAppStore.getState().setIsOffline(true);
    const goOnline = () => useAppStore.getState().setIsOffline(false);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);
  // Load instance capabilities once at startup (unauthenticated, self-host aware).
  useEffect(() => {
    apiClient.getInstanceConfig()
      .then((cfg) => useAppStore.getState().setInstanceConfig(cfg))
      .catch(() => { /* hosted/older backend without /public/config — keep nulls (permissive) */ });
  }, []);
  const setParticipantVolume = useCallback((userId: string, volume: number) => {
    const v = Math.max(0, Math.min(2, volume));
    const prev = useVoiceStore.getState().participantVolumes;
    if (prev[userId] !== v) useVoiceStore.getState().setParticipantVolumes({ ...prev, [userId]: v });
  }, []);

  const { backgroundImage, setBackgroundImage, backgroundOpacity, setBackgroundOpacity, backgroundBlur, setBackgroundBlur, bgGifAlwaysPlay, setBgGifAlwaysPlay, bgFrameUrl } = useBackgroundSettings(currentUser);

  // When any profile view opens (popup or full modal), fetch friend status for that user
  const fullProfileTarget = useUiStore(s => s.fullProfileTarget);
  const userProfileTarget = useUiStore(s => s.userProfileTarget);
  const activeProfileUserId = fullProfileTarget?.user?.id ?? userProfileTarget?.user?.id ?? null;
  useEffect(() => {
    if (!activeProfileUserId || !currentUser || activeProfileUserId === currentUser.id) {
      useUiStore.getState().setProfileFriendStatus(null);
      return;
    }
    const targetId = activeProfileUserId;
    let cancelled = false;
    Promise.all([apiClient.getFriends(), apiClient.getFriendRequests()]).then(([friends, requests]) => {
      if (cancelled) return;
      deferStoreUpdate(() => {
        const isFriend = friends.some((f) => f.id === targetId);
        const outgoing = requests.outgoing.find((r) => r.user.id === targetId);
        const incoming = requests.incoming.find((r) => r.user.id === targetId);
        if (isFriend) useUiStore.getState().setProfileFriendStatus({ status: 'friends' });
        else if (outgoing) useUiStore.getState().setProfileFriendStatus({ status: 'pending_outgoing', outgoingRequestId: outgoing.id });
        else if (incoming) useUiStore.getState().setProfileFriendStatus({ status: 'pending_incoming' });
        else useUiStore.getState().setProfileFriendStatus({ status: 'none' });
      });
    }).catch(() => deferStoreUpdate(() => useUiStore.getState().setProfileFriendStatus({ status: 'none' })));
    return () => { cancelled = true; };
  }, [activeProfileUserId, currentUser?.id]);

  const refetchProfileFriendStatus = useCallback(() => {
    if (!activeProfileUserId || !currentUser || activeProfileUserId === currentUser.id) return;
    const targetId = activeProfileUserId;
    Promise.all([apiClient.getFriends(), apiClient.getFriendRequests()]).then(([friends, requests]) => {
      deferStoreUpdate(() => {
        const isFriend = friends.some((f) => f.id === targetId);
        const outgoing = requests.outgoing.find((r) => r.user.id === targetId);
        const incoming = requests.incoming.find((r) => r.user.id === targetId);
        if (isFriend) useUiStore.getState().setProfileFriendStatus({ status: 'friends' });
        else if (outgoing) useUiStore.getState().setProfileFriendStatus({ status: 'pending_outgoing', outgoingRequestId: outgoing.id });
        else if (incoming) useUiStore.getState().setProfileFriendStatus({ status: 'pending_incoming' });
        else useUiStore.getState().setProfileFriendStatus({ status: 'none' });
      });
    }).catch(() => deferStoreUpdate(() => useUiStore.getState().setProfileFriendStatus({ status: 'none' })));
  }, [activeProfileUserId, currentUser?.id]);

  // Close-action modal fallback for unauthed screens (Login/Register). The
  // full CloseActionModal is only mounted in the authenticated branch below,
  // so without this the X button on the Login screen does nothing. When the
  // user is unauthed in Electron, auto-quit on close request.
  useEffect(() => {
    if (currentUser) return;
    if (!window.electron?.onShowCloseActionModal) return;
    return window.electron.onShowCloseActionModal(() => {
      window.electron?.closeActionChosen?.('quit', false);
    });
  }, [currentUser]);

  // MFA recommendation banner — initial evaluation on user login only.
  // Previously re-ran on currentUser.mfaEnabled changes, which caused the
  // banner to pop back every time any settings save happened (if the update
  // response briefly had mfaEnabled undefined/false mid-merge, the effect
  // thought MFA had been disabled and showed the banner again). Now scoped
  // to user ID only, with a separate effect to hide when MFA is enabled.
  useEffect(() => {
    if (!currentUser) { useAuthStore.getState().setShowMfaBanner(false); return; }
    if (currentUser.mfaEnabled) { useAuthStore.getState().setShowMfaBanner(false); return; }
    const dismissed = localStorage.getItem(`howl_mfa_dismissed_${currentUser.id}`);
    useAuthStore.getState().setShowMfaBanner(!dismissed);
  }, [currentUser?.id]);

  // Hide banner when MFA gets enabled (false → true). Never re-shows it.
  useEffect(() => {
    if (currentUser?.mfaEnabled) useAuthStore.getState().setShowMfaBanner(false);
  }, [currentUser?.mfaEnabled]);

  const dismissMfaBanner = useCallback(() => {
    if (currentUser) localStorage.setItem(`howl_mfa_dismissed_${currentUser.id}`, '1');
    useAuthStore.getState().setShowMfaBanner(false);
  }, [currentUser?.id]);

  // Autostart prompt — shown ONCE in Electron after first login.
  // localStorage is origin-scoped, so the "shown" flag from a prior origin
  // (legacy howl-app:// build) is invisible to the new https://app.howlpro.com
  // origin. Query Electron for the OS-level autostart state too — if it's
  // already enabled the user has already answered this prompt on a previous
  // install, even if localStorage was lost.
  const [showAutostartPrompt, setShowAutostartPrompt] = useState(false);

  // First-run server-layout picker. Lazily initialize from localStorage so
  // returning users on the same device skip the modal entirely. The flag
  // is set to '1' inside LayoutPickerModal's onComplete handler (in the
  // gate-chain render below), so refreshing while the picker is open
  // brings it back; only Continue dismisses it permanently.
  const [showLayoutPicker, setShowLayoutPicker] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try { return !localStorage.getItem(LAYOUT_PICKER_SEEN_KEY); } catch { return false; }
  });

  // Cross-device dismiss: when SettingsContext applies a server blob with
  // hasSeenLayoutPicker=true, it writes localStorage and dispatches this
  // event. Without this listener, the modal would still be on screen until
  // the user picked manually — defeating the cross-device sync.
  useEffect(() => {
    const handler = () => setShowLayoutPicker(false);
    window.addEventListener(LAYOUT_PICKER_SEEN_EVENT, handler);
    return () => window.removeEventListener(LAYOUT_PICKER_SEEN_EVENT, handler);
  }, []);
  useEffect(() => {
    if (!window.electron?.getAutostart) return;
    if (!currentUser) return;
    if (localStorage.getItem('howl_autostart_prompt_shown')) return;
    let cancelled = false;
    (async () => {
      try {
        const current = await window.electron!.getAutostart!();
        if (cancelled) return;
        if (current?.enabled) {
          // Previously answered — treat as shown, don't ask again.
          try { localStorage.setItem('howl_autostart_prompt_shown', '1'); } catch { /* ignore */ }
          return;
        }
      } catch { /* ignore — fall through to prompt */ }
      if (!cancelled) setShowAutostartPrompt(true);
    })();
    return () => { cancelled = true; };
  }, [currentUser?.id]);

  const handleAutostartPromptDismiss = useCallback(() => {
    setShowAutostartPrompt(false);
  }, []);

  // User status state (synced to backend so other clients see it in member list)
  const currentUserStatus = useAuthStore(s => s.currentUserStatus);

  useEffect(() => {
    if (!window.electron?.onUpdateDownloaded) return;
    return window.electron.onUpdateDownloaded((version: string) => useAppStore.getState().setUpdateReady(version));
  }, []);
  useEffect(() => {
    if (!window.electron?.onUpdateError) return;
    return window.electron.onUpdateError((message: string) => {
      console.warn('[updater] Update error:', message);
      useAppStore.getState().setUpdateError(message);
      setTimeout(() => useAppStore.getState().setUpdateError(null), 8000);
    });
  }, []);
  useEffect(() => {
    if (!window.electron?.onUpdateAvailable) return;
    return window.electron.onUpdateAvailable((version: string) => {
      useAppStore.getState().setUpdateAvailable(version);
    });
  }, []);
  // Hydrate update state that fired before React mounted (e.g., during the update screen)
  useEffect(() => {
    if (!window.electron?.getUpdateStatus) return;
    window.electron.getUpdateStatus().then((status) => {
      const store = useAppStore.getState();
      if (status.available && !store.updateAvailable) store.setUpdateAvailable(status.available);
      if (status.downloaded && !store.updateReady) store.setUpdateReady(status.downloaded);
    }).catch(() => {});
  }, []);

  // When server flags build as recommended-update, silently pre-download the update on Electron
  const updateRecommended = useUpdateStore(s => s.recommended);
  useEffect(() => {
    if (updateRecommended && window.electron?.checkForUpdate) {
      window.electron.checkForUpdate();
    }
  }, [updateRecommended]);

  // Deep link handler — howl://invite/<code> opens the invite page
  useEffect(() => {
    if (!window.electron?.onDeepLink) return;
    return window.electron.onDeepLink((data: { action: string; code: string }) => {
      if (data.action === 'invite' && data.code) {
        navigate(`/invite/${encodeURIComponent(data.code)}`);
      }
    });
  }, [navigate]);

  const { autoIdleRef } = useAutoIdle(currentUserStatus, !!connectedVoiceChannelId || !!activeDmCallChannelId);

  const handleStatusChange = useCallback(
    (status: User['status']) => {
      autoIdleRef.current = false;
      localStorage.removeItem('howl_auto_idle');
      // Manual choice — apply across all surfaces and sync immediately.
      setSelfStatus(status, { immediate: true });
    },
    [autoIdleRef],
  );

  // Audio, Media & Camera states (from voiceStore)
  const isMuted = useVoiceStore(s => s.isMuted);
  const isDeafened = useVoiceStore(s => s.isDeafened);
  const serverMuted = useVoiceStore(s => s.serverMuted);
  const serverDeafened = useVoiceStore(s => s.serverDeafened);
  const isScreenSharing = useVoiceStore(s => s.isScreenSharing);
  const isCameraOn = useVoiceStore(s => s.isCameraOn);
  const screenStream = useVoiceStore(s => s.screenStream);
  const cameraStream = useVoiceStore(s => s.cameraStream);
  const screenShareQuality = useVoiceStore(s => s.screenShareQuality);
  const showCameraPreview = useVoiceStore(s => s.showCameraPreview);
  const updateScreenShareQuality = useCallback((q: ScreenShareQuality) => {
    useVoiceStore.getState().setScreenShareQuality(q);
  }, []);

  const handleEditServerProfile = useCallback((serverId: string) => {
    useNavigationStore.getState().setAccountDeepLink({ page: 'my-account', subTab: 'profiles', profileServerId: serverId });
    navigate('/settings');
  }, [navigate]);

  const cleanupSession = useCallback(async (opts?: { preserveEncryption?: boolean }) => {
    const preserveEncryption = opts?.preserveEncryption ?? false;
    // Reset bootstrap-hydration tracking so the next sign-in (including
    // logout-then-relogin as the same user in the same tab) re-runs the
    // cold-start fetches. Without this, the per-domain useEffects would
    // see a stale ref matching the new currentUser.id and skip their
    // initial fetches, leaving stores empty until reload.
    bootstrappedUserIdRef.current = null;
    import('./src/pushManager').then(({ unsubscribeFromPush }) => unsubscribeFromPush()).catch(() => {});
    sessionStorage.removeItem('howl_voice_channel');
    socketService.disconnect();
    // Stop the history-upload syncer and release its cross-tab lease on
    // BOTH paths (preserve-keys idle/cross-tab logout AND full sign-out), so a
    // stale syncer never keeps draining after the session ends. The durable local
    // history store is wiped only on the full-clear path below (via reset()).
    stopHistorySync();
    try { await apiClient.logout(); } catch { /* best-effort — server may have already invalidated */ }
    if (!preserveEncryption) {
      await import('./services/dmEncryption').then(({ clearAllDmEncryptionData }) => clearAllDmEncryptionData()).catch(() => {});
      clearEncryptionStatus();
    } else {
      // Idle expiry / cross-tab logout / server session-expiry: scrub the
      // decrypted key material from memory and drop the plaintext attachment
      // cache, but keep the on-disk wrapped credential so the next unlock stays
      // seamless. This must clear the private + channel keys from memory once
      // the session is gone, so the next user on a shared device can't read them.
      await import('./services/dmEncryption').then(({ lockEncryptionForSessionEnd }) => lockEncryptionForSessionEnd()).catch(() => {});
    }
    if (typeof window !== 'undefined') {
      // Only wipe session/identity-bound keys. User preferences (theme,
      // custom colors, UI density, mention colors, notification settings,
      // keybinds, saved bar position, etc.) MUST survive a sign-out so
      // users don't lose their customization every time they come back to
      // the login screen after an idle session expiry or tab reload.
      const SESSION_SCOPED_KEYS = [
        'howl_auto_idle',
        'howl_returnTo',
        'howl_connected_stage_channel',
        'howl_logout_signal',
      ];
      for (const key of SESSION_SCOPED_KEYS) localStorage.removeItem(key);
      if (!preserveEncryption) {
        localStorage.removeItem('howl_e2e_remember');
        localStorage.removeItem('howl_e2e_remember_last_used');
      }
      // Per-user UUID-prefixed keys (E2E key material, per-account caches).
      // These are tied to the signed-in account and must not leak to the
      // next login.
      for (const key of Object.keys(localStorage)) {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:/.test(key)) {
          localStorage.removeItem(key);
        }
      }
    }
    if (typeof caches !== 'undefined') caches.delete('user-uploads').catch(() => {});
    useAuthStore.getState().setCurrentUser(null);
    navigate('/', { replace: true });
    useMessageStore.getState()._setAll({ messages: {}, channelHasMore: {}, channelPinnedMessageIds: {}, dmMessages: {}, dmHasMore: {}, dmPinnedMessageIds: {}, dmPinnedVersion: 0 });
    useDmStore.getState()._setAll({ dmChannels: [], dmBlockStatus: {} });
    useTypingStore.getState().clearAllTyping();
    useVoiceStore.getState().setParticipantVolumes({});
    useVoiceStore.getState().setScreenShareVolumes({});
    useNotificationStore.getState().setUnreadDmChannelIds(new Set());
    useUiStore.getState().setForwardPayload(null);
    useVoiceStore.getState().setConnectedVoiceChannelId(null);
    useNotificationStore.getState().setServerNotifications([]);
    useNotificationStore.getState().setServerMentionCounts({});
    useNotificationStore.getState().setServerUnreadIds(new Set());
    useNotificationStore.getState().setChannelUnreadIds(new Set());
    useNotificationStore.getState().setChannelMentionCounts({});
    useNotificationStore.getState().setThreadMentionCounts({});
    useNotificationStore.getState().setDmUnreadCounts({});
    useNotificationStore.getState().setDmMentionCounts({});
    useNotificationStore.getState().setNotificationCounts({ total: 0, byServer: {} });
    useNotificationStore.getState().setCalendarDotState({});
    useVoiceStore.getState().setVoiceChannelParticipants([]);
    useVoiceStore.getState().setAllVoiceChannelParticipants({});
    useVoiceStore.getState().setServerVoiceSummary({});
    useVoiceStore.getState().setServerStageSummary({});
    useUiStore.getState().setUserProfileTarget(null);
    useUiStore.getState().setUserContextMenuTarget(null);
    useUiStore.getState().setModViewTarget(null);
    useNotificationStore.getState().setPendingFriendRequestCount(0);
    useSocialStore.getState().setBlockedUserIds(new Set());
    setActiveDmCallChannelId(null);
    setIncomingDmCall(null);
    dismissToast();
    useAppStore.getState().setChannelLoadError(null);
    useAppStore.getState().setDmLoadError(null);
    useUiStore.getState().setDeleteChannelConfirm(null);
    useUiStore.getState().setRecoveryKeyModal(null);
    useUiStore.getState().setE2ePassphraseModal(null);
    useUiStore.getState().setShowRecoveryReminder(false);
    clearMediaCaches();
    // Delete (not just close) the DM search index (AES-GCM ciphertext at rest)
    // on EVERY session end — full sign-out AND idle-lock / cross-tab-logout
    // / server-session-expiry — as defense-in-depth so no DM history a same-user
    // re-login could resurrect survives the key scrub. The index is rebuilt from
    // messages on the next channel open.
    await import('./services/dmSearchIndex').then(m => m.teardownSearchIndexForSessionEnd()).catch(() => {});
    dmUpgradeRanRef.current = false;
    // Intentionally NOT calling resetSettings() here. User preferences (theme,
    // custom colors, UI density, mention colors, notification prefs, keybinds,
    // saved bar position) must survive sign-out per the block above — calling
    // resetSettings would wipe local settings AND debounce-push defaults to
    // the server, so users returning from an unexpected session expiry lost
    // every customization. A dedicated "Reset Settings" action in the UI
    // covers the intentional reset case.
  }, [dismissToast]);

  const handleLogout = useCallback(async (keepEncryptionKeys = false) => {
    await cleanupSession({ preserveEncryption: keepEncryptionKeys });
    try {
      localStorage.setItem('howl_logout_signal', JSON.stringify({ ts: Date.now(), keepKeys: keepEncryptionKeys }));
    } catch { /* best-effort */ }
  }, [cleanupSession]);

  useEffect(() => {
    apiClient.onSessionExpired(() => {
      cleanupSession({ preserveEncryption: true });
      navigate('/');
    });
  }, [cleanupSession, navigate]);

  // Cross-tab sync: propagate logout via localStorage storage event
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'howl_logout_signal' && e.newValue) {
        let keepKeys = false;
        try { keepKeys = JSON.parse(e.newValue).keepKeys === true; } catch { /* legacy format or parse error — default to wipe */ }
        cleanupSession({ preserveEncryption: keepKeys });
        navigate('/');
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [cleanupSession]);


  // Cross-tab sync: propagate token refresh via BroadcastChannel (in-memory, same-origin)
  useEffect(() => {
    let bc: BroadcastChannel;
    try {
      bc = new BroadcastChannel('howl_token_sync');
    } catch { return; /* BroadcastChannel unavailable */ }
    bc.onmessage = (e: MessageEvent) => {
      if (e.data?.type !== 'token_refresh' || typeof e.data.token !== 'string') return;
      try {
        const token = e.data.token;
        const parts = token.split('.');
        if (parts.length !== 3) return;
        const payload = JSON.parse(atob(parts[1]));
        if (payload.userId !== currentUser?.id) return;
        if (payload.exp && payload.exp * 1000 < Date.now()) return;
        apiClient.setToken(token);
        const sock = socketService.getSocket();
        if (sock) sock.auth = { token };
      } catch { /* reject malformed token */ }
    };
    return () => bc.close();
  }, [currentUser?.id]);

  // Cross-tab/cross-device sync: listen for profile, preferences, and settings
  // changes pushed via Socket.IO from other sessions of the same user.
  useEffect(() => {
    if (!currentUser?.id) return;
    const sock = socketService.getSocket();
    if (!sock) return;

    const onProfileUpdated = (data: Partial<User>) => {
      useAuthStore.getState().updateCurrentUser(data);
    };

    const onSettingsUpdated = async (data: { data: Record<string, unknown>; updatedAt: string }) => {
      if (!data.data) return;
      // Dedup our own echo: the server emits settings-updated back to the
      // sending socket too. When an incoming event's updatedAt matches the
      // one we just got back from our own PUT, re-applying it is a waste and
      // can clobber an in-flight later edit. Skip those.
      try {
        const { getLastLocallyObservedUpdatedAt } = await import('./utils/settingsSync');
        if (data.updatedAt && data.updatedAt === getLastLocallyObservedUpdatedAt()) return;
      } catch { /* fall through — apply anyway */ }
      applyServerSettings(data.data as import('./utils/settingsSync').SettingsBlob);
    };

    sock.on('profile-updated', onProfileUpdated);
    sock.on('settings-updated', onSettingsUpdated);

    return () => {
      sock.off('profile-updated', onProfileUpdated);
      sock.off('settings-updated', onSettingsUpdated);
    };
  }, [currentUser?.id, applyServerSettings]);

  // Tracks which userId has been hydrated from the /bootstrap aggregate
  // response.  The per-domain cold-start useEffects below check this ref and
  // skip their initial fetches when the data is already in the stores.
  const bootstrappedUserIdRef = useRef<string | null>(null);

  // Session restore waterfall — single bootstrap call replaces the previous
  // 7-call cold-start fan-out (auth/me + settings + servers + folders +
  // per-server emojis × N + notification-counts + blocked).  Connect-storm
  // prep for public-launch flash traffic.
  useEffect(() => {
    const restore = async () => {
      if (!apiClient.getToken()) {
        const refreshed = await apiClient.refreshAccessToken().catch(() => null);
        if (!refreshed) { return; }
      }

      try {
        // Diagnostic breadcrumbs use console.error so vite's production build
        // (which strips console.log/debug/info/warn via esbuild `pure`) keeps
        // them alive. The `[diag]` prefix marks them as observability, not
        // actual errors.
        console.error('[diag][restore] calling /bootstrap');
        const bootstrap = await apiClient.getBootstrap();
        console.error('[diag][restore] /bootstrap returned', { hasUser: !!bootstrap.user, errors: bootstrap.errors, serverCount: bootstrap.servers?.length });
        const user = bootstrap.user;
        if (!user) {
          // user is null can mean two very different things:
          //   1) loadCurrentUserProfile rejected (transient DB / pooler error)
          //      — surfaced via bootstrap.errors.user. Cookie is still valid;
          //      a reload would succeed. Do NOT clear the token and force the
          //      user to re-login.
          //   2) The user record is genuinely gone (account deleted) — no
          //      `errors.user` field. Then the token is now meaningless.
          if (bootstrap.errors?.user) {
            console.error('[diag][bootstrap] user slice failed transiently — keeping session, user can reload:', bootstrap.errors.user);
            return;
          }
          console.error('[diag][bootstrap] user is null with no errors — clearing token');
          apiClient.clearToken();
          return;
        }

        if (bootstrap.errors) {
          // Partial failure — we still have what succeeded.  Log so we can
          // see if a particular slice is consistently flaky in production.
          console.warn('[bootstrap] partial failure:', bootstrap.errors);
        }

        // Hydrate stores BEFORE setCurrentUser so the dependent useEffects
        // that fire when currentUser flips don't need to refetch.  Order
        // matches the per-effect store assignments below.
        deferStoreUpdate(() => {
          useServerStore.getState().setServers(bootstrap.servers);
          useServerFolderStore.getState().setFolders(bootstrap.folders);
          useNotificationStore.getState().setNotificationCounts(bootstrap.notificationCounts);
          useSocialStore.getState().setBlockedUserIds(new Set(bootstrap.blocked.map((u) => u.id)));
          // Flatten the per-server emoji map and seed the picker store, mirroring
          // the previous getServerEmojis × N fan-out behavior.
          setCustomEmojis(Object.values(bootstrap.emojis).flat());
        });

        // Apply server-stored settings from the bootstrap response (was a
        // separate fetch in fetchAndApplyServerSettings).  Sync hook below
        // marks settingsSyncDone so the redundant fetch doesn't fire.
        if (bootstrap.settings) {
          try {
            const { applyServerSettings: applyFromBootstrap } = await import('./utils/settingsSync');
            applyFromBootstrap(bootstrap.settings, applyServerSettings);
          } catch { /* ignore — fall back to local */ }
        }

        // Await encryption init + auto-unlock BEFORE setting the user so that
        // the DM message-loading effect (which triggers on currentUserId) finds
        // the key manager already unlocked.  Without this, messages fetched
        // before tryAutoUnlock completes get cached with the "🔒 Encrypted
        // message" placeholder and are never re-decrypted.
        //
        // setE2eLocked MUST run even on partial failure — without it, the
        // DM-column inline unlock form never shows because e2eLocked stays
        // at its default false, leaving the user stranded after dismissing
        // the launch modal.
        //
        // Decision tracked here so we can defer setE2ePassphraseModal('unlock')
        // until AFTER setCurrentUser — without that ordering, the modal state
        // is set on a uiStore that no consumer is mounted against yet
        // (AppLayout, where EncryptionPassphraseModal lives, only mounts when
        // currentUser is non-null). Setting it before the gate flips creates
        // a fragility window: any code path between this block and
        // setCurrentUser that touches uiStore could silently clobber the
        // modal flag, and the subscriber doesn't fire on initial mount for
        // a value that was set "in the past".
        let openUnlockModalAfterMount = false;
        try {
          const { initializeEncryption } = await import('./services/dmEncryption');
          await initializeEncryption(user.id);
          console.error('[diag][e2e-boot] init ok');
          // Provision this device's MLS identity at authenticated session
          // start, BEFORE and independent of vault unlock. Fire-and-forget: a failure
          // must never block boot/unlock; the provisioner is idempotent + cross-tab
          // single-flighted under withProvisionLock.
          void dmKeyManager.provisionMlsDevice().catch((e) =>
            console.error('[diag][e2e-boot] provisionMlsDevice failed: ' + (e as Error)?.message),
          );
          let hasBundle = false;
          let checkSetupTransientFail = false;
          try {
            hasBundle = await dmKeyManager.checkSetup();
            console.error('[diag][e2e-boot] hasBundle=' + hasBundle);
          } catch (checkErr) {
            // Transient checkSetup failure (5xx, network, 401-after-refresh).
            // Per fix 5b4da8fb, checkSetup throws on transient errors so we
            // don't surface the SETUP modal to users who already have keys.
            // BUT — we must still try to prompt for UNLOCK on transient
            // errors, otherwise a single cold-start 5xx silently
            // strands the user with no way to read encrypted DMs until
            // they manually navigate to Settings → Encryption. Track the
            // distinction so a genuine 404 (no bundle) doesn't nag users
            // who deliberately declined encryption setup.
            checkSetupTransientFail = true;
            console.error('[diag][e2e-boot] checkSetup transient failure:', (checkErr as Error)?.message);
          }
          if (hasBundle && !dmKeyManager.isUnlocked()) {
            let unlocked = false;
            try {
              unlocked = await dmKeyManager.tryAutoUnlock();
              console.error('[diag][e2e-boot] autoUnlock=' + unlocked);
            } catch (autoErr) {
              console.error('[diag][e2e-boot] autoUnlock threw:', (autoErr as Error)?.message);
              unlocked = false;
            }
            if (!unlocked && dmKeyManager.getUnlockOnLogin()) {
              console.error('[diag][e2e-boot] getUnlockOnLogin=true, queuing unlock modal for after currentUser mount');
              openUnlockModalAfterMount = true;
            }
          } else if (checkSetupTransientFail && dmKeyManager.getUnlockOnLogin() && !dmKeyManager.isUnlocked()) {
            // checkSetup threw a transient failure — we can't confirm the
            // bundle status from the server. If the user has
            // unlock-on-login enabled we open the modal anyway so they
            // can type their passphrase and recover from the transient.
            // A genuine first-time user (404) does NOT hit this branch
            // because checkSetup returns false cleanly on 404, leaving
            // checkSetupTransientFail=false.
            console.error('[diag][e2e-boot] checkSetup transient + getUnlockOnLogin=true, queuing unlock modal as recovery affordance');
            openUnlockModalAfterMount = true;
          }
        } catch (initErr) {
          console.error('[diag][e2e-boot] init FAILED:', (initErr as Error)?.message);
          // Encryption init failed — continue without E2E; user can unlock manually
        } finally {
          const locked = dmKeyManager.isSetup() && !dmKeyManager.isUnlocked();
          console.error('[diag][e2e-boot] e2eLocked=' + locked);
          useUiStore.getState().setE2eLocked(locked);
        }

        // Mark this user as bootstrap-hydrated so the per-domain cold-start
        // useEffects below skip their initial fetches (the data is already in
        // the stores).  Cleared on user change.
        bootstrappedUserIdRef.current = user.id;

        // Set user AFTER encryption is ready — this triggers the DM message-
        // loading effect, which needs the key manager unlocked to decrypt.
        deferStoreUpdate(() => useAuthStore.getState().setCurrentUser(user));
        console.error('[diag][restore] currentUser set, session restored');

        // Open the unlock modal AFTER setCurrentUser so AppLayout (which owns
        // EncryptionPassphraseModal) is mounted and subscribed to the uiStore
        // selector by the time the modal flag flips. queueMicrotask defers
        // until the current sync block finishes; React commits the
        // currentUser flip → AppLayout mounts → the modal-state set is then
        // observed via Zustand's normal change subscription path.
        if (openUnlockModalAfterMount) {
          queueMicrotask(() => {
            console.error('[diag][e2e-boot] opening unlock modal post-mount');
            useUiStore.getState().setE2ePassphraseModal('unlock');
          });
        }

        // If the user landed on /login (e.g. they hit /login while still
        // authenticated, or refreshed after navigating there), the unauth
        // route block stops matching once currentUser is set, but the URL
        // still says /login. AppLayout would render the chat under that URL,
        // which can look like a half-broken state. Send them to /home or
        // their stored returnTo so the URL matches what they're seeing.
        try {
          const path = window.location.pathname;
          if (path === '/login' || path === '/') {
            const returnTo = sessionStorage.getItem('howl_returnTo');
            sessionStorage.removeItem('howl_returnTo');
            const target = returnTo && /^\/(home|channels\/@me|channels\/[a-f0-9-]{36}|friends|settings|discover|s\/)/.test(returnTo)
              ? returnTo
              : '/home';
            navigate(target, { replace: true });
          }
        } catch { /* navigate may not be ready yet, harmless */ }

        const wasAutoIdle = localStorage.getItem('howl_auto_idle') === '1';
        localStorage.removeItem('howl_auto_idle');

        const actualStatus = user.rawStatus ?? user.status;
        let restoredStatus = actualStatus;
        if (restoredStatus === 'offline') restoredStatus = 'online';
        if (restoredStatus === 'idle' && wasAutoIdle) restoredStatus = 'online';

        deferStoreUpdate(() => applySelfStatus(restoredStatus));
        if (restoredStatus !== actualStatus) {
          syncStatusToServer(restoredStatus, { immediate: true });
        } else {
          primeSentStatus(restoredStatus);
        }
        import('./src/pushManager').then(({ subscribeToPush, isPushSupported }) => {
          if (isPushSupported() && Notification.permission === 'granted') subscribeToPush().catch(() => {});
        }).catch(() => {});
        import('./services/dmSearchIndex').then(async (m) => {
          await m.initSearchIndex(user.id);
          m.loadIndexFromDB().catch(() => {});
          m.evictOldMessages().catch(() => {});
        }).catch(() => {});
      } catch (err) {
        console.error('[diag][restore] threw — clearing token, user routed to login:', err);
        apiClient.clearToken();
      }
    };
    restore();
  }, []);

  // Fetch server-stored settings on login (cross-device sync)
  const settingsSyncDone = useRef(false);
  useEffect(() => {
    if (!currentUserId || settingsSyncDone.current) return;
    settingsSyncDone.current = true;
    // Bootstrap already hydrated settings — skip the redundant fetch.
    if (bootstrappedUserIdRef.current === currentUserId) return;
    import('./utils/settingsSync').then(({ fetchAndApplyServerSettings }) => {
      fetchAndApplyServerSettings(applyServerSettings);
    }).catch(() => {});
  }, [currentUserId, applyServerSettings]);

  // Real-time cross-device settings sync via socket
  useEffect(() => {
    if (!currentUserId) return;
    socketService.onSettingsUpdated(async ({ data, updatedAt }) => {
      if (!data) return;
      // Same echo-dedup as the raw socket handler above.
      try {
        const { getLastLocallyObservedUpdatedAt } = await import('./utils/settingsSync');
        if (updatedAt && updatedAt === getLastLocallyObservedUpdatedAt()) return;
      } catch { /* fall through */ }
      applyServerSettings(data as SettingsBlob);
    });
    return () => { socketService.offSettingsUpdated(); };
  }, [currentUserId, applyServerSettings]);

  // Flush pending settings sync on tab close / visibility change so edits
  // made in the last 500ms before exit don't get lost to the server,
  // which would cause a stale fetchAndApplyServerSettings on next login
  // to roll the local state back to the pre-edit values.
  useEffect(() => {
    if (!currentUserId) return;
    let mod: typeof import('./utils/settingsSync') | null = null;
    import('./utils/settingsSync').then((m) => { mod = m; }).catch(() => {});
    const flush = () => { mod?.flushSyncToServer(); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [currentUserId]);

  // Periodic DM search index eviction (every 30 min)
  useEffect(() => {
    if (!currentUser) return;
    const interval = setInterval(() => {
      import('./services/dmSearchIndex').then(m => m.evictOldMessages()).catch(() => {});
    }, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, [currentUser?.id]);

  // One-time migration helper: if the user has no server folders on the
  // backend but does have a legacy localStorage entry, import them.  Used by
  // both the bootstrap-hydrated path and the legacy fetch path so we don't
  // duplicate the localStorage parsing logic.
  const migrateLocalFoldersIfEmpty = useCallback((backendFolderCount: number) => {
    if (backendFolderCount > 0) {
      localStorage.removeItem('howl_server_folders');
      localStorage.removeItem('howl_selected_folder_id');
      return;
    }
    try {
      const raw = localStorage.getItem('howl_server_folders');
      if (!raw) return;
      const local = JSON.parse(raw) as Array<{ name: string; color?: string; serverIds: string[]; muted?: boolean }>;
      if (!Array.isArray(local) || local.length === 0) return;
      apiClient.importServerFolders(local.map((f) => ({
        name: f.name || 'Folder',
        color: f.color,
        serverIds: f.serverIds || [],
        muted: f.muted ?? false,
      }))).then((imported) => {
        deferStoreUpdate(() => useServerFolderStore.getState().setFolders(imported));
        localStorage.removeItem('howl_server_folders');
        localStorage.removeItem('howl_selected_folder_id');
      }).catch(() => {});
    } catch { /* invalid localStorage data, ignore */ }
  }, []);

  // Load servers when user is logged in
  useEffect(() => {
    if (!currentUser) {
      useServerStore.getState().setServers([]);
      return;
    }
    // Bootstrap already hydrated servers + folders — skip the redundant fetches
    // but still run the one-time localStorage migration for users whose
    // bootstrap returned an empty folder list.
    if (bootstrappedUserIdRef.current === currentUser.id) {
      migrateLocalFoldersIfEmpty(useServerFolderStore.getState().folders.length);
      return;
    }
    apiClient
      .getServers()
      .then((data) => deferStoreUpdate(() => useServerStore.getState().setServers(data)))
      .catch((err) => {
        console.error('Failed to load servers:', err);
      });

    // Fetch server folders (synced to account)
    apiClient.getServerFolders()
      .then((folders) => {
        deferStoreUpdate(() => useServerFolderStore.getState().setFolders(folders));
        migrateLocalFoldersIfEmpty(folders.length);
      })
      .catch(() => {
        try {
          const raw = localStorage.getItem('howl_server_folders');
          if (raw) {
            const local = JSON.parse(raw);
            if (Array.isArray(local)) {
              deferStoreUpdate(() => useServerFolderStore.getState().setFolders(
                local.map((f: Record<string, unknown>, i: number) => ({
                  id: (f.id as string) || `local-${i}`,
                  userId: '',
                  name: (f.name as string) || 'Folder',
                  color: (f.color as string | null) ?? null,
                  serverIds: (f.serverIds as string[]) || [],
                  position: i,
                  muted: (f.muted as boolean) ?? false,
                  createdAt: '',
                  updatedAt: '',
                }))
              ));
            }
          }
        } catch { /* no fallback available */ }
      });
  }, [currentUser?.id]);

  // Eagerly populate custom emoji store
  const serverIds = useServerStore(useShallow(s => s.servers.map(sv => sv.id)));
  const serverIdKey = useMemo(() => serverIds.join(','), [serverIds]);
  useEffect(() => {
    const currentServers = useServerStore.getState().servers;
    if (currentServers.length === 0) { setCustomEmojis([]); return; }
    Promise.all(
      currentServers.map((s) =>
        apiClient.getServerEmojis(s.id).then((emojis) => emojis).catch(() => [] as import('./types').CustomEmoji[])
      )
    ).then((results) => {
      setCustomEmojis(results.flat());
    });
  }, [serverIdKey]);

  // Load server members when viewing a server
  const lastMembersFetchRef = useRef<number>(0);
  useEffect(() => {
    if (!currentUser) {
      useServerStore.getState().setServerMembers([]);
      useServerStore.getState().setServerOwnerId(null);
      return;
    }
    const isServerView = isRealServerId(activeServerId);
    if (!isServerView) {
      useServerStore.getState().setServerMembers([]);
      useServerStore.getState().setServerOwnerId(null);
      return;
    }
    useAppStore.getState().setMembersLoadError(null);
    apiClient
      .getServerMembers(activeServerId)
      .then((m) => { lastMembersFetchRef.current = Date.now(); processServerMembers(m); })
      .catch((err) => {
        console.error('Failed to load server members:', err);
        useAppStore.getState().setMembersLoadError(err instanceof Error ? err.message : 'Failed to load members');
        useServerStore.getState().setServerMembers([]);
        useServerStore.getState().setServerOwnerId(null);
      });
  }, [currentUser?.id, activeServerId]);

  // Refetch servers and server members on window focus. For large servers
  // (>=1000 members) we skip the member refetch and rely on socket deltas
  // (member-join/leave/update) to keep the list current — a full refetch is
  // multi-MB and locks a Postgres connection for seconds. Also skip if we
  // just fetched within the last 30s to avoid duplicate work on rapid focus.
  useEffect(() => {
    const onFocus = () => {
      if (!currentUser?.id) return;
      apiClient.getServers().then((data) => deferStoreUpdate(() => useServerStore.getState().setServers(data))).catch(() => {});
      if (!isRealServerId(activeServerId)) return;
      const memberCount = useServerStore.getState().serverMembers.length;
      if (memberCount >= LARGE_SERVER_MEMBER_THRESHOLD) return;
      if (Date.now() - lastMembersFetchRef.current < MEMBERS_FOCUS_REFETCH_MIN_MS) return;
      apiClient.getServerMembers(activeServerId)
        .then((m) => { lastMembersFetchRef.current = Date.now(); processServerMembers(m); })
        .catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [currentUser?.id, activeServerId]);

  const refetchServerMembers = useCallback(() => {
    const sid = useNavigationStore.getState().activeServerId;
    if (!isRealServerId(sid)) return;
    if (useServerStore.getState().serverMembers.length >= LARGE_SERVER_MEMBER_THRESHOLD) return;
    apiClient.getServerMembers(sid)
      .then((m) => { lastMembersFetchRef.current = Date.now(); processServerMembers(m); })
      .catch(() => {});
  }, [processServerMembers]);

  // Refetch server members periodically — but only while visible. Member
  // updates arrive in real-time over the socket; the 2-minute poll is just a
  // consistency fallback so it doesn't need to fire while the window is
  // minimized. We re-fetch immediately on visibility restore to catch up.
  // refetchServerMembers self-skips for large servers (>=1000 members) where
  // socket deltas are the only sustainable path.
  const isViewingServer = isRealServerId(activeServerId);
  useEffect(() => {
    if (!currentUser?.id || !isViewingServer) return;
    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (interval !== null) return;
      interval = setInterval(refetchServerMembers, 120_000);
    };
    const stop = () => {
      if (interval === null) return;
      clearInterval(interval);
      interval = null;
    };
    if (isAppVisible()) start();
    const unsub = onVisibilityChange((visible) => {
      if (visible) {
        refetchServerMembers();
        start();
      } else {
        stop();
      }
    });
    return () => { stop(); unsub(); };
  }, [currentUser?.id, isViewingServer, refetchServerMembers]);

  // Socket: connect when logged in, join current channel when connected, disconnect on logout
  const prevChannelRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentUser) {
      socketService.disconnect();
      prevChannelRef.current = null;
      return;
    }
    const token = apiClient.getToken();
    if (!token) return;
    const server = useServerStore.getState().servers.find((s) => s.id === activeServerId);
    const channel = server?.channels.find((c) => c.id === activeChannelId);
    const isTextChannel = channel?.type === 'text';
    socketService.connect(token, () => {
      if (isTextChannel && activeChannelId) socketService.joinChannel(activeChannelId);
    });
    return () => socketService.disconnect();
  }, [currentUser?.id]);

  // Refs for socket callbacks to read current server/channel
  const activeServerIdRef = useRef(activeServerId);
  const activeChannelIdRef = useRef(activeChannelId);
  const quickTextChannelIdRef = useRef<string | null>(null);
  const activeServerRef = useRef<Server | undefined>(undefined);
  const prevServerIdForNotificationsRef = useRef<string | null>(null);
  const serversRef = useRef<Server[]>([]);
  const serverIdListRef = useRef<string[]>(['home']);
  const textChannelsRef = useRef<{ id: string }[]>([]);
  const currentUserRef = useRef<User | null>(null);
  const currentServersForRefs = useServerStore.getState().servers;
  serversRef.current = currentServersForRefs;
  serverIdListRef.current = ['home', ...currentServersForRefs.map(s => s.id)];
  textChannelsRef.current = (currentServersForRefs.find(s => s.id === activeServerId)?.channels.filter(c => c.type === 'text')) ?? [];
  currentUserRef.current = currentUser;
  const processDmListRef = useRef<((list: any) => void) | null>(null);

  // Channel socket events
  useChannelSocketEvents({
    currentUserId: currentUser?.id,
  });

  // Socket: on reconnect, fetch missed messages
  const handleReconnect = useCallback(async () => {
    await new Promise((r) => setTimeout(r, 1500));

    const navState = useNavigationStore.getState();
    const chId = navState.activeChannelId;
    const dmId = navState.activeDmChannelId;
    const sid = navState.activeServerId;

    // Stagger fan-out across ~1s with random per-call jitter so a flash-launch
    // reconnect storm spreads each client's burst over time, lowering peak QPS.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    fetchWithRetry(() => apiClient.getDMs())
      .then((list) => processDmListRef.current?.(list))
      .catch((err) => console.warn('[reconnect] DM list refresh failed:', err));

    sleep(200 + Math.random() * 300).then(() => {
      fetchWithRetry(() => apiClient.getServers())
        .then((fresh) => deferStoreUpdate(() => useServerStore.getState().setServers(fresh)))
        .catch((err) => console.warn('[reconnect] server list refresh failed:', err));
    });

    sleep(400 + Math.random() * 300).then(() => {
      apiClient.getNotificationCounts().then((c) => deferStoreUpdate(() => useNotificationStore.getState().setNotificationCounts(c))).catch(() => {});
    });

    // No bulk `join-server` re-fire on reconnect: the backend's connection
    // handler (socketHandlers/connection.ts) auto-subscribes the socket to
    // every server/channel/DM room the user can see on each (re)connect.
    // The active channel/DM explicit joins below are kept as defensive
    // single-event backstops — they don't contribute to the flood pattern
    // that this reconnect handler used to trigger.

    if (chId && sid !== 'home' && sid !== 'account' && sid !== 'friends' && sid !== 'dm') {
      socketService.joinChannel(chId);
      const chType = serversRef.current.find(s => s.channels.some(c => c.id === chId))?.channels.find(c => c.id === chId)?.type;
      if (chType !== 'forum') {
        sleep(600 + Math.random() * 300).then(() => {
          // Initial fetch capped at 50 (pagination loads more) per OOM mitigation
          // 33d1464 — heavier initial loads can blow the renderer heap on servers
          // with many embeds. Do not raise without revisiting that fix.
          fetchWithRetry(() => apiClient.getChannelMessages(chId, { limit: 50 }))
            .then(({ messages: fresh }) => {
              if (fresh.length === 0) return;
              {
                const old = useMessageStore.getState().messages[chId] || [];
                const oldIds = new Set(old.map(m => m.id));
                const newMsgs = fresh.filter(m => !oldIds.has(m.id));
                if (newMsgs.length > 0) {
                  const merged = [...old, ...newMsgs].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
                  useMessageStore.getState().setChannelMessages(chId, merged.length > MAX_MESSAGES_PER_CHANNEL ? merged.slice(-MAX_MESSAGES_PER_CHANNEL) : merged, useMessageStore.getState().channelHasMore[chId] ?? false);
                }
              }
            })
            .catch((err) => console.warn('[reconnect] channel messages refresh failed:', err));
        });
      }
    }

    if (dmId && sid === 'dm') {
      socketService.joinDM(dmId);
      sleep(600 + Math.random() * 300).then(() => {
        fetchWithRetry(() => apiClient.getDMMessages(dmId))
          .then(async ({ messages: fresh, encrypted }) => {
            if (fresh.length === 0) return;
            const existingIds = new Set((useMessageStore.getState().dmMessages[dmId] || []).map(m => m.id));
            const genuinelyNew = fresh.filter(m => !existingIds.has(m.id));
            if (genuinelyNew.length === 0) return;
            const isEncrypted = encrypted ?? false;
            if (isEncrypted) setChannelEncryptionStatus(dmId, true);
            let decrypted: typeof genuinelyNew;
            try {
              const dmChannel = useDmStore.getState().dmChannels.find((ch) => ch.id === dmId);
              decrypted = await decryptDMMessages(dmId, genuinelyNew, isEncrypted, dmChannel);
            } catch {
              decrypted = genuinelyNew;
            }
            {
              const old = useMessageStore.getState().dmMessages[dmId] || [];
              const oldIds = new Set(old.map(m => m.id));
              const newMsgs = decrypted.filter(m => !oldIds.has(m.id));
              if (newMsgs.length > 0) {
                const merged = [...old, ...newMsgs].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
                useMessageStore.getState().setDmMessages(dmId, merged.length > MAX_MESSAGES_PER_CHANNEL ? merged.slice(-MAX_MESSAGES_PER_CHANNEL) : merged, useMessageStore.getState().dmHasMore[dmId] ?? false);
              }
            }
          })
          .catch((err) => console.warn('[reconnect] DM messages refresh failed:', err));
      });
    }
  }, []);
  useEffect(() => {
    if (!currentUser) return;
    socketService.onReconnect(handleReconnect);
    return () => { socketService.offReconnect(); };
  }, [currentUser?.id, handleReconnect]);

  // E2E key management socket listeners
  useEffect(() => {
    if (!currentUser) return;
    socketService.onDmKeyRotationNeeded((data) => {
      // This event is MLS-only - the repurposed leader election. The
      // elected oldest-remaining member authors the leaver's Remove Commit.
      // Re-assert the mls ratchet (the elected member's local classification
      // can lag the server's saved-tier MlsGroup signal).
      setChannelProtocol(data.dmChannelId, 'mls');
      mlsCoordinator.handleGroupLeaderElection(data, currentUserId);
    });
    return () => {
      socketService.offDmKeyRotationNeeded();
    };
  }, [currentUser?.id]);

  // Reconnect socket after system sleep/wake (Electron only)
  useEffect(() => {
    if (!window.electron?.onSystemResume) return;
    const cleanup = window.electron.onSystemResume(() => {
      const sock = socketService.getSocket();
      if (sock && !sock.connected) {
        sock.connect();
      }
    });
    return cleanup;
  }, []);

  // Join all server rooms so we receive server-channel-activity
  const joinedServerRoomsRef = useRef<Set<string>>(new Set());
  const channelToServerMap = useMemo(() => {
    const map: Record<string, string> = {};
    const currentServers = useServerStore.getState().servers;
    for (const s of currentServers) {
      for (const ch of s.channels) map[ch.id] = s.id;
    }
    return map;
  }, [serverIdKey]);
  const channelToServerMapRef = useRef<Record<string, string>>({});
  channelToServerMapRef.current = channelToServerMap;
  const channelToServerLookup = useCallback((): Record<string, string> => channelToServerMapRef.current, []);

  useEffect(() => {
    if (!currentUserId || !socketService.joinServer || !socketService.leaveServer) return;

    const onInitial = (serverId: string, participantsByChannel: Record<string, Array<VoiceParticipantInfo>>) => {
      const filtered: Record<string, VoiceParticipantInfo[]> = {};
      for (const [chId, list] of Object.entries(participantsByChannel)) {
        if (list.length > 0) filtered[chId] = list.map(resolveVoiceSummary);
      }
      if (Object.keys(filtered).length > 0) {
        deferStoreUpdate(() => useVoiceStore.getState().setServerVoiceSummary(prev => ({ ...prev, [serverId]: filtered })));
      }
    };

    const onUpdate = (serverId: string, channelId: string, participants: Array<VoiceParticipantInfo>) => {
      if (serverId === activeServerIdRef.current) return;
      deferStoreUpdate(() => useVoiceStore.getState().setServerVoiceSummary(prev => {
        const serverData = { ...(prev[serverId] ?? {}) };
        if (participants.length === 0) {
          delete serverData[channelId];
        } else {
          serverData[channelId] = participants.map(resolveVoiceSummary);
        }
        if (Object.keys(serverData).length === 0) {
          const next = { ...prev };
          delete next[serverId];
          return next;
        }
        return { ...prev, [serverId]: serverData };
      }));
    };

    const onStageInitial = (serverId: string, participantsByChannel: Record<string, Array<VoiceParticipantInfo>>) => {
      const filtered: Record<string, VoiceParticipantInfo[]> = {};
      for (const [chId, list] of Object.entries(participantsByChannel)) {
        if (list.length > 0) filtered[chId] = list.map(resolveVoiceSummary);
      }
      if (Object.keys(filtered).length > 0) {
        deferStoreUpdate(() => useVoiceStore.getState().setServerStageSummary(prev => ({ ...prev, [serverId]: filtered })));
      }
    };

    const onStageUpdate = (serverId: string, channelId: string, participants: Array<VoiceParticipantInfo>) => {
      deferStoreUpdate(() => useVoiceStore.getState().setServerStageSummary(prev => {
        const serverData = { ...(prev[serverId] ?? {}) };
        if (participants.length === 0) {
          delete serverData[channelId];
        } else {
          serverData[channelId] = participants.map(resolveVoiceSummary);
        }
        if (Object.keys(serverData).length === 0) {
          const next = { ...prev };
          delete next[serverId];
          return next;
        }
        return { ...prev, [serverId]: serverData };
      }));
    };

    socketService.whenConnected(() => {
      socketService.onGlobalVoiceParticipantsInitial?.(onInitial, channelToServerLookup);
      socketService.onGlobalVoiceParticipants?.(onUpdate, channelToServerLookup);
      socketService.onGlobalStageParticipantsInitial?.(onStageInitial, channelToServerLookup);
      socketService.onGlobalStageParticipants?.(onStageUpdate, channelToServerLookup);

      const serverIds = useServerStore.getState().servers.filter((s) => typeof s.id === 'string').map((s) => s.id);
      const next = new Set(serverIds);
      joinedServerRoomsRef.current.forEach((id) => {
        if (!next.has(id)) {
          socketService.leaveServer(id);
          joinedServerRoomsRef.current.delete(id);
        }
      });
      // Track membership in the ref for parity with the leave path above,
      // but don't emit `join-server` — the backend's connection-time
      // auto-subscribe (socketHandlers/connection.ts) joins every server
      // room the user can see, so the explicit emit here would just burn
      // the 30/10s socket rate-limit counter with no added effect.
      serverIds.forEach((id) => {
        if (!joinedServerRoomsRef.current.has(id)) {
          joinedServerRoomsRef.current.add(id);
        }
      });
    });

    return () => {
      socketService.offGlobalVoiceParticipants?.();
      socketService.offGlobalStageParticipants?.();
    };
  }, [currentUserId, serverIdKey, channelToServerLookup]);



  // Presence updates
  usePresenceUpdates({ currentUserId: currentUser?.id });

  // Activity updates
  useActivityUpdates({ currentUserId: currentUser?.id });

  // Seed current user's spotify activity on mount
  useEffect(() => {
    if (!currentUser?.id) return;
    let cancelled = false;
    apiClient.getSpotifyPlaybackState().then(data => {
      if (cancelled || !data.active || !data.track) return;
      const prev = useAuthStore.getState().currentUser;
      if (!prev || prev.activity?.type === 'spotify') return;
      useAuthStore.getState().updateCurrentUser({
        activity: {
          type: 'spotify' as const,
          name: data.track!.name,
          details: data.track!.artists.join(', '),
          state: data.track!.album,
          largeImage: data.track!.albumArt,
          platformId: data.track!.id,
          durationMs: data.track!.durationMs,
          startedAt: new Date().toISOString(),
        },
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentUser?.id]);

  // Electron game detection
  useGameDetection({ enabled: advancedSettings.showGameLibrary, shareDetectedGames: true });

  // Electron Spotify detection
  useSpotifyDetection({ enabled: advancedSettings.showGameLibrary, shareSpotifyActivity: true });

  useSocialSocketEvents({ currentUserId: currentUser?.id, showGlobalToast });

  useBillingSocketEvents({ currentUserId: currentUser?.id });

  useServerMemberSocketEvents({
    currentUserId: currentUser?.id,
    joinedServerRoomsRef,
    navigateHome: useCallback(() => navigate('/home'), [navigate]),
    refetchServerMembers,
    showGlobalToast,
  });

  useNotificationSocketEvents({ currentUserId: currentUser?.id, activeServerIdRef, activeChannelIdRef, currentUserRef, serversRef });

  useDiscoverySocketEvents({ currentUserId: currentUser?.id });

  // Fetch initial notification counts on mount
  useEffect(() => {
    if (!currentUser) return;
    // Bootstrap already hydrated counts — skip the redundant fetch.
    if (bootstrappedUserIdRef.current === currentUser.id) return;
    apiClient.getNotificationCounts().then((c) => deferStoreUpdate(() => useNotificationStore.getState().setNotificationCounts(c))).catch(() => {});
  }, [currentUser?.id]);

  // Clear calendar white dot when calendar is opened
  const calendarDotForActiveServer = calendarDotState[activeServerId as string];
  useEffect(() => {
    if (calendarActive && activeServerId && calendarDotForActiveServer === 'change') {
      useNotificationStore.getState().setCalendarDotState((prev) => { const next = { ...prev }; delete next[activeServerId]; return next; });
    }
  }, [calendarActive, activeServerId, calendarDotForActiveServer]);

  // Server structure socket events — hook writes directly to useServerStore.
  useServerStructureSocketEvents();

  // Self Roles socket events.
  useRolePickerSocketEvents();

  // Poll + thread socket events
  const setMessagesDispatch: React.Dispatch<React.SetStateAction<Record<string, Message[]>>> = useCallback((action) => {
    const prev = useMessageStore.getState().messages;
    const next = typeof action === 'function' ? action(prev) : action;
    useMessageStore.getState()._setAll({ messages: next });
  }, []);
  useThreadPollSocketEvents(setMessagesDispatch);

  useStageSocketEvents();
  useViewerSocketEvents();

  // Load polls + threads when channel changes
  useEffect(() => {
    if (isRealServerId(activeServerId) && activeChannelId) {
      apiClient.getPolls(activeChannelId, activeServerId).then((polls) => {
        deferStoreUpdate(() => {
          useThreadPollStore.getState().setChannelPollsRaw((prev) => ({ ...prev, [activeChannelId]: polls }));
          useThreadPollStore.getState().touchThreadChannel(activeChannelId);
          useThreadPollStore.getState().evictStaleThreadChannels(activeChannelId);
        });
      }).catch(() => {});
      apiClient.getThreads(activeChannelId, activeServerId).then((threads) => {
        deferStoreUpdate(() => {
          useThreadPollStore.getState().setChannelThreadsRaw((prev) => ({ ...prev, [activeChannelId]: threads }));
          useThreadPollStore.getState().touchThreadChannel(activeChannelId);
          useThreadPollStore.getState().evictStaleThreadChannels(activeChannelId);
        });
      }).catch(() => {});
    }
    useThreadPollStore.getState().setActiveThread(null);
  }, [activeServerId, activeChannelId]);

  // Load all threads for the server
  useEffect(() => {
    if (!isRealServerId(activeServerId)) return;
    apiClient.getServerThreads(activeServerId).then((threads) => {
      deferStoreUpdate(() => {
        const grouped: Record<string, Thread[]> = {};
        for (const t of threads) {
          if (!grouped[t.channelId]) grouped[t.channelId] = [];
          grouped[t.channelId].push(t);
        }
        useThreadPollStore.getState().setChannelThreadsRaw((prev) => ({ ...prev, ...grouped }));
      });
    }).catch(() => {});
  }, [activeServerId]);

  // Load stage sessions when server changes
  useEffect(() => {
    if (!isRealServerId(activeServerId)) return;
    const server = useServerStore.getState().servers.find((s) => s.id === activeServerId);
    const stageChannels = server?.channels.filter((c) => c.type === 'stage') ?? [];
    for (const ch of stageChannels) {
      apiClient.getStage(ch.id, activeServerId).then((session) => {
        deferStoreUpdate(() => {
          if (session) useVoiceStore.getState().setActiveStageSessions((prev) => ({ ...prev, [ch.id]: normalizeStageSession(session) }));
          else useVoiceStore.getState().setActiveStageSessions((prev) => { const next = { ...prev }; delete next[ch.id]; return next; });
        });
      }).catch(() => {});
    }
  }, [activeServerId]);

  // DM socket events
  useDmSocketEvents({ currentUserId: currentUser?.id });
  // OTR (Off the Record) tier socket events — ephemeral 1:1
  useOtrSocketEvents(currentUser?.id);

  // MLS: heal undecryptable DM messages when keys arrive (epoch / mls-ready).
  useMlsRedecrypt({ currentUserId: currentUser?.id });
  // MLS: lazily restore the open DM's archived history from the server
  // (retries when the channel becomes ready).
  useMlsHistoryRestore({ currentUserId: currentUser?.id, activeDmChannelId });

  // Load blocked list
  useEffect(() => {
    if (!currentUser) return;
    // Bootstrap already hydrated the blocked set — skip the redundant fetch.
    if (bootstrappedUserIdRef.current === currentUser.id) return;
    apiClient.getBlocked().then((users) => deferStoreUpdate(() => useSocialStore.getState().setBlockedUserIds(new Set(users.map((u) => u.id))))).catch(() => {});
  }, [currentUser?.id]);

  useEffect(() => {
    const sid = activeServerId;
    const isServer = isRealServerId(sid);
    if (isServer) {
      if (prevServerIdForNotificationsRef.current != null && prevServerIdForNotificationsRef.current !== sid) {
        useNotificationStore.getState().setServerNotifications([]);
      }
      prevServerIdForNotificationsRef.current = sid;
      useNotificationStore.getState().clearServerMention(sid);
      useNotificationStore.getState().removeServerUnread(sid);
    } else {
      prevServerIdForNotificationsRef.current = null;
    }
  }, [activeServerId]);

  // Clear channel-level notification dots when user selects that text channel
  useEffect(() => {
    if (!activeChannelId) return;
    // Clear the unread dot from the channel list (visual only)
    useNotificationStore.getState().removeChannelUnread(activeChannelId);
    useNotificationStore.getState().clearChannelMention(activeChannelId);
    // markChannelRead is deferred to ChatArea — called when user sees new messages or reaches bottom
  }, [activeChannelId]);

  // Server room: when viewing a server, subscribe to voice participants
  const joinedServerIdRef = useRef<string | null>(null);
  const hasServerRoom = typeof socketService.joinServer === 'function';
  useEffect(() => {
    if (!currentUserId) return;
    const isServerView = isRealServerId(activeServerId);
    if (!isServerView) {
      if (joinedServerIdRef.current) {
        socketService.offServerVoiceParticipants?.();
        joinedServerIdRef.current = null;
        useVoiceStore.getState().setAllVoiceChannelParticipants({});
      }
      return;
    }
    if (!hasServerRoom) return;
    const serverId = activeServerId as string;
    if (joinedServerIdRef.current === serverId) return;
    if (joinedServerIdRef.current) {
      socketService.offServerVoiceParticipants?.();
    }
    joinedServerIdRef.current = serverId;
    socketService.joinServer(serverId);
    socketService.onServerVoiceParticipantsInitial?.((participantsByChannel) => {
      deferStoreUpdate(() => useVoiceStore.getState().setAllVoiceChannelParticipants(
        Object.fromEntries(
          Object.entries(participantsByChannel).map(([chId, list]) => [
            chId,
            list.map((p) => ({ ...resolveVoiceSummary(p), id: p.userId })),
          ])
        )
      ));
    });
    socketService.onServerVoiceParticipants?.((channelId, participants) => { deferStoreUpdate(() => {
      const state = useVoiceStore.getState();
      const prev = state.allVoiceChannelParticipants[channelId] ?? [];
      const next = participants.map((p) => ({ ...resolveVoiceSummary(p), id: p.userId }));
      const server = activeServerRef.current;
      const channelName = server?.channels.find((c) => c.id === channelId)?.name ?? 'Voice';
      const joined = participants.filter((p) => !prev.some((q) => q.id === p.userId));
      const left = prev.filter((p) => !participants.some((q) => q.userId === p.id));

      // Compute new serverVoiceSummary
      const svPrev = state.serverVoiceSummary;
      const serverData = { ...(svPrev[serverId] ?? {}) };
      if (participants.length === 0) {
        delete serverData[channelId];
      } else {
        serverData[channelId] = participants.map(resolveVoiceSummary);
      }
      let newSvs: typeof svPrev;
      if (Object.keys(serverData).length === 0) {
        newSvs = { ...svPrev };
        delete newSvs[serverId];
      } else {
        newSvs = { ...svPrev, [serverId]: serverData };
      }

      // Batch both voice store updates into a single setState
      useVoiceStore.setState({
        serverVoiceSummary: newSvs,
        allVoiceChannelParticipants: { ...state.allVoiceChannelParticipants, [channelId]: next },
      });

      // Notifications (separate store) — only for actual joins/leaves, not initial sync
      const isLikelyInitialSync = prev.length === 0 && participants.length > 1;
      if (!isLikelyInitialSync && (joined.length > 0 || left.length > 0)) {
        useNotificationStore.getState().setServerNotifications((n) => {
          let result = n;
          for (const p of joined) {
            result = upsertGroupedNotification(result, {
              groupKey: `voice_join:${channelId}`,
              type: 'voice_join',
              username: p.username,
              channelName,
            });
          }
          for (const p of left) {
            result = upsertGroupedNotification(result, {
              groupKey: `voice_leave:${channelId}`,
              type: 'voice_leave',
              username: p.username,
              channelName,
            });
          }
          return result;
        });
      }
    }); });
    return () => {
      socketService.offServerVoiceParticipants?.();
      if (joinedServerIdRef.current === serverId) joinedServerIdRef.current = null;
    };
  }, [currentUserId, activeServerId, hasServerRoom]);

  // Voice channel: play connect/disconnect sounds and maintain the tracking
  // ref used by other hooks. The actual join-voice-channel socket emit is
  // handled by useCallSession's transport (which sends the signed join-blob
  // required for E2EE leader election). Previously this effect emitted an
  // UNSIGNED join here, which the backend saw as an already-in-channel
  // re-emit when useCallSession's SIGNED join arrived — triggering the
  // "existingChannel === channelId" transfer branch (socketsLeave +
  // call-transferred to other devices). That branch briefly yanked this
  // socket out of the voice room between the two emits and could kick
  // other tabs of the same user off the channel mid-join.
  const voiceChannelIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentUserId) return;
    const channelId = connectedVoiceChannelId;
    if (voiceChannelIdRef.current && voiceChannelIdRef.current !== channelId) {
      voiceChannelIdRef.current = null;
      useVoiceStore.getState().setVoiceChannelParticipants([]);
    }
    if (!channelId) return;
    voiceChannelIdRef.current = channelId;
    if (voiceSettingsRef.current.soundConnect) playActionSoundRef.current('connect');
    const onParticipants = (chId: string, participants: Array<{ userId: string; username: string; nickname?: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }>) => {
      if (chId === channelId)
        deferStoreUpdate(() => useVoiceStore.getState().setVoiceChannelParticipants(participants.map((p) => ({ userId: p.userId, username: p.username, nickname: p.nickname, avatar: resolveAsset(p.avatar), banner: resolveAsset(p.banner), bannerPositionY: p.bannerPositionY, bannerZoom: p.bannerZoom, nameColor: p.nameColor, nameFont: p.nameFont, nameEffect: p.nameEffect, avatarEffect: p.avatarEffect, effectivePlan: p.effectivePlan, roleColor: p.roleColor, roleStyle: p.roleStyle as 'solid' | 'gradient' | 'holographic' | undefined, stream: null }))));
    };
    const onJoined = (data: { userId: string; username: string; nickname?: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }) => {
      deferStoreUpdate(() => useVoiceStore.getState().setVoiceChannelParticipants((prev) =>
        prev.some((p) => p.userId === data.userId) ? prev : [...prev, { userId: data.userId, username: data.username, nickname: data.nickname, avatar: resolveAsset(data.avatar), banner: resolveAsset(data.banner), bannerPositionY: data.bannerPositionY, bannerZoom: data.bannerZoom, nameColor: data.nameColor, nameFont: data.nameFont, nameEffect: data.nameEffect, avatarEffect: data.avatarEffect, effectivePlan: data.effectivePlan, roleColor: data.roleColor, roleStyle: data.roleStyle as 'solid' | 'gradient' | 'holographic' | undefined, stream: null }]
      ));
    };
    const onLeft = (data: { userId: string }) => {
      deferStoreUpdate(() => useVoiceStore.getState().setVoiceChannelParticipants((prev) => prev.filter((p) => p.userId !== data.userId)));
    };
    socketService.onVoiceParticipants(onParticipants);
    socketService.onVoiceUserJoined(onJoined);
    socketService.onVoiceUserLeft(onLeft);
    return () => {
      // leave + listener cleanup are owned by useCallSession's transport —
      // emitting leave here too double-emits and (previously) also wiped
      // useCallSession's freshly-registered listeners via offVoice(). Keep
      // only the UI concerns (sound, participant list reset, ref).
      if (voiceSettingsRef.current.soundDisconnect) playActionSoundRef.current('disconnect');
      voiceChannelIdRef.current = null;
      useVoiceStore.getState().setVoiceChannelParticipants([]);
    };
  }, [connectedVoiceChannelId, currentUserId]);

  // Join socket rooms for all DM channels
  const joinedDmIdsRef = useRef<Set<string>>(new Set());
  const dmChannelIds = useDmStore(useShallow(s => s.dmChannels.map(ch => ch.id)));
  const dmChannelIdKey = useMemo(() => dmChannelIds.join(','), [dmChannelIds]);
  useEffect(() => {
    if (!currentUserId) return;
    const ids = new Set(useDmStore.getState().dmChannels.map((ch) => ch.id));
    joinedDmIdsRef.current.forEach((id) => {
      if (!ids.has(id)) {
        socketService.leaveDM(id);
        joinedDmIdsRef.current.delete(id);
      }
    });
    // Track membership in the ref so the leave-on-removal loop above still
    // fires, but don't emit `join-dm` — the backend's connection-time
    // auto-subscribe handles this on every (re)connect. Mid-session DM
    // creation calls `socketsJoin` from the creating route (routes/dms.ts,
    // routes/dmKeys.ts), so the live socket is already in the room.
    ids.forEach((id) => {
      if (!joinedDmIdsRef.current.has(id)) {
        joinedDmIdsRef.current.add(id);
      }
    });
  }, [currentUserId, dmChannelIdKey]);

  // Recovery key weekly reminder
  useEffect(() => {
    if (!currentUser || !dmKeyManager.isUnlocked()) return;
    apiClient.request('/dms/keys/bundle').then((bundle: any) => {
      if (!bundle?.lastRecoveryReminder) return;
      const lastReminder = new Date(bundle.lastRecoveryReminder).getTime();
      const weekMs = 7 * 24 * 60 * 60 * 1000;
      if (Date.now() - lastReminder > weekMs) {
        useUiStore.getState().setShowRecoveryReminder(true);
      }
    }).catch(() => {});
  }, [currentUser?.id]);

  // Clear unread when user selects a DM channel. OTR has its own parallel unread
  // maps (cleared tier-aware in ChatArea) and no server read state, so skip this
  // Saved-tier clear/markDmAsRead while viewing OTR — otherwise opening OTR would
  // wipe (and server-mark-read) an unread Saved message. Switching back to Saved
  // re-fires with tier 'saved' and clears correctly.
  useEffect(() => {
    if (!activeDmChannelId || activeDmTier === 'otr') return;
    apiClient.markDmAsRead(activeDmChannelId).catch(() => {});
    useNotificationStore.getState().removeUnreadDmChannel(activeDmChannelId);
    useNotificationStore.getState().clearDmUnread(activeDmChannelId);
    useNotificationStore.getState().clearDmMention(activeDmChannelId);
  }, [activeDmChannelId, activeDmTier]);

  // Fetch pending friend request count on mount — socket events
  // (friend-request-received, friend-list-update, friend-request-cancelled)
  // keep the count current after the initial load, so no polling needed.
  useEffect(() => {
    if (!currentUser) return;
    apiClient.getFriendRequests().then((r) => deferStoreUpdate(() => useNotificationStore.getState().setPendingFriendRequestCount(r.incoming.length))).catch(() => {});
  }, [currentUser?.id]);
  useEffect(() => {
    if (currentUserId && activeServerId === 'friends') {
      apiClient.getFriendRequests().then((r) => deferStoreUpdate(() => useNotificationStore.getState().setPendingFriendRequestCount(r.incoming.length))).catch(() => {});
    }
  }, [currentUserId, activeServerId]);

  const processDmList = useCallback(async (list: Array<any>) => {
    list.forEach((ch) => {
      if (ch.encrypted !== undefined) setChannelEncryptionStatus(ch.id, ch.encrypted);
    });
    const { isMlsEnvelopeV4 } = await import('./services/mls/types');
    const processedChannels = await Promise.all(list.map(async (ch) => {
      if (!ch.lastMessage) return ch;
      const content = ch.lastMessage.content;
      const needsDecrypt = ch.lastMessage.encrypted || isMlsEnvelopeV4(content);
      if (!needsDecrypt) return ch;
      if (dmKeyManager.isUnlocked()) {
        try {
          const { decryptDMContent, ENCRYPTED_PLACEHOLDER } = await import('./services/dmEncryption');
          const decrypted = await decryptDMContent(ch.id, content, true, ch.lastMessage.authorId);
          if (decrypted !== content && decrypted !== ENCRYPTED_PLACEHOLDER) {
            return { ...ch, lastMessage: { ...ch.lastMessage, content: decrypted } };
          }
        } catch {
          // fall through
        }
      }
      return { ...ch, lastMessage: { ...ch.lastMessage, content: '' } };
    }));
    const currentActiveId = useNavigationStore.getState().activeDmChannelId;
    const next = new Set<string>();
    const nextUnreadCounts: Record<string, number> = {};
    const nextMentionCounts: Record<string, number> = {};
    list.forEach((ch) => {
      if (ch.hasUnread && ch.id !== currentActiveId) next.add(ch.id);
      if ((ch.unreadCount ?? 0) > 0 && ch.id !== currentActiveId) nextUnreadCounts[ch.id] = ch.unreadCount!;
      if ((ch.mentionCount ?? 0) > 0 && ch.id !== currentActiveId) nextMentionCounts[ch.id] = ch.mentionCount!;
    });
    deferStoreUpdate(() => {
      useDmStore.getState().setDmChannels(processedChannels);
      useNotificationStore.setState({
        unreadDmChannelIds: next,
        dmUnreadCounts: nextUnreadCounts,
        dmMentionCounts: nextMentionCounts,
      });
    });
  }, []);
  processDmListRef.current = processDmList;

  // Load DM channel list
  useEffect(() => {
    if (!currentUser) return;
    apiClient.getDMs().then(processDmList).catch(() => {});
  }, [currentUser?.id, processDmList]);

  // Refresh DM list when opening Messages view
  useEffect(() => {
    if (!currentUserId || activeServerId !== 'dm') return;
    if (useDmStore.getState().dmChannels.length > 0) return;
    apiClient.getDMs().then(processDmList).catch(() => {});
  }, [currentUserId, activeServerId, processDmList]);

  // Load messages for active DM
  useEffect(() => {
    if (!currentUserId || !activeDmChannelId) return;
    const channelId = activeDmChannelId;

    // Establish/re-join the mls 1:1 on open (per server mlsGroupId).
    // Fire-and-forget; runs before the dmFetchedChannels guard so a reopen of an
    // already-loaded but not-ready channel still attempts establishment.
    maybeEstablishActiveMlsChannel(channelId, useDmStore.getState().dmChannels.find((ch) => ch.id === channelId));

    dmAccessOrder.current = dmAccessOrder.current.filter((id) => id !== channelId);
    dmAccessOrder.current.push(channelId);

    if (dmFetchedChannels.current.has(channelId)) return;

    let cancelled = false;
    useAppStore.getState().setDmLoadError(null);
    apiClient
      .getDMMessages(channelId)
      .then(async ({ messages: msgs, hasMore, blockStatus, pinnedMessageIds: pins, encrypted }) => {
        if (cancelled) return;
        const isEncrypted = encrypted ?? false;
        if (isEncrypted) setChannelEncryptionStatus(channelId, true);
        const dmChannel = useDmStore.getState().dmChannels.find((ch) => ch.id === channelId);
        const decryptedMsgs = await decryptDMMessages(channelId, msgs, isEncrypted, dmChannel);
        if (cancelled) return;

        deferStoreUpdate(() => {
          useAppStore.getState().setDmLoadError(null);
          {
            const existing = useMessageStore.getState().dmMessages[channelId] || [];
            const historyIds = new Set(decryptedMsgs.map((m) => m.id));
            const realtimeOnly = existing.filter((m) => !historyIds.has(m.id));
            useMessageStore.getState().setDmMessages(channelId, capMessages([...decryptedMsgs, ...realtimeOnly]), hasMore);
            dmFetchedChannels.current.add(channelId);
            while (dmAccessOrder.current.length > MAX_CACHED_DM_CHANNELS) {
              const evicted = dmAccessOrder.current.shift()!;
              if (evicted !== channelId) {
                dmFetchedChannels.current.delete(evicted);
                const prevDm = useMessageStore.getState().dmMessages;
                if (prevDm[evicted]) {
                  const { [evicted]: _, ...rest } = prevDm;
                  useMessageStore.getState()._setAll({ dmMessages: rest });
                }
              }
            }
          }
          useMessageStore.getState().evictStaleDmChannels(channelId);
          if (blockStatus) useDmStore.getState().setDmBlockStatus(channelId, blockStatus);
          useMessageStore.getState().setDmPinnedIds(channelId, pins ?? []);
        });
        if (isEncrypted) import('./services/dmSearchIndex').then(m => m.indexDMMessages(channelId, decryptedMsgs)).catch(() => {});
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Failed to load DM messages:', err);
          useAppStore.getState().setDmLoadError(err instanceof Error ? err.message : 'Failed to load messages');
        }
      });
    return () => { cancelled = true; };
  }, [activeDmChannelId, currentUserId]);

  // Re-decrypt cached encrypted DMs when E2E keys become available.
  //
  // Boot path that this fixes: auto-unlock fails (no remembered credential, or
  // the user disabled it) → setCurrentUser proceeds → the DM-load effect above
  // fires for activeDmChannelId while dmKeyManager.isUnlocked() is still false
  // → decryptDMMessages stamps every envelope with ENCRYPTED_PLACEHOLDER and
  // marks the channel in dmFetchedChannels. The unlock modal then opens, the
  // user types their passphrase, dmKeyManager emits 'unlocked' — but the
  // already-stored placeholder content sits in messageStore forever because
  // nothing watches the unlock event to invalidate it. The inline DMView
  // unlock form had a one-off onDmUnlocked callback for this; the modal path
  // (AppLayout EncryptionPassphraseModal) and the Settings → Encryption tab
  // both bypassed it. Single subscriber here covers every unlock entry point.
  //
  // dmFetchedChannels is also cleared so navigating to a previously-loaded
  // encrypted DM after unlock re-fires the load effect instead of skipping
  // because "we already fetched this" and showing the empty/placeholder cache.
  useEffect(() => {
    if (!currentUserId) return;
    // Invalidate placeholder-stamped encrypted DMs and re-decrypt the active one.
    // Shared by two triggers: the legacy unlock event (dmKeyManager 'unlocked')
    // and — for MLS 1:1 DMs — the coordinator's 'mls-ready'. An MLS DM left
    // open during unlock must not stay stuck on the lock placeholder. The
    // coordinator activates asynchronously AFTER dmKeyManager unlocks, so when
    // 'unlocked' fires isReadyForChannel() is still false and the re-decrypt
    // yields placeholders; 'mls-ready' fires the same reload once it's ready.
    const reloadEncryptedDms = async () => {
      const encryptedIds = useDmStore.getState().dmChannels
        .filter((ch) => ch.encrypted)
        .map((ch) => ch.id);
      if (encryptedIds.length === 0) return;
      const prevDm = useMessageStore.getState().dmMessages;
      const next = { ...prevDm };
      for (const id of encryptedIds) {
        delete next[id];
        dmFetchedChannels.current.delete(id);
      }
      useMessageStore.getState()._setAll({ dmMessages: next });
      const activeId = useNavigationStore.getState().activeDmChannelId;
      if (activeId && encryptedIds.includes(activeId)) {
        const dmChannel = useDmStore.getState().dmChannels.find((ch) => ch.id === activeId);
        await apiClient.getDMMessages(activeId)
          .then(async ({ messages: msgs, hasMore, blockStatus, pinnedMessageIds: pins, encrypted }) => {
            const decryptedMsgs = await decryptDMMessages(activeId, msgs, encrypted ?? true, dmChannel);
            useMessageStore.getState().setDmMessages(activeId, capMessages(decryptedMsgs), hasMore);
            dmFetchedChannels.current.add(activeId);
            if (blockStatus) useDmStore.getState().setDmBlockStatus(activeId, blockStatus);
            useMessageStore.getState().setDmPinnedIds(activeId, pins ?? []);
          })
          .catch(() => {});
      }
    };
    // Coalesce concurrent triggers: 'unlocked' and 'mls-ready' fire in close
    // succession on a normal unlock. Run at most one reload at a time, but if a
    // trigger arrives while a reload is in flight, queue exactly one trailing
    // rerun so the final reload lands AFTER the last event ('mls-ready', once
    // the coordinator is ready). Mirrors mlsCoordinator.runWelcomeDrain.
    let reloading = false;
    let rerunPending = false;
    const runReload = async () => {
      if (reloading) { rerunPending = true; return; }
      reloading = true;
      try {
        do {
          rerunPending = false;
          await reloadEncryptedDms();
        } while (rerunPending);
      } finally {
        reloading = false;
      }
    };
    const offLegacy = dmKeyManager.on(() => {
      if (!dmKeyManager.isUnlocked()) return;
      void runReload();
    });
    // On vault lock, drop the in-memory DM search index + close its DB
    // handle. The on-disk store is deleted by lock()'s teardown on every
    // scrub-for-good path; it only survives a tab-close/reopen (no lock()), where
    // onUnlocked rebuilds from it. After a deliberate lock the store is gone and
    // search re-indexes lazily as DMs are opened.
    const offSearchLock = dmKeyManager.on((e) => {
      if (e === 'locked') {
        void import('./services/dmSearchIndex').then((m) => m.onLocked()).catch(() => undefined);
      } else if (e === 'unlocked' && currentUserId) {
        void import('./services/dmSearchIndex').then((m) => m.onUnlocked(currentUserId)).catch(() => undefined);
      }
    });
    const offMls = mlsCoordinator.mlsEvents.on((e) => {
      // Drive the reactive indicator on BOTH transitions so the DM
      // composer's MLS-locked banner appears when a sibling tab (or a worker
      // crash) tears MLS down and clears again once it recovers. Consumers read
      // mlsCoordinator.isActive() synchronously, gated on this tick.
      useUiStore.getState().bumpMlsReadyTick();
      if (e === 'mls-ready') {
        void runReload();
        // Bring the upload syncer up and pull the cross-device archive
        // (eager preview pass) once MLS is live. startHistorySync is idempotent for
        // the same active user; drainHistoryNow flushes any unsynced local rows. The
        // eager DOWN-restore is lease-gated, and navigator.locks grants the lease
        // ASYNCHRONOUSLY — so it must run from the lease-acquired continuation, not
        // synchronously here (where the lease is not yet held). startHistorySync
        // invokes the callback exactly when this tab holds the lease.
        if (currentUserId) {
          const uid = currentUserId;
          startHistorySync(uid, () => {
            void runEagerPreviewRestore(uid);
            // Move-to-Private: finish any rotation interrupted by a crash/close.
            // Lease-gated (this callback fires only on the lease-holding tab).
            void dmKeyManager.resumePendingRotation(uid);
          });
          drainHistoryNow();
        }
        // An mls DM left open across unlock must establish once MLS is
        // ready (the DM-load effect is keyed on the active channel, not readiness).
        const activeId = useNavigationStore.getState().activeDmChannelId;
        if (activeId) {
          const activeDm = useDmStore.getState().dmChannels.find((ch) => ch.id === activeId);
          maybeEstablishActiveMlsChannel(activeId, activeDm);
        }
      }
    });
    const offApplyFailed = mlsCoordinator.onApplyFailed((e) => {
      useUiStore.getState().markChannelNeedsResync(e.dmChannelId);
    });
    // Self-heal: a later good commit advances the epoch -> clear the resync hint.
    const offEpochClear = mlsCoordinator.onEpochChange((e) => {
      useUiStore.getState().clearChannelResync(e.dmChannelId);
    });
    // A channel that becomes ready (create/join/Welcome succeeded) clears any
    // peer-unprovisioned failure recorded for it.
    const offReadyClear = mlsCoordinator.onReadyChannel((dmChannelId) => {
      useUiStore.getState().clearEstablishFailure(dmChannelId);
    });
    // A restored archive can change a DM's last-message preview. Refresh
    // the DM list (re-decrypting previews from the now-populated local history)
    // when history is restored, debounced so the eager bulk pass + a burst of
    // per-channel restores collapse into a single fetch.
    let previewTimer: ReturnType<typeof setTimeout> | null = null;
    const offHistoryPreviews = mlsCoordinator.onHistoryRestored(() => {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        apiClient.getDMs().then((list) => processDmListRef.current?.(list)).catch(() => {});
      }, 300);
    });
    return () => {
      offLegacy(); offSearchLock(); offMls(); offApplyFailed(); offEpochClear(); offReadyClear(); offHistoryPreviews();
      if (previewTimer) clearTimeout(previewTimer);
    };
  }, [currentUserId]);


  // Join channel rooms for ALL servers to receive new-message events
  const joinedAllChannelsRef = useRef<Set<string>>(new Set());
  const allChannelIds = useServerStore(useShallow(s => {
    const ids: string[] = [];
    for (const sv of s.servers) {
      if (sv.channels) for (const ch of sv.channels) ids.push(ch.id);
    }
    return ids;
  }));
  const allChannelIdKey = useMemo(() => allChannelIds.join(','), [allChannelIds]);
  useEffect(() => {
    if (!currentUserId) return;
    const srvs = useServerStore.getState().servers;
    const allChannelIds = new Set<string>();
    for (const s of srvs) {
      if (s.channels) {
        for (const ch of s.channels) {
          allChannelIds.add(ch.id);
        }
      }
    }

    // Track membership in the ref (so the cleanup block below and the
    // return-unmount cleanup still work), but don't emit `join-channel`.
    // The backend's connection-time auto-subscribe joins every visible text
    // channel room on each (re)connect; mid-session channel creation calls
    // `socketsJoin` from routes/servers.ts. Emitting here would burn the
    // 30/10s socket rate-limit counter with no added effect and was the
    // primary cause of post-login "Rate limited" errors for users in many
    // servers.
    for (const id of allChannelIds) {
      if (!joinedAllChannelsRef.current.has(id)) {
        joinedAllChannelsRef.current.add(id);
      }
    }

    for (const id of joinedAllChannelsRef.current) {
      if (!allChannelIds.has(id)) {
        socketService.leaveChannel(id);
        joinedAllChannelsRef.current.delete(id);
      }
    }

    return () => {
      for (const id of joinedAllChannelsRef.current) {
        socketService.leaveChannel(id);
      }
      joinedAllChannelsRef.current.clear();
    };
  }, [currentUserId, allChannelIdKey]);

  // Track active channel for message loading
  useEffect(() => {
    if (!currentUserId) return;
    const server = useServerStore.getState().servers.find((s) => s.id === activeServerId);
    const channel = server?.channels.find((c) => c.id === activeChannelId);
    if (!channel || channel.type !== 'text') return;
    prevChannelRef.current = activeChannelId;
  }, [activeChannelId, activeServerId, currentUserId]);

  // Load messages for active text channel
  useEffect(() => {
    if (!currentUserId) return;
    if (!activeChannelId) return;
    const server = useServerStore.getState().servers.find((s) => s.id === activeServerId);
    const channel = server?.channels.find((c) => c.id === activeChannelId);
    if (!channel || channel.type !== 'text') return;

    channelAccessOrder.current = channelAccessOrder.current.filter((id) => id !== activeChannelId);
    channelAccessOrder.current.push(activeChannelId);

    const lastFetch = channelFetchTimestamps.current[activeChannelId];
    // Previously also required `hasCached = messages.length > 0` to skip, but
    // a single socket-delivered message would trip the cache check before the
    // REST fetch ever ran, permanently marking the channel "cached" and
    // skipping subsequent fetches — channels stuck until hard-refresh. Trust
    // the fetch timestamp alone.
    if (lastFetch && Date.now() - lastFetch < 60_000) return;

    useAppStore.getState().setChannelLoadError(null);
    apiClient
      .getChannelMessages(activeChannelId)
      .then(({ messages: msgs, hasMore, pinnedMessageIds: pinIds, lastReadAt }) => { deferStoreUpdate(() => {
        useAppStore.getState().setChannelLoadError(null);
        channelFetchTimestamps.current[activeChannelId] = Date.now();
        useMessageStore.getState().setChannelMessages(activeChannelId, capMessages(msgs), hasMore);
        while (channelAccessOrder.current.length > MAX_CACHED_CHANNELS) {
          const evicted = channelAccessOrder.current.shift()!;
          if (evicted !== activeChannelId) {
            delete channelFetchTimestamps.current[evicted];
          }
        }
        useMessageStore.getState().evictStaleChannels(activeChannelId);
        useMessageStore.getState().setChannelPinnedIds(activeChannelId, pinIds ?? []);
        if (lastReadAt) {
          useNotificationStore.getState().setChannelLastReadAt(activeChannelId, lastReadAt);
        }
      }); })
      .catch((err) => {
        console.error('Failed to load channel messages:', err);
        useAppStore.getState().setChannelLoadError(err instanceof Error ? err.message : 'Failed to load messages');
      });
  }, [activeChannelId, activeServerId, currentUserId, serverIdKey]);

  // When in voice channel, preload messages for the selected quick-text channel
  useEffect(() => {
    if (!currentUserId || !connectedVoiceChannelId) return;
    const server = useServerStore.getState().servers.find((s) => s.id === activeServerId);
    const textChannels = server?.channels.filter((c) => c.type === 'text') ?? [];
    const firstText = textChannels[0];
    const channelId = selectedQuickTextChannelId && textChannels.some((c) => c.id === selectedQuickTextChannelId)
      ? selectedQuickTextChannelId
      : firstText?.id;
    if (!channelId) return;
    apiClient
      .getChannelMessages(channelId)
      .then(({ messages: msgs, hasMore }) => {
        deferStoreUpdate(() => useMessageStore.getState().setChannelMessages(channelId, capMessages(msgs), hasMore));
      })
      .catch(() => {});
  }, [currentUserId, connectedVoiceChannelId, activeServerId, selectedQuickTextChannelId]);

  const playActionSound = useCallback((type: 'mute' | 'unmute' | 'deafen' | 'undeafen' | 'connect' | 'disconnect' | 'userJoined' | 'userLeft') => {
    if (streamerSettings.enabled && streamerSettings.disableSounds) return;
    try {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.connect(ctx.destination);
      let lastEnd = 0;
      const note = (freq: number, start: number, dur: number, vol: number) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.frequency.value = freq;
        g.gain.setValueAtTime(vol, ctx.currentTime + start);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
        osc.connect(g).connect(master);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + dur);
        lastEnd = Math.max(lastEnd, start + dur);
      };
      switch (type) {
        case 'mute':    note(600, 0, 0.08, 0.25); note(400, 0.07, 0.10, 0.20); break;
        case 'unmute':  note(400, 0, 0.08, 0.25); note(700, 0.07, 0.10, 0.20); break;
        case 'deafen':  note(500, 0, 0.08, 0.28); note(350, 0.07, 0.08, 0.24); note(200, 0.14, 0.12, 0.20); break;
        case 'undeafen': note(350, 0, 0.08, 0.28); note(550, 0.07, 0.08, 0.24); note(800, 0.14, 0.12, 0.20); break;
        case 'connect':    note(330, 0, 0.08, 0.22); note(440, 0.08, 0.08, 0.25); note(660, 0.16, 0.12, 0.28); break;
        case 'disconnect': note(550, 0, 0.08, 0.22); note(400, 0.08, 0.10, 0.20); note(280, 0.16, 0.12, 0.15); break;
        case 'userJoined': note(800, 0, 0.06, 0.18); note(1000, 0.05, 0.08, 0.15); break;
        case 'userLeft':   note(600, 0, 0.06, 0.15); note(400, 0.05, 0.08, 0.12); break;
      }
      setTimeout(() => ctx.close().catch(() => {}), (lastEnd + 0.1) * 1000);
    } catch { /* no audio */ }
  }, [streamerSettings.enabled, streamerSettings.disableSounds]);

  const voiceSettingsRef = useRef(voiceSettings);
  voiceSettingsRef.current = voiceSettings;
  const playActionSoundRef = useRef(playActionSound);
  playActionSoundRef.current = playActionSound;

  // Sync streamer sound setting
  useEffect(() => {
    streamerSoundsDisabled.current = streamerSettings.enabled && streamerSettings.disableSounds;
  }, [streamerSettings.enabled, streamerSettings.disableSounds]);

  // Warm the screen-share codec capability cache once, fire-and-forget. Probes
  // the GPU for hardware AV1/VP9 encode so resolveScreenShareCodec('auto') has
  // an answer ready by the time the user starts sharing. ~50–200ms one-time.
  useEffect(() => {
    detectBestScreenShareCodec().catch(() => {});
  }, []);

  // Sync notification sound preferences
  useEffect(() => {
    if (!currentUser) return;
    const syncPrefs = () => {
      apiClient.getPreferences().then((p) => {
        soundNewMessageEnabled.current = p.notifySoundNewMessage;
        soundCurrentChannelEnabled.current = p.notifySoundCurrentChannel;
        allSoundsDisabled.current = p.notifyDisableAllSounds;
        unreadBadgeEnabled.current = p.notifyUnreadBadge;
        taskbarFlashEnabled.current = p.notifyTaskbarFlash;
        desktopNotificationsEnabled.current = p.notifyDesktop;
        incomingRingEnabled.current = p.notifySoundIncomingRing;
      }).catch(() => {});
    };
    syncPrefs();
    const onPrefsChange = () => syncPrefs();
    window.addEventListener('howl-prefs-change', onPrefsChange);
    return () => window.removeEventListener('howl-prefs-change', onPrefsChange);
  }, [currentUser?.id]);

  const toggleMute = useCallback(() => {
    if (serverMuted) return;
    useVoiceStore.getState().setIsMuted(prev => {
      const next = !prev;
      if (next) {
        if (voiceSettings.soundMute) playActionSound('mute');
      } else {
        if (isDeafened && !serverDeafened) {
          useVoiceStore.getState().setIsDeafened(false);
          if (voiceSettings.soundUndeafen) playActionSound('undeafen');
        } else {
          if (voiceSettings.soundUnmute) playActionSound('unmute');
        }
      }
      return next;
    });
  }, [serverMuted, serverDeafened, isDeafened, voiceSettings.soundMute, voiceSettings.soundUnmute, voiceSettings.soundUndeafen, playActionSound]);

  const mutedBeforeDeafenRef = useRef<boolean>(false);
  const toggleDeafen = useCallback(() => {
    if (serverDeafened) return;
    useVoiceStore.getState().setIsDeafened(prev => {
      const newState = !prev;
      if (newState) {
        if (voiceSettings.soundDeafen) playActionSound('deafen');
        mutedBeforeDeafenRef.current = isMuted;
        useVoiceStore.getState().setIsMuted(true);
      } else {
        if (voiceSettings.soundUndeafen) playActionSound('undeafen');
        useVoiceStore.getState().setIsMuted(mutedBeforeDeafenRef.current);
      }
      return newState;
    });
  }, [serverDeafened, isMuted, voiceSettings.soundDeafen, voiceSettings.soundUndeafen, playActionSound]);

  // Broadcast mute/deafen state
  useEffect(() => {
    if (connectedVoiceChannelId) {
      socketService.sendVoiceStateUpdate(connectedVoiceChannelId, isMuted, isDeafened);
    } else if (activeDmCallChannelId) {
      socketService.sendDmCallStateUpdate(activeDmCallChannelId, isMuted, isDeafened);
    }
  }, [isMuted, isDeafened, connectedVoiceChannelId, activeDmCallChannelId]);

  useVoiceControlSocketEvents({ connectedVoiceChannelId, activeDmCallChannelId, voiceChannelIdRef, servers: useServerStore.getState().servers, setActiveDmCallChannelId, setDmCallWithVideo, setDmCallDeclinedUserIds, showGlobalToast: showGlobalToast as any });

  // Global keybinds
  const disconnectFromVoice = useCallback(() => {
    if (connectedVoiceChannelId) {
      socketService.leaveVoiceChannel(connectedVoiceChannelId);
      voiceChannelIdRef.current = null;
      useVoiceStore.getState().setConnectedVoiceChannelId(null);
      useVoiceStore.getState().setVoiceChannelParticipants([]);
      useVoiceStore.getState().setServerMuted(false);
      useVoiceStore.getState().setServerDeafened(false);
      // Clean up unified video effect pipeline (worker + autoframe + color grade + background) + raw device track
      effectCleanupRef.current?.();
      effectCleanupRef.current = null;
      pipelineRef.current = null;
      import('./services/call/autoFrameProcessor').then(m => m.destroyDetector()).catch(() => {});
      const cam = useVoiceStore.getState().cameraStream;
      if (cam) {
        cam.getTracks().forEach(t => t.stop());
        useVoiceStore.getState().setCameraStream(null);
        useVoiceStore.getState().setIsCameraOn(false);
      }
      // Also stop the raw device track — when effects are active, `cam` is a
      // canvas output and the OS camera stays lit until the raw track ends.
      rawCameraStreamRef.current?.getTracks().forEach(t => t.stop());
      rawCameraStreamRef.current = null;
      const scr = useVoiceStore.getState().screenStream;
      if (scr) {
        scr.getTracks().forEach(t => t.stop());
        useVoiceStore.getState().setScreenStream(null);
        useVoiceStore.getState().setIsScreenSharing(false);
      }
    }
  }, [connectedVoiceChannelId]);

  const onAcceptIncomingDmCall = useCallback((joinWithVideo: boolean) => {
    if (!incomingDmCall) return;
    const call = incomingDmCall;
    const accept = () => {
      leaveOtherActiveCalls('dm');
      useVoiceStore.getState().setDmCallIsInitiator(false);
      useVoiceStore.getState().setDmCallIncomingMlsReady(call.mlsCallReady);
      setActiveDmCallChannelId(call.dmChannelId);
      setDmCallWithVideo(joinWithVideo);
      navigate(`/channels/@me/${call.dmChannelId}`);
      setIncomingDmCall(null);
    };
    if (!ensureE2eUnlockedForCall(accept)) return;
    accept();
  }, [incomingDmCall, leaveOtherActiveCalls, setActiveDmCallChannelId, setDmCallWithVideo, navigate, setIncomingDmCall, ensureE2eUnlockedForCall]);

  const onDeclineIncomingDmCall = useCallback(() => {
    if (!incomingDmCall) return;
    socketService.declineDmCall(incomingDmCall.dmChannelId);
    declinedDmCallChannelIds.current.set(incomingDmCall.dmChannelId, Date.now());
    setIncomingDmCall(null);
  }, [incomingDmCall, setIncomingDmCall]);

  const toggleStreamerModeKb = useCallback(() => {
    updateStreamer({ enabled: !streamerSettings.enabled });
  }, [streamerSettings.enabled, updateStreamer]);

  const toggleVAD = useCallback(() => {
    updateVoice({ pushToTalk: !voiceSettings.pushToTalk });
  }, [voiceSettings.pushToTalk, updateVoice]);

  const startScreenShareWithQuality = useCallback(async (quality: ScreenShareQuality) => {
    useVoiceStore.getState().setShowScreenSharePicker(false);
    updateScreenShareQuality(quality);
    try {
      let stream: MediaStream;
      if (quality.sourceId && window.electron) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: quality.audio !== false ? { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: quality.sourceId } } as any : false,
          video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: quality.sourceId, ...(() => { const c = getVideoConstraintsForDisplay(quality); const v = c.video; return typeof v === 'object' ? { minWidth: (v as any).width?.ideal, minHeight: (v as any).height?.ideal, minFrameRate: (v as any).frameRate?.ideal > 30 ? 30 : undefined, maxFrameRate: (v as any).frameRate?.ideal } : {}; })() } } as any,
        });
      } else {
        const constraints = getVideoConstraintsForDisplay(quality);
        stream = await navigator.mediaDevices.getDisplayMedia(constraints);
      }
      useVoiceStore.getState().setScreenStream(stream);
      useVoiceStore.getState().setIsScreenSharing(true);
      stream.getVideoTracks()[0].onended = () => {
        useVoiceStore.getState().setIsScreenSharing(false);
        useVoiceStore.getState().setScreenStream(null);
      };
      window.focus();
      setTimeout(() => window.focus(), 200);
      setTimeout(() => window.focus(), 600);
    } catch (err) {
      console.error("Error sharing screen:", err);
    }
  }, [updateScreenShareQuality]);

  const toggleScreenShare = useCallback(() => {
    if (isScreenSharing) {
      screenStream?.getTracks().forEach(track => track.stop());
      useVoiceStore.getState().setScreenStream(null);
      useVoiceStore.getState().setIsScreenSharing(false);
    } else {
      // Always open the screen/source + quality picker when starting —
      // never start blind. Picker.onConfirm wires up startScreenShareWithQuality.
      useVoiceStore.getState().setShowScreenSharePicker(true);
    }
  }, [isScreenSharing, screenStream]);

  const openScreenShareSettings = useCallback(() => {
    useVoiceStore.getState().setShowScreenSharePicker(true);
  }, []);

  // Broadcast local screen-share state to the server so other members see the
  // "watch stream" icon next to the user in the sidebar voice list. Also
  // emits a cleanup `false` when disconnecting from voice so stale flags
  // don't stick around on the other server members' UIs.
  useEffect(() => {
    if (!connectedVoiceChannelId) return;
    socketService.sendVoiceSetScreenShare(connectedVoiceChannelId, !!isScreenSharing);
    return () => {
      socketService.sendVoiceSetScreenShare(connectedVoiceChannelId, false);
    };
  }, [connectedVoiceChannelId, isScreenSharing]);

  /**
   * Actually start the camera (acquire stream + apply auto-frame/color-grade
   * pre-publish processors). Pulled out of toggleCamera so the camera-preview
   * modal can call this directly on Confirm.
   */
  const voiceRemoteParticipantsRef = useRef<{ userId: string }[]>([]);
  // Raw getUserMedia stream lives in its own ref so the OS camera device is
  // released even when the voice store's `cameraStream` points at a processed
  // canvas/background-effect track. The autoframe/colorGrade processors null
  // out their sourceTrack ref on cleanup() but do NOT call .stop() — by design,
  // the caller owns the raw stream lifecycle. Without this ref, toggling the
  // camera off while effects are active left the OS camera indicator on.
  const rawCameraStreamRef = useRef<MediaStream | null>(null);
  const effectCleanupRef = useRef<(() => void) | null>(null);
  const pipelineRef = useRef<import('./services/call/CameraPipeline').CameraPipelineHandle | null>(null);
  const enableCamera = useCallback(async () => {
    try {
      const peerCount = voiceRemoteParticipantsRef.current.length || 1;
      const perks = getPlanPerks((currentUser?.stripePlan as PlanTier) ?? null);
      const constraints = getVideoConstraintsForCamera(peerCount, perks.maxCameraRes, perks.maxCameraBitrate, perks.maxCameraFps);
      const cameraId = voiceSettingsRef.current.selectedCameraId;
      if (cameraId && typeof constraints.video === 'object') {
        (constraints.video as MediaTrackConstraints).deviceId = { exact: cameraId };
      }
      // Release any previous raw in case enableCamera is entered twice without
      // a toggle-off in between (defensive — should not normally happen).
      effectCleanupRef.current?.();
      effectCleanupRef.current = null;
      pipelineRef.current = null;
      rawCameraStreamRef.current?.getTracks().forEach((t) => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      rawCameraStreamRef.current = stream;

      // Apply the full effect pipeline (autoframe, color grade, background
      // blur / virtual background) via CameraPipeline. The pipeline handle
      // exposes live-update methods so mid-call effect changes (blur radius,
      // background image, autoframe toggle, zoom, color grade) take effect
      // immediately without rebuilding the stream.
      const vs = voiceSettingsRef.current;
      const { buildProcessedCameraStream } = await import('./services/call/buildProcessedCameraStream');
      const { stream: finalStream, cleanup, pipeline } = await buildProcessedCameraStream(stream, {
        autoFrameMode: vs.autoFrameMode,
        autoFrameZoom: vs.autoFrameZoom,
        autoFrameZoomAuto: vs.autoFrameZoomAuto,
        videoColorGradeEnabled: vs.videoColorGradeEnabled,
        videoColorGrade: vs.videoColorGrade,
        videoBackgroundMode: vs.videoBackgroundMode,
        videoBackgroundBlurRadius: vs.videoBackgroundBlurRadius,
        videoBackgroundImageUrl: vs.videoBackgroundImageUrl,
      });
      effectCleanupRef.current = cleanup;
      pipelineRef.current = pipeline;

      useVoiceStore.getState().setCameraStream(finalStream);
      useVoiceStore.getState().setIsCameraOn(true);
      window.focus();

      // Detect when the camera track ends unexpectedly (OS suspends camera,
      // device disconnect, another app grabs exclusive access, GPU process
      // crash, etc.). Without this, the video element silently shows a black
      // frame while isCameraOn stays true. Log + reset state so the UI
      // reflects reality and the user can re-toggle to recover.
      finalStream.getVideoTracks().forEach((track) => {
        const handleEnd = () => {
          console.warn('[camera] video track ended unexpectedly — cleaning up. readyState:', track.readyState);
          // Only react if state still says camera is on (avoid double-cleanup)
          if (useVoiceStore.getState().isCameraOn) {
            try { finalStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
            // Stop raw source track too — when effects wrap the camera, the
            // finalStream is a canvas output, not the actual device track.
            try { rawCameraStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
            rawCameraStreamRef.current = null;
            try { effectCleanupRef.current?.(); effectCleanupRef.current = null; } catch { /* ignore */ }
            pipelineRef.current = null;
            useVoiceStore.getState().setCameraStream(null);
            useVoiceStore.getState().setIsCameraOn(false);
            showGlobalToast('Camera stopped — device may have been disconnected or used by another app', 'warning');
          }
        };
        track.addEventListener('ended', handleEnd, { once: true });
        // Also watch for `mute` events (OS-level pause without ending the track).
        // { once: true } matches the `ended` listener: the mute event fires at most
        // once per track lifetime (OS suspend/disconnect) and the track is replaced
        // on the next camera toggle, so a persistent listener would leak.
        track.addEventListener('mute', () => {
          console.warn('[camera] video track muted by OS/browser. enabled:', track.enabled, 'muted:', track.muted);
        }, { once: true });
      });
    } catch (err) {
      console.error("Error accessing camera:", err);
      const msg = (err as Error)?.message ?? '';
      if (msg.includes('Permission') || msg.includes('NotAllowed')) {
        showGlobalToast(t('toast.cameraPermissionDenied'), 'warning');
      } else if (msg.includes('NotFound') || msg.includes('DevicesNotFound')) {
        showGlobalToast(t('toast.noCameraFound'), 'warning');
      } else {
        showGlobalToast(t('toast.cameraStartFailed'), 'warning');
      }
    }
  }, [currentUser?.stripePlan, showGlobalToast, t]);

  // Live-update video effects when settings change mid-call. The pipeline
  // handle mutates internal state — the processed track identity stays the
  // same, so LiveKit keeps publishing without replaceTrack.
  useEffect(() => {
    const p = pipelineRef.current;
    if (!p || !isCameraOn) return;
    p.updateAutoFrame(voiceSettings.autoFrameMode ?? 'off');
    p.updateZoom(voiceSettings.autoFrameZoom ?? 1, voiceSettings.autoFrameZoomAuto);
    p.updateColorGrade(
      !!voiceSettings.videoColorGradeEnabled,
      (voiceSettings.videoColorGrade ?? 'none') as import('./services/call/colorGradeProcessor').GradeId,
    );
    p.updateBackground(voiceSettings.videoBackgroundMode ?? 'off', {
      blurRadius: voiceSettings.videoBackgroundBlurRadius,
      imageUrl: voiceSettings.videoBackgroundImageUrl,
    });
  }, [
    isCameraOn,
    voiceSettings.autoFrameMode,
    voiceSettings.autoFrameZoom,
    voiceSettings.autoFrameZoomAuto,
    voiceSettings.videoColorGradeEnabled,
    voiceSettings.videoColorGrade,
    voiceSettings.videoBackgroundMode,
    voiceSettings.videoBackgroundBlurRadius,
    voiceSettings.videoBackgroundImageUrl,
  ]);

  const toggleCamera = useCallback(async () => {
    if (isCameraOn) {
      cameraStream?.getTracks().forEach(track => track.stop());
      // Stop raw source track — with autoframe/colorGrade/background effects,
      // cameraStream points at a canvas output and the underlying OS camera
      // device is only released by stopping the raw track here.
      rawCameraStreamRef.current?.getTracks().forEach(t => t.stop());
      rawCameraStreamRef.current = null;
      // Clean up the unified effect pipeline (worker + autoframe + color grade + background)
      effectCleanupRef.current?.();
      effectCleanupRef.current = null;
      pipelineRef.current = null;
      import('./services/call/autoFrameProcessor').then(m => m.destroyDetector()).catch(() => {});
      useVoiceStore.getState().setCameraStream(null);
      useVoiceStore.getState().setIsCameraOn(false);
    } else if (voiceSettings.cameraPreviewModal) {
      // Show preview modal first; user clicks "Turn On Camera" to confirm.
      useVoiceStore.getState().setShowCameraPreview(true);
    } else {
      await enableCamera();
    }
  }, [isCameraOn, cameraStream, voiceSettings.cameraPreviewModal, enableCamera]);

  const endCurrentCall = useCallback(() => {
    if (activeDmCallChannelId) {
      socketService.leaveDmCall(activeDmCallChannelId);
      setActiveDmCallChannelId(null);
    } else if (connectedVoiceChannelId) {
      disconnectFromVoice();
    }
  }, [activeDmCallChannelId, connectedVoiceChannelId, setActiveDmCallChannelId, disconnectFromVoice]);

  // Stream Deck: register action handlers + state.call provider
  // Re-registers whenever the underlying callbacks change so the controller
  // always invokes the latest closure. Teardown in initStreamDeckController's
  // cleanup nulls them out; we also null on unmount of this effect.
  useEffect(() => {
    setHangupHandler(() => endCurrentCall());
    setCallEndHandler(() => endCurrentCall());
    setCallAnswerHandler(() => {
      if (incomingDmCall) onAcceptIncomingDmCall(!!incomingDmCall.withVideo);
    });
    setCallDeclineHandler(() => {
      if (incomingDmCall) onDeclineIncomingDmCall();
    });
    setPTTHandler((phase) => {
      const inVoice = !!(connectedVoiceChannelId || activeDmCallChannelId || connectedStageChannelId);
      if (!voiceSettings.pushToTalk || !inVoice) return;
      useVoiceStore.getState().setIsMuted(phase === 'up');
    });
    setCallStateProvider(() => {
      const data: CallStateData = {
        incoming: !!incomingDmCall,
        active: !!activeDmCallChannelId,
        caller: incomingDmCall
          ? { userId: incomingDmCall.fromUserId, name: incomingDmCall.username, avatar: incomingDmCall.avatar }
          : null,
        startedAt: dmCallStartedAt,
      };
      return data;
    });
    // navigation handler — uses the same react-router navigate from useNavigate()
    setNavigateHandler((path) => { navigate(path); });
    // device switcher — enumerate devices at call time and cycle
    // to the next one, updating voiceSettings via SettingsContext.
    setDeviceSwitcherHandler((kind) => {
      void (async () => {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const inputs = devices.filter(d => d.kind === 'audioinput');
          const outputs = devices.filter(d => d.kind === 'audiooutput');

          if (kind === 'input' || kind === 'both') {
            const curIdx = inputs.findIndex(d => d.deviceId === voiceSettings.selectedMicId);
            const nextIdx = (curIdx + 1) % (inputs.length || 1);
            const nextDevice = inputs[nextIdx];
            if (nextDevice) updateVoice({ selectedMicId: nextDevice.deviceId });
          }
          if (kind === 'output' || kind === 'both') {
            const curIdx = outputs.findIndex(d => d.deviceId === voiceSettings.selectedSpeakerId);
            const nextIdx = (curIdx + 1) % (outputs.length || 1);
            const nextDevice = outputs[nextIdx];
            if (nextDevice) updateVoice({ selectedSpeakerId: nextDevice.deviceId });
          }
        } catch {
          // Device enumeration failed (permissions not granted, etc.)
        }
      })();
    });
    return () => {
      setHangupHandler(null);
      setCallEndHandler(null);
      setCallAnswerHandler(null);
      setCallDeclineHandler(null);
      setPTTHandler(null);
      setCallStateProvider(null);
      setNavigateHandler(null);
      setDeviceSwitcherHandler(null);
    };
  }, [
    endCurrentCall, onAcceptIncomingDmCall, onDeclineIncomingDmCall,
    incomingDmCall, activeDmCallChannelId, connectedVoiceChannelId,
    connectedStageChannelId, voiceSettings.pushToTalk, navigate,
    voiceSettings.selectedMicId, voiceSettings.selectedSpeakerId, updateVoice,
    dmCallStartedAt,
  ]);

  // Stream Deck: push state.call on change
  useEffect(() => {
    pushState('state.call', {
      incoming: !!incomingDmCall,
      active: !!activeDmCallChannelId,
      caller: incomingDmCall
        ? { userId: incomingDmCall.fromUserId, name: incomingDmCall.username, avatar: incomingDmCall.avatar }
        : null,
      startedAt: dmCallStartedAt,
    } satisfies CallStateData);
  }, [incomingDmCall, activeDmCallChannelId, dmCallStartedAt]);

  // Stream Deck: thread/stage/reaction handlers + E2EE provider
  useEffect(() => {
    // thread.start-from-focused: opens thread creation from focused channel's latest message
    setThreadStartHandler(async () => {
      const nav = useNavigationStore.getState();
      const chId = nav.activeChannelId;
      const srvId = nav.activeServerId;
      if (!chId || !srvId) return { code: 'no-focused-message' };
      const ms = useMessageStore.getState();
      const msgs = ms.messages[chId];
      const parentMsg = msgs && msgs.length > 0 ? msgs[msgs.length - 1] : null;
      if (!parentMsg) return { code: 'no-focused-message' };
      try {
        const { submitCreateThread } = await import('./utils/threadActions');
        await submitCreateThread(
          { name: `Thread from ${parentMsg.id.slice(0, 8)}`, parentMessageId: parentMsg.id, autoArchive: false, autoArchiveDuration: '1440' },
          srvId,
          chId,
        );
        const thread = useThreadPollStore.getState().activeThread;
        return thread ? { threadId: thread.id } : { code: 'action-failed' };
      } catch {
        return { code: 'action-failed' };
      }
    });

    // thread.lock-toggle: Thread locking is not yet implemented in Howl.
    // The Thread interface has no 'locked' field. Return not-implemented.
    setThreadLockHandler(null);

    // stage.start-end: toggles stage session on the connected stage channel
    setStageStartEndHandler(async () => {
      const v = useVoiceStore.getState();
      const stageChId = v.connectedStageChannelId;
      if (!stageChId) return { code: 'no-stage-channel' };
      const session = v.activeStageSessions[stageChId];
      const srvId = useNavigationStore.getState().activeServerId;
      if (!srvId) return { code: 'no-server' };
      if (session && !session.endedAt) {
        // End the stage
        await apiClient.endStage(stageChId, srvId);
      } else {
        // Start a new stage with defaults
        const { startStage } = await import('./utils/voiceActions');
        await startStage(stageChId, srvId, {
          maxSpeakers: 10,
          textChatEnabled: true,
          allowEmojis: true,
          allowStickers: true,
          allowGifs: true,
        }, navigate);
      }
    });

    // stage.remove-speaker: removes a speaker from the connected stage
    setStageRemoveSpeakerHandler(async (userId: string) => {
      const v = useVoiceStore.getState();
      const stageChId = v.connectedStageChannelId;
      if (!stageChId) return { code: 'no-stage-channel' };
      const srvId = useNavigationStore.getState().activeServerId;
      if (!srvId) return { code: 'no-server' };
      await apiClient.removeSpeaker(stageChId, srvId, userId);
    });

    // E2EE state provider: exposes vault-lock state without the controller
    // importing dmKeyManager (boundary safe). Reads from the lightweight
    // encryptionFlags + dmKeyManager.isUnlocked() available here in App.tsx.
    setE2eeStateProvider(
      (): E2eeStateData => {
        const vaultLocked = dmKeyManager.isSetup() && !dmKeyManager.isUnlocked();
        const lockedChannels: string[] = [];
        if (vaultLocked) {
          const dms = useDmStore.getState().dmChannels;
          for (const ch of dms) {
            if (isChannelEncrypted(ch.id)) lockedChannels.push(ch.id);
          }
        }
        return { unlocked: !vaultLocked, lockedChannels };
      },
      (channelId: string): boolean => {
        // Returns true if the channel is accessible (vault unlocked or channel not encrypted)
        if (!isChannelEncrypted(channelId)) return true;
        return dmKeyManager.isUnlocked();
      },
    );

    return () => {
      setThreadStartHandler(null);
      setThreadLockHandler(null);
      setStageStartEndHandler(null);
      setStageRemoveSpeakerHandler(null);
      setE2eeStateProvider(null);
    };
  }, [navigate]);

  const keybindActions = useMemo<KeybindActions>(() => ({
    toggleMute:        (phase) => { if (phase === 'down') toggleMute(); },
    toggleDeafen:      (phase) => { if (phase === 'down') toggleDeafen(); },
    toggleVAD:         (phase) => { if (phase === 'down') toggleVAD(); },
    toggleStreamerMode:(phase) => { if (phase === 'down') toggleStreamerModeKb(); },
    toggleCamera:      (phase) => { if (phase === 'down') toggleCamera(); },
    toggleScreenShare: (phase) => { if (phase === 'down') toggleScreenShare(); },
    disconnectFromVoice:(phase) => { if (phase === 'down') disconnectFromVoice(); },
    navigateBack:      (phase) => { if (phase === 'down') window.history.back(); },
    navigateForward:   (phase) => { if (phase === 'down') window.history.forward(); },
    goHome:            (phase) => { if (phase === 'down') navigate('/'); },
    openSettings:      (phase) => { if (phase === 'down') navigate('/settings'); },
    focusTextArea:     (phase) => {
      if (phase !== 'down') return;
      const el = document.querySelector('input[type="text"][aria-label], textarea') as HTMLElement | null;
      el?.focus();
    },
    toggleMembersPanel:(phase) => { if (phase === 'down') setMembersColumnOpen(!membersColumnOpen); },
    navigateServerUp:  (phase) => {
      if (phase !== 'down') return;
      const ids = serverIdListRef.current;
      const cur = ids.indexOf(activeServerId as string);
      if (cur > 0) navigate(`/channels/${ids[cur - 1]}`);
    },
    navigateServerDown:(phase) => {
      if (phase !== 'down') return;
      const ids = serverIdListRef.current;
      const cur = ids.indexOf(activeServerId as string);
      if (cur >= 0 && cur < ids.length - 1) navigate(`/channels/${ids[cur + 1]}`);
    },
    navigateChannelUp: (phase) => {
      if (phase !== 'down') return;
      const textChs = textChannelsRef.current;
      if (!textChs.length) return;
      const cur = textChs.findIndex(c => c.id === activeChannelId);
      if (cur > 0) navigate(`/channels/${activeServerId}/${textChs[cur - 1].id}`);
    },
    navigateChannelDown:(phase) => {
      if (phase !== 'down') return;
      const textChs = textChannelsRef.current;
      if (!textChs.length) return;
      const cur = textChs.findIndex(c => c.id === activeChannelId);
      if (cur >= 0 && cur < textChs.length - 1) navigate(`/channels/${activeServerId}/${textChs[cur + 1].id}`);
    },
    unassigned:        () => {},
    // Hold-actions — receive both phases.
    pushToTalk: (phase) => {
      const inVoice = !!connectedVoiceChannelId || !!activeDmCallChannelId || !!connectedStageChannelId;
      if (!voiceSettings.pushToTalk || !inVoice) return;
      useVoiceStore.getState().setIsMuted(phase === 'up');
    },
    pushToMute: (phase) => {
      const inVoice = !!connectedVoiceChannelId || !!activeDmCallChannelId || !!connectedStageChannelId;
      if (!inVoice) return;
      useVoiceStore.getState().setIsMuted(phase === 'down');
    },
    openSoundboard:     () => {},
    openSoundboardHold: () => {},
    // New call-control actions (Howl-specific extension beyond Discord parity)
    answerCall: (phase) => {
      if (phase !== 'down') return;
      if (!incomingDmCall) return;
      onAcceptIncomingDmCall(!!incomingDmCall.withVideo);
    },
    declineCall: (phase) => {
      if (phase !== 'down') return;
      if (!incomingDmCall) return;
      onDeclineIncomingDmCall();
    },
    endCall: (phase) => {
      if (phase !== 'down') return;
      endCurrentCall();
    },
  }), [
    toggleMute, toggleDeafen, toggleVAD, toggleStreamerModeKb, toggleCamera,
    toggleScreenShare, disconnectFromVoice, membersColumnOpen, setMembersColumnOpen,
    activeServerId, activeChannelId, navigate,
    connectedVoiceChannelId, activeDmCallChannelId, connectedStageChannelId,
    voiceSettings.pushToTalk,
    incomingDmCall, onAcceptIncomingDmCall, onDeclineIncomingDmCall, endCurrentCall,
  ]);

  // Start muted when PTT mode is first enabled while in voice — PTT keydown unmutes.
  useEffect(() => {
    if (!voiceSettings.pushToTalk) return;
    const inVoice = !!connectedVoiceChannelId || !!activeDmCallChannelId || !!connectedStageChannelId;
    if (!inVoice) return;
    useVoiceStore.getState().setIsMuted(true);
  }, [voiceSettings.pushToTalk, connectedVoiceChannelId, activeDmCallChannelId, connectedStageChannelId]);

  const DEFAULT_KEYBINDS: KeybindEntry[] = useMemo(() => [
    { id: '_vad', action: 'toggleVAD', keys: '', enabled: true },
    { id: '_home', action: 'goHome', keys: 'CTRL+ALT+H', enabled: true },
    { id: '_settings', action: 'openSettings', keys: 'CTRL+,', enabled: true },
    { id: '_srvUp', action: 'navigateServerUp', keys: 'CTRL+ALT+ARROWUP', enabled: true },
    { id: '_srvDn', action: 'navigateServerDown', keys: 'CTRL+ALT+ARROWDOWN', enabled: true },
    { id: '_chUp', action: 'navigateChannelUp', keys: 'ALT+ARROWUP', enabled: true },
    { id: '_chDn', action: 'navigateChannelDown', keys: 'ALT+ARROWDOWN', enabled: true },
    { id: '_focus', action: 'focusTextArea', keys: 'ESCAPE', enabled: true },
    { id: '_members', action: 'toggleMembersPanel', keys: 'CTRL+U', enabled: true },
  ], []);

  const mergedKeybinds = useMemo(() => {
    const userActions = new Set(keybinds.map(k => k.action));
    const defaults = DEFAULT_KEYBINDS.filter(d => !userActions.has(d.action));
    return [...keybinds, ...defaults];
  }, [keybinds, DEFAULT_KEYBINDS]);

  const keybindPageOpen = useNavigationStore(s => s.keybindPageOpen);

  // Push global-flagged bindings to the Electron main process so the native
  // hook matches them even when Howl is unfocused. No-op on web.
  useEffect(() => {
    const electron = (window as any).electron;
    if (!electron?.keybinds?.setBindings) return;
    if (!keybindsGlobalMasterEnabled) {
      electron.keybinds.shutdown();
      return;
    }
    const globals = mergedKeybinds
      .filter(k => k.enabled && k.global && k.keys)
      .map(k => ({
        actionId: k.action,
        combo: isLegacyCombo(k.keys) ? migrateLegacyCombo(k.keys) : k.keys,
      }));
    electron.keybinds.setBindings(globals);
  }, [mergedKeybinds, keybindsGlobalMasterEnabled]);

  useGlobalKeybinds(mergedKeybinds, keybindActions, !keybindPageOpen);

  // Display user (logged-in user + status) for components
  const displayUser = useMemo<User | null>(() => currentUser ? { ...currentUser, status: currentUserStatus } : null, [currentUser, currentUserStatus]);

  const activeServer = useServerStore(s => s.servers.find(sv => sv.id === activeServerId));
  const activeChannel = useMemo(() => activeServer?.channels.find(c => c.id === activeChannelId) || activeServer?.channels[0], [activeServer, activeChannelId]);

  // Keep refs in sync so socket callbacks always see current server/channel
  useEffect(() => {
    activeServerIdRef.current = activeServerId;
    activeChannelIdRef.current = activeChannelId;
    activeServerRef.current = activeServer;
  }, [activeServerId, activeChannelId, activeServer]);

  const showVoiceView = useMemo(() => activeChannel?.type === 'voice', [activeChannel?.type]);
  const _showStageView = useMemo(() => activeChannel?.type === 'stage', [activeChannel?.type]);
  const _showForumView = useMemo(() => activeChannel?.type === 'forum', [activeChannel?.type]);

  // Mobile swipe-to-open drawers
  const isServerView = isRealServerId(activeServerId);
  const canSwipeMembers = isServerView && !showVoiceView && !!activeChannelId;

  const serverDrawerPanelRef = useRef<HTMLDivElement>(null);
  const serverBackdropRef = useRef<HTMLDivElement>(null);
  const DRAWER_WIDTH = 280;

  const serverDrawerSwipe = useSwipeGesture({
    direction: 'right',
    threshold: DRAWER_WIDTH * 0.3,
    velocityThreshold: 0.5,
    edgeThreshold: 30,
    enabled: isMobile && !mobileServerDrawerOpen && isServerView,
    onDrag: (dx) => {
      const clamped = Math.max(0, Math.min(dx, DRAWER_WIDTH));
      const pct = clamped / DRAWER_WIDTH;
      if (serverDrawerPanelRef.current) {
        serverDrawerPanelRef.current.style.transition = 'none';
        serverDrawerPanelRef.current.style.transform = `translateX(${-DRAWER_WIDTH + clamped}px)`;
      }
      if (serverBackdropRef.current) {
        serverBackdropRef.current.style.transition = 'none';
        serverBackdropRef.current.style.opacity = String(pct * 0.6);
        serverBackdropRef.current.parentElement!.style.visibility = 'visible';
      }
    },
    onSwipe: () => {
      if (serverDrawerPanelRef.current) serverDrawerPanelRef.current.style.transition = '';
      if (serverBackdropRef.current) serverBackdropRef.current.style.transition = '';
      useNavigationStore.getState().setMobileServerDrawerOpen(true);
    },
    onCancel: () => {
      if (serverDrawerPanelRef.current) {
        serverDrawerPanelRef.current.style.transition = '';
        serverDrawerPanelRef.current.style.transform = '';
      }
      if (serverBackdropRef.current) {
        serverBackdropRef.current.style.transition = '';
        serverBackdropRef.current.style.opacity = '';
        serverBackdropRef.current.parentElement!.style.visibility = '';
      }
    },
  });

  const membersDrawerRef = useRef<HTMLDivElement>(null);
  const membersBackdropRef = useRef<HTMLDivElement>(null);
  const MEMBERS_WIDTH = 288;

  const membersSwipe = useSwipeGesture({
    direction: 'left',
    threshold: MEMBERS_WIDTH * 0.3,
    velocityThreshold: 0.5,
    edgeThreshold: 30,
    enabled: isMobile && !mobileMembersOpen && canSwipeMembers,
    onDrag: (dx) => {
      const clamped = Math.max(-MEMBERS_WIDTH, Math.min(0, dx));
      const pct = Math.abs(clamped) / MEMBERS_WIDTH;
      if (membersDrawerRef.current) {
        membersDrawerRef.current.style.transition = 'none';
        membersDrawerRef.current.style.transform = `translateX(${MEMBERS_WIDTH + clamped}px)`;
      }
      if (membersBackdropRef.current) {
        membersBackdropRef.current.style.transition = 'none';
        membersBackdropRef.current.style.opacity = String(pct * 0.6);
        membersBackdropRef.current.parentElement!.style.visibility = 'visible';
      }
    },
    onSwipe: () => {
      if (membersDrawerRef.current) membersDrawerRef.current.style.transition = '';
      if (membersBackdropRef.current) membersBackdropRef.current.style.transition = '';
      setMobileMembersOpen(true);
    },
    onCancel: () => {
      if (membersDrawerRef.current) {
        membersDrawerRef.current.style.transition = '';
        membersDrawerRef.current.style.transform = '';
      }
      if (membersBackdropRef.current) {
        membersBackdropRef.current.style.transition = '';
        membersBackdropRef.current.style.opacity = '';
        membersBackdropRef.current.parentElement!.style.visibility = '';
      }
    },
  });

  const contentSwipeHandlers = isMobile ? {
    onTouchStart: (e: React.TouchEvent) => {
      serverDrawerSwipe.bind.onTouchStart(e);
      membersSwipe.bind.onTouchStart(e);
    },
    onTouchMove: (e: React.TouchEvent) => {
      serverDrawerSwipe.bind.onTouchMove(e);
      membersSwipe.bind.onTouchMove(e);
    },
    onTouchEnd: (e: React.TouchEvent) => {
      serverDrawerSwipe.bind.onTouchEnd(e);
      membersSwipe.bind.onTouchEnd(e);
    },
  } : {};

  const voiceAudioConstraints = useMemo(() => ({
    noiseSuppression: voiceSettings.noiseSuppression !== 'none',
    echoCancellation: voiceSettings.echoCancellation,
    autoGainControl: voiceSettings.autoGainControl ?? true,
    opusBitrate: voiceSettings.opusBitrate,
    opusFec: voiceSettings.opusFec,
    opusDtx: voiceSettings.opusDtx,
    opusPacketLoss: voiceSettings.opusPacketLoss,
    opusSignal: voiceSettings.opusSignal,
    opusStereo: voiceSettings.opusStereo,
  }), [voiceSettings.noiseSuppression, voiceSettings.echoCancellation, voiceSettings.autoGainControl, voiceSettings.opusBitrate, voiceSettings.opusFec, voiceSettings.opusDtx, voiceSettings.opusPacketLoss, voiceSettings.opusSignal, voiceSettings.opusStereo]);

  // Settings for the engine-owned mic processing chain (HPF + compressor +
  // gate + gain). Passed in addition to voiceAudioConstraints — the latter
  // controls browser-level NS/AGC/EC at getUserMedia time, while this drives
  // our custom DSP that runs on top.
  const voiceAudioProcessing = useMemo(() => ({
    noiseSuppressionLevel: voiceSettings.noiseSuppression,
    autoInputSensitivity: voiceSettings.autoInputSensitivity,
    inputSensitivity: voiceSettings.inputSensitivity,
    noiseEngine: voiceSettings.noiseEngine,
  }), [voiceSettings.noiseSuppression, voiceSettings.autoInputSensitivity, voiceSettings.inputSensitivity, voiceSettings.noiseEngine]);

  const activeVoiceServer = connectedVoiceChannelId
    ? useServerStore.getState().servers.find((s: Server) => s.channels.some((c: Channel) => c.id === connectedVoiceChannelId))
    : undefined;
  const activeVoicePowerUpTier = (() => {
    const pc = activeVoiceServer?.powerUpCount ?? 0;
    return pc >= 14 ? 3 : pc >= 7 ? 2 : pc >= 2 ? 1 : 0;
  })();

  const screenShareBitrateForEngine = useMemo(() => {
    const perks = getPlanPerks((displayUser?.stripePlan ?? null) as PlanTier);
    return getScreenShareBitrate(screenShareQuality, perks.maxScreenShareBitrate);
  }, [screenShareQuality, displayUser?.stripePlan]);

  // Surface a non-blocking toast when the raw mic track ends unexpectedly
  // (USB unplug, OS permission revoked, BT out of range). Engine-initiated
  // stops (device switch, leave, teardown) do not fire this — the listener
  // is detached before the engine-initiated track.stop().
  const handleMicTrackEnded = useCallback(() => {
    showGlobalToast(
      t('toast.micDisconnected', 'Microphone disconnected — check your input device.'),
      'warning',
      8000,
    );
  }, [showGlobalToast, t]);

  // Surface an actionable hint when the engine detects sustained voice
  // activity while the user is self-muted. Throttled at the engine layer
  // (~once per 30s); the toast itself auto-dismisses after 6s. Tapping the
  // action toggles self-mute off via the existing voiceStore setter.
  const handleSpeakingWhileMuted = useCallback(() => {
    showGlobalToast(
      t('toast.speakingWhileMuted', "You're muted. Did you mean to talk?"),
      'info',
      6000,
      {
        actionLabel: t('toast.unmute', 'Unmute'),
        onAction: () => useVoiceStore.getState().setIsMuted(false),
      },
    );
  }, [showGlobalToast, t]);

  // Mic silence tracking — piped into voiceStore so call views can read it
  // without prop drilling. The active engine's callback updates the store;
  // the inactive one never fires.
  const handleVoiceSilenceUpdate = useCallback((ms: number) => {
    useVoiceStore.getState().setVoiceSilenceMs(ms);
  }, []);
  const handleDmSilenceUpdate = useCallback((ms: number) => {
    useVoiceStore.getState().setDmSilenceMs(ms);
  }, []);

  const { localStream: voiceLocalStream, remoteParticipants: voiceRemoteParticipants, error: voiceError, disconnectedByInactivity: voiceInactivityDisconnect, enableRemoteScreen: voiceEnableRemoteScreen, disableRemoteScreen: voiceDisableRemoteScreen, setE2eeKey: voiceSetE2eeKey, switchMicDevice: voiceSwitchMicDevice, serverRegion: voiceServerRegion, isE2ee: voiceIsE2ee, isE2eeFailed: voiceIsE2eeFailed } = useVoiceChannel(
    connectedVoiceChannelId,
    displayUser ?? null,
    isMuted,
    cameraStream,
    screenStream,
    voiceSettings.selectedMicId || undefined,
    voiceAudioConstraints,
    activeVoicePowerUpTier,
    displayUser?.stripePlan,
    voiceSettings.screenShareCodec ?? 'auto',
    screenShareQuality.fps,
    screenShareBitrateForEngine,
    voiceSettings.selectedSpeakerId || undefined,
    voiceSettings.speakerVolume ?? 100,
    voiceSettings.micVolume ?? 100,
    screenShareQuality.resolution,
    voiceAudioProcessing,
    btDevicePreferences,
    bluetoothAudioSettings,
    publishBtQualityStatus,
    handleMicTrackEnded,
    handleSpeakingWhileMuted,
    handleVoiceSilenceUpdate,
  );

  useVoiceE2ee(connectedVoiceChannelId, currentUser?.id ?? null, voiceSetE2eeKey);
  useStreamAttenuation(voiceSettings.streamAttenuation ?? true, voiceSettings.streamAttenuationStrength ?? 50, !!connectedVoiceChannelId);

  // Keep voiceRemoteParticipantsRef in sync so enableCamera (declared earlier) can
  // read peerCount without creating a use-before-declaration TS error.
  useEffect(() => {
    voiceRemoteParticipantsRef.current = voiceRemoteParticipants;
  }, [voiceRemoteParticipants]);

  // Mirror the local microphone stream into voiceStore so the side-panel
  // speaking indicator can pick up the current user's own speaking state
  // (the per-participant bridge only carries *remote* streams).
  useEffect(() => {
    useVoiceStore.getState().setLocalVoiceStream(voiceLocalStream ?? null);
    return () => { useVoiceStore.getState().setLocalVoiceStream(null); };
  }, [voiceLocalStream]);

  // Stage LiveKit connection
  const connectedStageSession = connectedStageChannelId ? activeStageSessions[connectedStageChannelId] : undefined;
  const isCurrentUserStageSpeaker = useMemo(() => connectedStageSession?.speakers.some(s => s.userId === (currentUser?.id ?? '')) ?? false, [connectedStageSession?.speakers, currentUser?.id]);
  const { localStream: stageLocalStream, remoteParticipants: stageRemoteParticipants, error: stageError, disconnectedByInactivity: stageDisconnectedByInactivity, enableRemoteScreen: stageEnableRemoteScreen, disableRemoteScreen: stageDisableRemoteScreen, setE2eeKey: stageSetE2eeKey, switchMicDevice: stageSwitchMicDevice, serverRegion: stageServerRegion, isE2ee: stageIsE2ee, isE2eeFailed: stageIsE2eeFailed } = useStageRoom(
    connectedStageChannelId,
    displayUser ?? null,
    isCurrentUserStageSpeaker,
    isMuted,
    cameraStream,
    screenStream,
    voiceSettings.selectedMicId || undefined,
    voiceAudioConstraints,
    activeVoicePowerUpTier,
    displayUser?.stripePlan,
    voiceSettings.screenShareCodec ?? 'auto',
    screenShareQuality.fps,
    screenShareBitrateForEngine,
    voiceSettings.selectedSpeakerId || undefined,
    voiceSettings.speakerVolume ?? 100,
    voiceSettings.micVolume ?? 100,
    screenShareQuality.resolution,
    voiceAudioProcessing,
    btDevicePreferences,
    bluetoothAudioSettings,
    publishBtQualityStatus,
  );

  useStageE2ee(connectedStageChannelId, currentUser?.id ?? null, connectedStageSession?.startedById ?? null, stageSetE2eeKey);

  // DM call LiveKit connection — lifted to App level (matching voice/stage pattern)
  const dmCameraStream = useVoiceStore(s => s.dmCameraStream);
  const dmScreenStream = useVoiceStore(s => s.dmScreenStream);
  const dmCallIsInitiator = useVoiceStore(s => s.dmCallIsInitiator);
  const dmCallIncomingMlsReady = useVoiceStore(s => s.dmCallIncomingMlsReady);

  const { localStream: dmLocalStream, remoteParticipants: dmRemoteParticipants, error: dmError, disconnectedByInactivity: dmDisconnectedByInactivity, enableRemoteScreen: dmEnableRemoteScreen, disableRemoteScreen: dmDisableRemoteScreen, switchMicDevice: dmSwitchMicDevice, leave: dmLeave, isE2ee: dmIsE2ee, isE2eeFailed: dmIsE2eeFailed, isE2eeEstablishing: dmIsE2eeEstablishing, isE2eeBlocked: dmIsE2eeBlocked, callKeyMode: dmCallKeyMode, startedAt: dmStartedAt, getMicSilenceMs: _dmGetMicSilenceMs } = useDMCall(
    activeDmCallChannelId,
    displayUser ?? null,
    isMuted,
    dmCameraStream,
    dmScreenStream,
    voiceSettings.selectedMicId || undefined,
    voiceAudioConstraints,
    displayUser?.stripePlan,
    dmCallWithVideo,
    voiceSettings.screenShareCodec ?? 'auto',
    dmCallIsInitiator,
    screenShareQuality.fps,
    screenShareBitrateForEngine,
    voiceSettings.micVolume ?? 100,
    voiceAudioProcessing,
    btDevicePreferences,
    bluetoothAudioSettings,
    publishBtQualityStatus,
    handleMicTrackEnded,
    handleSpeakingWhileMuted,
    handleDmSilenceUpdate,
    dmCallIncomingMlsReady,
  );

  // Sync DM call participant IDs to App state so the ring/decline flow works
  useEffect(() => {
    setDmCallParticipantIds(dmRemoteParticipants.map(p => p.userId));
  }, [dmRemoteParticipants, setDmCallParticipantIds]);

  // Track userIds that have appeared in voiceRemoteParticipants at least once
  // during the current channel session. This lets the bridge below distinguish
  // "socket-only, still connecting to LiveKit" (never been in remote → keep)
  // from "disconnected, LiveKit dropped them before socket voice-user-left
  // arrived" (was in remote, now gone → don't re-merge). Without it, the
  // bridge would re-add a disconnected user with stream:null and VoiceChannel
  // would render them stuck on "Connecting…".
  const voiceSeenRemoteIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    voiceSeenRemoteIdsRef.current = new Set();
  }, [connectedVoiceChannelId]);

  // Bridge CallEngine remoteParticipants into voiceChannelParticipants
  useEffect(() => {
    if (!connectedVoiceChannelId || voiceRemoteParticipants.length === 0) return;
    for (const r of voiceRemoteParticipants) voiceSeenRemoteIdsRef.current.add(r.userId);
    useVoiceStore.getState().setVoiceChannelParticipants((prev) => {
      const prevMap = new Map(prev.map((p) => [p.userId, p]));
      const remoteMap = new Map(voiceRemoteParticipants.map((r) => [r.userId, r]));
      const merged: typeof prev = voiceRemoteParticipants.map((r) => {
        const existing = prevMap.get(r.userId);
        return {
          userId: r.userId,
          username: r.username || existing?.username || r.userId,
          nickname: r.nickname || existing?.nickname || undefined,
          avatar: r.avatar || existing?.avatar || undefined,
          banner: r.banner || existing?.banner || undefined,
          bannerPositionY: r.bannerPositionY ?? existing?.bannerPositionY ?? undefined,
          bannerZoom: r.bannerZoom ?? existing?.bannerZoom ?? undefined,
          nameColor: r.nameColor || existing?.nameColor || undefined,
          nameFont: r.nameFont || existing?.nameFont || undefined,
          nameEffect: r.nameEffect || existing?.nameEffect || undefined,
          avatarEffect: r.avatarEffect || existing?.avatarEffect || undefined,
          effectivePlan: r.effectivePlan || existing?.effectivePlan || undefined,
          roleColor: r.roleColor || existing?.roleColor || undefined,
          roleStyle: (r.roleStyle || existing?.roleStyle || undefined) as 'solid' | 'gradient' | 'holographic' | undefined,
          stream: r.stream,
          isMuted: r.isMuted,
          isDeafened: r.isDeafened,
          serverMuted: r.serverMuted,
          serverDeafened: r.serverDeafened,
        };
      });
      for (const p of prev) {
        if (remoteMap.has(p.userId)) continue;
        if (voiceSeenRemoteIdsRef.current.has(p.userId)) continue;
        merged.push(p);
      }
      return merged;
    });
  }, [voiceRemoteParticipants, connectedVoiceChannelId]);

  // Pause/resume remote screen watching
  const pausedScreensRef = useRef<Set<string>>(new Set());
  const prevShowVoiceViewRef = useRef(showVoiceView);
  useEffect(() => {
    const prev = prevShowVoiceViewRef.current;
    prevShowVoiceViewRef.current = showVoiceView;
    if (prev && !showVoiceView && connectedVoiceChannelId) {
      voiceRemoteParticipants.forEach((p) => {
        if (p.screenStream) {
          pausedScreensRef.current.add(p.userId);
          voiceDisableRemoteScreen?.(p.userId);
        }
      });
    } else if (!prev && showVoiceView && pausedScreensRef.current.size > 0) {
      pausedScreensRef.current.forEach((userId) => {
        voiceEnableRemoteScreen?.(userId);
      });
      pausedScreensRef.current.clear();
    }
  }, [showVoiceView, connectedVoiceChannelId, voiceRemoteParticipants, voiceDisableRemoteScreen, voiceEnableRemoteScreen]);

  // Play join/leave sounds when voice participants change
  const prevVoiceParticipantIdsRef = useRef<Set<string>>(new Set());
  const voiceJoinedRef = useRef(false);

  useEffect(() => {
    if (!connectedVoiceChannelId) {
      prevVoiceParticipantIdsRef.current = new Set();
      voiceJoinedRef.current = false;
      return;
    }

    const currentIds = new Set(voiceRemoteParticipants.map(p => p.userId));
    const prevIds = prevVoiceParticipantIdsRef.current;

    if (!voiceJoinedRef.current) {
      if (currentIds.size > 0 || prevIds.size > 0) {
        voiceJoinedRef.current = true;
      }
      prevVoiceParticipantIdsRef.current = currentIds;
      return;
    }

    let played = false;
    for (const id of currentIds) {
      if (!prevIds.has(id)) {
        if (voiceSettingsRef.current.soundConnect) {
          playActionSoundRef.current('userJoined');
        }
        played = true;
        break;
      }
    }

    if (!played) {
      for (const id of prevIds) {
        if (!currentIds.has(id)) {
          if (voiceSettingsRef.current.soundDisconnect) {
            playActionSoundRef.current('userLeft');
          }
          break;
        }
      }
    }

    prevVoiceParticipantIdsRef.current = currentIds;
  }, [voiceRemoteParticipants, connectedVoiceChannelId]);

  useEffect(() => {
    if (voiceInactivityDisconnect && connectedVoiceChannelId) {
      try { sessionStorage.removeItem('howl_voice_channel'); } catch (err) { console.error('Failed to clear voice channel session', err); }
      useVoiceStore.getState().setConnectedVoiceChannelId(null);
      useVoiceStore.getState().setVoiceChannelParticipants([]);
      useVoiceStore.getState().setServerMuted(false);
      useVoiceStore.getState().setServerDeafened(false);
      if (isCameraOn) toggleCamera();
      if (isScreenSharing) toggleScreenShare();
      const firstText = activeServer?.channels.find((c) => c.type === 'text');
      const fallback = activeServer?.channels[0];
      const targetCh = firstText ?? fallback;
      if (targetCh && activeServer) navigate(`/channels/${activeServer.id}/${targetCh.id}`);
    }
  }, [voiceInactivityDisconnect]);

  const handleChannelSelect = useCallback((id: string) => {
    const server = useServerStore.getState().servers.find(s => s.id === activeServerId);
    const channel = server?.channels.find(c => c.id === id);
    if (channel?.type === 'voice') {
      const joinVoice = () => {
        leaveOtherActiveCalls('voice');
        useVoiceStore.getState().setConnectedVoiceChannelId(id);
        try {
          sessionStorage.setItem('howl_voice_channel', JSON.stringify({ serverId: activeServerId, channelId: id }));
        } catch (err) { console.error('Failed to store voice channel', err); }
      };
      if (!ensureE2eUnlockedForCall(joinVoice)) {
        // Unlock modal was shown; navigate into the channel anyway so the
        // user sees the voice view. After the modal closes with a successful
        // unlock, `joinVoice` is invoked automatically by the modal handler.
        navigate(`/channels/${activeServerId}/${id}`);
        return;
      }
      joinVoice();
    }
    useNavigationStore.getState().setCalendarActive(false);
    useCalendarStore.getState().setCalendarEvents([]);
    useCalendarStore.getState().setCalendarSelectedEvent(null);
    useCalendarStore.getState().setCalendarCreateModal({ open: false });
    navigate(`/channels/${activeServerId}/${id}`);
  }, [activeServerId, navigate]);

  const clearStoredVoiceChannel = useCallback(() => {
    try {
      sessionStorage.removeItem('howl_voice_channel');
    } catch (err) { console.error('Failed to clear voice channel session', err); }
  }, []);

  const e2eeFileMetaRef = useRef<Map<string, { key: string; name: string; type: string; size: number; thumbUrl?: string; thumbKey?: string; thumbWidth?: number; thumbHeight?: number }>>(new Map());

  const handleOpenFullProfile = useCallback((user: UserWithRole, serverId?: string, initialTab?: 'showcase' | 'activity' | 'friends' | 'servers') => {
    useUiStore.getState().setFullProfileTarget({ user, serverId, initialTab });
    useUiStore.getState().setUserProfileTarget(null);
    useUiStore.getState().setUserContextMenuTarget(null);
  }, []);

  // Calendar: fetch events when opened or month changes
  useEffect(() => {
    if (!calendarActive || !isRealServerId(activeServerId)) return;
    let cancelled = false;
    useCalendarStore.getState().setCalendarLoading(true);
    apiClient.getServerEvents(activeServerId, calendarMonth.month, calendarMonth.year)
      .then((events) => { if (!cancelled) deferStoreUpdate(() => useCalendarStore.getState().setCalendarEvents(events)); })
      .catch((err) => console.error('Failed to fetch calendar events', err))
      .finally(() => { if (!cancelled) useCalendarStore.getState().setCalendarLoading(false); });
    return () => { cancelled = true; };
  }, [calendarActive, activeServerId, calendarMonth.year, calendarMonth.month]);

  useCalendarSocketEvents({ activeServerId });

  // Stage connection persistence
  const STAGE_CHANNEL_KEY = 'howl_connected_stage_channel';
  useEffect(() => {
    try {
      if (connectedStageChannelId) localStorage.setItem(STAGE_CHANNEL_KEY, connectedStageChannelId);
      else localStorage.removeItem(STAGE_CHANNEL_KEY);
    } catch { /* localStorage unavailable */ }
  }, [connectedStageChannelId]);

  // Restore stage connection on mount
  const stageRestoreAttemptedRef = useRef(false);
  useEffect(() => {
    if (!currentUserId || stageRestoreAttemptedRef.current) return;
    const srvs = useServerStore.getState().servers;
    if (srvs.length === 0) return;
    stageRestoreAttemptedRef.current = true;
    try {
      const savedStageId = localStorage.getItem(STAGE_CHANNEL_KEY);
      if (!savedStageId) return;
      const serverId = srvs.flatMap(s => s.channels.map(c => ({ channelId: c.id, serverId: s.id }))).find(x => x.channelId === savedStageId)?.serverId;
      if (!serverId) { localStorage.removeItem(STAGE_CHANNEL_KEY); return; }
      apiClient.getStage(savedStageId, serverId).then((session) => {
        if (session) {
          useVoiceStore.getState().setActiveStageSessions((prev) => ({ ...prev, [savedStageId]: normalizeStageSession(session) }));
          useVoiceStore.getState().setConnectedStageChannelId(savedStageId);
          // useStageRoom's transport.join will handle the actual audience join
          // with ACK gating; this legacy emit was redundant and pre-dated the
          // hook-driven flow. Removing it prevents an unhandled-rejection
          // warning if the socket isn't connected yet at auto-rejoin time.
        } else {
          localStorage.removeItem(STAGE_CHANNEL_KEY);
        }
      }).catch(() => localStorage.removeItem(STAGE_CHANNEL_KEY));
    } catch { /* localStorage unavailable */ }
  }, [currentUserId, serverIdKey]);

  // Only switch to first channel when the current channel is not in this server.
  // Subscribed via useServerStore so this re-runs after lazy hydration drops
  // channels into the active server (slim GET /api/servers ships no channels).
  const activeServerChannelIds = useServerStore(useShallow(s => {
    if (!isRealServerId(activeServerId)) return [] as string[];
    return s.servers.find(sv => sv.id === activeServerId)?.channels.map(c => c.id) ?? [];
  }));
  useEffect(() => {
    if (!isRealServerId(activeServerId)) return;
    if (activeServerChannelIds.length === 0) return;
    if (activeServerChannelIds.includes(activeChannelId)) return;
    navigate(`/channels/${activeServerId}/${activeServerChannelIds[0]}`, { replace: true });
  }, [activeServerId, activeChannelId, activeServerChannelIds, navigate]);

  // Typing callbacks
  const _lastTypingEmit = useRef(0);
  const handleChatTyping = useCallback(() => {
    const now = Date.now();
    if (now - _lastTypingEmit.current < 2000) return;
    _lastTypingEmit.current = now;
    socketService.emitTyping({ channelId: useNavigationStore.getState().activeChannelId });
  }, []);

  const _lastQtTypingEmit = useRef(0);
  const handleQTTyping = useCallback(() => {
    const chId = quickTextChannelIdRef.current;
    if (!chId) return;
    const now = Date.now();
    if (now - _lastQtTypingEmit.current < 2000) return;
    _lastQtTypingEmit.current = now;
    socketService.emitTyping({ channelId: chId });
  }, []);

  // Auth handlers
  const initEncryptionWithRestore = useCallback(async (user: User) => {
    try {
      const { initializeEncryption } = await import('./services/dmEncryption');
      await initializeEncryption(user.id);
    } catch {
      // no-op
    }
  }, []);

  const handleAuthSuccess = useCallback(async (user: User, loginPassword?: string) => {
    deferStoreUpdate(() => useAuthStore.getState().setCurrentUser(user));
    await initEncryptionWithRestore(user);
    // Provision this device's MLS identity at authenticated session start,
    // BEFORE and independent of vault unlock (fire-and-forget; idempotent under lock).
    void dmKeyManager.provisionMlsDevice().catch((e) =>
      console.error('[diag][e2e-login] provisionMlsDevice failed: ' + (e as Error)?.message),
    );
    import('./services/dmSearchIndex').then(async (m) => {
      await m.initSearchIndex(user.id);
      m.loadIndexFromDB().catch(() => {});
    }).catch(() => {});

    console.error('[diag][e2e-login] start, hasLoginPassword=' + !!loginPassword);
    if (loginPassword) {
      try {
        const hasBundle = await dmKeyManager.checkSetup();
        console.error('[diag][e2e-login] hasBundle=' + hasBundle);
        if (!hasBundle) {
          // Show encryption choice modal instead of auto-setup
          console.error('[diag][e2e-login] no bundle, opening choice modal');
          useUiStore.getState().setEncryptionChoicePassword(loginPassword);
        } else {
          try {
            await dmKeyManager.unlock(loginPassword);
            console.error('[diag][e2e-login] unlock(loginPassword) ok');
            void dmKeyManager.rememberOnDevice(loginPassword);
          } catch (unlockErr) {
            console.error('[diag][e2e-login] unlock(loginPassword) failed: ' + (unlockErr as Error)?.message + ', isPasswordDerived=' + dmKeyManager.isPasswordDerived() + ', getUnlockOnLogin=' + dmKeyManager.getUnlockOnLogin());
            // Unlock failed — password may have changed (forgot-password / admin reset)
            // OR user has separate E2E passphrase (Secure mode, not Secure-and-Easy).
            if (dmKeyManager.isPasswordDerived()) {
              try {
                await dmKeyManager.serverRecover(loginPassword);
                console.error('[diag][e2e-login] serverRecover ok');
                void dmKeyManager.rememberOnDevice(loginPassword);
              } catch (recoverErr) {
                console.error('[diag][e2e-login] serverRecover failed: ' + (recoverErr as Error)?.message + ', opening unlock modal');
                useUiStore.getState().setE2ePassphraseModal('unlock');
              }
            } else {
              // Separate E2E passphrase. Always prompt — without this the
              // user is stranded with the locked banner and no way to unlock.
              // Was previously gated on getUnlockOnLogin(), which silently
              // dropped the prompt for users who had ever toggled it off.
              console.error('[diag][e2e-login] separate E2E passphrase, opening unlock modal');
              useUiStore.getState().setE2ePassphraseModal('unlock');
            }
          }
        }
      } catch (err) {
        // Transient bundle-fetch failure (5xx, network, timeout). DON'T show
        // the setup-choice modal — the user likely already has a bundle. If
        // they previously enabled unlock-on-login, surface the unlock modal
        // anyway so they can recover from the transient.
        console.error('[diag][e2e-login] checkSetup transient: ' + (err as Error)?.message);
        if (dmKeyManager.getUnlockOnLogin() && !dmKeyManager.isUnlocked()) {
          console.error('[diag][e2e-login] transient + getUnlockOnLogin=true, opening unlock modal as recovery');
          useUiStore.getState().setE2ePassphraseModal('unlock');
        }
      }
    } else {
      // Silent-unlock matrix: a no-password login (passkey / MFA /
      // device-verify / SSO) gets a SILENT install ONLY if this device already
      // holds a device content key (tryAutoUnlock -> installFromDeviceContentKeys).
      // Otherwise we fail-closed to the lock prompt below - never silent
      // plaintext. KNOWN LIMITATION: pure-SSO accounts (passwordHash:null) cannot
      // server-recover (backend dmKeys.ts server-recover 400s with "Account has
      // no password set"), so on a brand-new device with no stored content key
      // they always land on the prompt. Giving SSO a server-recovery credential
      // is out of scope here.
      try {
        const hasBundle = await dmKeyManager.checkSetup();
        console.error('[diag][e2e-login] (no-password) hasBundle=' + hasBundle);
        if (hasBundle) {
          const autoUnlocked = await dmKeyManager.tryAutoUnlock();
          console.error('[diag][e2e-login] (no-password) autoUnlock=' + autoUnlocked + ', getUnlockOnLogin=' + dmKeyManager.getUnlockOnLogin());
          // Without a login password, prompt unconditionally if not auto-unlocked.
          // Gating on getUnlockOnLogin() here strands SSO users who toggled it off.
          if (!autoUnlocked) useUiStore.getState().setE2ePassphraseModal('unlock');
        } else {
          console.error('[diag][e2e-login] (no-password) no bundle, opening setup modal');
          useUiStore.getState().setE2ePassphraseModal('setup');
        }
      } catch (err) {
        console.error('[diag][e2e-login] (no-password) checkSetup transient: ' + (err as Error)?.message);
        if (!dmKeyManager.isUnlocked()) {
          console.error('[diag][e2e-login] (no-password) transient + locked, opening unlock modal as recovery');
          useUiStore.getState().setE2ePassphraseModal('unlock');
        }
      }
    }

    // Sync shared E2E locked state after all setup/unlock attempts.
    // (Also driven by the dmKeyManager event subscriber; this is a
    // belt-and-braces resync in case any path bypasses the emitter.)
    const lockedAfter = dmKeyManager.isSetup() && !dmKeyManager.isUnlocked();
    console.error('[diag][e2e-login] e2eLocked=' + lockedAfter + ', modal=' + useUiStore.getState().e2ePassphraseModal);
    useUiStore.getState().setE2eLocked(lockedAfter);

    const wasAutoIdle = localStorage.getItem('howl_auto_idle') === '1';
    localStorage.removeItem('howl_auto_idle');
    let loginStatus = user.status;
    if (loginStatus === 'offline') loginStatus = 'online';
    if (loginStatus === 'idle' && wasAutoIdle) loginStatus = 'online';
    deferStoreUpdate(() => applySelfStatus(loginStatus));
    if (loginStatus !== user.status) {
      syncStatusToServer(loginStatus, { immediate: true });
    } else {
      primeSentStatus(loginStatus);
    }
    import('./src/pushManager').then(({ subscribeToPush, isPushSupported }) => {
      if (isPushSupported()) subscribeToPush().catch(() => {});
    }).catch(() => {});
    try {
      const returnTo = sessionStorage.getItem('howl_returnTo');
      sessionStorage.removeItem('howl_returnTo');
      if (returnTo && /^\/(home|channels\/@me|channels\/[a-f0-9-]{36}|friends|settings|discover|s\/)/.test(returnTo)) {
        navigate(returnTo, { replace: true });
      }
    } catch { /* ignore */ }
  }, [navigate]);

  const encryptionChoicePassword = useUiStore(s => s.encryptionChoicePassword);

  // Public discovery pages — accessible regardless of auth state
  // /s/:vanity always renders its own chrome (public server profile preview).
  // /discover renders its own chrome ONLY for unauthenticated visitors. Authed
  // users at /discover fall through to AppLayout, which embeds DiscoverPage
  // inside the regular app shell (Discord-parity — discover is a page in the
  // app, not a full-screen takeover, when you're signed in).
  const discoverPathMatch = /^\/discover(\/|$|\?)/.test(location.pathname);
  const publicProfileMatch = location.pathname.match(/^\/s\/([A-Za-z0-9_-]{1,64})\/?$/);
  const discoverStandalone = discoverPathMatch && !currentUser;
  if (discoverStandalone || publicProfileMatch) {
    return (
      <div className="fixed inset-0 overflow-y-auto bg-app">
        <div className="absolute inset-0" style={{ paddingTop: titleBarPad }}>
          <Suspense fallback={null}>
            {discoverStandalone
              ? <DiscoverPage />
              : <PublicServerProfile vanity={publicProfileMatch?.[1]} />}
          </Suspense>
        </div>
        <TitleBar />
      </div>
    );
  }

  // Electron auth helper pages
  // When Electron opens passkey/auth pages in the system browser via shell.openExternal(),
  // the browser may already be signed in. These pages must render regardless of auth state
  // so the WebAuthn ceremony completes and the deep link fires back to Electron.
  // The ?nonce= parameter signals this is an Electron-originated flow.
  const isElectronAuthHelper = currentUser
    && /^\/auth\/(passkey-login|passkey-mfa|passkey-register)$/.test(location.pathname)
    && new URLSearchParams(location.search).has('nonce');

  if (isElectronAuthHelper) {
    return (
      <div className="fixed inset-0 overflow-y-auto bg-app">
        <div className="absolute inset-0" style={{ paddingTop: titleBarPad }}>
          <Routes>
            <Route path="/auth/passkey-login" element={<Suspense fallback={null}><PasskeyLoginPage /></Suspense>} />
            <Route path="/auth/passkey-mfa" element={<Suspense fallback={null}><PasskeyMfaPage /></Suspense>} />
            <Route path="/auth/passkey-register" element={<Suspense fallback={null}><PasskeyRegisterPage /></Suspense>} />
            <Route path="*" element={null} />
          </Routes>
        </div>
        <TitleBar />
      </div>
    );
  }

  // Legal pages — accessible regardless of auth state
  // External links (Electron install screen, emails, etc.) open these in the system
  // browser which may already be signed in. Must render outside the auth gate.
  const legalFiles: Record<string, string> = {
    '/terms-of-service': '/_legal-terms-of-service.html',
    '/privacy-policy': '/_legal-privacy-policy.html',
    '/community-guidelines': '/_legal-community-guidelines.html',
    '/dmca-policy': '/_legal-dmca-policy.html',
    '/refund-policy': '/_legal-refund-policy.html',
    '/law-enforcement': '/_legal-law-enforcement.html',
    '/accessibility': '/_legal-accessibility-statement.html',
  };
  const legalFile = currentUser ? legalFiles[location.pathname] : null;
  if (legalFile) {
    return (
      <div className="fixed inset-0 overflow-y-auto bg-app">
        <div className="absolute inset-0" style={{ paddingTop: titleBarPad }}>
          <Suspense fallback={null}>
            <LegalPage htmlFile={legalFile} />
          </Suspense>
        </div>
        <TitleBar />
      </div>
    );
  }

  // Account-security action pages (revoke sessions / revert email)
  // Reached from one-click links in security emails ("Sign out of all sessions",
  // "Revert email change"). They must render regardless of auth state: the link
  // recipient may not be logged in (an attacker may have changed the password),
  // and the whole point of a "this wasn't me" action is to act without first
  // signing in. The signed token in the URL is the authentication signal, which
  // the backend verifies (POST /auth/revoke-sessions and /auth/email/revert).
  if (location.pathname === '/revoke-sessions' || location.pathname === '/email-revert') {
    return (
      <div className="fixed inset-0 overflow-y-auto bg-app">
        <div className="absolute inset-0" style={{ paddingTop: titleBarPad }}>
          <Suspense fallback={null}>
            <SecurityActionPage action={location.pathname === '/email-revert' ? 'email-revert' : 'revoke-sessions'} />
          </Suspense>
        </div>
        <TitleBar />
      </div>
    );
  }

  // Marketing landing root — always shows for web visitors, regardless of auth
  // Discord-pattern: visiting howlpro.com always shows the landing page. Authed
  // users click "Open in Browser" / "Open App" to enter the app shell.
  //
  // Electron skips this entirely. Detection is via the module-level
  // __isElectronApp constant (URL `?app=1` signal + sessionStorage cache);
  // see its definition for why the previous URL-protocol check is wrong now
  // that packaged Electron loads from the same HTTPS origin as the web app.
  if (!__isElectronApp && location.pathname === '/') {
    // Self-host builds have no marketing site; send the root into the app/login
    // (authed users are then forwarded to /home by the post-auth handler above).
    const selfHostRedirect = selfHostRootRedirect(__selfHostBuild, location.pathname);
    if (selfHostRedirect) return <Navigate to={selfHostRedirect} replace />;
    return (
      <div className="fixed inset-0 overflow-y-auto bg-app">
        <div className="absolute inset-0" style={{ paddingTop: titleBarPad }}>
          <Suspense fallback={null}><LandingPage /></Suspense>
        </div>
        <TitleBar />
        <CookieConsent />
      </div>
    );
  }

  // Unauthenticated routes
  if (!currentUser) {
    const isElectronApp = __isElectronApp;

    return (
      <div className="fixed inset-0 overflow-y-auto bg-app">
        <div className="absolute inset-0" style={{ paddingTop: titleBarPad }}>
          <Routes>
            <Route path="/auth/callback" element={
              <SsoCallback onAuthSuccess={handleAuthSuccess} />
            } />
            <Route path="/auth/passkey-login" element={<Suspense fallback={null}><PasskeyLoginPage /></Suspense>} />
            <Route path="/auth/passkey-mfa" element={<Suspense fallback={null}><PasskeyMfaPage /></Suspense>} />
            <Route path="/auth/passkey-register" element={<Suspense fallback={null}><PasskeyRegisterPage /></Suspense>} />
            <Route path="/about" element={<Suspense fallback={null}><AboutPage /></Suspense>} />
            <Route path="/credits" element={<Suspense fallback={null}><CreditsPage /></Suspense>} />
            <Route path="/login" element={<Suspense fallback={null}><Login onAuthSuccess={handleAuthSuccess} /></Suspense>} />
            <Route path="/terms-of-service" element={<Suspense fallback={null}><LegalPage htmlFile="/_legal-terms-of-service.html" /></Suspense>} />
            <Route path="/privacy-policy" element={<Suspense fallback={null}><LegalPage htmlFile="/_legal-privacy-policy.html" /></Suspense>} />
            <Route path="/community-guidelines" element={<Suspense fallback={null}><LegalPage htmlFile="/_legal-community-guidelines.html" /></Suspense>} />
            <Route path="/dmca-policy" element={<Suspense fallback={null}><LegalPage htmlFile="/_legal-dmca-policy.html" /></Suspense>} />
            <Route path="/refund-policy" element={<Suspense fallback={null}><LegalPage htmlFile="/_legal-refund-policy.html" /></Suspense>} />
            <Route path="/law-enforcement" element={<Suspense fallback={null}><LegalPage htmlFile="/_legal-law-enforcement.html" /></Suspense>} />
            <Route path="/accessibility" element={<Suspense fallback={null}><LegalPage htmlFile="/_legal-accessibility-statement.html" /></Suspense>} />
            <Route path="/invite/:code" element={
              <Suspense fallback={null}>
                <InviteResolvePage
                  servers={useServerStore.getState().servers}
                  onJoin={(code: string) => joinByInvite(code, navigate)}
                  onViewServer={(serverId) => { const s = useServerStore.getState().servers.find(sv => sv.id === serverId); if (s) { showGlobalToast(t('toast.alreadyInServer', { name: s.name })); navigate(`/channels/${s.id}/${s.channels[0]?.id ?? ''}`); } }}
                  isLoggedIn={!!currentUser}
                />
              </Suspense>
            } />
            <Route path="*" element={
              isElectronApp
                ? <Suspense fallback={null}><Login onAuthSuccess={handleAuthSuccess} /></Suspense>
                : <UnauthCatchAll><Suspense fallback={null}><LandingPage /></Suspense></UnauthCatchAll>
            } />
          </Routes>
        </div>
        <TitleBar />
        <CookieConsent />
      </div>
    );
  }

  // Onboarding / setup gates
  if (currentUser.needsOnboarding) {
    return (
      <div className="fixed inset-0 overflow-y-auto bg-app">
        <div className="absolute inset-0" style={{ paddingTop: titleBarPad }}>
          <SsoOnboarding user={currentUser} onComplete={async (u, password) => {
            useAuthStore.getState().setCurrentUser(u);
            useUiStore.getState().setEncryptionChoicePassword(password);
          }} />
        </div>
        <TitleBar />
      </div>
    );
  }

  if (currentUser.needsDateOfBirth) {
    return (
      <div className="fixed inset-0 overflow-y-auto bg-app">
        <div className="absolute inset-0" style={{ paddingTop: titleBarPad }}>
          <DateOfBirthPrompt user={currentUser} onComplete={(u) => useAuthStore.getState().setCurrentUser(u)} />
        </div>
        <TitleBar />
      </div>
    );
  }

  if (currentUser.hasPassword === false) {
    return (
      <div className="fixed inset-0 overflow-y-auto bg-app">
        <div className="absolute inset-0" style={{ paddingTop: titleBarPad }}>
          <PasswordSetupPrompt user={currentUser} onComplete={async (u, password) => {
          useAuthStore.getState().setCurrentUser(u);
          useUiStore.getState().setEncryptionChoicePassword(password);
        }} />
        </div>
        <TitleBar />
      </div>
    );
  }

  if (currentUser.emailVerified === false) {
    return (
      <div className="fixed inset-0 overflow-y-auto bg-app">
        <div className="absolute inset-0" style={{ paddingTop: titleBarPad }}>
          <SsoEmailVerification user={currentUser} onVerified={(u) => useAuthStore.getState().setCurrentUser(u)} />
        </div>
        <TitleBar />
      </div>
    );
  }

  if (encryptionChoicePassword) {
    return (
      <div className="fixed inset-0 overflow-y-auto bg-app">
        <div className="absolute inset-0" style={{ paddingTop: titleBarPad }}>
          <EncryptionChoiceModal
            accountPassword={encryptionChoicePassword}
            onComplete={() => {
              useUiStore.getState().setEncryptionChoicePassword(null);
              // e2eLocked is now driven by the dmKeyManager event subscriber
              // wired in initializeEncryption — setup/unlock inside the modal
              // emits 'unlocked' which the subscriber maps to setE2eLocked(false).
              useUiStore.getState().setE2ePassphraseModal(null);
            }}
            /* Escape hatch — user can dismiss Secure-DM setup at login and
               continue with unencrypted chat. They'll see the Setup CTA
               again in Settings → Encryption. */
            onClose={() => {
              useUiStore.getState().setEncryptionChoicePassword(null);
            }}
          />
        </div>
        <TitleBar />
      </div>
    );
  }

  // First-run layout picker
  // Once the user clears all the mandatory onboarding gates above (DOB,
  // password, email verify, Secure-DM choice), we ask them to pick
  // Default vs Classic server layout. This is the last gate before
  // AppLayout mounts — any later and the user would see the app in
  // whatever the default layout is for a moment, then get blocked.
  //
  // Cross-device persistence: the seen flag is mirrored to the server
  // via SettingsBlob.hasSeenLayoutPicker. On a second device, the modal
  // can briefly flash before the server fetch lands; SettingsContext's
  // applyServerSettings then writes the localStorage flag and dispatches
  // LAYOUT_PICKER_SEEN_EVENT, which the useEffect above catches to
  // dismiss the picker without a click.
  if (showLayoutPicker) {
    return (
      <div className="fixed inset-0 overflow-y-auto bg-app">
        <div className="absolute inset-0" style={{ paddingTop: titleBarPad }}>
          <LayoutPickerModal
            onComplete={() => {
              try { localStorage.setItem(LAYOUT_PICKER_SEEN_KEY, '1'); } catch { /* private mode */ }
              // Push the seen flag to the server so other devices skip
              // the picker. setServerLayout inside the modal already
              // calls scheduleSyncToServer, but the order is
              // setServerLayout (sync queued) → onComplete (localStorage
              // written), so the queued sync's collectSettingsBlob will
              // pick up the flag from localStorage as long as the 500ms
              // debounce hasn't fired. We schedule explicitly here as a
              // belt-and-braces guarantee.
              schedSettingsSync();
              setShowLayoutPicker(false);
            }}
          />
        </div>
        <TitleBar />
      </div>
    );
  }

  // Invite page — accessible regardless of auth state
  // When an authenticated user navigates to /invite/:code (via browser URL,
  // deep link from Electron, or an in-app link), render InviteResolvePage
  // directly instead of falling through to AppLayout (which doesn't have a
  // route for /invite/:code and would show the home view).
  const inviteMatch = location.pathname.match(/^\/invite\/([A-Za-z0-9_-]{3,32})$/);
  if (inviteMatch) {
    return (
      <div className="fixed inset-0 overflow-y-auto bg-app">
        <div className="absolute inset-0" style={{ paddingTop: titleBarPad }}>
          <Suspense fallback={null}>
            <InviteResolvePage
              inviteCode={inviteMatch[1]}
              servers={useServerStore.getState().servers}
              onJoin={(code: string) => joinByInvite(code, navigate)}
              onViewServer={(serverId) => {
                const s = useServerStore.getState().servers.find(sv => sv.id === serverId);
                if (s) {
                  showGlobalToast(t('toast.alreadyInServer', { name: s.name }));
                  navigate(`/channels/${s.id}/${s.channels[0]?.id ?? ''}`);
                }
              }}
              isLoggedIn={!!currentUser}
            />
          </Suspense>
        </div>
        <TitleBar />
      </div>
    );
  }

  // Authenticated app: delegate layout to AppLayout
  return (
    <>
      <UpdateRecommendedBanner />
      <UpdateBlockingModal />
      {isElectron && <CloseActionModal />}
      {isElectron && <StreamDeckPairModal />}
      {showAutostartPrompt && <AutostartPromptModal onDismiss={handleAutostartPromptDismiss} />}
      <CameraPreviewModal
        open={showCameraPreview}
        selectedDeviceId={voiceSettings.selectedCameraId}
        alwaysPreview={voiceSettings.cameraPreviewModal}
        videoBackgroundMode={voiceSettings.videoBackgroundMode}
        onClose={() => useVoiceStore.getState().setShowCameraPreview(false)}
        onConfirm={() => {
          useVoiceStore.getState().setShowCameraPreview(false);
          enableCamera();
        }}
        onDeviceChange={(id) => updateVoice({ selectedCameraId: id })}
        onAlwaysPreviewChange={(v) => updateVoice({ cameraPreviewModal: v })}
        onVideoBackgroundModeChange={(mode) => updateVoice({ videoBackgroundMode: mode })}
        onOpenVideoSettings={() => {
          useVoiceStore.getState().setShowCameraPreview(false);
          useNavigationStore.getState().setAccountDeepLink({ page: 'voice-video' });
          navigate('/settings');
        }}
      />
      <AppLayout
      handleLogout={handleLogout}
      handleStatusChange={handleStatusChange}
      handleChannelSelect={handleChannelSelect}
      handleChatTyping={handleChatTyping}
      handleQTTyping={handleQTTyping}
      toggleMute={toggleMute}
      toggleDeafen={toggleDeafen}
      toggleScreenShare={toggleScreenShare}
      toggleCamera={toggleCamera}
      startScreenShareWithQuality={startScreenShareWithQuality}
      openScreenShareSettings={openScreenShareSettings}
      updateScreenShareQuality={updateScreenShareQuality}
      disconnectFromVoice={disconnectFromVoice}
      clearStoredVoiceChannel={clearStoredVoiceChannel}
      dismissMfaBanner={dismissMfaBanner}
      refetchServerMembers={refetchServerMembers}
      processServerMembers={processServerMembers}
      setParticipantVolume={setParticipantVolume}
      refetchProfileFriendStatus={refetchProfileFriendStatus}
      handleOpenFullProfile={handleOpenFullProfile}
      handleEditServerProfile={handleEditServerProfile}
      setActiveDmCallChannelId={setActiveDmCallChannelId}
      setDmCallWithVideo={setDmCallWithVideo}
      setDmCallDeclinedUserIds={setDmCallDeclinedUserIds}
      setIncomingDmCall={setIncomingDmCall}
      onAcceptIncomingDmCall={onAcceptIncomingDmCall}
      onDeclineIncomingDmCall={onDeclineIncomingDmCall}
      voiceLocalStream={voiceLocalStream}
      voiceRemoteParticipants={voiceRemoteParticipants}
      voiceError={voiceError}
      voiceEnableRemoteScreen={voiceEnableRemoteScreen}
      voiceDisableRemoteScreen={voiceDisableRemoteScreen}
      voiceSwitchMicDevice={voiceSwitchMicDevice}
      voiceServerRegion={voiceServerRegion ?? stageServerRegion}
      voiceIsE2ee={voiceIsE2ee}
      voiceIsE2eeFailed={voiceIsE2eeFailed}
      stageLocalStream={stageLocalStream}
      stageRemoteParticipants={stageRemoteParticipants}
      stageIsE2ee={stageIsE2ee}
      stageIsE2eeFailed={stageIsE2eeFailed}
      stageError={stageError}
      stageDisconnectedByInactivity={stageDisconnectedByInactivity}
      stageEnableRemoteScreen={stageEnableRemoteScreen}
      stageDisableRemoteScreen={stageDisableRemoteScreen}
      stageSwitchMicDevice={stageSwitchMicDevice}
      dmLocalStream={dmLocalStream}
      dmRemoteParticipants={dmRemoteParticipants}
      dmError={dmError}
      dmDisconnectedByInactivity={dmDisconnectedByInactivity}
      dmEnableRemoteScreen={dmEnableRemoteScreen}
      dmDisableRemoteScreen={dmDisableRemoteScreen}
      dmSwitchMicDevice={dmSwitchMicDevice}
      dmLeave={dmLeave}
      dmIsE2ee={dmIsE2ee}
      dmIsE2eeFailed={dmIsE2eeFailed}
      dmIsE2eeEstablishing={dmIsE2eeEstablishing}
      dmIsE2eeBlocked={dmIsE2eeBlocked}
      dmCallKeyMode={dmCallKeyMode}
      dmStartedAt={dmStartedAt}
      voiceAudioConstraints={voiceAudioConstraints}
      backgroundImage={backgroundImage}
      setBackgroundImage={setBackgroundImage}
      backgroundOpacity={backgroundOpacity}
      setBackgroundOpacity={setBackgroundOpacity}
      backgroundBlur={backgroundBlur}
      setBackgroundBlur={setBackgroundBlur}
      bgGifAlwaysPlay={bgGifAlwaysPlay}
      setBgGifAlwaysPlay={setBgGifAlwaysPlay}
      bgFrameUrl={bgFrameUrl}
      membersColumnWidth={membersColumnWidth}
      membersColumnOpen={membersColumnOpen}
      setMembersColumnOpen={setMembersColumnOpen as (v: boolean | ((prev: boolean) => boolean)) => void}
      mobileMembersOpen={mobileMembersOpen}
      setMobileMembersOpen={setMobileMembersOpen as (v: boolean | ((prev: boolean) => boolean)) => void}
      startDrag={startDrag}
      activeDmCallChannelId={activeDmCallChannelId}
      dmCallWithVideo={dmCallWithVideo}
      dmCallDeclinedUserIds={dmCallDeclinedUserIds}
      dmCallParticipantIds={dmCallParticipantIds}
      incomingDmCall={incomingDmCall}
      declinedDmCallChannelIds={declinedDmCallChannelIds}
      messageRateLimitActive={messageRateLimitActive}
      messageSendError={messageSendError}
      globalToast={globalToast}
      showGlobalToast={showGlobalToast}
      dismissToast={dismissToast}
      e2eeFileMetaRef={e2eeFileMetaRef}
      contentSwipeHandlers={contentSwipeHandlers}
      serverDrawerPanelRef={serverDrawerPanelRef}
      serverBackdropRef={serverBackdropRef}
      membersDrawerRef={membersDrawerRef}
      membersBackdropRef={membersBackdropRef}
      channelFetchTimestamps={channelFetchTimestamps}
      processDmListRef={processDmListRef}
      joinedServerRoomsRef={joinedServerRoomsRef}
    />
    </>
  );
};

export default App;
