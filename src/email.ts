export interface EmailAttachment {
  filename: string;
  content: string;
  mimeType: string;
}

export interface SendEmailArgs {
  to: string;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}

export interface EmailProvider {
  send(args: SendEmailArgs): Promise<void>;
}

export interface EmailEnv {
  SENDGRID_API_KEY: string;
  SENDGRID_FROM: string;
}

export function createSendGridProvider(env: EmailEnv): EmailProvider {
  return {
    async send({ to, subject, html, attachments }: SendEmailArgs): Promise<void> {
      const { fromEmail, fromName } = parseFromAddress(env.SENDGRID_FROM);

      const body: Record<string, unknown> = {
        personalizations: [{ to: [{ email: to }] }],
        from: fromName ? { email: fromEmail, name: fromName } : { email: fromEmail },
        subject,
        content: [{ type: 'text/html', value: html }],
      };

      if (attachments && attachments.length > 0) {
        body.attachments = attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
          type: a.mimeType,
          disposition: 'attachment',
        }));
      }

      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`SendGrid request failed (${res.status}): ${errBody}`);
      }
    },
  };
}

export function parseFromAddress(raw: string): { fromEmail: string; fromName?: string } {
  const match = raw.match(/^\s*(?:"?([^"<]+?)"?\s*)?<([^>]+)>\s*$/);
  if (match) {
    return { fromName: match[1]?.trim(), fromEmail: match[2].trim() };
  }
  return { fromEmail: raw.trim() };
}

let cachedProvider: EmailProvider | null = null;

export function getEmailProvider(env: EmailEnv): EmailProvider {
  if (!cachedProvider) {
    cachedProvider = createSendGridProvider(env);
  }
  return cachedProvider;
}

export function resetEmailProvider(): void {
  cachedProvider = null;
}

export async function sendEmail(c: any, _from: string, to: string, subject: string, html: string, attachments: EmailAttachment[] = []): Promise<void> {
  const provider = getEmailProvider(c.env as EmailEnv);
  await provider.send({ to, subject, html, attachments });
}
