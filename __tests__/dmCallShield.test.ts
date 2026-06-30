// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { deriveDmCallShield, computeStandingAck } from '../hooks/useDMCall';

// Bilateral DM-call shield honesty.
//
// The initiator must NOT show a green "end-to-end encrypted" shield purely
// because its OWN SFrame key installed — that over-claims call-wide
// confidentiality while the peer may still be keying or have failed entirely.
// Green ("secure") is earned only once every current remote peer has confirmed
// E2EE is established on their leg via the `dm-call-e2ee-ack` round-trip.

const base = {
  e2eeReady: true,
  e2eeExpected: true,
  localKeyed: true,
  blocked: false,
  degraded: false,
  remotePeerIds: [] as string[],
  ackedPeerIds: new Set<string>(),
  failedPeerIds: new Set<string>(),
};

describe('deriveDmCallShield', () => {
  it('no shield for an unencrypted / non-E2EE DM (E2EE never expected)', () => {
    expect(
      deriveDmCallShield({
        ...base,
        e2eeExpected: false,
        localKeyed: false,
      }),
    ).toBe('none');
  });

  it('shows "encrypting" while local key resolution is still pending', () => {
    expect(
      deriveDmCallShield({ ...base, e2eeReady: false, localKeyed: false }),
    ).toBe('encrypting');
  });

  it('does not show "encrypting" pre-resolution when E2EE was never expected', () => {
    expect(
      deriveDmCallShield({
        ...base,
        e2eeReady: false,
        e2eeExpected: false,
        localKeyed: false,
      }),
    ).toBe('none');
  });

  it('shows "failed" (amber) when E2EE was expected but the local key never installed', () => {
    expect(
      deriveDmCallShield({ ...base, localKeyed: false }),
    ).toBe('failed');
  });

  it('initiator keyed but alone (no peer yet) is "encrypting", NOT secure — guards the over-claim', () => {
    expect(
      deriveDmCallShield({ ...base, remotePeerIds: [] }),
    ).toBe('encrypting');
  });

  it('keyed locally but peer has not acked yet => "encrypting"', () => {
    expect(
      deriveDmCallShield({
        ...base,
        remotePeerIds: ['bob'],
        ackedPeerIds: new Set(),
      }),
    ).toBe('encrypting');
  });

  it('keyed locally AND the only peer acked success => "secure" (green)', () => {
    expect(
      deriveDmCallShield({
        ...base,
        remotePeerIds: ['bob'],
        ackedPeerIds: new Set(['bob']),
      }),
    ).toBe('secure');
  });

  it('peer reported E2EE failure => "failed" (amber), even though local is keyed', () => {
    expect(
      deriveDmCallShield({
        ...base,
        remotePeerIds: ['bob'],
        failedPeerIds: new Set(['bob']),
      }),
    ).toBe('failed');
  });

  it('group DM call: all present peers must ack before green', () => {
    expect(
      deriveDmCallShield({
        ...base,
        remotePeerIds: ['bob', 'carol'],
        ackedPeerIds: new Set(['bob']),
      }),
    ).toBe('encrypting');

    expect(
      deriveDmCallShield({
        ...base,
        remotePeerIds: ['bob', 'carol'],
        ackedPeerIds: new Set(['bob', 'carol']),
      }),
    ).toBe('secure');
  });

  it('group DM call: any peer failure dominates over the others acking', () => {
    expect(
      deriveDmCallShield({
        ...base,
        remotePeerIds: ['bob', 'carol'],
        ackedPeerIds: new Set(['bob']),
        failedPeerIds: new Set(['carol']),
      }),
    ).toBe('failed');
  });

  it('stale acks/failures for peers no longer in the call are ignored', () => {
    // dave acked then left; only bob remains and has acked => secure.
    expect(
      deriveDmCallShield({
        ...base,
        remotePeerIds: ['bob'],
        ackedPeerIds: new Set(['bob', 'dave']),
        failedPeerIds: new Set(['dave']),
      }),
    ).toBe('secure');
  });
});

describe('shield extensions', () => {
  it('blocked: E2EE expected but no scheme yielded a key (red, never silent)', () => {
    expect(deriveDmCallShield({ ...base, blocked: true, localKeyed: false })).toBe('blocked');
  });

  it('blocked outranks failed and acks', () => {
    expect(deriveDmCallShield({
      ...base, blocked: true, localKeyed: false,
      remotePeerIds: ['bob'], failedPeerIds: new Set(['bob']),
    })).toBe('blocked');
  });

  it('no shield when E2EE was never expected, even if blocked is set', () => {
    expect(deriveDmCallShield({ ...base, e2eeExpected: false, blocked: true, localKeyed: false })).toBe('none');
  });

  it('degraded mid-call MLS failure surfaces as failed', () => {
    expect(deriveDmCallShield({
      ...base, degraded: true, remotePeerIds: ['bob'], ackedPeerIds: new Set(['bob']),
    })).toBe('failed');
  });

  it('existing states are unchanged when blocked/degraded are false', () => {
    expect(deriveDmCallShield({ ...base, remotePeerIds: ['bob'], ackedPeerIds: new Set(['bob']) })).toBe('secure');
  });
});

describe('computeStandingAck — standing E2EE ack (re)emit decision', () => {
  it('emits when first informing a present peer (prev null)', () => {
    const r = computeStandingAck(null, ['bob'], true);
    expect(r.emit).toBe(true);
    expect(r.nextRef).toEqual({ ok: true, informed: new Set(['bob']) });
  });

  it('does not re-emit when state and roster are unchanged', () => {
    const prev = { ok: true, informed: new Set(['bob']) };
    expect(computeStandingAck(prev, ['bob'], true).emit).toBe(false);
  });

  it('resets to null and does not emit when the room drains to zero peers', () => {
    const prev = { ok: true, informed: new Set(['bob']) };
    const r = computeStandingAck(prev, [], true);
    expect(r.nextRef).toBeNull();
    expect(r.emit).toBe(false);
  });

  it('re-emits to a peer who left and rejoined (regression: stale "informed" must not suppress the rejoin ack)', () => {
    // Bob present and informed.
    let ref = computeStandingAck(null, ['bob'], true).nextRef;
    // Bob's socket drops → 1:1 room empties → ref resets to null (the fix).
    ref = computeStandingAck(ref, [], true).nextRef;
    expect(ref).toBeNull();
    // Bob rejoins on a fresh socket that missed the original broadcast → we
    // MUST re-emit our standing ack, else his shield sticks on "encrypting".
    const rejoin = computeStandingAck(ref, ['bob'], true);
    expect(rejoin.emit).toBe(true);
    expect(rejoin.nextRef).toEqual({ ok: true, informed: new Set(['bob']) });
  });

  it('emits again when our own keyed state flips', () => {
    const prev = { ok: false, informed: new Set(['bob']) };
    expect(computeStandingAck(prev, ['bob'], true).emit).toBe(true);
  });

  it('emits for a newly-present peer while keeping prior peers informed', () => {
    const prev = { ok: true, informed: new Set(['bob']) };
    const r = computeStandingAck(prev, ['bob', 'carol'], true);
    expect(r.emit).toBe(true);
    expect(r.nextRef).toEqual({ ok: true, informed: new Set(['bob', 'carol']) });
  });
});
