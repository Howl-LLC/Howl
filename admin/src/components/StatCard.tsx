// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { CARD } from './styles';

type StatColor = 'cyan' | 'green' | 'red' | 'blue' | 'violet' | 'emerald' | 'amber' | 'slate';

interface StatCardProps {
  label: string;
  value: number | string;
  icon: LucideIcon;
  color: StatColor;
  accent?: boolean;
  change?: string;
  changeType?: 'up' | 'down' | 'neutral';
}

const COLOR_MAP: Record<StatColor, { gradient: string; border: string; iconColor: string; accentBorder: string }> = {
  cyan:    { gradient: 'from-cyan-500/20 to-cyan-600/10',    border: 'border-cyan-500/20',    iconColor: 'text-cyan-400',    accentBorder: 'border-cyan-500/30' },
  green:   { gradient: 'from-green-500/20 to-green-600/10',  border: 'border-green-500/20',   iconColor: 'text-green-400',   accentBorder: 'border-green-500/30' },
  red:     { gradient: 'from-red-500/20 to-red-600/10',      border: 'border-red-500/20',     iconColor: 'text-red-400',     accentBorder: 'border-red-500/30' },
  blue:    { gradient: 'from-blue-500/20 to-blue-600/10',    border: 'border-blue-500/20',    iconColor: 'text-blue-400',    accentBorder: 'border-blue-500/30' },
  violet:  { gradient: 'from-violet-500/20 to-violet-600/10', border: 'border-violet-500/20', iconColor: 'text-violet-400',  accentBorder: 'border-violet-500/30' },
  emerald: { gradient: 'from-emerald-500/20 to-emerald-600/10', border: 'border-emerald-500/20', iconColor: 'text-emerald-400', accentBorder: 'border-emerald-500/30' },
  amber:   { gradient: 'from-amber-500/20 to-amber-600/10', border: 'border-amber-500/20',   iconColor: 'text-amber-400',   accentBorder: 'border-amber-500/30' },
  slate:   { gradient: 'from-slate-500/20 to-slate-600/10', border: 'border-slate-500/20',    iconColor: 'text-slate-400',   accentBorder: 'border-slate-500/30' },
};

const CHANGE_STYLE: Record<string, string> = {
  up: 'text-emerald-400',
  down: 'text-red-400',
  neutral: 'text-slate-500',
};

export const StatCard: React.FC<StatCardProps> = ({ label, value, icon: Icon, color, accent, change, changeType }) => {
  const c = COLOR_MAP[color];
  const displayValue = typeof value === 'number' ? value.toLocaleString() : value;

  return (
    <div className={`${CARD} p-5 hover:scale-[1.02] transition-transform duration-200 group cursor-default ${accent ? `relative ${c.accentBorder}` : ''}`}>
      {accent && (
        <div
          className={`absolute top-0 left-4 right-4 h-px bg-gradient-to-r ${c.gradient} opacity-60`}
          style={{ borderRadius: '0 0 2px 2px' }}
        />
      )}
      <div className="flex items-center justify-between mb-3">
        <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${c.gradient} border ${c.border} flex items-center justify-center ${c.iconColor} group-hover:scale-110 transition-transform duration-200`}>
          <Icon size={20} />
        </div>
        {change && changeType && (
          <span className={`text-xs font-semibold ${CHANGE_STYLE[changeType]}`}>
            {changeType === 'up' ? '\u2191' : changeType === 'down' ? '\u2193' : '\u2022'} {change}
          </span>
        )}
      </div>
      <div className="text-3xl font-bold text-white tracking-tight">{displayValue}</div>
      <div className="text-xs text-slate-500 mt-1 font-medium">{label}</div>
    </div>
  );
};
