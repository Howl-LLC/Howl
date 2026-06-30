// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { Smile, MessageCirclePlus, BarChart3, Code2, EyeOff, Image, UserCog } from 'lucide-react';
import { $getRoot } from 'lexical';
import type { LexicalChatEditorHandle } from '../LexicalChatEditor';

export interface SlashCommandArg {
  name: string;
  description: string;
  type: 'string' | 'user' | 'channel' | 'role' | 'number';
  required: boolean;
}

export interface SlashCommandContext {
  editorRef: React.RefObject<LexicalChatEditorHandle | null>;
  onSendMessage: (content: string) => void;
  onCreatePoll?: () => void;
  onCreateThread?: () => void;
  onSlashCommand?: (command: string, args: Record<string, string>) => void;
  activeServerId?: string;
  isDM: boolean;
}

export interface SlashCommand {
  name: string;
  description: string;
  icon: React.ReactNode;
  args: SlashCommandArg[];
  immediate?: boolean;
  execute?: (args: Record<string, string>, context: SlashCommandContext) => 'send' | 'keep' | 'clear';
  action?: (args: Record<string, string>, context: SlashCommandContext) => void;
  serverOnly?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'shrug',
    description: 'Appends \u00AF\\_(\u30C4)_/\u00AF to your message',
    icon: <Smile size={16} />,
    args: [{ name: 'message', description: 'Optional message', type: 'string', required: false }],
    execute: (args, ctx) => {
      const msg = args.message ? `${args.message} \u00AF\\_(\u30C4)_/\u00AF` : '\u00AF\\_(\u30C4)_/\u00AF';
      ctx.editorRef.current?.setTextContent(msg);
      return 'send';
    },
  },
  {
    name: 'tableflip',
    description: 'Flips the table',
    icon: <Smile size={16} />,
    args: [],
    immediate: true,
    execute: (_args, ctx) => {
      ctx.editorRef.current?.setTextContent('(\u256F\u00B0\u25A1\u00B0)\u256F\uFE35 \u253B\u2501\u253B');
      return 'send';
    },
  },
  {
    name: 'unflip',
    description: 'Puts the table back',
    icon: <Smile size={16} />,
    args: [],
    immediate: true,
    execute: (_args, ctx) => {
      ctx.editorRef.current?.setTextContent('\u252C\u2500\u252C\u30CE( \u00BA _ \u00BA\u30CE)');
      return 'send';
    },
  },
  {
    name: 'lenny',
    description: 'Lenny face',
    icon: <Smile size={16} />,
    args: [],
    immediate: true,
    execute: (_args, ctx) => {
      ctx.editorRef.current?.setTextContent('( \u0361\u00B0 \u035C\u0296 \u0361\u00B0)');
      return 'send';
    },
  },
  {
    name: 'disapprove',
    description: 'Look of disapproval',
    icon: <Smile size={16} />,
    args: [],
    immediate: true,
    execute: (_args, ctx) => {
      ctx.editorRef.current?.setTextContent('\u0CA0_\u0CA0');
      return 'send';
    },
  },
  {
    name: 'spoiler',
    description: 'Mark text as a spoiler',
    icon: <EyeOff size={16} />,
    args: [{ name: 'text', description: 'Text to hide', type: 'string', required: true }],
    execute: (args, ctx) => {
      ctx.editorRef.current?.setTextContent(`||${args.text}||`);
      return 'keep';
    },
  },
  {
    name: 'code',
    description: 'Insert a code block',
    icon: <Code2 size={16} />,
    args: [{ name: 'language', description: 'Programming language', type: 'string', required: false }],
    execute: (args, ctx) => {
      const lang = args.language || '';
      ctx.editorRef.current?.setTextContent(`\`\`\`${lang}\n\n\`\`\``);
      // Position cursor on the empty middle line for typing
      setTimeout(() => {
        const editor = ctx.editorRef.current?.getEditor();
        if (!editor?.getRootElement()) return; // editor unmounted
        editor.update(() => {
          const root = $getRoot();
          const children = root.getChildren();
          if (children.length >= 2) children[1].selectEnd();
        });
      }, 0);
      return 'keep';
    },
  },
  {
    name: 'me',
    description: 'Send an action message',
    icon: <Smile size={16} />,
    args: [{ name: 'action', description: 'What you are doing', type: 'string', required: true }],
    execute: (args, ctx) => {
      ctx.editorRef.current?.setTextContent(`*${args.action}*`);
      return 'send';
    },
  },
  {
    name: 'poll',
    description: 'Create a poll',
    icon: <BarChart3 size={16} />,
    args: [],
    immediate: true,
    action: (_args, ctx) => { ctx.onCreatePoll?.(); },
  },
  {
    name: 'thread',
    description: 'Create a thread',
    icon: <MessageCirclePlus size={16} />,
    args: [],
    immediate: true,
    action: (_args, ctx) => { ctx.onCreateThread?.(); },
  },
  {
    name: 'giphy',
    description: 'Search and send a GIF',
    icon: <Image size={16} />,
    args: [{ name: 'search', description: 'Search term', type: 'string', required: true }],
    action: (args, ctx) => { ctx.onSlashCommand?.('giphy', args); },
  },
  {
    name: 'nick',
    description: 'Change your server nickname',
    icon: <UserCog size={16} />,
    args: [{ name: 'name', description: 'New nickname', type: 'string', required: true }],
    serverOnly: true,
    action: (args, ctx) => { ctx.onSlashCommand?.('nick', args); },
  },
];
