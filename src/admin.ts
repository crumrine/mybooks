import { Hono } from 'hono';
import Stripe from 'stripe';
import type { AppBindings } from './index';
import { requireSession, AuthEnv, SessionClaims } from './auth';
import { parseDeliveryMode, type DeliveryMode } from './deliveryMode';
import { createAxiomLogger, describeError } from './axiom';

const VALID_DELIVERY_MODES: readonly DeliveryMode[] = ['auto_charge_silent', 'pdf_invoice'];
const VALID_INTERVALS = ['day', 'week', 'month', 'year'] as const;
type SubscriptionInterval = (typeof VALID_INTERVALS)[number];
const STRIPE_MIN_CENTS = 50;

let cachedStripe: Stripe | null = null;
function stripeClient(apiKey: string): Stripe {
  if (!cachedStripe) cachedStripe = new Stripe(apiKey, { apiVersion: '2025-08-27.basil', typescript: true });
  return cachedStripe;
}

export interface AdminEnv extends AuthEnv, AppBindings {}

type AdminVars = { Variables: { session: SessionClaims }; Bindings: AdminEnv };

const admin = new Hono<AdminVars>();

admin.use('/api/admin/*', requireSession());

admin.get('/api/admin/dashboard', async (c) => {
  const stripe = stripeClient(c.env.STRIPE_API_KEY);
  const [subs, upcomingInvoices, recentFailed] = await Promise.all([
    stripe.subscriptions.list({ status: 'active', limit: 100, expand: ['data.items.data.price'] }),
    stripe.invoices.list({ status: 'open', limit: 20 }),
    stripe.invoices.list({ status: 'uncollectible', limit: 10 }),
  ]);

  let mrrCents = 0;
  for (const sub of subs.data) {
    for (const item of sub.items.data) {
      const price = item.price;
      if (!price?.recurring || !price.unit_amount) continue;
      const qty = item.quantity ?? 1;
      const amount = price.unit_amount * qty;
      switch (price.recurring.interval) {
        case 'month':
          mrrCents += amount / (price.recurring.interval_count || 1);
          break;
        case 'year':
          mrrCents += amount / (12 * (price.recurring.interval_count || 1));
          break;
        case 'week':
          mrrCents += (amount * 52) / (12 * (price.recurring.interval_count || 1));
          break;
        case 'day':
          mrrCents += (amount * 365) / (12 * (price.recurring.interval_count || 1));
          break;
      }
    }
  }

  return c.json({
    mrr_cents: Math.round(mrrCents),
    active_subscriptions: subs.data.length,
    open_invoices: upcomingInvoices.data.length,
    uncollectible_invoices: recentFailed.data.length,
  });
});

admin.get('/api/admin/clients', async (c) => {
  const stripe = stripeClient(c.env.STRIPE_API_KEY);
  const customers = await stripe.customers.list({ limit: 100 });
  const rows = await c.env.DB.prepare('SELECT stripe_customer_id, display_name, hourly_rate_cents, notes, archived_at FROM client_metadata').all();
  const localMap = new Map<string, any>();
  for (const r of rows.results ?? []) localMap.set((r as any).stripe_customer_id, r);

  const clients = customers.data.map((cust) => {
    const local = localMap.get(cust.id);
    return {
      id: cust.id,
      email: cust.email,
      stripe_name: cust.name,
      display_name: local?.display_name ?? cust.name ?? cust.email ?? cust.id,
      delivery_mode: parseDeliveryMode(cust.metadata ?? null),
      hourly_rate_cents: local?.hourly_rate_cents ?? null,
      notes: local?.notes ?? null,
      archived: local?.archived_at != null,
    };
  });
  return c.json({ clients });
});

admin.post('/api/admin/clients', async (c) => {
  const body = await c.req.json<{
    email: string;
    display_name: string;
    delivery_mode?: DeliveryMode;
    hourly_rate_cents?: number;
    notes?: string;
  }>();

  if (!body.email || !body.display_name) {
    return c.json({ error: 'email and display_name are required' }, 400 as any);
  }
  if (body.delivery_mode && !VALID_DELIVERY_MODES.includes(body.delivery_mode)) {
    return c.json({ error: 'invalid delivery_mode' }, 400 as any);
  }

  const delivery_mode: DeliveryMode = body.delivery_mode ?? 'pdf_invoice';
  const stripe = stripeClient(c.env.STRIPE_API_KEY);
  const customer = await stripe.customers.create({
    email: body.email,
    name: body.display_name,
    metadata: { delivery_mode },
  });

  const now = Date.now();
  await c.env.DB
    .prepare(
      `INSERT INTO client_metadata (stripe_customer_id, display_name, hourly_rate_cents, notes, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    )
    .bind(customer.id, body.display_name, body.hourly_rate_cents ?? null, body.notes ?? null, now)
    .run();

  return c.json(
    {
      id: customer.id,
      email: customer.email,
      display_name: body.display_name,
      delivery_mode,
      hourly_rate_cents: body.hourly_rate_cents ?? null,
      notes: body.notes ?? null,
    },
    201 as any,
  );
});

admin.get('/api/admin/clients/:id', async (c) => {
  const id = c.req.param('id');
  const log = createAxiomLogger(c.env, {
    component: 'admin.client_detail',
    fields: { customer_id: id },
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });
  try {
    const stripe = stripeClient(c.env.STRIPE_API_KEY);
    const customer = await stripe.customers.retrieve(id);
    if ((customer as any).deleted) return c.json({ error: 'Customer deleted' }, 404 as any);
    const cust = customer as Stripe.Customer;

    const local = await c.env.DB
      .prepare('SELECT display_name, hourly_rate_cents, notes, archived_at FROM client_metadata WHERE stripe_customer_id = ?1')
      .bind(id)
      .first<{ display_name: string; hourly_rate_cents: number | null; notes: string | null; archived_at: number | null }>();

    const [subs, invoices, timeRows] = await Promise.all([
      stripe.subscriptions.list({ customer: id, status: 'all', limit: 20, expand: ['data.default_payment_method'] }),
      stripe.invoices.list({ customer: id, limit: 20 }),
      c.env.DB
        .prepare(`SELECT * FROM time_entries WHERE customer_id = ?1 AND status IN ('draft','pushed','billed') ORDER BY entry_date DESC, created_at DESC LIMIT 200`)
        .bind(id)
        .all<any>(),
    ]);

    const productIds = new Set<string>();
    for (const s of subs.data) {
      for (const i of s.items.data) {
        if (typeof i.price.product === 'string') productIds.add(i.price.product);
      }
    }
    const productMap = new Map<string, Stripe.Product>();
    if (productIds.size > 0) {
      const products = await stripe.products.list({ ids: [...productIds], limit: 100 });
      for (const p of products.data) productMap.set(p.id, p);
    }

    return c.json({
    id: cust.id,
    email: cust.email,
    stripe_name: cust.name,
    display_name: local?.display_name ?? cust.name,
    delivery_mode: parseDeliveryMode(cust.metadata ?? null),
    hourly_rate_cents: local?.hourly_rate_cents ?? null,
    notes: local?.notes ?? null,
    archived: local?.archived_at != null,
    subscriptions: subs.data.map((s) => ({
      id: s.id,
      status: s.status,
      paused: s.pause_collection != null,
      pause_behavior: s.pause_collection?.behavior ?? null,
      resumes_at: s.pause_collection?.resumes_at ?? null,
      current_period_end: s.items.data[0]?.current_period_end ?? null,
      items: s.items.data.map((i) => {
        const prodId = typeof i.price.product === 'string' ? i.price.product : null;
        const prod = prodId ? productMap.get(prodId) ?? null : null;
        return {
          plan_name: prod?.name ?? null,
          amount: i.price.unit_amount,
          currency: i.price.currency,
          interval: i.price.recurring?.interval,
        };
      }),
    })),
    time_entries: (timeRows.results ?? []).map((r: any) => ({
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
      created_at: r.created_at,
    })),
    invoices: invoices.data.map((inv) => ({
      id: inv.id,
      number: inv.number,
      amount_due: inv.amount_due,
      amount_paid: inv.amount_paid,
      currency: inv.currency,
      status: inv.status,
      hosted_invoice_url: inv.hosted_invoice_url,
      created: inv.created,
    })),
    });
  } catch (err) {
    log.error('client_detail_failed', describeError(err));
    throw err;
  }
});

admin.patch('/api/admin/clients/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    display_name?: string;
    email?: string;
    delivery_mode?: DeliveryMode;
    hourly_rate_cents?: number | null;
    notes?: string | null;
  }>();

  if (body.delivery_mode && !VALID_DELIVERY_MODES.includes(body.delivery_mode)) {
    return c.json({ error: 'invalid delivery_mode' }, 400 as any);
  }
  if (body.email !== undefined && body.email !== null) {
    if (typeof body.email !== 'string' || !/^\S+@\S+\.\S+$/.test(body.email.trim())) {
      return c.json({ error: 'invalid email' }, 400 as any);
    }
  }
  if (body.hourly_rate_cents != null) {
    if (!Number.isInteger(body.hourly_rate_cents) || body.hourly_rate_cents < 0) {
      return c.json({ error: 'hourly_rate_cents must be a non-negative integer' }, 400 as any);
    }
  }

  const stripe = stripeClient(c.env.STRIPE_API_KEY);
  if (body.display_name !== undefined || body.delivery_mode !== undefined || body.email !== undefined) {
    const updates: Stripe.CustomerUpdateParams = {};
    if (body.display_name !== undefined) updates.name = body.display_name;
    if (body.email !== undefined) updates.email = body.email?.trim() ?? undefined;
    if (body.delivery_mode !== undefined) updates.metadata = { delivery_mode: body.delivery_mode };
    await stripe.customers.update(id, updates);
  }

  const now = Date.now();
  await c.env.DB
    .prepare(
      `INSERT INTO client_metadata (stripe_customer_id, display_name, hourly_rate_cents, notes, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(stripe_customer_id) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, display_name),
         hourly_rate_cents = CASE WHEN ?6 = 1 THEN excluded.hourly_rate_cents ELSE hourly_rate_cents END,
         notes = CASE WHEN ?7 = 1 THEN excluded.notes ELSE notes END,
         updated_at = ?5`,
    )
    .bind(
      id,
      body.display_name ?? null,
      body.hourly_rate_cents ?? null,
      body.notes ?? null,
      now,
      body.hourly_rate_cents !== undefined ? 1 : 0,
      body.notes !== undefined ? 1 : 0,
    )
    .run();

  return c.json({ ok: true });
});

admin.post('/api/admin/subscriptions', async (c) => {
  const body = await c.req.json<{
    customer_id: string;
    amount_cents: number;
    currency?: string;
    interval?: SubscriptionInterval;
    product_name: string;
    description?: string;
  }>();

  if (!body.customer_id || !body.product_name) {
    return c.json({ error: 'customer_id and product_name are required' }, 400 as any);
  }
  if (typeof body.amount_cents !== 'number' || !Number.isInteger(body.amount_cents) || body.amount_cents < STRIPE_MIN_CENTS) {
    return c.json({ error: `amount_cents must be an integer >= ${STRIPE_MIN_CENTS}` }, 400 as any);
  }
  const interval: SubscriptionInterval = body.interval ?? 'month';
  if (!VALID_INTERVALS.includes(interval)) {
    return c.json({ error: 'invalid interval' }, 400 as any);
  }
  const currency = (body.currency ?? 'usd').toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) {
    return c.json({ error: 'invalid currency code' }, 400 as any);
  }

  const stripe = stripeClient(c.env.STRIPE_API_KEY);
  let product: Stripe.Product | null = null;
  let price: Stripe.Price | null = null;
  try {
    product = await stripe.products.create({ name: body.product_name, description: body.description });
    price = await stripe.prices.create({
      product: product.id,
      unit_amount: body.amount_cents,
      currency,
      recurring: { interval },
    });
    const sub = await stripe.subscriptions.create({
      customer: body.customer_id,
      items: [{ price: price.id }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.confirmation_secret', 'pending_setup_intent'],
    });

    return c.json(
      {
        id: sub.id,
        status: sub.status,
        product_id: product.id,
        price_id: price.id,
        latest_invoice:
          typeof sub.latest_invoice === 'object' && sub.latest_invoice
            ? { id: sub.latest_invoice.id, status: sub.latest_invoice.status, hosted_invoice_url: sub.latest_invoice.hosted_invoice_url }
            : sub.latest_invoice,
      },
      201 as any,
    );
  } catch (err) {
    if (price) {
      try { await stripe.prices.update(price.id, { active: false }); } catch {}
    }
    if (product) {
      try { await stripe.products.update(product.id, { active: false }); } catch {}
    }
    throw err;
  }
});

admin.post('/api/admin/clients/:id/invoice', async (c) => {
  const customerId = c.req.param('id');
  const log = createAxiomLogger(c.env, {
    component: 'admin.one_off_invoice',
    fields: { customer_id: customerId },
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });

  let body: {
    amount_cents: number;
    description: string;
    currency?: string;
    send_email?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400 as any);
  }

  if (typeof body.amount_cents !== 'number' || !Number.isInteger(body.amount_cents) || body.amount_cents < STRIPE_MIN_CENTS) {
    return c.json({ error: `amount_cents must be an integer >= ${STRIPE_MIN_CENTS}` }, 400 as any);
  }
  if (typeof body.description !== 'string' || body.description.trim().length === 0) {
    return c.json({ error: 'description required' }, 400 as any);
  }
  const currency = (body.currency ?? 'usd').toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) {
    return c.json({ error: 'invalid currency' }, 400 as any);
  }

  const stripe = stripeClient(c.env.STRIPE_API_KEY);
  let itemId: string | null = null;
  try {
    const item = await stripe.invoiceItems.create({
      customer: customerId,
      amount: body.amount_cents,
      currency,
      description: body.description.trim(),
    });
    itemId = item.id;

    const invoice = await stripe.invoices.create({
      customer: customerId,
      auto_advance: false,
      collection_method: 'send_invoice',
      days_until_due: 14,
      pending_invoice_items_behavior: 'include',
    });

    const finalized = await stripe.invoices.finalizeInvoice(invoice.id!);

    if (body.send_email !== false) {
      try {
        await stripe.invoices.sendInvoice(finalized.id!);
      } catch (sendErr) {
        log.warn('stripe_send_invoice_failed', describeError(sendErr));
      }
    }

    log.info('one_off_invoice_created', {
      invoice_id: finalized.id,
      amount_due: finalized.amount_due,
      status: finalized.status,
    });

    return c.json(
      {
        invoice_id: finalized.id,
        number: finalized.number,
        status: finalized.status,
        amount_due: finalized.amount_due,
        hosted_invoice_url: finalized.hosted_invoice_url,
        invoice_pdf: finalized.invoice_pdf,
      },
      201 as any,
    );
  } catch (err) {
    log.error('one_off_invoice_failed', describeError(err));
    if (itemId) {
      try { await stripe.invoiceItems.del(itemId); } catch {}
    }
    throw err;
  }
});

admin.post('/api/admin/subscriptions/:id/pause', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ behavior?: 'keep_as_draft' | 'mark_uncollectible' | 'void'; resumes_at?: number | null }>().catch(() => ({} as any));
  const behavior = body.behavior ?? 'void';
  if (!['keep_as_draft', 'mark_uncollectible', 'void'].includes(behavior)) {
    return c.json({ error: 'invalid behavior' }, 400 as any);
  }
  const stripe = stripeClient(c.env.STRIPE_API_KEY);
  const sub = await stripe.subscriptions.update(id, {
    pause_collection: {
      behavior,
      ...(body.resumes_at ? { resumes_at: body.resumes_at } : {}),
    },
  });
  return c.json({ id: sub.id, status: sub.status, pause_collection: sub.pause_collection });
});

admin.post('/api/admin/subscriptions/:id/resume', async (c) => {
  const id = c.req.param('id');
  const stripe = stripeClient(c.env.STRIPE_API_KEY);
  const sub = await stripe.subscriptions.update(id, {
    pause_collection: '',
  } as any);
  return c.json({ id: sub.id, status: sub.status, pause_collection: sub.pause_collection });
});

admin.post('/api/admin/invoices/:id/mark-paid', async (c) => {
  const id = c.req.param('id');
  const log = createAxiomLogger(c.env, {
    component: 'admin.mark_paid',
    fields: { invoice_id: id },
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });
  const body = await c.req.json<{ payment_method?: 'check' | 'bank_transfer' | 'cash' | 'other' }>().catch(() => ({} as any));
  const stripe = stripeClient(c.env.STRIPE_API_KEY);
  try {
    const invoice = await stripe.invoices.pay(id, {
      paid_out_of_band: true,
    });
    log.info('invoice_marked_paid', { invoice_id: id, amount_paid: invoice.amount_paid, payment_method: body.payment_method ?? 'other' });
    return c.json({ id: invoice.id, status: invoice.status, amount_paid: invoice.amount_paid, paid_out_of_band: true });
  } catch (err) {
    log.error('mark_paid_failed', describeError(err));
    throw err;
  }
});

admin.get('/api/admin/invoices', async (c) => {
  const stripe = stripeClient(c.env.STRIPE_API_KEY);
  const invoices = await stripe.invoices.list({ limit: 50 });
  return c.json({
    invoices: invoices.data.map((inv) => ({
      id: inv.id,
      number: inv.number,
      customer: inv.customer,
      customer_email: inv.customer_email,
      amount_due: inv.amount_due,
      amount_paid: inv.amount_paid,
      currency: inv.currency,
      status: inv.status,
      hosted_invoice_url: inv.hosted_invoice_url,
      created: inv.created,
    })),
  });
});

export default admin;

export function __resetAdminStripeForTest() {
  cachedStripe = null;
}
