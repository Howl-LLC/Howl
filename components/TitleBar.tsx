// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect } from 'react';
import { X, Minus, Square, Copy } from 'lucide-react';

export const TITLE_BAR_HEIGHT = 28;
const BUTTON_WIDTH = 40;

function getElectronApi(): ElectronBridge | undefined {
  return window.electron;
}

function isElectronEnv() {
  return !!(window.electron?.isElectron || window.__ELECTRON_WINDOW__);
}

function getPlatform(): string {
  return window.electron?.platform || window.__ELECTRON_PLATFORM__ || 'win32';
}

export const TitleBar: React.FC = () => {
  const [showBar, setShowBar] = useState(isElectronEnv);
  const [isMaximized, setIsMaximized] = useState(false);
  const [platform, setPlatform] = useState(getPlatform);

  useEffect(() => {
    if (showBar) return;
    const t = setTimeout(() => {
      setShowBar(isElectronEnv());
      setPlatform(getPlatform());
    }, 100);
    return () => clearTimeout(t);
  }, [showBar]);

  useEffect(() => {
    const api = getElectronApi();
    if (!api?.onMaximizedChange) return;
    return api.onMaximizedChange((max: boolean) => setIsMaximized(max));
  }, [showBar]);

  if (!showBar) return null;

  const isMac = platform === 'darwin';
  if (isMac) {
    return (
      <div
        className="flex items-center select-none drag-region flex-shrink-0"
        style={{
          height: TITLE_BAR_HEIGHT,
          WebkitAppRegion: 'drag',
          background: 'transparent',
          paddingLeft: 78,
          zIndex: 'var(--z-max)' as unknown as number,
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
        } as React.CSSProperties}
      >
        <span
          className="text-[11px] font-medium tracking-wide uppercase truncate"
          style={{ color: 'var(--text-secondary)' }}
        >
          Howl
        </span>
      </div>
    );
  }

  const api = getElectronApi();
  const handleMinimize = () => api?.minimize?.();
  const handleMaximize = () => api?.maximize?.();
  const handleClose = () => api?.close?.();

  const btnBase: React.CSSProperties = {
    width: BUTTON_WIDTH,
    height: TITLE_BAR_HEIGHT,
    WebkitAppRegion: 'no-drag',
    border: 'none',
    outline: 'none',
    background: 'transparent',
  } as React.CSSProperties;

  return (
    <div
      className="flex items-stretch flex-shrink-0 select-none drag-region"
      style={{
        height: TITLE_BAR_HEIGHT,
        WebkitAppRegion: 'drag',
        background: 'transparent',
        zIndex: 'var(--z-max)' as unknown as number,
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
      } as React.CSSProperties}
    >
      <div
        className="flex-1 flex items-center pl-4 overflow-hidden min-w-0"
        onDoubleClick={handleMaximize}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span
          className="text-[11px] font-medium tracking-wide uppercase truncate"
          style={{ color: 'var(--text-secondary)' }}
        >
          Howl
        </span>
      </div>

      <div
        className="flex items-stretch no-drag shrink-0"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          type="button"
          onClick={handleMinimize}
          className="flex items-center justify-center transition-all duration-150"
          style={{ ...btnBase, color: 'var(--text-secondary)' }}
          onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'var(--fill-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
          title="Minimize"
        >
          <Minus size={12} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          onClick={handleMaximize}
          className="flex items-center justify-center transition-all duration-150"
          style={{ ...btnBase, color: 'var(--text-secondary)' }}
          onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'var(--fill-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
          title={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? (
            <Copy size={10} strokeWidth={1.5} />
          ) : (
            <Square size={9} strokeWidth={1.5} />
          )}
        </button>
        <button
          type="button"
          onClick={handleClose}
          className="flex items-center justify-center transition-all duration-150"
          style={{ ...btnBase, color: 'var(--text-secondary)' }}
          onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'var(--danger)'; e.currentTarget.style.color = '#fff'; }}
          onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
          title="Close"
        >
          <X size={12} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
};
