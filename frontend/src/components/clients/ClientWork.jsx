import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import '../team/pendingWork.css';

// ---------------------------------------------------------------------------
// CLIENT PAGE -> CLIENT WORK (user request 2026-10-10: "the BDE can reach
// everything about their clients").
//
//   Waiting on this client   what needs doing now, in plain words, each row opens the right place
//   All activity             one timeline, newest first, with filter chips (counts from the server)
//
// GET /api/clients/:id/work?kind=&limit=  (utils/clientWork.js clientTimeline) — 403 for
// logins without the client desk (the page then hides this tab).
// ---------------------------------------------------------------------------

const KINDS = [
  ['all', 'Everything', '•'],
  ['notes', 'Notes', '📝'],
  ['agreement', 'Agreement', '📄'],
  ['jobs', 'Jobs', '💼'],
  ['people', 'People sent', '👤'],
  ['interviews', 'Interviews', '📅'],
  ['followups', 'Follow-ups', '🔔'],
  ['money', 'Money', '₹'],
  ['files', 'Files', '📎'],
  ['messages', 'Messages', '💬'],
  ['access', 'Logins & access', '🔑'],
];
const KIND_ICON = Object.fromEntries(KINDS.map(([k, , i]) => [k, i]));
const KIND_LABEL = Object.fromEntries(KINDS.map(([k, l]) => [k, l]));
const PAGE = 30;

// 10-10-2026 18:45, Indian time.
export function istStamp(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}-${p.month}-${p.year} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

const days = (n) => `${n} day${Number(n) === 1 ? '' : 's'}`;

// The waiting list, one group per kind of work.
function groupsOf(lists, onGoTab) {
  const L = lists || {};
  const cand = (x) => (x.candidateId ? <Link to={`/candidates/${x.candidateId}`}>{x.candidate}</Link> : <b>{x.candidate}</b>);
  return [
    {
      id: 'noReply',
      title: 'Client has not replied',
      rows: (L.noReply || []).map((x) => ({ key: x.applicationId, node: <>{cand(x)}{` — ${x.job}`}{x.waitedDays != null ? <span className="small-muted">{` · waiting ${days(x.waitedDays)}`}</span> : null}</> })),
    },
    {
      id: 'shortlisted',
      title: 'Client shortlisted — fix the interview',
      rows: (L.shortlisted || []).map((x) => ({ key: x.applicationId, node: <>{cand(x)}{` — ${x.job}`}</> })),
    },
    {
      id: 'feedback',
      title: 'Interview done — no client feedback yet',
      rows: (L.feedback || []).map((x) => ({ key: x.applicationId, node: <>{cand(x)}{` — ${x.job}`}</> })),
    },
    {
      id: 'agreement',
      title: 'Agreement',
      rows: (L.agreement || []).map((x) => ({
        key: x.clientId || 'agr',
        node: <>{x.notSent ? 'The agreement is not sent yet' : `The agreement is not signed yet${x.agreement ? ` (${x.agreement})` : ''}`}</>,
        action: <button type="button" className="btn btn-sm" onClick={() => onGoTab('agreement')}>Open the agreement</button>,
      })),
    },
    {
      id: 'requests',
      title: 'Job requests waiting',
      rows: (L.requests || []).map((x) => ({ key: x.requirementId, node: <Link to={`/requirements/${x.requirementId}`}>{x.job}</Link> })),
    },
    {
      id: 'logins',
      title: 'Logins waiting',
      rows: (L.logins || []).map((x, i) => ({
        key: `${x.clientId}-${i}`,
        node: <>{`Login request${x.who ? ` from ${x.who}` : ''}`}</>,
        action: <button type="button" className="btn btn-sm" onClick={() => onGoTab('portal')}>Open logins</button>,
      })),
    },
    {
      id: 'invoices',
      title: 'Invoices past due (for your information)',
      info: true,
      rows: (L.invoices || []).map((x, i) => ({
        key: `${x.invoiceNumber}-${i}`,
        node: <>{`${x.invoiceNumber || 'Invoice'} — ${days(x.daysLate)} past the due day`}</>,
        action: <button type="button" className="btn btn-sm" onClick={() => onGoTab('invoices')}>See invoices</button>,
      })),
    },
  ].filter((g) => g.rows.length);
}

function Group({ g }) {
  const [all, setAll] = useState(false);
  const rows = all ? g.rows : g.rows.slice(0, 5);
  return (
    <section className={`pwk-cw-group${g.info ? ' is-info' : ''}`}>
      <div className="pwk-cw-group-head">
        <b>{g.title}</b>
        <span className={`pwk-tag ${g.info ? 'pwk-tag-grey' : 'pwk-tag-orange'}`}>{g.rows.length}</span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="pwk-cw-row">
          <div className="pwk-cw-row-main">{r.node}</div>
          {r.action}
        </div>
      ))}
      {g.rows.length > 5 && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAll((a) => !a)}>{all ? 'Show fewer' : `Show all ${g.rows.length}`}</button>
      )}
    </section>
  );
}

export default function ClientWork({ clientId, initial, onGoTab }) {
  const [data, setData] = useState(initial || null);
  const [kind, setKind] = useState('all');
  const [limit, setLimit] = useState(PAGE);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const first = useRef(true);

  useEffect(() => {
    // The first look is what the page already fetched (kind all, first rows).
    if (first.current && initial && kind === 'all' && limit === PAGE) { first.current = false; return undefined; }
    first.current = false;
    let live = true;
    setLoading(true);
    api.get(`/clients/${clientId}/work`, { params: { kind, limit } })
      .then((r) => { if (live) { setData(r.data); setErr(''); } })
      .catch((e) => { if (live) setErr((e.response && e.response.data && e.response.data.error) || 'Could not load the client work. Please try again.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [clientId, kind, limit]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <div className="small-muted">{err || 'Loading the client work…'}</div>;
  const pending = data.pending || { lists: {}, total: 0 };
  const groups = groupsOf(pending.lists, onGoTab);
  const counts = data.counts || {};
  const events = data.events || [];

  return (
    <div className="pwk-cw">
      <section className="card section">
        <h3 className="pwk-cw-h">Waiting on this client</h3>
        {!groups.length ? (
          <div className="fux-banner is-green"><b>Nothing is waiting on this client.</b> All caught up.</div>
        ) : (
          <>
            <div className="small-muted pwk-cw-sub">{`${pending.total} thing${pending.total === 1 ? '' : 's'} to do. The client is chased after ${days(data.feedbackDays || 3)} with no reply.`}</div>
            <div className="pwk-cw-groups">{groups.map((g) => <Group key={g.id} g={g} />)}</div>
          </>
        )}
      </section>

      <section className="card section">
        <h3 className="pwk-cw-h">All activity</h3>
        <div className="pwk-chips" role="group" aria-label="Kind of activity">
          {KINDS.filter(([k]) => k === 'all' || kind === k || Number(counts[k]) > 0).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`pwk-chip${kind === k ? ' is-on' : ''}`}
              aria-pressed={kind === k}
              onClick={() => { setKind(k); setLimit(PAGE); }}
            >
              {label}
              {Number(counts[k]) > 0 ? ` ${counts[k]}` : ''}
            </button>
          ))}
        </div>
        {err && <div className="fux-err">{err}</div>}
        <div style={{ opacity: loading ? 0.55 : 1, transition: 'opacity .15s' }}>
          {!events.length ? (
            <div className="small-muted pwk-cw-empty">{kind === 'all' ? 'Nothing has happened on this client yet.' : `No ${String(KIND_LABEL[kind] || '').toLowerCase()} yet.`}</div>
          ) : (
            <ol className="pwk-tl">
              {events.map((e) => (
                <li key={e.id} className="pwk-tl-item" data-kind={e.kind}>
                  <span className="pwk-tl-dot" aria-hidden="true">{KIND_ICON[e.kind] || '•'}</span>
                  <div className="pwk-tl-body">
                    <div className="pwk-tl-title">{e.title}</div>
                    {e.detail && <div className="pwk-tl-detail">{e.detail}</div>}
                    <div className="small-muted">
                      {[istStamp(e.at), e.by ? `by ${e.by}` : null, KIND_LABEL[e.kind] || null].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
        {data.total > events.length && (
          <div className="pwk-cw-more">
            <button type="button" className="btn" disabled={loading} onClick={() => setLimit((l) => l + PAGE)}>{loading ? 'Loading…' : `Show more (${data.total - events.length} left)`}</button>
          </div>
        )}
      </section>
    </div>
  );
}
