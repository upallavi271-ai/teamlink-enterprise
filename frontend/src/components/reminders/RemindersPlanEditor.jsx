import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import { istDate, istTime, fromIst, quickTime, when } from './remUtil.js';
import './reminders.css';

// ---------------------------------------------------------------------------
// "Reminders to the candidate" - in the interview booking window and the joining panel (founder 2026-11-20).
// The default steps are pre-ticked (2 days before 10:00, 1 day before 17:00, 2 hours before / the joining morning); each has a date and time
// (quick choices), the way it goes (only the ways that are connected, allowed and reach this candidate), the language and the words (preview).
// Saving the booking saves this plan: the parent sends the `onChange` value as `reminders: { steps }`.
// (backend: POST /api/ats/reminders/suggest + /preview, utils/scheduledReminders.js)
// ---------------------------------------------------------------------------
export default function RemindersPlanEditor({
  applicationId, kind, eventAt, mode, details, onChange, title = 'Reminders to the candidate',
}) {
  const [data, setData] = useState(null);
  const [steps, setSteps] = useState([]);
  const [open, setOpen] = useState({});
  const [err, setErr] = useState('');
  const seq = useRef(0);
  const evKey = `${applicationId}|${kind}|${eventAt || ''}|${mode || ''}`;

  useEffect(() => {
    if (!applicationId || !eventAt) { setData(null); setSteps([]); return undefined; }
    let live = true;
    const t = setTimeout(() => {
      api.post('/ats/reminders/suggest', {
        applicationId, kind, eventAt, mode, details,
      }).then((r) => {
        if (!live) return;
        setData(r.data); setErr('');
        setSteps((r.data.steps || []).map((s, i) => ({ ...s, key: `s${seq.current++}-${i}` })));
      }).catch((e) => { if (live) { setData(null); setSteps([]); setErr(e.response?.data?.error || ''); } });
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [evKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (onChange) {
      onChange({
        steps: steps.map(({
          stepKey, sendAt, channel, language, checked,
        }) => ({
          stepKey, sendAt, channel, language, checked,
        })),
        ready: !!data,
      });
    }
  }, [steps, !!data]); // eslint-disable-line react-hooks/exhaustive-deps

  // the words follow the details typed above (venue, address ...), refreshed a moment after typing stops
  const detailsKey = JSON.stringify(details || {});
  useEffect(() => {
    if (!data || !data.canSeeText || !steps.length) return undefined;
    let live = true;
    const t = setTimeout(() => {
      steps.forEach((s) => {
        api.post('/ats/reminders/preview', {
          applicationId, kind, eventAt, mode, details, sendAt: s.sendAt, language: s.language, stepKey: s.stepKey,
        })
          .then((r) => { if (live && r.data.text !== undefined) setSteps((cur) => cur.map((x) => (x.key === s.key ? { ...x, text: r.data.text, missing: r.data.missing || x.missing } : x))); })
          .catch(() => {});
      });
    }, 600);
    return () => { live = false; clearTimeout(t); };
  }, [detailsKey, !!data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!applicationId) return null;
  const head = <div className="rem-head"><b>{title}</b></div>;
  if (!eventAt) return (<div className="rem-box">{head}<div className="ivx-hint" style={{ margin: 0 }}>Pick the date and time first: the messages are planned around them.</div></div>);
  if (!data) {
    return err
      ? (<div className="rem-box">{head}<div className="rem-warn">{err}</div></div>)
      : (<div className="rem-box">{head}<div className="ivx-hint" style={{ margin: 0 }}>Planning the messages…</div></div>);
  }

  const patch = (key, p) => setSteps((cur) => cur.map((s) => (s.key === key ? { ...s, ...p } : s)));
  const refresh = (s, p) => {
    if (!data.canSeeText) return;
    api.post('/ats/reminders/preview', {
      applicationId, kind, eventAt, mode, details, sendAt: p.sendAt || s.sendAt, language: p.language || s.language, stepKey: s.stepKey,
    }).then((r) => { if (r.data.text !== undefined) patch(s.key, { text: r.data.text, missing: r.data.missing || [] }); }).catch(() => {});
  };
  const edit = (s, p) => { patch(s.key, p); if (p.sendAt || p.language) refresh(s, p); };
  const setDateTime = (s, date, time) => {
    const iso = fromIst(date, time);
    if (iso) edit(s, { sendAt: iso, stepKey: s.stepKey === 'NOW' ? s.stepKey : `X${new Date(iso).getTime()}` });
  };
  const offered = (data.channels || []).filter((c) => c.offered);
  const addOne = () => {
    if (steps.length >= data.max) return;
    const sendAt = quickTime('D1', eventAt);
    const base = steps[0] || {};
    const s = {
      key: `s${seq.current++}-n`, stepKey: `X${new Date(sendAt).getTime()}`, sendAt, label: 'Extra message', channel: base.channel || (offered[0] && offered[0].channel) || 'WhatsApp', language: base.language || data.language, checked: true, text: null, missing: [],
    };
    setSteps((cur) => [...cur, s]);
    refresh(s, {});
  };
  const ticked = steps.filter((s) => s.checked).length;
  const evWord = kind === 'joining' ? 'joining' : 'interview';
  return (
    <div className="rem-box" aria-label={title}>
      <div className="rem-head">
        <b>{title}</b>
        <span className="small-muted">{ticked === 0 ? 'None will be sent' : `${ticked} message${ticked === 1 ? '' : 's'} planned`}</span>
        {!data.switchOn && <span className="rem-warn">Reminders are switched off for now: the plan is saved and shown, nothing is sent until an Admin turns them on.</span>}
      </div>
      {!data.canEdit && <div className="rem-warn">You can see this plan. The recruiter or the team lead can change it.</div>}
      {steps.length === 0 && <div className="ivx-hint" style={{ margin: 0 }}>{`The ${evWord} is too soon for any of the usual steps. Add a message below, or the candidate gets only the booking message.`}</div>}
      {steps.map((s) => {
        const late = new Date(s.sendAt).getTime() >= new Date(eventAt).getTime();
        const chOk = offered.some((c) => c.channel === s.channel);
        return (
          <div className="rem-step" key={s.key}>
            <input type="checkbox" checked={!!s.checked} disabled={!data.canEdit} aria-label={`Send: ${s.label}`} onChange={(e) => patch(s.key, { checked: e.target.checked })} />
            <div>
              <div className="rem-step-main">
                <b style={{ minWidth: 118 }}>{s.stepKey === 'NOW' ? 'At once (details)' : s.label}</b>
                <input type="date" aria-label="Date" value={istDate(s.sendAt)} disabled={!data.canEdit || !s.checked || s.stepKey === 'NOW'} onChange={(e) => setDateTime(s, e.target.value, istTime(s.sendAt))} />
                <input type="time" aria-label="Time" value={istTime(s.sendAt)} disabled={!data.canEdit || !s.checked || s.stepKey === 'NOW'} onChange={(e) => setDateTime(s, istDate(s.sendAt), e.target.value)} />
                <select aria-label="Way" value={s.channel} disabled={!data.canEdit || !s.checked} onChange={(e) => patch(s.key, { channel: e.target.value })}>
                  {(data.channels || []).map((c) => <option key={c.channel} value={c.channel} disabled={!c.offered}>{c.offered ? c.channel : `${c.channel} (${c.reason || 'not available'})`}</option>)}
                </select>
                <select aria-label="Language" value={s.language} disabled={!data.canEdit || !s.checked} onChange={(e) => edit(s, { language: e.target.value })}>
                  {(data.languages || []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                {data.canSeeText && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen((o) => ({ ...o, [s.key]: !o[s.key] }))}>{open[s.key] ? 'Hide words' : 'See the words'}</button>}
              </div>
              {data.canEdit && s.checked && s.stepKey !== 'NOW' && (
                <div className="rem-quick" style={{ marginTop: 4 }}>
                  <span className="small-muted" style={{ fontSize: 11 }}>Quick:</span>
                  {[['D2', '2 days before'], ['D1', '1 day before'], ['H2', '2 hours before']].map(([k, l]) => (
                    <button key={k} type="button" className="btn btn-sm btn-ghost" onClick={() => { const iso = quickTime(k, eventAt); edit(s, { sendAt: iso, stepKey: `X${new Date(iso).getTime()}` }); }}>{l}</button>
                  ))}
                </div>
              )}
              {late && <div className="rem-bad">{`This is after the ${evWord}: pick an earlier time.`}</div>}
              {s.checked && !chOk && <div className="rem-warn">{`${s.channel} cannot be used for this candidate right now: pick another way.`}</div>}
              {s.checked && (s.missing || []).length > 0 && <div className="rem-warn">{`Missing for this message: ${s.missing.join(', ')}. Fill it in above (needed for the reminders).`}</div>}
              <div className="small-muted" style={{ fontSize: 11 }}>{`Goes ${when(s.sendAt)} India time`}</div>
              {open[s.key] && data.canSeeText && <div className="rem-text">{s.text || 'Loading…'}</div>}
            </div>
          </div>
        );
      })}
      {data.canEdit && (
        <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm" disabled={steps.length >= data.max} onClick={addOne}>+ Add a message</button>
          <span className="small-muted" style={{ fontSize: 11 }}>{`Up to ${data.max}. Messages go between ${String(data.earliestHour).padStart(2, '0')}:00 and ${String(data.latestHour).padStart(2, '0')}:00 India time. Later you can change them from the candidate's page.`}</span>
        </div>
      )}
      {!data.canSeeText && <div className="small-muted" style={{ fontSize: 11, marginTop: 4 }}>The words of the messages are shown to the recruiter and the team lead.</div>}
    </div>
  );
}
