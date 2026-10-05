// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { createEditor, $getRoot, $isLineBreakNode, $isParagraphNode } from 'lexical';
import { $setRootPlainText } from '../components/lexical/setRootPlainText';

function roundTrip(text: string): { out: string; paragraphs: number; lineBreaks: number } {
  const editor = createEditor({ onError: (e) => { throw e; } });
  let out = '';
  let paragraphs = 0;
  let lineBreaks = 0;
  editor.update(() => { $setRootPlainText(text); }, { discrete: true });
  editor.read(() => {
    const root = $getRoot();
    out = root.getTextContent();
    paragraphs = root.getChildrenSize();
    const para = root.getFirstChild();
    if ($isParagraphNode(para)) {
      lineBreaks = para.getChildren().filter((n) => $isLineBreakNode(n)).length;
    }
  });
  return { out, paragraphs, lineBreaks };
}

describe('$setRootPlainText', () => {
  it('round-trips a single newline without doubling it', () => {
    const r = roundTrip('a\nb');
    expect(r.out).toBe('a\nb');
    expect(r.paragraphs).toBe(1);
    expect(r.lineBreaks).toBe(1);
  });

  it('round-trips a blank line (two newlines) without doubling', () => {
    const r = roundTrip('a\n\nb');
    expect(r.out).toBe('a\n\nb');
    expect(r.paragraphs).toBe(1);
    expect(r.lineBreaks).toBe(2);
  });

  it('keeps leading and trailing newlines', () => {
    expect(roundTrip('\na\n').out).toBe('\na\n');
  });

  it('handles text with no newline and empty text', () => {
    expect(roundTrip('hello').out).toBe('hello');
    expect(roundTrip('').out).toBe('');
    expect(roundTrip('').paragraphs).toBe(1);
  });
});
