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
  INVOICE_STATE: KVNamespace;
  DB: D1Database;
  MYBROWSER: Fetcher;
}

const app = new Hono<{ Bindings: AppBindings }>();

app.use('*', logger());

app.post('/api/send-invoice', async (c) => {
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
