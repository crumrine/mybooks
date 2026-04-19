export interface AxiomEnv {
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  AXIOM_REGION?: string;
  AXIOM_APP_ID?: string;
  AXIOM_ENV?: string;
}

export type AxiomLevel = 'info' | 'warn' | 'error';

export interface AxiomEvent {
  _time?: string;
  app: string;
  env: string;
  level: AxiomLevel;
  component: string;
  message: string;
  [key: string]: unknown;
}

interface AxiomContext {
  env: AxiomEnv;
  baseFields: Record<string, unknown>;
  waitUntil?: (p: Promise<unknown>) => void;
}

function ingestUrl(env: AxiomEnv): string | null {
  if (!env.AXIOM_TOKEN || !env.AXIOM_DATASET) return null;
  const region = (env.AXIOM_REGION ?? 'us').toLowerCase();
  const host = region === 'eu' ? 'api.eu.axiom.co' : 'api.axiom.co';
  return `https://${host}/v1/datasets/${encodeURIComponent(env.AXIOM_DATASET)}/ingest`;
}

async function postIngest(env: AxiomEnv, events: AxiomEvent[]): Promise<void> {
  const url = ingestUrl(env);
  if (!url || events.length === 0) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.AXIOM_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(events),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('[axiom] ingest failed', res.status, text.slice(0, 200));
    }
  } catch (err) {
    console.warn('[axiom] ingest threw:', err instanceof Error ? err.message : err);
  }
}

export function createAxiomLogger(env: AxiomEnv, opts?: { component?: string; fields?: Record<string, unknown>; waitUntil?: (p: Promise<unknown>) => void }) {
  const ctx: AxiomContext = {
    env,
    baseFields: {
      app: env.AXIOM_APP_ID ?? 'mybooks',
      env: env.AXIOM_ENV ?? 'prod',
      component: opts?.component ?? 'worker',
      ...(opts?.fields ?? {}),
    },
    waitUntil: opts?.waitUntil,
  };

  function emit(level: AxiomLevel, message: string, extra?: Record<string, unknown>) {
    const ev: AxiomEvent = {
      _time: new Date().toISOString(),
      level,
      message,
      ...ctx.baseFields,
      ...(extra ?? {}),
    } as AxiomEvent;

    const promise = postIngest(env, [ev]);
    if (ctx.waitUntil) ctx.waitUntil(promise);
    return promise;
  }

  return {
    info: (message: string, fields?: Record<string, unknown>) => emit('info', message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => emit('warn', message, fields),
    error: (message: string, fields?: Record<string, unknown>) => emit('error', message, fields),
    child: (component: string, fields?: Record<string, unknown>) =>
      createAxiomLogger(env, {
        component,
        fields: { ...ctx.baseFields, ...(fields ?? {}) },
        waitUntil: ctx.waitUntil,
      }),
  };
}

export type AxiomLogger = ReturnType<typeof createAxiomLogger>;

export function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      error_name: err.name,
      error_message: err.message,
      error_stack: err.stack?.split('\n').slice(0, 10).join('\n'),
    };
  }
  return { error_message: String(err) };
}
