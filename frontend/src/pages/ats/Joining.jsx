// Interviews & Joining -> Joining (change list §12 + the simplicity checklist,
// 2026-10-03).
//
//   Offer accepted → WAITING TO JOIN (oldest first) → the checklist:
//     1 Documents  2 Joining date  3 Confirmation call  4 Joined / Did not join
//   → "Rahul joined" and then, automatically:
//     Client placement   the invoice entry for Accounts + the guarantee period
//                        (alert before it ends; Left inside it → Replacement)
//     Internal hire      the HRMS employee record
// (backend: routes/interviewsJoining.js + utils/joining.js onApplicationJoined)

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api';
import CandidateDrawer from '../../components/CandidateDrawer.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { can } from '../../permissions';
import AtsDataTools from '../../components/AtsDataTools.jsx';
import Pager from '../../components/Pager.jsx';
import ListPageHeader, { StatusTabs } from '../../components/ui/ListPageHeader.jsx';
import StatusChip from '../../components/ui/StatusChip.jsx';
import { Modal } from '../../components/proto.jsx';
import { ReleaseLetterModal, ShareModal, TrackChip, openLetter } from '../../components/clientTrack/ClientTrack.jsx';
import '../../components/interviews/Interviews.css';
import JoinDropList from '../../components/joindrop/JoinDropList.jsx';
import { DropDialog, errText } from '../../components/joindrop/JdParts.jsx';
import {
  fmtDate, money, Banner, IntJoinEmpty, EMPTY_INTJOIN_FILTERS, useIntJoinPaged, ShowOlder, PAGE_SIZES_IJ,
} from './intjoinShared.jsx';

const LEFT = ['Replacement Due', 'Replaced', 'Left after Guarantee'];
const first = (n) => String(n || '').replace(/^ZZTEST\S*\s*/i, '').split(/\s+/)[0] || 'The candidate';
const todayIso = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

function viewOf(r) {
  if (r.joiningStatus === 'Dropped') return 'dropped';
  if (r.waitingToJoin) return 'waiting';
  if (['JOINED', 'HIRED'].includes(r.stage)) return 'joined';
  return 'all';
}
// The checklist, as four done / not-done facts.
function checks(r) {
  return {
    docs: r.documentsStatus === 'Verified',
    date: r.joiningStatus === 'Joining Scheduled' && !!r.joiningDate,
    call: !!r.call,
  };
}
function nextStep(r) {
  const c = checks(r);
  if (!c.docs) return 'Check documents';
  if (!c.date) return 'Set joining date';
  if (!c.call) return 'Confirmation call';
  return 'Mark joined';
}
const VIEWS = [['waiting', 'Waiting to join'], ['joined', 'Joined'], ['dropped', 'Did not join'], ['all', 'All']];

export default function Joining() {
  const { user } = useAuth();
  // "Joined and dropped" (Joining & Drop, 2026-10-17): every joining with its dates, place, replacement period and drops. A bell link opens it.
  const [sp] = useSearchParams();
  const [mode, setMode] = useState(sp.get('view') === 'joindrop' || sp.get('record') ? 'joindrop' : 'work');
  const [dialog, setDialog] = useState(null);
  const [joinedMsg, setJoinedMsg] = useState('');
  const [openCand, setOpenCand] = useState(null); // the candidate window, opened right here
  const canAct = can(user, 'ats', 'interviews', 'Joining', 'edit');
  const canDocs = can(user, 'ats', 'interviews', 'Offers', 'edit');
  const canSeeInvoice = can(user, 'accounts', 'accounts', 'Invoices', 'view');
  // B2 — left inside the guarantee and no replacement: Accounts raises a credit note from the invoice.
  const canCreditNote = can(user, 'accounts', 'accounts', 'Invoices', 'create');
  const canHire = can(user, 'ats', 'interviews', 'Internal Hiring', 'approve');
  const [view, setView] = useState('waiting');
  // The server searches, counts and pages the list (utils/intJoinList.js): the tab
  // counts are for the WHOLE list under the filters, not for this page. "Waiting
  // to join" comes oldest first (the person waiting longest is the risk).
  const ws = useIntJoinPaged('/ats/joining', { view });
  const {
    data, error, notice, act, load, setNotice, list, counts,
  } = ws;
  const rows = data.rows || [];
  const page = ws.pager;
  const live = dialog && dialog.id ? (data.rows || []).find((r) => r.id === dialog.id) : null;
  const close = () => setDialog(null);

  async function markJoined(r, body) {
    setJoinedMsg('');
    const ok = await act(async () => {
      const res = await api.post(`/ats/joining/${r.id}/joined`, body || {});
      setJoinedMsg(res.data.message || `🎉 ${first(r.candidate.name)} joined.`);
      return res;
    }, ' ');
    if (ok) { setNotice(''); close(); }
  }

  return (
    <div>
      <ListPageHeader
        title="Joining"
        question="People who said yes to the offer, until the day they start the job."
        data={(
          <AtsDataTools
            module="joining"
            kinds={['joining']}
            onImported={load}
            body={ws.exportBody}
          />
        )}
      />

      {/* The Interviews · Feedback · Offers · Joining tabs are drawn above the page by
          Shell.jsx (components/InterviewTabs.jsx) — tabs of Interview Calendar. */}

      <div className="jd-filters" role="tablist" aria-label="Joining screens" style={{ margin: '0 0 10px' }}>
        <button type="button" role="tab" aria-selected={mode === 'work'} className={`btn btn-sm${mode === 'work' ? ' btn-primary' : ''}`} onClick={() => setMode('work')}>Waiting to join and joined</button>
        <button type="button" role="tab" aria-selected={mode === 'joindrop'} className={`btn btn-sm${mode === 'joindrop' ? ' btn-primary' : ''}`} onClick={() => setMode('joindrop')}>Joined and dropped (dates, replacement period, drops)</button>
      </div>
      {mode === 'joindrop' && <JoinDropList onOpen={setOpenCand} />}
      {mode !== 'joindrop' && (<>
      {joinedMsg && <div className="ivx-success" role="status">{joinedMsg}</div>}
      <Banner error={error} notice={notice && notice.trim() ? notice : ''} />

      <StatusTabs
        label="Joining view"
        tabs={VIEWS.map(([key, label]) => ({ key, label, count: counts[key] || 0 }))}
        value={view}
        onChange={setView}
        hideZero
      />
      {list.toolbar}

      <div className="tbl-wrap" style={data.loading && rows.length ? { opacity: 0.55, transition: "opacity .15s" } : undefined} aria-busy={data.loading ? "true" : undefined}>
        <table>
          <thead>
            <tr><th>Candidate</th><th>Requirement</th><th>Joining date</th><th>{view === 'joined' ? 'Guarantee' : 'Checklist'}</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const internal = r.hiringType === 'TeamLink Internal Hire';
              const c = checks(r);
              const v = viewOf(r);
              const late = v === 'waiting' && r.joiningDate && r.joiningDate < todayIso();
              return (
                <tr key={r.id}>
                  <td className="row-link"><a href={`/candidates/${r.candidate.id}`} onClick={(e) => { e.preventDefault(); setOpenCand(r); }}>{r.candidate.name}</a></td>
                  <td>
                    <div>{r.requirement.title}</div>
                    <div className="small-muted" style={{ fontSize: 12 }}>{internal ? 'TeamLink (internal)' : r.requirement.client?.name || ''}</div>
                  </td>
                  <td className="small-muted" style={{ whiteSpace: 'nowrap' }}>{r.joiningDate ? fmtDate(r.joiningDate) : (v === 'joined' && r.joinedAt ? fmtDate(r.joinedAt) : 'Not recorded')}</td>
                  <td>
                    {v === 'joined' ? <Guarantee r={r} internal={internal} /> : (r.clientTrack && v === 'waiting' ? (
                      <div>
                        <TrackChip track={r.clientTrack} />
                        {r.clientTrack.joining?.releasedAt && <div className="small-muted" style={{ fontSize: 11.5, marginTop: 2 }}>{`Client released it ${fmtDate(r.clientTrack.joining.releasedAt)}${r.clientTrack.joining.onBehalf ? ' (recorded by the BDE)' : ''}`}</div>}
                        <div className="ivx-check" aria-label="Checklist" style={{ marginTop: 4 }}>
                          <span className={c.docs ? 'is-done' : ''}>{c.docs ? '✓ ' : ''}Documents</span>
                          <span className={r.clientTrack.joining?.confirmedAt ? 'is-done' : ''}>{r.clientTrack.joining?.confirmedAt ? '✓ ' : ''}Candidate confirmed</span>
                        </div>
                      </div>
                    ) : (
                      <div className="ivx-check" aria-label="Checklist">
                        <span className={c.docs ? 'is-done' : ''}>{c.docs ? '✓ ' : ''}Documents</span>
                        <span className={c.date ? 'is-done' : ''}>{c.date ? '✓ ' : ''}Date</span>
                        <span className={r.call && /not/i.test(r.call.note || '') ? 'is-bad' : c.call ? 'is-done' : ''}>{c.call ? '✓ ' : ''}Call</span>
                      </div>
                    ))}
                  </td>
                  <td>
                    {v === 'waiting' && (late
                      ? <StatusChip status="Joining date passed" tone="red" />
                      : <StatusChip status={r.daysWaiting ? `Waiting ${r.daysWaiting} day${r.daysWaiting === 1 ? '' : 's'}` : 'Waiting since today'} tone={r.daysWaiting > 14 ? 'red' : 'amber'} />)}
                    {v === 'joined' && <StatusChip status={`Joined ${r.joinedAt ? fmtDate(r.joinedAt) : ''}`.trim()} tone="green" />}
                    {v === 'dropped' && <StatusChip status="Did not join" tone="red" />}
                    {v === 'joined' && !internal && r.invoice && (
                      <div className="small-muted" style={{ fontSize: 11, marginTop: 2 }}>
                        {canSeeInvoice ? <Link to={`/invoices/${r.invoice.id}`}>Bill ready</Link> : 'Bill ready for Accounts'}
                      </div>
                    )}
                    {v === 'joined' && r.clientTrack?.invoice && <div style={{ marginTop: 3 }}><StatusChip status={`Invoice: ${r.clientTrack.invoice.label}`} tone={r.clientTrack.invoice.tone} /></div>}
                    {v === 'joined' && internal && <div className="small-muted" style={{ fontSize: 11, marginTop: 2 }}>{r.hrmsEmployeeId ? 'Employee added' : 'Not added as employee yet'}</div>}
                  </td>
                  <td>
                    <div className="ivx-actions">
                      {!canAct && <span className="small-muted">—</span>}
                      {canAct && v === 'waiting' && r.clientTrack && !r.clientTrack.joining?.releasedAt && (r.clientTrack.mayRelease
                        ? <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'clientRelease', id: r.id })}>Record the client&apos;s joining letter</button>
                        : <span className="small-muted">Waiting for the client&apos;s joining letter.</span>)}
                      {canAct && v === 'waiting' && r.clientTrack?.joining?.state === 'RELEASED' && (
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'share', id: r.id })}>Share joining letter with candidate</button>
                      )}
                      {canAct && v === 'waiting' && r.clientTrack?.joining?.state === 'SHARED' && (
                        <>
                          <button type="button" className="btn btn-sm" onClick={() => setDialog({ kind: 'share', id: r.id })}>Share again</button>
                          <button type="button" className="btn btn-sm" onClick={() => act(() => api.post(`/ats/joining/${r.id}/candidate-confirm`, {}), `Saved. ${first(r.candidate.name)} confirmed joining.`)}>Candidate confirmed</button>
                        </>
                      )}
                      {r.clientTrack?.joining?.file?.canOpen && v === 'waiting' && (
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => openLetter(`/ats/offers/${r.id}/client-letter/joining`)}>Open the client&apos;s letter</button>
                      )}
                      {canAct && v === 'waiting' && (
                        <button type="button" className={`btn btn-sm${r.clientTrack && r.clientTrack.joining?.state !== 'CONFIRMED' ? '' : ' btn-primary'}`} onClick={() => setDialog({ kind: 'checklist', id: r.id })}>{nextStep(r)}</button>
                      )}
                      {canAct && v === 'dropped' && (
                        <button type="button" className="btn btn-sm" onClick={() => setDialog({ kind: 'checklist', id: r.id })}>Set a new date</button>
                      )}
                      {canAct && v === 'joined' && internal && canHire && !r.hrmsEmployeeId && (
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => act(() => api.post(`/ats/internal-hiring/${r.id}/create-employee`), `Saved. ${first(r.candidate.name)} added as an employee.`)}>Add as employee</button>
                      )}
                      {canAct && v === 'joined' && !internal && !LEFT.includes(r.joiningStatus) && (
                        <button type="button" className="btn btn-sm" onClick={() => setDialog({ kind: 'left', id: r.id })}>Left the job</button>
                      )}
                      {canAct && !internal && r.joiningStatus === 'Replacement Due' && (
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => act(() => api.post(`/ats/joining/${r.id}/replaced`, {}), 'Saved. Replacement given.')}>Replacement given</button>
                      )}
                      {canCreditNote && !internal && r.joiningStatus === 'Replacement Due' && r.invoice && (
                        <Link className="btn btn-sm" to={`/invoices?tab=notes&raise=${r.id}`} title="No replacement possible — give the client a credit note on the invoice">No replacement — credit note</Link>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan="6" style={{ padding: 0 }}>
                <IntJoinEmpty
                  loading={data.loading} failed={data.failed} onRetry={load}
                  filters={list.active ? { q: 'x' } : EMPTY_INTJOIN_FILTERS}
                  onClear={list.clear}
                  noun="people"
                  title={{ waiting: 'Nobody is waiting to join.', joined: 'Nobody has joined yet.', dropped: 'Everyone joined — nobody dropped out.' }[view] || 'Nobody at joining yet.'}
                />
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} noun="people" sizes={PAGE_SIZES_IJ} />
      <ShowOlder
        older={ws.older}
        setOlder={ws.setOlder}
        count={ws.olderCount}
        noun="people"
        openText="Showing people waiting to join, and those who joined in the last 90 days."
      />

      </>)}

      {dialog?.kind === 'checklist' && live && (
        <Checklist
          r={live}
          canDocs={canDocs}
          act={act}
          onClose={close}
          onJoined={(body) => markJoined(live, body)}
        />
      )}
      {dialog?.kind === 'clientRelease' && live && (
        <ReleaseLetterModal
          kind="joining"
          onBehalf
          endpoint={`/ats/joining/${live.id}/client-release`}
          candidateName={live.candidate.name}
          onClose={close}
          onDone={(r) => { close(); act(async () => {}, r.message); }}
        />
      )}
      {dialog?.kind === 'share' && live && (
        <ShareModal
          kind="joining"
          endpoint={`/ats/joining/${live.id}/share`}
          candidateName={first(live.candidate.name)}
          onClose={() => { close(); load(); }}
        />
      )}
      {dialog?.kind === 'left' && live && (
        <LeftViaDrop row={live} onClose={close} onDone={(m) => { close(); act(async () => {}, m); }} />
      )}
      {openCand && (
        <CandidateDrawer
          candidateId={openCand.candidate.id}
          applicationId={openCand.id}
          user={user}
          onClose={() => setOpenCand(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

function Guarantee({ r, internal }) {
  if (internal) return <span className="small-muted">Not needed</span>;
  // Shown words only — joiningStatus values stay as stored. Replacement due is a problem (red); the other two are done (green).
  if (LEFT.includes(r.joiningStatus)) {
    const text = { 'Replacement Due': 'Replacement due', Replaced: 'Replacement given', 'Left after Guarantee': 'Left after guarantee' }[r.joiningStatus];
    return <StatusChip status={text} tone={r.joiningStatus === 'Replacement Due' ? 'red' : 'green'} />;
  }
  if (!r.guaranteeEnds) return <span className="small-muted">{r.guaranteeTerm || '—'}</span>;
  const left = r.guaranteeDaysLeft;
  if (left == null || left < 0 || !r.inGuarantee) return <StatusChip status="Guarantee over" tone="green" />;
  return (
    <>
      <StatusChip status={`Ends in ${left} day${left === 1 ? '' : 's'}`} tone={left <= 7 ? 'red' : 'blue'} />
      <div className="small-muted" style={{ fontSize: 11 }}>{`${r.guaranteeTerm || ''} · to ${fmtDate(r.guaranteeEnds)}`}</div>
    </>
  );
}

// The joining checklist — four steps, one place, and the big "Joined" button.
function Checklist({ r, canDocs, act, onClose, onJoined }) {
  const c = checks(r);
  const internal = r.hiringType === 'TeamLink Internal Hire';
  const [date, setDate] = useState(r.joiningDate || '');
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [drop, setDrop] = useState(false);
  const [dropReason, setDropReason] = useState('');
  const [busy, setBusy] = useState(false);
  // The day and the place they joined (the job's place is the default); both are kept in the joining record.
  const [joinedOn, setJoinedOn] = useState(r.joiningDate || todayIso());
  const [place, setPlace] = useState(r.requirement?.location || r.requirement?.client?.location || '');
  const [placeErr, setPlaceErr] = useState('');
  const step = async (fn, msg) => { setBusy(true); try { return await act(fn, msg); } finally { setBusy(false); } };
  useEffect(() => { setDate(r.joiningDate || ''); }, [r.joiningDate]);
  const docText = { Pending: 'Not received', Submitted: 'Received — check them', Verified: 'Checked' }[r.documentsStatus] || r.documentsStatus;

  return (
    <Modal
      title={`Joining — ${r.candidate.name}`}
      onClose={onClose}
      footer={drop ? (
        <button type="button" className="btn btn-primary" disabled={busy || !dropReason.trim()} onClick={async () => { const ok = await step(() => api.post(`/ats/joining/${r.id}/not-joined`, { reason: dropReason.trim() }), `Saved. ${first(r.candidate.name)} did not join.`); if (ok) onClose(); }}>Save — did not join</button>
      ) : (
        <>
          <button type="button" className="btn btn-ghost" onClick={() => setDrop(true)}>Did not join</button>
          <button type="button" className="btn btn-primary" disabled={busy || !c.date} title={c.date ? '' : 'Set the joining date first'} onClick={() => { if (!place.trim()) { setPlaceErr('Type the place (city or branch) where they joined.'); return; } setPlaceErr(''); onJoined({ joinedOn, location: place.trim() }); }}>Joined ✓</button>
        </>
      )}
    >
      <div className="ivx-fb">
        <div className="ivx-hint" style={{ marginTop: 0, marginBottom: 12 }}>{`${r.requirement.title} · ${internal ? 'TeamLink (internal)' : r.requirement.client?.name || ''}${r.offeredCtc ? ` · ${money(r.offeredCtc)} a year` : ''}`}</div>

        {drop ? (
          <div className="ivx-sec">
            <b>Why did they not join?</b>
            <textarea rows="3" maxLength={1000} placeholder="e.g. Took another job, family reasons" value={dropReason} onChange={(e) => setDropReason(e.target.value)} />
            <button type="button" className="btn btn-sm btn-ghost" style={{ marginTop: 6 }} onClick={() => setDrop(false)}>Back to the checklist</button>
          </div>
        ) : (
          <>
            <div className="ivx-sec">
              <b>{c.docs ? '✓ ' : '1 · '}Documents — {docText}</b>
              {!c.docs && canDocs && (
                <div className="ivx-actions">
                  {r.documentsStatus !== 'Submitted' && (
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => step(() => api.post(`/ats/offers/${r.id}/documents`, { documentsStatus: 'Submitted' }), 'Saved. Documents received.')}>Received</button>
                  )}
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => step(() => api.post(`/ats/offers/${r.id}/documents`, { documentsStatus: 'Verified' }), 'Saved. Documents checked.')}>Checked ✓</button>
                </div>
              )}
            </div>

            <div className="ivx-sec">
              <b>{c.date ? '✓ ' : '2 · '}Joining date</b>
              <div className="ivx-actions">
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                <button type="button" className="btn btn-sm" disabled={busy || !date || (internal && !c.docs) || (c.date && date === r.joiningDate)} onClick={() => step(() => api.post(`/ats/joining/${r.id}/schedule`, { joiningDate: date }), `Saved. Joining on ${fmtDate(date)}.`)}>Save date</button>
              </div>
              {internal && !c.docs && <div className="ivx-hint">For an internal hire, check the documents first.</div>}
            </div>

            <div className="ivx-sec">
              <b>{c.call ? '✓ ' : '3 · '}Confirmation call</b>
              {r.call ? (
                <div className="ivx-hint" style={{ marginTop: 0 }}>{`Called ${fmtDate(r.call.at)}${r.call.by ? ` by ${r.call.by}` : ''}${r.call.note ? ` — ${r.call.note}` : ''}`}</div>
              ) : null}
              <div className="ivx-outs" style={{ gridTemplateColumns: 'repeat(3,1fr)' }} role="radiogroup" aria-label="What did the candidate say">
                {[['Will join', 'green'], ['Not sure', 'orange'], ['Will not join', 'red']].map(([v, tone]) => (
                  <button key={v} type="button" role="radio" aria-checked={outcome === v} className={`ivx-out ${tone}${outcome === v ? ' is-on' : ''}`} onClick={() => setOutcome(v)}>{v}</button>
                ))}
              </div>
              {outcome && (
                <div className="ivx-actions" style={{ marginTop: 6 }}>
                  <input style={{ flex: 1, minWidth: 160 }} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={async () => { const ok = await step(() => api.post(`/ats/joining/${r.id}/call`, { outcome, note: note.trim() ? `${outcome} — ${note.trim()}` : outcome }), `Saved. Call noted: ${outcome}.`); if (ok) { setOutcome(''); setNote(''); } }}>Save call</button>
                </div>
              )}
            </div>

            <div className="ivx-sec">
              <b>When and where did they join?</b>
              <div className="ivx-actions">
                <input type="date" max={todayIso()} value={joinedOn} onChange={(e) => setJoinedOn(e.target.value)} aria-label="Day they joined" />
                <input style={{ flex: 1, minWidth: 160 }} placeholder="Place (city or branch)" value={place} onChange={(e) => setPlace(e.target.value)} aria-label="Place they joined" />
              </div>
              {placeErr && <div className="error-text">{placeErr}</div>}
            </div>

            <div className="ivx-hint">
              {internal ? 'Joined adds them as an employee.' : 'Joined makes the bill for Accounts, starts the replacement period and tells the client, recruiter, TL, BDE and HR.'}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// "Left the job" now opens the full Report-a-drop form (day, last working day, reason, details, who will be told).
function LeftViaDrop({ row, onClose, onDone }) {
  const [rec, setRec] = useState(null);
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get(`/join-drop/application/${row.id}`).then((r) => setRec(r.data.record)).catch((e) => setErr(errText(e, 'Could not open the drop form.')));
    api.get('/join-drop/meta').then((r) => setMeta(r.data)).catch(() => {});
  }, [row.id]);
  if (err) return <Modal title="Report a drop" onClose={onClose}><div className="error-text">{err}</div></Modal>;
  if (!rec || !meta) return null;
  return <DropDialog rec={rec} meta={meta} endpoint={`/join-drop/${rec.id}/drop`} onClose={onClose} onDone={(r) => onDone(r.message || 'Saved.')} />;
}

// (the older one-line form, kept for reference)
function LeftForm({ row, onClose, onSubmit }) {
  const [leftOn, setLeftOn] = useState(todayIso());
  const [reason, setReason] = useState('');
  return (
    <Modal
      title={`Candidate left — ${row.candidate.name}`}
      onClose={onClose}
      footer={<button type="button" className="btn btn-primary" disabled={!reason.trim()} onClick={() => onSubmit(leftOn, reason.trim())}>Save</button>}
    >
      <div className="ivx-fb">
        <div className="ivx-hint" style={{ marginTop: 0, marginBottom: 12 }}>{`Guarantee ${row.guaranteeTerm || '—'}${row.guaranteeEnds ? ` to ${fmtDate(row.guaranteeEnds)}` : ''}`}</div>
        <div className="ivx-sec"><b>Left on</b><input type="date" value={leftOn} onChange={(e) => setLeftOn(e.target.value)} /></div>
        <div className="ivx-sec"><b>Why?</b><input style={{ width: '100%' }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Resigned in week 3" /></div>
      </div>
    </Modal>
  );
}
