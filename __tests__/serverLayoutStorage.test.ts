// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach } from 'vitest';
import { getStoredServerLayout, setStoredServerLayout } from '../utils/uiDensityStorage';

describe('serverLayout storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns "default" when nothing is stored', () => {
    expect(getStoredServerLayout()).toBe('default');
  });

  it('round-trips a stored "classic" value', () => {
    setStoredServerLayout('classic');
    expect(getStoredServerLayout()).toBe('classic');
  });

  it('round-trips a stored "default" value', () => {
    setStoredServerLayout('classic');
    setStoredServerLayout('default');
    expect(getStoredServerLayout()).toBe('default');
  });

  it('rejects unknown values and falls back to default', () => {
    localStorage.setItem('howl_server_layout', 'modern');
    expect(getStoredServerLayout()).toBe('default');
  });

  it('rejects empty string and falls back to default', () => {
    localStorage.setItem('howl_server_layout', '');
    expect(getStoredServerLayout()).toBe('default');
  });
});
