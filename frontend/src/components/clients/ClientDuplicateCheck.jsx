import { useCallback, useRef, useState } from 'react';
import api from '../../api';
import { agreementStatusLabel } from '../../atsVocab';
import { useAuth } from '../../context/AuthContext.jsx';
import './clients.css';

// ---------------------------------------------------------------------------
// §8 — "Possible duplicate found … [View Existing] [Create Anyway]".
//
//   const dup = useClientDuplicateCheck({ excludeId });
//   <input onBlur={() => dup.check(form)} />
//   <ClientDuplicateWarning dup={dup} anywayLabel="Create Anyway" />
//   before save:  const r = await dup.check(form); if (r.matches.length && !r.acked) stop;
//   save body:    { ...form, ...dup.overrideBody() }
//
// The server (POST /clients/check-duplicate) does the matching — GSTIN, PAN,
// normalised name incl. every merged-away spelling, phone, email, address — so
// the rule lives in one place. "Create Anyway" is an explicit click, and the
// server audit-logs it with the note typed here.
// ---------------------------------------------------------------------------
export const DUP_FIELDS = [
  'name', 'legalName', 'gst', 'pan', 'contactPhone', 'contactEmail', 'contactWhatsApp',
  'secondaryContactPhone', 'secondaryContactEmail', 'billingContactPhone', 'billingContactEmail',
  'recruitmentContactPhone', 'recruitmentContactEmail', 'landline', 'houseNumber', 'street', 'area', 'pincode',
];
const norm = (v) => String(v ?? '').trim();
const idsKey = (matches) => (matches || []).map((m) => m.id).sort().join(',');

export function useClientDuplicateCheck({ excludeId = null } = {}) {
  const [state, setState] = useState({ matches: [], total: 0, blocking: false, checking: false });
  const [ackKey, setAckKeyState] = useState('');
  const [note, setNoteState] = useState('');
  const ackRef = useRef('');
  const noteRef = useRef('');
  const lastKey = useRef('');
  const lastResult = useRef(null);
  const seq = useRef(0);

  const setAckKey = (k) => { ackRef.current = k; setAckKeyState(k); };
  const setNote = (v) => { noteRef.current = v; setNoteState(v); };

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
    const finish = (data) => ({ ...data, acked: !data.matches.length || ackRef.current === idsKey(data.matches) });
    if (!Object.keys(probe).length) {
      lastKey.current = key;
      lastResult.current = { matches: [], total: 0, blocking: false };
      setState({ matches: [], total: 0, blocking: false, checking: false });
      return finish(lastResult.current);
    }
    if (key === lastKey.current && lastResult.current) return finish(lastResult.current);
    const my = ++seq.current;
    setState((s) => ({ ...s, checking: true }));
    try {
      const res = await api.post('/clients/check-duplicate', { ...probe, excludeId });
      const data = { matches: res.data.matches || [], total: res.data.total || 0, blocking: !!res.data.blocking };
      if (my === seq.current) {
        lastKey.current = key;
        lastResult.current = data;
        setState({ ...data, checking: false });
      }
      return finish(data);
    } catch {
      if (my === seq.current) setState((s) => ({ ...s, checking: false }));
      // The server re-checks GSTIN / PAN / name on save regardless.
      return finish({ matches: [], total: 0, blocking: false });
    }
  }, [excludeId]);

  // A 409 from POST / PUT carries the matches: show them the same way.
  const fromServer = (body) => {
    const data = { matches: body?.duplicates || [], total: (body?.duplicates || []).length, blocking: !!body?.blocking };
    lastResult.current = data;
    setState({ ...data, checking: false });
  };
  const reset = () => {
    lastKey.current = '';
    lastResult.current = null;
    setAckKey('');
    setNote('');
    setState({ matches: [], total: 0, blocking: false, checking: false });
  };
  const acked = !!state.matches.length && ackKey === idsKey(state.matches);
  return {
    ...state,
    acked,
    note,
    setNote,
    confirmAnyway: () => setAckKey(idsKey(state.matches)),
    undoAnyway: () => setAckKey(''),
    check,
    fromServer,
    reset,
    overrideBody: () => (ackRef.current && lastResult.current && ackRef.current === idsKey(lastResult.current.matches)
      ? { allowDuplicate: true, duplicateNote: noteRef.current }
      : {}),
  };
}

// Review #3 §5 / §20 — the three answers to a possible duplicate:
//   [Open Existing]      the matching client, in a new tab (the form stays)
//   [Merge Review]       Super Admin / Admin only: /clients/duplicates focused
//                        on that client (and on this one, when editing), where
//                        the admin chooses the master and confirms — nothing
//                        is ever merged automatically
//   [Create New Anyway]  an explicit, audit-logged override
// `mergeWith` = the id of the client being edited (none on Add Client, where
// the new client does not exist yet).
const MERGE_ADMIN = ['SUPER_ADMIN', 'ADMIN'];
export const mayMergeClients = (user) => !!user && (MERGE_ADMIN.includes(user.role) || MERGE_ADMIN.includes(user.atsRole));
export const mergeReviewLink = (focusId, withId) => `/clients/duplicates?focus=${encodeURIComponent(focusId)}${withId ? `&with=${encodeURIComponent(withId)}` : ''}`;

export function ClientDuplicateWarning({ dup, anywayLabel = 'Create New Anyway', subject = 'this new client', mergeWith = null }) {
  const { user } = useAuth();
  const canMerge = mayMergeClients(user);
  if (dup.checking && !dup.matches.length) return <div className="cldup-checking">Checking for existing clients…</div>;
  if (!dup.matches.length) return null;
  return (
    <div className="cldup" role="alert">
      <div className="cldup-head">
        <span aria-hidden="true">⚠</span>
        Possible duplicate found
        <span className="cldup-count">
          {dup.total > dup.matches.length ? `${dup.matches.length} of ${dup.total} shown` : `${dup.matches.length} existing client${dup.matches.length > 1 ? 's' : ''}`}
        </span>
      </div>
      <ul className="cldup-list">
        {dup.matches.map((m) => (
          <li key={m.id} className="cldup-item">
            <div className="cldup-item-top">
              <b>{m.name}</b>
              <span className="clrel-code">{m.displayCode}</span>
              {m.agreementStatus && <span className="clrel-pill">{`Agreement: ${agreementStatusLabel(m.agreementStatus)}`}</span>}
            </div>
            <div className="cldup-meta">
              {[m.legalName && `Legal: ${m.legalName}`, m.location, m.ownerDepartment, m.gst && `GSTIN ${m.gst}`, m.pan && `PAN ${m.pan}`,
                [m.contactName, m.contactPhone, m.contactEmail].filter(Boolean).join(' · ')].filter(Boolean).join(' · ') || '—'}
            </div>
            <div className="cldup-reasons">
              {m.reasons.map((r) => <span key={r.code} className={`cldup-reason ${r.strength}`}>{r.label}</span>)}
            </div>
            <div className="cldup-actions">
              <a className="btn btn-sm" href={`/clients/${m.id}`} target="_blank" rel="noopener noreferrer">Open Existing ↗</a>
              {canMerge && (
                <a
                  className="btn btn-sm"
                  href={mergeReviewLink(m.id, mergeWith)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Compare and merge on Duplicate clients — you choose the master and confirm; nothing merges automatically"
                >
                  Merge Review ↗
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
      {!dup.acked ? (
        <div className="cldup-actions">
          <button type="button" className="btn btn-sm btn-danger" onClick={dup.confirmAnyway}>{anywayLabel}</button>
          <span className="small-muted" style={{ fontSize: 11.5 }}>
            {dup.blocking
              ? 'Same GSTIN / PAN / name — saving is blocked until you confirm this is a different client.'
              : 'Review the match before saving. Duplicates are never merged automatically.'}
          </span>
        </div>
      ) : (
        <div className="cldup-ack">
          <div className="cldup-ok">{`You confirmed ${subject} is a different company. Saving records this in the audit trail.`}</div>
          <label>
            Why is it different? (recorded with the audit entry)
            <textarea rows="2" value={dup.note} onChange={(e) => dup.setNote(e.target.value)} placeholder="e.g. separate branch with its own GSTIN" />
          </label>
          <button type="button" className="btn btn-sm btn-ghost" onClick={dup.undoAnyway}>Undo</button>
        </div>
      )}
    </div>
  );
}
