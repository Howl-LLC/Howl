// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import './src/sentry'; // Sentry must init before other imports
import './app.css';
import './src/i18n';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SettingsProvider } from './contexts/SettingsContext';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import { installChunkReloadGuard, clearChunkReloadFlagOnSuccess } from './src/chunkReloadGuard';

// Recover automatically from stale-deploy chunk-load failures (CF Pages +
// service-worker cache mismatch after a redeploy). Must run before any
// dynamic import() can fail.
installChunkReloadGuard();
clearChunkReloadFlagOnSuccess();

// Electron uses file:// in production — BrowserRouter (pushState) won't work.
// HashRouter uses /#/path style URLs which work with any protocol.
const isElectron = !!(window.electron?.isElectron || window.__ELECTRON_WINDOW__);
const Router = isElectron ? HashRouter : BrowserRouter;

if (import.meta.env.PROD) {
  const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (typeof hook === 'object') {
    for (const key of Object.keys(hook)) {
      if (typeof hook[key] === 'function') {
        hook[key] = () => {};
      }
    }
  }

  // (Self-XSS console warning removed per product decision.)
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary
      fallback={
        <div className="flex h-screen w-full items-center justify-center bg-app-surface text-slate-400">
          <div className="text-center max-w-md p-8">
            <p className="text-red-400 font-bold uppercase text-sm mb-2">Something went wrong</p>
            <p className="text-xs mb-4">An unexpected error occurred. Please reload the page.</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-[var(--cyan-accent)]/20 border border-[var(--cyan-accent)]/40 text-[var(--cyan-accent)] rounded-lg text-xs font-bold uppercase"
            >
              Reload page
            </button>
          </div>
        </div>
      }
    >
      <Router>
        <SettingsProvider>
          <App />
        </SettingsProvider>
      </Router>
    </ErrorBoundary>
  </React.StrictMode>
);

