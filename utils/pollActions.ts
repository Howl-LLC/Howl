// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Poll action utilities.
 * Extracted from App.tsx useCallback handlers for reuse outside React components.
 */
import { apiClient } from '../services/api';
import { useThreadPollStore } from '../stores/threadPollStore';
import { useMessageStore } from '../stores/messageStore';
import { useUiStore } from '../stores/uiStore';
import { isRealServerId } from './navigationHelpers';

// Create a poll

export async function createPoll(
  data: {
    question: string;
    options: (string | { text: string; emoji?: string })[];
    allowMultiple: boolean;
    anonymous: boolean;
    duration: string;
  },
  context: {
    activeServerId?: string | null;
    activeChannelId?: string | null;
    activeDmChannelId?: string | null;
  },
): Promise<void> {
  const { activeServerId, activeChannelId, activeDmChannelId } = context;
  if (activeDmChannelId) {
    const poll = await apiClient.createDmPoll(activeDmChannelId, data);
    if (poll) {
      useThreadPollStore.getState().setChannelPollsRaw((prev) => ({
        ...prev,
        [activeDmChannelId]: [...(prev[activeDmChannelId] ?? []), poll],
      }));
    }
  } else if (isRealServerId(activeServerId) && activeChannelId) {
    const poll = await apiClient.createPoll(activeChannelId, activeServerId, data);
    if (poll) {
      useThreadPollStore.getState().setChannelPollsRaw((prev) => ({
        ...prev,
        [activeChannelId]: [...(prev[activeChannelId] ?? []), poll],
      }));
    }
  }
  useUiStore.getState().setPollModalOpen(false);
}

// Vote on a poll (optimistic)

export async function votePoll(
  pollId: string,
  optionId: string,
  context: {
    activeServerId?: string | null;
    activeChannelId?: string | null;
    activeDmChannelId?: string | null;
  },
): Promise<void> {
  const { activeServerId, activeChannelId, activeDmChannelId } = context;
  const channelKey = activeDmChannelId || activeChannelId;

  // Optimistic update
  if (channelKey) {
    useThreadPollStore.getState().setChannelPollsRaw((prev) => {
      const polls = prev[channelKey];
      if (!polls) return prev;
      return {
        ...prev,
        [channelKey]: polls.map((p) => {
          if (p.id !== pollId) return p;
          const wasVotedForThis = p.myVotes?.includes(optionId);
          if (wasVotedForThis) return p;
          let newMyVotes = [...(p.myVotes ?? [])];
          if (!p.allowMultiple) {
            const oldOptionId = newMyVotes[0];
            const updatedOptions = p.options.map((o) => {
              if (o.id === oldOptionId) return { ...o, voteCount: Math.max(0, o.voteCount - 1) };
              if (o.id === optionId) return { ...o, voteCount: o.voteCount + 1 };
              return o;
            });
            newMyVotes = [optionId];
            return {
              ...p,
              myVotes: newMyVotes,
              options: updatedOptions,
              totalVotes: oldOptionId ? p.totalVotes : p.totalVotes + 1,
            };
          }
          newMyVotes.push(optionId);
          return {
            ...p,
            myVotes: newMyVotes,
            options: p.options.map((o) =>
              o.id === optionId ? { ...o, voteCount: o.voteCount + 1 } : o,
            ),
            totalVotes: p.totalVotes + 1,
          };
        }),
      };
    });
  }

  try {
    if (activeDmChannelId) {
      await apiClient.voteDmPoll(pollId, optionId, activeDmChannelId);
    } else if (isRealServerId(activeServerId) && activeChannelId) {
      await apiClient.votePoll(pollId, optionId, activeServerId, activeChannelId);
    }
  } catch {
    // Revert: re-fetch polls
    if (channelKey) {
      try {
        const polls = activeDmChannelId
          ? await apiClient.getDmPolls(activeDmChannelId)
          : await apiClient.getPolls(activeChannelId!, activeServerId!);
        useThreadPollStore.getState().setChannelPollsRaw((prev) => ({
          ...prev,
          [channelKey]: polls,
        }));
      } catch {
        /* silent */
      }
    }
  }
}

// Remove a vote from a poll (optimistic)

export async function removeVotePoll(
  pollId: string,
  optionId: string,
  context: {
    activeServerId?: string | null;
    activeChannelId?: string | null;
    activeDmChannelId?: string | null;
  },
): Promise<void> {
  const { activeServerId, activeChannelId, activeDmChannelId } = context;
  const channelKey = activeDmChannelId || activeChannelId;

  // Optimistic update
  if (channelKey) {
    useThreadPollStore.getState().setChannelPollsRaw((prev) => {
      const polls = prev[channelKey];
      if (!polls) return prev;
      return {
        ...prev,
        [channelKey]: polls.map((p) => {
          if (p.id !== pollId) return p;
          const wasVoted = p.myVotes?.includes(optionId);
          if (!wasVoted) return p;
          return {
            ...p,
            myVotes: (p.myVotes ?? []).filter((v) => v !== optionId),
            options: p.options.map((o) =>
              o.id === optionId ? { ...o, voteCount: Math.max(0, o.voteCount - 1) } : o,
            ),
            totalVotes: Math.max(0, p.totalVotes - 1),
          };
        }),
      };
    });
  }

  try {
    if (activeDmChannelId) {
      await apiClient.removeVoteDmPoll(pollId, optionId, activeDmChannelId);
    } else if (isRealServerId(activeServerId) && activeChannelId) {
      await apiClient.removeVotePoll(pollId, optionId, activeServerId, activeChannelId);
    }
  } catch {
    // Revert: re-fetch polls
    if (channelKey) {
      try {
        const polls = activeDmChannelId
          ? await apiClient.getDmPolls(activeDmChannelId)
          : await apiClient.getPolls(activeChannelId!, activeServerId!);
        useThreadPollStore.getState().setChannelPollsRaw((prev) => ({
          ...prev,
          [channelKey]: polls,
        }));
      } catch {
        /* silent */
      }
    }
  }
}

// Close a poll (optimistic)

export async function closePoll(
  pollId: string,
  context: {
    activeServerId?: string | null;
    activeChannelId?: string | null;
    activeDmChannelId?: string | null;
  },
): Promise<void> {
  const { activeServerId, activeChannelId, activeDmChannelId } = context;

  // Optimistic close
  useThreadPollStore.getState().setChannelPollsRaw((prev) => {
    const updated = { ...prev };
    for (const key of Object.keys(updated)) {
      updated[key] = updated[key].map((p) =>
        p.id === pollId ? { ...p, closedAt: new Date().toISOString() } : p,
      );
    }
    return updated;
  });

  try {
    if (activeDmChannelId) {
      await apiClient.editDmPoll(pollId, { closePoll: true }, activeDmChannelId);
    } else if (isRealServerId(activeServerId) && activeChannelId) {
      await apiClient.editPoll(pollId, { closePoll: true }, activeServerId, activeChannelId);
    }
  } catch {
    // Revert: set closedAt back to null
    useThreadPollStore.getState().setChannelPollsRaw((prev) => {
      const updated = { ...prev };
      for (const key of Object.keys(updated)) {
        updated[key] = updated[key].map((p) =>
          p.id === pollId ? { ...p, closedAt: null } : p,
        );
      }
      return updated;
    });
  }
}

// Delete a poll (optimistic)

export async function deletePoll(
  pollId: string,
  context: {
    activeServerId?: string | null;
    activeChannelId?: string | null;
    activeDmChannelId?: string | null;
  },
): Promise<void> {
  const { activeServerId, activeChannelId, activeDmChannelId } = context;

  // Optimistically remove poll from state
  useThreadPollStore.getState().setChannelPollsRaw((prev) => {
    const updated = { ...prev };
    for (const key of Object.keys(updated)) {
      updated[key] = updated[key].filter((p) => p.id !== pollId);
    }
    return updated;
  });

  // Remove the system message that referenced this poll
  const msgKey = activeDmChannelId || activeChannelId;
  if (msgKey) {
    const pollSystemFilter = (m: any) =>
      !(
        m.type === 'system' &&
        (m.systemPayload as any)?.kind === 'poll' &&
        (m.systemPayload as any)?.pollId === pollId
      );
    if (activeDmChannelId) {
      const { dmMessages } = useMessageStore.getState();
      const list = dmMessages[msgKey];
      if (list) {
        const filtered = list.filter(pollSystemFilter);
        if (filtered.length !== list.length) {
          useMessageStore.getState()._setAll({
            dmMessages: { ...useMessageStore.getState().dmMessages, [msgKey]: filtered },
          });
        }
      }
    } else {
      const { messages } = useMessageStore.getState();
      const list = messages[msgKey];
      if (list) {
        const filtered = list.filter(pollSystemFilter);
        if (filtered.length !== list.length) {
          useMessageStore.getState()._setAll({
            messages: { ...useMessageStore.getState().messages, [msgKey]: filtered },
          });
        }
      }
    }
  }

  try {
    if (activeDmChannelId) {
      await apiClient.deleteDmPoll(pollId, activeDmChannelId);
    } else if (isRealServerId(activeServerId) && activeChannelId) {
      await apiClient.deletePoll(pollId, activeServerId, activeChannelId);
    }
  } catch {
    // Revert: re-fetch polls
    if (activeDmChannelId) {
      apiClient
        .getDmPolls(activeDmChannelId)
        .then((polls) => {
          useThreadPollStore.getState().setChannelPollsRaw((prev) => ({
            ...prev,
            [activeDmChannelId]: polls,
          }));
        })
        .catch(() => {});
    } else if (isRealServerId(activeServerId) && activeChannelId) {
      apiClient
        .getPolls(activeChannelId, activeServerId)
        .then((polls) => {
          useThreadPollStore.getState().setChannelPollsRaw((prev) => ({
            ...prev,
            [activeChannelId]: polls,
          }));
        })
        .catch(() => {});
    }
  }
}
