// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect, useCallback } from 'react';

export interface MediaDeviceInfo_ {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
}

export function useMediaDevices() {
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo_[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo_[]>([]);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo_[]>([]);

  const enumerate = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioInputs(devices.filter(d => d.kind === 'audioinput').map(d => ({ deviceId: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0, 4)}`, kind: d.kind })));
      setAudioOutputs(devices.filter(d => d.kind === 'audiooutput').map(d => ({ deviceId: d.deviceId, label: d.label || `Speaker ${d.deviceId.slice(0, 4)}`, kind: d.kind })));
      setVideoInputs(devices.filter(d => d.kind === 'videoinput').map(d => ({ deviceId: d.deviceId, label: d.label || `Camera ${d.deviceId.slice(0, 4)}`, kind: d.kind })));
    } catch {
      // permissions not granted yet — labels will be empty
    }
  }, []);

  useEffect(() => {
    enumerate();
    const handler = () => enumerate();
    navigator.mediaDevices?.addEventListener('devicechange', handler);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', handler);
  }, [enumerate]);

  const requestPermissionsAndEnumerate = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach(t => t.stop());
    } catch {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
      } catch { /* ignore */ }
    }
    await enumerate();
  }, [enumerate]);

  return { audioInputs, audioOutputs, videoInputs, enumerate, requestPermissionsAndEnumerate };
}
