// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

interface LegalPageProps {
  htmlFile: string;
}

export function LegalPage({ htmlFile }: LegalPageProps) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(htmlFile)
      .then((res) => res.text())
      .then((html) => setContent(html))
      .catch(() => setContent('<p>Failed to load page.</p>'))
      .finally(() => setLoading(false));
  }, [htmlFile]);

  // Set document.title from the h1 content
  useEffect(() => {
    if (!content) return;
    const match = content.match(/<h1[^>]*>(.*?)<\/h1>/i);
    if (match) {
      document.title = match[1].replace(/&mdash;/g, '\u2014').replace(/&amp;/g, '&');
    }
    // Scroll to top when content loads
    scrollRef.current?.scrollTo(0, 0);
  }, [content]);

  const handleClick = (e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest('a');
    if (!target) return;
    const href = target.getAttribute('href');
    if (href && href.startsWith('/')) {
      e.preventDefault();
      navigate(href);
    }
  };

  return (
    <div
      ref={scrollRef}
      className="h-screen overflow-y-auto"
      style={{
        background: 'var(--bg-app)',
        color: 'var(--text-secondary)',
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        lineHeight: 1.7,
        padding: '2rem',
      }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto', paddingBottom: '4rem' }}>
        <button
          type="button"
          onClick={() => navigate(-1)}
          style={{
            display: 'inline-block',
            marginBottom: '1.5rem',
            color: 'var(--cyan-accent)',
            background: 'none',
            border: 'none',
            fontSize: '0.85rem',
            cursor: 'pointer',
            padding: 0,
            fontFamily: 'inherit',
          }}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.textDecoration = 'underline'; }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.textDecoration = 'none'; }}
        >
          &larr; Back
        </button>
        {loading ? (
          <p style={{ color: 'var(--text-secondary)' }}>Loading&hellip;</p>
        ) : (
          <div
            className="legal-content"
            onClick={handleClick}
            dangerouslySetInnerHTML={{ __html: content }}
          />
        )}
      </div>
      <style>{`
        .legal-content h1 { color: var(--text-primary); font-size: 1.75rem; margin-bottom: 0.25rem; }
        .legal-content h2 { color: var(--text-primary); font-size: 1.1rem; margin-top: 2rem; margin-bottom: 0.5rem; border-bottom: 1px solid var(--border-subtle); padding-bottom: 0.4rem; }
        .legal-content h3 { color: var(--text-primary); font-size: 0.95rem; margin-top: 1.25rem; margin-bottom: 0.35rem; }
        .legal-content p, .legal-content li { font-size: 0.875rem; margin-bottom: 0.75rem; }
        .legal-content ul, .legal-content ol { padding-left: 1.5rem; }
        .legal-content li { margin-bottom: 0.35rem; }
        .legal-content a { color: var(--cyan-accent); }
        .legal-content a:hover { text-decoration: underline; }
        .legal-content hr { border: none; border-top: 1px solid var(--border-subtle); margin: 1.5rem 0; }
        .legal-content .meta { color: var(--text-secondary); font-size: 0.8rem; margin-bottom: 2rem; }
        .legal-content table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.85rem; }
        .legal-content th, .legal-content td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border-subtle); }
        .legal-content th { color: var(--text-primary); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }
        .legal-content strong { color: var(--text-primary); }
        .legal-content code { background: var(--border-subtle); padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.8rem; color: var(--text-primary); }
      `}</style>
    </div>
  );
}
