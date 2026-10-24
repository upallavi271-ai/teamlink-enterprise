import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { Btn, Panel, Pill, Tabs } from '../ui.jsx';
import { fmtShort } from './shared.jsx';

// the call list of a Voice campaign: a person rings each one and logs it (Called with minutes, No answer, Skip). Nothing is dialled by the machine.
export default function CallTasks({ campaignKey, onChanged }) {
  const { toast } = useOmni();
  const [tab, setTab] = useState('todo');
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [page, setPage] = useState(1);
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [mins, setMins] = useState({});
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try { setD(await omni.get(`/gs/campaigns/campaign/${campaignKey}/calls`, { status: tab === 'all' ? '' : tab, q: qLive, page, pageSize: 10 })); setErr(''); } catch (e) { setErr(errOf(e, 'The call list could not be loaded.')); }
  }, [campaignKey, tab, qLive, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setTimeout(() => { setQLive(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const mark = async (t, outcome) => {
    setBusy(t.id);
    try {
      await omni.post(`/gs/campaigns/calls/${t.id}/mark`, { outcome, minutes: outcome === 'called' ? (mins[t.id] === undefined || mins[t.id] === '' ? 1 : mins[t.id]) : undefined });
      toast(outcome === 'called' ? `${t.name}: call logged` : (outcome === 'no_answer' ? `${t.name}: no answer logged` : `${t.name}: skipped`));
      await load(); if (onChanged) onChanged();
    } catch (e) { toast(errOf(e, 'That call could not be logged.')); } finally { setBusy(''); }
  };
  if (err) return <div className="cmp-err">{err}</div>;
  if (!d) return <div style={{ fontSize: 11 }}>Loading…</div>;
  const c = d.counts;
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
  return (
    <Panel title="Calls to make" sub="A person rings each one and logs what happened. Nothing is dialled by the system." style={{ marginTop: 14 }}>
      {d.script && <div style={{ background: '#fbfdfc', border: '1px solid var(--line)', borderRadius: 10, padding: '9px 12px', margin: '8px 0 10px' }}><small style={{ color: 'var(--muted)', fontSize: 9, fontWeight: 800 }}>CALL SCRIPT</small><div className="cmp-msg">{d.script}</div></div>}
      <Tabs value={tab} onChange={(v) => { setTab(v); setPage(1); }} tabs={[['todo', 'To call', c.todo], ['called', 'Called', c.called], ['noanswer', 'No answer', c.noAnswer], ['skipped', 'Skipped', c.skipped], ['all', 'All']]} />
      <input className="search" style={{ margin: '10px 0' }} placeholder="Search by name..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search by name" />
      <div className="table-scroll">
        <table className="table cmp-table-small">
          <thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Minutes</th><th>Action</th></tr></thead>
          <tbody>
            {d.tasks.map((t) => (
              <tr key={t.id}>
                <td style={{ fontWeight: 800 }}>{t.name}{t.city && <span className="cmp-sub">{t.city}</span>}</td>
                <td>{t.phone || '—'}</td>
                <td><Pill tone={t.status === 'queued' ? 'scheduled' : (t.status === 'sent' ? 'live' : (t.status === 'failed' ? 'red' : 'draft'))}>{t.statusWords}</Pill>{t.at && <span className="cmp-sub">{fmtShort(t.at)}</span>}</td>
                <td>{t.minutes == null ? '—' : t.minutes}</td>
                <td>
                  {t.status === 'queued' && d.can ? (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <input aria-label="Minutes" type="number" min="0" max="600" placeholder="min" style={{ width: 58, height: 30 }} value={mins[t.id] === undefined ? '' : mins[t.id]} onChange={(e) => setMins({ ...mins, [t.id]: e.target.value })} />
                      <Btn small primary disabled={busy === t.id} onClick={() => mark(t, 'called')}>Called</Btn>
                      <Btn small disabled={busy === t.id} onClick={() => mark(t, 'no_answer')}>No answer</Btn>
                      <Btn small disabled={busy === t.id} onClick={() => mark(t, 'skip')}>Skip</Btn>
                    </div>
                  ) : '—'}
                </td>
              </tr>
            ))}
            {!d.tasks.length && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--muted)', padding: 22 }}>{tab === 'todo' ? 'No calls waiting.' : 'Nothing here.'}</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, fontSize: 10, color: 'var(--muted)' }}>
        <span>{d.total} {d.total === 1 ? 'person' : 'people'}</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><button type="button" className="tiny-btn" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">‹</button>Page {page} of {pages}<button type="button" className="tiny-btn" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page">›</button></span>
      </div>
    </Panel>
  );
}
