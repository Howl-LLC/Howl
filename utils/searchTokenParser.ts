// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
export interface SearchFilters {
  query: string;
  from?: string;
  in?: string;
  has?: string;
  before?: string;
  after?: string;
  mentions?: string;
  pinned?: boolean;
}

const SUPPORTED_KEYS = new Set(['from', 'in', 'has', 'before', 'after', 'during', 'mentions', 'pinned']);

const VALID_HAS_VALUES = new Set(['file', 'image', 'video', 'link', 'embed', 'sticker', 'sound', 'attachment']);

/**
 * Parse a date-like token value into an ISO date string.
 * Returns null for unparseable values.
 */
export function parseDateToken(value: string): string | null {
  const lower = value.toLowerCase();

  if (lower === 'today') {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  }
  if (lower === 'yesterday') {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  }

  // Full ISO with time component — pass through if valid
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toISOString();
    return null;
  }

  // Date-only: YYYY-MM-DD → midnight UTC
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(value + 'T00:00:00.000Z');
    if (!isNaN(d.getTime())) return d.toISOString();
    return null;
  }

  return null;
}

/**
 * Expand a `during:` token into `after` and `before` filter values.
 */
function expandDuring(value: string): { after?: string; before?: string } {
  const lower = value.toLowerCase();
  const now = new Date();

  if (lower === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { after: start.toISOString(), before: now.toISOString() };
  }
  if (lower === 'yesterday') {
    const startYesterday = new Date(now);
    startYesterday.setDate(startYesterday.getDate() - 1);
    startYesterday.setHours(0, 0, 0, 0);
    const startToday = new Date(now);
    startToday.setHours(0, 0, 0, 0);
    return { after: startYesterday.toISOString(), before: startToday.toISOString() };
  }
  if (lower === 'week') {
    const start = new Date(now);
    start.setDate(start.getDate() - 7);
    return { after: start.toISOString() };
  }
  if (lower === 'month') {
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    return { after: start.toISOString() };
  }

  return {};
}

/**
 * Parse Discord-style search filter tokens from a search input string.
 *
 * Supported syntax:
 * - `key:value` — filter token
 * - `key:"quoted value"` — filter with spaces in value
 * - Multiple of same key: last one wins
 * - Unknown keys are kept as regular search text
 */
export function parseSearchTokens(input: string): SearchFilters {
  const filters: SearchFilters = { query: '' };
  const queryParts: string[] = [];

  let i = 0;
  const len = input.length;

  while (i < len) {
    // Skip whitespace
    if (input[i] === ' ') {
      i++;
      continue;
    }

    // Check for a quoted string that is NOT preceded by a key:
    // (standalone "quoted text" is query text)
    if (input[i] === '"') {
      const closing = input.indexOf('"', i + 1);
      if (closing !== -1) {
        queryParts.push(input.slice(i + 1, closing));
        i = closing + 1;
      } else {
        // No closing quote — take rest as text
        queryParts.push(input.slice(i + 1));
        break;
      }
      continue;
    }

    // Try to match a key:value token
    // Look ahead for a colon that could be a filter key
    const colonIdx = input.indexOf(':', i);

    if (colonIdx !== -1 && colonIdx > i) {
      const potentialKey = input.slice(i, colonIdx);

      // Key must not contain spaces
      if (!potentialKey.includes(' ') && SUPPORTED_KEYS.has(potentialKey.toLowerCase())) {
        const key = potentialKey.toLowerCase();
        const valueStart = colonIdx + 1;

        // Empty value — treat entire "key:" as text
        if (valueStart >= len || input[valueStart] === ' ') {
          queryParts.push(input.slice(i, valueStart));
          i = valueStart;
          continue;
        }

        let value: string;

        // Quoted value
        if (input[valueStart] === '"') {
          const closing = input.indexOf('"', valueStart + 1);
          if (closing !== -1) {
            value = input.slice(valueStart + 1, closing);
            i = closing + 1;
          } else {
            // No closing quote — take rest as value
            value = input.slice(valueStart + 1);
            i = len;
          }
        } else {
          // Unquoted value — ends at next whitespace
          const spaceIdx = input.indexOf(' ', valueStart);
          if (spaceIdx !== -1) {
            value = input.slice(valueStart, spaceIdx);
            i = spaceIdx;
          } else {
            value = input.slice(valueStart);
            i = len;
          }
        }

        // Apply the filter
        applyFilter(filters, key, value, queryParts);
        continue;
      }
    }

    // Not a filter — consume until next whitespace as query text
    const nextSpace = input.indexOf(' ', i);
    if (nextSpace !== -1) {
      queryParts.push(input.slice(i, nextSpace));
      i = nextSpace;
    } else {
      queryParts.push(input.slice(i));
      i = len;
    }
  }

  filters.query = queryParts.filter(Boolean).join(' ').trim();
  return filters;
}

function applyFilter(filters: SearchFilters, key: string, value: string, queryParts: string[]): void {
  switch (key) {
    case 'from':
      filters.from = value;
      break;
    case 'in':
      filters.in = value;
      break;
    case 'has': {
      const lower = value.toLowerCase();
      if (!VALID_HAS_VALUES.has(lower)) {
        queryParts.push(`${key}:${value}`);
        break;
      }
      // Normalize "embed" → "link"
      filters.has = lower === 'embed' ? 'link' : lower;
      break;
    }
    case 'before': {
      const parsed = parseDateToken(value);
      filters.before = parsed ?? value;
      break;
    }
    case 'after': {
      const parsed = parseDateToken(value);
      filters.after = parsed ?? value;
      break;
    }
    case 'during': {
      const expanded = expandDuring(value);
      if (expanded.after) filters.after = expanded.after;
      if (expanded.before) filters.before = expanded.before;
      if (!expanded.after && !expanded.before) {
        queryParts.push(`during:${value}`);
      }
      break;
    }
    case 'mentions':
      filters.mentions = value;
      break;
    case 'pinned': {
      const lower = value.toLowerCase();
      if (lower === 'true') {
        filters.pinned = true;
      } else if (lower === 'false') {
        filters.pinned = false;
      } else {
        queryParts.push(`pinned:${value}`);
      }
      break;
    }
  }
}

/**
 * Rebuild a query string from a SearchFilters object.
 * Used when removing a filter pill to reconstruct the input.
 */
export function serializeFilters(filters: SearchFilters): string {
  const parts: string[] = [];

  if (filters.query) {
    parts.push(filters.query);
  }

  if (filters.from !== undefined) {
    parts.push(filters.from.includes(' ') ? `from:"${filters.from}"` : `from:${filters.from}`);
  }
  if (filters.in !== undefined) {
    parts.push(filters.in.includes(' ') ? `in:"${filters.in}"` : `in:${filters.in}`);
  }
  if (filters.has !== undefined) {
    parts.push(`has:${filters.has}`);
  }
  if (filters.before !== undefined) {
    parts.push(`before:${filters.before}`);
  }
  if (filters.after !== undefined) {
    parts.push(`after:${filters.after}`);
  }
  if (filters.mentions !== undefined) {
    parts.push(
      filters.mentions.includes(' ') ? `mentions:"${filters.mentions}"` : `mentions:${filters.mentions}`,
    );
  }
  if (filters.pinned !== undefined) {
    parts.push(`pinned:${filters.pinned}`);
  }

  return parts.join(' ');
}
