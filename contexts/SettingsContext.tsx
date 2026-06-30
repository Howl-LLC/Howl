// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppTheme } from '../App';
import { getStoredCustomTheme, applyCustomTheme, clearCustomTheme } from '../services/themeUtils';
import {
  getStoredUiDensity, setStoredUiDensity, type UiDensity,
  getStoredChatMessageDisplay, setStoredChatMessageDisplay, type ChatMessageDisplay,
  getStoredMessageGroupSpacing, setStoredMessageGroupSpacing,
  getStoredChatFontSize, setStoredChatFontSize,
  getStoredZoomLevel, setStoredZoomLevel,
  getStoredMentionHighlightColor, setStoredMentionHighlightColor, type MentionHighlightColor,
  getStoredServerLayout, setStoredServerLayout, type ServerLayout,
} from '../utils/uiDensityStorage';
import {
  getStoredAccessibility, setStoredAccessibility,
  getStoredChatSettings, setStoredChatSettings,
  getStoredKeybinds, setStoredKeybinds,
  getKeybindsGlobalMasterEnabled, setKeybindsGlobalMasterEnabled,
  getStoredStreamer, setStoredStreamer,
  getStoredVoice, setStoredVoice,
  getStoredLanguage, setStoredLanguage,
  getStoredTimeFormat, setStoredTimeFormat,
  getStoredAdvanced, setStoredAdvanced,
  getStoredGameOverlay, setStoredGameOverlay,
  getStoredBluetoothAudio, setStoredBluetoothAudio,
  getStoredBtDevicePreferences, setStoredBtDevicePreferences,
  DEFAULT_KEYBINDS,
  type AccessibilitySettings, type ChatSettings, type KeybindEntry,
  type StreamerSettings, type VoiceSettings, type AdvancedSettings, type TimeFormat,
  type GameOverlaySettings, type BluetoothAudioSettings, type BtDevicePreference,
} from '../utils/settingsStorage';

import { scheduleSyncToServer, type SettingsBlob, LAYOUT_PICKER_SEEN_KEY, LAYOUT_PICKER_SEEN_EVENT } from '../utils/settingsSync';
import {
  upsertPreference, removePreference, evictLruIfNeeded,
} from '../services/audio/btQualityPreferences';

export interface SettingsContextValue {
  theme: AppTheme;
  setTheme: (theme: AppTheme) => void;
  uiDensity: UiDensity;
  setUiDensity: (d: UiDensity) => void;
  chatMessageDisplay: ChatMessageDisplay;
  setChatMessageDisplay: (v: ChatMessageDisplay) => void;
  messageGroupSpacing: number;
  setMessageGroupSpacing: (px: number) => void;
  chatFontSize: number;
  setChatFontSize: (px: number) => void;
  zoomLevel: number;
  cssZoomLevel: number;
  setZoomLevel: (pct: number) => void;
  mentionHighlightColor: MentionHighlightColor;
  setMentionHighlightColor: (c: MentionHighlightColor) => void;
  serverLayout: ServerLayout;
  setServerLayout: (v: ServerLayout) => void;
  accessibilitySettings: AccessibilitySettings;
  updateAccessibility: (patch: Partial<AccessibilitySettings>) => void;
  chatSettings: ChatSettings;
  updateChatSettings: (patch: Partial<ChatSettings>) => void;
  keybinds: KeybindEntry[];
  updateKeybinds: (binds: KeybindEntry[]) => void;
  keybindsGlobalMasterEnabled: boolean;
  updateKeybindsGlobalMasterEnabled: (enabled: boolean) => void;
  streamerSettings: StreamerSettings;
  updateStreamer: (patch: Partial<StreamerSettings>) => void;
  voiceSettings: VoiceSettings;
  updateVoice: (patch: Partial<VoiceSettings>) => void;
  language: string;
  updateLanguage: (lang: string) => void;
  timeFormat: TimeFormat;
  updateTimeFormat: (tf: TimeFormat) => void;
  advancedSettings: AdvancedSettings;
  updateAdvanced: (patch: Partial<AdvancedSettings>) => void;
  gameOverlaySettings: GameOverlaySettings;
  updateGameOverlay: (patch: Partial<GameOverlaySettings>) => void;
  bluetoothAudioSettings: BluetoothAudioSettings;
  updateBluetoothAudioSettings: (patch: Partial<BluetoothAudioSettings>) => void;
  btDevicePreferences: BtDevicePreference[];
  addBtDevicePreference: (pref: BtDevicePreference) => void;
  removeBtDevicePreferenceByLabel: (label: string) => void;
  clearAllBtDevicePreferences: () => void;
  setLastNonBtMicLabel: (label: string | null) => void;
  resetSettings: () => void;
  applyServerSettings: (blob: SettingsBlob) => void;
}

export const SUPPORTED_LANGUAGES = ['en-US', 'en-GB', 'es', 'fr', 'de', 'ja', 'ko', 'pt-BR', 'zh-CN'] as const;

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  // -- Theme --
  const [theme, setThemeState] = useState<AppTheme>(() => {
    const VALID_THEMES: AppTheme[] = ['neural', 'light', 'matter', 'void', 'custom'];
    const raw = localStorage.getItem('howl_app_theme') ?? localStorage.getItem('app_theme');
    return (raw && VALID_THEMES.includes(raw as AppTheme)) ? raw as AppTheme : 'void';
  });
  const setTheme = useCallback((t: AppTheme) => { localStorage.setItem('howl_app_theme', t); setThemeState(t); scheduleSyncToServer(); }, []);

  // -- UI density / display --
  const [uiDensity, setUiDensityState] = useState<UiDensity>(() => getStoredUiDensity() ?? 'default');
  const setUiDensity = useCallback((d: UiDensity) => { setStoredUiDensity(d); setUiDensityState(d); scheduleSyncToServer(); }, []);

  const [chatMessageDisplay, setChatMessageDisplayState] = useState<ChatMessageDisplay>(() => getStoredChatMessageDisplay() ?? 'default');
  const setChatMessageDisplay = useCallback((v: ChatMessageDisplay) => { setStoredChatMessageDisplay(v); setChatMessageDisplayState(v); scheduleSyncToServer(); }, []);

  const [messageGroupSpacing, setMessageGroupSpacingState] = useState(() => getStoredMessageGroupSpacing() ?? 16);
  const setMessageGroupSpacing = useCallback((px: number) => { setStoredMessageGroupSpacing(px); setMessageGroupSpacingState(px); scheduleSyncToServer(); }, []);

  const [chatFontSize, setChatFontSizeState] = useState(() => getStoredChatFontSize() ?? 16);
  const setChatFontSize = useCallback((px: number) => { setStoredChatFontSize(px); setChatFontSizeState(px); scheduleSyncToServer(); }, []);

  const [zoomLevel, setZoomLevelState] = useState(() => getStoredZoomLevel() ?? 100);
  const isElectron = !!(window.electron?.isElectron || (window as any).__ELECTRON_WINDOW__);
  const cssZoomLevel = isElectron ? 100 : zoomLevel;
  const setZoomLevel = useCallback((pct: number) => {
    const clamped = Math.max(50, Math.min(200, pct));
    setStoredZoomLevel(clamped);
    setZoomLevelState(clamped);
    // Do NOT call scheduleSyncToServer() — zoom is device-specific
    if (window.electron?.setZoomFactor) {
      window.electron.setZoomFactor(clamped / 100);
    }
  }, []);

  useEffect(() => {
    if (window.electron?.setZoomFactor) {
      window.electron.setZoomFactor(zoomLevel / 100);
    }
  }, []); // Only on mount

  const [mentionHighlightColor, setMentionHighlightColorState] = useState<MentionHighlightColor>(getStoredMentionHighlightColor);
  const setMentionHighlightColor = useCallback((c: MentionHighlightColor) => { setStoredMentionHighlightColor(c); setMentionHighlightColorState(c); scheduleSyncToServer(); }, []);

  // -- Server layout (Default = today's tabbed-panel layout, Classic = Discord-style) --
  const [serverLayout, setServerLayoutState] = useState<ServerLayout>(getStoredServerLayout);
  const setServerLayout = useCallback((v: ServerLayout) => { setStoredServerLayout(v); setServerLayoutState(v); scheduleSyncToServer(); }, []);

  // -- Complex settings objects --
  const [accessibilitySettings, setAccessibilityState] = useState<AccessibilitySettings>(getStoredAccessibility);
  const updateAccessibility = useCallback((patch: Partial<AccessibilitySettings>) => {
    setStoredAccessibility(patch);
    setAccessibilityState(prev => ({ ...prev, ...patch }));
    scheduleSyncToServer();
  }, []);

  const [chatSettings, setChatSettingsState] = useState<ChatSettings>(getStoredChatSettings);
  const updateChatSettings = useCallback((patch: Partial<ChatSettings>) => {
    setStoredChatSettings(patch);
    setChatSettingsState(prev => ({ ...prev, ...patch }));
    scheduleSyncToServer();
  }, []);

  const [keybinds, setKeybindsState] = useState<KeybindEntry[]>(getStoredKeybinds);
  const updateKeybinds = useCallback((binds: KeybindEntry[]) => {
    setStoredKeybinds(binds);
    setKeybindsState(binds);
    scheduleSyncToServer();
  }, []);

  const [keybindsGlobalMasterEnabled, setKeybindsGlobalMasterEnabledState] =
    useState<boolean>(() => getKeybindsGlobalMasterEnabled());

  const updateKeybindsGlobalMasterEnabled = useCallback((enabled: boolean) => {
    setKeybindsGlobalMasterEnabled(enabled);
    setKeybindsGlobalMasterEnabledState(enabled);
  }, []);

  const [streamerSettings, setStreamerState] = useState<StreamerSettings>(getStoredStreamer);
  const updateStreamer = useCallback((patch: Partial<StreamerSettings>) => {
    setStoredStreamer(patch);
    setStreamerState(prev => ({ ...prev, ...patch }));
    scheduleSyncToServer();
  }, []);

  const [voiceSettings, setVoiceState] = useState<VoiceSettings>(() => {
    const stored = getStoredVoice();
    // One-shot legacy normalization: AI noise engine + browser-level NS
    // double-process the mic stream and produce tinny, over-processed voice
    // (the older "Voice Isolation" preset shipped with both on, so existing
    // profiles can have this conflict). When both are active, force browser
    // NS off — the AI engine wins because it's universally the better algo.
    if (stored.noiseEngine !== 'off' && stored.noiseSuppression !== 'none') {
      setStoredVoice({ noiseSuppression: 'none' });
      return { ...stored, noiseSuppression: 'none' };
    }
    return stored;
  });
  const updateVoice = useCallback((patch: Partial<VoiceSettings>) => {
    // Bidirectional mutual exclusion: AI noise engine and browser-level NS
    // must never run simultaneously — double-processing produces tinny,
    // over-processed audio.
    const normalized: Partial<VoiceSettings> = { ...patch };
    if (normalized.noiseEngine !== undefined && normalized.noiseEngine !== 'off') {
      normalized.noiseSuppression = 'none';
    }
    if (normalized.noiseSuppression !== undefined && normalized.noiseSuppression !== 'none') {
      normalized.noiseEngine = 'off';
    }
    setStoredVoice(normalized);
    setVoiceState(prev => ({ ...prev, ...normalized }));
    scheduleSyncToServer();
  }, []);

  const [language, setLanguageState] = useState(() => {
    const stored = getStoredLanguage();
    return (SUPPORTED_LANGUAGES as readonly string[]).includes(stored) ? stored : 'en-US';
  });
  const updateLanguage = useCallback((lang: string) => {
    const valid = (SUPPORTED_LANGUAGES as readonly string[]).includes(lang) ? lang : 'en-US';
    setStoredLanguage(valid);
    setLanguageState(valid);
    scheduleSyncToServer();
  }, []);

  const [timeFormat, setTimeFormatState] = useState<TimeFormat>(getStoredTimeFormat);
  const updateTimeFormat = useCallback((tf: TimeFormat) => { setStoredTimeFormat(tf); setTimeFormatState(tf); scheduleSyncToServer(); }, []);

  const [advancedSettings, setAdvancedState] = useState<AdvancedSettings>(getStoredAdvanced);
  const updateAdvanced = useCallback((patch: Partial<AdvancedSettings>) => {
    setStoredAdvanced(patch);
    setAdvancedState(prev => ({ ...prev, ...patch }));
    // Auto-enable software encoding when disabling hardware acceleration
    if (patch.hardwareAcceleration === false) {
      const currentVoice = getStoredVoice();
      if (!currentVoice.forceSwEncoding) {
        setStoredVoice({ forceSwEncoding: true });
        setVoiceState(prev => ({ ...prev, forceSwEncoding: true }));
        window.electron?.setForceSwEncode?.(true);
      }
    }
    scheduleSyncToServer();
  }, []);

  const [gameOverlaySettings, setGameOverlaySettings] = useState<GameOverlaySettings>(getStoredGameOverlay);
  const updateGameOverlay = useCallback((patch: Partial<GameOverlaySettings>) => {
    setStoredGameOverlay(patch);
    setGameOverlaySettings(prev => ({ ...prev, ...patch }));
    scheduleSyncToServer();
  }, []);

  // -- Bluetooth audio quality --
  const [bluetoothAudioSettings, setBluetoothAudioSettingsState] =
    useState<BluetoothAudioSettings>(() => getStoredBluetoothAudio());

  const updateBluetoothAudioSettings = useCallback((patch: Partial<BluetoothAudioSettings>) => {
    setStoredBluetoothAudio(patch);
    setBluetoothAudioSettingsState(prev => ({ ...prev, ...patch }));
    scheduleSyncToServer();
  }, []);

  const setLastNonBtMicLabel = useCallback((label: string | null) => {
    setStoredBluetoothAudio({ lastNonBtMicLabel: label });
    setBluetoothAudioSettingsState(prev => ({ ...prev, lastNonBtMicLabel: label }));
    scheduleSyncToServer();
  }, []);

  const [btDevicePreferences, setBtDevicePreferencesState] =
    useState<BtDevicePreference[]>(() => getStoredBtDevicePreferences());

  const addBtDevicePreference = useCallback((pref: BtDevicePreference) => {
    const current = getStoredBtDevicePreferences();
    const withUpsert = upsertPreference(current, pref);
    const evicted = evictLruIfNeeded(withUpsert);
    setStoredBtDevicePreferences(evicted);
    setBtDevicePreferencesState(evicted);
    scheduleSyncToServer();
  }, []);

  const removeBtDevicePreferenceByLabel = useCallback((label: string) => {
    const current = getStoredBtDevicePreferences();
    const next = removePreference(current, label);
    setStoredBtDevicePreferences(next);
    setBtDevicePreferencesState(next);
    scheduleSyncToServer();
  }, []);

  const clearAllBtDevicePreferences = useCallback(() => {
    setStoredBtDevicePreferences([]);
    setBtDevicePreferencesState([]);
    scheduleSyncToServer();
  }, []);

  const resetSettings = useCallback(() => {
    // Theme — persisted via useEffect on theme state
    setThemeState('void');
    localStorage.setItem('howl_app_theme', 'void');
    clearCustomTheme();
    // UI density settings
    setStoredUiDensity('default'); setUiDensityState('default');
    setStoredChatMessageDisplay('default'); setChatMessageDisplayState('default');
    setStoredMessageGroupSpacing(16); setMessageGroupSpacingState(16);
    setStoredChatFontSize(16); setChatFontSizeState(16);
    setStoredZoomLevel(100); setZoomLevelState(100);
    if (window.electron?.setZoomFactor) window.electron.setZoomFactor(1);
    setStoredMentionHighlightColor('cyan'); setMentionHighlightColorState('cyan');
    setStoredServerLayout('default'); setServerLayoutState('default');
    // Complex settings — use canonical defaults from settingsStorage
    const defaultAccessibility: AccessibilitySettings = {
      saturation: 100, saturationCustomColors: false, alwaysUnderlineLinks: false, highContrast: false,
      roleColorMode: 'in-names', syncMotionWithOS: true, reducedMotion: false,
      autoplayGifs: true, playAnimatedEmoji: true, stickerAnimation: 'always',
      showSendButton: false, legacyChatInput: false, ttsRate: 100, showOnOffIndicators: false, composerSpellcheck: true, spellcheckLanguages: [],
    };
    setStoredAccessibility(defaultAccessibility); setAccessibilityState(defaultAccessibility);
    const defaultChat: ChatSettings = {
      displayImagesLinks: true, displayImagesUploaded: true, imageDescriptions: false,
      showEmbeds: true, showEmojiReactions: true, convertEmoticons: true,
      dmSearchAll: false, spoilerMode: 'on-click', previewTextBox: true,
      dmSidebarShowActivity: false,
    };
    setStoredChatSettings(defaultChat); setChatSettingsState(defaultChat);
    setStoredKeybinds(DEFAULT_KEYBINDS); setKeybindsState(DEFAULT_KEYBINDS);
    const defaultStreamer: StreamerSettings = {
      enabled: false, autoDetectOBS: true, hidePersonalInfo: true,
      hideInviteLinks: true, disableSounds: true, disableNotifications: true, hideFromCapture: false,
    };
    setStoredStreamer(defaultStreamer); setStreamerState(defaultStreamer);
    const defaultVoice: VoiceSettings = {
      selectedMicId: '', selectedSpeakerId: '', selectedCameraId: '',
      micVolume: 100, speakerVolume: 100, autoInputSensitivity: true, inputSensitivity: 50,
      noiseSuppression: 'none', echoCancellation: true, autoGainControl: true, pushToTalk: false, pushToTalkKey: '',
      showStreamPreviews: true, showAdvancedStream: false, soundDeafen: true, soundUndeafen: true,
      soundMute: true, soundUnmute: true, soundConnect: true, soundDisconnect: true, soundboardVolume: 100, opusBitrate: 64, opusFec: true,
      opusDtx: true, opusPacketLoss: 15, opusSignal: 'voice', opusStereo: false,
      inputProfile: 'isolation', screenShareCodec: 'auto', forceSwEncoding: false,
      videoBackgroundMode: 'off', videoBackgroundBlurRadius: 10, videoBackgroundImageUrl: '',
      videoColorGradeEnabled: false, videoColorGrade: 'none',
      autoFrameMode: 'off', autoFrameZoom: 1.3, autoFrameZoomAuto: false,
      cameraPreviewModal: true,
      muteHowlAudioWhileSharing: true,
      noiseEngine: 'dfn3-light',
      notifyOnNoMicAudio: true,
    };
    setStoredVoice(defaultVoice); setVoiceState(defaultVoice);
    setStoredLanguage('en-US'); setLanguageState('en-US');
    setStoredTimeFormat('auto'); setTimeFormatState('auto');
    const defaultAdvanced: AdvancedSettings = { hardwareAcceleration: true, showGameLibrary: true };
    setStoredAdvanced(defaultAdvanced); setAdvancedState(defaultAdvanced);
    const defaultGameOverlay: GameOverlaySettings = {
      enabled: false, clickableRegions: true, lockKeybind: 'SHIFT+BACKQUOTE',
      widgetMode: 'detailed', widgetCorner: 'top-left', avatarSize: 'medium',
      displayNames: 'always', showUsers: 'always', maxUsersDisplayed: 8,
      toastCorner: 'bottom-right', toastMessages: true, toastWelcome: true,
      toastGoLive: true, toastGameActivity: true, toastNowPlaying: true,
    };
    setStoredGameOverlay(defaultGameOverlay); setGameOverlaySettings(defaultGameOverlay);
    setStoredBluetoothAudio({ autoOptimizeBluetoothAudio: true, lastNonBtMicLabel: null });
    setBluetoothAudioSettingsState({ autoOptimizeBluetoothAudio: true, lastNonBtMicLabel: null });
    setStoredBtDevicePreferences([]);
    setBtDevicePreferencesState([]);
    scheduleSyncToServer();
  }, []);

  /** Apply a settings blob received from the server (preserves device-specific fields) */
  const applyServerSettings = useCallback((blob: SettingsBlob) => {
    if (blob.theme && ['neural', 'light', 'matter', 'void', 'custom'].includes(blob.theme)) {
      setThemeState(blob.theme as AppTheme);
    }
    if (blob.uiDensity) { setStoredUiDensity(blob.uiDensity as UiDensity); setUiDensityState(blob.uiDensity as UiDensity); }
    if (blob.chatMessageDisplay) { setStoredChatMessageDisplay(blob.chatMessageDisplay as ChatMessageDisplay); setChatMessageDisplayState(blob.chatMessageDisplay as ChatMessageDisplay); }
    if (blob.messageGroupSpacing != null) { setStoredMessageGroupSpacing(blob.messageGroupSpacing); setMessageGroupSpacingState(blob.messageGroupSpacing); }
    if (blob.chatFontSize != null) { setStoredChatFontSize(blob.chatFontSize); setChatFontSizeState(blob.chatFontSize); }
    if (blob.mentionHighlightColor) {
      const validColors = ['cyan', 'purple', 'amber', 'indigo', 'pink', 'green', 'white'];
      if (validColors.includes(blob.mentionHighlightColor)) {
        setStoredMentionHighlightColor(blob.mentionHighlightColor as MentionHighlightColor);
        setMentionHighlightColorState(blob.mentionHighlightColor as MentionHighlightColor);
      }
    }
    if (blob.serverLayout === 'default' || blob.serverLayout === 'classic') {
      setStoredServerLayout(blob.serverLayout);
      setServerLayoutState(blob.serverLayout);
    }
    if (blob.accessibility) { setStoredAccessibility(blob.accessibility as Partial<AccessibilitySettings>); setAccessibilityState(prev => ({ ...prev, ...blob.accessibility as Partial<AccessibilitySettings> })); }
    if (blob.chat) { setStoredChatSettings(blob.chat as Partial<ChatSettings>); setChatSettingsState(prev => ({ ...prev, ...blob.chat as Partial<ChatSettings> })); }
    if (blob.keybinds && Array.isArray(blob.keybinds)) { setStoredKeybinds(blob.keybinds as unknown as KeybindEntry[]); setKeybindsState(blob.keybinds as unknown as KeybindEntry[]); }
    if (blob.streamer) { setStoredStreamer(blob.streamer as Partial<StreamerSettings>); setStreamerState(prev => ({ ...prev, ...blob.streamer as Partial<StreamerSettings> })); }
    if (blob.voice) {
      const patch = { ...blob.voice } as Partial<VoiceSettings>;
      delete (patch as Record<string, unknown>).selectedMicId;
      delete (patch as Record<string, unknown>).selectedSpeakerId;
      delete (patch as Record<string, unknown>).selectedCameraId;
      // Enforce mutual exclusion: AI engine wins over browser NS
      if (patch.noiseEngine && patch.noiseEngine !== 'off') {
        patch.noiseSuppression = 'none';
      }
      setStoredVoice(patch); setVoiceState(prev => ({ ...prev, ...patch }));
    }
    if (blob.language) { setStoredLanguage(blob.language); setLanguageState(blob.language); }
    if (blob.timeFormat) { setStoredTimeFormat(blob.timeFormat as TimeFormat); setTimeFormatState(blob.timeFormat as TimeFormat); }
    if (blob.advanced) {
      const patch = { ...blob.advanced } as Partial<AdvancedSettings>;
      delete (patch as Record<string, unknown>).hardwareAcceleration;
      setStoredAdvanced(patch); setAdvancedState(prev => ({ ...prev, ...patch }));
    }
    if (blob.gameOverlay) { setStoredGameOverlay(blob.gameOverlay as Partial<GameOverlaySettings>); setGameOverlaySettings(getStoredGameOverlay()); }
    if (blob.bluetoothAudio && typeof blob.bluetoothAudio === 'object') {
      const ba = blob.bluetoothAudio as Record<string, unknown>;
      const patch: Partial<BluetoothAudioSettings> = {};
      if (typeof ba.autoOptimizeBluetoothAudio === 'boolean') {
        patch.autoOptimizeBluetoothAudio = ba.autoOptimizeBluetoothAudio;
      }
      if (ba.lastNonBtMicLabel === null || typeof ba.lastNonBtMicLabel === 'string') {
        patch.lastNonBtMicLabel = ba.lastNonBtMicLabel as string | null;
      }
      if (Object.keys(patch).length > 0) {
        setStoredBluetoothAudio(patch);
        setBluetoothAudioSettingsState(prev => ({ ...prev, ...patch }));
      }
    }
    if (Array.isArray(blob.btDevicePreferences)) {
      // getStoredBtDevicePreferences applies shape validation; we go through
      // the storage layer to reuse that validator instead of duplicating it.
      setStoredBtDevicePreferences(blob.btDevicePreferences as unknown as BtDevicePreference[]);
      setBtDevicePreferencesState(getStoredBtDevicePreferences());
    }
    if (Array.isArray(blob.pinnedActivityServers)) {
      try { localStorage.setItem('howl_pinned_activity_servers', JSON.stringify(blob.pinnedActivityServers)); } catch { /* storage full */ }
    }
    // Mirror the layout-picker seen flag from server → localStorage so a
    // user who picked on another device doesn't get re-prompted here.
    // Native `storage` events don't fire for same-tab writes, so we
    // dispatch a custom event for App.tsx to dismiss a currently-mounted
    // picker. (If localStorage already had the flag, no need to re-fire.)
    if (blob.hasSeenLayoutPicker === true) {
      let alreadySet = false;
      try { alreadySet = localStorage.getItem(LAYOUT_PICKER_SEEN_KEY) === '1'; } catch { /* private mode */ }
      if (!alreadySet) {
        try { localStorage.setItem(LAYOUT_PICKER_SEEN_KEY, '1'); } catch { /* private mode */ }
        try { window.dispatchEvent(new Event(LAYOUT_PICKER_SEEN_EVENT)); } catch { /* SSR */ }
      }
    }
  }, []);

  // -- DOM side-effects --

  // Theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('howl_app_theme', theme);
    try { localStorage.removeItem('app_theme'); } catch { /* migrate old key */ }
    if (theme === 'custom') {
      applyCustomTheme(getStoredCustomTheme());
    } else {
      clearCustomTheme();
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty('--chat-font-size', `${chatFontSize}px`);
  }, [chatFontSize]);

  // Saturation
  useEffect(() => {
    const root = document.documentElement;
    const sat = accessibilitySettings.saturation;
    root.style.setProperty('--app-saturation', `${sat}%`);
    root.style.setProperty('--app-sat-inv', sat > 0 && sat < 100 ? String(Math.round(10000 / sat) / 100) : '1');
    document.body.style.filter = sat < 100 ? `saturate(var(--app-saturation))` : '';
    document.body.classList.toggle('howl-sat-reducing', sat < 100);
    document.body.classList.toggle('howl-sat-custom-colors', accessibilitySettings.saturationCustomColors && sat < 100);
  }, [accessibilitySettings.saturation, accessibilitySettings.saturationCustomColors]);

  useEffect(() => {
    document.body.classList.toggle('howl-reduced-motion', accessibilitySettings.reducedMotion);
  }, [accessibilitySettings.reducedMotion]);

  useEffect(() => {
    document.body.classList.toggle('howl-underline-links', accessibilitySettings.alwaysUnderlineLinks);
  }, [accessibilitySettings.alwaysUnderlineLinks]);

  useEffect(() => {
    document.body.classList.toggle('howl-high-contrast', accessibilitySettings.highContrast);
  }, [accessibilitySettings.highContrast]);

  // Streamer mode
  useEffect(() => {
    document.body.classList.toggle('howl-streamer-mode', streamerSettings.enabled);
  }, [streamerSettings.enabled]);

  useEffect(() => {
    document.body.classList.toggle('howl-streamer-hide-info', streamerSettings.enabled && streamerSettings.hidePersonalInfo);
  }, [streamerSettings.enabled, streamerSettings.hidePersonalInfo]);

  useEffect(() => {
    document.body.classList.toggle('howl-streamer-hide-invites', streamerSettings.enabled && streamerSettings.hideInviteLinks);
  }, [streamerSettings.enabled, streamerSettings.hideInviteLinks]);

  useEffect(() => {
    document.body.classList.toggle('howl-streamer-no-notif', streamerSettings.enabled && streamerSettings.disableNotifications);
  }, [streamerSettings.enabled, streamerSettings.disableNotifications]);

  // Sync-with-OS motion preference
  useEffect(() => {
    if (!accessibilitySettings.syncMotionWithOS) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => updateAccessibility({ reducedMotion: mq.matches });
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [accessibilitySettings.syncMotionWithOS, updateAccessibility]);

  // Accessibility body classes (consolidated)
  useEffect(() => {
    document.body.classList.toggle('howl-no-autoplay-gifs', !accessibilitySettings.autoplayGifs);
    document.body.classList.toggle('howl-no-animated-emoji', !accessibilitySettings.playAnimatedEmoji);
    document.body.dataset.stickerAnimation = accessibilitySettings.stickerAnimation;
    document.body.classList.toggle('howl-onoff-indicators', accessibilitySettings.showOnOffIndicators);
    document.body.classList.toggle('howl-role-color-hidden', accessibilitySettings.roleColorMode === 'hidden');
    document.body.classList.toggle('howl-role-color-dot', accessibilitySettings.roleColorMode === 'next-to-names');
  }, [accessibilitySettings.autoplayGifs, accessibilitySettings.playAnimatedEmoji, accessibilitySettings.stickerAnimation, accessibilitySettings.showOnOffIndicators, accessibilitySettings.roleColorMode]);

  // Language
  useEffect(() => {
    document.documentElement.lang = language;
    import('../src/i18n').then(({ loadLocale }) => {
      loadLocale(language);
    });
  }, [language]);

  // Push the user's spellcheck-language selection to Electron's session
  // so Chromium's bundled Hunspell engine checks against the right
  // dictionaries. Web is a no-op — browsers manage this themselves.
  // Empty array → defer to Electron's app.getLocale() default.
  useEffect(() => {
    const sc = window.electron?.spellcheck;
    if (!sc) return;
    const langs = accessibilitySettings.spellcheckLanguages;
    if (langs && langs.length > 0) {
      sc.setLanguages(langs).catch(() => { /* unsupported codes silently fall back */ });
    }
  }, [accessibilitySettings.spellcheckLanguages]);

  // Cross-tab settings sync via localStorage 'storage' event
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (!e.key || e.newValue === null) return;
      const v = e.newValue;
      switch (e.key) {
        case 'howl_app_theme': {
          const VALID_THEMES: AppTheme[] = ['neural', 'light', 'matter', 'void', 'custom'];
          if (VALID_THEMES.includes(v as AppTheme)) setThemeState(v as AppTheme);
          break;
        }
        case 'howl_language':
          if ((SUPPORTED_LANGUAGES as readonly string[]).includes(v)) setLanguageState(v);
          break;
        case 'howl_ui_density': setUiDensityState(v as UiDensity); break;
        case 'howl_chat_message_display': setChatMessageDisplayState(v as ChatMessageDisplay); break;
        case 'howl_message_group_spacing': setMessageGroupSpacingState(Number(v) || 16); break;
        case 'howl_chat_font_size': setChatFontSizeState(Number(v) || 16); break;
        case 'howl_zoom_level': setZoomLevelState(Number(v) || 100); break;
        case 'howl_time_format': setTimeFormatState(v as TimeFormat); break;
        default:
          // Complex JSON settings
          try {
            if (e.key.startsWith('howl_a11y_')) setAccessibilityState(getStoredAccessibility());
            else if (e.key.startsWith('howl_chat_')) setChatSettingsState(getStoredChatSettings());
            else if (e.key === 'howl_keybinds') setKeybindsState(JSON.parse(v));
            else if (e.key.startsWith('howl_streamer_')) setStreamerState(getStoredStreamer());
            else if (e.key.startsWith('howl_voice_')) setVoiceState(getStoredVoice());
            else if (e.key.startsWith('howl_adv_')) setAdvancedState(getStoredAdvanced());
            else if (e.key.startsWith('howl_overlay_')) setGameOverlaySettings(getStoredGameOverlay());
          } catch { /* ignore malformed */ }
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  // Advanced (consolidated)
  useEffect(() => {
    document.body.classList.toggle('howl-no-hw-accel', !advancedSettings.hardwareAcceleration);
    document.body.classList.toggle('howl-game-lib-hidden', !advancedSettings.showGameLibrary);
  }, [advancedSettings.hardwareAcceleration, advancedSettings.showGameLibrary]);

  // Game Overlay settings are forwarded to the overlay window by useOverlayBridge
  // (in AppLayout) — no duplicate IPC here.

  const value = useMemo<SettingsContextValue>(() => ({
    theme, setTheme,
    uiDensity, setUiDensity,
    chatMessageDisplay, setChatMessageDisplay,
    messageGroupSpacing, setMessageGroupSpacing,
    chatFontSize, setChatFontSize,
    zoomLevel, cssZoomLevel, setZoomLevel,
    mentionHighlightColor, setMentionHighlightColor,
    serverLayout, setServerLayout,
    accessibilitySettings, updateAccessibility,
    chatSettings, updateChatSettings,
    keybinds, updateKeybinds,
    keybindsGlobalMasterEnabled, updateKeybindsGlobalMasterEnabled,
    streamerSettings, updateStreamer,
    voiceSettings, updateVoice,
    language, updateLanguage,
    timeFormat, updateTimeFormat,
    advancedSettings, updateAdvanced,
    gameOverlaySettings, updateGameOverlay,
    bluetoothAudioSettings, updateBluetoothAudioSettings,
    btDevicePreferences, addBtDevicePreference,
    removeBtDevicePreferenceByLabel, clearAllBtDevicePreferences,
    setLastNonBtMicLabel,
    resetSettings,
    applyServerSettings,
  }), [
    theme, setTheme,
    uiDensity, setUiDensity,
    chatMessageDisplay, setChatMessageDisplay,
    messageGroupSpacing, setMessageGroupSpacing,
    chatFontSize, setChatFontSize,
    zoomLevel, cssZoomLevel, setZoomLevel,
    mentionHighlightColor, setMentionHighlightColor,
    serverLayout, setServerLayout,
    accessibilitySettings, updateAccessibility,
    chatSettings, updateChatSettings,
    keybinds, updateKeybinds,
    keybindsGlobalMasterEnabled, updateKeybindsGlobalMasterEnabled,
    streamerSettings, updateStreamer,
    voiceSettings, updateVoice,
    language, updateLanguage,
    timeFormat, updateTimeFormat,
    advancedSettings, updateAdvanced,
    gameOverlaySettings, updateGameOverlay,
    bluetoothAudioSettings, updateBluetoothAudioSettings,
    btDevicePreferences, addBtDevicePreference,
    removeBtDevicePreferenceByLabel, clearAllBtDevicePreferences,
    setLastNonBtMicLabel,
    resetSettings,
    applyServerSettings,
  ]);

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error('useSettings must be used within a <SettingsProvider>');
  }
  return ctx;
}
