// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { create } from 'zustand';
import type { StageSession } from '../types';
import type { VoiceParticipantInfo, ScreenShareQuality } from './types';

interface VoiceState {
  connectedVoiceChannelId: string | null;
  connectedStageChannelId: string | null;
  voiceChannelParticipants: Array<{
    userId: string; username: string; nickname?: string; discriminator?: string;
    avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number;
    roleColor?: string; roleStyle?: 'solid' | 'gradient' | 'holographic';
    nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string;
    effectivePlan?: string; stream: MediaStream | null;
    isMuted?: boolean; isDeafened?: boolean;
    serverMuted?: boolean; serverDeafened?: boolean;
  }>;
  allVoiceChannelParticipants: Record<string, Array<{
    id: string; username: string; discriminator?: string; avatar?: string;
    nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string;
    effectivePlan?: string; roleColor?: string; roleStyle?: string;
    isScreenSharing?: boolean;
  }>>;
  serverVoiceSummary: Record<string, Record<string, VoiceParticipantInfo[]>>;
  serverStageSummary: Record<string, Record<string, VoiceParticipantInfo[]>>;
  activeStageSessions: Record<string, StageSession>;
  /** per-stage-channel flag: true once the local user holds the
   *  verified host SFrame key (host always true; audience/speaker flips true
   *  when stage-e2ee-key arrives, false while still waiting). Drives the
   *  audience amber "key not yet arrived" shield in useStageRoom. Set by
   *  useStageE2ee; absent/false means no verified key yet. */
  stageE2eeKeyed: Record<string, boolean>;
  isMuted: boolean;
  isDeafened: boolean;
  serverMuted: boolean;
  serverDeafened: boolean;
  isScreenSharing: boolean;
  isCameraOn: boolean;
  screenStream: MediaStream | null;
  cameraStream: MediaStream | null;
  /** The local user's microphone output for the currently-connected voice
   * channel. Exposed so side-panel UI can render a speaking indicator for
   * the local user without threading the stream through multiple prop
   * layers. `null` when not in a voice channel. */
  localVoiceStream: MediaStream | null;
  participantVolumes: Record<string, number>;
  screenShareVolumes: Record<string, number>;
  screenShareQuality: ScreenShareQuality;
  showScreenSharePicker: boolean;
  showCameraPreview: boolean;
  stageSettingsModal: { channelId: string; mode: 'start' | 'edit' } | null;
  /** True if the local user pressed Call (initiator), false if they
   *  Accepted an incoming-dm-call (recipient). Null when no call is being
   *  established. Lets useDMCall pick the right branch: a recipient with no
   *  MLS key blocks honestly rather than starting a call the caller could not
   *  key. */
  dmCallIsInitiator: boolean | null;
  /** mlsCallReady from the accepted incoming-dm-call. Undefined when
   *  there is no accepted incoming call (idle, initiator side) or the
   *  caller predates MLS-keyed calls. */
  dmCallIncomingMlsReady: boolean | undefined;
  /** When set, VoiceChannel picks this up on first render after joining and
   *  auto-calls `enableRemoteScreen(userId)` + starts watching. Cleared once
   *  consumed so reconnects don't re-trigger. Set by the sidebar "watch
   *  stream" button before calling switchVoiceChannel. */
  autoWatchScreenUserId: string | null;

  // DM call input streams
  // Camera / screen streams acquired in DMCallView and published here
  // so App.tsx can feed them to useDMCall (which lives at the top level).
  dmCameraStream: MediaStream | null;
  dmScreenStream: MediaStream | null;

  /** Consecutive mic-silence duration in ms for the currently-active voice
   *  channel engine. Updated ~1 Hz by App.tsx's onMicSilenceUpdate callback.
   *  0 when audio is present or no engine is active. */
  voiceSilenceMs: number;
  /** Same as voiceSilenceMs but for the DM call engine. */
  dmSilenceMs: number;

  setConnectedVoiceChannelId(id: string | null | ((prev: string | null) => string | null)): void;
  setConnectedStageChannelId(id: string | null | ((prev: string | null) => string | null)): void;
  setVoiceChannelParticipants(p: VoiceState['voiceChannelParticipants'] | ((prev: VoiceState['voiceChannelParticipants']) => VoiceState['voiceChannelParticipants'])): void;
  setAllVoiceChannelParticipants(p: VoiceState['allVoiceChannelParticipants'] | ((prev: VoiceState['allVoiceChannelParticipants']) => VoiceState['allVoiceChannelParticipants'])): void;
  setServerVoiceSummary(s: VoiceState['serverVoiceSummary'] | ((prev: VoiceState['serverVoiceSummary']) => VoiceState['serverVoiceSummary'])): void;
  setServerStageSummary(s: VoiceState['serverStageSummary'] | ((prev: VoiceState['serverStageSummary']) => VoiceState['serverStageSummary'])): void;
  setActiveStageSessions(s: VoiceState['activeStageSessions'] | ((prev: VoiceState['activeStageSessions']) => VoiceState['activeStageSessions'])): void;
  setStageE2eeKeyed(channelId: string, keyed: boolean): void;
  setIsMuted(v: boolean | ((prev: boolean) => boolean)): void;
  setIsDeafened(v: boolean | ((prev: boolean) => boolean)): void;
  setServerMuted(v: boolean): void;
  setServerDeafened(v: boolean): void;
  setIsScreenSharing(v: boolean): void;
  setIsCameraOn(v: boolean): void;
  setScreenStream(stream: MediaStream | null): void;
  setCameraStream(stream: MediaStream | null): void;
  setLocalVoiceStream(stream: MediaStream | null): void;
  setParticipantVolumes(v: Record<string, number>): void;
  setScreenShareVolumes(v: Record<string, number>): void;
  setScreenShareQuality(q: ScreenShareQuality): void;
  setShowScreenSharePicker(v: boolean): void;
  setShowCameraPreview(v: boolean): void;
  setStageSettingsModal(v: VoiceState['stageSettingsModal']): void;
  setDmCallIsInitiator(v: boolean | null): void;
  setDmCallIncomingMlsReady(v: boolean | undefined): void;
  setAutoWatchScreenUserId(userId: string | null): void;
  setDmCameraStream(s: MediaStream | null): void;
  setDmScreenStream(s: MediaStream | null): void;
  setVoiceSilenceMs(ms: number): void;
  setDmSilenceMs(ms: number): void;
  /** Clean up voice/stage data for a specific server (call on server leave/removal) */
  clearServerData(serverId: string, channelIds?: string[]): void;
}

const readParticipantVolumes = (): Record<string, number> => {
  try {
    const raw = localStorage.getItem('howl_participant_volumes');
    if (raw) return JSON.parse(raw) as Record<string, number>;
  } catch { /* ignore */ }
  return {};
};

const readScreenShareVolumes = (): Record<string, number> => {
  try {
    const raw = localStorage.getItem('howl_screenshare_volumes');
    if (raw) return JSON.parse(raw) as Record<string, number>;
  } catch { /* ignore */ }
  return {};
};

const DEFAULT_SCREEN_SHARE_QUALITY: ScreenShareQuality = { resolution: '1080p' as const, fps: 30 as const };

const readScreenShareQuality = (): ScreenShareQuality => {
  try {
    const raw = localStorage.getItem('howl_screenshare_quality');
    if (raw) return JSON.parse(raw) as ScreenShareQuality;
  } catch { /* ignore */ }
  return DEFAULT_SCREEN_SHARE_QUALITY;
};

export const useVoiceStore = create<VoiceState>()((set, get) => ({
  connectedVoiceChannelId: null,
  connectedStageChannelId: null,
  voiceChannelParticipants: [],
  allVoiceChannelParticipants: {},
  serverVoiceSummary: {},
  serverStageSummary: {},
  activeStageSessions: {},
  stageE2eeKeyed: {},
  isMuted: false,
  isDeafened: false,
  serverMuted: false,
  serverDeafened: false,
  isScreenSharing: false,
  isCameraOn: false,
  screenStream: null,
  cameraStream: null,
  localVoiceStream: null,
  participantVolumes: readParticipantVolumes(),
  screenShareVolumes: readScreenShareVolumes(),
  screenShareQuality: readScreenShareQuality(),
  showScreenSharePicker: false,
  showCameraPreview: false,
  stageSettingsModal: null,
  dmCallIsInitiator: null,
  dmCallIncomingMlsReady: undefined,
  autoWatchScreenUserId: null,
  dmCameraStream: null,
  dmScreenStream: null,
  voiceSilenceMs: 0,
  dmSilenceMs: 0,

  setConnectedVoiceChannelId(id) {
    if (typeof id === 'function') set((state) => ({ connectedVoiceChannelId: (id as (prev: string | null) => string | null)(state.connectedVoiceChannelId) }));
    else set({ connectedVoiceChannelId: id });
  },
  setConnectedStageChannelId(id) {
    if (typeof id === 'function') set((state) => ({ connectedStageChannelId: (id as (prev: string | null) => string | null)(state.connectedStageChannelId) }));
    else set({ connectedStageChannelId: id });
  },
  setVoiceChannelParticipants(p) {
    const prev = get().voiceChannelParticipants;
    const next = typeof p === 'function'
      ? (p as (prev: VoiceState['voiceChannelParticipants']) => VoiceState['voiceChannelParticipants'])(prev)
      : p;
    if (next === prev) return;
    // Stop MediaStream tracks for removed participants
    const nextIds = new Set(next.map(x => x.userId));
    for (const participant of prev) {
      if (!nextIds.has(participant.userId) && participant.stream) {
        participant.stream.getTracks().forEach(t => t.stop());
      }
    }
    set({ voiceChannelParticipants: next });
  },
  setAllVoiceChannelParticipants(p) {
    if (typeof p === 'function') {
      const prev = get().allVoiceChannelParticipants;
      const next = (p as (prev: VoiceState['allVoiceChannelParticipants']) => VoiceState['allVoiceChannelParticipants'])(prev);
      if (next === prev) return;
      set({ allVoiceChannelParticipants: next });
    } else {
      if (p === get().allVoiceChannelParticipants) return;
      set({ allVoiceChannelParticipants: p });
    }
  },
  setServerVoiceSummary(s) {
    if (typeof s === 'function') {
      const prev = get().serverVoiceSummary;
      const next = (s as (prev: VoiceState['serverVoiceSummary']) => VoiceState['serverVoiceSummary'])(prev);
      if (next === prev) return;
      set({ serverVoiceSummary: next });
    } else {
      if (s === get().serverVoiceSummary) return;
      set({ serverVoiceSummary: s });
    }
  },
  setServerStageSummary(s) {
    if (typeof s === 'function') {
      const prev = get().serverStageSummary;
      const next = (s as (prev: VoiceState['serverStageSummary']) => VoiceState['serverStageSummary'])(prev);
      if (next === prev) return;
      set({ serverStageSummary: next });
    } else {
      if (s === get().serverStageSummary) return;
      set({ serverStageSummary: s });
    }
  },
  setActiveStageSessions(s) {
    if (typeof s === 'function') {
      const prev = get().activeStageSessions;
      const next = (s as (prev: VoiceState['activeStageSessions']) => VoiceState['activeStageSessions'])(prev);
      if (next === prev) return;
      set({ activeStageSessions: next });
    } else {
      if (s === get().activeStageSessions) return;
      set({ activeStageSessions: s });
    }
  },
  setStageE2eeKeyed(channelId, keyed) {
    const prev = get().stageE2eeKeyed;
    if (prev[channelId] === keyed) return;
    set({ stageE2eeKeyed: { ...prev, [channelId]: keyed } });
  },
  setIsMuted(v) {
    if (typeof v === 'function') set((state) => ({ isMuted: (v as (prev: boolean) => boolean)(state.isMuted) }));
    else set({ isMuted: v });
  },
  setIsDeafened(v) {
    if (typeof v === 'function') set((state) => ({ isDeafened: (v as (prev: boolean) => boolean)(state.isDeafened) }));
    else set({ isDeafened: v });
  },
  setServerMuted(v) { set({ serverMuted: v }); },
  setServerDeafened(v) { set({ serverDeafened: v }); },
  setIsScreenSharing(v) { set({ isScreenSharing: v }); },
  setIsCameraOn(v) { set({ isCameraOn: v }); },

  setScreenStream(stream) {
    set((state) => {
      state.screenStream?.getTracks().forEach((t) => t.stop());
      return { screenStream: stream };
    });
  },

  setCameraStream(stream) {
    set((state) => {
      state.cameraStream?.getTracks().forEach((t) => t.stop());
      return { cameraStream: stream };
    });
  },

  setLocalVoiceStream(stream) {
    // Don't stop tracks — the stream is owned by useVoiceChannel/CallEngine
    // and they'll clean it up on disconnect. This store field is a reference
    // for read-only consumers (speaking indicators, etc.).
    if (get().localVoiceStream === stream) return;
    set({ localVoiceStream: stream });
  },

  setParticipantVolumes(v) {
    try { localStorage.setItem('howl_participant_volumes', JSON.stringify(v)); } catch { /* ignore */ }
    set({ participantVolumes: v });
  },

  setScreenShareVolumes(v) {
    try { localStorage.setItem('howl_screenshare_volumes', JSON.stringify(v)); } catch { /* ignore */ }
    set({ screenShareVolumes: v });
  },

  setScreenShareQuality(q) {
    try { localStorage.setItem('howl_screenshare_quality', JSON.stringify(q)); } catch { /* ignore */ }
    set({ screenShareQuality: q });
  },

  setShowScreenSharePicker(v) { set({ showScreenSharePicker: v }); },
  setShowCameraPreview(v) { set({ showCameraPreview: v }); },
  setStageSettingsModal(v) { set({ stageSettingsModal: v }); },
  setDmCallIsInitiator(v) { set({ dmCallIsInitiator: v }); },
  setDmCallIncomingMlsReady(v) { set({ dmCallIncomingMlsReady: v }); },
  setAutoWatchScreenUserId(userId) { set({ autoWatchScreenUserId: userId }); },
  setDmCameraStream(s) {
    if (get().dmCameraStream === s) return;
    set({ dmCameraStream: s });
  },
  setDmScreenStream(s) {
    if (get().dmScreenStream === s) return;
    set({ dmScreenStream: s });
  },
  setVoiceSilenceMs(ms) { set({ voiceSilenceMs: ms }); },
  setDmSilenceMs(ms) { set({ dmSilenceMs: ms }); },

  clearServerData(serverId, channelIds) {
    set(state => {
      let changed = false;
      const updates: Partial<VoiceState> = {};
      if (state.serverVoiceSummary[serverId]) {
        const { [serverId]: _, ...rest } = state.serverVoiceSummary;
        updates.serverVoiceSummary = rest;
        changed = true;
      }
      if (state.serverStageSummary[serverId]) {
        const { [serverId]: _, ...rest } = state.serverStageSummary;
        updates.serverStageSummary = rest;
        changed = true;
      }
      // activeStageSessions + stageE2eeKeyed are keyed by channelId, not serverId
      if (channelIds && channelIds.length > 0) {
        const chSet = new Set(channelIds);
        const filtered: Record<string, StageSession> = {};
        let removed = false;
        for (const [chId, session] of Object.entries(state.activeStageSessions)) {
          if (chSet.has(chId)) { removed = true; }
          else { filtered[chId] = session; }
        }
        if (removed) {
          updates.activeStageSessions = filtered;
          changed = true;
        }
        const filteredKeyed: Record<string, boolean> = {};
        let removedKeyed = false;
        for (const [chId, keyed] of Object.entries(state.stageE2eeKeyed)) {
          if (chSet.has(chId)) { removedKeyed = true; }
          else { filteredKeyed[chId] = keyed; }
        }
        if (removedKeyed) {
          updates.stageE2eeKeyed = filteredKeyed;
          changed = true;
        }
      }
      return changed ? updates : state;
    });
  },
}));
