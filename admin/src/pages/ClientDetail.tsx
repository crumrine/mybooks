import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatCents } from '../api';

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

  useEffect(() => {
    if (!id) return;
    api<ClientDetailData>(`/api/admin/clients/${id}`).then(setData).catch((e) => setError(e.message));
  }, [id]);

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

function StatusPill({ value }: { value: string }) {
  const color =
    value === 'paid' || value === 'active' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
    : value === 'open' || value === 'trialing' ? 'bg-blue-500/10 text-blue-400 border-blue-500/30'
    : value === 'canceled' || value === 'uncollectible' || value === 'past_due' ? 'bg-red-500/10 text-red-400 border-red-500/30'
    : 'bg-neutral-800 text-neutral-400 border-neutral-700';
  return <span className={`inline-block px-2 py-0.5 text-xs rounded-full border ${color}`}>{value}</span>;
}
