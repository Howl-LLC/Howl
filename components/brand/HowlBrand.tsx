// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * HowlBrand — canonical logo + wordmark lockup.
 *
 * Single source of truth for the in-nav Howl brand mark. Everywhere a small
 * Howl logo sits next to the "Howl" word — landing-page top-left, Discover
 * header, etc. — it should render this component so the size, font, color
 * tokens, and corner radius stay in lockstep.
 *
 * Spec (matches the landing-page top-left header at LandingPage.tsx ~L224-227):
 *   - logo: 36×36, object-cover, borderRadius 4 (absolute, sampled directly
 *           from `howl-logo.png` corner curvature)
 *   - wordmark: var(--font-display) (= Clash Display), 22px, weight 700,
 *               letterSpacing -0.02em
 *   - gap between them: 10px
 *
 * This component renders only the inner lockup; the caller wraps it in
 * whatever <a> / <Link> / <span> they need.
 *
 * `logoSrc` lets the landing page pass its bundle-relative path
 * (`asset('howl-logo-v4.png')` → `/landing/assets/howl-logo-v4.png`) while
 * everywhere else uses the default canonical `/howl-logo.png`.
 */
import React from 'react';
import { assetPath } from '../../utils/assetPath';

interface HowlBrandProps {
  /** Override the logo image src. Defaults to the canonical `/howl-logo.png`. */
  logoSrc?: string;
  /** Optional className for outer wrapper (e.g. additional flex / spacing). */
  className?: string;
  /** Optional color override for the wordmark. Defaults to `var(--text)` so
   *  the mark inherits the surrounding theme's primary text color. */
  color?: string;
}

export const HowlBrand: React.FC<HowlBrandProps> = ({
  logoSrc,
  className = '',
  color = 'var(--text)',
}) => {
  const src = logoSrc ?? assetPath('/howl-logo.png');
  return (
    <span className={`inline-flex items-center ${className}`} style={{ gap: 10 }}>
      <img
        src={src}
        alt="Howl"
        style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 4 }}
        decoding="async"
        width={36}
        height={36}
      />
      <span
        style={{
          color,
          fontFamily: 'var(--font-display)',
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: '-0.02em',
          lineHeight: 1,
        }}
      >
        Howl
      </span>
    </span>
  );
};

export default HowlBrand;
