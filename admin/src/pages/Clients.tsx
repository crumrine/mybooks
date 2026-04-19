import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatCents } from '../api';

interface Client {
  id: string;
  email: string | null;
  display_name: string;
  delivery_mode: 'pdf_invoice' | 'auto_charge_silent';
  hourly_rate_cents: number | null;
  archived: boolean;
}

export default function Clients() {
  const [clients, setClients] = useState<Client[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    email: '',
    display_name: '',
    delivery_mode: 'pdf_invoice' as 'pdf_invoice' | 'auto_charge_silent',
    hourly_rate: '',
  });

  function load() {
    api<{ clients: Client[] }>('/api/admin/clients').then((d) => setClients(d.clients)).catch((e) => setError(e.message));
  }

  useEffect(load, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/admin/clients', {
        method: 'POST',
        body: JSON.stringify({
          email: form.email,
          display_name: form.display_name,
          delivery_mode: form.delivery_mode,
          hourly_rate_cents: form.hourly_rate ? Math.round(parseFloat(form.hourly_rate) * 100) : undefined,
        }),
      });
      setCreating(false);
      setForm({ email: '', display_name: '', delivery_mode: 'pdf_invoice', hourly_rate: '' });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create client');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-neutral-100">Clients</h1>
        <button
          onClick={() => setCreating((v) => !v)}
          className="bg-indigo-600 hover:bg-indigo-500 text-white rounded-md px-3 py-1.5 text-sm font-medium"
        >
          {creating ? 'Cancel' : '+ New client'}
        </button>
      </div>

      {creating && (
        <form onSubmit={create} className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <input
              required
              placeholder="Display name"
              value={form.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              className="bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm"
            />
            <input
              required
              type="email"
              placeholder="Email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <select
              value={form.delivery_mode}
              onChange={(e) => setForm({ ...form, delivery_mode: e.target.value as any })}
              className="bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm"
            >
              <option value="pdf_invoice">pdf_invoice (email receipt)</option>
              <option value="auto_charge_silent">auto_charge_silent (no email)</option>
            </select>
            <input
              type="number"
              step="0.01"
              placeholder="Hourly rate (USD, optional)"
              value={form.hourly_rate}
              onChange={(e) => setForm({ ...form, hourly_rate: e.target.value })}
              className="bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm"
            />
          </div>
          <button type="submit" className="bg-indigo-600 hover:bg-indigo-500 text-white rounded-md px-4 py-2 text-sm font-medium justify-self-start">
            Create
          </button>
          {error && <div className="text-xs text-red-400">{error}</div>}
        </form>
      )}

      {clients === null && !error && <div className="text-sm text-neutral-500">Loading…</div>}
      {error && !creating && <div className="text-sm text-red-400">{error}</div>}
      {clients && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950 text-xs uppercase tracking-wider text-neutral-500">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-4 py-2 font-medium">Email</th>
                <th className="text-left px-4 py-2 font-medium">Delivery</th>
                <th className="text-left px-4 py-2 font-medium">Rate</th>
              </tr>
            </thead>
            <tbody>
              {clients.length === 0 ? (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-neutral-500">No clients yet.</td></tr>
              ) : clients.map((c) => (
                <tr key={c.id} className="border-t border-neutral-800 hover:bg-neutral-950/50">
                  <td className="px-4 py-2"><Link to={`/clients/${c.id}`} className="text-indigo-400 hover:text-indigo-300">{c.display_name}</Link></td>
                  <td className="px-4 py-2 text-neutral-400">{c.email ?? '-'}</td>
                  <td className="px-4 py-2 text-neutral-400">
                    <span className={c.delivery_mode === 'auto_charge_silent' ? 'text-amber-400' : ''}>{c.delivery_mode}</span>
                  </td>
                  <td className="px-4 py-2 text-neutral-400">{c.hourly_rate_cents != null ? `${formatCents(c.hourly_rate_cents)}/hr` : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
