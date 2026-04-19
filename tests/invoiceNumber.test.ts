import { describe, it, expect, beforeEach } from 'vitest';
import { formatInvoiceNumber, nextInvoiceNumber } from '../src/invoiceNumber';

class FakeKV {
  store = new Map<string, { value: string; metadata?: any }>();
  putCount = 0;

  async getWithMetadata<T>(key: string): Promise<{ value: string | null; metadata: T | null }> {
    const entry = this.store.get(key);
    return { value: entry?.value ?? null, metadata: (entry?.metadata as T) ?? null };
  }

  async put(key: string, value: string, opts?: { metadata?: any }): Promise<void> {
    this.putCount += 1;
    this.store.set(key, { value, metadata: opts?.metadata });
  }
}

function makeEnv() {
  return { INVOICE_STATE: new FakeKV() as any };
}

describe('formatInvoiceNumber', () => {
  it('pads sequence to 4 digits', () => {
    expect(formatInvoiceNumber(2026, 1)).toBe('INV-2026-0001');
    expect(formatInvoiceNumber(2026, 42)).toBe('INV-2026-0042');
    expect(formatInvoiceNumber(2026, 9999)).toBe('INV-2026-9999');
    expect(formatInvoiceNumber(2027, 10000)).toBe('INV-2027-10000');
  });
});

describe('nextInvoiceNumber', () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    env = makeEnv();
  });

  it('starts a fresh year at 0001', async () => {
    const num = await nextInvoiceNumber(env as any, new Date('2026-01-05T00:00:00Z'));
    expect(num).toBe('INV-2026-0001');
  });

  it('increments sequentially within the same year', async () => {
    const d = new Date('2026-03-15T00:00:00Z');
    const a = await nextInvoiceNumber(env as any, d);
    const b = await nextInvoiceNumber(env as any, d);
    const c = await nextInvoiceNumber(env as any, d);
    expect(a).toBe('INV-2026-0001');
    expect(b).toBe('INV-2026-0002');
    expect(c).toBe('INV-2026-0003');
  });

  it('resets to 0001 when crossing into a new year', async () => {
    await nextInvoiceNumber(env as any, new Date('2026-12-31T23:00:00Z'));
    await nextInvoiceNumber(env as any, new Date('2026-12-31T23:30:00Z'));
    const nextYear = await nextInvoiceNumber(env as any, new Date('2027-01-01T00:05:00Z'));
    expect(nextYear).toBe('INV-2027-0001');
  });

  it('produces unique, sequential numbers under concurrency', async () => {
    const d = new Date('2026-06-01T00:00:00Z');
    const results = await Promise.all(Array.from({ length: 20 }, () => nextInvoiceNumber(env as any, d)));
    const unique = new Set(results);
    expect(unique.size).toBe(results.length);
    const sorted = [...results].sort();
    for (let i = 0; i < sorted.length; i++) {
      expect(sorted[i]).toBe(`INV-2026-${String(i + 1).padStart(4, '0')}`);
    }
  });

  it('throws on corrupt counter state', async () => {
    const e = makeEnv();
    (e.INVOICE_STATE as any).store.set('invoice:seq:2026', { value: 'not-a-number' });
    await expect(nextInvoiceNumber(e as any, new Date('2026-02-01T00:00:00Z'))).rejects.toThrow(/corrupt/);
  });
});
