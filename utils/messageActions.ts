// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Channel message action utilities.
 * Extracted from App.tsx useCallback handlers for reuse outside React components.
 */
import { apiClient } from '../services/api';
import { useMessageStore } from '../stores/messageStore';
import { useUiStore } from '../stores/uiStore';
import type { Message } from '../types';

// Mirror of dmActions.ts cap. Both paths must keep the in-memory list bounded.
const MAX_MESSAGES_PER_CHANNEL = 1000;
const capMessages = (arr: Message[]) =>
  arr.length > MAX_MESSAGES_PER_CHANNEL ? arr.slice(-MAX_MESSAGES_PER_CHANNEL) : arr;

// Send a message to a specific channel

export function sendChannelMessage(
  channelId: string,
  content: string,
  replyToMessageId?: string,
  attachment?: { url: string; name: string; contentType?: string },
  isForward?: boolean,
  showToast?: (msg: string, type: string) => void,
): Promise<void> {
  return apiClient
    .sendChannelMessage(channelId, content, replyToMessageId, attachment, isForward)
    .then((saved) => {
      useMessageStore.getState().addChannelMessage(channelId, saved);
    })
    .catch((err) => {
      console.error('Failed to send message:', err);
      const isRateLimit = !!(err && (err.isRateLimit || (typeof err.message === 'string' && err.message.toLowerCase().includes('rate limit'))));
      const fallback = err instanceof Error ? err.message : 'Failed to send message';
      showToast?.(isRateLimit ? "You're sending messages too fast. Wait a few seconds and try again." : fallback, 'warning');
    });
}

// Pin a channel message

export function pinChannelMessage(channelId: string, messageId: string): void {
  apiClient
    .pinChannelMessage(channelId, messageId)
    .then(() => {
      useMessageStore.getState().addChannelPinnedId(channelId, messageId);
    })
    .catch((err) => console.error('Failed to pin message:', err));
}

// Unpin a channel message

export function unpinChannelMessage(channelId: string, messageId: string): void {
  apiClient
    .unpinChannelMessage(channelId, messageId)
    .then(() => {
      useMessageStore.getState().removeChannelPinnedId(channelId, messageId);
      // Remove the "X pinned a message" system message
      const { messages } = useMessageStore.getState();
      const list = messages[channelId] ?? [];
      const filtered = list.filter(
        (m) =>
          !(
            m.type === 'system' &&
            m.systemPayload?.kind === 'pin' &&
            m.systemPayload?.messageId === messageId
          ),
      );
      if (filtered.length !== list.length) {
        useMessageStore.getState()._setAll({
          messages: { ...useMessageStore.getState().messages, [channelId]: filtered },
        });
      }
    })
    .catch((err) => console.error('Failed to unpin message:', err));
}

// Set delete-message pending (shows confirm modal)

export function promptDeleteMessage(
  channelId: string,
  messageId: string,
): void {
  const { messages } = useMessageStore.getState();
  const msgs = messages[channelId] ?? [];
  const msg = msgs.find((m) => m.id === messageId);
  useMessageStore.getState().setDeleteMessagePending({
    id: messageId,
    channelId,
    content: msg?.content ?? '',
    authorUsername: msg?.authorUsername ?? 'Unknown',
    authorAvatar: msg?.authorAvatar,
    createdAt: msg?.timestamp
      ? new Date(msg.timestamp).toISOString()
      : new Date().toISOString(),
  });
}

// Confirm and execute a pending delete

export function confirmDeleteMessage(
  showToast?: (msg: string, type: string) => void,
): void {
  const pending = useMessageStore.getState().deleteMessagePending;
  if (!pending) return;
  useMessageStore.getState().setDeleteMessagePending(null);
  apiClient
    .deleteChannelMessage(pending.channelId, pending.id)
    .then(() => {
      useMessageStore.getState().removeChannelMessage(pending.channelId, pending.id);
      useMessageStore.getState().removeChannelPinnedId(pending.channelId, pending.id);
    })
    .catch((err) => {
      console.error('Failed to delete message:', err);
      showToast?.('Failed to delete message', 'warning');
    });
}

// Edit a channel message

export function editChannelMessage(
  channelId: string,
  messageId: string,
  newContent: string,
  showToast?: (msg: string, type: string) => void,
): void {
  apiClient
    .editChannelMessage(channelId, messageId, newContent)
    .then((res) => {
      useMessageStore.getState().updateChannelMessage(channelId, messageId, (m) => ({
        ...m,
        content: res.content,
        editedAt: res.editedAt,
      }));
    })
    .catch((err) => {
      console.error('Failed to edit message:', err);
      showToast?.('Failed to edit message', 'warning');
    });
}

// Report a channel message (opens report modal)

export function reportChannelMessage(
  channelId: string,
  messageId: string,
  currentUserId: string | undefined,
): void {
  const { messages } = useMessageStore.getState();
  const msgs = messages[channelId] ?? [];
  const msg = msgs.find((m) => m.id === messageId);
  if (!msg || !currentUserId) return;
  useUiStore.getState().setReportModal({
    messageId,
    messageType: 'channel',
    channelId,
    authorId: msg.authorId,
    content: msg.content,
    attachmentUrl: msg.attachmentUrl ?? undefined,
  });
}

// React to a channel message (optimistic toggle)

export function reactChannelMessage(
  channelId: string,
  messageId: string,
  emoji: string,
  currentUserId: string,
): void {
  useMessageStore.getState().updateChannelMessage(channelId, messageId, (m) => {
    const reactions = [...(m.reactions ?? [])];
    const idx = reactions.findIndex((r) => r.emoji === emoji);
    if (idx >= 0) {
      const r = reactions[idx];
      if (r.userIds.includes(currentUserId)) {
        const next = r.userIds.filter((id) => id !== currentUserId);
        if (next.length === 0) reactions.splice(idx, 1);
        else reactions[idx] = { ...r, userIds: next };
      } else {
        reactions[idx] = { ...r, userIds: [...r.userIds, currentUserId] };
      }
    } else {
      reactions.push({ emoji, userIds: [currentUserId] });
    }
    return { ...m, reactions };
  });
  apiClient.reactChannelMessage(channelId, messageId, emoji).catch(() => {
    // Revert optimistic reaction by re-applying the inverse toggle
    useMessageStore.getState().updateChannelMessage(channelId, messageId, (m) => {
      const reactions = [...(m.reactions ?? [])];
      const idx = reactions.findIndex((r) => r.emoji === emoji);
      if (idx >= 0) {
        const r = reactions[idx];
        if (r.userIds.includes(currentUserId)) {
          const next = r.userIds.filter((id) => id !== currentUserId);
          if (next.length === 0) reactions.splice(idx, 1);
          else reactions[idx] = { ...r, userIds: next };
        } else {
          reactions[idx] = { ...r, userIds: [...r.userIds, currentUserId] };
        }
      } else {
        reactions.push({ emoji, userIds: [currentUserId] });
      }
      return { ...m, reactions };
    });
  });
}

// Forward image (opens forward modal)

export function forwardImage(att: {
  url: string;
  name: string;
  contentType?: string;
}): void {
  useUiStore.getState().setForwardPayload({ attachment: att });
}

// Forward message to a channel

export async function forwardToChannel(
  channelId: string,
  payload: { text?: string; attachment?: { url: string; name: string; contentType?: string } },
): Promise<void> {
  const content = payload.text ?? (payload.attachment ? '(attachment)' : '');
  const saved = await apiClient.sendChannelMessage(channelId, content, undefined, payload.attachment, true);
  useMessageStore.getState().addChannelMessage(channelId, saved);
}

// Load older channel messages

// Per-channel in-flight guard. A module-level boolean would silently drop a
// fetch on channel B if channel A had a fetch in flight when the user switched.
const _loadingOlderChannels = new Set<string>();

export async function loadOlderChannelMessages(channelId: string): Promise<void> {
  if (!channelId || _loadingOlderChannels.has(channelId)) return;
  const { messages, channelHasMore } = useMessageStore.getState();
  const current = messages[channelId];
  if (!current || current.length === 0 || !channelHasMore[channelId]) return;
  const oldest = current[0];
  _loadingOlderChannels.add(channelId);
  try {
    const { messages: older, hasMore } = await apiClient.getChannelMessages(channelId, {
      before: oldest.id,
    });
    if (older.length > 0) {
      const store = useMessageStore.getState();
      const existing = store.messages[channelId] ?? [];
      const existingIds = new Set(existing.map((m) => m.id));
      const newOlder = older.filter((m) => !existingIds.has(m.id));
      store._setAll({
        messages: { ...store.messages, [channelId]: capMessages([...newOlder, ...existing]) },
        channelHasMore: { ...store.channelHasMore, [channelId]: hasMore },
      });
    } else {
      useMessageStore.getState().setChannelHasMore(channelId, hasMore);
    }
  } catch (err) {
    console.error('Failed to load older messages:', err);
  } finally {
    _loadingOlderChannels.delete(channelId);
  }
}
