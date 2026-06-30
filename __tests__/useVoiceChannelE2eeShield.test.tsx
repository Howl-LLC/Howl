// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * useVoiceChannel must expose isE2ee/isE2eeFailed so VoiceChannel.tsx
 * can render the same E2EE shield that StageView/DMCallView render. Server
 * voice runs SFrame E2EE unconditionally (e2eeEnabled:true), so the hook's
 * shield flags are derived from the render-seeded SFrame session key:
 *   - key present  → isE2ee true  (green shield)
 *   - in a channel but no key → isE2eeFailed true (amber shield)
 *   - not in a channel → neither (no shield)
 *
 * useCallSession is mocked so this test exercises only the shield derivation,
 * not the LiveKit/socket engine.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Stub the heavy call-session engine: return a minimal session object and
// echo back the e2eeKeyBytes argument so we can assert the hook seeded a key.
const callSessionSpy = vi.fn();
vi.mock('../hooks/useCallSession', () => ({
  useCallSession: (...args: unknown[]) => {
    callSessionSpy(...args);
    return {
      localStream: null,
      remoteParticipants: [],
      leave: () => {},
      error: null,
      disconnectedByInactivity: false,
      enableRemoteScreen: () => {},
      disableRemoteScreen: () => {},
      setE2eeKey: async () => {},
      switchMicDevice: async () => {},
      serverRegion: null,
      startedAt: null,
      getMicSilenceMs: () => 0,
    };
  },
}));

// Control the voice E2EE key store so we can drive the shield states.
const voiceKeyState = {
  key: null as Uint8Array | null,
  channelId: null as string | null,
  generated: null as Uint8Array | null,
};
vi.mock('../services/voiceE2ee', () => ({
  getVoiceKey: () => voiceKeyState.key,
  getVoiceChannelId: () => voiceKeyState.channelId,
  generateVoiceSessionKey: () => voiceKeyState.generated,
  setVoiceKey: (chId: string, k: Uint8Array | null) => {
    voiceKeyState.channelId = chId;
    voiceKeyState.key = k;
  },
  buildOwnSignedJoinBlob: () => null,
}));

import { useVoiceChannel } from '../hooks/useVoiceChannel';
import type { User } from '../types';

const user = { id: 'u1', username: 'alice' } as unknown as User;

describe('useVoiceChannel — E2EE shield flags', () => {
  beforeEach(() => {
    voiceKeyState.key = null;
    voiceKeyState.channelId = null;
    voiceKeyState.generated = null;
    callSessionSpy.mockClear();
  });

  it('not in a channel: no shield (isE2ee=false, isE2eeFailed=false)', () => {
    const { result } = renderHook(() => useVoiceChannel(null, user));
    expect(result.current.isE2ee).toBe(false);
    expect(result.current.isE2eeFailed).toBe(false);
  });

  it('in a channel with a freshly-seeded key: green shield', () => {
    voiceKeyState.generated = new Uint8Array(32).fill(7);
    const { result } = renderHook(() => useVoiceChannel('ch-1', user));
    expect(result.current.isE2ee).toBe(true);
    expect(result.current.isE2eeFailed).toBe(false);
  });

  it('reuses an existing key for the same channel (green shield)', () => {
    voiceKeyState.key = new Uint8Array(32).fill(9);
    voiceKeyState.channelId = 'ch-1';
    // generateVoiceSessionKey must NOT be needed; null here proves reuse.
    voiceKeyState.generated = null;
    const { result } = renderHook(() => useVoiceChannel('ch-1', user));
    expect(result.current.isE2ee).toBe(true);
    expect(result.current.isE2eeFailed).toBe(false);
  });

  it('in a channel but key seeding produced nothing: amber shield', () => {
    // getVoiceKey() null + generateVoiceSessionKey() null → no key bytes.
    voiceKeyState.key = null;
    voiceKeyState.channelId = null;
    voiceKeyState.generated = null;
    const { result } = renderHook(() => useVoiceChannel('ch-1', user));
    expect(result.current.isE2ee).toBe(false);
    expect(result.current.isE2eeFailed).toBe(true);
  });

  it('passes e2eeEnabled=true and the seeded key into useCallSession', () => {
    const seeded = new Uint8Array(32).fill(3);
    voiceKeyState.generated = seeded;
    renderHook(() => useVoiceChannel('ch-1', user));
    expect(callSessionSpy).toHaveBeenCalled();
    const args = callSessionSpy.mock.calls[0];
    // e2eeKeyBytes is the 14th positional arg (index 13) in useCallSession.
    expect(args[13]).toBe(seeded);
    // e2eeEnabled is the 20th positional arg (index 19), always true for voice.
    expect(args[19]).toBe(true);
  });
});
