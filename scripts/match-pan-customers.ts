#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
/**
 * Build the matched-customer CSV for a Stripe PAN migration request.
 *
 * Input  (source CSV, headerless or header-first): source_cus_id,email
 *        Export it from the source Stripe account's Customers tab, or paste
 *        a list you compiled manually.
 * Output (stdout): email,source_cus_id,destination_cus_id,notes
 *
 * Usage:
 *   STRIPE_API_KEY=sk_live_... \
 *     node --experimental-strip-types scripts/match-pan-customers.ts \
 *     source-customers.csv > matched.csv
 *
 * The STRIPE_API_KEY you pass should point at the DESTINATION account — the
 * standalone Empro one. A restricted key with Customers: read is sufficient.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

interface StripeCustomer {
  id: string;
  email: string | null;
  name: string | null;
  deleted?: boolean;
}

interface SourceRow {
  source_cus_id: string;
  email: string;
}

function usage(): never {
  process.stderr.write(
    `match-pan-customers.ts — join a source-side customer list against the
destination Stripe account by email.

Usage:
  STRIPE_API_KEY=sk_live_xxx node --experimental-strip-types \\
    scripts/match-pan-customers.ts <source.csv> > matched.csv

source.csv format:
  - CSV with two columns: source_cus_id, email
  - Header row ("source_cus_id,email") is optional and auto-skipped.
  - Extra columns are ignored.
`,
  );
  process.exit(2);
}

function parseCsv(text: string): SourceRow[] {
  const rows: SourceRow[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cells = line.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
    const [first, second] = cells;
    if (i === 0 && first?.toLowerCase().includes('cus') === false && first?.toLowerCase() === 'source_cus_id') {
      continue;
    }
    if (!first || !second) continue;
    if (!/^cus_/.test(first)) {
      if (i === 0) continue;
      process.stderr.write(`warn: row ${i + 1} first column is not a cus_ id, skipping: ${first}\n`);
      continue;
    }
    rows.push({ source_cus_id: first, email: second.toLowerCase() });
  }
  return rows;
}

async function stripeGet<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Stripe ${path} → ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function fetchDestinationByEmail(email: string, apiKey: string): Promise<StripeCustomer[]> {
  const qs = new URLSearchParams({ email, limit: '10' });
  const res = await stripeGet<{ data: StripeCustomer[] }>(`/customers?${qs}`, apiKey);
  return res.data.filter((c) => !c.deleted);
}

function csvEscape(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

async function main() {
  const { positionals } = parseArgs({ allowPositionals: true });
  if (positionals.length !== 1) usage();
  const [sourceCsvPath] = positionals;

  const apiKey = process.env.STRIPE_API_KEY;
  if (!apiKey) {
    process.stderr.write('STRIPE_API_KEY not set (should be destination account key)\n');
    process.exit(2);
  }

  const text = readFileSync(sourceCsvPath, 'utf-8');
  const rows = parseCsv(text);
  if (rows.length === 0) {
    process.stderr.write('no valid rows found in source CSV\n');
    process.exit(1);
  }

  process.stderr.write(`joining ${rows.length} source customers against destination account…\n`);

  process.stdout.write('email,source_cus_id,destination_cus_id,destination_name,notes\n');

  for (const row of rows) {
    let destId = '';
    let destName = '';
    let notes = '';
    try {
      const matches = await fetchDestinationByEmail(row.email, apiKey);
      if (matches.length === 0) {
        notes = 'no destination customer with this email';
      } else if (matches.length > 1) {
        destId = matches[0].id;
        destName = matches[0].name ?? '';
        notes = `ambiguous: ${matches.length} destination customers with same email (${matches.map((m) => m.id).join('|')})`;
      } else {
        destId = matches[0].id;
        destName = matches[0].name ?? '';
      }
    } catch (err) {
      notes = `lookup_error: ${err instanceof Error ? err.message : String(err)}`;
    }
    process.stdout.write(
      [row.email, row.source_cus_id, destId, destName, notes].map(csvEscape).join(',') + '\n',
    );
  }

  process.stderr.write('done.\n');
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
