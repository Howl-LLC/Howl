// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { Crown, Shield, Zap, ShieldCheck, Bug, Heart, BadgeCheck } from 'lucide-react';

export interface ProfileBadgesProps {
  badges?: string[];
  size?: 'sm' | 'md';
}

const BADGE_CONFIG: Record<string, { icon: React.ReactNode; label: string; bg: string; border: string; text: string }> = {
  pro: {
    icon: <Crown size={10} />,
    label: 'Howl Pro',
    bg: 'bg-gradient-to-r from-[var(--cyan-accent)]/20 to-purple-500/20',
    border: 'border-[var(--cyan-accent)]/40',
    text: 'text-[var(--cyan-accent)]',
  },
  pro_essential: {
    icon: <Zap size={10} />,
    label: 'Essential',
    bg: 'bg-emerald-500/15',
    border: 'border-emerald-500/30',
    text: 'text-emerald-400',
  },
  beta: {
    icon: <Shield size={10} />,
    label: 'Beta',
    bg: 'bg-amber-500/15',
    border: 'border-amber-500/30',
    text: 'text-amber-400',
  },
  staff: {
    icon: <ShieldCheck size={10} />,
    label: 'Staff',
    bg: 'bg-rose-500/15',
    border: 'border-rose-500/30',
    text: 'text-rose-400',
  },
  bug_hunter: {
    icon: <Bug size={10} />,
    label: 'Bug Hunter',
    bg: 'bg-lime-500/15',
    border: 'border-lime-500/30',
    text: 'text-lime-400',
  },
  early_supporter: {
    icon: <Heart size={10} />,
    label: 'Early Supporter',
    bg: 'bg-pink-500/15',
    border: 'border-pink-500/30',
    text: 'text-pink-400',
  },
  verified: {
    icon: <BadgeCheck size={10} />,
    label: 'Verified',
    bg: 'bg-sky-500/15',
    border: 'border-sky-500/30',
    text: 'text-sky-400',
  },
};

export const BADGE_DEFAULT_ORDER = ['staff', 'verified', 'pro', 'pro_essential', 'beta', 'bug_hunter', 'early_supporter'];

export const ProfileBadges: React.FC<ProfileBadgesProps> = ({ badges, size = 'md' }) => {
  if (!badges || badges.length === 0) return null;

  // Render in the order received - the backend sends a curated, ordered list.
  const visible = badges.filter(b => BADGE_CONFIG[b]);
  if (visible.length === 0) return null;

  const px = size === 'sm' ? 'px-1 py-px' : 'px-1.5 py-0.5';
  const textSize = size === 'sm' ? 'text-[7px]' : 'text-[8px]';
  const iconSize = size === 'sm' ? 8 : 10;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {visible.map(key => {
        const cfg = BADGE_CONFIG[key];
        if (!cfg) return null;
        return (
          <span
            key={key}
            className={`inline-flex items-center gap-0.5 ${px} rounded-md border font-bold uppercase tracking-wider ${cfg.bg} ${cfg.border} ${cfg.text} ${textSize}`}
            title={cfg.label}
          >
            {React.cloneElement(cfg.icon as React.ReactElement<{ size?: number }>, { size: iconSize })}
            {cfg.label}
          </span>
        );
      })}
    </div>
  );
};
