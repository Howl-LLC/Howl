// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { User } from '../types';
import { formatUsername } from '../types';

export type MentionSuggestionType = 'user' | 'role' | 'everyone' | 'here';

export interface MentionSuggestion {
  type: MentionSuggestionType;
  label: string;
  value: string;
  userId?: string;
  role?: string;
}

/** Get suggestions for @ mention autocomplete. query is the text after @ (e.g. "raj" or "every"). */
export function getMentionSuggestions(
  query: string,
  users: User[],
  options: {
    roles?: string[];
    showEveryone?: boolean;
    showHere?: boolean;
  }
): MentionSuggestion[] {
  const q = query.trim().toLowerCase();
  const out: MentionSuggestion[] = [];

  if (options.showEveryone !== false) {
    if (!q || 'everyone'.startsWith(q)) {
      out.push({ type: 'everyone', label: 'everyone', value: '@everyone' });
    }
  }
  if (options.showHere !== false) {
    if (!q || 'here'.startsWith(q)) {
      out.push({ type: 'here', label: 'here (online only)', value: '@here' });
    }
  }

  if (options.roles?.length) {
    for (const role of options.roles) {
      const r = role.toLowerCase();
      if (!q || r.startsWith(q) || r.includes(q)) {
        if (!out.some((x) => x.type === 'role' && x.role?.toLowerCase() === r)) {
          out.push({ type: 'role', label: role, value: `@${role}`, role });
        }
      }
    }
  }

  for (const user of users) {
    const name = formatUsername(user);
    const nameLower = name.toLowerCase();
    if (!q || nameLower.startsWith(q) || nameLower.includes(q)) {
      out.push({
        type: 'user',
        label: name,
        value: `@${name}`,
        userId: user.id,
      });
    }
  }

  return out.slice(0, 10);
}

/** Segment type for rendering message content with mentions */
export type MentionSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; value: string; kind: 'user' | 'role' | 'everyone' | 'here' };

// Matches: @everyone, @here, @<Name With Spaces>, @<Name#1234>, @SimpleName, @Name#1234
// eslint-disable-next-line security/detect-unsafe-regex
const MENTION_REGEX = /@(?:<([^>]+)>|(everyone|here|[a-zA-Z0-9_]+(?:#\d{4})?))/g;

/** Parse message content into text and mention segments for display.
 *  memberNames: optional list of known member usernames for distinguishing user vs role mentions. */
export function parseContentWithMentions(
  content: string,
  _users?: User[],
  _roles?: string[],
  memberNames?: string[]
): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  MENTION_REGEX.lastIndex = 0;
  while ((m = MENTION_REGEX.exec(content)) !== null) {
    if (m.index > lastIndex) {
      segments.push({ type: 'text', value: content.slice(lastIndex, m.index) });
    }
    const bracketName = m[1];  // from @<Name With Spaces>
    const plainName = m[2];    // from @SimpleName or @everyone/@here
    const name = bracketName || plainName;
    const raw = name.toLowerCase();

    if (raw === 'everyone') {
      segments.push({ type: 'mention', value: '@everyone', kind: 'everyone' });
    } else if (raw === 'here') {
      segments.push({ type: 'mention', value: '@here', kind: 'here' });
    } else if (name.includes('#')) {
      segments.push({ type: 'mention', value: `@${name}`, kind: 'user' });
    } else {
      const isUser = memberNames ? memberNames.some(n => n.toLowerCase() === raw) : false;
      segments.push({ type: 'mention', value: `@${name}`, kind: isUser ? 'user' : 'role' });
    }
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < content.length) {
    segments.push({ type: 'text', value: content.slice(lastIndex) });
  }
  if (segments.length === 0 && content.length > 0) {
    segments.push({ type: 'text', value: content });
  }
  return segments;
}
