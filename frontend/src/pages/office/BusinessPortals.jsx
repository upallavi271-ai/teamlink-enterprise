// Office & Accounts — what sits under the expense table (Office spec P2):
// the due dates strip, the Government portals row and the Business details
// (collapsed). The same due dates are also on the Dashboard's Reminders card.
import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import InfoTip from './InfoTip.jsx';
import { dueDates, fmtD } from './officeUtil';
import {
  checkGstin, isPan, isTan, isIfsc, isUpi,
} from '../../utils/gstin';

// ---------------------------------------------------------------------------
// Business Details
// ---------------------------------------------------------------------------
function ProfileModal({ profile, onClose, onSaved }) {
  const [f, setF] = useState({
    gstin: profile.gstin || '', pan: profile.pan || '', tan: profile.tan || '', accountNumber: profile.accountNumber || '',
    bankName: profile.bankName || '', ifsc: profile.ifsc || '', branch: profile.branch || '', accountType: profile.accountType || 'Current', upi: profile.upi || '',
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const up = (k) => (e) => setF({ ...f, [k]: ['gstin', 'pan', 'tan', 'ifsc'].includes(k) ? e.target.value.toUpperCase().replace(/\s+/g, '') : e.target.value });
  const gc = f.gstin ? checkGstin(f.gstin) : null;
  const panBad = f.pan && !isPan(f.pan) ? 'PAN is 5 letters, 4 digits, a letter'
    : (f.pan && gc?.ok && gc.pan !== f.pan ? `Not the PAN inside the GSTIN (${gc.pan})` : '');
  const tanBad = f.tan && !isTan(f.tan) ? 'TAN is 4 letters, 5 digits, a letter' : '';
  const ifscBad = f.ifsc && !isIfsc(f.ifsc) ? 'IFSC is 4 letters, a 0, then 6 letters or digits' : '';
  const upiBad = f.upi && !isUpi(f.upi) ? 'Looks like name@bank' : '';
  const accBad = f.accountNumber && !/^[0-9]{6,18}$/.test(f.accountNumber.replace(/\s+/g, '')) ? '6 to 18 digits' : '';
  const blocked = (gc && !gc.ok) || panBad || tanBad || ifscBad || upiBad || accBad;

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { const r = await api.put('/office-expenses/business-profile', f); onSaved(r.data); } catch (e2) { setErr(e2.response?.data?.error || 'Could not save'); setBusy(false); }
  };
  const Hint = ({ bad, ok }) => (bad ? <div className="oe-hint bad">{bad}</div> : (ok ? <div className="oe-hint ok">{ok}</div> : null));
  return (
    <Modal
      title="Business Details"
      note="Admin and Accounts only"
      size="wide"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="oe-bp-form" className="btn btn-primary" disabled={busy || !!blocked}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      )}
    >
      <form id="oe-bp-form" className="oe-form" onSubmit={save}>
        <label className="field oe-span2"><span>GSTIN</span>
          <input value={f.gstin} maxLength={15} onChange={up('gstin')} placeholder="15 characters" />
          <Hint bad={gc && !gc.ok ? gc.error : ''} ok={gc?.ok ? `GSTIN valid · ${gc.stateName} · PAN inside ${gc.pan}` : ''} />
        </label>
        <label className="field"><span>PAN</span>
          <input value={f.pan} maxLength={10} onChange={up('pan')} placeholder={gc?.ok ? `blank = ${gc.pan} from the GSTIN` : '10 characters'} />
          <Hint bad={panBad} />
        </label>
        <label className="field"><span>TAN</span>
          <input value={f.tan} maxLength={10} onChange={up('tan')} placeholder="e.g. HYDT12345A" />
          <Hint bad={tanBad} />
        </label>
        <label className="field"><span>Bank name</span><input value={f.bankName} onChange={up('bankName')} /></label>
        <label className="field"><span>Account number</span>
          <input value={f.accountNumber} inputMode="numeric" onChange={up('accountNumber')} />
          <Hint bad={accBad} />
        </label>
        <label className="field"><span>IFSC</span>
          <input value={f.ifsc} maxLength={11} onChange={up('ifsc')} />
          <Hint bad={ifscBad} />
        </label>
        <label className="field"><span>Branch name</span><input value={f.branch} onChange={up('branch')} /></label>
        <label className="field"><span>Account type</span>
          <select value={f.accountType} onChange={up('accountType')}><option>Current</option><option>Savings</option></select>
        </label>
        <label className="field oe-span2"><span>UPI / VPA</span>
          <input value={f.upi} onChange={up('upi')} placeholder="name@bank" />
          <Hint bad={upiBad} />
        </label>
        {err && <div className="notice red oe-span3" style={{ marginBottom: 0 }}><span>{err}</span></div>}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// BELOW THE EXPENSE TABLE (Office spec P2, 2026-10-05), in this order:
//   1 DueStrip         — 4 small cards: TDS challan, GSTR-1, GSTR-3B, TDS return
//   2 GovPortals       — GST portal, TRACES, Income Tax e-filing: name, ID, Open;
//                        the page / address behind an Admin-only Edit popup
//   3 BusinessDetails  — collapsed by default, a "Show" toggle (default export)
// The explanations are "i" tooltips (InfoTip); Office.jsx adds the audit line.
// ---------------------------------------------------------------------------

// 1 — Due dates. The same four statutory dates the Dashboard's Reminders card
// shows (officeUtil.dueDates()). Red when due within 2 days, amber within a
// week, grey otherwise.
const dueTone = (days) => (days <= 2 ? 'red' : days <= 7 ? 'amber' : 'grey');
const DUE_NAMES = {
  tds: 'TDS payment challan', gstr1: 'GSTR-1', gstr3b: 'GSTR-3B', tdsret: 'TDS return 24Q/26Q',
};
export function DueStrip() {
  const list = dueDates(new Date());
  return (
    <section className="ofp-blk" aria-labelledby="ofp-due-t">
      <div className="ofp-hd">
        <h3 id="ofp-due-t">Due dates</h3>
        <InfoTip text="The next government due date of each kind. Red: due within 2 days. Amber: within a week. Grey: later." />
      </div>
      <div className="ofp-grid4" role="list">
        {list.map((d) => (
          <div key={d.key} role="listitem" className={`ofp-due ${dueTone(d.days)}`} title={`${d.title} · ${d.for}`}>
            <span className="ofp-due-n">{DUE_NAMES[d.key] || d.title}</span>
            <span className="ofp-due-d">{fmtD(d.date)}</span>
            <span className="ofp-due-w">{d.days === 0 ? 'Today' : `in ${d.days} day${d.days === 1 ? '' : 's'}`}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// 2 — Government portals. One Open button each (a plain link: it opens the
// address in a new tab and never signs in). Which page / the address it opens
// is set in the Edit popup, Admin only (the API refuses everyone else).
function PortalEditModal({ portal, onClose, onSaved }) {
  const [pageKey, setPageKey] = useState(portal.selectedPage);
  const page = portal.pages.find((pg) => pg.key === pageKey) || portal.pages[0];
  const [addr, setAddr] = useState(page.url);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setAddr(page.url); }, [page.url]);
  const put = async (body) => {
    setBusy(true); setErr('');
    try { const r = await api.put(`/office-expenses/portal-links/${portal.key}`, body); onSaved(r.data); } catch (e) { setErr(e.response?.data?.error || 'Could not save. Try again.'); setBusy(false); }
  };
  const save = (e) => {
    e.preventDefault();
    const v = addr.trim();
    put(v && v !== page.url ? { selectedPage: page.key, url: v } : { selectedPage: page.key });
  };
  return (
    <Modal
      title={`Edit · ${portal.name}`}
      note="Admin only"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="ofp-portal-form" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      )}
    >
      <form id="ofp-portal-form" onSubmit={save}>
        {portal.pages.length > 1 && (
          <label className="field"><span>Open which page</span>
            <select value={pageKey} onChange={(e) => setPageKey(e.target.value)}>
              {portal.pages.map((pg) => <option key={pg.key} value={pg.key}>{pg.label}</option>)}
            </select>
          </label>
        )}
        <label className="field"><span>Address it opens</span>
          <input value={addr} onChange={(e) => setAddr(e.target.value)} inputMode="url" aria-label={`Address the ${portal.name} button opens`} />
        </label>
        {page.edited && (
          <div className="small-muted" style={{ marginBottom: 8 }}>
            Changed{portal.lastEditedBy ? ` by ${portal.lastEditedBy}` : ''}{portal.lastEditedAt ? ` on ${fmtD(String(portal.lastEditedAt).slice(0, 10))}` : ''}.{' '}
            <button type="button" className="link-btn" disabled={busy} onClick={() => put({ selectedPage: page.key, reset: true })}>Back to the default address</button>
          </div>
        )}
        {err && <div className="notice red" style={{ marginBottom: 0 }}><span>{err}</span></div>}
      </form>
    </Modal>
  );
}

export function GovPortals({ portals, canEdit, onUpdated }) {
  const [editing, setEditing] = useState(null);
  return (
    <section className="ofp-blk" aria-labelledby="ofp-gov-t">
      <div className="ofp-hd">
        <h3 id="ofp-gov-t">Government portals</h3>
        <InfoTip text="Open takes you to the portal in a new tab. It never signs in for you: if the portal's login page comes up, sign in there (the GST portal also asks for a CAPTCHA). Nothing is fetched from the portals." />
      </div>
      {!portals && <div className="small-muted"><span className="oe-spin oe-spin-sm" aria-hidden="true" /> Loading…</div>}
      {portals && (
        <div className="ofp-grid3" role="list">
          {portals.map((p) => (
            <div key={p.key} role="listitem" className="ofp-portal">
              <div className="ofp-portal-t">
                <b>{p.name}</b>
                {canEdit && (
                  <button type="button" className="ofp-gear" onClick={() => setEditing(p)} aria-label={`Edit the ${p.name} button`} title="Edit (Admin only)">
                    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="M10 6.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Zm7 3.2-.1-1.1 1.6-1.3-1.6-2.8-2 .6a6.6 6.6 0 0 0-1.9-1.1L12.6 2H9.4l-.4 2.1c-.7.3-1.3.6-1.9 1.1l-2-.6-1.6 2.8 1.6 1.3L5 10l.1 1.1-1.6 1.3 1.6 2.8 2-.6c.6.5 1.2.8 1.9 1.1l.4 2.1h3.2l.4-2.1c.7-.3 1.3-.6 1.9-1.1l2 .6 1.6-2.8-1.6-1.3.1-1.1Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
                  </button>
                )}
              </div>
              <div className="ofp-portal-id">
                <span>{p.idLabel}</span>
                {p.idValue ? <b className="num">{p.idValue}</b> : <span className="status priority-high">not set</span>}
              </div>
              <a className="btn btn-sm btn-primary ofp-open" href={p.url} target="_blank" rel="noopener noreferrer" title={`Opens ${p.url} in a new tab`}>Open ↗</a>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <PortalEditModal portal={editing} onClose={() => setEditing(null)}
          onSaved={(np) => { setEditing(null); onUpdated(np); }} />
      )}
    </section>
  );
}

// 3 — Business details: GSTIN, PAN, Bank account, IFSC, UPI / VPA in two
// columns; Edit and the GSTIN check badge on the title row. Collapsed until
// "Show" is pressed (an old ?tab=business link opens it).
function BusinessGrid({ profile }) {
  const p = profile;
  const gc = p.gstinCheck;
  const Item = ({ k, v, s }) => (
    <div className="oe-btx-i">
      <div className="oe-btx-k">{k}</div>
      <div className="oe-btx-v">{v || <span className="status priority-high">not set</span>}</div>
      {s && <div className="oe-btx-s">{s}</div>}
    </div>
  );
  return (
    <div className="oe-btx ofp-btx2">
      <Item k="GSTIN" v={p.gstin && <span className="num">{p.gstin}</span>} s={p.gstin ? `State code ${gc?.stateCode || p.gstin.slice(0, 2)}${gc?.stateName ? ` · ${gc.stateName}` : ''}` : 'Add the GSTIN printed on your invoices'} />
      <Item k="PAN" v={p.panShown && <><span className="num">{p.panShown}</span>{!p.panSet && <span className="status priority-medium" title="No PAN entered on its own — this is the PAN inside the GSTIN">from GSTIN</span>}</>} />
      <Item k="Bank account" v={p.accountNumber && <span className="num">{p.accountNumber}</span>} s={[p.bankName, p.branch, p.accountType].filter(Boolean).join(' · ') || null} />
      <Item k="IFSC" v={p.ifsc && <span className="num">{p.ifsc}</span>} />
      <Item k="UPI / VPA" v={p.upi} s={p.upi ? 'Printed on the invoice for payment' : null} />
    </div>
  );
}

export default function BusinessDetails({
  canManage, onError, reloadKey, openSignal, onSaved,
}) {
  const [profile, setProfile] = useState(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => {
    api.get('/office-expenses/business-profile').then((r) => setProfile(r.data)).catch(() => onError('Business details could not be loaded.'));
  }, [onError]);
  useEffect(load, [load, reloadKey]);
  useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);
  const gc = profile?.gstinCheck;
  const badge = !profile ? null : !profile.gstin ? <span className="status priority-medium">No GSTIN yet</span>
    : (gc?.ok ? <span className="status priority-low">GSTIN valid</span> : <span className="status priority-high" title={gc?.error}>GSTIN check failed</span>);
  return (
    <section id="oe-sec-business" className="ofp-blk ofp-biz" aria-labelledby="ofp-biz-t">
      <div className="ofp-hd">
        <h3 id="ofp-biz-t">Business details</h3>
        <InfoTip text="Only Admin and Accounts can see this section — the server sends these details to nobody else." />
        {badge}
        <span className="ofp-hd-r">
          {canManage && profile && <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>}
          <button type="button" className="btn btn-sm" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="ofp-biz-b">{open ? 'Hide' : 'Show'}</button>
        </span>
      </div>
      {open && (
        <div id="ofp-biz-b">
          {!profile ? <div className="small-muted"><span className="oe-spin oe-spin-sm" aria-hidden="true" /> Loading…</div> : <BusinessGrid profile={profile} />}
        </div>
      )}
      {editing && profile && (
        <ProfileModal profile={profile} onClose={() => setEditing(false)}
          onSaved={(np) => { setEditing(false); setProfile(np); load(); if (onSaved) onSaved(); }} />
      )}
    </section>
  );
}
