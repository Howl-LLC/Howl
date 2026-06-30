// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';

/* ── Color conversion helpers ──────────────────────────────────────── */

function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(f(5))}${toHex(f(3))}${toHex(f(1))}`;
}

function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const m = hex.replace('#', '').match(/.{2}/g);
  if (!m) return { h: 0, s: 1, v: 1 };
  const [r, g, b] = m.map((c) => parseInt(c, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

function isValidHex(hex: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(hex);
}

// Normalize any CSS color string (#rgb, #rrggbb, #rrggbbaa, rgb(), hsl(),
// color(srgb …), named colors) into `#rrggbb`. Returns null if the browser
// can't parse it or the color isn't opaque. Used for the EyeDropper result
// because `sRGBHex` is not guaranteed to be 6-digit hex on all platforms
// (HDR/wide-gamut Chromium and some Electron builds return non-`#rrggbb`).
function normalizeToHex(input: string): string | null {
  const trimmed = input.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  // Sentinel: if assigning `trimmed` to fillStyle is rejected as invalid, the
  // setter silently keeps the previous value, so we can detect parse failure.
  ctx.fillStyle = '#000000';
  ctx.fillStyle = trimmed;
  const normalized = String(ctx.fillStyle);
  if (normalized === '#000000' && trimmed.toLowerCase() !== '#000000') return null;
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized.toLowerCase() : null;
}

/* ── Preset swatches ───────────────────────────────────────────────── */

const SWATCHES = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
  '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
  '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#ffffff', '#94a3b8', '#000000',
];

/* ── Component ─────────────────────────────────────────────────────── */

interface ColorPickerProps {
  value: string;
  onChange: (hex: string) => void;
  className?: string;
}

const hasEyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window;

export function ColorPicker({ value, onChange, className }: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const [hexInput, setHexInput] = useState(value);
  // Eyedropper is async and the user's pick click can leak back to the page on
  // Linux Chromium; keep this flag true while the dropper is open so the
  // outside-click handler doesn't close the panel during/after the pick.
  const eyeDropperActive = useRef(false);

  // Sync external value changes
  useEffect(() => {
    if (isValidHex(value)) {
      setHsv(hexToHsv(value));
      setHexInput(value);
    }
  }, [value]);

  const commit = useCallback((h: number, s: number, v: number) => {
    const hex = hsvToHex(h, s, v);
    setHsv({ h, s, v });
    setHexInput(hex);
    onChange(hex);
  }, [onChange]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (eyeDropperActive.current) return;
      const target = 'touches' in e ? e.touches[0]?.target : e.target;
      if (target && panelRef.current && !panelRef.current.contains(target as Node) &&
          btnRef.current && !btnRef.current.contains(target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler, { passive: true });
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [open]);

  /* ── Saturation / Brightness area drag ───────────────────────── */
  const svRef = useRef<HTMLDivElement>(null);
  const draggingSV = useRef(false);

  const updateSV = useCallback((e: { clientX: number; clientY: number }) => {
    const el = svRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const s = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const v = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
    commit(hsv.h, s, v);
  }, [hsv.h, commit]);

  const onSVPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    draggingSV.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    updateSV(e);
  }, [updateSV]);

  const onSVPointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingSV.current) return;
    updateSV(e);
  }, [updateSV]);

  const onSVPointerUp = useCallback(() => {
    draggingSV.current = false;
  }, []);

  /* ── Hue slider drag ─────────────────────────────────────────── */
  const hueRef = useRef<HTMLDivElement>(null);
  const draggingHue = useRef(false);

  const updateHue = useCallback((e: { clientX: number }) => {
    const el = hueRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const h = Math.max(0, Math.min(360, ((e.clientX - rect.left) / rect.width) * 360));
    commit(h, hsv.s, hsv.v);
  }, [hsv.s, hsv.v, commit]);

  const onHuePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    draggingHue.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    updateHue(e);
  }, [updateHue]);

  const onHuePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingHue.current) return;
    updateHue(e);
  }, [updateHue]);

  const onHuePointerUp = useCallback(() => {
    draggingHue.current = false;
  }, []);

  /* ── Panel position ──────────────────────────────────────────── */
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const panelW = 256;
    const panelH = 340;
    let top = r.bottom + 8;
    let left = r.left;
    if (top + panelH > window.innerHeight - 12) top = r.top - panelH - 8;
    if (left + panelW > window.innerWidth - 12) left = window.innerWidth - panelW - 12;
    if (left < 12) left = 12;
    setPos({ top, left });
  }, [open]);

  const currentHex = hsvToHex(hsv.h, hsv.s, hsv.v);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-8 h-8 rounded-lg border border-[var(--border-strong)] cursor-pointer transition-all duration-[120ms] hover:scale-105 active:scale-95 ${className ?? ''}`}
        style={{ backgroundColor: currentHex }}
        title={currentHex}
      />
      {open && pos && createPortal(
        <div
          ref={panelRef}
          className="fixed z-[var(--z-max)] w-64 rounded-2xl shadow-2xl overflow-hidden spring-pop-in"
          style={{
            top: pos.top,
            left: pos.left,
            backgroundColor: 'var(--bg-floating)',
            border: '1px solid var(--border-subtle)',
            backdropFilter: 'blur(24px)',
          }}
        >
          {/* Saturation / Brightness area */}
          <div
            ref={svRef}
            className="relative w-full h-36 cursor-crosshair select-none"
            style={{
              background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h}, 100%, 50%))`,
            }}
            onPointerDown={onSVPointerDown}
            onPointerMove={onSVPointerMove}
            onPointerUp={onSVPointerUp}
          >
            {/* Thumb */}
            <div
              className="absolute w-4 h-4 rounded-full border-2 border-white shadow-md pointer-events-none"
              style={{
                left: `${hsv.s * 100}%`,
                top: `${(1 - hsv.v) * 100}%`,
                transform: 'translate(-50%, -50%)',
                backgroundColor: currentHex,
              }}
            />
          </div>

          <div className="p-3 space-y-3">
            {/* Hue slider */}
            <div
              ref={hueRef}
              className="relative h-3 rounded-full cursor-pointer select-none"
              style={{
                background: 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)',
              }}
              onPointerDown={onHuePointerDown}
              onPointerMove={onHuePointerMove}
              onPointerUp={onHuePointerUp}
            >
              <div
                className="absolute top-1/2 w-4 h-4 rounded-full border-2 border-white shadow-md pointer-events-none"
                style={{
                  left: `${(hsv.h / 360) * 100}%`,
                  transform: 'translate(-50%, -50%)',
                  backgroundColor: `hsl(${hsv.h}, 100%, 50%)`,
                }}
              />
            </div>

            {/* Hex input + current color preview + eyedropper */}
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg shrink-0 border border-[var(--glass-border)]" style={{ backgroundColor: currentHex }} />
              <input
                type="text"
                value={hexInput}
                onChange={(e) => {
                  const v = e.target.value;
                  setHexInput(v);
                  if (isValidHex(v)) {
                    const newHsv = hexToHsv(v);
                    setHsv(newHsv);
                    onChange(v);
                  }
                }}
                onBlur={() => {
                  if (!isValidHex(hexInput)) setHexInput(currentHex);
                }}
                className="flex-1 rounded-lg px-2.5 py-1.5 text-xs font-mono border outline-none"
                style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                maxLength={7}
                spellCheck={false}
              />
              {hasEyeDropper && (
                <button
                  type="button"
                  title="Pick color from screen"
                  onClick={async () => {
                    eyeDropperActive.current = true;
                    try {
                      const dropper = new (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper();
                      const result = await dropper.open();
                      const raw = typeof result?.sRGBHex === 'string' ? result.sRGBHex : '';
                      const hex = raw ? normalizeToHex(raw) : null;
                      if (hex) {
                        const newHsv = hexToHsv(hex);
                        setHsv(newHsv);
                        setHexInput(hex);
                        onChange(hex);
                      } else {
                        // Empty/missing/unparseable sRGBHex — log so the user can see what the API actually returned.
                        console.warn('[ColorPicker] EyeDropper returned no usable color', { result, raw });
                      }
                    } catch (err) {
                      // Log every rejection (including AbortError) — on Linux Chromium the
                      // pick click sometimes aborts even though the user picked a real pixel.
                      console.warn('[ColorPicker] EyeDropper rejected:', err);
                    } finally {
                      // Defer clearing past the next tick so any leaked pick-click mousedown
                      // doesn't close the panel before we apply the color.
                      setTimeout(() => { eyeDropperActive.current = false; }, 0);
                    }
                  }}
                  className="w-7 h-7 shrink-0 flex items-center justify-center rounded-lg border border-[var(--glass-border)] hover:bg-fill-active active:scale-90 transition-all duration-[120ms]"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m2 22 1-1h3l9-9" />
                    <path d="M3 21v-3l9-9" />
                    <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9" />
                    <path d="m15 6 3 3" />
                    <path d="M9 12l3 3" />
                  </svg>
                </button>
              )}
            </div>

            {/* Preset swatches */}
            <div className="grid grid-cols-10 gap-1.5">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    const newHsv = hexToHsv(c);
                    setHsv(newHsv);
                    setHexInput(c);
                    onChange(c);
                  }}
                  className={`w-5 h-5 rounded-md border transition-all duration-[120ms] hover:scale-110 active:scale-95 ${currentHex.toLowerCase() === c.toLowerCase() ? 'border-white ring-1 ring-white/40 scale-110' : 'border-[var(--glass-border)]'}`}
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
