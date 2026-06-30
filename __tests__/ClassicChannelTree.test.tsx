// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ClassicChannelTree } from '../components/server/ClassicChannelTree';
import type { Channel, ChannelCategory } from '../types';

function cat(id: string, name: string, position: number): ChannelCategory {
  return { id, name, position, serverId: 's1' } as ChannelCategory;
}

function ch(id: string, name: string, type: 'text' | 'voice', categoryId: string | null, position: number): Channel {
  return {
    id, name, type, categoryId, position,
    serverId: 's1', description: null, slowMode: 0, isPrivate: false,
    ageRestricted: false, userLimit: 0,
  } as unknown as Channel;
}

describe('ClassicChannelTree', () => {
  beforeEach(() => { localStorage.clear(); });

  it('renders text channels grouped under their category', () => {
    render(<ClassicChannelTree
      channels={[ch('c1', 'general', 'text', 'cat1', 0), ch('c2', 'off-topic', 'text', 'cat1', 1)]}
      categories={[cat('cat1', 'TEXT', 0)]}
      activeChannelId="c1"
      onSelectChannel={() => {}}
      serverId="s1"
    />);
    expect(screen.getByText('TEXT')).toBeDefined();
    expect(screen.getByText('general')).toBeDefined();
    expect(screen.getByText('off-topic')).toBeDefined();
  });

  it('renders voice participants indented under their voice channel', () => {
    render(<ClassicChannelTree
      channels={[ch('v1', 'Lounge', 'voice', 'cat2', 0)]}
      categories={[cat('cat2', 'VOICE', 0)]}
      voiceParticipantsByChannel={{ v1: [{ id: 'u1', username: 'Alice' }, { id: 'u2', username: 'Bob' }] }}
      onSelectChannel={() => {}}
      serverId="s1"
    />);
    expect(screen.getByText('Lounge')).toBeDefined();
    expect(screen.getByText('Alice')).toBeDefined();
    expect(screen.getByText('Bob')).toBeDefined();
  });

  it('sorts categories and channels by position', () => {
    const { container } = render(<ClassicChannelTree
      channels={[ch('c2', 'off-topic', 'text', 'cat1', 1), ch('c1', 'general', 'text', 'cat1', 0)]}
      categories={[cat('cat2', 'SECOND', 1), cat('cat1', 'FIRST', 0)]}
      onSelectChannel={() => {}}
      serverId="s1"
    />);
    const labels = Array.from(container.querySelectorAll('[data-cat-label]')).map(e => e.textContent?.trim());
    expect(labels).toEqual(['FIRST', 'SECOND']);
    const channelLabels = Array.from(container.querySelectorAll('[data-channel-name]')).map(e => e.getAttribute('data-channel-name'));
    expect(channelLabels).toEqual(['general', 'off-topic']);
  });

  it('renders uncategorized channels at the top', () => {
    render(<ClassicChannelTree
      channels={[ch('u1', 'welcome', 'text', null, 0), ch('c1', 'general', 'text', 'cat1', 0)]}
      categories={[cat('cat1', 'TEXT', 0)]}
      onSelectChannel={() => {}}
      serverId="s1"
    />);
    expect(screen.getByText('welcome')).toBeDefined();
    expect(screen.getByText('general')).toBeDefined();
    expect(screen.getByText('TEXT')).toBeDefined();
  });

  it('clicking a voice channel joins the call AND navigates to the channel view', async () => {
    // Voice clicks must call BOTH callbacks: onJoinVoiceChannel actually
    // joins the LiveKit room, and onSelectChannel updates the active
    // channel so the voice-view UI (participant cards / video tiles)
    // appears in the chat area instead of leaving the user staring at
    // the previous text channel.
    const { fireEvent } = await import('@testing-library/react');
    const onSelect = vi.fn();
    const onJoinVoice = vi.fn();
    render(<ClassicChannelTree
      channels={[ch('v1', 'Lounge', 'voice', 'cat1', 0)]}
      categories={[cat('cat1', 'VOICE', 0)]}
      onSelectChannel={onSelect}
      onJoinVoiceChannel={onJoinVoice}
      serverId="s1"
    />);
    fireEvent.click(screen.getByText('Lounge'));
    expect(onJoinVoice).toHaveBeenCalledWith('v1');
    expect(onSelect).toHaveBeenCalledWith('v1');
  });

  it('clicking a text channel calls onSelectChannel', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const onSelect = vi.fn();
    const onJoinVoice = vi.fn();
    render(<ClassicChannelTree
      channels={[ch('c1', 'general', 'text', 'cat1', 0)]}
      categories={[cat('cat1', 'TEXT', 0)]}
      onSelectChannel={onSelect}
      onJoinVoiceChannel={onJoinVoice}
      serverId="s1"
    />);
    fireEvent.click(screen.getByText('general'));
    expect(onSelect).toHaveBeenCalledWith('c1');
    expect(onJoinVoice).not.toHaveBeenCalled();
  });

  it('shows the connected-voice indicator dot on the matching voice channel', () => {
    const { container } = render(<ClassicChannelTree
      channels={[ch('v1', 'Lounge', 'voice', 'cat1', 0), ch('v2', 'Rainforest', 'voice', 'cat1', 1)]}
      categories={[cat('cat1', 'VOICE', 0)]}
      connectedVoiceChannelId="v1"
      onSelectChannel={() => {}}
      onJoinVoiceChannel={() => {}}
      serverId="s1"
    />);
    const connectedDots = container.querySelectorAll('[aria-label="Connected"]');
    expect(connectedDots.length).toBe(1);
  });
});
