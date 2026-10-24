// REQUEST A NEW JOB (per-role spec 2026-10-03).
//
// A BDE no longer creates a job and a client asks for new hiring from the
// portal; both send a REQUEST that TeamLink (a Manager / Admin) reviews and
// opens. The server saves it as a Draft requirement (utils/requirementRequest.js)
// — nothing here goes live by itself.
//
//   endpoint  POST /requirements/requests             (BDE — their own clients)
//             POST /portal/client/requirement-requests (client — own company)
//   clients   the picker list for a BDE; omitted for a client (own company).
import { useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import DuplicateJobWarning from './DuplicateJobWarning.jsx'; // "This looks like a job you already have" (2026-10-13)
// 2026-10-14: a normal single-column form like Add job (the side preview is gone).
import ReqSection from './reqsplit/ReqSection.jsx';
import LocationPicker from './LocationPicker.jsx';
import { useJobLocations } from './jobLocations.js';
import '../clients/clientForm.css';
import '../clients/addClientModal.css';
import './reqsplit/reqsplit.css';
import Combo from '../Combo.jsx';
import useClientLabel from '../clients/useClientLabel.js'; // one company, many locations: "Name - Location" for same-name clients (2026-10-22)

// ONLY THE MAIN FIELDS (user, 2026-10-09): what the client knows. TeamLink's BDE
// fills in the rest (description, qualification, notice period, posting sites...).
const EMPTY = { title: '', clientId: '', openings: 1, location: '', skills: '', experience: '', salaryMonthlyMin: '', salaryMonthlyMax: '', joinBy: '30', notes: '' };
const JOIN_BY = [['asap', 'As soon as possible'], ['15', 'Within 15 days'], ['30', 'Within a month'], ['later', 'No hurry']];

export default function RequestJobModal({
  endpoint, clients = null, presetClientId = '', presetTitle = '', onClose, onSent,
}) {
  const clientLabel = useClientLabel();
  // presetClientId / presetTitle: a link from "+ New job" on a client, or from a team lead's "Ask the client manager to add a job" bell.
  const [form, setForm] = useState({
    ...EMPTY,
    title: presetTitle || '',
    clientId: clients && presetClientId && clients.some((c) => c.id === presetClientId) ? presetClientId : (clients && clients.length === 1 ? clients[0].id : ''),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dup, setDup] = useState(null); // the server's 409 DUPLICATE_JOB answer
  // After Send: a plain "Sent to <BDE>. We'll confirm soon." screen (user, 2026-10-09).
  const [done, setDone] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const [open, setOpen] = useState({ need: true, more: true });
  const places = useJobLocations(); // the shared list of places (staff form)
  const toggle = (id) => setOpen((o) => ({ ...o, [id]: !o[id] }));
  async function send(extraIn = {}) {
    // only a plain object of extra fields is ever added to the request: a click handler that passes its event here must not put the event (a DOM
    // node and a circular structure) into the body, which could not be turned into JSON, so nothing was sent and the form said "Could not send".
    const extra = extraIn && Object.getPrototypeOf(extraIn) === Object.prototype ? extraIn : {};
    if (!form.title.trim()) { setError('Please add the requirement title.'); return; }
    if (clients && !form.clientId) { setError('Please pick the client this requirement is for.'); return; }
    setBusy(true);
    setError('');
    try {
      const body = { ...form, openings: Number(form.openings) || 1, ...extra };
      if (!clients) delete body.clientId;
      const res = await api.post(endpoint, body);
      setDone(res.data);
    } catch (err) {
      if (err.response?.status === 409 && err.response.data?.code === 'DUPLICATE_JOB') { setDup(err.response.data); setBusy(false); return; }
      // No answer at all (the server was restarting or busy) is told apart from a refusal, so the sender knows to simply try again.
      const noAnswer = !err.response || (err.response.status >= 500 && !err.response.data);
      setError(err.response?.data?.error || (noAnswer ? 'The server did not answer just now. Nothing was sent. Please press Send request again in a moment.' : 'Could not send. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const finish = () => onSent?.(done);
    return (
      <Modal
        title="Request sent"
        onClose={finish}
        footer={<button type="button" className="btn btn-primary" onClick={finish}>Done</button>}
      >
        <div className="notice green" role="status" style={{ fontSize: 15 }}><b>{done.message || 'Request sent. We will confirm soon.'}</b></div>
        {clients ? (
          <ol style={{ margin: '12px 0 0', paddingLeft: 20, lineHeight: 1.7 }}>
            <li>Request <b>{done.reqCode}</b> is saved in Requirements. A lead opens it.</li>
            <li>The client&apos;s BDE and the BDE TL are told on screen.</li>
            <li>Open it from Requirements, fill in the rest and press <b>Save &amp; Post</b>.</li>
          </ol>
        ) : (
        <ol style={{ margin: '12px 0 0', paddingLeft: 20, lineHeight: 1.7 }}>
          <li>Your request <b>{done.reqCode}</b> is saved as <b>Waiting for confirmation</b>.</li>
          <li>{done.sentTo ? `${done.sentTo.name} (${done.sentTo.position || 'your TeamLink contact'}) checks it.` : 'TeamLink checks it.'}</li>
          <li>Then the requirement opens and we start finding people. You can follow it under <b>My Requirements</b>.</li>
        </ol>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      title="Ask for a new requirement"
      size={clients ? 'xwide acw-modal' : undefined}
      onClose={onClose}
      footer={(
        <div className="cf-bar">
          <span className="cf-bar-note">Your TeamLink contact checks the request, then opens the requirement.</span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => send()} disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button>
        </div>
      )}
    >
      {error && <div className="notice red">{error}</div>}
      {dup && dup.matches && <DuplicateJobWarning dup={dup} onCancel={() => setDup(null)} onCreateAnyway={(reason) => { setDup(null); send({ duplicateOverride: true, duplicateReason: reason }); }} />}
      {dup && !dup.matches && (
        <div className="notice amber" role="alert">
          <div>{dup.error}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-sm" onClick={() => setDup(null)}>Cancel</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => { setDup(null); send({ duplicateOverride: true, duplicateReason: 'The client confirmed it is a different requirement' }); }}>It is a different requirement: send it</button>
          </div>
        </div>
      )}
      {clients ? (
        <div className="acw-wrap rf-wrap rf-one">
          <div className="acw-form">
            <div className="cf">
              <ReqSection id="need" n={1} title="What You Need" hint="" filled={[form.title, form.clientId, form.openings, form.location, form.experience].filter((v) => String(v || '').trim()).length} total={5} done={!!form.title.trim() && !!form.clientId} open={open.need} onToggle={toggle}>
      <label className="field">
        <span>Requirement title</span>
        <input className="input" value={form.title} onChange={set('title')} placeholder="e.g. Staff Nurse" />
      </label>
      {clients && (
        <label className="field">
          <span>Client</span>
          <Combo className="input" value={form.clientId} onChange={set('clientId')}>
            <option value="">— Select —</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{clientLabel(c)}</option>)}
          </Combo>
        </label>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        <label className="field">
          <span>Openings</span>
          <input className="input" type="number" min="1" value={form.openings} onChange={set('openings')} />
        </label>
        <div className="field">
          <span>Location</span>
          <LocationPicker single places={places} value={form.location} onChange={(v) => setForm((f) => ({ ...f, location: v }))} />
        </div>
        <label className="field">
          <span>Experience (years)</span>
          <input className="input" value={form.experience} onChange={set('experience')} placeholder="e.g. 2-5" />
        </label>
      </div>
              </ReqSection>
              <ReqSection id="more" n={2} title="Pay, Skills and Timing" hint="" filled={[form.salaryMonthlyMin || form.salaryMonthlyMax, form.skills, form.joinBy, form.notes].filter((v) => String(v || '').trim()).length} total={4} open={open.more} onToggle={toggle}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        <label className="field">
          <span>Salary from (₹ per month)</span>
          <input className="input" type="number" min="0" value={form.salaryMonthlyMin} onChange={set('salaryMonthlyMin')} placeholder="e.g. 15000" />
        </label>
        <label className="field">
          <span>Salary up to (₹ per month)</span>
          <input className="input" type="number" min="0" value={form.salaryMonthlyMax} onChange={set('salaryMonthlyMax')} placeholder="e.g. 25000" />
        </label>
      </div>
      <label className="field">
        <span>Key skills</span>
        <input className="input" value={form.skills} onChange={set('skills')} placeholder="e.g. ICU, BLS" />
      </label>
      <div className="field">
        <span>When do you need them to join?</span>
        <div role="radiogroup" aria-label="When do you need them to join?" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {JOIN_BY.map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={form.joinBy === v}
              className={`btn btn-sm${form.joinBy === v ? ' btn-primary' : ''}`}
              onClick={() => setForm((f) => ({ ...f, joinBy: v }))}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>Anything else we should know</span>
        <textarea className="input" rows={3} value={form.notes} onChange={set('notes')} />
      </label>
              </ReqSection>
            </div>
          </div>
        </div>
      ) : (
        <>
      <label className="field">
        <span>Requirement title</span>
        <input className="input" value={form.title} onChange={set('title')} placeholder="e.g. Staff Nurse" />
      </label>
      {clients && (
        <label className="field">
          <span>Client</span>
          <Combo className="input" value={form.clientId} onChange={set('clientId')}>
            <option value="">— Select —</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{clientLabel(c)}</option>)}
          </Combo>
        </label>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        <label className="field">
          <span>Openings</span>
          <input className="input" type="number" min="1" value={form.openings} onChange={set('openings')} />
        </label>
        <label className="field">
          <span>Location</span>
          <input className="input" value={form.location} onChange={set('location')} />
        </label>
        <label className="field">
          <span>Experience (years)</span>
          <input className="input" value={form.experience} onChange={set('experience')} placeholder="e.g. 2-5" />
        </label>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        <label className="field">
          <span>Salary from (₹ per month)</span>
          <input className="input" type="number" min="0" value={form.salaryMonthlyMin} onChange={set('salaryMonthlyMin')} placeholder="e.g. 15000" />
        </label>
        <label className="field">
          <span>Salary up to (₹ per month)</span>
          <input className="input" type="number" min="0" value={form.salaryMonthlyMax} onChange={set('salaryMonthlyMax')} placeholder="e.g. 25000" />
        </label>
      </div>
      <label className="field">
        <span>Key skills</span>
        <input className="input" value={form.skills} onChange={set('skills')} placeholder="e.g. ICU, BLS" />
      </label>
      <div className="field">
        <span>When do you need them to join?</span>
        <div role="radiogroup" aria-label="When do you need them to join?" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {JOIN_BY.map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={form.joinBy === v}
              className={`btn btn-sm${form.joinBy === v ? ' btn-primary' : ''}`}
              onClick={() => setForm((f) => ({ ...f, joinBy: v }))}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>Anything else we should know</span>
        <textarea className="input" rows={3} value={form.notes} onChange={set('notes')} />
      </label>
        </>
      )}
    </Modal>
  );
}
