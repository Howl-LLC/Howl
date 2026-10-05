// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { $getRoot, $createParagraphNode, $createTextNode, $createLineBreakNode, type ParagraphNode } from 'lexical';

/**
 * Replace the whole document with `text`, as a single paragraph whose lines are
 * separated by LineBreakNodes. This mirrors what PlainTextPlugin produces when the
 * user types Shift+Enter. Building one ParagraphNode per line instead would make
 * `$getRoot().getTextContent()` emit "\n\n" between lines (Lexical joins block
 * children with a double newline), doubling every newline in the sent message.
 * Returns the paragraph so callers can position the caret inside it.
 */
export function $setRootPlainText(text: string): ParagraphNode {
  const root = $getRoot();
  root.clear();
  const para = $createParagraphNode();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) para.append($createLineBreakNode());
    if (lines[i]) para.append($createTextNode(lines[i]));
  }
  root.append(para);
  return para;
}
