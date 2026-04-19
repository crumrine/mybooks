import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { sendInvoice } from './invoices';
import { home } from './home';
import { billing, requestBillingLink } from './billing';
import { handleStripeWebhook, webhookInit } from './webhook';
import authRoutes from './authRoutes';
import adminRoutes from './admin';

export interface AppBindings {
  STRIPE_API_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  SENDGRID_API_KEY: string;
  SENDGRID_FROM: string;
  APP_NAME: string;
  APP_DOMAIN: string;
  DEV_MODE: string;
  DEV_EMAIL: string;
  ADMIN_API_TOKEN: string;
  ADMIN_EMAIL: string;
  AUTH_SECRET: string;
  DB: D1Database;
  MYBROWSER: Fetcher;
  ASSETS?: Fetcher;
}

const app = new Hono<{ Bindings: AppBindings }>();

app.use('*', logger());

async function requireAdminToken(c: any): Promise<Response | null> {
  const expected = c.env.ADMIN_API_TOKEN;
  if (!expected) {
    return c.json({ error: 'ADMIN_API_TOKEN not configured' }, 503 as any);
  }
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !(await timingSafeEqual(token, expected))) {
    return c.json({ error: 'Unauthorized' }, 401 as any);
  }
  return null;
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const av = new Uint8Array(da);
  const bv = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0 && a.length === b.length;
}

app.post('/api/send-invoice', async (c) => {
  const unauthorized = await requireAdminToken(c);
  if (unauthorized) return unauthorized;

  try {
    const { customerId, chargeId } = await c.req.json();

    if (!customerId) return c.json({ error: 'Customer ID is required' }, 400 as any);
    if (!chargeId) return c.json({ error: 'Charge ID is required' }, 400 as any);

    c.executionCtx.waitUntil(sendInvoice(c, customerId, chargeId));
    return c.json({ message: 'Invoice queued' }, 200 as any);
  } catch (error) {
    console.error('Error processing manual invoice:', error);
    return c.json({ error: 'Internal server error' }, 500 as any);
  }
});

app.route('/', authRoutes as any);
app.route('/', adminRoutes as any);

app.get('/', home);
app.get('/billing/:customerId', billing);
app.get('/api/request-billing-link', requestBillingLink);
app.post('/webhook/stripe', handleStripeWebhook);

app.get('/admin', (c) => c.redirect('/admin/'));
app.get('/admin/*', async (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text('Admin UI not deployed', 503 as any);
});

export default {
  scheduled: webhookInit,
  fetch: app.fetch,
};
