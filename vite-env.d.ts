/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;

declare module 'virtual:pwa-register' {
  export function registerSW(options?: {
    immediate?: boolean;
    onNeedRefresh?: () => void;
    onOfflineReady?: () => void;
    onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void;
    onRegisteredSW?: (swUrl: string, registration: ServiceWorkerRegistration | undefined) => void;
    onRegisterError?: (error: Error) => void;
  }): (reloadPage?: boolean) => Promise<void>;
}

interface ImportMetaEnv {
  readonly VITE_DOWNLOAD_BASE_URL?: string;
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_BACKEND_PORT?: string;
  readonly VITE_SAME_ORIGIN?: string;
  readonly VITE_TURNSTILE_SITE_KEY?: string;
  readonly VITE_DONATE_URL?: string;
  readonly VITE_LIVEKIT_URL?: string;
  readonly VITE_ADSENSE_CLIENT_ID?: string;
  readonly VITE_ADSENSE_SLOT_HEADER?: string;
  readonly VITE_ADSENSE_SLOT_SIDEBAR?: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
