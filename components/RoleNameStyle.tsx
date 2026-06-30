// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect } from 'react';
import { NAME_FONTS } from '../shared/planPerks';
import { isValidCssColor } from '../utils/securityUtils';
import { loadFont } from '../utils/lazyFont';

import type { RoleStyle } from '../types/server';
export type { RoleStyle };

// Pixel font (Press Start 2P) is bitmap-style — its glyphs fill the em-box and read
// visually larger than proportional fonts at the same font-size. Scale to match.
const NAME_FONT_SIZE_SCALE: Record<string, number> = {
  pixel: 0.72,
};

interface RoleNameStyleProps {
  name: string;
  color?: string | null;
  style?: RoleStyle;
  className?: string;
  overrideColor?: string | null;
  overrideFont?: string | null;
  nameEffect?: string | null;
}

/**
 * Outer wrapper that remounts the inner styled span whenever the props that
 * feed inline `style` AND a running CSS animation change together (color,
 * font, effect). Without this, changing nameColor while shimmer/neon/gradient
 * animations are running produces stale-paint artifacts: both effects use
 * baseColor inside their gradient/shadow, but reapplying inline styles to a
 * span with an in-flight animation interleaves old and new gradient state
 * mid-cycle. Keying the inner component throws away the old DOM node and
 * starts the animation fresh on a new one.
 *
 * Lives here (not at every call site) so all 25 consumers — chat, DM,
 * member list, profile popup, voice cards, search, forum, stages, etc. —
 * inherit the fix automatically when remote users change their pro
 * customization while their name is on screen.
 */
export const RoleNameStyle: React.FC<RoleNameStyleProps> = (props) => {
  const colorKey = props.overrideColor ?? props.color ?? '';
  const fontKey = props.overrideFont ?? '';
  const effectKey = props.nameEffect ?? '';
  const remountKey = `${effectKey}|${colorKey}|${fontKey}`;
  return <RoleNameStyleInner key={remountKey} {...props} />;
};

const RoleNameStyleInner: React.FC<RoleNameStyleProps> = ({ name, color, style = 'solid', className = '', overrideColor, overrideFont, nameEffect }) => {
  const rawColor = overrideColor || color;
  const baseColor = (rawColor && isValidCssColor(rawColor)) ? rawColor : 'var(--text-primary)';
  const fontEntry = overrideFont ? NAME_FONTS.find(f => f.key === overrideFont) : null;
  const fontFamily = fontEntry?.family;
  const fontScale = overrideFont ? NAME_FONT_SIZE_SCALE[overrideFont] : undefined;
  const fontSize = fontScale ? `${fontScale}em` : undefined;

  // Lazy-load decorative font WOFF2 on first render that uses it
  useEffect(() => {
    if (overrideFont) loadFont(overrideFont);
  }, [overrideFont]);

  const effectStyle: React.CSSProperties = {};
  const effectClass = '';
  if (nameEffect === 'glow') {
    effectStyle.textShadow = `0 0 8px ${baseColor}, 0 0 16px ${baseColor}80`;
  } else if (nameEffect === 'rainbow') {
    effectStyle.background = 'linear-gradient(90deg, #ff6b6b, #feca57, #48dbfb, #ff9ff3, #ff6b6b)';
    effectStyle.backgroundSize = '200% auto';
    effectStyle.WebkitBackgroundClip = 'text';
    effectStyle.WebkitTextFillColor = 'transparent';
    effectStyle.backgroundClip = 'text';
    effectStyle.animation = 'name-rainbow 3s linear infinite';
  } else if (nameEffect === 'shimmer') {
    effectStyle.background = `linear-gradient(90deg, ${baseColor} 40%, #fff 50%, ${baseColor} 60%)`;
    effectStyle.backgroundSize = '200% auto';
    effectStyle.WebkitBackgroundClip = 'text';
    effectStyle.WebkitTextFillColor = 'transparent';
    effectStyle.backgroundClip = 'text';
    effectStyle.animation = 'name-shimmer 2s linear infinite';
  } else if (nameEffect === 'fire') {
    effectStyle.background = 'linear-gradient(180deg, #ff6b35, #ff4500, #ff0000)';
    effectStyle.WebkitBackgroundClip = 'text';
    effectStyle.WebkitTextFillColor = 'transparent';
    effectStyle.backgroundClip = 'text';
  } else if (nameEffect === 'neon') {
    effectStyle.textShadow = `0 0 4px ${baseColor}, 0 0 12px ${baseColor}80, 0 0 24px ${baseColor}40`;
    effectStyle.animation = 'name-neon-flicker 4s infinite';
    effectStyle.contain = 'layout style';
    effectStyle.willChange = 'opacity';
  } else if (nameEffect === 'pulse') {
    effectStyle.animation = 'name-pulse-glow 2s ease-in-out infinite';
    effectStyle.contain = 'layout style';
    effectStyle.willChange = 'text-shadow, opacity';
  } else if (nameEffect === 'gradient') {
    effectStyle.background = 'linear-gradient(90deg, #a78bfa, var(--cyan-accent), #34d399, #a78bfa)';
    effectStyle.backgroundSize = '200% auto';
    effectStyle.WebkitBackgroundClip = 'text';
    effectStyle.WebkitTextFillColor = 'transparent';
    effectStyle.backgroundClip = 'text';
    effectStyle.animation = 'name-gradient 4s linear infinite';
  }

  const hasClipEffect = nameEffect === 'rainbow' || nameEffect === 'shimmer' || nameEffect === 'fire' || nameEffect === 'gradient';

  const fontWeight = overrideFont === 'bold' ? 900 : 700;
  const letterSpacing = overrideFont === 'spaced' ? '0.25em' : undefined;

  const dataAttr = (color && isValidCssColor(color)) ? { 'data-role-color': color } : {};
  const truncateBase: React.CSSProperties = { textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%', display: 'inline-block', verticalAlign: 'bottom' };
  const truncate: React.CSSProperties = { ...truncateBase, overflow: 'hidden' };
  const truncateClip: React.CSSProperties = truncateBase;

  if (!hasClipEffect && style === 'gradient') {
    return (
      <span className={`${className} ${effectClass}`} {...dataAttr} style={{
        background: `linear-gradient(135deg, ${baseColor}, ${baseColor}99)`,
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
        fontWeight, letterSpacing, fontFamily, fontSize, ...effectStyle, ...truncate
      }}>{name}</span>
    );
  }
  if (!hasClipEffect && style === 'holographic') {
    return (
      <span className={`${className} ${effectClass}`} {...dataAttr} style={{
        background: `linear-gradient(90deg, ${baseColor}, #a78bfa, ${baseColor}, #67e8f9)`,
        backgroundSize: '200% auto', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        backgroundClip: 'text', fontWeight, letterSpacing, animation: 'role-holographic 3s ease infinite', fontFamily, fontSize, ...effectStyle, ...truncate
      }}>{name}</span>
    );
  }

  if (hasClipEffect) {
    return <span className={`${className} ${effectClass}`} {...dataAttr} style={{ fontWeight, letterSpacing, fontFamily, fontSize, ...effectStyle, ...truncateClip }}>{name}</span>;
  }

  return <span className={`${className} ${effectClass}`} {...dataAttr} style={{ color: baseColor, fontWeight, letterSpacing, fontFamily, fontSize, ...effectStyle, ...truncate }}>{name}</span>;
};
