// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePipPosition } from '../hooks/usePipPosition';

describe('usePipPosition', () => {
  beforeEach(() => {
    sessionStorage.clear();
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
  });

  /** Fabricate a minimal PointerEvent-ish object for dispatching on window.
   *  window.dispatchEvent with new PointerEvent isn't supported in JSDOM, so
   *  we synthesize a MouseEvent with the pointer-event fields the hook reads. */
  function makePointerMoveEvent(clientX: number, clientY: number): PointerEvent {
    const e = new MouseEvent('pointermove', { bubbles: true, clientX, clientY });
    Object.defineProperty(e, 'pointerId', { value: 1, configurable: true });
    return e as PointerEvent;
  }
  function makePointerUpEvent(): PointerEvent {
    const e = new MouseEvent('pointerup', { bubbles: true });
    Object.defineProperty(e, 'pointerId', { value: 1, configurable: true });
    return e as PointerEvent;
  }

  it('defaults to bottom-right corner on first mount', () => {
    renderHook(() => usePipPosition({ width: 320, height: 180 }));
    // The initial corner is persisted on mount so future sessions restore
    // exactly where the user left it. Default is bottom-right.
    expect(sessionStorage.getItem('howl_pip_corner')).toBe('br');
  });

  it('snap chooses nearest corner after drag end and persists to sessionStorage', () => {
    const { result } = renderHook(() => usePipPosition({ width: 320, height: 180 }));
    // Attach ref — without a real element, the transform is written to a null
    // ref and drag still works, but setPointerCapture is skipped (caught).
    const el = document.createElement('div');
    document.body.appendChild(el);
    act(() => { result.current.ref(el); });
    // Start drag from near bottom-right (default corner).
    act(() => {
      const e = new MouseEvent('pointerdown', { bubbles: true, clientX: 700, clientY: 580, button: 0 });
      Object.defineProperty(e, 'pointerId', { value: 1, configurable: true });
      result.current.onPointerDown(e as unknown as React.PointerEvent<HTMLDivElement>);
    });
    // Move into the top-left quadrant.
    act(() => { window.dispatchEvent(makePointerMoveEvent(50, 50)); });
    act(() => { window.dispatchEvent(makePointerUpEvent()); });
    expect(sessionStorage.getItem('howl_pip_corner')).toBe('tl');
  });

  it('reads persisted corner from sessionStorage on subsequent mounts', () => {
    sessionStorage.setItem('howl_pip_corner', 'tl');
    const { result } = renderHook(() => usePipPosition({ width: 320, height: 180 }));
    const el = document.createElement('div');
    document.body.appendChild(el);
    act(() => { result.current.ref(el); });
    // After mount the transform should position at top-left corner
    // (safe inset = 16 -> translate3d(16px, 16px, 0)).
    expect(el.style.transform).toContain('16px');
  });
});
