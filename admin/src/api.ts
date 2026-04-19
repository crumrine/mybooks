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
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export function formatCents(cents: number | null | undefined, currency = 'usd'): string {
  if (cents == null) return '-';
  const sym = currency.toLowerCase() === 'usd' ? '$' : currency.toUpperCase() + ' ';
  return `${sym}${(cents / 100).toFixed(2)}`;
}
