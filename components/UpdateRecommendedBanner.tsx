// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { X as CloseIcon } from 'lucide-react';
import { useUpdateStore } from '../stores/updateStore';

export function UpdateRecommendedBanner() {
  const { recommended, required, dismissRecommended } = useUpdateStore();
  if (!recommended || required) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[9000] flex items-start gap-3 pl-4 pr-3 py-3 rounded-xl border max-w-xs"
      style={{
        backgroundColor: 'var(--bg-floating)',
        borderColor: 'var(--warning-subtle)',
        backdropFilter: 'blur(20px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px var(--warning-subtle) inset',
      }}
    >
      <div
        className="w-2 h-2 rounded-full shrink-0 mt-1"
        style={{
          backgroundColor: 'var(--warning)',
          boxShadow: '0 0 6px var(--warning)',
        }}
      />
      <p className="flex-1 text-xs font-medium leading-snug" style={{ color: 'var(--text-primary)' }}>
        A new version of Howl is available. Restart when ready.
      </p>
      <button
        type="button"
        aria-label="dismiss"
        onClick={() => dismissRecommended()}
        className="p-1 rounded-lg hover:bg-fill-active transition-colors shrink-0"
        style={{ color: 'var(--text-secondary)' }}
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
}
