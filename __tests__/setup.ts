// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import '@testing-library/jest-dom/vitest';

// Browser-specific globals are only mocked when the test environment is
// jsdom. Script tests run in node and would crash on `window`.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });

  Object.defineProperty(window, 'IntersectionObserver', {
    writable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });

  Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });

  // Node 22+ ships an experimental global `localStorage`. On Node 25 it
  // activates without a backing file (the "--localstorage-file was provided
  // without a valid path" warning) and shadows jsdom's Storage with a stub
  // that lacks a working clear(), so tests doing `localStorage.clear()` throw
  // "localStorage.clear is not a function". Install a self-contained in-memory
  // Storage on both globalThis and window so storage tests behave identically
  // across Node versions.
  class MemoryStorage {
    private store = new Map<string, string>();
    get length() { return this.store.size; }
    clear() { this.store.clear(); }
    getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null; }
    key(index: number) { return Array.from(this.store.keys())[index] ?? null; }
    removeItem(key: string) { this.store.delete(key); }
    setItem(key: string, value: string) { this.store.set(key, String(value)); }
  }
  for (const prop of ['localStorage', 'sessionStorage'] as const) {
    const storage = new MemoryStorage() as unknown as Storage;
    Object.defineProperty(globalThis, prop, { configurable: true, writable: true, value: storage });
    Object.defineProperty(window, prop, { configurable: true, writable: true, value: storage });
  }
}
