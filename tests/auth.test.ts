import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildSessionCookie,
  consumeChallenge,
  hashChallengeToken,
  issueChallenge,
  readSessionCookie,
  signSession,
  verifySession,
} from '../src/auth';

const SECRET = 'test-secret-long-enough-for-hmac-1234567890';

class FakeD1 {
  store = new Map<string, any>();

  prepare(sql: string) {
    return new FakeStmt(this, sql);
  }
}

class FakeStmt {
  constructor(private db: FakeD1, private sql: string, private args: any[] = []) {}
  bind(...args: any[]) {
    return new FakeStmt(this.db, this.sql, args);
  }
  async run() {
    const s = this.sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('INSERT INTO auth_challenges')) {
      const [hash, email, expiresAt, createdAt] = this.args;
      this.db.store.set(hash, { email, expires_at: expiresAt, consumed_at: null, created_at: createdAt });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
  async first<T>() {
    const s = this.sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('UPDATE auth_challenges SET consumed_at')) {
      const [hash, now] = this.args;
      const row = this.db.store.get(hash);
      if (!row || row.consumed_at !== null || row.expires_at <= now) return null;
      row.consumed_at = now;
      return { email: row.email } as T;
    }
    if (s.startsWith('SELECT expires_at, consumed_at FROM auth_challenges')) {
      const [hash] = this.args;
      const row = this.db.store.get(hash);
      if (!row) return null;
      return { expires_at: row.expires_at, consumed_at: row.consumed_at } as T;
    }
    if (s.startsWith('SELECT COUNT(*) as n FROM auth_challenges')) {
      return { n: 0 } as T;
    }
    return null;
  }
}

describe('JWT session round-trip', () => {
  it('signs and verifies a session', async () => {
    const jwt = await signSession({ sub: 'admin@example.com' }, SECRET);
    const claims = await verifySession(jwt, SECRET);
    expect(claims?.sub).toBe('admin@example.com');
    expect(claims?.exp).toBeGreaterThan(claims?.iat ?? 0);
  });

  it('rejects a tampered payload', async () => {
    const jwt = await signSession({ sub: 'admin@example.com' }, SECRET);
    const [h, _p, s] = jwt.split('.');
    const badPayload = btoa(JSON.stringify({ sub: 'attacker@example.com', iat: 1, exp: 99999999999 }))
      .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const tampered = `${h}.${badPayload}.${s}`;
    expect(await verifySession(tampered, SECRET)).toBeNull();
  });

  it('rejects a different secret', async () => {
    const jwt = await signSession({ sub: 'admin@example.com' }, SECRET);
    expect(await verifySession(jwt, 'different-secret')).toBeNull();
  });

  it('rejects an expired session', async () => {
    const past = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30;
    const jwt = await signSession({ sub: 'admin@example.com' }, SECRET, past);
    expect(await verifySession(jwt, SECRET)).toBeNull();
  });

  it('rejects malformed input', async () => {
    expect(await verifySession('', SECRET)).toBeNull();
    expect(await verifySession('not.a.jwt.at.all', SECRET)).toBeNull();
    expect(await verifySession('onlyonepart', SECRET)).toBeNull();
  });
});

describe('Cookie helpers', () => {
  it('round-trips the session cookie value', () => {
    const cookie = buildSessionCookie('abc.def.ghi');
    expect(cookie).toContain('mb_session=abc.def.ghi');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(readSessionCookie('other=foo; mb_session=abc.def.ghi; bar=baz')).toBe('abc.def.ghi');
  });

  it('returns null for no cookie header', () => {
    expect(readSessionCookie(null)).toBeNull();
    expect(readSessionCookie(undefined)).toBeNull();
    expect(readSessionCookie('')).toBeNull();
    expect(readSessionCookie('unrelated=yes')).toBeNull();
  });
});

describe('Magic-link challenge', () => {
  let db: FakeD1;

  beforeEach(() => {
    db = new FakeD1();
  });

  it('issues a token that is consumable exactly once', async () => {
    const issued = await issueChallenge(db as any, 'admin@example.com');
    expect(issued.token).toBeTruthy();
    expect(issued.hash).toBe(await hashChallengeToken(issued.token));

    const first = await consumeChallenge(db as any, issued.token);
    expect(first.ok).toBe(true);
    expect(first.email).toBe('admin@example.com');

    const second = await consumeChallenge(db as any, issued.token);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('already_used');
  });

  it('rejects an unknown token', async () => {
    const res = await consumeChallenge(db as any, 'nope');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_found');
  });

  it('rejects an expired token', async () => {
    const past = Date.now() - 60 * 60 * 1000;
    const issued = await issueChallenge(db as any, 'admin@example.com', past);
    const res = await consumeChallenge(db as any, issued.token);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('expired');
  });

  it('normalizes email to lowercase', async () => {
    const issued = await issueChallenge(db as any, 'ADMIN@Example.COM');
    const res = await consumeChallenge(db as any, issued.token);
    expect(res.email).toBe('admin@example.com');
  });
});
