// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { RolesSection } from '../components/serverSettings/RolesSection';
import type { ServerRoleFromAPI } from '../types/server';
import type { Server } from '../types';

// t() in RolesSection is called as t(key, { defaultValue }) for the new copy
// and as t(key) elsewhere — resolve to defaultValue when present, else the key.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string } | string) =>
      (typeof o === 'object' && o?.defaultValue) || k,
  }),
}));

// No real socket in the test env: the live-sync effect calls getSocket() and
// early-returns on null. Stub the module so we don't pull in the socket stack.
vi.mock('../services/socket', () => ({
  socketService: { getSocket: () => null },
}));

// RolesSection imports apiClient only for reorder; never hit in this test.
vi.mock('../services/api', () => ({ apiClient: { reorderServerRoles: vi.fn() } }));

const server = { id: 's1', name: 'Test' } as unknown as Server;

function apiRole(over: Partial<ServerRoleFromAPI>): ServerRoleFromAPI {
  return {
    id: 'r1', name: 'Moderator', color: '#5865f2', style: 'solid', position: 1,
    locked: false, isEveryone: false, permissions: {}, displaySeparately: false,
    allowMention: false, selfAssignable: false, hidden: false, blocksSelfRoles: false, memberCount: 0,
    ...over,
  };
}

function renderSection(roles: ServerRoleFromAPI[], onUpdateRole = vi.fn().mockResolvedValue(undefined)) {
  const getServerRoles = vi.fn().mockResolvedValue(roles);
  render(
    <RolesSection
      server={server}
      localMembers={[]}
      setLocalMembers={() => {}}
      showToast={() => {}}
      getServerRoles={getServerRoles}
      onUpdateRole={onUpdateRole}
    />,
  );
  return { getServerRoles, onUpdateRole };
}

// Find the Toggle (role="switch") inside the SettingRow carrying the given title.
function switchForRow(title: string): HTMLElement {
  const row = screen.getByText(title).closest('div.flex.items-center.justify-between');
  if (!row) throw new Error(`SettingRow for "${title}" not found`);
  return within(row as HTMLElement).getByRole('switch');
}

async function openRole(name: string) {
  const roleRow = await screen.findByText(name);
  fireEvent.click(roleRow);
}

describe('RolesSection — Hidden toggle', () => {
  beforeEach(() => { localStorage.clear(); });

  it('renders the Hidden toggle for a non-everyone role and reflects hidden=true', async () => {
    renderSection([apiRole({ id: 'r1', name: 'Moderator', hidden: true })]);
    await openRole('Moderator');

    const hiddenSwitch = switchForRow('Hidden role');
    expect(hiddenSwitch).toHaveAttribute('aria-checked', 'true');
  });

  it('round-trips a Hidden change into the save payload', async () => {
    const onUpdateRole = vi.fn().mockResolvedValue(undefined);
    const getServerRoles = vi.fn().mockResolvedValue([apiRole({ id: 'r1', name: 'Moderator', hidden: false })]);
    render(
      <RolesSection
        server={server}
        localMembers={[]}
        setLocalMembers={() => {}}
        showToast={() => {}}
        getServerRoles={getServerRoles}
        onUpdateRole={onUpdateRole}
      />,
    );
    await openRole('Moderator');

    const hiddenSwitch = switchForRow('Hidden role');
    expect(hiddenSwitch).toHaveAttribute('aria-checked', 'false');

    // Turn Hidden on, then save.
    fireEvent.click(hiddenSwitch);
    expect(hiddenSwitch).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByText('serverSettings.saveChanges'));

    await waitFor(() => expect(onUpdateRole).toHaveBeenCalled());
    const payload = onUpdateRole.mock.calls[0][2];
    expect(payload).toMatchObject({ hidden: true });
  });

  it('does not render the Hidden toggle for the @everyone role', async () => {
    renderSection([apiRole({ id: 'everyone', name: 'everyone', isEveryone: true })]);
    await openRole('everyone');

    // @everyone opens straight to the Permissions tab; the display-only Hidden
    // row must never appear for it.
    expect(screen.queryByText('Hidden role')).toBeNull();
  });
});

describe('RolesSection — Block self-roles toggle', () => {
  beforeEach(() => { localStorage.clear(); });

  it('renders the Block self-roles toggle for a non-everyone role and reflects blocksSelfRoles=true', async () => {
    renderSection([apiRole({ id: 'r1', name: 'Moderator', blocksSelfRoles: true })]);
    await openRole('Moderator');

    const blockSwitch = switchForRow('Block self-roles');
    expect(blockSwitch).toHaveAttribute('aria-checked', 'true');
  });

  it('round-trips a Block self-roles change into the save payload', async () => {
    const onUpdateRole = vi.fn().mockResolvedValue(undefined);
    const getServerRoles = vi.fn().mockResolvedValue([apiRole({ id: 'r1', name: 'Moderator', blocksSelfRoles: false })]);
    render(
      <RolesSection
        server={server}
        localMembers={[]}
        setLocalMembers={() => {}}
        showToast={() => {}}
        getServerRoles={getServerRoles}
        onUpdateRole={onUpdateRole}
      />,
    );
    await openRole('Moderator');

    const blockSwitch = switchForRow('Block self-roles');
    expect(blockSwitch).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(blockSwitch);
    expect(blockSwitch).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByText('serverSettings.saveChanges'));

    await waitFor(() => expect(onUpdateRole).toHaveBeenCalled());
    const payload = onUpdateRole.mock.calls[0][2];
    expect(payload).toMatchObject({ blocksSelfRoles: true });
  });

  it('does not render the Block self-roles toggle for the @everyone role', async () => {
    renderSection([apiRole({ id: 'everyone', name: 'everyone', isEveryone: true })]);
    await openRole('everyone');

    expect(screen.queryByText('Block self-roles')).toBeNull();
  });
});
