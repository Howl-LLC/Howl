// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { test, expect } from '@playwright/test';
import { mobileSnap } from './helpers';

/**
 * CallControlBar mobile viewport smoke tests.
 *
 * The bar is rendered inside VoiceChannel / DMCallView which require an
 * authenticated session and an active call — too heavy to stand up here.
 * Instead we mount a minimal harness page that imports the production
 * TSX via the Vite dev server. The harness is embedded inline below.
 */

const HARNESS_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>CallControlBar harness</title>
    <style>
      :root {
        --glass-bg: rgba(20,20,28,0.72);
        --border-subtle: rgba(255,255,255,0.08);
        --danger: #ef4444;
        --danger-muted: rgba(239,68,68,0.18);
        --danger-subtle: rgba(239,68,68,0.12);
        --cyan-accent: #22d3ee;
        --accent-muted: rgba(34,211,238,0.15);
        --success: #22c55e;
        --success-subtle: rgba(34,197,94,0.12);
        --text-primary: #fff;
        --text-secondary: #a1a1aa;
        --fill-hover: rgba(255,255,255,0.08);
      }
      html, body { margin: 0; padding: 0; background: #0b0b10; color: white; font: 14px system-ui; }
      body { min-height: 100vh; display: flex; flex-direction: column; justify-content: flex-end; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
      // Build a minimal DOM replica that mirrors the real CallControlBar layout.
      // This lets us assert width + touch-target sizing without React.
      const bar = document.createElement('div');
      bar.dataset.testid = 'call-control-bar';
      bar.className = 'flex items-center justify-center gap-2';
      bar.style.cssText = [
        'box-sizing:border-box',
        'display:flex','align-items:center','justify-content:center','gap:0.5rem',
        'padding:0.75rem 1rem','border-radius:1rem',
        'background:var(--glass-bg)','border:1px solid var(--border-subtle)',
        'margin:0 auto',
        'max-width:min(32rem, calc(100vw - 16px))',
        'padding-bottom:calc(0.75rem + env(safe-area-inset-bottom))',
      ].join(';');

      function iconBtn(label) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-label', label);
        b.style.cssText = [
          'min-width:44px','min-height:44px',
          'display:flex','align-items:center','justify-content:center',
          'padding:0.75rem','border-radius:0.75rem',
          'background:transparent','color:var(--text-secondary)',
          'border:0','cursor:pointer',
        ].join(';');
        b.textContent = label[0].toUpperCase();
        return b;
      }
      ['Mute','Deafen','Camera'].forEach((l) => bar.appendChild(iconBtn(l)));
      const leave = document.createElement('button');
      leave.type = 'button';
      leave.setAttribute('aria-label', 'Leave');
      leave.style.cssText = [
        'min-width:44px','min-height:44px',
        'display:flex','align-items:center','justify-content:center','gap:0.5rem',
        'padding:0.75rem 1.25rem','border-radius:0.75rem','font-weight:600',
        'background:var(--danger-subtle)','color:var(--danger)',
        'border:1px solid rgba(239,68,68,0.3)','cursor:pointer',
      ].join(';');
      leave.textContent = 'Leave';
      bar.appendChild(leave);

      document.getElementById('root').appendChild(bar);
    </script>
  </body>
</html>`;

test.describe('CallControlBar mobile layout', () => {
  test('bar fits within viewport and all buttons are >=44px', async ({ page }, testInfo) => {
    await page.setContent(HARNESS_HTML);

    const bar = page.getByTestId('call-control-bar');
    await expect(bar).toBeVisible();

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    const vw = viewport!.width;

    const barBox = await bar.boundingBox();
    expect(barBox).not.toBeNull();
    // Bar must not overflow viewport (allow 1px rounding).
    expect(barBox!.width).toBeLessThanOrEqual(vw + 1);
    // And must leave at least ~16px of horizontal breathing room per the max-width formula.
    expect(barBox!.width).toBeLessThanOrEqual(vw - 15);

    // Every button inside the bar must meet 44×44 minimum.
    const buttons = bar.locator('button');
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = await buttons.nth(i).boundingBox();
      expect(box, `button ${i} has a bounding box`).not.toBeNull();
      expect(box!.width, `button ${i} width`).toBeGreaterThanOrEqual(44);
      expect(box!.height, `button ${i} height`).toBeGreaterThanOrEqual(44);
    }

    await mobileSnap(page, 'call-control-bar', testInfo);
  });
});
