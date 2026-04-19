export interface InvoiceCounterEnv {
  INVOICE_STATE: KVNamespace;
}

const KEY_PREFIX = 'invoice:seq:';

export function formatInvoiceNumber(year: number, seq: number): string {
  const padded = seq.toString().padStart(4, '0');
  return `INV-${year}-${padded}`;
}

export async function nextInvoiceNumber(env: InvoiceCounterEnv, now: Date = new Date()): Promise<string> {
  const year = now.getUTCFullYear();
  const key = `${KEY_PREFIX}${year}`;

  for (let attempt = 0; attempt < 25; attempt++) {
    const { value, metadata } = await env.INVOICE_STATE.getWithMetadata<{ etag?: string }>(key);
    const current = value ? parseInt(value, 10) : 0;
    if (value && Number.isNaN(current)) {
      throw new Error(`Invoice counter for ${year} is corrupt: ${value}`);
    }
    const next = current + 1;
    const expected = metadata?.etag ?? '';
    const newEtag = `${next}:${crypto.randomUUID()}`;

    const latest = await env.INVOICE_STATE.getWithMetadata<{ etag?: string }>(key);
    const latestEtag = latest.metadata?.etag ?? '';
    if (latestEtag !== expected) {
      continue;
    }

    await env.INVOICE_STATE.put(key, String(next), { metadata: { etag: newEtag } });

    const check = await env.INVOICE_STATE.getWithMetadata<{ etag?: string }>(key);
    if (check.metadata?.etag !== newEtag) {
      continue;
    }

    return formatInvoiceNumber(year, next);
  }

  throw new Error('Failed to allocate invoice number after 25 attempts');
}
