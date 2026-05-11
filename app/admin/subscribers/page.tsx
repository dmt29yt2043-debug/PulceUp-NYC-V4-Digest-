'use client';

/**
 * /admin/subscribers — read-only list of collected email subscribers.
 *
 * Auth: enter SUBSCRIBERS_ADMIN_TOKEN in the password field. We pass it as a
 * Bearer header to GET /api/subscribe. The same token lives in the server's
 * env (see route.ts) — there is no client-side validation. If the token is
 * wrong, the API returns 401 and we show an error.
 */

import { useState, useCallback } from 'react';

interface Subscriber {
  id: number;
  email: string;
  signed_up_at: string;
  updated_at: string;
  source: string;
  profile: {
    children: { age: number; gender: string; name?: string; interests: string[] }[];
    neighborhoods: string[];
    budget: string;
    specialNeeds?: string;
  };
  referrer_url?: string;
  welcome_sent_at: string | null;
  last_digest_sent_at: string | null;
  unsubscribed_at: string | null;
}

export default function SubscribersAdminPage() {
  const [token, setToken] = useState('');
  const [auth, setAuth] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subs, setSubs] = useState<Subscriber[]>([]);
  const [total, setTotal] = useState(0);

  const fetchSubs = useCallback(async (bearer: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/subscribe', {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || `HTTP ${res.status}`);
        setSubs([]);
        return false;
      }
      setSubs(data.subscribers || []);
      setTotal(data.total || 0);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fetch failed');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await fetchSubs(token);
    if (ok) setAuth(true);
  };

  const downloadCsv = useCallback(() => {
    const headers = [
      'id', 'email', 'signed_up_at', 'source', 'children', 'neighborhoods',
      'budget', 'special_needs', 'welcome_sent', 'unsubscribed',
    ];
    const escape = (v: unknown) => {
      const s = String(v ?? '');
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const rows = subs.map((s) => [
      s.id,
      s.email,
      s.signed_up_at,
      s.source,
      (s.profile.children || []).map((c) => `${c.gender}:${c.age}`).join(';'),
      (s.profile.neighborhoods || []).join(';'),
      s.profile.budget,
      s.profile.specialNeeds || '',
      s.welcome_sent_at ? 'yes' : 'no',
      s.unsubscribed_at ? 'yes' : 'no',
    ].map(escape).join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pulseup-subscribers-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [subs]);

  if (!auth) {
    return (
      <div style={S.loginWrap}>
        <form onSubmit={handleLogin} style={S.loginForm}>
          <h2 style={{ margin: 0, color: '#fff' }}>PulseUp · Subscribers</h2>
          <input
            type="password"
            placeholder="Admin token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            style={S.input}
            autoFocus
          />
          <button type="submit" style={S.btn} disabled={loading}>
            {loading ? 'Checking…' : 'Login'}
          </button>
          {error && <div style={{ color: '#ff6b6b', fontSize: 13 }}>{error}</div>}
        </form>
      </div>
    );
  }

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h1 style={{ margin: 0, fontSize: 22 }}>PulseUp · Subscribers</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ color: '#aaa', fontSize: 14 }}>{total} total</span>
          <button onClick={() => fetchSubs(token)} style={S.btnSmall} disabled={loading}>
            {loading ? '…' : 'Refresh'}
          </button>
          <button onClick={downloadCsv} style={S.btnSmall} disabled={subs.length === 0}>
            Export CSV
          </button>
        </div>
      </div>

      {error && (
        <div style={{ color: '#ff6b6b', padding: 12, background: '#2a1d1d', borderRadius: 8, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {subs.length === 0 && !loading ? (
        <div style={{ textAlign: 'center', padding: 50, color: '#888' }}>
          No subscribers yet.
        </div>
      ) : (
        <div style={S.tableWrap}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>#</th>
                <th style={S.th}>Email</th>
                <th style={S.th}>Signed up</th>
                <th style={S.th}>Source</th>
                <th style={S.th}>Children</th>
                <th style={S.th}>Neighborhoods</th>
                <th style={S.th}>Budget</th>
                <th style={S.th}>Special</th>
                <th style={S.th}>Welcome</th>
              </tr>
            </thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.id} style={{ borderBottom: '1px solid #222' }}>
                  <td style={S.td}>{s.id}</td>
                  <td style={{ ...S.td, fontFamily: 'monospace' }}>{s.email}</td>
                  <td style={S.td}>{new Date(s.signed_up_at).toLocaleString()}</td>
                  <td style={S.td}>{s.source}</td>
                  <td style={S.td}>
                    {(s.profile.children || []).map((c, i) => (
                      <span key={i} style={{ marginRight: 6 }}>
                        {c.gender === 'girl' ? '👧' : c.gender === 'boy' ? '👦' : '🧒'}
                        {c.age}
                      </span>
                    ))}
                  </td>
                  <td style={S.td}>{(s.profile.neighborhoods || []).join(', ') || '—'}</td>
                  <td style={S.td}>{s.profile.budget}</td>
                  <td style={S.td}>{s.profile.specialNeeds || '—'}</td>
                  <td style={S.td}>
                    {s.unsubscribed_at ? '🚫 unsub' : s.welcome_sent_at ? '✅' : '⏳'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  loginWrap: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0f0d2e',
  },
  loginForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: 30,
    background: '#1a1742',
    borderRadius: 12,
    width: 340,
  },
  input: {
    padding: 10,
    borderRadius: 6,
    border: '1px solid #333',
    background: '#0f0d2e',
    color: '#fff',
    fontSize: 14,
  },
  btn: {
    padding: 10,
    borderRadius: 6,
    border: 'none',
    background: '#e91e63',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnSmall: {
    padding: '6px 12px',
    borderRadius: 6,
    border: '1px solid #333',
    background: '#1a1742',
    color: '#fff',
    fontSize: 13,
    cursor: 'pointer',
  },
  page: {
    minHeight: '100vh',
    background: '#0f0d2e',
    color: '#fff',
    padding: 24,
    fontFamily: 'system-ui, sans-serif',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
    flexWrap: 'wrap',
    gap: 12,
  },
  tableWrap: {
    overflowX: 'auto',
    background: '#1a1742',
    borderRadius: 8,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 13,
  },
  th: {
    textAlign: 'left',
    padding: '10px 12px',
    background: '#0f0d2e',
    color: '#aaa',
    fontWeight: 500,
    borderBottom: '1px solid #333',
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '10px 12px',
    color: '#ddd',
    verticalAlign: 'top',
  },
};
