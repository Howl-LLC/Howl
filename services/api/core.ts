// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { User, Message, GameActivity } from '../../types';
import { API_BASE_URL, getBackendOrigin } from '../../config';
import { normalizeMessage as normalizeMessageRaw } from '../messageNormalizer';
import type { BackendUser, BackendMessage, BackendDMMessage } from '../apiTypes';
import { useUpdateStore } from '../../stores/updateStore';
import { getProtocolHeaders } from './protocolHeaders';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export class APIClient {
  private token: string | null = null;
  private refreshPromise: Promise<string | null> | null = null;
  private refreshFailedAt = 0;
  private static readonly REFRESH_COOLDOWN_MS = 5000;
  private sessionExpiredCallback: (() => void) | null = null;
  private cache = new Map<string, { data: unknown; expiresAt: number }>();
  private pendingGets = new Map<string, Promise<unknown>>();
  private readonly DEFAULT_CACHE_TTL = 15_000;
  private readonly MAX_CACHE_ENTRIES = 200;
  /**
   * Per-endpoint-family client-side rate-limit gate. Keyed by the request
   * path with UUIDs and numeric ids replaced by `:id`, so `/messages/channels/<uuid>`
   * and `/messages/channels/<other-uuid>` share one entry but `/auth/me/status`
   * has its own. Avoids the prior bug where a 429 on a chatty endpoint
   * (e.g. presence pings) would lock out unrelated writes like message sends.
   */
  private rateLimitUntilByFamily = new Map<string, number>();
  /** Hard ceiling on the fallback Retry-After window when the server omits the header. */
  private static readonly RATE_LIMIT_FALLBACK_MAX_MS = 10_000;
  private onRateLimit: ((info: { retryAfter: number; isMutation: boolean }) => void) | null = null;

  setRateLimitHandler(fn: ((info: { retryAfter: number; isMutation: boolean }) => void) | null) {
    this.onRateLimit = fn;
  }

  getCached<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) { this.cache.delete(key); return undefined; }
    return entry.data as T;
  }

  setCache(key: string, data: unknown, ttl = this.DEFAULT_CACHE_TTL) {
    if (this.cache.size >= this.MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { data, expiresAt: Date.now() + ttl });
  }

  invalidateCache(prefix?: string) {
    if (!prefix) { this.cache.clear(); return; }
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  constructor() {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('auth_token');
    }
  }

  onSessionExpired(callback: () => void) {
    this.sessionExpiredCallback = callback;
  }

  setToken(token: string) {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  clearToken() {
    this.token = null;
  }

  /** Invoked by the socket service when the server emits 'session-expired'. */
  triggerSessionExpired() {
    this.token = null;
    this.sessionExpiredCallback?.();
  }

  async logout(): Promise<void> {
    try {
      const headers: Record<string, string> = {
        ...await getProtocolHeaders(),
        ...(this.token ? { 'Authorization': `Bearer ${this.token}` } : {}),
      };
      await fetch(`${API_BASE_URL}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers,
      });
    } catch { /* best-effort */ }
    this.token = null;
    this.refreshPromise = null;
    this.cache.clear();
    this.pendingGets.clear();
    this.rateLimitUntilByFamily.clear();
    this.refreshFailedAt = 0;
  }

  async exchangeSsoCode(code: string): Promise<{ user: User } | { mfaRequired: true; mfaToken: string; methods: string[] }> {
    const res = await fetch(`${API_BASE_URL}/auth/sso/exchange-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...await getProtocolHeaders() },
      credentials: 'include',
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to exchange SSO code');
    }
    const data = await res.json() as { token?: string; mfaRequired?: boolean; mfaToken?: string; methods?: string[] };
    if (data.mfaRequired && data.mfaToken && data.methods) {
      return { mfaRequired: true, mfaToken: data.mfaToken, methods: data.methods };
    }
    if (!data.token) throw new Error('Failed to exchange SSO code');
    this.setToken(data.token);
    return { user: await this.me() };
  }

  async refreshAccessToken(): Promise<string | null> {
    if (this.refreshPromise) return this.refreshPromise;
    if (Date.now() - this.refreshFailedAt < APIClient.REFRESH_COOLDOWN_MS) return null;
    this.refreshPromise = (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...await getProtocolHeaders() },
        });
        if (!res.ok) {
          // Only clear the token on HARD auth failures (refresh cookie
          // invalid / expired / revoked). Transient server errors (5xx) or
          // rate-limits (429) must NOT sign the user out — the cookie is
          // still valid, we just couldn't reach the server. Letting 502
          // from a Cloudflare hiccup nuke the user's session is the root
          // cause of the "active-use signout" reports.
          if (res.status === 401 || res.status === 403) {
            this.token = null;
          } else {
            this.refreshFailedAt = Date.now();
          }
          return null;
        }
        const data = await res.json() as { token: string };
        this.token = data.token;
        // Broadcast new token to other tabs so they don't need to refresh independently
        try {
          const bc = new BroadcastChannel('howl_token_sync');
          bc.postMessage({ type: 'token_refresh', token: data.token });
          bc.close();
        } catch { /* best-effort cross-tab sync */ }
        return data.token;
      } catch {
        // Network error (offline, DNS fail, timeout). Do NOT null the token
        // — keep it so the next retry after connectivity returns doesn't
        // force a re-login. The 5s cooldown prevents hot-loop retries.
        this.refreshFailedAt = Date.now();
        return null;
      } finally {
        this.refreshPromise = null;
      }
    })();
    return this.refreshPromise;
  }

  private static readonly REQUEST_TIMEOUT_MS = 15000;

  /**
   * Collapse an endpoint path into a coarse "family" key for the per-family
   * rate-limit gate. Strips query strings, lowercases, and replaces UUIDs
   * and bare numeric segments with `:id`. Intentionally coarse: we'd rather
   * over-share a gate within a logical route than under-share it.
   */
  private rateLimitFamilyKey(endpoint: string): string {
    const path = endpoint.split('?')[0].toLowerCase();
    return path
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id')
      .replace(/(?<=\/)\d+(?=\/|$)/g, ':id');
  }

  async request<T>(endpoint: string, options: RequestInit = {}, isRetry = false): Promise<T> {
    const method = (options.method ?? 'GET').toUpperCase();
    const familyKey = this.rateLimitFamilyKey(endpoint);
    if (method !== 'GET') {
      const until = this.rateLimitUntilByFamily.get(familyKey) ?? 0;
      if (Date.now() < until) {
        throw Object.assign(new Error('Rate limited \u2014 please wait before retrying.'), { isRateLimit: true });
      }
      if (until && Date.now() >= until) this.rateLimitUntilByFamily.delete(familyKey);
    }
    const isGet = method === 'GET' && !options.body;

    if (isGet && !isRetry) {
      const pending = this.pendingGets.get(endpoint);
      if (pending) return pending as Promise<T>;
    }

    const doRequest = async (): Promise<T> => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string> || {}),
      };

      const token = this.getToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      // Protocol handshake headers
      Object.assign(headers, await getProtocolHeaders());

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), APIClient.REQUEST_TIMEOUT_MS);

      let res: Response;
      try {
        res = await fetch(`${API_BASE_URL}${endpoint}`, {
          ...options,
          headers,
          credentials: 'include',
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error('Request timed out. Please check your connection and try again.', { cause: err });
        }
        if (/fetch|network|failed to load|connection/i.test(msg)) {
          throw new Error("Can't reach the server. Check your connection and that the API is available.", { cause: err });
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }

      // Version-gate: server returns 426 Upgrade Required when the client
      // build is too old or the protocol version is unsupported.
      if (res.status === 426) {
        try {
          const body = await res.json();
          if (body?.reason === 'buildDate' || body?.reason === 'protocolVersion') {
            useUpdateStore.getState().setRequired(body.reason);
          }
        } catch { /* ignore malformed body */ }
        throw new Error('Upgrade required');
      }

      if (res.status === 401 && !isRetry && !endpoint.includes('/auth/refresh') && token) {
        const newToken = await this.refreshAccessToken();
        if (newToken) {
          return this.request<T>(endpoint, options, true);
        }
        if (this.token === null && this.sessionExpiredCallback) {
          this.sessionExpiredCallback();
        }
      }

      // Transparent retry for GETs that get rate-limited. We only retry once
      // (gated by !isRetry, which is also used by the 401-refresh path) so a
      // single request can never produce more than one retry total.
      if (res.status === 429 && isGet && !isRetry) {
        const parsed = parseInt(res.headers.get('Retry-After') || '', 10);
        const retryAfter = Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : 5, 10);
        await sleep(retryAfter * 1000 + Math.random() * 500);
        return this.request<T>(endpoint, options, true);
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let message = `Request failed with status ${res.status}`;
        let fields: Record<string, string> | undefined;
        // A 404 whose body is not the API's JSON `{ error }` shape did not come from a
        // route handler (dev proxy with the backend down, captive portal, CDN edge).
        // Stamped on the error so consumers that treat a 404 as an authoritative
        // "resource deleted" signal (e.g. the MLS stale-group teardown) can ignore it.
        let nonApiResponse = false;
        if (res.status >= 500) {
          message = "Server error. Please try again in a moment.";
        } else if (res.status === 404 && text && text.trimStart().startsWith('<!')) {
          message = 'API not found (404). Is the backend running?';
          nonApiResponse = true;
        } else {
          try {
            const body = text ? JSON.parse(text) : null;
            if (body && typeof body.error === 'string') message = body.error;
            if (body && typeof body.fields === 'object' && body.fields !== null) {
              fields = body.fields as Record<string, string>;
            }
            if (res.status === 404 && (!body || typeof body.error !== 'string')) nonApiResponse = true;
          } catch {
            if (text && text.length < 200) message = text;
            if (res.status === 404) nonApiResponse = true;
          }
        }
        const err = new Error(message) as Error & { status?: number; isRateLimit?: boolean; fields?: Record<string, string>; nonApiResponse?: boolean };
        err.status = res.status;
        if (fields) err.fields = fields;
        if (nonApiResponse) err.nonApiResponse = true;
        if (res.status === 429) {
          err.isRateLimit = true;
          const retryAfterHeader = res.headers.get('Retry-After');
          const parsed = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
          // GETs self-heal via the transparent retry above; only block
          // subsequent non-GETs in the same endpoint family.
          if (!isGet) {
            // Only honor server-supplied Retry-After (capped at 60s for sanity);
            // when the header is missing or unparseable, fall back to a short
            // window so a single transient 429 cannot lock writes for a minute.
            const retryAfterMs = Number.isFinite(parsed) && parsed > 0
              ? Math.min(parsed * 1000, 60_000)
              : APIClient.RATE_LIMIT_FALLBACK_MAX_MS;
            this.rateLimitUntilByFamily.set(familyKey, Date.now() + retryAfterMs);
          }
          const retryAfterForToast = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
          this.onRateLimit?.({ retryAfter: retryAfterForToast, isMutation: !isGet });
        }
        throw err;
      }

      if (res.status === 204) return undefined as T;
      return res.json() as Promise<T>;
    };

    if (isGet && !isRetry) {
      const promise = doRequest().finally(() => {
        this.pendingGets.delete(endpoint);
      });
      this.pendingGets.set(endpoint, promise);
      return promise;
    }

    return doRequest();
  }

  /** Resolve relative upload paths to full URL for display. */
  resolveAssetUrl(url: string | null | undefined): string | undefined {
    if (!url) return undefined;
    if (url.startsWith('/')) return getBackendOrigin() + url;
    return url;
  }

  normalizeUser(backendUser: BackendUser): User {
    const avatarUrl =
      this.resolveAssetUrl(backendUser.avatar) || null;
    const bannerUrl = this.resolveAssetUrl(backendUser.banner);
    const bgImageUrl = this.resolveAssetUrl(backendUser.backgroundImage);

    return {
      id: backendUser.id,
      username: backendUser.username,
      discriminator: backendUser.discriminator,
      email: backendUser.email,
      avatar: avatarUrl,
      banner: bannerUrl ?? undefined,
      bannerPositionY: backendUser.bannerPositionY ?? 50,
      bannerZoom: backendUser.bannerZoom ?? 100,
      status: backendUser.status === 'invisible' ? 'offline' : ((backendUser.status as User['status']) ?? 'offline'),
      rawStatus: backendUser.status as User['status'] ?? 'offline',
      stripePlan: backendUser.stripePlan ?? null,
      effectivePlan: backendUser.effectivePlan ?? backendUser.stripePlan ?? null,
      nameColor: backendUser.nameColor ?? null,
      nameFont: backendUser.nameFont ?? null,
      nameEffect: backendUser.nameEffect ?? null,
      avatarEffect: backendUser.avatarEffect ?? null,
      badges: backendUser.badges ?? [],
      mfaEnabled: backendUser.mfaEnabled ?? false,
      backgroundImage: bgImageUrl ?? null,
      backgroundOpacity: backendUser.backgroundOpacity ?? 0.15,
      backgroundBlur: backendUser.backgroundBlur ?? 0,
      bgGifAlwaysPlay: backendUser.bgGifAlwaysPlay ?? false,
      needsDateOfBirth: backendUser.needsDateOfBirth ?? false,
      needsOnboarding: backendUser.needsOnboarding ?? false,
      emailVerified: backendUser.emailVerified ?? true,
      hasPassword: backendUser.hasPassword,
      isMinor: backendUser.isMinor ?? false,
      activity: backendUser.activity ? {
        type: backendUser.activity.type as GameActivity['type'],
        name: backendUser.activity.name,
        details: backendUser.activity.details ?? undefined,
        state: backendUser.activity.state ?? undefined,
        largeImage: backendUser.activity.largeImage ?? undefined,
        smallImage: backendUser.activity.smallImage ?? undefined,
        startedAt: backendUser.activity.startedAt,
        platformId: backendUser.activity.platformId ?? undefined,
        platform: backendUser.activity.platform ?? undefined,
        durationMs: backendUser.activity.durationMs ?? undefined,
      } : undefined,
      secondaryActivity: backendUser.secondaryActivity ? {
        type: backendUser.secondaryActivity.type as GameActivity['type'],
        name: backendUser.secondaryActivity.name,
        details: backendUser.secondaryActivity.details ?? undefined,
        state: backendUser.secondaryActivity.state ?? undefined,
        largeImage: backendUser.secondaryActivity.largeImage ?? undefined,
        smallImage: backendUser.secondaryActivity.smallImage ?? undefined,
        startedAt: backendUser.secondaryActivity.startedAt,
        platformId: backendUser.secondaryActivity.platformId ?? undefined,
        platform: backendUser.secondaryActivity.platform ?? undefined,
        durationMs: backendUser.secondaryActivity.durationMs ?? undefined,
      } : undefined,
      customStatus: backendUser.customStatus ?? undefined,
      activityBio: backendUser.activityBio ?? undefined,
      hasSpotify: backendUser.connectedApps?.some(a => a.provider === 'spotify') ?? false,
    };
  }

  normalizeMessage(backendMessage: BackendMessage): Message {
    const msg = normalizeMessageRaw(backendMessage);
    // Channel messages default authorRoleStyle to 'solid' (DM messages leave it undefined)
    msg.authorRoleStyle = (backendMessage.authorRoleStyle as Message['authorRoleStyle']) ?? 'solid';
    return msg;
  }

  normalizeDmMessage(m: BackendDMMessage): Message {
    return normalizeMessageRaw(m);
  }

  async me(): Promise<User> {
    const data = await this.request<BackendUser>('/auth/me');
    return this.normalizeUser(data);
  }
}
