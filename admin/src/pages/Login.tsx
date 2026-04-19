import { useState } from 'react';
import { api } from '../api';

export default function Login() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    setError(null);
    try {
      await api('/api/auth/request', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      setStatus('sent');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Failed to send link');
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-neutral-900 border border-neutral-800 rounded-xl p-8">
        <h1 className="text-xl font-semibold text-neutral-100 mb-2">Sign in</h1>
        <p className="text-sm text-neutral-400 mb-6">
          Enter your email to receive a sign-in link.
        </p>
        {status === 'sent' ? (
          <div className="text-sm text-neutral-300 space-y-3">
            <p>If that address is the admin account, a sign-in link has been sent. Check your inbox.</p>
            <button
              onClick={() => setStatus('idle')}
              className="text-xs text-neutral-500 hover:text-neutral-300"
            >
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <input
              type="email"
              required
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-indigo-600"
            />
            {error && <div className="text-xs text-red-400">{error}</div>}
            <button
              type="submit"
              disabled={status === 'sending'}
              className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-neutral-700 text-white rounded-md px-4 py-2 text-sm font-medium transition"
            >
              {status === 'sending' ? 'Sending…' : 'Email me a link'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
