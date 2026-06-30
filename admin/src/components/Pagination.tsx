// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { BTN_GHOST } from './styles';

interface PaginationProps {
  page: number;
  pages: number;
  total: number;
  onPageChange: (page: number) => void;
  label?: string;
}

export const Pagination: React.FC<PaginationProps> = ({ page, pages, total, onPageChange, label = 'results' }) => {
  if (pages <= 1) return null;

  return (
    <div className="flex items-center justify-between mt-5 px-1">
      <span className="text-xs text-slate-500">{total.toLocaleString()} {label}</span>
      <div className="flex items-center gap-2">
        <button
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className={`${BTN_GHOST} disabled:opacity-20`}
        >
          <ChevronLeft size={16} />
        </button>
        <div className="flex items-center gap-1">
          {(() => {
            const btnClass = (pageNum: number) =>
              `w-8 h-8 rounded-lg text-xs font-medium transition-all duration-200 ${
                pageNum === page
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                  : 'text-slate-500 hover:text-white hover:bg-white/5'
              }`;
            const ellipsis = (key: string) => (
              <span key={key} className="w-8 h-8 flex items-center justify-center text-xs text-slate-500 cursor-default">
                &hellip;
              </span>
            );
            const pageBtn = (pageNum: number) => (
              <button
                key={pageNum}
                onClick={() => onPageChange(pageNum)}
                className={btnClass(pageNum)}
              >
                {pageNum}
              </button>
            );

            // Small page count — show all pages, no ellipsis needed
            if (pages <= 7) {
              return Array.from({ length: pages }, (_, i) => pageBtn(i + 1));
            }

            const items: React.ReactNode[] = [];

            // Determine the middle window (5 pages centered on current page)
            let windowStart = Math.max(2, page - 2);
            let windowEnd = Math.min(pages - 1, page + 2);

            // Adjust window to always show 5 pages when near edges
            if (windowStart <= 2) {
              windowStart = 2;
              windowEnd = Math.min(pages - 1, 6);
            }
            if (windowEnd >= pages - 1) {
              windowEnd = pages - 1;
              windowStart = Math.max(2, pages - 5);
            }

            // Always show page 1
            items.push(pageBtn(1));

            // Left ellipsis
            if (windowStart > 2) {
              items.push(ellipsis('left-ellipsis'));
            }

            // Middle window
            for (let i = windowStart; i <= windowEnd; i++) {
              items.push(pageBtn(i));
            }

            // Right ellipsis
            if (windowEnd < pages - 1) {
              items.push(ellipsis('right-ellipsis'));
            }

            // Always show last page
            items.push(pageBtn(pages));

            return items;
          })()}
        </div>
        <button
          disabled={page >= pages}
          onClick={() => onPageChange(page + 1)}
          className={`${BTN_GHOST} disabled:opacity-20`}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
};
