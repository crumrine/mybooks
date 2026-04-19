import type { Context, MiddlewareHandler } from 'hono';

const JWT_ALG = 'HS256';
const JWT_TYP = 'JWT';
const SESSION_COOKIE = 'mb_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const CHALLENGE_TTL_SECONDS = 60 * 15;

export interface AuthEnv {
  AUTH_SECRET: string;
  ADMIN_EMAIL: string;
  APP_DOMAIN: string;
  APP_NAME: string;
  DB: D1Database;
  SENDGRID_API_KEY: string;
  SENDGRID_FROM: string;
}

export interface SessionClaims {
  sub: string;
  iat: number;
  exp: number;
}

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array | string): string {
  let buf: Uint8Array;
  if (typeof bytes === 'string') {
    buf = new TextEncoder().encode(bytes);
  } else if (bytes instanceof Uint8Array) {
    buf = bytes;
  } else {
    buf = new Uint8Array(bytes);
  }
  let bin = '';
  for (let i = 0; i < buf.byteLength; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signSession(claims: Omit<SessionClaims, 'iat' | 'exp'>, secret: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const full: SessionClaims = { ...claims, iat: now, exp: now + SESSION_TTL_SECONDS };
  const header = { alg: JWT_ALG, typ: JWT_TYP };
  const headerPart = base64UrlEncode(JSON.stringify(header));
  const payloadPart = base64UrlEncode(JSON.stringify(full));
  const signingInput = `${headerPart}.${payloadPart}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

export async function verifySession(token: string, secret: string, now = Math.floor(Date.now() / 1000)): Promise<SessionClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, sigPart] = parts;
  const key = await hmacKey(secret);
  const sigBytes = base64UrlDecode(sigPart);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes.buffer.slice(sigBytes.byteOffset, sigBytes.byteOffset + sigBytes.byteLength) as ArrayBuffer,
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!ok) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart))) as SessionClaims;
    if (!claims || typeof claims.exp !== 'number' || typeof claims.sub !== 'string') return null;
    if (claims.exp <= now) return null;
    return claims;
  } catch {
    return null;
  }
}

export async function hashChallengeToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return base64UrlEncode(digest);
}

function randomToken(byteLength = 32): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

export interface IssueChallengeResult {
  token: string;
  hash: string;
  expiresAt: number;
}

export async function issueChallenge(db: D1Database, email: string, now = Date.now()): Promise<IssueChallengeResult> {
  const token = randomToken(32);
  const hash = await hashChallengeToken(token);
  const expiresAt = now + CHALLENGE_TTL_SECONDS * 1000;
  await db
    .prepare('INSERT INTO auth_challenges (token_hash, email, expires_at, consumed_at, created_at) VALUES (?1, ?2, ?3, NULL, ?4)')
    .bind(hash, email.toLowerCase(), expiresAt, now)
    .run();
  return { token, hash, expiresAt };
}

export interface ConsumeResult {
  ok: boolean;
  email?: string;
  reason?: 'not_found' | 'expired' | 'already_used';
}

export async function consumeChallenge(db: D1Database, token: string, now = Date.now()): Promise<ConsumeResult> {
  const hash = await hashChallengeToken(token);

  const claimed = await db
    .prepare(
      `UPDATE auth_challenges
       SET consumed_at = ?2
       WHERE token_hash = ?1
         AND consumed_at IS NULL
         AND expires_at > ?2
       RETURNING email`,
    )
    .bind(hash, now)
    .first<{ email: string }>();

  if (claimed) return { ok: true, email: claimed.email };

  const status = await db
    .prepare('SELECT expires_at, consumed_at FROM auth_challenges WHERE token_hash = ?1')
    .bind(hash)
    .first<{ expires_at: number; consumed_at: number | null }>();

  if (!status) return { ok: false, reason: 'not_found' };
  if (status.consumed_at !== null) return { ok: false, reason: 'already_used' };
  return { ok: false, reason: 'expired' };
}

export function buildSessionCookie(token: string, maxAgeSeconds = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

const MIN_SECRET_LENGTH = 32;

export function requireSession(): MiddlewareHandler<{ Bindings: AuthEnv; Variables: { session: SessionClaims } }> {
  return async (c, next) => {
    const env = c.env as AuthEnv;
    if (!env.AUTH_SECRET || env.AUTH_SECRET.length < MIN_SECRET_LENGTH || !env.ADMIN_EMAIL) {
      return c.json({ error: 'Auth not configured' }, 503 as any);
    }
    const token = readSessionCookie(c.req.header('cookie'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401 as any);
    const claims = await verifySession(token, env.AUTH_SECRET);
    if (!claims || claims.sub !== env.ADMIN_EMAIL.toLowerCase()) {
      return c.json({ error: 'Unauthorized' }, 401 as any);
    }
    c.set('session', claims);
    await next();
  };
}

export function magicLinkEmail(appName: string, appDomain: string, callbackUrl: string): { subject: string; html: string } {
  const subject = `Sign in to ${appName}`;
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0a;color:#e5e5e5;padding:40px 20px">
  <div style="max-width:480px;margin:0 auto;background:#171717;border:1px solid #262626;border-radius:8px;padding:32px">
    <h1 style="margin:0 0 16px;font-size:20px;color:#fafafa">Sign in to ${appName}</h1>
    <p style="margin:0 0 24px;color:#a3a3a3;line-height:1.6">Click the button below to sign in. This link expires in 15 minutes and can only be used once.</p>
    <p><a href="${callbackUrl}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:500">Sign in</a></p>
    <p style="margin:24px 0 0;color:#737373;font-size:12px;line-height:1.6">If you did not request this, ignore this email. The link is: <br><span style="word-break:break-all;color:#525252">${callbackUrl}</span></p>
  </div>
</body></html>`;
  return { subject, html };
}
