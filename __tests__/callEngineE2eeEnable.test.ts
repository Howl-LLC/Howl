// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallEngineConfig } from '../services/call/types';

/**
 * setE2EEEnabled: livekit-client never turns SFrame on by itself —
 * Room.setupE2EE() only constructs the E2EEManager, and FrameCryptor
 * encode/decode short-circuit to plaintext passthrough until
 * room.setE2EEEnabled(true) is called. These tests pin that CallEngine
 * enables E2EE on the room exactly once per room, only after a key is in
 * the keyring (enabling with an empty ring drops frames), and never on
 * rooms built without an E2EE config (setE2EEEnabled would throw).
 */

// Shared recorders, hoisted so the livekit-client mock factory can use them.
const h = vi.hoisted(() => {
  const order: string[] = [];
  // Loosely typed on purpose: tests poke FakeRoom internals (handlers, opts).
  const rooms: any[] = [];
  return { order, rooms };
});

vi.mock('livekit-client', () => {
  class FakeExternalE2EEKeyProvider {
    async setKey(_key: ArrayBuffer): Promise<void> {
      h.order.push('install:setKey');
    }
    onSetEncryptionKey(_material: unknown, _participantIdentity?: string, keyIndex?: number): void {
      h.order.push(`install:setKeyAtIndex:${keyIndex}`);
    }
  }
  class FakeRoom {
    opts: unknown;
    name = 'fake-room';
    remoteParticipants = new Map<string, unknown>();
    localParticipant = { identity: 'me', publishTrack: vi.fn(async () => {}) };
    handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    setE2EEEnabled = vi.fn(async (enabled: boolean) => {
      h.order.push(`enable:${enabled}`);
    });
    constructor(opts: unknown) {
      this.opts = opts;
      h.rooms.push(this);
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
      return this;
    }
    async connect(_url: string, _jwt: string): Promise<void> {}
    disconnect(_stop?: boolean): void {}
  }
  return {
    Room: FakeRoom,
    // Every RoomEvent member resolves to its own name so wireRoomEvents'
    // handler registrations land under stable string keys.
    RoomEvent: new Proxy({}, { get: (_t, p) => String(p) }),
    Track: { Source: { Microphone: 'microphone', Camera: 'camera', ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio' } },
    DisconnectReason: { CLIENT_INITIATED: 1, JOIN_FAILURE: 2, DUPLICATE_IDENTITY: 3, PARTICIPANT_REMOVED: 4, ROOM_DELETED: 5, SERVER_SHUTDOWN: 6 },
    ExternalE2EEKeyProvider: FakeExternalE2EEKeyProvider,
    LocalAudioTrack: class {},
  };
});

// jsdom lacks both. start() degrades gracefully without a mic (getUserMedia
// throws → caught → engine continues micless), which is exactly the lean
// path these tests want: connect → key install → enable, no publish.
class FakeWorker {
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}
class FakeMediaStream {
  tracks: unknown[];
  constructor(tracks?: unknown[]) { this.tracks = tracks ?? []; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
  getVideoTracks() { return []; }
}
vi.stubGlobal('Worker', FakeWorker);
vi.stubGlobal('MediaStream', FakeMediaStream);

import { createCallEngine } from '../services/call/CallEngine';

const KEY = new Uint8Array(32).fill(7);

function makeConfig(overrides: Partial<CallEngineConfig> = {}): CallEngineConfig {
  return {
    currentUserId: 'me',
    livekitUrl: 'ws://test:7880',
    getToken: async () => 'jwt',
    onRemoteParticipants: () => {},
    autoOptimizeBluetoothAudio: false,
    ...overrides,
  };
}

function installCount(): number {
  return h.order.filter((e) => e.startsWith('install:')).length;
}

describe('CallEngine SFrame enable (room.setE2EEEnabled)', () => {
  beforeEach(() => {
    h.order.length = 0;
    h.rooms.length = 0;
  });

  it('start() with a pre-resolved key enables E2EE exactly once, after the key install', async () => {
    const engine = await createCallEngine(makeConfig({ e2eeKeyBytes: KEY }));
    await engine.start();
    const room = h.rooms[0];
    expect(room.setE2EEEnabled).toHaveBeenCalledTimes(1);
    expect(room.setE2EEEnabled).toHaveBeenCalledWith(true);
    const installIdx = h.order.indexOf('install:setKey');
    const enableIdx = h.order.indexOf('enable:true');
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(enableIdx).toBeGreaterThan(installIdx);
  });

  it('start() with an MLS epoch-indexed key installs at the slot then enables', async () => {
    const engine = await createCallEngine(makeConfig({ e2eeKeyBytes: KEY, e2eeKeyIndex: 5 }));
    await engine.start();
    const room = h.rooms[0];
    expect(room.setE2EEEnabled).toHaveBeenCalledTimes(1);
    expect(room.setE2EEEnabled).toHaveBeenCalledWith(true);
    const installIdx = h.order.indexOf('install:setKeyAtIndex:5');
    const enableIdx = h.order.indexOf('enable:true');
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(enableIdx).toBeGreaterThan(installIdx);
  });

  it('never calls setE2EEEnabled on a room built without an E2EE config', async () => {
    const engine = await createCallEngine(makeConfig());
    await engine.start();
    const room = h.rooms[0];
    expect((room.opts as { e2ee?: unknown } | undefined)?.e2ee).toBeUndefined();
    expect(room.setE2EEEnabled).not.toHaveBeenCalled();
  });

  it('late key via setE2eeKey (voice/stage late-joiner) enables once, after that install', async () => {
    const engine = await createCallEngine(makeConfig({ e2eeEnabled: true }));
    await engine.start();
    const room = h.rooms[0];
    // No key yet — enabling now would make the encoder drop frames.
    expect(room.setE2EEEnabled).not.toHaveBeenCalled();
    await engine.setE2eeKey(KEY);
    expect(room.setE2EEEnabled).toHaveBeenCalledTimes(1);
    expect(room.setE2EEEnabled).toHaveBeenCalledWith(true);
    expect(h.order.indexOf('enable:true')).toBeGreaterThan(h.order.indexOf('install:setKey'));
    // Key rotation must not re-enable.
    await engine.setE2eeKey(new Uint8Array(32).fill(9));
    expect(room.setE2EEEnabled).toHaveBeenCalledTimes(1);
  });

  it('late MLS resolution via setE2eeKeyAtEpoch enables once; epoch rekeys do not re-enable', async () => {
    const engine = await createCallEngine(makeConfig({ e2eeEnabled: true }));
    await engine.start();
    const room = h.rooms[0];
    expect(room.setE2EEEnabled).not.toHaveBeenCalled();
    await engine.setE2eeKeyAtEpoch(KEY, 7n);
    expect(room.setE2EEEnabled).toHaveBeenCalledTimes(1);
    expect(h.order.indexOf('enable:true')).toBeGreaterThan(h.order.indexOf('install:setKeyAtIndex:7'));
    await engine.setE2eeKeyAtEpoch(new Uint8Array(32).fill(9), 8n);
    expect(room.setE2EEEnabled).toHaveBeenCalledTimes(1);
  });

  it('Reconnected re-injects the key but does not double-enable', async () => {
    const engine = await createCallEngine(makeConfig({ e2eeKeyBytes: KEY }));
    await engine.start();
    const room = h.rooms[0];
    expect(room.setE2EEEnabled).toHaveBeenCalledTimes(1);
    const installsBefore = installCount();
    for (const handler of room.handlers.get('Reconnected') ?? []) handler();
    await vi.waitFor(() => {
      expect(installCount()).toBe(installsBefore + 1);
    });
    expect(room.setE2EEEnabled).toHaveBeenCalledTimes(1);
  });
});
