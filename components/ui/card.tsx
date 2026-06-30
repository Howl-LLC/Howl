// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

const levels = {
  raised: 'bg-panel border border-[var(--glass-border)] shadow-elevation-sm rounded-[var(--radius-xl)]',
  floating: 'glass border rounded-[var(--radius-2xl)]',
} as const;

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  level?: keyof typeof levels;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ level = 'raised', className, children, ...props }, ref) => (
    <div ref={ref} className={cn(levels[level], className)} {...props}>
      {children}
    </div>
  ),
);
Card.displayName = 'Card';

/** Card section with optional title */
export function CardSection({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('p-5', className)}>
      {title && (
        <h3 className="font-bold text-xs uppercase tracking-wider mb-4 text-t-primary">{title}</h3>
      )}
      {children}
    </div>
  );
}
