// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Extracts question/answer pairs from a page's "## FAQ" markdown section so
// the layout can emit FAQPage JSON-LD (rich results win disproportionate
// clicks for a new domain).
//
// The pages follow one shape:
//   ## FAQ
//   **Question one?**
//   One to two plain sentences.
//
//   **Question two?**
//   ...
// The section ends at the next heading, an `---` rule, or end of file.

export interface FaqItem {
  question: string
  answer: string
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> label
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1') // italics
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractFaq(markdown: string): FaqItem[] {
  const sectionMatch = markdown.match(/^## FAQ\s*$([\s\S]*?)(?=^#{1,6}\s|^---\s*$|(?![\s\S]))/m)
  if (!sectionMatch) return []

  const items: FaqItem[] = []
  const pairPattern = /\*\*(.+?)\*\*\s*\n([\s\S]+?)(?=\n\s*\n|\s*$)/g
  for (const match of sectionMatch[1].matchAll(pairPattern)) {
    const question = stripMarkdown(match[1])
    const answer = stripMarkdown(match[2])
    if (question.endsWith('?') && answer) {
      items.push({ question, answer })
    }
  }
  return items
}
