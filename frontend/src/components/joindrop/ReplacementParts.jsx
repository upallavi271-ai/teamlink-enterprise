import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Modal } from '../proto.jsx';
import { dmy, errText } from './JdParts.jsx';
import './joindrop.css';

// ---------------------------------------------------------------------------
// WHO REPLACED WHOM (founder 2026-11-20): the two names are visible wherever a drop or a replacement is shown.
//   <ReplacementTags row={...} />       the chips every list / page uses. Reads the fields the server puts on a row:
//                                       replacementFor[]   "Replacement for <dropped candidate> (dropped on <date>, <client>, <requirement>)"
//                                       replacedBy / replacementWords / replacementState   on the DROPPED person: "Replaced by <name> (joined on ...)",
//                                       "Replacement due by <date> - not yet replaced", "The replacement period ended ...", "The client said no ..."
//   <WhoReplacedDialog />               "Who is this a replacement for?" (the Roll status choice "Replacement" opens it; it needs a pick)
//   <LinkReplacedButton />              the red "Link the replaced person" button on a Roll status "Replacement" that links to nobody (older data)
// ---------------------------------------------------------------------------
const STATE_TONE = {
  REPLACED: 'green', ADDED: 'blue', DUE: 'amber', EXPIRED: 'red', DECLINED: 'grey', CLOSED: 'grey', NOT_OWED: 'grey', UNKNOWN: 'grey',
};

// a chip that wraps (a name and its dates are never cut)
export function Chip({ tone = 'blue', children, title, to }) {
  const body = <span className={`jd-chip jd-chip-${tone}`} title={title || undefined}>{children}</span>;
  return to ? <Link to={to} style={{ textDecoration: 'none' }}>{body}</Link> : body;
}

export function ReplacementTags({ row, onlyFor = false, onlyBy = false }) {
  if (!row) return null;
  const fors = Array.isArray(row.replacementFor) ? row.replacementFor : [];
  const showBy = !onlyFor && (row.replacedBy || row.replacementWords) && (row.left || row.status === 'Dropped' || row.leftAfterJoining || row.replacedBy || row.dropKind === 'left');
  if (!fors.length && !showBy) return null;
  return (
    <div className="jd-chips" data-testid="replacement-tags">
      {!onlyBy && fors.map((f) => (
        <Chip key={`${f.recordId}-${f.applicationId}`} tone="blue" title={f.words} to={f.candidateId ? `/candidates/${f.candidateId}` : undefined}>{f.words}</Chip>
      ))}
      {showBy && row.replacementWords && (
        <Chip tone={STATE_TONE[row.replacementState] || 'grey'} title={row.replacementWords} to={row.replacedBy && row.replacedBy.candidateId ? `/candidates/${row.replacedBy.candidateId}` : undefined}>{row.replacementWords}</Chip>
      )}
    </div>
  );
}

// "Who is this a replacement for?" - the dropped candidates of the SAME client still waiting for a replacement (this requirement first).
export function WhoReplacedDialog({
  appId, candidateName, onClose, onDone, setLabel = true,
}) {
  const [data, setData] = useState(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get(`/join-drop/waiting/${appId}`).then((r) => setData(r.data)).catch((e) => setErr(errText(e, 'Could not load the list.')));
  }, [appId]);
  async function save() {
    if (!pick) { setErr('Choose who this person is a replacement for.'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.post('/join-drop/replacement-link', { droppedRecordId: pick, applicationId: appId, setLabel });
      onDone(r.data);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  const records = (data && data.records) || [];
  const same = records.filter((r) => r.sameRequirement);
  const other = records.filter((r) => !r.sameRequirement);
  const line = (r) => (
    <label key={r.id} className="jd-pick">
      <input type="radio" name="who-replaced" checked={pick === r.id} onChange={() => setPick(r.id)} />
      <span>
        <b>{r.candidateName}</b>
        <span className="small-muted">{` · dropped on ${dmy(r.droppedOn)} · ${r.jobTitle || 'requirement'}${r.jobCode ? ` (${r.jobCode})` : ''}${r.dueBy ? ` · replacement due by ${dmy(r.dueBy)}` : ''}`}</span>
      </span>
    </label>
  );
  return (
    <Modal
      title="Who is this a replacement for?"
      onClose={onClose}
      footer={records.length ? <button type="button" className="btn btn-primary" disabled={busy || !pick} onClick={save}>{busy ? 'Saving…' : 'Save: this is the replacement'}</button> : <button type="button" className="btn" onClick={onClose}>Close</button>}
    >
      <div className="small-muted" style={{ marginBottom: 8 }}>
        {`${candidateName ? `${candidateName} - ` : ''}choose the dropped candidate of ${data && data.clientName ? data.clientName : 'this client'} that this person replaces. The replacement task closes and both names are written on both records.`}
      </div>
      {!data && !err && <div className="small-muted">Loading…</div>}
      {data && !records.length && <div className="jd-banner">{data.message || 'No dropped candidate of this client is waiting for a replacement.'} The label is not saved.</div>}
      {same.length > 0 && <div className="jd-pick-group"><div className="small-muted">On the same requirement</div>{same.map(line)}</div>}
      {other.length > 0 && <div className="jd-pick-group"><div className="small-muted">Other requirements of this client</div>{other.map(line)}</div>}
      {err && <div className="error-text">{err}</div>}
    </Modal>
  );
}

// A Roll status "Replacement" with no link behind it (set before the dialog existed): a red button that opens the same dialog.
export function LinkReplacedButton({ appId, rollStatus, candidateName, onLinked, refreshKey }) {
  const [needs, setNeeds] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    if (appId && rollStatus === 'Replacement') {
      api.get(`/join-drop/replacing/${appId}`).then((r) => { if (alive) setNeeds(!!(r.data && r.data.needsLink && r.data.canLink)); }).catch(() => { if (alive) setNeeds(false); });
    } else setNeeds(false);
    return () => { alive = false; };
  }, [appId, rollStatus, refreshKey]);
  if (!needs && !open) return null;
  return (
    <>
      {needs && <button type="button" className="btn btn-sm" style={{ color: '#b42318', borderColor: '#b42318' }} title="This says Replacement but not whose. Choose the dropped candidate." onClick={() => setOpen(true)} data-testid="link-replaced-button">Link the replaced person</button>}
      {open && <WhoReplacedDialog appId={appId} candidateName={candidateName} onClose={() => setOpen(false)} onDone={(r) => { setOpen(false); setNeeds(false); if (onLinked) onLinked(r); }} />}
    </>
  );
}
