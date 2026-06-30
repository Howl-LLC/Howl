// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { BridgeClient, type ConnectionState } from '../bridge/client.js';
import { getToken, setToken, clearToken } from '../bridge/token-store.js';
import type { Topic } from '../protocol/types.js';

/**
 * All topics the plugin subscribes to after authentication.
 * Each topic maps to a state pipeline on the bridge side.
 */
const ALL_TOPICS: Topic[] = [
  'state.voice',
  'state.call',
  'state.presence',
  'state.dm-presence',
  'state.unread',
  'state.focused-channel',
  'state.thread-stage',
  'state.e2ee',
  'state.bridge',
];

type TopicListener = (data: unknown, isSnapshot: boolean) => void;

/**
 * Singleton that owns the BridgeClient lifecycle:
 *   init → connect → auth (or pair) → subscribe → dispatch events.
 *
 * Actions import this singleton and call `getState(topic)`,
 * `onChange(topic, cb)`, and `executeAction(action, params)`.
 */
export class Connection {
  private static instance: Connection | null = null;

  private client: BridgeClient;
  private snapshots = new Map<string, unknown>();
  private topicListeners = new Map<string, Set<TopicListener>>();
  private connectionListeners = new Set<(state: ConnectionState) => void>();
  private initPromise: Promise<void> | null = null;

  // True while the user has a pending consent modal in Howl. Actions render
  // an "OPEN HOWL TO PAIR" screen on their key faces while this is true.
  // Cleared when the pair flow resolves (allow / deny / timeout / disconnect).
  private pairPending = false;
  private pairPendingListeners = new Set<(pending: boolean) => void>();

  private constructor(opts: { pluginId: string; displayName: string; version: string }) {
    this.client = new BridgeClient({
      pluginInfo: {
        pluginId: opts.pluginId,
        displayName: opts.displayName,
        version: opts.version,
      },
    });

    // Forward bridge events to per-topic listeners.
    this.client.onEvent((topic, data, isSnapshot) => {
      if (isSnapshot) {
        this.snapshots.set(topic, data);
      } else {
        // Merge delta into snapshot. For simplicity the latest delta
        // replaces the snapshot — individual actions can diff if needed.
        this.snapshots.set(topic, data);
      }
      const listeners = this.topicListeners.get(topic);
      if (listeners) {
        for (const cb of listeners) {
          try { cb(data, isSnapshot); } catch { /* swallow */ }
        }
      }
    });

    // Forward connection state changes.
    this.client.onStateChange((state) => {
      for (const cb of this.connectionListeners) {
        try { cb(state); } catch { /* swallow */ }
      }
    });
  }

  // -- Singleton lifecycle --------------------------------------------------

  /**
   * Initialize the connection singleton. Call once from plugin.ts.
   */
  static init(opts: { pluginId: string; displayName: string; version: string }): void {
    if (Connection.instance) return;
    Connection.instance = new Connection(opts);
    // Kick off connection in the background; don't await — Stream Deck
    // connect() needs to proceed immediately.
    Connection.instance.initPromise = Connection.instance.bootstrap();
  }

  /**
   * Get the singleton. Throws if init() has not been called.
   */
  static get(): Connection {
    if (!Connection.instance) {
      throw new Error('Connection.init() must be called before Connection.get()');
    }
    return Connection.instance;
  }

  // -- Public API -----------------------------------------------------------

  /**
   * Latest snapshot for a topic. Returns undefined if no snapshot received yet.
   */
  getState(topic: Topic): unknown {
    return this.snapshots.get(topic);
  }

  /**
   * Subscribe to changes on a specific topic.
   * Returns an unsubscribe function.
   */
  onChange(topic: Topic, cb: TopicListener): () => void {
    let set = this.topicListeners.get(topic);
    if (!set) {
      set = new Set();
      this.topicListeners.set(topic, set);
    }
    set.add(cb);
    return () => { set!.delete(cb); };
  }

  /**
   * Subscribe to connection state changes.
   */
  onConnectionChange(cb: (state: ConnectionState) => void): () => void {
    this.connectionListeners.add(cb);
    return () => { this.connectionListeners.delete(cb); };
  }

  /**
   * Execute an action on the Howl renderer via the bridge.
   */
  async executeAction(action: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.client.execute(action, params);
  }

  /**
   * List resources (for Property Inspector pickers).
   */
  async listResources(resource: string, params?: Record<string, unknown>): Promise<unknown[]> {
    return this.client.list(resource, params);
  }

  /**
   * Trigger the pairing flow. The user must approve on the Howl side.
   * On success the token is persisted to Elgato global settings.
   *
   * While Howl is showing its consent modal, every Howl key on Stream Deck
   * shows an "OPEN HOWL TO PAIR" screen. The screen clears as soon as the
   * user makes a decision (allow / deny / dismiss).
   */
  async requestPairing(): Promise<void> {
    this.setPairPending(true);
    try {
      const { token } = await this.client.pair();
      await setToken(token);
    } finally {
      this.setPairPending(false);
    }
  }

  /** True while the consent modal is up in Howl. */
  get isPairPending(): boolean {
    return this.pairPending;
  }

  /**
   * Subscribe to pair-pending state changes. Fires immediately with the
   * current value, then on every change. Returns unsubscribe.
   */
  onPairPendingChange(cb: (pending: boolean) => void): () => void {
    this.pairPendingListeners.add(cb);
    try { cb(this.pairPending); } catch { /* swallow */ }
    return () => { this.pairPendingListeners.delete(cb); };
  }

  private setPairPending(pending: boolean): void {
    if (this.pairPending === pending) return;
    this.pairPending = pending;
    for (const cb of this.pairPendingListeners) {
      try { cb(pending); } catch { /* swallow */ }
    }
  }

  /** Current bridge connection state. */
  get connectionState(): ConnectionState {
    return this.client.state;
  }

  // -- Internal -------------------------------------------------------------

  /**
   * Bootstrap flow: connect → auth (or pair) → subscribe.
   */
  private async bootstrap(): Promise<void> {
    try {
      await this.client.connect();
    } catch {
      // Port file not found or connect failed. The BridgeClient will
      // retry via its internal reconnect loop. Nothing else to do here.
      return;
    }

    // Attempt auth with stored token.
    const token = await getToken();
    if (token) {
      try {
        await this.client.auth(token);
        await this.client.subscribe(ALL_TOPICS);
        return; // Fully connected and subscribed.
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'not-paired' || code === 'invalid-token') {
          // Token is stale (Howl reinstalled, or user revoked). Clear it.
          await clearToken();
          // Fall through — auto-request pair below.
        } else {
          // Other errors: let the reconnect loop handle it.
          return;
        }
      }
    }

    // No token, or a previous token was rejected. Auto-request pairing so
    // Howl shows the consent modal immediately — the user doesn't have to
    // hunt for a "pair" button. On success the token persists via Elgato
    // global settings; subsequent reconnects use the auth path above.
    try {
      await this.requestPairing();
      await this.client.subscribe(ALL_TOPICS);
    } catch {
      // Pair denied, timed out, or user dismissed the modal. The bridge
      // client's reconnect loop will re-enter bootstrap() on the next
      // reconnect, giving the user another chance.
    }
  }
}
