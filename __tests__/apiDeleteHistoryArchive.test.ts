// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub fetch so request() resolves against a controlled response rather than
// the network. A 200 with a JSON body exercises the real request() success path
// (res.ok && status !== 204 -> res.json()).
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { apiClient } from '../services/api';

describe('apiClient.deleteDmHistoryArchive', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('issues DELETE /dms/history-archive and returns the parsed body', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ deleted: 7 }) });

    const res = await apiClient.deleteDmHistoryArchive();

    expect(res).toEqual({ deleted: 7 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/dms/history-archive');
    expect(init.method).toBe('DELETE');
    // The bulk wipe targets the collection root, not a per-message/per-channel path.
    expect(String(url)).not.toMatch(/\/dms\/history-archive\/.+/);
  });
});
