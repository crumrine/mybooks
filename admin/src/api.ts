import { reportClientError } from './errorReporting';

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) {
    if (!location.pathname.endsWith('/admin/') && !location.pathname.endsWith('/admin')) {
      location.href = '/admin/';
    }
    throw new Error('Unauthorized');
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j.error ?? j.message ?? text;
    } catch {}
    const errMsg = msg || `HTTP ${res.status}`;
    reportClientError({
      message: `api_error ${init?.method ?? 'GET'} ${path}`,
      component: 'admin.api',
      context: { status: res.status, body: errMsg.slice(0, 500), method: init?.method ?? 'GET', path },
    });
    throw new Error(errMsg);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export function formatCents(cents: number | null | undefined, currency = 'usd'): string {
  if (cents == null) return '-';
  const sym = currency.toLowerCase() === 'usd' ? '$' : currency.toUpperCase() + ' ';
  return `${sym}${(cents / 100).toFixed(2)}`;
}
