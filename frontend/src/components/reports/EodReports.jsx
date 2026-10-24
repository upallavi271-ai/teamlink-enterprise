import { useEffect, useState } from 'react';
import api from '../../api';
import { FacetSelect } from '../ui/ListPageHeader.jsx';
import Modal from '../Modal.jsx';
import PendingWorkSettings from '../team/PendingWorkSettings.jsx';
import { errText, istTime } from '../team/pendingWorkKit.jsx';
import '../followups/followups.css';
import '../team/pendingWork.css';

// ---------------------------------------------------------------------------
// REPORTS -> ATS -> DAILY REPORT -> END OF DAY (user request 2026-10-10).
// At the end of the day the team lead gets three things in one report:
//   1) the Call report   2) the Team report   3) the Individual reports
// (mail + bell + Excel + this screen). A BDE team lead gets the BDE-desk version.
//
// GET  /api/pending-work/eod?tl=&day=&build=1   one report + the days kept + the team leads you may read
// GET  /api/pending-work/eod/xlsx?tl=&day=      the Excel file
// POST /api/pending-work/eod/send               send now / send again
// ---------------------------------------------------------------------------

const longDay = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '');
const shortDay = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' }) : '');
const monthName = (m) => (m ? new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) : '');
const num = (n) => (n === null || n === undefined ? null : Number(n));
// Never a bare zero.
const show = (n) => (num(n) === null || num(n) === 0 ? '—' : num(n).toLocaleString('en-IN'));

function saveBlob(res, fallback) {
  const cd = (res.headers && res.headers['content-disposition']) || '';
  const m = /filename="?([^";]+)"?/.exec(cd);
  const href = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = href; a.download = (m && m[1]) || fallback; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(href), 2000);
}

const OUTCOMES = [
  ['connected', 'Spoke'], ['interested', 'Interested'], ['notInterested', 'Not interested'], ['callBack', 'Call back'],
  ['notAnswered', 'No answer'], ['busy', 'Busy'], ['switchedOff', 'Switched off'], ['wrongNumber', 'Wrong number'],
  ['failed', 'Failed'], ['started', 'Started'], ['other', 'Other'],
];
const OUTCOME_TONE = { connected: 'green', interested: 'green', callBack: 'blue', started: 'blue' };

function Change({ now, before }) {
  const a = num(now); const b = num(before);
  if (a === null || b === null) return <span className="fux-dash">—</span>;
  if (a === b) return <span className="pwk-same">same</span>;
  const up = a > b;
  return <span className={up ? 'pwk-up' : 'pwk-down'}>{`${up ? '▲' : '▼'} ${Math.abs(a - b).toLocaleString('en-IN')}`}</span>;
}

function Part({ no, title, hint, children }) {
  return (
    <section className="pwk-part">
      <h3 className="pwk-part-title"><span className="pwk-part-no">{no}</span>{title}</h3>
      {hint && <div className="small-muted pwk-part-hint">{hint}</div>}
      {children}
    </section>
  );
}

// ---- 1) CALL REPORT ----------------------------------------------------------
function CallReport({ r }) {
  const c = r.calls && r.calls.team;
  const people = r.people || [];
  if (!c) return null;
  return (
    <Part no="1" title="Call report" hint="Who called, who spoke, and who still has people to call.">
      <div className={`fux-banner ${c.total ? 'is-blue' : 'is-orange'}`}>
        {c.total ? (
          <>
            <b>{`${c.total} call${c.total === 1 ? '' : 's'}`}</b>
            {` to ${c.candidates || 0} people · `}
            <b className="fux-green">{`${c.connected || 0} spoke`}</b>
            {` · ${c.notConnected || 0} not reached`}
            {c.talkMinutes ? ` · ${c.talkMinutes} minutes of talk` : ''}
          </>
        ) : <b>No calls were made today.</b>}
      </div>
      <div className="pwk-chips">
        {OUTCOMES.filter(([k]) => Number(c.outcomes && c.outcomes[k]) > 0).map(([k, l]) => (
          <span key={k} className={`pwk-tag pwk-tag-${OUTCOME_TONE[k] || 'grey'}`}>{`${l} ${c.outcomes[k]}`}</span>
        ))}
      </div>
      <div className="pwk-wrap">
        <table className="fux-table pwk-table pwk-flat">
          <thead>
            <tr>
              <th>Recruiter</th>
              <th className="num">Calls</th>
              <th className="num">Spoke</th>
              <th className="num">Not reached</th>
              <th className="num">Interested</th>
              <th>Last call</th>
              <th className="num" title="People whose follow-up was due today and who were not called">Due, not called</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => {
              const k = p.calls || {};
              return (
                <tr key={p.userId}>
                  <td data-label="Recruiter"><b>{p.name}</b></td>
                  <td className="num" data-label="Calls">{show(k.total)}</td>
                  <td className="num" data-label="Spoke">{show(k.connected)}</td>
                  <td className="num" data-label="Not reached">{show(k.notConnected)}</td>
                  <td className="num" data-label="Interested">{show(k.outcomes && k.outcomes.interested)}</td>
                  <td data-label="Last call">{k.lastCallAt ? istTime(k.lastCallAt) : <span className="fux-dash">—</span>}</td>
                  <td className={`num ${k.dueNotCalled ? 'fux-red' : ''}`} data-label="Due, not called" title={(k.dueNotCalledNames || []).join(', ')}>{show(k.dueNotCalled)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Part>
  );
}

// ---- 2) TEAM REPORT ----------------------------------------------------------
function recruitingRows(t, p, m) {
  return [
    ['Calls made', t.calls, p.calls, m.calls],
    ['Calls where they spoke', t.callsConnected, null, null],
    ['Mails to candidates', t.mails, p.mails, null],
    ['WhatsApp to candidates', t.whatsapp, p.whatsapp, null],
    ['Follow-ups done', t.followUpsDone, p.followUpsDone, m.followUpsDone],
    ['Moved to team lead check', t.sentTl, p.sentTl, null],
    ['Sent to client', t.sentClient, p.sentClient, m.sentClient],
    ['Interviews fixed', t.interviews, p.interviews, m.interviews],
    ['Interviews done', t.interviewsDone, p.interviewsDone, null],
    ['Selected', t.selected, null, null],
    ['Offers', t.offers, p.offers, null],
    ['Joined', t.joined, p.joined, m.joined],
    ['Rejected', t.rejected, null, null],
  ];
}
const bdeRows = (t) => ([
  ['Client contacts', t.clientContacts], ['Client notes', t.clientNotes], ['Agreements sent', t.agreementsSent],
  ['Sent to clients', t.sentToClient], ['Interviews fixed', t.interviewsSet], ['Client feedback saved', t.clientFeedbackSaved],
  ['Follow-ups done', t.followUpsDone], ['Steps moved', t.stepsMoved],
].filter(([a, b]) => !(a === 'Agreements sent' && b === undefined)).map(([a, b]) => [a, b, null, null]));

function TeamReport({ r, bde }) {
  const t = r.team.totals || {};
  const prev = r.team.previous;
  const month = r.team.month;
  const pd = r.team.pending || {};
  const rows = bde ? bdeRows(t) : recruitingRows(t, prev || {}, month || {});
  const tg = r.team.joiningTarget;
  const jobs = r.team.jobsNoSubmissionList || [];
  const pct = tg && tg.target ? Math.min(100, Math.round((tg.joinings / tg.target) * 100)) : 0;
  const pend = [
    ['Late', pd.late, 'red'], ['Due today', pd.dueToday, 'orange'], ['Waiting', pd.waiting, 'blue'],
    ...(bde ? [['Client work waiting', pd.clientWork, 'orange']] : [['Follow-ups late', pd.followUpsLate, 'red'], ['Not moving (old work)', pd.notMoving, 'grey']]),
  ].filter(([, n]) => Number(n) > 0);
  return (
    <Part no={bde ? '1' : '2'} title="Team report" hint={bde ? 'What the client managers (BDE) did today.' : 'The whole team today, against the last working day and the month so far.'}>
      <div className="pwk-wrap">
        <table className="fux-table pwk-table pwk-flat">
          <thead>
            <tr>
              <th>What</th>
              <th className="num">Today</th>
              {!bde && <th className="num">{prev && prev.day ? `Before (${shortDay(prev.day)})` : 'Before'}</th>}
              {!bde && <th className="num">Change</th>}
              {!bde && <th className="num">{month && month.month ? `${monthName(month.month)} so far` : 'Month so far'}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, now, before, mo]) => (
              <tr key={label}>
                <td data-label="What">{label}</td>
                <td className="num" data-label="Today"><b>{show(now)}</b></td>
                {!bde && <td className="num" data-label="Before">{show(before)}</td>}
                {!bde && <td className="num" data-label="Change"><Change now={now} before={before} /></td>}
                {!bde && <td className="num" data-label="Month so far">{show(mo)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pwk-pend">
        <b>Pending now</b>
        {pend.length ? pend.map(([l, n, tone]) => <span key={l} className={`pwk-tag pwk-tag-${tone}`}>{`${l} ${n}`}</span>) : <span className="pwk-tag pwk-tag-green">Nothing is pending</span>}
      </div>

      {tg && (
        <div className="pwk-target">
          <div><b>Joinings this month:</b> {`${tg.joinings} of ${tg.target}`}</div>
          <div className="pwk-bar"><span style={{ width: `${pct}%` }} className={tg.joinings >= tg.target ? 'is-done' : ''} /></div>
        </div>
      )}

      {jobs.length > 0 && (
        <div className="pwk-jobs">
          <div className="pwk-jobs-title">Requirements where no profile was sent today</div>
          {jobs.map((j, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <div key={i} className="small-muted">{`${j.job}${j.client ? ` (${j.client})` : ''}`}</div>
          ))}
        </div>
      )}
    </Part>
  );
}

// ---- 3) INDIVIDUAL REPORTS ---------------------------------------------------
function Stat({ label, v }) {
  if (!(Number(v) > 0)) return null;
  return <span className="pwk-stat"><b>{Number(v).toLocaleString('en-IN')}</b>{` ${label}`}</span>;
}

function Individuals({ r, bde }) {
  const people = r.people || [];
  if (!people.length) return null;
  return (
    <Part no={bde ? '2' : '3'} title="Individual reports" hint="One card for each person.">
      <div className="pwk-cards">
        {people.map((p) => {
          const pend = bde ? { waiting: p.waiting, late: p.late, dueToday: p.dueToday } : (p.pending || {});
          const k = p.calls || {};
          return (
            <article key={p.userId} className={`pwk-card${p.noActivity ? ' is-quiet' : ''}`}>
              <div className="pwk-card-head">
                <b>{p.name}</b>
                {bde && p.seat ? <span className="small-muted">{p.seat}</span> : null}
                {p.noActivity && <span className="pwk-tag pwk-tag-orange">No activity today</span>}
              </div>
              <div className="pwk-stats">
                {bde ? (
                  <>
                    <Stat label="client contacts" v={p.clientContacts} />
                    <Stat label="notes" v={p.clientNotes} />
                    <Stat label="agreements sent" v={p.agreementsSent} />
                    <Stat label="sent to clients" v={p.sentToClient} />
                    <Stat label="interviews fixed" v={p.interviewsSet} />
                    <Stat label="client feedback saved" v={p.clientFeedbackSaved} />
                    <Stat label="follow-ups done" v={p.followUpsDone} />
                    <Stat label="steps moved" v={p.stepsMoved} />
                  </>
                ) : (
                  <>
                    <Stat label="calls" v={k.total} />
                    <Stat label="spoke" v={k.connected} />
                    <Stat label="steps moved" v={p.stepsMoved} />
                    <Stat label="sent to team lead" v={p.sentTl} />
                    <Stat label="sent to client" v={p.sentClient} />
                    <Stat label="interviews fixed" v={p.interviews} />
                    <Stat label="interviews done" v={p.interviewsDone} />
                    <Stat label="selected" v={p.selected} />
                    <Stat label="offers" v={p.offers} />
                    <Stat label="joined" v={p.joined} />
                    <Stat label="follow-ups done" v={p.followUps && p.followUps.done} />
                  </>
                )}
                {p.noActivity && <span className="small-muted">Nothing was recorded for this person today.</span>}
              </div>
              <div className="pwk-pend pwk-pend-sm">
                {Number(pend.late) > 0 && <span className="pwk-tag pwk-tag-red">{`${pend.late} late`}</span>}
                {Number(pend.dueToday) > 0 && <span className="pwk-tag pwk-tag-orange">{`${pend.dueToday} due today`}</span>}
                {Number(pend.waiting) > 0 && <span className="pwk-tag pwk-tag-blue">{`${pend.waiting} waiting`}</span>}
                {bde && Number(p.pendingTotal) > 0 && <span className="pwk-tag pwk-tag-orange">{`${p.pendingTotal} client work waiting`}</span>}
                {!(Number(pend.late) > 0 || Number(pend.dueToday) > 0 || Number(pend.waiting) > 0 || Number(p.pendingTotal) > 0) && <span className="pwk-tag pwk-tag-green">Nothing waiting</span>}
                {!bde && p.followUps && Number(p.followUps.openDue) > 0 && <span className="pwk-tag pwk-tag-red">{`${p.followUps.openDue} follow-up${p.followUps.openDue === 1 ? '' : 's'} not done`}</span>}
              </div>
              {(p.lateItems || []).length > 0 && (
                <ul className="pwk-late">
                  {p.lateItems.map((it, i) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <li key={i}>
                      <b>{it.candidate}</b>{` — ${it.job}`}
                      <span className="small-muted">{` · ${it.step || ''}`}</span>
                      {it.daysLate ? <span className="fux-red">{` · ${it.daysLate} day${it.daysLate === 1 ? '' : 's'} late`}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}
      </div>
    </Part>
  );
}

// ---- the screen ----------------------------------------------------------------
export default function EodReports({ initialDay }) {
  const [tl, setTl] = useState('');
  const [day, setDay] = useState(initialDay || '');
  const [build, setBuild] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [ok, setOk] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [settings, setSettings] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api.get('/pending-work/eod', { params: { ...(tl ? { tl } : {}), ...(day ? { day } : {}), ...(build ? { build: 1 } : {}) } })
      .then((r) => { if (live) { setData(r.data); setErr(''); } })
      .catch((e) => { if (live) setErr(errText(e, 'Could not load the end-of-day report. Please try again.')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [tl, day, build]);

  const pick = (patch) => { setOk(''); setConfirm(false); if ('tl' in patch) { setTl(patch.tl); setBuild(false); } if ('day' in patch) { setDay(patch.day); setBuild(false); } };

  if (err && !data) return <div className="fux-err">{err}</div>;
  if (!data) return <div className="small-muted">Loading the end-of-day report…</div>;

  const r = data.report;
  const tls = data.teamLeads || [];
  const bde = !!r && r.kind === 'bde';
  const stored = (data.days || []).includes(data.day);
  const tlId = data.tl || tl;

  async function download() {
    setBusy('xlsx'); setErr('');
    try {
      const res = await api.get('/pending-work/eod/xlsx', { params: { tl: tlId, day: data.day }, responseType: 'blob' });
      saveBlob(res, `end-of-day-${data.day}.xlsx`);
    } catch (e) {
      let text = 'The Excel file could not be made. Please try again.';
      try { text = JSON.parse(await e.response.data.text()).error || text; } catch { /* keep */ }
      setErr(text);
    } finally { setBusy(''); }
  }
  async function send() {
    setBusy('send'); setErr(''); setOk(''); setConfirm(false);
    try {
      const res = await api.post('/pending-work/eod/send', { tl: tlId, day: data.day });
      setOk(`Sent${res.data && res.data.sentTo ? ` to ${res.data.sentTo}` : ''}${res.data && res.data.copies ? ` and ${res.data.copies} cop${res.data.copies === 1 ? 'y' : 'ies'}` : ''}.`);
    } catch (e) { setErr(errText(e, 'The report could not be sent. Please try again.')); } finally { setBusy(''); }
  }

  return (
    <div className="pwk-eod" style={{ opacity: loading ? 0.6 : 1, transition: 'opacity .15s' }}>
      <div className="fux-dr-bar">
        {tls.length > 1 && (
          <FacetSelect
            label="Team lead"
            value={tlId}
            allLabel="Choose"
            options={tls.map((t) => ({ value: t.id, label: `${t.name}${t.department ? ` · ${t.department}` : ''}`, count: 1 }))}
            onChange={(v) => pick({ tl: v })}
          />
        )}
        <div className="field">
          <label htmlFor="eod-day">Day</label>
          <input id="eod-day" type="date" value={data.day} max={data.today} onChange={(e) => e.target.value && pick({ day: e.target.value })} />
        </div>
      </div>
      {(data.days || []).length > 0 && (
        <div className="pwk-days">
          <span className="small-muted">Reports kept:</span>
          {[...data.days].sort().reverse().slice(0, 10).map((d) => (
            <button key={d} type="button" className={`pwk-chip${d === data.day ? ' is-on' : ''}`} onClick={() => pick({ day: d })}>{shortDay(d)}</button>
          ))}
        </div>
      )}

      {err && <div className="fux-err" style={{ marginBottom: 8 }}>{err}</div>}
      {ok && <div className="fux-banner is-green" role="status">{ok}</div>}

      {!r && (
        <div className="pwk-empty">
          <div className="fux-banner is-orange">{data.note || 'There is no report for this day.'}</div>
          {data.day <= data.today && !build && (
            <button type="button" className="btn btn-primary" onClick={() => setBuild(true)}>Build this day</button>
          )}
        </div>
      )}

      {r && (
        <>
          <div className="pwk-eod-head">
            <div>
              <h2 className="pwk-eod-title">{`End of day — ${longDay(r.day)}`}</h2>
              <div className="small-muted">{`${r.tl && r.tl.name ? `Team lead: ${r.tl.name} · ` : ''}${r.scope || ''}`}</div>
            </div>
            <div className="pwk-eod-btns">
              <button type="button" className="btn btn-primary" disabled={!!busy} onClick={download}>{busy === 'xlsx' ? 'Preparing…' : 'Download Excel'}</button>
              {data.canSend && !confirm && (
                <button type="button" className="btn" disabled={!!busy} onClick={() => setConfirm(true)}>{stored ? 'Send again' : 'Send now'}</button>
              )}
              {data.canSend && confirm && (
                <span className="pwk-confirm">
                  <span className="small-muted">{`Send this report to ${r.tl && r.tl.name ? r.tl.name : 'the team lead'}?`}</span>
                  <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={send}>{busy === 'send' ? 'Sending…' : 'Yes, send'}</button>
                  <button type="button" className="btn btn-sm" onClick={() => setConfirm(false)}>Cancel</button>
                </span>
              )}
              {data.canManage && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSettings(true)}>Report settings</button>}
            </div>
          </div>

          {(r.rebuilt || (data.note && data.day !== data.today)) && (
            <div className="fux-banner is-orange">
              {data.note || 'This day was rebuilt from the records. The pending numbers are not known for a past day.'}
            </div>
          )}
          {r.quiet && <div className="fux-banner is-orange">{bde ? 'No activity was recorded on the client desk today.' : 'No activity was recorded for this team today.'}</div>}
          {(r.noActivity || []).length > 0 && !r.quiet && (
            <div className="fux-banner is-orange"><b>No activity today:</b> {r.noActivity.join(', ')}</div>
          )}

          {!bde && <CallReport r={r} />}
          <TeamReport r={r} bde={bde} />
          <Individuals r={r} bde={bde} />

          {r.pendingNote && <div className="fux-note">{r.pendingNote}</div>}
          {r.generatedAt && <div className="fux-note">{`Made at ${istTime(r.generatedAt)} Indian time.`}</div>}
        </>
      )}

      {settings && (
        <Modal title="Reminders and reports" size="wide" onClose={() => setSettings(false)}>
          <PendingWorkSettings onClose={() => setSettings(false)} />
        </Modal>
      )}
    </div>
  );
}
