import { describe, it, expect, beforeEach } from 'vitest';
import { formatInvoiceNumber, nextInvoiceNumber } from '../src/invoiceNumber';

class FakeD1 {
  rows = new Map<number, number>();

  prepare(sql: string) {
    return new FakeStmt(this, sql);
  }
}

class FakeStmt {
  constructor(private db: FakeD1, private sql: string, private args: unknown[] = []) {}

  bind(...args: unknown[]) {
    return new FakeStmt(this.db, this.sql, args);
  }

  async first<T>(): Promise<T | null> {
    const s = this.sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('INSERT INTO invoice_counter')) {
      const year = this.args[0] as number;
      const current = this.db.rows.get(year) ?? 0;
      const next = current + 1;
      this.db.rows.set(year, next);
      return { seq: next } as T;
    }
    throw new Error(`unrecognized SQL in fake D1: ${s}`);
  }
}

function makeEnv() {
  return { DB: new FakeD1() as any };
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

  it('produces unique sequential numbers for serialized calls', async () => {
    const d = new Date('2026-06-01T00:00:00Z');
    const results: string[] = [];
    for (let i = 0; i < 20; i++) {
      results.push(await nextInvoiceNumber(env as any, d));
    }
    const unique = new Set(results);
    expect(unique.size).toBe(results.length);
    for (let i = 0; i < results.length; i++) {
      expect(results[i]).toBe(`INV-2026-${String(i + 1).padStart(4, '0')}`);
    }
  });

  it('throws when D1 returns no row', async () => {
    const brokenDB = {
      prepare: () => ({ bind: () => ({ first: async () => null }) }),
    };
    await expect(nextInvoiceNumber({ DB: brokenDB as any }, new Date('2026-02-01T00:00:00Z'))).rejects.toThrow(
      /Failed to allocate/,
    );
  });
});
