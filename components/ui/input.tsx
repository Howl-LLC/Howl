// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const base =
  'w-full bg-input-surface border border-[var(--glass-border)] rounded-[var(--radius-md)] px-4 py-3 text-sm text-t-primary placeholder:text-t-secondary/60 outline-none transition-[border-color,box-shadow] duration-150 ease focus:border-accent-muted focus:shadow-[0_0_0_3px_var(--accent-subtle)]';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, className, ...props }, ref) => (
    <div>
      {label && (
        <label className="block text-[11px] font-semibold tracking-wide mb-2 text-t-secondary">
          {label}
        </label>
      )}
      <input ref={ref} className={cn(base, className)} {...props} />
    </div>
  ),
);
Input.displayName = 'Input';
