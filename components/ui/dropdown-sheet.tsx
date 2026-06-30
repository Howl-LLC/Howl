// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { FloatingPortal } from '@floating-ui/react';
import type { ReactNode } from 'react';
import { useEffect } from 'react';

export interface DropdownSheetProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
}

export function DropdownSheet({ isOpen, onClose, children, labelledBy }: DropdownSheetProps) {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <FloatingPortal>
      <div
        data-testid="dropdown-sheet-root"
        className="fixed inset-0 z-[500] flex items-end"
        aria-labelledby={labelledBy}
      >
        <button
          type="button"
          aria-label="Close"
          className="absolute inset-0 w-full h-full bg-black/40 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={onClose}
        />
        <div
          className="relative w-full max-h-[70vh] rounded-t-2xl border-t shadow-2xl animate-in slide-in-from-bottom duration-200"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            borderColor: 'var(--glass-border)',
            color: 'var(--text-primary)',
          }}
        >
          <div
            aria-hidden
            className="mx-auto mt-2 mb-2 h-1.5 w-10 rounded-full"
            style={{ backgroundColor: 'var(--text-tertiary)' }}
          />
          {children}
        </div>
      </div>
    </FloatingPortal>
  );
}
