# Stripe PAN Migration — FreshBooks → Empro Standalone

Tracking artifact for the card-data migration needed to cut Empro's billing off
FreshBooks and onto this app without forcing customers to re-enter cards.

## Summary

- **Source account**: Stripe Connect account provisioned by FreshBooks Payments
  (holds the saved card tokens for my FreshBooks-billed customers). `acct_` ID
  is known; record below once confirmed.
- **Destination account**: Empro standalone Stripe Standard account —
  `acct_1TNx9rGsXJ1enyXj`, owner `brian@empro.biz`.
- **Count**: < 10 active recurring-billing customers, each with 1–2 saved cards.

## Timeline

| Date (UTC) | Event |
|---|---|
| 2026-04-20 | FreshBooks Tier II Payments (Jason) declines to facilitate migration. Suggests Stripe Support directly. Email archived below. |
| pending    | File Stripe Support ticket (draft below). Attach FreshBooks email. |
| pending    | Receive Stripe request for source `acct_`, matched customer CSV, PCI attestation counter-party. |
| pending    | FreshBooks Payments Risk/Compliance signs attestation. |
| pending    | Stripe executes copy. |
| pending    | Verify on destination: each migrated customer now has the right `pm_` attached. Update `delivery_mode` metadata if needed. |
| pending    | Point recurring subscriptions at migrated `pm_`s. Unpause. |

## FreshBooks response (2026-04-20)

Tier II Support Specialist, Payments — Jason:

> You mentioned that you are trying to migrate your saved payment tokens from
> your Stripe account for FreshBooks Payments over to a standalone Stripe
> Standard account. At this time, FreshBooks is not able to facilitate moving
> saved payment methods off of the Stripe account used for FreshBooks Payments.
> Since both accounts are Stripe account, you may be able to reach out to
> Stripe Support to see if they are able to migrate these payment tokens for
> you. Unfortunately, if they are not able to assist with moving them, your
> Clients will have to update their payment information manually on your new
> billing platform.

## Stripe Support ticket — draft

**Where to file:** Stripe Dashboard → Help → Contact Support → Payments →
"Data migration / PAN copy." File from the destination account.

**Subject:** Request for PAN copy — migrating saved payment methods from a FreshBooks-managed Stripe Connect account to my standalone Stripe Standard account

**Body:**

> Hi Stripe team,
>
> I'm moving my billing off FreshBooks onto my own self-hosted invoicing
> platform running on Stripe Subscriptions. I need your help migrating saved
> customer payment methods (card tokens) from the FreshBooks Payments Stripe
> account I've been using to my standalone Stripe Standard account.
>
> **Source account** (FreshBooks Payments Stripe Connect account):
> `acct_<SOURCE_ID_HERE>`.
>
> **Destination account** (mine, standalone): `acct_1TNx9rGsXJ1enyXj` (live
> mode), owner `brian@empro.biz`.
>
> **Scope:** Fewer than 10 active customers, each with one or two saved card
> payment methods. All are current recurring-billing customers with existing
> signed engagements; no authentication or relationship change — only the
> platform they are billed through. Matched-customer CSV attached (source
> `cus_` ↔ destination `cus_` by email).
>
> **Why I'm coming to you directly:** I already asked FreshBooks Payments
> Support to facilitate. Their Tier II Payments team (Jason, 2026-04-20)
> responded that "FreshBooks is not able to facilitate moving saved payment
> methods off of the Stripe account used for FreshBooks Payments," and
> suggested I contact Stripe. Their email is attached.
>
> I understand PAN copy requires:
> 1. Written authorization from the source account holder (FreshBooks /
>    their payments affiliate). I am happy to help reach the right person
>    there if you can tell me whom to ask or what form they need to sign.
> 2. PCI-compliance attestation from the source.
> 3. A matched customer list with the `cus_` IDs on both sides — attached.
>
> Without this migration, my customers have to re-enter card details
> manually, which is material churn and support cost for a very small
> business. Appreciate your help driving this with FreshBooks on the
> platform side.
>
> Thanks,
> Brian Crumrine
> brian@empro.biz
> Destination Stripe account: `acct_1TNx9rGsXJ1enyXj`

## Tactical notes

1. **Name the process:** "PAN copy" or "card data migration" in the subject.
   Support agents who triage tickets route faster when the product term is in
   the subject line.

2. **Parallel reply to FreshBooks:** after filing with Stripe, reply to Jason
   and ask for two things:
   - the source `acct_` ID (confirms what you already have)
   - a named contact at FreshBooks Payments Risk/Compliance who can sign
     Stripe's migration attestation. Jason himself cannot sign it; line up
     the next hop before Stripe asks.

3. **If Stripe L1 pushes back:** insist on escalation to the "Data Migrations"
   team — they exist as a specific queue. Do not accept "we can't migrate
   from Connect → Standard" as a final answer. It's routine; they just need
   both sides authorized.

## Matched customer CSV — how to build

Run `scripts/match-pan-customers.ts` (see that file for usage). It accepts a
source CSV `source_cus_id,email` that you export from the FreshBooks-side
Stripe dashboard (Customers tab → Export), and joins against your destination
Stripe account's `customers.list` by email. Output: `email,source_cus_id,destination_cus_id,notes`.

Any row where `destination_cus_id` is blank means the customer does not yet
exist on the destination side — create them via the admin UI before
attaching the ticket.
