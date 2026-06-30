// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useRef, useEffect, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { cn } from '../../lib/utils';
import { X } from 'lucide-react';
import { IconButton } from './icon-button';

const maxWidths = {
  sm: 'max-w-[400px]',
  md: 'max-w-[520px]',
  lg: 'max-w-[640px]',
  xl: 'max-w-[800px]',
} as const;

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  size?: keyof typeof maxWidths;
  children: ReactNode;
  className?: string;
  /** Show default close button in top-right corner */
  showClose?: boolean;
}

export function Modal({ open, onClose, size = 'md', children, className, showClose = true }: ModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, open);

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, handleEscape]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4 modal-safe-area">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[8px] animate-in fade-in duration-200"
        onClick={onClose}
      />
      {/* Container */}
      <div
        ref={containerRef}
        className={cn(
          'relative w-full glass border rounded-[var(--radius-2xl)] shadow-elevation-xl spring-pop-in max-h-[90vh] overflow-y-auto',
          maxWidths[size],
          className,
        )}
      >
        {showClose && (
          <IconButton
            size="md"
            className="absolute top-4 right-4 z-10"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </IconButton>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Consistent modal header section */
export function ModalHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-7 pt-6 pb-2', className)}>{children}</div>;
}

/** Consistent modal body section */
export function ModalBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-7 pb-6', className)}>{children}</div>;
}

/** Consistent modal footer with top border */
export function ModalFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex justify-end gap-2 px-7 py-4 border-t border-default', className)}>
      {children}
    </div>
  );
}
