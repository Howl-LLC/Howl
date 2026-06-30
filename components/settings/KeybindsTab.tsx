// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, ChevronDown, Check, HelpCircle, RotateCcw, AlertTriangle, X } from 'lucide-react';
import { useSettings } from '../../contexts/SettingsContext';
import { startKeyCapture, formatComboDisplay } from '../../utils/keybindFormat';

const ACTION_TO_SETTING_ID: Record<string, string> = {
  toggleMute: 'toggle-mute',
  toggleDeafen: 'toggle-deafen',
  toggleCamera: 'toggle-camera',
  toggleScreenShare: 'toggle-screen-share',
  disconnectFromVoice: 'disconnect-from-voice',
  pushToTalk: 'push-to-talk',
  pushToMute: 'push-to-mute',
  openSoundboard: 'open-soundboard',
  openSoundboardHold: 'open-soundboard-hold',
  answerCall: 'answer-call',
  declineCall: 'decline-call',
  endCall: 'end-call',
  toggleStreamerMode: 'toggle-streamer-mode',
  navigateBack: 'navigate-back',
  navigateForward: 'navigate-forward',
  toggleVAD: 'toggle-vad',
  goHome: 'go-home',
  openSettings: 'open-settings',
  navigateServerUp: 'navigate-server-up',
  navigateServerDown: 'navigate-server-down',
  navigateChannelUp: 'navigate-channel-up',
  navigateChannelDown: 'navigate-channel-down',
  focusTextArea: 'focus-text-area',
  toggleMembersPanel: 'toggle-members-panel',
};

export interface KeybindsTabProps {}

export const KeybindsTab: React.FC<KeybindsTabProps> = () => {
  const { keybinds, updateKeybinds: onKeybindsChange, keybindsGlobalMasterEnabled, updateKeybindsGlobalMasterEnabled } = useSettings();
  const { t } = useTranslation();

  const [dismissMacBanner, setDismissMacBanner] = useState(false);
  const [editingKeybindId, setEditingKeybindId] = useState<string | null>(null);
  const [capturingKeys, setCapturingKeys] = useState(false);
  const [actionDropdownOpen, setActionDropdownOpen] = useState<string | null>(null);
  const [conflictWarning, setConflictWarning] = useState<{ combo: string; existingAction: string; pendingId?: string; pendingAction?: string } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const kbList = keybinds ?? [];

  // Actions available in the dynamic "Add Shortcut" dropdown
  const DYNAMIC_ACTIONS: { value: string; label: string; category: string }[] = [
    { value: 'unassigned', label: t('settings.shortcutAction.unassigned'), category: t('settings.shortcutCategory.voiceVideo') },
    { value: 'toggleMute', label: t('settings.shortcutAction.toggleMute'), category: t('settings.shortcutCategory.voiceVideo') },
    { value: 'toggleDeafen', label: t('settings.shortcutAction.toggleDeafen'), category: t('settings.shortcutCategory.voiceVideo') },
    { value: 'toggleCamera', label: t('settings.shortcutAction.toggleCamera'), category: t('settings.shortcutCategory.voiceVideo') },
    { value: 'toggleScreenShare', label: t('settings.shortcutAction.toggleScreenShare'), category: t('settings.shortcutCategory.voiceVideo') },
    { value: 'disconnectFromVoice', label: t('settings.shortcutAction.disconnectFromVoice'), category: t('settings.shortcutCategory.voiceVideo') },
    { value: 'pushToTalk', label: t('settings.shortcutAction.pushToTalk'), category: t('settings.shortcutCategory.voiceVideo') },
    { value: 'pushToMute', label: t('settings.shortcutAction.pushToMute'), category: t('settings.shortcutCategory.voiceVideo') },
    { value: 'openSoundboard', label: t('settings.shortcutAction.openSoundboard'), category: t('settings.shortcutCategory.voiceVideo') },
    { value: 'openSoundboardHold', label: t('settings.shortcutAction.openSoundboardHold'), category: t('settings.shortcutCategory.voiceVideo') },
    { value: 'answerCall', label: t('settings.shortcutAction.answerCall'), category: t('settings.shortcutCategory.voiceVideo') },
    { value: 'declineCall', label: t('settings.shortcutAction.declineCall'), category: t('settings.shortcutCategory.voiceVideo') },
    { value: 'endCall', label: t('settings.shortcutAction.endCall'), category: t('settings.shortcutCategory.voiceVideo') },
    { value: 'toggleStreamerMode', label: t('settings.shortcutAction.toggleStreamerMode'), category: t('settings.shortcutCategory.miscellaneous') },
    { value: 'navigateBack', label: t('settings.shortcutAction.navigateBack'), category: t('settings.shortcutCategory.navigation') },
    { value: 'navigateForward', label: t('settings.shortcutAction.navigateForward'), category: t('settings.shortcutCategory.navigation') },
  ];
  const DYNAMIC_ACTION_VALUES = new Set(DYNAMIC_ACTIONS.map(a => a.value));

  // Fixed default shortcuts — always visible in the bottom section
  const FIXED_ACTIONS: { value: string; label: string; category: string }[] = [
    { value: 'toggleVAD', label: t('settings.shortcutAction.toggleVAD'), category: t('settings.shortcutCategory.voiceVideo') },
    { value: 'goHome', label: t('settings.shortcutAction.goHome'), category: t('settings.shortcutCategory.navigation') },
    { value: 'openSettings', label: t('settings.shortcutAction.openSettings'), category: t('settings.shortcutCategory.navigation') },
    { value: 'navigateServerUp', label: t('settings.shortcutAction.navigateServerUp'), category: t('settings.shortcutCategory.navigation') },
    { value: 'navigateServerDown', label: t('settings.shortcutAction.navigateServerDown'), category: t('settings.shortcutCategory.navigation') },
    { value: 'navigateChannelUp', label: t('settings.shortcutAction.navigateChannelUp'), category: t('settings.shortcutCategory.navigation') },
    { value: 'navigateChannelDown', label: t('settings.shortcutAction.navigateChannelDown'), category: t('settings.shortcutCategory.navigation') },
    { value: 'focusTextArea', label: t('settings.shortcutAction.focusTextArea'), category: t('settings.shortcutCategory.chat') },
    { value: 'toggleMembersPanel', label: t('settings.shortcutAction.toggleMembersPanel'), category: t('settings.shortcutCategory.chat') },
  ];

  const ALL_ACTIONS = [...DYNAMIC_ACTIONS, ...FIXED_ACTIONS];

  // Actions that can be toggled to "Global" (fires system-wide in Electron).
  // All other actions stay window-scoped. This is the renderer-side safeguard —
  // the Settings UI won't show the Global toggle for non-whitelisted actions.
  const GLOBAL_CAPABLE_ACTIONS: ReadonlySet<string> = new Set([
    'toggleMute', 'toggleDeafen', 'toggleCamera', 'toggleScreenShare',
    'disconnectFromVoice', 'pushToTalk', 'pushToMute',
    'openSoundboard', 'openSoundboardHold',
    'toggleStreamerMode', 'toggleVAD',
    'answerCall', 'declineCall', 'endCall',
  ]);

  const IS_ELECTRON = typeof window !== 'undefined' && !!(window as any).electron?.keybinds;

  // New-format defaults — side-specific modifiers, physical e.code keys.
  // See utils/keybindFormat.ts for token semantics.
  const DEFAULT_KEY_MAP: Record<string, string> = {
    toggleMute: 'LCtrl+LShift+KeyM',
    toggleDeafen: 'LCtrl+LShift+KeyD',
    toggleCamera: 'LCtrl+LShift+KeyV',
    toggleScreenShare: 'LCtrl+LShift+KeyS',
    toggleStreamerMode: 'LCtrl+LShift+KeyI',
    navigateBack: 'LAlt+ArrowLeft',
    navigateForward: 'LAlt+ArrowRight',
    disconnectFromVoice: 'LCtrl+LShift+LAlt+KeyD',
    goHome: 'LCtrl+LAlt+KeyH',
    openSettings: 'LCtrl+Comma',
    focusTextArea: 'Escape',
    toggleMembersPanel: 'LCtrl+KeyU',
    navigateServerUp: 'LCtrl+LAlt+ArrowUp',
    navigateServerDown: 'LCtrl+LAlt+ArrowDown',
    navigateChannelUp: 'LAlt+ArrowUp',
    navigateChannelDown: 'LAlt+ArrowDown',
  };

  const setGlobalForAction = (action: string, global: boolean) => {
    const defaultKeys = DEFAULT_KEY_MAP[action] ?? '';
    const existing = kbList.find(k => k.action === action);
    if (existing) {
      onKeybindsChange?.(kbList.map(k => k.id === existing.id ? { ...k, global } : k));
    } else {
      onKeybindsChange?.([...kbList, { id: `_user_${action}`, action, keys: defaultKeys, enabled: true, global }]);
    }
  };

  const isActionGlobal = (action: string): boolean => {
    const bind = kbList.find(k => k.action === action);
    return !!bind?.global;
  };

  const getEffectiveKey = (action: string): string => {
    const userBind = kbList.find(k => k.action === action);
    if (userBind) return userBind.keys;
    return DEFAULT_KEY_MAP[action] ?? '';
  };

  const isCustomised = (action: string): boolean => kbList.some(k => k.action === action);

  const getActionLabel = (action: string): string => {
    const meta = ALL_ACTIONS.find(a => a.value === action);
    return meta?.label ?? action;
  };

  // Check for conflicting keybinds
  const findConflict = (combo: string, excludeId?: string, excludeAction?: string): string | null => {
    if (!combo) return null;
    const conflict = kbList.find(k =>
      k.keys === combo && k.enabled && k.id !== excludeId && k.action !== excludeAction
    );
    if (conflict) return conflict.action;
    // Also check DEFAULT_KEY_MAP for built-in conflicts
    const defaultConflict = Object.entries(DEFAULT_KEY_MAP).find(([action, keys]) =>
      keys === combo && action !== excludeAction && !kbList.some(k => k.action === action)
    );
    if (defaultConflict) return defaultConflict[0];
    return null;
  };

  // Record key for a dynamic shortcut (by keybind id) or a fixed action (by action string)
  const handleRecordKeyById = (id: string, combo: string) => {
    const kb = kbList.find(k => k.id === id);
    const conflict = findConflict(combo, id, kb?.action);
    if (conflict) {
      setConflictWarning({ combo, existingAction: conflict, pendingId: id });
      return;
    }
    onKeybindsChange?.(kbList.map(k => k.id === id ? { ...k, keys: combo } : k));
    setCapturingKeys(false);
    setEditingKeybindId(null);
  };

  const handleRecordKey = (action: string, combo: string) => {
    const conflict = findConflict(combo, undefined, action);
    if (conflict) {
      setConflictWarning({ combo, existingAction: conflict, pendingAction: action });
      return;
    }
    const existing = kbList.find(k => k.action === action);
    if (existing) {
      onKeybindsChange?.(kbList.map(k => k.action === action ? { ...k, keys: combo } : k));
    } else {
      onKeybindsChange?.([...kbList, { id: `kb-${Date.now()}`, action, keys: combo, enabled: true }]);
    }
    setCapturingKeys(false);
    setEditingKeybindId(null);
  };

  const applyConflictOverride = () => {
    if (!conflictWarning) return;
    const cw = conflictWarning;
    setConflictWarning(null);
    if (cw.pendingId) {
      onKeybindsChange?.(kbList.map(k => {
        if (k.id === cw.pendingId) return { ...k, keys: cw.combo };
        if (k.keys === cw.combo && k.enabled) return { ...k, keys: '' };
        return k;
      }));
    } else if (cw.pendingAction) {
      const existing = kbList.find(k => k.action === cw.pendingAction);
      let updated = kbList.map(k => {
        if (k.keys === cw.combo && k.enabled && k.action !== cw.pendingAction) return { ...k, keys: '' };
        if (k.action === cw.pendingAction) return { ...k, keys: cw.combo };
        return k;
      });
      if (!existing) {
        updated = [...updated, { id: `kb-${Date.now()}`, action: cw.pendingAction, keys: cw.combo, enabled: true }];
      }
      onKeybindsChange?.(updated);
    }
    setCapturingKeys(false);
    setEditingKeybindId(null);
  };

  const handleToggleEnabled = (action: string) => {
    const existing = kbList.find(k => k.action === action);
    if (existing) {
      onKeybindsChange?.(kbList.map(k => k.action === action ? { ...k, enabled: !k.enabled } : k));
    } else {
      onKeybindsChange?.([...kbList, { id: `kb-${Date.now()}`, action, keys: DEFAULT_KEY_MAP[action] ?? '', enabled: false }]);
    }
  };

  const handleToggleEnabledById = (id: string) => {
    onKeybindsChange?.(kbList.map(k => k.id === id ? { ...k, enabled: !k.enabled } : k));
  };

  const handleResetKey = (action: string) => {
    onKeybindsChange?.(kbList.filter(k => k.action !== action));
    setEditingKeybindId(null);
    setCapturingKeys(false);
  };

  const handleDeleteDynamic = (id: string) => {
    onKeybindsChange?.(kbList.filter(k => k.id !== id));
    setEditingKeybindId(null);
    setCapturingKeys(false);
  };

  const handleAddDynamic = () => {
    const newEntry = { id: `kb-${Date.now()}`, action: 'unassigned', keys: '', enabled: true };
    onKeybindsChange?.([...kbList, newEntry]);
  };

  const handleChangeAction = (id: string, newAction: string) => {
    onKeybindsChange?.(kbList.map(k => {
      if (k.id !== id) return k;
      // Preserve existing key binding when switching actions. Only fall back to
      // the per-action default when nothing is bound yet (e.g. switching away
      // from the empty "unassigned" placeholder).
      const keys = k.keys !== '' ? k.keys : (DEFAULT_KEY_MAP[newAction] ?? '');
      return { ...k, action: newAction, keys };
    }));
  };

  const isEnabled = (action: string): boolean => {
    const userBind = kbList.find(k => k.action === action);
    if (userBind) return userBind.enabled;
    return true;
  };

  const fixedCategories = [...new Set(FIXED_ACTIONS.map(a => a.category))];
  const dynamicDropdownCategories = [...new Set(DYNAMIC_ACTIONS.map(a => a.category))];

  const formatKeyDisplay = (keys: string): string[] => {
    const tokens = formatComboDisplay(keys);
    if (tokens.length === 0) return [t('settings.shortcutUnset')];
    return tokens;
  };

  // Keep a reference to the current capture so cancelling via the Stop
  // button (instead of Escape) uninstalls the global listener cleanly.
  const captureStopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { captureStopRef.current?.(); }, []);

  /** Start capturing for a dynamic shortcut row (keyed by id). */
  const beginRecordById = (id: string) => {
    const kb = kbListRef.current.find(k => k.id === id);
    if (!kb) return;
    setEditingKeybindId(id);
    setCapturingKeys(true);
    captureStopRef.current?.();
    captureStopRef.current = startKeyCapture({
      onCapture: (combo) => {
        captureStopRef.current = null;
        handleRecordKeyById(id, combo);
      },
      onCancel: () => {
        captureStopRef.current = null;
        setCapturingKeys(false);
        setEditingKeybindId(null);
      },
      onClear: () => {
        captureStopRef.current = null;
        setCapturingKeys(false);
        setEditingKeybindId(null);
        onKeybindsChangeRef.current?.(kbListRef.current.map(k => k.id === id ? { ...k, keys: '' } : k));
      },
    });
  };

  /** Start capturing for a fixed default action. */
  const beginRecordByAction = (action: string) => {
    setEditingKeybindId(action);
    setCapturingKeys(true);
    captureStopRef.current?.();
    captureStopRef.current = startKeyCapture({
      onCapture: (combo) => {
        captureStopRef.current = null;
        handleRecordKey(action, combo);
      },
      onCancel: () => {
        captureStopRef.current = null;
        setCapturingKeys(false);
        setEditingKeybindId(null);
      },
      onClear: () => {
        captureStopRef.current = null;
        setCapturingKeys(false);
        setEditingKeybindId(null);
        // Clear to empty so the fixed action has no user binding — the
        // DEFAULT_KEY_MAP value then takes over as the displayed key.
        const existing = kbListRef.current.find(k => k.action === action);
        if (existing) {
          onKeybindsChangeRef.current?.(kbListRef.current.map(k => k.action === action ? { ...k, keys: '' } : k));
        }
      },
    });
  };

  /** Cancel any in-flight capture (e.g. user clicked away from the record pill). */
  const cancelRecord = () => {
    captureStopRef.current?.();
    captureStopRef.current = null;
    setCapturingKeys(false);
    setEditingKeybindId(null);
  };

  const isMac = typeof window !== 'undefined' && (window as any).__ELECTRON_PLATFORM__ === 'darwin';
  const hasAnyGlobal = kbList.some(k => k.global && k.enabled);

  // Dynamic shortcuts are user-added keybinds whose action is in the dropdown list
  const dynamicKeybinds = kbList.filter(k => DYNAMIC_ACTION_VALUES.has(k.action));

  // Prune empty/unassigned keybinds on unmount.
  // Empty deps + ref reads — with [kbList, onKeybindsChange] deps, the cleanup
  // would fire on every list change and see a stale snapshot: the cleanup closure
  // from the previous render captures the kbList that still contained the
  // unassigned-empty placeholder, filters it out, and calls onKeybindsChange
  // with that snapshot — clobbering the row the user just bound a key to.
  const kbListRef = useRef(kbList);
  kbListRef.current = kbList;
  const onKeybindsChangeRef = useRef(onKeybindsChange);
  onKeybindsChangeRef.current = onKeybindsChange;
  useEffect(() => {
    return () => {
      const current = kbListRef.current;
      const cleaned = current.filter(k => k.keys !== '' || k.action !== 'unassigned');
      if (cleaned.length !== current.length) {
        onKeybindsChangeRef.current?.(cleaned);
      }
    };
  }, []);

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>{t('settings.shortcuts')}</h2>
      <p className="text-xs mb-8" style={{ color: 'var(--text-secondary)' }}>{t('settings.shortcutsDesc')}</p>

      <div className="border border-[var(--cyan-accent)]/20 rounded-xl px-4 py-3 mb-8 flex items-center gap-2 text-xs" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 5%, transparent)', color: 'var(--text-secondary)' }}>
        <HelpCircle size={14} className="text-[var(--cyan-accent)] shrink-0" />
        {t('settings.shortcutsPaused')}
      </div>

      {/* ── macOS Accessibility banner ── */}
      {isMac && hasAnyGlobal && keybindsGlobalMasterEnabled && !dismissMacBanner && (
        <div className="border border-amber-500/30 rounded-xl px-4 py-3 mb-6 flex items-center gap-3 text-xs" style={{ backgroundColor: 'color-mix(in srgb, #f59e0b 8%, transparent)' }}>
          <AlertTriangle size={14} className="text-amber-400 shrink-0" />
          <span className="flex-1" style={{ color: 'var(--text-primary)' }}>
            {t('settings.shortcutSetting.macAccessibilityRequired')}
          </span>
          <button
            type="button"
            className="px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-500 text-black hover:opacity-90 transition-all shrink-0"
            onClick={() => (window as any).electron.keybinds.openMacAccessibility()}
          >
            {t('settings.shortcutSetting.macAccessibilityCta')}
          </button>
          <button
            type="button"
            className="shrink-0 hover:opacity-70 transition-opacity"
            style={{ color: 'var(--text-secondary)' }}
            onClick={() => setDismissMacBanner(true)}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* ── Master global keybinds toggle (Electron only) ── */}
      {IS_ELECTRON && (
        <div id="setting-global-keybinds-master" className="border border-default rounded-xl px-4 py-3 mb-8 flex items-center justify-between gap-4" style={{ backgroundColor: 'var(--bg-panel)' }}>
          <div>
            <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{t('settings.shortcutSetting.masterEnabled')}</div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('settings.shortcutSetting.masterEnabledHelp')}</div>
          </div>
          <button type="button" role="switch" aria-checked={keybindsGlobalMasterEnabled}
            onClick={() => updateKeybindsGlobalMasterEnabled(!keybindsGlobalMasterEnabled)}
            className={`relative shrink-0 w-10 h-5 rounded-full transition-colors duration-200 ${keybindsGlobalMasterEnabled ? 'bg-[var(--cyan-accent)]' : 'bg-fill-strong'}`}>
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${keybindsGlobalMasterEnabled ? 'translate-x-5' : ''}`} />
          </button>
        </div>
      )}

      {/* ── Section A: Dynamic Shortcuts ── */}
      <div className="mb-10">
        <div id="setting-shortcut-action" className="flex items-center justify-between mb-4">
          <h3 className="text-xs font-semibold text-[var(--cyan-accent)]">{t('settings.shortcuts')}</h3>
          <button id="setting-add-shortcut" type="button" onClick={handleAddDynamic}
            className="btn-cta flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs transition-all">
            <Plus size={14} />
            {t('settings.addShortcut')}
          </button>
        </div>

        {dynamicKeybinds.length === 0 ? (
          <div className="border border-default rounded-2xl px-5 py-8 text-center" style={{ backgroundColor: 'var(--bg-panel)' }}>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('settings.noShortcutsConfigured')}</p>
          </div>
        ) : (
          <div id="setting-shortcut-key-combo" className="border border-default rounded-2xl" style={{ backgroundColor: 'var(--bg-panel)' }}>
            {dynamicKeybinds.map((kb, i) => {
              const isEditing = editingKeybindId === kb.id && capturingKeys;
              const actionMeta = DYNAMIC_ACTIONS.find(a => a.value === kb.action);
              const isDropdownOpen = actionDropdownOpen === kb.id;
              return (
                <div key={kb.id} id={ACTION_TO_SETTING_ID[kb.action] ? `setting-keybind-${ACTION_TO_SETTING_ID[kb.action]}` : undefined} className={`flex items-center justify-between px-5 py-3 gap-3 ${i < dynamicKeybinds.length - 1 ? 'border-b border-default' : ''} ${!kb.enabled ? 'opacity-40' : ''}`} style={{ transition: 'opacity 0.2s' }}>
                  {/* Action dropdown trigger */}
                  <div className="relative min-w-[180px]">
                    <button type="button"
                      onClick={() => setActionDropdownOpen(isDropdownOpen ? null : kb.id)}
                      className={`flex items-center justify-between gap-2 w-full px-3 py-1.5 rounded-lg text-sm font-medium border cursor-pointer transition-all duration-150 ${isDropdownOpen ? 'border-[var(--cyan-accent)] ring-1 ring-[var(--cyan-accent)]/30' : 'border-[var(--glass-border)] hover:border-[var(--border-strong)]'}`}
                      style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-primary)' }}>
                      <span className="truncate">{actionMeta?.label ?? kb.action}</span>
                      <ChevronDown size={14} className={`shrink-0 transition-transform duration-200 ${isDropdownOpen ? 'rotate-180' : ''}`} style={{ color: 'var(--text-secondary)' }} />
                    </button>

                    {/* Custom dropdown menu */}
                    {isDropdownOpen && (
                      <div ref={dropdownRef}
                        className="absolute left-0 top-full mt-1.5 w-64 rounded-xl border border-[var(--glass-border)] shadow-2xl z-50 overflow-hidden"
                        style={{
                          backgroundColor: 'var(--bg-panel)',
                          animation: 'keybindDropdownIn 0.18s cubic-bezier(0.16, 1, 0.3, 1)',
                        }}>
                        <style>{`
                          @keyframes keybindDropdownIn {
                            from { opacity: 0; transform: translateY(-6px) scale(0.97); }
                            to { opacity: 1; transform: translateY(0) scale(1); }
                          }
                        `}</style>
                        <div className="max-h-[280px] overflow-y-auto py-1.5 scrollbar-thin scrollbar-thumb-[var(--fill-active)]">
                          {dynamicDropdownCategories.map((cat, ci) => (
                            <div key={cat}>
                              {ci > 0 && <div className="mx-3 my-1 border-t border-default" />}
                              <p className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-secondary)' }}>{cat}</p>
                              {DYNAMIC_ACTIONS.filter(a => a.category === cat).map(a => (
                                <button key={a.value} type="button"
                                  onClick={() => { handleChangeAction(kb.id, a.value); setActionDropdownOpen(null); }}
                                  className={`flex items-center w-full px-3 py-1.5 text-sm text-left transition-colors duration-100 ${kb.action === a.value ? 'bg-[var(--cyan-accent)]/10 text-[var(--cyan-accent)]' : 'hover:bg-fill-hover'}`}
                                  style={{ color: kb.action === a.value ? 'var(--cyan-accent)' : 'var(--text-primary)' }}>
                                  <span className="flex-1 truncate">{a.label}</span>
                                  {kb.action === a.value && <Check size={14} className="shrink-0 ml-2" />}
                                </button>
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Backdrop to close dropdown */}
                    {isDropdownOpen && <div className="fixed inset-0 z-40" onClick={() => setActionDropdownOpen(null)} />}
                  </div>

                  {/* Key combo / Record */}
                  <div className="flex items-center gap-2 shrink-0 ml-auto">
                    {isEditing ? (
                      <button type="button"
                        onClick={cancelRecord}
                        title={t('settings.shortcutCancel', { defaultValue: 'Cancel (Esc) · Backspace to clear' })}
                        className="px-3 py-1.5 rounded-lg border-2 border-[var(--cyan-accent)] text-xs font-mono animate-pulse min-w-[120px] text-center cursor-pointer"
                        style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-primary)' }}
                      >{t('settings.shortcutPressKeys')}</button>
                    ) : (
                      <div className="flex gap-1 min-w-[120px] justify-end flex-wrap">
                        {formatKeyDisplay(kb.keys).map((k, j) => (
                          <span key={j} className="px-2 py-1 rounded-md text-xs font-mono font-bold border border-[var(--glass-border)]" style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-secondary)' }}>{k.trim()}</span>
                        ))}
                      </div>
                    )}
                    <button type="button" onClick={() => beginRecordById(kb.id)}
                      className="btn-secondary px-3 py-1.5 text-xs">
                      {t('settings.shortcutRecord')}
                    </button>
                    <button type="button" onClick={() => handleDeleteDynamic(kb.id)}
                      className="px-2 py-1.5 rounded-lg text-xs hover:bg-red-500/20 transition-all" style={{ color: 'var(--text-secondary)' }}
                      title={t('common.delete')}>
                      <Trash2 size={12} />
                    </button>
                    <button type="button" role="switch" aria-checked={kb.enabled} onClick={() => handleToggleEnabledById(kb.id)}
                      className={`relative shrink-0 w-10 h-5 rounded-full transition-colors duration-200 ${kb.enabled ? 'bg-[var(--cyan-accent)]' : 'bg-fill-strong'}`}>
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${kb.enabled ? 'translate-x-5' : ''}`} />
                    </button>
                    {IS_ELECTRON && GLOBAL_CAPABLE_ACTIONS.has(kb.action) && keybindsGlobalMasterEnabled && (
                      <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }} title={t('settings.shortcutSetting.globalTooltip')}>
                        <input
                          type="checkbox"
                          checked={!!kb.global}
                          onChange={(e) => {
                            const next = kbList.map(k => k.id === kb.id ? { ...k, global: e.target.checked } : k);
                            onKeybindsChange?.(next);
                          }}
                          className="accent-[var(--cyan-accent)]"
                        />
                        {t('settings.shortcutSetting.global')}
                      </label>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Section B: Default Shortcuts ── */}
      <div className="mb-8">
        <h3 className="text-xs font-semibold mb-4 text-[var(--cyan-accent)]">{t('settings.defaultShortcuts')}</h3>
        {fixedCategories.map(cat => {
          const actions = FIXED_ACTIONS.filter(a => a.category === cat);
          return (
            <div key={cat} className="mb-6">
              <p className="text-[11px] font-semibold mb-2 uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{cat}</p>
              <div className="border border-default rounded-2xl overflow-hidden" style={{ backgroundColor: 'var(--bg-panel)' }}>
                {actions.map((act, i) => {
                  const isEditing = editingKeybindId === act.value && capturingKeys;
                  const currentKey = getEffectiveKey(act.value);
                  const enabled = isEnabled(act.value);
                  const custom = isCustomised(act.value);
                  return (
                    <div key={act.value} id={ACTION_TO_SETTING_ID[act.value] ? `setting-keybind-${ACTION_TO_SETTING_ID[act.value]}` : undefined} className={`flex items-center justify-between px-5 py-3 gap-4 ${i < actions.length - 1 ? 'border-b border-default' : ''} ${!enabled ? 'opacity-40' : ''}`} style={{ transition: 'opacity 0.2s' }}>
                      <span className="text-sm font-medium flex-1 min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>{act.label}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        {isEditing ? (
                          <button type="button"
                            onClick={cancelRecord}
                            title={t('settings.shortcutCancel', { defaultValue: 'Cancel (Esc) · Backspace to clear' })}
                            className="px-3 py-1.5 rounded-lg border-2 border-[var(--cyan-accent)] text-xs font-mono animate-pulse min-w-[120px] text-center cursor-pointer"
                            style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-primary)' }}
                          >{t('settings.shortcutPressKeys')}</button>
                        ) : (
                          <div className="flex gap-1 min-w-[120px] justify-end flex-wrap">
                            {formatKeyDisplay(currentKey).map((k, j) => (
                              <span key={j} className="px-2 py-1 rounded-md text-xs font-mono font-bold border border-[var(--glass-border)]" style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-secondary)' }}>{k.trim()}</span>
                            ))}
                          </div>
                        )}
                        <button type="button" onClick={() => beginRecordByAction(act.value)}
                          className="btn-secondary px-3 py-1.5 text-xs">
                          {t('settings.shortcutRecord')}
                        </button>
                        {custom && (
                          <button type="button" onClick={() => handleResetKey(act.value)}
                            className="px-2 py-1.5 rounded-lg text-xs hover:bg-fill-active transition-all" style={{ color: 'var(--text-secondary)' }}
                            title={t('settings.shortcutResetDefault')}>
                            <RotateCcw size={12} />
                          </button>
                        )}
                        <button type="button" role="switch" aria-checked={enabled} onClick={() => handleToggleEnabled(act.value)}
                          className={`relative shrink-0 w-10 h-5 rounded-full transition-colors duration-200 ${enabled ? 'bg-[var(--cyan-accent)]' : 'bg-fill-strong'}`}>
                          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${enabled ? 'translate-x-5' : ''}`} />
                        </button>
                        {IS_ELECTRON && GLOBAL_CAPABLE_ACTIONS.has(act.value) && keybindsGlobalMasterEnabled && (
                          <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }} title={t('settings.shortcutSetting.globalTooltip')}>
                            <input
                              type="checkbox"
                              checked={isActionGlobal(act.value)}
                              onChange={(e) => setGlobalForAction(act.value, e.target.checked)}
                              className="accent-[var(--cyan-accent)]"
                            />
                            {t('settings.shortcutSetting.global')}
                          </label>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Conflict warning dialog */}
      {conflictWarning && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="rounded-2xl border p-6 max-w-sm w-full mx-4" style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}>
            <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{t('settings.keybinds.conflictTitle')}</h3>
            <p className="text-xs mb-6" style={{ color: 'var(--text-secondary)' }}>
              <span className="font-mono font-bold">{conflictWarning.combo}</span> {t('settings.keybinds.conflictAssignedTo')} <span className="font-semibold">{getActionLabel(conflictWarning.existingAction)}</span>. {t('settings.keybinds.conflictReplace')}
            </p>
            <div className="flex gap-3 justify-end">
              <button type="button" onClick={() => { setConflictWarning(null); setCapturingKeys(false); setEditingKeybindId(null); }} className="px-4 py-2 text-sm rounded-lg bg-fill-hover hover:bg-fill-active" style={{ color: 'var(--text-secondary)' }}>{t('common.cancel')}</button>
              <button type="button" onClick={applyConflictOverride} className="btn-cta px-4 py-2 text-sm rounded-xl">{t('settings.keybinds.replace')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default KeybindsTab;
