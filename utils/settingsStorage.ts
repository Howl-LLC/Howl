// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Types

import { migrateLegacyCombo } from './keybindFormat';
import { BT_PREFS_CAP } from '../services/audio/btQualityPreferences';

export type RoleColorMode = 'in-names' | 'next-to-names' | 'hidden';
export type StickerAnimation = 'always' | 'interaction' | 'never';
export type SpoilerMode = 'on-click' | 'on-servers-i-moderate' | 'always';
export type TimeFormat = 'auto' | '12h' | '24h';
export type NoiseSuppression = 'none' | 'low' | 'medium' | 'high';
export type OpusSignal = 'auto' | 'voice' | 'music';
export type InputProfile = 'isolation' | 'studio' | 'custom';
/** Noise-suppression engine selector. Mutually exclusive:
 *   - 'off'     — no ML denoising; pure DSP chain from the mic.
 *   - 'rnnoise' — Xiph's RNNoise (~2-5% CPU, light quality).
 *   - 'dfn3-light' — DeepFilterNet 3 tiny (~3-7% CPU, Krisp-tier quality). Default.
 *   - 'dfn3-max'   — DeepFilterNet 3 base (~8-15% CPU, highest quality).
 *  Both DFN3 variants bundle their ONNX model; RNNoise remains as the
 *  legacy low-cost option. Toggling picks one engine at a time. */
export type NoiseEngine = 'off' | 'rnnoise' | 'dfn3-light' | 'dfn3-max';
/** Auto-frame smoothness level.
 *  - off: disabled entirely (face detection not loaded).
 *  - medium: lerp=0.15, detect every 2 frames (~30Hz). Responsive but a touch
 *    steppy on fast motion — the original "on" behavior before this split.
 *  - high: lerp=0.06, detect every frame (~60Hz) with spring-damper velocity
 *    smoothing. Much smoother glide; costs ~2× detection CPU. */
export type AutoFrameMode = 'off' | 'medium' | 'high';

export interface AccessibilitySettings {
  saturation: number;
  saturationCustomColors: boolean;
  alwaysUnderlineLinks: boolean;
  highContrast: boolean;
  roleColorMode: RoleColorMode;
  syncMotionWithOS: boolean;
  reducedMotion: boolean;
  autoplayGifs: boolean;
  playAnimatedEmoji: boolean;
  stickerAnimation: StickerAnimation;
  showSendButton: boolean;
  legacyChatInput: boolean;
  ttsRate: number;
  showOnOffIndicators: boolean;
  /** Browser spellcheck on the message composer. Default true. Toggle via the
   * composer right-click context menu. */
  composerSpellcheck: boolean;
  /** Locale codes Chromium should spell-check against. Web ignores this
   *  (browser uses its own setting); Electron pushes the list to
   *  `session.setSpellCheckerLanguages`. Empty array → fallback to
   *  Electron's `app.getLocale()`. Each entry must be a code returned by
   *  `availableSpellCheckerLanguages` (e.g. 'en-US', 'es-ES', 'fr-FR'). */
  spellcheckLanguages: string[];
}

export interface ChatSettings {
  displayImagesLinks: boolean;
  displayImagesUploaded: boolean;
  imageDescriptions: boolean;
  showEmbeds: boolean;
  showEmojiReactions: boolean;
  convertEmoticons: boolean;
  dmSearchAll: boolean;
  spoilerMode: SpoilerMode;
  previewTextBox: boolean;
  dmSidebarShowActivity: boolean;
}

export interface KeybindEntry {
  id: string;
  action: string;
  keys: string;
  enabled: boolean;
  /** If true AND running in Electron, the binding fires even when Howl is
   *  unfocused (via the native keyboard hook in main). Ignored on web.
   *  Undefined is treated as false. */
  global?: boolean;
}

export interface StreamerSettings {
  enabled: boolean;
  autoDetectOBS: boolean;
  hidePersonalInfo: boolean;
  hideInviteLinks: boolean;
  disableSounds: boolean;
  disableNotifications: boolean;
  hideFromCapture: boolean;
}

export interface VoiceSettings {
  selectedMicId: string;
  selectedSpeakerId: string;
  selectedCameraId: string;
  micVolume: number;
  speakerVolume: number;
  autoInputSensitivity: boolean;
  inputSensitivity: number;
  noiseSuppression: NoiseSuppression;
  echoCancellation: boolean;
  autoGainControl: boolean;
  pushToTalk: boolean;
  pushToTalkKey: string;
  showStreamPreviews: boolean;
  showAdvancedStream: boolean;
  soundDeafen: boolean;
  soundUndeafen: boolean;
  soundMute: boolean;
  soundUnmute: boolean;
  soundConnect: boolean;
  soundDisconnect: boolean;
  soundboardVolume: number;
  streamAttenuation?: boolean;
  streamAttenuationStrength?: number;
  opusBitrate: number;
  opusFec: boolean;
  opusDtx: boolean;
  opusPacketLoss: number;
  opusSignal: OpusSignal;
  opusStereo: boolean;
  inputProfile: InputProfile;
  screenShareCodec: 'auto' | 'h264' | 'vp9' | 'av1';
  forceSwEncoding: boolean;
  // Video effects
  videoBackgroundMode: 'off' | 'blur' | 'image';
  videoBackgroundBlurRadius: number;
  videoBackgroundImageUrl: string;
  videoColorGradeEnabled: boolean;
  videoColorGrade: 'none' | 'warm' | 'cool' | 'noir' | 'vivid' | 'faded';
  /** Face-tracking auto-framing mode. Replaces the old `autoFrameEnabled`
   *  boolean with a 3-level smoothness selector (off / medium / high). */
  autoFrameMode: AutoFrameMode;
  autoFrameZoom: number;
  /** When true, auto-frame computes zoom dynamically from the face bounding
   *  box size so the subject keeps a target portion of the frame regardless
   *  of distance from the camera. Overrides `autoFrameZoom` at runtime. */
  autoFrameZoomAuto: boolean;
  /** Show preview modal before enabling camera (Discord-style). Default true. */
  cameraPreviewModal: boolean;
  /** When sharing a screen with system audio, silence Howl's own participant
   * audio playback so the share doesn't capture other people's voices and
   * echo them back. Default true. */
  muteHowlAudioWhileSharing: boolean;
  /** Active ML noise-suppression engine. Mutually exclusive selection —
   *  at most one engine runs at a time. Defaults to 'dfn3-light'. Changes
   *  take effect on the next mic-chain build (re-join the call to apply). */
  noiseEngine: NoiseEngine;
  /** Show a warning when the microphone isn't picking up audio during a
   *  call. Controls both the mic-icon indicator and the dismissible banner.
   *  Default true. */
  notifyOnNoMicAudio: boolean;
}

export interface AdvancedSettings {
  hardwareAcceleration: boolean;
  showGameLibrary: boolean;
}

// Helpers

function getJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function setJSON<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    console.warn('Settings storage: failed to write', key, '(quota may be exceeded)');
  }
}

function getNum(key: string, min: number, max: number): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= min && n <= max) return n;
    return null;
  } catch {
    return null;
  }
}

function setNum(key: string, v: number, min: number, max: number): void {
  try {
    localStorage.setItem(key, String(Math.max(min, Math.min(max, v))));
  } catch {
    console.warn('Settings storage: failed to write', key, '(quota may be exceeded)');
  }
}

function getBool(key: string): boolean | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

function setBool(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    console.warn('Settings storage: failed to write', key, '(quota may be exceeded)');
  }
}

function getStr<T extends string>(key: string, allowed: T[]): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw != null && (allowed as string[]).includes(raw)) return raw as T;
    return null;
  } catch {
    return null;
  }
}

function setStr(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    console.warn('Settings storage: failed to write', key, '(quota may be exceeded)');
  }
}

// Accessibility

const DEFAULTS_A: AccessibilitySettings = {
  saturation: 100,
  saturationCustomColors: false,
  alwaysUnderlineLinks: false,
  highContrast: false,
  roleColorMode: 'in-names',
  syncMotionWithOS: true,
  reducedMotion: false,
  autoplayGifs: true,
  playAnimatedEmoji: true,
  stickerAnimation: 'always',
  showSendButton: false,
  legacyChatInput: false,
  ttsRate: 100,
  showOnOffIndicators: false,
  composerSpellcheck: true,
  spellcheckLanguages: [],
};

export function getStoredAccessibility(): AccessibilitySettings {
  return {
    saturation: getNum('howl_a11y_saturation', 0, 100) ?? DEFAULTS_A.saturation,
    saturationCustomColors: getBool('howl_a11y_sat_custom') ?? DEFAULTS_A.saturationCustomColors,
    alwaysUnderlineLinks: getBool('howl_a11y_underline_links') ?? DEFAULTS_A.alwaysUnderlineLinks,
    highContrast: getBool('howl_a11y_high_contrast') ?? DEFAULTS_A.highContrast,
    roleColorMode: getStr<RoleColorMode>('howl_a11y_role_color', ['in-names', 'next-to-names', 'hidden']) ?? DEFAULTS_A.roleColorMode,
    syncMotionWithOS: getBool('howl_a11y_sync_motion') ?? DEFAULTS_A.syncMotionWithOS,
    reducedMotion: getBool('howl_a11y_reduced_motion') ?? DEFAULTS_A.reducedMotion,
    autoplayGifs: getBool('howl_a11y_autoplay_gifs') ?? DEFAULTS_A.autoplayGifs,
    playAnimatedEmoji: getBool('howl_a11y_animated_emoji') ?? DEFAULTS_A.playAnimatedEmoji,
    stickerAnimation: getStr<StickerAnimation>('howl_a11y_sticker_anim', ['always', 'interaction', 'never']) ?? DEFAULTS_A.stickerAnimation,
    showSendButton: getBool('howl_a11y_send_btn') ?? DEFAULTS_A.showSendButton,
    legacyChatInput: getBool('howl_a11y_legacy_input') ?? DEFAULTS_A.legacyChatInput,
    ttsRate: getNum('howl_a11y_tts_rate', 50, 200) ?? DEFAULTS_A.ttsRate,
    showOnOffIndicators: getBool('howl_a11y_onoff_indicators') ?? DEFAULTS_A.showOnOffIndicators,
    composerSpellcheck: getBool('howl_a11y_composer_spellcheck') ?? DEFAULTS_A.composerSpellcheck,
    spellcheckLanguages: (() => {
      try {
        const raw = localStorage.getItem('howl_a11y_spellcheck_languages');
        if (!raw) return DEFAULTS_A.spellcheckLanguages;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return DEFAULTS_A.spellcheckLanguages;
        return parsed.filter((s): s is string => typeof s === 'string');
      } catch { return DEFAULTS_A.spellcheckLanguages; }
    })(),
  };
}

export function setStoredAccessibility(patch: Partial<AccessibilitySettings>): void {
  if (patch.saturation !== undefined) setNum('howl_a11y_saturation', patch.saturation, 0, 100);
  if (patch.saturationCustomColors !== undefined) setBool('howl_a11y_sat_custom', patch.saturationCustomColors);
  if (patch.alwaysUnderlineLinks !== undefined) setBool('howl_a11y_underline_links', patch.alwaysUnderlineLinks);
  if (patch.highContrast !== undefined) setBool('howl_a11y_high_contrast', patch.highContrast);
  if (patch.roleColorMode !== undefined) setStr('howl_a11y_role_color', patch.roleColorMode);
  if (patch.syncMotionWithOS !== undefined) setBool('howl_a11y_sync_motion', patch.syncMotionWithOS);
  if (patch.reducedMotion !== undefined) setBool('howl_a11y_reduced_motion', patch.reducedMotion);
  if (patch.autoplayGifs !== undefined) setBool('howl_a11y_autoplay_gifs', patch.autoplayGifs);
  if (patch.playAnimatedEmoji !== undefined) setBool('howl_a11y_animated_emoji', patch.playAnimatedEmoji);
  if (patch.stickerAnimation !== undefined) setStr('howl_a11y_sticker_anim', patch.stickerAnimation);
  if (patch.showSendButton !== undefined) setBool('howl_a11y_send_btn', patch.showSendButton);
  if (patch.legacyChatInput !== undefined) setBool('howl_a11y_legacy_input', patch.legacyChatInput);
  if (patch.ttsRate !== undefined) setNum('howl_a11y_tts_rate', patch.ttsRate, 50, 200);
  if (patch.showOnOffIndicators !== undefined) setBool('howl_a11y_onoff_indicators', patch.showOnOffIndicators);
  if (patch.composerSpellcheck !== undefined) setBool('howl_a11y_composer_spellcheck', patch.composerSpellcheck);
  if (patch.spellcheckLanguages !== undefined) {
    try {
      const safe = patch.spellcheckLanguages.filter((s): s is string => typeof s === 'string');
      localStorage.setItem('howl_a11y_spellcheck_languages', JSON.stringify(safe));
    } catch { /* quota / blocked */ }
  }
}

// Chat

const DEFAULTS_C: ChatSettings = {
  displayImagesLinks: true,
  displayImagesUploaded: true,
  imageDescriptions: false,
  showEmbeds: true,
  showEmojiReactions: true,
  convertEmoticons: true,
  dmSearchAll: false,
  spoilerMode: 'on-click',
  previewTextBox: true,
  dmSidebarShowActivity: false,
};

export function getStoredChatSettings(): ChatSettings {
  return {
    displayImagesLinks: getBool('howl_chat_img_links') ?? DEFAULTS_C.displayImagesLinks,
    displayImagesUploaded: getBool('howl_chat_img_uploads') ?? DEFAULTS_C.displayImagesUploaded,
    imageDescriptions: getBool('howl_chat_img_desc') ?? DEFAULTS_C.imageDescriptions,
    showEmbeds: getBool('howl_chat_embeds') ?? DEFAULTS_C.showEmbeds,
    showEmojiReactions: getBool('howl_chat_emoji_react') ?? DEFAULTS_C.showEmojiReactions,
    convertEmoticons: getBool('howl_chat_emoticons') ?? DEFAULTS_C.convertEmoticons,
    dmSearchAll: getBool('howl_chat_dm_search_all') ?? DEFAULTS_C.dmSearchAll,
    spoilerMode: getStr<SpoilerMode>('howl_chat_spoiler', ['on-click', 'on-servers-i-moderate', 'always']) ?? DEFAULTS_C.spoilerMode,
    previewTextBox: getBool('howl_chat_preview_text') ?? DEFAULTS_C.previewTextBox,
    dmSidebarShowActivity: getBool('howl_chat_dm_activity') ?? DEFAULTS_C.dmSidebarShowActivity,
  };
}

export function setStoredChatSettings(patch: Partial<ChatSettings>): void {
  if (patch.displayImagesLinks !== undefined) setBool('howl_chat_img_links', patch.displayImagesLinks);
  if (patch.displayImagesUploaded !== undefined) setBool('howl_chat_img_uploads', patch.displayImagesUploaded);
  if (patch.imageDescriptions !== undefined) setBool('howl_chat_img_desc', patch.imageDescriptions);
  if (patch.showEmbeds !== undefined) setBool('howl_chat_embeds', patch.showEmbeds);
  if (patch.showEmojiReactions !== undefined) setBool('howl_chat_emoji_react', patch.showEmojiReactions);
  if (patch.convertEmoticons !== undefined) setBool('howl_chat_emoticons', patch.convertEmoticons);
  if (patch.dmSearchAll !== undefined) setBool('howl_chat_dm_search_all', patch.dmSearchAll);
  if (patch.spoilerMode !== undefined) setStr('howl_chat_spoiler', patch.spoilerMode);
  if (patch.previewTextBox !== undefined) setBool('howl_chat_preview_text', patch.previewTextBox);
  if (patch.dmSidebarShowActivity !== undefined) setBool('howl_chat_dm_activity', patch.dmSidebarShowActivity);
}

// Keybinds

export const DEFAULT_KEYBINDS: KeybindEntry[] = [];

export function getStoredKeybinds(): KeybindEntry[] {
  const raw = getJSON<KeybindEntry[]>('howl_keybinds', DEFAULT_KEYBINDS);
  // Lazy migration from the legacy CTRL+SHIFT+M format to the new
  // side-specific LCtrl+LShift+KeyM format. Runs at most once per stored
  // bind — the migration function is a no-op on already-new combos.
  // Persists the migrated list so subsequent reads are already clean.
  let mutated = false;
  const migrated = raw.map((bind) => {
    if (!bind.keys) return bind;
    const next = migrateLegacyCombo(bind.keys);
    if (next !== bind.keys) { mutated = true; return { ...bind, keys: next }; }
    return bind;
  });
  if (mutated) setJSON('howl_keybinds', migrated);
  return migrated;
}

export function setStoredKeybinds(binds: KeybindEntry[]): void {
  setJSON('howl_keybinds', binds);
}

/** Global-keybinds master kill-switch. When false, the native hook is fully
 *  unloaded — no global bindings fire regardless of per-binding state. */
export function getKeybindsGlobalMasterEnabled(): boolean {
  return getBool('howl_keybinds_global_master_enabled') ?? true;
}

export function setKeybindsGlobalMasterEnabled(enabled: boolean): void {
  setBool('howl_keybinds_global_master_enabled', enabled);
}

// Streamer

const DEFAULTS_S: StreamerSettings = {
  enabled: false,
  autoDetectOBS: true,
  hidePersonalInfo: true,
  hideInviteLinks: true,
  disableSounds: true,
  disableNotifications: true,
  hideFromCapture: false,
};

export function getStoredStreamer(): StreamerSettings {
  return {
    enabled: getBool('howl_streamer_enabled') ?? DEFAULTS_S.enabled,
    autoDetectOBS: getBool('howl_streamer_auto_obs') ?? DEFAULTS_S.autoDetectOBS,
    hidePersonalInfo: getBool('howl_streamer_hide_info') ?? DEFAULTS_S.hidePersonalInfo,
    hideInviteLinks: getBool('howl_streamer_hide_invites') ?? DEFAULTS_S.hideInviteLinks,
    disableSounds: getBool('howl_streamer_mute_sounds') ?? DEFAULTS_S.disableSounds,
    disableNotifications: getBool('howl_streamer_mute_notif') ?? DEFAULTS_S.disableNotifications,
    hideFromCapture: getBool('howl_streamer_hide_capture') ?? DEFAULTS_S.hideFromCapture,
  };
}

export function setStoredStreamer(patch: Partial<StreamerSettings>): void {
  if (patch.enabled !== undefined) setBool('howl_streamer_enabled', patch.enabled);
  if (patch.autoDetectOBS !== undefined) setBool('howl_streamer_auto_obs', patch.autoDetectOBS);
  if (patch.hidePersonalInfo !== undefined) setBool('howl_streamer_hide_info', patch.hidePersonalInfo);
  if (patch.hideInviteLinks !== undefined) setBool('howl_streamer_hide_invites', patch.hideInviteLinks);
  if (patch.disableSounds !== undefined) setBool('howl_streamer_mute_sounds', patch.disableSounds);
  if (patch.disableNotifications !== undefined) setBool('howl_streamer_mute_notif', patch.disableNotifications);
  if (patch.hideFromCapture !== undefined) setBool('howl_streamer_hide_capture', patch.hideFromCapture);
}

// Voice & Video

const DEFAULTS_V: VoiceSettings = {
  selectedMicId: '',
  selectedSpeakerId: '',
  selectedCameraId: '',
  micVolume: 100,
  speakerVolume: 100,
  autoInputSensitivity: true,
  inputSensitivity: 50,
  noiseSuppression: 'high',
  echoCancellation: true,
  autoGainControl: true,
  pushToTalk: false,
  pushToTalkKey: '',
  showStreamPreviews: true,
  showAdvancedStream: false,
  soundDeafen: true,
  soundUndeafen: true,
  soundMute: true,
  soundUnmute: true,
  soundConnect: true,
  soundDisconnect: true,
  soundboardVolume: 100,
  opusBitrate: 64,
  opusFec: true,
  opusDtx: true,
  opusPacketLoss: 15,
  opusSignal: 'voice',
  opusStereo: false,
  inputProfile: 'isolation',
  screenShareCodec: 'auto',
  forceSwEncoding: false,
  videoBackgroundMode: 'off',
  videoBackgroundBlurRadius: 10,
  videoBackgroundImageUrl: '',
  videoColorGradeEnabled: false,
  videoColorGrade: 'none',
  autoFrameMode: 'off',
  autoFrameZoom: 1.3,
  autoFrameZoomAuto: false,
  cameraPreviewModal: true,
  muteHowlAudioWhileSharing: true,
  // DFN3 Light — Krisp-tier denoising via deepfilternet3-noise-filter
  // (Apache-2.0 OR MIT). Model + WASM are bundled under public/models/dfn3/
  // and fetched from the app's own origin on first enable.
  noiseEngine: 'dfn3-light',
  notifyOnNoMicAudio: true,
};

/** Migration-aware read of the auto-frame mode. If the new key is present,
 *  use it. Otherwise fall back to the legacy boolean: `true` → 'medium',
 *  anything else → 'off'. New key takes precedence once written. */
function readAutoFrameMode(): AutoFrameMode {
  const explicit = getStr<AutoFrameMode>('howl_voice_af_mode', ['off', 'medium', 'high']);
  if (explicit) return explicit;
  const legacy = getBool('howl_voice_af_on');
  if (legacy === true) return 'medium';
  return 'off';
}

/** Migration-aware read of the legacy input profile. 'nvidia-broadcast' used
 *  to be a valid option (since removed). Existing users with that stored
 *  preference get remapped to 'isolation' so the next load doesn't trip the
 *  narrowed union. Other values pass through untouched. */
function readInputProfile(): InputProfile {
  try {
    const raw = localStorage.getItem('howl_voice_input_profile');
    if (raw === 'nvidia-broadcast') {
      try { localStorage.setItem('howl_voice_input_profile', 'isolation'); } catch { /* quota */ }
      return 'isolation';
    }
  } catch { /* localStorage may throw in private / sandboxed modes */ }
  return getStr<InputProfile>('howl_voice_input_profile', ['isolation', 'studio', 'custom']) ?? DEFAULTS_V.inputProfile;
}

/** Migration-aware read of the noise-suppression engine. Legacy boolean
 *  `howl_voice_adv_ns` (RNNoise on/off) is preserved:
 *   - true  → 'rnnoise' (user explicitly opted in — keep their choice)
 *   - false → 'off'    (user explicitly opted out — keep their choice)
 *  Absence → DEFAULTS_V.noiseEngine (DFN3 Light). Once the new key is
 *  written explicitly, it takes precedence. */
function readNoiseEngine(): NoiseEngine {
  const explicit = getStr<NoiseEngine>('howl_voice_noise_engine', ['off', 'rnnoise', 'dfn3-light', 'dfn3-max']);
  if (explicit) return explicit;
  const legacyRnnoise = getBool('howl_voice_adv_ns');
  if (legacyRnnoise === true) return 'rnnoise';
  if (legacyRnnoise === false) return 'off';
  return DEFAULTS_V.noiseEngine;
}

export function getStoredVoice(): VoiceSettings {
  return {
    selectedMicId: localStorage.getItem('howl_voice_mic_id') ?? DEFAULTS_V.selectedMicId,
    selectedSpeakerId: localStorage.getItem('howl_voice_speaker_id') ?? DEFAULTS_V.selectedSpeakerId,
    selectedCameraId: localStorage.getItem('howl_voice_camera_id') ?? DEFAULTS_V.selectedCameraId,
    micVolume: getNum('howl_voice_mic_vol', 0, 200) ?? DEFAULTS_V.micVolume,
    speakerVolume: getNum('howl_voice_speaker_vol', 0, 200) ?? DEFAULTS_V.speakerVolume,
    autoInputSensitivity: getBool('howl_voice_auto_sens') ?? DEFAULTS_V.autoInputSensitivity,
    inputSensitivity: getNum('howl_voice_input_sens', 0, 100) ?? DEFAULTS_V.inputSensitivity,
    noiseSuppression: getStr<NoiseSuppression>('howl_voice_noise_sup', ['none', 'low', 'medium', 'high']) ?? DEFAULTS_V.noiseSuppression,
    echoCancellation: getBool('howl_voice_echo') ?? DEFAULTS_V.echoCancellation,
    autoGainControl: getBool('howl_voice_agc') ?? DEFAULTS_V.autoGainControl,
    pushToTalk: getBool('howl_voice_ptt') ?? DEFAULTS_V.pushToTalk,
    pushToTalkKey: localStorage.getItem('howl_voice_ptt_key') ?? DEFAULTS_V.pushToTalkKey,
    showStreamPreviews: getBool('howl_voice_stream_prev') ?? DEFAULTS_V.showStreamPreviews,
    showAdvancedStream: getBool('howl_voice_adv_stream') ?? DEFAULTS_V.showAdvancedStream,
    soundDeafen: getBool('howl_voice_snd_deafen') ?? DEFAULTS_V.soundDeafen,
    soundUndeafen: getBool('howl_voice_snd_undeafen') ?? DEFAULTS_V.soundUndeafen,
    soundMute: getBool('howl_voice_snd_mute') ?? DEFAULTS_V.soundMute,
    soundUnmute: getBool('howl_voice_snd_unmute') ?? DEFAULTS_V.soundUnmute,
    soundConnect: getBool('howl_voice_snd_connect') ?? DEFAULTS_V.soundConnect,
    soundDisconnect: getBool('howl_voice_snd_disconnect') ?? DEFAULTS_V.soundDisconnect,
    soundboardVolume: getNum('howl_voice_sb_vol', 0, 100) ?? DEFAULTS_V.soundboardVolume,
    opusBitrate: getNum('howl_voice_opus_bitrate', 6, 510) ?? DEFAULTS_V.opusBitrate,
    opusFec: getBool('howl_voice_opus_fec') ?? DEFAULTS_V.opusFec,
    opusDtx: getBool('howl_voice_opus_dtx') ?? DEFAULTS_V.opusDtx,
    opusPacketLoss: getNum('howl_voice_opus_pktloss', 0, 100) ?? DEFAULTS_V.opusPacketLoss,
    opusSignal: getStr<OpusSignal>('howl_voice_opus_signal', ['auto', 'voice', 'music']) ?? DEFAULTS_V.opusSignal,
    opusStereo: getBool('howl_voice_opus_stereo') ?? DEFAULTS_V.opusStereo,
    inputProfile: readInputProfile(),
    screenShareCodec: getStr<VoiceSettings['screenShareCodec']>('howl_voice_ss_codec', ['auto', 'h264', 'vp9', 'av1']) ?? DEFAULTS_V.screenShareCodec,
    forceSwEncoding: getBool('howl_voice_force_sw') ?? DEFAULTS_V.forceSwEncoding,
    videoBackgroundMode: getStr<VoiceSettings['videoBackgroundMode']>('howl_voice_bg_mode', ['off', 'blur', 'image']) ?? DEFAULTS_V.videoBackgroundMode,
    videoBackgroundBlurRadius: getNum('howl_voice_bg_blur', 1, 20) ?? DEFAULTS_V.videoBackgroundBlurRadius,
    videoBackgroundImageUrl: localStorage.getItem('howl_voice_bg_img') ?? DEFAULTS_V.videoBackgroundImageUrl,
    videoColorGradeEnabled: getBool('howl_voice_cg_on') ?? DEFAULTS_V.videoColorGradeEnabled,
    videoColorGrade: getStr<VoiceSettings['videoColorGrade']>('howl_voice_cg', ['none', 'warm', 'cool', 'noir', 'vivid', 'faded']) ?? DEFAULTS_V.videoColorGrade,
    autoFrameMode: readAutoFrameMode(),
    autoFrameZoom: getNum('howl_voice_af_zoom', 1, 3) ?? DEFAULTS_V.autoFrameZoom,
    autoFrameZoomAuto: getBool('howl_voice_af_zoom_auto') ?? DEFAULTS_V.autoFrameZoomAuto,
    cameraPreviewModal: getBool('howl_voice_cam_preview') ?? DEFAULTS_V.cameraPreviewModal,
    muteHowlAudioWhileSharing: getBool('howl_voice_mute_while_sharing') ?? DEFAULTS_V.muteHowlAudioWhileSharing,
    noiseEngine: readNoiseEngine(),
    notifyOnNoMicAudio: getBool('howl_voice_notify_no_mic') ?? DEFAULTS_V.notifyOnNoMicAudio,
  };
}

export function setStoredVoice(patch: Partial<VoiceSettings>): void {
  if (patch.selectedMicId !== undefined) setStr('howl_voice_mic_id', patch.selectedMicId);
  if (patch.selectedSpeakerId !== undefined) setStr('howl_voice_speaker_id', patch.selectedSpeakerId);
  if (patch.selectedCameraId !== undefined) setStr('howl_voice_camera_id', patch.selectedCameraId);
  if (patch.micVolume !== undefined) setNum('howl_voice_mic_vol', patch.micVolume, 0, 200);
  if (patch.speakerVolume !== undefined) setNum('howl_voice_speaker_vol', patch.speakerVolume, 0, 200);
  if (patch.autoInputSensitivity !== undefined) setBool('howl_voice_auto_sens', patch.autoInputSensitivity);
  if (patch.inputSensitivity !== undefined) setNum('howl_voice_input_sens', patch.inputSensitivity, 0, 100);
  if (patch.noiseSuppression !== undefined) setStr('howl_voice_noise_sup', patch.noiseSuppression);
  if (patch.echoCancellation !== undefined) setBool('howl_voice_echo', patch.echoCancellation);
  if (patch.autoGainControl !== undefined) setBool('howl_voice_agc', patch.autoGainControl);
  if (patch.pushToTalk !== undefined) setBool('howl_voice_ptt', patch.pushToTalk);
  if (patch.pushToTalkKey !== undefined) setStr('howl_voice_ptt_key', patch.pushToTalkKey);
  if (patch.showStreamPreviews !== undefined) setBool('howl_voice_stream_prev', patch.showStreamPreviews);
  if (patch.showAdvancedStream !== undefined) setBool('howl_voice_adv_stream', patch.showAdvancedStream);
  if (patch.soundDeafen !== undefined) setBool('howl_voice_snd_deafen', patch.soundDeafen);
  if (patch.soundUndeafen !== undefined) setBool('howl_voice_snd_undeafen', patch.soundUndeafen);
  if (patch.soundMute !== undefined) setBool('howl_voice_snd_mute', patch.soundMute);
  if (patch.soundUnmute !== undefined) setBool('howl_voice_snd_unmute', patch.soundUnmute);
  if (patch.soundConnect !== undefined) setBool('howl_voice_snd_connect', patch.soundConnect);
  if (patch.soundDisconnect !== undefined) setBool('howl_voice_snd_disconnect', patch.soundDisconnect);
  if (patch.soundboardVolume !== undefined) setNum('howl_voice_sb_vol', patch.soundboardVolume, 0, 100);
  if (patch.opusBitrate !== undefined) setNum('howl_voice_opus_bitrate', patch.opusBitrate, 6, 510);
  if (patch.opusFec !== undefined) setBool('howl_voice_opus_fec', patch.opusFec);
  if (patch.opusDtx !== undefined) setBool('howl_voice_opus_dtx', patch.opusDtx);
  if (patch.opusPacketLoss !== undefined) setNum('howl_voice_opus_pktloss', patch.opusPacketLoss, 0, 100);
  if (patch.opusSignal !== undefined) setStr('howl_voice_opus_signal', patch.opusSignal);
  if (patch.opusStereo !== undefined) setBool('howl_voice_opus_stereo', patch.opusStereo);
  if (patch.inputProfile !== undefined) setStr('howl_voice_input_profile', patch.inputProfile);
  if (patch.screenShareCodec !== undefined) setStr('howl_voice_ss_codec', patch.screenShareCodec);
  if (patch.forceSwEncoding !== undefined) setBool('howl_voice_force_sw', patch.forceSwEncoding);
  if (patch.videoBackgroundMode !== undefined) setStr('howl_voice_bg_mode', patch.videoBackgroundMode);
  if (patch.videoBackgroundBlurRadius !== undefined) setNum('howl_voice_bg_blur', patch.videoBackgroundBlurRadius, 1, 20);
  if (patch.videoBackgroundImageUrl !== undefined) setStr('howl_voice_bg_img', patch.videoBackgroundImageUrl);
  if (patch.videoColorGradeEnabled !== undefined) setBool('howl_voice_cg_on', patch.videoColorGradeEnabled);
  if (patch.videoColorGrade !== undefined) setStr('howl_voice_cg', patch.videoColorGrade);
  if (patch.autoFrameMode !== undefined) {
    setStr('howl_voice_af_mode', patch.autoFrameMode);
    // Clear legacy boolean key so downgrades from a future release don't
    // resurrect a stale "enabled=true" while the new mode is 'off'.
    try { localStorage.removeItem('howl_voice_af_on'); } catch { /* quota / disabled */ }
  }
  if (patch.autoFrameZoomAuto !== undefined) setBool('howl_voice_af_zoom_auto', patch.autoFrameZoomAuto);
  if (patch.autoFrameZoom !== undefined) setNum('howl_voice_af_zoom', patch.autoFrameZoom, 1, 3);
  if (patch.cameraPreviewModal !== undefined) setBool('howl_voice_cam_preview', patch.cameraPreviewModal);
  if (patch.muteHowlAudioWhileSharing !== undefined) setBool('howl_voice_mute_while_sharing', patch.muteHowlAudioWhileSharing);
  if (patch.noiseEngine !== undefined) {
    setStr('howl_voice_noise_engine', patch.noiseEngine);
    // Clear the legacy boolean key so future reads use the new canonical
    // field instead of re-deriving from the deprecated toggle.
    try { localStorage.removeItem('howl_voice_adv_ns'); } catch { /* quota / disabled */ }
  }
  if (patch.notifyOnNoMicAudio !== undefined) setBool('howl_voice_notify_no_mic', patch.notifyOnNoMicAudio);
}

// Language & Time

export function getStoredLanguage(): string {
  return localStorage.getItem('howl_language') ?? 'en-US';
}
export function setStoredLanguage(lang: string): void {
  setStr('howl_language', lang);
}

export function getStoredTimeFormat(): TimeFormat {
  return getStr<TimeFormat>('howl_time_format', ['auto', '12h', '24h']) ?? 'auto';
}
export function setStoredTimeFormat(tf: TimeFormat): void {
  setStr('howl_time_format', tf);
}

// Advanced

export function getStoredAdvanced(): AdvancedSettings {
  return {
    hardwareAcceleration: getBool('howl_adv_hw_accel') ?? true,
    showGameLibrary: getBool('howl_adv_game_lib') ?? true,
  };
}

export function setStoredAdvanced(patch: Partial<AdvancedSettings>): void {
  if (patch.hardwareAcceleration !== undefined) setBool('howl_adv_hw_accel', patch.hardwareAcceleration);
  if (patch.showGameLibrary !== undefined) setBool('howl_adv_game_lib', patch.showGameLibrary);
}

// Game Overlay

export type OverlayWidgetMode = 'compact' | 'detailed';
export type OverlayCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type OverlayAvatarSize = 'small' | 'medium' | 'large';
export type OverlayNameDisplay = 'always' | 'speaking-only' | 'never';
export type OverlayUserDisplay = 'always' | 'speaking-only' | 'never';

export interface GameOverlaySettings {
  enabled: boolean;
  clickableRegions: boolean;
  lockKeybind: string;
  widgetMode: OverlayWidgetMode;
  widgetCorner: OverlayCorner;
  avatarSize: OverlayAvatarSize;
  displayNames: OverlayNameDisplay;
  showUsers: OverlayUserDisplay;
  maxUsersDisplayed: number;
  toastCorner: OverlayCorner;
  toastMessages: boolean;
  toastWelcome: boolean;
  toastGoLive: boolean;
  toastGameActivity: boolean;
  toastNowPlaying: boolean;
}

const DEFAULTS_OV: GameOverlaySettings = {
  enabled: false,
  clickableRegions: true,
  lockKeybind: 'SHIFT+BACKQUOTE',
  widgetMode: 'detailed',
  widgetCorner: 'top-left',
  avatarSize: 'medium',
  displayNames: 'always',
  showUsers: 'always',
  maxUsersDisplayed: 8,
  toastCorner: 'bottom-right',
  toastMessages: true,
  toastWelcome: true,
  toastGoLive: true,
  toastGameActivity: true,
  toastNowPlaying: true,
};

export function getStoredGameOverlay(): GameOverlaySettings {
  return {
    enabled: getBool('howl_overlay_enabled') ?? DEFAULTS_OV.enabled,
    clickableRegions: getBool('howl_overlay_clickable') ?? DEFAULTS_OV.clickableRegions,
    lockKeybind: localStorage.getItem('howl_overlay_keybind') ?? DEFAULTS_OV.lockKeybind,
    widgetMode: getStr<OverlayWidgetMode>('howl_overlay_widget_mode', ['compact', 'detailed']) ?? DEFAULTS_OV.widgetMode,
    widgetCorner: getStr<OverlayCorner>('howl_overlay_widget_corner', ['top-left', 'top-right', 'bottom-left', 'bottom-right']) ?? DEFAULTS_OV.widgetCorner,
    avatarSize: getStr<OverlayAvatarSize>('howl_overlay_avatar_size', ['small', 'medium', 'large']) ?? DEFAULTS_OV.avatarSize,
    displayNames: getStr<OverlayNameDisplay>('howl_overlay_display_names', ['always', 'speaking-only', 'never']) ?? DEFAULTS_OV.displayNames,
    showUsers: getStr<OverlayUserDisplay>('howl_overlay_show_users', ['always', 'speaking-only', 'never']) ?? DEFAULTS_OV.showUsers,
    maxUsersDisplayed: getNum('howl_overlay_max_users', 0, 25) ?? DEFAULTS_OV.maxUsersDisplayed,
    toastCorner: getStr<OverlayCorner>('howl_overlay_toast_corner', ['top-left', 'top-right', 'bottom-left', 'bottom-right']) ?? DEFAULTS_OV.toastCorner,
    toastMessages: getBool('howl_overlay_toast_msg') ?? DEFAULTS_OV.toastMessages,
    toastWelcome: getBool('howl_overlay_toast_welcome') ?? DEFAULTS_OV.toastWelcome,
    toastGoLive: getBool('howl_overlay_toast_golive') ?? DEFAULTS_OV.toastGoLive,
    toastGameActivity: getBool('howl_overlay_toast_activity') ?? DEFAULTS_OV.toastGameActivity,
    toastNowPlaying: getBool('howl_overlay_toast_playing') ?? DEFAULTS_OV.toastNowPlaying,
  };
}

export function setStoredGameOverlay(patch: Partial<GameOverlaySettings>): void {
  if (patch.enabled !== undefined) setBool('howl_overlay_enabled', patch.enabled);
  if (patch.clickableRegions !== undefined) setBool('howl_overlay_clickable', patch.clickableRegions);
  if (patch.lockKeybind !== undefined) setStr('howl_overlay_keybind', patch.lockKeybind);
  if (patch.widgetMode !== undefined) setStr('howl_overlay_widget_mode', patch.widgetMode);
  if (patch.widgetCorner !== undefined) setStr('howl_overlay_widget_corner', patch.widgetCorner);
  if (patch.avatarSize !== undefined) setStr('howl_overlay_avatar_size', patch.avatarSize);
  if (patch.displayNames !== undefined) setStr('howl_overlay_display_names', patch.displayNames);
  if (patch.showUsers !== undefined) setStr('howl_overlay_show_users', patch.showUsers);
  if (patch.maxUsersDisplayed !== undefined) setNum('howl_overlay_max_users', patch.maxUsersDisplayed, 0, 25);
  if (patch.toastCorner !== undefined) setStr('howl_overlay_toast_corner', patch.toastCorner);
  if (patch.toastMessages !== undefined) setBool('howl_overlay_toast_msg', patch.toastMessages);
  if (patch.toastWelcome !== undefined) setBool('howl_overlay_toast_welcome', patch.toastWelcome);
  if (patch.toastGoLive !== undefined) setBool('howl_overlay_toast_golive', patch.toastGoLive);
  if (patch.toastGameActivity !== undefined) setBool('howl_overlay_toast_activity', patch.toastGameActivity);
  if (patch.toastNowPlaying !== undefined) setBool('howl_overlay_toast_playing', patch.toastNowPlaying);
}

// Bluetooth Audio Quality

export type BtDeviceChoice = 'split';

export interface BtDevicePreference {
  /** Primary match key — stable across the user's devices */
  label: string;
  /** Last-seen deviceId within this origin for fast exact-match */
  deviceId?: string;
  /** Currently only 'split' is stored; absence = "ask on next encounter" */
  choice: BtDeviceChoice;
  /** ms timestamp for LRU eviction when the cap is exceeded */
  lastSeenAt: number;
}

export interface BluetoothAudioSettings {
  /** Global kill switch. When false: no probing, no banners, no auto-splits, no indicators. */
  autoOptimizeBluetoothAudio: boolean;
  /** Label of the last non-BT mic the user actively used (tier !== 'bad' on a non-BT-labeled device). Used to rank split-devices candidates. */
  lastNonBtMicLabel: string | null;
}

const DEFAULTS_BT_AUDIO: BluetoothAudioSettings = {
  autoOptimizeBluetoothAudio: true,
  lastNonBtMicLabel: null,
};

export function getStoredBluetoothAudio(): BluetoothAudioSettings {
  let storedLabel: string | null = DEFAULTS_BT_AUDIO.lastNonBtMicLabel;
  try {
    const raw = localStorage.getItem('howl_bt_audio_last_non_bt_mic_label');
    if (raw !== null) storedLabel = raw;
  } catch { /* localStorage throws in private mode / sandboxed contexts */ }
  return {
    autoOptimizeBluetoothAudio:
      getBool('howl_bt_audio_auto_optimize') ?? DEFAULTS_BT_AUDIO.autoOptimizeBluetoothAudio,
    lastNonBtMicLabel: storedLabel,
  };
}

export function setStoredBluetoothAudio(patch: Partial<BluetoothAudioSettings>): void {
  if (patch.autoOptimizeBluetoothAudio !== undefined) {
    setBool('howl_bt_audio_auto_optimize', patch.autoOptimizeBluetoothAudio);
  }
  if (patch.lastNonBtMicLabel !== undefined) {
    if (patch.lastNonBtMicLabel === null) {
      try { localStorage.removeItem('howl_bt_audio_last_non_bt_mic_label'); } catch { /* ignore */ }
    } else {
      setStr('howl_bt_audio_last_non_bt_mic_label', patch.lastNonBtMicLabel);
    }
  }
}

function isValidBtDevicePreference(x: unknown): x is BtDevicePreference {
  if (!x || typeof x !== 'object') return false;
  const p = x as Partial<BtDevicePreference>;
  return typeof p.label === 'string'
    && p.choice === 'split'
    && typeof p.lastSeenAt === 'number'
    && Number.isFinite(p.lastSeenAt)
    && (p.deviceId === undefined || typeof p.deviceId === 'string');
}

export function getStoredBtDevicePreferences(): BtDevicePreference[] {
  const raw = getJSON<unknown[]>('howl_bt_device_prefs', []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidBtDevicePreference);
}

export function setStoredBtDevicePreferences(prefs: BtDevicePreference[]): void {
  // Cap + LRU sort is the responsibility of the preferences module; storage is pass-through.
  const valid = prefs.filter(isValidBtDevicePreference).slice(0, BT_PREFS_CAP);
  setJSON('howl_bt_device_prefs', valid);
}
