// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Volume2, MessageSquare, Crown, Cpu, AlertCircle,
  Upload, Focus, Play, Square,
} from 'lucide-react';
import { socketService } from '../../services/socket';
import { useMicPreviewMeter } from '../../hooks/useMicPreviewMeter';
import { useMediaDevices } from '../../hooks/useMediaDevices';
import { startKeyCapture, formatComboDisplay } from '../../utils/keybindFormat';
import { detectSupportedCodecs, CODEC_LABELS, type ScreenShareCodec } from '../../utils/videoConstraints';
import type { VoiceSettings, NoiseSuppression, OpusSignal, NoiseEngine } from '../../utils/settingsStorage';
import type { PlanTier } from '../../shared/planPerks';
import { getPlanPerks } from '../../shared/planPerks';
import { checkBackgroundSupport } from '../../services/call/videoEffects';
import { checkAutoFrameSupport } from '../../services/call/autoFrameProcessor';
import { COLOR_GRADES, type GradeId } from '../../services/call/colorGradeProcessor';
import { buildProcessedCameraStream } from '../../services/call/buildProcessedCameraStream';
import { useSettings } from '../../contexts/SettingsContext';
import { ToggleRow, Toggle, RadioOption, SliderRow, SelectRow, SettingsSection } from './SettingsWidgets';
import { Dropdown } from '../ui/dropdown';
import { BluetoothQualityBadge } from '../audio/BluetoothQualityBadge';
import {
  matchesBluetoothLabel,
  type QualityTier,
} from '../../services/audio/btQualityDetector';
import { useBluetoothQuality } from '../../hooks/useBluetoothQuality';
import { InCallBluetoothBanner } from '../audio/InCallBluetoothBanner';

const BG_PRESETS = [
  { id: 'gradient-ocean', colors: ['#0c3547', '#204051', '#3a7bd5'], labelKey: 'settings.video.presetOcean' },
  { id: 'gradient-sunset', colors: ['#e65c00', '#f9d423'], labelKey: 'settings.video.presetSunset' },
  { id: 'gradient-aurora', colors: ['#0f2027', '#203a43', '#2c5364'], labelKey: 'settings.video.presetAurora' },
  { id: 'gradient-lavender', colors: ['#7f53ac', '#647dee'], labelKey: 'settings.video.presetLavender' },
  { id: 'gradient-forest', colors: ['#134e5e', '#71b280'], labelKey: 'settings.video.presetForest' },
  { id: 'gradient-midnight', colors: ['#0f0c29', '#302b63', '#24243e'], labelKey: 'settings.video.presetMidnight' },
];

function renderGradientPreset(colors: string[], width = 640, height = 400): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const grad = ctx.createLinearGradient(0, 0, width, height);
  colors.forEach((c, i) => grad.addColorStop(i / (colors.length - 1), c));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

export interface VoiceVideoTabProps {
  voiceSettings?: VoiceSettings;
  onVoiceSettingsChange?: (patch: Partial<VoiceSettings>) => void;
  subscription?: { plan: string | null; status: string | null; currentPeriodEnd: string | null } | null;
}

const DEFAULT_VS: VoiceSettings = {
  selectedMicId: '', selectedSpeakerId: '', selectedCameraId: '',
  micVolume: 100, speakerVolume: 100,
  autoInputSensitivity: true, inputSensitivity: 50,
  noiseSuppression: 'none', echoCancellation: true, autoGainControl: true,
  pushToTalk: false, pushToTalkKey: '',
  showStreamPreviews: true, showAdvancedStream: false,
  soundDeafen: true, soundUndeafen: true, soundMute: true, soundUnmute: true,
  soundConnect: true, soundDisconnect: true, soundboardVolume: 100,
  opusBitrate: 64, opusFec: true, opusDtx: true, opusPacketLoss: 15,
  opusSignal: 'voice', opusStereo: false,
  inputProfile: 'isolation',
  screenShareCodec: 'auto', forceSwEncoding: false,
  videoBackgroundMode: 'off', videoBackgroundBlurRadius: 10, videoBackgroundImageUrl: '',
  videoColorGradeEnabled: false, videoColorGrade: 'none',
  autoFrameMode: 'off', autoFrameZoom: 1.3, autoFrameZoomAuto: false,
  cameraPreviewModal: true,
  muteHowlAudioWhileSharing: true,
  // Placeholder default — real default lives in settingsStorage DEFAULTS_V
  // and is plumbed in via props.
  noiseEngine: 'dfn3-light',
  notifyOnNoMicAudio: true,
};

export default function VoiceVideoTab({ voiceSettings, onVoiceSettingsChange, subscription }: VoiceVideoTabProps) {
  const { t } = useTranslation();

  const vs = voiceSettings ?? DEFAULT_VS;
  const isCustomProfile = vs.inputProfile === 'custom';
  const isIsolation = vs.inputProfile === 'isolation';
  const isStudio = vs.inputProfile === 'studio';
  const setVS = (patch: Partial<VoiceSettings>) => onVoiceSettingsChange?.(patch);

  const { audioInputs, audioOutputs, videoInputs, requestPermissionsAndEnumerate } = useMediaDevices();

  const { status: liveQuality } = useBluetoothQuality();

  const {
    bluetoothAudioSettings,
    updateBluetoothAudioSettings,
    btDevicePreferences,
    removeBtDevicePreferenceByLabel,
    clearAllBtDevicePreferences,
  } = useSettings();

  // Derive a tier for each enumerated input device. We can only guess via label
  // heuristic here — live sample-rate data is available only for the active mic
  // and is overlaid below.
  const deviceTierMap = useMemo(() => {
    const map = new Map<string, { tier: QualityTier; isHd: boolean }>();
    for (const d of audioInputs) {
      const bt = matchesBluetoothLabel(d.label);
      map.set(d.deviceId, { tier: bt ? 'medium' : 'good', isHd: false });
    }
    // Overlay the live-measured tier for the active device, if known.
    if (liveQuality) {
      map.set(liveQuality.deviceId, {
        tier: liveQuality.tier,
        isHd: liveQuality.isBluetooth && liveQuality.tier === 'good',
      });
    }
    return map;
  }, [audioInputs, liveQuality]);

  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  // True while the test-camera preview is requested. The effect below handles
  // the full getUserMedia + buildProcessedCameraStream lifecycle — same
  // pattern as CameraPreviewModal.tsx which works reliably.
  const [testVideoActive, setTestVideoActive] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [micTestActive, setMicTestActive] = useState(false);
  const [isDraggingSensitivity, setIsDraggingSensitivity] = useState(false);
  const [pttCapturing, setPttCapturing] = useState(false);
  const pttCaptureStopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { pttCaptureStopRef.current?.(); }, []);
  const beginPttCapture = useCallback(() => {
    setPttCapturing(true);
    pttCaptureStopRef.current?.();
    pttCaptureStopRef.current = startKeyCapture({
      onCapture: (combo) => {
        pttCaptureStopRef.current = null;
        setPttCapturing(false);
        setVS({ pushToTalkKey: combo });
      },
      onCancel: () => { pttCaptureStopRef.current = null; setPttCapturing(false); },
      onClear: () => {
        pttCaptureStopRef.current = null;
        setPttCapturing(false);
        setVS({ pushToTalkKey: '' });
      },
    });
  }, []);
  const cancelPttCapture = useCallback(() => {
    pttCaptureStopRef.current?.();
    pttCaptureStopRef.current = null;
    setPttCapturing(false);
  }, []);
  const formatPttKey = (keys: string): string => {
    const tokens = formatComboDisplay(keys);
    return tokens.length > 0 ? tokens.join(' + ') : '';
  };
  const [socketConnected, setSocketConnected] = useState(socketService.isConnected());
  const [gpuInfo, setGpuInfo] = useState<{ vendor: string; name: string } | null>(null);
  const [supportedCodecs, setSupportedCodecs] = useState<ScreenShareCodec[]>([]);
  const [bgSupported, setBgSupported] = useState(true);
  const [afSupported, setAfSupported] = useState(true);
  const [presetCache] = useState(() => new Map<string, string>());

  const videoRef = useRef<HTMLVideoElement>(null);
  // Raw getUserMedia output + processor cleanup tracked separately so we can
  // stop the camera device AND release the canvas/WASM resources when the
  // preview is turned off. Mirrors the CameraPreviewModal pattern.
  const rawVideoStreamRef = useRef<MediaStream | null>(null);
  const videoEffectCleanupRef = useRef<(() => void) | null>(null);
  const meter = useMicPreviewMeter(micStream, {
    noiseEngine: vs.noiseEngine,
    noiseSuppression: vs.noiseSuppression,
    autoInputSensitivity: vs.autoInputSensitivity,
    inputSensitivity: vs.inputSensitivity,
  });
  const micLoopbackRef = useRef<{ ctx: AudioContext; gain: GainNode; cleanup: () => void } | null>(null);
  const mergedBarRef = useRef<HTMLDivElement>(null);

  // Test camera preview — effect-based (same shape as CameraPreviewModal).
  // Runs when the user clicks Test Video and whenever an effect setting
  // changes so the preview stays live as the user tweaks.
  useEffect(() => {
    if (!testVideoActive) return;
    let cancelled = false;
    (async () => {
      try {
        setMediaError(null);
        const constraints: MediaStreamConstraints = {
          video: vs.selectedCameraId ? { deviceId: { exact: vs.selectedCameraId } } : true,
        };
        const raw = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) {
          raw.getTracks().forEach((t) => t.stop());
          return;
        }
        // Release any prior pipeline (device swap / setting change case).
        videoEffectCleanupRef.current?.();
        videoEffectCleanupRef.current = null;
        rawVideoStreamRef.current?.getTracks().forEach((t) => t.stop());
        rawVideoStreamRef.current = raw;

        const { stream: processed, cleanup } = await buildProcessedCameraStream(raw, {
          autoFrameMode: vs.autoFrameMode,
          autoFrameZoom: vs.autoFrameZoom,
          autoFrameZoomAuto: vs.autoFrameZoomAuto,
          videoColorGradeEnabled: vs.videoColorGradeEnabled,
          videoColorGrade: vs.videoColorGrade,
          videoBackgroundMode: vs.videoBackgroundMode,
          videoBackgroundBlurRadius: vs.videoBackgroundBlurRadius,
          videoBackgroundImageUrl: vs.videoBackgroundImageUrl,
        });
        if (cancelled) {
          cleanup();
          raw.getTracks().forEach((t) => t.stop());
          return;
        }
        videoEffectCleanupRef.current = cleanup;
        setVideoStream((prev) => {
          prev?.getTracks().forEach((t) => t.stop());
          return processed;
        });
        requestPermissionsAndEnumerate();
      } catch (e) {
        if (cancelled) return;
        videoEffectCleanupRef.current?.();
        videoEffectCleanupRef.current = null;
        rawVideoStreamRef.current?.getTracks().forEach((t) => t.stop());
        rawVideoStreamRef.current = null;
        setMediaError(e instanceof Error ? e.message : t('settings.voice.cameraAccessDenied'));
        setTestVideoActive(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    testVideoActive,
    vs.selectedCameraId,
    vs.autoFrameMode,
    vs.autoFrameZoom,
    vs.autoFrameZoomAuto,
    vs.videoColorGradeEnabled,
    vs.videoColorGrade,
    vs.videoBackgroundMode,
    vs.videoBackgroundBlurRadius,
    vs.videoBackgroundImageUrl,
    requestPermissionsAndEnumerate,
    t,
  ]);

  // When the preview turns off, release everything.
  useEffect(() => {
    if (testVideoActive) return;
    videoEffectCleanupRef.current?.();
    videoEffectCleanupRef.current = null;
    rawVideoStreamRef.current?.getTracks().forEach((t) => t.stop());
    rawVideoStreamRef.current = null;
    setVideoStream((prev) => {
      prev?.getTracks().forEach((t) => t.stop());
      return null;
    });
  }, [testVideoActive]);

  // Mic loopback for "Let's Check" test
  useEffect(() => {
    if (!micTestActive || !micStream) {
      if (micLoopbackRef.current) {
        micLoopbackRef.current.cleanup();
        micLoopbackRef.current = null;
      }
      return;
    }
    if (micStream.getAudioTracks().length === 0) return;
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(micStream);
      const delay = ctx.createDelay(2.0);
      delay.delayTime.value = 1.5;
      const gain = ctx.createGain();
      gain.gain.value = (voiceSettings?.micVolume ?? 100) / 100;
      source.connect(delay);
      delay.connect(gain);
      gain.connect(ctx.destination);

      const cleanup = () => {
        try {
          source.disconnect();
          delay.disconnect();
          gain.disconnect();
          ctx.close().catch(() => {});
        } catch { /* already closed */ }
      };
      micLoopbackRef.current = { ctx, gain, cleanup };
    } catch { /* Web Audio not available */ }
    return () => {
      if (micLoopbackRef.current) {
        micLoopbackRef.current.cleanup();
        micLoopbackRef.current = null;
      }
    };
  }, [micStream, micTestActive]);

  useEffect(() => {
    if (micLoopbackRef.current) {
      micLoopbackRef.current.gain.gain.value = (voiceSettings?.micVolume ?? 100) / 100;
    }
  }, [voiceSettings?.micVolume]);

  // Assign video stream to <video> element
  useEffect(() => {
    if (videoStream && videoRef.current) videoRef.current.srcObject = videoStream;
  }, [videoStream]);

  // Poll socket connection status
  useEffect(() => {
    const timer = setInterval(() => setSocketConnected(socketService.isConnected()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Capture mic when "Let's Check" is active OR the manual sensitivity bar is visible
  const needsMicCapture = micTestActive || (!vs.autoInputSensitivity && isCustomProfile);

  useEffect(() => {
    if (!needsMicCapture) {
      setMicStream(prev => { prev?.getTracks().forEach(tr => tr.stop()); return null; });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const audioConstraint: MediaTrackConstraints = {
          ...(vs.selectedMicId ? { deviceId: { exact: vs.selectedMicId } } : {}),
          noiseSuppression: vs.noiseSuppression !== 'none',
          echoCancellation: vs.echoCancellation,
        };
        const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
        if (!cancelled) {
          setMicStream(prev => { prev?.getTracks().forEach(tr => tr.stop()); return s; });
          requestPermissionsAndEnumerate();
        } else {
          s.getTracks().forEach(tr => tr.stop());
        }
      } catch (e) {
        if (!cancelled) setMediaError(e instanceof Error ? e.message : t('settings.voice.micAccessDenied'));
      }
    })();
    return () => { cancelled = true; };
  }, [needsMicCapture, vs.selectedMicId]);

  const stopMicTest = useCallback(() => {
    setMicTestActive(false);
    // Only stop mic if the sensitivity bar doesn't also need it
    if (vs.autoInputSensitivity || !isCustomProfile) {
      setMicStream(prev => { prev?.getTracks().forEach(tr => tr.stop()); return null; });
    }
  }, [vs.autoInputSensitivity, isCustomProfile]);

  // Full cleanup on unmount
  useEffect(() => {
    return () => {
      micStream?.getTracks().forEach((track) => track.stop());
      videoStream?.getTracks().forEach((track) => track.stop());
      if (micLoopbackRef.current) {
        micLoopbackRef.current.cleanup();
        micLoopbackRef.current = null;
      }
    };
  }, [micStream, videoStream]);

  // Release the video-effect pipeline + raw camera on unmount only. The
  // `testVideoActive`-toggle-off effect above handles the normal stop case,
  // but if the user navigates away from Settings while the preview is still
  // active, that effect never runs — the raw getUserMedia track would leak
  // and keep the OS camera indicator on. Empty deps so this only fires on
  // real unmount (not on every stream change, which would prematurely stop
  // the NEW raw that the main effect just assigned to the ref).
  useEffect(() => {
    return () => {
      videoEffectCleanupRef.current?.();
      videoEffectCleanupRef.current = null;
      rawVideoStreamRef.current?.getTracks().forEach((t) => t.stop());
      rawVideoStreamRef.current = null;
    };
  }, []);

  // Detect GPU & codec support
  useEffect(() => {
    setSupportedCodecs(detectSupportedCodecs());
    if (window.electron?.getGPUInfo) {
      window.electron.getGPUInfo().then(info => setGpuInfo(info)).catch(() => {});
    }
  }, []);

  // Check background & auto-frame support
  useEffect(() => {
    checkBackgroundSupport().then(setBgSupported);
    setAfSupported(checkAutoFrameSupport());
  }, []);

  const plan = (subscription?.plan as PlanTier) ?? null;
  const perks = getPlanPerks(plan);

  // Merged sensitivity bar: drag handlers
  const updateSensitivityFromMouse = useCallback((clientX: number) => {
    if (!mergedBarRef.current) return;
    const rect = mergedBarRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, Math.round(((clientX - rect.left) / rect.width) * 100)));
    onVoiceSettingsChange?.({ inputSensitivity: pct });
  }, [onVoiceSettingsChange]);

  const handleBarMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingSensitivity(true);
    updateSensitivityFromMouse(e.clientX);
  }, [updateSensitivityFromMouse]);

  useEffect(() => {
    if (!isDraggingSensitivity) return;
    const onMove = (e: MouseEvent) => updateSensitivityFromMouse(e.clientX);
    const onUp = () => setIsDraggingSensitivity(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [isDraggingSensitivity, updateSensitivityFromMouse]);

  const [previewingSoundKey, setPreviewingSoundKey] = useState<string | null>(null);
  const previewSoundCtxRef = useRef<AudioContext | null>(null);
  const previewSoundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopSoundPreview = useCallback(() => {
    if (previewSoundCtxRef.current) {
      previewSoundCtxRef.current.close().catch(() => {});
      previewSoundCtxRef.current = null;
    }
    if (previewSoundTimerRef.current) {
      clearTimeout(previewSoundTimerRef.current);
      previewSoundTimerRef.current = null;
    }
    setPreviewingSoundKey(null);
  }, []);

  useEffect(() => () => stopSoundPreview(), [stopSoundPreview]);

  const togglePreviewSound = useCallback((key: 'soundDeafen' | 'soundUndeafen' | 'soundMute' | 'soundUnmute' | 'soundConnect' | 'soundDisconnect') => {
    if (previewingSoundKey === key) {
      stopSoundPreview();
      return;
    }
    stopSoundPreview();
    try {
      const ctx = new AudioContext();
      previewSoundCtxRef.current = ctx;
      setPreviewingSoundKey(key);
      const master = ctx.createGain();
      master.connect(ctx.destination);
      const n = (freq: number, start: number, dur: number, vol: number) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.frequency.value = freq;
        g.gain.setValueAtTime(vol, ctx.currentTime + start);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
        o.connect(g).connect(master); o.start(ctx.currentTime + start); o.stop(ctx.currentTime + start + dur);
      };
      if (key === 'soundMute')         { n(600, 0, 0.08, 0.25); n(400, 0.07, 0.10, 0.20); }
      else if (key === 'soundUnmute')   { n(400, 0, 0.08, 0.25); n(700, 0.07, 0.10, 0.20); }
      else if (key === 'soundDeafen')   { n(500, 0, 0.08, 0.28); n(350, 0.07, 0.08, 0.24); n(200, 0.14, 0.12, 0.20); }
      else if (key === 'soundUndeafen') { n(350, 0, 0.08, 0.28); n(550, 0.07, 0.08, 0.24); n(800, 0.14, 0.12, 0.20); }
      else if (key === 'soundConnect')    { n(330, 0, 0.08, 0.22); n(440, 0.08, 0.08, 0.25); n(660, 0.16, 0.12, 0.28); }
      else if (key === 'soundDisconnect') { n(550, 0, 0.08, 0.22); n(400, 0.08, 0.10, 0.20); n(280, 0.16, 0.12, 0.15); }
      previewSoundTimerRef.current = setTimeout(() => {
        if (previewSoundCtxRef.current === ctx) {
          ctx.close().catch(() => {});
          previewSoundCtxRef.current = null;
        }
        setPreviewingSoundKey((p) => (p === key ? null : p));
        previewSoundTimerRef.current = null;
      }, 400);
    } catch (err) {
      console.error('Failed to preview sound', err);
      previewSoundCtxRef.current = null;
      setPreviewingSoundKey(null);
    }
  }, [previewingSoundKey, stopSoundPreview]);

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-xl font-black uppercase tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>{t('settings.voiceVideo')}</h2>
      <p className="text-xs mb-8" style={{ color: 'var(--text-secondary)' }}>{t('settings.tuneMicCamera')}</p>

      {mediaError && (
        <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">{mediaError}</div>
      )}

      {/* Voice section — device selection + volume */}
      <div className="border border-default rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
        <h3 className="font-black text-xs uppercase tracking-wider mb-5" style={{ color: 'var(--text-primary)' }}>{t('settings.voice.voice')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-5">
          <div id="setting-selected-microphone">
            <p className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--text-secondary)' }}>{t('settings.microphone')}</p>
            <Dropdown
              options={[{ value: '', label: t('settings.default') }, ...audioInputs.map(d => {
                const info = deviceTierMap.get(d.deviceId);
                return {
                  value: d.deviceId,
                  label: d.label,
                  ...(info && matchesBluetoothLabel(d.label)
                    ? { icon: <BluetoothQualityBadge tier={info.tier} isHdBluetooth={info.isHd} /> }
                    : {}),
                };
              })]}
              value={vs.selectedMicId}
              onChange={v => setVS({ selectedMicId: v })}
              renderOption={(opt) => {
                const info = deviceTierMap.get(opt.value);
                const isBt = opt.value !== '' && matchesBluetoothLabel(opt.label);
                return (
                  <span className="flex items-center gap-2 truncate">
                    {isBt && info && <BluetoothQualityBadge tier={info.tier} isHdBluetooth={info.isHd} />}
                    <span className="truncate">{opt.label}</span>
                  </span>
                );
              }}
              size="sm"
              className="w-full"
            />
            {liveQuality?.tier === 'bad' && (
              <div className="pt-2">
                <InCallBluetoothBanner
                  onRequestMicSwitch={async (newId) => {
                    setVS({ selectedMicId: newId });
                  }}
                />
              </div>
            )}
          </div>
          <div id="setting-selected-speaker">
            <p className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--text-secondary)' }}>{t('settings.speaker')}</p>
            <Dropdown
              options={[{ value: '', label: t('settings.default') }, ...audioOutputs.map(d => ({ value: d.deviceId, label: d.label }))]}
              value={vs.selectedSpeakerId}
              onChange={v => setVS({ selectedSpeakerId: v })}
              size="sm"
              className="w-full"
            />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-5">
          <div id="setting-microphone-volume"><SliderRow label={t('settings.microphoneVolume')} value={vs.micVolume} min={0} max={200} step={1} unit="%" onChange={v => setVS({ micVolume: v })} /></div>
          <div id="setting-speaker-volume"><SliderRow label={t('settings.speakerVolume')} value={vs.speakerVolume} min={0} max={200} step={1} unit="%" onChange={v => setVS({ speakerVolume: v })} /></div>
        </div>
        <div id="setting-mic-test" className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2.5 rounded-full bg-fill-active overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${micTestActive ? Math.min(100, meter.level) : 0}%`, background: 'linear-gradient(to right, #059669, #34d399)', opacity: micTestActive && meter.level > 2 ? 1 : 0.3, transition: 'width 16ms linear' }} />
            </div>
            {!micTestActive ? (
              <button type="button" onClick={() => setMicTestActive(true)}
                className="btn-cta text-[10px] font-black uppercase tracking-widest px-4 py-2 rounded-xl transition-all shrink-0">
                {t('settings.voice.letsCheck')}
              </button>
            ) : (
              <button type="button" onClick={stopMicTest}
                className="text-[10px] font-black uppercase tracking-widest bg-fill-active px-4 py-2 rounded-xl hover:bg-fill-stronger transition-all shrink-0" style={{ color: 'var(--text-primary)' }}>
                {t('settings.voice.stopTest')}
              </button>
            )}
          </div>
          {micTestActive && (
            <div className="flex items-center gap-2">
              <Volume2 size={12} className="text-emerald-400 animate-pulse shrink-0" />
              <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>{t('settings.listening')}</p>
            </div>
          )}
        </div>
        <p className="text-[10px] mt-3" style={{ color: 'var(--text-secondary)' }}>{micTestActive ? t('settings.listening') : t('settings.voice.inputLevelHint')}</p>
      </div>

      {/* Input Profile */}
      <div id="setting-input-profile" className="border border-default rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
        <h3 className="font-black text-xs uppercase tracking-wider mb-4" style={{ color: 'var(--text-primary)' }}>{t('settings.inputProfile')}</h3>
        <RadioOption label={t('settings.voiceIsolation')} description={t('settings.voiceIsolationDesc')} value="isolation" selected={isIsolation} onChange={() => setVS({ inputProfile: 'isolation', noiseSuppression: 'none', noiseEngine: 'dfn3-light', echoCancellation: true, autoGainControl: true, autoInputSensitivity: true, opusBitrate: 64, opusFec: true, opusDtx: true, opusPacketLoss: 15, opusSignal: 'voice', opusStereo: false })} />
        <RadioOption label={t('settings.studio')} description={t('settings.studioDesc')} value="studio" selected={isStudio} onChange={() => setVS({ inputProfile: 'studio', noiseSuppression: 'none', noiseEngine: 'off', echoCancellation: false, autoGainControl: false, autoInputSensitivity: true, pushToTalk: false, opusBitrate: 64, opusFec: false, opusDtx: false, opusPacketLoss: 0, opusSignal: 'music', opusStereo: true })} />
        <RadioOption label={t('settings.customProfile')} description={t('settings.customProfileDesc')} value="custom" selected={isCustomProfile} onChange={() => setVS({ inputProfile: 'custom', noiseSuppression: 'medium', noiseEngine: 'off', echoCancellation: true, autoGainControl: true, autoInputSensitivity: true, opusBitrate: 64, opusFec: true, opusDtx: false, opusPacketLoss: 15, opusSignal: 'voice', opusStereo: false })} />

        {/* Voice Isolation: only Push to Talk */}
        {isIsolation && (
          <div className="mt-5">
            <div id="setting-push-to-talk"><ToggleRow label={t('settings.pushToTalk')} description={t('settings.pushToTalkDesc')} checked={vs.pushToTalk} onChange={v => {
              setVS({ pushToTalk: v });
              if (v && !vs.pushToTalkKey) setPttCapturing(true);
            }} /></div>
            {vs.pushToTalk && (
              <div id="setting-push-to-talk-key" className="ml-1 mt-1 mb-2">
                <p className="text-[10px] font-bold uppercase tracking-widest mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('settings.pushToTalkKey')}</p>
                {pttCapturing ? (
                  <button type="button"
                    onClick={cancelPttCapture}
                    title={t('settings.shortcutCancel', { defaultValue: 'Cancel (Esc) · Backspace to clear' })}
                    className="px-3 py-2 rounded-xl border-2 border-[var(--cyan-accent)] text-sm animate-pulse max-w-xs cursor-pointer"
                    style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-primary)' }}
                  >{t('settings.pressAKey')}</button>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="px-3 py-2 rounded-xl text-sm border border-[var(--glass-border)]" style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-primary)' }}>
                      {formatPttKey(vs.pushToTalkKey) || t('settings.voice.noneSet')}
                    </span>
                    <button type="button" onClick={beginPttCapture}
                      className="btn-secondary px-3 py-2 text-xs">
                      {vs.pushToTalkKey ? t('settings.change') : t('settings.setKey')}
                    </button>
                  </div>
                )}
                {!vs.pushToTalkKey && (
                  <p className="text-xs mt-1 text-amber-400">{t('settings.mustSetPTTKey')}</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Studio: no options shown (always-on, no processing) */}
        {isStudio && (
          <p className="mt-4 text-xs" style={{ color: 'var(--text-secondary)' }}>{t('settings.voice.studioInfo')}</p>
        )}

        {/* Custom: full controls */}
        {isCustomProfile && (
          <>
            <div className="mt-5">
              <div id="setting-auto-adjust-sensitivity"><ToggleRow label={t('settings.autoAdjustSensitivity')} description={t('settings.autoAdjustDesc')} checked={vs.autoInputSensitivity} onChange={v => setVS({ autoInputSensitivity: v })} /></div>
              {!vs.autoInputSensitivity ? (
                <div id="setting-input-sensitivity" className="mt-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-secondary)' }}>
                      {t('settings.inputSensitivity')}
                    </p>
                    <span className="text-xs font-semibold tabular-nums text-[var(--cyan-accent)]">
                      {vs.inputSensitivity}%
                    </span>
                  </div>
                  <div
                    className="relative h-3 rounded-full cursor-pointer select-none"
                    style={{ backgroundColor: 'var(--fill-active)' }}
                    ref={mergedBarRef}
                    onMouseDown={handleBarMouseDown}
                  >
                    <div
                      className="absolute inset-y-0 left-0 rounded-l-full pointer-events-none"
                      style={{ width: `${vs.inputSensitivity}%`, background: 'linear-gradient(to right, #b45309, #f59e0b)' }}
                    />
                    <div
                      className="absolute inset-y-0 rounded-r-full pointer-events-none"
                      style={{ left: `${vs.inputSensitivity}%`, right: 0, background: 'linear-gradient(to right, #059669, #34d399)' }}
                    />
                    <div
                      className="absolute inset-y-0 left-0 rounded-full pointer-events-none"
                      style={{ width: `${Math.min(100, meter.level)}%`, background: 'rgba(0, 0, 0, 0.6)', transition: 'width 16ms linear' }}
                    />
                    <div
                      className="absolute w-4 h-4 rounded-full pointer-events-none"
                      style={{ left: `${vs.inputSensitivity}%`, top: '50%', transform: 'translate(-50%, -50%)', background: 'white', boxShadow: '0 0 0 1px rgba(0,0,0,0.2), 0 2px 6px rgba(0,0,0,0.3)' }}
                    />
                  </div>
                  <p className="text-[10px] mt-1.5" style={{ color: 'var(--text-secondary)', opacity: 0.7 }}>{t('settings.voice.thresholdHint')}</p>
                </div>
              ) : (
                <div className="mt-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--text-secondary)' }}>{t('settings.voice.inputLevel')}</p>
                  <div className="relative h-3 rounded-full overflow-visible" style={{ backgroundColor: 'var(--fill-active)' }}>
                    <div
                      className="absolute inset-y-0 left-0 rounded-full"
                      style={{
                        width: `${micTestActive ? Math.min(100, meter.level) : 0}%`,
                        background: meter.gateOpen ? 'linear-gradient(to right, #059669, #34d399)' : 'var(--fill-stronger)',
                        transition: 'width 16ms linear, background 150ms ease',
                        opacity: micTestActive && meter.level > 2 ? 1 : 0.3,
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div id="setting-noise-suppression"><SelectRow
              label={t('settings.noiseSuppression')}
              description={vs.noiseEngine !== 'off' ? t('settings.noiseSuppressionDisabledHint', 'Disabled — handled by Advanced Noise Suppression below') : undefined}
              disabled={vs.noiseEngine !== 'off'}
              value={vs.noiseSuppression}
              options={[
                { value: 'none', label: t('common.none') },
                { value: 'low', label: t('settings.low') },
                { value: 'medium', label: t('settings.medium') },
                { value: 'high', label: t('settings.high') },
              ]}
              onChange={v => setVS({ noiseSuppression: v as NoiseSuppression })}
            /></div>

            <div id="setting-advanced-noise-suppression"><SelectRow
              label={t('settings.advancedNoiseSuppression', 'Advanced Noise Suppression')}
              description={t('settings.advancedNoiseSuppressionDesc', 'AI-powered background noise removal.')}
              value={vs.noiseEngine}
              options={[
                { value: 'dfn3-max', label: t('settings.noiseEngine.dfn3Max', 'DFN3 Max') },
                { value: 'dfn3-light', label: t('settings.noiseEngine.dfn3Light', 'DFN3 Light') },
                { value: 'rnnoise', label: t('settings.noiseEngine.rnnoise', 'RNNoise') },
                { value: 'off', label: t('common.off', 'Off') },
              ]}
              onChange={v => setVS({ noiseEngine: v as NoiseEngine })}
            /></div>

            <div id="setting-echo-cancellation"><ToggleRow label={t('settings.echoCancellation')} description={t('settings.echoCancellationDesc')} checked={vs.echoCancellation} onChange={v => setVS({ echoCancellation: v })} /></div>
            <div id="setting-auto-gain-control"><ToggleRow label={t('settings.autoGainControl', 'Auto Gain Control')} description={t('settings.autoGainControlDesc', 'Automatically adjusts your mic volume to maintain a consistent level')} checked={vs.autoGainControl ?? true} onChange={v => setVS({ autoGainControl: v })} /></div>
            <ToggleRow label={t('settings.pushToTalk')} description={t('settings.pushToTalkDesc')} checked={vs.pushToTalk} onChange={v => {
              setVS({ pushToTalk: v });
              if (v && !vs.pushToTalkKey) setPttCapturing(true);
            }} />
            {vs.pushToTalk && (
              <div className="ml-1 mt-1 mb-2">
                <p className="text-[10px] font-bold uppercase tracking-widest mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('settings.pushToTalkKey')}</p>
                {pttCapturing ? (
                  <button type="button"
                    onClick={cancelPttCapture}
                    title={t('settings.shortcutCancel', { defaultValue: 'Cancel (Esc) · Backspace to clear' })}
                    className="px-3 py-2 rounded-xl border-2 border-[var(--cyan-accent)] text-sm animate-pulse max-w-xs cursor-pointer"
                    style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-primary)' }}
                  >{t('settings.pressAKey')}</button>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="px-3 py-2 rounded-xl text-sm border border-[var(--glass-border)]" style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-primary)' }}>
                      {formatPttKey(vs.pushToTalkKey) || t('settings.voice.noneSet')}
                    </span>
                    <button type="button" onClick={beginPttCapture}
                      className="btn-secondary px-3 py-2 text-xs">
                      {vs.pushToTalkKey ? t('settings.change') : t('settings.setKey')}
                    </button>
                  </div>
                )}
                {!vs.pushToTalkKey && (
                  <p className="text-xs mt-1 text-amber-400">{t('settings.mustSetPTTKey')}</p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Input Level — always visible regardless of profile, only active when testing */}
      {!isCustomProfile && (
        <div className="border border-default rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
          <h3 className="font-black text-xs uppercase tracking-wider mb-4" style={{ color: 'var(--text-primary)' }}>{t('settings.voice.inputLevel')}</h3>
          <div className="relative h-3 rounded-full overflow-visible" style={{ backgroundColor: 'var(--fill-active)' }}>
            <div
              className="absolute inset-y-0 left-0 rounded-full"
              style={{
                width: `${micTestActive ? Math.min(100, meter.level) : 0}%`,
                background: 'linear-gradient(to right, #059669, #34d399)',
                transition: 'width 16ms linear',
                opacity: micTestActive && meter.level > 2 ? 1 : 0.3,
              }}
            />
          </div>
          <p className="text-[10px] mt-2" style={{ color: 'var(--text-secondary)' }}>{micTestActive ? t('settings.listening') : t('settings.voice.speakToSeeLevel')}</p>
        </div>
      )}

      {/* Audio Codec — the bitrate slider is shown in every profile so
          users can tune transmit quality even when on a preset profile.
          The advanced codec knobs (FEC / DTX / packet loss / signal /
          stereo) stay locked to Custom because they encode the profile's
          intent (Studio = music-stereo, Isolation = voice-mono-DTX). */}
      <div className="border border-default rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
        <h3 className="font-black text-xs uppercase tracking-wider mb-4" style={{ color: 'var(--text-primary)' }}>{t('settings.voice.audioCodec')}</h3>
        {(() => {
          const plan = subscription?.plan as PlanTier ?? null;
          const maxBitrate = plan === 'pro' ? 384 : plan === 'essential' ? 128 : 96;
          const nextTierLabel = plan === 'essential' ? t('settings.voice.upgradeProBitrate') : t('settings.voice.upgradeEssentialBitrate');
          return (
            <div id="setting-opus-bitrate">
              <SliderRow label={t('settings.opusBitrate')} value={Math.min(vs.opusBitrate, maxBitrate)} min={6} max={maxBitrate} step={1} unit=" kbps" onChange={v => setVS({ opusBitrate: v })} />
              {plan !== 'pro' && (
                <div className="mt-1 mb-3">
                  <div className="pro-shimmer-badge inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--cyan-accent)]/30 text-[10px] font-bold" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 12%, transparent)', color: 'var(--text-secondary)' }}>
                    <Crown size={10} className="text-[var(--cyan-accent)] shrink-0" />
                    <span>{t('settings.voice.maxBitrateOnPlan', { bitrate: maxBitrate })} {nextTierLabel}</span>
                  </div>
                </div>
              )}
            </div>
          );
        })()}
        {isCustomProfile && (
          <>
            <div id="setting-forward-error-correction"><ToggleRow label={t('settings.forwardErrorCorrection')} description={t('settings.voice.fecDesc')} checked={vs.opusFec} onChange={v => setVS({ opusFec: v })} /></div>
            <div id="setting-discontinuous-transmission"><ToggleRow label={t('settings.discontinuousTransmission')} description={t('settings.voice.dtxDesc')} checked={vs.opusDtx} onChange={v => setVS({ opusDtx: v })} /></div>
            <div id="setting-expected-packet-loss"><SliderRow label={t('settings.expectedPacketLoss')} value={vs.opusPacketLoss} min={0} max={30} step={1} unit="%" onChange={v => setVS({ opusPacketLoss: v })} /></div>
            <div id="setting-opus-signal-mode"><SelectRow label={t('settings.opusSignalMode')} value={vs.opusSignal} options={[
              { value: 'auto', label: t('settings.autoRecommended') },
              { value: 'voice', label: t('settings.voiceOptimized') },
              { value: 'music', label: t('settings.musicHigherFidelity') },
            ]} onChange={v => setVS({ opusSignal: v as OpusSignal })} /></div>
            <div id="setting-stereo-audio"><ToggleRow label={t('settings.stereoAudio')} description={t('settings.voice.stereoDesc')} checked={vs.opusStereo} onChange={v => setVS({ opusStereo: v })} /></div>
          </>
        )}
      </div>

      {/* Mic Notifications */}
      <div className="border border-default rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
        <h3 className="font-black text-xs uppercase tracking-wider mb-4" style={{ color: 'var(--text-primary)' }}>{t('settings.voice.micNotifications', 'Mic Notifications')}</h3>
        <div id="setting-notify-on-no-mic-audio"><ToggleRow
          label={t('settings.voice.notifyNoMicAudio', 'Notify when your mic isn\'t picking up audio')}
          description={t('settings.voice.notifyNoMicAudioDesc', 'Show a warning if no audio is detected from your microphone during a call.')}
          checked={vs.notifyOnNoMicAudio ?? true}
          onChange={v => setVS({ notifyOnNoMicAudio: v })}
        /></div>
      </div>

      {/* Camera */}
      <div className="border border-default rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
        <h3 className="font-black text-xs uppercase tracking-wider mb-4" style={{ color: 'var(--text-primary)' }}>{t('settings.camera')}</h3>
        <div id="setting-test-video" className="mb-4 rounded-xl border border-[var(--glass-border)] bg-black aspect-video w-full flex items-center justify-center overflow-hidden">
          {videoStream ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full rounded-xl object-cover"
            />
          ) : (
            <button
              type="button"
              onClick={() => setTestVideoActive(true)}
              className="btn-cta text-sm font-bold px-5 py-2.5 rounded-xl transition-all"
            >
              {t('settings.testVideo')}
            </button>
          )}
        </div>
        {videoStream && (
          <button
            type="button"
            onClick={() => setTestVideoActive(false)}
            className="text-[10px] font-black uppercase tracking-widest bg-fill-active px-4 py-2 rounded-xl hover:bg-fill-stronger transition-all mb-4"
            style={{ color: 'var(--text-primary)' }}
          >
            {t('settings.stopCamera')}
          </button>
        )}
        <div id="setting-selected-camera">
          <p className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--text-secondary)' }}>{t('settings.camera')}</p>
          <Dropdown
            options={[{ value: '', label: t('settings.default') }, ...videoInputs.map(d => ({ value: d.deviceId, label: d.label }))]}
            value={vs.selectedCameraId}
            onChange={v => setVS({ selectedCameraId: v })}
            size="sm"
            className="w-full"
          />
        </div>
      </div>

      {/* Background */}
      <div id="setting-video-background-mode" className="border border-default rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
        <h3 className="font-black text-xs uppercase tracking-wider mb-4" style={{ color: 'var(--text-primary)' }}>{t('settings.video.background')}</h3>

        {!bgSupported && (
          <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg text-xs" style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--text-secondary)' }}>
            <AlertCircle size={14} /> {t('settings.video.unsupported')}
          </div>
        )}

        {/* Mode selector: Off / Blur / Background */}
        <div className="flex gap-2 mb-4">
          {(['off', 'blur', 'image'] as const).map(mode => {
            const labels = { off: t('settings.video.bgOff'), blur: t('settings.video.bgBlur'), image: t('settings.video.bgBackground') };
            const isActive = vs.videoBackgroundMode === mode;
            return (
              <button
                key={mode}
                type="button"
                disabled={!bgSupported}
                onClick={() => setVS({ videoBackgroundMode: mode })}
                className="flex-1 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all border"
                style={{
                  backgroundColor: isActive ? 'var(--cta-bg, #02385A)' : 'var(--fill-hover)',
                  color: isActive ? '#fff' : 'var(--text-secondary)',
                  borderColor: isActive ? 'var(--cta-bg, #02385A)' : 'transparent',
                  opacity: bgSupported ? 1 : 0.4,
                }}
              >
                {labels[mode]}
              </button>
            );
          })}
        </div>

        {/* Blur intensity slider */}
        {vs.videoBackgroundMode === 'blur' && (
          <div id="setting-video-background-blur-intensity"><SliderRow label={t('settings.video.blurIntensity')} value={vs.videoBackgroundBlurRadius} min={1} max={20} step={1} onChange={v => setVS({ videoBackgroundBlurRadius: v })} /></div>
        )}

        {/* Background presets + upload */}
        {vs.videoBackgroundMode === 'image' && (
          <div>
            <div id="setting-video-background-preset" className="grid grid-cols-3 gap-2 mb-3">
              {BG_PRESETS.map(preset => {
                const isSelected = vs.videoBackgroundImageUrl === presetCache.get(preset.id);
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => {
                      let url = presetCache.get(preset.id);
                      if (!url) {
                        url = renderGradientPreset(preset.colors);
                        presetCache.set(preset.id, url);
                      }
                      setVS({ videoBackgroundImageUrl: url });
                    }}
                    className="relative rounded-xl overflow-hidden transition-all"
                    style={{
                      aspectRatio: '16/10',
                      background: `linear-gradient(135deg, ${preset.colors.join(', ')})`,
                      outline: isSelected ? '2px solid var(--cyan-accent)' : '2px solid transparent',
                      outlineOffset: 2,
                    }}
                  >
                    <div className="absolute bottom-0 inset-x-0 px-2 py-1 text-[9px] font-bold text-white/80" style={{ background: 'linear-gradient(transparent, rgba(0,0,0,0.5))' }}>
                      {t(preset.labelKey)}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Custom upload */}
            {perks.canCustomVideoBackground ? (
              <div>
                {vs.videoBackgroundImageUrl && !Array.from(presetCache.values()).includes(vs.videoBackgroundImageUrl) && (
                  <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-lg text-xs" style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--text-primary)' }}>
                    <span className="flex-1 truncate">{t('settings.video.uploadCustom')}: {t('settings.video.background')}</span>
                    <button id="setting-video-background-clear" type="button" onClick={() => setVS({ videoBackgroundImageUrl: '' })} className="text-[10px] font-bold uppercase" style={{ color: 'var(--cyan-accent)' }}>{t('settings.video.clear')}</button>
                  </div>
                )}
                <label id="setting-video-background-upload-custom" className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed cursor-pointer text-[11px] font-medium transition-all hover:bg-fill-hover" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
                  <Upload size={14} />
                  {t('settings.video.uploadCustom')}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return;
                      if (file.size > 2 * 1024 * 1024) return;
                      const img = new Image();
                      const objectUrl = URL.createObjectURL(file);
                      img.onload = () => {
                        URL.revokeObjectURL(objectUrl);
                        const MAX = 1280;
                        let w = img.width, h = img.height;
                        if (w > MAX || h > MAX) {
                          if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
                          else { w = Math.round(w * MAX / h); h = MAX; }
                        }
                        const canvas = document.createElement('canvas');
                        canvas.width = w;
                        canvas.height = h;
                        const ctx = canvas.getContext('2d');
                        if (!ctx) return;
                        ctx.drawImage(img, 0, 0, w, h);
                        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
                        setVS({ videoBackgroundImageUrl: dataUrl });
                      };
                      img.onerror = () => URL.revokeObjectURL(objectUrl);
                      img.src = objectUrl;
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
            ) : (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs" style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--text-secondary)' }}>
                <Crown size={14} className="text-[var(--cyan-accent)]" />
                {t('settings.video.customBgGated')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Color Grade */}
      <div className="border border-default rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
        <div id="setting-video-color-grade-enabled" className="flex items-center justify-between mb-1">
          <h3 className="font-black text-xs uppercase tracking-wider" style={{ color: 'var(--text-primary)' }}>{t('settings.video.colorGrade')}</h3>
          <Toggle checked={vs.videoColorGradeEnabled} onChange={v => { setVS({ videoColorGradeEnabled: v, ...(v ? {} : { videoColorGrade: 'none' }) }); }} />
        </div>
        <p className="text-[11px] mb-4" style={{ color: 'var(--text-secondary)' }}>{t('settings.video.colorGradeDesc')}</p>

        <div id="setting-video-color-grade" className="flex justify-between" style={{ opacity: vs.videoColorGradeEnabled ? 1 : 0.2, pointerEvents: vs.videoColorGradeEnabled ? 'auto' : 'none', transition: 'opacity 0.2s' }}>
          {([
            { id: 'none', label: t('settings.video.gradeNatural'), gradient: 'linear-gradient(135deg, #667eea, #764ba2)' },
            { id: 'warm', label: t('settings.video.gradeWarm'), gradient: 'linear-gradient(135deg, #f093fb, #f5576c)' },
            { id: 'cool', label: t('settings.video.gradeCool'), gradient: 'linear-gradient(135deg, #4facfe, #00f2fe)' },
            { id: 'noir', label: t('settings.video.gradeNoir'), gradient: 'linear-gradient(135deg, #434343, #000000)' },
            { id: 'vivid', label: t('settings.video.gradeVivid'), gradient: 'linear-gradient(135deg, #fa709a, #fee140)' },
            { id: 'faded', label: t('settings.video.gradeFaded'), gradient: 'linear-gradient(135deg, #a8caba, #5d4157)' },
          ] as { id: GradeId; label: string; gradient: string }[]).map(grade => {
            const isSelected = vs.videoColorGrade === grade.id;
            return (
              <button
                key={grade.id}
                type="button"
                onClick={() => setVS({ videoColorGrade: grade.id })}
                className="flex flex-col items-center gap-1.5"
              >
                <div
                  className="rounded-full transition-all"
                  style={{
                    width: 38, height: 38,
                    background: grade.gradient,
                    filter: COLOR_GRADES[grade.id] === 'none' ? undefined : COLOR_GRADES[grade.id],
                    outline: isSelected ? '2px solid var(--cyan-accent)' : '2px solid transparent',
                    outlineOffset: 2,
                    boxShadow: isSelected ? '0 0 12px var(--cyan-accent)' : 'none',
                  }}
                />
                <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color: isSelected ? 'var(--cyan-accent)' : 'var(--text-secondary)' }}>{grade.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Framing */}
      <div id="setting-auto-frame-mode" className="border border-default rounded-2xl p-6 mb-6" style={{ backgroundColor: vs.autoFrameMode !== 'off' ? 'color-mix(in srgb, var(--cyan-accent) 5%, var(--bg-panel))' : 'var(--bg-panel)', transition: 'background-color 0.3s' }}>
        <div className="flex items-start gap-3 mb-4">
          <div className="shrink-0 mt-0.5 p-2 rounded-lg" style={{ backgroundColor: 'var(--fill-hover)' }}>
            <Focus size={18} style={{ color: vs.autoFrameMode !== 'off' ? 'var(--cyan-accent)' : 'var(--text-secondary)' }} />
          </div>
          <div className="flex-1 min-w-0">
            <span className="font-black text-xs uppercase tracking-wider" style={{ color: 'var(--text-primary)' }}>{t('settings.video.autoFrame')}</span>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('settings.video.autoFrameDesc')}</p>
          </div>
        </div>

        {!afSupported && (
          <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg text-xs" style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--text-secondary)' }}>
            <AlertCircle size={14} /> {t('settings.video.unsupported')}
          </div>
        )}

        {/* 3-level smoothness selector. Off = detection disabled. Medium = legacy
            behavior (lerp 0.15, detect every 2 frames). High = spring-damper with
            detect every frame — much smoother glide, costs ~2x CPU. */}
        <div className="grid grid-cols-3 gap-2 mb-4" role="radiogroup" aria-label={t('settings.video.autoFrame')}>
          {(['off', 'medium', 'high'] as const).map((mode) => {
            const selected = vs.autoFrameMode === mode;
            const label = t(`settings.video.autoFrameMode.${mode}`, mode === 'off' ? 'Off' : mode === 'medium' ? 'Medium' : 'High');
            const desc = t(`settings.video.autoFrameMode.${mode}Desc`,
              mode === 'off' ? 'Disabled' :
              mode === 'medium' ? 'Smooth tracking' :
              'Silky-smooth, more CPU');
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!afSupported}
                onClick={() => setVS({ autoFrameMode: mode })}
                className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  selected
                    ? 'btn-cta-selected'
                    : 'border-default hover:bg-fill-hover'
                }`}
                style={{ backgroundColor: selected ? undefined : 'var(--fill-hover)' }}
              >
                <div className="text-xs font-semibold" style={{ color: selected ? '#fff' : 'var(--text-primary)' }}>
                  {label}
                </div>
                <div className="text-[10px] mt-0.5 leading-snug" style={{ color: 'var(--text-secondary)' }}>
                  {desc}
                </div>
              </button>
            );
          })}
        </div>

        <div style={{ opacity: vs.autoFrameMode !== 'off' ? 1 : 0.2, transition: 'opacity 0.2s' }}>
          {/* Auto-zoom toggle. When on, the processor derives target zoom from
              the face bounding-box width so the subject keeps ~30% frame coverage
              regardless of camera distance. Slider is disabled in auto mode. */}
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex-1 min-w-0">
              <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                {t('settings.video.autoFrameZoomAuto', 'Auto zoom')}
              </span>
              <p className="text-[10px] mt-0.5 leading-snug" style={{ color: 'var(--text-secondary)' }}>
                {t('settings.video.autoFrameZoomAutoDesc', 'Automatically adjust zoom based on how close you are to the camera')}
              </p>
            </div>
            <Toggle
              checked={!!vs.autoFrameZoomAuto}
              onChange={v => setVS({ autoFrameZoomAuto: v })}
              disabled={!afSupported || vs.autoFrameMode === 'off'}
            />
          </div>
          <div id="setting-auto-frame-zoom" style={{ opacity: vs.autoFrameZoomAuto ? 0.4 : 1, transition: 'opacity 0.2s' }}>
            <SliderRow
              label={t('settings.video.autoFrameZoom')}
              value={vs.autoFrameZoom}
              min={1}
              max={2.5}
              step={0.1}
              unit="x"
              onChange={v => setVS({ autoFrameZoom: v })}
            />
          </div>
        </div>
      </div>

      {/* Streaming */}
      <div className="border border-default rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
        <h3 className="font-black text-xs uppercase tracking-wider mb-4" style={{ color: 'var(--text-primary)' }}>{t('settings.voice.streaming')}</h3>
        <div id="setting-show-stream-previews"><ToggleRow label={t('settings.showStreamPreviews')} description={t('settings.voice.showStreamPreviewsDesc')} checked={vs.showStreamPreviews} onChange={v => setVS({ showStreamPreviews: v })} /></div>
        <div id="setting-mute-howl-audio-while-sharing"><ToggleRow label={t('settings.voice.muteHowlAudioWhileSharing', 'Mute Howl audio while sharing')} description={t('settings.voice.muteHowlAudioWhileSharingDesc', 'When you share a screen with system audio, silence other participants\' voices on your device so they don\'t echo back through the screen-share capture.')} checked={vs.muteHowlAudioWhileSharing ?? true} onChange={v => setVS({ muteHowlAudioWhileSharing: v })} /></div>
        <div id="setting-show-advanced-stream-settings"><ToggleRow label={t('settings.voice.showAdvancedStream')} description={t('settings.voice.showAdvancedStreamDesc')} checked={vs.showAdvancedStream} onChange={v => setVS({ showAdvancedStream: v })} /></div>
        {vs.showAdvancedStream && (
          <div className="mt-3 pt-3 border-t border-default">
            <div id="setting-stream-attenuation"><ToggleRow label={t('settings.voice.streamAttenuation')} description={t('settings.voice.streamAttenuationDesc')} checked={vs.streamAttenuation ?? true} onChange={v => setVS({ streamAttenuation: v })} /></div>
            {(vs.streamAttenuation ?? true) && (
              <div id="setting-stream-attenuation-strength"><SliderRow label={t('settings.voice.attenuationStrength')} value={vs.streamAttenuationStrength ?? 50} min={0} max={100} step={1} unit="%" onChange={v => setVS({ streamAttenuationStrength: v })} /></div>
            )}
          </div>
        )}
      </div>

      {/* Screen Share Encoding */}
      <div className="border border-default rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
        <h3 className="font-black text-xs uppercase tracking-wider mb-4" style={{ color: 'var(--text-primary)' }}>{t('settings.voice.screenShareEncoding')}</h3>

        {gpuInfo && (
          <div className="flex items-center gap-3 mb-4 px-3 py-2.5 rounded-lg border border-default" style={{ backgroundColor: 'var(--fill-hover)' }}>
            <Cpu size={16} className="text-[var(--cyan-accent)] shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                {t('settings.voice.gpuDetected', { vendor: gpuInfo.vendor !== 'Unknown' ? `${gpuInfo.vendor} GPU` : 'GPU' })}
              </p>
              <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                {t('settings.voice.supportedCodecs')}: {supportedCodecs.length > 0 ? supportedCodecs.map(c => CODEC_LABELS[c]).join(', ') : t('settings.voice.noneDetected')}
              </p>
            </div>
          </div>
        )}

        <div id="setting-screen-share-codec" className="py-3 border-b border-default">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('settings.voice.preferredCodec')}</p>
              <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('settings.voice.preferredCodecDesc')}</p>
            </div>
            <Dropdown
              options={[
                { value: 'auto' as ScreenShareCodec, label: t('settings.autoRecommended') },
                ...(['h264', 'vp9', 'av1'] as const).map(c => ({
                  value: c as ScreenShareCodec,
                  label: `${CODEC_LABELS[c]}${!supportedCodecs.includes(c) ? ` (${t('settings.voice.unsupported')})` : ''}`,
                  disabled: !supportedCodecs.includes(c),
                })),
              ]}
              value={(vs.screenShareCodec ?? 'auto') as ScreenShareCodec}
              onChange={v => setVS({ screenShareCodec: v })}
              size="sm"
            />
          </div>
          <p className="text-[11px] mt-2" style={{ color: 'var(--text-secondary)' }}>
            {(vs.screenShareCodec ?? 'auto') === 'auto' && t('settings.voice.codecAutoDesc')}
            {vs.screenShareCodec === 'h264' && t('settings.voice.codecH264Desc')}
            {vs.screenShareCodec === 'vp9' && t('settings.voice.codecVp9Desc')}
            {vs.screenShareCodec === 'av1' && t('settings.voice.codecAv1Desc')}
          </p>
        </div>

        <div id="setting-force-software-encoding"><ToggleRow
          label={t('settings.voice.forceSoftwareEncoding')}
          description={t('settings.voice.forceSoftwareEncodingDesc')}
          checked={vs.forceSwEncoding ?? false}
          onChange={v => {
            setVS({ forceSwEncoding: v });
            window.electron?.setForceSwEncode?.(v);
          }}
        /></div>
        {vs.forceSwEncoding && (
          <div className="flex items-center gap-2 mt-2 px-3 py-2 rounded-lg border border-amber-500/20" style={{ backgroundColor: 'rgba(245,158,11,0.05)' }}>
            <AlertCircle size={14} className="text-amber-400 shrink-0" />
            <p className="text-[11px] text-amber-400">{t('settings.voice.restartRequired')}</p>
          </div>
        )}
      </div>

      {/* Sounds */}
      <div id="setting-preview-sound" className="mb-6">
        <SettingsSection title={t('settings.sounds')}>
          <div className="space-y-3">
            {([[t('settings.deafen'), 'soundDeafen', 'setting-sound-deafen'], [t('settings.undeafen'), 'soundUndeafen', 'setting-sound-undeafen'], [t('settings.mute'), 'soundMute', 'setting-sound-mute'], [t('settings.unmute'), 'soundUnmute', 'setting-sound-unmute'], [t('settings.voiceConnect', 'Connect'), 'soundConnect', 'setting-sound-connect'], [t('settings.voiceDisconnect', 'Disconnect'), 'soundDisconnect', 'setting-sound-disconnect']] as [string, 'soundDeafen' | 'soundUndeafen' | 'soundMute' | 'soundUnmute' | 'soundConnect' | 'soundDisconnect', string][]).map(([label, key, settingId]) => {
              const isPlaying = previewingSoundKey === key;
              return (
                <div key={key} id={settingId} className="flex items-center justify-between py-2 border-b border-[var(--glass-border)] last:border-b-0">
                  <div className="flex items-center gap-2.5">
                    <span className="text-xs font-medium text-t-primary">{label}</span>
                    <button
                      type="button"
                      onClick={() => togglePreviewSound(key)}
                      aria-label={isPlaying ? t('settings.stop') : t('settings.preview')}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider border transition-all ${
                        isPlaying
                          ? 'bg-red-500/15 text-red-400 border-red-500/40 hover:bg-red-500/25'
                          : 'bg-[var(--cyan-accent)]/10 text-[var(--cyan-accent)] border-[var(--cyan-accent)]/30 hover:bg-[var(--cyan-accent)]/20'
                      }`}
                    >
                      {isPlaying ? <Square size={9} fill="currentColor" /> : <Play size={9} fill="currentColor" />}
                      {isPlaying ? t('settings.stop') : t('settings.preview')}
                    </button>
                  </div>
                  <Toggle checked={vs[key]} onChange={(v) => setVS({ [key]: v })} />
                </div>
              );
            })}
          </div>
        </SettingsSection>
      </div>

      {/* Soundboard */}
      <div className="border border-default rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
        <h3 className="font-black text-xs uppercase tracking-wider mb-4" style={{ color: 'var(--text-primary)' }}>{t('settings.voice.soundboard')}</h3>
        <div id="setting-soundboard-volume"><SliderRow label={t('settings.soundboardVolume')} value={vs.soundboardVolume} min={0} max={100} step={1} unit="%" onChange={v => setVS({ soundboardVolume: v })} /></div>
      </div>

      {/* Connection */}
      <div className="border border-default rounded-2xl p-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
        <h3 className="font-black text-xs uppercase tracking-wider mb-4 flex items-center" style={{ color: 'var(--text-primary)' }}>
          <MessageSquare size={14} className="mr-2 text-[var(--cyan-accent)]" /> {t('settings.voice.realtimeConnection')}
        </h3>
        <p className="text-[11px] mb-2" style={{ color: 'var(--text-secondary)' }}>{t('settings.voice.socketDesc')}</p>
        <p className={`text-[11px] font-bold ${socketConnected ? 'text-emerald-400' : 'text-amber-400'}`}>
          {socketConnected ? t('settings.voice.connected') : t('settings.voice.disconnected')}
        </p>
      </div>

      {/* Audio Quality — Bluetooth optimization & remembered devices */}
      <div className="border border-default rounded-2xl p-6 mt-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
        <h3 className="font-black text-xs uppercase tracking-wider mb-4" style={{ color: 'var(--text-primary)' }}>{t('bluetoothQuality.settings.sectionTitle')}</h3>

        <label id="setting-auto-optimize-bluetooth" className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={bluetoothAudioSettings.autoOptimizeBluetoothAudio}
            onChange={(e) => updateBluetoothAudioSettings({ autoOptimizeBluetoothAudio: e.target.checked })}
            className="mt-1 accent-[var(--cyan-accent)]"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('bluetoothQuality.settings.autoOptimizeLabel')}</span>
            <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              {t('bluetoothQuality.settings.autoOptimizeDescription')}
            </span>
          </span>
        </label>

        {btDevicePreferences.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-secondary)' }}>{t('bluetoothQuality.settings.rememberedDevicesTitle')}</p>
            <ul className="space-y-1">
              {btDevicePreferences.map((p) => (
                <li key={p.label} className="flex items-center justify-between gap-3 rounded-xl border border-default px-3 py-1.5" style={{ backgroundColor: 'var(--fill-hover)' }}>
                  <span className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>{p.label}</span>
                  <button
                    type="button"
                    className="text-[10px] font-bold uppercase tracking-widest shrink-0 hover:text-red-400 transition-colors"
                    style={{ color: 'var(--text-secondary)' }}
                    onClick={() => removeBtDevicePreferenceByLabel(p.label)}
                  >
                    {t('bluetoothQuality.settings.forgetButton')}
                  </button>
                </li>
              ))}
            </ul>
            <button
              id="setting-bluetooth-clear-all-devices"
              type="button"
              className="text-[10px] font-bold uppercase tracking-widest hover:text-red-400 transition-colors"
              style={{ color: 'var(--text-secondary)' }}
              onClick={clearAllBtDevicePreferences}
            >
              {t('bluetoothQuality.settings.clearAllButton')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
