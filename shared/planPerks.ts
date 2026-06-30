// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
export type PlanTier = null | 'essential' | 'pro';

export function getPlanPerks(plan: PlanTier) {
  return {
    maxUploadMB: plan === 'pro' ? 500 : plan === 'essential' ? 100 : 50,
    maxImportMB: plan === 'pro' ? 500 : plan === 'essential' ? 200 : 50,
    maxScreenShareRes: plan === 'pro' ? '1440p' as const : '1080p' as const,
    maxScreenShareFps: (plan ? 60 : 30) as 30 | 60,
    canUploadBanner: plan === 'essential' || plan === 'pro',
    canChangeDiscriminator: plan === 'essential' || plan === 'pro',
    maxVoiceBitrate: plan === 'pro' ? 384 : plan === 'essential' ? 128 : 96,
    maxCameraBitrate: plan === 'pro' ? 10_000_000 : plan === 'essential' ? 5_500_000 : 3_000_000,
    maxCameraFps: (plan === 'pro' ? 60 : 30) as 30 | 60,
    maxCameraRes: (plan === 'pro' ? '1440p' : plan === 'essential' ? '1080p' : '720p') as '720p' | '1080p' | '1440p',
    maxScreenShareBitrate: plan === 'pro' ? 7_000_000 : plan === 'essential' ? 4_000_000 : 2_500_000,
    universalEmoji: plan === 'essential' || plan === 'pro',
    canCustomNameColor: plan === 'pro',
    canCustomNameFont: plan === 'pro',
    canColoredText: plan === 'pro',
    canProfileEffects: plan === 'pro',
    canNameEffects: plan === 'pro',
    canCustomBackground: plan === 'essential' || plan === 'pro',
    // Showcase
    maxShowcaseCards: plan === 'pro' ? 12 : plan === 'essential' ? 4 : 2,
    showcaseAllSizes: plan === 'essential' || plan === 'pro',
    showcaseHeroSize: plan === 'pro',
    showcaseAutoRefreshHours: plan === 'pro' ? 12 : plan === 'essential' ? 12 : 24,
    showcaseManualRefreshHours: plan === 'pro' ? 1 : plan === 'essential' ? 6 : 24,
    showcaseCustomText: plan === 'pro',
    showcaseSteamPlaytime: plan === 'essential' || plan === 'pro',
    showcaseMobileLayout: plan === 'essential' || plan === 'pro',
    canCustomVideoBackground: plan === 'essential' || plan === 'pro',
  };
}

export const PLAN_LABELS: Record<string, string> = {
  essential: 'Howl Pro Essential',
  pro: 'Howl Pro',
};

export const NAME_FONTS: { key: string; label: string; family: string }[] = [
  { key: 'default', label: 'Default', family: 'inherit' },
  { key: 'serif', label: 'Serif', family: "'Georgia', serif" },
  { key: 'mono', label: 'Monospace', family: "'JetBrains Mono', ui-monospace, monospace" },
  { key: 'handwritten', label: 'Handwritten', family: "'Pacifico', cursive" },
  { key: 'rounded', label: 'Rounded', family: "'Nunito', 'Varela Round', sans-serif" },
  { key: 'pixel', label: 'Pixel', family: "'Press Start 2P', 'VT323', monospace" },
  { key: 'elegant', label: 'Elegant', family: "'Playfair Display', 'Didot', serif" },
  { key: 'display', label: 'Display', family: "'Clash Display', 'Satoshi', sans-serif" },
  { key: 'bold', label: 'Bold', family: "'Satoshi', sans-serif" },
  { key: 'futuristic', label: 'Futuristic', family: "'Orbitron', sans-serif" },
  { key: 'spaced', label: 'Spaced', family: 'inherit' },
  { key: 'script', label: 'Script', family: "'Caveat', cursive" },
  { key: 'verdana', label: 'Verdana', family: "'Verdana', Geneva, sans-serif" },
  { key: 'comic-sans', label: 'Comic Sans', family: "'Comic Sans MS', 'Comic Sans', cursive" },
  { key: 'dyslexie', label: 'Dyslexie', family: "'OpenDyslexic', 'Verdana', sans-serif" },
];

export const AVATAR_EFFECTS: { key: string; label: string }[] = [
  { key: 'none', label: 'None' },
  { key: 'glow-cyan', label: 'Cyan Glow' },
  { key: 'glow-purple', label: 'Purple Glow' },
  { key: 'glow-gold', label: 'Gold Glow' },
  { key: 'glow-rose', label: 'Rose Glow' },
  { key: 'glow-emerald', label: 'Emerald Glow' },
  { key: 'ring-animated', label: 'Pulse Ring' },
  { key: 'ring-rainbow', label: 'Rainbow Ring' },
  { key: 'ring-fire', label: 'Fire Ring' },
  { key: 'sparkle', label: 'Sparkle' },
  { key: 'breathe', label: 'Breathe' },
  { key: 'shadow-neon', label: 'Neon' },
];

export const NAME_EFFECTS: { key: string; label: string }[] = [
  { key: 'none', label: 'None' },
  { key: 'glow', label: 'Glow' },
  { key: 'rainbow', label: 'Rainbow' },
  { key: 'shimmer', label: 'Shimmer' },
  { key: 'fire', label: 'Fire' },
  { key: 'neon', label: 'Neon' },
  { key: 'pulse', label: 'Pulse' },
  { key: 'gradient', label: 'Gradient' },
];

const VALID_AVATAR_EFFECTS = new Set(AVATAR_EFFECTS.map(e => e.key));

export function getAvatarEffectClass(effect?: string | null): string {
  if (!effect || effect === 'none') return '';
  if (!VALID_AVATAR_EFFECTS.has(effect)) return '';
  return `avatar-effect-${effect}`;
}

/** Flat shape for resolveProNameStyle — covers user records and anything mapped to it. */
export interface NameCustomizable {
  effectivePlan?: string | null;
  stripePlan?: string | null;
  nameColor?: string | null;
  nameFont?: string | null;
  nameEffect?: string | null;
}

/**
 * Pro-gated name-style props to spread into <RoleNameStyle>, or null when the
 * user isn't Pro or has no name customization set. Centralizes the
 * `(effectivePlan || stripePlan) === 'pro' && (color || font || effect)` gate
 * otherwise copy-pasted across chat/call/DM sites, so the rule and the
 * effectivePlan→stripePlan fallback live in one place. Callers still pick the
 * source object (own user vs looked-up member vs message author fields).
 */
export function resolveProNameStyle(
  u?: NameCustomizable | null,
): { overrideColor?: string | null; overrideFont?: string | null; nameEffect?: string | null } | null {
  if (!u) return null;
  if ((u.effectivePlan || u.stripePlan) !== 'pro') return null;
  if (!u.nameColor && !u.nameFont && !u.nameEffect) return null;
  return { overrideColor: u.nameColor, overrideFont: u.nameFont, nameEffect: u.nameEffect };
}
