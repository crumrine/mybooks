import { Hono } from 'hono';
import Stripe from 'stripe';
import type { AppBindings } from './index';
import { requireSession, AuthEnv, SessionClaims } from './auth';
import { parseDeliveryMode, type DeliveryMode } from './deliveryMode';

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
  const stripe = stripeClient(c.env.STRIPE_API_KEY);
  const customer = await stripe.customers.retrieve(id);
  if ((customer as any).deleted) return c.json({ error: 'Customer deleted' }, 404 as any);
  const cust = customer as Stripe.Customer;

  const local = await c.env.DB
    .prepare('SELECT display_name, hourly_rate_cents, notes, archived_at FROM client_metadata WHERE stripe_customer_id = ?1')
    .bind(id)
    .first<{ display_name: string; hourly_rate_cents: number | null; notes: string | null; archived_at: number | null }>();

  const [subs, invoices] = await Promise.all([
    stripe.subscriptions.list({ customer: id, status: 'all', limit: 20, expand: ['data.items.data.price.product'] }),
    stripe.invoices.list({ customer: id, limit: 20 }),
  ]);

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
      current_period_end: s.items.data[0]?.current_period_end,
      items: s.items.data.map((i) => ({
        plan_name: typeof i.price.product === 'object' && i.price.product && 'name' in i.price.product ? i.price.product.name : null,
        amount: i.price.unit_amount,
        currency: i.price.currency,
        interval: i.price.recurring?.interval,
      })),
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
});

admin.patch('/api/admin/clients/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    display_name?: string;
    delivery_mode?: DeliveryMode;
    hourly_rate_cents?: number | null;
    notes?: string | null;
  }>();

  const stripe = stripeClient(c.env.STRIPE_API_KEY);
  if (body.display_name || body.delivery_mode) {
    const updates: Stripe.CustomerUpdateParams = {};
    if (body.display_name) updates.name = body.display_name;
    if (body.delivery_mode) updates.metadata = { delivery_mode: body.delivery_mode };
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
    interval?: 'month' | 'year' | 'week' | 'day';
    product_name: string;
    description?: string;
  }>();

  if (!body.customer_id || !body.amount_cents || !body.product_name) {
    return c.json({ error: 'customer_id, amount_cents, product_name required' }, 400 as any);
  }

  const stripe = stripeClient(c.env.STRIPE_API_KEY);
  const product = await stripe.products.create({
    name: body.product_name,
    description: body.description,
  });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: body.amount_cents,
    currency: body.currency ?? 'usd',
    recurring: { interval: body.interval ?? 'month' },
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
