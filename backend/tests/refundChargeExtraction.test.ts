// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression test for the Stripe API 2026-02-25.clover refund-eligibility break.
 *
 * Pre-fix, `findEligibleCharge` in billing.ts read `(inv as any).charge` from
 * the result of `stripe.invoices.list()`. The `.charge` field was removed from
 * the Invoice object in API 2026-02-25.clover (the SDK v20.3.1 default), so
 * every subscription and power-up refund-eligibility check returned
 * `{ eligible: false, reason: 'no_eligible_charge' }` even when a paid charge
 * existed within the 5-day window.
 *
 * Post-fix, charge IDs are extracted from `Invoice.payments` (an ApiList of
 * InvoicePayment) — handling both `payment.type === 'charge'` (legacy) and
 * `payment.type === 'payment_intent'` (the common case, requires resolving the
 * PI to read its `latest_charge`). The exported helper is unit-tested here so
 * a future Stripe SDK upgrade that shifts the shape again will fail loudly.
 */

import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import { getInvoiceChargeIds } from '../src/routes/billing.js';

function makeStripe(piMap: Record<string, Partial<Stripe.PaymentIntent>>): Stripe {
  return {
    paymentIntents: {
      retrieve: vi.fn(async (id: string) => {
        if (!(id in piMap)) throw new Error(`PI not found: ${id}`);
        return piMap[id] as Stripe.PaymentIntent;
      }),
    },
  } as unknown as Stripe;
}

function makeInvoice(payments: Array<Partial<Stripe.InvoicePayment>> | undefined): Stripe.Invoice {
  const inv: Partial<Stripe.Invoice> = {
    status: 'paid',
    payments: payments
      ? ({ data: payments as Stripe.InvoicePayment[], has_more: false } as Stripe.ApiList<Stripe.InvoicePayment>)
      : undefined,
  };
  return inv as Stripe.Invoice;
}

describe('getInvoiceChargeIds — Stripe API 2026-02-25.clover regression', () => {
  it('extracts charge id from a payment_intent-type InvoicePayment via latest_charge', async () => {
    const stripe = makeStripe({
      pi_abc: { id: 'pi_abc', latest_charge: 'ch_xyz' },
    });
    const invoice = makeInvoice([
      {
        status: 'paid',
        payment: { type: 'payment_intent', payment_intent: 'pi_abc' } as Stripe.InvoicePayment.Payment,
      },
    ]);

    const ids = await getInvoiceChargeIds(stripe, invoice);

    expect(ids).toEqual(['ch_xyz']);
  });

  it('extracts charge id from a charge-type InvoicePayment directly (no PI lookup)', async () => {
    const retrieveSpy = vi.fn();
    const stripe = { paymentIntents: { retrieve: retrieveSpy } } as unknown as Stripe;
    const invoice = makeInvoice([
      {
        status: 'paid',
        payment: { type: 'charge', charge: 'ch_direct' } as Stripe.InvoicePayment.Payment,
      },
    ]);

    const ids = await getInvoiceChargeIds(stripe, invoice);

    expect(ids).toEqual(['ch_direct']);
    expect(retrieveSpy).not.toHaveBeenCalled();
  });

  it('returns [] when invoice.payments is missing (caller forgot to expand)', async () => {
    const stripe = makeStripe({});
    const invoice = makeInvoice(undefined);

    const ids = await getInvoiceChargeIds(stripe, invoice);

    expect(ids).toEqual([]);
  });

  it('returns [] when invoice.payments.data is empty', async () => {
    const stripe = makeStripe({});
    const invoice = makeInvoice([]);

    const ids = await getInvoiceChargeIds(stripe, invoice);

    expect(ids).toEqual([]);
  });

  it('skips InvoicePayment entries whose status is not "paid"', async () => {
    const stripe = makeStripe({ pi_open: { id: 'pi_open', latest_charge: 'ch_should_not_appear' } });
    const invoice = makeInvoice([
      {
        status: 'open',
        payment: { type: 'payment_intent', payment_intent: 'pi_open' } as Stripe.InvoicePayment.Payment,
      },
    ]);

    const ids = await getInvoiceChargeIds(stripe, invoice);

    expect(ids).toEqual([]);
  });

  it('skips PI-type payments whose PaymentIntent has no latest_charge', async () => {
    const stripe = makeStripe({
      pi_no_charge: { id: 'pi_no_charge', latest_charge: null },
    });
    const invoice = makeInvoice([
      {
        status: 'paid',
        payment: { type: 'payment_intent', payment_intent: 'pi_no_charge' } as Stripe.InvoicePayment.Payment,
      },
    ]);

    const ids = await getInvoiceChargeIds(stripe, invoice);

    expect(ids).toEqual([]);
  });

  it('does not crash when paymentIntents.retrieve throws — skips that entry', async () => {
    const stripe = {
      paymentIntents: {
        retrieve: vi.fn(async () => { throw new Error('Stripe transient error'); }),
      },
    } as unknown as Stripe;
    const invoice = makeInvoice([
      {
        status: 'paid',
        payment: { type: 'payment_intent', payment_intent: 'pi_will_throw' } as Stripe.InvoicePayment.Payment,
      },
    ]);

    const ids = await getInvoiceChargeIds(stripe, invoice);

    expect(ids).toEqual([]);
  });

  it('returns all charge ids when an invoice has multiple paid payments (e.g. retries)', async () => {
    const stripe = makeStripe({
      pi_first: { id: 'pi_first', latest_charge: 'ch_first' },
      pi_second: { id: 'pi_second', latest_charge: 'ch_second' },
    });
    const invoice = makeInvoice([
      {
        status: 'paid',
        payment: { type: 'payment_intent', payment_intent: 'pi_first' } as Stripe.InvoicePayment.Payment,
      },
      {
        status: 'paid',
        payment: { type: 'payment_intent', payment_intent: 'pi_second' } as Stripe.InvoicePayment.Payment,
      },
    ]);

    const ids = await getInvoiceChargeIds(stripe, invoice);

    expect(ids).toEqual(['ch_first', 'ch_second']);
  });

  it('handles latest_charge as an expanded Charge object, not just a string id', async () => {
    const stripe = makeStripe({
      pi_expanded: {
        id: 'pi_expanded',
        latest_charge: { id: 'ch_expanded' } as Stripe.Charge,
      },
    });
    const invoice = makeInvoice([
      {
        status: 'paid',
        payment: { type: 'payment_intent', payment_intent: 'pi_expanded' } as Stripe.InvoicePayment.Payment,
      },
    ]);

    const ids = await getInvoiceChargeIds(stripe, invoice);

    expect(ids).toEqual(['ch_expanded']);
  });

  it('handles charge-type payment where payment.charge is an expanded Charge object', async () => {
    const stripe = makeStripe({});
    const invoice = makeInvoice([
      {
        status: 'paid',
        payment: { type: 'charge', charge: { id: 'ch_object' } as Stripe.Charge } as Stripe.InvoicePayment.Payment,
      },
    ]);

    const ids = await getInvoiceChargeIds(stripe, invoice);

    expect(ids).toEqual(['ch_object']);
  });
});
