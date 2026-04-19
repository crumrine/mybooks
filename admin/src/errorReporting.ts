export interface ClientErrorEvent {
  message: string;
  stack?: string;
  component?: string;
  level?: 'info' | 'warn' | 'error';
  context?: Record<string, unknown>;
}

export async function reportClientError(ev: ClientErrorEvent): Promise<void> {
  try {
    await fetch('/api/log/client', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...ev,
        url: window.location.href,
        user_agent: navigator.userAgent,
      }),
      keepalive: true,
    });
  } catch {}
}

export function installGlobalErrorHandlers(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (e) => {
    reportClientError({
      message: e.message || 'window.error',
      stack: e.error instanceof Error ? e.error.stack : undefined,
      component: 'window.onerror',
      context: { filename: e.filename, lineno: e.lineno, colno: e.colno },
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    reportClientError({
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
      component: 'unhandledrejection',
    });
  });
}
