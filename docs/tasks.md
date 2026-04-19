# Tasks

Phase-by-phase execution plan. Work through in order. Each phase ends with `code-reviewer` subagent pass.

## Phase 0: Bootstrap

**Goal**: fork deploys cleanly, generates PDFs on test Stripe charges.

**Prerequisites**:
- Cloudflare account with Workers + Pages enabled
- Stripe test account created, API keys available
- SendGrid account with verified sender domain
- Domain ready (e.g. `billing.empro.biz`)

**Tasks**:
- [ ] Fork Cap-go/worker-invoices, rename to final repo name
- [ ] Clone locally, install deps (`bun install`)
- [ ] Verify `wrangler dev` works with test Stripe account
- [ ] Create Cloudflare KV namespace for invoice counter: `wrangler kv namespace create INVOICE_STATE`
- [ ] Create D1 database: `wrangler d1 create consulting-billing`
- [ ] Wire bindings in `wrangler.toml` (KV, D1, R2 if needed)
- [ ] Deploy to a `*.workers.dev` subdomain
- [ ] Set webhook endpoint in Stripe test account pointing at the worker
- [ ] Trigger a test charge via Stripe CLI, confirm PDF email fires (still via Resend for now)

**Acceptance**:
- Fork boots on Cloudflare
- `charge.succeeded` test event produces a PDF email
- No code changes yet, just infrastructure

---

## Phase 1: Fork hardening

**Goal**: production-ready fork behavior.

**Tasks**:
- [ ] Add Stripe webhook signature verification (`stripe.webhooks.constructEvent` with `STRIPE_WEBHOOK_SECRET` env)
- [ ] Replace fork's chargeId-based invoice numbering with KV counter. Format `INV-YYYY-NNNN`. Year resets to 0001 on Jan 1.
- [ ] Extract email sending into `src/email.ts` with interface `send({to, subject, html, attachments})`
- [ ] Implement SendGrid provider in `src/email.ts`. Remove Resend.
- [ ] Add per-client delivery mode gate: webhook handler reads `customer.metadata.delivery_mode`, skips PDF email if `auto_charge_silent`
- [ ] Remove any lingering Resend references from README and env var docs
- [ ] Write tests:
  - Webhook signature verification (valid, invalid, missing)
  - Invoice number increment under concurrent requests
  - Delivery mode gate (silent, pdf_invoice, missing metadata defaults to pdf_invoice)
- [ ] Run `code-reviewer` subagent
- [ ] Run `test-writer` subagent to fill any coverage gaps
- [ ] Run `security-auditor` subagent on webhook + auth paths

**Acceptance**:
- Webhook with invalid signature returns 401
- Two concurrent charges produce sequential, non-duplicate invoice numbers
- Customer with `delivery_mode: auto_charge_silent` does NOT receive a PDF email after charge
- All tests pass
- No security auditor findings above low severity

---

## Phase 2: Admin UI

**Goal**: Brian can manage clients and subscriptions from a web UI instead of the Stripe dashboard.

**Tasks**:
- [ ] Create new Cloudflare Pages project for the admin app
- [ ] Vite + React + TypeScript + Tailwind scaffold
- [ ] Dark mode default, CSS variables for theming
- [ ] Magic-link auth flow:
  - POST `/api/auth/request` sends email with signed token link
  - GET `/api/auth/callback?token=...` verifies, sets JWT cookie
  - Middleware protects all admin routes
- [ ] Worker API endpoints (under `/api/admin/*`):
  - GET/POST `/clients`
  - GET/PATCH/DELETE `/clients/:id`
  - GET/POST `/subscriptions`
  - GET `/invoices` (cached from Stripe)
  - GET `/dashboard` (MRR, active subs, upcoming, failed, unbilled time)
- [ ] Admin UI pages:
  - Dashboard
  - Clients list
  - Client detail (subscription history, invoice history, time entries)
  - Subscription create form
- [ ] Sync with Stripe: create Stripe customer on client save, create Price + Subscription on sub save, set `delivery_mode` metadata
- [ ] D1 schema migration: `client_metadata`, `webhook_events` tables
- [ ] Run `code-reviewer`

**Acceptance**:
- Brian can log in via magic link
- Create a client, have it appear in Stripe
- Create a monthly subscription for that client
- Dashboard shows accurate MRR

---

## Phase 3: Time capture PWA

**Goal**: mobile-first time entry on iPhone, offline-capable.

**Tasks**:
- [ ] Add `/time` route to admin app
- [ ] PWA manifest with `start_url: "/time"`, icons, theme color matching brand
- [ ] Register service worker via Workbox
- [ ] IndexedDB schema for offline time entry buffer
- [ ] Quick entry form: client picker, minutes, description, entry date (default today), billable toggle
- [ ] Timer mode: start/stop, persists in IndexedDB across tab close
- [ ] Sync logic: on online event, POST buffered entries to `/api/time`
- [ ] D1 schema migration: `time_entries` table
- [ ] Worker API endpoints:
  - POST `/api/time` (create, accepts array for batch sync)
  - GET `/api/time?customer_id=...&status=draft` (unbilled queue)
  - PATCH `/api/time/:id` (edit draft)
  - DELETE `/api/time/:id` (void draft)
- [ ] Test PWA install on iPhone Safari, verify home-screen launch goes to `/time`
- [ ] Verify offline entry + later sync works
- [ ] Run `code-reviewer`

**Acceptance**:
- Install PWA on iPhone from Safari
- Enter time offline, close app, reconnect, entries appear in admin unbilled queue
- Timer runs, survives tab close, can be stopped and saved

---

## Phase 4: Invoice items flow

**Goal**: push billable time entries to Stripe so they attach to the next subscription invoice.

**Tasks**:
- [ ] Client detail page shows unbilled time entries grouped by date
- [ ] "Push selected entries to next invoice" action with checkboxes
- [ ] Worker endpoint POST `/api/time/push`: iterates selected entries, calls `stripe.invoiceItems.create({customer, amount, currency, description})` for each
- [ ] On success, update each time entry: `status='pushed'`, `stripe_invoice_item_id=...`, `pushed_at=NOW()`
- [ ] Handle `invoice.finalized` webhook:
  - Look up time entries with matching `stripe_invoice_item_id`
  - Update to `status='billed'`, stamp `stripe_invoice_id` and `billed_at`
- [ ] Handle `invoice.voided` webhook (rare but possible): revert entries to `draft`, clear `stripe_invoice_item_id`
- [ ] Tests:
  - Push flow creates correct number of Stripe invoice items
  - Amount math: `minutes / 60 * hourly_rate_cents`, rounded to nearest cent
  - `invoice.finalized` closes the loop correctly
- [ ] Run `code-reviewer`, `test-writer`

**Acceptance**:
- Enter 3 time entries, push them, check Stripe dashboard → next upcoming invoice shows 3 line items
- When that invoice finalizes on the subscription cycle, entries move to `billed` status
- Invoice PDF shows each line item clearly

---

## Phase 5: FreshBooks migration

**Goal**: cut over from FreshBooks to this app without losing billing continuity.

**STOP and confirm with Brian before starting this phase.**

**Prerequisites**:
- Stripe PAN migration completed (customer + payment methods moved from FreshBooks Payments Connect account to Brian's standalone Stripe account)
- FreshBooks subscription still active (for export)

**Tasks**:
- [ ] Write migration script (one-off, in `scripts/migrate-from-freshbooks.ts`):
  - Read FreshBooks API for clients, recurring templates, outstanding time entries
  - For each client: set `delivery_mode` metadata on Stripe customer, create matching subscription with `billing_cycle_anchor` preserving timing, seed unbilled time as Stripe invoice items
- [ ] Dry-run mode: `pause_collection: true` on all new subs, log what would happen
- [ ] Verify spot-check: pick 2 clients, manually confirm their new subscription timing and amount matches FreshBooks
- [ ] Cutover day:
  - Unpause all subscriptions
  - Disable FreshBooks recurring templates
  - Monitor first invoice cycle
- [ ] After first successful cycle: cancel FreshBooks subscription
- [ ] Run `security-auditor` on the migration artifacts

**Acceptance**:
- All < 10 clients migrated cleanly
- First post-cutover invoice cycle succeeds for all clients
- FreshBooks subscription canceled
- No outstanding issues after 30 days

---

## Phase 6: Polish

**Goal**: fit and finish.

**Tasks**:
- [ ] Branded dunning email template for `invoice.payment_failed`
- [ ] Admin alert email on `charge.dispute.created`
- [ ] CSV export for time entries and invoices
- [ ] Write `docs/setup.md` for forkers
- [ ] Write public `README.md` with fork-basis credit, disclaimer, setup link
- [ ] LinkedIn post draft: Brian writes, we edit
- [ ] Disable GitHub Issues, set up Discussions to off, lock PRs to review-only

**Acceptance**:
- Repo is public, documented, ready to be referenced in a LinkedIn post
- Brian has been running on this for 30+ days with no FreshBooks dependency

