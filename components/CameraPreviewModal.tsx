// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Wand2, Sparkles } from 'lucide-react';
import { buildProcessedCameraStream } from '../services/call/buildProcessedCameraStream';
import { getStoredVoice } from '../utils/settingsStorage';
import { Dropdown } from './ui/dropdown';

interface CameraPreviewModalProps {
  open: boolean;
  selectedDeviceId: string;
  alwaysPreview: boolean;
  videoBackgroundMode: 'off' | 'blur' | 'image';
  onClose: () => void;
  /** Confirm — caller starts camera with current selectedDeviceId. */
  onConfirm: () => void;
  /** Device picked from dropdown — caller persists to voiceSettings. */
  onDeviceChange: (deviceId: string) => void;
  onAlwaysPreviewChange: (v: boolean) => void;
  onVideoBackgroundModeChange: (mode: 'off' | 'blur' | 'image') => void;
  /** Open the Voice & Video settings page for advanced background config. */
  onOpenVideoSettings: () => void;
}

/**
 * Discord-style "ready to video?" modal — shown before turning the camera on.
 * Lets the user verify the device, swap cameras, toggle a basic background
 * effect, and skip the modal next time. Heavier features (custom background
 * upload, color grade, auto-frame) live in the Voice & Video settings page;
 * we surface a link rather than duplicating the UI here.
 */
export const CameraPreviewModal: React.FC<CameraPreviewModalProps> = ({
  open,
  selectedDeviceId,
  alwaysPreview,
  videoBackgroundMode,
  onClose,
  onConfirm,
  onDeviceChange,
  onAlwaysPreviewChange,
  onVideoBackgroundModeChange,
  onOpenVideoSettings,
}) => {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Raw getUserMedia output lives in its own ref so we can stop the camera
  // device even when `stream` state points at a processed track.
  const rawStreamRef = useRef<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const effectCleanupRef = useRef<(() => void) | null>(null);

  // Enumerate devices once when the modal opens (after permission grant).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        // Permission probe — required before enumerateDevices returns labels.
        const probe = await navigator.mediaDevices.getUserMedia({ video: true });
        probe.getTracks().forEach((t) => t.stop());
        if (cancelled) return;
        const list = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        setDevices(list.filter((d) => d.kind === 'videoinput'));
      } catch (err) {
        if (!cancelled) setError((err as Error).message || 'Camera permission denied');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Start / restart preview stream when device changes. Applies autoframe +
  // color grade if the user has them enabled in voice settings so the preview
  // reflects what the remote participant will see.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const constraints: MediaStreamConstraints = {
          video: selectedDeviceId
            ? { deviceId: { exact: selectedDeviceId } }
            : true,
        };
        const raw = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) {
          raw.getTracks().forEach((t) => t.stop());
          return;
        }
        // Stop any prior processed+raw stream first.
        effectCleanupRef.current?.();
        effectCleanupRef.current = null;
        rawStreamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current?.getTracks().forEach((t) => t.stop());
        rawStreamRef.current = raw;

        const vs = getStoredVoice();
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
        effectCleanupRef.current = cleanup;
        streamRef.current = processed;
        setStream(processed);
        setError(null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message || 'Could not start camera');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, selectedDeviceId]);

  // The <video> element is conditionally rendered on `stream` being truthy,
  // so its ref is null during the render that first flips `stream`. Attach
  // srcObject in a dedicated effect once the element mounts.
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  // Cleanup preview stream when modal closes
  useEffect(() => {
    if (open) return;
    effectCleanupRef.current?.();
    effectCleanupRef.current = null;
    rawStreamRef.current?.getTracks().forEach((t) => t.stop());
    rawStreamRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
  }, [open]);

  const deviceOptions = useMemo(
    () =>
      devices.map((d) => ({
        value: d.deviceId,
        label: d.label || `Camera ${d.deviceId.slice(0, 6)}`,
      })),
    [devices]
  );

  if (!open) return null;

  const bgOptions: { value: 'off' | 'blur' | 'image'; label: string; icon: React.ReactNode }[] = [
    { value: 'off', label: 'None', icon: null },
    { value: 'blur', label: 'Blur', icon: <Wand2 size={14} /> },
    { value: 'image', label: 'Custom', icon: <Sparkles size={14} /> },
  ];

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{
        backgroundColor: 'var(--overlay-backdrop, rgba(2,6,23,0.65))',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-[480px] mx-4 rounded-2xl overflow-hidden shadow-2xl spring-pop-in"
        style={{
          backgroundColor: 'var(--glass-bg, rgba(15,22,35,0.78))',
          border: '1px solid var(--glass-border, rgba(255,255,255,0.08))',
          backdropFilter: 'blur(32px) saturate(1.6)',
          WebkitBackdropFilter: 'blur(32px) saturate(1.6)',
          boxShadow: '0 0 0 1px var(--border-subtle) inset, 0 25px 50px -12px rgba(0,0,0,0.5)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3">
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            Ready to video chat?
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-fill-active transition-colors"
            style={{ color: 'var(--text-secondary)' }}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Preview */}
        <div className="px-5">
          <div
            className="aspect-video rounded-xl overflow-hidden relative ring-1"
            style={{ backgroundColor: '#000', boxShadow: '0 0 0 1px var(--border-subtle) inset' }}
          >
            {stream ? (
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="w-full h-full object-cover"
              />
            ) : (
              <div
                className="absolute inset-0 flex items-center justify-center text-xs"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {error ? error : 'Starting camera…'}
              </div>
            )}
          </div>
        </div>

        {/* Device dropdown */}
        <div className="px-5 mt-4">
          <Dropdown
            options={deviceOptions}
            value={selectedDeviceId || (devices[0]?.deviceId ?? '')}
            onChange={(v) => onDeviceChange(v)}
            placeholder="No cameras available"
          />
        </div>

        {/* Background quick-toggle + settings link */}
        <div className="px-5 mt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-secondary)' }}>
            Video Background
          </h3>
          <div className="grid grid-cols-3 gap-2">
            {bgOptions.map((opt) => {
              const active = videoBackgroundMode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onVideoBackgroundModeChange(opt.value)}
                  className="flex flex-col items-center justify-center gap-1.5 py-3 rounded-xl transition-all text-xs font-medium"
                  style={{
                    backgroundColor: active ? 'var(--cyan-accent-faint, rgba(7,111,160,0.10))' : 'var(--fill-hover)',
                    border: `1px solid ${active ? 'var(--cyan-accent)' : 'var(--border-subtle)'}`,
                    color: active ? 'var(--cyan-accent)' : 'var(--text-primary)',
                  }}
                >
                  {opt.icon}
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={onOpenVideoSettings}
            className="w-full mt-2 px-3 py-2 rounded-lg text-xs flex items-center justify-center gap-1.5 transition-colors"
            style={{ color: 'var(--cyan-accent)' }}
          >
            <Sparkles size={12} />
            <span>Configure backgrounds, effects & color grade</span>
          </button>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 mt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <label className="flex items-center gap-2 text-xs cursor-pointer select-none" style={{ color: 'var(--text-secondary)' }}>
            <input
              type="checkbox"
              checked={alwaysPreview}
              onChange={(e) => onAlwaysPreviewChange(e.target.checked)}
              className="cursor-pointer"
              style={{ accentColor: 'var(--cyan-accent)' }}
            />
            Always preview video
          </label>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!stream}
            className="btn-cta px-4 py-2 rounded-xl text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Turn On Camera
          </button>
        </div>
      </div>
    </div>
  );
};

export default CameraPreviewModal;
