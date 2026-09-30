import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { PanelPad, StatRow, AssignRow, EmptyMini, TwoCol, QaRow, NumHead, Modal, SectionLabel } from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin, canDecideServices, can } from '../../permissions';
import PeopleFilterBar, { EMPTY_PEOPLE_FILTERS, peopleMatches, peopleOptions, statusOptions, textMatches } from '../../components/PeopleFilterBar.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { ListEmpty } from '../../components/ui/ListFilters.jsx';
import Combo from '../../components/Combo.jsx';
import { ComposeModal, Field, AiAssist, useSubmit, CheckLine } from '../../components/ComposeForm.jsx';
import ApprovalChain, { ApprovalChainLine, fmtDateTime } from '../../components/ApprovalChain.jsx';
import DataIoBar from '../../components/dataio/DataIoBar.jsx';
import './Resignation.css';

// ---------------------------------------------------------------------------
// RESIGNATION (spec item 7) — backend/src/routes/resignations.js.
//
// The form is the old HRMS "Letter of Resignation (LOR)" (see LorHead below):
// company / location / department and the employee block prefilled, the
// last day computed as today + the notice period, a reason (picker + Other),
// "Describe reason", who it is submitted to, and the optional fields HR has
// switched on (Notice Period, Handover, Knowledge Transfer, Exit Comments).
// Approvers open the same letter read-only. The submission date and time are recorded by the
// server. It then climbs the shared approval chain
//   Employee → TL → STL → HR → Assistant Manager → Manager → Super Admin
// (components/ApprovalChain.jsx) and, on final approval, the employee goes on
// Notice Period with the approved last working date.
// ---------------------------------------------------------------------------
const RESIGNATION_STATUSES = ['Pending Approval', 'Notice Period', 'Accepted', 'Rejected', 'Relieved', 'Withdrawn'];
const SERVING = ['Notice Period', 'Accepted'];
const OPEN = ['Pending Approval', ...SERVING];
// Filter standard: Search · Employee · Department · Status · Reason · Sort |
// More: Employee ID · Role · Employee status · Submitted on · Waiting on me.
const RSG_EMPTY = { ...EMPTY_PEOPLE_FILTERS, q: '', reason: '', waiting: '', from: '', to: '' };
const submittedOf = (r) => r.submittedAt || r.createdAt;
// DATE-WISE (2026-09-29): every resignation — live ones and the history
// imported from the employee master — is dated by its RELIEVING date (the
// last working day), its RESIGNATION date, or when it was submitted.
const DATE_BASES = [['relieving', 'Relieving date'], ['resignation', 'Resignation date'], ['submitted', 'Submitted on']];
const keyDate = (r, basis) => {
  if (basis === 'resignation') return r.resignationDate || '';
  if (basis === 'submitted') return r.source === 'Imported' ? '' : String(submittedOf(r) || '').slice(0, 10);
  return r.relievingDate || r.lastWorkingDate || '';
};
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m) => (/^\d{4}-\d{2}$/.test(m) ? `${MONTH_NAMES[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}` : m);
const RSG_SORTS = [
  ['date-desc', 'Date (latest first)', null],
  ['date-asc', 'Date (oldest first)', null],
  ['new', 'Newest first', (a, b) => String(submittedOf(b)).localeCompare(String(submittedOf(a)))],
  ['old', 'Oldest first', (a, b) => String(submittedOf(a)).localeCompare(String(submittedOf(b)))],
  ['lwd', 'Last working day (soonest)', (a, b) => String(a.lastWorkingDate || '9999').localeCompare(String(b.lastWorkingDate || '9999'))],
];

const statusCls = (s) => (s === 'Relieved' ? 'active' : ['Withdrawn', 'Rejected'].includes(s) ? 'rejected' : s === 'Pending Approval' ? 'pending' : 'applied');

// ---- THE LETTER OF RESIGNATION (LOR) ----------------------------------------
// The form is laid out as the old HRMS "Letter of Resignation (LOR)": one card,
// the company / location / department and the employee's own details
// prefilled read-only, the relieving date computed as today + the notice
// period (HrConfig.noticePeriodDays, 45 when unset), the reason, who it is
// submitted to, and the employee's name as a signature. The same letter,
// read-only, is what the approver / HR opens (ResignationDetailModal).
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const FALLBACK_NOTICE_DAYS = 45;
const FIX_FIELDS = 'Fill in the highlighted fields.';
// Local calendar date (not UTC): the letter is dated the day the person sees.
const localIso = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function addDaysLocal(iso, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + Number(days || 0));
  return localIso(d);
}
// 2026-09-28 -> 28-SEP-2026
function lorDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}-${MONTHS[Number(m[2]) - 1]}-${m[1]}` : '—';
}

const IconList = () => (
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
    <path d="M3 5h2M8 5h9M3 10h2M8 10h9M3 15h2M8 15h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
  </svg>
);
const IconEnvelope = () => (
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
    <rect x="2.5" y="4.5" width="15" height="11" rx="1.6" stroke="currentColor" strokeWidth="1.6" fill="none" />
    <path d="M3 5.5l7 5.2 7-5.2" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinejoin="round" />
  </svg>
);
const IconPrint = () => (
  <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" focusable="false">
    <path d="M5.5 7.5V3h9v4.5M5.5 14H3.5v-6h13v6h-2M6 11.5h8V17H6z" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" />
  </svg>
);

function RO({ label, value }) {
  return (
    <div className="rsg-lor-ro">
      <label>{label}</label>
      <div className="rsg-lor-ro-val" role="textbox" aria-readonly="true" aria-label={label}>{value || '—'}</div>
    </div>
  );
}

// The picker with a list icon — the shared searchable Combo underneath.
function LorPicker({ value, onChange, invalid, children, placeholder }) {
  return (
    <div className={`rsg-lor-pick${invalid ? ' is-invalid' : ''}`}>
      <span className="rsg-lor-pick-ic"><IconList /></span>
      <Combo className="rsg-lor-combo" value={value} onChange={onChange} placeholder={placeholder} aria-invalid={invalid || undefined}>
        {children}
      </Combo>
    </div>
  );
}

const FieldError = ({ msg }) => (msg ? <div className="rsg-lor-err" role="alert">{msg}</div> : null);

// The letter's fixed top: title, date, company / location / department and
// the employee block. Shared by the form and the read-only view.
function LorHead({ dateIso, companyName, info }) {
  return (
    <>
      <div className="rsg-lor-head">
        <h2 className="rsg-lor-title">Letter of Resignation (LOR)</h2>
        <div className="rsg-lor-today">Today Date: <b>{lorDate(dateIso)}</b></div>
      </div>
      <div className="rsg-lor-grid">
        <RO label="Client Name" value={companyName} />
        <RO label="Client Location" value={info?.location} />
        <RO label="Department / Division" value={info?.department} />
        <RO label="Employee ID" value={info?.employeeCode} />
        <RO label="Employee Name" value={info?.name} />
        <RO label="Current Job Title" value={info?.designation} />
      </div>
    </>
  );
}

function LorSign({ name, dateIso }) {
  return (
    <div className="rsg-lor-sign">
      <span className="rsg-lor-script">{name || '—'}</span>
      <span className="rsg-lor-sign-date">{lorDate(dateIso)}</span>
    </div>
  );
}

// ---- THE FORM ---------------------------------------------------------------
function ResignationFormModal({ isHR, employees, me, onClose, onSaved }) {
  const [employeeId, setEmployeeId] = useState(isHR ? '' : (me || ''));
  const [cfg, setCfg] = useState(null);
  const [cfgError, setCfgError] = useState('');
  const [today] = useState(() => localIso());
  const [form, setForm] = useState({
    requestedLastWorkingDate: '', lwdTouched: false, editLwd: false,
    reason: '', comments: '', noticePeriodDays: '', submittingToUserId: '',
    handoverDetails: '', knowledgeTransferDetails: '', exitComments: '',
  });
  const [errs, setErrs] = useState({});
  const [tried, setTried] = useState(false);
  const { busy, error, setError, run } = useSubmit();
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // The employee block, company name, reasons, approvers, optional fields and
  // the notice default.
  useEffect(() => {
    setCfgError('');
    if (isHR && !employeeId) { setCfg((c) => (c ? { ...c, employee: null, openResignation: null, approvers: [] } : c)); return; }
    const q = employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : '';
    api.get(`/resignations/form${q}`)
      .then((res) => {
        setCfg(res.data);
        setForm((f) => ({
          ...f,
          noticePeriodDays: f.noticePeriodDays === '' ? String(res.data.noticePeriodDays ?? '') : f.noticePeriodDays,
          submittingToUserId: (res.data.approvers || []).some((a) => a.userId === f.submittingToUserId)
            ? f.submittingToUserId : (res.data.defaultApproverUserId || ''),
        }));
      })
      .catch((err) => setCfgError(err.response?.data?.error || 'Could not load the resignation form'));
  }, [employeeId, isHR]);

  const on = Object.fromEntries((cfg?.optionalFields || []).map((f) => [f.key, f.enabled]));
  const policyNotice = cfg?.noticePeriodDays ?? FALLBACK_NOTICE_DAYS;
  const notice = on.noticePeriod && form.noticePeriodDays !== '' && !Number.isNaN(Number(form.noticePeriodDays)) ? Number(form.noticePeriodDays) : policyNotice;
  // Last day = today + the notice period, until the person asks for their own
  // date (the existing flow lets them request a different one).
  const lwd = form.lwdTouched ? form.requestedLastWorkingDate : addDaysLocal(today, notice);
  const info = cfg?.employee;

  function validate() {
    const e = {};
    if (isHR && !employeeId) e.employee = 'Pick the employee who is resigning.';
    if (!lwd) e.lwd = 'The last day of employment is required.';
    else if (lwd < today) e.lwd = 'The last day cannot be before today.';
    if (!form.reason) e.reason = 'Pick the reason for resignation.';
    if (form.reason === 'Other' && !form.comments.trim()) e.comments = 'Describe the reason when you pick "Other".';
    if ((cfg?.approvers || []).length && !form.submittingToUserId) e.submittingTo = 'Pick who the resignation is submitted to.';
    if (on.noticePeriod && form.noticePeriodDays !== '') {
      const n = Number(form.noticePeriodDays);
      if (!Number.isInteger(n) || n < 0 || n > 365) e.notice = 'A whole number of days between 0 and 365.';
    }
    return e;
  }
  // Inline messages refresh as the person fixes things, once they tried.
  useEffect(() => {
    if (!tried) return;
    const e = validate();
    setErrs(e);
    if (!Object.keys(e).length) setError((m) => (m === FIX_FIELDS ? '' : m));
  }, [form, employeeId, cfg, tried]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    setTried(true);
    const e = validate();
    setErrs(e);
    if (Object.keys(e).length) { setError(FIX_FIELDS); return; }
    setError('');
    const describe = form.comments.trim();
    const body = {
      employeeId: employeeId || undefined,
      resignationDate: today,
      requestedLastWorkingDate: lwd,
      reason: form.reason,
      reasonOther: form.reason === 'Other' ? describe.split('\n')[0].slice(0, 500) : undefined,
      comments: describe || undefined,
      submittingToUserId: form.submittingToUserId || undefined,
    };
    if (on.noticePeriod && form.noticePeriodDays !== '') body.noticePeriodDays = Number(form.noticePeriodDays);
    if (on.handover) body.handoverDetails = form.handoverDetails.trim() || undefined;
    if (on.knowledgeTransfer) body.knowledgeTransferDetails = form.knowledgeTransferDetails.trim() || undefined;
    if (on.exitComments) body.exitComments = form.exitComments.trim() || undefined;
    const res = await run(() => api.post('/resignations', body), 'Could not submit the resignation');
    if (res) onSaved(res.data);
  }

  const blocked = !!cfg?.openResignation;
  const extras = on.noticePeriod || on.handover || on.knowledgeTransfer || on.exitComments;
  return (
    <Modal title="Submit Resignation" wide onClose={onClose}>
      <form className="rsg-lor" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        {isHR && (
          <div className={`field rsg-lor-who${errs.employee ? ' is-invalid' : ''}`}>
            <label>Employee<span className="rsg-lor-req"> *</span></label>
            <Combo value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">Select employee</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}{e.employeeCode ? ` · ${e.employeeCode}` : ''}</option>)}
            </Combo>
            <FieldError msg={errs.employee} />
          </div>
        )}
        <div className="rsg-lor-card">
          <LorHead dateIso={today} companyName={cfg?.companyName} info={info} />
          {isHR && !employeeId && <EmptyMini>Pick the employee to fill in their details.</EmptyMini>}
          {blocked && (
            <div className="rsg-warn" style={{ marginTop: 10 }}>
              There is already a resignation on file that is {cfg.openResignation.status.toLowerCase()}. It has to be decided or withdrawn first.
            </div>
          )}

          <h4 className="rsg-lor-sec">Date of Relieving</h4>
          <p className="rsg-lor-line">
            Please be advised that my last day of employment will be on{' '}
            <b className="rsg-lor-date" data-testid="lor-lwd">{lorDate(lwd)}</b>
          </p>
          <div className="rsg-lor-note">
            {form.lwdTouched
              ? <>You are requesting a different date than today + the {notice}-day notice period ({lorDate(addDaysLocal(today, notice))}). <button type="button" className="rsg-lor-link" onClick={() => setForm((f) => ({ ...f, lwdTouched: false, editLwd: false, requestedLastWorkingDate: '' }))}>Use the notice period</button></>
              : <>Today + {notice}-day notice period{on.noticePeriod && form.noticePeriodDays !== '' && Number(form.noticePeriodDays) !== policyNotice ? '' : ' (company policy)'}. <button type="button" className="rsg-lor-link" onClick={() => set('editLwd', true)}>Request a different date</button></>}
          </div>
          {(form.editLwd || form.lwdTouched) && (
            <div className={`field rsg-lor-lwd${errs.lwd ? ' is-invalid' : ''}`}>
              <label htmlFor="rsg-lwd">Requested last working date</label>
              <input id="rsg-lwd" type="date" value={lwd} min={today} onChange={(e) => setForm((f) => ({ ...f, requestedLastWorkingDate: e.target.value, lwdTouched: true }))} />
              <div className="compose-hint">Your approvers can agree it or set the date on final approval.</div>
            </div>
          )}
          <FieldError msg={errs.lwd} />

          <h4 className="rsg-lor-sec">Reason for Resignation</h4>
          <p className="rsg-lor-line">The reason for my resignation is as follows:</p>
          <div className="rsg-lor-two">
            <div className={`field${errs.reason ? ' is-invalid' : ''}`}>
              <label>Reason for resignation<span className="rsg-lor-req"> *</span></label>
              <LorPicker value={form.reason} onChange={(e) => set('reason', e.target.value)} invalid={!!errs.reason}>
                <option value="">Select reason</option>
                {(cfg?.reasons || []).map((r) => <option key={r} value={r}>{r}</option>)}
              </LorPicker>
              <FieldError msg={errs.reason} />
            </div>
            <div className={`field${errs.submittingTo ? ' is-invalid' : ''}`}>
              <label>Resignation Submitting To<span className="rsg-lor-req"> *</span></label>
              <LorPicker value={form.submittingToUserId} onChange={(e) => set('submittingToUserId', e.target.value)} invalid={!!errs.submittingTo}>
                <option value="">Select person</option>
                {(cfg?.approvers || []).map((a) => <option key={a.userId} value={a.userId}>{a.name} — {a.label}</option>)}
              </LorPicker>
              <FieldError msg={errs.submittingTo} />
              {cfg && info && !(cfg.approvers || []).length && <div className="compose-hint">Nobody sits above this employee on the approval chain — it is approved on submission.</div>}
            </div>
          </div>
          <div className={`field${errs.comments ? ' is-invalid' : ''}`}>
            <label htmlFor="rsg-describe">Describe reason{form.reason === 'Other' && <span className="rsg-lor-req"> *</span>}</label>
            <textarea id="rsg-describe" rows="4" value={form.comments} onChange={(e) => set('comments', e.target.value)} placeholder="Anything you want your approvers to know" />
            <FieldError msg={errs.comments} />
          </div>
          <AiAssist kind="resignation" title={`Resignation — ${form.reason || 'reason'}`} text={form.comments} onText={(comments) => set('comments', comments)} />

          {extras && (
            <details className="rsg-lor-extra" open={!!(form.handoverDetails || form.knowledgeTransferDetails || form.exitComments || errs.notice)}>
              <summary>Additional details (optional)</summary>
              {on.noticePeriod && (
                <div className={`field${errs.notice ? ' is-invalid' : ''}`} style={{ maxWidth: 260 }}>
                  <label>Notice Period (days)</label>
                  <input type="number" min="0" max="365" value={form.noticePeriodDays} onChange={(e) => set('noticePeriodDays', e.target.value)} />
                  <div className="compose-hint">Company policy: {policyNotice} days.</div>
                  <FieldError msg={errs.notice} />
                </div>
              )}
              {on.handover && (
                <Field label="Handover Details">
                  <textarea rows="3" value={form.handoverDetails} onChange={(e) => set('handoverDetails', e.target.value)} placeholder="Who takes over what, open items, accounts" />
                </Field>
              )}
              {on.knowledgeTransfer && (
                <Field label="Knowledge Transfer Details">
                  <textarea rows="3" value={form.knowledgeTransferDetails} onChange={(e) => set('knowledgeTransferDetails', e.target.value)} placeholder="Sessions planned, documents, recipients" />
                </Field>
              )}
              {on.exitComments && (
                <Field label="Exit Comments">
                  <textarea rows="3" value={form.exitComments} onChange={(e) => set('exitComments', e.target.value)} />
                </Field>
              )}
            </details>
          )}

          <div className="rsg-lor-foot">
            <LorSign name={info?.name} dateIso={today} />
            {(error || cfgError) && <div className="error-text rsg-lor-foot-err">{error || cfgError}</div>}
            <div className="rsg-lor-actions">
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary rsg-lor-submit" disabled={busy || blocked}>
                <IconEnvelope /> {busy ? 'Submitting…' : 'Submit Resignation'}
              </button>
            </div>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// The filed letter, read-only — what the approver / HR opens and prints.
function LorLetter({ r, companyName, submittingTo }) {
  const f = r.form || {};
  const info = r.employeeInfo || {};
  const dateIso = f.resignationDate || (r.submittedAt ? localIso(new Date(r.submittedAt)) : '');
  const lwd = f.approvedLastWorkingDate || f.requestedLastWorkingDate || r.lastWorkingDate;
  return (
    <div className="rsg-lor-card rsg-lor-view">
      <LorHead dateIso={dateIso} companyName={companyName} info={info} />
      <h4 className="rsg-lor-sec">Date of Relieving</h4>
      <p className="rsg-lor-line">
        Please be advised that my last day of employment will be on <b className="rsg-lor-date">{lorDate(f.requestedLastWorkingDate || lwd)}</b>
      </p>
      {f.approvedLastWorkingDate && f.approvedLastWorkingDate !== f.requestedLastWorkingDate && (
        <div className="rsg-lor-note">Approved last working date: <b>{lorDate(f.approvedLastWorkingDate)}</b></div>
      )}
      <div className="rsg-lor-note">Notice period: {r.noticePeriodDays != null ? `${r.noticePeriodDays} days` : '—'}</div>
      <h4 className="rsg-lor-sec">Reason for Resignation</h4>
      <p className="rsg-lor-line">The reason for my resignation is as follows:</p>
      <div className="rsg-lor-two">
        <RO label="Reason for resignation" value={f.reason === 'Other' && f.reasonOther && !String(f.comments || '').startsWith(f.reasonOther) ? `Other: ${f.reasonOther}` : (f.reason || r.reason)} />
        <RO label="Resignation Submitting To" value={submittingTo || info.reportingManager} />
      </div>
      <div className="rsg-lor-ro rsg-lor-ro-text">
        <label>Describe reason</label>
        <div className="rsg-lor-text">{f.comments || r.notes || '—'}</div>
      </div>
      {f.handoverDetails && <div className="rsg-lor-ro rsg-lor-ro-text"><label>Handover Details</label><div className="rsg-lor-text">{f.handoverDetails}</div></div>}
      {f.knowledgeTransferDetails && <div className="rsg-lor-ro rsg-lor-ro-text"><label>Knowledge Transfer Details</label><div className="rsg-lor-text">{f.knowledgeTransferDetails}</div></div>}
      {f.exitComments && <div className="rsg-lor-ro rsg-lor-ro-text"><label>Exit Comments</label><div className="rsg-lor-text">{f.exitComments}</div></div>}
      <div className="rsg-lor-foot">
        <LorSign name={info.name} dateIso={dateIso} />
      </div>
    </div>
  );
}

// Print just the letter, in its own window (falls back to the page's print).
const PRINT_CSS = `
  body{font-family:"Public Sans",system-ui,"Segoe UI",sans-serif;color:#16202B;margin:24px}
  .rsg-lor-card{border:1px solid #DDE3EC;border-radius:10px;padding:22px 26px;max-width:820px;margin:0 auto}
  .rsg-lor-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;border-bottom:2px solid #2B4F86;padding-bottom:8px;margin-bottom:14px}
  .rsg-lor-title{color:#2B4F86;font-size:20px;margin:0}
  .rsg-lor-today{font-size:13px}
  .rsg-lor-grid,.rsg-lor-two{display:grid;grid-template-columns:repeat(3,1fr);gap:10px 16px}
  .rsg-lor-two{grid-template-columns:1fr 1fr;margin-top:6px}
  .rsg-lor-ro{display:flex;flex-direction:column;gap:3px;margin-bottom:6px}
  .rsg-lor-ro label{font-size:11px;color:#53637A}
  .rsg-lor-ro-val,.rsg-lor-text{border:1px solid #DDE3EC;border-radius:6px;padding:6px 8px;font-size:13px;background:#F5F7FA;font-family:inherit;color:inherit}
  .rsg-lor-text{white-space:pre-wrap;min-height:40px}
  .rsg-lor-sec{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#1F3864;margin:18px 0 4px}
  .rsg-lor-line{margin:4px 0;font-size:14px}
  .rsg-lor-date{color:#1F3864}
  .rsg-lor-note{font-size:12px;color:#53637A}
  .rsg-lor-foot{display:flex;justify-content:flex-end;margin-top:26px}
  .rsg-lor-sign{display:flex;flex-direction:column;align-items:flex-end;gap:2px}
  .rsg-lor-script{font-family:"Segoe Script","Brush Script MT","Lucida Handwriting",cursive;font-size:24px;color:#1F3864;border-bottom:1px solid #8695A9;padding:0 6px 2px}
  .rsg-lor-sign-date{font-size:12px;color:#53637A}
`;
function printLetter(node, title) {
  if (!node) return;
  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) { window.print(); return; }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  w.document.write(`<!doctype html><html><head><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>${node.outerHTML}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => { try { w.print(); } catch { /* the window was closed */ } }, 150);
}

// ---- ONE RESIGNATION: the letter as filed + its full approval history -------
function ResignationDetailModal({ id, isHR, myEmployeeId, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [lwd, setLwd] = useState('');
  const letterRef = useRef(null);

  function load() {
    setLoadError('');
    api.get(`/resignations/${id}`)
      .then((res) => { setData(res.data); setLwd(''); })
      .catch((err) => setLoadError(err.response?.data?.error || 'Could not load the resignation'));
  }
  useEffect(load, [id]);

  async function act(fn, fallback) {
    setError('');
    setBusy(true);
    try {
      await fn();
      load();
      onChanged();
    } catch (err) {
      setError(err.response?.data?.error || fallback);
    } finally {
      setBusy(false);
    }
  }
  const decide = (decision, remarks) => act(() => api.patch(`/resignations/${id}/status`, {
    status: decision === 'Approved' ? 'Accepted' : 'Rejected',
    reason: remarks || undefined,
    lastWorkingDate: decision === 'Approved' && lwd ? lwd : undefined,
  }), 'Could not record the decision');

  const r = data;
  const f = r?.form;
  const wf = r?.workflow;
  const mayDecide = wf && wf.state === 'Pending' && (wf.canAct || wf.canDirect);
  const lastStep = wf && wf.state === 'Pending' && (wf.canDirect || (wf.approvalLevelNo && wf.approvalLevelNo === wf.approvalLevelCount));
  const mine = r && myEmployeeId && r.employeeId === myEmployeeId;

  return (
    <Modal
      title="Letter of Resignation" onClose={onClose} wide
      footer={(
        <>
          {r && <button className="btn" onClick={() => printLetter(letterRef.current, `Letter of Resignation — ${r.employeeInfo?.name || ''}`)}><IconPrint /> Print</button>}
          <button className="btn" onClick={onClose}>Close</button>
        </>
      )}
    >
      {loadError && <div className="error-text">{loadError}</div>}
      {!r && !loadError && <EmptyMini>Loading…</EmptyMini>}
      {r && (
        <div className="rsg">
          <div ref={letterRef}>
            <LorLetter r={r} companyName={r.companyName} submittingTo={r.submittingTo} />
          </div>

          <div className="rsg-section" style={{ marginTop: 16 }}>Status</div>
          <div className="rsg-info">
            <div><span>Status</span><b><span className={`status ${statusCls(r.status)}`}>{r.status}</span></b></div>
            <div><span>Requested Last Working Date</span><b>{f?.requestedLastWorkingDate ? lorDate(f.requestedLastWorkingDate) : '—'}</b></div>
            <div><span>Approved Last Working Date</span><b>{f?.approvedLastWorkingDate ? lorDate(f.approvedLastWorkingDate) : (SERVING.includes(r.status) && r.lastWorkingDate ? lorDate(r.lastWorkingDate) : '—')}</b></div>
            <div><span>Submitted</span><b>{r.submittedAt ? fmtDateTime(r.submittedAt) : '—'}</b></div>
            <div><span>Submitted By</span><b>{r.submittedBy || r.employeeInfo?.name || '—'}</b></div>
            <div><span>Reporting Manager</span><b>{r.employeeInfo?.reportingManager || '—'}</b></div>
          </div>

          <SectionLabel style={{ marginTop: 16 }}>Approval Chain</SectionLabel>
          {mayDecide && lastStep && (
            <Field label="Approved last working date (optional)" hint={`Blank keeps the requested date (${f?.requestedLastWorkingDate ? lorDate(f.requestedLastWorkingDate) : '—'}). Used only when this approval is the final one.`}>
              <input type="date" value={lwd} min={f?.resignationDate || undefined} onChange={(e) => setLwd(e.target.value)} />
            </Field>
          )}
          <ApprovalChain workflow={wf} onDecide={decide} busy={busy} error={error} recordStatus={r.status} />

          <div className="rsg-actions">
            {mine && OPEN.includes(r.status) && (
              <button className="btn btn-sm" disabled={busy} onClick={() => { if (window.confirm('Withdraw your resignation?')) act(() => api.patch(`/resignations/${id}/withdraw`), 'Could not withdraw'); }}>Withdraw my resignation</button>
            )}
            {isHR && SERVING.includes(r.status) && (
              <button className="btn btn-sm" disabled={busy} onClick={() => act(() => api.patch(`/resignations/${id}/status`, { status: 'Relieved' }), 'Could not relieve')}>Mark Relieved</button>
            )}
          </div>
          {!mayDecide && error && <div className="error-text">{error}</div>}
        </div>
      )}
    </Modal>
  );
}

// ---- HR: which optional fields the form shows, and the reasons ---------------
function FormSettingsModal({ onClose }) {
  const [cfg, setCfg] = useState(null);
  const [reasons, setReasons] = useState('');
  const [enabled, setEnabled] = useState([]);
  const { busy, error, run } = useSubmit();
  useEffect(() => {
    api.get('/resignations/form').then((res) => {
      setCfg(res.data);
      setReasons(res.data.reasons.filter((r) => r !== 'Other').join('\n'));
      setEnabled(res.data.optionalFields.filter((f) => f.enabled).map((f) => f.key));
    });
  }, []);
  async function save() {
    const res = await run(() => api.put('/resignations/form-config', {
      reasons: reasons.split('\n').map((r) => r.trim()).filter(Boolean),
      optionalFields: enabled,
    }), 'Could not save the settings');
    if (res) onClose();
  }
  return (
    <ComposeModal title="Resignation Form Settings" onClose={onClose} onSubmit={save} submitLabel="Save Settings" busy={busy} error={error}>
      {!cfg ? <EmptyMini>Loading…</EmptyMini> : (
        <div className="rsg-settings">
          <Field label="Reasons offered" hint="One per line. “Other” is always offered and asks for the reason in words.">
            <textarea rows="7" value={reasons} onChange={(e) => setReasons(e.target.value)} />
          </Field>
          <Field label="Optional fields on the form" hint={`The Notice Period field defaults to the policy (${cfg.noticePeriodDays} days).`}>
            <div className="rsg-checks">
              {cfg.optionalFields.map((f) => (
                <CheckLine key={f.key} checked={enabled.includes(f.key)} onChange={(v) => setEnabled((e) => (v ? [...e, f.key] : e.filter((k) => k !== f.key)))}>{f.label}</CheckLine>
              ))}
            </div>
          </Field>
        </div>
      )}
    </ComposeModal>
  );
}

export default function Resignation() {
  const { user } = useAuth();
  // isHR here DRAWS WRITE CONTROLS, so it asks the write permission and not
  // only the read one. Approving is NOT one of them: approve / reject lives in
  // each resignation's chain view and is offered to whoever's turn it is (or
  // a Super Admin, directly) — the API refuses anything out of turn.
  const hrView = hasHrmsAdmin(user);
  const isHR = hrView && canDecideServices(user);
  const canConfigure = can(user, 'hrms', 'hrms', 'Employee Services', 'configure');
  const [records, setRecords] = useState([]);
  const [pf, setPf] = useState(RSG_EMPTY);
  const [sort, setSort] = useState('date-desc');
  // Date-wise: which date, then year / month; plus where the record came from.
  const [basis, setBasis] = useState('relieving');
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');
  const [source, setSource] = useState('');
  const [rtype, setRtype] = useState('');
  const [summary, setSummary] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState('');
  const [recording, setRecording] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [settings, setSettings] = useState(false);

  function load() {
    api.get('/resignations').then((res) => setRecords(res.data)).catch((err) => setError(err.response?.data?.error || 'Could not load resignations'));
    if (isHR) {
      api.get('/resignations/summary').then((res) => setSummary(res.data)).catch(() => setSummary(null));
      api.get('/employees').then((res) => setEmployees(res.data)).catch(() => setEmployees([]));
    }
  }
  useEffect(load, [isHR]);

  async function relieve(r) {
    setError('');
    try {
      await api.patch(`/resignations/${r.id}/status`, { status: 'Relieved' });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update the resignation');
    }
  }

  const checklist = summary?.exitChecklist || [
    'Exit interview scheduled', 'Assets returned', 'Access revoked',
    'Full & final settlement processed', 'Experience letter issued',
  ];
  const pendingApproval = records.filter((r) => r.status === 'Pending Approval').length;
  const serving = records.filter((r) => SERVING.includes(r.status)).length;
  const relieved = records.filter((r) => r.status === 'Relieved').length;
  const isMine = (r) => r.workflow && r.workflow.currentOwnerUserId === user?.id;
  // Everything except the year / month choice — the base the month totals count.
  const base = records.filter((r) => peopleMatches(r, pf, undefined, undefined, submittedOf)
    && textMatches(`${r.employee?.name || ''} ${r.employee?.employeeCode || ''} ${r.reason || ''} ${r.type || ''} ${r.notes || ''}`, pf.q)
    && (!pf.reason || r.reason === pf.reason)
    && (!pf.waiting || isMine(r))
    && (!source || r.source === source)
    && (!rtype || (r.type || '') === rtype));
  const byDate = (dir) => (a, b) => {
    const x = keyDate(a, basis); const y = keyDate(b, basis);
    if (!x && !y) return 0;
    if (!x) return 1; // undated last, whichever direction
    if (!y) return -1;
    return dir * x.localeCompare(y);
  };
  const sorter = sort === 'date-desc' ? byDate(-1) : sort === 'date-asc' ? byDate(1) : (RSG_SORTS.find(([k]) => k === sort) || RSG_SORTS[0])[2];
  const shown = base.filter((r) => {
    const d = keyDate(r, basis);
    if (month === 'No date') return !d;
    return (!year || d.startsWith(year)) && (!month || d.slice(0, 7) === month);
  }).sort(sorter);
  // TOTALS PER MONTH of the chosen date, for the current filters.
  const monthTotals = Object.entries(base.reduce((o, r) => {
    const d = keyDate(r, basis);
    const m = d ? d.slice(0, 7) : 'No date';
    if (year && m !== 'No date' && !m.startsWith(year)) return o;
    return { ...o, [m]: (o[m] || 0) + 1 };
  }, {})).sort(([a], [b]) => (a === 'No date' ? 1 : b === 'No date' ? -1 : b.localeCompare(a)));
  const years = [...new Set(base.map((r) => keyDate(r, basis).slice(0, 4)).filter(Boolean))].sort().reverse();
  const types = [...new Set(records.map((r) => r.type).filter(Boolean))].sort();
  const importedCount = records.filter((r) => r.source === 'Imported').length;
  const page = usePaged(shown);
  const opts = peopleOptions(records);
  const reasons = [...new Set(records.map((r) => r.reason).filter(Boolean))].sort();
  const waitingOnMe = records.filter(isMine).length;
  const setF = (k, v) => setPf((f) => ({ ...f, [k]: v }));
  const pfLike = { activeCount: Object.values(pf).filter(Boolean).length, clear: () => setPf(RSG_EMPTY) };

  return (
    <div className="rsg">
      <QaRow style={{ marginBottom: 14 }}>
        <button className="btn btn-primary btn-sm" onClick={() => { setError(''); setRecording(true); }}>+ Submit Resignation</button>
        {canConfigure && <button className="btn btn-sm" onClick={() => setSettings(true)}>Form Settings</button>}
        {/* Export (everyone in scope / one employee) + import of resignation
            history with the compulsory sample. The Super Admin is notified. */}
        <DataIoBar ioKey="resignation" params={{ status: pf.status || undefined }} onImported={load} />
      </QaRow>
      {error && <div className="error-text">{error}</div>}
      {recording && (
        <ResignationFormModal
          isHR={isHR}
          employees={employees}
          me={user?.employeeId}
          onClose={() => setRecording(false)}
          onSaved={(saved) => { setRecording(false); load(); if (saved?.id) setOpenId(saved.id); }}
        />
      )}
      {openId && (
        <ResignationDetailModal id={openId} isHR={isHR} myEmployeeId={user?.employeeId} onClose={() => setOpenId(null)} onChanged={load} />
      )}
      {settings && <FormSettingsModal onClose={() => setSettings(false)} />}

      <StatRow cells={[
        { value: summary?.pendingApproval ?? pendingApproval, label: 'Pending Approval' },
        { value: summary?.servingNotice ?? serving, label: 'Serving Notice' },
        { value: summary?.relieved ?? relieved, label: 'Relieved' },
        { value: importedCount, label: 'Imported history' },
        { value: summary?.noticePeriodDays ?? 45, label: 'Notice Period (days)' },
      ]} />

      <TwoCol style={{ alignItems: 'start', marginTop: 14 }}>
        <PanelPad>
          <NumHead n={1} title="Resignations" />
          <div className="cell-muted" style={{ fontSize: 11.5, marginBottom: 6 }}>
            Each resignation climbs Employee → TL → STL → HR → Assistant Manager → Manager → Super Admin. Open one to see its full history
            {waitingOnMe ? <> — <b>{waitingOnMe} waiting on you</b></> : null}.
            Resigning never disables the login on its own.
          </div>
          <PeopleFilterBar
            filters={pf} setFilters={setPf} people={hrView} search="Resignations"
            departments={hrView ? opts.departments : undefined} roles={hrView ? opts.roles : undefined}
            statuses={statusOptions(records, RESIGNATION_STATUSES)} shown={shown.length} total={records.length}
            style={{ marginTop: 6 }}
            dates="Submitted on" labels={{ reason: 'Reason', waiting: 'Approval' }} moreKeys={['waiting']}
            more={waitingOnMe || pf.waiting ? (
              <Combo value={pf.waiting} title="Approval" onChange={(e) => setF('waiting', e.target.value)}>
                <option value="">Waiting on anyone</option>
                <option>Waiting on me</option>
              </Combo>
            ) : null}
          >
            {reasons.length > 0 && (
              <Combo value={pf.reason} title="Reason" onChange={(e) => setF('reason', e.target.value)}>
                <option value="">All reasons</option>
                {reasons.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            )}
            <Combo value={basis} title="Date" onChange={(e) => { setBasis(e.target.value); setYear(''); setMonth(''); }}>
              {DATE_BASES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Combo>
            <Combo value={year} title="Year" onChange={(e) => { setYear(e.target.value); setMonth(''); }}>
              <option value="">All years</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </Combo>
            <Combo value={month} title="Month" onChange={(e) => setMonth(e.target.value)}>
              <option value="">All months</option>
              {monthTotals.map(([m, n]) => <option key={m} value={m}>{monthLabel(m)} ({n})</option>)}
            </Combo>
            <Combo value={source} title="Source" onChange={(e) => setSource(e.target.value)}>
              <option value="">Live + imported history</option>
              <option value="TeamLink">Submitted in TeamLink</option>
              <option value="Imported">Imported history</option>
            </Combo>
            {types.length > 0 && (
              <Combo value={rtype} title="Type" onChange={(e) => setRtype(e.target.value)}>
                <option value="">All types</option>
                {types.map((t) => <option key={t} value={t}>{t}</option>)}
              </Combo>
            )}
            <label className="lf-sort">
              Sort
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                {RSG_SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
          </PeopleFilterBar>
          {shown.length === 0 ? <ListEmpty lf={pfLike} noun="resignations" title="No resignations on file." /> : page.slice.map((r) => (
            <AssignRow key={r.id}>
              <span style={{ minWidth: 0 }}>
                <b>{r.employee?.name}</b> <span className="cell-muted">{r.employee?.department || ''}</span><br />
                <span className="rsg-row-meta">
                  {r.source === 'Imported' ? (
                    <>
                      <span className="rsg-hist">Imported history</span>
                      {' '}{r.type || 'Relieved'}{r.reason ? ` · ${r.reason}` : ''}
                      {' · '}Relieved {r.relievingDate || <i>date not recorded</i>}
                      {r.employee?.employeeCode ? ` · ${r.employee.employeeCode}` : ''}
                    </>
                  ) : (
                    <>
                      {r.reason || 'Resignation'}{r.type ? ` (${r.type})` : ''} · Submitted {fmtDateTime(r.submittedAt)}
                      {r.resignationDate ? ` · Resigned ${r.resignationDate}` : ''}
                      {' · '}{r.status === 'Relieved' ? 'Relieved' : 'Last working day'} {r.lastWorkingDate || '—'}
                    </>
                  )}
                  {r.daysLeft != null ? ` · ${r.daysLeft >= 0 ? `${r.daysLeft} day(s) left` : 'past'}` : ''}
                </span>
                {r.workflow && <ApprovalChainLine workflow={r.workflow} compact />}
                {r.workflow?.state === 'Pending' && r.workflow.currentApprover && (
                  <div className="rsg-row-meta">With {r.workflow.approvalLevel}: <b>{r.workflow.currentApprover}</b></div>
                )}
              </span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                <span className={`status ${statusCls(r.status)}`}>{r.status}</span>
                <button className="btn btn-sm" onClick={() => setOpenId(r.id)}>{r.workflow && (r.workflow.currentOwnerUserId === user?.id) ? 'Review' : 'View'}</button>
                {isHR && SERVING.includes(r.status) && <button className="btn btn-sm" onClick={() => relieve(r)}>Relieve</button>}
              </span>
            </AssignRow>
          ))}
          {shown.length > 0 && <Pager page={page} noun="resignations" />}
        </PanelPad>
        <div>
        <PanelPad>
          <NumHead n={2} title={`Totals per month — ${(DATE_BASES.find(([k]) => k === basis) || DATE_BASES[0])[1]}`} />
          <div className="cell-muted" style={{ fontSize: 11.5, marginBottom: 6 }}>
            For the filters on the left{year ? ` · ${year}` : ''}. Click a month to list it.
          </div>
          <div className="rsg-months">
            {monthTotals.length === 0 ? <span className="cell-muted">Nothing to count.</span> : monthTotals.map(([m, n]) => (
              <button type="button" key={m} className={`rsg-month${month === m ? ' on' : ''}`} onClick={() => setMonth(month === m ? '' : m)}>
                <span>{monthLabel(m)}</span><b>{n}</b>
              </button>
            ))}
          </div>
          {monthTotals.length > 0 && (
            <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
              Total {monthTotals.reduce((t, [, n]) => t + n, 0)}{month ? <> · <button type="button" className="rsg-clear" onClick={() => setMonth('')}>clear month</button></> : null}
            </div>
          )}
        </PanelPad>
        <PanelPad style={{ marginTop: 14 }}>
          <NumHead n={3} title="Exit Checklist" />
          {checklist.map((c) => (
            <AssignRow flush key={c}><span>{c}</span><span className="cell-muted" style={{ fontSize: 11.5 }}>per exit</span></AssignRow>
          ))}
          <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 8 }}>
            Opened on the employee&apos;s offboarding tracker when the resignation is finally approved.
          </div>
        </PanelPad>
        </div>
      </TwoCol>
    </div>
  );
}
