// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { UserProvider, useUser } from '../contexts/UserContext';
import type { User } from '../types';

const mockUser: User = {
  id: 'u1',
  username: 'testuser',
  discriminator: '0001',
  avatar: null,
  email: 'test@test.com',
  emailVerified: true,
  status: 'online',
  createdAt: new Date().toISOString(),
} as User;

describe('UserContext', () => {
  it('provides user data to consuming components', () => {
    function Consumer() {
      const { currentUser } = useUser();
      return <div>{currentUser?.username}</div>;
    }

    render(
      <UserProvider currentUser={mockUser} setCurrentUser={() => {}} displayUser={mockUser}>
        <Consumer />
      </UserProvider>,
    );

    expect(screen.getByText('testuser')).toBeInTheDocument();
  });

  it('throws when useUser is called outside UserProvider', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => {
      renderHook(() => useUser());
    }).toThrow('useUser must be used within a <UserProvider>');
    consoleSpy.mockRestore();
  });

  it('provides null when no user is logged in', () => {
    function Consumer() {
      const { currentUser } = useUser();
      return <div>{currentUser ? 'logged-in' : 'logged-out'}</div>;
    }

    render(
      <UserProvider currentUser={null} setCurrentUser={() => {}} displayUser={null}>
        <Consumer />
      </UserProvider>,
    );

    expect(screen.getByText('logged-out')).toBeInTheDocument();
  });
});
