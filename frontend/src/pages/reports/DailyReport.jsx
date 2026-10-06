import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { FacetSelect } from '../../components/ui/ListPageHeader.jsx';
import StatusChip from '../../components/ui/StatusChip.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import '../../components/followups/followups.css';

// ---------------------------------------------------------------------------
// RECRUITER DAILY REPORT (user spec 2026-10-03, C2; ATS change list §13).
//
//   [Day] [Month]   Department → Team → Person (cascading, with counts)
//   Month table     Date | Added | Calls | Mails | Follow-ups | Sent to TL |
//                   Sent to client | Interviews | Joined | Pending
//                   → click a day to see that day's actual work
//   Targets         "12 of 20 Sent to client" bars (HRMS → Targets)
//   Export          CSV · Excel · PDF of exactly what is shown
//   E-mails         7 PM TL / weekly Manager — OFF until an admin switches it on
//
// Everything comes from GET /api/ats-daily/* (backend utils/dailyReport.js),
// which enforces the scope: a recruiter sees only their own work, a TL their
// team, a Manager / STL their departments, an Admin everything. Nothing is
// typed by anyone for this report.
// ---------------------------------------------------------------------------

const IST_TODAY = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const COL_LABEL = {
  added: 'Added', calls: 'Calls', mails: 'Mails', followUps: 'Follow-ups', sentTl: 'Sent to TL', sentClient: 'Sent to client', interviews: 'Interviews', joined: 'Joined', pending: 'Pending',
};
const DAY_CARDS = ['added', 'calls', 'mails', 'whatsapp', 'followUps', 'missed', 'reviewed', 'sentTl', 'sentClient', 'interviews', 'attended', 'feedback', 'offers', 'joined', 'pending'];

const fmtDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' });
const fmtLongDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtMonth = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const fmtTime = (at) => new Date(at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

function Cell({ v, k }) {
  if (v === null || v === undefined) return <td className="num fux-dash" title={k === 'pending' ? 'Known for today only' : undefined}>—</td>;
  if (!v) return <td className="num fux-dash">0</td>;
  return <td className={`num${k === 'missed' ? ' fux-red' : ''}`}>{Number(v).toLocaleString('en-IN')}</td>;
}

function saveBlob(res, fallback) {
  const cd = res.headers?.['content-disposition'] || '';
  const m = /filename="?([^";]+)"?/.exec(cd);
  const href = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = href; a.download = (m && m[1]) || fallback; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(href), 2000);
}

// --- the 7 PM TL / weekly Manager e-mail switch ------------------------------
function MailSettings() {
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    api.get('/ats-daily/mail-settings').then((r) => setS(r.data)).catch(() => setS(false));
  }, []);
  if (s === false || s === null) return null;
  async function save(patch) {
    setErr(''); setMsg('');
    try {
      const r = await api.put('/ats-daily/mail-settings', patch);
      setS(r.data);
      setMsg('Saved.');
    } catch (e) { setErr(e.response?.data?.error || 'Could not save. Please try again.'); }
  }
  async function showPreview(kind) {
    setErr('');
    try { const r = await api.get('/ats-daily/mail-preview', { params: { kind } }); setPreview(r.data); } catch (e) { setErr(e.response?.data?.error || 'Could not build the preview.'); }
  }
  const t = s.tlDaily; const m = s.managerWeekly;
  return (
    <details className="fux-mail" style={{ marginTop: 18 }}>
      <summary style={{ cursor: 'pointer', fontWeight: 700 }}>
        Report e-mails — <span className={s.status === 'On' ? 'fux-green' : 'fux-orange'}>{s.status === 'On' ? 'On' : 'Off'}</span>
      </summary>
      <div className="fux-note" style={{ marginBottom: 8 }}>{s.note}</div>
      <div className="fux-table-wrap">
        <table className="fux-table">
          <tbody>
            <tr>
              <td><b>Every day to each TL</b><div className="fux-note" style={{ marginTop: 2 }}>Their team&apos;s day</div></td>
              <td>
                {s.canEdit ? (
                  <span className="fux-inline">
                    <label className="fux-inline"><input type="checkbox" checked={t.on} onChange={(e) => save({ tlDaily: { on: e.target.checked } })} /> {t.on ? 'On' : 'Off'}</label>
                    at <input type="time" value={t.time} onChange={(e) => save({ tlDaily: { time: e.target.value } })} />
                  </span>
                ) : <span>{t.on ? `On, at ${t.time}` : 'Off'}</span>}
              </td>
              <td><button type="button" className="btn btn-sm" onClick={() => showPreview('tl')}>Preview</button></td>
            </tr>
            <tr>
              <td><b>Every week to each Manager</b><div className="fux-note" style={{ marginTop: 2 }}>Their area&apos;s week</div></td>
              <td>
                {s.canEdit ? (
                  <span className="fux-inline">
                    <label className="fux-inline"><input type="checkbox" checked={m.on} onChange={(e) => save({ managerWeekly: { on: e.target.checked } })} /> {m.on ? 'On' : 'Off'}</label>
                    on
                    <select value={m.weekday} onChange={(e) => save({ managerWeekly: { weekday: Number(e.target.value) } })}>
                      {s.weekdays.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                    </select>
                    at <input type="time" value={m.time} onChange={(e) => save({ managerWeekly: { time: e.target.value } })} />
                  </span>
                ) : <span>{m.on ? `On, ${m.weekdayLabel} at ${m.time}` : 'Off'}</span>}
              </td>
              <td><button type="button" className="btn btn-sm" onClick={() => showPreview('manager')}>Preview</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      {s.lastResult && <div className="fux-note">Last sent {s.lastResult.day}: {s.lastResult.sent} sent, {s.lastResult.failed} failed.</div>}
      {msg && <div className="fux-saved">{msg}</div>}
      {err && <div className="fux-err">{err}</div>}
      {preview && (
        <div style={{ marginTop: 10 }}>
          <div className="fux-note">Preview (nothing was sent) — <b>{preview.subject}</b></div>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: '#f8fafc', padding: 10, borderRadius: 8, maxHeight: 300, overflow: 'auto' }}>{preview.text}</pre>
        </div>
      )}
    </details>
  );
}

function PeopleTable({ people, columns, showLate }) {
  if (!people || people.length < 2) return null;
  return (
    <>
      <div className="fux-section-title">By person</div>
      <div className="fux-table-wrap">
        <table className="fux-table">
          <thead>
            <tr>
              <th>Person</th>
              {columns.map((k) => <th key={k} className="num">{COL_LABEL[k]}</th>)}
              {showLate && <th className="num">Late</th>}
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.key}>
                <td><b>{p.label}</b>{p.former && <> <StatusChip tone="grey" title="Has left — their old work stays theirs">Former</StatusChip></>}</td>
                {columns.map((k) => <Cell key={k} k={k} v={p[k]} />)}
                {showLate && <td className={`num${p.late ? ' fux-red' : ' fux-dash'}`}>{p.late === null || p.late === undefined ? '—' : p.late}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function DayRows({ rows }) {
  const page = usePaged(rows, 25);
  if (!rows.length) return null;
  return (
    <>
      <div className="fux-section-title">What was done</div>
      <div className="fux-table-wrap">
        <table className="fux-table">
          <thead><tr><th>Time</th><th>Person</th><th>What</th><th>Candidate</th><th>Job · Client</th><th>Detail</th></tr></thead>
          <tbody>
            {page.slice.map((r, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <tr key={i}>
                <td className="cell-muted">{r.timeKnown ? fmtTime(r.at) : '—'}</td>
                <td>{r.person}</td>
                <td>
                  <span className={r.metric === 'missed' ? 'fux-red' : r.metric === 'joined' ? 'fux-green' : ''}>{r.what}</span>
                  {r.imported && <span className="fux-note" style={{ marginLeft: 6 }}>(imported)</span>}
                </td>
                <td>{r.candidateId ? <Link to={`/candidates/${r.candidateId}`}>{r.candidate || 'Open'}</Link> : (r.candidate || '—')}</td>
                <td className="cell-muted">{[r.job, r.client].filter(Boolean).join(' · ') || '—'}</td>
                <td className="cell-muted">{r.detail || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} noun="items" />
    </>
  );
}

export default function DailyReport() {
  const today = IST_TODAY();
  const [view, setView] = useState('month');
  const [day, setDay] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [f, setF] = useState({ department: '', team: '', person: '', people: '' });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const params = useMemo(() => ({
    ...(view === 'day' ? { day } : { month }),
    ...(f.department ? { department: f.department } : {}),
    ...(f.team ? { team: f.team } : {}),
    ...(f.person ? { person: f.person } : {}),
    ...(f.people ? { people: f.people } : {}),
  }), [view, day, month, f]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api.get(`/ats-daily/${view}`, { params })
      .then((r) => { if (live) { setData(r.data); setErr(''); } })
      .catch((e) => { if (live) setErr(e.response?.data?.error || 'Could not load the daily report. Please try again.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [view, params]);

  async function exportAs(format) {
    setBusy(format);
    try {
      const r = await api.get('/ats-daily/export', { params: { ...params, view, format }, responseType: 'blob' });
      saveBlob(r, `daily-report.${format}`);
    } catch (e) {
      let text = 'The file could not be made. Please try again.';
      try { text = JSON.parse(await e.response.data.text()).error || text; } catch { /* keep */ }
      setErr(text);
    } finally { setBusy(''); }
  }

  const openDay = (d) => { setDay(d); setView('day'); };
  const o = (data && data.options) || {};
  const selfOnly = data ? data.selfOnly : true;
  const shown = data && data.view === view ? data : null;

  return (
    <div className="fux-dr">
      <div className="fux-dr-bar">
        <div className="fux-seg" role="tablist" aria-label="View">
          <button type="button" className={view === 'day' ? 'is-on' : ''} onClick={() => setView('day')}>Day</button>
          <button type="button" className={view === 'month' ? 'is-on' : ''} onClick={() => setView('month')}>Month</button>
        </div>
        {view === 'day' ? (
          <div className="field">
            <label htmlFor="dr-day">Day</label>
            <input id="dr-day" type="date" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} />
          </div>
        ) : (
          <div className="field">
            <label htmlFor="dr-month">Month</label>
            <input id="dr-month" type="month" value={month} max={today.slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          </div>
        )}
        {!selfOnly && (
          <>
            <FacetSelect label="Department" value={f.department} allLabel="All departments" options={o.departments} onChange={(v) => setF({ department: v, team: '', person: '' })} />
            <FacetSelect label="Team" value={f.team} allLabel="All teams" options={o.teams} onChange={(v) => setF((x) => ({ ...x, team: v, person: '' }))} />
            <FacetSelect label="Recruiter" value={f.person} allLabel="Everyone" options={o.people} onChange={(v) => setF((x) => ({ ...x, person: v }))} />
            <FacetSelect label="Active / Former" value={f.people} allLabel="Active + former" options={o.status} onChange={(v) => setF((x) => ({ ...x, people: v, person: '' }))} />
            {(f.department || f.team || f.person || f.people) && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setF({ department: '', team: '', person: '', people: '' })}>Clear</button>}
          </>
        )}
        <div className="fux-actions" style={{ marginLeft: 'auto' }}>
          {['csv', 'xlsx', 'pdf'].map((fmt) => (
            <button key={fmt} type="button" className="btn btn-sm" disabled={!!busy || !shown} onClick={() => exportAs(fmt)}>
              {busy === fmt ? 'Preparing…' : `Export ${fmt === 'xlsx' ? 'Excel' : fmt.toUpperCase()}`}
            </button>
          ))}
        </div>
      </div>

      {err && <div className="fux-err" style={{ marginBottom: 10 }}>{err}</div>}
      {!shown && !err && <div className="small-muted">Loading the daily report…</div>}

      {shown && (
        <div style={{ opacity: loading ? 0.55 : 1, transition: 'opacity .15s' }}>
          <div className="fux-dr-scope">
            {view === 'day' ? fmtLongDay(shown.day) : fmtMonth(shown.month)} · {shown.scope}
          </div>

          {view === 'month' && (
            <>
              {shown.targets.length > 0 ? (
                <div className="fux-targets">
                  {shown.targets.map((t) => {
                    const pct = Math.min(100, Math.round((t.done / t.target) * 100));
                    return (
                      <div className="fux-target" key={t.key}>
                        <div className="fux-target-top"><b>{t.label}</b><span>{t.done.toLocaleString('en-IN')} of {t.target.toLocaleString('en-IN')} this month</span></div>
                        <div className={`fux-bar${t.done >= t.target ? ' is-done' : ''}`}><span style={{ width: `${pct}%` }} /></div>
                      </div>
                    );
                  })}
                </div>
              ) : <div className="fux-note" style={{ marginTop: 0, marginBottom: 10 }}>{shown.targetNote}</div>}

              <div className="fux-table-wrap">
                <table className="fux-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      {shown.columns.map((k) => <th key={k} className="num" title={(shown.metrics.find((m) => m.key === k) || {}).hint}>{COL_LABEL[k]}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.days.filter((d) => !d.future).map((d) => (
                      <tr
                        key={d.date}
                        className={`${d.future ? 'is-future' : 'is-click'}${d.date === today ? ' is-today' : ''}`}
                        onClick={d.future ? undefined : () => openDay(d.date)}
                        title={d.future ? undefined : 'Open this day'}
                      >
                        <td>{fmtDay(d.date)}{d.date === today ? ' · today' : ''}</td>
                        {shown.columns.map((k) => <Cell key={k} k={k} v={d[k]} />)}
                      </tr>
                    ))}
                    <tr className="is-total">
                      <td>Total</td>
                      {shown.columns.map((k) => <Cell key={k} k={k} v={shown.totals[k]} />)}
                    </tr>
                  </tbody>
                </table>
              </div>
              {shown.totals.missed > 0 && <div className="fux-note"><span className="fux-red">{shown.totals.missed} follow-ups missed</span> this month — open a day to see which.</div>}
              <PeopleTable people={shown.people} columns={shown.columns} showLate />
            </>
          )}

          {view === 'day' && (
            <>
              {(() => {
                const cards = DAY_CARDS.filter((k) => shown.totals[k]);
                if (!cards.length && !shown.total) return <div className="fux-banner is-orange">No work recorded on this day.</div>;
                return (
                  <div className="fux-cards">
                    {cards.map((k) => {
                      const m = shown.metrics.find((x) => x.key === k) || {};
                      return (
                        <div className="fux-card" key={k} title={m.hint}>
                          <div className={`fux-card-n${k === 'missed' ? ' fux-red' : ''}`}>{shown.totals[k].toLocaleString('en-IN')}</div>
                          <div className="fux-card-l">{m.label}</div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
              <PeopleTable people={shown.people} columns={shown.metrics.filter((m) => m.col).map((m) => m.key)} showLate={shown.day === today} />
              <DayRows rows={shown.rows} />
              <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => { setMonth(shown.day.slice(0, 7)); setView('month'); }}>← Back to {fmtMonth(shown.day.slice(0, 7))}</button>
            </>
          )}

          <div className="fux-note">{shown.notes.pending}</div>
          <div className="fux-note">{shown.notes.added}</div>
          {view === 'month' && shown.importedCount > 0 && <div className="fux-note">{shown.notes.imported}</div>}
        </div>
      )}

      {!selfOnly && <MailSettings />}
    </div>
  );
}
