// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

interface CreditsPageProps {}

/* ─── Credits Data ─── */

const CREDITS = [
  { name: 'LiveKit', description: 'Open-source WebRTC SFU powering voice and video calls.', license: 'Apache 2.0', url: 'https://livekit.io', author: 'LiveKit, Inc.' },
  { name: 'Twemoji', description: 'Emoji graphics used throughout the app for consistent, colorful emoji rendering.', license: 'CC-BY 4.0', url: 'https://github.com/jdecked/twemoji', author: 'Twitter / Jdecked contributors' },
  { name: 'Lucide Icons', description: 'Icon set used for UI elements across the application.', license: 'ISC License', url: 'https://lucide.dev', author: 'Lucide contributors' },
  { name: 'Klipy', description: 'GIF search and trending API powering the GIF picker.', license: 'API Service', url: 'https://klipy.com', author: 'Klipy' },
  { name: 'Stripe', description: 'Payment processing for subscriptions and billing.', license: 'Service', url: 'https://stripe.com', author: 'Stripe, Inc.' },
  { name: 'Resend', description: 'Transactional email service for verification codes and notifications.', license: 'Service', url: 'https://resend.com', author: 'Resend, Inc.' },
  { name: 'Cloudflare', description: 'CDN, DDoS protection, and Turnstile CAPTCHA verification.', license: 'Service', url: 'https://www.cloudflare.com', author: 'Cloudflare, Inc.' },
  { name: 'DiceBear', description: 'Identicon avatars used as default placeholders for group chats.', license: 'MIT License', url: 'https://www.dicebear.com', author: 'DiceBear contributors' },
  { name: 'Plus Jakarta Sans', description: 'Primary typeface used throughout the interface.', license: 'SIL OFL 1.1', url: 'https://fonts.google.com/specimen/Plus+Jakarta+Sans', author: 'Gumpita Rahayu / Tokotype' },
  { name: 'JetBrains Mono', description: 'Monospace typeface used for code and technical content.', license: 'SIL OFL 1.1', url: 'https://www.jetbrains.com/lp/mono/', author: 'JetBrains' },
  { name: 'React', description: 'JavaScript library for building user interfaces.', license: 'MIT License', url: 'https://react.dev', author: 'Meta / React contributors' },
  { name: 'Lexical', description: 'Extensible text editor framework powering the message input and rich text editing.', license: 'MIT License', url: 'https://lexical.dev', author: 'Meta / Lexical contributors' },
  { name: 'Electron', description: 'Framework for building cross-platform desktop apps with web technologies.', license: 'MIT License', url: 'https://www.electronjs.org', author: 'OpenJS Foundation / Electron contributors' },
  { name: 'Socket.IO', description: 'Real-time bidirectional event-based communication library.', license: 'MIT License', url: 'https://socket.io', author: 'Socket.IO contributors' },
  { name: 'Tailwind CSS', description: 'Utility-first CSS framework used for styling.', license: 'MIT License', url: 'https://tailwindcss.com', author: 'Tailwind Labs' },
  { name: 'Prisma', description: 'Next-generation ORM for database access and migrations.', license: 'Apache 2.0', url: 'https://www.prisma.io', author: 'Prisma Data, Inc.' },
  { name: 'Vite', description: 'Fast frontend build tool powering the development experience.', license: 'MIT License', url: 'https://vite.dev', author: 'Evan You / Vite contributors' },
  { name: 'i18next', description: 'Internationalization framework for multi-language support.', license: 'MIT License', url: 'https://www.i18next.com', author: 'i18next contributors' },
  { name: 'ts-mls', description: 'RFC 9420 Messaging Layer Security (MLS) implementation powering end-to-end encrypted DMs and group DMs.', license: 'MIT License', url: 'https://github.com/LukaJCB/ts-mls', author: 'Luka Jacobowitz (lukajcb)' },
  { name: 'hpke-js (X-Wing KEM)', description: 'Post-quantum hybrid key encapsulation (X-Wing: X25519 + ML-KEM-768) used as the default MLS ciphersuite.', license: 'MIT License', url: 'https://github.com/dajiaji/hpke-js', author: 'Ajitomi Daisuke / hpke-js contributors' },
  { name: 'TweetNaCl', description: 'X25519/Ed25519 primitives for the encryption-key recovery vault, the roaming device identity, and voice/stage call-key distribution.', license: 'Unlicense', url: 'https://tweetnacl.js.org', author: 'Dmitry Chestnykh / TweetNaCl contributors' },
  { name: 'Sharp', description: 'High-performance image processing for thumbnails and optimization.', license: 'Apache 2.0', url: 'https://sharp.pixelplumbing.com', author: 'Lovell Fuller' },
  { name: 'Sentry', description: 'Error monitoring and performance tracking.', license: 'FSL', url: 'https://sentry.io', author: 'Sentry / Functional Software, Inc.' },
  { name: 'Zod', description: 'TypeScript-first schema validation for API inputs.', license: 'MIT License', url: 'https://zod.dev', author: 'Colin McDonnell' },
  { name: 'MiniSearch', description: 'Lightweight full-text search engine for message search.', license: 'MIT License', url: 'https://lucaong.github.io/minisearch/', author: 'Luca Ongaro' },
  { name: 'SimpleWebAuthn', description: 'WebAuthn / passkey support for passwordless sign-in.', license: 'MIT License', url: 'https://simplewebauthn.dev', author: 'SimpleWebAuthn contributors' },
  { name: 'PDQ (pdq-wasm)', description: 'Perceptual image hashing for duplicate detection.', license: 'MIT License', url: 'https://github.com/facebook/ThreatExchange', author: 'Meta / Facebook' },
  { name: 'IndexedDB (idb)', description: 'Promise-based IndexedDB wrapper for local storage.', license: 'ISC License', url: 'https://github.com/jakearchibald/idb', author: 'Jake Archibald' },
  { name: 'BullMQ', description: 'Redis-based job queue for background processing.', license: 'MIT License', url: 'https://docs.bullmq.io', author: 'Taskforce.sh' },
  { name: 'electron-updater', description: 'Auto-update support for the desktop app.', license: 'MIT License', url: 'https://www.electron.build/auto-update', author: 'electron-builder' },
  { name: 'tailwindcss-animate', description: 'Animation utilities for Tailwind CSS.', license: 'MIT License', url: 'https://github.com/jamiebuilds/tailwindcss-animate', author: 'Jamie Kyle' },
  { name: 'Pino', description: 'Fast JSON logger for the backend server.', license: 'MIT License', url: 'https://getpino.io', author: 'Pino contributors' },
  { name: 'Motion', description: 'Animation library (formerly Framer Motion) powering transitions, scroll effects, and micro-interactions.', license: 'MIT License', url: 'https://motion.dev', author: 'Matt Perry / Motion' },
  { name: 'COBE', description: 'Lightweight WebGL globe used for the interactive 3D globe visual.', license: 'MIT License', url: 'https://cobe.vercel.app', author: 'Shu Ding' },
  { name: 'shadcn/ui', description: 'Tailwind CSS component patterns and CLI scaffolding used as a starting point for UI components.', license: 'MIT License', url: 'https://ui.shadcn.com', author: 'shadcn' },
  { name: 'Magic UI', description: 'Animated UI components including particles, number tickers, and border beams.', license: 'MIT License', url: 'https://magicui.design', author: 'Magic UI contributors' },
  { name: 'Clash Display', description: 'Bold display typeface used for headings across the landing and info pages.', license: 'ITF Free Font License', url: 'https://www.fontshare.com/fonts/clash-display', author: 'Indian Type Foundry' },
  { name: 'Satoshi', description: 'Clean sans-serif typeface used for body text on the landing and info pages.', license: 'ITF Free Font License', url: 'https://www.fontshare.com/fonts/satoshi', author: 'Indian Type Foundry' },
  { name: 'Geist', description: 'Variable sans typeface used across the product UI.', license: 'SIL OFL 1.1', url: 'https://vercel.com/font', author: 'Vercel' },
  { name: 'OpenDyslexic', description: 'Typeface option available for dyslexia-friendly rendering.', license: 'SIL OFL 1.1', url: 'https://opendyslexic.org', author: 'Abelardo Gonzalez' },
  { name: 'Express', description: 'Fast, unopinionated web framework powering the backend HTTP API.', license: 'MIT License', url: 'https://expressjs.com', author: 'OpenJS Foundation / Express contributors' },
  { name: 'Zustand', description: 'Minimal state management used across the React frontend.', license: 'MIT License', url: 'https://zustand-demo.pmnd.rs', author: 'Poimandres' },
  { name: 'React Router', description: 'Client-side routing for the React app.', license: 'MIT License', url: 'https://reactrouter.com', author: 'Remix / React Router contributors' },
  { name: 'React Virtuoso', description: 'Virtualized lists used to render long message histories smoothly.', license: 'MIT License', url: 'https://virtuoso.dev', author: 'Petyo Ivanov' },
  { name: 'bcrypt', description: 'Password hashing at rest with constant-time comparison.', license: 'MIT License', url: 'https://github.com/kelektiv/node.bcrypt.js', author: 'kelektiv contributors' },
  { name: 'hash-wasm', description: 'WebAssembly Argon2id key derivation for the DM encryption key backup blob.', license: 'MIT License', url: 'https://github.com/Daninet/hash-wasm', author: 'Dani Biró' },
  { name: 'DOMPurify', description: 'XSS-safe HTML sanitization for rendered message content.', license: 'Apache 2.0', url: 'https://github.com/cure53/DOMPurify', author: 'Cure53' },
  { name: 'Helmet', description: 'Security-related HTTP headers middleware on the backend.', license: 'MIT License', url: 'https://helmetjs.github.io', author: 'Evan Hahn / Helmet contributors' },
  { name: 'otplib', description: 'TOTP generation and verification for multi-factor authentication.', license: 'MIT License', url: 'https://github.com/yeojz/otplib', author: 'Gerald Yeo' },
  { name: 'ioredis', description: 'Redis client used for pub/sub, queues, and caching.', license: 'MIT License', url: 'https://github.com/redis/ioredis', author: 'Zihua Li / Redis' },
  { name: 'AWS SDK for JavaScript', description: 'S3 client powering Cloudflare R2 uploads and presigned URLs.', license: 'Apache 2.0', url: 'https://aws.amazon.com/sdk-for-javascript/', author: 'Amazon Web Services' },
  { name: 'Multer', description: 'Multipart form-data handling for file uploads.', license: 'MIT License', url: 'https://github.com/expressjs/multer', author: 'Express contributors' },
  { name: 'web-push', description: 'Web Push protocol implementation for browser push notifications.', license: 'MIT License', url: 'https://github.com/web-push-libs/web-push', author: 'web-push-libs contributors' },
  { name: 'RNNoise (WASM)', description: 'RNNoise-based noise suppression in the voice capture pipeline.', license: 'MIT License', url: 'https://github.com/jitsi/rnnoise-wasm', author: '8x8 / Jitsi' },
  { name: 'DeepFilterNet', description: 'Deep-learning noise suppression option in the voice capture pipeline.', license: 'Apache-2.0 / MIT', url: 'https://github.com/Rikorose/DeepFilterNet', author: 'DeepFilterNet contributors' },
  { name: 'MediaPipe Tasks Vision', description: 'Background segmentation and blur for the camera pipeline.', license: 'Apache 2.0', url: 'https://developers.google.com/mediapipe', author: 'Google' },
  { name: 'LiveKit Track Processors', description: 'Track processors (blur, virtual background) for LiveKit video.', license: 'Apache 2.0', url: 'https://github.com/livekit/track-processors-js', author: 'LiveKit, Inc.' },
  { name: 'highlight.js', description: 'Syntax highlighting for code blocks in messages.', license: 'BSD-3-Clause', url: 'https://highlightjs.org', author: 'Ivan Sagalaev / highlight.js contributors' },
  { name: 'Turndown', description: 'HTML to Markdown conversion for paste handling.', license: 'MIT License', url: 'https://github.com/mixmark-io/turndown', author: 'Mixmark IO' },
  { name: 'obscenity', description: 'Robust profanity detection used to validate usernames.', license: 'MIT License', url: 'https://github.com/jo3-l/obscenity', author: 'Joseph Liu' },
];

/* ─── Main ───────────────────────────────────────────────────────────────
   Visual style matches `components/LegalPage.tsx` (and the legal HTML
   fragments under public/_legal-*.html): system font, max-width 720,
   subtle borders, no animated particles / scroll progress / per-card
   colour swatches. Credits are a long quiet document, not a marketing
   surface. */

export const CreditsPage: React.FC<CreditsPageProps> = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { document.title = 'Howl | Credits'; }, []);

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
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.textDecoration = 'underline'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.textDecoration = 'none'; }}
        >
          &larr; {t('common.back')}
        </button>

        <h1 className="credits-h1">{t('credits.title')}</h1>
        <p className="credits-meta">{CREDITS.length} libraries, services and assets that power Howl.</p>

        <p className="credits-intro">{t('credits.description')}</p>

        <ul className="credits-list">
          {CREDITS.map((c) => (
            <li key={c.name} className="credit-item">
              <div className="credit-head">
                <a href={c.url} target="_blank" rel="noopener noreferrer" className="credit-name">
                  {c.name}
                </a>
                <span className="credit-license">{c.license}</span>
              </div>
              <p className="credit-desc">{c.description}</p>
              <p className="credit-author">{c.author}</p>
            </li>
          ))}
        </ul>
      </div>

      <style>{`
        .credits-h1 { color: var(--text-primary); font-size: 1.75rem; margin-bottom: 0.25rem; }
        .credits-meta { color: var(--text-secondary); font-size: 0.8rem; margin-bottom: 2rem; }
        .credits-intro { font-size: 0.875rem; margin-bottom: 2rem; }

        .credits-list { list-style: none; padding: 0; margin: 0; }
        .credit-item {
          padding: 0.9rem 0;
          border-bottom: 1px solid var(--border-subtle);
        }
        .credit-item:last-child { border-bottom: none; }

        .credit-head {
          display: flex; align-items: baseline; gap: 0.5rem;
          margin-bottom: 0.15rem;
        }
        .credit-name {
          color: var(--text-primary);
          font-weight: 600;
          font-size: 0.95rem;
          text-decoration: none;
        }
        .credit-name:hover { text-decoration: underline; color: var(--cyan-accent); }
        .credit-license {
          color: var(--text-secondary);
          font-size: 0.75rem;
          font-variant-numeric: tabular-nums;
        }

        .credit-desc {
          font-size: 0.875rem;
          margin: 0.1rem 0;
          color: var(--text-secondary);
        }
        .credit-author {
          font-size: 0.75rem;
          margin: 0;
          color: var(--text-secondary);
          opacity: 0.7;
        }
      `}</style>
    </div>
  );
};
