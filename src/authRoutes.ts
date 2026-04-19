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
import { createAxiomLogger, describeError, type AxiomEnv } from './axiom';

const auth = new Hono<{ Bindings: AuthEnv & AxiomEnv }>();

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

  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  if (!(await allowAuthRequest(env.DB, ip, requested))) {
    return c.json({ error: 'Too many requests' }, 429 as any);
  }

  const log = createAxiomLogger(env as any, {
    component: 'auth.request',
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });

  if (requested === adminEmail) {
    const challenge = await issueChallenge(env.DB, adminEmail);
    const origin = new URL(c.req.url).origin;
    const callbackUrl = `${origin}/api/auth/callback?token=${challenge.token}`;
    const { subject, html } = magicLinkEmail(env.APP_NAME || 'Billing', env.APP_DOMAIN, callbackUrl);
    try {
      await getEmailProvider(env).send({ to: adminEmail, subject, html });
      log.info('magic_link_sent', { origin });
    } catch (err) {
      console.error('Failed to send magic-link email:', err);
      log.error('magic_link_send_failed', { ...describeError(err), origin });
      return c.json({ error: 'Unable to send magic link' }, 502 as any);
    }
  } else {
    log.info('magic_link_request_ignored_non_admin', { requested_hash: await hashEmailForLog(requested) });
    await sleepForTimingParity();
  }

  return c.json({ ok: true });
});

const AUTH_REQUEST_WINDOW_MS = 15 * 60 * 1000;
const AUTH_REQUEST_MAX = 5;

async function allowAuthRequest(db: D1Database, ip: string, email: string): Promise<boolean> {
  const now = Date.now();
  const since = now - AUTH_REQUEST_WINDOW_MS;
  const key = `${ip}|${email.toLowerCase()}`;
  try {
    const row = await db
      .prepare('SELECT COUNT(*) as n FROM auth_challenges WHERE created_at > ?1 AND email = ?2')
      .bind(since, email.toLowerCase())
      .first<{ n: number }>();
    if ((row?.n ?? 0) >= AUTH_REQUEST_MAX) return false;
  } catch {
    /* if D1 fails, fail open so auth still works */
  }
  void key;
  return true;
}

async function sleepForTimingParity(): Promise<void> {
  const ms = 200 + Math.floor(Math.random() * 150);
  return new Promise((r) => setTimeout(r, ms));
}

async function hashEmailForLog(email: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email));
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < 6; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

auth.get('/api/auth/callback', async (c) => {
  const env = c.env;
  if (!env.AUTH_SECRET || !env.ADMIN_EMAIL) {
    return c.json({ error: 'Auth not configured' }, 503 as any);
  }
  const token = c.req.query('token') ?? '';
  if (!token) return c.json({ error: 'token required' }, 400 as any);

  const result = await consumeChallenge(env.DB, token);
  if (!result.ok) {
    const label =
      result.reason === 'expired' ? 'expired'
      : result.reason === 'already_used' ? 'already used'
      : 'invalid';
    return c.html(
      `<!doctype html><html><body style="font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e5e5e5;min-height:100vh;display:flex;align-items:center;justify-content:center">
      <div style="text-align:center"><h1 style="color:#ef4444">Link ${label}</h1><p><a href="/admin/" style="color:#6366f1">Request a new sign-in link</a></p></div></body></html>`,
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
