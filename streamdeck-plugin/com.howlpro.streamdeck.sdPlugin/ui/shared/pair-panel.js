// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Howl Stream Deck plugin -- shared Property Inspector pair-panel overlay.
// Each PI HTML page loads this script (`<script src="./shared/pair-panel.js"></script>`).
// While the plugin is in pair-pending state, this overlay covers the
// normal config UI and tells the user to open Howl and approve the
// consent modal there. Once the user approves pairing in Howl, the
// plugin tells us via `sendToPropertyInspector` and we hide the overlay.

(function () {
  'use strict';

  let overlay = null;
  let initialized = false;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'howl-pair-panel';
    overlay.innerHTML = [
      '<style>',
      '  #howl-pair-panel { position: fixed; inset: 0; z-index: 9999; padding: 28px;',
      '    background: #020617; color: #f1f5f9;',
      '    font-family: "Plus Jakarta Sans", -apple-system, system-ui, sans-serif;',
      '    display: none; box-sizing: border-box;',
      '    flex-direction: column; align-items: center; justify-content: center; gap: 16px; }',
      '  #howl-pair-panel.show { display: flex; }',
      '  #howl-pair-panel .accent { width: 36px; height: 2px; background: #22d3ee; }',
      '  #howl-pair-panel .label { color: #22d3ee; font-size: 11px; font-weight: 900;',
      '    text-transform: uppercase; letter-spacing: 0.08em; }',
      '  #howl-pair-panel .title { font-size: 18px; font-weight: 700; text-align: center; }',
      '  #howl-pair-panel .desc { font-size: 12px; color: rgba(241,245,249,0.6);',
      '    text-align: center; max-width: 280px; line-height: 1.5; }',
      '  #howl-pair-panel button { padding: 8px 18px; border-radius: 8px;',
      '    border: 1px solid rgba(241,245,249,0.12); background: rgba(241,245,249,0.04);',
      '    color: rgba(241,245,249,0.85); font-size: 12px; font-weight: 600; cursor: pointer; }',
      '  #howl-pair-panel button:hover { background: rgba(241,245,249,0.08); }',
      '  #howl-pair-panel .plugin-id { font-family: "JetBrains Mono", ui-monospace, monospace;',
      '    font-size: 10px; color: rgba(241,245,249,0.4); }',
      '</style>',
      '<div class="accent"></div>',
      '<div class="label">Pair Howl</div>',
      '<div class="title">Open Howl to allow pairing</div>',
      '<div class="desc">Howl is showing a consent prompt on this computer. Approve it there to start using your Stream Deck.</div>',
      '<button type="button" id="howl-pair-retry">Retry pair</button>',
      '<div class="plugin-id">com.howlpro.streamdeck</div>',
    ].join('\n');
    document.body.appendChild(overlay);

    overlay.querySelector('#howl-pair-retry').addEventListener('click', function () {
      if (window.websocket && window.websocket.readyState === 1) {
        window.websocket.send(JSON.stringify({
          event: 'sendToPlugin',
          context: window.uuid || '',
          action: (window.actionInfo && window.actionInfo.action) || '',
          payload: { type: 'retry-pair' },
        }));
      }
    });

    return overlay;
  }

  function show() {
    const ov = ensureOverlay();
    ov.classList.add('show');
  }

  function hide() {
    if (overlay) overlay.classList.remove('show');
  }

  function attach() {
    if (initialized) return;
    if (!window.websocket || typeof window.websocket.addEventListener !== 'function') return;
    initialized = true;

    window.websocket.addEventListener('message', function (ev) {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m && m.event === 'sendToPropertyInspector' && m.payload && m.payload.type === 'pair-state') {
        if (m.payload.pending) show();
        else hide();
      }
    });

    // Ask the plugin for the current pair state so we render correctly even
    // if the PI opens after the pair flow already started.
    window.websocket.send(JSON.stringify({
      event: 'sendToPlugin',
      context: window.uuid || '',
      action: (window.actionInfo && window.actionInfo.action) || '',
      payload: { type: 'pair-state-query' },
    }));
  }

  // The PI's `connectElgatoStreamDeckSocket` creates `window.websocket`
  // after it is called. Poll until it shows up, then attach our listener.
  const poll = setInterval(function () {
    if (window.websocket && window.websocket.readyState === 1) {
      clearInterval(poll);
      attach();
    }
  }, 50);

  setTimeout(function () { clearInterval(poll); }, 10_000);
})();
