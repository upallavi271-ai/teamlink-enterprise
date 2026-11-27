// ---------------------------------------------------------------------------
// THE ONE LEAVE SCREEN (founder 2026-11-13: "ahh 3 buttons kakunda okaey dantlo chain approvals chudali ... only one button pettu").
// The Requests list used to carry three buttons for one leave: Open, Approve / Reject and Chain. They are this one screen now:
//   * the leave: who, which dates, how many days, the reason, the employee's comments, the work handed over, Pulse HRMS says ...
//   * the approval chain, level by level (components/ApprovalChain.jsx), who is up next
//   * who approved, and when: every level with who did what, the date and time and the comment (the old Chain screen)
//   * everything that happened to the request (the old Chain screen's history)
//   * Approve / Reject / Reassign for the login whose turn it is (or a Super Admin deciding directly) - the buttons appear only
//     when the server says that login may act; nothing here decides who may.
// Data: GET /api/leave/:id/workflow (leave, workflow, history, handoffs, handover, earlyLogout, source, pulse).
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import { Modal, EmptyMini, SectionLabel } from '../../components/proto.jsx';
import ApprovalChain from '../../components/ApprovalChain.jsx';
import { LeaveFacts, LeaveDecidePanel } from './LeaveExtras.jsx';
import EmployeeLeaves, { SplitNote } from './EmployeeLeaves.jsx';
import { ChainSteps, ChainHistory } from './LeaveChainScreen.jsx';
import './LeaveChainScreen.css';

export default function LeaveRequestScreen({ requestId, onClose, onActed = () => {} }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  // The request shown; the note of a leave in parts can switch to another part without leaving the screen.
  const [shown, setShown] = useState(requestId);
  useEffect(() => { setShown(requestId); }, [requestId]);

  function load() {
    setError('');
    api.get(`/leave/${shown}/workflow`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load this leave.'));
  }
  useEffect(load, [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  const openOther = (id) => { setData(null); setShown(id); };

  const leave = data?.leave;
  const wf = data?.workflow;
  const e = (leave && leave.employee) || {};
  return (
    <Modal title={leave ? `Leave - ${e.name || ''}` : 'Leave'} onClose={onClose} wide footer={<button className="btn" onClick={onClose}>Close</button>}>
      {error && <div className="error-text">{error}</div>}
      {!data && !error && <EmptyMini>Loading…</EmptyMini>}
      {leave && (
        <>
          <div className="wf-head">
            <div><span className="cell-muted">Leave ID:</span> <b>LV-{String(leave.id).slice(-4).toUpperCase()}</b></div>
          </div>
          <SplitNote split={data.split} currentId={leave.id} onOpenPart={openOther} />
          <LeaveFacts leave={leave} handoffs={data.handoffs} early={data.earlyLogout} source={data.source} pulse={data.pulse} handover={data.handover} />

          {/* What this employee has already taken, then the decision, on the same screen (founder 2026-11-25). */}
          <EmployeeLeaves data={data.employeeLeave} name={e.name} />
          <LeaveDecidePanel data={data} onDone={() => { load(); onActed(); }} />

          {wf && <><SectionLabel style={{ marginTop: 14 }}>Approval chain</SectionLabel><ApprovalChain workflow={wf} recordStatus={leave.status} /></>}

          <SectionLabel style={{ marginTop: 16 }}>Who approved, and when</SectionLabel>
          <ChainSteps steps={(wf && wf.steps) || []} />

          <SectionLabel style={{ marginTop: 16 }}>{`Everything that happened (${(data.history || []).length})`}</SectionLabel>
          <ChainHistory history={data.history || []} />
        </>
      )}
    </Modal>
  );
}
