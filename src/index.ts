import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { sendInvoice } from './invoices';
import { home } from './home';
import { billing, requestBillingLink } from './billing';
import { handleStripeWebhook, webhookInit } from './webhook';

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
  DB: D1Database;
  MYBROWSER: Fetcher;
}

const app = new Hono<{ Bindings: AppBindings }>();

app.use('*', logger());

function requireAdminToken(c: any): Response | null {
  const expected = c.env.ADMIN_API_TOKEN;
  if (!expected) {
    return c.json({ error: 'ADMIN_API_TOKEN not configured' }, 503 as any);
  }
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !timingSafeEqual(token, expected)) {
    return c.json({ error: 'Unauthorized' }, 401 as any);
  }
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

app.post('/api/send-invoice', async (c) => {
  const unauthorized = requireAdminToken(c);
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

app.get('/', home);
app.get('/billing/:customerId', billing);
app.get('/api/request-billing-link', requestBillingLink);
app.post('/webhook/stripe', handleStripeWebhook);

export default {
  scheduled: webhookInit,
  fetch: app.fetch,
};
