// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useRef, useEffect, useCallback } from 'react';

interface UsePopoutWindowOptions {
  windowName: string;
  title: string;
  containerId: string;
}

interface UsePopoutWindowReturn {
  isPoppedOut: boolean;
  popoutContainerRef: React.RefObject<HTMLDivElement | null>;
  openPopout: () => void;
  closePopout: () => void;
}

/**
 * Manages a detached browser popout window with CSP injection and stylesheet cloning.
 * Used by VoiceChannel and DMCallView to pop call UIs into separate windows.
 */
export function usePopoutWindow({ windowName, title, containerId }: UsePopoutWindowOptions): UsePopoutWindowReturn {
  const [isPoppedOut, setIsPoppedOut] = useState(false);
  const popoutWindowRef = useRef<Window | null>(null);
  const popoutContainerRef = useRef<HTMLDivElement | null>(null);
  const popoutTickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const openPopout = useCallback(() => {
    if (popoutWindowRef.current && !popoutWindowRef.current.closed) {
      popoutWindowRef.current.focus();
      return;
    }
    const w = Math.min(1200, screen.availWidth * 0.75);
    const h = Math.min(800, screen.availHeight * 0.75);
    const left = Math.round((screen.availWidth - w) / 2);
    const top = Math.round((screen.availHeight - h) / 2);
    const popup = window.open('', windowName, `width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`);
    if (!popup) return;

    // Inject CSP meta tag for security
    const cspMeta = popup.document.createElement('meta');
    cspMeta.httpEquiv = 'Content-Security-Policy';
    cspMeta.content = "default-src 'self' blob: data:; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' blob:; connect-src 'none'; object-src 'none';";
    popup.document.head.appendChild(cspMeta);

    popup.document.title = title;
    popup.document.body.style.margin = '0';
    popup.document.body.style.padding = '0';
    popup.document.body.style.background = getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim() || '#020617';
    popup.document.body.style.overflow = 'hidden';
    popup.document.body.style.height = '100vh';

    const container = popup.document.createElement('div');
    container.id = containerId;
    container.style.width = '100%';
    container.style.height = '100%';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    popup.document.body.appendChild(container);

    // Serialize all CSS rules into a single style block for the popup
    let allCSS = '';
    try {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            allCSS += rule.cssText + '\n';
          }
        } catch {
          // Cross-origin stylesheet — clone the link tag instead
          if (sheet.href) {
            const link = popup.document.createElement('link');
            link.rel = 'stylesheet';
            link.href = sheet.href;
            popup.document.head.appendChild(link);
          }
        }
      }
    } catch {
      // Fallback: clone all style/link nodes
      Array.from(document.querySelectorAll('link[rel="stylesheet"], style')).forEach((node) => {
        popup.document.head.appendChild(node.cloneNode(true));
      });
    }
    if (allCSS) {
      const style = popup.document.createElement('style');
      style.textContent = allCSS;
      popup.document.head.appendChild(style);
    }

    // Transfer dark mode class
    if (document.documentElement.classList.contains('dark')) {
      popup.document.documentElement.classList.add('dark');
    }

    // Copy CSS custom properties from parent theme
    const computedStyle = getComputedStyle(document.documentElement);
    const cssVarsToCopy = [
      '--bg-app', '--bg-panel', '--bg-sidebar', '--bg-chat', '--bg-statusbar', '--bg-input', '--bg-floating',
      '--text-primary', '--text-secondary', '--border-subtle', '--cyan-accent', '--accent-glow',
      '--glass-bg', '--glass-border', '--spoiler-overlay',
      '--fill-hover', '--fill-active', '--fill-selected', '--fill-selected-hover',
      '--accent-subtle', '--accent-muted', '--accent-emphasis',
      '--danger', '--danger-subtle', '--danger-muted',
      '--success', '--success-subtle', '--success-muted',
      '--warning', '--warning-subtle', '--warning-muted',
      '--scrollbar-thumb', '--scrollbar-thumb-hover', '--scrollbar-thumb-active',
      '--chat-font-size', '--chat-line-height',
    ];
    cssVarsToCopy.forEach(v => {
      const val = computedStyle.getPropertyValue(v);
      if (val) popup.document.documentElement.style.setProperty(v, val);
    });

    popoutWindowRef.current = popup;
    popoutContainerRef.current = container;
    setIsPoppedOut(true);

    // Poll to detect popup close
    const tick = setInterval(() => {
      if (popup.closed) {
        clearInterval(tick);
        popoutTickRef.current = null;
        popoutWindowRef.current = null;
        popoutContainerRef.current = null;
        setIsPoppedOut(false);
      }
    }, 500);
    popoutTickRef.current = tick;

    popup.addEventListener('beforeunload', () => {
      clearInterval(tick);
      popoutTickRef.current = null;
      popoutWindowRef.current = null;
      popoutContainerRef.current = null;
      setIsPoppedOut(false);
    });
  }, [windowName, title, containerId]);

  const closePopout = useCallback(() => {
    if (popoutTickRef.current) { clearInterval(popoutTickRef.current); popoutTickRef.current = null; }
    if (popoutWindowRef.current && !popoutWindowRef.current.closed) popoutWindowRef.current.close();
    popoutWindowRef.current = null;
    popoutContainerRef.current = null;
    setIsPoppedOut(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (popoutTickRef.current) clearInterval(popoutTickRef.current);
      if (popoutWindowRef.current && !popoutWindowRef.current.closed) popoutWindowRef.current.close();
    };
  }, []);

  return { isPoppedOut, popoutContainerRef, openPopout, closePopout };
}
