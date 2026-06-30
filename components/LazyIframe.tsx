// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useRef, useState, useEffect, useId } from 'react';

interface LazyIframeProps {
  src: string;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
  allow?: string;
  sandbox?: string;
  loading?: 'lazy' | 'eager';
  referrerPolicy?: React.HTMLAttributeReferrerPolicy;
  width?: string | number;
  height?: string | number;
  frameBorder?: string | number;
  allowFullScreen?: boolean;
  /** Placeholder height before iframe loads */
  placeholderHeight?: number;
}

// Load-zone margin: how far outside the viewport an embed starts rendering.
// 600px pre-warms embeds before they hit the viewport so scrolled-to content is
// already live by the time it's visible.
const LOAD_MARGIN_PX = 600;

// Globally cap mounted iframes to prevent long chats with many embeds from
// accumulating unbounded memory/video-contexts. Far above the typical visible
// working set (2-4 at a time), so a user's reading window is never evicted,
// but well below the 100+ embeds a long chat can have mounted via Virtuoso's
// keep-alive zone.
const LRU_CAPACITY = 20;

// Two-tier registry: items currently in the load zone are protected from
// eviction (keeps the visible reading window flicker-free even if more than
// 20 embeds are simultaneously on-screen). Items that have left the zone are
// evicted in LRU order when total mounted exceeds capacity.
const inZone = new Set<string>();
const outOfZone = new Map<string, () => void>();

function evictIfOver(): void {
  while (inZone.size + outOfZone.size > LRU_CAPACITY && outOfZone.size > 0) {
    const firstEntry = outOfZone.entries().next().value;
    if (!firstEntry) break;
    const [oldestId, oldestUnload] = firstEntry;
    outOfZone.delete(oldestId);
    oldestUnload();
  }
}

function enterZone(id: string): void {
  outOfZone.delete(id);
  inZone.add(id);
  evictIfOver();
}

function leaveZone(id: string, unload: () => void): void {
  if (!inZone.has(id)) return;
  inZone.delete(id);
  outOfZone.set(id, unload); // Map insertion order = LRU (front = oldest)
  evictIfOver();
}

function deregister(id: string): void {
  inZone.delete(id);
  outOfZone.delete(id);
}

/**
 * Iframe that only loads its src when scrolled near the viewport.
 *
 * Uses an IntersectionObserver with a 600px pre-warm margin. Mounted iframes
 * are tracked in a module-level LRU (cap 20). When the cap is exceeded, the
 * least-recently-out-of-zone iframe is forced to unload. Iframes currently
 * in the load zone are protected from eviction so the visible working set
 * never flickers — this is the "pop-in" prevention Discord uses.
 */
export const LazyIframe = React.memo(function LazyIframe({
  src, title, className, style, allow, sandbox, loading, referrerPolicy,
  width, height, frameBorder, allowFullScreen, placeholderHeight = 300,
}: LazyIframeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const [isRendered, setIsRendered] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Closure-captured unload callback — LRU stores this and fires it when
    // evicting. Stable across the effect's lifetime.
    const unload = () => setIsRendered(false);

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsRendered(true);
          enterZone(id);
        } else {
          leaveZone(id, unload);
        }
      },
      { rootMargin: `${LOAD_MARGIN_PX}px 0px ${LOAD_MARGIN_PX}px 0px` },
    );
    observer.observe(el);

    return () => {
      observer.disconnect();
      deregister(id);
    };
  }, [id]);

  return (
    // w-full h-full so a parent with explicit dimensions (e.g. aspect-video)
    // passes height down to the iframe via className="h-full" — without this
    // the iframe auto-sized itself and blew out the aspect container.
    // minHeight only applies while the placeholder is showing.
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ minHeight: isRendered ? undefined : placeholderHeight }}
    >
      {isRendered ? (
        <iframe
          src={src}
          title={title}
          className={className}
          style={style}
          allow={allow}
          sandbox={sandbox}
          loading={loading}
          referrerPolicy={referrerPolicy}
          width={width}
          height={height}
          frameBorder={frameBorder}
          allowFullScreen={allowFullScreen}
        />
      ) : (
        <div
          className="w-full h-full flex items-center justify-center rounded-lg"
          style={{
            minHeight: placeholderHeight,
            background: 'var(--fill-hover)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--text-tertiary)',
            fontSize: 12,
          }}
        >
          Loading embed...
        </div>
      )}
    </div>
  );
});
