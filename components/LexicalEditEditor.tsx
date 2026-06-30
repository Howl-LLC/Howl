// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { forwardRef, useImperativeHandle, useRef, useEffect, useMemo } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_DOWN_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { MentionPillNode } from './lexical/MentionPillNode';
import { ChannelLinkNode } from './lexical/ChannelLinkNode';
import { CustomEmojiNode } from './lexical/CustomEmojiNode';
import { useIsMobile } from '../hooks/useIsMobile';
import { useVisualViewportHeight } from '../hooks/useVisualViewportHeight';

export interface LexicalEditEditorProps {
  initialValue: string;
  onSave: (text: string) => void;
  onCancel: () => void;
  onChange?: (text: string) => void;
  className?: string;
  style?: React.CSSProperties;
  maxLength?: number;
}

export interface LexicalEditEditorHandle {
  focus: () => void;
  getTextContent: () => string;
}

function EditorRefPlugin({ editorRef }: { editorRef: React.MutableRefObject<LexicalEditor | null> }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { editorRef.current = editor; }, [editor, editorRef]);
  return null;
}

function EditKeyboardPlugin({ onSave, onCancel, maxLength }: { onSave: (text: string) => void; onCancel: () => void; maxLength?: number }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
          return true;
        }
        if (event.key === 'Enter' && !event.shiftKey && !editor.isComposing()) {
          event.preventDefault();
          editor.read(() => {
            const text = $getRoot().getTextContent().trim();
            if (maxLength && text.length > maxLength) return; // silently block oversized saves
            onSave(text);
          });
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onSave, onCancel, maxLength]);
  return null;
}

function EditOnChangePlugin({ onChange }: { onChange?: (text: string) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    if (!onChange) return;
    return editor.registerUpdateListener(() => {
      editor.read(() => {
        onChange($getRoot().getTextContent());
      });
    });
  }, [editor, onChange]);
  return null;
}

function AutoFocusPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editor.focus();
  }, [editor]);
  return null;
}

export const LexicalEditEditor = forwardRef<LexicalEditEditorHandle, LexicalEditEditorProps>((props, ref) => {
  const { initialValue, onSave, onCancel, onChange, className, style, maxLength } = props;
  const editorInstanceRef = useRef<LexicalEditor | null>(null);

  // Mobile-only: clamp the editor's max-height against the visible viewport so a long
  // message can't push the Save/Cancel row offscreen when the soft keyboard is open.
  const isMobile = useIsMobile();
  const vh = useVisualViewportHeight(isMobile);
  const contentEditableStyle = useMemo<React.CSSProperties>(
    () => ({
      minHeight: '1.5em',
      maxHeight: isMobile ? `${vh * 0.35}px` : '200px',
      overflowY: 'auto',
    }),
    [isMobile, vh],
  );

  useImperativeHandle(ref, () => ({
    focus: () => { editorInstanceRef.current?.focus(); },
    getTextContent: () => {
      let text = '';
      editorInstanceRef.current?.read(() => {
        text = $getRoot().getTextContent();
      });
      return text;
    },
  }));

  const initialConfig = useRef({
    namespace: 'HowlEditEditor',
    theme: { paragraph: 'lexical-paragraph' },
    nodes: [MentionPillNode, ChannelLinkNode, CustomEmojiNode],
    onError: (error: Error) => {
      if (/error #(75|78)\b/.test(error.message)) return;
      console.error('Lexical edit error:', error);
    },
    editorState: () => {
      const root = $getRoot();
      const lines = initialValue.split('\n');
      for (const line of lines) {
        const p = $createParagraphNode();
        if (line) p.append($createTextNode(line));
        root.append(p);
      }
    },
  }).current;

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <EditorRefPlugin editorRef={editorInstanceRef} />
      <div className={className} style={style}>
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className="outline-none w-full text-sm"
              style={contentEditableStyle}
              aria-multiline="true"
              aria-label="Edit message"
              data-gramm="false"
              data-gramm_editor="false"
              data-enable-grammarly="false"
            />
          }
          placeholder={null}
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <HistoryPlugin />
      <EditKeyboardPlugin onSave={onSave} onCancel={onCancel} maxLength={maxLength} />
      <EditOnChangePlugin onChange={onChange} />
      <AutoFocusPlugin />
    </LexicalComposer>
  );
});

LexicalEditEditor.displayName = 'LexicalEditEditor';
