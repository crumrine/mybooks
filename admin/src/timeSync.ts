import { api } from './api';
import { listUnsynced, markSynced } from './timeDB';
import { reportClientError } from './errorReporting';

let syncInFlight = false;

export async function syncPending(): Promise<{ synced: number; failed: number }> {
  if (syncInFlight) return { synced: 0, failed: 0 };
  syncInFlight = true;
  try {
    const pending = await listUnsynced();
    if (pending.length === 0) return { synced: 0, failed: 0 };

    const payload = pending.map((e) => ({
      id: e.id,
      customer_id: e.customer_id,
      minutes: e.minutes,
      description: e.description,
      entry_date: e.entry_date,
      billable: e.billable,
      client_created_at: e.client_created_at,
    }));

    try {
      const res = await api<{ entries: { id: string }[]; skipped?: { id: string }[] }>('/api/time', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const now = Date.now();
      for (const entry of res.entries) {
        await markSynced(entry.id, now);
      }
      return { synced: res.entries.length, failed: 0 };
    } catch (err) {
      reportClientError({
        message: 'time_sync_failed',
        stack: err instanceof Error ? err.stack : undefined,
        component: 'timeSync',
        context: { pending_count: pending.length },
      });
      return { synced: 0, failed: pending.length };
    }
  } finally {
    syncInFlight = false;
  }
}

export function installAutoSync(onUpdate?: () => void) {
  window.addEventListener('online', () => {
    syncPending().then((r) => {
      if (r.synced > 0 || r.failed > 0) onUpdate?.();
    });
  });
  if (navigator.onLine) {
    setTimeout(() => {
      syncPending().then((r) => {
        if (r.synced > 0) onUpdate?.();
      });
    }, 500);
  }
}
