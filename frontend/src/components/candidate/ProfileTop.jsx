import { useState } from 'react';
import api from '../../api';
import { initials } from '../../atsVocab';
import { productRole } from '../../permissions';
import Modal from '../Modal.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { mayEditProfile } from './EditCandidateProfile.jsx'; // adding a salary is an edit: Recruiter / Super Admin (2026-10-29)
import { SalaryFitChips, AddSalaryDialog } from '../SalaryFit.jsx'; // Salary fit chips + the gentle "Add salary"
import FitBreakdown, { useFitBreakdown } from '../match/FitBreakdown.jsx'; // Fit = Resume · AI · Location · Salary
import { ContactButtons } from './ProfileSlots.jsx';
import { recordedAs, IMPORTED_SOURCE, longDay, CAME_KIND_TEXT } from '../../utils/candidateSource.js';
import './ProfileTop.css';

// ---------------------------------------------------------------------------
// The profile's TOP (Candidates §7): initials circle, name, phone, email,
// location, current step, and the big Call / WhatsApp / Mail / SMS buttons
// (ContactButtons slot). Shared by the big window and the full page.
//
// ProfileTools: Archive / Bring back (Team lead, Admin, Super Admin) and the
// real Delete (Super Admin only, duplicate or wrong entry only) — the server
// checks every rule again (routes/candidatesBoard.js).
// ---------------------------------------------------------------------------
const code = (c) => c.code || `CAN-${String(c.id || '').slice(-8).toUpperCase()}`;
// Archive for the Recruiter too, Delete (wrong entry) for the TL too (founder 2026-10-31); the server keeps each to their own area
const ARCHIVE_ROLES = ['SUPER_ADMIN', 'ADMIN', 'STL', 'TL', 'RECRUITER'];
const DELETE_LEADS = ['ADMIN', 'STL', 'TL'];
const hasRole = (user, list) => !!user && (list.includes(user.role) || list.includes(productRole(user, 'ats')));
export const mayArchive = (user) => !!user && (ARCHIVE_ROLES.includes(user.role) || ARCHIVE_ROLES.includes(productRole(user, 'ats')));
export const isSuperAdmin = (user) => !!user && (user.role === 'SUPER_ADMIN' || productRole(user, 'ats') === 'SUPER_ADMIN');

// "Came from Naukri on 12 Oct 2026, added by Asha" — says what the date means when it is not the real arrival day.
function CameLine({ c }) {
  const known = c.sourceKey && c.sourceKey !== IMPORTED_SOURCE;
  const day = c.cameOnDay ? longDay(c.cameOnDay) : null;
  const kind = c.cameOnKind;
  let text = known ? `Came from ${c.sourceKey}` : 'Source not recorded';
  if (day) {
    if (kind === 'imported') text += ` · loaded into TeamLink on ${day}`;
    else if (kind === 'sheet') text += ` · ${day} (date from the old sheet)`;
    else if (kind === 'applied') text += ` · applied on ${day}`;
    else text += ` · on ${day}`;
  }
  if (c.addedByName) text += `, added by ${c.addedByName}`;
  const title = [recordedAs(c), day ? `${day}: ${CAME_KIND_TEXT[kind] || ''}` : null].filter(Boolean).join(' · ');
  return (
    <div className={`cpt-came${known ? '' : ' is-unknown'}${kind === 'imported' ? ' is-imported' : ''}`} title={title || undefined}>
      <span aria-hidden="true">🧲</span>
      {' '}
      {text}
    </div>
  );
}

const JOINED_STAGES = ['JOINED', 'HIRED'];
// "Joined on 12 Oct 2026" beside the Joined step (one rule on the server: utils/joinDayShared.js). When the shown application is not the
// joined one, the joined application is named: "Joined on 12 Oct 2026 (Requirement X, Client Y)". Never blank, never today's date.
function JoinedOn({ c, app }) {
  if (!app) return null;
  if (JOINED_STAGES.includes(app.stage)) {
    return <span className="small-muted cpt-joinedon">{app.joiningDay ? ` · Joined on ${longDay(app.joiningDay)}` : ' · Joined (date not recorded)'}</span>;
  }
  const others = (c.applications || []).filter((a) => a.id !== app.id && JOINED_STAGES.includes(a.stage));
  if (!others.length) return null;
  const best = [...others].sort((x, y) => String(y.joiningDay || '').localeCompare(String(x.joiningDay || '')))[0];
  const r = best.requirement || {};
  const where = [r.title || best.requirementTitle, r.internal ? 'TeamLink (internal)' : ((r.client && r.client.name) || best.clientName)].filter(Boolean).join(', ');
  return (
    <div className="small-muted cpt-joinedon" style={{ marginTop: 4 }}>
      {best.joiningDay ? `Joined on ${longDay(best.joiningDay)}` : 'Joined (date not recorded)'}
      {where ? ` (${where})` : ''}
    </div>
  );
}

export default function ProfileTop({
  c, app, internal, onChanged, extra = null,
}) {
  const [addSalary, setAddSalary] = useState(false);
  const fitB = useFitBreakdown(app ? app.id : null); // the Fit for THIS job: total + Resume · AI · Location · Salary
  if (!c) return null;
  const stage = app ? (app.stageLabel || app.stageGroupLabel) : null;
  // Salary fit for THIS job (server-shaped for the viewer). Old record without salary: "Add salary" (not for the BDE team).
  const fit = app && app.salaryFit ? app.salaryFit : null;
  const { user } = useAuth();
  const mayAdd = !!c.salaryMissing && (!fit || fit.prompt === 'Add salary') && mayEditProfile(user);
  return (
    <div className="cpt">
      <span className="cpt-ini" aria-hidden="true">{initials(c.name)}</span>
      <div className="cpt-main">
        <div className="cpt-name">
          {c.name}
          <span className="cpt-code" title={c.id}>{code(c)}</span>
          {c.profileStatus === 'Archived' && <span className="cpt-flag is-orange">Archived</span>}
          {c.profileStatus === 'Do Not Use' && <span className="cpt-flag is-red">Do not use</span>}
        </div>
        <div className="cpt-facts">
          {c.phone && <span>{c.phone}</span>}
          {c.email && <span className="cpt-email">{c.email}</span>}
          {c.location && <span>{c.location}</span>}
          {c.experienceYears != null && <span>{`${c.experienceYears} yrs exp`}</span>}
          {/* Came from <source> on <date>, added by <name> (TeamLink logins only: the server sends these to nobody else). */}
        </div>
        {c.sourceKey && <CameLine c={c} />}
        <div className="cpt-step">
          <span className="small-muted">Current step:</span>
          {' '}
          {stage ? <StatusChip status={app.stageGroupLabel || stage}>{stage}</StatusChip> : <span className="small-muted">Not in any requirement yet</span>}
          {app && app.requirement && <span className="small-muted">{` · ${app.requirement.title || ''}`}</span>}
          {app && JOINED_STAGES.includes(app.stage) && <JoinedOn c={c} app={app} />}
        </div>
        {app && !JOINED_STAGES.includes(app.stage) && <JoinedOn c={c} app={app} />}
        {fitB && (
          <div className="cpt-step" style={{ marginTop: 6 }}>
            <FitBreakdown b={fitB} showFormula />
          </div>
        )}
        {(fit || mayAdd) && (
          <div className="cpt-step" style={{ marginTop: 6 }}>
            <span className="small-muted">Salary fit:</span>
            {' '}
            {fit ? <SalaryFitChips fit={fit} onAdd={mayAdd ? () => setAddSalary(true) : undefined} showBudget /> : null}
            {!fit && mayAdd && <button type="button" className="sfit-chip sfit-grey sfit-btn" onClick={() => setAddSalary(true)}>+ Add salary</button>}
          </div>
        )}
        {addSalary && <AddSalaryDialog candidateId={c.id} name={c.name} current={c.currentSalary || ''} expected={c.expectedSalary || ''} onClose={() => setAddSalary(false)} onSaved={onChanged} />}
      </div>
      <div className="cpt-btns">
        <ContactButtons c={c} app={app} internal={internal} onChanged={onChanged} />
        {extra}
      </div>
    </div>
  );
}

export function ProfileTools({
  c, user, onChanged, onDeleted,
}) {
  const [dlg, setDlg] = useState(null); // 'archive' | 'delete'
  const [reason, setReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const archived = c.profileStatus === 'Archived';
  const canArchive = mayArchive(user) && c.profileStatus !== 'Do Not Use';
  const canDelete = isSuperAdmin(user) || hasRole(user, DELETE_LEADS);
  if (!canArchive && !canDelete) return null;

  async function doArchive(on) {
    setBusy(true); setMsg(null);
    try {
      await api.post(`/candidates/${c.id}/${on ? 'archive' : 'unarchive'}`, { reason });
      setDlg(null); setReason('');
      setMsg({ ok: true, text: on ? `${c.name} is archived — hidden from every list. Nothing was deleted.` : `${c.name} is back in the lists.` });
      if (onChanged) onChanged();
    } catch (err) {
      setMsg({ ok: false, text: err.response?.data?.error || 'That did not work. Try again.' });
    } finally { setBusy(false); }
  }
  async function doDelete() {
    setBusy(true); setMsg(null);
    try {
      await api.delete(`/candidates/${c.id}`, { data: { reason, confirmName } });
      setDlg(null);
      if (onDeleted) onDeleted(c);
    } catch (err) {
      setMsg({ ok: false, text: err.response?.data?.error || 'Could not delete. Please try again.' });
      setDlg(null);
    } finally { setBusy(false); }
  }

  return (
    <div className="cpt-tools">
      {canArchive && !archived && <button type="button" className="btn btn-sm" onClick={() => { setReason(''); setDlg('archive'); }}>Archive</button>}
      {canArchive && archived && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => doArchive(false)}>Bring back</button>}
      {canDelete && <button type="button" className="btn btn-sm btn-ghost cpt-del" onClick={() => { setReason(''); setConfirmName(''); setDlg('delete'); }}>Delete (wrong entry)</button>}
      {msg && <span className={msg.ok ? 'cpt-ok' : 'error-text'}>{msg.text}</span>}

      {dlg === 'archive' && (
        <Modal
          title={`Archive ${c.name}?`}
          onClose={() => setDlg(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setDlg(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={busy || !reason.trim()} onClick={() => doArchive(true)}>Archive</button>
            </>
          )}
        >
          <div className="small-muted" style={{ marginBottom: 8 }}>
            Archived people are hidden from every list. Nothing is deleted. You can bring them back from People → Archived.
          </div>
          <label className="field">
            <span>Why?</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Not looking for a job any more" />
          </label>
        </Modal>
      )}

      {dlg === 'delete' && (
        <Modal
          title={`Delete ${c.name} for good?`}
          onClose={() => setDlg(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setDlg(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy || !reason || confirmName.trim().toLowerCase() !== String(c.name || '').trim().toLowerCase()}
                onClick={doDelete}
              >
                Delete for good
              </button>
            </>
          )}
        >
          <div className="notice red" style={{ marginBottom: 8 }}>
            Only for a duplicate or a wrong entry. This cannot be undone. For anyone else, use Archive.
          </div>
          <div className="field">
            <span>Why?</span>
            <div className="contact-methods">
              {['Duplicate', 'Wrong entry'].map((r) => (
                <button key={r} type="button" className={`contact-method${reason === r ? ' is-on' : ''}`} onClick={() => setReason(r)}>{r}</button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>{`Type the name to confirm: ${c.name}`}</span>
            <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
          </label>
        </Modal>
      )}
    </div>
  );
}
