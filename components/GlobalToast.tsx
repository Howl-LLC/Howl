// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { X as CloseIcon } from 'lucide-react';
import { motion } from 'motion/react';

interface GlobalToastProps {
  id: string;
  message: string;
  type: 'info' | 'warning';
  onDismiss: () => void;
  actionLabel?: string;
  onAction?: () => void;
}

const GlobalToast: React.FC<GlobalToastProps> = ({ id, message, type, onDismiss, actionLabel, onAction }) => {
  const isWarning = type === 'warning';
  return (
    <motion.div
      key={id}
      initial={{ opacity: 0, y: -20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -20, scale: 0.95 }}
      transition={{ duration: 0.15, ease: [0.25, 0.46, 0.45, 0.94] }}
      className="fixed top-6 left-1/2 -translate-x-1/2 z-[var(--z-toast)] flex items-center gap-3 pl-4 pr-3 py-3 rounded-xl border animate-in slide-in-from-top-2 fade-in duration-200"
      style={{
        backgroundColor: 'var(--bg-floating)',
        borderColor: isWarning ? 'var(--warning-subtle)' : 'var(--glass-border)',
        backdropFilter: 'blur(20px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
        boxShadow: `0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px ${isWarning ? 'var(--warning-subtle)' : 'var(--fill-hover)'} inset`,
        maxWidth: 420,
      }}
    >
      <div
        className="w-2 h-2 rounded-full shrink-0"
        style={{
          backgroundColor: isWarning ? 'var(--warning)' : 'var(--cyan-accent)',
          boxShadow: `0 0 6px ${isWarning ? 'var(--warning)' : 'var(--cyan-accent)'}`,
        }}
      />
      <p className="text-xs font-medium leading-snug" style={{ color: 'var(--text-primary)' }}>
        {message}
      </p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="btn-cta ml-1 px-2.5 py-1 text-xs font-semibold shrink-0"
          style={{ borderRadius: 8 }}
        >
          {actionLabel}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="ml-1 p-1 rounded-lg hover:bg-fill-active transition-colors shrink-0"
        style={{ color: 'var(--text-secondary)' }}
      >
        <CloseIcon size={12} />
      </button>
    </motion.div>
  );
};

export default GlobalToast;
