import { Hono } from 'hono';
import Stripe from 'stripe';
import type { AppBindings } from './index';
import { requireSession, type AuthEnv, type SessionClaims } from './auth';
import { createAxiomLogger, describeError, type AxiomEnv } from './axiom';

let cachedStripe: Stripe | null = null;
function stripeClient(apiKey: string): Stripe {
  if (!cachedStripe) cachedStripe = new Stripe(apiKey, { apiVersion: '2025-08-27.basil', typescript: true });
  return cachedStripe;
}

export type TimeEntryStatus = 'draft' | 'pushed' | 'billed' | 'voided';
const VALID_STATUSES: readonly TimeEntryStatus[] = ['draft', 'pushed', 'billed', 'voided'];
const ENTRY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MINUTES_PER_ENTRY = 60 * 24;
const MAX_BATCH_SIZE = 200;

export interface TimeEntryRow {
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

export function rowToEntry(r: TimeEntryRow) {
  return {
    id: r.id,
    customer_id: r.customer_id,
    minutes: r.minutes,
    description: r.description,
    entry_date: r.entry_date,
    billable: r.billable === 1,
    status: r.status,
    stripe_invoice_item_id: r.stripe_invoice_item_id,
    stripe_invoice_id: r.stripe_invoice_id,
    pushed_at: r.pushed_at,
    billed_at: r.billed_at,
    voided_at: r.voided_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export interface NewEntry {
  id?: string;
  customer_id: string;
  minutes: number;
  description?: string | null;
  entry_date: string;
  billable?: boolean;
  client_created_at?: number;
}

function validateNewEntry(e: unknown): { ok: true; value: NewEntry } | { ok: false; error: string } {
  if (!e || typeof e !== 'object') return { ok: false, error: 'entry must be an object' };
  const o = e as Record<string, unknown>;
  if (typeof o.customer_id !== 'string' || !o.customer_id.startsWith('cus_')) {
    return { ok: false, error: 'customer_id must be a Stripe customer id' };
  }
  if (typeof o.minutes !== 'number' || !Number.isInteger(o.minutes) || o.minutes <= 0 || o.minutes > MAX_MINUTES_PER_ENTRY) {
    return { ok: false, error: `minutes must be an integer between 1 and ${MAX_MINUTES_PER_ENTRY}` };
  }
  if (typeof o.entry_date !== 'string' || !ENTRY_DATE_RE.test(o.entry_date)) {
    return { ok: false, error: 'entry_date must be YYYY-MM-DD' };
  }
  if (o.description != null && typeof o.description !== 'string') {
    return { ok: false, error: 'description must be a string' };
  }
  if (o.billable != null && typeof o.billable !== 'boolean') {
    return { ok: false, error: 'billable must be a boolean' };
  }
  if (o.id != null && (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > 64)) {
    return { ok: false, error: 'id must be a non-empty string' };
  }
  return {
    ok: true,
    value: {
      id: (o.id as string | undefined) ?? undefined,
      customer_id: o.customer_id,
      minutes: o.minutes,
      description: (o.description as string | null | undefined) ?? null,
      entry_date: o.entry_date,
      billable: (o.billable as boolean | undefined) ?? true,
      client_created_at: typeof o.client_created_at === 'number' ? o.client_created_at : undefined,
    },
  };
}

function newId(): string {
  return `te_${crypto.randomUUID().replace(/-/g, '')}`;
}

type Vars = { Bindings: AppBindings & AuthEnv & AxiomEnv; Variables: { session: SessionClaims } };

const time = new Hono<Vars>();

time.use('/api/time', requireSession());
time.use('/api/time/*', requireSession());

time.post('/api/time', async (c) => {
  const log = createAxiomLogger(c.env, {
    component: 'time.create',
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400 as any);
  }

  const rawList = Array.isArray(body) ? body : [body];
  if (rawList.length === 0) return c.json({ entries: [] });
  if (rawList.length > MAX_BATCH_SIZE) return c.json({ error: `batch exceeds ${MAX_BATCH_SIZE}` }, 400 as any);

  const validated: NewEntry[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const res = validateNewEntry(rawList[i]);
    if (!res.ok) return c.json({ error: `entry[${i}]: ${res.error}` }, 400 as any);
    validated.push(res.value);
  }

  const now = Date.now();
  const created: ReturnType<typeof rowToEntry>[] = [];
  const skipped: { id: string; reason: string }[] = [];

  try {
    for (const entry of validated) {
      const id = entry.id ?? newId();
      const existing = entry.id
        ? await c.env.DB
            .prepare('SELECT * FROM time_entries WHERE id = ?1')
            .bind(id)
            .first<TimeEntryRow>()
        : null;
      if (existing) {
        skipped.push({ id, reason: 'already_exists' });
        created.push(rowToEntry(existing));
        continue;
      }
      const insert = await c.env.DB
        .prepare(
          `INSERT INTO time_entries
           (id, customer_id, minutes, description, entry_date, billable, status, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'draft', ?7, ?7)
           RETURNING *`,
        )
        .bind(id, entry.customer_id, entry.minutes, entry.description, entry.entry_date, entry.billable ? 1 : 0, now)
        .first<TimeEntryRow>();
      if (!insert) throw new Error(`insert returned no row for ${id}`);
      created.push(rowToEntry(insert));
    }

    log.info('time_entries_created', { count: created.length, skipped: skipped.length });
    return c.json({ entries: created, skipped });
  } catch (err) {
    log.error('time_create_failed', describeError(err));
    throw err;
  }
});

time.get('/api/time', async (c) => {
  const customer_id = c.req.query('customer_id');
  const status = c.req.query('status');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '200', 10) || 200, 500);

  if (status && !VALID_STATUSES.includes(status as TimeEntryStatus)) {
    return c.json({ error: 'invalid status' }, 400 as any);
  }

  const conditions: string[] = [];
  const args: unknown[] = [];
  let idx = 1;
  if (customer_id) {
    conditions.push(`customer_id = ?${idx++}`);
    args.push(customer_id);
  }
  if (status) {
    conditions.push(`status = ?${idx++}`);
    args.push(status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  args.push(limit);

  const stmt = c.env.DB
    .prepare(`SELECT * FROM time_entries ${where} ORDER BY entry_date DESC, created_at DESC LIMIT ?${idx}`)
    .bind(...args);
  const rows = await stmt.all<TimeEntryRow>();
  return c.json({ entries: (rows.results ?? []).map(rowToEntry) });
});

time.patch('/api/time/:id', async (c) => {
  const id = c.req.param('id');
  let body: {
    minutes?: number;
    description?: string | null;
    entry_date?: string;
    billable?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400 as any);
  }

  if (body.minutes !== undefined && (!Number.isInteger(body.minutes) || body.minutes <= 0 || body.minutes > MAX_MINUTES_PER_ENTRY)) {
    return c.json({ error: 'invalid minutes' }, 400 as any);
  }
  if (body.entry_date !== undefined && !ENTRY_DATE_RE.test(body.entry_date)) {
    return c.json({ error: 'invalid entry_date' }, 400 as any);
  }

  const existing = await c.env.DB
    .prepare('SELECT * FROM time_entries WHERE id = ?1')
    .bind(id)
    .first<TimeEntryRow>();
  if (!existing) return c.json({ error: 'not found' }, 404 as any);
  if (existing.status !== 'draft') {
    return c.json({ error: `cannot edit entry in status=${existing.status}` }, 409 as any);
  }

  const now = Date.now();
  const updated = await c.env.DB
    .prepare(
      `UPDATE time_entries SET
         minutes = COALESCE(?2, minutes),
         description = CASE WHEN ?3 = 1 THEN ?4 ELSE description END,
         entry_date = COALESCE(?5, entry_date),
         billable = COALESCE(?6, billable),
         updated_at = ?7
       WHERE id = ?1
       RETURNING *`,
    )
    .bind(
      id,
      body.minutes ?? null,
      body.description !== undefined ? 1 : 0,
      body.description ?? null,
      body.entry_date ?? null,
      body.billable !== undefined ? (body.billable ? 1 : 0) : null,
      now,
    )
    .first<TimeEntryRow>();
  if (!updated) return c.json({ error: 'update failed' }, 500 as any);
  return c.json(rowToEntry(updated));
});

time.post('/api/time/push', async (c) => {
  const log = createAxiomLogger(c.env, {
    component: 'time.push',
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });

  let body: { entry_ids?: string[]; rate_cents?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400 as any);
  }
  if (!Array.isArray(body.entry_ids) || body.entry_ids.length === 0) {
    return c.json({ error: 'entry_ids required' }, 400 as any);
  }
  if (body.entry_ids.length > 100) {
    return c.json({ error: 'max 100 entries per push' }, 400 as any);
  }
  if (body.rate_cents != null && (!Number.isInteger(body.rate_cents) || body.rate_cents <= 0)) {
    return c.json({ error: 'rate_cents must be a positive integer' }, 400 as any);
  }

  const placeholders = body.entry_ids.map((_, i) => `?${i + 1}`).join(',');
  const rows = await c.env.DB
    .prepare(`SELECT * FROM time_entries WHERE id IN (${placeholders})`)
    .bind(...body.entry_ids)
    .all<TimeEntryRow>();
  const entries = rows.results ?? [];

  if (entries.length !== body.entry_ids.length) {
    return c.json({ error: 'some entry_ids not found' }, 404 as any);
  }
  const nonDraft = entries.filter((e) => e.status !== 'draft');
  if (nonDraft.length > 0) {
    return c.json({ error: `not all entries in draft (${nonDraft.map((e) => e.id).join(',')})` }, 409 as any);
  }
  const nonBillable = entries.filter((e) => e.billable !== 1);
  if (nonBillable.length > 0) {
    return c.json({ error: `non-billable entries cannot be pushed` }, 400 as any);
  }
  const customerId = entries[0].customer_id;
  if (!entries.every((e) => e.customer_id === customerId)) {
    return c.json({ error: 'all entries must belong to the same customer' }, 400 as any);
  }

  let rateCents = body.rate_cents;
  if (rateCents == null) {
    const meta = await c.env.DB
      .prepare('SELECT hourly_rate_cents FROM client_metadata WHERE stripe_customer_id = ?1')
      .bind(customerId)
      .first<{ hourly_rate_cents: number | null }>();
    rateCents = meta?.hourly_rate_cents ?? undefined;
  }
  if (!rateCents) {
    return c.json({ error: 'no hourly_rate_cents set for client and none provided' }, 400 as any);
  }

  const stripe = stripeClient(c.env.STRIPE_API_KEY);
  const pushed: { entry_id: string; stripe_invoice_item_id: string; amount_cents: number }[] = [];
  const now = Date.now();
  const createdItemIds: string[] = [];

  try {
    for (const entry of entries) {
      const amount = Math.round((entry.minutes / 60) * rateCents);
      const descParts = [
        entry.description || `${entry.minutes} min`,
        `(${entry.entry_date})`,
      ];
      const item = await stripe.invoiceItems.create({
        customer: customerId,
        amount,
        currency: 'usd',
        description: descParts.join(' '),
        metadata: { time_entry_id: entry.id },
      });
      createdItemIds.push(item.id);

      await c.env.DB
        .prepare(
          `UPDATE time_entries
           SET status = 'pushed', stripe_invoice_item_id = ?2, pushed_at = ?3, updated_at = ?3
           WHERE id = ?1 AND status = 'draft'`,
        )
        .bind(entry.id, item.id, now)
        .run();

      pushed.push({ entry_id: entry.id, stripe_invoice_item_id: item.id, amount_cents: amount });
    }
    log.info('time_entries_pushed', { customer_id: customerId, count: pushed.length, total_cents: pushed.reduce((s, p) => s + p.amount_cents, 0) });
    return c.json({ customer_id: customerId, pushed });
  } catch (err) {
    log.error('time_push_failed', { ...describeError(err), customer_id: customerId, entry_count: entries.length, created_item_ids: createdItemIds });
    for (const id of createdItemIds) {
      try { await stripe.invoiceItems.del(id); } catch {}
    }
    if (createdItemIds.length > 0) {
      const idArgs = entries.map((_, i) => `?${i + 1}`).join(',');
      const tsPlaceholder = `?${entries.length + 1}`;
      await c.env.DB
        .prepare(
          `UPDATE time_entries
           SET status = 'draft', stripe_invoice_item_id = NULL, pushed_at = NULL, updated_at = ${tsPlaceholder}
           WHERE id IN (${idArgs}) AND status = 'pushed'`,
        )
        .bind(...entries.map((e) => e.id), Date.now())
        .run();
    }
    throw err;
  }
});

time.delete('/api/time/:id', async (c) => {
  const id = c.req.param('id');
  const now = Date.now();
  const result = await c.env.DB
    .prepare(
      `UPDATE time_entries SET status = 'voided', voided_at = ?2, updated_at = ?2
       WHERE id = ?1 AND status = 'draft'
       RETURNING *`,
    )
    .bind(id, now)
    .first<TimeEntryRow>();
  if (!result) return c.json({ error: 'not found or not in draft' }, 404 as any);
  return c.json(rowToEntry(result));
});

export default time;
