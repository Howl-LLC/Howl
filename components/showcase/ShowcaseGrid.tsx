// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import type { ShowcaseCard, SteamPlaytimeEntry } from '../../services/api/gameAccounts';
import type { GameActivity } from '../../types';
import {
  renderCardContent, GAME_COLORS, DATA_PROVIDERS,
  type GameAccount, type SpotifyData, type PlatformProfiles,
} from './cardRenderers';
import { useIsMobile } from '../../hooks/useIsMobile';

function parseSize(size: string): { cols: number; rows: number } {
  const [cols, rows] = size.split('x').map(Number);
  return { cols: cols || 1, rows: rows || 1 };
}

interface ShowcaseGridProps {
  layout: ShowcaseCard[];
  mobileLayout?: ShowcaseCard[] | null;
  gameAccounts: GameAccount[];
  spotifyData?: SpotifyData | null;
  spotifyActivity?: GameActivity | null;
  steamPlaytime?: SteamPlaytimeEntry[];
  steamRecentActivity?: SteamPlaytimeEntry[];
  platformProfiles?: PlatformProfiles | null;
  loading?: boolean;
}

export const ShowcaseGrid: React.FC<ShowcaseGridProps> = ({ layout, mobileLayout, gameAccounts, spotifyData, spotifyActivity, steamPlaytime, steamRecentActivity, platformProfiles, loading }) => {
  const isMobile = useIsMobile();
  const gridCols = isMobile ? 2 : 3;

  if (loading) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${gridCols}, 1fr)`, gap: isMobile ? '6px' : '10px', gridAutoRows: isMobile ? '100px' : '110px' }}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="rounded-xl animate-pulse" style={{
            gridColumn: i === 0 ? 'span 2' : 'span 1',
            background: 'var(--fill-hover)',
            border: '1px solid var(--fill-hover)',
            borderRadius: '12px',
          }} />
        ))}
      </div>
    );
  }

  const effectiveLayout = isMobile && mobileLayout && mobileLayout.length > 0 ? mobileLayout : layout;
  const sorted = [...effectiveLayout].sort((a, b) => a.position - b.position);

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
      gap: isMobile ? '6px' : '10px',
      gridAutoRows: isMobile ? '100px' : '110px',
      gridAutoFlow: 'dense',
    }}>
      {sorted.map(card => {
        const { cols, rows } = parseSize(card.size);
        const cappedCols = isMobile ? Math.min(cols, 2) : cols;
        const accentColor = card.color || (card.game ? GAME_COLORS[card.game] || 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.3)');
        const account = card.game ? gameAccounts.find(a => a.game === card.game) : undefined;
        const isVerified = account?.verified ?? false;
        const provider = card.game ? DATA_PROVIDERS[card.game] : undefined;

        return (
          <div key={card.id} style={{
            gridColumn: `span ${cappedCols}`,
            gridRow: `span ${rows}`,
            background: `color-mix(in srgb, ${accentColor} 5%, transparent)`,
            border: `1px solid color-mix(in srgb, ${accentColor} 15%, transparent)`,
            borderRadius: '12px',
            padding: isMobile ? '10px' : '14px',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
          }}>
            {renderCardContent(card, gameAccounts, spotifyData, spotifyActivity, steamPlaytime, steamRecentActivity, platformProfiles)}
            {/* Error indicator */}
            {card.game && (() => {
              const acct = gameAccounts.find(a => a.game === card.game);
              return acct?.fetchError ? (
                <div style={{ position: 'absolute', bottom: 6, left: 8, right: 8, fontSize: '8px', padding: '2px 6px', borderRadius: '12px', background: 'rgba(220,50,50,0.1)', color: 'rgba(220,50,50,0.5)' }}>
                  Stats unavailable
                </div>
              ) : null;
            })()}
            {/* Data provider attribution */}
            {provider && account?.stats && (
              <a
                href={provider.url}
                target="_blank"
                rel="noopener noreferrer"
                className="absolute bottom-1.5 right-2 no-underline hover:underline transition-opacity"
                style={{ color: 'var(--text-secondary)', opacity: 0.3, fontSize: '7px', lineHeight: 1 }}
                title={`Data provided by ${provider.name}`}
              >
                {provider.name}
              </a>
            )}
            {isVerified && (
              <div style={{
                position: 'absolute', top: 8, right: 8,
                width: 14, height: 14, borderRadius: '50%',
                background: 'rgba(59,165,93,0.2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="#3ba55d"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default ShowcaseGrid;
