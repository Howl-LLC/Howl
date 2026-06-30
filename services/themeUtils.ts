// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/** Custom theme colors (user-picked). Stored in localStorage when theme is 'custom'. */
export interface CustomThemeColors {
  accent: string;
  bgApp: string;
  /** Status-bar background hex; converted to translucent rgba at apply-time so the glass blur shows through. If unset, defaults to a darkened/lightened bgApp. */
  bgStatusBar?: string;
  textPrimary?: string;
  textSecondary?: string;
}

/** Matches valid CSS color values for theme text: #hex or rgba(...) */
function isValidThemeColor(value: string): boolean {
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return true;
  const trimmed = value.trim();
  const match = trimmed.match(/^(rgb|rgba)\(([^)]*)\)$/);
  if (!match) return false;
  const parts = match[2].split(',').map((s) => s.trim());
  if (parts.length === 3) {
    return parts.every((p) => /^\d{1,3}$/.test(p));
  }
  if (parts.length === 4) {
    const rgb = parts.slice(0, 3).every((p) => /^\d{1,3}$/.test(p));
    const alpha = /^(0|1|0?\.\d+)$/.test(parts[3]);
    return rgb && alpha;
  }
  return false;
}

const STORAGE_KEY = 'app_theme_custom';

const defaultCustom: CustomThemeColors = {
  accent: '#076FA0',
  bgApp: '#0c0e13',
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((c) => c / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Darken hex by factor (0–1 multiplies each channel). */
function darkenHex(hex: string, factor: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const f = (x: number) => Math.round(Math.max(0, Math.min(255, x * factor)));
  return `#${[f(rgb.r), f(rgb.g), f(rgb.b)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** Lighten hex by moving toward white (amount 0–1). */
function lightenHex(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const f = (x: number) => Math.round(x + (255 - x) * amount);
  return `#${[f(rgb.r), f(rgb.g), f(rgb.b)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** Derive full CSS variable set from accent + bg. Used when applying custom theme. */
export function customThemeToCssVars(colors: CustomThemeColors): Record<string, string> {
  const { accent, bgApp } = colors;
  const isDark = luminance(bgApp) < 0.5;
  const textPrimary = colors.textPrimary ?? (isDark ? '#f1f5f9' : '#0f172a');
  const textSecondary = colors.textSecondary ?? (isDark ? 'rgba(241, 245, 249, 0.5)' : '#64748b');
  const rgb = hexToRgb(accent);
  const bgRgb = hexToRgb(bgApp);
  const glowRgba = rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)` : 'rgba(7, 111, 160, 0.3)';
  /* Panel/sidebar: use darkened variant of bgApp so boxes and sidebar differentiate from main background */
  const veryDark = isDark && luminance(bgApp) < 0.02;
  const panelHex = bgRgb
    ? (veryDark ? lightenHex(bgApp, 0.04) : darkenHex(bgApp, isDark ? 0.82 : 0.92))
    : (isDark ? '#0f172a' : '#e2e8f0');
  const sidebarHex = bgRgb
    ? (veryDark ? lightenHex(bgApp, 0.02) : darkenHex(bgApp, isDark ? 0.75 : 0.88))
    : (isDark ? '#020617' : '#f1f5f9');
  const panelRgba = panelHex;
  const sidebarRgba = sidebarHex;
  const chatRgba = bgRgb ? `rgba(${bgRgb.r}, ${bgRgb.g}, ${bgRgb.b}, 0.2)` : (isDark ? 'rgba(2, 6, 23, 0.2)' : 'rgba(255, 255, 255, 0.1)');
  const statusBarBg = pickedHexToStatusBarRgba(colors.bgStatusBar) ?? chatRgba;

  const glassBg = bgRgb
    ? `rgba(${bgRgb.r}, ${bgRgb.g}, ${bgRgb.b}, ${isDark ? 0.72 : 0.62})`
    : (isDark ? 'rgba(10, 15, 30, 0.72)' : 'rgba(255, 255, 255, 0.62)');
  const glassBorder = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)';

  // Design system tokens — these use color-mix which resolves against the computed
  // values of --text-primary and --cyan-accent, so they adapt automatically.
  // We also include them here for custom themes so they resolve correctly when
  // custom CSS properties are applied via inline style overrides on :root.
  const fillHover = `color-mix(in srgb, ${textPrimary} 6%, transparent)`;
  const fillActive = `color-mix(in srgb, ${textPrimary} 10%, transparent)`;
  const fillSelected = `color-mix(in srgb, ${accent} 10%, transparent)`;
  const fillSelectedHover = `color-mix(in srgb, ${accent} 16%, transparent)`;
  const accentSubtle = `color-mix(in srgb, ${accent} 8%, transparent)`;
  const accentMuted = `color-mix(in srgb, ${accent} 15%, transparent)`;
  const accentEmphasis = `color-mix(in srgb, ${accent} 25%, transparent)`;

  return {
    '--cyan-accent': accent,
    // CTA fill: darkened accent so the solid button keeps strong white-text
    // contrast (mirrors how the default themes use a deep navy, not the raw
    // mid-bright accent). Tracks the user's chosen accent hue.
    '--cta-bg': darkenHex(accent, 0.5),
    '--bg-app': bgApp,
    '--bg-panel': panelRgba,
    '--bg-sidebar': sidebarRgba,
    '--bg-chat': chatRgba,
    '--bg-input': bgRgb ? darkenHex(bgApp, isDark ? 0.65 : 0.95) : (isDark ? 'rgba(0, 0, 0, 0.6)' : 'rgba(255, 255, 255, 0.8)'),
    '--bg-statusbar': statusBarBg,
    '--text-primary': textPrimary,
    '--text-secondary': textSecondary,
    '--text-tertiary': isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)',
    '--border-subtle': isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.08)',
    '--accent-glow': glowRgba,
    '--glass-bg': glassBg,
    '--glass-border': glassBorder,
    '--spoiler-overlay': isDark ? 'rgba(255, 255, 255, 0.88)' : 'rgba(0, 0, 0, 0.85)',
    '--overlay-backdrop': isDark ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.5)',
    '--bg-code': `color-mix(in srgb, ${textPrimary} 3%, transparent)`,
    '--bg-skeleton': `color-mix(in srgb, ${textPrimary} 6%, transparent)`,
    '--bg-skeleton-subtle': `color-mix(in srgb, ${textPrimary} 4%, transparent)`,
    '--text-on-accent': isDark ? '#0f172a' : '#ffffff',
    '--text-faint': isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)',
    '--status-online': '#10b981',
    '--status-idle': '#f59e0b',
    '--status-dnd': '#ef4444',
    '--status-offline': isDark ? '#64748b' : '#94a3b8',
    '--glass-shadow': isDark
      ? '0 0 0 1px rgba(255,255,255,0.04) inset, 0 8px 32px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3)'
      : '0 0 0 1px rgba(0,0,0,0.03) inset, 0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)',
    '--divider': isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)',
    '--fill-hover': fillHover,
    '--fill-active': fillActive,
    '--fill-strong': `color-mix(in srgb, ${textPrimary} 15%, transparent)`,
    '--fill-stronger': `color-mix(in srgb, ${textPrimary} 20%, transparent)`,
    '--border-strong': `color-mix(in srgb, ${textPrimary} 12%, transparent)`,
    '--fill-selected': fillSelected,
    '--fill-selected-hover': fillSelectedHover,
    '--accent-subtle': accentSubtle,
    '--accent-muted': accentMuted,
    '--accent-emphasis': accentEmphasis,
    '--scrollbar-thumb': isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.15)',
    '--scrollbar-thumb-hover': isDark ? 'rgba(255, 255, 255, 0.25)' : 'rgba(0, 0, 0, 0.25)',
    '--scrollbar-thumb-active': isDark ? 'rgba(255, 255, 255, 0.35)' : 'rgba(0, 0, 0, 0.35)',
  };
}

const CUSTOM_VAR_KEYS = [
  '--cyan-accent', '--cta-bg', '--bg-app', '--bg-panel', '--bg-sidebar', '--bg-chat', '--bg-input', '--bg-statusbar',
  '--text-primary', '--text-secondary', '--text-tertiary', '--border-subtle', '--accent-glow',
  '--glass-bg', '--glass-border', '--spoiler-overlay',
  '--overlay-backdrop', '--bg-code', '--bg-skeleton', '--bg-skeleton-subtle',
  '--text-on-accent', '--text-faint',
  '--status-online', '--status-idle', '--status-dnd', '--status-offline',
  '--glass-shadow', '--divider',
  '--fill-hover', '--fill-active', '--fill-strong', '--fill-stronger', '--border-strong', '--fill-selected', '--fill-selected-hover',
  '--accent-subtle', '--accent-muted', '--accent-emphasis',
  '--scrollbar-thumb', '--scrollbar-thumb-hover', '--scrollbar-thumb-active',
];

export function applyCustomTheme(colors: CustomThemeColors): void {
  const vars = customThemeToCssVars(colors);
  const el = document.documentElement;
  CUSTOM_VAR_KEYS.forEach((key) => {
    const value = vars[key];
    if (value != null) el.style.setProperty(key, value);
  });
}

export function clearCustomTheme(): void {
  CUSTOM_VAR_KEYS.forEach((key) => document.documentElement.style.removeProperty(key));
}

export function getStoredCustomTheme(): CustomThemeColors {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...defaultCustom };
    const parsed = JSON.parse(raw) as Partial<CustomThemeColors> & { bgFloating?: string };
    const explicitStatusBar = (parsed.bgStatusBar && isValidThemeColor(parsed.bgStatusBar)) ? parsed.bgStatusBar : undefined;
    const legacyFloating = (parsed.bgFloating && isValidThemeColor(parsed.bgFloating)) ? parsed.bgFloating : undefined;
    return {
      accent: parsed.accent ?? defaultCustom.accent,
      bgApp: parsed.bgApp ?? defaultCustom.bgApp,
      bgStatusBar: explicitStatusBar ?? legacyFloating,
      textPrimary: (parsed.textPrimary && isValidThemeColor(parsed.textPrimary)) ? parsed.textPrimary : undefined,
      textSecondary: (parsed.textSecondary && isValidThemeColor(parsed.textSecondary)) ? parsed.textSecondary : undefined,
    };
  } catch {
    return { ...defaultCustom };
  }
}

export function saveCustomTheme(colors: CustomThemeColors): void {
  const canonical: Record<string, string> = { accent: colors.accent, bgApp: colors.bgApp };
  if (colors.bgStatusBar) canonical.bgStatusBar = colors.bgStatusBar;
  if (colors.textPrimary) canonical.textPrimary = colors.textPrimary;
  if (colors.textSecondary) canonical.textSecondary = colors.textSecondary;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(canonical));
}

/** Default status-bar hex when bgStatusBar is not set (for picker display). */
export function getDefaultStatusBarHex(colors: Pick<CustomThemeColors, 'bgApp'>): string {
  const isDark = luminance(colors.bgApp) < 0.5;
  return isDark ? darkenHex(colors.bgApp, 0.5) : lightenHex(colors.bgApp, 0.08);
}

/** Convert a picked hex to a translucent rgba so the glass blur shows through. Returns null on invalid hex. */
function pickedHexToStatusBarRgba(hex: string | undefined): string | null {
  if (!hex) return null;
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.2)`;
}
