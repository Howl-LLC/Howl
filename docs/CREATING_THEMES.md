# Creating a New Theme

Three files to touch. That's it.

## Step 1: Define the CSS variables

Open `app.css` and copy any existing `[data-theme='...']` block (e.g. the `matter` block). Change the selector and values:

```css
[data-theme='forest'] {
    /* Backgrounds */
    --bg-app: #1a2e1a;
    --bg-panel: rgba(20, 40, 20, 0.6);
    --bg-sidebar: rgba(15, 30, 15, 0.85);
    --bg-chat: rgba(20, 40, 20, 0.2);
    --bg-input: rgba(20, 40, 20, 0.5);
    --bg-floating: #1e3a1e;
    --bg-code: rgba(255,255,255,0.03);
    --bg-skeleton: rgba(255,255,255,0.06);
    --bg-skeleton-subtle: rgba(255,255,255,0.04);

    /* Text */
    --text-primary: #e8f5e8;
    --text-secondary: rgba(232, 245, 232, 0.5);
    --text-on-accent: #0f172a;          /* text color ON accent buttons */
    --text-faint: rgba(255,255,255,0.35);

    /* Borders */
    --border-subtle: rgba(255, 255, 255, 0.06);
    --divider: rgba(255,255,255,0.06);

    /* Accent */
    --cyan-accent: #4ade80;             /* your theme's accent color */
    --accent-glow: rgba(74, 222, 128, 0.3);

    /* Glass */
    --glass-bg: rgba(15, 30, 15, 0.72);
    --glass-border: rgba(255, 255, 255, 0.08);
    --glass-shadow: 0 0 0 1px rgba(255,255,255,0.04) inset, 0 8px 32px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3);

    /* Overlays */
    --overlay-backdrop: rgba(0,0,0,0.7);
    --spoiler-overlay: rgba(255, 255, 255, 0.88);

    /* Status dots (usually same across themes) */
    --status-online: #10b981;
    --status-idle: #f59e0b;
    --status-dnd: #ef4444;
    --status-offline: #64748b;

    /* Scrollbar */
    --scrollbar-thumb: rgba(255, 255, 255, 0.15);
    --scrollbar-thumb-hover: rgba(255, 255, 255, 0.25);
    --scrollbar-thumb-active: rgba(255, 255, 255, 0.35);
}
```

**Tips for dark themes:** Use `rgba(255,255,255,...)` for subtle borders/dividers, light `--text-primary`.
**Tips for light themes:** Use `rgba(0,0,0,...)` for borders/dividers, dark `--text-primary`, set `--text-on-accent: #ffffff`.

The following tokens are **auto-derived** from the variables above (via `color-mix()` in `:root`) and don't need to be redefined:
- `--fill-hover`, `--fill-active`, `--fill-selected`, `--fill-selected-hover`
- `--accent-subtle`, `--accent-muted`, `--accent-emphasis`
- `--danger`, `--success`, `--warning` (and their `-subtle`/`-muted` variants)
- `--shadow-sm/md/lg/xl`, `--shadow-glow`

## Step 2: Register the theme name

**`App.tsx`** (~line 85) -- add to the union type:
```typescript
export type AppTheme = 'neural' | 'light' | 'matter' | 'void' | 'custom' | 'forest';
```

**`contexts/SettingsContext.tsx`** -- add to ALL `VALID_THEMES` arrays (there are 3 occurrences, ~lines 75, 241, 368):
```typescript
const VALID_THEMES: AppTheme[] = ['neural', 'light', 'matter', 'void', 'custom', 'forest'];
```

## Step 3: Add the theme picker button

**`components/settings/AppearanceTab.tsx`** (~line 196) -- add an entry to the themes array:
```typescript
{ id: 'forest' as AppTheme, label: t('settings.forest'), bg: '#1a2e1a', border: 'border-[var(--glass-border)]', accent: '#4ade80' },
```

The `bg` and `accent` here are just for the preview swatch -- hardcode your theme's actual `--bg-app` and `--cyan-accent` values.

Also add the i18n key `settings.forest` to your translation files (or just use a literal string while prototyping).

## That's it

No component changes needed. Every surface in the app reads from CSS variables.

## Checklist

- [ ] `[data-theme='name']` block in `app.css` with all 27 variables
- [ ] `AppTheme` union in `App.tsx`
- [ ] `VALID_THEMES` arrays in `SettingsContext.tsx` (3 places)
- [ ] Theme picker entry in `AppearanceTab.tsx`
- [ ] i18n label (optional -- can use literal string)
- [ ] Visual check: switch to new theme, verify chat, sidebar, settings, auth pages, modals
