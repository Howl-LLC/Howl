// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';

interface FilterOption {
  value: string;
  label: string;
}

interface FilterChipsProps {
  options: FilterOption[];
  value: string;
  onChange: (value: string) => void;
}

export const FilterChips: React.FC<FilterChipsProps> = ({ options, value, onChange }) => {
  return (
    <div className="flex gap-1 flex-wrap">
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 border ${
            value === option.value
              ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'
              : 'text-slate-400 border-white/[0.06] hover:bg-white/5 hover:text-white'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
};
