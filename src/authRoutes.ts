import { Hono } from 'hono';
import {
  type AuthEnv,
  buildSessionCookie,
  clearSessionCookie,
  consumeChallenge,
  issueChallenge,
  magicLinkEmail,
  readSessionCookie,
  signSession,
  verifySession,
} from './auth';
import { getEmailProvider } from './email';

const auth = new Hono<{ Bindings: AuthEnv }>();

auth.post('/api/auth/request', async (c) => {
  const env = c.env;
  if (!env.ADMIN_EMAIL || !env.AUTH_SECRET) {
    return c.json({ error: 'Auth not configured' }, 503 as any);
  }
  let body: { email?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400 as any);
  }
  const requested = (body.email ?? '').trim().toLowerCase();
  const adminEmail = env.ADMIN_EMAIL.toLowerCase();

  if (!requested) {
    return c.json({ error: 'email required' }, 400 as any);
  }

  if (requested === adminEmail) {
    const challenge = await issueChallenge(env.DB, adminEmail);
    const origin = new URL(c.req.url).origin;
    const callbackUrl = `${origin}/api/auth/callback?token=${challenge.token}`;
    const { subject, html } = magicLinkEmail(env.APP_NAME || 'Billing', env.APP_DOMAIN, callbackUrl);
    try {
      await getEmailProvider(env).send({ to: adminEmail, subject, html });
    } catch (err) {
      console.error('Failed to send magic-link email:', err);
      return c.json({ error: 'Unable to send magic link' }, 502 as any);
    }
  }

  return c.json({ ok: true });
});

auth.get('/api/auth/callback', async (c) => {
  const env = c.env;
  if (!env.AUTH_SECRET || !env.ADMIN_EMAIL) {
    return c.json({ error: 'Auth not configured' }, 503 as any);
  }
  const token = c.req.query('token') ?? '';
  if (!token) return c.json({ error: 'token required' }, 400 as any);

  const result = await consumeChallenge(env.DB, token);
  if (!result.ok) {
    return c.html(
      `<!doctype html><html><body style="font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e5e5e5;min-height:100vh;display:flex;align-items:center;justify-content:center">
      <div style="text-align:center"><h1 style="color:#ef4444">Link ${result.reason === 'expired' ? 'expired' : result.reason === 'already_used' ? 'already used' : 'invalid'}</h1><p><a href="/admin/" style="color:#6366f1">Request a new sign-in link</a></p></div></body></html>`,
      401 as any,
    );
  }

  if ((result.email ?? '').toLowerCase() !== env.ADMIN_EMAIL.toLowerCase()) {
    return c.json({ error: 'Unauthorized' }, 401 as any);
  }

  const jwt = await signSession({ sub: env.ADMIN_EMAIL.toLowerCase() }, env.AUTH_SECRET);
  c.header('Set-Cookie', buildSessionCookie(jwt));
  return c.redirect('/admin/');
});

auth.post('/api/auth/logout', async (c) => {
  c.header('Set-Cookie', clearSessionCookie());
  return c.json({ ok: true });
});

auth.get('/api/auth/me', async (c) => {
  const env = c.env;
  const token = readSessionCookie(c.req.header('cookie'));
  if (!token) return c.json({ authenticated: false }, 200 as any);
  const claims = await verifySession(token, env.AUTH_SECRET);
  if (!claims) return c.json({ authenticated: false }, 200 as any);
  return c.json({ authenticated: true, email: claims.sub, exp: claims.exp });
});

export default auth;
