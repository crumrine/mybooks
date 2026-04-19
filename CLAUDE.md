# CLAUDE.md

Project context for Claude Code agents working on this repo.

## Mission

Self-hosted FreshBooks replacement for solo consultants. Initial deployment: Empro.biz. Designed to be portable so other solo consultants can fork, set env vars, and run it for their own business. Reference implementation, not a maintained product.

## Stack (locked)

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers (TypeScript) |
| Frontend | Cloudflare Pages, Vite + React + Tailwind + Workbox (PWA) |
| Database | Cloudflare D1 (SQLite) |
| Counter state | Cloudflare KV |
| File/asset storage | Cloudflare R2 (if needed for failed-send PDFs, per fork's pattern) |
| Payments | Stripe (Subscriptions + Invoice Items) |
| Email | SendGrid |
| PDF generation | Puppeteer on Workers (inherited from fork) |
| Auth | Magic link via SendGrid, signed JWT cookie |
| Routing | Hono |

**Do not add new external dependencies** without checking the portability constraint first. A forker should not need to sign up for anything outside Cloudflare + Stripe + SendGrid.

## Fork basis

Forked from **Cap-go/worker-invoices** (MIT license). Credit upstream in README.

Inherited working code:
- Stripe `charge.succeeded` webhook handler
- Branded PDF generation via Puppeteer on Workers
- Email delivery (Resend, being swapped to SendGrid)
- Minimal `/billing/<customer_id>` client history page
- Auto-webhook registration cron
- Stripe branding reads (logo, color, company info)

What we add on top:
1. Time capture PWA at `/time`
2. Time entries → `stripe.invoiceItems.create` flow
3. Admin UI for clients + subscriptions
4. Per-client delivery mode via Stripe customer metadata
5. Webhook signature verification (fork skips this)
6. Sequential invoice numbering in KV (fork uses chargeId-based)
7. Magic-link auth for admin

## Key decisions (do not re-litigate)

- **D1 not Neon.** Portability over stack-consistency. No external database.
- **One invoice line per time entry.** Clients see every billable session on their PDF.
- **`/time` route inside admin, not subdomain.** Single Pages deploy. PWA manifest `start_url` = `/time`.
- **SendGrid not Resend.** Brian has a paid SendGrid account. Email provider is modularized in `src/email.ts` for easy forker swap.
- **Per-client delivery mode via Stripe customer metadata**, not a local DB flag. Metadata key: `delivery_mode`. Values: `auto_charge_silent` or `pdf_invoice`. Webhook handler reads this to decide whether to send the PDF email.
- **Sequential invoice numbers** stored in KV: key `invoice:seq`, format `INV-YYYY-NNNN`.
- **Dark mode default** everywhere. Admin UI, PWA, any page we build. Forker can override via env `APP_THEME_MODE` if we implement that later.
- **No hardcoded "Empro" anything.** Every business-specific value lives in env vars or is pulled from the Stripe account at runtime.

## Code conventions

- TypeScript strict mode
- Prefer primitives over abstractions until a pattern emerges three times
- Small files, single responsibility
- Hono for routing with typed context
- D1 access via raw SQL with prepared statements, or Drizzle - pick one in Phase 0 and stick
- Tests where correctness matters (webhook signature verification, invoice number increments, time entry push-to-Stripe, idempotency). Skip tests for glue code and UI.
- No comments unless explaining non-obvious reasoning. Code should be self-documenting.
- No em dashes in any user-facing copy (email templates, UI text, README). Use periods, commas, or parentheses instead. This is a brand voice rule for this project.

## Portability constraints (hard)

- Zero Empro-specific strings in code. Everything via env or Stripe.
- No baked-in logos or colors. Pull from Stripe account settings like the fork does.
- Email from-address via `SENDGRID_FROM` env var, never hardcoded.
- App name via `APP_NAME` env var (used in email subjects, page titles, PWA manifest).
- App domain via `APP_DOMAIN` env var (used in magic link URLs, webhook self-registration).
- A fresh clone + env vars + `wrangler deploy` should produce a working instance with zero code edits.

## Subagents

This project assumes Brian's global subagents are available:
- `code-reviewer` runs after each phase completes
- `test-writer` for Phase 1 (webhook sig verification, invoice numbering) and Phase 4 (invoice items push flow)
- `security-auditor` before Phase 5 cutover, especially around the magic-link auth and the unrestricted Stripe key exposure

## What NOT to do

- Don't add UI component libraries beyond shadcn/ui if React needs one. Tailwind handles most of what we need.
- Don't build a full accounting system. This is invoicing only. Expenses, P&L, tax reports are out of scope.
- Don't implement multi-tenancy. Single-tenant per deployment. Portable, not SaaS.
- Don't re-implement what Stripe already handles: subscription cron, dunning retries, SCA, customer portal, tax. Use Stripe primitives.
- Don't over-abstract the email provider. Keep `src/email.ts` as a single module with a simple `send({to, subject, html, attachments})` export and a SendGrid implementation. Don't build a plugin system.
- Don't write long comments or docstrings. Code first.
- Don't break the portability constraint for convenience.

## Reference documents

- `docs/spec.md` - full system specification
- `docs/tasks.md` - phase-by-phase execution plan with acceptance criteria
- `docs/setup.md` - forker onboarding guide (write during Phase 1)
- Upstream fork: https://github.com/Cap-go/worker-invoices

## Workflow expectations

- Work phase by phase per `docs/tasks.md`
- Each phase ends with running `code-reviewer` subagent
- Keep commits small and descriptive
- Before Phase 5 (FreshBooks cutover), pause and get confirmation from Brian

