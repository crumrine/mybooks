import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseFromAddress, createSendGridProvider } from '../src/email';

describe('parseFromAddress', () => {
  it('parses a bare email', () => {
    expect(parseFromAddress('noreply@example.com')).toEqual({ fromEmail: 'noreply@example.com' });
  });

  it('parses "Name <email>" form', () => {
    expect(parseFromAddress('Billing <noreply@example.com>')).toEqual({
      fromName: 'Billing',
      fromEmail: 'noreply@example.com',
    });
  });

  it('strips surrounding quotes from the name', () => {
    expect(parseFromAddress('"Acme Billing" <noreply@acme.com>')).toEqual({
      fromName: 'Acme Billing',
      fromEmail: 'noreply@acme.com',
    });
  });
});

describe('SendGrid provider', () => {
  const env = { SENDGRID_API_KEY: 'SG.test', SENDGRID_FROM: 'Billing <noreply@example.com>' };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts a correctly shaped payload to SendGrid', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createSendGridProvider(env);
    await provider.send({
      to: 'client@example.com',
      subject: 'Invoice #INV-2026-0001',
      html: '<p>Hi</p>',
      attachments: [{ filename: 'invoice.pdf', content: 'base64data', mimeType: 'application/pdf' }],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer SG.test');

    const body = JSON.parse(init.body);
    expect(body.personalizations[0].to[0].email).toBe('client@example.com');
    expect(body.from).toEqual({ email: 'noreply@example.com', name: 'Billing' });
    expect(body.subject).toBe('Invoice #INV-2026-0001');
    expect(body.content[0]).toEqual({ type: 'text/html', value: '<p>Hi</p>' });
    expect(body.attachments[0]).toEqual({
      filename: 'invoice.pdf',
      content: 'base64data',
      type: 'application/pdf',
      disposition: 'attachment',
    });
  });

  it('omits attachments field when none provided', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createSendGridProvider(env);
    await provider.send({ to: 'a@b.com', subject: 's', html: 'h' });

    const init = fetchMock.mock.calls[0][1];
    const body = JSON.parse(init.body);
    expect(body.attachments).toBeUndefined();
  });

  it('throws on non-2xx response', async () => {
    const fetchMock = vi.fn(async () => new Response('bad creds', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createSendGridProvider(env);
    await expect(provider.send({ to: 'a@b.com', subject: 's', html: 'h' })).rejects.toThrow(/401/);
  });
});
