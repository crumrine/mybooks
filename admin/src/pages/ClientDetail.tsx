import { FormEvent, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatCents } from '../api';

interface TimeEntry {
  id: string;
  customer_id: string;
  minutes: number;
  description: string | null;
  entry_date: string;
  billable: boolean;
  status: string;
  stripe_invoice_item_id: string | null;
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
}

export default function ClientDetail() {
  const { id } = useParams();
  const [data, setData] = useState<ClientDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<TimeEntry[]>([]);
  const [selectedDrafts, setSelectedDrafts] = useState<Set<string>>(new Set());
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushResult, setPushResult] = useState<string | null>(null);
  const [showOneOff, setShowOneOff] = useState(false);

  function load() {
    if (!id) return;
    api<ClientDetailData>(`/api/admin/clients/${id}`).then(setData).catch((e) => setError(e.message));
    api<{ entries: TimeEntry[] }>(`/api/time?customer_id=${id}&status=draft`).then((d) => setDrafts(d.entries)).catch(() => {});
  }

  useEffect(load, [id]);

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

  if (error) return <div className="text-red-400 text-sm">{error}</div>;
  if (!data) return <div className="text-neutral-500 text-sm">Loading…</div>;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/clients" className="text-xs text-neutral-500 hover:text-neutral-300">← Clients</Link>
        <h1 className="text-2xl font-semibold text-neutral-100 mt-2">{data.display_name}</h1>
        <div className="text-sm text-neutral-400 mt-1">{data.email}</div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <InfoCard label="Delivery mode" value={data.delivery_mode} highlight={data.delivery_mode === 'auto_charge_silent'} />
        <InfoCard label="Hourly rate" value={data.hourly_rate_cents != null ? `${formatCents(data.hourly_rate_cents)}/hr` : '-'} />
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
                <tr><th className="text-left px-4 py-2">Plan</th><th className="text-left px-4 py-2">Amount</th><th className="text-left px-4 py-2">Status</th><th className="text-left px-4 py-2">Next invoice</th></tr>
              </thead>
              <tbody>
                {data.subscriptions.map((s) => (
                  <tr key={s.id} className="border-t border-neutral-800">
                    <td className="px-4 py-2">{s.items[0]?.plan_name ?? '-'}</td>
                    <td className="px-4 py-2">{s.items[0]?.amount != null ? `${formatCents(s.items[0].amount, s.items[0].currency)}/${s.items[0].interval}` : '-'}</td>
                    <td className="px-4 py-2"><StatusPill value={s.status} /></td>
                    <td className="px-4 py-2 text-neutral-400">{s.current_period_end ? new Date(s.current_period_end * 1000).toLocaleDateString() : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-medium text-neutral-100">Unbilled time ({drafts.length})</h2>
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
        {drafts.length === 0 ? (
          <p className="text-sm text-neutral-500">No unbilled time entries.</p>
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
                  <th className="text-left px-3 py-2">Billable</th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((d) => (
                  <tr key={d.id} className="border-t border-neutral-800">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        disabled={!d.billable}
                        checked={selectedDrafts.has(d.id)}
                        onChange={(e) => {
                          setSelectedDrafts((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(d.id); else next.delete(d.id);
                            return next;
                          });
                        }}
                      />
                    </td>
                    <td className="px-3 py-2 text-neutral-400">{d.entry_date}</td>
                    <td className="px-3 py-2">{d.minutes}</td>
                    <td className="px-3 py-2 text-neutral-400">{d.description ?? '-'}</td>
                    <td className="px-3 py-2 text-neutral-500">{d.billable ? 'yes' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showOneOff && (
        <OneOffInvoice customerId={data.id} defaultDescription={`Services for ${data.display_name}`} onClose={(ok) => { setShowOneOff(false); if (ok) load(); }} />
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
                {data.invoices.map((inv) => (
                  <tr key={inv.id} className="border-t border-neutral-800">
                    <td className="px-4 py-2 font-mono text-xs">{inv.number ?? inv.id}</td>
                    <td className="px-4 py-2">{formatCents(inv.amount_due, inv.currency)}</td>
                    <td className="px-4 py-2"><StatusPill value={inv.status ?? 'n/a'} /></td>
                    <td className="px-4 py-2 text-neutral-400">{new Date(inv.created * 1000).toLocaleDateString()}</td>
                    <td className="px-4 py-2">{inv.hosted_invoice_url && <a href={inv.hosted_invoice_url} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300 text-xs">View</a>}</td>
                  </tr>
                ))}
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
            <label className="block">
              <span className="block text-xs uppercase tracking-wider text-neutral-500 mb-1">Amount (USD)</span>
              <input
                type="number"
                step="0.01"
                min="0.5"
                required
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                className="w-full bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="block text-xs uppercase tracking-wider text-neutral-500 mb-1">Description</span>
              <input
                type="text"
                required
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="w-full bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm"
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-neutral-400">
              <input
                type="checkbox"
                checked={form.send_email}
                onChange={(e) => setForm({ ...form, send_email: e.target.checked })}
              />
              Email hosted invoice to client via Stripe
            </label>
            {error && <div className="text-xs text-red-400">{error}</div>}
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-neutral-700 text-white rounded-md px-4 py-2 text-sm font-medium"
            >
              {submitting ? 'Creating…' : 'Create and finalize'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function StatusPill({ value }: { value: string }) {
  const color =
    value === 'paid' || value === 'active' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
    : value === 'open' || value === 'trialing' ? 'bg-blue-500/10 text-blue-400 border-blue-500/30'
    : value === 'canceled' || value === 'uncollectible' || value === 'past_due' ? 'bg-red-500/10 text-red-400 border-red-500/30'
    : 'bg-neutral-800 text-neutral-400 border-neutral-700';
  return <span className={`inline-block px-2 py-0.5 text-xs rounded-full border ${color}`}>{value}</span>;
}
