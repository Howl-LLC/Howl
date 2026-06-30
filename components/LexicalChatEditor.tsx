// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { forwardRef, useImperativeHandle, useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Bold, Italic, Underline, Strikethrough, Code, EyeOff } from 'lucide-react';
import type TurndownService from 'turndown';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $isParagraphNode,
  $createParagraphNode,
  $createTextNode,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  KEY_DOWN_COMMAND,
  KEY_BACKSPACE_COMMAND,
  PASTE_COMMAND,
  DecoratorNode,
  type EditorThemeClasses,
  type LexicalEditor,
  type LexicalNode,
  TextNode,
  type ParagraphNode,
} from 'lexical';
import { parseInlineMarkdown, type InlineMarkdownSegment } from '../utils/markdownUtils';
import { MentionPillNode, $createMentionPillNode, type MentionPillData } from './lexical/MentionPillNode';
import { ChannelLinkNode, $createChannelLinkNode, type ChannelLinkData } from './lexical/ChannelLinkNode';
import { CustomEmojiNode, $createCustomEmojiNode, type CustomEmojiData } from './lexical/CustomEmojiNode';
import { useIsMobile } from '../hooks/useIsMobile';
import { useVisualViewportHeight } from '../hooks/useVisualViewportHeight';
import { useSettings } from '../contexts/SettingsContext';
import { ComposerContextMenu } from './ComposerContextMenu';

export interface LexicalChatEditorProps {
  disabled?: boolean;
  placeholder?: string;
  maxLines?: number;
  onTextChange?: (text: string) => void;
  onSubmit?: () => void;
  onImagePaste?: (file: File) => void;
  onTextPaste?: (text: string) => void;
  onMentionQuery?: (query: string, startPos: number) => void;
  onMentionDismiss?: () => void;
  onMentionKeyDown?: (key: string) => boolean;
  mentionActive?: boolean;
  onChannelQuery?: (query: string, startPos: number) => void;
  onChannelDismiss?: () => void;
  onChannelKeyDown?: (key: string) => boolean;
  channelActive?: boolean;
  onEmojiQuery?: (query: string, startPos: number) => void;
  onEmojiDismiss?: () => void;
  onEmojiKeyDown?: (key: string) => boolean;
  emojiAutoActive?: boolean;
  onArrowUpEmpty?: () => void;
  onSlashQuery?: (query: string) => void;
  onSlashDismiss?: () => void;
  onSlashKeyDown?: (key: string) => boolean;
  slashActive?: boolean;
  onCodeBlockQuery?: (query: string) => void;
  onCodeBlockDismiss?: () => void;
  onCodeBlockKeyDown?: (key: string) => boolean;
  codeBlockActive?: boolean;
  anyDropdownOpen?: boolean;
  onEditorBlur?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export { type MentionPillData } from './lexical/MentionPillNode';
export { type ChannelLinkData } from './lexical/ChannelLinkNode';
export { type CustomEmojiData } from './lexical/CustomEmojiNode';

export interface LexicalChatEditorHandle {
  getTextContent: () => string;
  clear: () => void;
  focus: () => void;
  insertText: (text: string) => void;
  setTextContent: (text: string) => void;
  insertMentionText: (mentionText: string, searchStartPos: number) => void;
  insertMentionPill: (data: MentionPillData, searchStartPos: number) => void;
  insertChannelPill: (data: ChannelLinkData, searchStartPos: number) => void;
  insertCustomEmoji: (data: CustomEmojiData, searchStartPos: number) => void;
  getEditor: () => LexicalEditor | null;
}

const theme: EditorThemeClasses = {
  paragraph: 'lexical-paragraph',
  text: {
    bold: 'lexical-bold',
    italic: 'lexical-italic',
    underline: 'lexical-underline',
    strikethrough: 'lexical-strikethrough',
    code: 'lexical-code',
  },
};

// Internal Plugins

function EditorRefPlugin({ editorRef }: { editorRef: React.MutableRefObject<LexicalEditor | null> }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { editorRef.current = editor; }, [editor, editorRef]);
  return null;
}

function BlurDismissPlugin({ onBlur }: { onBlur?: () => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    if (!onBlur) return;
    const root = editor.getRootElement();
    if (!root) return;
    const handler = () => onBlur();
    root.addEventListener('blur', handler);
    return () => root.removeEventListener('blur', handler);
  }, [editor, onBlur]);
  return null;
}

function EnterToSendPlugin({
  onSubmit,
  mentionActive,
  onMentionKeyDown,
  slashActive,
  onSlashKeyDown,
  channelActive,
  onChannelKeyDown,
  emojiAutoActive,
  onEmojiKeyDown,
  codeBlockActive,
  onCodeBlockKeyDown,
}: {
  onSubmit?: () => void;
  mentionActive?: boolean;
  onMentionKeyDown?: (key: string) => boolean;
  slashActive?: boolean;
  onSlashKeyDown?: (key: string) => boolean;
  channelActive?: boolean;
  onChannelKeyDown?: (key: string) => boolean;
  emojiAutoActive?: boolean;
  onEmojiKeyDown?: (key: string) => boolean;
  codeBlockActive?: boolean;
  onCodeBlockKeyDown?: (key: string) => boolean;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if (event.key !== 'Enter') return false;
        if (event.shiftKey) return false;
        if (editor.isComposing()) return false;

        // Delegate Enter to whichever autocomplete system is active
        if (mentionActive && onMentionKeyDown) {
          const handled = onMentionKeyDown('Enter');
          if (handled) { event.preventDefault(); return true; }
        }
        if (channelActive && onChannelKeyDown) {
          const handled = onChannelKeyDown('Enter');
          if (handled) { event.preventDefault(); return true; }
        }
        if (emojiAutoActive && onEmojiKeyDown) {
          const handled = onEmojiKeyDown('Enter');
          if (handled) { event.preventDefault(); return true; }
        }
        if (slashActive && onSlashKeyDown) {
          const handled = onSlashKeyDown('Enter');
          if (handled) { event.preventDefault(); return true; }
        }
        if (codeBlockActive && onCodeBlockKeyDown) {
          const handled = onCodeBlockKeyDown('Enter');
          if (handled) { event.preventDefault(); return true; }
        }

        // No autocomplete consumed Enter — send the message
        event.preventDefault();
        onSubmit?.();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onSubmit, mentionActive, onMentionKeyDown, channelActive, onChannelKeyDown, emojiAutoActive, onEmojiKeyDown, slashActive, onSlashKeyDown, codeBlockActive, onCodeBlockKeyDown]);
  return null;
}

function MentionDetectorPlugin({
  onMentionQuery,
  onMentionDismiss,
}: {
  onMentionQuery?: (query: string, startPos: number) => void;
  onMentionDismiss?: () => void;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          onMentionDismiss?.();
          return;
        }

        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();

        // Cursor in empty paragraph (ParagraphNode, not TextNode) — no @ possible
        if (!$isTextNode(anchorNode)) {
          onMentionDismiss?.();
          return;
        }

        // Detect @ within the anchor node's text only — no cross-node math needed
        const textContent = anchorNode.getTextContent();
        const cursorOffset = anchor.offset;
        const textBeforeCursor = textContent.slice(0, cursorOffset);

        const lastAtIndex = textBeforeCursor.lastIndexOf('@');
        if (lastAtIndex === -1) {
          onMentionDismiss?.();
          return;
        }

        const queryText = textBeforeCursor.slice(lastAtIndex + 1);
        if (/\s/.test(queryText)) {
          onMentionDismiss?.();
          return;
        }

        // Compute the absolute position of @ for insertMentionText
        let absolutePos = 0;
        const root = $getRoot();
        const paragraphs = root.getChildren() as ParagraphNode[];
        let found = false;

        for (let pi = 0; pi < paragraphs.length; pi++) {
          if (pi > 0) absolutePos++; // \n between paragraphs
          const children = paragraphs[pi].getChildren() as TextNode[];
          for (const child of children) {
            if (child.getKey() === anchorNode.getKey()) {
              absolutePos += lastAtIndex;
              found = true;
              break;
            }
            absolutePos += child.getTextContentSize();
          }
          if (found) break;
        }

        if (!found) {
          onMentionDismiss?.();
          return;
        }

        onMentionQuery?.(queryText, absolutePos);
      });
    });
  }, [editor, onMentionQuery, onMentionDismiss]);
  return null;
}

function MentionKeyboardPlugin({
  mentionActive,
  onMentionKeyDown,
}: {
  mentionActive?: boolean;
  onMentionKeyDown?: (key: string) => boolean;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if (!mentionActive || !onMentionKeyDown) return false;
        const { key } = event;
        if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Tab' || key === 'Escape') {
          const handled = onMentionKeyDown(key);
          if (handled) {
            event.preventDefault();
            return true;
          }
        }
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor, mentionActive, onMentionKeyDown]);
  return null;
}

function AutoGrowPlugin({
  maxLines,
  contentEditableRef,
}: {
  maxLines: number;
  contentEditableRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerUpdateListener(() => {
      const el = contentEditableRef.current;
      if (!el) return;
      el.style.height = 'auto';
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
      const maxHeight = lineHeight * maxLines;
      const isOverflowing = el.scrollHeight > maxHeight;
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
      el.style.overflowY = isOverflowing ? 'auto' : 'hidden';
    });
  }, [editor, maxLines, contentEditableRef]);
  return null;
}

function OnChangePlugin({ onTextChange }: { onTextChange?: (text: string) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerUpdateListener(({ tags }) => {
      if (tags.has('history-merge')) return;
      editor.read(() => {
        const text = $getRoot().getTextContent();
        onTextChange?.(text);
      });
    });
  }, [editor, onTextChange]);
  return null;
}

// Smart Paste (HTML→Markdown)
// Turndown (~25 kB) is dynamically imported so it stays out of the main chunk.
// We kick off the load when the paste plugin mounts so it's almost always ready
// by the time a user actually pastes. If a user manages to paste rich HTML
// before it finishes loading, we fall through to plain-text paste — acceptable
// degradation that happens at most once per session.

let _turndown: TurndownService | null = null;
let _turndownLoadPromise: Promise<void> | null = null;

function startTurndownLoad(): void {
  if (_turndown || _turndownLoadPromise) return;
  _turndownLoadPromise = import('turndown')
    .then((m) => {
      const TD = m.default;
      const instance = new TD({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
        emDelimiter: '*',
        strongDelimiter: '**',
      });
      instance.addRule('underline', { filter: ['u'], replacement: (c) => `__${c}__` });
      instance.addRule('strikethrough', { filter: ['s', 'del', 'strike'] as any, replacement: (c) => `~~${c}~~` });
      instance.remove(['script', 'style', 'noscript', 'iframe', 'object', 'embed']);
      _turndown = instance;
    })
    .catch(() => {
      _turndownLoadPromise = null; // allow retry
    });
}

function convertHtmlToMarkdown(html: string): string | null {
  if (!_turndown) return null;
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/on\w+="[^"]*"/gi, '')
    .replace(/javascript:/gi, '');
  return _turndown.turndown(cleaned).trim();
}

function PasteHandlerPlugin({
  onImagePaste,
  onTextPaste,
}: {
  onImagePaste?: (file: File) => void;
  onTextPaste?: (text: string) => void;
}) {
  const [editor] = useLexicalComposerContext();
  // ClipboardEvent doesn't carry modifier state, so we bridge from the
  // preceding KEY_DOWN_COMMAND: Ctrl+Shift+V / Cmd+Shift+V flips this ref,
  // the paste handler reads it once, and we reset it immediately so a
  // subsequent menu-driven paste isn't misinterpreted as plain-text.
  const forcePlainTextRef = useRef(false);
  useEffect(() => {
    // Kick off turndown load as soon as the editor mounts. By the time the
    // user pastes, it's already in memory.
    startTurndownLoad();

    const unsubKeyDown = editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v') {
          forcePlainTextRef.current = true;
        }
        // Always return false — we're not claiming the event, just observing it.
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );

    const unsubPaste = editor.registerCommand(
      PASTE_COMMAND,
      (event: ClipboardEvent) => {
        const clipboardData = event.clipboardData;
        if (!clipboardData) return false;

        // Read-and-reset the shift-paste flag so this branch decision is
        // scoped to the current paste only.
        const forcePlainText = forcePlainTextRef.current;
        forcePlainTextRef.current = false;

        // 1. Image paste (highest priority)
        const items = clipboardData.items;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.kind === 'file' && item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) {
              event.preventDefault();
              onImagePaste?.(file);
              return true;
            }
          }
        }

        // 2. Rich text paste — check for HTML with actual formatting.
        // When the user holds Shift (Ctrl+Shift+V / Cmd+Shift+V), skip the
        // HTML → Markdown path entirely and fall through to plain-text below.
        // Matches the convention from Word, Google Docs, Slack, Discord.
        const htmlData = clipboardData.getData('text/html');
        const plainData = clipboardData.getData('text/plain');

        if (htmlData && plainData && !forcePlainText) {
          const hasFormatting = /<(b|strong|i|em|u|s|del|strike|code|pre|a\s|h[1-6]|ul|ol|li|blockquote)/i.test(htmlData);
          if (hasFormatting) {
            try {
              const markdown = convertHtmlToMarkdown(htmlData);
              if (markdown && markdown.trim() !== plainData.trim()) {
                event.preventDefault();
                editor.update(() => {
                  const selection = $getSelection();
                  if ($isRangeSelection(selection)) selection.insertText(markdown);
                });
                if (onTextPaste) onTextPaste(markdown);
                return true;
              }
            } catch { /* fall through to plain text */ }
            // markdown === null means turndown hasn't finished loading yet —
            // retry the load and fall through to plain-text paste below.
            if (!_turndown) startTurndownLoad();
          }
        }

        // 3. Plain text paste (existing behavior)
        if (plainData && onTextPaste) {
          onTextPaste(plainData);
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unsubKeyDown();
      unsubPaste();
    };
  }, [editor, onImagePaste, onTextPaste]);
  return null;
}

function DisablePlugin({ disabled }: { disabled?: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editor.setEditable(!disabled);
  }, [editor, disabled]);
  return null;
}

function KeyboardShortcutsPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        const isMod = event.metaKey || event.ctrlKey;
        if (!isMod) return false;

        let delimiter: string | null = null;
        if (event.key === 'b' && !event.shiftKey) delimiter = '**';
        else if (event.key === 'i' && !event.shiftKey) delimiter = '*';
        else if (event.key === 'u' && !event.shiftKey) delimiter = '__';
        else if (event.key === 's' && event.shiftKey) delimiter = '~~';
        else if (event.key === 'e' && !event.shiftKey) delimiter = '`';
        else if (event.key === 'x' && event.shiftKey) delimiter = '||';
        if (!delimiter) return false;

        event.preventDefault();
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          const selectedText = selection.getTextContent();
          if (selectedText) {
            selection.insertText(delimiter + selectedText + delimiter);
          } else {
            selection.insertText(delimiter + delimiter);
            const newSel = $getSelection();
            if ($isRangeSelection(newSel)) {
              const off = newSel.anchor.offset - delimiter.length;
              if (off >= 0) {
                newSel.anchor.offset = off;
                newSel.focus.offset = off;
              }
            }
          }
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);
  return null;
}

function ArrowUpEditPlugin({ onArrowUpEmpty, anyDropdownOpen }: { onArrowUpEmpty?: () => void; anyDropdownOpen?: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    if (!onArrowUpEmpty) return;
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if (event.key !== 'ArrowUp' || anyDropdownOpen) return false;
        let empty = false;
        editor.getEditorState().read(() => {
          empty = $getRoot().getTextContent().trim() === '';
        });
        if (!empty) return false;
        event.preventDefault();
        onArrowUpEmpty();
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor, onArrowUpEmpty, anyDropdownOpen]);
  return null;
}

// Shared Decorator Insertion

function $insertDecoratorAtTrigger(createNode: () => LexicalNode, searchStartPos: number) {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;

  const anchorKey = selection.anchor.key;
  const anchorOffset = selection.anchor.offset;
  const anchorNode = selection.anchor.getNode();
  if (!$isTextNode(anchorNode)) return;
  const paragraph = anchorNode.getParent();
  if (!paragraph || !$isParagraphNode(paragraph)) return;

  // Compute paragraph's start position in the full document text
  let paragraphStartPos = 0;
  const root = $getRoot();
  const allParas = root.getChildren();
  for (let pi = 0; pi < allParas.length; pi++) {
    if (pi > 0) paragraphStartPos++; // newline between paragraphs
    if (allParas[pi].getKey() === paragraph.getKey()) break;
    paragraphStartPos += allParas[pi].getTextContentSize();
  }

  // Local trigger offset within this paragraph (accounts for DecoratorNodes before trigger)
  const localTriggerOffset = searchStartPos - paragraphStartPos;
  if (localTriggerOffset < 0) return;

  // Walk ALL children (TextNodes + DecoratorNodes) to find the TextNode containing the trigger
  let localPos = 0;
  let triggerNode: typeof anchorNode | null = null;
  let triggerOffsetInNode = 0;

  for (const child of paragraph.getChildren()) {
    const childLen = child.getTextContentSize();
    if ($isTextNode(child) && localTriggerOffset >= localPos && localTriggerOffset < localPos + childLen) {
      triggerNode = child;
      triggerOffsetInNode = localTriggerOffset - localPos;
      break;
    }
    localPos += childLen;
  }

  if (!triggerNode) return;

  // Determine cursor offset within the trigger node
  const cursorInTriggerNode = (anchorKey === triggerNode.getKey()) ? anchorOffset : triggerNode.getTextContentSize();

  const text = triggerNode.getTextContent();
  const before = text.slice(0, triggerOffsetInNode);
  const after = text.slice(cursorInTriggerNode);
  const pill = createNode();
  const afterText = (after && !after.startsWith(' ')) ? ' ' + after : (after || ' ');
  const afterNode = $createTextNode(afterText);

  if (before) triggerNode.insertBefore($createTextNode(before));
  triggerNode.insertBefore(pill);
  triggerNode.insertBefore(afterNode);
  triggerNode.remove();
  afterNode.select(1, 1);
}

// Channel & Emoji Detector Plugins

function ChannelDetectorPlugin({
  onChannelQuery,
  onChannelDismiss,
}: {
  onChannelQuery?: (query: string, startPos: number) => void;
  onChannelDismiss?: () => void;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) { onChannelDismiss?.(); return; }
        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();
        if (!$isTextNode(anchorNode)) { onChannelDismiss?.(); return; }

        const textContent = anchorNode.getTextContent();
        const textBeforeCursor = textContent.slice(0, anchor.offset);
        const lastHash = textBeforeCursor.lastIndexOf('#');
        if (lastHash === -1) { onChannelDismiss?.(); return; }
        // Only trigger if # is at start or preceded by whitespace
        if (lastHash > 0 && !/\s/.test(textBeforeCursor[lastHash - 1])) { onChannelDismiss?.(); return; }
        const queryText = textBeforeCursor.slice(lastHash + 1);
        if (/\s/.test(queryText)) { onChannelDismiss?.(); return; }

        // Compute absolute position
        let absolutePos = 0;
        const root = $getRoot();
        const paragraphs = root.getChildren() as ParagraphNode[];
        let found = false;
        for (let pi = 0; pi < paragraphs.length; pi++) {
          if (pi > 0) absolutePos++;
          const children = paragraphs[pi].getChildren() as TextNode[];
          for (const child of children) {
            if (child.getKey() === anchorNode.getKey()) { absolutePos += lastHash; found = true; break; }
            absolutePos += child.getTextContentSize();
          }
          if (found) break;
        }
        if (!found) { onChannelDismiss?.(); return; }
        onChannelQuery?.(queryText, absolutePos);
      });
    });
  }, [editor, onChannelQuery, onChannelDismiss]);
  return null;
}

function ChannelKeyboardPlugin({ channelActive, onChannelKeyDown }: { channelActive?: boolean; onChannelKeyDown?: (key: string) => boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerCommand(KEY_DOWN_COMMAND, (event: KeyboardEvent) => {
      if (!channelActive || !onChannelKeyDown) return false;
      const { key } = event;
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Tab' || key === 'Escape' || key === 'Enter') {
        const handled = onChannelKeyDown(key);
        if (handled) { event.preventDefault(); return true; }
      }
      return false;
    }, COMMAND_PRIORITY_LOW);
  }, [editor, channelActive, onChannelKeyDown]);
  return null;
}

function EmojiTriggerPlugin({
  onEmojiQuery,
  onEmojiDismiss,
}: {
  onEmojiQuery?: (query: string, startPos: number) => void;
  onEmojiDismiss?: () => void;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) { onEmojiDismiss?.(); return; }
        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();
        if (!$isTextNode(anchorNode)) { onEmojiDismiss?.(); return; }

        const textContent = anchorNode.getTextContent();
        const textBeforeCursor = textContent.slice(0, anchor.offset);
        const lastColon = textBeforeCursor.lastIndexOf(':');
        if (lastColon === -1) { onEmojiDismiss?.(); return; }
        // Only trigger if : is at start or preceded by whitespace
        if (lastColon > 0 && !/\s/.test(textBeforeCursor[lastColon - 1])) { onEmojiDismiss?.(); return; }
        const queryText = textBeforeCursor.slice(lastColon + 1);
        if (/\s/.test(queryText) || queryText.length < 2) { onEmojiDismiss?.(); return; }

        // Compute absolute position
        let absolutePos = 0;
        const root = $getRoot();
        const paragraphs = root.getChildren() as ParagraphNode[];
        let found = false;
        for (let pi = 0; pi < paragraphs.length; pi++) {
          if (pi > 0) absolutePos++;
          const children = paragraphs[pi].getChildren() as TextNode[];
          for (const child of children) {
            if (child.getKey() === anchorNode.getKey()) { absolutePos += lastColon; found = true; break; }
            absolutePos += child.getTextContentSize();
          }
          if (found) break;
        }
        if (!found) { onEmojiDismiss?.(); return; }
        onEmojiQuery?.(queryText, absolutePos);
      });
    });
  }, [editor, onEmojiQuery, onEmojiDismiss]);
  return null;
}

function EmojiKeyboardPlugin({ emojiAutoActive, onEmojiKeyDown }: { emojiAutoActive?: boolean; onEmojiKeyDown?: (key: string) => boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerCommand(KEY_DOWN_COMMAND, (event: KeyboardEvent) => {
      if (!emojiAutoActive || !onEmojiKeyDown) return false;
      const { key } = event;
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Tab' || key === 'Escape' || key === 'Enter') {
        const handled = onEmojiKeyDown(key);
        if (handled) { event.preventDefault(); return true; }
      }
      return false;
    }, COMMAND_PRIORITY_LOW);
  }, [editor, emojiAutoActive, onEmojiKeyDown]);
  return null;
}

function BackspaceDecoratorPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerCommand(KEY_BACKSPACE_COMMAND, (event: KeyboardEvent) => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
      const anchor = selection.anchor;
      const node = anchor.getNode();
      if ($isTextNode(node) && anchor.offset === 0) {
        const prev = node.getPreviousSibling();
        if (prev && prev instanceof DecoratorNode) {
          event.preventDefault();
          prev.remove();
          return true;
        }
      }
      return false;
    }, COMMAND_PRIORITY_LOW);
  }, [editor]);
  return null;
}

function SlashCommandDetectorPlugin({
  onSlashQuery,
  onSlashDismiss,
}: {
  onSlashQuery?: (query: string) => void;
  onSlashDismiss?: () => void;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const text = $getRoot().getTextContent();
        // Only detect slash commands on single-line input starting with /
        if (!text.startsWith('/') || text.includes('\n')) { onSlashDismiss?.(); return; }
        onSlashQuery?.(text.slice(1));
      });
    });
  }, [editor, onSlashQuery, onSlashDismiss]);
  return null;
}

function SlashCommandKeyboardPlugin({
  slashActive,
  onSlashKeyDown,
}: {
  slashActive?: boolean;
  onSlashKeyDown?: (key: string) => boolean;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerCommand(KEY_DOWN_COMMAND, (event: KeyboardEvent) => {
      if (!slashActive || !onSlashKeyDown) return false;
      const { key } = event;
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Tab' || key === 'Escape') {
        const handled = onSlashKeyDown(key);
        if (handled) { event.preventDefault(); return true; }
      }
      return false;
    }, COMMAND_PRIORITY_LOW);
  }, [editor, slashActive, onSlashKeyDown]);
  return null;
}

// Floating Toolbar

const TOOLBAR_BUTTONS = [
  { icon: <Bold size={14} />, delimiter: '**', tooltip: 'Bold (Ctrl+B)' },
  { icon: <Italic size={14} />, delimiter: '*', tooltip: 'Italic (Ctrl+I)' },
  { icon: <Underline size={14} />, delimiter: '__', tooltip: 'Underline (Ctrl+U)' },
  { icon: <Strikethrough size={14} />, delimiter: '~~', tooltip: 'Strikethrough (Ctrl+Shift+S)' },
  { icon: <Code size={14} />, delimiter: '`', tooltip: 'Code (Ctrl+E)' },
  { icon: <EyeOff size={14} />, delimiter: '||', tooltip: 'Spoiler (Ctrl+Shift+X)' },
];

function FloatingToolbarPlugin({ disabled, anyDropdownOpen }: { disabled?: boolean; anyDropdownOpen?: boolean }) {
  const [editor] = useLexicalComposerContext();
  const [show, setShow] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return editor.registerUpdateListener(() => {
      if (disabled || anyDropdownOpen) { setShow(false); return; }
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || selection.isCollapsed()) {
          setShow(false);
          if (debounceRef.current) clearTimeout(debounceRef.current);
          return;
        }
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          const nativeSel = window.getSelection();
          if (!nativeSel || nativeSel.rangeCount === 0) { setShow(false); return; }
          const rect = nativeSel.getRangeAt(0).getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) { setShow(false); return; }
          const toolbarWidth = 240;
          setPosition({
            top: Math.max(8, rect.top - 40),
            left: Math.min(window.innerWidth - toolbarWidth - 8, Math.max(8, rect.left + rect.width / 2 - toolbarWidth / 2)),
          });
          setShow(true);
        }, 200);
      });
    });
  }, [editor, disabled, anyDropdownOpen]);

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const wrapSelection = useCallback((delimiter: string) => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        const text = selection.getTextContent();
        if (text) selection.insertText(delimiter + text + delimiter);
      }
    });
  }, [editor]);

  if (!show || !position) return null;
  return createPortal(
    <div
      className="fixed flex items-center gap-0.5 px-1.5 py-1 rounded-xl border shadow-xl z-[var(--z-tooltip)] select-none"
      style={{
        top: position.top,
        left: position.left,
        backgroundColor: 'var(--bg-floating)',
        borderColor: 'var(--border-subtle)',
        backdropFilter: 'blur(24px) saturate(1.1)',
        WebkitBackdropFilter: 'blur(24px) saturate(1.1)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {TOOLBAR_BUTTONS.map(({ icon, delimiter, tooltip }) => (
        <button
          key={delimiter}
          type="button"
          title={tooltip}
          onClick={() => wrapSelection(delimiter)}
          className="p-1.5 rounded-lg hover:bg-fill-strong transition-colors"
          style={{ color: 'var(--text-secondary)' }}
        >
          {icon}
        </button>
      ))}
    </div>,
    document.body,
  );
}

// Code Block Selector

const CODE_LANGUAGES = [
  { name: 'JavaScript', value: 'javascript', aliases: ['js', 'jsx'] },
  { name: 'TypeScript', value: 'typescript', aliases: ['ts', 'tsx'] },
  { name: 'Python', value: 'python', aliases: ['py'] },
  { name: 'Java', value: 'java', aliases: [] as string[] },
  { name: 'C#', value: 'csharp', aliases: ['cs', 'c#'] },
  { name: 'C++', value: 'cpp', aliases: ['c++'] },
  { name: 'C', value: 'c', aliases: [] as string[] },
  { name: 'Go', value: 'go', aliases: ['golang'] },
  { name: 'Rust', value: 'rust', aliases: ['rs'] },
  { name: 'Ruby', value: 'ruby', aliases: ['rb'] },
  { name: 'PHP', value: 'php', aliases: [] as string[] },
  { name: 'Swift', value: 'swift', aliases: [] as string[] },
  { name: 'Kotlin', value: 'kotlin', aliases: ['kt'] },
  { name: 'SQL', value: 'sql', aliases: [] as string[] },
  { name: 'Bash', value: 'bash', aliases: ['sh', 'zsh'] },
  { name: 'Shell', value: 'shell', aliases: [] as string[] },
  { name: 'CSS', value: 'css', aliases: [] as string[] },
  { name: 'HTML', value: 'html', aliases: ['xml'] },
  { name: 'JSON', value: 'json', aliases: [] as string[] },
  { name: 'YAML', value: 'yaml', aliases: ['yml'] },
  { name: 'Markdown', value: 'markdown', aliases: ['md'] },
  { name: 'Dockerfile', value: 'dockerfile', aliases: ['docker'] },
  { name: 'Lua', value: 'lua', aliases: [] as string[] },
  { name: 'Dart', value: 'dart', aliases: [] as string[] },
  { name: 'Scala', value: 'scala', aliases: [] as string[] },
  { name: 'R', value: 'r', aliases: [] as string[] },
  { name: 'Perl', value: 'perl', aliases: [] as string[] },
];
export { CODE_LANGUAGES };

function CodeBlockSelectorPlugin({
  onCodeBlockQuery,
  onCodeBlockDismiss,
}: {
  onCodeBlockQuery?: (query: string) => void;
  onCodeBlockDismiss?: () => void;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) { onCodeBlockDismiss?.(); return; }
        const anchorNode = selection.anchor.getNode();
        if (!$isTextNode(anchorNode)) { onCodeBlockDismiss?.(); return; }
        const text = anchorNode.getTextContent();
        if (!text.startsWith('```')) { onCodeBlockDismiss?.(); return; }
        const parent = anchorNode.getParent();
        if (!parent || parent.getFirstChild()?.getKey() !== anchorNode.getKey()) { onCodeBlockDismiss?.(); return; }
        onCodeBlockQuery?.(text.slice(3));
      });
    });
  }, [editor, onCodeBlockQuery, onCodeBlockDismiss]);
  return null;
}

function CodeBlockKeyboardPlugin({ codeBlockActive, onCodeBlockKeyDown }: { codeBlockActive?: boolean; onCodeBlockKeyDown?: (key: string) => boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerCommand(KEY_DOWN_COMMAND, (event: KeyboardEvent) => {
      if (!codeBlockActive || !onCodeBlockKeyDown) return false;
      const { key } = event;
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Tab' || key === 'Enter' || key === 'Escape') {
        const handled = onCodeBlockKeyDown(key);
        if (handled) { event.preventDefault(); return true; }
      }
      return false;
    }, COMMAND_PRIORITY_LOW);
  }, [editor, codeBlockActive, onCodeBlockKeyDown]);
  return null;
}

// Markdown Highlight

const FORMAT_BOLD = 1;
const FORMAT_ITALIC = 2;
const FORMAT_STRIKETHROUGH = 4;
const FORMAT_UNDERLINE = 8;
const FORMAT_CODE = 16;

const DIM_STYLE = 'opacity: 0.4';
const CYAN_STYLE = 'color: var(--cyan-accent)';
const SPOILER_STYLE = 'background-color: var(--fill-stronger); border-radius: 3px; padding: 0 2px';

interface HighlightSpec {
  text: string;
  format: number;
  style: string;
}

function getFormatBits(type: string): number {
  switch (type) {
    case 'bold': return FORMAT_BOLD;
    case 'italic': return FORMAT_ITALIC;
    case 'boldItalic': return FORMAT_BOLD | FORMAT_ITALIC;
    case 'underline': return FORMAT_UNDERLINE;
    case 'strikethrough': return FORMAT_STRIKETHROUGH;
    case 'code': return FORMAT_CODE;
    default: return 0;
  }
}

function getContentStyle(type: string): string {
  if (type === 'spoiler') return SPOILER_STYLE;
  return '';
}

function getDelimLen(type: string): number {
  switch (type) {
    case 'bold': case 'underline': case 'strikethrough': case 'spoiler': return 2;
    case 'boldItalic': return 3;
    case 'italic': case 'code': return 1;
    default: return 0;
  }
}

function buildHighlightSpecs(segments: InlineMarkdownSegment[], paragraphText: string): HighlightSpec[] {
  const specs: HighlightSpec[] = [];
  let pos = 0;

  for (const seg of segments) {
    if (seg.type === 'plain') {
      specs.push({ text: seg.value, format: 0, style: '' });
      pos += seg.value.length;
    } else if (seg.type === 'link') {
      if (seg.value === seg.url) {
        specs.push({ text: seg.value, format: 0, style: CYAN_STYLE });
        pos += seg.value.length;
      } else {
        specs.push({ text: '[', format: 0, style: DIM_STYLE });
        specs.push({ text: seg.value, format: 0, style: CYAN_STYLE });
        specs.push({ text: '](', format: 0, style: DIM_STYLE });
        specs.push({ text: seg.url, format: 0, style: CYAN_STYLE });
        specs.push({ text: ')', format: 0, style: DIM_STYLE });
        pos += 1 + seg.value.length + 2 + seg.url.length + 1;
      }
    } else {
      const dLen = getDelimLen(seg.type);
      const open = paragraphText.slice(pos, pos + dLen);
      const close = paragraphText.slice(pos + dLen + seg.value.length, pos + dLen + seg.value.length + dLen);
      specs.push({ text: open, format: 0, style: DIM_STYLE });
      specs.push({ text: seg.value, format: getFormatBits(seg.type), style: getContentStyle(seg.type) });
      specs.push({ text: close, format: 0, style: DIM_STYLE });
      pos += dLen + seg.value.length + dLen;
    }
  }

  return specs;
}

/** Merge adjacent specs with same format+style to match Lexical's text normalization. */
function mergeAdjacentSpecs(specs: HighlightSpec[]): HighlightSpec[] {
  const merged: HighlightSpec[] = [];
  for (const spec of specs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.format === spec.format && prev.style === spec.style) {
      prev.text += spec.text;
    } else {
      merged.push({ text: spec.text, format: spec.format, style: spec.style });
    }
  }
  return merged;
}

function specsMatchRun(specs: HighlightSpec[], nodes: LexicalNode[]): boolean {
  if (specs.length !== nodes.length) return false;
  for (let i = 0; i < specs.length; i++) {
    const node = nodes[i];
    if (!$isTextNode(node)) return false;
    if (node.getTextContent() !== specs[i].text) return false;
    if (node.getFormat() !== specs[i].format) return false;
    if ((node.getStyle() || '') !== specs[i].style) return false;
  }
  return true;
}

function MarkdownHighlightPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const processedParagraphs = new Set<string>();
    let isFormatting = false;

    return editor.registerNodeTransform(TextNode, (node) => {
      if (isFormatting) return;

      const paragraph = node.getParent();
      if (!paragraph || !$isParagraphNode(paragraph)) return;

      const paraKey = paragraph.getKey();
      if (processedParagraphs.has(paraKey)) return;
      processedParagraphs.add(paraKey);

      // Clear after all transforms in this batch complete
      if (processedParagraphs.size === 1) {
        queueMicrotask(() => processedParagraphs.clear());
      }

      // Group children into text runs separated by DecoratorNodes
      const children = paragraph.getChildren();
      if (!children.length) return;

      type TextRun = { nodes: LexicalNode[]; text: string };
      const textRuns: TextRun[] = [];
      let currentRun: LexicalNode[] = [];
      for (const child of children) {
        if ($isTextNode(child)) {
          currentRun.push(child);
        } else {
          if (currentRun.length) {
            textRuns.push({ nodes: currentRun, text: currentRun.map(n => n.getTextContent()).join('') });
            currentRun = [];
          }
          // DecoratorNode — skip, leave in place
        }
      }
      if (currentRun.length) {
        textRuns.push({ nodes: currentRun, text: currentRun.map(n => n.getTextContent()).join('') });
      }

      if (!textRuns.length) return;

      // Check if any run needs highlighting
      let anyNeedsUpdate = false;
      const runSpecs: { run: TextRun; specs: HighlightSpec[] }[] = [];
      for (const run of textRuns) {
        if (!run.text) { runSpecs.push({ run, specs: [] }); continue; }
        const segments = parseInlineMarkdown(run.text);
        const specs = mergeAdjacentSpecs(buildHighlightSpecs(segments, run.text));
        let specText = '';
        for (const s of specs) specText += s.text;
        if (specText !== run.text) { runSpecs.push({ run, specs: [] }); continue; }
        if (!specsMatchRun(specs, run.nodes)) anyNeedsUpdate = true;
        runSpecs.push({ run, specs });
      }
      if (!anyNeedsUpdate) return;

      // Save cursor
      const selection = $getSelection();
      let savedOffset = -1;
      if ($isRangeSelection(selection) && selection.isCollapsed()) {
        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();
        if ($isTextNode(anchorNode) && anchorNode.getParent()?.getKey() === paraKey) {
          savedOffset = 0;
          for (const child of paragraph.getChildren()) {
            if (child.getKey() === anchorNode.getKey()) {
              savedOffset += anchor.offset;
              break;
            }
            savedOffset += child.getTextContentSize();
          }
        }
      }

      isFormatting = true;
      try {
        for (const { run, specs } of runSpecs) {
          if (!specs.length || specsMatchRun(specs, run.nodes)) continue;
          // Safety: verify text content still matches before replacing
          const runText = run.nodes.map(n => n.getTextContent()).join('');
          let st = '';
          for (const s of specs) st += s.text;
          if (st !== runText) continue;
          // Insert all new nodes before the first old node, then remove all old nodes
          const firstOld = run.nodes[0];
          for (const spec of specs) {
            const textNode = $createTextNode(spec.text);
            if (spec.format) textNode.setFormat(spec.format);
            if (spec.style) textNode.setStyle(spec.style);
            firstOld.insertBefore(textNode);
          }
          for (const n of run.nodes) n.remove();
        }

        // Restore cursor
        if (savedOffset >= 0) {
          let off = 0;
          for (const child of paragraph.getChildren()) {
            const len = child.getTextContentSize();
            if (off + len >= savedOffset) {
              if ($isTextNode(child)) {
                child.select(savedOffset - off, savedOffset - off);
              }
              break;
            }
            off += len;
          }
        }
      } finally {
        isFormatting = false;
      }
    });
  }, [editor]);

  return null;
}

// Main Component

export const LexicalChatEditor = forwardRef<LexicalChatEditorHandle, LexicalChatEditorProps>((props, ref) => {
  const {
    disabled, placeholder, maxLines = 24, onTextChange, onSubmit,
    onImagePaste, onTextPaste, onMentionQuery, onMentionDismiss,
    onMentionKeyDown, mentionActive, onChannelQuery, onChannelDismiss,
    onChannelKeyDown, channelActive, onEmojiQuery, onEmojiDismiss,
    onEmojiKeyDown, emojiAutoActive, onArrowUpEmpty, onSlashQuery,
    onSlashDismiss, onSlashKeyDown, slashActive, onCodeBlockQuery,
    onCodeBlockDismiss, onCodeBlockKeyDown, codeBlockActive,
    anyDropdownOpen, onEditorBlur, className, style,
  } = props;

  const editorInstanceRef = useRef<LexicalEditor | null>(null);
  const contentEditableRef = useRef<HTMLDivElement>(null);

  // Composer right-click menu.
  // Web: don't intercept — the browser's native menu shows the OS-level
  //   spellcheck suggestions for misspelt words. Cleanest UX, no bundle cost.
  // Electron: main.js listens for `webContents.on('context-menu')` and
  //   forwards Chromium's `params.dictionarySuggestions` /
  //   `params.misspelledWord` / edit flags to us via IPC. We render the
  //   Howl-styled custom menu using that payload, replacing words via
  //   `webContents.replaceMisspelling` and writing user-dictionary
  //   additions through `addWordToSpellCheckerDictionary`.
  const { accessibilitySettings } = useSettings();
  const composerSpellcheck = accessibilitySettings.composerSpellcheck ?? true;
  const isElectron = typeof window !== 'undefined' && !!(window as { __ELECTRON_WINDOW__?: boolean }).__ELECTRON_WINDOW__;
  type ComposerMenuState = {
    x: number;
    y: number;
    misspelledWord: string | null;
    suggestions: string[];
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
  const [composerMenu, setComposerMenu] = useState<ComposerMenuState | null>(null);

  // Subscribe to main-process context-menu IPC. Renderer's onContextMenu
  // fires synchronously; main's `context-menu` event fires immediately
  // after with the spellcheck params. We render the menu only when this
  // IPC arrives (so we never render without the spellcheck data).
  useEffect(() => {
    const sc = (window as { electron?: { spellcheck?: { onContextMenu?: (cb: (params: { x: number; y: number; isEditable: boolean; misspelledWord: string; dictionarySuggestions: string[]; canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean }) => void) => () => void } } }).electron?.spellcheck;
    if (!sc?.onContextMenu) return;
    return sc.onContextMenu((params) => {
      // Filter to right-clicks inside an editable element. The
      // `context-menu` event also fires for clicks on plain page chrome
      // (channel list, message rows, etc.) — we don't want to hijack
      // those; their own handlers manage their own menus.
      if (!params.isEditable) return;
      // Also ignore if the click target wasn't inside our composer.
      // The contentEditable div is what receives the React onContextMenu;
      // we mark that via a data attribute and check the active element.
      const composer = contentEditableRef.current;
      const target = document.elementFromPoint(params.x, params.y);
      if (!composer || !target || !composer.contains(target as Node)) return;
      setComposerMenu({
        x: params.x,
        y: params.y,
        misspelledWord: params.misspelledWord || null,
        suggestions: Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions : [],
        canCut: !!params.canCut,
        canCopy: !!params.canCopy,
        canPaste: !!params.canPaste,
        canSelectAll: !!params.canSelectAll,
      });
    });
  }, []);

  const onComposerContextMenu = useCallback((e: React.MouseEvent) => {
    // Web: let the browser show its native menu (with native spellcheck
    // suggestions). Don't preventDefault.
    if (!isElectron) return;
    // Electron: suppress any default. The custom menu is rendered when
    // main's `composer-context-menu` IPC arrives (subscribed above).
    e.preventDefault();
  }, [isElectron]);

  // Mobile-only: clamp editor max-height against the visible viewport so the send
  // button doesn't get pushed offscreen when the soft keyboard is open. On desktop
  // (≥768px) this is a no-op — the caller's `style` prop is passed through untouched.
  const isMobile = useIsMobile();
  const vh = useVisualViewportHeight(isMobile);
  const contentEditableStyle = useMemo<React.CSSProperties | undefined>(
    () => (isMobile ? { ...style, maxHeight: `${vh * 0.35}px` } : style),
    [isMobile, vh, style],
  );

  useImperativeHandle(ref, () => ({
    getTextContent: () => {
      let text = '';
      editorInstanceRef.current?.read(() => {
        text = $getRoot().getTextContent();
      });
      return text;
    },
    clear: () => {
      editorInstanceRef.current?.update(() => {
        const root = $getRoot();
        root.clear();
        root.append($createParagraphNode());
      }, { tag: 'history-merge' });
    },
    focus: () => {
      editorInstanceRef.current?.focus();
    },
    insertText: (text: string) => {
      editorInstanceRef.current?.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText(text);
        } else {
          const root = $getRoot();
          const lastChild = root.getLastChild();
          if (lastChild) {
            lastChild.selectEnd();
            const newSel = $getSelection();
            if ($isRangeSelection(newSel)) newSel.insertText(text);
          }
        }
      });
    },
    setTextContent: (text: string) => {
      editorInstanceRef.current?.update(() => {
        const root = $getRoot();
        root.clear();
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const para = $createParagraphNode();
          if (lines[i]) para.append($createTextNode(lines[i]));
          root.append(para);
        }
        // Position cursor at the end
        const lastPara = root.getLastChild();
        if (lastPara) lastPara.selectEnd();
      }, { tag: 'history-merge' });
    },
    insertMentionText: (mentionText: string, searchStartPos: number) => {
      editorInstanceRef.current?.update(() => {
        const root = $getRoot();
        const fullText = root.getTextContent();
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;

        // Compute absolute cursor position
        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();
        let absCursor = 0;
        let foundCursor = false;
        const paragraphs = root.getChildren() as ParagraphNode[];

        for (let pi = 0; pi < paragraphs.length; pi++) {
          if (pi > 0) absCursor++;
          const children = paragraphs[pi].getChildren() as TextNode[];
          if (children.length === 0) {
            if (anchorNode.getKey() === paragraphs[pi].getKey()) {
              foundCursor = true;
              break;
            }
          }
          for (const child of children) {
            if (child.getKey() === anchorNode.getKey()) {
              absCursor += anchor.offset;
              foundCursor = true;
              break;
            }
            absCursor += child.getTextContentSize();
          }
          if (foundCursor) break;
        }

        if (!foundCursor) return;

        const before = fullText.slice(0, searchStartPos);
        const after = fullText.slice(absCursor);
        const newText = before + mentionText + ' ' + after;

        // Replace entire content
        root.clear();
        const lines = newText.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const para = $createParagraphNode();
          if (lines[i]) para.append($createTextNode(lines[i]));
          root.append(para);
        }

        // Position cursor after the inserted mention + space
        const targetPos = searchStartPos + mentionText.length + 1;
        let pos = 0;
        const newParagraphs = root.getChildren() as ParagraphNode[];
        for (let pi = 0; pi < newParagraphs.length; pi++) {
          if (pi > 0) pos++;
          const para = newParagraphs[pi];
          const children = para.getChildren() as TextNode[];
          for (const child of children) {
            const len = child.getTextContentSize();
            if (targetPos >= pos && targetPos <= pos + len) {
              (child as TextNode).select(targetPos - pos, targetPos - pos);
              return;
            }
            pos += len;
          }
        }
        // Fallback: select end
        const lastP = root.getLastChild();
        if (lastP) lastP.selectEnd();
      });
    },
    insertMentionPill: (data: MentionPillData, searchStartPos: number) => {
      editorInstanceRef.current?.update(() => {
        $insertDecoratorAtTrigger(() => $createMentionPillNode(data), searchStartPos);
      });
    },
    insertChannelPill: (data: ChannelLinkData, searchStartPos: number) => {
      editorInstanceRef.current?.update(() => {
        $insertDecoratorAtTrigger(() => $createChannelLinkNode(data), searchStartPos);
      });
    },
    insertCustomEmoji: (data: CustomEmojiData, searchStartPos: number) => {
      editorInstanceRef.current?.update(() => {
        $insertDecoratorAtTrigger(() => $createCustomEmojiNode(data), searchStartPos);
      });
    },
    getEditor: () => editorInstanceRef.current,
  }));

  const initialConfig = useRef({
    namespace: 'HowlChatEditor',
    theme,
    nodes: [MentionPillNode, ChannelLinkNode, CustomEmojiNode],
    onError: (error: Error) => {
      // Suppress known non-fatal Lexical reconciliation errors (#75 = stale DOM key, #78 = detached window).
      // These fire during channel switches / unmounts when pending updates race with DOM teardown. Lexical recovers.
      if (/error #(75|78)\b/.test(error.message)) return;
      console.error('Lexical error:', error);
    },
  }).current;

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <EditorRefPlugin editorRef={editorInstanceRef} />
      <BlurDismissPlugin onBlur={onEditorBlur} />
      <div className="relative" onContextMenu={onComposerContextMenu}>
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              ref={contentEditableRef}
              className={className}
              style={contentEditableStyle}
              aria-multiline="true"
              aria-label={placeholder}
              enterKeyHint="send"
              spellCheck={composerSpellcheck}
              data-gramm="false"
              data-gramm_editor="false"
              data-enable-grammarly="false"
            />
          }
          placeholder={
            placeholder ? (
              <div
                className="absolute left-0 top-0 px-2 py-0 pointer-events-none select-none text-sm leading-tight"
                style={{ color: 'var(--text-secondary)', opacity: 0.4 }}
              >
                {placeholder}
              </div>
            ) : null
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <HistoryPlugin />
      <EnterToSendPlugin onSubmit={onSubmit} mentionActive={mentionActive} onMentionKeyDown={onMentionKeyDown} channelActive={channelActive} onChannelKeyDown={onChannelKeyDown} emojiAutoActive={emojiAutoActive} onEmojiKeyDown={onEmojiKeyDown} slashActive={slashActive} onSlashKeyDown={onSlashKeyDown} codeBlockActive={codeBlockActive} onCodeBlockKeyDown={onCodeBlockKeyDown} />
      <MentionDetectorPlugin onMentionQuery={onMentionQuery} onMentionDismiss={onMentionDismiss} />
      <MentionKeyboardPlugin mentionActive={mentionActive} onMentionKeyDown={onMentionKeyDown} />
      <AutoGrowPlugin maxLines={maxLines} contentEditableRef={contentEditableRef} />
      <OnChangePlugin onTextChange={onTextChange} />
      <PasteHandlerPlugin onImagePaste={onImagePaste} onTextPaste={onTextPaste} />
      <DisablePlugin disabled={disabled} />
      <KeyboardShortcutsPlugin />
      <ArrowUpEditPlugin onArrowUpEmpty={onArrowUpEmpty} anyDropdownOpen={anyDropdownOpen} />
      <ChannelDetectorPlugin onChannelQuery={onChannelQuery} onChannelDismiss={onChannelDismiss} />
      <ChannelKeyboardPlugin channelActive={channelActive} onChannelKeyDown={onChannelKeyDown} />
      <EmojiTriggerPlugin onEmojiQuery={onEmojiQuery} onEmojiDismiss={onEmojiDismiss} />
      <EmojiKeyboardPlugin emojiAutoActive={emojiAutoActive} onEmojiKeyDown={onEmojiKeyDown} />
      <BackspaceDecoratorPlugin />
      <SlashCommandDetectorPlugin onSlashQuery={onSlashQuery} onSlashDismiss={onSlashDismiss} />
      <SlashCommandKeyboardPlugin slashActive={slashActive} onSlashKeyDown={onSlashKeyDown} />
      <CodeBlockSelectorPlugin onCodeBlockQuery={onCodeBlockQuery} onCodeBlockDismiss={onCodeBlockDismiss} />
      <CodeBlockKeyboardPlugin codeBlockActive={codeBlockActive} onCodeBlockKeyDown={onCodeBlockKeyDown} />
      <FloatingToolbarPlugin disabled={disabled} anyDropdownOpen={anyDropdownOpen} />
      <MarkdownHighlightPlugin />
      {composerMenu && (
        <ComposerContextMenu
          x={composerMenu.x}
          y={composerMenu.y}
          misspelledWord={composerMenu.misspelledWord}
          suggestions={composerMenu.suggestions}
          canCut={composerMenu.canCut}
          canCopy={composerMenu.canCopy}
          canPaste={composerMenu.canPaste}
          canSelectAll={composerMenu.canSelectAll}
          onReplaceMisspelling={(suggestion) => {
            // webContents.replaceMisspelling on the main side handles
            // selection + insertion correctly; renderer just forwards.
            (window as { electron?: { spellcheck?: { replaceMisspelling?: (w: string) => void } } }).electron?.spellcheck?.replaceMisspelling?.(suggestion);
          }}
          onAddToDictionary={() => {
            if (!composerMenu.misspelledWord) return;
            (window as { electron?: { spellcheck?: { addToDictionary?: (w: string) => void } } }).electron?.spellcheck?.addToDictionary?.(composerMenu.misspelledWord);
          }}
          onCut={() => { try { document.execCommand('cut'); } catch { /* clipboard blocked */ } }}
          onCopy={() => { try { document.execCommand('copy'); } catch { /* */ } }}
          onPaste={() => { try { document.execCommand('paste'); } catch { /* */ } }}
          onSelectAll={() => { try { document.execCommand('selectAll'); } catch { /* */ } }}
          onClose={() => setComposerMenu(null)}
        />
      )}
    </LexicalComposer>
  );
});

LexicalChatEditor.displayName = 'LexicalChatEditor';
