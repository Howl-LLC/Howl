// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Thread action utilities.
 * Extracted from App.tsx useCallback handlers for reuse outside React components.
 */
import { apiClient } from '../services/api';
import { socketService } from '../services/socket';
import { useThreadPollStore } from '../stores/threadPollStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useUiStore } from '../stores/uiStore';
import { useMessageStore } from '../stores/messageStore';
import { isRealServerId } from './navigationHelpers';
import type { Thread } from '../types';

// Open a thread

export function openThread(thread: Thread, activeServerId?: string | null): void {
  useThreadPollStore.getState().setActiveThread(thread);
  useUiStore.getState().setThreadBrowserOpen(false);
  useThreadPollStore.getState().setUnreadThreadIds((prev) => {
    const next = new Set(prev);
    next.delete(thread.id);
    return next;
  });
  useThreadPollStore.getState().setUnreadThreadCounts((prev) => {
    const next = { ...prev };
    delete next[thread.id];
    return next;
  });
  useNotificationStore.getState().clearThreadMention(thread.id);
  if (isRealServerId(activeServerId)) {
    apiClient.markThreadRead(activeServerId, thread.id).catch(() => {});
  }
  socketService.joinThread(thread.id);
  if (isRealServerId(activeServerId)) {
    apiClient
      .getThreadMessages(activeServerId, thread.id)
      .then((msgs) => {
        useThreadPollStore.getState().setThreadMessagesRaw((prev) => ({
          ...prev,
          [thread.id]: msgs,
        }));
      })
      .catch(() => {});
  }
}

// Close a thread

export function closeThread(): void {
  const activeThread = useThreadPollStore.getState().activeThread;
  if (activeThread) socketService.leaveThread(activeThread.id);
  useThreadPollStore.getState().setActiveThread(null);
}

// Open thread creation modal

export function openCreateThread(parentMessageId: string, parentContent: string): void {
  useUiStore.getState().setThreadCreationModal({ parentMessageId, parentContent });
}

// Submit thread creation

export async function submitCreateThread(
  data: {
    name: string;
    parentMessageId: string;
    autoArchive: boolean;
    autoArchiveDuration: string;
  },
  activeServerId: string,
  activeChannelId: string,
): Promise<void> {
  const thread = await apiClient.createThread(activeChannelId, activeServerId, data);
  useUiStore.getState().setThreadCreationModal(null);
  openThread(thread, activeServerId);
}

// Create thread from context menu (uses last message in channel)

export function createThreadFromMenu(activeChannelId: string, targetMessageId?: string): void {
  if (!activeChannelId) return;
  const { messages } = useMessageStore.getState();
  const channelMsgs = messages[activeChannelId] ?? [];
  const targetMsg = targetMessageId
    ? channelMsgs.find((m) => m.id === targetMessageId)
    : undefined;
  const parentMsg = targetMsg ?? channelMsgs[channelMsgs.length - 1];
  if (parentMsg) {
    useUiStore.getState().setThreadCreationModal({
      parentMessageId: parentMsg.id,
      parentContent: targetMsg ? (targetMsg.content ?? '') : '',
    });
  }
}

// Send a thread message

export async function sendThreadMessage(
  activeServerId: string,
  threadId: string,
  content: string,
  replyToMessageId?: string,
  attachment?: {
    url: string;
    name: string;
    contentType?: string;
    width?: number | null;
    height?: number | null;
  },
  showToast?: (msg: string, type: string) => void,
): Promise<void> {
  try {
    const sentMsg = await apiClient.sendThreadMessage(
      activeServerId,
      threadId,
      content,
      replyToMessageId,
      attachment,
    );
    if (sentMsg) {
      useThreadPollStore.getState().setThreadMessagesRaw((prev) => {
        const list = prev[threadId] ?? [];
        if (list.some((m) => m.id === sentMsg.id)) return prev;
        return { ...prev, [threadId]: [...list, sentMsg] };
      });
    }
  } catch (err) {
    const isRateLimit = !!(err && ((err as any).isRateLimit || (err instanceof Error && err.message.toLowerCase().includes('rate limit'))));
    const fallback = err instanceof Error ? err.message : 'Failed to send thread message';
    console.error('Failed to send thread message:', err);
    showToast?.(isRateLimit ? "You're sending messages too fast. Wait a few seconds and try again." : fallback, 'warning');
  }
}
