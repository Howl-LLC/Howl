// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AutoAssignRoles } from '../components/serverSettings/SelfRolesSection';
import type { Server } from '../types';

// t() resolves to defaultValue when present, else the key (mirrors RolesSectionHiddenToggle.test).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string } | string) =>
      (typeof o === 'object' && o?.defaultValue) || k,
  }),
}));

// No socket in test env.
vi.mock('../services/socket', () => ({
  socketService: { getSocket: () => null },
}));

// apiClient mock — getServerRoles + auto-roles GET/SET.
const getServerRoles = vi.fn();
const autoRolesGet = vi.fn();
const autoRolesSet = vi.fn();
vi.mock('../services/api', () => ({
  apiClient: {
    getServerRoles: (...a: unknown[]) => getServerRoles(...a),
    autoRolesGet: (...a: unknown[]) => autoRolesGet(...a),
    autoRolesSet: (...a: unknown[]) => autoRolesSet(...a),
    roleClaimRequestsList: vi.fn().mockResolvedValue({ requests: [] }),
  },
}));

const server = { id: 's1', name: 'Test' } as unknown as Server;

type ApiRole = {
  id: string; name: string; color: string; style: string; position: number;
  locked: boolean; isEveryone?: boolean; permissions: Record<string, boolean>;
  displaySeparately: boolean; allowMention: boolean; hidden?: boolean; memberCount: number;
};

function role(over: Partial<ApiRole>): ApiRole {
  return {
    id: 'r1', name: 'Role', color: '#5865f2', style: 'solid', position: 1,
    locked: false, isEveryone: false, permissions: {}, displaySeparately: false,
    allowMention: false, hidden: false, memberCount: 0, ...over,
  };
}

// 6 assignable roles — exceeds the cap of 5 so we can exercise the disabled state.
const SIX_ROLES: ApiRole[] = [
  role({ id: 'a', name: 'Alpha', position: 1 }),
  role({ id: 'b', name: 'Bravo', position: 2 }),
  role({ id: 'c', name: 'Charlie', position: 3 }),
  role({ id: 'd', name: 'Delta', position: 4 }),
  role({ id: 'e', name: 'Echo', position: 5 }),
  role({ id: 'f', name: 'Foxtrot', position: 6 }),
];

// Each role renders as a row carrying a checkbox / toggle. Find the control by row label.
function controlFor(name: string): HTMLInputElement {
  const labelEl = screen.getByText(name);
  const row = labelEl.closest('[data-autorole-row]') as HTMLElement | null;
  if (!row) throw new Error(`auto-role row for "${name}" not found`);
  return row.querySelector('input[type="checkbox"]') as HTMLInputElement;
}

describe('AutoAssignRoles — auto-assigned roles multi-select', () => {
  beforeEach(() => {
    getServerRoles.mockReset();
    autoRolesGet.mockReset();
    autoRolesSet.mockReset();
    getServerRoles.mockResolvedValue(SIX_ROLES);
    autoRolesSet.mockImplementation(async (_s: string, ids: string[]) => ({ roleIds: ids }));
  });

  it('lists all six assignable roles', async () => {
    autoRolesGet.mockResolvedValue({ roleIds: [] });
    render(<AutoAssignRoles server={server} showToast={() => {}} />);
    for (const r of SIX_ROLES) {
      expect(await screen.findByText(r.name)).toBeTruthy();
    }
  });

  it('disables unselected roles and shows the cap copy once 5 are selected', async () => {
    // Five already selected; the sixth must be disabled.
    autoRolesGet.mockResolvedValue({ roleIds: ['a', 'b', 'c', 'd', 'e'] });
    render(<AutoAssignRoles server={server} showToast={() => {}} />);

    await waitFor(() => expect(controlFor('Echo').checked).toBe(true));

    const sixth = controlFor('Foxtrot');
    expect(sixth.checked).toBe(false);
    expect(sixth.disabled).toBe(true);

    // Cap helper copy is shown.
    expect(screen.getByText('Maximum 5 reached')).toBeTruthy();
  });

  it('persists a deselection via autoRolesSet', async () => {
    autoRolesGet.mockResolvedValue({ roleIds: ['a', 'b', 'c', 'd', 'e'] });
    render(<AutoAssignRoles server={server} showToast={() => {}} />);

    await waitFor(() => expect(controlFor('Alpha').checked).toBe(true));

    fireEvent.click(controlFor('Alpha'));

    await waitFor(() => expect(autoRolesSet).toHaveBeenCalled());
    const lastCall = autoRolesSet.mock.calls[autoRolesSet.mock.calls.length - 1];
    expect(lastCall[0]).toBe('s1');
    expect(lastCall[1].sort()).toEqual(['b', 'c', 'd', 'e']);
  });
});
