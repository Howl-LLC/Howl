// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import streamDeck from '@elgato/streamdeck';
import { Connection } from './state/connection.js';
import { HOWL_APP_VERSION } from './generated/version.js';

// Voice actions
import { VoiceMuteAction } from './actions/voice/mute.js';
import { VoiceDeafenAction } from './actions/voice/deafen.js';
import { VoicePttAction } from './actions/voice/ptt.js';
import { VoiceCameraAction } from './actions/voice/camera.js';
import { VoiceHangupAction } from './actions/voice/hangup.js';
import { VoiceSwitchChannelAction } from './actions/voice/switch-channel.js';
import { VoiceDeviceSwitcherAction } from './actions/voice/device-switcher.js';

// Call actions
import { CallAnswerAction } from './actions/call/answer.js';
import { CallDeclineAction } from './actions/call/decline.js';
import { CallEndAction } from './actions/call/end.js';

// Presence actions
import { PresenceRotateAction } from './actions/presence/rotate.js';
import { PresenceSetAction } from './actions/presence/set.js';

// Reaction actions
import { ReactionReactFocusedAction } from './actions/reaction/react-focused.js';

// Channel / DM actions
import { ChannelSwitchAction } from './actions/channel/switch.js';
import { DmOpenPinnedAction } from './actions/channel/dm-open-pinned.js';

// Thread actions
import { ThreadStartAction } from './actions/thread/start.js';
import { ThreadLockToggleAction } from './actions/thread/lock-toggle.js';

// Stage actions
import { StageStartEndAction } from './actions/stage/start-end.js';
import { StageRemoveSpeakerAction } from './actions/stage/remove-speaker.js';

// Indicator actions
import { IndicatorUnreadSummaryAction } from './actions/indicator/unread-summary.js';

// Initialize the bridge connection singleton. The version is auto-synced
// from Howl's root package.json by streamdeck-plugin/scripts/sync-version.mjs
// on every build, so the pair handshake reports the same version Howl shows.
Connection.init({
  pluginId: 'com.howlpro.streamdeck',
  displayName: 'Howl',
  version: HOWL_APP_VERSION,
});

// Broadcast pair-state changes to whichever Howl Property Inspector is
// currently visible. The PI's pair-panel.js overlay reads these messages
// and shows / hides the "Open Howl to pair" screen accordingly. When no
// PI is visible the SDK no-ops the send.
Connection.get().onPairPendingChange((pending) => {
  try {
    void streamDeck.ui.sendToPropertyInspector({
      type: 'pair-state',
      pending,
    });
  } catch { /* swallow — no PI visible */ }
});

// Register all voice actions (7).
streamDeck.actions.registerAction(new VoiceMuteAction());
streamDeck.actions.registerAction(new VoiceDeafenAction());
streamDeck.actions.registerAction(new VoicePttAction());
streamDeck.actions.registerAction(new VoiceCameraAction());
streamDeck.actions.registerAction(new VoiceHangupAction());
streamDeck.actions.registerAction(new VoiceSwitchChannelAction());
streamDeck.actions.registerAction(new VoiceDeviceSwitcherAction());

// Register all call actions (3).
streamDeck.actions.registerAction(new CallAnswerAction());
streamDeck.actions.registerAction(new CallDeclineAction());
streamDeck.actions.registerAction(new CallEndAction());

// Register presence actions (2).
streamDeck.actions.registerAction(new PresenceRotateAction());
streamDeck.actions.registerAction(new PresenceSetAction());

// Register reaction actions (1).
streamDeck.actions.registerAction(new ReactionReactFocusedAction());

// Register channel / DM actions (2).
streamDeck.actions.registerAction(new ChannelSwitchAction());
streamDeck.actions.registerAction(new DmOpenPinnedAction());

// Register thread actions (2).
streamDeck.actions.registerAction(new ThreadStartAction());
streamDeck.actions.registerAction(new ThreadLockToggleAction());

// Register stage actions (2).
streamDeck.actions.registerAction(new StageStartEndAction());
streamDeck.actions.registerAction(new StageRemoveSpeakerAction());

// Register indicator actions (1).
streamDeck.actions.registerAction(new IndicatorUnreadSummaryAction());

// Connect to the Stream Deck software. This must be the last call —
// the SDK enters its event loop after connect().
streamDeck.connect();
