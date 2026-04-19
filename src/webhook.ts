import type { Context } from 'hono';
import Stripe from 'stripe';
import { getWebhookEndpoints, deleteWebhookEndpoint, createWebhookEndpoint } from './stripe';
import { parseDeliveryMode, shouldSendInvoiceEmail } from './deliveryMode';
import { sendInvoice } from './invoices';

export interface WebhookEnv {
  STRIPE_API_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  APP_DOMAIN: string;
  DB: D1Database;
}

let cachedStripe: Stripe | null = null;
function getStripe(apiKey: string): Stripe {
  if (!cachedStripe) {
    cachedStripe = new Stripe(apiKey, { apiVersion: '2025-08-27.basil', typescript: true });
  }
  return cachedStripe;
}

export interface VerifyResult {
  ok: boolean;
  status: number;
  event?: Stripe.Event;
  error?: string;
}

export async function verifyStripeWebhook(
  rawBody: string,
  signature: string | null,
  secret: string,
  apiKey: string,
): Promise<VerifyResult> {
  if (!signature) {
    return { ok: false, status: 400, error: 'Missing Stripe-Signature header' };
  }
  if (!secret) {
    return { ok: false, status: 500, error: 'Webhook secret not configured' };
  }

  const stripe = getStripe(apiKey);
  try {
    const event = await stripe.webhooks.constructEventAsync(rawBody, signature, secret);
    return { ok: true, status: 200, event };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid signature';
    return { ok: false, status: 401, error: message };
  }
}

export async function handleStripeWebhook(c: Context<{ Bindings: any }>): Promise<Response> {
  const signature = c.req.header('stripe-signature') ?? null;
  const rawBody = await c.req.text();
  const env = c.env as WebhookEnv;

  const verification = await verifyStripeWebhook(rawBody, signature, env.STRIPE_WEBHOOK_SECRET, env.STRIPE_API_KEY);
  if (!verification.ok) {
    console.warn('Rejected webhook:', verification.error);
    return c.json({ error: verification.error ?? 'Invalid request' }, verification.status as any);
  }

  const event = verification.event!;

  const firstTime = await recordEvent(env.DB, event.id, event.type);
  if (!firstTime) {
    return c.json({ message: 'Duplicate event, already processed' }, 200 as any);
  }

  if (event.type === 'charge.succeeded') {
    const charge = event.data.object as Stripe.Charge;
    const customerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
    const chargeId = charge.id;

    if (!customerId) {
      console.warn('charge.succeeded has no customer, skipping:', chargeId);
      return c.json({ message: 'No customer on charge, skipping' }, 200 as any);
    }

    const customerMetadata = await loadCustomerMetadata(env.STRIPE_API_KEY, customerId);
    const mode = parseDeliveryMode(customerMetadata);

    if (!shouldSendInvoiceEmail(mode)) {
      console.log(`Skipping invoice email for ${customerId} (delivery_mode=${mode})`);
      return c.json({ message: 'Delivery mode suppressed' }, 200 as any);
    }

    c.executionCtx.waitUntil(
      sendInvoice(c, customerId, chargeId).catch((err) => {
        console.error('sendInvoice failed for customer', customerId, 'charge', chargeId, '-', err instanceof Error ? (err.stack ?? err.message) : String(err));
      }),
    );
    return c.json({ message: 'Invoice queued' }, 200 as any);
  }

  return c.json({ message: `Ignored event ${event.type}` }, 200 as any);
}

async function recordEvent(db: D1Database, id: string, type: string): Promise<boolean> {
  try {
    const result = await db
      .prepare('INSERT OR IGNORE INTO webhook_events (id, type, received_at) VALUES (?1, ?2, ?3)')
      .bind(id, type, Date.now())
      .run();
    return (result.meta?.changes ?? 0) > 0;
  } catch (err) {
    console.error('Failed to record webhook event, proceeding anyway:', err);
    return true;
  }
}

async function loadCustomerMetadata(apiKey: string, customerId: string): Promise<Record<string, string> | null> {
  try {
    const stripe = getStripe(apiKey);
    const customer = await stripe.customers.retrieve(customerId);
    if (!customer || (customer as Stripe.DeletedCustomer).deleted) return null;
    return (customer as Stripe.Customer).metadata ?? null;
  } catch (err) {
    console.error('Failed to load customer metadata, defaulting to pdf_invoice:', err);
    return null;
  }
}

export const webhookInit = async (_event: ScheduledEvent, env: any, _ctx: ExecutionContext) => {
  try {
    if (!env.APP_DOMAIN) {
      console.log('APP_DOMAIN not configured, skipping webhook auto-registration');
      return;
    }
    const webhookData = await getWebhookEndpoints({ env });
    const webhookUrl = `https://${env.APP_DOMAIN}/webhook/stripe`;
    const requiredEvents = ['charge.succeeded'];
    const existingWebhook = webhookData.find(
      (wh: any) => wh.url === webhookUrl && requiredEvents.every((e) => wh.enabled_events.includes(e)),
    );

    if (!existingWebhook) {
      const oldWebhook = webhookData.find((wh: any) => wh.url === webhookUrl);
      if (oldWebhook) {
        await deleteWebhookEndpoint({ env }, oldWebhook.id);
      }
      const newWebhook = await createWebhookEndpoint({ env }, webhookUrl, requiredEvents);
      console.log('Webhook created:', newWebhook.id);
    }
  } catch (error) {
    console.error('Error in scheduled webhook check:', error);
  }
};

export function __resetStripeClientForTest() {
  cachedStripe = null;
}
