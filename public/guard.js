// Clickjacking protection — prevent embedding in third-party iframes.
// frame-ancestors CSP directive is ignored in meta tags (spec), so this
// is the frontend defense. The CDN/edge should also set frame-ancestors 'none'.
if (window.top !== window.self) {
  try { window.top.location = window.self.location; } catch (e) {
    document.body.innerHTML = '';
    document.body.style.display = 'none';
  }
}

// Production DevTools deterrent — blocks common shortcuts and warns in console.
// This file is NOT processed by Vite/esbuild, so console calls survive the
// production `drop: ['console']` transform. Runs before React mounts so
// shortcuts are blocked from the very first keypress.
(function () {
  // Skip in development and in Electron (Electron has its own main-process block)
  var h = window.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '' || h.endsWith('.trycloudflare.com')) return;
  if (window.location.protocol === 'file:') return;

  // Block DevTools keyboard shortcuts (capture phase, runs before React handlers)
  document.addEventListener('keydown', function (e) {
    if (e.key === 'F12') { e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
      var k = e.key.toUpperCase();
      // Ctrl+Shift+J (console), Ctrl+Shift+C (inspect element)
      // Note: Ctrl+Shift+I is intentionally omitted — it is captured by the
      // React keybind system (toggleStreamerMode) which already calls
      // preventDefault(), blocking DevTools as a side effect.
      if (k === 'J' || k === 'C') { e.preventDefault(); return; }
    }
    // Ctrl+U (view source) — also bound to toggleMembersPanel in React
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toUpperCase() === 'U') {
      e.preventDefault();
    }
  }, true);

  // (Self-XSS "Stop!" console banner removed per product decision.)
})();
