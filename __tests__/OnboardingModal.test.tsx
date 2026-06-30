// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OnboardingModal } from '../components/server/OnboardingModal';
import type { RolePickerTree, RolePickerEntry, RolePickerCategory } from '../services/api/rolePickers';

// t() resolves to defaultValue when present, else the key (mirrors AutoRoles.test).
// Stable identity so loadTree's useCallback dep doesn't change every render.
const tFn = (k: string, o?: { defaultValue?: string } | string) =>
  (typeof o === 'object' && o?.defaultValue) || k;
const i18nCtx = { t: tFn };
vi.mock('react-i18next', () => ({
  useTranslation: () => i18nCtx,
}));

// Toast is a no-op in tests. Stable identities so loadTree's useCallback dep
// doesn't change every render (which would re-fire the load effect).
const noopToast = { showGlobalToast: () => {}, globalToast: null, dismissToast: () => {} };
vi.mock('../hooks/useGlobalToast', () => ({
  useGlobalToast: () => noopToast,
}));

// apiClient mock — picker list/get + claim + onboardingComplete.
const rolePickersList = vi.fn();
const rolePickerGet = vi.fn();
const rolePickerEntryClaim = vi.fn();
const rolePickerEntryRelease = vi.fn();
const onboardingComplete = vi.fn();
vi.mock('../services/api', () => ({
  apiClient: {
    rolePickersList: (...a: unknown[]) => rolePickersList(...a),
    rolePickerGet: (...a: unknown[]) => rolePickerGet(...a),
    rolePickerEntryClaim: (...a: unknown[]) => rolePickerEntryClaim(...a),
    rolePickerEntryRelease: (...a: unknown[]) => rolePickerEntryRelease(...a),
    onboardingComplete: (...a: unknown[]) => onboardingComplete(...a),
  },
}));

// Spy on the store's close so case 2 can assert dismissal without mounting AppLayout.
import { useCommunityStore } from '../stores/communityStore';

const SERVER_ID = 's1';

function entry(over: Partial<RolePickerEntry>): RolePickerEntry {
  return {
    id: 'e1',
    roleId: 'r1',
    position: 0,
    emoji: null,
    iconUrl: null,
    description: null,
    requirements: null,
    memberCount: 0,
    held: false,
    pending: false,
    role: { id: 'r1', name: 'Role', color: '#5865f2', position: 1, selfAssignable: true, displaySeparately: false, locked: false },
    ...over,
  };
}

function category(over: Partial<RolePickerCategory>): RolePickerCategory {
  return { id: 'c1', name: 'Category', position: 0, pickMode: 'multi', required: false, entries: [], ...over };
}

function tree(over: Partial<RolePickerTree>): RolePickerTree {
  return {
    id: 'p1',
    channelId: 'ch1',
    serverId: SERVER_ID,
    heroTitle: null,
    heroDescription: null,
    selfRolesBlocked: false,
    categories: [],
    ...over,
  };
}

function mockTree(t: RolePickerTree) {
  rolePickersList.mockResolvedValue({ picker: { id: t.id, channelId: t.channelId, serverId: SERVER_ID, heroTitle: null, heroDescription: null } });
  rolePickerGet.mockResolvedValue(t);
}

function continueBtn(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
}

describe('OnboardingModal — mandatory onboarding with required-gate', () => {
  beforeEach(() => {
    rolePickersList.mockReset();
    rolePickerGet.mockReset();
    rolePickerEntryClaim.mockReset();
    rolePickerEntryRelease.mockReset();
    onboardingComplete.mockReset();
    rolePickerEntryClaim.mockResolvedValue({ ok: true, status: 'granted' });
    onboardingComplete.mockResolvedValue({ onboardingCompletedAt: '2026-06-20T00:00:00.000Z' });
    useCommunityStore.setState({ activeOnboardingServerId: SERVER_ID, shownOnboardingThisSession: new Set() });
  });

  it('case 1: one required category with no pick → Continue disabled; no Skip button', async () => {
    mockTree(tree({
      categories: [category({ id: 'c1', name: 'Pick A Team', required: true, entries: [entry({ id: 'e1', role: { id: 'r1', name: 'Alpha', color: '#fff', position: 1, selfAssignable: true, displaySeparately: false, locked: false } })] })],
    }));
    render(<OnboardingModal serverId={SERVER_ID} />);

    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());

    expect(continueBtn().disabled).toBe(true);
    // No Skip / dismiss affordance — mandatory.
    expect(screen.queryByRole('button', { name: /skip/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
  });

  it('case 2: after a pick (held===true on refetch) → Continue enabled; clicking completes + dismisses', async () => {
    const unheld = tree({
      categories: [category({ id: 'c1', name: 'Teams', required: true, entries: [entry({ id: 'e1', role: { id: 'r1', name: 'Alpha', color: '#fff', position: 1, selfAssignable: true, displaySeparately: false, locked: false } })] })],
    });
    const held = tree({
      categories: [category({ id: 'c1', name: 'Teams', required: true, entries: [entry({ id: 'e1', held: true, role: { id: 'r1', name: 'Alpha', color: '#fff', position: 1, selfAssignable: true, displaySeparately: false, locked: false } })] })],
    });
    // First load → unheld; after claim, loadTree refetches → held.
    rolePickersList.mockResolvedValue({ picker: { id: 'p1', channelId: 'ch1', serverId: SERVER_ID, heroTitle: null, heroDescription: null } });
    rolePickerGet.mockResolvedValueOnce(unheld).mockResolvedValue(held);

    render(<OnboardingModal serverId={SERVER_ID} />);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(continueBtn().disabled).toBe(true);

    fireEvent.click(screen.getByText('Alpha'));
    await waitFor(() => expect(rolePickerEntryClaim).toHaveBeenCalledWith(SERVER_ID, 'p1', 'e1'));
    await waitFor(() => expect(continueBtn().disabled).toBe(false));

    fireEvent.click(continueBtn());
    await waitFor(() => expect(onboardingComplete).toHaveBeenCalledWith(SERVER_ID));
    await waitFor(() => expect(useCommunityStore.getState().activeOnboardingServerId).toBeNull());
  });

  it('case 3: selfRolesBlocked with unsatisfied required category → Continue enabled (reconciliation)', async () => {
    mockTree(tree({
      selfRolesBlocked: true,
      categories: [category({ id: 'c1', name: 'Teams', required: true, entries: [entry({ id: 'e1', held: false, role: { id: 'r1', name: 'Alpha', color: '#fff', position: 1, selfAssignable: true, displaySeparately: false, locked: false } })] })],
    }));
    render(<OnboardingModal serverId={SERVER_ID} />);

    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(continueBtn().disabled).toBe(false);
  });

  it('case 5: required category with ONLY a manual-approval entry → requesting it (pending on refetch) enables Continue', async () => {
    // The trap: a required category whose only entry is manual-approval never
    // grants `held` (the server returns 202/pending_approval), so a held-only
    // gate would lock the member out forever. The fix counts pending too.
    const before = tree({
      categories: [category({
        id: 'c1', name: 'Membership', required: true, entries: [
          entry({ id: 'e1', held: false, pending: false, requirements: { manualApproval: true }, role: { id: 'r1', name: 'Verified', color: '#fff', position: 1, selfAssignable: true, displaySeparately: false, locked: false } }),
        ],
      })],
    });
    const after = tree({
      categories: [category({
        id: 'c1', name: 'Membership', required: true, entries: [
          entry({ id: 'e1', held: false, pending: true, requirements: { manualApproval: true }, role: { id: 'r1', name: 'Verified', color: '#fff', position: 1, selfAssignable: true, displaySeparately: false, locked: false } }),
        ],
      })],
    });
    // First load → not-requested; after the claim, loadTree refetches → pending.
    rolePickersList.mockResolvedValue({ picker: { id: 'p1', channelId: 'ch1', serverId: SERVER_ID, heroTitle: null, heroDescription: null } });
    rolePickerGet.mockResolvedValueOnce(before).mockResolvedValue(after);
    rolePickerEntryClaim.mockResolvedValue({ ok: true, status: 'pending_approval', requestId: 'req1' });

    render(<OnboardingModal serverId={SERVER_ID} />);
    await waitFor(() => expect(screen.getByText('Verified')).toBeTruthy());
    // Initially trapped under old held-only logic — Continue must be disabled.
    expect(continueBtn().disabled).toBe(true);

    fireEvent.click(screen.getByText('Verified'));
    await waitFor(() => expect(rolePickerEntryClaim).toHaveBeenCalledWith(SERVER_ID, 'p1', 'e1'));
    // After the pending refetch, the required-gate is satisfied by pending.
    await waitFor(() => expect(screen.getByText('Pending')).toBeTruthy());
    await waitFor(() => expect(continueBtn().disabled).toBe(false));

    fireEvent.click(continueBtn());
    await waitFor(() => expect(onboardingComplete).toHaveBeenCalledWith(SERVER_ID));
  });

  it('case 6: required category with ZERO entries (all hidden, stripped for non-mod) → Continue enabled (not trapped)', async () => {
    // After hidden entries are stripped, a required category whose entries were
    // all hidden becomes EMPTY for a non-mod. A held-only/some() gate over [] is
    // false, which would trap them in the non-dismissible modal. An empty
    // required category must count as satisfied.
    mockTree(tree({
      categories: [
        category({ id: 'c1', name: 'Staff (hidden, now empty)', required: true, entries: [] }),
        category({ id: 'c2', name: 'Optional', required: false, entries: [
          entry({ id: 'e2', role: { id: 'r2', name: 'Optional Role', color: '#fff', position: 1, selfAssignable: true, displaySeparately: false, locked: false } }),
        ] }),
      ],
    }));
    render(<OnboardingModal serverId={SERVER_ID} />);

    await waitFor(() => expect(screen.getByText('Optional Role')).toBeTruthy());
    expect(continueBtn().disabled).toBe(false);
  });

  it('case 4: renders only the entries present in the (already hidden-stripped) tree', async () => {
    mockTree(tree({
      categories: [category({
        id: 'c1', name: 'Visible', required: false, entries: [
          entry({ id: 'e1', role: { id: 'r1', name: 'VisibleRole', color: '#fff', position: 1, selfAssignable: true, displaySeparately: false, locked: false } }),
        ],
      })],
    }));
    render(<OnboardingModal serverId={SERVER_ID} />);

    await waitFor(() => expect(screen.getByText('VisibleRole')).toBeTruthy());
    // The tree is the source of truth — a role not in the tree is never invented.
    expect(screen.queryByText('HiddenRole')).toBeNull();
  });
});
