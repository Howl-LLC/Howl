// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Volume2, X } from 'lucide-react';

interface VolumePopupProps {
  userId: string;
  username: string;
  volume: number; // 0-2 range
  onChange: (userId: string, volume: number) => void;
  onClose: () => void;
  /** Accent color for the slider track fill. Defaults to var(--cyan-accent). */
  accentColor?: string;
}

const PRESETS = [50, 100, 150, 200];

const VolumePopup: React.FC<VolumePopupProps> = React.memo(({
  userId, username, volume, onChange, onClose, accentColor = 'var(--cyan-accent)',
}) => {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const percent = Math.round(volume * 100);
  const [editValue, setEditValue] = useState(String(percent));
  const [editing, setEditing] = useState(false);

  // Sync editValue when volume changes externally (slider drag)
  useEffect(() => { if (!editing) setEditValue(String(percent)); }, [percent, editing]);

  // Click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    const parsed = parseInt(editValue, 10);
    if (Number.isNaN(parsed)) { setEditValue(String(percent)); return; }
    const clamped = Math.max(0, Math.min(200, parsed));
    setEditValue(String(clamped));
    onChange(userId, clamped / 100);
  }, [editValue, percent, onChange, userId]);

  return (
    <div
      ref={ref}
      className="w-56 rounded-xl border border-default bg-fill-hover backdrop-blur-xl p-4 animate-[spring-pop-in_180ms_ease-out]"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <Volume2 size={14} style={{ color: accentColor }} className="shrink-0" />
        <span className="text-[12px] font-semibold truncate flex-1" style={{ color: 'var(--text-primary)' }}>
          {username}
        </span>
        <button type="button" onClick={onClose} className="p-0.5 rounded-lg hover:bg-fill-hover transition-colors" aria-label={t('common.close', 'Close')}>
          <X size={12} className="text-white/40" />
        </button>
      </div>

      {/* Slider */}
      <input
        type="range"
        min={0}
        max={2}
        step={0.01}
        value={volume}
        onChange={(e) => onChange(userId, e.target.valueAsNumber)}
        className="w-full h-2 rounded-full appearance-none cursor-pointer"
        style={{ background: `linear-gradient(to right, ${accentColor} ${percent / 2}%, var(--fill-active) ${percent / 2}%)` }}
        aria-label={t('volume.sliderLabel', 'Volume for {{username}}', { username })}
      />

      {/* Value + presets row */}
      <div className="flex items-center gap-1.5 mt-3">
        {editing ? (
          <input
            type="number"
            min={0}
            max={200}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); }}
            className="w-14 text-center text-sm font-bold tabular-nums bg-transparent border border-[var(--glass-border)] rounded-md px-1 py-0.5 outline-none focus:border-[var(--border-strong)]"
            style={{ color: accentColor }}
            autoFocus
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="w-14 text-center text-sm font-bold tabular-nums rounded-md px-1 py-0.5 hover:bg-fill-hover transition-colors cursor-text"
            style={{ color: accentColor }}
            title={t('volume.clickToEdit', 'Click to edit')}
          >
            {percent}%
          </button>
        )}
        <div className="flex-1 flex justify-end gap-1">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onChange(userId, p / 100)}
              className={`px-1.5 py-0.5 text-[10px] font-bold tabular-nums rounded-md transition-colors ${
                percent === p ? 'btn-cta-selected' : 'text-t-secondary hover:bg-fill-hover hover:text-t-primary'
              }`}
            >
              {p}%
            </button>
          ))}
        </div>
      </div>
    </div>
  );
});

VolumePopup.displayName = 'VolumePopup';
export default VolumePopup;
