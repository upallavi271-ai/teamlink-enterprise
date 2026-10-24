import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import {
  KV, dmy, when, errText, statusTone, JoiningDialog, DropDialog, DecisionDialog, ReasonDialog, LinkDialog, NoticeDialog,
  HistoryList, Journey, ToldTable,
} from './JdParts.jsx';
import './joindrop.css';

// ---------------------------------------------------------------------------
// CANDIDATE PAGE (full page and drawer): the "Joining & Drop" panel.
//   the joining card (day, place, designation, job, client, who recorded it), the replacement period, the drop and the client's decision,
//   the buttons this login has, the HISTORY (joined, drop, reason, decision, replacement, corrections: who and when) and the JOURNEY
//   (every date from the day the candidate came to us, to the joining and the drop).
// Everything comes from GET /api/join-drop/application/:appId; the server decides what each login sees and may do.
// ---------------------------------------------------------------------------
export default function JoiningDropPanel({ app, onChanged }) {
  const appId = app && app.id;
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [dlg, setDlg] = useState(null);
  const [show, setShow] = useState({ journey: false, told: false });
  const load = useCallback(() => {
    if (!appId) return;
    api.get(`/join-drop/application/${appId}`).then((r) => { setData(r.data); setErr(''); }).catch((e) => setErr(e.response?.status === 403 ? '' : errText(e, 'Could not load the joining details.')));
  }, [appId]);
  useEffect(() => { setData(null); setMsg(''); load(); }, [load]);
  useEffect(() => { api.get('/join-drop/meta').then((r) => setMeta(r.data)).catch(() => {}); }, []);

  if (!app) return null;
  if (err) return <div className="jd-card"><div className="small-muted">{err}</div></div>;
  if (!data) return null;
  const rec = data.record;
  const rights = data.rights || {};
  if (!rec) {
    if (!['JOINED', 'HIRED'].includes(app.stage)) return data.journey ? <JourneyOnly data={data} /> : null;
    return null;
  }
  const done = (r, text) => { setDlg(null); setMsg(text || r?.message || 'Saved.'); load(); if (onChanged) onChanged(); };
  const dropped = rec.status === 'Dropped';
  const canPay = meta?.rights?.seePay;
  const id = rec.id;

  return (
    <div>
      {msg && <div className="jd-banner green" role="status">{msg}</div>}
      <div className="jd-card">
        <div className="jd-head">
          <h4>Joining &amp; drop <StatusChip status={dropped ? 'Dropped' : 'Joined'} tone={statusTone(rec.status)} /></h4>
          <div className="small-muted">{rec.backfilled ? 'Copied from the existing records' : `Recorded by ${rec.recordedByName || 'TeamLink'}${rec.recordedVia ? ` (${rec.recordedVia})` : ''} on ${when(rec.createdAt)}`}</div>
        </div>
        {rec.needsDetails && (
          <div className="jd-banner">Some joining details are not recorded yet ({[rec.missing.includes('joinedOn') ? 'the day they joined' : null, rec.missing.includes('location') ? 'the place' : null].filter(Boolean).join(' and ')}).{rights.correct && ' Press "Add details".'}</div>
        )}
        <div className="jd-grid">
          <KV k="Joined on" v={rec.joinedOn ? dmy(rec.joinedOn) : null} />
          <KV k="Place" v={rec.location} />
          <KV k="Designation" v={rec.designation} />
          <KV k="Requirement" v={`${rec.jobTitle || ''}${rec.jobCode ? ` (${rec.jobCode})` : ''}`.trim()} />
          <KV k="Client" v={rec.clientName} />
          <KV k="Department" v={rec.department} />
          <KV k="Employment type" v={rec.employmentType} />
          <KV k="Reporting person at the client" v={[rec.reportingPerson, rec.reportingContact].filter(Boolean).join(' · ')} />
          {'offeredCtc' in rec && <KV k="Pay (CTC a year)" v={rec.offeredCtc ? `₹${Number(rec.offeredCtc).toLocaleString('en-IN')}` : null} />}
          <KV k="Days since joining" v={rec.daysSinceJoining != null ? `${rec.daysSinceJoining} day${rec.daysSinceJoining === 1 ? '' : 's'}` : null} />
          <KV k="Recruiter" v={rec.recruiterName} />
          <KV k="Team lead" v={rec.tlName} />
          <KV k="BDE" v={rec.bdeName} />
        </div>
        <div className="jd-banner blue" style={{ marginTop: 10 }}>
          <b>{rec.guaranteeLine}</b>
          {rec.guaranteeDays != null && rec.guaranteeDays > 0 && <div className="small-muted">{`Starts ${dmy(rec.guaranteeStartOn)} (the joining day), ends ${dmy(rec.guaranteeEndsOn)}, ${rec.guaranteeDays} days.`}{!dropped && rec.inGuarantee != null && (rec.inGuarantee ? ' Running now.' : ' Over.')}</div>}
        </div>
        <div className="jd-actions">
          {rights.correct && <button type="button" className={`btn btn-sm${rec.needsDetails ? ' btn-primary' : ''}`} onClick={() => setDlg('joining')}>{rec.needsDetails ? 'Add details' : 'Correct the details'}</button>}
          {rights.report && <button type="button" className="btn btn-sm" onClick={() => setDlg('drop')}>Report a drop</button>}
        </div>
      </div>

      {dropped && (
        <div className="jd-card">
          <div className="jd-head"><h4>The drop</h4><div className="small-muted">{`Reported by ${rec.dropReportedByName || 'Not recorded'}${rec.dropReportedFrom ? ` (${rec.dropReportedFrom})` : ''} on ${when(rec.dropReportedAt)}`}</div></div>
          {rec.dropAfterIncentive && <div className="jd-banner red">This drop came after the recruiter&apos;s incentive was decided for that month. The HR head has been told. The decision was not changed.</div>}
          <div className="jd-grid">
            <KV k="Dropped on" v={dmy(rec.droppedOn)} />
            <KV k="Last working day" v={rec.lastWorkingDay ? dmy(rec.lastWorkingDay) : null} />
            <KV k="Reason" v={rec.dropReason} />
            <KV k="More about it" v={rec.dropReasonDetail} nr={false} />
            <KV k="Days after joining" v={rec.dropDaysSinceJoining != null ? `${rec.dropDaysSinceJoining} day${rec.dropDaysSinceJoining === 1 ? '' : 's'}` : null} />
            <KV k="Inside the replacement period?" v={rec.dropWithinGuarantee === 1 ? 'Yes, inside the period' : (rec.dropWithinGuarantee === 0 ? 'No, after the period' : 'Not known')} />
          </div>
          <h4 style={{ marginTop: 14 }}>Replacement</h4>
          <div className="jd-grid">
            <KV k="The client's answer" v={rec.replacementDecisionWords || 'Waiting for the client'} nr={!rec.replacementDecisionWords} />
            <KV k="Answered by" v={rec.replacementDecisionWords ? `${rec.replacementDecidedByName || ''}${rec.replacementOnBehalf ? ' (on the client\'s behalf)' : ''} on ${when(rec.replacementDecidedAt)}` : null} />
            <KV k="The client's comment" v={rec.replacementComment} nr={false} />
            <KV k="Expected by" v={rec.replacementExpectedOn ? dmy(rec.replacementExpectedOn) : null} nr={false} />
            <KV k="Kind of profile wanted" v={rec.replacementProfileNotes} nr={false} />
            <KV k="Replacement status" v={rec.replacementStatus || (rec.replacementDecision ? null : 'Waiting for the client')} nr={false} />
            {rec.replacementTask && <KV k="Replacement task" v={`${rec.replacementTask.state}${rec.replacementTask.dueOn ? `, due ${dmy(rec.replacementTask.dueOn)}` : ''}${rec.replacementTask.assignee ? `, ${rec.replacementTask.assignee}` : ''}${rec.replacementTask.state === 'Cancelled' ? `. Cancelled by ${rec.replacementTask.cancelledBy || ''}: ${rec.replacementTask.cancelReason || ''}` : ''}`} nr={false} />}
          </div>
          {rec.suggestion && <div className="jd-banner">{rec.suggestion}</div>}
          <div className="jd-actions">
            {rights.correctDrop && <button type="button" className="btn btn-sm" onClick={() => setDlg('correctDrop')}>Correct the drop details</button>}
            {rights.decide && <button type="button" className="btn btn-sm btn-primary" onClick={() => setDlg('decide')}>Enter the client&apos;s answer</button>}
            {rights.openTask && <button type="button" className="btn btn-sm" onClick={() => setDlg('openTask')}>Open a replacement task</button>}
            {rights.cancelTask && <button type="button" className="btn btn-sm" onClick={() => setDlg('cancelTask')}>Cancel the replacement task</button>}
            {rights.link && <button type="button" className="btn btn-sm" onClick={() => setDlg('link')}>Link the replacement candidate</button>}
            {rights.closeReplacement && <button type="button" className="btn btn-sm" onClick={() => setDlg('closeRepl')}>Close the replacement</button>}
            {rights.notice && <button type="button" className="btn btn-sm" onClick={() => setDlg('notice')}>Send notice to candidate</button>}
            {rights.reopen && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDlg('reopen')}>Withdraw this drop (reported by mistake)</button>}
          </div>
        </div>
      )}

      <div className="jd-card">
        <div className="jd-head"><h4>History</h4><div className="small-muted">Nothing here is ever changed or deleted. A correction is a new line.</div></div>
        <HistoryList history={data.history} />
      </div>

      <div className="jd-card">
        <div className="jd-head"><h4>Journey</h4>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShow((s) => ({ ...s, journey: !s.journey }))}>{show.journey ? 'Hide' : 'Show every date'}</button>
        </div>
        {show.journey ? <Journey journey={data.journey} /> : <div className="small-muted">{journeyLine(data.journey)}</div>}
      </div>

      {(data.told || []).length > 0 && (
        <div className="jd-card">
          <div className="jd-head"><h4>Who was told</h4>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShow((s) => ({ ...s, told: !s.told }))}>{show.told ? 'Hide' : 'Show'}</button>
          </div>
          {show.told && <ToldTable told={data.told} emailsOn={data.emailsOn} />}
        </div>
      )}

      {dlg === 'joining' && <JoiningDialog rec={rec} endpointAdd={`/join-drop/application/${appId}/record`} endpointCorrect={`/join-drop/${id}`} canPay={!!canPay && 'offeredCtc' in rec} onClose={() => setDlg(null)} onDone={(r) => done(r)} />}
      {dlg === 'drop' && <DropDialog rec={rec} meta={meta} endpoint={`/join-drop/${id}/drop`} onClose={() => setDlg(null)} onDone={(r) => done(r)} />}
      {dlg === 'correctDrop' && <DropDialog rec={rec} meta={meta} correcting method="patch" endpoint={`/join-drop/${id}/drop`} onClose={() => setDlg(null)} onDone={(r) => done(r)} />}
      {dlg === 'decide' && <DecisionDialog rec={rec} endpoint={`/join-drop/${id}/decision`} onClose={() => setDlg(null)} onDone={(r) => done(r)} />}
      {dlg === 'link' && <LinkDialog rec={rec} endpoint={`/join-drop/${id}/replacement/link`} onClose={() => setDlg(null)} onDone={(r) => done(r)} />}
      {dlg === 'notice' && <NoticeDialog rec={rec} onClose={() => setDlg(null)} onDone={(r) => done(r, r?.message)} />}
      {dlg === 'cancelTask' && <ReasonDialog title="Cancel the replacement task" lead="Do this when the client does not want a replacement. The recruiter, TL and HR are told, and your reason is kept." label="Why is it not needed?" button="Cancel the task" endpoint={`/join-drop/${id}/replacement-task/cancel`} onClose={() => setDlg(null)} onDone={(r) => done(r)} />}
      {dlg === 'reopen' && <ReasonDialog title="Withdraw this drop" lead="Use this only if the drop was reported by mistake. The candidate goes back to Joined and the same people are told." label="Why was it wrong?" button="Withdraw the drop" endpoint={`/join-drop/${id}/reopen`} onClose={() => setDlg(null)} onDone={(r) => done(r)} />}
      {dlg === 'closeRepl' && <ReasonDialog title="Close the replacement" lead="Use this when the replacement was settled outside TeamLink." label="A note (optional)" button="Close it" field="note" endpoint={`/join-drop/${id}/replacement/close`} onClose={() => setDlg(null)} onDone={(r) => done(r)} />}
      {dlg === 'openTask' && (
        <ReasonDialog title="Open a replacement task" lead="This drop is outside the replacement period, so no task opened by itself. Open one if the client still wants a replacement." label="A note (optional)" button="Open the task" field="note" endpoint={`/join-drop/${id}/replacement-task/open`} onClose={() => setDlg(null)} onDone={(r) => done(r)} />
      )}
    </div>
  );
}

function journeyLine(j) {
  if (!j) return '';
  const d = j.dates || {};
  const bits = [['Came to us', d.cameOn], ['BDE', d.bdeOn], ['Sent to client', d.sentToClientOn], ['First interview', d.firstInterviewOn], ['Offer', d.offerOn], ['Joined', d.joinedOn], ['Dropped', d.droppedOn]];
  return bits.filter(([, v]) => v).map(([k, v]) => `${k}: ${dmy(v)}`).join(' → ') || 'No dates yet.';
}

function JourneyOnly({ data }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="jd-card">
      <div className="jd-head"><h4>Journey</h4><button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show every date'}</button></div>
      {open ? <Journey journey={data.journey} /> : <div className="small-muted">{journeyLine(data.journey)}</div>}
    </div>
  );
}
