import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Clients from './pages/Clients';
import ClientDetail from './pages/ClientDetail';
import NewSubscription from './pages/NewSubscription';

export default function App() {
  const [session, setSession] = useState<{ authenticated: boolean; email?: string } | null>(null);
  const location = useLocation();

  useEffect(() => {
    api<{ authenticated: boolean; email?: string }>('/api/auth/me')
      .then(setSession)
      .catch(() => setSession({ authenticated: false }));
  }, [location.pathname]);

  if (session === null) {
    return <div className="min-h-screen flex items-center justify-center text-neutral-500">Loading…</div>;
  }

  if (!session.authenticated) {
    return <Login />;
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-neutral-800 bg-neutral-950 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-6">
          <Link to="/" className="font-semibold text-neutral-100">MyBooks</Link>
          <nav className="flex gap-4 text-sm text-neutral-400">
            <Link to="/" className="hover:text-neutral-100">Dashboard</Link>
            <Link to="/clients" className="hover:text-neutral-100">Clients</Link>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-xs text-neutral-500">
            <span>{session.email}</span>
            <button
              onClick={async () => {
                await api('/api/auth/logout', { method: 'POST' });
                window.location.href = '/admin/';
              }}
              className="text-neutral-400 hover:text-neutral-100"
            >
              Log out
            </button>
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 py-8">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/clients" element={<Clients />} />
          <Route path="/clients/:id" element={<ClientDetail />} />
          <Route path="/clients/:id/new-subscription" element={<NewSubscription />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}
