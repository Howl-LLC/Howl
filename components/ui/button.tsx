// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const base =
  'inline-flex items-center justify-center gap-2 font-semibold transition-all duration-150 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] focus-visible:ring-2 focus-visible:ring-[var(--cyan-accent)]/40 focus-visible:outline-none disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none active:scale-[0.98]';

const variants = {
  // primary === the landing-page "Get Howl" CTA. Driven by the shared
  // .btn-cta class (app.css) so every primary button matches it exactly.
  primary: 'btn-cta',
  secondary: 'btn-secondary',
  ghost:
    'bg-transparent text-[var(--text-secondary)] hover:bg-fill-hover hover:text-[var(--text-primary)]',
  danger: 'btn-danger-soft',
  // solid destructive CTA — shared .btn-cta-danger class (app.css).
  'danger-solid': 'btn-cta-danger',
} as const;

const sizes = {
  sm: 'px-3 py-1.5 text-xs rounded-[var(--radius-md)]',
  md: 'px-5 py-2.5 text-sm rounded-[var(--radius-md)]',
  lg: 'px-6 py-3 text-base rounded-[var(--radius-lg)]',
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading, className, children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(base, variants[variant], sizes[size], className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading && (
        <span className="inline-block w-4 h-4 border-2 border-current/30 border-t-current rounded-full animate-spin" />
      )}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';
