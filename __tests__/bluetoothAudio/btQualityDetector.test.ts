// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyTier,
  matchesBluetoothLabel,
  detectPlatform,
  probeStream,
  subscribeDeviceChange,
  type BtQualityStatus as _BtQualityStatus,
} from '../../services/audio/btQualityDetector';

describe('btQualityDetector — classifyTier', () => {
  it('returns good for sample rates >= 32 kHz', () => {
    expect(classifyTier({ sampleRate: 48000, label: 'AirPods Pro' })).toBe('good');
    expect(classifyTier({ sampleRate: 32000, label: 'AirPods Pro' })).toBe('good');
    expect(classifyTier({ sampleRate: 44100, label: 'MacBook Air Microphone' })).toBe('good');
  });

  it('returns medium for sample rates exactly 16 kHz (HFP wideband mSBC)', () => {
    expect(classifyTier({ sampleRate: 16000, label: 'AirPods Pro Hands-Free' })).toBe('medium');
  });

  it('returns bad for sample rates <= 8 kHz (HFP narrowband SBC)', () => {
    expect(classifyTier({ sampleRate: 8000, label: 'AirPods Pro Hands-Free' })).toBe('bad');
    expect(classifyTier({ sampleRate: 7000, label: 'Foo' })).toBe('bad');
  });

  it('classifies intermediate rates by proximity: < 20 kHz medium, >= 20 kHz good', () => {
    expect(classifyTier({ sampleRate: 22050, label: 'Foo' })).toBe('good');
    expect(classifyTier({ sampleRate: 24000, label: 'Foo' })).toBe('good');
    expect(classifyTier({ sampleRate: 18000, label: 'Foo' })).toBe('medium');
  });

  it('handles null sample rate: bluetooth label -> medium, other -> good', () => {
    expect(classifyTier({ sampleRate: null, label: 'Bluetooth Headset' })).toBe('medium');
    expect(classifyTier({ sampleRate: null, label: 'Built-in Microphone' })).toBe('good');
    expect(classifyTier({ sampleRate: null, label: '' })).toBe('good');
  });

  it('handles NaN/Infinity/negative sample rate as null', () => {
    expect(classifyTier({ sampleRate: NaN, label: 'Bluetooth' })).toBe('medium');
    expect(classifyTier({ sampleRate: Infinity, label: 'Bluetooth' })).toBe('medium');
    expect(classifyTier({ sampleRate: -1, label: 'Bluetooth' })).toBe('medium');
  });
});

describe('btQualityDetector — matchesBluetoothLabel', () => {
  it('matches common Bluetooth label patterns (Windows)', () => {
    expect(matchesBluetoothLabel('AirPods Pro (Bluetooth Hands-Free)')).toBe(true);
    expect(matchesBluetoothLabel('Sony WH-1000XM5 (Bluetooth Stereo)')).toBe(true);
    expect(matchesBluetoothLabel('Headset Microphone (HFP)')).toBe(true);
    expect(matchesBluetoothLabel('Galaxy Buds (HSP)')).toBe(true);
  });

  it('matches Linux PipeWire labels', () => {
    expect(matchesBluetoothLabel('bluez_output.00_00_00_00_00_00.a2dp-sink')).toBe(true);
    expect(matchesBluetoothLabel('bluez_source.00_00_00_00_00_00.headset-head-unit')).toBe(true);
  });

  it('does not match non-Bluetooth labels', () => {
    expect(matchesBluetoothLabel('MacBook Air Microphone')).toBe(false);
    expect(matchesBluetoothLabel('Blue Yeti')).toBe(false);
    expect(matchesBluetoothLabel('USB Audio')).toBe(false);
    expect(matchesBluetoothLabel('')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(matchesBluetoothLabel('bluetooth')).toBe(true);
    expect(matchesBluetoothLabel('BLUETOOTH')).toBe(true);
    expect(matchesBluetoothLabel('hands-free')).toBe(true);
    expect(matchesBluetoothLabel('HANDS-FREE')).toBe(true);
  });

  it('matches Sony WH/WF model-number labels (real macOS Chrome format)', () => {
    expect(matchesBluetoothLabel('Sony WH-1000XM5')).toBe(true);
    expect(matchesBluetoothLabel('Sony WH-1000XM4')).toBe(true);
    expect(matchesBluetoothLabel('WF-1000XM5')).toBe(true);
  });

  it('matches Bose QC/NC model-number labels', () => {
    expect(matchesBluetoothLabel('Bose QC35')).toBe(true);
    expect(matchesBluetoothLabel('Bose QC45')).toBe(true);
    expect(matchesBluetoothLabel('Bose NC700')).toBe(true);
    expect(matchesBluetoothLabel('Bose QCUltra')).toBe(true);
  });

  it('requires bluez_ underscore+suffix (rejects bare "Bluez")', () => {
    expect(matchesBluetoothLabel('bluez_output.00_00_00_00_00_00.a2dp-sink')).toBe(true);
    expect(matchesBluetoothLabel('bluez_source.00_00.headset-head-unit')).toBe(true);
    expect(matchesBluetoothLabel('bluez_sink.xx')).toBe(true);
    expect(matchesBluetoothLabel('bluez_input.xx')).toBe(true);
    expect(matchesBluetoothLabel('Bluez Laboratories Mic')).toBe(false);
    expect(matchesBluetoothLabel('bluez Microphone')).toBe(false);
  });
});

describe('btQualityDetector — detectPlatform', () => {
  const orig = navigator.userAgent;
  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', { value: orig, configurable: true });
  });

  it('detects windows', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      configurable: true,
    });
    expect(detectPlatform()).toBe('windows');
  });

  it('detects mac', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36',
      configurable: true,
    });
    expect(detectPlatform()).toBe('mac');
  });

  it('detects linux', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      configurable: true,
    });
    expect(detectPlatform()).toBe('linux');
  });

  it('detects android', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36',
      configurable: true,
    });
    expect(detectPlatform()).toBe('android');
  });

  it('detects ios', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      configurable: true,
    });
    expect(detectPlatform()).toBe('ios');
  });

  it('returns unknown for unrecognized UA', () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Foo/1.0', configurable: true });
    expect(detectPlatform()).toBe('unknown');
  });
});

describe('btQualityDetector — probeStream', () => {
  function makeStream(sampleRate: number | undefined, label: string): MediaStream {
    const track = {
      getSettings: () => (sampleRate !== undefined ? { sampleRate } : {}),
      label,
    } as unknown as MediaStreamTrack;
    return {
      getAudioTracks: () => [track],
    } as unknown as MediaStream;
  }

  it('classifies a BT HFP stream as bad, isBluetooth=true', () => {
    const stream = makeStream(8000, 'AirPods Pro Hands-Free');
    const status = probeStream(stream, {
      deviceId: 'abc', label: 'AirPods Pro Hands-Free', kind: 'audioinput', groupId: 'g',
    } as MediaDeviceInfo);
    expect(status?.tier).toBe('bad');
    expect(status?.isBluetooth).toBe(true);
    expect(status?.sampleRate).toBe(8000);
    expect(status?.deviceId).toBe('abc');
    expect(status?.deviceLabel).toBe('AirPods Pro Hands-Free');
  });

  it('classifies a laptop mic as good, isBluetooth=false', () => {
    const stream = makeStream(48000, 'MacBook Air Microphone');
    const status = probeStream(stream, {
      deviceId: 'xyz', label: 'MacBook Air Microphone', kind: 'audioinput', groupId: 'g',
    } as MediaDeviceInfo);
    expect(status?.tier).toBe('good');
    expect(status?.isBluetooth).toBe(false);
  });

  it('classifies LE Audio AirPods (32 kHz) as good with isBluetooth=true', () => {
    const stream = makeStream(32000, 'AirPods Pro');
    const status = probeStream(stream, {
      deviceId: 'q', label: 'AirPods Pro', kind: 'audioinput', groupId: 'g',
    } as MediaDeviceInfo);
    expect(status?.tier).toBe('good');
    expect(status?.isBluetooth).toBe(true);
  });

  it('returns null when stream has no audio tracks', () => {
    const empty = { getAudioTracks: () => [] } as unknown as MediaStream;
    expect(probeStream(empty, null)).toBeNull();
  });
});

describe('btQualityDetector — subscribeDeviceChange', () => {
  let listeners: Array<() => void>;
  const mockMediaDevices = {
    addEventListener: vi.fn((ev: string, cb: () => void) => {
      if (ev === 'devicechange') listeners.push(cb);
    }),
    removeEventListener: vi.fn((ev: string, cb: () => void) => {
      if (ev === 'devicechange') listeners = listeners.filter(l => l !== cb);
    }),
  };

  beforeEach(() => {
    listeners = [];
    Object.defineProperty(navigator, 'mediaDevices', {
      value: mockMediaDevices,
      configurable: true,
    });
  });

  it('invokes the callback when devicechange fires', () => {
    const cb = vi.fn();
    const unsub = subscribeDeviceChange(cb);
    listeners.forEach(l => l());
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('returns an unsubscribe function that stops firing', () => {
    const cb = vi.fn();
    const unsub = subscribeDeviceChange(cb);
    unsub();
    expect(mockMediaDevices.removeEventListener).toHaveBeenCalled();
  });
});
