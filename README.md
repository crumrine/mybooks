# mybooks

Self-hosted invoicing worker for solo consultants. Portable reference implementation: fork it, set env vars, run it for your own business.

Forked from [Cap-go/worker-invoices](https://github.com/Cap-go/worker-invoices) (MIT) and reworked for time-capture plus Stripe subscriptions with per-client delivery modes.

## Stack

- Cloudflare Workers (TypeScript, Hono)
- Cloudflare KV (invoice sequence counter)
- Cloudflare D1 (client metadata, time entries, webhook dedupe)
- Stripe (subscriptions, invoice items, customer metadata)
- SendGrid (transactional email)
- Puppeteer on Workers (PDF rendering, inherited from fork)

## Setup

1. `npm install`
2. `wrangler login`
3. Create bindings:
   ```
   wrangler kv namespace create INVOICE_STATE
   wrangler kv namespace create INVOICE_STATE --preview
   wrangler d1 create mybooks
   ```
   Paste the returned IDs into `wrangler.json` under `kv_namespaces` and `d1_databases`.
4. Copy `.dev.vars.example` to `.dev.vars` and fill in:
   - `STRIPE_API_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `SENDGRID_API_KEY`
   - `DEV_EMAIL` (where dev-mode emails get rerouted)
5. Update `wrangler.json` `vars`:
   - `APP_NAME`
   - `APP_DOMAIN` (e.g. `billing.yourdomain.com`)
   - `SENDGRID_FROM` (e.g. `Billing <noreply@yourdomain.com>`)
6. `npm run dev` to run locally, `npm run deploy` to publish.

## Environment

| Name | Scope | Purpose |
|---|---|---|
| `STRIPE_API_KEY` | secret | Stripe API (`sk_test_` or `sk_live_`) |
| `STRIPE_WEBHOOK_SECRET` | secret | Stripe webhook signing secret (`whsec_`) |
| `SENDGRID_API_KEY` | secret | SendGrid HTTP API key |
| `SENDGRID_FROM` | var | From header (`Name <email>` or bare email) |
| `APP_NAME` | var | Display name used in UI + emails |
| `APP_DOMAIN` | var | Public host for webhook URL + links |
| `DEV_MODE` | var | `true` reroutes recipient emails to `DEV_EMAIL` |
| `DEV_EMAIL` | secret | Where dev-mode emails land |

## Portability

No business-specific strings in code. Everything comes from env vars or the connected Stripe account (logo, brand color, support email, VAT ID).

## Testing

```
npm run typecheck
npm test
```

Tests cover: webhook signature verification, KV invoice numbering under concurrency, delivery mode gating, SendGrid payload shape.

## License

MIT (inherited from upstream).
