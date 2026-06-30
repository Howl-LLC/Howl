// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  $applyNodeReplacement,
} from 'lexical';
import { LazyGif } from '../LazyGif';
import { getFrameUrl } from '../../utils/getFrameUrl';

export interface MentionPillData {
  mentionText: string; // raw: "@username" or "@<Name With Spaces>" or "@everyone"
  displayName: string; // display: "username" or "Name With Spaces" or "everyone"
  mentionType: 'user' | 'role' | 'everyone' | 'here';
  userId?: string;
  roleColor?: string | null;
  avatar?: string | null;
}

export type SerializedMentionPillNode = SerializedLexicalNode & {
  data: MentionPillData;
};

function MentionPillComponent({ data }: { data: MentionPillData }) {
  const accentColor =
    data.mentionType === 'everyone' || data.mentionType === 'here'
      ? 'var(--cyan-accent)'
      : data.roleColor || 'var(--cyan-accent)';

  return (
    <span
      className="inline-flex items-center gap-0.5 px-1 py-0 rounded-lg text-xs font-medium align-baseline cursor-default select-none"
      style={{
        backgroundColor: `color-mix(in srgb, ${accentColor} 15%, transparent)`,
        color: accentColor,
      }}
    >
      {data.avatar && data.mentionType === 'user' && (
        <LazyGif src={data.avatar} frameSrc={getFrameUrl(data.avatar)} alt="" className="w-3.5 h-3.5 rounded-[var(--radius-lg)] inline-block" draggable={false} />
      )}
      <span>@{data.displayName}</span>
    </span>
  );
}

export class MentionPillNode extends DecoratorNode<React.JSX.Element> {
  __data: MentionPillData;

  static getType(): string {
    return 'mention-pill';
  }

  static clone(node: MentionPillNode): MentionPillNode {
    return new MentionPillNode(node.__data, node.__key);
  }

  constructor(data: MentionPillData, key?: NodeKey) {
    super(key);
    this.__data = data;
  }

  createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.style.display = 'inline';
    return span;
  }

  updateDOM(): boolean {
    return false;
  }

  getTextContent(): string {
    return this.__data.mentionText;
  }

  getTextContentSize(): number {
    return this.__data.mentionText.length;
  }

  isInline(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  decorate(): React.JSX.Element {
    return <MentionPillComponent data={this.__data} />;
  }

  exportJSON(): SerializedMentionPillNode {
    return { type: 'mention-pill', data: this.__data, version: 1 };
  }

  static importJSON(json: SerializedMentionPillNode): MentionPillNode {
    return $createMentionPillNode(json.data);
  }
}

export function $createMentionPillNode(data: MentionPillData): MentionPillNode {
  return $applyNodeReplacement(new MentionPillNode(data));
}

export function $isMentionPillNode(node: LexicalNode | null | undefined): node is MentionPillNode {
  return node instanceof MentionPillNode;
}
