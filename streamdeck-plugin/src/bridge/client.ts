// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type {
  Topic,
  ResponseFrame,
  ErrorFrame,
  EventFrame,
} from '../protocol/types.js';
import { MAX_FRAME_BYTES } from '../protocol/types.js';

// Port-info discovery

export interface PortInfo {
  port: number;
  installId: string;
  version: string;
}

/**
 * Read the Howl bridge port-info file. Returns null if the file is missing,
 * unreadable, or malformed.
 */
export function discover(userDataDir?: string): PortInfo | null {
  const dir = userDataDir ?? defaultUserDataDir();
  if (!dir) return null;

  const filePath = join(dir, 'streamdeck-bridge.json');
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof obj.port !== 'number' ||
      typeof obj.installId !== 'string' ||
      typeof obj.version !== 'string'
    ) {
      return null;
    }
    return { port: obj.port, installId: obj.installId, version: obj.version };
  } catch {
    return null;
  }
}

function defaultUserDataDir(): string | null {
  const platform = process.platform;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? null;
  if (!home) return null;

  switch (platform) {
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Howl');
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Howl');
    case 'linux':
      return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Howl');
    default:
      return null;
  }
}

// BridgeClient

export type ConnectionState = 'connecting' | 'connected' | 'paired' | 'offline' | 'degraded';

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: { code: string; detail?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PluginInfo {
  pluginId: string;
  displayName: string;
  version: string;
}

const BACKOFF_STEPS = [1_000, 2_000, 5_000, 10_000, 30_000];
const REQUEST_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 30_000;

export class BridgeClient {
  private ws: WebSocket | null = null;
  readonly pluginInfo: PluginInfo;
  private pending = new Map<string, PendingRequest>();
  private eventListeners = new Set<(topic: string, data: unknown, isSnapshot: boolean) => void>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private _state: ConnectionState = 'offline';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  // Stored for reconnect flows.
  private storedToken: string | null = null;
  private subscribedTopics: Topic[] = [];

  constructor(opts: { pluginInfo: PluginInfo }) {
    this.pluginInfo = opts.pluginInfo;
  }

  // -- Public API -----------------------------------------------------------

  /**
   * Discover the bridge port-info file and open a WebSocket connection.
   * Resolves when the WS is OPEN; rejects if discovery fails or connect
   * times out.
   */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const info = discover();
      if (!info) {
        this.setState('offline');
        reject(new Error('Bridge port-info file not found'));
        return;
      }

      this.setState('connecting');

      const url = `ws://127.0.0.1:${info.port}/bridge`;
      const ws = new WebSocket(url, {
        headers: { Host: `127.0.0.1:${info.port}` },
        maxPayload: MAX_FRAME_BYTES,
      });

      const openTimeout = setTimeout(() => {
        ws.terminate();
        this.setState('offline');
        reject(new Error('Connection timeout'));
      }, 10_000);

      ws.on('open', () => {
        clearTimeout(openTimeout);
        this.ws = ws;
        this.reconnectAttempt = 0;
        this.setState('connected');
        this.startPing();
        resolve();
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        this.handleMessage(raw);
      });

      ws.on('close', () => {
        clearTimeout(openTimeout);
        this.cleanup();
        if (!this.destroyed) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', () => {
        // Error events are followed by close; no-op here.
      });

      ws.on('pong', () => {
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
      });
    });
  }

  /**
   * Send a `pair` command with a freshly generated 64-hex-char challenge.
   * Resolves with `{ token }` on `pair-accepted`.
   */
  pair(): Promise<{ token: string }> {
    const challenge = randomBytes(32).toString('hex'); // 64 hex chars
    return this.request('pair', {
      pluginId: this.pluginInfo.pluginId,
      displayName: this.pluginInfo.displayName,
      version: this.pluginInfo.version,
      challenge,
    }).then((data) => {
      const d = data as { token?: string };
      if (!d.token || typeof d.token !== 'string') {
        throw { code: 'invalid-response', detail: 'Missing token in pair-accepted' };
      }
      this.storedToken = d.token;
      this.setState('paired');
      return { token: d.token };
    });
  }

  /**
   * Authenticate with a previously-obtained token.
   */
  async auth(token: string): Promise<void> {
    await this.request('auth', { token });
    this.storedToken = token;
    this.setState('paired');
  }

  /**
   * Subscribe to state topics. The bridge will send snapshot events for
   * each topic, followed by deltas. Snapshot events are routed through
   * `onEvent` listeners.
   */
  async subscribe(topics: Topic[]): Promise<void> {
    await this.request('subscribe', { topics });
    // Merge into subscribed set for reconnect.
    const set = new Set([...this.subscribedTopics, ...topics]);
    this.subscribedTopics = [...set];
  }

  /**
   * Execute an action on the Howl renderer via the bridge.
   */
  async execute(action: string, params?: Record<string, unknown>): Promise<unknown> {
    const data = await this.request('execute', { action, params });
    return data;
  }

  /**
   * List resources for Property Inspector pickers.
   */
  async list(resource: string, params?: Record<string, unknown>): Promise<unknown[]> {
    const data = await this.request('list', { resource, params });
    return Array.isArray(data) ? data : [];
  }

  /**
   * Subscribe to state events pushed by the bridge.
   * Returns an unsubscribe function.
   */
  onEvent(cb: (topic: string, data: unknown, isSnapshot: boolean) => void): () => void {
    this.eventListeners.add(cb);
    return () => { this.eventListeners.delete(cb); };
  }

  /**
   * Subscribe to connection state changes.
   * Returns an unsubscribe function.
   */
  onStateChange(cb: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    return () => { this.stateListeners.delete(cb); };
  }

  /** Current connection state. */
  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Gracefully close the connection. No reconnect.
   */
  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'plugin-shutdown');
      this.ws = null;
    }
    this.cleanup();
    this.setState('offline');
  }

  // -- Internal -------------------------------------------------------------

  private setState(s: ConnectionState): void {
    if (this._state === s) return;
    this._state = s;
    for (const cb of this.stateListeners) {
      try { cb(s); } catch { /* swallow */ }
    }
  }

  private send(frame: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not open');
    }
    const payload = JSON.stringify({ v: 1, id: randomUUID(), ...frame });
    if (payload.length > MAX_FRAME_BYTES) {
      throw new Error('Frame exceeds MAX_FRAME_BYTES');
    }
    this.ws.send(payload);
  }

  /**
   * Send a command and await its response (matched by `id`).
   */
  private request(type: string, fields: Record<string, unknown>): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject({ code: 'timeout', detail: `Request ${type} timed out` });
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      const frame: Record<string, unknown> = {
        v: 1,
        id,
        kind: 'command',
        type,
        ...fields,
      };

      try {
        const payload = JSON.stringify(frame);
        if (payload.length > MAX_FRAME_BYTES) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject({ code: 'frame-too-large' });
          return;
        }
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject({ code: 'not-connected' });
          return;
        }
        this.ws.send(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject({ code: 'send-error', detail: String(err) });
      }
    });
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let frame: Record<string, unknown>;
    try {
      const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return; // Malformed JSON — drop silently.
    }

    // Minimal shape validation (no Zod on the plugin side — keep bundle lean).
    if (typeof frame !== 'object' || frame === null) return;
    if (frame.v !== 1) return;

    const kind = frame.kind as string | undefined;
    const id = frame.id as string | undefined;

    if (kind === 'response' && id && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve((frame as unknown as ResponseFrame).data);
      return;
    }

    if (kind === 'error') {
      const errFrame = frame as unknown as ErrorFrame;
      if (id && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject({ code: errFrame.code, detail: errFrame.detail });
        return;
      }
      // Broadcast errors (e.g. unsupported-version) — handle if needed.
      if (errFrame.code === 'unsupported-version') {
        this.setState('degraded');
      }
      return;
    }

    if (kind === 'event') {
      const ev = frame as unknown as EventFrame;
      for (const cb of this.eventListeners) {
        try { cb(ev.topic, ev.data, ev.snapshot); } catch { /* swallow */ }
      }
      return;
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.ping();
      this.pongTimer = setTimeout(() => {
        // Pong timeout — connection is dead.
        if (this.ws) {
          this.ws.terminate();
        }
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }

  private cleanup(): void {
    this.stopPing();
    // Reject all pending requests.
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject({ code: 'disconnected' });
    }
    this.pending.clear();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    this.setState('offline');

    const delay = BACKOFF_STEPS[Math.min(this.reconnectAttempt, BACKOFF_STEPS.length - 1)];
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        // Re-auth if we have a stored token.
        if (this.storedToken) {
          try {
            await this.auth(this.storedToken);
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (code === 'not-paired' || code === 'invalid-token') {
              // Token is no longer valid. Clear and enter needs-pairing state.
              this.storedToken = null;
              this.subscribedTopics = [];
              return; // Don't auto-subscribe; caller handles re-pairing.
            }
            throw err;
          }
          // Re-subscribe.
          if (this.subscribedTopics.length > 0) {
            await this.subscribe(this.subscribedTopics);
          }
        }
      } catch {
        // connect() or auth() failed — will schedule another reconnect
        // via the close handler if the WS was opened, or we schedule here
        // if connect() itself failed (no port file, etc.).
        if (!this.reconnectTimer && !this.destroyed) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }
}
