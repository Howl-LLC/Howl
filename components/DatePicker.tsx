// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'motion/react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';

interface DatePickerProps {
  value: string;
  onChange: (value: string) => void;
  max?: string;
  min?: string;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
  onFocus?: React.FocusEventHandler<HTMLDivElement>;
  onBlur?: React.FocusEventHandler<HTMLDivElement>;
  required?: boolean;
  autoFocus?: boolean;
}

type View = 'days' | 'months' | 'years';

const YEAR_PAGE_SIZE = 12;

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

function parseDate(s: string): { year: number; month: number; day: number } | null {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return { year: y, month: m - 1, day: d };
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function toDateStr(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

function isAfter(a: { year: number; month: number; day: number }, b: { year: number; month: number; day: number }): boolean {
  if (a.year !== b.year) return a.year > b.year;
  if (a.month !== b.month) return a.month > b.month;
  return a.day > b.day;
}

function isBefore(a: { year: number; month: number; day: number }, b: { year: number; month: number; day: number }): boolean {
  if (a.year !== b.year) return a.year < b.year;
  if (a.month !== b.month) return a.month < b.month;
  return a.day < b.day;
}

export const DatePicker: React.FC<DatePickerProps> = ({
  value,
  onChange,
  max,
  min,
  placeholder,
  className = '',
  style,
  onFocus,
  onBlur,
  required,
  autoFocus,
}) => {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || 'en-US';

  const parsed = useMemo(() => parseDate(value), [value]);
  const maxDate = useMemo(() => parseDate(max || ''), [max]);
  const minDate = useMemo(() => parseDate(min || ''), [min]);

  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<View>('days');
  const [viewYear, setViewYear] = useState(() => parsed?.year ?? new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => parsed?.month ?? new Date().getMonth());
  const [direction, setDirection] = useState(0);
  const [yearPageStart, setYearPageStart] = useState(() => {
    const y = parsed?.year ?? new Date().getFullYear();
    return y - (y % YEAR_PAGE_SIZE);
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const [openAbove, setOpenAbove] = useState(false);

  // Sync view state when value changes externally
  useEffect(() => {
    if (parsed) {
      setViewYear(parsed.year);
      setViewMonth(parsed.month);
      setYearPageStart(parsed.year - (parsed.year % YEAR_PAGE_SIZE));
    }
  }, [parsed]);

  // Position popup above or below based on available space
  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenAbove(spaceBelow < 360 && rect.top > spaceBelow);
    }
  }, [isOpen]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      const target = 'touches' in e ? e.touches[0]?.target : e.target;
      if (containerRef.current && target && !containerRef.current.contains(target as Node)) {
        setIsOpen(false);
        setView('days');
      }
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler, { passive: true });
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        setView('days');
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen]);

  const displayValue = useMemo(() => {
    if (!parsed) return '';
    try {
      const date = new Date(parsed.year, parsed.month, parsed.day);
      return new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }).format(date);
    } catch {
      return value;
    }
  }, [parsed, value, locale]);

  const weekdayHeaders = useMemo(() => {
    const headers: string[] = [];
    // Generate day names starting from Sunday
    for (let i = 0; i < 7; i++) {
      // Jan 7, 2024 is a Sunday
      const date = new Date(2024, 0, 7 + i);
      headers.push(
        new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(date)
      );
    }
    return headers;
  }, [locale]);

  const monthNames = useMemo(() => {
    return Array.from({ length: 12 }, (_, i) => {
      const date = new Date(2024, i, 1);
      return new Intl.DateTimeFormat(locale, { month: 'short' }).format(date);
    });
  }, [locale]);

  const fullMonthName = useMemo(() => {
    const date = new Date(viewYear, viewMonth, 1);
    return new Intl.DateTimeFormat(locale, { month: 'long' }).format(date);
  }, [locale, viewYear, viewMonth]);

  const isDayDisabled = useCallback(
    (year: number, month: number, day: number) => {
      const d = { year, month, day };
      if (maxDate && isAfter(d, maxDate)) return true;
      if (minDate && isBefore(d, minDate)) return true;
      return false;
    },
    [maxDate, minDate]
  );

  const isMonthDisabled = useCallback(
    (month: number) => {
      // A month is disabled if all its days are disabled
      if (maxDate && (viewYear > maxDate.year || (viewYear === maxDate.year && month > maxDate.month))) return true;
      if (minDate && (viewYear < minDate.year || (viewYear === minDate.year && month < minDate.month))) return true;
      return false;
    },
    [viewYear, maxDate, minDate]
  );

  const isYearDisabled = useCallback(
    (year: number) => {
      if (maxDate && year > maxDate.year) return true;
      if (minDate && year < minDate.year) return true;
      return false;
    },
    [maxDate, minDate]
  );

  const navigateMonth = useCallback(
    (delta: number) => {
      setDirection(delta);
      setViewMonth((prev) => {
        const newMonth = prev + delta;
        if (newMonth < 0) {
          setViewYear((y) => y - 1);
          return 11;
        }
        if (newMonth > 11) {
          setViewYear((y) => y + 1);
          return 0;
        }
        return newMonth;
      });
    },
    []
  );

  const selectDay = useCallback(
    (day: number) => {
      if (isDayDisabled(viewYear, viewMonth, day)) return;
      onChange(toDateStr(viewYear, viewMonth, day));
      setIsOpen(false);
      setView('days');
    },
    [viewYear, viewMonth, isDayDisabled, onChange]
  );

  const selectMonth = useCallback(
    (month: number) => {
      if (isMonthDisabled(month)) return;
      setViewMonth(month);
      setView('days');
    },
    [isMonthDisabled]
  );

  const selectYear = useCallback(
    (year: number) => {
      if (isYearDisabled(year)) return;
      setViewYear(year);
      setYearPageStart(year - (year % YEAR_PAGE_SIZE));
      setView('months');
    },
    [isYearDisabled]
  );

  const handleOpen = useCallback(() => {
    if (!isOpen) {
      // Reset view to days when opening
      setView('days');
      if (parsed) {
        setViewYear(parsed.year);
        setViewMonth(parsed.month);
        setYearPageStart(parsed.year - (parsed.year % YEAR_PAGE_SIZE));
      }
    }
    setIsOpen(!isOpen);
  }, [isOpen, parsed]);

  // Build the days grid
  const daysGrid = useMemo(() => {
    const daysInMonth = getDaysInMonth(viewYear, viewMonth);
    const firstDay = getFirstDayOfWeek(viewYear, viewMonth);
    const daysInPrevMonth = getDaysInMonth(
      viewMonth === 0 ? viewYear - 1 : viewYear,
      viewMonth === 0 ? 11 : viewMonth - 1
    );

    const cells: Array<{
      day: number;
      month: number;
      year: number;
      isCurrentMonth: boolean;
      isSelected: boolean;
      isToday: boolean;
      isDisabled: boolean;
    }> = [];

    const today = new Date();
    const todayY = today.getFullYear();
    const todayM = today.getMonth();
    const todayD = today.getDate();

    // Previous month's trailing days
    for (let i = firstDay - 1; i >= 0; i--) {
      const d = daysInPrevMonth - i;
      const m = viewMonth === 0 ? 11 : viewMonth - 1;
      const y = viewMonth === 0 ? viewYear - 1 : viewYear;
      cells.push({
        day: d,
        month: m,
        year: y,
        isCurrentMonth: false,
        isSelected: false,
        isToday: y === todayY && m === todayM && d === todayD,
        isDisabled: isDayDisabled(y, m, d),
      });
    }

    // Current month's days
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({
        day: d,
        month: viewMonth,
        year: viewYear,
        isCurrentMonth: true,
        isSelected: parsed ? parsed.year === viewYear && parsed.month === viewMonth && parsed.day === d : false,
        isToday: viewYear === todayY && viewMonth === todayM && d === todayD,
        isDisabled: isDayDisabled(viewYear, viewMonth, d),
      });
    }

    // Next month's leading days
    const remaining = 42 - cells.length; // 6 rows × 7
    for (let d = 1; d <= remaining; d++) {
      const m = viewMonth === 11 ? 0 : viewMonth + 1;
      const y = viewMonth === 11 ? viewYear + 1 : viewYear;
      cells.push({
        day: d,
        month: m,
        year: y,
        isCurrentMonth: false,
        isSelected: false,
        isToday: y === todayY && m === todayM && d === todayD,
        isDisabled: isDayDisabled(y, m, d),
      });
    }

    // Trim trailing row if all outside current month
    const rows = Math.ceil(cells.length / 7);
    if (rows > 5) {
      const lastRowStart = (rows - 1) * 7;
      const lastRowAllOutside = cells.slice(lastRowStart).every((c) => !c.isCurrentMonth);
      if (lastRowAllOutside) cells.splice(lastRowStart);
    }

    return cells;
  }, [viewYear, viewMonth, parsed, isDayDisabled]);

  const yearRange = useMemo(() => {
    return Array.from({ length: YEAR_PAGE_SIZE }, (_, i) => yearPageStart + i);
  }, [yearPageStart]);

  // Keyboard nav for days grid
  const handleDayKeyDown = useCallback(
    (e: React.KeyboardEvent, day: number) => {
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          if (day > 1) triggerRef.current?.querySelector<HTMLButtonElement>(`[data-day="${day - 1}"]`)?.focus();
          else navigateMonth(-1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (day < getDaysInMonth(viewYear, viewMonth)) triggerRef.current?.querySelector<HTMLButtonElement>(`[data-day="${day + 1}"]`)?.focus();
          else navigateMonth(1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (day > 7) containerRef.current?.querySelector<HTMLButtonElement>(`[data-day="${day - 7}"]`)?.focus();
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (day + 7 <= getDaysInMonth(viewYear, viewMonth)) containerRef.current?.querySelector<HTMLButtonElement>(`[data-day="${day + 7}"]`)?.focus();
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          selectDay(day);
          break;
      }
    },
    [viewYear, viewMonth, navigateMonth, selectDay]
  );

  // Hidden input for form validation
  const hiddenInput = required ? (
    <input
      type="text"
      value={value}
      required
      tabIndex={-1}
      aria-hidden
      onChange={() => {}}
      style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
    />
  ) : null;

  const canGoPrevMonth = !minDate || viewYear > minDate.year || (viewYear === minDate.year && viewMonth > minDate.month);
  const canGoNextMonth = !maxDate || viewYear < maxDate.year || (viewYear === maxDate.year && viewMonth < maxDate.month);

  return (
    <div ref={containerRef} className="relative" onFocus={onFocus as any} onBlur={onBlur as any}>
      {hiddenInput}

      {/* Trigger */}
      <div
        ref={triggerRef}
        role="combobox"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        tabIndex={0}
        className={`flex items-center gap-3 cursor-pointer select-none ${className}`}
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: isOpen ? 'var(--accent-emphasis)' : 'var(--border-subtle)',
          boxShadow: isOpen ? '0 0 0 2px var(--accent-muted)' : 'none',
          ...style,
        }}
        onClick={handleOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleOpen();
          }
        }}
        autoFocus={autoFocus}
      >
        <Calendar size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
        <span
          className="flex-1 text-sm truncate"
          style={{ color: displayValue ? 'var(--text-primary)' : 'var(--text-tertiary)' }}
        >
          {displayValue || placeholder || t('login.dateOfBirth', 'Select date')}
        </span>
        <ChevronDown isOpen={isOpen} />
      </div>

      {/* Popup */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: openAbove ? 6 : -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: openAbove ? 6 : -6 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            className="absolute left-0 right-0 z-50"
            style={{
              [openAbove ? 'bottom' : 'top']: '100%',
              marginTop: openAbove ? undefined : '6px',
              marginBottom: openAbove ? '6px' : undefined,
            }}
          >
            <div
              className="rounded-xl border overflow-hidden"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                borderColor: 'var(--border-subtle)',
                boxShadow: 'var(--shadow-lg), 0 0 0 1px var(--accent-subtle)',
                backdropFilter: 'blur(20px)',
              }}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => {
                    if (view === 'days') navigateMonth(-1);
                    else if (view === 'months') setViewYear((y) => y - 1);
                    else setYearPageStart((y) => y - YEAR_PAGE_SIZE);
                  }}
                  disabled={view === 'days' && !canGoPrevMonth}
                  className="p-1.5 rounded-lg transition-colors disabled:opacity-20 text-[var(--text-secondary)] hover:bg-[var(--accent-subtle)] hover:text-[var(--cyan-accent)]"
                >
                  <ChevronLeft size={16} />
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (view === 'days') setView('months');
                    else if (view === 'months') {
                      setYearPageStart(viewYear - (viewYear % YEAR_PAGE_SIZE));
                      setView('years');
                    }
                    else setView('days');
                  }}
                  className="text-sm font-semibold px-3 py-1 rounded-lg transition-colors text-[var(--text-primary)] hover:bg-[var(--accent-subtle)] hover:text-[var(--cyan-accent)]"
                >
                  {view === 'days' && `${fullMonthName} ${viewYear}`}
                  {view === 'months' && `${viewYear}`}
                  {view === 'years' && `${yearPageStart}\u2009–\u2009${yearPageStart + YEAR_PAGE_SIZE - 1}`}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (view === 'days') navigateMonth(1);
                    else if (view === 'months') setViewYear((y) => y + 1);
                    else setYearPageStart((y) => y + YEAR_PAGE_SIZE);
                  }}
                  disabled={view === 'days' && !canGoNextMonth}
                  className="p-1.5 rounded-lg transition-colors disabled:opacity-20 text-[var(--text-secondary)] hover:bg-[var(--accent-subtle)] hover:text-[var(--cyan-accent)]"
                >
                  <ChevronRight size={16} />
                </button>
              </div>

              {/* Divider */}
              <div style={{ height: '1px', backgroundColor: 'var(--border-subtle)' }} />

              {/* Body */}
              <div className="p-2.5">
                <AnimatePresence mode="wait" initial={false}>
                  {view === 'days' && (
                    <motion.div
                      key={`days-${viewYear}-${viewMonth}`}
                      initial={{ opacity: 0, x: direction * 24 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: direction * -24 }}
                      transition={{ duration: 0.15, ease: 'easeOut' }}
                    >
                      {/* Weekday headers */}
                      <div className="grid grid-cols-7 mb-1">
                        {weekdayHeaders.map((day, i) => (
                          <div
                            key={i}
                            className="text-center text-[10px] font-semibold uppercase tracking-wider py-1.5"
                            style={{ color: 'var(--text-tertiary)' }}
                          >
                            {day}
                          </div>
                        ))}
                      </div>

                      {/* Day cells */}
                      <div className="grid grid-cols-7">
                        {daysGrid.map((cell, i) => {
                          const isSelected = cell.isSelected;
                          const isDisabled = cell.isDisabled;

                          return (
                            <button
                              key={i}
                              type="button"
                              data-day={cell.isCurrentMonth ? cell.day : undefined}
                              disabled={isDisabled}
                              onClick={() => {
                                if (!cell.isCurrentMonth) {
                                  // Navigate to that month and select
                                  setViewYear(cell.year);
                                  setViewMonth(cell.month);
                                  if (!isDisabled) onChange(toDateStr(cell.year, cell.month, cell.day));
                                  setIsOpen(false);
                                  setView('days');
                                } else {
                                  selectDay(cell.day);
                                }
                              }}
                              onKeyDown={cell.isCurrentMonth ? (e) => handleDayKeyDown(e, cell.day) : undefined}
                              className={`relative flex items-center justify-center text-xs font-medium rounded-lg transition-all duration-100 ${!isSelected && !isDisabled ? 'hover:bg-[var(--accent-subtle)]' : ''}`}
                              style={{
                                height: '34px',
                                color: isDisabled
                                  ? 'var(--text-disabled)'
                                  : isSelected
                                    ? '#fff'
                                    : cell.isCurrentMonth
                                      ? 'var(--text-primary)'
                                      : 'var(--text-tertiary)',
                                background: isSelected
                                  ? 'var(--cta-bg, #02385A)'
                                  : 'transparent',
                                boxShadow: 'none',
                                cursor: isDisabled ? 'not-allowed' : 'pointer',
                              }}
                            >
                              {cell.day}
                              {cell.isToday && !isSelected && (
                                <span
                                  className="absolute bottom-[3px] left-1/2 -translate-x-1/2 rounded-full"
                                  style={{
                                    width: '3px',
                                    height: '3px',
                                    backgroundColor: 'var(--cyan-accent)',
                                  }}
                                />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </motion.div>
                  )}

                  {view === 'months' && (
                    <motion.div
                      key="months"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      transition={{ duration: 0.15, ease: 'easeOut' }}
                      className="grid grid-cols-3 gap-1.5"
                    >
                      {monthNames.map((name, i) => {
                        const isCurrent = parsed && parsed.year === viewYear && parsed.month === i;
                        const disabled = isMonthDisabled(i);
                        return (
                          <button
                            key={i}
                            type="button"
                            disabled={disabled}
                            onClick={() => selectMonth(i)}
                            className={`py-3 rounded-lg text-xs font-semibold transition-all duration-100 ${!isCurrent && !disabled ? 'hover:bg-[var(--accent-subtle)]' : ''}`}
                            style={{
                              color: disabled
                                ? 'var(--text-disabled)'
                                : isCurrent
                                  ? '#fff'
                                  : 'var(--text-primary)',
                              background: isCurrent
                                ? 'var(--cta-bg, #02385A)'
                                : 'transparent',
                              boxShadow: 'none',
                              cursor: disabled ? 'not-allowed' : 'pointer',
                            }}
                          >
                            {name}
                          </button>
                        );
                      })}
                    </motion.div>
                  )}

                  {view === 'years' && (
                    <motion.div
                      key={`years-${yearPageStart}`}
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      transition={{ duration: 0.15, ease: 'easeOut' }}
                      className="grid grid-cols-3 gap-1.5"
                    >
                      {yearRange.map((year) => {
                        const isCurrent = parsed?.year === year;
                        const disabled = isYearDisabled(year);
                        return (
                          <button
                            key={year}
                            type="button"
                            disabled={disabled}
                            onClick={() => selectYear(year)}
                            className={`py-3 rounded-lg text-xs font-semibold transition-all duration-100 ${!isCurrent && !disabled ? 'hover:bg-[var(--accent-subtle)]' : ''}`}
                            style={{
                              color: disabled
                                ? 'var(--text-disabled)'
                                : isCurrent
                                  ? '#fff'
                                  : 'var(--text-primary)',
                              background: isCurrent
                                ? 'var(--cta-bg, #02385A)'
                                : 'transparent',
                              boxShadow: 'none',
                              cursor: disabled ? 'not-allowed' : 'pointer',
                            }}
                          >
                            {year}
                          </button>
                        );
                      })}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

/* Tiny chevron indicator for the trigger */
function ChevronDown({ isOpen }: { isOpen: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      className={`shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
      style={{ color: 'var(--text-tertiary)' }}
    >
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
