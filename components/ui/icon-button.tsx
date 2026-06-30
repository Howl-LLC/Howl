// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const base =
  'inline-flex items-center justify-center bg-transparent text-[var(--text-secondary)] hover:bg-fill-hover hover:text-[var(--text-primary)] active:scale-90 transition-all duration-[120ms] ease focus-visible:ring-2 focus-visible:ring-[var(--cyan-accent)]/40 focus-visible:outline-none disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none';

const sizes = {
  sm: 'w-7 h-7 rounded-[var(--radius-sm)]',
  md: 'w-8 h-8 rounded-[var(--radius-md)]',
  lg: 'w-9 h-9 rounded-[var(--radius-md)]',
} as const;

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: keyof typeof sizes;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ size = 'md', className, children, ...props }, ref) => (
    <button ref={ref} className={cn(base, sizes[size], className)} {...props}>
      {children}
    </button>
  ),
);
IconButton.displayName = 'IconButton';
