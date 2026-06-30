// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { useSharedIsSpeaking } from '../hooks/useAudioLevel';

/** Wraps name with blue highlight when audio level is above threshold (user is talking) */
export const SpeakingHighlight = React.memo(({
  stream,
  children,
  className = '',
  speakingClassName = 'text-[var(--cyan-accent)]',
  threshold = 0.06,
}: {
  stream: MediaStream | null;
  children: React.ReactNode;
  className?: string;
  speakingClassName?: string;
  threshold?: number;
}) => {
  // Boolean-based: only re-renders on the speaking/not-speaking flip.
  const isSpeaking = useSharedIsSpeaking(stream, threshold);
  return <span className={isSpeaking ? `${className} ${speakingClassName}`.trim() : className}>{children}</span>;
});
SpeakingHighlight.displayName = 'SpeakingHighlight';
