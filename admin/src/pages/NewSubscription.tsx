import { FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';

export default function NewSubscription() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    product_name: '',
    description: '',
    amount: '',
    interval: 'month' as 'day' | 'week' | 'month' | 'year',
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!id) return;
    setError(null);
    setSubmitting(true);
    try {
      await api('/api/admin/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: id,
          product_name: form.product_name,
          description: form.description || undefined,
          amount_cents: Math.round(parseFloat(form.amount) * 100),
          interval: form.interval,
        }),
      });
      navigate(`/clients/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create subscription');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <Link to={`/clients/${id}`} className="text-xs text-neutral-500 hover:text-neutral-300">← Back to client</Link>
        <h1 className="text-2xl font-semibold text-neutral-100 mt-2">New subscription</h1>
      </div>
      <form onSubmit={submit} className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 space-y-4">
        <Field label="Product name">
          <input
            required
            value={form.product_name}
            onChange={(e) => setForm({ ...form, product_name: e.target.value })}
            className="w-full bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Description (optional)">
          <input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="w-full bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount (USD)">
            <input
              required
              type="number"
              step="0.01"
              min="0.5"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Interval">
            <select
              value={form.interval}
              onChange={(e) => setForm({ ...form, interval: e.target.value as any })}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm"
            >
              <option value="month">month</option>
              <option value="year">year</option>
              <option value="week">week</option>
              <option value="day">day</option>
            </select>
          </Field>
        </div>
        {error && <div className="text-xs text-red-400">{error}</div>}
        <button
          type="submit"
          disabled={submitting}
          className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-neutral-700 text-white rounded-md px-4 py-2 text-sm font-medium"
        >
          {submitting ? 'Creating…' : 'Create subscription'}
        </button>
      </form>
      <p className="text-xs text-neutral-500">
        The subscription is created with <code className="text-neutral-400">payment_behavior: default_incomplete</code>.
        Stripe will send the first invoice via the client's saved payment method.
      </p>
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
