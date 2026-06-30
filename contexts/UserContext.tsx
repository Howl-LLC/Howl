// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { User } from '../types';

export interface UserContextValue {
  currentUser: User | null;
  setCurrentUser: (user: User | null) => void;
  /** Resolved display user — may include server-specific profile overrides. */
  displayUser: User | null;
}

export const UserContext = createContext<UserContextValue | null>(null);

interface UserProviderProps {
  currentUser: User | null;
  setCurrentUser: (user: User | null) => void;
  displayUser: User | null;
  children: ReactNode;
}

export function UserProvider({
  currentUser,
  setCurrentUser,
  displayUser,
  children,
}: UserProviderProps) {
  const value = useMemo(
    () => ({ currentUser, setCurrentUser, displayUser }),
    [currentUser, setCurrentUser, displayUser],
  );
  return (
    <UserContext.Provider value={value}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser(): UserContextValue {
  const ctx = useContext(UserContext);
  if (!ctx) {
    throw new Error('useUser must be used within a <UserProvider>');
  }
  return ctx;
}
