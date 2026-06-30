// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useState } from 'react';
import { fetchMediaBlobUrl } from '../services/mediaUrl';
import { apiClient } from '../services/api';
import { getBackendOrigin } from '../config';

/**
 * An <img> that loads a /api/uploads asset through the tokened ?as=json hop, so
 * it works once the upload ACL is enabled. For non-message images that should not
 * carry MessageAttachment's chrome (lightbox, download chip) — e.g. a forum-post
 * cover. External (non-/api/uploads) URLs are rendered directly.
 */
export function AuthImage({ src, alt, className, onError }: { src: string; alt?: string; className?: string; onError?: () => void }) {
  const fullUrl = src.startsWith('http') ? src : `${getBackendOrigin()}${src}`;
  const isLocalUpload = fullUrl.includes('/api/uploads/') || fullUrl.startsWith(getBackendOrigin());
  const [blobUrl, setBlobUrl] = useState<string | null>(isLocalUpload ? null : fullUrl);

  useEffect(() => {
    if (!isLocalUpload) { setBlobUrl(fullUrl); return; }
    let objectUrl: string | null = null;
    const ac = new AbortController();
    fetchMediaBlobUrl(fullUrl, apiClient.getToken(), ac.signal)
      .then((blob) => { objectUrl = URL.createObjectURL(blob); setBlobUrl(objectUrl); })
      .catch(() => { if (!ac.signal.aborted) onError?.(); });
    return () => { ac.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [fullUrl, isLocalUpload]);

  if (!blobUrl) return <div className={className} aria-busy="true" />;
  return <img src={blobUrl} alt={alt ?? ''} className={className} onError={onError} />;
}
