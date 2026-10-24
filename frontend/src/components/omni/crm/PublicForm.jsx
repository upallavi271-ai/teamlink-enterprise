import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../../../api';
import FieldInput from './FieldInput.jsx';
import './crm.css';

// ---------------------------------------------------------------------------
// THE PUBLIC FORM PAGE (/forms-public/:token): no login, outside the TeamLink shell. Shows the fields of one Web Form, the permission words (a required tick) and the
// ways the person may agree to (WhatsApp / SMS need a phone, Email needs an address). Real data: GET / POST /api/public/outreach/forms/:token.
// A hidden "website" box catches robots. The answer is the same for a new and a known person.
// ---------------------------------------------------------------------------
const WAYS = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' };
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;

export default function PublicForm() {
  const { token } = useParams();
  const [form, setForm] = useState(null);
  const [gone, setGone] = useState('');
  const [ans, setAns] = useState({});
  const [off, setOff] = useState([]); // ways the person unticked
  const [consent, setConsent] = useState(false);
  const [trap, setTrap] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');
  useEffect(() => { document.title = 'Form'; api.get(`/public/outreach/forms/${encodeURIComponent(token)}`).then((r) => { setForm(r.data.form); document.title = r.data.form.title; }).catch((e) => setGone(errOf(e, 'This form is not available.'))); }, [token]);
  const hasPhone = useMemo(() => String(ans.phone || '').replace(/\D/g, '').length >= 8, [ans.phone]);
  const hasMail = useMemo(() => /\S+@\S+\.\S+/.test(String(ans.email || '')), [ans.email]);
  const reachable = form ? form.channels.map((c) => c.id).filter((c) => (c === 'email' ? hasMail : hasPhone)) : [];
  const chosen = reachable.filter((c) => !off.includes(c));
  const setA = (k) => (v) => setAns((a) => ({ ...a, [k]: v }));
  const submit = async (e) => {
    e.preventDefault(); setErr('');
    if (!consent) { setErr('Please tick the box to say we may contact you.'); return; }
    setBusy(true);
    try { const r = await api.post(`/public/outreach/forms/${encodeURIComponent(token)}`, { answers: ans, channels: chosen, consent: true, website: trap }); setDone(r.data.message || 'Thank you.'); } catch (x) { setErr(errOf(x, 'It could not be sent. Please try again.')); } finally { setBusy(false); }
  };
  if (gone) return <div className="tlpf"><div className="tlpf-card"><h1>This form is not available</h1><p>{gone}</p></div></div>;
  if (!form) return <div className="tlpf"><div className="tlpf-card"><p>Loading…</p></div></div>;
  if (done) return <div className="tlpf"><div className="tlpf-card"><h1>{form.title}</h1><div className="tlpf-ok" role="status">{done}</div></div></div>;
  return (
    <div className="tlpf">
      <form className="tlpf-card" onSubmit={submit} noValidate>
        <h1>{form.title}</h1>
        {form.description && <p className="tlpf-lead">{form.description}</p>}
        {form.fields.map((f) => (
          <div className="tlpf-field" key={f.key}>
            <label htmlFor={`pf_${f.key}`}>{f.label}{f.required ? ' (needed)' : ''}</label>
            {f.key === 'phone' ? <input id="pf_phone" inputMode="tel" autoComplete="tel" placeholder="+91…" maxLength={25} value={ans.phone || ''} onChange={(e) => setA('phone')(e.target.value)} />
              : f.key === 'email' ? <input id="pf_email" type="email" autoComplete="email" maxLength={160} value={ans.email || ''} onChange={(e) => setA('email')(e.target.value)} />
                : f.key === 'notes' ? <textarea id="pf_notes" maxLength={1000} value={ans.notes || ''} onChange={(e) => setA('notes')(e.target.value)} />
                  : f.key === 'preferredChannel' ? <FieldInput id="pf_preferredChannel" field={{ type: 'dropdown', options: f.options }} value={ans.preferredChannel || ''} onChange={setA('preferredChannel')} />
                    : f.key.startsWith('cf:') ? <FieldInput id={`pf_${f.key}`} field={{ type: f.type, options: f.options }} value={ans[f.key]} onChange={setA(f.key)} />
                      : <input id={`pf_${f.key}`} maxLength={f.key === 'name' ? 120 : 200} autoComplete={f.key === 'name' ? 'name' : 'off'} value={ans[f.key] || ''} onChange={(e) => setA(f.key)(e.target.value)} />}
            {f.hint && <small>{f.hint}</small>}
          </div>
        ))}
        <div style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, overflow: 'hidden' }} aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} /></label></div>
        <div className="tlpf-consent">
          <label className="tlpf-tick"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> <span>{form.consentText}</span></label>
          <div className="tlpf-ways">
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>You agree to be contacted on:</div>
            {reachable.length ? form.channels.filter((c) => reachable.includes(c.id)).map((c) => (
              <label key={c.id} className="tlpf-way"><input type="checkbox" checked={!off.includes(c.id)} onChange={(e) => setOff(e.target.checked ? off.filter((x) => x !== c.id) : [...off, c.id])} /> {WAYS[c.id] || c.label}</label>
            )) : <small>Type your {form.channels.some((c) => c.id === 'email') ? 'phone number or email' : 'phone number'} above, then choose the ways here.</small>}
          </div>
        </div>
        {err && <div className="tlpf-err" role="alert">{err}</div>}
        <button type="submit" className="tlpf-btn" disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>
        <p className="tlpf-foot">You can say STOP to any message and we will stop.</p>
      </form>
    </div>
  );
}
