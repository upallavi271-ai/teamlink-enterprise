import { useCallback, useRef, useState } from 'react';
import api from '../../api';
import { agreementStatusLabel } from '../../atsVocab';
import { useAuth } from '../../context/AuthContext.jsx';
import { chipText, cardFacts, gateConfirm } from '../../utils/clientLocation.js';
import './clients.css';

// ---------------------------------------------------------------------------
// "THIS CLIENT ALREADY EXISTS - DO YOU STILL WANT TO ADD ANOTHER ONE?" (2026-10-22, one company, many locations).
//
// The same company can be a client at several places (Palnadu Hospital at Narasaraopet and at Guntur), each with its own
// agreement and renewal. So a client whose name exists already is a QUESTION, never an error:
//
//   const dup = useClientDuplicateCheck({ excludeId });
//   <input onBlur={() => dup.check(form)} />
//   <ClientDuplicateWarning dup={dup} form={form} onNeed={(gate) => ...} onYes={() => ...} onOpenExisting={(m) => ...} />
//   before save:  const r = await dup.check(form); if (r.question && !r.acked) -> show the question, stop;
//   save body:    { ...form, ...dup.overrideBody() }      (confirmSeparate + the older allowDuplicate + the one-line reason)
//
// The server (POST /clients/check-duplicate, the same code the save runs) does the matching and builds the question: the
// matching clients with name / location / agreement / requirements and WHY they matched. Only same name, same GST / PAN
// ask anything; a similar phone or a near spelling is a quiet note and never stops the save. Nothing is ever merged here.
// ---------------------------------------------------------------------------
export const DUP_FIELDS = [
  'name', 'legalName', 'gst', 'pan', 'contactPhone', 'contactEmail', 'contactWhatsApp',
  'secondaryContactPhone', 'secondaryContactEmail', 'billingContactPhone', 'billingContactEmail',
  'recruitmentContactPhone', 'recruitmentContactEmail', 'landline', 'houseNumber', 'street', 'area', 'pincode',
  'location', 'state',
];
// the place only decides "same location?" - it never makes a match by itself
const PLACE_ONLY = new Set(['location', 'state']);
const norm = (v) => String(v ?? '').trim();
const idsKey = (matches) => (matches || []).map((m) => m.id).sort().join(',');
const EMPTY = { matches: [], total: 0, blocking: false, question: null };

export function useClientDuplicateCheck({ excludeId = null } = {}) {
  const [state, setState] = useState({ ...EMPTY, checking: false });
  const [ackKey, setAckKeyState] = useState('');
  const [note, setNoteState] = useState('');
  const ackRef = useRef('');
  const noteRef = useRef('');
  const lastKey = useRef('');
  const lastResult = useRef(null);
  const seq = useRef(0);

  const setAckKey = (k) => { ackRef.current = k; setAckKeyState(k); };
  const setNote = (v) => { noteRef.current = v; setNoteState(v); };
  const askKeyOf = (d) => (d && d.question ? idsKey(d.question.matches) : '');

  // `original` (edit): only the identity values that CHANGED are checked.
  const check = useCallback(async (form, original = null) => {
    const probe = {};
    DUP_FIELDS.forEach((k) => {
      const v = norm(form[k]);
      if (!v) return;
      if (original && norm(original[k]) === v) return;
      probe[k] = v;
    });
    const key = JSON.stringify(probe);
    // acked = nothing is asked, or the person already said yes to exactly this question
    const finish = (data) => ({ ...data, acked: !data.question || ackRef.current === askKeyOf(data) });
    if (!Object.keys(probe).some((k) => !PLACE_ONLY.has(k))) {
      lastKey.current = key;
      lastResult.current = { ...EMPTY };
      setState({ ...EMPTY, checking: false });
      return finish(lastResult.current);
    }
    if (key === lastKey.current && lastResult.current) return finish(lastResult.current);
    const my = ++seq.current;
    setState((s) => ({ ...s, checking: true }));
    try {
      const res = await api.post('/clients/check-duplicate', { ...probe, excludeId });
      const data = { matches: res.data.matches || [], total: res.data.total || 0, blocking: !!res.data.blocking, question: res.data.question || null };
      if (my === seq.current) {
        lastKey.current = key;
        lastResult.current = data;
        setState({ ...data, checking: false });
      }
      return finish(data);
    } catch {
      if (my === seq.current) setState((s) => ({ ...s, checking: false }));
      // The server asks the same question on save regardless.
      return finish({ ...EMPTY });
    }
  }, [excludeId]);

  // A 409 from POST / PUT carries the question (and the older matches list): show it the same way.
  const fromServer = (body) => {
    const data = { matches: body?.duplicates || body?.question?.matches || [], total: (body?.duplicates || []).length, blocking: !!body?.blocking, question: body?.question || null };
    lastResult.current = data;
    setState({ ...data, checking: false });
  };
  const reset = () => {
    lastKey.current = '';
    lastResult.current = null;
    setAckKey('');
    setNote('');
    setState({ ...EMPTY, checking: false });
  };
  const acked = !!state.question && ackKey === askKeyOf(state);
  return {
    ...state,
    acked,
    note,
    setNote,
    confirmAnyway: () => setAckKey(askKeyOf(state)),
    undoAnyway: () => setAckKey(''),
    check,
    fromServer,
    reset,
    // the confirmed save: the new flag, the older flag the server still reads, and the one-line reason
    overrideBody: () => (ackRef.current && lastResult.current && ackRef.current === askKeyOf(lastResult.current)
      ? { confirmSeparate: true, allowDuplicate: true, separateReason: noteRef.current, duplicateNote: noteRef.current }
      : {}),
  };
}

// Admin / Super Admin may also compare and merge two clients (Clients > Duplicate clients). Nothing merges by itself.
const MERGE_ADMIN = ['SUPER_ADMIN', 'ADMIN'];
export const mayMergeClients = (user) => !!user && (MERGE_ADMIN.includes(user.role) || MERGE_ADMIN.includes(user.atsRole));
export const mergeReviewLink = (focusId, withId) => `/clients/duplicates?focus=${encodeURIComponent(focusId)}${withId ? `&with=${encodeURIComponent(withId)}` : ''}`;

// The friendly box. `form` = the Add / Edit form (the Location typed so far); onNeed(gate) = something is still missing before the
// "yes" can count (the form shows it on the Location box); onYes() runs after a valid "yes" (the form saves again);
// onOpenExisting(match) = "No, open the existing client".
export function ClientDuplicateWarning({ dup, form = {}, onNeed, onYes, onOpenExisting, mergeWith = null }) {
  const { user } = useAuth();
  const canMerge = mayMergeClients(user);
  const q = dup.question;
  if (dup.checking && !dup.matches.length) return <div className="cldup-checking">Checking for existing clients…</div>;
  if (!q) {
    // Similar, but not the same: one quiet line. It never stops a save.
    const soft = dup.matches.filter((m) => m.strength !== 'exact').slice(0, 3);
    if (!soft.length) return null;
    return (
      <div className="csn csn-soft" role="note">
        <span>
          {'Looks a little like '}
          {soft.map((m, i) => (
            <span key={m.id}>
              {i > 0 && ', '}
              <a href={`/clients/${m.id}`} target="_blank" rel="noopener noreferrer">{m.name}{m.place ? ` (${m.place})` : ''}</a>
            </span>
          ))}
          {'. If it is a different client, just carry on.'}
        </span>
      </div>
    );
  }
  const likely = q.level === 'likelySame';
  const yes = () => {
    const gate = gateConfirm(q, { location: form.location, reason: dup.note });
    if (!gate.ok) { onNeed?.(gate); return; }
    dup.confirmAnyway();
    onYes?.();
  };
  const noWords = q.noLabel || 'No, open the existing client';
  return (
    <div className={`csn${likely ? ' csn-likely' : ''}`} id="csn-box" role="status">
      <div className="csn-head"><span className="csn-ico" aria-hidden="true">i</span>{q.title}</div>
      <p className="csn-text">{q.text}</p>
      <ul className="csn-list">
        {q.matches.map((m) => (
          <li key={m.id} className="csn-card">
            <div className="csn-card-top">
              <b className="csn-name">{m.name}</b>
              <span className="csn-loc">{m.location || 'No location written yet'}</span>
              <span className="clrel-code">{m.displayCode}</span>
            </div>
            <div className="csn-facts">{cardFacts(m, agreementStatusLabel).slice(1).join(' · ')}</div>
            <div className="csn-chips">
              {(m.reasons || []).map((r) => <span key={r.code} className="csn-chip">{chipText(r)}</span>)}
            </div>
            <div className="csn-open">
              <a className="btn btn-sm" href={`/clients/${m.id}`} target="_blank" rel="noopener noreferrer">Open ↗</a>
              {canMerge && (
                <a className="btn btn-sm btn-ghost" href={mergeReviewLink(m.id, mergeWith)} target="_blank" rel="noopener noreferrer" title="Admin only: compare and merge on Duplicate clients. Nothing merges by itself.">Merge review ↗</a>
              )}
            </div>
          </li>
        ))}
      </ul>
      {!dup.acked ? (
        <>
          {likely && (
            <label className="csn-reason">
              {q.reasonLabel || 'In one line: why is this a different client?'}
              <input
                value={dup.note}
                maxLength={200}
                onChange={(e) => dup.setNote(e.target.value)}
                placeholder="e.g. second hospital building, own MD and own agreement"
              />
            </label>
          )}
          <div className="csn-actions">
            <button type="button" className="btn btn-primary" onClick={yes}>{q.yesLabel}</button>
            <button type="button" className="btn" onClick={() => onOpenExisting?.(q.matches[0])}>{noWords}</button>
          </div>
        </>
      ) : (
        <div className="csn-ack">
          <span className="csn-ok">{likely ? 'OK. This will be added as a separate client.' : 'OK. This will be added as another location.'}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={dup.undoAnyway}>Undo</button>
        </div>
      )}
    </div>
  );
}
