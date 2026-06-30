// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchSignedMediaUrl, fetchMediaBlobUrl } from '../services/mediaUrl';

afterEach(() => { vi.unstubAllGlobals(); });

describe('fetchSignedMediaUrl', () => {
  it('sends the ?as=json hop with a Bearer header and returns the signed url', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      expect(url).toBe('https://api.test/api/uploads/x.png?as=json');
      return { ok: true, json: async () => ({ url: 'https://cdn.test/x?sig=abc' }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchSignedMediaUrl('https://api.test/api/uploads/x.png', 'tok123');
    expect(out).toBe('https://cdn.test/x?sig=abc');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok123');
    expect(init.credentials).toBe('include');
  });

  it('omits the Authorization header when token is null', async () => {
    const fetchMock = vi.fn(async (_url?: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ url: 'https://cdn.test/y' }) } as Response));
    vi.stubGlobal('fetch', fetchMock);
    await fetchSignedMediaUrl('https://api.test/api/uploads/y.png', null);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('throws on a non-ok as=json response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 } as Response)));
    await expect(fetchSignedMediaUrl('https://api.test/api/uploads/z.png', 't')).rejects.toThrow();
  });

  it('appends &as=json when the url already has a query', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.test/api/uploads/x.png?v=2&as=json');
      return { ok: true, json: async () => ({ url: 'https://cdn.test/x' }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    await fetchSignedMediaUrl('https://api.test/api/uploads/x.png?v=2', 't');
  });
});

describe('fetchMediaBlobUrl', () => {
  it('resolves the signed url then fetches the blob from the CDN with no extra headers', async () => {
    const blob = new Blob(['data']);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://cdn.test/x?sig=abc' }) } as Response)
      .mockResolvedValueOnce({ ok: true, blob: async () => blob } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchMediaBlobUrl('https://api.test/api/uploads/x.png', 'tok');
    expect(out).toBe(blob);
    expect(fetchMock.mock.calls[1][0]).toBe('https://cdn.test/x?sig=abc');
    const secondInit = (fetchMock.mock.calls[1][1] ?? {}) as RequestInit;
    expect(secondInit.headers).toBeUndefined();
  });
});
