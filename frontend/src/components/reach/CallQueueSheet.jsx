import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Modal from './ReachModal.jsx';
import ReachResult from './ReachResult.jsx';
import { REACH_MAX, countLine, telHref } from './reachKit.js';
import '../messaging/messaging.css';
import './reach.css';

// ---------------------------------------------------------------------------
// CALL LIST — call the ticked candidates one after another.
//
//   "You selected 37: 31 can be called, 4 no consent, 2 no phone"  (the server checked it)
//   then ONE person at a time: the name, the job, the number BIG, then
//     [Call now]  opens the dialler (tel:) on this phone / computer
//     [Call through TeamLink]  only when the Exotel connection is on: your own phone rings first
//   then how it went: Answered · Not answered · Busy · Wrong number · Call back (+ a date),
//   an optional note, and [Save and next candidate]. Every call is written to the candidate's
//   history and moves their open follow-up (last contact, outcome).
//
// HONEST: TeamLink does not dial or time a plain tel: call. It logs what you tell it happened.
// items: [{ id, latestApplicationId, name, requirementTitle, clientName, stageLabel }]
// ---------------------------------------------------------------------------

const ymd = (n) => new Date(Date.now() + 330 * 60000 + n * 86400000).toISOString().slice(0, 10);
const OUT_TONE = { Answered: 'green', 'Not answered': 'orange', Busy: 'orange', 'Wrong number': 'red', 'Call back': 'blue', Skipped: 'orange' };

export default function CallQueueSheet({ items, onClose, onDone }) {
  const [q, setQ] = useState(null);
  const [err, setErr] = useState('');
  const [started, setStarted] = useState(false);
  const [i, setI] = useState(0);
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [backOn, setBackOn] = useState(ymd(1));
  const [dialed, setDialed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [flash, setFlash] = useState('');
  const [log, setLog] = useState([]); // { id, name, outcome }
  const [gwBusy, setGwBusy] = useState(false);
  const [gwNote, setGwNote] = useState(null);

  const request = useMemo(() => items.slice(0, REACH_MAX + 1).map((x) => ({ id: x.id, applicationId: x.latestApplicationId || null })), [items]);
  useEffect(() => {
    let on = true;
    const seen = new Set();
    const uniq = request.filter((x) => (seen.has(x.id) ? false : seen.add(x.id)));
    api.post('/messaging/reach/call-queue', { items: uniq })
      .then((r) => { if (on) setQ(r.data); })
      .catch((e) => { if (on) setErr(e.response?.data?.error || 'Could not make the call list.'); });
    return () => { on = false; };
  }, [request]);

  const queue = (q && q.queue) || [];
  const total = queue.length;
  const cur = queue[i] || null;
  const finished = started && i >= total;
  const gw = q && q.call;
  const meta = (id) => items.find((x) => x.id === id) || {};
  const outcomes = (q && q.outcomes) || ['Answered', 'Not answered', 'Busy', 'Wrong number', 'Call back'];

  function nextPerson(entry) {
    setLog((l) => [...l, entry]);
    setOutcome(''); setNote(''); setBackOn(ymd(1)); setDialed(false); setSaveErr(''); setGwNote(null); setFlash('');
    setI((x) => x + 1);
  }
  async function save() {
    if (!cur || !outcome) return;
    setBusy(true); setSaveErr('');
    try {
      await api.post('/messaging/reach/call-log', {
        candidateId: cur.id, applicationId: cur.applicationId, outcome, note, purpose: 'Call list',
      });
      let extra = '';
      if (outcome === 'Call back' && cur.applicationId && backOn) {
        try { await api.post('/followups', { applicationId: cur.applicationId, dueDate: backOn, contactMode: 'Call', notes: note || 'Call back' }); extra = ` Call back set for ${backOn}.`; } catch (e) {
          extra = ` The call back reminder could not be set (${e.response?.data?.error || 'try on the candidate\'s page'}).`;
        }
      }
      setFlash(`Saved.${extra}`);
      nextPerson({ id: cur.id, name: cur.name, outcome, note: extra });
    } catch (e) { setSaveErr(e.response?.data?.error || 'That call could not be saved.'); } finally { setBusy(false); }
  }
  async function viaTeamLink() {
    setGwBusy(true); setGwNote(null);
    try {
      const r = await api.post('/messaging/call', { audience: 'candidates', id: cur.id, applicationId: cur.applicationId || undefined });
      setDialed(true); setGwNote({ ok: true, text: r.data.message + (r.data.sandbox ? ' (Test copy of TeamLink: no real call is made.)' : '') });
    } catch (e) { setGwNote({ ok: false, text: e.response?.data?.error || 'The call could not be started.' }); } finally { setGwBusy(false); }
  }
  const close = () => {
    if (log.length && onDone) onDone();
    onClose();
  };

  if (err) {
    return <Modal title="Call list" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}><div className="msg-box red">{err}</div></Modal>;
  }
  if (!q) {
    return <Modal title="Call list" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Cancel</button>}><div className="small-muted">Checking who can be called…</div></Modal>;
  }

  const skippedPeople = (q.skipped || []).map((s) => ({ ...s, name: s.name || 'A candidate', tone: s.code === 'no_consent' || s.code === 'outside' ? 'red' : 'orange' }));
  const counts = {};
  (q.skipped || []).forEach((s) => { counts[s.code] = (counts[s.code] || 0) + 1; });

  // ---- start screen ----
  if (!started) {
    return (
      <Modal
        title={`Call list — ${q.selected} candidate${q.selected === 1 ? '' : 's'}`}
        onClose={onClose}
        footer={(
          <>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={!total || q.selected > REACH_MAX} onClick={() => setStarted(true)}>{total ? `Start calling ${total}` : 'Nobody to call'}</button>
          </>
        )}
      >
        {q.selected > REACH_MAX && <div className="msg-box red">You ticked {q.selected}. At most {REACH_MAX} at a time: narrow the list, or call in batches.</div>}
        <div className="rch-count">{countLine(q.selected, total, 'can be called', counts)}</div>
        <div className="small-muted" style={{ marginBottom: 8 }}>
          You call one person, say how it went, and the next person comes up. Every call is saved on that candidate&apos;s history.
          {gw && gw.configured ? ' Calls can ring your own phone first through TeamLink.' : ' TeamLink is not connected to a phone line, so calls open the dialler of your own phone or computer; you tell us how each call went.'}
        </div>
        {skippedPeople.length > 0 && (
          <details className="msg-details" open={skippedPeople.length <= 4}>
            <summary>Who is left out, and why</summary>
            <ReachResult people={skippedPeople} />
          </details>
        )}
      </Modal>
    );
  }

  // ---- finished ----
  if (finished) {
    const byOutcome = {};
    log.forEach((x) => { byOutcome[x.outcome] = (byOutcome[x.outcome] || 0) + 1; });
    const saved = log.filter((x) => x.outcome !== 'Skipped').length;
    const people = [
      ...log.map((x) => ({ name: x.name, code: `o_${x.outcome}`, word: x.outcome === 'Skipped' ? 'Skipped by you' : x.outcome, tone: OUT_TONE[x.outcome] || 'blue', reason: x.note ? x.note.trim() : '' })),
      ...skippedPeople,
    ];
    return (
      <Modal wide title="Call list — done" onClose={close} footer={<button type="button" className="btn btn-primary" onClick={close}>Done</button>}>
        <div className="msg-box blue">You selected {q.selected}: {saved} call{saved === 1 ? '' : 's'} saved{q.skipped.length ? `, ${q.skipped.length} could not be called` : ''}. Every call is on the candidate&apos;s history.</div>
        <ReachResult people={people} />
      </Modal>
    );
  }

  // ---- the dialler ----
  const m = meta(cur.id);
  return (
    <Modal
      title={`Call list — ${i + 1} of ${total}`}
      onClose={close}
      footer={(
        <>
          <button type="button" className="btn" onClick={close}>Stop</button>
          <button type="button" className="btn" disabled={busy} onClick={() => nextPerson({ id: cur.id, name: cur.name, outcome: 'Skipped' })}>Skip</button>
          <button type="button" className="btn btn-primary" disabled={busy || !outcome} onClick={save}>
            {busy ? 'Saving…' : (i + 1 < total ? 'Save and next candidate →' : 'Save and finish')}
          </button>
        </>
      )}
    >
      <div className="rch-progress" aria-hidden="true"><span style={{ width: `${Math.round((i / Math.max(total, 1)) * 100)}%` }} /></div>
      {flash && <div className="small-muted rch-flash">{flash}</div>}
      <div className="rch-who">
        <div className="rch-name">{cur.name}</div>
        <div className="small-muted">{[cur.role || m.requirementTitle, m.stageLabel].filter(Boolean).join(' · ') || 'No requirement yet'}</div>
        <div className="rch-number">{cur.phone}</div>
      </div>
      <div className="rch-actions">
        <a className="btn btn-primary rch-callnow" href={telHref(cur.phone)} onClick={() => setDialed(true)}>📞 Call now</a>
        {gw && gw.configured && (
          <button type="button" className="btn" disabled={gwBusy} onClick={viaTeamLink}>{gwBusy ? 'Starting…' : '📞 Call through TeamLink'}</button>
        )}
      </div>
      <div className="small-muted">{gw && gw.configured ? 'Call through TeamLink rings your own phone first.' : 'Opens the dialler on this phone or computer.'} Then come back and say how it went.</div>
      {gwNote && <div className={`msg-box ${gwNote.ok ? 'green' : 'red'}`}>{gwNote.text}</div>}

      <div className="field" style={{ marginTop: 10 }}>
        <label>How did the call go?</label>
        <div className="rch-outcomes">
          {outcomes.map((o) => (
            <button key={o} type="button" className={`rch-out is-${OUT_TONE[o] || 'blue'}${outcome === o ? ' on' : ''}`} aria-pressed={outcome === o} onClick={() => setOutcome(o)}>{o}</button>
          ))}
        </div>
      </div>
      {outcome === 'Call back' && (
        <div className="field"><label htmlFor="rch-back">Call back on</label><input id="rch-back" type="date" min={ymd(0)} value={backOn} onChange={(e) => setBackOn(e.target.value)} /></div>
      )}
      <div className="field"><label htmlFor="rch-note">Note (optional)</label><textarea id="rch-note" className="msg-textarea" rows="2" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was said" /></div>
      {saveErr && <div className="msg-box red">{saveErr}</div>}
    </Modal>
  );
}
