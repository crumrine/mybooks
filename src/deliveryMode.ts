export type DeliveryMode = 'auto_charge_silent' | 'pdf_invoice';

const VALID: readonly DeliveryMode[] = ['auto_charge_silent', 'pdf_invoice'] as const;

export function parseDeliveryMode(metadata: Record<string, string> | null | undefined): DeliveryMode {
  const raw = metadata?.delivery_mode;
  if (raw && (VALID as readonly string[]).includes(raw)) {
    return raw as DeliveryMode;
  }
  return 'pdf_invoice';
}

export function shouldSendInvoiceEmail(mode: DeliveryMode): boolean {
  return mode === 'pdf_invoice';
}
