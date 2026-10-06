import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import Modal from '../components/Modal.jsx';
import StatusChip from '../components/ui/StatusChip.jsx';
import '../components/clients/portalAccess.css';

// /clients/portal-logins — the QUARTERLY REVIEW of client portal logins and
// the Admin queue (spec B1 / B2, 2026-10-03):
//   * every client login in your area: "are these still needed?"
//     (Still needed / Switch off), with an expired agreement flagged red;
//   * requests waiting for you (new login / switch off);
//   * candidate "delete my data" and withdraw requests (Admin only) — never
//     deleted automatically; the Admin handles them and writes what was done;
//   * the per-company limit (Super Admin / Admin).
// The server decides who sees what (routes/portalLogins.js GET /review).
const TONE = { green: 'green', blue: 'blue', orange: 'amber', red: 'red' };
const when = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const FILTERS = [
  ['all', 'All', () => true],
  ['review', 'Check due', (l) => l.flags.some((f) => f.key === 'review')],
  ['agreement', 'Agreement not active', (l) => l.flags.some((f) => f.key === 'agreement')],
  ['never', 'Never signed in', (l) => !l.lastLoginAt],
];

export default function ClientLoginsReview() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('all');
  const [clientFilter, setClientFilter] = useState('');
  const [closing, setClosing] = useState(null);
  const [note, setNote] = useState('');
  const [max, setMax] = useState('');

  const load = useCallback(() => {
    api.get('/portal/logins/review')
      .then((r) => { setData(r.data); setMax(String(r.data.settings?.maxClientLogins || '')); setError(''); })
      .catch((e) => setError(e.response?.data?.error || 'Could not load the review list.'));
  }, []);
  useEffect(load, [load]);

  function act(method, path, body, after) {
    setBusy(true); setError(''); setDone(null);
    return api[method](`/portal/logins${path}`, body || {})
      .then((r) => { setDone({ message: r.data.message || 'Saved.', link: r.data.link }); if (after) after(); load(); })
      .catch((e) => setError(e.response?.data?.error || 'That did not work. Please try again.'))
      .finally(() => setBusy(false));
  }

  // FILTER RULE: filters cascade, show counts, never offer a zero option.
  const logins = data?.logins || [];
  const byClient = useMemo(() => logins.filter((l) => !clientFilter || l.client.id === clientFilter), [logins, clientFilter]);
  const flagCounts = FILTERS.map(([k, label, fn]) => [k, label, byClient.filter(fn).length]).filter(([k, , n]) => k === 'all' || n > 0);
  const flagFn = (FILTERS.find(([k]) => k === filter) || FILTERS[0])[2];
  const byFlag = logins.filter(flagFn);
  const clients = useMemo(() => {
    const m = new Map();
    byFlag.forEach((l) => m.set(l.client.id, { ...l.client, n: (m.get(l.client.id)?.n || 0) + 1 }));
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [byFlag]);
  const shown = byFlag.filter((l) => !clientFilter || l.client.id === clientFilter);
  useEffect(() => { if (filter !== 'all' && !flagCounts.some(([k]) => k === filter)) setFilter('all'); }, [flagCounts, filter]);
  useEffect(() => { if (clientFilter && !clients.some((c) => c.id === clientFilter)) setClientFilter(''); }, [clients, clientFilter]);

  if (error && !data) return <div className="notice red"><span>{error}</span></div>;
  if (!data) return <div className="small-muted">Loading…</div>;
  const { rights, requests, candidateRequests } = data;

  return (
    <div className="tlpa" style={{ maxWidth: 1000 }}>
      <div className="page-head">
        <div>
          <h1>Client logins</h1>
          <div className="page-sub">Every {data.reviewEveryDays} days, check each client login is still needed.</div>
        </div>
      </div>
      {error && <div className="notice red"><span>{error}</span></div>}
      {done && <div className="notice green"><span>{done.message}</span></div>}

      {requests.length > 0 && (
        <div className="tlpa-section">
          <div className="tlpa-label">Waiting for you ({requests.length})</div>
          {requests.map((r) => (
            <div className="tlpa-row" key={r.id}>
              <div className="tlpa-who">
                <b>{r.kind === 'CLIENT_DISABLE' ? `Switch off: ${r.name}` : `New login: ${r.name}`}</b>
                <span className="small-muted"><Link to={`/clients/${r.client.id}?tab=portal`}>{r.client.name}</Link> · {r.email}{r.typeWords ? ` · ${r.typeWords}` : ''}</span>
                <span className="small-muted">Asked by {r.requestedBy} on {when(r.createdAt)}{r.reason ? ` — "${r.reason}"` : ''}</span>
              </div>
              <div className="tlpa-actions">
                <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => act('post', `/requests/${r.id}/approve`)}>{r.kind === 'CLIENT_DISABLE' ? 'Switch off' : 'Approve'}</button>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setClosing({ kind: 'decline', r }); setNote(''); }}>Decline</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {rights.approve && (
        <div className="tlpa-section">
          <div className="tlpa-label">Client logins in your area</div>
          {logins.length === 0 ? (
            <div className="tlpa-empty">No client has a portal login yet. Logins are added on the client page → Portal access.</div>
          ) : (
            <>
              <div className="tlpa-filters">
                {flagCounts.map(([k, label, n]) => (
                  <button type="button" key={k} className={`tlpa-filter${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>{label} ({n})</button>
                ))}
                {clients.length > 1 && (
                  <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} aria-label="Client">
                    <option value="">All clients ({byFlag.length})</option>
                    {clients.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.n})</option>)}
                  </select>
                )}
              </div>
              {shown.map((l) => (
                <div className="tlpa-row" key={l.id}>
                  <div className="tlpa-who">
                    <b>{l.name}</b>
                    <span className="small-muted"><Link to={`/clients/${l.client.id}?tab=portal`}>{l.client.name}</Link> · {l.email}</span>
                    <span className="small-muted">{l.lastLoginAt ? `Last signed in ${when(l.lastLoginAt)}` : 'Never signed in'} · checked {l.reviewedAt ? when(l.reviewedAt) : 'never'}</span>
                    <span className="tlpa-chips">
                      <StatusChip status={l.typeWords} tone="blue" />
                      <StatusChip status={l.state.label} tone={TONE[l.state.tone]} />
                      {l.flags.map((f) => <StatusChip key={f.key} status={f.label} tone={TONE[f.tone]} />)}
                    </span>
                  </div>
                  <div className="tlpa-actions">
                    <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => act('post', `/client/${l.client.id}/users/${l.id}/keep`)}>Still needed</button>
                    <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => window.confirm(`Switch off ${l.name}? They will not be able to sign in.`) && act('post', `/client/${l.client.id}/users/${l.id}/disable`)}>Switch off</button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {rights.adminQueue && (
        <div className="tlpa-section">
          <div className="tlpa-label">Candidate requests</div>
          {candidateRequests.length === 0 ? (
            <div className="tlpa-empty">No candidate is waiting — no "delete my data" or withdraw requests.</div>
          ) : candidateRequests.map((r) => (
            <div className="tlpa-row" key={r.id}>
              <div className="tlpa-who">
                <b>{r.kind === 'CANDIDATE_PRIVACY' ? `Delete my data — ${r.requestedBy}` : `Withdraw — ${r.requestedBy} (${r.name})`}</b>
                <span className="small-muted">{when(r.createdAt)}{r.reason ? ` — "${r.reason}"` : ''} · <Link to={`/candidates/${r.candidateId}`}>Open candidate</Link></span>
                <span className="small-muted">Nothing is deleted automatically. Do what is needed, then write what you did.</span>
              </div>
              <div className="tlpa-actions">
                <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => { setClosing({ kind: 'Done', r }); setNote(''); }}>Mark done</button>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setClosing({ kind: 'Declined', r }); setNote(''); }}>Decline</button>
              </div>
            </div>
          ))}
          <div style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act('post', '/archive-idle')}>Archive candidate logins idle for 12 months</button>
            <span className="small-muted"> Runs by itself every day too. A new email code opens an archived login again.</span>
          </div>
        </div>
      )}

      {rights.settings && (
        <div className="tlpa-section">
          <div className="tlpa-label">Setting</div>
          <div className="tlpa-row">
            <div className="tlpa-who"><b>Most client logins per company</b><span className="small-muted">Each person gets their own login. No shared logins.</span></div>
            <div className="tlpa-actions">
              <input type="number" min={1} max={20} value={max} onChange={(e) => setMax(e.target.value)} style={{ width: 70 }} aria-label="Most logins per company" />
              <button type="button" className="btn btn-sm btn-primary" disabled={busy || String(data.settings.maxClientLogins) === max} onClick={() => act('put', '/settings', { maxClientLogins: Number(max) })}>Save</button>
            </div>
          </div>
        </div>
      )}

      {closing && (
        <Modal
          title={closing.kind === 'decline' ? `Decline: ${closing.r.name}` : (closing.kind === 'Done' ? 'Mark done' : 'Decline the request')}
          onClose={() => setClosing(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setClosing(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !note.trim()}
                onClick={() => (closing.kind === 'decline'
                  ? act('post', `/requests/${closing.r.id}/reject`, { note }, () => setClosing(null))
                  : act('post', `/candidate-requests/${closing.r.id}/close`, { outcome: closing.kind, note }, () => setClosing(null)))}
              >
                Save
              </button>
            </>
          )}
        >
          <div className="tlpa-form">
            <label>{closing.kind === 'Done' ? 'What was done?' : 'Why? (they will see this)'}
              <input value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}
