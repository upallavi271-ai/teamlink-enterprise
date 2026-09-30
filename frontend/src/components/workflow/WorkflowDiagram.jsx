// ---------------------------------------------------------------------------
// THE ACTUAL WORKFLOW, drawn with live counts (GET /api/ats/workflow).
//
//   REQUIREMENT -> Client (job posting, multiple sources) | Internal (HR sourcing)
//   -> JOB PORTAL: Applications -> Duplicate Check -> Resume Score -> AI Interview
//      -> AI Score -> Recruiter Review -> SEND TO ATS
//   -> CLIENT HIRING chain | INTERNAL HIRING chain
//
// Every count is the server's (utils/workflowFlow.js over atsVocab
// WORKFLOW_STAGE_GROUPS), in the viewer's own scope. Clicking a box opens the
// list behind it below the diagram (GET /api/ats/workflow/list?group=).
// Used by pages/ats/AtsWorkflow.jsx and the Workflow tab of ATS Reports.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api';
import { WORKFLOW_STAGE_GROUPS } from '../../atsVocab';
import './WorkflowDiagram.css';

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN'));
const money = (n) => (n == null ? '—' : `₹${Math.round(Number(n)).toLocaleString('en-IN')}`);
const day = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

// Where a requirement box leads (they count requirements, not applications).
const REQ_LINKS = {
  client_requirement: '/requirements?type=client',
  job_posting: '/requirements/job-portal',
  multiple_sources: '/requirements/job-portal?view=apps',
  internal_requirement: '/requirements?type=internal',
  hr_sourcing: '/requirements/job-portal?view=apps',
};

function Box({ box, active, onPick, tone }) {
  const clickable = !!(box.group || box.link || REQ_LINKS[box.id]);
  const inner = (
    <>
      <span className="wfd-box-label">{box.label}</span>
      {box.count != null && <b className="wfd-box-count">{fmt(box.count)}</b>}
      {box.also && (
        <span className="wfd-box-also">
          {`${box.also.label}: `}
          <b>{fmt(box.also.count)}</b>
        </span>
      )}
    </>
  );
  const cls = `wfd-box wfd-${tone || 'ats'}${active ? ' is-active' : ''}${clickable ? '' : ' is-static'}`;
  if (box.link || (!box.group && REQ_LINKS[box.id])) {
    return <Link className={cls} to={box.link || REQ_LINKS[box.id]}>{inner}</Link>;
  }
  return (
    <button type="button" className={cls} onClick={() => box.group && onPick(box.group, box.label)} aria-pressed={active}>
      {inner}
    </button>
  );
}

function Chain({ title, boxes, activeGroup, onPick, tone, note }) {
  return (
    <section className={`wfd-chain wfd-chain-${tone}`} aria-label={title}>
      <h3 className="wfd-chain-title">{title}</h3>
      {note && <div className="wfd-chain-note">{note}</div>}
      <ol className="wfd-steps">
        {(boxes || []).map((b) => (
          <li key={b.id} className="wfd-step">
            <Box box={b} tone={tone} active={activeGroup && (b.group === activeGroup)} onPick={onPick} />
            {b.also && (
              <button type="button" className={`wfd-also-link${activeGroup === b.also.group ? ' is-active' : ''}`} onClick={() => onPick(b.also.group, b.also.label)}>
                {`Open ${b.also.label}`}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function DrillDown({ pick, onClose }) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  useEffect(() => {
    let live = true;
    setState({ loading: true, data: null, error: '' });
    api.get('/ats/workflow/list', { params: { group: pick.group } })
      .then((r) => { if (live) setState({ loading: false, data: r.data, error: '' }); })
      .catch((e) => { if (live) setState({ loading: false, data: null, error: e.response?.data?.error || 'Could not load the list.' }); });
    return () => { live = false; };
  }, [pick.group]);
  const d = state.data;
  return (
    <div className="card wfd-drill" id="wfd-drill">
      <div className="wfd-drill-head">
        <b>{pick.label}</b>
        {d && <span className="small-muted">{` · ${fmt(d.total)} ${d.entity === 'invoice' ? 'invoice(s)' : 'candidate(s)'}${d.total > d.rows.length ? ` — newest ${d.rows.length} shown` : ''}`}</span>}
        <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
      </div>
      {state.loading && <div className="small-muted">Loading…</div>}
      {state.error && <div className="alert alert-error">{state.error}</div>}
      {d && d.rows.length === 0 && <div className="small-muted">Nobody at this step in your scope.</div>}
      {d && d.rows.length > 0 && d.entity === 'invoice' && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Invoice</th><th>Client</th><th>Candidate</th><th>Amount</th><th>Received</th><th>Status</th><th>Due</th></tr></thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.id}>
                  <td className="row-link"><Link to={`/invoices/${r.id}`}>{r.invoiceNumber || r.id.slice(-6)}</Link></td>
                  <td>{r.client || '—'}</td>
                  <td>{r.candidateId ? <Link to={`/candidates/${r.candidateId}`}>{r.candidate}</Link> : '—'}</td>
                  <td>{money(r.amount)}</td>
                  <td>{money(r.receivedAmount)}</td>
                  <td>{r.status}</td>
                  <td className="small-muted">{r.dueDate || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d && d.rows.length > 0 && d.entity !== 'invoice' && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Candidate</th><th>Requirement</th><th>Client</th><th>Hiring</th><th>Stage</th><th>Next action</th><th>Updated</th></tr></thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.id}>
                  <td className="row-link"><Link to={`/candidates/${r.candidateId}`}>{r.candidate || '—'}</Link></td>
                  <td className="row-link">
                    <Link to={`/requirements/${r.requirementId}`}>{r.requirement || '—'}</Link>
                    {r.reqCode && <div className="small-muted">{r.reqCode}{r.department ? ` · ${r.department}` : ''}</div>}
                  </td>
                  <td>{r.client || '—'}</td>
                  <td className="small-muted">{r.hiring}{r.preAts ? ' · Job Portal' : ''}</td>
                  <td>
                    {r.stageLabel}
                    {r.guaranteeEnds && <div className="small-muted">{`Guarantee to ${r.guaranteeEnds}`}</div>}
                    {r.joiningStatus && ['Replacement Due', 'Replaced', 'Left after Guarantee'].includes(r.joiningStatus) && <div className="small-muted">{r.joiningStatus}</div>}
                  </td>
                  <td className="small-muted">{r.preAts && ['RECRUITER_REVIEW', 'RECRUITER_APPROVED'].includes(r.stage) ? 'Send to ATS' : r.nextAction}</td>
                  <td className="small-muted">{day(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function WorkflowDiagram({ compact = false }) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  // ?group=<GROUP_ID> opens that box's list straight away (dashboards link here).
  const [params] = useSearchParams();
  const askedGroup = params.get('group');
  const [pick, setPick] = useState(() => (askedGroup && WORKFLOW_STAGE_GROUPS[askedGroup]
    ? { group: askedGroup, label: WORKFLOW_STAGE_GROUPS[askedGroup].label }
    : null));
  const load = useCallback((fresh) => {
    setState((s) => ({ ...s, loading: true }));
    api.get('/ats/workflow', { params: fresh ? { fresh: 1 } : {} })
      .then((r) => setState({ loading: false, data: r.data, error: '' }))
      .catch((e) => setState({ loading: false, data: null, error: e.response?.data?.error || 'Could not load the workflow.' }));
  }, []);
  useEffect(() => { load(false); }, [load]);
  const onPick = (group, label) => {
    setPick({ group, label });
    // Scroll the page's own scrolling area (the shell's main pane), never the
    // document — scrollIntoView would also shift the fixed shell.
    setTimeout(() => {
      const el = document.getElementById('wfd-drill');
      if (!el) return;
      let box = el.parentElement;
      while (box && box !== document.body) {
        const oy = getComputedStyle(box).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && box.scrollHeight > box.clientHeight) break;
        box = box.parentElement;
      }
      if (box && box !== document.body) {
        box.scrollTo({ top: box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top - 12, behavior: 'smooth' });
      } else {
        window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - 70, behavior: 'smooth' });
      }
    }, 80);
  };
  const d = state.data;
  const req = d ? d.flow.requirement : [];
  const reqOf = (id) => req.find((b) => b.id === id);
  return (
    <div className={`wfd${compact ? ' is-compact' : ''}`}>
      <div className="wfd-toolbar">
        <span className="small-muted">
          {d ? `Live counts in your scope${d.scope ? ` (${d.scope})` : ''} · as of ${new Date(d.asOf).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}
        </span>
        <button type="button" className="btn btn-sm" onClick={() => load(true)} disabled={state.loading}>{state.loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      {state.error && <div className="alert alert-error">{state.error}</div>}
      {!d && state.loading && <div className="card small-muted">Loading the workflow…</div>}
      {d && (
        <>
          <div className="wfd-top"><div className="wfd-root">REQUIREMENT</div></div>
          <div className="wfd-split">
            <Chain
              title="Client requirement"
              tone="client"
              boxes={[reqOf('client_requirement'), reqOf('job_posting'), reqOf('multiple_sources')].filter(Boolean)}
              onPick={onPick}
              activeGroup={pick && pick.group}
            />
            <Chain
              title="Internal requirement"
              tone="internal"
              boxes={[reqOf('internal_requirement'), reqOf('hr_sourcing')].filter(Boolean)}
              onPick={onPick}
              activeGroup={pick && pick.group}
            />
          </div>
          <div className="wfd-merge" aria-hidden="true">▼</div>
          <Chain
            title="Job Portal (before the ATS)"
            tone="portal"
            note="Portal and HR-sourced applications are screened here and reach the ATS only when a recruiter / HR presses Send to ATS."
            boxes={d.flow.pre}
            onPick={onPick}
            activeGroup={pick && pick.group}
          />
          <div className="wfd-merge" aria-hidden="true">▼</div>
          <div className="wfd-split">
            <Chain title="Client hiring" tone="client" boxes={d.flow.client} onPick={onPick} activeGroup={pick && pick.group} />
            <Chain title="Internal hiring" tone="internal" boxes={d.flow.internal} onPick={onPick} activeGroup={pick && pick.group} />
          </div>
          {pick && <DrillDown pick={pick} onClose={() => setPick(null)} />}
        </>
      )}
    </div>
  );
}
