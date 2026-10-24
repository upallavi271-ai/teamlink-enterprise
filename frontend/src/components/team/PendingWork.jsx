import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api';
import { FacetSelect } from '../ui/ListPageHeader.jsx';
import Pager, { usePaged } from '../Pager.jsx';
import Modal from '../Modal.jsx';
import PendingWorkSettings from './PendingWorkSettings.jsx';
import {
  RemindButton, errText, nz, whenTone, whenWords,
} from './pendingWorkKit.jsx';
import '../followups/followups.css';
import './pendingWork.css';

// ---------------------------------------------------------------------------
// TEAM -> PENDING WORK (was "Who has work waiting").
//
//   banner      "2 late, 3 due today, 14 waiting in your team"
//   filters     Department · Recruiter · Type of work · How late  (counts, cascade — the server counts them)
//   table       Person | Late | Due today | Waiting | Follow-ups late | what it is made of | Remind | Open
//   a row opens (a chevron button) to the person's items, each with its own Remind
//
// GET /api/pending-work/team (utils/pendingWork.js teamView; a BDE team lead gets
// the BDE desk: audience 'bde', clientWork instead of follow-ups). Remind is
// POST /api/pending-work/remind — once a person per day; the answer is plain words.
// ---------------------------------------------------------------------------

const EMPTY = { department: '', recruiter: '', type: '', lateness: '' };

function bannerOf(t, bde, who) {
  const late = Number(t.late || 0);
  const due = Number(t.dueToday || 0);
  const waiting = Number(t.waiting || 0);
  const fu = Number(t.followUpsLate || 0);
  if (!late && !due && !waiting && !fu) return { tone: 'is-green', node: <b>{bde ? 'No client work is waiting in your team.' : 'Nothing is waiting in your team. All caught up.'}</b> };
  const parts = [];
  if (late) parts.push(<span key="l"><b className="fux-red">{`${late} late`}</b></span>);
  if (due) parts.push(<span key="d"><b className="pwk-orange">{`${due} due today`}</b></span>);
  if (waiting) parts.push(<span key="w"><b>{`${waiting} waiting`}</b></span>);
  const lead = parts.reduce((acc, p, i) => (i ? [...acc, ', ', p] : [p]), []);
  return {
    tone: late ? 'is-orange' : 'is-blue',
    node: (
      <>
        {lead.length ? lead : <b>Nothing is late</b>}
        {` in your ${who}`}
        {fu ? <>. <b className="fux-red">{`${fu} follow-up${fu === 1 ? ' is' : 's are'} late`}</b></> : null}
        {late ? '. The people with the most late work are at the top.' : '.'}
      </>
    ),
  };
}

// ---- today's digest, written (nothing is sent) ------------------------------
function DigestModal({ onClose }) {
  const [tl, setTl] = useState('');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    setD(null); setErr('');
    api.get('/pending-work/digest/preview', { params: tl ? { tl } : {} })
      .then((r) => { if (live) setD(r.data); })
      .catch((e) => { if (live) setErr(errText(e, 'Could not make the daily list. Please try again.')); });
    return () => { live = false; };
  }, [tl]);
  const tls = (d && d.teamLeads) || [];
  return (
    <Modal title="Today's daily list" note="Nothing is sent from here" onClose={onClose} foot={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
      {err && <div className="notice red">{err}</div>}
      {!d && !err && <div className="small-muted">Making today&apos;s list…</div>}
      {d && tls.length > 1 && (
        <div className="pwk-pick">
          <FacetSelect label="Team lead" value={tl} allLabel="Choose" options={tls.map((t) => ({ value: t.id, label: `${t.name}${t.department ? ` · ${t.department}` : ''}`, count: 1 }))} onChange={setTl} />
        </div>
      )}
      {d && d.bde && (
        <div className="pwk-digest">
          <b>Client work waiting on the BDE desk: {d.totals && d.totals.total ? d.totals.total : 'nothing right now'}</b>
          {d.note && <div className="small-muted">{d.note}</div>}
        </div>
      )}
      {d && !d.bde && (
        <div className="pwk-digest">
          <div className="pwk-digest-subject">{d.subject}</div>
          {d.empty && <div className="fux-banner is-green">Nothing is waiting for this team, so no list would be sent today.</div>}
          <pre className="pwk-digest-text">{d.text}</pre>
        </div>
      )}
    </Modal>
  );
}

// ---- one person's items -------------------------------------------------------
function Items({ row, bde, canRemind, onSent }) {
  const items = row.items || [];
  return (
    <div className="pwk-items">
      {!items.length && <div className="small-muted">Nothing is waiting on this person right now.</div>}
      {items.map((it, i) => {
        const key = `${it.applicationId || it.requirementId || it.clientId || it.invoiceNumber || 'x'}-${i}`;
        const own = canRemind && it.applicationId && (bde || it.ownerUserId === row.userId);
        if (bde) {
          return (
            <div key={key} className="pwk-item">
              <div className="pwk-item-main">
                <span className="pwk-tag pwk-tag-blue">{it.typeLabel}</span>{' '}
                {it.candidateId ? <Link to={`/candidates/${it.candidateId}`}>{it.text}</Link> : it.text}
              </div>
              {own && <RemindButton recruiterId={row.userId} applicationId={it.applicationId} onDone={onSent} />}
            </div>
          );
        }
        return (
          <div key={key} className="pwk-item">
            <div className="pwk-item-main">
              {it.candidateId ? <Link to={`/candidates/${it.candidateId}`}><b>{it.candidate}</b></Link> : <b>{it.candidate}</b>}
              {' — '}
              {it.job}
              {it.client ? <span className="small-muted">{` (${it.client})`}</span> : null}
              <div className="small-muted">
                {it.step ? `${it.step}${it.action ? ` · ${it.action}` : ''}` : it.action}
                {!own && it.ownerRole ? ` · waiting on the ${String(it.ownerRole).toLowerCase()}` : ''}
              </div>
            </div>
            <span className={`pwk-tag pwk-tag-${whenTone(it.status)}`}>{whenWords(it)}</span>
            {own && <RemindButton recruiterId={row.userId} applicationId={it.applicationId} onDone={onSent} />}
          </div>
        );
      })}
      {row.moreItems > 0 && (
        <div className="small-muted">
          {`and ${row.moreItems} more. `}
          <Link to={`/ats/team?view=pending&owner=${encodeURIComponent(`id:${row.userId}`)}`}>See all of them →</Link>
        </div>
      )}
      {!bde && row.jobs && row.jobs.length > 0 && (
        <div className="pwk-jobs">
          <div className="pwk-jobs-title">Requirements with no profile sent yet</div>
          {row.jobs.map((j, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <div key={i} className="small-muted">{`${j.job}${j.client ? ` (${j.client})` : ''}${j.daysOpen ? ` · open ${j.daysOpen} day${j.daysOpen === 1 ? '' : 's'}` : ''}`}</div>
          ))}
        </div>
      )}
      {row.counts && row.counts.notMoving > 0 && (
        <div className="small-muted pwk-notmoving" title="Old imported work that has not moved for a long time. It is never reminded.">
          {`Not moving: ${row.counts.notMoving} (old imported work, never reminded)`}
        </div>
      )}
    </div>
  );
}

export default function PendingWork() {
  const [params] = useSearchParams();
  const person = params.get('person') || '';
  const [values, setValues] = useState(EMPTY);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState({});
  const [sentMsg, setSentMsg] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showDigest, setShowDigest] = useState(false);
  const [bump, setBump] = useState(0);
  const [flash, setFlash] = useState('');
  const rowRefs = useRef({});

  useEffect(() => {
    let live = true;
    setLoading(true);
    api.get('/pending-work/team', { params: { ...Object.fromEntries(Object.entries(values).filter(([, v]) => v)), ...(bump ? { fresh: 1 } : {}) } })
      .then((r) => { if (live) { setData(r.data); setErr(''); } })
      .catch((e) => { if (live) setErr(errText(e, 'Could not load who has work waiting. Please try again.')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [values, bump]);

  const rows = data ? data.rows : [];
  const page = usePaged(rows, 25);

  // /ats/team?view=whohas&person=<id>: open that person and bring them into view.
  const doneFor = useRef('');
  useEffect(() => {
    if (!person || !data || doneFor.current === person) return undefined;
    if (!rows.some((r) => r.userId === person)) return undefined;
    doneFor.current = person;
    setOpen((o) => ({ ...o, [person]: true }));
    setFlash(person);
    const go = () => { const el = rowRefs.current[person]; if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    const t1 = setTimeout(go, 500);
    const t2 = setTimeout(go, 3400);
    const t3 = setTimeout(() => setFlash(''), 6000);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [person, data, rows]);

  if (err && !data) return <div className="fux-err">{err}</div>;
  if (!data) return <div className="small-muted">Loading who has pending work…</div>;

  const bde = data.audience === 'bde';
  const who = bde ? 'BDE team' : 'team';
  const f = data.facets || {};
  const anyFilter = Object.values(values).some(Boolean);
  const ban = bannerOf(data.totals || {}, bde, who);
  const setF = (k) => (v) => setValues((x) => ({ ...x, [k]: v }));
  const showFu = !bde;

  return (
    <div className="pwk" style={{ opacity: loading ? 0.6 : 1, transition: 'opacity .15s' }}>
      <div className="pwk-top">
        <div className={`fux-banner pwk-banner ${ban.tone}`}>{ban.node}</div>
        <div className="pwk-top-btns">
          <button type="button" className="btn btn-sm" onClick={() => setShowDigest(true)}>See today&apos;s list</button>
          <button type="button" className="btn btn-sm" onClick={() => setShowSettings(true)}>Reminder settings</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setBump((b) => b + 1)} disabled={loading}>Refresh</button>
        </div>
      </div>

      <div className="fux-dr-bar">
        {!bde && <FacetSelect label="Department" value={values.department} allLabel="All departments" options={f.department} onChange={(v) => setValues((x) => ({ ...x, department: v, recruiter: '' }))} />}
        <FacetSelect label={bde ? 'Client manager (BDE)' : 'Recruiter'} value={values.recruiter} allLabel={bde ? 'All client managers' : 'Everyone'} options={f.recruiter} onChange={setF('recruiter')} />
        <FacetSelect label="Type of work" value={values.type} allLabel="All kinds" options={f.type} onChange={setF('type')} />
        {!bde && <FacetSelect label="How late" value={values.lateness} allLabel="Any" options={f.lateness} onChange={setF('lateness')} />}
        {anyFilter && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setValues(EMPTY)}>Clear</button>}
      </div>

      {sentMsg && <div className="fux-banner is-green" role="status">{sentMsg}</div>}
      {err && <div className="fux-err">{err}</div>}

      {!rows.length ? (
        <div className="small-muted">{anyFilter ? 'Nobody matches these filters.' : 'Nobody in this list.'}</div>
      ) : (
        <>
          <div className="pwk-wrap">
            <table className="fux-table pwk-table">
              <thead>
                <tr>
                  <th>{bde ? 'Client manager (BDE)' : 'Person'}</th>
                  {bde && <th className="num" title="Client work waiting on this person">Client work waiting</th>}
                  <th className="num" title="The due day has passed">Late</th>
                  <th className="num" title="The due day is today">Due today</th>
                  <th className="num" title="The next steps of this person's candidates. Late and Due today are part of it.">Waiting</th>
                  {showFu && <th className="num" title="Follow-ups past their date and not done">Follow-ups late</th>}
                  <th>What it is made of</th>
                  <th className="pwk-th-act">What to do</th>
                </tr>
              </thead>
              <tbody>
                {page.slice.map((r) => {
                  const c = r.counts || {};
                  const isOpen = !!open[r.userId];
                  const own = bde ? Number(c.clientWork || 0) > 0 || Number(r.mine || 0) > 0 : Number(r.mine || 0) > 0;
                  const base = `/ats/team?view=pending&owner=${encodeURIComponent(`id:${r.userId}`)}`;
                  const numCell = (label, v, tone, to) => (
                    <td className={`num ${v ? tone || '' : 'fux-dash'}`} data-label={label}>
                      {v ? (to ? <Link to={to}>{nz(v)}</Link> : nz(v)) : '—'}
                    </td>
                  );
                  return (
                    <Fragment key={r.userId}>
                    <RowGroup refSet={(el) => { rowRefs.current[r.userId] = el; }} hot={flash === r.userId}>
                      <td data-label={bde ? 'Client manager (BDE)' : 'Person'} className="pwk-who">
                        <button type="button" className={`pwk-chev${isOpen ? ' is-open' : ''}`} aria-expanded={isOpen} aria-label={isOpen ? `Hide ${r.name}'s work` : `Show ${r.name}'s work`} onClick={() => setOpen((o) => ({ ...o, [r.userId]: !o[r.userId] }))}>
                          <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                        </button>
                        <span className="pwk-who-text">
                          <b>{r.name}</b>
                          <span className="small-muted">{[r.department, r.seat].filter(Boolean).join(' · ')}</span>
                          {!bde && r.tl ? <span className="small-muted">{`Team lead: ${r.tl}`}</span> : null}
                          {c.notMoving > 0 && <span className="pwk-notmoving-chip" title="Old imported work that has not moved for a long time. It is shown small and never reminded.">{`Not moving ${c.notMoving}`}</span>}
                        </span>
                      </td>
                      {bde && numCell('Client work waiting', Number(c.clientWork || 0), '', base)}
                      {numCell('Late', c.late, 'fux-red', `${base}&due=overdue`)}
                      {numCell('Due today', c.dueToday, 'pwk-orange', `${base}&due=today`)}
                      {numCell('Waiting', c.waiting, '', base)}
                      {showFu && numCell('Follow-ups late', c.followUpsLate, 'fux-red', '/ats/team?view=followups')}
                      <td data-label="Made of" className="pwk-made">
                        {(r.byType || []).length ? (r.byType || []).map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            className={`pwk-chip${values.type === t.id ? ' is-on' : ''}${t.late ? ' is-late' : ''}`}
                            title={`Show only: ${t.label}`}
                            onClick={() => setF('type')(values.type === t.id ? '' : t.id)}
                          >
                            {`${t.label} ${t.n}`}
                          </button>
                        )) : <span className="small-muted">Nothing waiting</span>}
                      </td>
                      <td data-label="" className="pwk-act">
                        {data.canRemind && own && (
                          <RemindButton
                            recruiterId={r.userId}
                            reminded={r.reminded}
                            onDone={(res) => setSentMsg((res && res.message) || `Reminder sent to ${r.name}.`)}
                          />
                        )}
                        {data.canRemind && !own && <span className="small-muted">Nothing to chase</span>}
                        <Link className="btn btn-sm" to={r.link || base}>Open</Link>
                      </td>
                    </RowGroup>
                    {isOpen && (
                      <tr className="pwk-detail">
                        <td colSpan={7}>
                          <Items row={r} bde={bde} canRemind={data.canRemind} onSent={(res) => setSentMsg((res && res.message) || `Reminder sent to ${r.name}.`)} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager page={page} noun="people" />
        </>
      )}

      <details className="pwk-help">
        <summary>What do these numbers mean?</summary>
        <ul>
          <li><b>Waiting</b> = the next steps of the person&apos;s candidates. Old imported work that is &quot;Not moving&quot; is not counted.</li>
          <li><b>Late</b> = the due day has passed. <b>Due today</b> = the due day is today. Both are part of Waiting.</li>
          <li><b>Not moving</b> = old imported work. It is shown small and nobody is reminded about it.</li>
          <li><b>Follow-ups late</b> = people they were meant to contact by a date that has passed.</li>
          <li><b>Requirements with no profile sent</b> = open requirements where nobody has been sent to the client yet.</li>
        </ul>
        {data.note && <div className="small-muted">{data.note}</div>}
      </details>

      {showSettings && (
        <Modal title="Reminders to team leads" size="wide" onClose={() => setShowSettings(false)}>
          <PendingWorkSettings onSaved={() => setBump((b) => b + 1)} />
        </Modal>
      )}
      {showDigest && <DigestModal onClose={() => setShowDigest(false)} />}
    </div>
  );
}

// A table row that can be found (scroll) and flashed.
function RowGroup({ children, refSet, hot }) {
  return <tr ref={refSet} className={`pwk-row${hot ? ' is-hot' : ''}`}>{children}</tr>;
}
