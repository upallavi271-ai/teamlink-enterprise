import { useEffect, useState } from 'react';
import api from '../api';
import { Modal } from './proto.jsx';
import './interviews/Interviews.css';
// B4 (2026-10-06): a PANEL of interviewers, and "Create meeting link".
import PanelPicker from './interviews/PanelPicker.jsx';
// 2026-10-14: Google Meet link field (Create a Meet link / paste / standing link); the booking e-mail goes with a calendar invite.
import { linkCheck } from './interviews/MeetStart.jsx';
import MeetingProviderField, { providerCheck } from './interviews/MeetingProviderField.jsx'; // Google Meet / Zoom / Teams / Other (audit 235)
// 2026-10-10: the "Booked - now tell them" window: Call / WhatsApp / SMS / Mail to the candidate, and the team.
import { InterviewTellWithPrep as InterviewTell } from './interviews/InterviewPrep.jsx'; // the booking window + the preparation-questions line
// 2026-11-20: "Reminders to the candidate" - scheduled messages 2 days / 1 day / 2 hours before, decided here by the recruiter / TL; the venue details they need.
import RemindersPlanEditor from './reminders/RemindersPlanEditor.jsx';
import ReminderDetailsFields from './reminders/ReminderDetailsFields.jsx';

// ---------------------------------------------------------------------------
// BOOK AN INTERVIEW — "like booking a cab" (change list §11, 2026-10-03).
//
//   Who → When (date, time) → How (Online / In person + link or address)
//   → Interviewer → [Book interview]
//
// One main button. The server (POST /ats/interviews/:id/book) does the
// pipeline move to Interview Scheduled (permission, history, follow-up) and
// tells the candidate, the recruiter / TL / client manager and the client.
// `preset` = { id, candidate: { name }, job, client, round? } books that person
// straight away (the "Book" button on a shortlisted row, "Next round").
//
// LAYOUT v3 (2026-10-03): Who (candidate + job) → ROUND → When → Online /
// Offline + link or address → Interviewer. After saving, the "Booked — now tell
// them" window (components/interviews/InterviewTell.jsx, 2026-10-10): the
// candidate gets Call · WhatsApp · SMS · Mail (each through the messaging module,
// or opened in the person's own app when a channel is not connected), "Send on
// all available channels", and the recruiter / TL / client manager (BDE) /
// interviewer can be told with one button. onBooked() fires on save (reload the
// list); onScheduled(msg) on Done.
// ---------------------------------------------------------------------------
const initials = (n) => String(n || '?').replace(/^ZZTEST\S*\s*/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

function Who({ row, onChange }) {
  return (
    <div className="ivx-who">
      <span className="ivx-av" aria-hidden="true">{initials(row.candidate.name)}</span>
      <span className="ivx-who-t">
        <b>{row.candidate.name}</b>
        <div>{row.job ? `Requirement: ${row.job}` : ''}{row.client ? ` · ${row.client}` : ''}</div>
      </span>
      {onChange && <button type="button" className="btn btn-sm btn-ghost" onClick={onChange}>Change</button>}
    </div>
  );
}

const roundOf = (row) => Math.max(1, Number(row && (row.round || row.suggestedRound)) || 1);

export default function ScheduleInterview({
  onClose, onScheduled, onBooked = null, preset = null,
}) {
  const [chosen, setChosen] = useState(preset);
  const [round, setRound] = useState(() => (preset ? roundOf(preset) : 1));
  const [done, setDone] = useState(null); // the server's reply after booking
  const pick = (row) => { setChosen(row); setRound(row ? roundOf({ round: row.suggestedRound }) : 1); };
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  const [form, setForm] = useState({ date: '', time: '', mode: 'Online', meetingLink: '', location: '', interviewer: '', provider: 'Google Meet', roundType: '' });
  const [panel, setPanel] = useState([]);
  const [venue, setVenue] = useState({}); // venue name, map link, contact person / phone, what to carry (optional, "needed for offline reminders")
  const [rem, setRem] = useState({ steps: [], ready: false }); // the reminder plan chosen below
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [listErr, setListErr] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  // TEAM AVAILABILITY (ATS audit 2026-11-17): once a person, a date and the panel are picked, ask the server what the panel (and the
  // candidate) already have that day; a clash within the hour is shown as a warning and the button says "Book anyway".
  const [slot, setSlot] = useState(null);
  const panelKey = panel.map((p) => p.userId || p.name).join('|');
  useEffect(() => {
    if (!chosen || !form.date || !panel.length) { setSlot(null); return undefined; }
    let live = true;
    const t = setTimeout(() => {
      api.post('/ats/team-tools/slot-check', {
        applicationId: chosen.id, date: form.date, time: form.time || '',
        panel: panel.map((p) => (p.userId ? { userId: p.userId } : { name: p.name })),
      }).then((r) => { if (live) setSlot(r.data); }).catch(() => { if (live) setSlot(null); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [chosen && chosen.id, form.date, form.time, panelKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const clashes = (slot && form.time && slot.clashes) || [];

  // Shortlisted people first; typing finds anyone else in your area.
  useEffect(() => {
    if (chosen) return undefined;
    const t = setTimeout(() => {
      api.get('/ats/interviews/bookable', { params: q.trim() ? { q: q.trim() } : {} })
        .then((r) => { setListErr(''); setList(r.data.rows || []); })
        .catch(() => { setListErr('Could not load people. Please try again.'); setList([]); });
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, chosen]);

  const linkState = form.provider === 'Google Meet' ? linkCheck(form.meetingLink).state : providerCheck(form.provider, form.meetingLink).state;
  const ready = chosen && form.date && form.time && panel.length > 0 && !(form.mode === 'Online' && linkState === 'bad');

  async function submit() {
    setError(''); setBusy(true);
    try {
      const r = await api.post(`/ats/interviews/${chosen.id}/book`, {
        round,
        viaPopup: true, // the "now tell them" window tells the candidate, so no automatic step message is sent too
        date: form.date,
        time: form.time,
        mode: form.mode,
        meetingLink: form.mode === 'Online' ? form.meetingLink.trim() : '',
        linkProvider: form.mode === 'Online' && form.meetingLink.trim() ? form.provider : undefined,
        roundType: form.roundType || undefined,
        location: form.mode === 'In Person' ? form.location.trim() : '',
        details: { ...venue, address: form.mode === 'In Person' ? form.location.trim() : '' },
        ...(rem.ready ? { reminders: { steps: rem.steps } } : {}),
        panel: panel.map((p) => (p.userId ? { userId: p.userId } : { name: p.name, email: p.email || null })),
      });
      setDone(r.data);
      if (onBooked) onBooked(r.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not book the interview. Please try again.');
    } finally { setBusy(false); }
  }

  if (done) {
    const finish = () => onScheduled(done.message || 'Interview booked.');
    return (
      <InterviewTell
        applicationId={chosen.id}
        kind="scheduled"
        saved={`Saved. ${chosen.candidate.name} · Round ${done.round || round}`}
        note={done.message}
        canMakeLink
        onClose={finish}
      />
    );
  }

  return (
    <Modal
      title="Book an interview"
      onClose={onClose}
      footer={(
        <button type="button" className="btn btn-primary" disabled={busy || !ready} onClick={submit}>
          {busy ? 'Booking…' : clashes.length ? 'Book anyway' : 'Book interview'}
        </button>
      )}
    >
      <div className="ivx-book">
        <div className="ivx-sec">
          <b>Who</b>
          {chosen ? (
            <Who row={chosen} onChange={preset ? null : () => pick(null)} />
          ) : (
            <>
              <input
                type="search"
                autoFocus
                placeholder="Search name, phone or requirement…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                style={{ width: '100%' }}
              />
              <div className="ivx-pick">
                {list === null && <div className="ivx-hint">Loading…</div>}
                {listErr && <div className="error-text">{listErr}</div>}
                {list && list.length === 0 && !listErr && (
                  <div className="ivx-hint">{q ? 'Nobody found. Try another name or requirement.' : 'Nobody is shortlisted right now. Search to find a person.'}</div>
                )}
                {(list || []).map((r) => (
                  <button key={r.id} type="button" onClick={() => pick(r)}>
                    <span className="ivx-av" style={{ width: 28, height: 28, fontSize: 11 }} aria-hidden="true">{initials(r.candidate.name)}</span>
                    <span className="ivx-who-t">
                      <b>{r.candidate.name}</b>
                      <div>{[r.job, r.client, r.round ? `Round ${r.round} done` : null].filter(Boolean).join(' · ')}</div>
                    </span>
                    {r.shortlisted ? <span className="ivx-pill green">Shortlisted</span> : r.nextRound ? <span className="ivx-pill blue">Next round</span> : null}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="ivx-sec">
          <b>Round</b>
          <div className="ivv3-rounds" role="radiogroup" aria-label="Interview round">
            {[...new Set([1, 2, 3, 4, round])].sort((a, b) => a - b).map((n) => (
              <button key={n} type="button" role="radio" aria-checked={round === n} className={round === n ? 'is-on' : ''} onClick={() => setRound(n)}>{n}</button>
            ))}
            <button type="button" aria-label="One more round" onClick={() => setRound(Math.min(20, round + 1))}>+</button>
          </div>
          <select aria-label="Round type" value={form.roundType} onChange={(e) => set({ roundType: e.target.value })} style={{ marginTop: 6 }}>
            <option value="">Round type (optional)</option>
            {['Technical', 'HR', 'Management', 'Client', 'Other'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        <div className="ivx-sec">
          <b>When</b>
          <div className="ivx-two">
            <input type="date" aria-label="Date" min={todayIst()} value={form.date} onChange={(e) => set({ date: e.target.value })} />
            <input type="time" aria-label="Time" value={form.time} onChange={(e) => set({ time: e.target.value })} />
          </div>
        </div>

        <div className="ivx-sec">
          <b>How</b>
          <div className="ivx-modes" role="radiogroup" aria-label="Online or in person">
            {[['Online', '💻 Online (video call)'], ['In Person', '🏢 Offline — in person']].map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={form.mode === v} className={`ivx-mode${form.mode === v ? ' is-on' : ''}`} onClick={() => set({ mode: v })}>{label}</button>
            ))}
          </div>
          <div style={{ marginTop: 8 }}>
            {form.mode === 'Online' ? (
              <MeetingProviderField provider={form.provider} onProvider={(p) => set({ provider: p })} value={form.meetingLink} onChange={(v) => set({ meetingLink: v })} />
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                <div className="rem-grid" style={{ gridTemplateColumns: '1fr' }}>
                  <label>
                    <span>Full address<span className="rem-need"> · needed for offline reminders</span></span>
                    <input aria-label="Address" placeholder="Address, e.g. 12 MG Road, Hyderabad 500001" value={form.location} onChange={(e) => set({ location: e.target.value })} />
                  </label>
                </div>
                <ReminderDetailsFields kind="interview" value={venue} onChange={setVenue} hideAddress />
              </div>
            )}
          </div>
        </div>

        <div className="ivx-sec">
          <RemindersPlanEditor
            applicationId={chosen ? chosen.id : null}
            kind="interview"
            eventAt={form.date && form.time ? new Date(`${form.date}T${form.time}:00+05:30`).toISOString() : null}
            mode={form.mode}
            details={{ ...venue, address: form.mode === 'In Person' ? form.location.trim() : '' }}
            onChange={setRem}
          />
        </div>

        <div className="ivx-sec">
          <b>Interviewers (panel)</b>
          <PanelPicker value={panel} onChange={setPanel} />
          <div className="ivx-hint">One or more people. Each gives their own feedback; the final decision is still one.</div>
        </div>

        {slot && (
          <div className="ivx-sec" aria-live="polite">
            <b>{`The panel's day (${form.date.split('-').reverse().join('/')})`}</b>
            {clashes.length > 0 && (
              <div className="error-text" style={{ margin: '4px 0 6px' }}>
                {clashes.map((c, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <div key={i}>{c.kind === 'candidate' ? `Clash: ${c.who} already has an interview at ${c.time}${c.job ? ` (${c.job})` : ''}.` : `Clash: ${c.who} already has an interview at ${c.time}${c.candidate && c.candidate !== 'Another interview' ? ` with ${c.candidate}` : ''}.`}</div>
                ))}
              </div>
            )}
            {slot.booked.length ? (
              <div className="small-muted" style={{ display: 'grid', gap: 2, fontSize: 12 }}>
                {slot.booked.map((b, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <div key={i} style={b.clash && form.time ? { color: 'var(--red, #b91c1c)' } : undefined}>{`${b.time} · ${b.interviewers.join(', ')} · ${b.candidate || 'Interview'}${b.job ? ` (${b.job})` : ''}`}</div>
                ))}
              </div>
            ) : <div className="small-muted" style={{ fontSize: 12 }}>Nothing booked for the panel that day.</div>}
            {slot.freeTimes && slot.freeTimes.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6, alignItems: 'center' }}>
                <span className="small-muted" style={{ fontSize: 12 }}>Free:</span>
                {slot.freeTimes.slice(0, 12).map((t) => (
                  <button key={t} type="button" className={`btn btn-sm${form.time === t ? ' btn-primary' : ''}`} onClick={() => set({ time: t })}>{t}</button>
                ))}
              </div>
            )}
            <div className="ivx-hint">{`An interview is taken as ${slot.windowMinutes || 60} minutes. A clash is a warning only; you can still book.`}</div>
          </div>
        )}

        {/* The button is greyed until these are filled — say why. */}
        {!ready && !busy && <div className="ivx-hint">Pick a person, date, time and at least one interviewer first.</div>}
        <div className="ivx-hint">After saving you tell the candidate by Call, WhatsApp, SMS or Mail, and the recruiter, TL and client manager (BDE) by one button. The panel and the team also get an app notice, a list of today's interviews at 8:30 am and a bell 1 hour before. An e-mail with a calendar invite goes to the candidate and the interviewers when you book. For an online interview, press "Create a Meet link" and paste it, or add it later.</div>
        {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </Modal>
  );
}
