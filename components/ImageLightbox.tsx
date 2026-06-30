// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, ZoomIn, ZoomOut, Share2, Download, ExternalLink, Copy, Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { retryOnExpired, toOriginalUploadPath } from '../utils/signedImageRetry';
import { downloadBlob } from '../utils/downloadFile';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ImageLightboxProps {
  open: boolean;
  onClose: () => void;
  /** Blob URL or data URL for displaying (and download/copy/open). */
  imageDisplayUrl: string;
  /** Canonical URL for "Copy link" (e.g. API URL). */
  imageLinkUrl: string;
  fileName: string;
  fileSizeBytes?: number;
  /** When provided, Forward button opens this callback. Use attachmentUrlPath for API (path like /api/uploads/xxx). */
  onForwardClick?: (attachment: { url: string; name: string; contentType?: string }) => void;
  /** Path for forwarding (e.g. /api/uploads/xxx) so the API receives the same attachment reference. */
  attachmentUrlPath?: string;
  /** Content type for forwarding so the message stores it and displays as image in DMs. */
  attachmentContentType?: string;
}

const ZOOM_OUT_SCALE = 1;
const ZOOM_IN_SCALE = 2;

export const ImageLightbox: React.FC<ImageLightboxProps> = ({
  open,
  onClose,
  imageDisplayUrl,
  imageLinkUrl,
  fileName,
  fileSizeBytes,
  onForwardClick,
  attachmentUrlPath,
  attachmentContentType,
}) => {
  const { t } = useTranslation();
  const [scale, setScale] = useState(ZOOM_OUT_SCALE);
  const [copied, setCopied] = useState<'image' | 'link' | null>(null);

  const toggleImageZoom = () => setScale((s) => (s <= ZOOM_OUT_SCALE ? ZOOM_IN_SCALE : ZOOM_OUT_SCALE));

  React.useEffect(() => {
    if (open) setScale(ZOOM_OUT_SCALE);
  }, [open]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === 'Escape') onClose();
    },
    [open, onClose]
  );

  React.useEffect(() => {
    if (!open) return;
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, handleKeyDown]);

  const zoomIn = () => setScale((s) => Math.min(s + 0.25, 3));
  const zoomOut = () => setScale((s) => Math.max(s - 0.25, 0.5));

  const handleDownload = async () => {
    try {
      const parsed = new URL(imageDisplayUrl, window.location.origin);
      if (!['http:', 'https:', 'blob:'].includes(parsed.protocol)) return;
      const res = await fetch(parsed.href);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      await downloadBlob(blob, fileName);
    } catch {
      window.dispatchEvent(new CustomEvent('howl:download-toast', { detail: { message: 'Failed to download', type: 'warning' } }));
    }
  };

  const handleOpenInBrowser = () => {
    try {
      const parsed = new URL(imageDisplayUrl, window.location.origin);
      if (!['http:', 'https:', 'blob:'].includes(parsed.protocol)) return;
      window.open(parsed.href, '_blank', 'noopener,noreferrer');
    } catch {
      // malformed URL — do nothing
    }
  };

  const handleCopyImage = async () => {
    try {
      const res = await fetch(imageDisplayUrl);
      const blob = await res.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      setCopied('image');
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // ignore
    }
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(imageLinkUrl);
      setCopied('link');
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // ignore
    }
  };

  const handleForward = () => {
    if (onForwardClick) {
      onForwardClick({ url: attachmentUrlPath ?? imageLinkUrl, name: fileName, contentType: attachmentContentType });
      onClose();
    } else if (navigator.share) {
      fetch(imageDisplayUrl)
        .then((r) => r.blob())
        .then((blob) => {
          const file = new File([blob], fileName, { type: blob.type });
          return navigator.share({ files: [file], title: fileName });
        })
        .catch(() => handleCopyLink());
    } else {
      handleCopyLink();
    }
  };

  if (!open) return null;

  const btnClass =
    'p-2.5 rounded-lg transition-colors hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50';
  const iconClass = 'w-5 h-5';

  const overlay = (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/92 safe-area-top safe-area-bottom"
      style={{ zIndex: 'var(--z-max)' as unknown as number }}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={t('a11y.imagePreview')}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 left-4 p-2 rounded-lg hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50 z-10"
        style={{ color: 'var(--text-primary)' }}
        aria-label={t('a11y.close')}
      >
        <X size={24} />
      </button>

      {/* Top right toolbar */}
      <div className="absolute top-4 right-4 flex items-center gap-1 z-10" style={{ color: 'var(--text-primary)' }}>
        <button type="button" onClick={zoomIn} className={btnClass} title={t('lightbox.zoomIn')} aria-label={t('lightbox.zoomIn')}>
          <ZoomIn className={iconClass} />
        </button>
        <button type="button" onClick={zoomOut} className={btnClass} title={t('lightbox.zoomOut')} aria-label={t('lightbox.zoomOut')}>
          <ZoomOut className={iconClass} />
        </button>
        <button type="button" onClick={handleForward} className={btnClass} title={t('lightbox.forward')} aria-label={t('lightbox.forward')}>
          <Share2 className={iconClass} />
        </button>
        <button type="button" onClick={handleDownload} className={btnClass} title={t('lightbox.download')} aria-label={t('lightbox.download')}>
          <Download className={iconClass} />
        </button>
        <button type="button" onClick={handleOpenInBrowser} className={btnClass} title={t('lightbox.openInNewTab')} aria-label={t('lightbox.openInNewTab')}>
          <ExternalLink className={iconClass} />
        </button>
        <button type="button" onClick={handleCopyImage} className={btnClass} title={t('lightbox.copyImage')} aria-label={t('lightbox.copyImage')}>
          <Copy className={iconClass} />
          {copied === 'image' && <span className="sr-only">{t('common.copied')}</span>}
        </button>
        <button type="button" onClick={handleCopyLink} className={btnClass} title={t('lightbox.copyLink')} aria-label={t('lightbox.copyLink')}>
          <Link2 className={iconClass} />
          {copied === 'link' && <span className="sr-only">{t('common.copied')}</span>}
        </button>
      </div>

      {/* Image area - click on image toggles zoom */}
      <div
        className="flex items-center justify-center min-w-0 min-h-0 p-4 max-w-[95vw] max-h-[90vh] cursor-zoom-in"
        style={{ cursor: scale <= ZOOM_OUT_SCALE ? 'zoom-in' : 'zoom-out' }}
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={sanitizeImgSrc(imageDisplayUrl) || (imageDisplayUrl.startsWith('blob:') ? imageDisplayUrl : '')}
          alt={fileName}
          className="max-w-full max-h-[85vh] w-auto h-auto object-contain select-none"
          style={{ transform: `scale(${scale})` }}
          draggable={false}
          data-original-src={toOriginalUploadPath(attachmentUrlPath) ?? toOriginalUploadPath(imageDisplayUrl)}
          onError={retryOnExpired}
          onClick={(e) => { e.stopPropagation(); toggleImageZoom(); }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleImageZoom(); } }}
          aria-label={scale <= ZOOM_OUT_SCALE ? t('lightbox.zoomIn') : t('lightbox.zoomOut')}
        />
      </div>

      {/* Bottom right: file name and size */}
      <div
        className="absolute bottom-4 right-4 px-3 py-2 rounded-lg text-sm z-10"
        style={{ backgroundColor: 'var(--overlay-backdrop)', backdropFilter: 'blur(8px)', color: 'var(--text-primary)' }}
      >
        <span className="font-medium truncate max-w-[200px] inline-block align-middle">{fileName}</span>
        {fileSizeBytes != null && (
          <span className="ml-2 opacity-80">{formatFileSize(fileSizeBytes)}</span>
        )}
      </div>

      {/* Copied toast */}
      {copied && (
        <div
          className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-sm z-20"
          style={{ backgroundColor: 'var(--cyan-accent)', color: 'var(--text-on-accent)' }}
        >
          {copied === 'image' ? t('common.imageCopied') : t('common.linkCopied')}
        </div>
      )}
    </div>
  );

  return createPortal(overlay, document.body);
};
