/**
 * End-to-end tests for handleStripeWebhook.
 *
 * These tests exercise the full handler path: signature verification ->
 * customer metadata fetch -> delivery-mode gate -> sendInvoice dispatch.
 * All Stripe network calls and sendInvoice are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';

// Mock sendInvoice BEFORE importing webhook so the module-level import picks up the mock.
vi.mock('../src/invoices', () => ({
  sendInvoice: vi.fn().mockResolvedValue(undefined),
}));

import { handleStripeWebhook, __resetStripeClientForTest } from '../src/webhook';
import { sendInvoice } from '../src/invoices';

// ---- helpers ----------------------------------------------------------------

const SECRET = 'whsec_e2e_test_secret';
const STRIPE_KEY = 'sk_test_dummy';

function signPayload(payload: string, secret: string, timestamp: number): string {
  const signed = `${timestamp}.${payload}`;
  const v1 = createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

function makeChargeEvent(customerId: string, chargeId: string): string {
  return JSON.stringify({
    id: 'evt_test_01',
    object: 'event',
    type: 'charge.succeeded',
    data: {
      object: {
        id: chargeId,
        object: 'charge',
        customer: customerId,
        amount: 5000,
        currency: 'usd',
      },
    },
  });
}

function makeApp() {
  const app = new Hono<{ Bindings: any }>();
  app.post('/webhook/stripe', handleStripeWebhook);
  return app;
}

function makeFakeDB() {
  const seen = new Set<string>();
  return {
    seen,
    prepare(_sql: string) {
      return {
        bind(id: string, _type: string, _ts: number) {
          return {
            async run() {
              const changes = seen.has(id) ? 0 : 1;
              seen.add(id);
              return { meta: { changes } };
            },
          };
        },
      };
    },
  };
}

function makeEnv(db = makeFakeDB()) {
  return {
    STRIPE_API_KEY: STRIPE_KEY,
    STRIPE_WEBHOOK_SECRET: SECRET,
    APP_DOMAIN: 'billing.example.com',
    DB: db as any,
  };
}

/**
 * Build a minimal ExecutionContext mock that captures waitUntil promises
 * so we can assert whether sendInvoice was queued.
 */
function makeFakeCtx() {
  const waitUntilCalls: Promise<any>[] = [];
  return {
    waitUntil: vi.fn((p: Promise<any>) => { waitUntilCalls.push(p); }),
    passThroughOnException: vi.fn(),
    _waitUntilCalls: waitUntilCalls,
  };
}

// ---- Stripe SDK stub --------------------------------------------------------
// webhook.ts uses a cached Stripe singleton. We mock the entire Stripe
// constructor so both constructEventAsync and customers.retrieve are under
// our control without any network calls.

let stripeCustomersRetrieve: ReturnType<typeof vi.fn>;
let stripeConstructEventAsync: ReturnType<typeof vi.fn>;

vi.mock('stripe', () => {
  // The mock factory is called once; the mocked functions are set in beforeEach.
  const MockStripe = vi.fn().mockImplementation(() => ({
    webhooks: {
      constructEventAsync: (...args: any[]) => stripeConstructEventAsync(...args),
    },
    customers: {
      retrieve: (...args: any[]) => stripeCustomersRetrieve(...args),
    },
  }));
  return { default: MockStripe };
});

// ---- test suite -------------------------------------------------------------

describe('handleStripeWebhook (end-to-end handler)', () => {
  let app: ReturnType<typeof makeApp>;
  let fakeCtx: ReturnType<typeof makeFakeCtx>;

  beforeEach(() => {
    __resetStripeClientForTest();
    vi.mocked(sendInvoice).mockClear();

    // Default: constructEventAsync succeeds by parsing the raw body.
    stripeConstructEventAsync = vi.fn().mockImplementation(async (rawBody: string) => {
      return JSON.parse(rawBody) as any;
    });

    // Default: customer has no special delivery mode.
    stripeCustomersRetrieve = vi.fn().mockResolvedValue({
      id: 'cus_default',
      deleted: false,
      metadata: {},
    });

    app = makeApp();
    fakeCtx = makeFakeCtx();
  });

  afterEach(() => {
    __resetStripeClientForTest();
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // 1. Invalid signature -> 401 from the handler itself
  // --------------------------------------------------------------------------
  it('returns 401 when the signature is invalid', async () => {
    stripeConstructEventAsync = vi.fn().mockRejectedValue(
      new Error('No signatures found matching the expected signature for payload'),
    );

    const payload = makeChargeEvent('cus_1', 'ch_1');
    const req = new Request('http://localhost/webhook/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'v1=badhash,t=1234567890' },
      body: payload,
    });

    const res = await app.fetch(req, makeEnv(), fakeCtx as any);
    expect(res.status).toBe(401);
    expect(fakeCtx.waitUntil).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 2. Missing signature -> 400
  // --------------------------------------------------------------------------
  it('returns 400 when the stripe-signature header is absent', async () => {
    const payload = makeChargeEvent('cus_1', 'ch_1');
    const req = new Request('http://localhost/webhook/stripe', {
      method: 'POST',
      // No stripe-signature header
      body: payload,
    });

    const res = await app.fetch(req, makeEnv(), fakeCtx as any);
    expect(res.status).toBe(400);
    expect(fakeCtx.waitUntil).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 3. auto_charge_silent -> suppressed, no sendInvoice
  // --------------------------------------------------------------------------
  it('suppresses invoice send for auto_charge_silent customer and returns 200', async () => {
    stripeCustomersRetrieve = vi.fn().mockResolvedValue({
      id: 'cus_silent',
      deleted: false,
      metadata: { delivery_mode: 'auto_charge_silent' },
    });

    const payload = makeChargeEvent('cus_silent', 'ch_silent');
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(payload, SECRET, ts);

    // Override constructEventAsync to also verify the real sig check path is
    // wired up -- we let it succeed by returning the parsed event.
    stripeConstructEventAsync = vi.fn().mockResolvedValue(JSON.parse(payload));

    const req = new Request('http://localhost/webhook/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': sig },
      body: payload,
    });

    const res = await app.fetch(req, makeEnv(), fakeCtx as any);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.message).toMatch(/suppressed/i);
    expect(fakeCtx.waitUntil).not.toHaveBeenCalled();
    expect(sendInvoice).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 4. pdf_invoice -> sendInvoice is queued via waitUntil
  // --------------------------------------------------------------------------
  it('queues sendInvoice via waitUntil for pdf_invoice customer', async () => {
    stripeCustomersRetrieve = vi.fn().mockResolvedValue({
      id: 'cus_pdf',
      deleted: false,
      metadata: { delivery_mode: 'pdf_invoice' },
    });

    const payload = makeChargeEvent('cus_pdf', 'ch_pdf');
    stripeConstructEventAsync = vi.fn().mockResolvedValue(JSON.parse(payload));

    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(payload, SECRET, ts);

    const req = new Request('http://localhost/webhook/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': sig },
      body: payload,
    });

    const res = await app.fetch(req, makeEnv(), fakeCtx as any);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.message).toMatch(/queued/i);
    expect(fakeCtx.waitUntil).toHaveBeenCalledOnce();
  });

  // --------------------------------------------------------------------------
  // 5. Missing metadata (null) defaults to pdf_invoice -> queues sendInvoice
  // --------------------------------------------------------------------------
  it('defaults to pdf_invoice when customer metadata is null', async () => {
    stripeCustomersRetrieve = vi.fn().mockResolvedValue({
      id: 'cus_nometa',
      deleted: false,
      metadata: null,
    });

    const payload = makeChargeEvent('cus_nometa', 'ch_nometa');
    stripeConstructEventAsync = vi.fn().mockResolvedValue(JSON.parse(payload));

    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(payload, SECRET, ts);

    const req = new Request('http://localhost/webhook/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': sig },
      body: payload,
    });

    const res = await app.fetch(req, makeEnv(), fakeCtx as any);
    expect(res.status).toBe(200);
    expect(fakeCtx.waitUntil).toHaveBeenCalledOnce();
  });

  // --------------------------------------------------------------------------
  // 6. Charge with no customer -> skipped gracefully
  // --------------------------------------------------------------------------
  it('returns 200 and skips processing when charge has no customer', async () => {
    const payload = JSON.stringify({
      id: 'evt_nocust',
      object: 'event',
      type: 'charge.succeeded',
      data: {
        object: { id: 'ch_nocust', object: 'charge', customer: null, amount: 100, currency: 'usd' },
      },
    });
    stripeConstructEventAsync = vi.fn().mockResolvedValue(JSON.parse(payload));

    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(payload, SECRET, ts);

    const req = new Request('http://localhost/webhook/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': sig },
      body: payload,
    });

    const res = await app.fetch(req, makeEnv(), fakeCtx as any);
    expect(res.status).toBe(200);
    expect(fakeCtx.waitUntil).not.toHaveBeenCalled();
    expect(stripeCustomersRetrieve).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 7. Non-charge event type -> ignored, no sendInvoice
  // --------------------------------------------------------------------------
  it('ignores non charge.succeeded event types', async () => {
    const payload = JSON.stringify({
      id: 'evt_other',
      object: 'event',
      type: 'customer.updated',
      data: { object: { id: 'cus_1' } },
    });
    stripeConstructEventAsync = vi.fn().mockResolvedValue(JSON.parse(payload));

    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(payload, SECRET, ts);

    const req = new Request('http://localhost/webhook/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': sig },
      body: payload,
    });

    const res = await app.fetch(req, makeEnv(), fakeCtx as any);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.message).toMatch(/ignored/i);
    expect(fakeCtx.waitUntil).not.toHaveBeenCalled();
  });

  it('short-circuits duplicate event IDs idempotently', async () => {
    stripeCustomersRetrieve = vi.fn().mockResolvedValue({ id: 'cus_dup', deleted: false, metadata: {} });
    const payload = makeChargeEvent('cus_dup', 'ch_dup');
    stripeConstructEventAsync = vi.fn().mockResolvedValue(JSON.parse(payload));

    const db = makeFakeDB();
    const env = makeEnv(db);
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(payload, SECRET, ts);

    const first = await app.fetch(
      new Request('http://localhost/webhook/stripe', { method: 'POST', headers: { 'stripe-signature': sig }, body: payload }),
      env,
      fakeCtx as any,
    );
    expect(first.status).toBe(200);
    expect(fakeCtx.waitUntil).toHaveBeenCalledTimes(1);

    const second = await app.fetch(
      new Request('http://localhost/webhook/stripe', { method: 'POST', headers: { 'stripe-signature': sig }, body: payload }),
      env,
      fakeCtx as any,
    );
    const body = await second.json() as any;
    expect(second.status).toBe(200);
    expect(body.message).toMatch(/duplicate/i);
    expect(fakeCtx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('defaults to pdf_invoice and queues send when customer metadata fetch fails', async () => {
    stripeCustomersRetrieve = vi.fn().mockRejectedValue(new Error('Stripe network error'));

    const payload = makeChargeEvent('cus_fetchfail', 'ch_fetchfail');
    stripeConstructEventAsync = vi.fn().mockResolvedValue(JSON.parse(payload));

    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(payload, SECRET, ts);

    const req = new Request('http://localhost/webhook/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': sig },
      body: payload,
    });

    const res = await app.fetch(req, makeEnv(), fakeCtx as any);
    expect(res.status).toBe(200);
    expect(fakeCtx.waitUntil).toHaveBeenCalledOnce();
  });
});
