// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { CARD, TABLE_HEAD } from './styles';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  /** Optional className for the <th> and <td> cells */
  className?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  emptyIcon?: React.ReactNode;
  emptyMessage?: string;
  loadingMessage?: string;
}

export function DataTable<T>({
  columns,
  data,
  rowKey,
  onRowClick,
  loading,
  emptyIcon,
  emptyMessage = 'No results found',
  loadingMessage = 'Loading...',
}: DataTableProps<T>) {
  return (
    <div className={`${CARD} overflow-x-auto`}>
      <table className="w-full text-sm">
        <thead>
          <tr className={TABLE_HEAD}>
            {columns.map((col) => (
              <th
                key={col.key}
                className={`px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider ${col.className || ''}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={columns.length} className="px-5 py-16 text-center text-slate-500">
                <RefreshCw size={16} className="animate-spin inline mr-2" />
                {loadingMessage}
              </td>
            </tr>
          ) : data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-5 py-16 text-center text-slate-500">
                {emptyIcon || <Search size={20} className="mx-auto mb-2 opacity-40" />}
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`border-t border-white/[0.04] hover:bg-white/[0.03] transition-all duration-150 group ${
                  onRowClick ? 'cursor-pointer' : ''
                }`}
              >
                {columns.map((col) => (
                  <td key={col.key} className={`px-5 py-3.5 ${col.className || ''}`}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
