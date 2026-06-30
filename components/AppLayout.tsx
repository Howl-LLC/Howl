// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { Suspense, useMemo, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../src/i18n';
import { isElectron as detectElectron } from '../config';
import { Sidebar, type ServerContextAction } from './Sidebar';
import { ChannelList, getPinnedForServer, getPinnedCategoriesForServer } from './ChannelList';
import { ChatArea } from './ChatArea';
import ChannelPanelAside from './ChannelPanelAside';
import { MemberList } from './MemberList';
const VoiceChannel = React.lazy(() => import('./VoiceChannel'));
import { QuickTextPanel } from './QuickTextPanel';
import { VoiceRemoteAudio } from './VoiceRemoteAudio';
import { InCallBluetoothBanner } from './audio/InCallBluetoothBanner';
import { ErrorBoundary } from './ErrorBoundary';
import { useRenderLoopDetector } from '../hooks/useRenderLoopDetector';
import { useIdleAutoLock } from '../hooks/useIdleAutoLock';
const HomeView = React.lazy(() => import('./HomeView').then(m => ({ default: m.HomeView })));
const FriendsView = React.lazy(() => import('./FriendsView').then(m => ({ default: m.FriendsView })));
const DiscoverPage = React.lazy(() => import('./discovery/DiscoverPage').then(m => ({ default: m.DiscoverPage })));
const ServerCalendar = React.lazy(() => import('./ServerCalendar').then(m => ({ default: m.ServerCalendar })));
const CreateEventModal = React.lazy(() => import('./calendar/CreateEventModal').then(m => ({ default: m.CreateEventModal })));
const DMView = React.lazy(() => import('./DMView').then(m => ({ default: m.DMView })));
const PollCreationModal = React.lazy(() => import('./PollCreationModal').then(m => ({ default: m.PollCreationModal })));
const ThreadCreationModal = React.lazy(() => import('./ThreadCreationModal').then(m => ({ default: m.ThreadCreationModal })));
const ThreadPanel = React.lazy(() => import('./ThreadPanel').then(m => ({ default: m.ThreadPanel })));
const StageSettingsModal = React.lazy(() => import('./StageSettingsModal').then(m => ({ default: m.StageSettingsModal })));
const StageView = React.lazy(() => import('./StageView').then(m => ({ default: m.StageView })));
const ForumView = React.lazy(() => import('./forum/ForumView').then(m => ({ default: m.ForumView })));
const RolePickerChannel = React.lazy(() => import('./channel/RolePickerChannel').then(m => ({ default: m.RolePickerChannel })));
const NotificationCenterViewLazy = React.lazy(() => import('./NotificationCenterView').then(m => ({ default: m.NotificationCenterView })));
const WelcomeScreenModal = React.lazy(() => import('./community/WelcomeScreenModal').then(m => ({ default: m.WelcomeScreenModal })));
const OnboardingModal = React.lazy(() => import('./server/OnboardingModal').then(m => ({ default: m.OnboardingModal })));
const ThreadBrowser = React.lazy(() => import('./ThreadBrowser').then(m => ({ default: m.ThreadBrowser })));
import { FloatingUserStatusBar } from './FloatingUserStatusBar';
import { TitleBar, TITLE_BAR_HEIGHT } from './TitleBar';
import { ReportMessageModal } from './ReportMessageModal';
import { RecoveryKeyModal } from './dm/RecoveryKeyModal';
import { RecoveryKeyReminder } from './dm/RecoveryKeyReminder';
import { EncryptionPassphraseModal } from './dm/EncryptionPassphraseModal';
import { X as CloseIcon, Shield, ShieldAlert, MessageCirclePlus, Calendar, Users } from 'lucide-react';
import { User, Message, Channel, NavigationTarget, formatUsername, serverHasPerm, type Thread } from '../types';
import { apiClient } from '../services/api';
import { socketService } from '../services/socket';
import { setChannelEncryptionStatus, isChannelEncrypted } from '../services/encryptionFlags';
import * as dmKeyManager from '../services/dmKeyManager';
import { decryptDMMessages } from '../services/dmEncryption';
import { setDmMuted, muteDurationToUntil } from '../utils/dmMuteStorage';
import { isRealServerId } from '../utils/navigationHelpers';
import type { MuteDuration } from './GroupChatContextMenu';
import { UserProfilePopup, type UserWithRole } from './UserProfilePopup';
import { FullProfileModal } from './FullProfileModal';
import { UserContextMenu } from './UserContextMenu';
import { NicknameModal } from './server/NicknameModal';
import { DirectMessageContextMenu } from './DirectMessageContextMenu';
import { type ForwardPayload } from './ForwardImageModal';
const ForwardImageModal = React.lazy(() => import('./ForwardImageModal').then(m => ({ default: m.ForwardImageModal })));
import { SpoilerRevealProvider } from './SpoilerRevealContext';
import { TemplatePreviewPage } from './TemplatePreviewPage';
import { CookieConsent } from './CookieConsent';
import { ConfirmDialog } from './settings/SettingsWidgets';
import GlobalToast from './GlobalToast';
import { motion } from 'motion/react';
import { AnimatePresence } from 'motion/react';
import { UserProvider } from '../contexts/UserContext';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { LazyGif } from './LazyGif';

const AccountView = React.lazy(() => import('./AccountView').then(m => ({ default: m.AccountView })));
const ScreenSharePicker = React.lazy(() => import('./ScreenSharePicker').then(m => ({ default: m.ScreenSharePicker })));
const ModViewPopup = React.lazy(() => import('./ModViewPopup').then(m => ({ default: m.ModViewPopup })));
const DMCallView = React.lazy(() => import('./DMCallView').then(m => ({ default: m.DMCallView })));
const IncomingDMCallModal = React.lazy(() => import('./IncomingDMCallModal').then(m => ({ default: m.IncomingDMCallModal })));
import { PipHost } from './pip/PipHost';
import { DeleteMessageModal } from './DeleteMessageModal';
import { NavigatorTrigger } from './launcher/NavigatorTrigger';
const HowlNavigator = React.lazy(() => import('./launcher/HowlNavigator').then(m => ({ default: m.HowlNavigator })));

import { sendChannelMessage, pinChannelMessage, unpinChannelMessage, promptDeleteMessage, confirmDeleteMessage as confirmDeleteMessageAction, editChannelMessage, reportChannelMessage, reactChannelMessage, forwardImage, forwardToChannel, loadOlderChannelMessages } from '../utils/messageActions';
import { sendDmMessage, deleteDmMessage, editDmMessage, reactDmMessage, reportDmMessage, pinDmMessage, unpinDmMessage, pinDmConversation, unpinDmConversation, getDmPins, createOrSelectDM, sendMessageAndOpenDM, createGroupDM, addGroupDmMembers, updateGroupDM, markDmRead, leaveGroupDM, blockUserInDmView, unblockUser, unblockUserInDmView, forwardToFriend, forwardToDM, loadOlderDmMessages } from '../utils/dmActions';
import type { MlsTier } from '../services/mls/roomKey';
import { createServer, handleServerCreatedFromTemplate, updateServer, joinByInvite, leaveServer, transferOwnershipAndLeave, deleteServer, markServerRead, createChannel, createCategory, updateChannel, deleteChannel, reorderChannels, updateCategory, deleteCategory, reorderCategories, createInvite, deleteInvite } from '../utils/serverActions';
import { createPoll, votePoll, removeVotePoll, closePoll, deletePoll } from '../utils/pollActions';
import { openThread, closeThread, openCreateThread, submitCreateThread, createThreadFromMenu, sendThreadMessage } from '../utils/threadActions';
import { switchVoiceChannel, leaveVoiceChannel, serverMuteUser, serverDeafenUser, moveVoiceUser, joinStage, leaveStage, raiseHand, lowerHand, joinStageAsSpeaker, moveSelfToAudience, startStage, editStage, normalizeStageSession } from '../utils/voiceActions';
import { ensureE2eUnlockedForCall } from '../utils/callE2eeGate';
import { leaveOtherActiveCalls } from '../utils/activeCallRegistry';
import { openCreateEventModal, selectEvent, changeMonth, submitEvent, deleteEvent, openEditEventModal, rsvpEvent, removeRsvp } from '../utils/calendarActions';
import { useNavigate } from 'react-router-dom';
import { navigateToMessage } from '../utils/navigateToMessage';
import { useSettings } from '../contexts/SettingsContext';
import { useBreakpoint } from '../hooks/useIsMobile';
import { useOverlayBridge } from '../hooks/useOverlayBridge';

import { useMessageStore } from '../stores/messageStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useServerStore } from '../stores/serverStore';
import { useSocialStore } from '../stores/socialStore';
import { useDmStore } from '../stores/dmStore';
import { useAuthStore } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';
import { useThreadPollStore } from '../stores/threadPollStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useCalendarStore } from '../stores/calendarStore';
import { useAppStore } from '../stores/appStore';
import { useShallow } from 'zustand/react/shallow';
import { useNavigationStore } from '../stores/navigationStore';
import { useCommunityStore } from '../stores/communityStore';

import { type ScreenShareQuality } from '../utils/videoConstraints';

type ServerMember = User & { role?: string; roleColor?: string; roleStyle?: 'solid' | 'gradient' | 'holographic'; nickname?: string | null; serverAvatar?: string | null; serverBanner?: string | null };

// Stable empty references to avoid new array/object creation on every render
const EMPTY_CHANNELS: Channel[] = [];
const EMPTY_CATEGORIES: import('../types').ChannelCategory[] = [];
const EMPTY_MESSAGES: Message[] = [];

/** Max messages kept in memory per channel. Oldest are evicted when exceeded. */
const MAX_MESSAGES_PER_CHANNEL = 1000;
/** Trim a message array to the per-channel cap, keeping the newest messages. */
const capMessages = (arr: Message[]) =>
  arr.length > MAX_MESSAGES_PER_CHANNEL ? arr.slice(-MAX_MESSAGES_PER_CHANNEL) : arr;

class ContentErrorBoundary extends React.Component<
  { children: React.ReactNode; onReset?: () => void },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 bg-app">
          <p className="text-t-secondary text-sm">{i18n.t('errors.viewLoadFailed')}</p>
          <button
            type="button"
            onClick={() => { this.setState({ hasError: false }); this.props.onReset?.(); }}
            className="px-4 py-2 rounded-lg bg-[var(--cyan-accent)]/20 text-[var(--cyan-accent)] border border-[var(--cyan-accent)]/40 hover:bg-[var(--cyan-accent)]/30 text-sm font-medium"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export interface AppLayoutProps {
  // Callbacks that remain in App.tsx (depend on hooks/refs)
  handleLogout: (keepEncryptionKeys?: boolean) => Promise<void>;
  handleStatusChange: (status: User['status']) => void;
  handleChannelSelect: (id: string) => void;
  handleChatTyping: () => void;
  handleQTTyping: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  toggleScreenShare: () => void;
  toggleCamera: () => void;
  startScreenShareWithQuality: (quality: ScreenShareQuality) => Promise<void>;
  openScreenShareSettings: () => void;
  updateScreenShareQuality: (q: ScreenShareQuality) => void;
  disconnectFromVoice: () => void;
  clearStoredVoiceChannel: () => void;
  dismissMfaBanner: () => void;
  refetchServerMembers: () => void;
  processServerMembers: (membersWithRole: ServerMember[]) => void;
  setParticipantVolume: (userId: string, volume: number) => void;
  refetchProfileFriendStatus: () => void;
  handleOpenFullProfile: (user: UserWithRole, serverId?: string, initialTab?: 'showcase' | 'activity' | 'friends' | 'servers') => void;
  handleEditServerProfile: (serverId: string) => void;
  setActiveDmCallChannelId: (id: string | null) => void;
  setDmCallWithVideo: (v: boolean) => void;
  setDmCallDeclinedUserIds: (ids: string[]) => void;
  setIncomingDmCall: (call: any) => void;
  onAcceptIncomingDmCall: (joinWithVideo: boolean) => void;
  onDeclineIncomingDmCall: () => void;

  // Values from React hooks in App.tsx

  // Voice hook returns
  voiceLocalStream: MediaStream | null;
  voiceRemoteParticipants: Array<{
    userId: string;
    username: string;
    nickname?: string;
    avatar?: string;
    banner?: string;
    bannerPositionY?: number;
    bannerZoom?: number;
    nameColor?: string;
    nameFont?: string;
    nameEffect?: string;
    avatarEffect?: string;
    effectivePlan?: string;
    roleColor?: string;
    roleStyle?: string;
    stream: MediaStream | null;
    screenStream?: MediaStream | null;
    serverMuted?: boolean;
    serverDeafened?: boolean;
    [key: string]: any;
  }>;
  voiceError: string | null;
  voiceEnableRemoteScreen: ((userId: string) => void) | undefined;
  voiceDisableRemoteScreen: ((userId: string) => void) | undefined;
  voiceSwitchMicDevice: (deviceId: string) => Promise<void>;

  // Server region (from LiveKit)
  voiceServerRegion: string | null;

  // Voice E2EE shield flags (server voice runs SFrame E2EE)
  voiceIsE2ee: boolean;
  voiceIsE2eeFailed: boolean;

  // Stage hook returns
  stageLocalStream: MediaStream | null;
  stageRemoteParticipants: Array<any>;
  stageIsE2ee: boolean;
  stageIsE2eeFailed: boolean;
  stageError: string | null;
  stageDisconnectedByInactivity: boolean;
  stageEnableRemoteScreen: ((userId: string) => void) | undefined;
  stageDisableRemoteScreen: ((userId: string) => void) | undefined;
  stageSwitchMicDevice: (deviceId: string) => Promise<void>;

  // DM call hook returns (lifted from DMCallView to App.tsx)
  dmLocalStream: MediaStream | null;
  dmRemoteParticipants: Array<any>;
  dmError: string | null;
  dmDisconnectedByInactivity: boolean;
  dmEnableRemoteScreen: ((userId: string) => void) | undefined;
  dmDisableRemoteScreen: ((userId: string) => void) | undefined;
  dmSwitchMicDevice: (deviceId: string) => Promise<void>;
  dmLeave: () => void;
  dmIsE2ee: boolean;
  dmIsE2eeFailed: boolean;
  dmIsE2eeEstablishing?: boolean;
  dmIsE2eeBlocked?: boolean;
  dmCallKeyMode?: 'mls' | null;
  dmStartedAt: number | null;

  // Voice audio constraints
  voiceAudioConstraints: Record<string, any>;

  // Background settings
  backgroundImage: string | null;
  setBackgroundImage: (img: string | null) => void;
  backgroundOpacity: number;
  setBackgroundOpacity: (v: number) => void;
  backgroundBlur: number;
  setBackgroundBlur: (v: number) => void;
  bgGifAlwaysPlay: boolean;
  setBgGifAlwaysPlay: (v: boolean) => void;
  bgFrameUrl: string | null;

  // Members column
  membersColumnWidth: number;
  membersColumnOpen: boolean;
  setMembersColumnOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  mobileMembersOpen: boolean;
  setMobileMembersOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  startDrag: (e: React.MouseEvent) => void;

  // DM call state
  activeDmCallChannelId: string | null;
  dmCallWithVideo: boolean;
  dmCallDeclinedUserIds: string[];
  dmCallParticipantIds: string[];
  incomingDmCall: any;
  declinedDmCallChannelIds: React.MutableRefObject<Map<string, number>>;

  // Message feedback
  messageRateLimitActive: boolean;
  messageSendError: string | null;

  // Global toast
  globalToast: { id: string; message: string; type: 'info' | 'warning'; actionLabel?: string; onAction?: () => void } | null;
  showGlobalToast: (message: string, type?: 'info' | 'warning') => void;
  dismissToast: () => void;

  // E2E file meta ref
  e2eeFileMetaRef: React.MutableRefObject<Map<string, { key: string; name: string; type: string; size: number; thumbUrl?: string; thumbKey?: string; thumbWidth?: number; thumbHeight?: number }>>;

  // Swipe handlers
  contentSwipeHandlers: Record<string, any>;
  serverDrawerPanelRef: React.RefObject<HTMLDivElement | null>;
  serverBackdropRef: React.RefObject<HTMLDivElement | null>;
  membersDrawerRef: React.RefObject<HTMLDivElement | null>;
  membersBackdropRef: React.RefObject<HTMLDivElement | null>;

  // Channel fetch timestamps ref (for retry)
  channelFetchTimestamps: React.MutableRefObject<Record<string, number>>;

  // processDmList ref
  processDmListRef: React.MutableRefObject<((list: any) => void) | null>;

  // Joined server rooms ref
  joinedServerRoomsRef: React.MutableRefObject<Set<string>>;
}

export function AppLayout(props: AppLayoutProps) {
  useRenderLoopDetector('AppLayout');
  const { t } = useTranslation();
  useOverlayBridge();
  const {
    handleLogout,
    handleStatusChange,
    handleChannelSelect,
    handleChatTyping,
    handleQTTyping,
    toggleMute,
    toggleDeafen,
    toggleScreenShare,
    toggleCamera,
    startScreenShareWithQuality,
    openScreenShareSettings,
    updateScreenShareQuality,
    disconnectFromVoice,
    clearStoredVoiceChannel,
    dismissMfaBanner,
    refetchServerMembers,
    processServerMembers,
    setParticipantVolume,
    refetchProfileFriendStatus,
    handleOpenFullProfile,
    handleEditServerProfile,
    setActiveDmCallChannelId,
    setDmCallWithVideo,
    setDmCallDeclinedUserIds,
    setIncomingDmCall,
    onAcceptIncomingDmCall,
    onDeclineIncomingDmCall,
    voiceLocalStream,
    voiceRemoteParticipants,
    voiceError,
    voiceEnableRemoteScreen,
    voiceDisableRemoteScreen,
    voiceSwitchMicDevice,
    voiceServerRegion,
    voiceIsE2ee,
    voiceIsE2eeFailed,
    stageLocalStream,
    stageRemoteParticipants,
    stageIsE2ee,
    stageIsE2eeFailed,
    stageError,
    stageDisconnectedByInactivity,
    stageEnableRemoteScreen,
    stageDisableRemoteScreen: _stageDisableRemoteScreen,
    stageSwitchMicDevice,
    dmLocalStream,
    dmRemoteParticipants,
    dmError,
    dmDisconnectedByInactivity,
    dmEnableRemoteScreen,
    dmDisableRemoteScreen,
    dmSwitchMicDevice,
    dmLeave,
    dmIsE2ee,
    dmIsE2eeFailed,
    dmIsE2eeEstablishing,
    dmIsE2eeBlocked,
    dmCallKeyMode,
    dmStartedAt,
    voiceAudioConstraints: _voiceAudioConstraints,
    backgroundImage,
    setBackgroundImage,
    backgroundOpacity,
    setBackgroundOpacity,
    backgroundBlur,
    setBackgroundBlur,
    bgGifAlwaysPlay,
    setBgGifAlwaysPlay,
    bgFrameUrl,
    membersColumnWidth,
    membersColumnOpen,
    setMembersColumnOpen,
    mobileMembersOpen,
    setMobileMembersOpen,
    startDrag,
    activeDmCallChannelId,
    dmCallWithVideo,
    dmCallDeclinedUserIds,
    dmCallParticipantIds,
    incomingDmCall,
    declinedDmCallChannelIds,
    messageRateLimitActive,
    messageSendError,
    globalToast,
    showGlobalToast,
    dismissToast,
    e2eeFileMetaRef,
    contentSwipeHandlers,
    serverDrawerPanelRef,
    serverBackdropRef,
    membersDrawerRef,
    membersBackdropRef,
    channelFetchTimestamps,
    processDmListRef,
    joinedServerRoomsRef,
  } = props;

  const navigate = useNavigate();

  // Cross-channel jump-to-message: navigates to the channel/DM that owns the messageId
  // and sets pendingScrollTarget. ChatArea picks it up on mount and scrolls (or fetches
  // a window around the target via the backend `?around=:id` endpoint).
  const handleNavigateToMessage = useCallback((channelId: string, messageId: string) => {
    navigateToMessage(channelId, messageId, navigate);
  }, [navigate]);

  // Derived from hooks (previously passed as props)
  const breakpointTier = useBreakpoint();
  const isMobile = breakpointTier === 'mobile';
  const isTablet = breakpointTier === 'tablet';
  const isElectron = detectElectron();
  const titleBarPad = isElectron ? TITLE_BAR_HEIGHT : 0;
  const {
    theme, uiDensity: rawUiDensity,
    zoomLevel, cssZoomLevel, setZoomLevel, accessibilitySettings,
    chatSettings, voiceSettings,
    advancedSettings, updateVoice,
    serverLayout,
  } = useSettings();
  const useSettingsRef = useRef({ zoomLevel, setZoomLevel });
  useSettingsRef.current = { zoomLevel, setZoomLevel };
  // Force compact density on mobile to reclaim vertical space
  const uiDensity = isMobile ? 'compact' : rawUiDensity;
  const zoomFraction = cssZoomLevel / 100;
  // Howl Navigator (rail-less launcher) engages only in the default layout on
  // desktop; classic layout and mobile/tablet keep the existing <Sidebar>.
  const useNavigator = serverLayout === 'default' && breakpointTier === 'desktop';
  // Rail-less Navigator: a fixed logo trigger floats at the top-left (48px at
  // left:14, top:12), so each page insets its leading panel to keep controls
  // clear of it — sidebars/deck inset locally; full-width pages drop below it.
  const navTopInset = useNavigator ? 60 : 0;
  // 72 = the old rail width; the floating 48px logo (left:14 → right edge 62)
  // then clears the deck bar's content + bottom hairline by ~10px, so it sits
  // alone in the top-left corner instead of the divider ramming into it.
  const navLeftInset = useNavigator ? 72 : 0;

  // Store selectors
  const currentUser = useAuthStore(s => s.currentUser)!;
  const currentUserStatus = useAuthStore(s => s.currentUserStatus);
  const showMfaBanner = useAuthStore(s => s.showMfaBanner);

  const activeServerId = useNavigationStore(s => s.activeServerId);
  const activeChannelId = useNavigationStore(s => s.activeChannelId);
  const activeDmChannelId = useNavigationStore(s => s.activeDmChannelId);
  const templateUrlCode = useNavigationStore(s => s.templateUrlCode);
  const accountDeepLink = useNavigationStore(s => s.accountDeepLink);
  const calendarActive = useNavigationStore(s => s.calendarActive);
  const selectedQuickTextChannelId = useNavigationStore(s => s.selectedQuickTextChannelId);
  const isQuickTextOpen = useNavigationStore(s => s.isQuickTextOpen);

  // Subscribe directly so nested mutations — new channels, categories,
  // renames, reorders — propagate to ChannelList/Sidebar in real time.
  // Gating on a join'd id list left `servers` stale until a refresh.
  const servers = useServerStore(s => s.servers);
  // Subscribe directly so role/nickname/avatar updates (where member count
  // doesn't change) still propagate to the members column in real time.
  const serverMembers = useServerStore(s => s.serverMembers as ServerMember[]);
  const serverOwnerId = useServerStore(s => s.serverOwnerId);

  // messages: scoped to activeChannelId to avoid re-rendering on every message in any channel
  const stageTextMessagesFromStore = useMessageStore(useCallback((s: { messages: Record<string, any[]> }) => s.messages[activeChannelId] ?? EMPTY_MESSAGES, [activeChannelId]));
  const pinnedRevision = useMessageStore(s => s.pinnedRevision);

  // dmChannels: read via getState() in callbacks/JSX to avoid re-rendering on every DM update
  const serverNotifications = useNotificationStore(s => s.serverNotifications);
  const notificationCounts = useNotificationStore(s => s.notificationCounts);
  const unreadDmChannelIds = useNotificationStore(s => s.unreadDmChannelIds);

  const connectedVoiceChannelId = useVoiceStore(s => s.connectedVoiceChannelId);
  const connectedStageChannelId = useVoiceStore(s => s.connectedStageChannelId);
  useIdleAutoLock(!!connectedVoiceChannelId || !!connectedStageChannelId || !!props.activeDmCallChannelId);
  const voiceChannelParticipants = useVoiceStore(useShallow(s => s.voiceChannelParticipants));
  // allVoiceChannelParticipants: ChannelPanelAside subscribes directly
  // serverVoiceSummary: Sidebar + FriendsView subscribe directly
  // serverStageSummary: FriendsView subscribes directly
  const activeStageSessions = useVoiceStore(useShallow(s => s.activeStageSessions));
  const stageSettingsModal = useVoiceStore(s => s.stageSettingsModal);
  const isMuted = useVoiceStore(s => s.isMuted);
  const isDeafened = useVoiceStore(s => s.isDeafened);
  // Shared mute helper below uses screenStream + voiceSettings (both read
  // further down). Computed inline at the VoiceRemoteAudio call site to avoid
  // reshuffling declaration order of voiceSettings.
  const serverMuted = useVoiceStore(s => s.serverMuted);
  const serverDeafened = useVoiceStore(s => s.serverDeafened);
  const isScreenSharing = useVoiceStore(s => s.isScreenSharing);
  const isCameraOn = useVoiceStore(s => s.isCameraOn);
  const screenStream = useVoiceStore(s => s.screenStream);
  const cameraStream = useVoiceStore(s => s.cameraStream);
  const showScreenSharePicker = useVoiceStore(s => s.showScreenSharePicker);
  const screenShareQuality = useVoiceStore(s => s.screenShareQuality);
  const participantVolumes = useVoiceStore(useShallow(s => s.participantVolumes));

  const channelThreads = useThreadPollStore(s => s.channelThreads);
  const activeThread = useThreadPollStore(s => s.activeThread);
  const unreadThreadIds = useThreadPollStore(s => s.unreadThreadIds);
  const unreadThreadCounts = useThreadPollStore(s => s.unreadThreadCounts);

  const calendarEvents = useCalendarStore(s => s.calendarEvents);
  const calendarCreateModal = useCalendarStore(s => s.calendarCreateModal);
  const calendarLoading = useCalendarStore(s => s.calendarLoading);

  const userProfileTarget = useUiStore(s => s.userProfileTarget);
  const userContextMenuTarget = useUiStore(s => s.userContextMenuTarget);
  const fullProfileTarget = useUiStore(s => s.fullProfileTarget);
  const nicknameModal = useUiStore(s => s.nicknameModal);
  const modViewTarget = useUiStore(s => s.modViewTarget);
  const dmRemoveFriendConfirm = useUiStore(s => s.dmRemoveFriendConfirm);
  const destructiveConfirm = useUiStore(s => s.destructiveConfirm);
  const forwardPayload = useUiStore(s => s.forwardPayload);
  const serverContextAction = useUiStore(s => s.serverContextAction);
  const recoveryKeyModal = useUiStore(s => s.recoveryKeyModal);
  const recoveryKeyShowHint = useUiStore(s => s.recoveryKeyShowHint);
  const e2ePassphraseModal = useUiStore(s => s.e2ePassphraseModal);
  const showRecoveryReminder = useUiStore(s => s.showRecoveryReminder);
  const showE2eInfoBanner = useUiStore(s => s.showE2eInfoBanner);
  const activeWelcomeServerId = useCommunityStore(s => s.activeWelcomeServerId);
  const activeOnboardingServerId = useCommunityStore(s => s.activeOnboardingServerId);
  const pollModalOpen = useUiStore(s => s.pollModalOpen);
  const threadCreationModal = useUiStore(s => s.threadCreationModal);
  const threadBrowserOpen = useUiStore(s => s.threadBrowserOpen);
  const launcherOpen = useUiStore(s => s.launcherOpen);
  // Close the navigator if it stops being eligible (window narrowed below
  // desktop, or layout switched to classic) so it can't silently re-open later.
  useEffect(() => {
    if (!useNavigator && launcherOpen) useUiStore.getState().setLauncherOpen(false);
  }, [useNavigator, launcherOpen]);
  const deleteChannelConfirm = useUiStore(s => s.deleteChannelConfirm);
  const openChannelSettingsId = useUiStore(s => s.openChannelSettingsId);
  const openCategorySettingsId = useUiStore(s => s.openCategorySettingsId);

  const isOffline = useAppStore(s => s.isOffline);
  const channelLoadError = useAppStore(s => s.channelLoadError);
  const dmLoadError = useAppStore(s => s.dmLoadError);
  const membersLoadError = useAppStore(s => s.membersLoadError);
  const floatingBarDocked = useAppStore(s => s.floatingBarDocked);
  const sidebarWidth = useAppStore(s => s.sidebarWidth);
  const updateReady = useAppStore(s => s.updateReady);
  const updateError = useAppStore(s => s.updateError);
  const pinnedCatRevision = useAppStore(s => s.pinnedCatRevision);

  const blockedUserIds = useSocialStore(s => s.blockedUserIds);

  // Refs
  const threadBrowserBtnRef = useRef<HTMLDivElement | null>(null);
  const quickTextChannelIdRef = useRef<string | null>(null);

  // Derived/memoized values
  const displayUser = useMemo<User | null>(() => currentUser ? { ...currentUser, status: currentUserStatus } : null, [currentUser, currentUserStatus]);
  const allUsers = useMemo(() => (displayUser ? [displayUser] : []), [displayUser]);

  const activeServer = useMemo(() => servers.find(s => s.id === activeServerId), [servers, activeServerId]);
  const activeChannel = useMemo(() => activeServer?.channels.find(c => c.id === activeChannelId) || activeServer?.channels[0], [activeServer, activeChannelId]);

  // Mobile/tablet: the anchored UserProfilePopup is unusable on touch — its 380px
  // width gets cropped against the click point and there's no clean dismiss target.
  // Redirect straight to FullProfileModal, which has a proper full-screen mobile layout.
  useEffect(() => {
    if (!userProfileTarget) return;
    if (!isMobile && !isTablet) return;
    const serverId = activeServerId === 'dm' ? undefined : activeServer?.id;
    handleOpenFullProfile(userProfileTarget.user, serverId);
  }, [userProfileTarget, isMobile, isTablet, activeServerId, activeServer?.id, handleOpenFullProfile]);

  const pinnedChannelIdsForActiveServer = useMemo(
    () => (activeServerId && activeServerId !== 'home' ? getPinnedForServer(activeServerId) : []),
    [activeServerId, pinnedRevision],
  );

  const pinnedCategoryIdsForActiveServer = useMemo(
    () => (activeServerId && activeServerId !== 'home' ? getPinnedCategoriesForServer(activeServerId) : []),
    [activeServerId, pinnedCatRevision],
  );

  const membersForList = useMemo(() => {
    const isServerView = isRealServerId(activeServerId);
    const list = serverMembers.length > 0
      ? serverMembers
      : (isServerView && displayUser ? [displayUser] : allUsers);
    if (!displayUser) return list;
    return list.map((m) => {
      const base = m.id === displayUser.id ? { ...m, status: currentUserStatus } : m;
      const withRole = base as ServerMember;
      return { ...base, role: withRole.role, roleColor: withRole.roleColor, roleStyle: withRole.roleStyle };
    });
  }, [serverMembers, allUsers, displayUser, currentUserStatus, activeServerId]);

  const connectedVoiceChannel = useMemo(() => {
    if (!connectedVoiceChannelId) return null;
    for (const server of servers) {
      const found = server.channels.find(c => c.id === connectedVoiceChannelId);
      if (found) return found;
    }
    return null;
  }, [connectedVoiceChannelId, servers]);

  const connectedVoiceServerId = useMemo(() => {
    if (!connectedVoiceChannelId) return null;
    for (const server of servers) {
      if (server.channels.some(c => c.id === connectedVoiceChannelId)) return server.id;
    }
    return null;
  }, [connectedVoiceChannelId, servers]);

  const connectedVoiceServerName = useMemo(() => {
    if (!connectedVoiceServerId) return null;
    return servers.find(s => s.id === connectedVoiceServerId)?.name ?? null;
  }, [connectedVoiceServerId, servers]);

  const showVoiceView = useMemo(() => activeChannel?.type === 'voice', [activeChannel?.type]);
  const showStageView = useMemo(() => activeChannel?.type === 'stage', [activeChannel?.type]);
  const showForumView = useMemo(() => activeChannel?.type === 'forum', [activeChannel?.type]);
  const showRolePickerView = useMemo(() => activeChannel?.type === 'role_picker', [activeChannel?.type]);

  const isServerView = typeof activeServerId === 'string' && !['home', 'friends', 'dm', 'account', 'discover', 'notifications'].includes(activeServerId);

  const chatAreaVoiceParticipants = useMemo(() => {
    const mapped = voiceChannelParticipants.map((p) => ({
      id: p.userId,
      username: p.username,
      discriminator: (p as any).discriminator,
      avatar: p.avatar,
      nameColor: p.nameColor,
      nameFont: p.nameFont,
      nameEffect: p.nameEffect,
      avatarEffect: p.avatarEffect,
      effectivePlan: p.effectivePlan,
      roleColor: p.roleColor,
      roleStyle: p.roleStyle,
      // Mute/deafen state — surfaced on the side-panel avatar like the
      // call-card avatars do (server-deafen > server-mute > deafen > mute).
      isMuted: p.isMuted,
      isDeafened: p.isDeafened,
      serverMuted: p.serverMuted,
      serverDeafened: p.serverDeafened,
    }));
    if (connectedVoiceChannelId && displayUser && !mapped.some((p) => p.id === displayUser.id)) {
      const du = displayUser as typeof displayUser & {
        nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string;
      };
      mapped.unshift({
        id: displayUser.id,
        username: displayUser.username,
        discriminator: displayUser.discriminator ?? undefined,
        avatar: displayUser.avatar ?? undefined,
        nameColor: du.nameColor,
        nameFont: du.nameFont,
        nameEffect: du.nameEffect,
        avatarEffect: du.avatarEffect,
        effectivePlan: displayUser.effectivePlan ?? displayUser.stripePlan ?? undefined,
        roleColor: undefined,
        roleStyle: undefined,
        // Local user's own state from voiceStore — covers the brief window
        // between joining and the server echoing back the participant list.
        isMuted,
        isDeafened,
        serverMuted,
        serverDeafened,
      });
    }
    return mapped;
  }, [voiceChannelParticipants, connectedVoiceChannelId, displayUser, isMuted, isDeafened, serverMuted, serverDeafened]);

  const _lastDmTypingEmit = useRef(0);
  const handleDmTyping = useMemo(
    () => activeDmChannelId ? () => {
      const now = Date.now();
      if (now - _lastDmTypingEmit.current < 2000) return;
      _lastDmTypingEmit.current = now;
      socketService.emitTyping({ dmChannelId: activeDmChannelId });
    } : undefined,
    [activeDmChannelId],
  );

  const canCreatePoll = useMemo(() => {
    if (activeDmChannelId) return true;
    const server = servers.find((s) => s.id === activeServerId);
    return serverHasPerm(server, 'createPolls');
  }, [activeServerId, activeDmChannelId, servers]);

  const canCreateThread = useMemo(() => {
    if (activeDmChannelId) return false;
    const server = servers.find((s) => s.id === activeServerId);
    return serverHasPerm(server, 'createThreads');
  }, [activeServerId, activeDmChannelId, servers]);

  const isInvitedToSpeak = useMemo(() => {
    if (!activeChannelId || !currentUser) return false;
    const session = activeStageSessions[activeChannelId];
    if (!session) return false;
    if (session.invitedSpeakerUserIds?.includes(currentUser.id)) return true;
    if (session.invitedRoleIds?.length) {
      const member = serverMembers.find(m => m.id === currentUser.id);
      if (member && 'roleId' in member && session.invitedRoleIds.includes((member as { roleId?: string }).roleId ?? '')) return true;
    }
    return false;
  }, [activeChannelId, activeStageSessions, currentUser, serverMembers]);

  // Fetch active stage session when navigating to a stage channel that isn't in the store yet
  useEffect(() => {
    if (!activeChannel || activeChannel.type !== 'stage' || !isServerView || !activeServerId) return;
    const channelId = activeChannel.id;
    if (activeStageSessions[channelId]) return;

    let cancelled = false;
    apiClient.getStage(channelId, activeServerId as string)
      .then((session) => {
        if (cancelled || !session) return;
        useVoiceStore.getState().setActiveStageSessions((prev) => {
          if (prev[channelId]) return prev;
          return { ...prev, [channelId]: normalizeStageSession(session) };
        });
      })
      .catch(() => { /* best effort — empty state will show with Start button */ });
    return () => { cancelled = true; };
  }, [activeChannel?.id, activeChannel?.type, activeServerId, isServerView]);

  // Auto-dismiss E2E info banner
  useEffect(() => {
    if (showE2eInfoBanner) {
      const timer = setTimeout(() => useUiStore.getState().setShowE2eInfoBanner(false), 12000);
      return () => clearTimeout(timer);
    }
  }, [showE2eInfoBanner]);

  // Surface 429 rate limits via global toast
  // Dedupe within 5s to avoid spamming during a sustained 429 burst.
  useEffect(() => {
    let lastShownAt = 0;
    apiClient.setRateLimitHandler(({ retryAfter }) => {
      const now = Date.now();
      if (now - lastShownAt < 5000) return;
      lastShownAt = now;
      showGlobalToast(`You're being rate limited. Please wait ~${retryAfter}s.`, 'warning');
    });
    return () => apiClient.setRateLimitHandler(null);
  }, [showGlobalToast]);

  // Welcome screen — first-visit modal
  // When a member opens a server we haven't shown the welcome screen for yet,
  // fetch its config; if the owner enabled it and curated channels, surface
  // the modal once. Servers without a welcome screen are silently marked seen
  // so we never refetch them.
  useEffect(() => {
    if (!activeServerId || !isRealServerId(activeServerId)) return;
    const serverId = activeServerId;
    const community = useCommunityStore.getState();
    if (community.hasSeenWelcome(serverId)) return;
    if (community.activeWelcomeServerId === serverId) return;

    let cancelled = false;
    apiClient.welcomeScreenGet(serverId)
      .then((resp) => {
        if (cancelled) return;
        if (resp.enabled && resp.channels.length > 0) {
          useCommunityStore.getState().showWelcomeModal(serverId);
        } else {
          useCommunityStore.getState().markWelcomeSeen(serverId);
        }
      })
      .catch(() => {
        if (cancelled) return;
        useCommunityStore.getState().markWelcomeSeen(serverId);
      });
    return () => { cancelled = true; };
  }, [activeServerId]);

  // Mandatory onboarding — first-visit role-picker gate
  // When a member opens a server that has onboarding enabled, a role picker,
  // and no recorded completion, show the mandatory onboarding modal. The
  // DURABLE show-once gate is the server-side `onboardingCompletedAt` (roams
  // across devices); the session guard below only prevents refetch loops on
  // tab/server switches. Fail-open on any error so a transient failure never
  // traps the user behind a modal that won't open.
  useEffect(() => {
    if (!activeServerId || !isRealServerId(activeServerId)) return;
    const serverId = activeServerId;
    const community = useCommunityStore.getState();
    if (community.hasShownOnboardingThisSession(serverId)) return;
    if (community.activeOnboardingServerId === serverId) return;

    let cancelled = false;
    Promise.all([
      apiClient.getServerSettings(serverId),
      apiClient.rolePickersList(serverId),
      apiClient.getMyServerProfile(serverId),
    ])
      .then(([settings, pickerResp, profile]) => {
        if (cancelled) return;
        if (settings.onboardingEnabled && pickerResp.picker != null && profile.onboardingCompletedAt == null) {
          useCommunityStore.getState().showOnboardingModal(serverId);
        } else {
          // Conditions not met — mark shown-this-session to avoid refetch churn.
          // The durable gate is onboardingCompletedAt; if conditions later change
          // mid-session that's acceptable (it surfaces next session / next device).
          useCommunityStore.getState().markOnboardingShownThisSession(serverId);
        }
      })
      .catch(() => {
        if (cancelled) return;
        // Fail-open: don't trap the user on a transient error.
        useCommunityStore.getState().markOnboardingShownThisSession(serverId);
      });
    return () => { cancelled = true; };
  }, [activeServerId]);

  // Lazy-hydrate channels/categories for the active server
  // GET /api/servers returns a slim payload (no channels/categories) to keep
  // the bootstrap path cheap during a flash flood of logins. We hydrate the
  // active server on demand here. Servers stay hydrated for the session.
  useEffect(() => {
    if (!activeServerId || !isRealServerId(activeServerId)) return;
    const serverId = activeServerId;
    const current = useServerStore.getState().servers.find(s => s.id === serverId);
    // Already hydrated — channels were populated by getServer or a mutation.
    if (current && current.channels.length > 0) return;

    let cancelled = false;
    apiClient.getServer(serverId)
      .then((full) => {
        if (cancelled) return;
        useServerStore.getState().updateServer(serverId, () => full);
      })
      .catch((err) => {
        // 403 = no longer a member (existing membership flow handles eviction).
        // Other errors leave the server in slim state; user can retry by clicking
        // elsewhere and back. Don't surface a toast — the empty channel list is
        // self-explanatory and a hydration retry is cheap.
        console.warn('[hydrate] failed to hydrate server', { serverId, err });
      });
    return () => { cancelled = true; };
  }, [activeServerId]);

  // Zoom keyboard shortcuts
  useEffect(() => {
    const isElectronApp = detectElectron();

    // Electron handles shortcuts via IPC from main.js → preload.js → onZoomCommand
    if (isElectronApp) {
      const cleanup = window.electron?.onZoomCommand?.((direction: 'in' | 'out' | 'reset') => {
        const { zoomLevel: current, setZoomLevel: set } = useSettingsRef.current;
        if (direction === 'in') set(Math.min(200, current + 5));
        else if (direction === 'out') set(Math.max(50, current - 5));
        else if (direction === 'reset') set(100);
      });
      return () => cleanup?.();
    }

    // Web: listen for Ctrl/Cmd +/- and 0
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '0') {
        e.preventDefault();
        e.stopPropagation();
        const { zoomLevel: current, setZoomLevel: set } = useSettingsRef.current;
        if (e.key === '+' || e.key === '=') set(Math.min(200, current + 5));
        else if (e.key === '-') set(Math.max(50, current - 5));
        else if (e.key === '0') set(100);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true); // capture phase
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  /** User IDs of people we're currently in a voice chat with (server voice or DM call), including self. */
  const voiceParticipantUserIds = useMemo(() => connectedVoiceChannelId
    ? [...voiceRemoteParticipants.map((p) => p.userId), ...(displayUser ? [displayUser.id] : [])]
    : activeDmCallChannelId
      ? [...dmCallParticipantIds, ...(displayUser ? [displayUser.id] : [])]
      : [], [connectedVoiceChannelId, voiceRemoteParticipants, displayUser, activeDmCallChannelId, dmCallParticipantIds]);

  const dmCallDisplayName = useMemo(() => {
    if (!activeDmCallChannelId) return null;
    const ch = useDmStore.getState().dmChannels.find(c => c.id === activeDmCallChannelId);
    if (!ch) return 'Call';
    return ch.isGroup
      ? (ch.name || ch.otherUsers?.map(u => u.username).join(', ') || 'Group Call')
      : (ch.otherUser?.username ?? 'Call');
  }, [activeDmCallChannelId]);

  // Set→Array conversions (avoids new references on every render)
  const otherServerMembersMemo = useMemo(() => serverMembers.filter((m) => m.id !== displayUser?.id), [serverMembers, displayUser?.id]);
  const voiceRemoteAudioParticipants = useMemo(() => voiceRemoteParticipants.map((p) => ({ userId: p.userId, stream: p.stream })), [voiceRemoteParticipants]);

  const quickTextChannels = useMemo(() => activeServer?.channels.filter((c) => c.type === 'text') ?? EMPTY_CHANNELS, [activeServer]);
  const activeServerTextForumChannels = useMemo(() => (activeServer?.channels ?? EMPTY_CHANNELS).filter((c: Channel) => c.type === 'text' || c.type === 'forum'), [activeServer]);
  const activeServerVoiceChannels = useMemo(() => (activeServer?.channels ?? EMPTY_CHANNELS).filter((c: Channel) => c.type === 'voice'), [activeServer]);
  const activeServerTextChannels = useMemo(() => (activeServer?.channels ?? EMPTY_CHANNELS).filter((c: Channel) => c.type === 'text'), [activeServer]);
  const stageTextMessages = stageTextMessagesFromStore;
  const quickTextChannelId = useMemo(() => {
    const first = quickTextChannels[0];
    if (selectedQuickTextChannelId && quickTextChannels.some((c) => c.id === selectedQuickTextChannelId))
      return selectedQuickTextChannelId;
    return first?.id ?? null;
  }, [quickTextChannels, selectedQuickTextChannelId]);
  quickTextChannelIdRef.current = quickTextChannelId;
  const quickTextChannel = useMemo(() => {
    if (!quickTextChannelId) return null;
    return quickTextChannels.find(c => c.id === quickTextChannelId) ?? null;
  }, [quickTextChannels, quickTextChannelId]);
  const handleTextChannelHeaderClick = useMemo(
    () => serverHasPerm(activeServer, 'manageChannels')
      ? () => activeChannel && useUiStore.getState().setOpenChannelSettingsId(activeChannel.id)
      : undefined,
    [activeServer, activeChannel],
  );

  // Stable callback refs
  const stableUploadFile = useCallback(
    (file: File) => apiClient.uploadFile(file),
    [],
  );

  /** Upload wrapper for DM contexts: encrypts files via E2E — never falls back to plaintext. */
  const dmEncryptedUploadFile = useCallback(async (file: File) => {
    const channelId = useNavigationStore.getState().activeDmChannelId;
    if (!channelId) {
      throw new Error('No active DM channel — cannot upload file.');
    }
    const { encryptAndUploadFile } = await import('../services/dmEncryption');
    const result = await encryptAndUploadFile(file, channelId);
    e2eeFileMetaRef.current.set(result.url, {
      key: result.key,
      name: result.name,
      type: result.type,
      size: result.size,
      thumbUrl: result.thumbUrl,
      thumbKey: result.thumbKey,
      thumbWidth: result.thumbWidth,
      thumbHeight: result.thumbHeight,
    });
    return {
      url: result.url,
      name: result.name,
      contentType: result.type,
      size: result.size,
      width: result.thumbWidth ?? null,
      height: result.thumbHeight ?? null,
    };
  }, []);

  const stableGetToken = useCallback(() => apiClient.getToken(), []);
  const stableGetChannelPins = useCallback(
    (channelId: string) => apiClient.getChannelPins(channelId),
    [],
  );

  const handleUserClick = useCallback((user: User, e: React.MouseEvent) => useUiStore.getState().setUserProfileTarget({ user, anchorRect: { left: e.clientX, top: e.clientY + 8 } }), []);
  const handleUserRightClick = useCallback((user: User, e: React.MouseEvent) => useUiStore.getState().setUserContextMenuTarget({ user, x: e.clientX, y: e.clientY }), []);

  const handleSelectChannel = useCallback((channelId: string) => navigate(`/channels/${useNavigationStore.getState().activeServerId}/${channelId}`), [navigate]);
  const handleServerContextMenu = useCallback((serverId: string, action: ServerContextAction) => {
    useUiStore.getState().setServerContextAction({ serverId, action });
    navigate(`/channels/${serverId}`);
  }, [navigate]);
  const handleFloatingBarDockToggle = useCallback(() => useAppStore.getState().setFloatingBarDocked(!useAppStore.getState().floatingBarDocked), []);

  const handleDismissNotification = useCallback((id: string) => useNotificationStore.getState().setServerNotifications((n) => n.filter((x) => x.id !== id)), []);
  const handleClearAllNotifications = useCallback(() => useNotificationStore.getState().setServerNotifications([]), []);

  // Adapter wrappers
  const adaptedSendMessage = useCallback((content: string, replyToMessageId?: string, attachment?: { url: string; name: string; contentType?: string }) => sendChannelMessage(activeChannelId, content, replyToMessageId, attachment, undefined, showGlobalToast as any), [activeChannelId, showGlobalToast]);
  const adaptedDeleteMessage = useCallback((messageId: string) => promptDeleteMessage(activeChannelId, messageId), [activeChannelId]);
  const adaptedEditMessage = useCallback((messageId: string, newContent: string) => editChannelMessage(activeChannelId, messageId, newContent, showGlobalToast as any), [activeChannelId, showGlobalToast]);
  const adaptedReportMessage = useCallback((messageId: string) => reportChannelMessage(activeChannelId, messageId, currentUser?.id), [activeChannelId, currentUser?.id]);
  const adaptedReactMessage = useCallback((messageId: string, emoji: string) => reactChannelMessage(activeChannelId, messageId, emoji, currentUser?.id ?? ''), [activeChannelId, currentUser?.id]);
  const adaptedPinMessage = useCallback((messageId: string) => pinChannelMessage(activeChannelId, messageId), [activeChannelId]);
  const adaptedUnpinMessage = useCallback((messageId: string) => unpinChannelMessage(activeChannelId, messageId), [activeChannelId]);
  const adaptedSendDm = useCallback((dmChannelId: string, content: string, replyToMessageId?: string, attachment?: { url: string; name: string; contentType?: string }, tier?: MlsTier) => sendDmMessage(dmChannelId, content, { replyToMessageId, attachment, tier, e2eeFileMeta: e2eeFileMetaRef.current as any, showToast: showGlobalToast as any }), [showGlobalToast]);
  const adaptedEditDm = useCallback((dmChannelId: string, messageId: string, newContent: string) => editDmMessage(dmChannelId, messageId, newContent, useDmStore.getState().dmChannels, showGlobalToast as any), [showGlobalToast]);
  const adaptedReportDm = useCallback((dmChannelId: string, messageId: string) => reportDmMessage(dmChannelId, messageId, currentUser?.id), [currentUser?.id]);
  const adaptedReactDm = useCallback((dmChannelId: string, messageId: string, emoji: string) => reactDmMessage(dmChannelId, messageId, emoji, currentUser?.id ?? ''), [currentUser?.id]);
  const adaptedCreateServer = useCallback((name: string, options?: { icon?: string; template?: string; community?: boolean }) => createServer(name, navigate, options), [navigate]);
  // Discard the JoinByInviteResult — callers in Sidebar / chat invite embeds
  // are fire-and-forget. The /invite/:code page (InviteResolvePage) consumes
  // joinByInvite directly and handles the application_required branch itself.
  const adaptedJoinByInvite = useCallback(async (code: string): Promise<void> => {
    await joinByInvite(code, navigate);
  }, [navigate]);
  const adaptedLeaveServer = useCallback((serverId: string) => leaveServer(serverId, navigate, joinedServerRoomsRef), [navigate]);
  const adaptedTransferAndLeave = useCallback((serverId: string, newOwnerId: string) => transferOwnershipAndLeave(serverId, newOwnerId, navigate, joinedServerRoomsRef), [navigate]);
  const adaptedDeleteServer = useCallback((serverId: string, password?: string) => deleteServer(serverId, navigate, password, joinedServerRoomsRef), [navigate]);
  const adaptedCreateOrSelectDM = useCallback((otherUserId: string) => createOrSelectDM(otherUserId, navigate), [navigate]);
  const adaptedSendMessageAndOpenDM = useCallback((otherUserId: string, content: string) => sendMessageAndOpenDM(otherUserId, content, navigate, e2eeFileMetaRef.current as any), [navigate]);
  const adaptedCreateGroupDM = useCallback((memberIds: string[]) => createGroupDM(memberIds, navigate), [navigate]);
  const adaptedLeaveGroupDM = useCallback((dmChannelId: string) => leaveGroupDM(dmChannelId, navigate, activeDmChannelId), [navigate, activeDmChannelId]);
  const pollContext = useMemo(() => ({ activeServerId: activeServerId as string | null, activeChannelId, activeDmChannelId }), [activeServerId, activeChannelId, activeDmChannelId]);
  const adaptedVotePoll = useCallback((pollId: string, optionId: string) => votePoll(pollId, optionId, pollContext), [pollContext]);
  const adaptedRemoveVotePoll = useCallback((pollId: string, optionId: string) => removeVotePoll(pollId, optionId, pollContext), [pollContext]);
  const adaptedClosePoll = useCallback((pollId: string) => closePoll(pollId, pollContext), [pollContext]);
  const adaptedDeletePoll = useCallback((pollId: string) => deletePoll(pollId, pollContext), [pollContext]);
  const adaptedOpenThread = useCallback((thread: Thread) => openThread(thread, activeServerId as string | null), [activeServerId]);
  const adaptedCreateThreadFromMenu = useCallback(() => createThreadFromMenu(activeChannelId), [activeChannelId]);
  const adaptedDeleteEvent = useCallback((eventId: string) => deleteEvent(activeServerId as string, eventId), [activeServerId]);
  const adaptedRsvpEvent = useCallback((eventId: string, status: 'GOING' | 'INTERESTED' | 'DECLINED') => rsvpEvent(activeServerId as string, eventId, status), [activeServerId]);
  const adaptedRemoveRsvp = useCallback((eventId: string) => removeRsvp(activeServerId as string, eventId), [activeServerId]);
  const adaptedSubmitEvent = useCallback((data: any) => submitEvent(activeServerId as string, data, calendarCreateModal.editEvent ?? undefined), [activeServerId, calendarCreateModal.editEvent]);
  const adaptedLeaveVoiceChannel = useCallback(() => leaveVoiceChannel(navigate, { isCameraOn, isScreenSharing, toggleCamera, toggleScreenShare }), [navigate, isCameraOn, isScreenSharing, toggleCamera, toggleScreenShare]);
  const adaptedRaiseHand = useCallback(() => raiseHand(connectedStageChannelId ?? '', activeServerId as string), [connectedStageChannelId, activeServerId]);
  const adaptedLowerHand = useCallback((targetUserId?: string) => lowerHand(connectedStageChannelId ?? '', activeServerId as string, targetUserId), [connectedStageChannelId, activeServerId]);
  const adaptedJoinAsSpeaker = useCallback(() => joinStageAsSpeaker(activeChannelId, activeServerId as string), [activeChannelId, activeServerId]);
  const adaptedMoveSelfToAudience = useCallback(() => moveSelfToAudience(connectedStageChannelId ?? '', activeServerId as string), [connectedStageChannelId, activeServerId]);
  const adaptedSendThreadMessage = useCallback((content: string, replyToMessageId?: string, attachment?: { url: string; name: string; contentType?: string; width?: number | null; height?: number | null }) => sendThreadMessage(activeServerId as string, activeThread?.id ?? '', content, replyToMessageId, attachment, showGlobalToast as any), [activeServerId, activeThread?.id, showGlobalToast]);
  const adaptedServerCreatedFromTemplate = useCallback((server: { id: string; name: string; channels: Array<{ id: string; name: string; type: string }> }) => handleServerCreatedFromTemplate(server, navigate), [navigate]);

  // Canonical nav-target dispatcher — shared by the legacy Sidebar and the new
  // Howl Navigator so the dm/lastDm/localStorage logic stays single-sourced.
  const handleNavTarget = useCallback((target: NavigationTarget) => {
    if (target === 'home') navigate('/home');
    else if (target === 'friends') navigate('/friends');
    else if (target === 'dm') {
      const lastDm = activeDmChannelId || (() => { try { return localStorage.getItem('howl_last_dm_channel'); } catch { return null; } })();
      navigate(lastDm ? `/channels/@me/${lastDm}` : '/channels/@me');
    }
    else if (target === 'account') navigate('/settings');
    else if (target === 'notifications') navigate('/notifications');
    else if (target === 'discover') navigate('/discover');
    else navigate(`/channels/${target}`);
  }, [navigate, activeDmChannelId]);
  const adaptedStartStage = useCallback((data: any) => startStage(stageSettingsModal?.channelId ?? '', activeServerId as string, data, navigate), [stageSettingsModal?.channelId, activeServerId, navigate]);
  const adaptedEditStage = useCallback((data: any) => editStage(stageSettingsModal?.channelId ?? '', activeServerId as string, data), [stageSettingsModal?.channelId, activeServerId]);
  const adaptedSubmitCreateThread = useCallback((data: { name: string; parentMessageId: string; autoArchive: boolean; autoArchiveDuration: string }) => submitCreateThread(data, activeServerId as string, activeChannelId), [activeServerId, activeChannelId]);
  const adaptedCreatePollFinal = useCallback((data: { question: string; options: (string | { text: string; emoji?: string })[]; allowMultiple: boolean; anonymous: boolean; duration: string }) => createPoll(data, pollContext), [pollContext]);
  const adaptedLoadOlderDm = useCallback(() => loadOlderDmMessages(activeDmChannelId ?? '', useDmStore.getState().dmChannels), [activeDmChannelId]);
  const qtChannelId = useMemo(() => {
    const server = servers.find((s) => s.id === activeServerId);
    const textChannels = server?.channels.filter((c) => c.type === 'text') ?? [];
    return selectedQuickTextChannelId && textChannels.some((c) => c.id === selectedQuickTextChannelId) ? selectedQuickTextChannelId : textChannels[0]?.id ?? '';
  }, [servers, activeServerId, selectedQuickTextChannelId]);
  const adaptedQtSend = useCallback((content: string, replyToMessageId?: string, attachment?: { url: string; name: string; contentType?: string }) => sendChannelMessage(qtChannelId, content, replyToMessageId, attachment, undefined, showGlobalToast as any), [qtChannelId, showGlobalToast]);
  const adaptedQtDelete = useCallback((messageId: string) => promptDeleteMessage(qtChannelId, messageId), [qtChannelId]);
  const adaptedQtEdit = useCallback((messageId: string, newContent: string) => editChannelMessage(qtChannelId, messageId, newContent, showGlobalToast as any), [qtChannelId, showGlobalToast]);
  const adaptedQtReact = useCallback((messageId: string, emoji: string) => reactChannelMessage(qtChannelId, messageId, emoji, currentUser?.id ?? ''), [qtChannelId, currentUser?.id]);
  const adaptedQtPin = useCallback((messageId: string) => pinChannelMessage(qtChannelId, messageId), [qtChannelId]);
  const adaptedQtUnpin = useCallback((messageId: string) => unpinChannelMessage(qtChannelId, messageId), [qtChannelId]);

  // DM view callbacks
  const handleDmUserClick = useCallback((user: UserWithRole, e: React.MouseEvent) => {
    useUiStore.getState().setUserProfileTarget({ user, anchorRect: { left: e.clientX, top: e.clientY + 8 } });
  }, []);
  const handleDmUserRightClick = useCallback((user: UserWithRole, e: React.MouseEvent) => {
    useUiStore.getState().setUserContextMenuTarget({ user, x: e.clientX, y: e.clientY });
  }, []);
  const handleDirectMessageContextMenu = useCallback((user: UserWithRole, dmChannelId: string, e: React.MouseEvent) => {
    useUiStore.getState().setUserContextMenuTarget({ user, x: e.clientX, y: e.clientY, dmChannelId });
  }, []);

  // renderContent
  const renderContent = () => {
    switch(activeServerId) {
      case 'discover':
        return <ContentErrorBoundary><Suspense fallback={null}><DiscoverPage embedded /></Suspense></ContentErrorBoundary>;
      case 'home':
        return <ContentErrorBoundary><Suspense fallback={null}><HomeView onNavigateToDM={(userId) => { adaptedCreateOrSelectDM(userId); }} onFriendRightClick={(user, e) => useUiStore.getState().setUserContextMenuTarget({ user, x: e.clientX, y: e.clientY })} onNavigateToFriends={() => navigate('/channels/@me/friends')} showGameLibrary={advancedSettings.showGameLibrary} onNavigateToSettings={() => { useNavigationStore.getState().setAccountDeepLink({ page: 'connections' }); navigate('/settings'); }} /></Suspense></ContentErrorBoundary>;
      case 'account':
        return <ContentErrorBoundary><Suspense fallback={null}><AccountView user={displayUser!} onLogout={handleLogout} onUserUpdate={(u) => useAuthStore.getState().updateCurrentUser(u)} onClose={() => { navigate('/home'); useNavigationStore.getState().setAccountDeepLink(null); }} statusBarDocked={!isMobile && floatingBarDocked} navTopInset={navTopInset} servers={servers} initialPage={accountDeepLink?.page} initialSubTab={accountDeepLink?.subTab} initialProfileServerId={accountDeepLink?.profileServerId} onKeybindPageActive={useNavigationStore.getState().setKeybindPageOpen} backgroundImage={backgroundImage} onBackgroundImageChange={setBackgroundImage} backgroundOpacity={backgroundOpacity} onBackgroundOpacityChange={setBackgroundOpacity} backgroundBlur={backgroundBlur} onBackgroundBlurChange={setBackgroundBlur} bgGifAlwaysPlay={bgGifAlwaysPlay} onBgGifAlwaysPlayChange={setBgGifAlwaysPlay} showToast={showGlobalToast} /></Suspense></ContentErrorBoundary>;
      case 'friends':
        return (
          <ContentErrorBoundary><Suspense fallback={null}>
          <FriendsView
            onCreateOrSelectDM={adaptedCreateOrSelectDM}
            onOpenDMView={() => {
              const lastDm = activeDmChannelId || (() => { try { return localStorage.getItem('howl_last_dm_channel'); } catch { return null; } })();
              navigate(lastDm ? `/channels/@me/${lastDm}` : '/channels/@me');
            }}
            onPendingCountChange={(count: number) => useNotificationStore.getState().setPendingFriendRequestCount(count)}
            onUnblock={unblockUserInDmView}
            onServerClick={(serverId) => navigate(`/channels/${serverId}`)}
            onUserClick={(user, e) => useUiStore.getState().setUserProfileTarget({ user, anchorRect: { left: e.clientX, top: e.clientY + 8 } })}
            onUserRightClick={(user, e) => useUiStore.getState().setUserContextMenuTarget({ user, x: e.clientX, y: e.clientY })}
          />
          </Suspense></ContentErrorBoundary>
        );
      case 'dm':
        if (!displayUser) {
          return (
            <div className="flex-1 flex items-center justify-center" style={{ backgroundColor: 'var(--bg-chat)' }}>
              <p className="text-t-secondary text-sm font-medium uppercase tracking-wider">{t('auth.loginToViewMessages')}</p>
            </div>
          );
        }
        return (
          <ErrorBoundary key={activeDmChannelId ?? 'dm-list'}>
          <Suspense fallback={null}><DMView
            dmUsers={[]}
            onSelectDM={(dmId: string | null) => navigate(dmId ? `/channels/@me/${dmId}` : '/channels/@me')}
            onSendDMMessage={adaptedSendDm}
            onShowToast={showGlobalToast}
            rateLimitBanner={messageRateLimitActive}
            messageSendError={messageSendError}
            dmLoadError={dmLoadError}
            onRetryLoadMessages={() => {
              if (!activeDmChannelId) return;
              useAppStore.getState().setDmLoadError(null);
              const channelId = activeDmChannelId;
              const dmChannel = useDmStore.getState().dmChannels.find((ch) => ch.id === channelId);
              apiClient.getDMMessages(channelId)
                .then(async ({ messages: msgs, hasMore, blockStatus, pinnedMessageIds: pins, encrypted }) => {
                  const isEncrypted = encrypted ?? false;
                  if (isEncrypted) setChannelEncryptionStatus(channelId, true);
                  const decryptedMsgs = await decryptDMMessages(channelId, msgs, isEncrypted, dmChannel);
                  {
                    const existing = useMessageStore.getState().dmMessages[channelId] || [];
                    const historyIds = new Set(decryptedMsgs.map((m) => m.id));
                    const realtimeOnly = existing.filter((m) => !historyIds.has(m.id));
                    useMessageStore.getState().setDmMessages(channelId, capMessages([...decryptedMsgs, ...realtimeOnly]), hasMore);
                  }
                  if (blockStatus) useDmStore.getState().setDmBlockStatus(channelId, blockStatus);
                  useMessageStore.getState().setDmPinnedIds(channelId, pins ?? []);
                })
                .catch((err) => useAppStore.getState().setDmLoadError(err instanceof Error ? err.message : 'Failed to load messages'));
            }}
            onCreateOrSelectDM={adaptedCreateOrSelectDM}
            onCreateGroupDM={adaptedCreateGroupDM}
            onAddGroupDmMembers={addGroupDmMembers}
            onUpdateGroupDM={updateGroupDM}
            onMarkDmRead={markDmRead}
            onLeaveGroupDM={adaptedLeaveGroupDM}
            onPinConversation={pinDmConversation}
            onUnpinConversation={unpinDmConversation}
            onPinMessage={pinDmMessage}
            onUnpinMessage={unpinDmMessage}
            getDMPins={getDmPins as any}
            getFriends={apiClient.getFriends.bind(apiClient)}
            allUsers={allUsers}
            onUserClick={handleDmUserClick}
            onUserRightClick={handleDmUserRightClick}
            onDirectMessageContextMenu={handleDirectMessageContextMenu}
            onDeleteDMMessage={deleteDmMessage}
            onEditDMMessage={adaptedEditDm}
            onReportDMMessage={adaptedReportDm}
            onReactDMMessage={adaptedReactDm}
            onLoadMoreDmMessages={adaptedLoadOlderDm}
            onStartVoiceCall={(dmChannelId) => {
              const start = () => { leaveOtherActiveCalls('dm'); useVoiceStore.getState().setDmCallIsInitiator(true); useVoiceStore.getState().setDmCallIncomingMlsReady(undefined); setActiveDmCallChannelId(dmChannelId); setDmCallWithVideo(false); };
              if (!ensureE2eUnlockedForCall(start)) return;
              start();
            }}
            onStartVideoCall={(dmChannelId) => {
              const start = () => { leaveOtherActiveCalls('dm'); useVoiceStore.getState().setDmCallIsInitiator(true); useVoiceStore.getState().setDmCallIncomingMlsReady(undefined); setActiveDmCallChannelId(dmChannelId); setDmCallWithVideo(true); };
              if (!ensureE2eUnlockedForCall(start)) return;
              start();
            }}
            activeDmCallChannelId={activeDmCallChannelId}
            incomingDmCall={incomingDmCall}
            incomingCallNeedsUnlock={!!incomingDmCall && isChannelEncrypted(incomingDmCall.dmChannelId) && !dmKeyManager.isUnlocked()}
            onAcceptIncomingCall={(joinWithVideo) => {
              if (!incomingDmCall) return;
              const call = incomingDmCall;
              const accept = () => {
                leaveOtherActiveCalls('dm');
                useVoiceStore.getState().setDmCallIsInitiator(false);
                useVoiceStore.getState().setDmCallIncomingMlsReady(call.mlsCallReady);
                setActiveDmCallChannelId(call.dmChannelId);
                setDmCallWithVideo(joinWithVideo);
                setIncomingDmCall(null);
              };
              if (!ensureE2eUnlockedForCall(accept)) return;
              accept();
            }}
            onDeclineIncomingCall={() => {
              if (incomingDmCall) {
                socketService.declineDmCall(incomingDmCall.dmChannelId);
                declinedDmCallChannelIds.current.set(incomingDmCall.dmChannelId, Date.now());
              }
              setIncomingDmCall(null);
            }}
            onForwardImage={(att) => useUiStore.getState().setForwardPayload({ attachment: att, sourceEncryptedDm: !!(activeDmChannelId && isChannelEncrypted(activeDmChannelId)) })}
            onForwardMessage={(p) => useUiStore.getState().setForwardPayload({ ...p, sourceEncryptedDm: !!(activeDmChannelId && isChannelEncrypted(activeDmChannelId)) })}
            onMuteDM={(dmChannelId, duration) => setDmMuted(dmChannelId, muteDurationToUntil(duration))}
            onTyping={handleDmTyping}
            uiDensity={uiDensity}
            navTopInset={navTopInset}
            onDmUnlocked={() => {
              const encryptedIds = useDmStore.getState().dmChannels.filter((ch) => ch.encrypted).map((ch) => ch.id);
              {
                const prevDm = useMessageStore.getState().dmMessages;
                const next = { ...prevDm };
                for (const id of encryptedIds) delete next[id];
                useMessageStore.getState()._setAll({ dmMessages: next });
              }
              const activeId = useNavigationStore.getState().activeDmChannelId;
              if (activeId && encryptedIds.includes(activeId)) {
                const dmChannel = useDmStore.getState().dmChannels.find((ch) => ch.id === activeId);
                apiClient.getDMMessages(activeId)
                  .then(async ({ messages: msgs, hasMore, blockStatus, pinnedMessageIds: pins, encrypted }) => {
                    const decryptedMsgs = await decryptDMMessages(activeId, msgs, encrypted ?? true, dmChannel);
                    useMessageStore.getState().setDmMessages(activeId, capMessages(decryptedMsgs), hasMore);
                    if (blockStatus) useDmStore.getState().setDmBlockStatus(activeId, blockStatus);
                    useMessageStore.getState().setDmPinnedIds(activeId, pins ?? []);
                  })
                  .catch(() => {});
              }
              apiClient.getDMs().then((list) => processDmListRef.current?.(list)).catch(() => {});
            }}
            onJoinInvite={adaptedJoinByInvite}
            onViewInviteServer={(serverId) => { const s = servers.find(sv => sv.id === serverId); if (s) navigate(`/channels/${s.id}/${s.channels[0]?.id ?? ''}`); }}
            uploadFile={dmEncryptedUploadFile}
          /></Suspense>
          </ErrorBoundary>
        );
      case 'notifications':
        return (
          <ContentErrorBoundary><Suspense fallback={null}>
          <NotificationCenterViewLazy
            notificationCounts={notificationCounts}
            currentUserId={currentUser?.id ?? ''}
            servers={servers}
            onGoToChannel={(serverId: string, channelId: string) => {
              navigate(`/channels/${serverId}`);
              if (channelId) setTimeout(() => useNavigationStore.getState().setActiveChannelId(channelId), 50);
            }}
            onGoToThread={async (serverId: string, channelId: string, threadId: string) => {
              navigate(`/channels/${serverId}`);
              setTimeout(async () => {
                if (channelId) useNavigationStore.getState().setActiveChannelId(channelId);
                try {
                  const thread = await apiClient.getThread(channelId, serverId, threadId);
                  if (thread) openThread(thread);
                } catch { /* thread may be deleted */ }
              }, 150);
            }}
            onCountsChange={(counts: typeof notificationCounts) => useNotificationStore.getState().setNotificationCounts(counts)}
          />
          </Suspense></ContentErrorBoundary>
        );
      default:
        return (
          <div className="flex-1 flex flex-col overflow-hidden min-w-0 relative">
            {/* Deck bar: server + channel tabs + Members.
                Hidden (display:none) in Classic — the chat area extends up
                into this space and the equivalent controls live in the
                extended subheader pill (server menu) and a top-right actions
                bubble (members/threads/calendar). We still mount ChannelList
                in Classic so its server-menu portal is available when the
                pill chevron requests it via useUiStore.serverMenuOpenAnchor. */}
            {activeServer && (
              <div
                className={`flex items-center shrink-0 ${uiDensity === 'compact' ? 'h-11 gap-1.5' : uiDensity === 'spacious' ? 'h-16 gap-3' : 'h-14 gap-2'}`}
                style={{
                  position: 'relative',
                  zIndex: 2,
                  display: serverLayout === 'classic' ? 'none' : undefined,
                  // Clear the floating Navigator logo at the deck bar's left edge.
                  paddingLeft: navLeftInset || undefined,
                } as React.CSSProperties}
              >
                <ChannelList
                  layout="deck"
                  uiDensity={uiDensity}
                  server={activeServer}
                  onChannelSelect={handleChannelSelect}
                  onUpdateServer={updateServer}
                  onCreateChannel={createChannel}
                  onCreateCategory={createCategory}
                  onDeleteCategory={async (serverId, categoryId) => { await deleteCategory(serverId, categoryId); }}
                  onUpdateCategory={async (serverId, categoryId, data) => updateCategory(serverId, categoryId, data)}
                  onUpdateChannel={async (serverId, channelId, data) => updateChannel(serverId, channelId, data)}
                  onReorderChannels={async (serverId, channels) => { await reorderChannels(serverId, channels); }}
                  onReorderCategories={async (serverId, cats) => { await reorderCategories(serverId, cats); }}
                  onCreateInvite={createInvite}
                  onDeleteInvite={deleteInvite}
                  onUpdateInvite={(serverId, inviteId, data) => apiClient.updateServerInvite(serverId, inviteId, data)}
                  onLeaveServer={adaptedLeaveServer}
                  onTransferOwnershipAndLeave={adaptedTransferAndLeave}
                  onDeleteServer={adaptedDeleteServer}
                  otherServerMembers={otherServerMembersMemo}
                  serverMembers={serverMembers}
                  getServerInvites={apiClient.getServerInvites.bind(apiClient)}
                  getServerRoles={apiClient.getServerRoles.bind(apiClient)}
                  onUpdateRole={async (sid, rid, data) => { await apiClient.updateServerRole(sid, rid, data as { name?: string; color?: string; style?: string; icon?: string; permissions?: Record<string, boolean>; displaySeparately?: boolean; allowMention?: boolean }); }}
                  onCreateRole={(sid, data) => apiClient.createServerRole(sid, { name: data.name as string, color: data.color as string, permissions: (data.permissions as Record<string, boolean>) ?? {} })}
                  onDeleteRole={apiClient.deleteServerRole.bind(apiClient)}
                  onAddMemberToRole={apiClient.addMemberToRole.bind(apiClient)}
                  onRemoveMemberFromRole={apiClient.removeMemberFromRole.bind(apiClient)}
                  onRolesUpdated={refetchServerMembers}
                  onKickMember={async (serverId, userId) => { await apiClient.kickServerMember(serverId, userId); refetchServerMembers(); }}
                  getMemberModView={apiClient.getMemberModView.bind(apiClient)}
                  serverContextAction={serverContextAction?.serverId === activeServer.id ? serverContextAction : null}
                  onClearContextAction={() => useUiStore.getState().setServerContextAction(null)}
                  deckMembersColumnOpen={isMobile || isTablet ? mobileMembersOpen : membersColumnOpen}
                  onDeckMembersColumnToggle={() => isMobile || isTablet ? setMobileMembersOpen((v) => !v) : setMembersColumnOpen(!membersColumnOpen)}
                  deckMembersCount={membersForList.length}
                  onMarkChannelRead={(channelId) => {
                    useNotificationStore.getState().removeChannelUnread(channelId);
                    useNotificationStore.getState().clearChannelMention(channelId);
                  }}
                  onDeleteChannel={activeServer && serverHasPerm(activeServer, 'manageChannels') ? (channel) => useUiStore.getState().setDeleteChannelConfirm({ channel, serverId: activeServer.id }) : undefined}
                  openChannelSettingsId={openChannelSettingsId}
                  onClearOpenChannelSettings={() => useUiStore.getState().setOpenChannelSettingsId(null)}
                  openCategorySettingsId={openCategorySettingsId}
                  onClearOpenCategorySettings={() => useUiStore.getState().setOpenCategorySettingsId(null)}
                  onEditServerProfile={handleEditServerProfile}
                  onPinnedChannelsChange={(serverId) => {
                    if (serverId === activeServerId) {
                      useMessageStore.getState().bumpPinnedRevision();
                    }
                  }}
                  onPinnedCategoriesChange={(serverId) => {
                    if (serverId === activeServerId) {
                      useAppStore.getState().bumpPinnedCatRevision();
                    }
                  }}
                  onToggleCalendar={() => useNavigationStore.getState().setCalendarActive(!useNavigationStore.getState().calendarActive)}
                  onThreadSelect={openThread}
                  onStageChannelSelect={joinStage}
                  isThreadBrowserActive={threadBrowserOpen}
                  onToggleThreadBrowser={() => useUiStore.getState().setThreadBrowserOpen(!useUiStore.getState().threadBrowserOpen)}
                  // In Classic mode the deck bar is `display: none` but ChannelList
                  // still mounts and writes the threads-button ref to {0,0,0,0}.
                  // The Classic top-right bubble owns the real button — skip the
                  // ref pass-through here so its ref-write isn't clobbered.
                  threadBrowserBtnRef={serverLayout === 'classic' ? undefined : threadBrowserBtnRef}
                />
              </div>
            )}
            {/* Classic-mode top-right actions bubble — relocated deck buttons
                (thread browser, calendar, members toggle). When members
                column is open, bubble width = members column content width
                with three equal-1/3 cells (icons only). When closed, bubble
                shrinks to icon-only intrinsic width; the chat-area pin/search
                row reserves matching paddingRight so they don't overlap. */}
            {activeServer && serverLayout === 'classic' && !isMobile && !isTablet && (() => {
              const padTop = uiDensity === 'compact' ? 10 : uiDensity === 'spacious' ? 18 : 14;
              // Mirror members-column right padding (line 1701) so the bubble's
              // right edge aligns with the column content's right edge.
              const padRight = uiDensity === 'compact' ? 10 : uiDensity === 'spacious' ? 16 : 12;
              // Members column has paddingLeft: 4 (line 1702). Bubble width
              // matches that content area: membersColumnWidth - 4 - padRight.
              // Cap at 0 so a negative number can't slip through if the column
              // is briefly narrower than the paddings during a drag.
              const openWidth = Math.max(0, membersColumnWidth - 4 - padRight);
              const canCalendar = serverHasPerm(activeServer, 'viewCalendar');
              return (
                <div
                  className="absolute top-0 right-0 z-20 pointer-events-auto"
                  style={{ paddingTop: padTop, paddingRight: padRight }}
                >
                  <div
                    className="rounded-2xl flex items-stretch overflow-hidden"
                    style={{
                      backgroundColor: 'var(--bg-chat)',
                      backdropFilter: 'blur(24px) saturate(1.1)',
                      WebkitBackdropFilter: 'blur(24px) saturate(1.1)',
                      border: '1px solid var(--border-subtle)',
                      boxShadow: 'var(--shadow-lg)',
                      width: membersColumnOpen ? openWidth : undefined,
                      padding: membersColumnOpen ? 0 : (uiDensity === 'compact' ? '2px' : uiDensity === 'spacious' ? '4px' : '3px'),
                      gap: membersColumnOpen ? 0 : (uiDensity === 'compact' ? 2 : uiDensity === 'spacious' ? 4 : 3),
                    } as React.CSSProperties}
                  >
                    {/* Threads cell. Callback ref claims the threadBrowser
                        anchor — AppLayout already skips the deck-bar pass
                        in Classic mode (above) so this is the only writer. */}
                    <div
                      ref={(el) => { threadBrowserBtnRef.current = el; }}
                      className={membersColumnOpen ? 'flex-1 flex' : 'shrink-0 flex'}
                      style={membersColumnOpen ? { borderRight: '1px solid var(--border-subtle)' } : undefined}
                    >
                      <button
                        type="button"
                        onClick={() => useUiStore.getState().setThreadBrowserOpen(!useUiStore.getState().threadBrowserOpen)}
                        className="flex items-center justify-center transition-colors w-full rounded-lg"
                        style={{
                          color: threadBrowserOpen ? 'var(--text-accent)' : 'var(--text-secondary)',
                          backgroundColor: threadBrowserOpen ? 'var(--fill-active)' : undefined,
                          padding: membersColumnOpen ? '8px 0' : '6px',
                          minWidth: membersColumnOpen ? undefined : 32,
                        }}
                        aria-pressed={threadBrowserOpen}
                        aria-label={t('threads.threadBrowser')}
                      >
                        <MessageCirclePlus size={14} />
                      </button>
                    </div>
                    {/* Calendar cell. When the user lacks viewCalendar
                        permission we still render an empty cell (in open
                        mode) so threads + members keep their 1/3 layout. */}
                    {canCalendar ? (
                      <div
                        className={membersColumnOpen ? 'flex-1 flex' : 'shrink-0 flex'}
                        style={membersColumnOpen ? { borderRight: '1px solid var(--border-subtle)' } : undefined}
                      >
                        <button
                          type="button"
                          onClick={() => useNavigationStore.getState().setCalendarActive(!useNavigationStore.getState().calendarActive)}
                          className="relative flex items-center justify-center transition-colors w-full rounded-lg"
                          style={{
                            color: calendarActive ? 'var(--text-accent)' : 'var(--text-secondary)',
                            backgroundColor: calendarActive ? 'var(--fill-active)' : undefined,
                            padding: membersColumnOpen ? '8px 0' : '6px',
                            minWidth: membersColumnOpen ? undefined : 32,
                          }}
                          aria-pressed={calendarActive}
                          aria-label={t('channels.calendar')}
                        >
                          <Calendar size={14} />
                        </button>
                      </div>
                    ) : membersColumnOpen ? (
                      <div className="flex-1" style={{ borderRight: '1px solid var(--border-subtle)' }} />
                    ) : null}
                    {/* Members cell. */}
                    <div className={membersColumnOpen ? 'flex-1 flex' : 'shrink-0 flex'}>
                      <button
                        type="button"
                        onClick={() => isMobile || isTablet ? setMobileMembersOpen((v) => !v) : setMembersColumnOpen(!membersColumnOpen)}
                        className={`flex items-center justify-center gap-1 transition-colors w-full rounded-lg ${
                          membersColumnOpen ? 'bg-fill-active text-t-accent' : 'hover:bg-fill-hover text-t-primary'
                        }`}
                        style={{
                          padding: membersColumnOpen ? '8px 0' : '6px',
                          minWidth: membersColumnOpen ? undefined : 32,
                        }}
                        aria-pressed={membersColumnOpen}
                        aria-label={membersColumnOpen ? t('channels.hideMembers') : t('channels.showMembers')}
                      >
                        <Users size={14} />
                        <span className="text-[10px] font-semibold tabular-nums opacity-70">{membersForList.length}</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}
            <div className="flex flex-1 overflow-hidden min-w-0">
              {isServerView && !isMobile && !isTablet && activeServer && (
                <ChannelPanelAside
                  channels={activeServer.channels ?? EMPTY_CHANNELS}
                  categories={activeServer.categories ?? EMPTY_CATEGORIES}
                  activeChannelId={activeChannelId}
                  onSelectChannel={handleSelectChannel}
                  connectedVoiceChannel={connectedVoiceChannel}
                  connectedVoiceServerName={connectedVoiceServerName}
                  voiceChannelParticipants={chatAreaVoiceParticipants}
                  onLeaveVoiceChannel={connectedVoiceChannelId ? adaptedLeaveVoiceChannel : undefined}
                  onSwitchVoiceChannel={switchVoiceChannel}
                  servers={servers}
                  pinnedChannelIds={pinnedChannelIdsForActiveServer}
                  pinnedCategoryIds={pinnedCategoryIdsForActiveServer}
                  serverNotifications={serverNotifications}
                  onDismissNotification={handleDismissNotification}
                  onClearAllNotifications={handleClearAllNotifications}
                  channelThreads={channelThreads}
                  activeThreadId={activeThread?.id ?? null}
                  onThreadSelect={openThread}
                  unreadThreadIds={unreadThreadIds}
                  unreadThreadCounts={unreadThreadCounts}
                  onOpenChannelSettings={activeServer && serverHasPerm(activeServer, 'manageChannels') ? (channelId) => useUiStore.getState().setOpenChannelSettingsId(channelId) : undefined}
                  onOpenCategorySettings={activeServer && serverHasPerm(activeServer, 'manageChannels') ? (categoryId) => useUiStore.getState().setOpenCategorySettingsId(categoryId) : undefined}
                  onMarkChannelRead={(channelId) => {
                    useNotificationStore.getState().removeChannelUnread(channelId);
                    useNotificationStore.getState().clearChannelMention(channelId);
                  }}
                  onRequestDeleteChannel={activeServer && serverHasPerm(activeServer, 'manageChannels') ? (channel) => useUiStore.getState().setDeleteChannelConfirm({ channel, serverId: activeServer.id }) : undefined}
                  canManageChannels={!!(activeServer && serverHasPerm(activeServer, 'manageChannels'))}
                  onCreateChannelInCategory={activeServer && serverHasPerm(activeServer, 'manageChannels')
                    ? (categoryId, categoryName) => useUiStore.getState().setCreateChannelRequest({
                        serverId: activeServer.id,
                        categoryId,
                        categoryName,
                        initialType: 'text',
                      })
                    : undefined}
                  // Drag-drop reorder in the Classic left bar — only enabled
                  // when the user has manageChannels (matches the gating
                  // already used by the "+" category button above). Same
                  // backend as Server Settings; the server broadcasts
                  // `channels-reordered` so a drag in either view propagates
                  // to the other.
                  onReorderChannels={activeServer && serverHasPerm(activeServer, 'manageChannels')
                    ? async (serverId, channels) => { await reorderChannels(serverId, channels); }
                    : undefined}
                  onReorderCategories={activeServer && serverHasPerm(activeServer, 'manageChannels')
                    ? async (serverId, cats) => { await reorderCategories(serverId, cats); }
                    : undefined}
                  currentUserId={displayUser?.id}
                  activeServerId={activeServerId}
                  onUserClick={handleUserClick}
                  onUserRightClick={handleUserRightClick}
                  channelName={activeChannel?.name}
                  channelType={activeChannel?.type}
                  onTextChannelHeaderClick={handleTextChannelHeaderClick}
                  serverBanner={activeServer.banner ?? null}
                  serverPowerUpCount={activeServer.powerUpCount ?? 0}
                />
              )}
              <div
                className="flex-1 overflow-hidden min-w-0"
                style={{
                  display: 'grid',
                  paddingTop: uiDensity === 'compact' ? 4 : uiDensity === 'spacious' ? 8 : 6,
                  gridTemplateColumns: activeServer && !isMobile && !isTablet && (membersColumnOpen || activeThread)
                    ? `1fr ${activeThread ? 400 : membersColumnWidth}px`
                    : '1fr',
                  ...(isMobile || isTablet ? {} : {
                    transition: 'grid-template-columns 0.25s ease-out',
                  }),
                }}
              >
              {/* First cell: chat + voice */}
              <div className="flex overflow-hidden min-w-0 min-h-0 relative z-[1]">
                <div
                  className={`flex flex-col overflow-hidden relative transition-opacity duration-300 min-w-0 ${(showVoiceView || showStageView || showForumView || showRolePickerView) && !calendarActive ? 'w-0 flex-[0_0_0] opacity-0 pointer-events-none overflow-hidden' : 'flex-1 opacity-100 z-10'}`}
                  style={(showVoiceView || showStageView || showForumView || showRolePickerView) && !calendarActive
                    ? { display: 'none' }
                    : { contain: 'layout style' }
                  }
                >
                {channelLoadError && (
                  <div className="flex items-center justify-between gap-3 px-3 py-2 bg-red-500/10 border-b border-red-500/30 text-red-300 text-sm shrink-0">
                    <span className="truncate">{channelLoadError}</span>
                    <button
                      type="button"
                      onClick={() => {
                        useAppStore.getState().setChannelLoadError(null);
                        if (activeChannelId) {
                          apiClient.getChannelMessages(activeChannelId, { limit: 50 })
                            .then(({ messages: msgs, hasMore, pinnedMessageIds: pinIds }) => {
                              useMessageStore.getState().setChannelMessages(activeChannelId, capMessages(msgs), hasMore);
                              if (pinIds) useMessageStore.getState().setChannelPinnedIds(activeChannelId, pinIds);
                              channelFetchTimestamps.current[activeChannelId] = Date.now();
                            })
                            .catch((err) => useAppStore.getState().setChannelLoadError(err instanceof Error ? err.message : 'Failed to load messages'));
                        }
                      }}
                      className="shrink-0 px-2 py-1 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-xs font-medium uppercase"
                    >
                      Retry
                    </button>
                  </div>
                )}
                {calendarActive && activeServer && (
                  <Suspense fallback={null}>
                    <ServerCalendar
                      serverId={activeServer.id}
                      server={activeServer}
                      events={calendarEvents}
                      loading={calendarLoading}
                      onCreateEvent={openCreateEventModal}
                      onSelectEvent={selectEvent}
                      onNavigateBack={() => {
                        useNavigationStore.getState().setCalendarActive(false);
                        useCalendarStore.getState().setCalendarEvents([]);
                        useCalendarStore.getState().setCalendarSelectedEvent(null);
                        useCalendarStore.getState().setCalendarCreateModal({ open: false });
                      }}
                      onMonthChange={changeMonth}
                      onEditEvent={openEditEventModal}
                      onDeleteEvent={adaptedDeleteEvent}
                      onRsvp={adaptedRsvpEvent}
                      onRemoveRsvp={adaptedRemoveRsvp}
                      onJoinVoiceChannel={(channelId) => {
                        useNavigationStore.getState().setCalendarActive(false);
                        useCalendarStore.getState().setCalendarEvents([]);
                        useCalendarStore.getState().setCalendarSelectedEvent(null);
                        useCalendarStore.getState().setCalendarCreateModal({ open: false });
                        handleChannelSelect(channelId);
                      }}
                      currentUserId={currentUser?.id}
                      members={membersForList}
                    />
                  </Suspense>
                )}
                {calendarCreateModal.open && activeServer && (
                  <Suspense fallback={null}>
                    <CreateEventModal
                      isOpen={calendarCreateModal.open}
                      onClose={() => useCalendarStore.getState().setCalendarCreateModal({ open: false })}
                      onSubmit={adaptedSubmitEvent}
                      onDelete={calendarCreateModal.editEvent ? adaptedDeleteEvent : undefined}
                      textChannels={activeServerTextForumChannels}
                      voiceChannels={activeServerVoiceChannels}
                      editEvent={calendarCreateModal.editEvent}
                      initialDate={calendarCreateModal.initialDate}
                      serverId={activeServer.id}
                      canMentionEveryone={serverHasPerm(activeServer, 'mentionEveryone')}
                    />
                  </Suspense>
                )}
                {!calendarActive && activeChannel && activeChannel.type === 'text' && (
                  <ErrorBoundary key={activeChannelId}>
                  <ChatArea
                    channel={activeChannel}
                    onLoadMoreMessages={() => loadOlderChannelMessages(activeChannelId)}
                    onSendMessage={adaptedSendMessage}
                    uploadFile={stableUploadFile}
                    getToken={stableGetToken}
                    onForwardImage={forwardImage}
                    onForwardMessage={(p: ForwardPayload | null) => useUiStore.getState().setForwardPayload(p)}
                    rateLimitBanner={messageRateLimitActive}
                    messageSendError={messageSendError}
                    onUserClick={handleUserClick}
                    onUserRightClick={handleUserRightClick}
                    onPinMessage={adaptedPinMessage}
                    onUnpinMessage={adaptedUnpinMessage}
                    getChannelPins={stableGetChannelPins}
                    showServerNotificationStrip
                    canDeleteAnyMessage={serverHasPerm(activeServer, 'manageMessages')}
                    canMentionEveryone={serverHasPerm(activeServer, 'mentionEveryone')}
                    onDeleteMessage={adaptedDeleteMessage}
                    onEditMessage={adaptedEditMessage}
                    onReportMessage={adaptedReportMessage}
                    onReactMessage={adaptedReactMessage}
                    onJoinInvite={adaptedJoinByInvite}
                    onViewServer={(serverId) => { const s = servers.find(sv => sv.id === serverId); if (s) navigate(`/channels/${s.id}/${s.channels[0]?.id ?? ''}`); }}
                    onTyping={handleChatTyping}
                    onSelectChannel={handleSelectChannel}
                    onVotePoll={adaptedVotePoll}
                    onRemoveVotePoll={adaptedRemoveVotePoll}
                    onClosePoll={adaptedClosePoll}
                    onDeletePoll={adaptedDeletePoll}
                    onOpenThread={adaptedOpenThread}
                    onCreateThread={openCreateThread}
                    onCreatePoll={() => useUiStore.getState().setPollModalOpen(true)}
                    canCreatePoll={canCreatePoll}
                    onCreateThreadFromMenu={adaptedCreateThreadFromMenu}
                    canCreateThread={canCreateThread}
                    onMarkUnread={(timestamp, channelId) => { apiClient.markChannelRead(channelId, timestamp).catch(() => {}); }}
                    onNavigateToMessage={handleNavigateToMessage}
                    // Classic + members closed: the icon-only top-right action
                    // bubble (z-20) sits over the chat header. Reserve enough
                    // padding so pin/search shift left out of its z-stack.
                    // Footprint = outer paddingRight + 3 icon buttons (32px
                    // minWidth each) + 2 inter-button gaps + 2 inner paddings,
                    // plus a 16px visual buffer so they aren't kissing edges:
                    //   compact:  10 + 96 + 4 + 4  = 114 + 16 = 130
                    //   default:  12 + 96 + 6 + 6  = 120 + 16 = 136
                    //   spacious: 16 + 96 + 8 + 8  = 128 + 16 = 144
                    headerActionsRightPad={
                      serverLayout === 'classic' && !isMobile && !isTablet && !membersColumnOpen
                        ? (uiDensity === 'compact' ? 130 : uiDensity === 'spacious' ? 144 : 136)
                        : undefined
                    }
                  />
                  </ErrorBoundary>
                )}
                </div>

              <div
                className={`flex flex-col overflow-hidden transition-opacity duration-300 min-h-0 min-w-0 ${showVoiceView && !calendarActive ? 'flex-1 opacity-100 z-10' : 'w-0 flex-[0_0_0] opacity-0 pointer-events-none overflow-hidden'}`}
                style={showVoiceView && !calendarActive
                  ? { contain: 'layout style paint' }
                  : { display: 'none' }
                }
              >
                {showVoiceView && connectedVoiceChannel && displayUser && (
                    <ErrorBoundary
                      fallback={
                        <div className="flex flex-1 flex-col items-center justify-center p-8 bg-app-surface text-center">
                          <p className="text-red-400 font-bold uppercase text-sm mb-2">{t('errors.voiceChannelError')}</p>
                          <button
                            type="button"
                            onClick={() => {
                              clearStoredVoiceChannel();
                              useVoiceStore.getState().setConnectedVoiceChannelId(null);
                              const firstText = activeServer?.channels.find((c) => c.type === 'text');
                              const fallback = activeServer?.channels[0];
                              const targetCh = firstText ?? fallback;
                              if (targetCh && activeServer) navigate(`/channels/${activeServer.id}/${targetCh.id}`);
                            }}
                            className="px-4 py-2 bg-[var(--cyan-accent)]/20 border border-[var(--cyan-accent)]/40 text-[var(--cyan-accent)] rounded-lg text-xs font-bold uppercase"
                          >
                            Leave channel
                          </button>
                        </div>
                      }
                    >
                      <InCallBluetoothBanner onRequestMicSwitch={voiceSwitchMicDevice} />
                      <Suspense fallback={null}><VoiceChannel
                        channel={connectedVoiceChannel}
                        currentUser={displayUser}
                        participants={voiceChannelParticipants}
                        onTerminate={() => {
                          clearStoredVoiceChannel();
                          useVoiceStore.getState().setConnectedVoiceChannelId(null);
                          if (isCameraOn) toggleCamera();
                          if (isScreenSharing) toggleScreenShare();
                          const firstText = activeServer?.channels.find((c) => c.type === 'text');
                          const fallback = activeServer?.channels[0];
                          const targetCh = firstText ?? fallback;
                          if (targetCh && activeServer) navigate(`/channels/${activeServer.id}/${targetCh.id}`);
                        }}
                        isMuted={isMuted}
                        isDeafened={isDeafened}
                        onToggleMute={toggleMute}
                        isScreenSharing={isScreenSharing}
                        screenStream={screenStream}
                        isCameraOn={isCameraOn}
                        cameraStream={cameraStream}
                        localStream={voiceLocalStream}
                        remoteParticipants={voiceRemoteParticipants}
                        voiceError={voiceError}
                        isE2ee={voiceIsE2ee}
                        isE2eeFailed={voiceIsE2eeFailed}
                        participantVolumes={participantVolumes}
                        onParticipantVolumeChange={setParticipantVolume}
                        servers={servers}
                        onSwitchVoiceChannel={(channelId) => {
                          const doSwitch = () => {
                            leaveOtherActiveCalls('voice');
                            clearStoredVoiceChannel();
                            useVoiceStore.getState().setConnectedVoiceChannelId(channelId);
                            try {
                              const targetServer = servers.find(s => s.channels.some(c => c.id === channelId));
                              if (targetServer) {
                                sessionStorage.setItem('howl_voice_channel', JSON.stringify({ serverId: targetServer.id, channelId }));
                              }
                            } catch (err) { console.error('Failed to store voice channel on switch', err); }
                          };
                          if (!ensureE2eUnlockedForCall(doSwitch)) return;
                          doSwitch();
                        }}
                        enableRemoteScreen={voiceEnableRemoteScreen}
                        disableRemoteScreen={voiceDisableRemoteScreen}
                        showStreamPreviews={voiceSettings.showStreamPreviews}
                        showAdvancedStream={voiceSettings.showAdvancedStream}
                        onParticipantRightClick={activeServer ? (user, e) => {
                          const full = serverMembers.find(m => m.id === user.id) ?? user;
                          useUiStore.getState().setUserContextMenuTarget({ user: full, x: e.clientX, y: e.clientY });
                        } : undefined}
                        onToggleDeafen={toggleDeafen}
                        onToggleScreenShare={toggleScreenShare}
                        onToggleCamera={toggleCamera}
                        onOpenScreenShareSettings={openScreenShareSettings}
                        screenSharePickerOpen={showScreenSharePicker}
                        renderScreenSharePicker={() => {
                          const activeServer = connectedVoiceChannelId
                            ? servers.find((s) => s.channels.some((c) => c.id === connectedVoiceChannelId))
                            : undefined;
                          const pc = activeServer?.powerUpCount ?? 0;
                          const bt = pc >= 14 ? 3 : pc >= 7 ? 2 : pc >= 2 ? 1 : 0;
                          return (
                            <Suspense fallback={null}>
                              <ScreenSharePicker
                                onConfirm={(q) => {
                                  if (isScreenSharing) {
                                    screenStream?.getTracks().forEach(track => track.stop());
                                    useVoiceStore.getState().setScreenStream(null);
                                    useVoiceStore.getState().setIsScreenSharing(false);
                                    setTimeout(() => startScreenShareWithQuality(q), 100);
                                  } else {
                                    startScreenShareWithQuality(q);
                                  }
                                }}
                                onChangeSource={(q) => {
                                  screenStream?.getTracks().forEach(track => track.stop());
                                  useVoiceStore.getState().setScreenStream(null);
                                  useVoiceStore.getState().setIsScreenSharing(false);
                                  useVoiceStore.getState().setShowScreenSharePicker(false);
                                  updateScreenShareQuality(q);
                                  setTimeout(() => startScreenShareWithQuality(q), 100);
                                }}
                                onCancel={() => useVoiceStore.getState().setShowScreenSharePicker(false)}
                                userPlan={displayUser?.stripePlan}
                                serverPowerUpTier={connectedVoiceChannelId ? bt : undefined}
                                currentQuality={screenShareQuality}
                                isSharing={isScreenSharing}
                                screenShareCodec={voiceSettings.screenShareCodec ?? 'auto'}
                onCodecChange={(c) => updateVoice({ screenShareCodec: c })}
                              />
                            </Suspense>
                          );
                        }}
                        serverMuted={serverMuted}
                        serverDeafened={serverDeafened}
                        onOpenChannelSettings={activeServer && serverHasPerm(activeServer, 'manageChannels') ? (channelId) => useUiStore.getState().setOpenChannelSettingsId(channelId) : undefined}
                      />
                      </Suspense>
                    </ErrorBoundary>
                )}
                {showVoiceView && (!connectedVoiceChannel || !displayUser) && (
                  <div className="flex flex-1 items-center justify-center bg-[var(--bg-panel)] text-t-secondary text-sm uppercase tracking-widest">
                    Connecting to voice…
                  </div>
                )}
                {showVoiceView && quickTextChannels.length > 0 && (
                  <QuickTextPanel
                    isOpen={isQuickTextOpen}
                    onToggle={useNavigationStore.getState().setIsQuickTextOpen}
                    channels={quickTextChannels}
                    selectedChannelId={quickTextChannelId}
                    onChannelSelect={useNavigationStore.getState().setSelectedQuickTextChannelId}
                    isMobile={isMobile}
                  >
                    {quickTextChannel && (
                      <ChatArea
                        channel={quickTextChannel}
                        hideHeader
                        inline
                        showServerNotificationStrip={false}
                        onSendMessage={adaptedQtSend}
                        onDeleteMessage={adaptedQtDelete}
                        onEditMessage={adaptedQtEdit}
                        onReactMessage={adaptedQtReact}
                        onPinMessage={adaptedQtPin}
                        onUnpinMessage={adaptedQtUnpin}
                        onTyping={handleQTTyping}
                        onLoadMoreMessages={() => loadOlderChannelMessages(qtChannelId)}
                        uploadFile={stableUploadFile}
                        getToken={stableGetToken}
                        canDeleteAnyMessage={serverHasPerm(activeServer, 'manageMessages')}
                        canMentionEveryone={serverHasPerm(activeServer, 'mentionEveryone')}
                        onUserClick={handleUserClick}
                        onUserRightClick={handleUserRightClick}
                        onForwardImage={(att) => useUiStore.getState().setForwardPayload({ attachment: att })}
                        onForwardMessage={(payload) => useUiStore.getState().setForwardPayload(payload)}
                        onNavigateToMessage={handleNavigateToMessage}
                      />
                    )}
                  </QuickTextPanel>
                )}
              </div>
              {/* Stage view */}
              <div
                className={`flex flex-col overflow-hidden transition-opacity duration-300 min-h-0 min-w-0 ${showStageView && !calendarActive ? 'flex-1 opacity-100 z-10' : 'w-0 flex-[0_0_0] opacity-0 pointer-events-none overflow-hidden'}`}
                style={showStageView && !calendarActive
                  ? { contain: 'layout style paint' }
                  : { display: 'none' }
                }
              >
                {showStageView && activeChannel && activeStageSessions[activeChannelId] && (<>
                  <InCallBluetoothBanner onRequestMicSwitch={stageSwitchMicDevice} />
                  <Suspense fallback={null}>
                    <StageView
                      channel={activeChannel}
                      session={activeStageSessions[activeChannelId]}
                      currentUserId={currentUser?.id ?? ''}
                      canManage={serverHasPerm(activeServer, 'manageStages')}
                      canRequestToSpeak={serverHasPerm(activeServer, 'requestToSpeak')}
                      hasRaisedHand={activeStageSessions[activeChannelId]?.handRaises?.some((h: any) => h.userId === (currentUser?.id ?? '')) ?? false}
                      hasJoined={!!connectedStageChannelId && connectedStageChannelId === activeChannelId}
                      isSpeaker={activeStageSessions[activeChannelId]?.speakers.some(s => s.userId === (currentUser?.id ?? '')) ?? false}
                      onJoinAudience={() => joinStage(activeChannelId)}
                      onRaiseHand={adaptedRaiseHand}
                      onLowerHand={adaptedLowerHand}
                      onLeave={leaveStage}
                      onEndStage={async () => { if (activeChannelId && activeServerId) { useVoiceStore.getState().setActiveStageSessions((prev) => { const next = { ...prev }; delete next[activeChannelId]; return next; }); useVoiceStore.getState().setConnectedStageChannelId(null); try { localStorage.removeItem('howl_connected_stage_channel'); } catch { /* storage unavailable */ } try { await apiClient.endStage(activeChannelId, activeServerId as string); } catch { /* best effort */ } } }}
                      onJoinAsSpeaker={adaptedJoinAsSpeaker}
                      onMoveSelfToAudience={adaptedMoveSelfToAudience}
                      isInvited={isInvitedToSpeak}
                      onSettings={() => activeChannelId && useVoiceStore.getState().setStageSettingsModal({ channelId: activeChannelId, mode: 'edit' })}
                      chatEnabled={activeStageSessions[activeChannelId]?.textChatEnabled ?? false}
                      onInviteToSpeak={async (userId) => { if (activeChannelId && activeServerId) { try { await apiClient.acceptHandRaise(activeChannelId, activeServerId as string, userId); } catch { /* best effort */ } } }}
                      onMoveToAudience={async (userId) => { if (activeChannelId && activeServerId) { try { await apiClient.removeSpeaker(activeChannelId, activeServerId as string, userId); } catch { /* best effort */ } } }}
                      localStream={stageLocalStream}
                      remoteParticipants={stageRemoteParticipants}
                      isMuted={isMuted}
                      isDeafened={isDeafened}
                      isCameraOn={!!cameraStream}
                      isScreenSharing={!!screenStream}
                      cameraStream={cameraStream}
                      screenStream={screenStream}
                      onToggleMute={toggleMute}
                      onToggleDeafen={toggleDeafen}
                      onToggleCamera={toggleCamera}
                      onToggleScreenShare={toggleScreenShare}
                      stageTextMessages={stageTextMessages}
                      stageTextUsers={membersForList}
                      onSendStageMessage={(content) => adaptedSendMessage(content)}
                      userPlan={displayUser?.stripePlan}
                      maxAttachmentMB={50}
                      allowEmojis={activeStageSessions[activeChannelId]?.allowEmojis}
                      allowStickers={activeStageSessions[activeChannelId]?.allowStickers}
                      allowGifs={activeStageSessions[activeChannelId]?.allowGifs}
                      isE2ee={stageIsE2ee}
                      isE2eeFailed={stageIsE2eeFailed}
                      error={stageError}
                      disconnectedByInactivity={stageDisconnectedByInactivity}
                      participantVolumes={participantVolumes}
                      onParticipantVolumeChange={setParticipantVolume}
                    />
                  </Suspense>
                </>)}
                {showStageView && activeChannel && !activeStageSessions[activeChannelId] && (
                  <div className="flex-1 flex flex-col items-center justify-center gap-4">
                    <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ backgroundColor: 'var(--fill-hover)' }}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-t-secondary" style={{ opacity: 0.4 }}><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/></svg>
                    </div>
                    <p className="text-sm text-t-secondary">{t('stage.noActiveSession')}</p>
                    {serverHasPerm(activeServer, 'manageStages') && (
                      <button
                        type="button"
                        onClick={() => activeChannelId && useVoiceStore.getState().setStageSettingsModal({ channelId: activeChannelId, mode: 'start' })}
                        className="btn-cta px-5 py-2.5 rounded-xl text-sm transition-colors"
                      >
                        Start stage
                      </button>
                    )}
                  </div>
                )}
              </div>
              {/* Forum view */}
              <div
                className={`flex flex-col overflow-hidden transition-opacity duration-300 min-h-0 min-w-0 ${showForumView && !calendarActive ? 'flex-1 opacity-100 z-10' : 'w-0 flex-[0_0_0] opacity-0 pointer-events-none overflow-hidden'}`}
                style={showForumView && !calendarActive
                  ? { contain: 'layout style' }
                  : { display: 'none' }
                }
              >
                {showForumView && activeChannel && displayUser && (
                  <Suspense fallback={null}>
                    <ForumView
                      serverId={activeServerId as string}
                      channel={activeChannel}
                      currentUser={displayUser}
                      uploadFile={stableUploadFile}
                      canManagePosts={serverHasPerm(activeServer, 'manageChannels')}
                      canDeleteMessages={serverHasPerm(activeServer, 'manageMessages')}
                    />
                  </Suspense>
                )}
              </div>
              {/* Role-picker channel — full-pane self-roles UI when active. */}
              <div
                className={`flex flex-col overflow-hidden transition-opacity duration-300 min-h-0 min-w-0 ${showRolePickerView && !calendarActive ? 'flex-1 opacity-100 z-10' : 'w-0 flex-[0_0_0] opacity-0 pointer-events-none overflow-hidden'}`}
                style={showRolePickerView && !calendarActive
                  ? { contain: 'layout style' }
                  : { display: 'none' }
                }
              >
                {showRolePickerView && activeChannel && activeServer && (
                  <Suspense fallback={null}>
                    <RolePickerChannel server={activeServer} channel={activeChannel} />
                  </Suspense>
                )}
              </div>
              </div>
              {activeServer && !isMobile && !isTablet && activeThread && (
                <Suspense fallback={null}>
                  <ThreadPanel
                    serverId={activeServerId as string}
                    channelId={activeChannelId}
                    users={membersForList}
                    onClose={closeThread}
                    onSendMessage={adaptedSendThreadMessage}
                    isCreator={activeThread.authorId === currentUser?.id}
                    canManage={serverHasPerm(activeServer, 'manageMessages')}
                    maxAttachmentMB={50}
                    userPlan={displayUser?.stripePlan}
                  />
                </Suspense>
              )}
              {activeServer && !isMobile && !isTablet && !activeThread && membersColumnOpen && (
                <div className="min-w-0 min-h-0 flex flex-col">
                  <div
                    className="relative flex flex-col h-full flex-1 min-h-0"
                    style={{
                      width: membersColumnWidth,
                      minWidth: membersColumnWidth,
                      // In Classic the top-right action bubble (threads /
                      // calendar / members count) sits absolute over the
                      // members column. Push the members content down past
                      // the bubble + a 12px breathing gap so the OWNER /
                      // ADMIN section headers aren't hidden underneath it.
                      // Bubble height ≈ 32px (8px·2 button pad + 14px icon
                      // + 1px·2 border) + outer paddingTop = ~46px on
                      // default density; +12px gap = 58. Rounded:
                      //   compact 54, default 60, spacious 66.
                      paddingTop: serverLayout === 'classic'
                        ? (uiDensity === 'compact' ? 54 : uiDensity === 'spacious' ? 66 : 60)
                        : (uiDensity === 'compact' ? 10 : uiDensity === 'spacious' ? 18 : 14),
                      paddingBottom: uiDensity === 'compact' ? 10 : uiDensity === 'spacious' ? 18 : 14,
                      paddingRight: uiDensity === 'compact' ? 10 : uiDensity === 'spacious' ? 16 : 12,
                      paddingLeft: 4,
                    }}
                  >
                    <div
                      role="separator"
                      aria-label="Resize members column"
                      // 6px wide handle sitting flush at the column's left
                      // edge, matching ChannelList / Sidebar resize handles.
                      // Earlier `w-3` + `left-[-6px]` made it 12px wide with
                      // a 6px overshoot into the chat area — that overshoot
                      // exactly covered the chat scrollbar (also 6px) and
                      // intercepted clicks meant for it.
                      className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-[var(--cyan-accent)]/30 transition-colors z-10 group/resize"
                      style={{ pointerEvents: membersColumnOpen ? 'auto' : 'none' }}
                      onMouseDown={startDrag}
                    >
                      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 rounded-full bg-[var(--cyan-accent)]/0 group-hover/resize:bg-[var(--cyan-accent)]/40 transition-colors" />
                    </div>
                    {membersLoadError && (
                      <div className="flex items-center justify-between gap-2 px-3 py-2 mb-2 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs shrink-0">
                        <span className="truncate flex-1">{membersLoadError}</span>
                        <button
                          type="button"
                          onClick={() => {
                            if (isRealServerId(activeServerId)) {
                              useAppStore.getState().setMembersLoadError(null);
                              apiClient.getServerMembers(activeServerId)
                                .then(processServerMembers)
                                .catch((err) => useAppStore.getState().setMembersLoadError(err instanceof Error ? err.message : 'Failed to load members'));
                            }
                          }}
                          className="shrink-0 px-2 py-1 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-xs font-medium uppercase"
                        >
                          Retry
                        </button>
                      </div>
                    )}
                    <MemberList
                      members={membersForList}
                      ownerId={serverOwnerId ?? undefined}
                      onMemberClick={(member, e) => useUiStore.getState().setUserProfileTarget({ user: member, anchorRect: { left: e.clientX, top: e.clientY + 8 } })}
                      onMemberRightClick={(member, e) => useUiStore.getState().setUserContextMenuTarget({ user: member, x: e.clientX, y: e.clientY })}
                      embedded
                      uiDensity={uiDensity}
                      roleColorMode={accessibilitySettings.roleColorMode}
                    />
                  </div>
                </div>
              )}
              </div>
            </div>

            {/* Mobile members slide-out overlay */}
            {(isMobile || isTablet) && activeServer && (
              <div
                className="fixed inset-0 z-[var(--z-modal)] flex justify-end"
                style={{
                  visibility: mobileMembersOpen ? 'visible' : 'hidden',
                  transitionProperty: 'visibility',
                  transitionDuration: '0ms',
                  transitionDelay: mobileMembersOpen ? '0ms' : '300ms',
                }}
                onClick={() => setMobileMembersOpen(false)}
              >
                <div
                  ref={membersBackdropRef}
                  className="absolute inset-0 transition-opacity duration-300"
                  style={{ backgroundColor: 'var(--overlay-backdrop)', opacity: mobileMembersOpen ? 1 : 0 }}
                />
                <div
                  ref={membersDrawerRef}
                  className="relative w-[min(288px,75vw)] h-full flex flex-col transition-transform duration-300 ease-out safe-area-right safe-area-top safe-area-bottom bg-panel"
                  style={{
                    transform: mobileMembersOpen ? 'translateX(0)' : 'translateX(100%)',
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="shrink-0 flex items-center justify-end px-3 pt-2 pb-0">
                    <button type="button" onClick={() => setMobileMembersOpen(false)} className="p-1.5 rounded-lg hover:bg-fill-active transition-colors text-t-secondary" aria-label="Close members panel">
                      <CloseIcon size={18} />
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto min-h-0">
                      <MemberList
                      members={membersForList}
                      ownerId={serverOwnerId ?? undefined}
                      onMemberClick={(member, e) => { useUiStore.getState().setUserProfileTarget({ user: member, anchorRect: { left: e.clientX, top: e.clientY + 8 } }); setMobileMembersOpen(false); }}
                      onMemberRightClick={(member, e) => { useUiStore.getState().setUserContextMenuTarget({ user: member, x: e.clientX, y: e.clientY }); setMobileMembersOpen(false); }}
                      embedded
                      uiDensity={uiDensity}
                      roleColorMode={accessibilitySettings.roleColorMode}
                    />
                  </div>
                </div>
              </div>
            )}

            {activeServer && userProfileTarget && !isMobile && !isTablet && (
              <UserProfilePopup
                canKick={serverHasPerm(activeServer, 'kickMembers')}
                isTargetOwner={userProfileTarget.user.id === serverOwnerId}
                onClose={() => { useUiStore.getState().setUserProfileTarget(null); useUiStore.getState().setProfileFriendStatus(null); }}
                onViewFullProfile={(user, initialTab) => handleOpenFullProfile(user, activeServer?.id, initialTab)}
                onCreateDM={(userId) => { adaptedCreateOrSelectDM(userId); useUiStore.getState().setUserProfileTarget(null); }}
                onSendMessageAndOpenDM={adaptedSendMessageAndOpenDM}
                onAddFriend={(user) => {
                  apiClient.sendFriendRequest(formatUsername(user)).then(() => refetchProfileFriendStatus()).catch(() => {});
                }}
                onCancelFriendRequest={(requestId) => apiClient.cancelFriendRequest(requestId).then(refetchProfileFriendStatus).catch(() => {})}
                onRemoveFriend={(userId) => {
                  useUiStore.getState().setDestructiveConfirm({
                    title: t('friends.removeFriendTitle'),
                    desc: t('friends.removeFriendDesc'),
                    confirmLabel: t('common.remove'),
                    danger: true,
                    onConfirm: () => apiClient.removeFriend(userId).then(refetchProfileFriendStatus).catch(() => showGlobalToast(t('toast.failedRemoveFriend'), 'warning')),
                  });
                }}
                isBlocked={blockedUserIds.has(userProfileTarget.user.id)}
                onBlock={(userId) => {
                  useUiStore.getState().setDestructiveConfirm({
                    title: t('social.blockUser'),
                    desc: t('social.blockUserDesc', { username: userProfileTarget.user.username }),
                    confirmLabel: t('common.block'),
                    danger: true,
                    onConfirm: () => apiClient.blockUser(userId).then(() => { useSocialStore.getState().addBlockedUser(userId); useUiStore.getState().setUserProfileTarget(null); }).catch(() => showGlobalToast(t('toast.failedBlockUser'), 'warning')),
                  });
                }}
                onUnblock={(userId) => unblockUser(userId).then(() => useUiStore.getState().setUserProfileTarget(null))}
                onOpenModView={(userId) => { useUiStore.getState().setModViewTarget({ serverId: activeServer.id, userId }); useUiStore.getState().setUserProfileTarget(null); }}
                onKick={serverHasPerm(activeServer, 'kickMembers') && userProfileTarget.user.id !== serverOwnerId ? (userId) => {
                  useUiStore.getState().setDestructiveConfirm({
                    title: t('moderation.kickMember'),
                    desc: t('moderation.kickMemberDesc', { username: userProfileTarget.user.username }),
                    confirmLabel: t('common.kick'),
                    danger: true,
                    onConfirm: () => apiClient.kickServerMember(activeServer.id, userId).then(refetchServerMembers).catch(() => showGlobalToast(t('toast.failedKickMember'), 'warning')),
                  });
                } : undefined}
              />
            )}
            {activeServer && userContextMenuTarget && (
              <UserContextMenu
                canKick={serverHasPerm(activeServer, 'kickMembers')}
                isTargetOwner={userContextMenuTarget.user.id === serverOwnerId}
                onClose={() => useUiStore.getState().setUserContextMenuTarget(null)}
                onProfile={(userId) => {
                  const member = membersForList.find((m) => m.id === userId);
                  if (member) handleOpenFullProfile(member as UserWithRole, activeServer?.id);
                  useUiStore.getState().setUserContextMenuTarget(null);
                }}
                onMention={() => { useUiStore.getState().setUserContextMenuTarget(null); }}
                onCreateDM={(userId) => { adaptedCreateOrSelectDM(userId); useUiStore.getState().setUserContextMenuTarget(null); }}
                onOpenModView={(userId) => { useUiStore.getState().setModViewTarget({ serverId: activeServer.id, userId }); useUiStore.getState().setUserContextMenuTarget(null); }}
                onKick={serverHasPerm(activeServer, 'kickMembers') && userContextMenuTarget.user.id !== serverOwnerId ? (userId) => {
                  const target = userContextMenuTarget.user.username;
                  useUiStore.getState().setDestructiveConfirm({
                    title: t('moderation.kickMember'),
                    desc: t('moderation.kickMemberDesc', { username: target }),
                    confirmLabel: t('common.kick'),
                    danger: true,
                    onConfirm: () => apiClient.kickServerMember(activeServer.id, userId).then(refetchServerMembers).catch(() => showGlobalToast(t('toast.failedKickMember'), 'warning')),
                  });
                } : undefined}
                onBan={serverHasPerm(activeServer, 'banMembers') && userContextMenuTarget.user.id !== serverOwnerId ? (userId) => {
                  const target = userContextMenuTarget.user.username;
                  useUiStore.getState().setDestructiveConfirm({
                    title: t('moderation.banMember'),
                    desc: t('moderation.banMemberDesc', { target }),
                    confirmLabel: t('common.ban'),
                    danger: true,
                    onConfirm: () => apiClient.banServerMember(activeServer.id, userId).then(() => refetchServerMembers()).catch(() => showGlobalToast(t('toast.failedBanMember'), 'warning')),
                  });
                } : undefined}
                isBlocked={blockedUserIds.has(userContextMenuTarget.user.id)}
                onBlock={(userId) => {
                  const target = userContextMenuTarget.user.username;
                  useUiStore.getState().setDestructiveConfirm({
                    title: t('social.blockUser'),
                    desc: t('social.blockUserDesc', { username: target }),
                    confirmLabel: t('common.block'),
                    danger: true,
                    onConfirm: () => apiClient.blockUser(userId).then(() => { useSocialStore.getState().addBlockedUser(userId); useUiStore.getState().setUserContextMenuTarget(null); }).catch(() => showGlobalToast(t('toast.failedBlockUser'), 'warning')),
                  });
                }}
                onUnblock={(userId) => unblockUser(userId).then(() => useUiStore.getState().setUserContextMenuTarget(null))}
                inVoiceWithUserIds={voiceParticipantUserIds}
                participantVolumes={participantVolumes}
                onParticipantVolumeChange={setParticipantVolume}
                serverId={activeServer.id}
                onEditServerProfile={handleEditServerProfile}
                canMuteMembers={serverHasPerm(activeServer, 'muteMembers')}
                isTargetServerMuted={userContextMenuTarget.user.id === displayUser?.id ? serverMuted : voiceRemoteParticipants.find(p => p.userId === userContextMenuTarget.user.id)?.serverMuted}
                isTargetServerDeafened={userContextMenuTarget.user.id === displayUser?.id ? serverDeafened : voiceRemoteParticipants.find(p => p.userId === userContextMenuTarget.user.id)?.serverDeafened}
                onServerMute={serverMuteUser}
                onServerDeafen={serverDeafenUser}
                canMoveMembers={serverHasPerm(activeServer, 'moveMembers')}
                voiceChannels={activeServer.channels.filter(c => c.type === 'voice')}
                currentVoiceChannelId={connectedVoiceChannelId}
                onMoveToVoiceChannel={moveVoiceUser}
                isMuted={isMuted}
                isDeafened={isDeafened}
                onToggleMute={toggleMute}
                onToggleDeafen={toggleDeafen}
                canChangeNickname={(() => {
                  // Self-edit is allowed when the user has the changeNickname
                  // permission. Editing someone else's nickname requires
                  // manageNicknames AND that the target is not the owner. The
                  // backend additionally enforces role-hierarchy; we still
                  // surface the menu item so the failure path comes from the
                  // server with a clear error rather than the menu lying.
                  const targetId = userContextMenuTarget.user.id;
                  const isSelfTarget = targetId === displayUser?.id;
                  if (isSelfTarget) return serverHasPerm(activeServer, 'changeNickname');
                  if (targetId === serverOwnerId) return false;
                  return serverHasPerm(activeServer, 'manageNicknames');
                })()}
                onChangeNickname={(userId) => {
                  const member = membersForList.find((m) => m.id === userId) as
                    | (typeof membersForList[number] & {
                        nickname?: string | null;
                        roleColor?: string;
                        roleStyle?: 'solid' | 'gradient' | 'holographic';
                        nameColor?: string;
                        nameFont?: string;
                        nameEffect?: string;
                        avatarEffect?: string;
                        effectivePlan?: string;
                        stripePlan?: string;
                      })
                    | undefined;
                  const fallback = userContextMenuTarget.user;
                  useUiStore.getState().setNicknameModal({
                    serverId: activeServer.id,
                    serverName: activeServer.name,
                    target: {
                      id: userId,
                      username: member?.username ?? fallback.username,
                      avatar: member?.avatar ?? fallback.avatar ?? null,
                      discriminator: member?.discriminator ?? fallback.discriminator,
                      roleColor: member?.roleColor,
                      roleStyle: member?.roleStyle,
                      nameColor: member?.nameColor,
                      nameFont: member?.nameFont,
                      nameEffect: member?.nameEffect,
                      avatarEffect: member?.avatarEffect,
                      effectivePlan: member?.effectivePlan,
                      stripePlan: member?.stripePlan,
                    },
                    currentNickname: member?.nickname ?? null,
                    isSelf: userId === displayUser?.id,
                  });
                  useUiStore.getState().setUserContextMenuTarget(null);
                }}
              />
            )}
            {activeServer && modViewTarget && modViewTarget.serverId === activeServer.id && (
              <ContentErrorBoundary><Suspense fallback={null}><ModViewPopup
                serverId={modViewTarget.serverId}
                serverName={activeServer.name}
                member={(() => {
                  const m = membersForList.find((x) => x.id === modViewTarget.userId);
                  return m ? { id: m.id, username: m.username, discriminator: m.discriminator, avatar: m.avatar ?? undefined } : { id: modViewTarget.userId, username: 'Unknown', avatar: undefined };
                })()}
                getModView={apiClient.getMemberModView.bind(apiClient)}
                onClose={() => useUiStore.getState().setModViewTarget(null)}
                onKick={serverHasPerm(activeServer, 'kickMembers') && modViewTarget.userId !== serverOwnerId ? (serverId, userId) => apiClient.kickServerMember(serverId, userId).then(refetchServerMembers) : undefined}
                onDirectMessage={(userId) => { adaptedCreateOrSelectDM(userId); }}
              /></Suspense></ContentErrorBoundary>
            )}
          </div>
        );
    }
  };

  // Main JSX
  return (
    <UserProvider currentUser={currentUser} setCurrentUser={useAuthStore.getState().setCurrentUser} displayUser={displayUser}>
    <div
      className="fixed inset-0 overflow-hidden flex flex-col bg-app safe-area-top safe-area-bottom"
    >
      <a href="#main-content" className="skip-link">Skip to main content</a>
      {isOffline && (
        <div className="bg-red-500/90 text-white text-xs font-semibold text-center py-1.5 px-4 flex items-center justify-center gap-2 z-[var(--z-max)] shrink-0">
          <span className="w-2 h-2 rounded-full bg-white/80 animate-pulse" />
          You're offline — check your internet connection
        </div>
      )}
      {backgroundImage && (
        <div
          className="fixed inset-0 pointer-events-none overflow-hidden"
          style={{ opacity: backgroundOpacity, zIndex: 0 }}
        >
          {/*
            Background renders through LazyGif so it shares the same pause
            pipeline as banners/avatars: useAppVisible (Electron-aware) +
            server-frame swap when bgFrameUrl is available + canvas-capture
            fallback when it isn't. The previous CSS background-image
            implementation didn't reliably stop GIF decode in Chromium even
            with `display:none` toggling — the `<img>` element does, because
            Chromium's image-decoder lifetime is tied to the element's
            "render-tree-attached" state for img but not for css-background.
          */}
          <LazyGif
            src={sanitizeImgSrc(backgroundImage)}
            frameSrc={bgFrameUrl ?? undefined}
            alt=""
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'center',
              filter: backgroundBlur > 0 ? `blur(${backgroundBlur}px)` : undefined,
              transform: backgroundBlur > 0 ? 'scale(1.05)' : undefined,
            }}
          />
        </div>
      )}
      <div
        className="flex flex-col overflow-hidden relative"
        style={{
          width: zoomFraction === 1 ? '100%' : `calc(${100 / zoomFraction}vw + 2px)`,
          height: zoomFraction === 1 ? '100dvh' : `${100 / zoomFraction}dvh`,
          zoom: zoomFraction === 1 ? undefined : zoomFraction,
          backgroundColor: backgroundImage ? 'transparent' : 'var(--bg-app)',
        }}
      >
      <div className="absolute top-0 left-0 right-0" style={{ zIndex: 'var(--z-max)' as unknown as number }}>
        <TitleBar />
      </div>
      <div style={{ height: titleBarPad, flexShrink: 0 }} />
      {showMfaBanner && (
        <div className="flex items-center gap-3 px-4 py-2 text-xs font-medium" style={{ backgroundColor: 'rgba(234,179,8,0.12)', color: '#fbbf24', borderBottom: '1px solid rgba(234,179,8,0.2)', paddingLeft: navLeftInset || undefined }}>
          <ShieldAlert size={14} className="shrink-0" />
          <span>Secure your account — enable two-factor authentication (2FA) in <button type="button" className="underline hover:text-yellow-300 font-semibold" onClick={() => { useNavigationStore.getState().setAccountDeepLink({ page: 'my-account', subTab: 'security' }); navigate('/settings'); dismissMfaBanner(); }}>Account Settings &rarr; Security</button></span>
          <button type="button" onClick={dismissMfaBanner} className="ml-auto p-0.5 rounded-lg hover:bg-fill-active transition-colors" aria-label="Dismiss">
            <CloseIcon size={14} />
          </button>
        </div>
      )}
      {/* Keep remote voice audio playing when user is in a voice channel but viewing text channel / elsewhere.
          When the local user is sharing a screen with system audio, silence
          participant playback so the capture doesn't echo others' voices back
          (gated by the voice setting, default on). */}
      {connectedVoiceChannelId && (
        <VoiceRemoteAudio
          participants={voiceRemoteAudioParticipants}
          participantVolumes={participantVolumes}
          isDeafened={isDeafened || (
            voiceSettings.muteHowlAudioWhileSharing !== false &&
            !!screenStream &&
            screenStream.getAudioTracks().some((t) => t.readyState === 'live')
          )}
          speakerVolume={voiceSettings.speakerVolume / 100}
          speakerId={voiceSettings.selectedSpeakerId || undefined}
        />
      )}
      <div className={`flex flex-1 overflow-hidden relative ${isMobile ? 'flex-col-reverse' : 'flex-row'}`} data-layout-tier={breakpointTier}>
        <ErrorBoundary>
        {useNavigator ? (
          // Rail-less: content fills the width; only the fixed-position logo
          // trigger floats over the top-left. Per-page top/left insets below
          // keep it clear of each page's leading controls.
          <NavigatorTrigger
            onOpen={() => useUiStore.getState().setLauncherOpen(true)}
            titleBarPad={titleBarPad}
          />
        ) : (
        <Sidebar
          onSelect={handleNavTarget}
          onCreateServer={adaptedCreateServer}
          onJoinServer={adaptedJoinByInvite}
          onServerCreated={adaptedServerCreatedFromTemplate}
          onMarkServerRead={markServerRead}
          onServerContextMenu={handleServerContextMenu}
          onFloatingBarDockToggle={handleFloatingBarDockToggle}
          onSidebarWidthChange={(w: number) => useAppStore.getState().setSidebarWidth(w)}
          isMobile={isMobile}
          isTablet={isTablet}
          onEditServerProfile={handleEditServerProfile}
          onMobileServerDrawerToggle={useNavigationStore.getState().setMobileServerDrawerOpen}
          serverDrawerPanelRef={serverDrawerPanelRef}
          serverBackdropRef={serverBackdropRef}
          activeDmCallChannelId={activeDmCallChannelId}
        />
        )}
        </ErrorBoundary>
        <div id="main-content" tabIndex={-1} className="flex-1 flex overflow-hidden relative min-w-0 min-h-0 z-[1] focus:outline-none" style={{ minWidth: isMobile ? 0 : 200 }} {...contentSwipeHandlers}>
          <ContentErrorBoundary key={activeServerId}>
            <SpoilerRevealProvider
              channelId={activeServerId === 'dm' ? (activeDmChannelId ?? '') : activeChannelId}
              serverId={activeServerId === 'dm' ? 'dm' : (typeof activeServerId === 'string' ? activeServerId : '')}
              spoilerMode={chatSettings.spoilerMode}
              isServerModerator={serverHasPerm(activeServer, 'manageMessages')}
            >
              <motion.div
                key={activeServerId}
                initial={{ opacity: 0, scale: 0.985 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.12, ease: [0.25, 0.46, 0.45, 0.94] }}
                className="flex-1 flex min-h-0"
                style={navTopInset && ['home', 'friends', 'notifications', 'discover'].includes(activeServerId as string) ? { paddingTop: navTopInset } : undefined}
              >
                {renderContent()}
              </motion.div>
            </SpoilerRevealProvider>
          </ContentErrorBoundary>
          {activeServerId === 'dm' && userProfileTarget && !isMobile && !isTablet && (
            <UserProfilePopup
              onClose={() => { useUiStore.getState().setUserProfileTarget(null); useUiStore.getState().setProfileFriendStatus(null); }}
              onViewFullProfile={(user, initialTab) => handleOpenFullProfile(user, undefined, initialTab)}
              onCreateDM={(userId) => { adaptedCreateOrSelectDM(userId); useUiStore.getState().setUserProfileTarget(null); }}
              onSendMessageAndOpenDM={adaptedSendMessageAndOpenDM}
              onAddFriend={(user) => {
                apiClient.sendFriendRequest(formatUsername(user)).then(() => refetchProfileFriendStatus()).catch(() => {});
              }}
              onCancelFriendRequest={(requestId) => apiClient.cancelFriendRequest(requestId).then(refetchProfileFriendStatus).catch(() => {})}
              onRemoveFriend={(userId) => {
                useUiStore.getState().setDestructiveConfirm({
                  title: t('friends.removeFriendTitle'),
                  desc: t('friends.removeFriendDesc'),
                  confirmLabel: t('common.remove'),
                  danger: true,
                  onConfirm: () => apiClient.removeFriend(userId).then(refetchProfileFriendStatus).catch(() => showGlobalToast(t('toast.failedRemoveFriend'), 'warning')),
                });
              }}
              isBlocked={blockedUserIds.has(userProfileTarget.user.id)}
              onBlock={(userId) => {
                useUiStore.getState().setDestructiveConfirm({
                  title: t('social.blockUser'),
                  desc: t('social.blockUserDesc', { username: userProfileTarget.user.username }),
                  confirmLabel: t('common.block'),
                  danger: true,
                  onConfirm: () => blockUserInDmView(userId, () => useUiStore.getState().setUserProfileTarget(null)),
                });
              }}
              onUnblock={(userId) => unblockUserInDmView(userId).then(() => useUiStore.getState().setUserProfileTarget(null))}
            />
          )}
          {activeServerId === 'dm' && userContextMenuTarget && (
            userContextMenuTarget.dmChannelId != null ? (
              <DirectMessageContextMenu
                user={userContextMenuTarget.user}
                x={userContextMenuTarget.x}
                y={userContextMenuTarget.y}
                dmChannelId={userContextMenuTarget.dmChannelId}
                isUnread={unreadDmChannelIds.has(userContextMenuTarget.dmChannelId)}
                onClose={() => useUiStore.getState().setUserContextMenuTarget(null)}
                onMarkAsRead={markDmRead}
                onProfile={(_userId) => {
                  handleOpenFullProfile(userContextMenuTarget.user);
                  useUiStore.getState().setUserContextMenuTarget(null);
                }}
                isPinned={useDmStore.getState().dmChannels.find((c) => c.id === userContextMenuTarget.dmChannelId)?.pinned ?? false}
                onPinConversation={pinDmConversation}
                onUnpinConversation={unpinDmConversation}
                onCloseDM={(id) => {
                  if (activeDmChannelId === id) navigate('/channels/@me');
                  useDmStore.getState().removeDmChannel(id);
                  { const prevDm = useMessageStore.getState().dmMessages; if (prevDm[id]) { const { [id]: _, ...rest } = prevDm; useMessageStore.getState()._setAll({ dmMessages: rest }); } }
                  try { if (localStorage.getItem('howl_last_dm_channel') === id) localStorage.removeItem('howl_last_dm_channel'); } catch { /* ignored */ }
                  useUiStore.getState().setUserContextMenuTarget(null);
                }}
                onInviteToServer={() => useUiStore.getState().setUserContextMenuTarget(null)}
                onRemoveFriend={(userId) => { useUiStore.getState().setDmRemoveFriendConfirm({ userId, username: formatUsername(userContextMenuTarget.user) }); useUiStore.getState().setUserContextMenuTarget(null); }}
                onIgnore={() => useUiStore.getState().setUserContextMenuTarget(null)}
                onBlock={(userId) => {
                  const target = userContextMenuTarget.user.username;
                  useUiStore.getState().setDestructiveConfirm({
                    title: t('social.blockUser'),
                    desc: t('social.blockUserDesc', { username: target }),
                    confirmLabel: t('common.block'),
                    danger: true,
                    onConfirm: () => blockUserInDmView(userId, () => useUiStore.getState().setUserContextMenuTarget(null)),
                  });
                }}
                isBlocked={blockedUserIds.has(userContextMenuTarget.user.id)}
                onUnblock={(userId) => unblockUserInDmView(userId).then(() => useUiStore.getState().setUserContextMenuTarget(null))}
                onMute={(_userId, duration: MuteDuration) => {
                  if (userContextMenuTarget?.dmChannelId) setDmMuted(userContextMenuTarget.dmChannelId, muteDurationToUntil(duration));
                  useUiStore.getState().setUserContextMenuTarget(null);
                }}
                inVoiceWithUserIds={voiceParticipantUserIds}
                participantVolumes={participantVolumes}
                onParticipantVolumeChange={setParticipantVolume}
              />
            ) : (
              <UserContextMenu
                onClose={() => useUiStore.getState().setUserContextMenuTarget(null)}
                onProfile={() => {
                  handleOpenFullProfile(userContextMenuTarget.user);
                  useUiStore.getState().setUserContextMenuTarget(null);
                }}
                onMention={() => useUiStore.getState().setUserContextMenuTarget(null)}
                onCreateDM={(userId) => { adaptedCreateOrSelectDM(userId); useUiStore.getState().setUserContextMenuTarget(null); }}
                isBlocked={blockedUserIds.has(userContextMenuTarget.user.id)}
                onBlock={(userId) => {
                  const target = userContextMenuTarget.user.username;
                  useUiStore.getState().setDestructiveConfirm({
                    title: t('social.blockUser'),
                    desc: t('social.blockUserDesc', { username: target }),
                    confirmLabel: t('common.block'),
                    danger: true,
                    onConfirm: () => blockUserInDmView(userId, () => useUiStore.getState().setUserContextMenuTarget(null)),
                  });
                }}
                onUnblock={(userId) => unblockUserInDmView(userId).then(() => useUiStore.getState().setUserContextMenuTarget(null))}
                inVoiceWithUserIds={voiceParticipantUserIds}
                participantVolumes={participantVolumes}
                onParticipantVolumeChange={setParticipantVolume}
                isMuted={isMuted}
                isDeafened={isDeafened}
                onToggleMute={toggleMute}
                onToggleDeafen={toggleDeafen}
              />
            )
          )}
          {activeServerId === 'home' && userContextMenuTarget && (
            <UserContextMenu
              onClose={() => useUiStore.getState().setUserContextMenuTarget(null)}
              onProfile={() => {
                handleOpenFullProfile(userContextMenuTarget.user);
                useUiStore.getState().setUserContextMenuTarget(null);
              }}
              onMention={() => useUiStore.getState().setUserContextMenuTarget(null)}
              onCreateDM={(userId) => { adaptedCreateOrSelectDM(userId); useUiStore.getState().setUserContextMenuTarget(null); }}
              isBlocked={blockedUserIds.has(userContextMenuTarget.user.id)}
              onBlock={(userId) => {
                const target = userContextMenuTarget.user.username;
                useUiStore.getState().setDestructiveConfirm({
                  title: t('social.blockUser'),
                  desc: t('social.blockUserDesc', { username: target }),
                  confirmLabel: t('common.block'),
                  danger: true,
                  onConfirm: () => blockUserInDmView(userId, () => useUiStore.getState().setUserContextMenuTarget(null)),
                });
              }}
              onUnblock={(userId) => unblockUserInDmView(userId).then(() => useUiStore.getState().setUserContextMenuTarget(null))}
              inVoiceWithUserIds={voiceParticipantUserIds}
              participantVolumes={participantVolumes}
              onParticipantVolumeChange={setParticipantVolume}
              isMuted={isMuted}
              isDeafened={isDeafened}
              onToggleMute={toggleMute}
              onToggleDeafen={toggleDeafen}
            />
          )}
        </div>

        {/* Nickname Modal — opened from UserContextMenu's "Change Nickname" item. */}
        {nicknameModal && (
          <NicknameModal
            open
            serverId={nicknameModal.serverId}
            serverName={nicknameModal.serverName}
            target={nicknameModal.target}
            currentNickname={nicknameModal.currentNickname}
            isSelf={nicknameModal.isSelf}
            onClose={() => useUiStore.getState().setNicknameModal(null)}
            onSaved={() => {
              // Refresh server members so the new nickname propagates into
              // the member list / chat author labels without waiting for the
              // socket event (the backend also broadcasts, this is just the
              // optimistic mirror so the closing user sees the update first).
              if (refetchServerMembers) refetchServerMembers();
            }}
          />
        )}

        {/* Full Profile Modal */}
        {fullProfileTarget && (
          <FullProfileModal
            onClose={() => { useUiStore.getState().setFullProfileTarget(null); useUiStore.getState().setProfileFriendStatus(null); }}
            onCreateDM={(userId) => { adaptedCreateOrSelectDM(userId); useUiStore.getState().setFullProfileTarget(null); }}
            onSendMessageAndOpenDM={(userId, content) => { adaptedSendMessageAndOpenDM(userId, content); useUiStore.getState().setFullProfileTarget(null); }}
            onAddFriend={(user) => {
              apiClient.sendFriendRequest(formatUsername(user)).then(() => refetchProfileFriendStatus()).catch(() => {});
            }}
            onCancelFriendRequest={(requestId) => apiClient.cancelFriendRequest(requestId).then(refetchProfileFriendStatus).catch(() => {})}
            onRemoveFriend={(userId) => {
              useUiStore.getState().setDestructiveConfirm({
                title: t('friends.removeFriendTitle'),
                desc: t('friends.removeFriendDesc'),
                confirmLabel: t('common.remove'),
                danger: true,
                onConfirm: () => apiClient.removeFriend(userId).then(refetchProfileFriendStatus).catch(() => showGlobalToast(t('toast.failedRemoveFriend'), 'warning')),
              });
            }}
            isBlocked={blockedUserIds.has(fullProfileTarget.user.id)}
            onBlock={(userId) => {
              useUiStore.getState().setDestructiveConfirm({
                title: t('social.blockUser'),
                desc: t('social.blockUserDesc', { username: fullProfileTarget.user.username }),
                confirmLabel: t('common.block'),
                danger: true,
                onConfirm: () => apiClient.blockUser(userId).then(() => { useSocialStore.getState().addBlockedUser(userId); useUiStore.getState().setFullProfileTarget(null); }).catch(() => showGlobalToast(t('toast.failedBlockUser'), 'warning')),
              });
            }}
            onUnblock={(userId) => {
              if (fullProfileTarget.serverId) {
                unblockUser(userId).then(() => useUiStore.getState().setFullProfileTarget(null));
              } else {
                unblockUserInDmView(userId).then(() => useUiStore.getState().setFullProfileTarget(null));
              }
            }}
            onOpenModView={fullProfileTarget.serverId && activeServer ? (userId) => { useUiStore.getState().setModViewTarget({ serverId: activeServer.id, userId }); useUiStore.getState().setFullProfileTarget(null); } : undefined}
            canKick={fullProfileTarget.serverId ? serverHasPerm(activeServer, 'kickMembers') : false}
            isTargetOwner={fullProfileTarget.user.id === serverOwnerId}
            onKick={fullProfileTarget.serverId && activeServer && serverHasPerm(activeServer, 'kickMembers') && fullProfileTarget.user.id !== serverOwnerId ? (userId) => {
              useUiStore.getState().setDestructiveConfirm({
                title: t('moderation.kickMember'),
                desc: t('moderation.kickMemberDesc', { username: fullProfileTarget.user.username }),
                confirmLabel: t('common.kick'),
                danger: true,
                onConfirm: () => apiClient.kickServerMember(activeServer.id, userId).then(refetchServerMembers).catch(() => showGlobalToast(t('toast.failedKickMember'), 'warning')),
              });
            } : undefined}
            serverName={activeServer?.name}
            serverIcon={activeServer?.icon ?? null}
            onOpenUserProfile={(friend) => {
              useUiStore.getState().setFullProfileTarget({
                user: { ...friend, status: friend.status } as UserWithRole,
                serverId: fullProfileTarget.serverId,
              });
            }}
          />
        )}

        {/* Remove Friend Confirmation (from DM context menu) */}
        {dmRemoveFriendConfirm && (
          <div className="fixed inset-0 z-[var(--z-max)] flex items-center justify-center bg-[var(--overlay-backdrop)] backdrop-blur-sm modal-safe-area">
            <div className="rounded-2xl border p-6 modal-responsive bg-panel border-default" style={{ ['--modal-max-w' as string]: '24rem' }}>
              <h3 className="text-lg font-semibold mb-2 text-t-primary">{t('friends.removeFriendTitle')}</h3>
              <p className="text-sm mb-6 text-t-secondary">
                {t('friends.removeFriendConfirmDesc', { username: dmRemoveFriendConfirm.username })}
              </p>
              <div className="flex gap-3 justify-end">
                <button type="button" onClick={() => useUiStore.getState().setDmRemoveFriendConfirm(null)} className="px-4 py-2 text-sm rounded-lg bg-fill-hover hover:bg-fill-active text-t-secondary">{t('common.cancel')}</button>
                <button type="button" onClick={() => { apiClient.removeFriend(dmRemoveFriendConfirm.userId).catch(() => {}); useUiStore.getState().setDmRemoveFriendConfirm(null); }} className="btn-cta-danger px-4 py-2 text-sm rounded-xl">{t('common.remove')}</button>
              </div>
            </div>
          </div>
        )}

        <FloatingUserStatusBar
          theme={theme}
          onToggleMute={toggleMute}
          onToggleDeafen={toggleDeafen}
          onToggleScreenShare={toggleScreenShare}
          onToggleCamera={toggleCamera}
          onStatusChange={handleStatusChange}
          sidebarWidth={sidebarWidth}
          zoomLevel={cssZoomLevel}
          soundboardVolume={voiceSettings.soundboardVolume}
          onSoundboardVolumeChange={(v) => updateVoice({ soundboardVolume: v })}
          userPlan={displayUser?.stripePlan}
          connectedVoiceChannelName={connectedVoiceChannel?.name ?? null}
          isInStage={!!connectedStageChannelId}
          isStageSpeaker={connectedStageChannelId ? (activeStageSessions[connectedStageChannelId]?.speakers.some(s => s.userId === (currentUser?.id ?? '')) ?? false) : false}
          connectedStageChannelName={connectedStageChannelId ? servers.flatMap(s => s.channels).find(c => c.id === connectedStageChannelId)?.name ?? null : null}
          isInDmCall={!!activeDmCallChannelId}
          dmCallDisplayName={dmCallDisplayName}
          serverRegion={voiceServerRegion}
          onLeaveVoiceChannel={(connectedVoiceChannelId || activeDmCallChannelId || connectedStageChannelId) ? () => {
            if (connectedVoiceChannelId) {
              clearStoredVoiceChannel();
              disconnectFromVoice();
            }
            if (activeDmCallChannelId) {
              socketService.leaveDmCall(activeDmCallChannelId);
              setActiveDmCallChannelId(null);
            }
            if (connectedStageChannelId) {
              leaveStage();
            }
            if (isCameraOn) toggleCamera();
            if (isScreenSharing) toggleScreenShare();
          } : undefined}
        />
        {incomingDmCall && (
          <ContentErrorBoundary><Suspense fallback={null}><IncomingDMCallModal
            fromUsername={incomingDmCall.username}
            fromAvatar={incomingDmCall.avatar}
            fromAvatarEffect={incomingDmCall.avatarEffect}
            fromEffectivePlan={incomingDmCall.effectivePlan}
            fromBanner={incomingDmCall.banner}
            fromBannerPositionY={incomingDmCall.bannerPositionY}
            fromBannerZoom={incomingDmCall.bannerZoom}
            fromNameColor={incomingDmCall.nameColor}
            fromNameFont={incomingDmCall.nameFont}
            fromNameEffect={incomingDmCall.nameEffect}
            withVideo={incomingDmCall.withVideo}
            suppressSound={currentUserStatus === 'dnd'}
            needsUnlock={isChannelEncrypted(incomingDmCall.dmChannelId) && !dmKeyManager.isUnlocked()}
            onAccept={onAcceptIncomingDmCall}
            onDecline={onDeclineIncomingDmCall}
          /></Suspense></ContentErrorBoundary>
        )}
        {forwardPayload && (forwardPayload.attachment || forwardPayload.text) && (
          <Suspense fallback={null}>
            <ForwardImageModal
              open
              onClose={() => useUiStore.getState().setForwardPayload(null)}
              attachment={forwardPayload.attachment ?? undefined}
              text={forwardPayload.text}
              getFriends={apiClient.getFriends.bind(apiClient)}
              dmChannels={useDmStore.getState().dmChannels}
              servers={useServerStore.getState().servers}
              onSendToFriend={forwardToFriend}
              onSendToDM={forwardToDM}
              onSendToChannel={forwardToChannel}
              sourceEncryptedDm={forwardPayload.sourceEncryptedDm}
            />
          </Suspense>
        )}
        {deleteChannelConfirm && (
          <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4 modal-safe-area" style={{ backgroundColor: 'var(--overlay-backdrop)' }} onClick={() => useUiStore.getState().setDeleteChannelConfirm(null)}>
            <div className="rounded-xl border shadow-xl modal-responsive p-5 flex flex-col gap-4 bg-panel border-default" style={{ ['--modal-max-w' as string]: '28rem' }} onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-semibold text-t-primary">{t('channels.deleteChannel')}</h3>
              <p className="text-sm text-t-secondary">
                {deleteChannelConfirm.channel.type === 'text'
                  ? t('channels.deleteTextChannelConfirm')
                  : t('channels.deleteVoiceChannelConfirm')}
              </p>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => useUiStore.getState().setDeleteChannelConfirm(null)}
                  className="px-4 py-2 rounded-lg text-sm font-medium hover:bg-fill-active transition-colors text-t-secondary"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const { channel, serverId } = deleteChannelConfirm;
                    const server = servers.find((s) => s.id === serverId);
                    useUiStore.getState().setDeleteChannelConfirm(null);
                    if (!server) return;
                    try {
                      await deleteChannel(serverId, channel.id);
                      if (activeChannelId === channel.id) {
                        const remaining = server.channels.filter((c) => c.id !== channel.id);
                        const firstText = remaining.find((c) => c.type === 'text');
                        const targetCh = firstText ?? remaining[0];
                        if (targetCh) navigate(`/channels/${serverId}/${targetCh.id}`);
                      }
                    } catch (err) {
                      console.error('Failed to delete channel:', err);
                    }
                  }}
                  className="btn-cta-danger px-4 py-2 rounded-xl text-sm transition-colors"
                >
                  {t('common.delete')}
                </button>
              </div>
            </div>
          </div>
        )}
        <DeleteMessageModal
          onClose={() => useMessageStore.getState().setDeleteMessagePending(null)}
          onConfirm={() => confirmDeleteMessageAction(showGlobalToast as any)}
        />
        {showScreenSharePicker && !document.fullscreenElement && (() => {
          const activeServer = connectedVoiceChannelId
            ? servers.find((s) => s.channels.some((c) => c.id === connectedVoiceChannelId))
            : undefined;
          const pc = activeServer?.powerUpCount ?? 0;
          const bt = pc >= 14 ? 3 : pc >= 7 ? 2 : pc >= 2 ? 1 : 0;
          return (
            <Suspense fallback={null}>
              <ScreenSharePicker
                onConfirm={(q) => {
                  if (isScreenSharing) {
                    screenStream?.getTracks().forEach(track => track.stop());
                    useVoiceStore.getState().setScreenStream(null);
                    useVoiceStore.getState().setIsScreenSharing(false);
                    setTimeout(() => startScreenShareWithQuality(q), 100);
                  } else {
                    startScreenShareWithQuality(q);
                  }
                }}
                onChangeSource={(q) => {
                  screenStream?.getTracks().forEach(track => track.stop());
                  useVoiceStore.getState().setScreenStream(null);
                  useVoiceStore.getState().setIsScreenSharing(false);
                  useVoiceStore.getState().setShowScreenSharePicker(false);
                  updateScreenShareQuality(q);
                  setTimeout(() => startScreenShareWithQuality(q), 100);
                }}
                onCancel={() => useVoiceStore.getState().setShowScreenSharePicker(false)}
                userPlan={displayUser?.stripePlan}
                serverPowerUpTier={connectedVoiceChannelId ? bt : undefined}
                currentQuality={screenShareQuality}
                isSharing={isScreenSharing}
                screenShareCodec={voiceSettings.screenShareCodec ?? 'auto'}
                onCodecChange={(c) => updateVoice({ screenShareCodec: c })}
              />
            </Suspense>
          );
        })()}
        {activeDmCallChannelId && displayUser && (() => {
          const ch = useDmStore.getState().dmChannels.find((c) => c.id === activeDmCallChannelId);
          const callDisplayName = ch
            ? (ch.isGroup
                ? (ch.name || ch.otherUsers?.map((u) => formatUsername(u)).join(', ') || 'Group')
                : formatUsername(ch.otherUser ?? { username: 'Unknown', discriminator: '' }))
            : 'Unknown';
          const isViewingCallChannel = activeServerId === 'dm' && activeDmChannelId === activeDmCallChannelId;
          const callOtherUsers = ch
            ? ch.isGroup
              ? (ch.otherUsers ?? []).map((u) => ({ ...u }))
              : ch.otherUser ? [{ ...ch.otherUser }] : []
            : [];
          return (
            <ContentErrorBoundary><Suspense fallback={null}><DMCallView
              dmChannelId={activeDmCallChannelId}
              currentUser={displayUser}
              displayName={callDisplayName}
              withVideo={dmCallWithVideo}
              onEndCall={() => { setActiveDmCallChannelId(null); setDmCallWithVideo(false); setDmCallDeclinedUserIds([]); useVoiceStore.getState().setDmCallIsInitiator(null); useVoiceStore.getState().setDmCallIncomingMlsReady(undefined); }}
              participantVolumes={participantVolumes}
              onParticipantVolumeChange={setParticipantVolume}
              isDeafened={isDeafened}
              onToggleDeafen={toggleDeafen}
              isMutedFromParent={isMuted}
              onToggleMuteFromParent={toggleMute}
              speakerVolume={voiceSettings.speakerVolume / 100}
              speakerId={voiceSettings.selectedSpeakerId || undefined}
              userPlan={displayUser?.stripePlan}
              inlinePortalTargetId={isViewingCallChannel ? 'dm-call-inline-target' : undefined}
              otherUsers={callOtherUsers}
              declinedUserIds={dmCallDeclinedUserIds}
              screenShareCodec={voiceSettings.screenShareCodec ?? 'auto'}
              onCodecChange={(c) => updateVoice({ screenShareCodec: c })}
              localStream={dmLocalStream}
              remoteParticipants={dmRemoteParticipants}
              leave={dmLeave}
              error={dmError}
              disconnectedByInactivity={dmDisconnectedByInactivity}
              enableRemoteScreen={dmEnableRemoteScreen}
              disableRemoteScreen={dmDisableRemoteScreen}
              switchMicDevice={dmSwitchMicDevice}
              isE2ee={dmIsE2ee}
              isE2eeFailed={dmIsE2eeFailed}
              isE2eeEstablishing={dmIsE2eeEstablishing}
              isE2eeBlocked={dmIsE2eeBlocked}
              callKeyMode={dmCallKeyMode}
              startedAt={dmStartedAt}
            /></Suspense></ContentErrorBoundary>
          );
        })()}
        <PipHost
          activeDmCallChannelId={activeDmCallChannelId}
          voiceRemoteParticipants={voiceRemoteParticipants}
          stageRemoteParticipants={stageRemoteParticipants}
          dmRemoteParticipants={dmRemoteParticipants}
          voiceEnableRemoteScreen={voiceEnableRemoteScreen}
          stageEnableRemoteScreen={stageEnableRemoteScreen}
          dmEnableRemoteScreen={dmEnableRemoteScreen}
          dmLocalStream={dmLocalStream}
        />
      </div>
      </div>
      {updateError && (
        <div className="fixed bottom-6 right-6 z-[var(--z-max)] flex items-center gap-3 px-4 py-3 rounded-xl border border-red-500/20 shadow-2xl shadow-black/40"
          style={{ backgroundColor: 'rgba(8,15,25,0.95)', backdropFilter: 'blur(12px)' }}>
          <div className="w-2 h-2 rounded-full bg-red-400 shrink-0" />
          <p className="text-xs text-t-secondary">{t('updates.checkFailed')}</p>
          <button type="button" onClick={() => useAppStore.getState().setUpdateError(null)}
            className="text-[10px] font-bold text-white/40 hover:text-white/60 transition-colors">
            {t('common.dismiss')}
          </button>
        </div>
      )}
      {updateReady && activeServerId !== 'home' && (
        <div className="fixed bottom-6 right-6 z-[var(--z-max)] flex items-center gap-3 px-4 py-3 rounded-xl border border-[var(--cyan-accent)]/20 shadow-2xl shadow-black/40"
          style={{ backgroundColor: 'rgba(8,15,25,0.95)', backdropFilter: 'blur(12px)' }}>
          <div className="w-2 h-2 rounded-full bg-[var(--cyan-accent)] animate-pulse shrink-0" />
          <p className="text-xs font-medium text-t-primary">
            {t('updates.readyToInstall', { version: updateReady })}
          </p>
          <button type="button" onClick={() => { window.electron?.restartForUpdate?.(); }}
            className="btn-cta text-[10px] px-3 py-1.5 rounded-xl transition-all">
            {t('updates.restart')}
          </button>
          <button type="button" onClick={() => useAppStore.getState().setUpdateReady(null)}
            className="text-[10px] font-bold text-white/40 hover:text-white/60 transition-colors">
            {t('common.later')}
          </button>
        </div>
      )}

      {destructiveConfirm && (
        <ConfirmDialog
          title={destructiveConfirm.title}
          desc={destructiveConfirm.desc}
          confirmLabel={destructiveConfirm.confirmLabel}
          danger={destructiveConfirm.danger}
          onConfirm={() => { destructiveConfirm.onConfirm(); useUiStore.getState().setDestructiveConfirm(null); }}
          onCancel={() => useUiStore.getState().setDestructiveConfirm(null)}
        />
      )}

      <ReportMessageModal
        onClose={() => useUiStore.getState().setReportModal(null)}
        onSubmitted={() => useUiStore.getState().setReportModal(null)}
        showToast={showGlobalToast}
      />

      {recoveryKeyModal && (
        <RecoveryKeyModal
          recoveryKey={recoveryKeyModal}
          showPassphraseHint={recoveryKeyShowHint}
          onConfirm={() => {
            useUiStore.getState().setRecoveryKeyModal(null);
            useUiStore.getState().setRecoveryKeyShowHint(false);
          }}
        />
      )}

      {/* Mandatory onboarding takes precedence over the welcome screen. */}
      {activeOnboardingServerId && (
        <Suspense fallback={null}>
          <OnboardingModal serverId={activeOnboardingServerId} />
        </Suspense>
      )}

      {activeWelcomeServerId && !activeOnboardingServerId && (
        <Suspense fallback={null}>
          <WelcomeScreenModal
            serverId={activeWelcomeServerId}
            onClose={() => useCommunityStore.getState().closeWelcomeModal()}
          />
        </Suspense>
      )}

      {showRecoveryReminder && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[9998] w-full max-w-md px-4">
          <RecoveryKeyReminder
            onDismiss={() => {
              useUiStore.getState().setShowRecoveryReminder(false);
              apiClient.request('/dms/keys/dismiss-reminder', { method: 'POST' }).catch(() => {});
            }}
            onViewKey={() => {
              useUiStore.getState().setShowRecoveryReminder(false);
              useNavigationStore.getState().setAccountDeepLink({ page: 'encryption' });
              navigate('/channels/account');
            }}
          />
        </div>
      )}

      {e2ePassphraseModal && (
        <EncryptionPassphraseModal
          mode={e2ePassphraseModal}
          onSubmit={async (passphrase, remember) => {
            if (e2ePassphraseModal === 'setup') {
              const { recoveryKey } = await dmKeyManager.autoSetup(passphrase);
              if (remember) dmKeyManager.rememberOnDevice(passphrase);
              useUiStore.getState().setE2ePassphraseModal(null);
              // e2eLocked is now driven by the dmKeyManager event subscriber
              // wired in initializeEncryption — autoSetup -> setup() emits
              // 'unlocked' which the subscriber maps to setE2eLocked(false).
              useUiStore.getState().setRecoveryKeyShowHint(true);
              useUiStore.getState().setRecoveryKeyModal(recoveryKey);
            } else {
              try {
                await dmKeyManager.unlock(passphrase);
              } catch (unlockErr) {
                // Secure-and-Easy (passwordDerived) users after a password reset:
                // the server blob is still wrapped with the OLD password's Argon2id
                // key, so deriving from the new password fails AES-GCM auth. Fall
                // back to server-escrow recovery, mirroring the login-time flow in
                // App.tsx. Without this fallback, users who land in this modal with
                // a reset password are dead-ended unless they have the recovery key.
                if (dmKeyManager.isPasswordDerived()) {
                  await dmKeyManager.serverRecover(passphrase);
                } else {
                  throw unlockErr;
                }
              }
              // Server-recovery (passwordDerived) users are always-on: persist content keys
              // regardless of the remember checkbox so this device silently boots next time
              // (mirrors App.tsx login). Self users still honor the explicit checkbox.
              if (remember || dmKeyManager.isPasswordDerived()) dmKeyManager.rememberOnDevice(passphrase);
              useUiStore.getState().setE2ePassphraseModal(null);
              // e2eLocked is now driven by the dmKeyManager event subscriber
              // wired in initializeEncryption (unlock/serverRecover both emit
              // 'unlocked', which the subscriber maps to setE2eLocked(false)).
            }
            // Resume any action that was blocked on the unlock (e.g. voice-channel
            // join). Without this, the caller's flow dies when the gate returns
            // false, leaving the UI stuck on "Connecting to voice…".
            const pending = useUiStore.getState().pendingE2eAction;
            if (pending) {
              useUiStore.getState().setPendingE2eAction(null);
              try { pending(); } catch (err) { console.error('[e2e] pending action failed', err); }
            }
          }}
          onSkip={undefined}
          /* Close = deliberate dismiss. Clears the modal + any pending E2E
             action so the user isn't wedged on a "Connecting…" state that
             was waiting on this unlock. e2eLocked is centrally managed via
             the dmKeyManager event subscriber, so no manual resync needed
             on dismiss — closing without unlocking leaves the lock state
             unchanged from when the modal opened. */
          onClose={() => {
            useUiStore.getState().setE2ePassphraseModal(null);
            useUiStore.getState().setPendingE2eAction(null);
          }}
          onRecover={e2ePassphraseModal === 'unlock' ? async (recoveryKeyStr, newPassphrase) => {
            const { recoveryKey: newRecoveryKey } = await dmKeyManager.recover(recoveryKeyStr, newPassphrase);
            dmKeyManager.rememberOnDevice(newPassphrase);
            useUiStore.getState().setE2ePassphraseModal(null);
            // e2eLocked is now driven by the dmKeyManager event subscriber
            // (recover() emits 'unlocked').
            useUiStore.getState().setRecoveryKeyShowHint(false);
            useUiStore.getState().setRecoveryKeyModal(newRecoveryKey);
            const pending = useUiStore.getState().pendingE2eAction;
            if (pending) {
              useUiStore.getState().setPendingE2eAction(null);
              try { pending(); } catch (err) { console.error('[e2e] pending action failed', err); }
            }
          } : undefined}
        />
      )}

      <AnimatePresence>
        {globalToast && (
          <GlobalToast
            id={globalToast.id}
            message={globalToast.message}
            type={globalToast.type}
            onDismiss={dismissToast}
            actionLabel={globalToast.actionLabel}
            onAction={globalToast.onAction}
          />
        )}
      </AnimatePresence>
      <CookieConsent />
      {templateUrlCode && (
        <TemplatePreviewPage
          code={templateUrlCode}
          onServerCreated={(server) => {
            if (!useServerStore.getState().servers.some(s => s.id === server.id)) {
              useServerStore.getState().addServer(server);
            }
            useNavigationStore.getState().setTemplateUrlCode(null);
            navigate(`/channels/${server.id}/${server.channels[0]?.id ?? ''}`);
          }}
          onCancel={() => {
            useNavigationStore.getState().setTemplateUrlCode(null);
            navigate('/home');
          }}
          userName={displayUser?.username}
        />
      )}
      {pollModalOpen && <Suspense fallback={null}><PollCreationModal isOpen onClose={() => useUiStore.getState().setPollModalOpen(false)} onCreatePoll={adaptedCreatePollFinal} /></Suspense>}
      {threadCreationModal && <Suspense fallback={null}><ThreadCreationModal isOpen parentMessageId={threadCreationModal.parentMessageId} parentMessagePreview={threadCreationModal.parentContent} onClose={() => useUiStore.getState().setThreadCreationModal(null)} onCreateThread={adaptedSubmitCreateThread} /></Suspense>}
      {stageSettingsModal && <Suspense fallback={null}><StageSettingsModal isOpen mode={stageSettingsModal.mode} onClose={() => useVoiceStore.getState().setStageSettingsModal(null)} onSubmit={stageSettingsModal.mode === 'edit' ? adaptedEditStage : adaptedStartStage} initialTopic={stageSettingsModal.mode === 'edit' ? (activeStageSessions[stageSettingsModal.channelId]?.topic ?? '') : ''} initialMaxSpeakers={stageSettingsModal.mode === 'edit' ? (activeStageSessions[stageSettingsModal.channelId]?.maxSpeakers ?? 10) : 10} initialTextChatEnabled={stageSettingsModal.mode === 'edit' ? (activeStageSessions[stageSettingsModal.channelId]?.textChatEnabled ?? false) : false} initialAllowEmojis={stageSettingsModal.mode === 'edit' ? (activeStageSessions[stageSettingsModal.channelId]?.allowEmojis ?? false) : false} initialAllowStickers={stageSettingsModal.mode === 'edit' ? (activeStageSessions[stageSettingsModal.channelId]?.allowStickers ?? false) : false} initialAllowGifs={stageSettingsModal.mode === 'edit' ? (activeStageSessions[stageSettingsModal.channelId]?.allowGifs ?? false) : false} serverMembers={membersForList.map(m => ({ id: m.id, username: m.username, avatar: m.avatar, discriminator: m.discriminator }))} loadServerRoles={activeServerId && typeof activeServerId === 'string' ? async () => { const roles = await apiClient.getServerRoles(activeServerId); return roles.map(r => ({ id: r.id, name: r.name, color: r.color })); } : undefined} currentUserId={currentUser?.id ?? ''} /></Suspense>}
      {threadBrowserOpen && activeServerId && typeof activeServerId === 'string' && <Suspense fallback={null}><ThreadBrowser serverId={activeServerId} channels={activeServerTextChannels} open={threadBrowserOpen} onClose={() => useUiStore.getState().setThreadBrowserOpen(false)} onOpenThread={(thread) => { openThread(thread); useUiStore.getState().setThreadBrowserOpen(false); }} canManageThreads={serverHasPerm(activeServer, 'createThreads') || serverHasPerm(activeServer, 'manageMessages')} onUnarchiveThread={async (thread) => { if (activeServerId) { try { await apiClient.editThread(thread.channelId, activeServerId, thread.id, { archived: false }); } catch { /* best effort */ } } }} anchorRef={threadBrowserBtnRef} /></Suspense>}
      {showE2eInfoBanner && (
        <div className="fixed top-14 left-1/2 -translate-x-1/2 z-[100] max-w-md w-full px-4 animate-in fade-in slide-in-from-top-2 duration-300">
          <div
            className="rounded-xl border border-[var(--glass-border)] p-4 flex items-start gap-3 shadow-2xl"
            style={{ backgroundColor: 'var(--bg-panel)', backdropFilter: 'blur(20px)' }}
          >
            <Shield size={18} className="text-emerald-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                End-to-end encryption is active
              </p>
              <p className="text-[11px] mt-1" style={{ color: 'var(--text-secondary)' }}>
                Your DMs, files, and calls are encrypted. Your encryption passphrase is your account password — you'll need it if you sign in on a new device. You can manage encryption and enable automatic password sync in Settings → Encryption.
              </p>
            </div>
            <button
              onClick={() => useUiStore.getState().setShowE2eInfoBanner(false)}
              className="p-1 rounded-lg hover:bg-fill-active transition-colors shrink-0"
              style={{ color: 'var(--text-secondary)' }}
            >
              <CloseIcon size={14} />
            </button>
          </div>
        </div>
      )}
      {useNavigator && launcherOpen && (
        // Own ErrorBoundary so a render fault in the overlay (e.g. a malformed
        // persisted layout) degrades to a closed launcher instead of taking down
        // the whole app. fallback=null + onError closes the launcher so the
        // resting trigger and the rest of the app keep working.
        <ErrorBoundary fallback={null} onError={() => useUiStore.getState().setLauncherOpen(false)}>
          <Suspense fallback={null}>
            <HowlNavigator
              onClose={() => useUiStore.getState().setLauncherOpen(false)}
              onNavigate={handleNavTarget}
              titleBarPad={titleBarPad}
              onCreateServer={adaptedCreateServer}
              onJoinServer={adaptedJoinByInvite}
              onServerCreated={adaptedServerCreatedFromTemplate}
              userName={currentUser?.username}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
    </UserProvider>
  );
}
