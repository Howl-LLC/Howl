// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/** Shared style constants for the Howl admin panel. */

export const INPUT_CLS =
  'w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500/40 focus:bg-white/[0.06] transition-all duration-200';

/** Search input with left icon padding — avoids Tailwind v4 px/pl shorthand conflict. */
export const SEARCH_INPUT_CLS =
  'w-full pl-11 pr-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500/40 focus:bg-white/[0.06] transition-all duration-200';

export const BTN_PRIMARY =
  'px-5 py-2.5 rounded-xl bg-cyan-500/15 text-cyan-300 border border-cyan-500/25 text-sm font-semibold hover:bg-cyan-500/25 hover:border-cyan-500/40 disabled:opacity-30 transition-all duration-200';

export const BTN_GHOST =
  'p-2.5 rounded-xl text-slate-400 hover:text-white hover:bg-white/[0.06] transition-all duration-200';

export const CARD =
  'rounded-2xl border border-white/[0.06] bg-gradient-to-b from-white/[0.03] to-white/[0.01] backdrop-blur-sm';

export const TABLE_HEAD = 'bg-white/[0.03] text-left';

export const SELECT_CLS =
  'px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white text-sm focus:outline-none focus:border-cyan-500/40 transition-all duration-200 [&>option]:bg-[#0a0f1e] cursor-pointer appearance-none';
