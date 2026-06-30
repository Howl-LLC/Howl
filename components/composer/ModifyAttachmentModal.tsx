// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect, useRef, useCallback } from 'react';
import { X, FileText, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFocusTrap } from '../../hooks/useFocusTrap';

export interface ModifyAttachmentModalProps {
  open: boolean;
  filename: string;
  alt: string;
  isSpoiler: boolean;
  previewUrl: string | null;
  contentType?: string | null;
  onSave: (next: { filename: string; alt: string; isSpoiler: boolean }) => void;
  onCancel: () => void;
}

export function ModifyAttachmentModal({
  open,
  filename,
  alt,
  isSpoiler,
  previewUrl,
  contentType,
  onSave,
  onCancel,
}: ModifyAttachmentModalProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, open);

  const [localFilename, setLocalFilename] = useState(filename);
  const [localAlt, setLocalAlt] = useState(alt);
  const [localIsSpoiler, setLocalIsSpoiler] = useState(isSpoiler);

  // Re-initialize local state when modal opens with new props
  useEffect(() => {
    if (open) {
      setLocalFilename(filename);
      setLocalAlt(alt);
      setLocalIsSpoiler(isSpoiler);
    }
  }, [open, filename, alt, isSpoiler]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onCancel]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onCancel();
    },
    [onCancel],
  );

  const handleSave = useCallback(() => {
    onSave({ filename: localFilename, alt: localAlt, isSpoiler: localIsSpoiler });
  }, [onSave, localFilename, localAlt, localIsSpoiler]);

  if (!open) return null;

  const isImage = contentType?.startsWith('image/');
  const isVideo = contentType?.startsWith('video/');

  const preview = previewUrl ? (
    isImage ? (
      <img
        src={previewUrl}
        alt={localFilename}
        className="w-full h-full object-cover rounded-lg"
        loading="lazy"
        decoding="async"
      />
    ) : isVideo ? (
      <video
        src={previewUrl}
        muted
        preload="metadata"
        className="w-full h-full object-cover rounded-lg"
      />
    ) : (
      <div className="w-full h-full flex items-center justify-center rounded-lg" style={{ backgroundColor: '#0d1112' }}>
        <FileText size={28} style={{ color: 'rgba(255,255,255,0.35)' }} />
      </div>
    )
  ) : (
    <div className="w-full h-full flex items-center justify-center rounded-lg" style={{ backgroundColor: '#0d1112' }}>
      <FileText size={28} style={{ color: 'rgba(255,255,255,0.35)' }} />
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={handleBackdropClick}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-label={t('modifyAttachment.title', 'Modify Attachment')}
        className="w-full mx-4 sm:mx-0"
        style={{
          maxWidth: '380px',
          backgroundColor: '#14191a',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '12px',
          boxShadow: '0 16px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.2)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h2 style={{ fontSize: '15px', fontWeight: 600, color: '#fff' }}>
            {t('modifyAttachment.title', 'Modify Attachment')}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="flex items-center justify-center rounded-full transition-colors hover:bg-white/10"
            style={{ width: '28px', height: '28px' }}
            aria-label={t('common.close', 'Close')}
          >
            <X size={16} style={{ color: 'rgba(255,255,255,0.5)' }} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 pb-3">
          {/* Desktop: side-by-side. Mobile: stacked. */}
          <div className="flex flex-col sm:flex-row gap-3">
            {/* Preview */}
            <div
              className="mx-auto sm:mx-0 shrink-0 rounded-lg overflow-hidden"
              style={{
                width: 'var(--preview-size)',
                height: 'var(--preview-size)',
                // Use CSS custom properties for responsive sizing
                // Mobile: 140px centered, Desktop: 80px side
              }}
            >
              {/* We use inline styles with media-query alternative via two containers */}
              <div className="hidden sm:block" style={{ width: '80px', height: '80px' }}>
                {preview}
              </div>
              <div className="block sm:hidden mx-auto" style={{ width: '140px', height: '140px', maxWidth: '100%' }}>
                {preview}
              </div>
            </div>

            {/* Fields */}
            <div className="flex-1 min-w-0 flex flex-col gap-2.5">
              {/* Filename */}
              <div>
                <label className="block text-[11px] font-medium mb-1" style={{ color: 'rgba(255,255,255,0.5)' }}>
                  {t('modifyAttachment.filename', 'Filename')}
                </label>
                <input
                  type="text"
                  value={localFilename}
                  onChange={(e) => setLocalFilename(e.target.value.slice(0, 255))}
                  maxLength={255}
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none transition-colors"
                  style={{
                    backgroundColor: '#0d1112',
                    border: '1px solid rgba(255,255,255,0.08)',
                    color: '#fff',
                  }}
                  onFocus={(e) => {
                    (e.target as HTMLInputElement).style.borderColor = '#5a8d77';
                  }}
                  onBlur={(e) => {
                    (e.target as HTMLInputElement).style.borderColor = 'rgba(255,255,255,0.08)';
                  }}
                />
              </div>

              {/* Description (Alt Text) */}
              <div>
                <label className="block text-[11px] font-medium mb-1" style={{ color: 'rgba(255,255,255,0.5)' }}>
                  {t('modifyAttachment.description', 'Description')}
                </label>
                <input
                  type="text"
                  value={localAlt}
                  onChange={(e) => setLocalAlt(e.target.value.slice(0, 500))}
                  maxLength={500}
                  placeholder={t('modifyAttachment.descriptionPlaceholder', 'Add a description')}
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none transition-colors placeholder:text-white/20"
                  style={{
                    backgroundColor: '#0d1112',
                    border: '1px solid rgba(255,255,255,0.08)',
                    color: '#fff',
                  }}
                  onFocus={(e) => {
                    (e.target as HTMLInputElement).style.borderColor = '#5a8d77';
                  }}
                  onBlur={(e) => {
                    (e.target as HTMLInputElement).style.borderColor = 'rgba(255,255,255,0.08)';
                  }}
                />
                {/* Char counter: desktop only */}
                <div className="hidden sm:block text-right mt-0.5">
                  <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.3)' }}>
                    {localAlt.length}/500
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Spoiler checkbox row */}
          <button
            type="button"
            onClick={() => setLocalIsSpoiler((v) => !v)}
            className="w-full flex items-center gap-3 mt-3 px-3 py-2.5 rounded-lg transition-colors hover:brightness-110 cursor-pointer"
            style={{ backgroundColor: '#0d1112' }}
          >
            <div
              className="shrink-0 flex items-center justify-center rounded-[3px] transition-colors"
              style={{
                width: '14px',
                height: '14px',
                backgroundColor: localIsSpoiler ? '#5a8d77' : 'transparent',
                border: localIsSpoiler ? '1px solid #5a8d77' : '1px solid rgba(255,255,255,0.2)',
              }}
            >
              {localIsSpoiler && <Check size={10} style={{ color: '#fff' }} />}
            </div>
            <span className="text-sm" style={{ color: 'rgba(255,255,255,0.8)' }}>
              {t('modifyAttachment.spoiler', 'Mark as Spoiler')}
            </span>
          </button>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 pb-4 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-[13px] font-semibold transition-colors hover:bg-white/5"
            style={{
              color: 'rgba(255,255,255,0.6)',
              border: '1px solid rgba(255,255,255,0.08)',
              backgroundColor: 'transparent',
            }}
          >
            {t('modifyAttachment.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="btn-cta px-4 py-2 rounded-xl text-[13px] font-semibold transition-opacity"
          >
            {t('modifyAttachment.save', 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}
