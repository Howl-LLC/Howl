// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useId, useRef, useState } from 'react';
import {
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useListNavigation,
  useRole,
  useTypeahead,
  type Placement,
} from '@floating-ui/react';

export interface UseDropdownPanelOptions {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  placement?: Placement;
  optionLabels: string[];
  activeIndex: number | null;
  setActiveIndex: (index: number | null) => void;
  selectedIndex: number | null;
  disableTypeahead?: boolean;
}

const MOBILE_QUERY = '(max-width: 767px)';

export function useDropdownPanel(opts: UseDropdownPanelOptions) {
  const {
    isOpen,
    onOpenChange,
    placement = 'bottom-start',
    optionLabels,
    activeIndex,
    setActiveIndex,
    selectedIndex,
    disableTypeahead = false,
  } = opts;

  const listRef = useRef<Array<HTMLElement | null>>([]);
  const listContentRef = useRef<Array<string | null>>(optionLabels);
  listContentRef.current = optionLabels;

  const listboxId = useId();

  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(MOBILE_QUERY).matches
      : false
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  const floating = useFloating({
    open: isOpen,
    onOpenChange,
    placement,
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        apply({ availableHeight, elements }) {
          Object.assign(elements.floating.style, {
            maxHeight: `${Math.max(160, availableHeight - 16)}px`,
          });
        },
        padding: 8,
      }),
    ],
  });

  const click = useClick(floating.context, { event: 'mousedown' });
  const dismiss = useDismiss(floating.context);
  const role = useRole(floating.context, { role: 'listbox' });
  const listNav = useListNavigation(floating.context, {
    listRef,
    activeIndex,
    selectedIndex,
    onNavigate: setActiveIndex,
    loop: true,
    virtual: false,
    focusItemOnOpen: 'auto',
  });
  const typeahead = useTypeahead(floating.context, {
    listRef: listContentRef,
    activeIndex,
    onMatch: isOpen ? setActiveIndex : undefined,
    enabled: !disableTypeahead,
  });

  const interactions = useInteractions([click, dismiss, role, listNav, typeahead]);

  return {
    floating,
    interactions,
    listRef,
    listboxId,
    isMobile,
  };
}
