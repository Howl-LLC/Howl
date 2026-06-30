// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { DropdownMulti } from '../../../components/ui/dropdown-multi';

const SEASONS = [
  { value: 's1', label: 'Season 1' },
  { value: 's2', label: 'Season 2' },
  { value: 's3', label: 'Season 3' },
];

const TRIGGER_ROLE = 'combobox';

describe('<DropdownMulti />', () => {
  it('renders placeholder when no values selected', () => {
    render(<DropdownMulti options={SEASONS} values={[]} onChange={() => {}} placeholder="All" />);
    expect(screen.getByRole(TRIGGER_ROLE)).toHaveTextContent('All');
  });

  it('renders the count when multiple values are selected', () => {
    render(<DropdownMulti options={SEASONS} values={['s1', 's3']} onChange={() => {}} />);
    expect(screen.getByRole(TRIGGER_ROLE)).toHaveTextContent('2 selected');
  });

  it('renders the single selected label when exactly one value is selected', () => {
    render(<DropdownMulti options={SEASONS} values={['s2']} onChange={() => {}} />);
    expect(screen.getByRole(TRIGGER_ROLE)).toHaveTextContent('Season 2');
  });

  it('panel has aria-multiselectable="true"', async () => {
    const user = userEvent.setup();
    render(<DropdownMulti options={SEASONS} values={[]} onChange={() => {}} />);
    screen.getByRole(TRIGGER_ROLE).focus();
    await user.click(screen.getByRole(TRIGGER_ROLE));
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true');
  });

  it('toggles a value on click and stays open', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DropdownMulti options={SEASONS} values={[]} onChange={onChange} />);
    screen.getByRole(TRIGGER_ROLE).focus();
    await user.click(screen.getByRole(TRIGGER_ROLE));
    await user.click(screen.getByRole('option', { name: /Season 1/ }));
    expect(onChange).toHaveBeenLastCalledWith(['s1']);
    // Panel stays open after selection.
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('removes a value when its option is clicked again', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DropdownMulti options={SEASONS} values={['s1', 's2']} onChange={onChange} />);
    screen.getByRole(TRIGGER_ROLE).focus();
    await user.click(screen.getByRole(TRIGGER_ROLE));
    await user.click(screen.getByRole('option', { name: /Season 2/ }));
    expect(onChange).toHaveBeenLastCalledWith(['s1']);
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<DropdownMulti options={SEASONS} values={[]} onChange={() => {}} />);
    screen.getByRole(TRIGGER_ROLE).focus();
    await user.click(screen.getByRole(TRIGGER_ROLE));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('aria-selected reflects current values', async () => {
    const user = userEvent.setup();
    render(<DropdownMulti options={SEASONS} values={['s1', 's3']} onChange={() => {}} />);
    screen.getByRole(TRIGGER_ROLE).focus();
    await user.click(screen.getByRole(TRIGGER_ROLE));
    const opts = screen.getAllByRole('option');
    expect(opts[0]).toHaveAttribute('aria-selected', 'true');
    expect(opts[1]).toHaveAttribute('aria-selected', 'false');
    expect(opts[2]).toHaveAttribute('aria-selected', 'true');
  });
});
