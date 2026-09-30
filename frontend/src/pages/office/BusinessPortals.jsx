// Section 1 of the one-page Office & Accounts — Business & Tax Details, with
// the Government portals launcher as a compact collapsible block inside it.
// (The statutory due dates it used to carry are on the Dashboard's Reminders
// card now.)
import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import {
  checkGstin, isPan, isTan, isIfsc, isUpi,
} from '../../utils/gstin';
import { money, fmtD } from './officeUtil';

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
        <label className="field"><span>TAN (TRACES login)</span>
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

// v2 §1: the compact grid — Company Name, GSTIN, PAN, TAN, Bank Account, IFSC,
// UPI / VPA and the GST registration status (the checksum badge), with Edit.
function BusinessGrid({ profile, canManage, onSaved }) {
  const [editing, setEditing] = useState(false);
  const p = profile;
  const gc = p.gstinCheck;
  const Item = ({ k, v, s }) => (
    <div className="oe-btx-i">
      <div className="oe-btx-k">{k}</div>
      <div className="oe-btx-v">{v || <span className="status priority-high">not set</span>}</div>
      {s && <div className="oe-btx-s">{s}</div>}
    </div>
  );
  const reg = !p.gstin ? <span className="status priority-medium">Not registered here</span>
    : (gc?.ok ? <span className="status priority-low">GSTIN valid</span> : <span className="status priority-high" title={gc?.error}>GSTIN check failed</span>);
  return (
    <>
      <div className="oe-btx">
        <Item k="Company name" v={p.name} s="From the company settings" />
        <Item k="GSTIN" v={p.gstin && <span className="num">{p.gstin}</span>} s={p.gstin ? `State code ${gc?.stateCode || p.gstin.slice(0, 2)}${gc?.stateName ? ` · ${gc.stateName}` : ''}` : 'Add the GSTIN printed on your invoices'} />
        <Item k="GST registration status" v={reg} s={p.gstin ? (gc?.ok ? 'The GSTIN passes the checksum' : gc?.error) : null} />
        <Item k="PAN" v={p.panShown && <><span className="num">{p.panShown}</span>{!p.panSet && <span className="status priority-medium" title="No PAN entered on its own — this is the PAN inside the GSTIN">from GSTIN</span>}</>} />
        <Item k="TAN" v={p.tan && <span className="num">{p.tan}</span>} s="TRACES login" />
        <Item k="Bank account" v={p.accountNumber && <span className="num">{p.accountNumber}</span>} s={[p.bankName, p.branch, p.accountType].filter(Boolean).join(' · ') || null} />
        <Item k="IFSC" v={p.ifsc && <span className="num">{p.ifsc}</span>} />
        <Item k="UPI / VPA" v={p.upi} s="Printed on the invoice for payment" />
      </div>
      <div className="oe-btx-foot">
        {canManage && <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing(true)}>Edit</button>}
        <span>Admin and Accounts only — the server sends these details to nobody else — and every change is written to the Audit Log with the name, the date, the old value and the new one.</span>
      </div>
      {editing && <ProfileModal profile={p} onClose={() => setEditing(false)} onSaved={(np) => { setEditing(false); onSaved(np); }} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Government portals
// ---------------------------------------------------------------------------
const openUrl = (url) => window.open(url, '_blank', 'noopener,noreferrer');

function PortalRow({ portal, canManage, onUpdated, onError }) {
  const [addr, setAddr] = useState(portal.url);
  useEffect(() => { setAddr(portal.url); }, [portal.url]);
  const page = portal.pages.find((pg) => pg.key === portal.selectedPage) || portal.pages[0];

  const put = async (body) => {
    try { const r = await api.put(`/office-expenses/portal-links/${portal.key}`, body); onUpdated(r.data); return true; } catch (e) { onError(e.response?.data?.error || 'Could not save the address'); return false; }
  };
  const saveAddr = async () => {
    const v = addr.trim();
    if (!v || v === portal.url) { setAddr(portal.url); return; }
    if (!(await put({ selectedPage: page.key, url: v }))) setAddr(portal.url);
  };
  return (
    <div className="oe-portal">
      <div className="oe-portal-main">
        <div className="oe-portal-name"><b>{portal.name}</b><div className="small-muted">{portal.sub}</div></div>
        <div className="oe-portal-id"><span>{portal.idLabel}</span><b className="num">{portal.idValue || <span className="status priority-high">not set</span>}</b></div>
        <label className="oe-f oe-portal-page"><span>Open which page</span>
          <select className="oe-sel" value={page.key} onChange={(e) => (canManage ? put({ selectedPage: e.target.value }) : onUpdated({ ...portal, selectedPage: e.target.value, url: portal.pages.find((pg) => pg.key === e.target.value).url }))}>
            {portal.pages.map((pg) => <option key={pg.key} value={pg.key}>{pg.label}</option>)}
          </select>
        </label>
        <button type="button" className="btn btn-primary btn-sm oe-portal-open" onClick={() => openUrl(portal.url)} title={`Opens ${portal.url} in a new tab`}>↗ Open</button>
      </div>
      <div className="oe-portal-addr">
        <span>Address it opens</span>
        <input
          value={addr}
          readOnly={!canManage}
          onChange={(e) => setAddr(e.target.value)}
          onBlur={saveAddr}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setAddr(portal.url); } }}
          aria-label={`Address the ${portal.name} button opens`}
        />
        {page.edited && canManage && (
          <button type="button" className="link-btn" onClick={() => put({ selectedPage: page.key, reset: true })} title={`Back to ${page.defaultUrl}`}>Reset to default</button>
        )}
        {page.edited && <span className="small-muted">edited{portal.lastEditedAt ? ` ${fmtD(String(portal.lastEditedAt).slice(0, 10))}` : ''}</span>}
      </div>
    </div>
  );
}

function BalancesModal({ balances, period, onClose, onSaved }) {
  const [gst, setGst] = useState(balances.gst == null ? '' : String(balances.gst));
  const [traces, setTraces] = useState(balances.traces == null ? '' : String(balances.traces));
  const [err, setErr] = useState('');
  const save = async (e) => {
    e.preventDefault();
    try { const r = await api.put('/office-expenses/portal-balances', { period, gst, traces }); onSaved(r.data); } catch (e2) { setErr(e2.response?.data?.error || 'Could not save'); }
  };
  return (
    <Modal
      title="Enter the portal balances"
      onClose={onClose}
      footer={(<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" form="oe-bal-form" className="btn btn-primary">Save</button></>)}
    >
      <form id="oe-bal-form" onSubmit={save}>
        <div className="small-muted" style={{ marginBottom: 10 }}>Typed by you, as the portal shows it — nothing is fetched. Leave a box blank to clear it.</div>
        <label className="field"><span>GST portal balance (₹)</span><input type="number" step="0.01" autoFocus value={gst} onChange={(e) => setGst(e.target.value)} /></label>
        <label className="field"><span>TRACES balance (₹)</span><input type="number" step="0.01" value={traces} onChange={(e) => setTraces(e.target.value)} /></label>
        {err && <div className="notice red"><span>{err}</span></div>}
      </form>
    </Modal>
  );
}

export default function BusinessPortals({
  period, canManage, onError, onBalancesSaved, reloadKey,
}) {
  const [profile, setProfile] = useState(null);
  const [portals, setPortals] = useState(null);
  const [balances, setBalances] = useState({ gst: null, traces: null });
  const [periodLabel, setPeriodLabel] = useState('');
  const [balOpen, setBalOpen] = useState(false);

  const load = useCallback(() => {
    api.get('/office-expenses/business-profile').then((r) => setProfile(r.data)).catch(() => onError('Business Details could not be loaded.'));
    api.get('/office-expenses/portals', { params: { period } }).then((r) => {
      setPortals(r.data.portals); setBalances(r.data.balances); setPeriodLabel(r.data.period.label);
    }).catch(() => onError('The portals could not be loaded.'));
  }, [period, onError]);
  useEffect(load, [load, reloadKey]);

  const none = balances.gst == null && balances.traces == null;
  const gstPortal = portals?.find((p) => p.key === 'gst');

  return (
    <>
      {!profile && <div className="small-muted"><span className="oe-spin oe-spin-sm" aria-hidden="true" /> Loading…</div>}
      {profile && <BusinessGrid profile={profile} canManage={canManage} onSaved={(np) => { setProfile(np); load(); }} />}

      {/* The three government portal launchers, kept as they were — the
          configured address, "Open which page", Open in a new tab, the
          editable address and the portal balances — folded into one block. */}
      <details className="oe-portals-d">
        <summary>
          <span className="oe-sec-car" aria-hidden="true" />
          <b>Government portals</b>
          <span className="small-muted">
            {portals ? portals.map((p) => p.name).join(' · ') : 'GST · TRACES · Income Tax'} — each opens its configured address in a new tab
          </span>
        </summary>
        <div className="oe-portals-in">
          {!portals && <div className="small-muted">Loading…</div>}
          {portals && portals.map((p) => (
            <PortalRow key={p.key} portal={p} canManage={canManage} onError={onError}
              onUpdated={(np) => setPortals(portals.map((x) => (x.key === np.key ? np : x)))} />
          ))}

          <div className="oe-note">
            <div>
              {none ? <b>The portal balance is not on file. </b> : (
                <b>On file for {periodLabel}: GST portal {balances.gst == null ? 'not entered' : money(balances.gst)} · TRACES {balances.traces == null ? 'not entered' : money(balances.traces)}. </b>
              )}
              Nothing is fetched — this app has no connection to the portals. Open the GST portal, read {gstPortal?.ledgerPath || 'Services → Ledgers'}, and TRACES for
              the TDS side, then type the two balances here, and compare them with the Net GST in the Financial Overview.
            </div>
            {canManage && <button type="button" className="btn btn-sm" onClick={() => setBalOpen(true)}>Enter the portal balances</button>}
          </div>

          <details className="oe-portals-more">
            <summary>About the portal login</summary>
            <div className="notice amber oe-callout">
              <span>
                If the login page comes up, that is the portal, not this app. The GST portal signs you in with a username, a password and a
                CAPTCHA that has to be typed by a person — it is built that way on purpose, and no website or app can get past it for you.
                What the button controls is where you land: while your browser still holds a live GST session, Returns dashboard opens
                straight on the returns screen; once that session has expired the portal sends you to Login first, and after you sign in it
                carries you on.
              </span>
            </div>
            <div className="notice oe-callout">
              <span>
                These buttons only open the address shown, in a new tab — they never sign in for you. The GST and TRACES logins, if you keep
                them here, are in GST &amp; TDS Portals further down: encrypted on the server and masked until you press Show. Changed the
                address? It is remembered for that portal, so a page that moves is a one-time fix.
              </span>
            </div>
          </details>
        </div>
      </details>

      {balOpen && (
        <BalancesModal balances={balances} period={period} onClose={() => setBalOpen(false)}
          onSaved={(b) => { setBalances(b); setBalOpen(false); onBalancesSaved(); }} />
      )}
    </>
  );
}
