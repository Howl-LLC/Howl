interface ElectronBridge {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  isElectron: true;
  platform: 'win32' | 'darwin' | 'linux';
  onMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void;
  onUpdateDownloaded: (callback: (version: string) => void) => () => void;
  restartForUpdate: () => void;
  showNotification: (title: string, body: string) => void;
  getGPUInfo: () => Promise<{ vendor: string; name: string; vendorId?: number | null; deviceId?: number | null; driverVersion?: string | null }>;
  setForceSwEncode: (enabled: boolean) => Promise<boolean>;
  onSystemResume?: (callback: () => void) => () => void;
  onUpdateError?: (callback: (message: string) => void) => () => void;
  getDetectedGame: () => Promise<{ name: string; exeName: string; steamAppId?: string; detectedAt: string } | null>;
  setGameDetectionEnabled: (enabled: boolean) => Promise<void>;
  onGameActivityDetected: (callback: (game: { name: string; exeName: string; steamAppId?: string; detectedAt: string }) => void) => () => void;
  onGameActivityCleared: (callback: () => void) => () => void;
  getRunningProcesses: () => Promise<string[]>;
  addCustomGame: (game: { exeName: string; displayName: string }) => Promise<void>;
  removeCustomGame: (exeName: string) => Promise<void>;
  getCustomGames: () => Promise<Array<{ exeName: string; name: string }>>;
  getDetectedSpotify: () => Promise<{ name: string; artist: string; detectedAt: string } | null>;
  setSpotifyDetectionEnabled: (enabled: boolean) => Promise<void>;
  onSpotifyDetected: (callback: (track: { name: string; artist: string; detectedAt: string }) => void) => () => void;
  onSpotifyCleared: (callback: () => void) => () => void;
  getDesktopSources?: () => Promise<Array<{
    id: string;
    name: string;
    thumbnail: string;
    appIcon: string | null;
    display_id: string;
  }>>;
  onWindowVisibility?: (callback: (visible: boolean) => void) => () => void;
  clearCache?: () => Promise<{ success: boolean }>;
  // Composer spellcheck
  // Native Chromium spellcheck wired through main.js; renderer uses the
  // suggestions to render its own context menu. See main.js + preload.js.
  spellcheck?: {
    onContextMenu: (callback: (params: {
      x: number;
      y: number;
      isEditable: boolean;
      misspelledWord: string;
      dictionarySuggestions: string[];
      selectionText: string;
      canCut: boolean;
      canCopy: boolean;
      canPaste: boolean;
      canSelectAll: boolean;
    }) => void) => () => void;
    replaceMisspelling: (word: string) => void;
    addToDictionary: (word: string) => void;
    getAvailableLanguages: () => Promise<string[]>;
    getLanguages: () => Promise<string[]>;
    setLanguages: (languages: string[]) => Promise<boolean>;
  };
  // Game overlay IPC
  setOverlayEnabled?: (enabled: boolean) => void;
  updateOverlayVoice?: (data: unknown) => void;
  updateOverlayNotifications?: (data: unknown) => void;
  updateOverlaySettings?: (settings: unknown) => void;
  updateOverlayServers?: (data: unknown) => void;
  updateOverlayMessages?: (data: unknown) => void;
  updateOverlayUnreads?: (data: unknown) => void;
  onOverlayToMain?: (callback: (channel: string, ...args: unknown[]) => void) => () => void;
  onDeepLink?: (cb: (data: { action: string; code: string }) => void) => () => void;
  startSso?: (provider: string) => void;
  startSsoLink?: (data: { provider: string; linkToken: string }) => void;
  startAppConnect?: (data: { provider: string; connectToken: string }) => void;
  startPasskeyLogin?: () => void;
  startPasskeyMfa?: (mfaToken: string) => Promise<void>;
  startPasskeyRegister?: (sessionToken: string) => Promise<void>;
  onSsoCallback?: (callback: (data: { code?: string; error?: string }) => void) => () => void;
  onSsoSettingsCallback?: (callback: (data: Record<string, string>) => void) => () => void;
  openExternal?: (url: string) => Promise<{ success: boolean }>;
  getAppSettings?: () => Promise<{ closeAction: 'ask' | 'tray' | 'quit'; startMinimized: boolean }>;
  setAppSettings?: (settings: { closeAction?: 'ask' | 'tray' | 'quit'; startMinimized?: boolean }) => Promise<{ closeAction: 'ask' | 'tray' | 'quit'; startMinimized: boolean }>;
  setBadgeCount?: (count: number, options?: { overlayPng?: string | null; taskbarFlash?: boolean }) => void;
  onShowCloseActionModal?: (callback: () => void) => () => void;
  closeActionChosen?: (action: 'tray' | 'quit', remember: boolean) => void;
  onUpdateAvailable?: (callback: (version: string) => void) => (() => void);
  checkForUpdate?: () => void;
  repairClearCache?: () => void;
  repairReinstall?: () => void;
  getAutostart?: () => Promise<{ enabled: boolean; startHidden: boolean }>;
  setAutostart?: (opts: { enabled: boolean; startHidden: boolean }) => void;
  setVoiceSessionState?: (active: boolean) => void;
  setZoomFactor?: (factor: number) => void;
  getZoomFactor?: () => number;
  onZoomCommand?: (callback: (direction: 'in' | 'out' | 'reset') => void) => () => void;
  // Update screen
  updateCheckComplete?: () => void;
  onUpdateChecking?: (callback: () => void) => () => void;
  onUpdateDownloadProgress?: (callback: (percent: number) => void) => () => void;
  onUpdateNotAvailable?: (callback: () => void) => () => void;
  getUpdateStatus?: () => Promise<{ available: string | null; downloaded: string | null }>;
  getBuildDate?: () => Promise<string>;
  downloadBlob?: (base64Data: string, fileName: string) => Promise<boolean>;
  /** OS-keychain envelope. Present only on Electron; web callers must fall back. */
  safeStorage?: {
    isAvailable: () => Promise<boolean>;
    encryptString: (plaintext: string) => Promise<string>;
    decryptString: (ciphertextB64: string) => Promise<string>;
  };
}

interface TurnstileWidget {
  render(container: string | HTMLElement, options: Record<string, unknown>): string;
  remove(widgetId: string): void;
  reset(widgetId: string): void;
}

interface Window {
  electron?: ElectronBridge;
  __ELECTRON_WINDOW__?: boolean;
  __ELECTRON_PLATFORM__?: string;
  turnstile?: TurnstileWidget;
}
