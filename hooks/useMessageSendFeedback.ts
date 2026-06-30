// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useCallback, useEffect, useRef } from 'react';

/**
 * Manages the transient "sending too fast" rate-limit banner and the
 * automod / content-filter / slow-mode error banner.  Both auto-dismiss
 * after a timeout and clean up on unmount.
 */
export function useMessageSendFeedback() {
  /** When true, show "sending too fast" banner above message input. Clears after 10 s. */
  const [messageRateLimitActive, setMessageRateLimitActive] = useState(false);
  const messageRateLimitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activateMessageRateLimitBanner = useCallback(() => {
    if (messageRateLimitTimeoutRef.current) clearTimeout(messageRateLimitTimeoutRef.current);
    setMessageRateLimitActive(true);
    messageRateLimitTimeoutRef.current = setTimeout(() => {
      setMessageRateLimitActive(false);
      messageRateLimitTimeoutRef.current = null;
    }, 10_000);
  }, []);

  /** Transient error message from automod / content filter / slow mode. Clears after 8 s. */
  const [messageSendError, setMessageSendError] = useState<string | null>(null);
  const messageSendErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showMessageSendError = useCallback((msg: string) => {
    if (messageSendErrorTimeoutRef.current) clearTimeout(messageSendErrorTimeoutRef.current);
    setMessageSendError(msg);
    messageSendErrorTimeoutRef.current = setTimeout(() => {
      setMessageSendError(null);
      messageSendErrorTimeoutRef.current = null;
    }, 8_000);
  }, []);

  // Cleanup timers on unmount
  useEffect(() => () => {
    if (messageRateLimitTimeoutRef.current) clearTimeout(messageRateLimitTimeoutRef.current);
    if (messageSendErrorTimeoutRef.current) clearTimeout(messageSendErrorTimeoutRef.current);
  }, []);

  return {
    messageRateLimitActive,
    messageSendError,
    activateMessageRateLimitBanner,
    showMessageSendError,
  };
}
