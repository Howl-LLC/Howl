// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Inline + block markdown for message text.
 * Inline: *italic*, **bold**, ***bold italic***, __underline__, ~~strikethrough~~, `code`, [text](url).
 * Block (line-start): # headers, -# subtext, > block quote, >>> multi-line quote, - / * lists, ``` code block.
 */

export type InlineMarkdownSegment =
  | { type: 'plain'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'boldItalic'; value: string }
  | { type: 'underline'; value: string }
  | { type: 'strikethrough'; value: string }
  | { type: 'code'; value: string }
  | { type: 'spoiler'; value: string }
  | { type: 'link'; value: string; url: string };

/** Block-level segment (from line-based parsing). */
export type BlockSegment =
  | { type: 'paragraph'; lines: string[] }
  | { type: 'header'; level: 1 | 2 | 3; text: string }
  | { type: 'subtext'; text: string }
  | { type: 'blockquote'; lines: string[]; multi: boolean }
  | { type: 'codeblock'; code: string; lang?: string }
  | { type: 'list'; items: { indent: number; text: string }[] };

/**
 * Parse a plain text string into inline markdown segments.
 * Order: [link], `code`, ***, **, __, *, _, ~~.
 */
const MAX_PARSE_LENGTH = 10_000;

export function parseInlineMarkdown(text: string): InlineMarkdownSegment[] {
  if (text.length > MAX_PARSE_LENGTH) {
    return [{ type: 'plain', value: text.slice(0, MAX_PARSE_LENGTH) }];
  }
  const segments: InlineMarkdownSegment[] = [];
  let i = 0;

  while (i < text.length) {
    // Masked link: [text](url) — only allow http(s) and mailto protocols
    if (text[i] === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const value = text.slice(i + 1, closeBracket);
          const url = text.slice(closeBracket + 2, closeParen);
          const trimmedUrl = url.trimStart();
          const urlLower = trimmedUrl.toLowerCase();
          const isSafe =
            (urlLower.startsWith('http://') || urlLower.startsWith('https://') || urlLower.startsWith('mailto:'))
            || (trimmedUrl.startsWith('/') && !trimmedUrl.startsWith('//'));
          if (isSafe) {
            segments.push({ type: 'link', value, url });
          } else {
            segments.push({ type: 'plain', value: text.slice(i, closeParen + 1) });
          }
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Triple/double backtick: treat as plain text (block-level fences, not inline code)
    // Must be checked BEFORE the single-backtick handler to avoid empty code spans
    // that desync the InlineMarkdownPreview overlay width from the textarea cursor.
    if (text[i] === '`' && text[i + 1] === '`') {
      let count = 0;
      let j = i;
      while (j < text.length && text[j] === '`') { count++; j++; }
      segments.push({ type: 'plain', value: text.slice(i, i + count) });
      i += count;
      continue;
    }

    // Code: `...` (single backtick)
    if (text[i] === '`') {
      const start = i + 1;
      const end = text.indexOf('`', start);
      if (end === -1) {
        // Unclosed backtick — render as literal character
        segments.push({ type: 'plain', value: '`' });
        i = start;
        continue;
      }
      segments.push({ type: 'code', value: text.slice(start, end) });
      i = end + 1;
      continue;
    }

    // Spoiler: ||...||
    if (text.slice(i, i + 2) === '||') {
      const start = i + 2;
      const end = text.indexOf('||', start);
      if (end !== -1) {
        segments.push({ type: 'spoiler', value: text.slice(start, end) });
        i = end + 2;
        continue;
      }
    }

    // Bold italic: ***...***
    if (text.slice(i, i + 3) === '***') {
      const start = i + 3;
      const end = text.indexOf('***', start);
      if (end !== -1) {
        segments.push({ type: 'boldItalic', value: text.slice(start, end) });
        i = end + 3;
        continue;
      }
    }

    // Bold: **...**
    if (text.slice(i, i + 2) === '**') {
      const start = i + 2;
      const end = text.indexOf('**', start);
      if (end !== -1) {
        segments.push({ type: 'bold', value: text.slice(start, end) });
        i = end + 2;
        continue;
      }
    }

    // Underline: __...__
    if (text.slice(i, i + 2) === '__') {
      const start = i + 2;
      const end = text.indexOf('__', start);
      if (end !== -1) {
        segments.push({ type: 'underline', value: text.slice(start, end) });
        i = end + 2;
        continue;
      }
    }

    // Italic: *...* (not ** or ***)
    if (
      text[i] === '*' &&
      text.slice(i, i + 3) !== '***' &&
      text.slice(i, i + 2) !== '**'
    ) {
      const start = i + 1;
      const end = text.indexOf('*', start);
      if (end !== -1) {
        segments.push({ type: 'italic', value: text.slice(start, end) });
        i = end + 1;
        continue;
      }
    }

    // Underscore italic: _..._ (single _ only, not __)
    if (text[i] === '_') {
      const next = text[i + 1];
      if (next !== '_') {
        const start = i + 1;
        const end = text.indexOf('_', start);
        if (end !== -1 && text[end + 1] !== '_') {
          segments.push({ type: 'italic', value: text.slice(start, end) });
          i = end + 1;
          continue;
        }
      }
    }

    // Strikethrough: ~~...~~
    if (text.slice(i, i + 2) === '~~') {
      const start = i + 2;
      const end = text.indexOf('~~', start);
      if (end !== -1) {
        segments.push({ type: 'strikethrough', value: text.slice(start, end) });
        i = end + 2;
        continue;
      }
    }

    // Bare URL: https://... or http://...
    if (text.slice(i, i + 8) === 'https://' || text.slice(i, i + 7) === 'http://') {
      const urlMatch = text.slice(i).match(/^https?:\/\/[^\s<>"]+/);
      if (urlMatch) {
        let url = urlMatch[0];
        // Strip trailing punctuation that's likely not part of the URL
        url = url.replace(/[),.:;!?]+$/, '');
        segments.push({ type: 'link', value: url, url });
        i += url.length;
        continue;
      }
    }

    // Plain: advance to next delimiter
    const rest = text.slice(i);
    const match = rest.match(/\[|`|\|\||\*\*\*|\*\*|__|\*|_|~~|https?:\/\//);
    const plainEnd = match ? i + match.index! : text.length;
    if (plainEnd > i) {
      segments.push({ type: 'plain', value: text.slice(i, plainEnd) });
      i = plainEnd;
    } else {
      segments.push({ type: 'plain', value: text[i]! });
      i += 1;
    }
  }

  return segments;
}

const CODE_FENCE = '```';

/**
 * Parse block structure from a string (multi-line). Returns an array of blocks.
 * Headers (# ## ###), subtext (-# ), block quote (> >>>), code block (```), list (- * with optional 2-space indent), paragraph.
 */
export function parseBlockStructure(text: string): BlockSegment[] {
  const safe = text.length > MAX_PARSE_LENGTH ? text.slice(0, MAX_PARSE_LENGTH) : text;
  const lines = safe.split(/\r?\n/);
  const blocks: BlockSegment[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Code block: ``` then lines until ```
    if (line.startsWith(CODE_FENCE)) {
      // Extract language hint: ```typescript → 'typescript', ``` → undefined
      const langHint = line.slice(CODE_FENCE.length).trim().toLowerCase() || undefined;
      // Validate: only allow alphanumeric, hyphens, plus, sharp (e.g. c++, c#, f#)
      const lang = langHint && /^[a-z0-9+#._-]+$/.test(langHint) ? langHint : undefined;
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.startsWith(CODE_FENCE)) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1; // skip closing ```
      blocks.push({ type: 'codeblock', code: codeLines.join('\n'), lang });
      continue;
    }

    // Header: # , ## , ### at start (space after)
    const headerMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headerMatch) {
      const level = headerMatch[1]!.length as 1 | 2 | 3;
      blocks.push({ type: 'header', level, text: headerMatch[2]!.trim() });
      i += 1;
      continue;
    }

    // Subtext: -# at start (space after)
    const subtextMatch = line.match(/^-#\s+(.+)$/);
    if (subtextMatch) {
      blocks.push({ type: 'subtext', text: subtextMatch[1]!.trim() });
      i += 1;
      continue;
    }

    // Multi-line block quote: >>> at start
    if (line.startsWith('>>>')) {
      const quoteLines: string[] = [line.slice(3).replace(/^\s+/, '')];
      i += 1;
      while (i < lines.length && !/^(#|-#|>>>|```|\s*[-*]\s)/.test(lines[i]!) && !lines[i]!.startsWith(CODE_FENCE)) {
        const rest = lines[i]!;
        if (rest.startsWith('>')) {
          quoteLines.push(rest.replace(/^>+\s?/, ''));
        } else {
          quoteLines.push(rest);
        }
        i += 1;
      }
      blocks.push({ type: 'blockquote', lines: quoteLines, multi: true });
      continue;
    }

    // Single-line block quote: > at start (space after)
    if (line.startsWith('>')) {
      const content = line.replace(/^>+\s?/, '').trim();
      blocks.push({ type: 'blockquote', lines: [content], multi: false });
      i += 1;
      continue;
    }

    // List: line starting with - or * (space after); optional 2-space indent
    const listItemMatch = line.match(/^(\s*)([-*])\s+(.+)$/);
    if (listItemMatch) {
      const items: { indent: number; text: string }[] = [];
      const indentSpaces = listItemMatch[1]!.length;
      const indent = Math.floor(indentSpaces / 2);
      items.push({ indent, text: listItemMatch[3]! });
      i += 1;
      while (i < lines.length) {
        const nextMatch = lines[i]!.match(/^(\s*)([-*])\s+(.+)$/);
        if (!nextMatch) break;
        const nextIndent = Math.floor(nextMatch[1]!.length / 2);
        items.push({ indent: nextIndent, text: nextMatch[3]! });
        i += 1;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    // Paragraph: collect consecutive non-special lines
    const paraLines: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (
        l.startsWith(CODE_FENCE) ||
        /^#{1,3}\s/.test(l) ||
        /^-#\s/.test(l) ||
        l.startsWith('>>>') ||
        l.startsWith('>') ||
        /^\s*[-*]\s/.test(l)
      ) {
        break;
      }
      paraLines.push(l);
      i += 1;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', lines: paraLines });
    }
  }

  return blocks;
}

/**
 * If content has newlines, parse as blocks; otherwise return a single paragraph block.
 */
export function parseContentBlocks(content: string): BlockSegment[] {
  if (!content.includes('\n')) {
    return content.trim() ? [{ type: 'paragraph', lines: [content] }] : [];
  }
  return parseBlockStructure(content);
}
