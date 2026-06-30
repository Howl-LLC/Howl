// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { LetterAvatar } from './LetterAvatar';
import { getAvatarEffectClass } from '../shared/planPerks';

interface UserAvatarProps {
  user: {
    avatar?: string | null;
    username: string;
    avatarEffect?: string | null;
    effectivePlan?: string | null;
    stripePlan?: string | null;
  };
  size: number;
  /** Merged onto the wrapper (e.g. "ring-2 ring-emerald-500/40"). */
  className?: string;
  /** Merged onto the inner <LetterAvatar> (e.g. "opacity-50"). */
  innerClassName?: string;
  /** Overlays positioned absolutely inside the wrapper (TypingStatusDot, etc.). */
  children?: React.ReactNode;
  style?: React.CSSProperties;
  /** Avatar corner shape. 'squircle' (default) matches the server-rail icon radius; pass 'circle' to opt out. */
  shape?: 'circle' | 'squircle';
}

/**
 * Renders a user's avatar with their Pro "avatar effect" (glow/ring/etc.) when applicable.
 * The wrapper is `overflow-visible` because effects are `box-shadow` / `::before` pseudo-elements
 * that render outside the avatar's bounding box — they would be clipped if applied to LetterAvatar directly.
 *
 * Non-Pro users and missing `avatarEffect` render with no effect class (identical visual to a plain LetterAvatar wrapper).
 */
export const UserAvatar: React.FC<UserAvatarProps> = React.memo(({
  user,
  size,
  className = '',
  innerClassName = '',
  children,
  style,
  shape = 'squircle',
}) => {
  const isPro = (user.effectivePlan ?? user.stripePlan) === 'pro';
  const effectCls = isPro ? getAvatarEffectClass(user.avatarEffect) : '';
  // 'squircle' matches the server-rail icon radius (--radius-lg = 12px); 'circle' is the default everywhere else.
  const radiusCls = shape === 'squircle' ? 'rounded-[var(--radius-lg)]' : 'rounded-full';
  return (
    <div
      className={`relative shrink-0 overflow-visible ${radiusCls} ${effectCls} ${className}`}
      style={{ width: size, height: size, ...style }}
    >
      <LetterAvatar
        avatar={user.avatar}
        username={user.username}
        size={size}
        className={`${radiusCls} ${innerClassName}`}
      />
      {children}
    </div>
  );
});

export default UserAvatar;
