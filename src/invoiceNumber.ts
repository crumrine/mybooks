export interface InvoiceCounterEnv {
  DB: D1Database;
}

export function formatInvoiceNumber(year: number, seq: number): string {
  const padded = seq.toString().padStart(4, '0');
  return `INV-${year}-${padded}`;
}

export async function nextInvoiceNumber(env: InvoiceCounterEnv, now: Date = new Date()): Promise<string> {
  const year = now.getUTCFullYear();

  const result = await env.DB
    .prepare(
      `INSERT INTO invoice_counter (year, seq) VALUES (?1, 1)
       ON CONFLICT(year) DO UPDATE SET seq = seq + 1
       RETURNING seq`,
    )
    .bind(year)
    .first<{ seq: number }>();

  if (!result || typeof result.seq !== 'number') {
    throw new Error(`Failed to allocate invoice number for year ${year}`);
  }

  return formatInvoiceNumber(year, result.seq);
}
