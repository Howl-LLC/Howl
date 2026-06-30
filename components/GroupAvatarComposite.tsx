// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { Users } from 'lucide-react';
import { LetterAvatar } from './LetterAvatar';

interface GroupAvatarCompositeProps {
  members: Array<{ avatar?: string | null; username: string }>;
  size: number;
  className?: string;
}

const POSITIONS: Record<number, (size: number, d: number) => Array<{ style: React.CSSProperties; z: number }>> = {
  2: (size, d) => [
    { style: { top: 0, left: 0, width: d, height: d }, z: 2 },
    { style: { bottom: 0, right: 0, width: d, height: d }, z: 1 },
  ],
  3: (_size, d) => [
    { style: { top: 0, left: '50%', transform: 'translateX(-50%)', width: d, height: d }, z: 3 },
    { style: { bottom: 0, left: 0, width: d, height: d }, z: 2 },
    { style: { bottom: 0, right: 0, width: d, height: d }, z: 1 },
  ],
  4: (_size, d) => [
    { style: { top: 0, left: 0, width: d, height: d }, z: 4 },
    { style: { top: 0, right: 0, width: d, height: d }, z: 3 },
    { style: { bottom: 0, left: 0, width: d, height: d }, z: 2 },
    { style: { bottom: 0, right: 0, width: d, height: d }, z: 1 },
  ],
};

const DIAMETER_RATIO: Record<number, number> = { 2: 0.62, 3: 0.56, 4: 0.53 };

export const GroupAvatarComposite: React.FC<GroupAvatarCompositeProps> = React.memo(({ members, size, className }) => {
  const count = Math.min(members.length, 4);

  if (count === 0) {
    return (
      <div className={className} style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Users size={Math.round(size * 0.47)} className="text-slate-400" />
      </div>
    );
  }

  if (count === 1) {
    return <LetterAvatar avatar={members[0].avatar} username={members[0].username} size={size} className={`rounded-full ${className ?? ''}`} />;
  }

  const d = Math.round(size * DIAMETER_RATIO[count]);
  const slots = POSITIONS[count](size, d);

  return (
    <div className={className} style={{ position: 'relative', width: size, height: size }}>
      {slots.map((slot, i) => (
        <LetterAvatar
          key={i}
          avatar={members[i].avatar}
          username={members[i].username}
          size={d}
          className="rounded-full"
          style={{ position: 'absolute', zIndex: slot.z, border: '1.5px solid var(--bg-app)', ...slot.style }}
        />
      ))}
    </div>
  );
});
