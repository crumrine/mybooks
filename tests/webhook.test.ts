import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyStripeWebhook, __resetStripeClientForTest } from '../src/webhook';

const SECRET = 'whsec_test_secret_abc123';
const STRIPE_KEY = 'sk_test_dummy';

function signPayload(payload: string, secret: string, timestamp: number): string {
  const signed = `${timestamp}.${payload}`;
  const v1 = createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

describe('verifyStripeWebhook', () => {
  beforeEach(() => {
    __resetStripeClientForTest();
  });

  afterEach(() => {
    __resetStripeClientForTest();
  });

  it('rejects missing signature header with 400', async () => {
    const result = await verifyStripeWebhook('{}', null, SECRET, STRIPE_KEY);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it('rejects when no secret is configured with 500', async () => {
    const result = await verifyStripeWebhook('{}', 'sig', '', STRIPE_KEY);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });

  it('rejects an invalid signature with 401', async () => {
    const payload = JSON.stringify({ id: 'evt_1', type: 'charge.succeeded', data: { object: {} } });
    const badSig = `t=${Math.floor(Date.now() / 1000)},v1=deadbeef`;
    const result = await verifyStripeWebhook(payload, badSig, SECRET, STRIPE_KEY);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('accepts a valid signature and returns the parsed event', async () => {
    const payload = JSON.stringify({
      id: 'evt_abc',
      object: 'event',
      type: 'charge.succeeded',
      data: { object: { id: 'ch_1', customer: 'cus_1' } },
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(payload, SECRET, ts);

    const result = await verifyStripeWebhook(payload, sig, SECRET, STRIPE_KEY);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.event?.type).toBe('charge.succeeded');
    expect((result.event?.data.object as any).id).toBe('ch_1');
  });

  it('rejects a tampered payload even with a real timestamp and signature for the original', async () => {
    const original = JSON.stringify({ id: 'evt_1', type: 'charge.succeeded', data: { object: { id: 'ch_1' } } });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(original, SECRET, ts);
    const tampered = JSON.stringify({ id: 'evt_1', type: 'charge.succeeded', data: { object: { id: 'ch_EVIL' } } });

    const result = await verifyStripeWebhook(tampered, sig, SECRET, STRIPE_KEY);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('rejects a stale timestamp outside the default tolerance', async () => {
    const payload = JSON.stringify({ id: 'evt_1', type: 'charge.succeeded', data: { object: {} } });
    const ts = Math.floor(Date.now() / 1000) - 60 * 60;
    const sig = signPayload(payload, SECRET, ts);
    const result = await verifyStripeWebhook(payload, sig, SECRET, STRIPE_KEY);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });
});
