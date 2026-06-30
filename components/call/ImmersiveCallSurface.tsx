// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { createPortal } from 'react-dom';
import { useAuthStore } from '../../stores/authStore';
import { useBackgroundSettings } from '../../hooks/useBackgroundSettings';
import { sanitizeCssUrl } from '../../utils/securityUtils';

export type ImmersiveCallSurfaceMode = 'fullscreen' | 'popout';

export interface ImmersiveCallSurfaceProps {
  /** Card grid + any focused-participant overlays. */
  children: React.ReactNode;
  /** Bottom-center control bar. */
  controls: React.ReactNode;
  /** Fullscreen (portal overlay covering the whole window) or popout (absolute inset-0 in popout container). */
  mode: ImmersiveCallSurfaceMode;
  /** Optional extra class on the outer div. */
  className?: string;
}

export const ImmersiveCallSurface = React.memo(function ImmersiveCallSurface({
  children,
  controls,
  mode,
  className,
}: ImmersiveCallSurfaceProps) {
  const currentUser = useAuthStore((s) => s.currentUser);
  const { activeBgImage, backgroundOpacity, backgroundBlur } = useBackgroundSettings(currentUser);

  // Fullscreen mode: render at the top of the z-stack with a dedicated z-index
  // so the sidebar, chat composer, and other AppLayout chrome can never leak
  // through. `--z-pip` sits above dropdowns but below modals/toasts so ring
  // modals and settings can still appear on top when they need to.
  // Popout mode: flows with the popout window's own layout.
  const outerClassName = `${mode === 'fullscreen' ? 'fixed' : 'absolute'} inset-0 flex flex-col overflow-hidden bg-[var(--bg-app)] ${className ?? ''}`;
  const outerStyle: React.CSSProperties | undefined = mode === 'fullscreen'
    ? { zIndex: 'var(--z-pip)' as unknown as number }
    : undefined;

  const body = (
    <div
      className={outerClassName}
      style={outerStyle}
      data-immersive-call-surface=""
      data-mode={mode}
    >
      {/* Background image layer — mirrors the AppLayout background so custom
          user backgrounds show through behind the call grid rather than being
          replaced by a flat bg-app fill. Rendered inside the portal so it
          works even when the surface is detached from the main app tree. */}
      {activeBgImage && (
        <div
          className="absolute inset-0 pointer-events-none overflow-hidden"
          style={{ opacity: backgroundOpacity, zIndex: 0 }}
        >
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: activeBgImage.startsWith('data:image/')
                ? `url("${activeBgImage}")`
                : (sanitizeCssUrl(activeBgImage) || 'none'),
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              backgroundRepeat: 'no-repeat',
              filter: backgroundBlur > 0 ? `blur(${backgroundBlur}px)` : undefined,
              transform: backgroundBlur > 0 ? 'scale(1.05)' : undefined,
            }}
          />
        </div>
      )}

      {/* Grid area */}
      <div className="relative z-[1] flex-1 min-h-0 overflow-auto flex items-center justify-center">
        {children}
      </div>

      {/* Controls — fixed at bottom, centered, with safe-area padding */}
      <div
        className="relative z-[1] shrink-0 flex items-center justify-center px-3 pb-4"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
      >
        {controls}
      </div>
    </div>
  );

  // Portal fullscreen to document.body so it escapes any ancestor stacking
  // contexts (sidebar, channel panel, etc.). Popout stays inline — its
  // `popoutContainerRef` caller already creates its own stacking context.
  if (mode === 'fullscreen' && typeof document !== 'undefined') {
    return createPortal(body, document.body);
  }
  return body;
});

ImmersiveCallSurface.displayName = 'ImmersiveCallSurface';
