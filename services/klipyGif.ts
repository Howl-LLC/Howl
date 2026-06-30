// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { API_BASE_URL } from '../config';

export interface KlipyGifFile {
  url: string;
  width?: number;
  height?: number;
}

export interface KlipyGif {
  id: string;
  slug?: string;
  title?: string;
  files: Record<string, KlipyGifFile>;
}

export interface KlipyGifResult {
  items: KlipyGif[];
  hasNext: boolean;
  page: number;
}

function pickPreviewUrl(files: Record<string, any>): string {
  return (
    files.sm?.gif?.url ??
    files.sm?.webp?.url ??
    files.md?.gif?.url ??
    files.md?.webp?.url ??
    files.hd?.gif?.url ??
    ''
  );
}

function pickFullUrl(files: Record<string, any>): string {
  return (
    files.md?.gif?.url ??
    files.hd?.gif?.url ??
    files.sm?.gif?.url ??
    files.md?.webp?.url ??
    ''
  );
}

export function getPreviewUrl(gif: KlipyGif): string {
  return pickPreviewUrl(gif.files);
}

export function getFullUrl(gif: KlipyGif): string {
  return pickFullUrl(gif.files);
}

/** Pick width/height matching the same priority as pickFullUrl */
export function getFullDimensions(gif: KlipyGif): { width?: number; height?: number } {
  const f = gif.files as Record<string, any>;
  const pick = f.md?.gif ?? f.hd?.gif ?? f.sm?.gif ?? f.md?.webp;
  return { width: pick?.width, height: pick?.height };
}

async function klipyFetch(endpoint: string, params: Record<string, string>): Promise<KlipyGifResult> {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE_URL}/klipy${endpoint}${qs ? `?${qs}` : ''}`;
  const token = (await import('./api')).apiClient.getToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { headers, credentials: 'include' });
  if (!res.ok) throw new Error(`Klipy API ${res.status}`);
  const json = await res.json();
  const data = json?.data ?? json;
  interface KlipyApiItem {
    id?: string;
    slug?: string;
    title?: string;
    file?: Record<string, KlipyGifFile>;
  }
  const items: KlipyGif[] = ((data?.data ?? []) as KlipyApiItem[]).map((item) => ({
    id: item.id ?? item.slug ?? String(Math.random()),
    slug: item.slug,
    title: item.title ?? '',
    files: item.file ?? {},
  }));
  return {
    items,
    hasNext: !!data?.has_next,
    page: Number(data?.current_page ?? params.page ?? 1),
  };
}

export function searchGifs(query: string, page = 1): Promise<KlipyGifResult> {
  return klipyFetch('/search', { q: query, per_page: '24', page: String(page) });
}

export function getTrendingGifs(page = 1): Promise<KlipyGifResult> {
  return klipyFetch('/trending', { per_page: '24', page: String(page) });
}

export function getRecentGifs(page = 1): Promise<KlipyGifResult> {
  return klipyFetch('/recents', { per_page: '24', page: String(page) });
}

export async function triggerGifShare(gifId: string): Promise<void> {
  const url = `${API_BASE_URL}/klipy/share`;
  const token = (await import('./api')).apiClient.getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  fetch(url, { method: 'POST', headers, credentials: 'include', body: JSON.stringify({ item_id: gifId }) }).catch(() => {});
}

export interface GifFavorite {
  gifUrl: string;
  previewUrl: string;
  title: string;
  createdAt: string;
}

export async function getGifFavorites(page = 1, limit = 50): Promise<{ favorites: GifFavorite[]; total: number; hasNext: boolean }> {
  const url = `${API_BASE_URL}/klipy/favorites?page=${page}&limit=${limit}`;
  const token = (await import('./api')).apiClient.getToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { headers, credentials: 'include' });
  if (!res.ok) throw new Error('Failed to load favorites');
  return res.json();
}

export async function addGifFavorite(gifUrl: string, previewUrl: string, title: string = ''): Promise<void> {
  const url = `${API_BASE_URL}/klipy/favorites`;
  const token = (await import('./api')).apiClient.getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { method: 'POST', headers, credentials: 'include', body: JSON.stringify({ gifUrl, previewUrl, title }) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to add favorite');
  }
}

export async function removeGifFavorite(gifUrl: string): Promise<void> {
  const url = `${API_BASE_URL}/klipy/favorites`;
  const token = (await import('./api')).apiClient.getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  await fetch(url, { method: 'DELETE', headers, credentials: 'include', body: JSON.stringify({ gifUrl }) }).catch(() => {});
}
