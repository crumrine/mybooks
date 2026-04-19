import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/auth', () => ({
  requireSession: () => async (_c: any, next: any) => next(),
}));

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
