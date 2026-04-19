import { useEffect, useState } from 'react';
import { api, formatCents } from '../api';

interface DashboardData {
  mrr_cents: number;
  active_subscriptions: number;
  open_invoices: number;
  uncollectible_invoices: number;
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<DashboardData>('/api/admin/dashboard')
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="text-red-400 text-sm">{error}</div>;
  if (!data) return <div className="text-neutral-500 text-sm">Loading…</div>;

  const cards = [
    { label: 'MRR', value: formatCents(data.mrr_cents) },
    { label: 'Active subscriptions', value: String(data.active_subscriptions) },
    { label: 'Open invoices', value: String(data.open_invoices) },
    { label: 'Uncollectible', value: String(data.uncollectible_invoices) },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-neutral-100">Dashboard</h1>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cards.map((card) => (
          <div key={card.label} className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
            <div className="text-xs uppercase tracking-wider text-neutral-500">{card.label}</div>
            <div className="text-2xl font-semibold text-neutral-100 mt-1">{card.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
