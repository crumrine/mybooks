import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/auth', () => ({
  requireSession: () => async (_c: any, next: any) => next(),
}));

const stripeMocks = {
  createItem: vi.fn(),
  deleteItem: vi.fn(),
};
vi.mock('stripe', () => {
  const Mock = vi.fn().mockImplementation(() => ({
    invoiceItems: {
      create: (...args: any[]) => stripeMocks.createItem(...args),
      del: (...args: any[]) => stripeMocks.deleteItem(...args),
    },
  }));
  return { default: Mock };
});

import timeRoutes from '../src/timeEntries';

interface Row {
  id: string;
  customer_id: string;
  minutes: number;
  description: string | null;
  entry_date: string;
  billable: number;
  status: string;
  stripe_invoice_item_id: string | null;
  stripe_invoice_id: string | null;
  pushed_at: number | null;
  billed_at: number | null;
  voided_at: number | null;
  created_at: number;
  updated_at: number;
}

class FakeD1 {
  store = new Map<string, Row>();
  clientMeta = new Map<string, { hourly_rate_cents: number | null }>();

  prepare(sql: string) {
    return new FakeStmt(this, sql);
  }
}

class FakeStmt {
  constructor(private db: FakeD1, private sql: string, private args: any[] = []) {}
  bind(...args: any[]) {
    return new FakeStmt(this.db, this.sql, args);
  }
  private norm() {
    return this.sql.replace(/\s+/g, ' ').trim();
  }
  async first<T>(): Promise<T | null> {
    const s = this.norm();
    if (s.startsWith('SELECT hourly_rate_cents FROM client_metadata')) {
      const [cid] = this.args;
      return (this.db.clientMeta.get(cid) as T) ?? null;
    }
    if (s.startsWith('SELECT * FROM time_entries WHERE id =')) {
      const [id] = this.args;
      return (this.db.store.get(id) as T) ?? null;
    }
    if (s.startsWith('INSERT INTO time_entries')) {
      const [id, customer_id, minutes, description, entry_date, billable, now] = this.args;
      const row: Row = {
        id,
        customer_id,
        minutes,
        description: description ?? null,
        entry_date,
        billable,
        status: 'draft',
        stripe_invoice_item_id: null,
        stripe_invoice_id: null,
        pushed_at: null,
        billed_at: null,
        voided_at: null,
        created_at: now,
        updated_at: now,
      };
      this.db.store.set(id, row);
      return row as T;
    }
    if (s.startsWith('UPDATE time_entries SET minutes')) {
      const [id, minutes, descFlag, description, entry_date, billable, now] = this.args;
      const row = this.db.store.get(id);
      if (!row) return null;
      if (minutes !== null) row.minutes = minutes;
      if (descFlag === 1) row.description = description;
      if (entry_date !== null) row.entry_date = entry_date;
      if (billable !== null) row.billable = billable;
      row.updated_at = now;
      return row as T;
    }
    if (s.startsWith("UPDATE time_entries SET status = 'voided'")) {
      const [id, now] = this.args;
      const row = this.db.store.get(id);
      if (!row || row.status !== 'draft') return null;
      row.status = 'voided';
      row.voided_at = now;
      row.updated_at = now;
      return row as T;
    }
    return null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    const s = this.norm();
    if (s.startsWith('SELECT * FROM time_entries WHERE id IN')) {
      const rows = this.args
        .map((id) => this.db.store.get(id))
        .filter((r): r is Row => r !== undefined);
      return { results: rows as unknown as T[] };
    }
    if (s.startsWith('SELECT * FROM time_entries') && s.includes('ORDER BY')) {
      let rows = [...this.db.store.values()];
      let argIdx = 0;
      if (s.includes('customer_id = ?')) {
        const expect = this.args[argIdx++];
        rows = rows.filter((r) => r.customer_id === expect);
      }
      if (s.includes('status = ?')) {
        const expect = this.args[argIdx++];
        rows = rows.filter((r) => r.status === expect);
      }
      rows.sort((a, b) => (b.entry_date.localeCompare(a.entry_date)) || (b.created_at - a.created_at));
      const limit = this.args[this.args.length - 1];
      return { results: rows.slice(0, limit) as T[] };
    }
    return { results: [] };
  }
  async run() {
    const s = this.norm();
    if (s.startsWith("UPDATE time_entries SET status = 'pushed'")) {
      const [id, itemId, now] = this.args;
      const row = this.db.store.get(id);
      if (!row || row.status !== 'draft') return { meta: { changes: 0 } };
      row.status = 'pushed';
      row.stripe_invoice_item_id = itemId;
      row.pushed_at = now;
      row.updated_at = now;
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE time_entries SET status = 'draft'")) {
      let changes = 0;
      const ids = this.args.slice(0, this.args.length - 1) as string[];
      const now = this.args[this.args.length - 1] as number;
      for (const id of ids) {
        const row = this.db.store.get(id);
        if (row && row.status === 'pushed') {
          row.status = 'draft';
          row.stripe_invoice_item_id = null;
          row.pushed_at = null;
          row.updated_at = now;
          changes++;
        }
      }
      return { meta: { changes } };
    }
    return { meta: { changes: 0 } };
  }
}

function makeApp(db: FakeD1) {
  const app = new Hono<{ Bindings: any }>();
  app.route('/', timeRoutes as any);
  return {
    fetch(path: string, init?: RequestInit) {
      const req = new Request(`http://test${path}`, init);
      const env = {
        DB: db as any,
        AXIOM_TOKEN: '',
        AXIOM_DATASET: '',
        STRIPE_API_KEY: 'sk_test_dummy',
      };
      return app.fetch(req, env as any, { waitUntil: () => {} } as any);
    },
  };
}

describe('POST /api/time', () => {
  let db: FakeD1;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    db = new FakeD1();
    app = makeApp(db);
  });

  it('creates a single entry', async () => {
    const res = await app.fetch('/api/time', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customer_id: 'cus_abc', minutes: 45, entry_date: '2026-04-19', description: 'design review' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].customer_id).toBe('cus_abc');
    expect(body.entries[0].minutes).toBe(45);
    expect(body.entries[0].status).toBe('draft');
    expect(body.entries[0].billable).toBe(true);
    expect(body.entries[0].id).toMatch(/^te_/);
  });

  it('accepts a batch of entries', async () => {
    const res = await app.fetch('/api/time', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([
        { customer_id: 'cus_a', minutes: 30, entry_date: '2026-04-19' },
        { customer_id: 'cus_b', minutes: 60, entry_date: '2026-04-19', billable: false },
      ]),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.entries).toHaveLength(2);
    expect(body.entries[1].billable).toBe(false);
  });

  it('is idempotent on client-supplied id', async () => {
    const payload = { id: 'te_client_1', customer_id: 'cus_a', minutes: 15, entry_date: '2026-04-19' };
    const first = await (await app.fetch('/api/time', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json() as any;
    const second = await (await app.fetch('/api/time', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json() as any;
    expect(first.entries[0].id).toBe('te_client_1');
    expect(second.entries[0].id).toBe('te_client_1');
    expect(second.skipped).toEqual([{ id: 'te_client_1', reason: 'already_exists' }]);
    expect(db.store.size).toBe(1);
  });

  it.each([
    ['missing customer_id', { minutes: 30, entry_date: '2026-04-19' }],
    ['non-Stripe customer id', { customer_id: 'nope', minutes: 30, entry_date: '2026-04-19' }],
    ['zero minutes', { customer_id: 'cus_a', minutes: 0, entry_date: '2026-04-19' }],
    ['negative minutes', { customer_id: 'cus_a', minutes: -1, entry_date: '2026-04-19' }],
    ['over 24h minutes', { customer_id: 'cus_a', minutes: 60 * 24 + 1, entry_date: '2026-04-19' }],
    ['bad date shape', { customer_id: 'cus_a', minutes: 30, entry_date: '04-19-2026' }],
    ['non-boolean billable', { customer_id: 'cus_a', minutes: 30, entry_date: '2026-04-19', billable: 'yes' }],
  ])('rejects %s', async (_, payload) => {
    const res = await app.fetch('/api/time', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
  });

  it('rejects batches over the cap', async () => {
    const big = Array.from({ length: 201 }, () => ({ customer_id: 'cus_a', minutes: 5, entry_date: '2026-04-19' }));
    const res = await app.fetch('/api/time', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(big),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/time filtering', () => {
  it('filters by customer_id and status', async () => {
    const db = new FakeD1();
    const app = makeApp(db);
    await app.fetch('/api/time', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([
      { customer_id: 'cus_a', minutes: 10, entry_date: '2026-04-19' },
      { customer_id: 'cus_a', minutes: 20, entry_date: '2026-04-18' },
      { customer_id: 'cus_b', minutes: 30, entry_date: '2026-04-19' },
    ])});
    const res = await app.fetch('/api/time?customer_id=cus_a&status=draft');
    const body = await res.json() as any;
    expect(body.entries).toHaveLength(2);
    expect(body.entries.every((e: any) => e.customer_id === 'cus_a')).toBe(true);
  });

  it('rejects invalid status', async () => {
    const db = new FakeD1();
    const app = makeApp(db);
    const res = await app.fetch('/api/time?status=invented');
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/time/:id', () => {
  it('updates a draft entry', async () => {
    const db = new FakeD1();
    const app = makeApp(db);
    const created = await (await app.fetch('/api/time', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customer_id: 'cus_a', minutes: 30, entry_date: '2026-04-19', description: 'orig' }) })).json() as any;
    const id = created.entries[0].id;
    const patched = await (await app.fetch(`/api/time/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minutes: 45, description: 'new' }) })).json() as any;
    expect(patched.minutes).toBe(45);
    expect(patched.description).toBe('new');
  });

  it('refuses to edit non-draft entry', async () => {
    const db = new FakeD1();
    const app = makeApp(db);
    const created = await (await app.fetch('/api/time', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customer_id: 'cus_a', minutes: 30, entry_date: '2026-04-19' }) })).json() as any;
    const id = created.entries[0].id;
    db.store.get(id)!.status = 'pushed';
    const res = await app.fetch(`/api/time/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minutes: 99 }) });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/time/push', () => {
  let db: FakeD1;
  let app: ReturnType<typeof makeApp>;
  let itemCounter: number;

  beforeEach(() => {
    db = new FakeD1();
    app = makeApp(db);
    itemCounter = 0;
    stripeMocks.createItem.mockReset();
    stripeMocks.deleteItem.mockReset();
    stripeMocks.createItem.mockImplementation(async ({ customer, amount }: any) => {
      itemCounter++;
      return { id: `ii_test_${itemCounter}`, customer, amount };
    });
  });

  async function seedEntry(overrides: Partial<Row> = {}): Promise<Row> {
    const res = await (await app.fetch('/api/time', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customer_id: 'cus_a', minutes: 60, entry_date: '2026-04-19', description: 'work', ...overrides }),
    })).json() as any;
    const row = db.store.get(res.entries[0].id)!;
    Object.assign(row, overrides);
    return row;
  }

  it('pushes entries using client hourly rate', async () => {
    db.clientMeta.set('cus_a', { hourly_rate_cents: 15000 });
    const a = await seedEntry();
    const b = await seedEntry({});
    const res = await app.fetch('/api/time/push', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry_ids: [a.id, b.id] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.pushed).toHaveLength(2);
    expect(body.pushed[0].amount_cents).toBe(15000);
    expect(stripeMocks.createItem).toHaveBeenCalledTimes(2);
    expect(db.store.get(a.id)!.status).toBe('pushed');
    expect(db.store.get(a.id)!.stripe_invoice_item_id).toBe('ii_test_1');
  });

  it('accepts rate_cents override', async () => {
    const a = await seedEntry({ minutes: 30 });
    const res = await (await app.fetch('/api/time/push', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry_ids: [a.id], rate_cents: 20000 }),
    })).json() as any;
    expect(res.pushed[0].amount_cents).toBe(10000);
  });

  it('rejects if rate missing and no override', async () => {
    const a = await seedEntry();
    const res = await app.fetch('/api/time/push', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry_ids: [a.id] }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects when entries span multiple customers', async () => {
    db.clientMeta.set('cus_a', { hourly_rate_cents: 10000 });
    const a = await seedEntry();
    const b = await seedEntry({ customer_id: 'cus_b' });
    db.store.get(b.id)!.customer_id = 'cus_b';
    const res = await app.fetch('/api/time/push', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry_ids: [a.id, b.id] }),
    });
    expect(res.status).toBe(400);
  });

  it('rolls back partial failure', async () => {
    db.clientMeta.set('cus_a', { hourly_rate_cents: 10000 });
    const a = await seedEntry();
    const b = await seedEntry();
    stripeMocks.createItem.mockImplementationOnce(async () => ({ id: 'ii_ok_1', customer: 'cus_a', amount: 10000 }));
    stripeMocks.createItem.mockImplementationOnce(async () => { throw new Error('stripe boom'); });
    const res = await app.fetch('/api/time/push', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry_ids: [a.id, b.id] }),
    });
    expect(res.status).toBe(500);
    expect(stripeMocks.deleteItem).toHaveBeenCalledWith('ii_ok_1');
    expect(db.store.get(a.id)!.status).toBe('draft');
    expect(db.store.get(a.id)!.stripe_invoice_item_id).toBeNull();
    expect(db.store.get(b.id)!.status).toBe('draft');
  });

  it('refuses non-draft entries', async () => {
    db.clientMeta.set('cus_a', { hourly_rate_cents: 10000 });
    const a = await seedEntry();
    db.store.get(a.id)!.status = 'pushed';
    const res = await app.fetch('/api/time/push', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry_ids: [a.id] }),
    });
    expect(res.status).toBe(409);
  });

  it('refuses non-billable entries', async () => {
    db.clientMeta.set('cus_a', { hourly_rate_cents: 10000 });
    const a = await seedEntry();
    db.store.get(a.id)!.billable = 0;
    const res = await app.fetch('/api/time/push', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry_ids: [a.id] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/time/:id (soft void)', () => {
  it('voids a draft entry', async () => {
    const db = new FakeD1();
    const app = makeApp(db);
    const created = await (await app.fetch('/api/time', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customer_id: 'cus_a', minutes: 30, entry_date: '2026-04-19' }) })).json() as any;
    const id = created.entries[0].id;
    const del = await (await app.fetch(`/api/time/${id}`, { method: 'DELETE' })).json() as any;
    expect(del.status).toBe('voided');
    expect(del.voided_at).toBeGreaterThan(0);
  });

  it('refuses to void non-draft', async () => {
    const db = new FakeD1();
    const app = makeApp(db);
    const created = await (await app.fetch('/api/time', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customer_id: 'cus_a', minutes: 30, entry_date: '2026-04-19' }) })).json() as any;
    const id = created.entries[0].id;
    db.store.get(id)!.status = 'billed';
    const res = await app.fetch(`/api/time/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
