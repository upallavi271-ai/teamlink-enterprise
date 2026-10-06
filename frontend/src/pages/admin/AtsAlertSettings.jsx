import { useEffect, useState } from 'react';
import api from '../../api';
import StatusChip from '../../components/ui/StatusChip.jsx';

// ---------------------------------------------------------------------------
// Administration → STEP TIMING — every per-step day in ONE table (spec
// 2026-10-03 §4 / §14 and the follow-up rules, C1):
//   Finish this step within N days      → the step's due date; Late after it
//                                          (utils/atsAlertSettings.js)
//   Contact the candidate every N days   → the follow-up badges
//                                          (utils/followupVisibility.js)
// plus Stale, the late-work alerts (OFF until the user approves decision #6,
// in-app only) and how long the bell keeps a message.
// GET / PUT /api/dashboard/ats/alert-settings (Super Admin / Admin change it).
// ---------------------------------------------------------------------------
const CONTACT_WORD = {
  after_contact: 'days after the last contact',
  before_interview: 'days before the interview',
  before_joining: 'days before the joining date',
  none: 'no contact needed',
  mixed: 'days (differs inside this step)',
};

export default function AtsAlertSettings() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [contact, setContact] = useState({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  // THE ONE "Candidate emails" switch (same setting as the Interview Calendar
  // admin line): every automatic email / message to candidates. OFF by default.
  const [mails, setMails] = useState(null);
  const [mailsMsg, setMailsMsg] = useState('');
  useEffect(() => {
    api.get('/ats/interview-reminders').then((r) => setMails(r.data)).catch(() => setMails(null));
  }, []);
  async function flipMails() {
    setMailsMsg('');
    try {
      const r = await api.put('/ats/interview-reminders', { enabled: !mails.enabled });
      setMails(r.data);
      setMailsMsg(r.data.message || (r.data.enabled ? 'Candidate emails are on.' : 'Candidate emails are off.'));
    } catch (e) { setMailsMsg(e.response?.data?.error || 'Could not change it. Try again.'); }
  }

  const load = () => api.get('/dashboard/ats/alert-settings')
    .then((r) => { setData(r.data); setForm(JSON.parse(JSON.stringify(r.data.settings))); setContact({}); })
    .catch((e) => setError(e.response?.data?.error || 'The settings could not be loaded. Refresh the page.'));
  useEffect(() => { load(); }, []);

  if (error && !data) return <div className="notice red">{error}</div>;
  if (!data || !form) return <div className="small-muted">Loading…</div>;
  const edit = data.canEdit;
  const c = data.contact || { rows: {} };
  const num = (v) => (v === '' ? '' : Number(v));
  const setDay = (id, v) => setForm({ ...form, dueDays: { ...form.dueDays, [id]: num(v) } });
  const setEsc = (k, v) => setForm({ ...form, escalation: { ...form.escalation, [k]: v } });

  async function save(extra = {}) {
    setBusy(true); setError(''); setSaved('');
    try {
      const r = await api.put('/dashboard/ats/alert-settings', {
        dueDays: form.dueDays, staleAfterDays: form.staleAfterDays, bellExpireDays: form.bellExpireDays,
        escalation: { enabled: form.escalation.enabled, tlAfterDays: form.escalation.tlAfterDays, managerAfterDays: form.escalation.managerAfterDays },
        contactDays: contact,
        ...extra,
      });
      setData({ ...data, settings: r.data.settings, contact: r.data.contact });
      setForm(JSON.parse(JSON.stringify(r.data.settings)));
      setContact({});
      setSaved(extra.confirmContact ? 'Confirmed and saved. These days are now in use.' : 'Saved. New due dates apply from now on.');
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save. Try again.');
    } finally { setBusy(false); }
  }
  async function runPreview() {
    setPreview({ loading: true });
    try { setPreview((await api.get('/dashboard/ats/escalation/preview')).data); } catch (e) { setPreview({ error: e.response?.data?.error || 'Could not check.' }); }
  }
  const field = (value, onChange, min, max, label) => (
    <input type="number" min={min} max={max} value={value} disabled={!edit} aria-label={label} onChange={(e) => onChange(e.target.value)} style={{ width: 70 }} />
  );
  const last = form.escalation.lastRun;
  return (
    <div style={{ maxWidth: 900 }}>
      <div className="page-head">
        <div>
          <h1>Step timing</h1>
          <div className="page-sub">How long each step may take, how often to contact the candidate, and who is told when work is late.</div>
        </div>
        {edit && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => save()}>{busy ? 'Saving…' : 'Save'}</button>}
      </div>
      {!edit && <div className="notice">Only a Super Admin or Admin can change these. You can read them.</div>}
      {saved && <div className="notice green">{saved}</div>}
      {error && <div className="notice red">{error}</div>}

      <div className="panel">
        <div className="panel-head">
          <h3>Each step</h3>
          {c.confirmed ? <StatusChip tone="green">Confirmed</StatusChip> : <StatusChip tone="amber">Suggested — confirm</StatusChip>}
        </div>
        <div style={{ padding: '8px 18px 14px' }}>
          {!c.confirmed && (
            <div className="notice" style={{ marginTop: 0 }}>
              These days are <b>suggested</b> — please check them and press <b>Confirm these days</b> (your decision #10).
              Until then the contact days are not used; the finish days already set the due dates.
            </div>
          )}
          <div className="tbl-wrap" style={{ border: 0 }}>
            <table className="ah-tbl" style={{ width: '100%' }}>
              <thead><tr><th style={{ textAlign: 'left' }}>Step</th><th style={{ textAlign: 'left' }}>Finish this step within</th><th style={{ textAlign: 'left' }}>Contact the candidate every</th></tr></thead>
              <tbody>{data.steps.map((s) => {
                const cr = c.rows[s.id] || {};
                const cv = contact[s.id] !== undefined ? contact[s.id] : cr.days;
                return (
                  <tr key={s.id}>
                    <td style={{ padding: '6px 8px 6px 0' }}><b>{s.label}</b></td>
                    <td>
                      {field(form.dueDays[s.id], (v) => setDay(s.id, v), 0, 60, `${s.label}: finish within`)}{' '}
                      <span className="small-muted">{s.hint || 'days'}{form.dueDays[s.id] !== s.defaultDays ? ` · normal ${s.defaultDays}` : ''}</span>
                    </td>
                    <td>
                      {cr.mode === 'none' && contact[s.id] === undefined
                        ? <span className="small-muted">No contact needed {edit && <button type="button" className="link-btn" onClick={() => setContact({ ...contact, [s.id]: 2 })}>Set days</button>}</span>
                        : (
                          <>
                            {field(cv ?? '', (v) => setContact({ ...contact, [s.id]: num(v) }), 0, 60, `${s.label}: contact every`)}{' '}
                            <span className="small-muted">
                              {cr.mixed && contact[s.id] === undefined ? `${cr.days}–${cr.max} ${CONTACT_WORD.after_contact}` : (CONTACT_WORD[cr.mode] || CONTACT_WORD.after_contact)}
                            </span>
                          </>
                        )}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
          <p className="small-muted" style={{ marginBottom: 0 }}>
            Work that started before {form.startedOn} is timed from {form.startedOn}, so nothing old turns Late all at once.
            A follow-up&apos;s own date always wins.
          </p>
          {edit && !c.confirmed && (
            <div style={{ marginTop: 10 }}>
              <button type="button" className="btn" disabled={busy} onClick={() => save({ confirmContact: true })}>Confirm these days</button>
            </div>
          )}
          {c.confirmed && c.confirmedBy && <div className="small-muted" style={{ marginTop: 6 }}>Confirmed by {c.confirmedBy}{c.confirmedAt ? ` on ${new Date(c.confirmedAt).toLocaleDateString('en-GB')}` : ''}.</div>}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>Old work (Stale)</h3></div>
        <div style={{ padding: '8px 18px 14px' }}>
          Nothing happened for {field(form.staleAfterDays, (v) => setForm({ ...form, staleAfterDays: num(v) }), 7, 365, 'Stale after days')} days → it goes to <b>Stale</b>, not Late.
          <div className="small-muted">Stale work is shown on the dashboard on its own; a Super Admin / Admin can close it in bulk there.</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Tell the next boss when work is late</h3>
          {form.escalation.enabled ? <StatusChip tone="green">On</StatusChip> : <StatusChip tone="amber">Off</StatusChip>}
        </div>
        <div style={{ padding: '8px 18px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={form.escalation.enabled} disabled={!edit} onChange={(e) => setEsc('enabled', e.target.checked)} />
            Switch on (checked every 15 minutes)
          </label>
          <div>Due date passed → the person who owns the step.</div>
          <div>Late more than {field(form.escalation.tlAfterDays, (v) => setEsc('tlAfterDays', num(v)), 0, 30, 'Team lead after days')} day(s) → also the team lead.</div>
          <div>Late more than {field(form.escalation.managerAfterDays, (v) => setEsc('managerAfterDays', num(v)), 0, 60, 'Manager after days')} day(s) → also the manager.</div>
          <div className="small-muted">Only a bell message for now — one message per person per day, updated, never one per candidate. Email, WhatsApp and SMS wait for your decision.</div>
          {last && <div className="small-muted">Last check: {new Date(last.at).toLocaleString('en-IN')} · {last.late} late · {last.people} people told</div>}
          {edit && (
            <div>
              <button type="button" className="btn btn-sm" onClick={runPreview}>Who would be told now?</button>
              {preview && preview.loading && <span className="small-muted"> Checking…</span>}
              {preview && preview.error && <span className="notice red">{preview.error}</span>}
              {preview && preview.groups && (
                <div className="small-muted" style={{ marginTop: 6 }}>
                  {preview.late ? `${preview.late} late item${preview.late === 1 ? '' : 's'} · ` : 'Nothing is late right now. '}
                  {preview.groups.length ? preview.groups.map((g) => `${g.name} (${g.level === 'owner' ? 'owner' : g.level === 'tl' ? 'team lead' : 'manager'}): ${g.count}`).join(' · ') : 'Nobody would get a message.'}
                  {' '}(Nothing was sent.)
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {mails && (
        <div className="panel">
          <div className="panel-head">
            <h3>Candidate emails</h3>
            {mails.enabled ? <StatusChip tone="green">On</StatusChip> : <StatusChip tone="amber">Off</StatusChip>}
          </div>
          <div style={{ padding: '8px 18px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>One switch for every email to candidates: Rejected, Selected, offer letters, interview booked / moved / reminders.</div>
            <div className="small-muted">
              {mails.enabled
                ? 'On: these messages are sent.'
                : 'Off: each message is still saved on the candidate’s Communications as “Not sent — candidate emails are switched off”, but nothing goes out.'}
              {' '}Team in-app notices always go.
            </div>
            {mails.canEdit && (
              <div><button type="button" className="btn btn-sm" onClick={flipMails}>{mails.enabled ? 'Turn off' : 'Turn on'}</button></div>
            )}
            {mailsMsg && <div className="notice">{mailsMsg}</div>}
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head"><h3>Bell</h3></div>
        <div style={{ padding: '8px 18px 14px' }}>
          Messages older than {field(form.bellExpireDays, (v) => setForm({ ...form, bellExpireDays: num(v) }), 1, 90, 'Bell keeps messages days')} days stop counting in the bell.
          <div className="small-muted">The bell counts only what is yours: your late / due-today tasks, approvals, mentions and (for admins) system alerts. Red = late, orange = due today.</div>
        </div>
      </div>
    </div>
  );
}
