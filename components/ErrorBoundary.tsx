// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { Component, ErrorInfo, ReactNode } from 'react';
import i18n from '../src/i18n';
import { Sentry, sentryEnabled } from '../src/sentry';
import { maybeRecoverFromChunkError } from '../src/chunkReloadGuard';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Stale-deploy recovery: if a code-split chunk failed because CF Pages
    // returned the SPA fallback (text/html) for a missing JS asset, evict
    // the SW + caches and reload once. Skips the Sentry capture in that
    // case because the underlying cause is environmental, not a code bug.
    if (maybeRecoverFromChunkError(error)) return;
    this.props.onError?.(error, errorInfo);
    if (sentryEnabled()) {
      Sentry.captureException(error, { extra: { componentStack: errorInfo.componentStack } });
    }
    if (import.meta.env.DEV) {
      console.error('ErrorBoundary caught:', error, errorInfo);
    }
  }

  render() {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex flex-1 flex-col items-center justify-center p-8 bg-app-surface border border-red-500/30 rounded-xl text-center">
          <p className="text-red-400 font-bold uppercase text-sm mb-2">{i18n.t('errors.somethingWentWrong')}</p>
          <p className="text-slate-400 text-xs mono mb-4 max-w-md break-all">
            {i18n.t('errors.unexpectedError')}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, error: null })}
            className="btn-cta px-4 py-2 rounded-xl text-xs font-bold uppercase"
          >
            {i18n.t('common.tryAgain')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
