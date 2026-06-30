// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { Channel, Message, User } from '../types';
import { MessageInput } from './MessageInput';
import { MentionText } from './MentionText';
import { LetterAvatar } from './LetterAvatar';
import { RoleNameStyle } from './RoleNameStyle';

export interface StageTextChatProps {
  channel: Channel;
  messages: Message[];
  users: User[];
  currentUserId: string;
  onSendMessage: (content: string) => void;
  maxAttachmentMB: number;
  userPlan?: string | null;
  allowEmojis?: boolean;
  allowStickers?: boolean;
  allowGifs?: boolean;
}

export const StageTextChat: React.FC<StageTextChatProps> = ({ channel, messages, users, currentUserId: _currentUserId, onSendMessage, maxAttachmentMB, userPlan, allowEmojis, allowStickers, allowGifs }) => {
  const { t } = useTranslation();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const usersById = React.useMemo(() => {
    const map = new Map<string, User>();
    for (const u of users) map.set(u.id, u);
    return map;
  }, [users]);

  const memberNames = React.useMemo(() => users.map(u => u.username), [users]);

  // Show last 100 messages
  const recentMessages = messages.slice(-100);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [recentMessages.length]);

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-1 no-scrollbar">
        {recentMessages.length === 0 && (
          <p className="text-xs text-center py-4" style={{ color: 'var(--text-tertiary)' }}>{t('threads.noMessages')}</p>
        )}
        {recentMessages.map((msg) => {
          const author = usersById.get(msg.authorId);
          return (
            <div key={msg.id} className="flex items-start gap-2 py-0.5">
              <div className="w-6 h-6 rounded-[var(--radius-lg)] overflow-hidden shrink-0 mt-0.5">
                <LetterAvatar avatar={author?.avatar ?? null} username={author?.username ?? '?'} size={24} className="rounded-full" />
              </div>
              <div className="min-w-0">
                <RoleNameStyle
                  name={author?.username ?? 'Unknown'}
                  overrideColor={(author as any)?.nameColor}
                  overrideFont={(author as any)?.nameFont}
                  nameEffect={(author as any)?.nameEffect}
                  className="text-xs font-semibold mr-1.5 inline"
                />
                <span className="text-xs break-words" style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
                  <MentionText content={msg.content} messageId={msg.id} memberNames={memberNames} />
                </span>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 px-2 pb-2">
        <MessageInput
          channel={channel}
          users={users}
          onSendMessage={(content) => onSendMessage(content)}
          isDM={false}
          uiDensity="compact"
          maxAttachmentMB={maxAttachmentMB}
          userPlan={userPlan}
          replyingTo={null}
          onCancelReply={() => {}}
          showSendBtn
          disableEmojis={!allowEmojis}
          disableStickers={!allowStickers}
          disableGifs={!allowGifs}
        />
      </div>
    </div>
  );
};
