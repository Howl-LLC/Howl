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

export interface CustomEmojiData {
  emojiId: string;
  name: string;
  imageUrl: string;
  serverId: string;
}

export type SerializedCustomEmojiNode = SerializedLexicalNode & {
  data: CustomEmojiData;
};

export class CustomEmojiNode extends DecoratorNode<React.JSX.Element> {
  __data: CustomEmojiData;

  static getType(): string {
    return 'custom-emoji';
  }

  static clone(node: CustomEmojiNode): CustomEmojiNode {
    return new CustomEmojiNode(node.__data, node.__key);
  }

  constructor(data: CustomEmojiData, key?: NodeKey) {
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
    return `:${this.__data.name}:`;
  }

  getTextContentSize(): number {
    return this.__data.name.length + 2;
  }

  isInline(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  decorate(): React.JSX.Element {
    return (
      <img
        src={this.__data.imageUrl}
        alt={`:${this.__data.name}:`}
        title={`:${this.__data.name}:`}
        className="inline-block align-text-bottom"
        style={{ width: '1.2em', height: '1.2em' }}
        draggable={false}
      />
    );
  }

  exportJSON(): SerializedCustomEmojiNode {
    return { type: 'custom-emoji', data: this.__data, version: 1 };
  }

  static importJSON(json: SerializedCustomEmojiNode): CustomEmojiNode {
    return $createCustomEmojiNode(json.data);
  }
}

export function $createCustomEmojiNode(data: CustomEmojiData): CustomEmojiNode {
  return $applyNodeReplacement(new CustomEmojiNode(data));
}

export function $isCustomEmojiNode(node: LexicalNode | null | undefined): node is CustomEmojiNode {
  return node instanceof CustomEmojiNode;
}
