// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Dropdown } from '../../../components/ui/dropdown';

const BASIC_OPTIONS = [
  { value: 'a', label: 'Apple' },
  { value: 'b', label: 'Banana' },
  { value: 'c', label: 'Cherry' },
];

// Floating UI's useRole({ role: 'listbox' }) assigns role="combobox" to the
// reference (trigger) element, so we query for 'combobox' throughout.
const TRIGGER_ROLE = 'combobox';

describe('<Dropdown /> — basic render + open/close', () => {
  it('renders the placeholder when no value is selected', () => {
    render(<Dropdown options={BASIC_OPTIONS} value={null} onChange={() => {}} placeholder="Pick one" />);
    expect(screen.getByRole(TRIGGER_ROLE)).toHaveTextContent('Pick one');
  });

  it('renders the selected option label', () => {
    render(<Dropdown options={BASIC_OPTIONS} value="b" onChange={() => {}} />);
    expect(screen.getByRole(TRIGGER_ROLE)).toHaveTextContent('Banana');
  });

  it('opens the listbox on click and shows all options', async () => {
    const user = userEvent.setup();
    render(<Dropdown options={BASIC_OPTIONS} value={null} onChange={() => {}} />);
    await user.click(screen.getByRole(TRIGGER_ROLE));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('closes the listbox on Escape', async () => {
    const user = userEvent.setup();
    render(<Dropdown options={BASIC_OPTIONS} value={null} onChange={() => {}} />);
    await user.click(screen.getByRole(TRIGGER_ROLE));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('sets aria-expanded correctly', async () => {
    const user = userEvent.setup();
    render(<Dropdown options={BASIC_OPTIONS} value={null} onChange={() => {}} />);
    const trigger = screen.getByRole(TRIGGER_ROLE);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });
});

// Helper: focus the trigger before clicking so keyboard events route correctly
// in jsdom. Floating UI's useClick({ event: 'mousedown' }) opens the panel on
// mousedown, but jsdom doesn't always move focus to the button on pointer events
// the way a real browser does. Explicitly focusing first mirrors real behavior.
async function openWithKeyboard(user: ReturnType<typeof userEvent.setup>) {
  await user.tab();                    // focus the combobox trigger
  await user.keyboard('{ArrowDown}');  // open + focus first item
}

describe('<Dropdown /> — keyboard navigation + selection', () => {
  it('navigates options with ArrowDown/ArrowUp', async () => {
    const user = userEvent.setup();
    render(<Dropdown options={BASIC_OPTIONS} value={null} onChange={() => {}} />);

    // ArrowDown on a focused trigger opens the panel and activates the first item
    await openWithKeyboard(user);
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('tabindex', '0');

    await user.keyboard('{ArrowDown}');
    expect(options[1]).toHaveAttribute('tabindex', '0');

    await user.keyboard('{ArrowUp}');
    expect(options[0]).toHaveAttribute('tabindex', '0');
  });

  it('selects an option on click and closes', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Dropdown options={BASIC_OPTIONS} value={null} onChange={onChange} />);
    screen.getByRole(TRIGGER_ROLE).focus();
    await user.click(screen.getByRole(TRIGGER_ROLE));
    await user.click(screen.getByRole('option', { name: 'Banana' }));
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('selects the active option on Enter and closes', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Dropdown options={BASIC_OPTIONS} value={null} onChange={onChange} />);

    // Open via keyboard: ArrowDown opens + focuses first item, second ArrowDown
    // moves to item[1] (Banana, value='b'), Enter selects it.
    await openWithKeyboard(user);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('type-ahead jumps to first matching option', async () => {
    const user = userEvent.setup();
    render(<Dropdown options={BASIC_OPTIONS} value={null} onChange={() => {}} />);
    screen.getByRole(TRIGGER_ROLE).focus();
    await user.click(screen.getByRole(TRIGGER_ROLE));
    await user.keyboard('c');
    const options = screen.getAllByRole('option');
    expect(options[2]).toHaveAttribute('tabindex', '0');
  });

  it('aria-selected reflects the current value', async () => {
    const user = userEvent.setup();
    render(<Dropdown options={BASIC_OPTIONS} value="c" onChange={() => {}} />);
    screen.getByRole(TRIGGER_ROLE).focus();
    await user.click(screen.getByRole(TRIGGER_ROLE));
    const opts = screen.getAllByRole('option');
    expect(opts[0]).toHaveAttribute('aria-selected', 'false');
    expect(opts[2]).toHaveAttribute('aria-selected', 'true');
  });

  it('skips disabled options on click', async () => {
    const onChange = vi.fn();
    const opts = [
      { value: 'a', label: 'Active' },
      { value: 'b', label: 'Disabled', disabled: true },
    ];
    const user = userEvent.setup();
    render(<Dropdown options={opts} value={null} onChange={onChange} />);
    screen.getByRole(TRIGGER_ROLE).focus();
    await user.click(screen.getByRole(TRIGGER_ROLE));
    await user.click(screen.getByRole('option', { name: 'Disabled' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('<Dropdown /> — searchable', () => {
  const LONG_OPTIONS = Array.from({ length: 15 }, (_, i) => ({
    value: `v${i}`,
    label: `Option ${i}`,
  }));

  it('auto-enables search when options.length > 10', async () => {
    const user = userEvent.setup();
    render(<Dropdown options={LONG_OPTIONS} value={null} onChange={() => {}} />);
    screen.getByRole(TRIGGER_ROLE).focus();
    await user.click(screen.getByRole(TRIGGER_ROLE));
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
  });

  it('does not auto-enable search at <= 10 options', async () => {
    const user = userEvent.setup();
    render(<Dropdown options={BASIC_OPTIONS} value={null} onChange={() => {}} />);
    screen.getByRole(TRIGGER_ROLE).focus();
    await user.click(screen.getByRole(TRIGGER_ROLE));
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('forces search on via searchable prop', async () => {
    const user = userEvent.setup();
    render(<Dropdown options={BASIC_OPTIONS} value={null} onChange={() => {}} searchable />);
    screen.getByRole(TRIGGER_ROLE).focus();
    await user.click(screen.getByRole(TRIGGER_ROLE));
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
  });

  it('filters options by substring match (case-insensitive)', async () => {
    const user = userEvent.setup();
    render(<Dropdown options={BASIC_OPTIONS} value={null} onChange={() => {}} searchable />);
    screen.getByRole(TRIGGER_ROLE).focus();
    await user.click(screen.getByRole(TRIGGER_ROLE));
    await user.type(screen.getByRole('searchbox'), 'an');
    const opts = screen.queryAllByRole('option');
    expect(opts).toHaveLength(1);
    expect(opts[0]).toHaveTextContent('Banana');
  });

  it('shows "No results" when filter matches nothing', async () => {
    const user = userEvent.setup();
    render(<Dropdown options={BASIC_OPTIONS} value={null} onChange={() => {}} searchable />);
    screen.getByRole(TRIGGER_ROLE).focus();
    await user.click(screen.getByRole(TRIGGER_ROLE));
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.getByText('No results')).toBeInTheDocument();
  });

  it('selects filtered match on Enter', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Dropdown options={BASIC_OPTIONS} value={null} onChange={onChange} searchable />);
    screen.getByRole(TRIGGER_ROLE).focus();
    await user.click(screen.getByRole(TRIGGER_ROLE));
    await user.type(screen.getByRole('searchbox'), 'ch');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('c');
  });
});

describe('<Dropdown /> — edge cases and props', () => {
  it('is non-interactive when disabled', async () => {
    const user = userEvent.setup();
    render(<Dropdown options={BASIC_OPTIONS} value={null} onChange={() => {}} disabled />);
    const trigger = screen.getByRole(TRIGGER_ROLE);
    await user.click(trigger);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows "No options" when options array is empty', async () => {
    const user = userEvent.setup();
    render(<Dropdown options={[]} value={null} onChange={() => {}} />);
    screen.getByRole(TRIGGER_ROLE).focus();
    await user.click(screen.getByRole(TRIGGER_ROLE));
    expect(screen.getByText('No options')).toBeInTheDocument();
  });

  it('renders hidden input when name prop is set', () => {
    const { container } = render(
      <Dropdown options={BASIC_OPTIONS} value="b" onChange={() => {}} name="fruit" />
    );
    const hidden = container.querySelector('input[type="hidden"]');
    expect(hidden).toBeInTheDocument();
    expect(hidden).toHaveAttribute('name', 'fruit');
    expect(hidden).toHaveAttribute('value', 'b');
  });

  it('hidden input is empty when value is null', () => {
    const { container } = render(
      <Dropdown options={BASIC_OPTIONS} value={null} onChange={() => {}} name="fruit" />
    );
    const hidden = container.querySelector('input[type="hidden"]');
    expect(hidden).toHaveAttribute('value', '');
  });

  it('renders custom trigger via renderTrigger prop', () => {
    render(
      <Dropdown
        options={BASIC_OPTIONS}
        value="a"
        onChange={() => {}}
        renderTrigger={(s) => <span>custom:{s?.label ?? 'none'}</span>}
      />
    );
    expect(screen.getByText('custom:Apple')).toBeInTheDocument();
  });

  it('renders custom option rows via renderOption prop', async () => {
    const user = userEvent.setup();
    render(
      <Dropdown
        options={BASIC_OPTIONS}
        value={null}
        onChange={() => {}}
        renderOption={(o) => <span>row:{o.label}</span>}
      />
    );
    screen.getByRole(TRIGGER_ROLE).focus();
    await user.click(screen.getByRole(TRIGGER_ROLE));
    expect(screen.getByText('row:Apple')).toBeInTheDocument();
    expect(screen.getByText('row:Banana')).toBeInTheDocument();
  });
});
