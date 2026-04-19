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

## Setup (forkers)

This repo's committed `wrangler.json` carries the upstream deployer's values (Empro's). When you fork, replace them with your own — `wrangler.example.json` is the clean template.

1. `cp wrangler.example.json wrangler.json` (overwrite) and fill in `APP_NAME`, `APP_DOMAIN`, `SENDGRID_FROM`, plus the D1 id from step 4.
2. `npm install && (cd admin && npm install)`
3. `wrangler login`
4. `wrangler d1 create mybooks` → paste `database_id` into `wrangler.json`. Then:
   ```
   wrangler d1 execute mybooks --remote --file=migrations/0001_init.sql
   wrangler d1 execute mybooks --remote --file=migrations/0002_phase2_admin.sql
   ```
5. Set secrets (never put these in `wrangler.json`):
   ```
   wrangler secret put STRIPE_API_KEY
   wrangler secret put STRIPE_WEBHOOK_SECRET
   wrangler secret put SENDGRID_API_KEY
   wrangler secret put DEV_EMAIL
   wrangler secret put ADMIN_API_TOKEN          # long random string
   wrangler secret put ADMIN_EMAIL              # only this address can log in
   wrangler secret put AUTH_SECRET              # 32+ random bytes (openssl rand -hex 48)
   wrangler secret put DEV_MODE                 # "true" to reroute all outbound email to DEV_EMAIL
   ```
6. `npm run deploy` (builds the admin UI and deploys the Worker).
7. In Stripe dashboard, add a webhook endpoint at `https://<your-domain>/webhook/stripe` listening for `charge.succeeded`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET` above. The scheduled task maintains this automatically every 6 hours once `APP_DOMAIN` resolves.
8. Visit `https://<your-domain>/admin/`, enter `ADMIN_EMAIL`, click the magic link.

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
