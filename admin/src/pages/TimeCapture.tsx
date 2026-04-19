import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { clearTimer, getTimer, listPending, queueEntry, removeEntry, saveTimer } from '../timeDB';
import { installAutoSync, syncPending } from '../timeSync';

interface Client {
  id: string;
  display_name: string;
  email: string | null;
}

interface Pending {
  id: string;
  customer_id: string;
  minutes: number;
  description: string | null;
  entry_date: string;
  billable: boolean;
  client_created_at: number;
  synced_at: number | null;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function TimeCapture() {
  const [clients, setClients] = useState<Client[]>([]);
  const [online, setOnline] = useState<boolean>(navigator.onLine);
  const [pending, setPending] = useState<Pending[]>([]);
  const [form, setForm] = useState({
    customer_id: '',
    minutes: '',
    description: '',
    entry_date: todayIso(),
    billable: true,
  });
  const [timer, setTimer] = useState({ running: false, customer_id: '', description: '', billable: true, started_at: 0 });
  const [, tick] = useState(0);
  const tickRef = useRef<number | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  async function refreshPending() {
    const all = await listPending();
    setPending(all);
  }

  async function refreshClients() {
    try {
      const data = await api<{ clients: Client[] }>('/api/admin/clients');
      setClients(data.clients);
      try {
        localStorage.setItem('time.clientCache', JSON.stringify(data.clients));
      } catch {}
    } catch {
      try {
        const cached = localStorage.getItem('time.clientCache');
        if (cached) setClients(JSON.parse(cached));
      } catch {}
    }
  }

  useEffect(() => {
    refreshClients();
    refreshPending();
    getTimer().then((t) => {
      setTimer({ running: t.running, customer_id: t.customer_id ?? '', description: t.description, billable: t.billable, started_at: t.started_at ?? 0 });
    });
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    installAutoSync(() => refreshPending());
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    if (timer.running) {
      tickRef.current = window.setInterval(() => tick((n) => n + 1), 1000);
      return () => {
        if (tickRef.current) window.clearInterval(tickRef.current);
      };
    }
  }, [timer.running]);

  async function saveEntry(e: React.FormEvent) {
    e.preventDefault();
    const minutes = parseInt(form.minutes, 10);
    if (!form.customer_id || !minutes || minutes <= 0) return;
    await queueEntry({
      customer_id: form.customer_id,
      minutes,
      description: form.description || null,
      entry_date: form.entry_date,
      billable: form.billable,
    });
    setForm((f) => ({ ...f, minutes: '', description: '' }));
    setSaveStatus(online ? 'Saved, syncing…' : 'Saved offline');
    await refreshPending();
    if (online) {
      const res = await syncPending();
      if (res.synced > 0) setSaveStatus(`Synced ${res.synced}`);
      else if (res.failed > 0) setSaveStatus(`Queued (${res.failed} pending sync)`);
      await refreshPending();
    }
    window.setTimeout(() => setSaveStatus(null), 3000);
  }

  async function startTimer() {
    if (!timer.customer_id) return;
    const next = { ...timer, running: true, started_at: Date.now() };
    setTimer(next);
    await saveTimer({
      running: true,
      customer_id: next.customer_id,
      description: next.description,
      billable: next.billable,
      started_at: next.started_at,
    });
  }

  async function stopAndSave() {
    if (!timer.running || !timer.started_at) return;
    const elapsedMs = Date.now() - timer.started_at;
    const minutes = Math.max(1, Math.round(elapsedMs / 60000));
    await queueEntry({
      customer_id: timer.customer_id,
      minutes,
      description: timer.description || null,
      entry_date: todayIso(),
      billable: timer.billable,
    });
    await clearTimer();
    setTimer({ running: false, customer_id: '', description: '', billable: true, started_at: 0 });
    await refreshPending();
    if (online) await syncPending();
    await refreshPending();
    setSaveStatus(`Timer saved: ${minutes} min`);
    window.setTimeout(() => setSaveStatus(null), 3000);
  }

  async function discardPending(id: string) {
    await removeEntry(id);
    await refreshPending();
  }

  const elapsedMinutes = timer.running && timer.started_at
    ? Math.floor((Date.now() - timer.started_at) / 60000)
    : 0;
  const elapsedSeconds = timer.running && timer.started_at
    ? Math.floor(((Date.now() - timer.started_at) % 60000) / 1000)
    : 0;

  const unsyncedCount = pending.filter((p) => p.synced_at == null).length;

  return (
    <div className="space-y-6 max-w-xl mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-neutral-100">Time</h1>
        <div className="flex items-center gap-2 text-xs">
          <span className={`inline-block w-2 h-2 rounded-full ${online ? 'bg-emerald-400' : 'bg-amber-400'}`} />
          <span className="text-neutral-400">{online ? 'online' : 'offline'}</span>
          {unsyncedCount > 0 && <span className="text-amber-400">· {unsyncedCount} pending</span>}
        </div>
      </div>

      <section className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm uppercase tracking-wider text-neutral-500">Timer</h2>
          {timer.running && (
            <div className="text-3xl font-mono text-emerald-400 tabular-nums">
              {String(elapsedMinutes).padStart(2, '0')}:{String(elapsedSeconds).padStart(2, '0')}
            </div>
          )}
        </div>
        <select
          value={timer.customer_id}
          disabled={timer.running}
          onChange={(e) => setTimer({ ...timer, customer_id: e.target.value })}
          className="w-full bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm disabled:opacity-50"
        >
          <option value="">Select client…</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}
        </select>
        <input
          type="text"
          value={timer.description}
          onChange={(e) => setTimer({ ...timer, description: e.target.value })}
          placeholder="What are you working on?"
          className="w-full bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm"
        />
        {!timer.running ? (
          <button
            onClick={startTimer}
            disabled={!timer.customer_id}
            className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-700 text-white rounded-md px-4 py-3 font-medium"
          >
            Start
          </button>
        ) : (
          <button
            onClick={stopAndSave}
            className="w-full bg-red-600 hover:bg-red-500 text-white rounded-md px-4 py-3 font-medium"
          >
            Stop and save
          </button>
        )}
      </section>

      <form onSubmit={saveEntry} className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 space-y-3">
        <h2 className="text-sm uppercase tracking-wider text-neutral-500">Quick entry</h2>
        <select
          required
          value={form.customer_id}
          onChange={(e) => setForm({ ...form, customer_id: e.target.value })}
          className="w-full bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm"
        >
          <option value="">Select client…</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}
        </select>
        <div className="grid grid-cols-2 gap-3">
          <input
            required
            type="number"
            min="1"
            max="1440"
            placeholder="Minutes"
            value={form.minutes}
            onChange={(e) => setForm({ ...form, minutes: e.target.value })}
            className="bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm"
          />
          <input
            type="date"
            value={form.entry_date}
            onChange={(e) => setForm({ ...form, entry_date: e.target.value })}
            className="bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm"
          />
        </div>
        <input
          type="text"
          placeholder="Description (optional)"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          className="w-full bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm"
        />
        <label className="flex items-center gap-2 text-sm text-neutral-400">
          <input
            type="checkbox"
            checked={form.billable}
            onChange={(e) => setForm({ ...form, billable: e.target.checked })}
          />
          Billable
        </label>
        <button
          type="submit"
          className="w-full bg-indigo-600 hover:bg-indigo-500 text-white rounded-md px-4 py-2 font-medium"
        >
          Save entry
        </button>
        {saveStatus && <div className="text-xs text-emerald-400">{saveStatus}</div>}
      </form>

      <section className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm uppercase tracking-wider text-neutral-500">Recent</h2>
          {unsyncedCount > 0 && online && (
            <button onClick={() => syncPending().then(refreshPending)} className="text-xs text-indigo-400 hover:text-indigo-300">
              Sync now
            </button>
          )}
        </div>
        {pending.length === 0 ? (
          <p className="text-sm text-neutral-500 py-4">No entries yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-800">
            {pending.map((p) => {
              const c = clients.find((x) => x.id === p.customer_id);
              return (
                <li key={p.id} className="py-2 flex items-center gap-3 text-sm">
                  <div className="flex-1 min-w-0">
                    <div className="text-neutral-200 truncate">
                      {c?.display_name ?? p.customer_id} · {p.minutes}m
                      {!p.billable && <span className="text-neutral-500"> (non-billable)</span>}
                    </div>
                    <div className="text-xs text-neutral-500 truncate">
                      {p.entry_date}
                      {p.description ? ` · ${p.description}` : ''}
                    </div>
                  </div>
                  {p.synced_at != null ? (
                    <span className="text-xs text-emerald-400">synced</span>
                  ) : (
                    <>
                      <span className="text-xs text-amber-400">pending</span>
                      <button onClick={() => discardPending(p.id)} className="text-xs text-neutral-500 hover:text-red-400">
                        discard
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
