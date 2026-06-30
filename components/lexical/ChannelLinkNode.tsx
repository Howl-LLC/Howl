// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { Hash, Volume2, Radio } from 'lucide-react';
import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  $applyNodeReplacement,
} from 'lexical';

export interface ChannelLinkData {
  channelId: string;
  channelName: string;
  channelType: 'text' | 'voice' | 'stage' | 'forum' | 'role_picker';
}

export type SerializedChannelLinkNode = SerializedLexicalNode & {
  data: ChannelLinkData;
};

function ChannelLinkComponent({ data }: { data: ChannelLinkData }) {
  const Icon = data.channelType === 'voice' ? Volume2 : data.channelType === 'stage' ? Radio : Hash;
  return (
    <span
      className="inline-flex items-center gap-0.5 px-1 py-0 rounded-lg text-xs font-medium align-baseline cursor-pointer select-none hover:underline hover:opacity-80 transition-opacity"
      style={{
        backgroundColor: 'var(--accent-subtle)',
        color: 'var(--cyan-accent)',
      }}
    >
      <Icon size={11} />
      <span>{data.channelName}</span>
    </span>
  );
}

export class ChannelLinkNode extends DecoratorNode<React.JSX.Element> {
  __data: ChannelLinkData;

  static getType(): string {
    return 'channel-link';
  }

  static clone(node: ChannelLinkNode): ChannelLinkNode {
    return new ChannelLinkNode(node.__data, node.__key);
  }

  constructor(data: ChannelLinkData, key?: NodeKey) {
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
    return `#${this.__data.channelName}`;
  }

  getTextContentSize(): number {
    return this.__data.channelName.length + 1;
  }

  isInline(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  decorate(): React.JSX.Element {
    return <ChannelLinkComponent data={this.__data} />;
  }

  exportJSON(): SerializedChannelLinkNode {
    return { type: 'channel-link', data: this.__data, version: 1 };
  }

  static importJSON(json: SerializedChannelLinkNode): ChannelLinkNode {
    return $createChannelLinkNode(json.data);
  }
}

export function $createChannelLinkNode(data: ChannelLinkData): ChannelLinkNode {
  return $applyNodeReplacement(new ChannelLinkNode(data));
}

export function $isChannelLinkNode(node: LexicalNode | null | undefined): node is ChannelLinkNode {
  return node instanceof ChannelLinkNode;
}
