// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Users, Hash } from 'lucide-react';
import { UserAvatar } from './UserAvatar';
import { GroupAvatarComposite } from './GroupAvatarComposite';

/**
 * Centered placeholder shown over the message list when a channel/DM has been
 * fetched and is genuinely empty (no messages yet). Sibling-absolute over the
 * Virtuoso so it disappears the instant the first message arrives without
 * forcing Virtuoso to remount.
 */
export type EmptyChatStateProps = {
  surface: 'channel' | 'dm' | 'group-dm' | 'otr';
  channelName: string;
  otherUser?: {
    username: string;
    avatar?: string | null;
    avatarEffect?: string | null;
    effectivePlan?: string | null;
    stripePlan?: string | null;
  } | null;
  groupMembers?: Array<{ avatar?: string | null; username: string }>;
};

export function EmptyChatState({ surface, channelName, otherUser, groupMembers }: EmptyChatStateProps) {
  const { t } = useTranslation();

  let icon: React.ReactNode;
  let title: string;
  let hint = '';
  let otrBody: React.ReactNode = null;

  if (surface === 'otr' && otherUser) {
    icon = <UserAvatar user={otherUser} size={64} shape="squircle" />;
    title = t('chat.otrEmptyTitle', 'Off the Record with {{name}}', { name: otherUser.username });
    otrBody = (
      <div className="flex flex-col gap-2 max-w-sm text-center">
        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {t('chat.otrEmptyDeviceOnly', 'This conversation lives only on your devices. It is never backed up to our servers.')}
        </p>
        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {t('chat.otrEmptyForwardSecret', 'It is forward secret: keys are erased as you go, so earlier messages cannot be recovered later.')}
        </p>
        <div className="flex flex-col gap-1 mt-1">
          <p className="text-xs leading-relaxed" style={{ color: '#fbbf24' }}>
            {t('chat.otrEmptyNewDevice', 'A new device will not see this history.')}
          </p>
          <p className="text-xs leading-relaxed" style={{ color: '#fbbf24' }}>
            {t('chat.otrEmptyLostDevices', 'If you lose all your devices, these messages are gone for good.')}
          </p>
          <p className="text-xs leading-relaxed" style={{ color: '#fbbf24' }}>
            {t('chat.otrEmptyOtherCopies', 'It cannot stop the other person from keeping their own copies.')}
          </p>
        </div>
      </div>
    );
  } else if (surface === 'dm' && otherUser) {
    icon = <UserAvatar user={otherUser} size={64} shape="squircle" />;
    title = t('chat.emptyDmTitle', 'This is the start of your messages with {{name}}.', { name: otherUser.username });
    hint = t('chat.emptyDmHint', 'Say hi to get the conversation going.');
  } else if (surface === 'group-dm') {
    icon = groupMembers && groupMembers.length > 0
      ? <GroupAvatarComposite members={groupMembers} size={64} />
      : (
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center"
          style={{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--glass-border)' }}
        >
          <Users size={28} style={{ color: 'var(--text-secondary)' }} />
        </div>
      );
    title = t('chat.emptyGroupDmTitle', 'Welcome to {{name}}.', { name: channelName });
    hint = t('chat.emptyGroupDmHint', 'Be the first to send a message.');
  } else {
    icon = (
      <div
        className="w-16 h-16 rounded-full flex items-center justify-center"
        style={{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--glass-border)' }}
      >
        <Hash size={32} style={{ color: 'var(--text-secondary)' }} />
      </div>
    );
    title = t('chat.emptyChannelTitle', 'Welcome to #{{name}}', { name: channelName });
    hint = t('chat.emptyChannelHint', 'This is the start of the #{{name}} channel. Send a message to kick things off.', { name: channelName });
  }

  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 px-6 pointer-events-none select-none"
    >
      <div className="opacity-70 mb-1">{icon}</div>
      <p className="text-base font-semibold text-center max-w-md" style={{ color: 'var(--text-primary)' }}>{title}</p>
      {otrBody ?? <p className="text-xs text-center max-w-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{hint}</p>}
    </div>
  );
}
