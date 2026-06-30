// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { FloatingPortal } from '@floating-ui/react';
import { useEffect, useMemo, useState, type ReactNode, type KeyboardEvent } from 'react';
import { useDropdownPanel } from './use-dropdown-panel';
import { DropdownSheet } from './dropdown-sheet';
import type { DropdownOption, DropdownSize } from './dropdown';

export interface DropdownMultiProps<TValue extends string | number = string> {
  options: DropdownOption<TValue>[];
  values: TValue[];
  onChange: (values: TValue[]) => void;
  placeholder?: string;
  searchable?: boolean;
  size?: DropdownSize;
  disabled?: boolean;
  renderOption?: (option: DropdownOption<TValue>) => ReactNode;
  renderTrigger?: (selected: DropdownOption<TValue>[]) => ReactNode;
  name?: string;
  align?: 'start' | 'center' | 'end';
  className?: string;
  panelClassName?: string;
}

const SIZE_CLASSES: Record<DropdownSize, { trigger: string; option: string; text: string }> = {
  tiny: { trigger: 'h-5 px-1.5 text-[8px]', option: 'h-5 px-2 text-[8px]', text: 'text-[8px]' },
  sm: { trigger: 'h-8 px-2.5 text-xs', option: 'h-8 px-2.5 text-xs', text: 'text-xs' },
  md: { trigger: 'h-10 px-3 text-sm', option: 'h-9 px-3 text-sm', text: 'text-sm' },
  lg: { trigger: 'h-12 px-4 text-base', option: 'h-11 px-4 text-base', text: 'text-base' },
};

const AUTO_SEARCH_THRESHOLD = 10;

export function DropdownMulti<TValue extends string | number = string>(
  props: DropdownMultiProps<TValue>
) {
  const {
    options,
    values,
    onChange,
    placeholder = 'Select…',
    searchable,
    size = 'md',
    disabled = false,
    renderOption,
    renderTrigger,
    name,
    align = 'start',
    className,
    panelClassName,
  } = props;

  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [query, setQuery] = useState('');

  const searchEnabled = searchable ?? options.length > AUTO_SEARCH_THRESHOLD;
  const valueSet = useMemo(() => new Set<TValue>(values), [values]);

  const filteredOptions = useMemo(() => {
    if (!searchEnabled || !query) return options;
    const q = query.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, searchEnabled, query]);

  const optionLabels = useMemo(() => filteredOptions.map((o) => o.label), [filteredOptions]);

  const placement = align === 'center' ? 'bottom' : align === 'end' ? 'bottom-end' : 'bottom-start';

  const { floating, interactions, listRef, listboxId, isMobile } = useDropdownPanel({
    isOpen,
    onOpenChange: (open) => {
      if (!disabled) {
        setIsOpen(open);
        if (!open) setQuery('');
      }
    },
    placement,
    optionLabels,
    activeIndex,
    setActiveIndex,
    selectedIndex: null,
    disableTypeahead: searchEnabled,
  });

  const selectedOptions = useMemo(
    () => options.filter((o) => valueSet.has(o.value)),
    [options, valueSet]
  );

  const sizeCls = SIZE_CLASSES[size];

  const toggle = (index: number) => {
    const opt = filteredOptions[index];
    if (!opt || opt.disabled) return;
    const next = valueSet.has(opt.value)
      ? values.filter((v) => v !== opt.value)
      : [...values, opt.value];
    onChange(next);
  };

  useEffect(() => {
    if (activeIndex !== null && activeIndex >= filteredOptions.length) {
      setActiveIndex(filteredOptions.length > 0 ? 0 : null);
    }
  }, [filteredOptions.length, activeIndex]);

  const triggerProps = interactions.getReferenceProps({
    ref: floating.refs.setReference,
    disabled,
    'aria-expanded': isOpen,
    'aria-haspopup': 'listbox',
  });

  const triggerLabel =
    selectedOptions.length === 0
      ? placeholder
      : selectedOptions.length === 1
        ? selectedOptions[0].label
        : `${selectedOptions.length} selected`;

  const renderTriggerContent = () =>
    renderTrigger ? (
      renderTrigger(selectedOptions)
    ) : (
      <span
        className="truncate"
        style={{
          color: selectedOptions.length > 0 ? 'var(--text-primary)' : 'var(--text-secondary)',
        }}
      >
        {triggerLabel}
      </span>
    );

  const triggerClassName = [
    'inline-flex w-full items-center justify-between gap-2 rounded-lg border transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cyan-accent)]/40',
    disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-[var(--fill-hover)]',
    sizeCls.trigger,
    className ?? '',
  ].join(' ');

  const panelContent = (
    <div
      ref={(el) => {
        floating.refs.setFloating(el);
      }}
      {...interactions.getFloatingProps({ 'aria-multiselectable': 'true' })}
      className={[
        'overflow-hidden outline-none rounded-lg border shadow-xl',
        'animate-in fade-in zoom-in-[0.97] duration-150',
        'flex flex-col',
        panelClassName ?? '',
      ].join(' ')}
      style={{
        ...floating.floatingStyles,
        backgroundColor: 'var(--bg-elevated)',
        borderColor: 'var(--glass-border)',
        zIndex: 'var(--z-popover, 400)' as unknown as number,
        minWidth: '200px',
      }}
    >
      {searchEnabled ? (
        <input
          type="text"
          role="searchbox"
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const idx = activeIndex ?? 0;
              if (filteredOptions.length > 0) toggle(idx);
            }
          }}
          placeholder="Search…"
          className={`w-full px-3 py-2 border-b ${sizeCls.text} outline-none`}
          style={{
            backgroundColor: 'var(--bg-input)',
            borderColor: 'var(--glass-border)',
            color: 'var(--text-primary)',
          }}
        />
      ) : null}
      <ul
        id={listboxId}
        className="flex-1 overflow-auto outline-none"
      >
        {filteredOptions.length === 0 ? (
          <li
            className={`flex items-center ${sizeCls.option}`}
            style={{ color: 'var(--text-secondary)' }}
          >
            {query ? 'No results' : 'No options'}
          </li>
        ) : (
          filteredOptions.map((opt, i) => {
            const isChecked = valueSet.has(opt.value);
            const isActive = i === activeIndex;
            return (
              <li
                key={String(opt.value)}
                ref={(el) => {
                  listRef.current[i] = el;
                }}
                role="option"
                id={`${listboxId}-option-${i}`}
                aria-selected={isChecked}
                aria-disabled={opt.disabled}
                tabIndex={isActive ? 0 : -1}
                {...interactions.getItemProps({
                  onClick: () => toggle(i),
                  onKeyDown: (e: KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggle(i);
                    }
                  },
                })}
                className={[
                  'flex items-center gap-2 cursor-pointer',
                  sizeCls.option,
                  opt.disabled ? 'opacity-40 pointer-events-none' : '',
                ].join(' ')}
                style={{
                  backgroundColor: isActive ? 'var(--fill-hover)' : undefined,
                  color: 'var(--text-primary)',
                }}
              >
                <Checkbox checked={isChecked} />
                {renderOption ? (
                  renderOption(opt)
                ) : (
                  <span className="truncate flex-1">{opt.label}</span>
                )}
              </li>
            );
          })
        )}
      </ul>
    </div>
  );

  return (
    <>
      <button
        type="button"
        {...triggerProps}
        className={triggerClassName}
        style={{
          backgroundColor: 'var(--bg-input)',
          borderColor: 'var(--glass-border)',
        }}
      >
        {renderTriggerContent()}
        <ChevronIcon />
      </button>
      {name ? (
        <input type="hidden" name={name} value={values.map(String).join(',')} />
      ) : null}
      {isOpen ? (
        isMobile ? (
          <DropdownSheet isOpen onClose={() => setIsOpen(false)} labelledBy={listboxId}>
            {panelContent}
          </DropdownSheet>
        ) : (
          <FloatingPortal>{panelContent}</FloatingPortal>
        )
      ) : null}
    </>
  );
}

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-lg border"
      style={{
        backgroundColor: checked ? 'var(--cyan-accent)' : 'transparent',
        borderColor: checked ? 'var(--cyan-accent)' : 'var(--glass-border)',
      }}
    >
      {checked ? (
        <svg viewBox="0 0 14 14" className="w-3 h-3" fill="none">
          <path d="M3 7.5l2.5 2.5L11 4.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </span>
  );
}

function ChevronIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="w-4 h-4 flex-shrink-0 opacity-70"
      fill="currentColor"
    >
      <path
        fillRule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.4a.75.75 0 01-1.08 0l-4.25-4.4a.75.75 0 01.02-1.06z"
      />
    </svg>
  );
}
