import { FormEvent, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatCents } from '../api';
import { listPending, syncPending } from '../timeSync';
import type { TimeEntryStatus } from '../timeSync';

interface ServerTimeEntry {
  id: string;
  customer_id: string;
  minutes: number;
  description: string | null;
  entry_date: string;
  billable: boolean;
  status: TimeEntryStatus;
  stripe_invoice_item_id: string | null;
  stripe_invoice_id?: string | null;
  pushed_at?: number | null;
  billed_at?: number | null;
  created_at?: number;
}

interface UnifiedTimeEntry extends ServerTimeEntry {
  local_pending: boolean;
}

interface ClientDetailData {
  id: string;
  email: string | null;
  display_name: string;
  delivery_mode: 'pdf_invoice' | 'auto_charge_silent';
  hourly_rate_cents: number | null;
  notes: string | null;
  subscriptions: Array<{
    id: string;
    status: string;
    paused: boolean;
    pause_behavior: string | null;
    resumes_at: number | null;
    current_period_end: number | null;
    items: Array<{ plan_name: string | null; amount: number | null; currency: string; interval?: string }>;
  }>;
  invoices: Array<{
    id: string;
    number: string | null;
    amount_due: number;
    amount_paid: number;
    currency: string;
    status: string | null;
    hosted_invoice_url: string | null;
    created: number;
  }>;
  time_entries: ServerTimeEntry[];
}

function centsToDollars(c: number | null | undefined): string {
  if (c == null) return '';
  return (c / 100).toFixed(2);
}

export default function ClientDetail() {
  const { id } = useParams();
  const [data, setData] = useState<ClientDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<UnifiedTimeEntry[]>([]);
  const [selectedDrafts, setSelectedDrafts] = useState<Set<string>>(new Set());
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushResult, setPushResult] = useState<string | null>(null);
  const [showOneOff, setShowOneOff] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  async function mergeEntries(serverEntries: ServerTimeEntry[]): Promise<UnifiedTimeEntry[]> {
    const byId = new Map<string, UnifiedTimeEntry>();
    for (const e of serverEntries) {
      byId.set(e.id, { ...e, local_pending: false });
    }
    const pending = await listPending();
    for (const p of pending) {
      if (p.customer_id !== id) continue;
      if (byId.has(p.id)) continue;
      byId.set(p.id, {
        id: p.id,
        customer_id: p.customer_id,
        minutes: p.minutes,
        description: p.description,
        entry_date: p.entry_date,
        billable: p.billable,
        status: 'draft',
        stripe_invoice_item_id: null,
        local_pending: p.synced_at == null,
      });
    }
    return [...byId.values()].sort((a, b) => b.entry_date.localeCompare(a.entry_date));
  }

  async function load() {
    if (!id) return;
    try {
      await syncPending().catch(() => {});
      const d = await api<ClientDetailData>(`/api/admin/clients/${id}`);
      setData(d);
      setEntries(await mergeEntries(d.time_entries));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  async function pushSelected() {
    if (selectedDrafts.size === 0) return;
    setPushing(true);
    setPushError(null);
    setPushResult(null);
    try {
      const res = await api<{ pushed: { amount_cents: number }[] }>('/api/time/push', {
        method: 'POST',
        body: JSON.stringify({ entry_ids: [...selectedDrafts] }),
      });
      const total = res.pushed.reduce((s, p) => s + p.amount_cents, 0);
      setPushResult(`Pushed ${res.pushed.length} entries (${formatCents(total)}) to Stripe.`);
      setSelectedDrafts(new Set());
      load();
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'push failed');
    } finally {
      setPushing(false);
    }
  }

  async function pauseSub(subId: string) {
    setActionBusy(subId);
    try {
      await api(`/api/admin/subscriptions/${subId}/pause`, { method: 'POST', body: JSON.stringify({ behavior: 'void' }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'pause failed');
    } finally {
      setActionBusy(null);
    }
  }

  async function resumeSub(subId: string) {
    setActionBusy(subId);
    try {
      await api(`/api/admin/subscriptions/${subId}/resume`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'resume failed');
    } finally {
      setActionBusy(null);
    }
  }

  async function markInvoicePaid(invoiceId: string) {
    if (!confirm('Mark this invoice paid out-of-band? Use for checks or offline payments.')) return;
    setActionBusy(invoiceId);
    try {
      await api(`/api/admin/invoices/${invoiceId}/mark-paid`, { method: 'POST', body: JSON.stringify({ payment_method: 'check' }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'mark-paid failed');
    } finally {
      setActionBusy(null);
    }
  }

  if (error) return <div className="text-red-400 text-sm">{error}</div>;
  if (!data) return <div className="text-neutral-500 text-sm">Loading…</div>;

  const drafts = entries.filter((e) => e.status === 'draft' && !e.local_pending);
  const pending = entries.filter((e) => e.local_pending);
  const pushed = entries.filter((e) => e.status === 'pushed');
  const billed = entries.filter((e) => e.status === 'billed');

  return (
    <div className="space-y-6">
      <div>
        <Link to="/clients" className="text-xs text-neutral-500 hover:text-neutral-300">← Clients</Link>
        <div className="mt-2 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-neutral-100">{data.display_name}</h1>
            <div className="text-sm text-neutral-400 mt-1">{data.email}</div>
          </div>
          <button
            onClick={() => setShowEdit(true)}
            className="bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded-md px-3 py-1.5 text-sm"
          >
            Edit client
          </button>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <InfoCard label="Delivery mode" value={data.delivery_mode} highlight={data.delivery_mode === 'auto_charge_silent'} />
        <InfoCard label="Hourly rate" value={data.hourly_rate_cents != null ? `${formatCents(data.hourly_rate_cents)}/hr` : 'not set'} />
        <InfoCard label="Notes" value={data.notes ?? '—'} />
      </div>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-medium text-neutral-100">Subscriptions</h2>
          <Link to={`/clients/${data.id}/new-subscription`} className="bg-indigo-600 hover:bg-indigo-500 text-white rounded-md px-3 py-1.5 text-sm font-medium">
            + New subscription
          </Link>
        </div>
        {data.subscriptions.length === 0 ? (
          <p className="text-sm text-neutral-500">No subscriptions yet.</p>
        ) : (
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-neutral-950 text-xs uppercase tracking-wider text-neutral-500">
                <tr><th className="text-left px-4 py-2">Plan</th><th className="text-left px-4 py-2">Amount</th><th className="text-left px-4 py-2">Status</th><th className="text-left px-4 py-2">Next invoice</th><th className="text-left px-4 py-2"></th></tr>
              </thead>
              <tbody>
                {data.subscriptions.map((s) => (
                  <tr key={s.id} className="border-t border-neutral-800">
                    <td className="px-4 py-2">{s.items[0]?.plan_name ?? '-'}</td>
                    <td className="px-4 py-2">{s.items[0]?.amount != null ? `${formatCents(s.items[0].amount, s.items[0].currency)}/${s.items[0].interval}` : '-'}</td>
                    <td className="px-4 py-2">
                      <StatusPill value={s.paused ? 'paused' : s.status} />
                      {s.paused && s.pause_behavior && <span className="ml-2 text-xs text-neutral-500">({s.pause_behavior})</span>}
                    </td>
                    <td className="px-4 py-2 text-neutral-400">{s.paused ? '—' : s.current_period_end ? new Date(s.current_period_end * 1000).toLocaleDateString() : '-'}</td>
                    <td className="px-4 py-2 text-right">
                      {s.paused ? (
                        <button onClick={() => resumeSub(s.id)} disabled={actionBusy === s.id} className="text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-50">
                          {actionBusy === s.id ? '…' : 'Resume'}
                        </button>
                      ) : (
                        <button onClick={() => pauseSub(s.id)} disabled={actionBusy === s.id} className="text-xs text-amber-400 hover:text-amber-300 disabled:opacity-50">
                          {actionBusy === s.id ? '…' : 'Pause'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-medium text-neutral-100">
            Time entries
            <span className="ml-2 text-sm text-neutral-500">
              ({drafts.length} draft{pending.length > 0 ? ` · ${pending.length} pending sync` : ''})
            </span>
          </h2>
          <div className="flex gap-2">
            <button
              onClick={pushSelected}
              disabled={selectedDrafts.size === 0 || pushing}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-neutral-700 text-white rounded-md px-3 py-1.5 text-sm font-medium"
            >
              {pushing ? 'Pushing…' : `Push ${selectedDrafts.size} to next invoice`}
            </button>
            <button
              onClick={() => setShowOneOff(true)}
              className="bg-neutral-800 hover:bg-neutral-700 text-white rounded-md px-3 py-1.5 text-sm"
            >
              One-off invoice
            </button>
          </div>
        </div>
        {pushError && <div className="text-sm text-red-400 mb-2">{pushError}</div>}
        {pushResult && <div className="text-sm text-emerald-400 mb-2">{pushResult}</div>}
        {entries.length === 0 ? (
          <p className="text-sm text-neutral-500">No time entries.</p>
        ) : (
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-neutral-950 text-xs uppercase tracking-wider text-neutral-500">
                <tr>
                  <th className="text-left px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={drafts.length > 0 && selectedDrafts.size === drafts.filter((d) => d.billable).length}
                      onChange={(e) => {
                        if (e.target.checked) setSelectedDrafts(new Set(drafts.filter((d) => d.billable).map((d) => d.id)));
                        else setSelectedDrafts(new Set());
                      }}
                    />
                  </th>
                  <th className="text-left px-3 py-2">Date</th>
                  <th className="text-left px-3 py-2">Minutes</th>
                  <th className="text-left px-3 py-2">Description</th>
                  <th className="text-left px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const selectable = e.status === 'draft' && !e.local_pending && e.billable;
                  return (
                    <tr key={e.id} className="border-t border-neutral-800">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          disabled={!selectable}
                          checked={selectedDrafts.has(e.id)}
                          onChange={(ev) => {
                            setSelectedDrafts((prev) => {
                              const next = new Set(prev);
                              if (ev.target.checked) next.add(e.id); else next.delete(e.id);
                              return next;
                            });
                          }}
                        />
                      </td>
                      <td className="px-3 py-2 text-neutral-400">{e.entry_date}</td>
                      <td className="px-3 py-2">{e.minutes}</td>
                      <td className="px-3 py-2 text-neutral-400">
                        {e.description ?? '—'}
                        {!e.billable && <span className="ml-2 text-xs text-neutral-500">(non-billable)</span>}
                      </td>
                      <td className="px-3 py-2">
                        {e.local_pending ? (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/30">pending sync</span>
                        ) : (
                          <StatusPill value={e.status} />
                        )}
                      </td>
                    </tr>
                  );
                })}
                {pushed.length > 0 && (
                  <tr className="border-t border-neutral-800 bg-neutral-950/50">
                    <td colSpan={5} className="px-3 py-1 text-xs text-neutral-500">
                      {pushed.length} pushed (awaiting next invoice), {billed.length} billed
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showOneOff && (
        <OneOffInvoice customerId={data.id} defaultDescription={`Services for ${data.display_name}`} onClose={(ok) => { setShowOneOff(false); if (ok) load(); }} />
      )}

      {showEdit && (
        <EditClient
          client={{
            id: data.id,
            display_name: data.display_name,
            email: data.email ?? '',
            delivery_mode: data.delivery_mode,
            hourly_rate_cents: data.hourly_rate_cents,
            notes: data.notes,
          }}
          onClose={(ok) => { setShowEdit(false); if (ok) load(); }}
        />
      )}

      <section>
        <h2 className="text-lg font-medium text-neutral-100 mb-3">Recent invoices</h2>
        {data.invoices.length === 0 ? (
          <p className="text-sm text-neutral-500">No invoices yet.</p>
        ) : (
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-neutral-950 text-xs uppercase tracking-wider text-neutral-500">
                <tr><th className="text-left px-4 py-2">Number</th><th className="text-left px-4 py-2">Amount</th><th className="text-left px-4 py-2">Status</th><th className="text-left px-4 py-2">Date</th><th className="text-left px-4 py-2"></th></tr>
              </thead>
              <tbody>
                {data.invoices.map((inv) => {
                  const isUnpaid = inv.status === 'open' || inv.status === 'draft' || inv.status === 'uncollectible';
                  return (
                    <tr key={inv.id} className="border-t border-neutral-800">
                      <td className="px-4 py-2 font-mono text-xs">{inv.number ?? inv.id}</td>
                      <td className="px-4 py-2">{formatCents(inv.amount_due, inv.currency)}</td>
                      <td className="px-4 py-2"><StatusPill value={inv.status ?? 'n/a'} /></td>
                      <td className="px-4 py-2 text-neutral-400">{new Date(inv.created * 1000).toLocaleDateString()}</td>
                      <td className="px-4 py-2 text-right space-x-3">
                        {inv.hosted_invoice_url && <a href={inv.hosted_invoice_url} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300 text-xs">View</a>}
                        {isUnpaid && (
                          <button onClick={() => markInvoicePaid(inv.id)} disabled={actionBusy === inv.id} className="text-emerald-400 hover:text-emerald-300 text-xs disabled:opacity-50">
                            {actionBusy === inv.id ? '…' : 'Mark paid'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function InfoCard({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
      <div className="text-xs uppercase tracking-wider text-neutral-500">{label}</div>
      <div className={`mt-1 text-neutral-100 ${highlight ? 'text-amber-400' : ''}`}>{value}</div>
    </div>
  );
}

function StatusPill({ value }: { value: string }) {
  const color =
    value === 'paid' || value === 'active' || value === 'billed' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
    : value === 'open' || value === 'trialing' || value === 'pushed' ? 'bg-blue-500/10 text-blue-400 border-blue-500/30'
    : value === 'paused' || value === 'draft' ? 'bg-neutral-700/30 text-neutral-300 border-neutral-600/30'
    : value === 'canceled' || value === 'uncollectible' || value === 'past_due' ? 'bg-red-500/10 text-red-400 border-red-500/30'
    : 'bg-neutral-800 text-neutral-400 border-neutral-700';
  return <span className={`inline-block px-2 py-0.5 text-xs rounded-full border ${color}`}>{value}</span>;
}

function EditClient({
  client,
  onClose,
}: {
  client: { id: string; display_name: string; email: string; delivery_mode: 'pdf_invoice' | 'auto_charge_silent'; hourly_rate_cents: number | null; notes: string | null };
  onClose: (ok: boolean) => void;
}) {
  const [form, setForm] = useState({
    display_name: client.display_name,
    email: client.email,
    delivery_mode: client.delivery_mode,
    hourly_rate: centsToDollars(client.hourly_rate_cents),
    notes: client.notes ?? '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        display_name: form.display_name,
        email: form.email,
        delivery_mode: form.delivery_mode,
        notes: form.notes.length > 0 ? form.notes : null,
      };
      if (form.hourly_rate.trim() === '') {
        payload.hourly_rate_cents = null;
      } else {
        const cents = Math.round(parseFloat(form.hourly_rate) * 100);
        if (!Number.isFinite(cents) || cents < 0) throw new Error('invalid hourly rate');
        payload.hourly_rate_cents = cents;
      }
      await api(`/api/admin/clients/${client.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-20 px-4">
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-neutral-100">Edit client</h3>
          <button onClick={() => onClose(false)} className="text-neutral-500 hover:text-neutral-200">×</button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Display name">
            <input required value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} className="w-full bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm" />
          </Field>
          <Field label="Email">
            <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="w-full bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm" />
          </Field>
          <Field label="Delivery mode">
            <select value={form.delivery_mode} onChange={(e) => setForm({ ...form, delivery_mode: e.target.value as any })} className="w-full bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm">
              <option value="pdf_invoice">pdf_invoice (email receipt)</option>
              <option value="auto_charge_silent">auto_charge_silent (no email)</option>
            </select>
          </Field>
          <Field label="Hourly rate (USD, blank = not set)">
            <input type="number" step="0.01" min="0" value={form.hourly_rate} onChange={(e) => setForm({ ...form, hourly_rate: e.target.value })} className="w-full bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm" />
          </Field>
          <Field label="Notes">
            <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={3} className="w-full bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm resize-y" />
          </Field>
          {error && <div className="text-xs text-red-400">{error}</div>}
          <div className="flex gap-2 pt-2">
            <button type="submit" disabled={submitting} className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:bg-neutral-700 text-white rounded-md px-4 py-2 text-sm font-medium">
              {submitting ? 'Saving…' : 'Save changes'}
            </button>
            <button type="button" onClick={() => onClose(false)} className="bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded-md px-4 py-2 text-sm">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wider text-neutral-500 mb-1">{label}</span>
      {children}
    </label>
  );
}

function OneOffInvoice({ customerId, defaultDescription, onClose }: { customerId: string; defaultDescription: string; onClose: (ok: boolean) => void }) {
  const [form, setForm] = useState({
    amount: '',
    description: defaultDescription,
    send_email: true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ hosted_invoice_url: string | null; number: string | null } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await api<{ hosted_invoice_url: string | null; number: string | null }>(
        `/api/admin/clients/${customerId}/invoice`,
        {
          method: 'POST',
          body: JSON.stringify({
            amount_cents: Math.round(parseFloat(form.amount) * 100),
            description: form.description,
            send_email: form.send_email,
          }),
        },
      );
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-20 px-4">
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-neutral-100">One-off invoice</h3>
          <button onClick={() => onClose(result !== null)} className="text-neutral-500 hover:text-neutral-200">×</button>
        </div>
        {result ? (
          <div className="space-y-3">
            <p className="text-sm text-emerald-400">Invoice {result.number ?? ''} created and {form.send_email ? 'sent' : 'finalized'}.</p>
            {result.hosted_invoice_url && (
              <a href={result.hosted_invoice_url} target="_blank" rel="noopener noreferrer" className="block text-sm text-indigo-400 hover:text-indigo-300">
                Open hosted invoice
              </a>
            )}
            <button onClick={() => onClose(true)} className="bg-neutral-800 hover:bg-neutral-700 rounded-md px-4 py-2 text-sm">Done</button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <Field label="Amount (USD)">
              <input type="number" step="0.01" min="0.5" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="w-full bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm" />
            </Field>
            <Field label="Description">
              <input type="text" required value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm" />
            </Field>
            <label className="flex items-center gap-2 text-sm text-neutral-400">
              <input type="checkbox" checked={form.send_email} onChange={(e) => setForm({ ...form, send_email: e.target.checked })} />
              Email hosted invoice to client via Stripe
            </label>
            {error && <div className="text-xs text-red-400">{error}</div>}
            <button type="submit" disabled={submitting} className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-neutral-700 text-white rounded-md px-4 py-2 text-sm font-medium">
              {submitting ? 'Creating…' : 'Create and finalize'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
