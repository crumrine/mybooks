import { describe, it, expect } from 'vitest';
import { parseDeliveryMode, shouldSendInvoiceEmail } from '../src/deliveryMode';

describe('parseDeliveryMode', () => {
  it('returns pdf_invoice when metadata is null', () => {
    expect(parseDeliveryMode(null)).toBe('pdf_invoice');
  });

  it('returns pdf_invoice when metadata is undefined', () => {
    expect(parseDeliveryMode(undefined)).toBe('pdf_invoice');
  });

  it('returns pdf_invoice when key is missing', () => {
    expect(parseDeliveryMode({})).toBe('pdf_invoice');
  });

  it('returns pdf_invoice when value is invalid', () => {
    expect(parseDeliveryMode({ delivery_mode: 'bogus' })).toBe('pdf_invoice');
  });

  it('returns auto_charge_silent when set explicitly', () => {
    expect(parseDeliveryMode({ delivery_mode: 'auto_charge_silent' })).toBe('auto_charge_silent');
  });

  it('returns pdf_invoice when set explicitly', () => {
    expect(parseDeliveryMode({ delivery_mode: 'pdf_invoice' })).toBe('pdf_invoice');
  });
});

describe('shouldSendInvoiceEmail', () => {
  it('sends for pdf_invoice', () => {
    expect(shouldSendInvoiceEmail('pdf_invoice')).toBe(true);
  });

  it('suppresses for auto_charge_silent', () => {
    expect(shouldSendInvoiceEmail('auto_charge_silent')).toBe(false);
  });
});
