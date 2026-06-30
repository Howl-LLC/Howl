// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect } from 'react';
import type { Poll, Thread, ThreadMessage, Message } from '../types';
import { socketService } from '../services/socket';
import { deferStoreUpdate } from '../utils/storeHelpers';
import { useThreadPollStore } from '../stores/threadPollStore';
import { useMessageStore } from '../stores/messageStore';

/**
 * Registers socket events for polls and threads:
 *
 * Poll events:
 * - poll-created, poll-vote-updated, poll-closed, poll-deleted, poll-updated
 *
 * Thread events:
 * - thread-created, thread-message, thread-archived, thread-deleted,
 *   thread-updated, thread-message-edited, thread-message-deleted
 *
 * The setMessages callback is kept for backwards compatibility but poll-deleted
 * now reads from the message store directly to avoid stale closures.
 */
export function useThreadPollSocketEvents(
  _setMessages: React.Dispatch<React.SetStateAction<Record<string, Message[]>>>,
): void {
  // Poll socket events
  useEffect(() => {
    socketService.onPollCreated((poll: Poll) => {
      const key = poll.channelId ?? poll.dmChannelId;
      if (!key) return;
      deferStoreUpdate(() => {
        useThreadPollStore.getState().setChannelPollsRaw((prev) => {
          const list = prev[key] ?? [];
          if (list.some((p) => p.id === poll.id)) return prev;
          return { ...prev, [key]: [...list, poll] };
        });
      });
    });
    socketService.onPollVoteUpdated((data) => {
      deferStoreUpdate(() => {
        useThreadPollStore.getState().setChannelPollsRaw((prev) => {
          const updated = { ...prev };
          for (const key of Object.keys(updated)) {
            updated[key] = updated[key].map((p) =>
              p.id === data.pollId
                ? {
                    ...p,
                    totalVotes: data.totalVotes,
                    options: p.options.map((opt) => {
                      const m = data.options.find((o: any) => o.id === opt.id);
                      return m ? { ...opt, voteCount: m.voteCount, emoji: m.emoji ?? opt.emoji } : opt;
                    }),
                  }
                : p
            );
          }
          return updated;
        });
      });
    });
    socketService.onPollClosed((data) => {
      deferStoreUpdate(() => {
        useThreadPollStore.getState().setChannelPollsRaw((prev) => {
          const updated = { ...prev };
          for (const key of Object.keys(updated)) {
            updated[key] = updated[key].map((p) => p.id === data.pollId ? { ...p, closedAt: new Date().toISOString() } : p);
          }
          return updated;
        });
      });
    });
    socketService.onPollDeleted((data) => {
      deferStoreUpdate(() => {
        useThreadPollStore.getState().setChannelPollsRaw((prev) => {
          const updated = { ...prev };
          for (const key of Object.keys(updated)) { updated[key] = updated[key].filter((p) => p.id !== data.pollId); }
          return updated;
        });
      });
      // Remove poll system messages from the message store directly (avoids stale closure on setMessages).
      const pollFilter = (m: Message) =>
        !(m.type === 'system' && (m.systemPayload as any)?.kind === 'poll' && (m.systemPayload as any)?.pollId === data.pollId);
      const msgState = useMessageStore.getState();
      // Channel messages
      const nextMessages = { ...msgState.messages };
      let channelChanged = false;
      for (const key of Object.keys(nextMessages)) {
        const filtered = nextMessages[key].filter(pollFilter);
        if (filtered.length !== nextMessages[key].length) {
          nextMessages[key] = filtered;
          channelChanged = true;
        }
      }
      // DM messages
      const nextDmMessages = { ...msgState.dmMessages };
      let dmChanged = false;
      for (const key of Object.keys(nextDmMessages)) {
        const filtered = nextDmMessages[key].filter(pollFilter);
        if (filtered.length !== nextDmMessages[key].length) {
          nextDmMessages[key] = filtered;
          dmChanged = true;
        }
      }
      if (channelChanged || dmChanged) {
        msgState._setAll({
          ...(channelChanged ? { messages: nextMessages } : {}),
          ...(dmChanged ? { dmMessages: nextDmMessages } : {}),
        });
      }
    });
    socketService.onPollUpdated((poll: Poll) => {
      const key = poll.channelId ?? poll.dmChannelId;
      if (!key) return;
      deferStoreUpdate(() => {
        useThreadPollStore.getState().setChannelPollsRaw((prev) => ({
          ...prev,
          [key]: (prev[key] ?? []).map((p) => p.id === poll.id ? poll : p),
        }));
      });
    });
    return () => { socketService.offPollCreated(); socketService.offPollVoteUpdated(); socketService.offPollClosed(); socketService.offPollDeleted(); socketService.offPollUpdated(); };
  }, []);

  // Thread socket events
  useEffect(() => {
    socketService.onThreadCreated((thread: Thread) => {
      deferStoreUpdate(() => {
        useThreadPollStore.getState().setChannelThreadsRaw((prev) => {
          const list = prev[thread.channelId] ?? [];
          if (list.some((t) => t.id === thread.id)) return prev;
          return { ...prev, [thread.channelId]: [...list, thread] };
        });
      });
    });
    socketService.onThreadMessage((msg: ThreadMessage) => {
      deferStoreUpdate(() => {
        useThreadPollStore.getState().setThreadMessagesRaw((prev) => {
          const list = prev[msg.threadId] ?? [];
          if (list.some((m) => m.id === msg.id)) return prev;
          return { ...prev, [msg.threadId]: [...list, msg] };
        });
        useThreadPollStore.getState().setActiveThread((current) => {
          if (current?.id !== msg.threadId) {
            useThreadPollStore.getState().setUnreadThreadIds((prev) => new Set([...prev, msg.threadId]));
            useThreadPollStore.getState().setUnreadThreadCounts((prev) => ({ ...prev, [msg.threadId]: (prev[msg.threadId] ?? 0) + 1 }));
          }
          return current;
        });
        useThreadPollStore.getState().setChannelThreadsRaw((prev) => {
          const updated = { ...prev };
          for (const key of Object.keys(updated)) {
            updated[key] = updated[key].map((t) => t.id === msg.threadId ? { ...t, lastActivityAt: msg.createdAt, messageCount: (t.messageCount ?? 0) + 1 } : t);
          }
          return updated;
        });
      });
    });
    socketService.onThreadArchived((data) => {
      deferStoreUpdate(() => {
        if (data.channelId) useThreadPollStore.getState().setChannelThreadsRaw((prev) => ({ ...prev, [data.channelId!]: (prev[data.channelId!] ?? []).filter((t) => t.id !== data.id) }));
        useThreadPollStore.getState().setActiveThread((current) => (current?.id === data.id ? null : current));
      });
    });
    socketService.onThreadDeleted((data) => {
      deferStoreUpdate(() => {
        if (data.channelId) useThreadPollStore.getState().setChannelThreadsRaw((prev) => ({ ...prev, [data.channelId]: (prev[data.channelId] ?? []).filter((t) => t.id !== data.threadId) }));
        useThreadPollStore.getState().setActiveThread((current) => (current?.id === data.threadId ? null : current));
      });
    });
    socketService.onThreadUpdated((data: Partial<Thread> & { id: string }) => {
      deferStoreUpdate(() => {
        if (data.channelId) {
          useThreadPollStore.getState().setChannelThreadsRaw((prev) => {
            const list = prev[data.channelId!];
            if (!list) return prev;
            return { ...prev, [data.channelId!]: list.map((t) => t.id === data.id ? { ...t, ...data } : t) };
          });
        }
        useThreadPollStore.getState().setActiveThread((current) => {
          if (current?.id !== data.id) return current;
          return { ...current, ...data };
        });
      });
    });
    socketService.onThreadMessageEdited((data: { id: string; threadId: string; content: string; editedAt: string }) => {
      deferStoreUpdate(() => {
        useThreadPollStore.getState().setThreadMessagesRaw((prev) => {
          const list = prev[data.threadId];
          if (!list) return prev;
          return { ...prev, [data.threadId]: list.map((m) => m.id === data.id ? { ...m, content: data.content, editedAt: data.editedAt } : m) };
        });
      });
    });
    socketService.onThreadMessageDeleted((data: { id: string; threadId: string }) => {
      deferStoreUpdate(() => {
        useThreadPollStore.getState().setThreadMessagesRaw((prev) => {
          const list = prev[data.threadId];
          if (!list) return prev;
          return { ...prev, [data.threadId]: list.filter((m) => m.id !== data.id) };
        });
        useThreadPollStore.getState().setChannelThreadsRaw((prev) => {
          const updated = { ...prev };
          for (const key of Object.keys(updated)) {
            updated[key] = updated[key].map((t) => t.id === data.threadId ? { ...t, messageCount: Math.max(0, (t.messageCount ?? 1) - 1) } : t);
          }
          return updated;
        });
      });
    });
    return () => { socketService.offThreadCreated(); socketService.offThreadMessage(); socketService.offThreadArchived(); socketService.offThreadDeleted(); socketService.offThreadUpdated(); socketService.offThreadMessageEdited(); socketService.offThreadMessageDeleted(); };
  }, []);
}
