// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';

export interface LinkPreviewData {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  favicon: string | null;
}

declare module './core' {
  interface APIClient {
    getLinkPreview(url: string): Promise<LinkPreviewData | null>;
  }
}

APIClient.prototype.getLinkPreview = async function (this: APIClient, url: string): Promise<LinkPreviewData | null> {
  try {
    return await this.request<LinkPreviewData>(`/link-preview?url=${encodeURIComponent(url)}`);
  } catch {
    return null;
  }
};
