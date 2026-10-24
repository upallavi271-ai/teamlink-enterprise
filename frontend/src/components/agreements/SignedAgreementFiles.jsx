import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { agreementBlind } from '../../utils/agreementPrivacy.js';
import useClientLabel from '../clients/useClientLabel.js'; // one company, many locations: "Name - Location" for same-name clients (2026-10-22)
import './signedAgreementFiles.css';

// ---------------------------------------------------------------------------
// THE ONE "View agreement" - used on every screen that has a client.
// Server: backend routes/agreementSignedFiles.js (imported signed files) + routes/agreementOwnFile.js (the one
// uploaded file) + routes/agreementSeal.js (the e-sign agreement). Every one of them refuses a login that may not
// read agreements (403), so the button is only a convenience: it is drawn for the same logins the screens already
// call "not blind" (utils/agreementPrivacy.js) and for a client login. A TL / STL / Recruiter / HR login sees nothing.
//
//   <ViewAgreementButton clientId />         the button. It is ALWAYS there. Press it:
//                                              - exactly one file and no e-sign agreement: the file opens at once
//                                              - several files (or an e-sign agreement too): a small window with the list
//                                              - nothing: a small window "No signed agreement uploaded for this client yet",
//                                                and for an Admin / Super Admin an "Upload agreement" button
//   <ViewAgreementPicker clients />          a button that first asks WHICH client (BDE workspace), then the same window
//   <SignedAgreementFiles clientId />        a card that lists the imported signed files (Client agreement tab)
//
// A file is always fetched WITH the login token (as a blob) and then opened - never by a plain link.
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function niceDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] || ''} ${m[1]}` : '';
}
export function metaLine(f) {
  return [niceDate(f.agreementDate) || 'Date not known', f.department, f.branch, f.version].filter(Boolean).join(' · ');
}
const NONE_WORDS = 'No signed agreement uploaded for this client yet';
const UPLOAD_ACCEPT = '.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp';

// Who is shown the button: everyone the agreement screens are not hidden from, plus the client's own login.
export function useCanViewAgreement() {
  const { user } = useAuth();
  if (!user) return false;
  if (user.role === 'CLIENT' || user.atsRole === 'CLIENT') return true;
  // Accounts read every agreement (the server: agreementAccess 'ACCOUNTANT'); an accounts-only login has no ATS Clients matrix, so read the role itself.
  if ([user.role, user.atsRole, user.accountsRole].includes('ACCOUNTANT')) return true;
  return !agreementBlind(user);
}

// Fetch one file with the token, then open it in a new tab (PDF / picture) or save it (Word, or "Download").
// f = { path (under /api), mime, canShow, fileName }
export async function openAgreementFile(f, download) {
  const save = download || !f.canShow;
  // Open the tab first (inside the click), so a pop-up blocker does not stop it while the file is coming.
  const tab = save ? null : window.open('', '_blank');
  if (tab) { try { tab.opener = null; } catch { /* ignore */ } }
  try {
    const r = await api.get(f.path, { responseType: 'blob', params: save ? { download: 1 } : {} });
    const url = URL.createObjectURL(new Blob([r.data], { type: f.mime || r.data.type }));
    if (save || !tab) {
      const a = document.createElement('a');
      a.href = url; a.download = f.fileName || 'agreement'; document.body.appendChild(a); a.click(); a.remove();
    } else {
      tab.location.href = url;
    }
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  } catch (e) {
    if (tab) tab.close();
    throw e;
  }
}

// Everything the window needs about one client, in one go.
async function loadAgreement(clientId, esignHint) {
  // The e-signed agreement itself (the client signed it through TeamLink): once it is Signed / Active / Expired its PDF is on file and is
  // what "View agreement" must open - before this, a client who had signed showed "No signed agreement uploaded".
  const [sf, own, es, ex] = await Promise.all([
    api.get(`/agreement/${clientId}/signed-files`).then((r) => r.data).catch((e) => ({ denied: e.response && e.response.status === 403, failed: true })),
    api.get(`/agreement/${clientId}/own-file/info`).then((r) => r.data).catch(() => null),
    typeof esignHint === 'boolean'
      ? Promise.resolve(esignHint)
      : api.get(`/agreement/${clientId}`).then((r) => !!(r.data && r.data.document)).catch(() => false),
    api.get(`/agreement/${clientId}/executed`).then((r) => r.data).catch(() => null),
  ]);
  const items = [];
  if (ex && ex.pdfAvailable) {
    const no = String(ex.agreementId || 'agreement').replace(/[^w.-]/g, '');
    items.push({
      key: 'esign', label: 'Signed agreement (e-signed in TeamLink)', meta: [ex.agreementId, ex.signedBy ? `signed by ${ex.signedBy}` : null, ex.signedAt ? `on ${niceDate(String(ex.signedAt).slice(0, 10))}` : null].filter(Boolean).join(' · '),
      tag: ex.status === 'ACTIVE' ? 'Active' : '', path: `/agreement/${clientId}/pdf`, mime: 'application/pdf', canShow: true, fileName: `${no}-signed.pdf`,
    });
  }
  if (own && own.has && own.own !== false) {
    items.push({
      key: 'own', label: "Client's own agreement", meta: [own.name, 'Uploaded file'].filter(Boolean).join(' · '),
      path: `/agreement/${clientId}/own-file`, mime: own.mime, canShow: !!own.canShow, fileName: own.name,
    });
  }
  ((sf && sf.files) || []).forEach((f) => items.push({
    key: f.id, label: f.label, meta: metaLine(f), tag: f.kind && f.kind !== 'Signed agreement' ? f.kind : '',
    path: `/agreement/${clientId}/signed-files/${f.id}`, mime: f.mime, canShow: f.canShow, fileName: f.fileName,
  }));
  return { items, esign: es, esignWaiting: !!es && !(ex && ex.pdfAvailable), canUpload: !!(sf && sf.canRemove), denied: !!(sf && sf.denied && !items.length) };
}

// The window (and the "one file opens at once" rule). Mount it to use it; onClose when it is done.
export function ViewAgreementWindow({ clientId, esign, onClose, onChanged }) {
  const navigate = useNavigate();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const fileInput = useRef(null);
  const first = useRef(true);

  const load = useCallback(async () => {
    const data = await loadAgreement(clientId, first.current ? esign : undefined);
    return data;
  }, [clientId, esign]);

  useEffect(() => {
    let live = true;
    (async () => {
      const data = await load();
      if (!live) return;
      first.current = false;
      if (!data.denied && data.items.length === 1 && (!data.esign || data.items[0].key === 'esign')) {
        try { await openAgreementFile(data.items[0], false); onClose(); return; } catch { setErr('Could not open the file. Please try again.'); }
      }
      setD(data);
    })();
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function pickItem(it, download) {
    setErr(''); setBusy(it.key + (download ? 'd' : ''));
    try { await openAgreementFile(it, download); } catch { setErr('Could not open the file. Please try again.'); }
    setBusy('');
  }
  async function upload(file) {
    if (!file) return;
    setErr(''); setBusy('upload');
    try {
      const f = new FormData();
      f.append('file', file);
      await api.post(`/clients/${clientId}/agreement/upload-file`, f);
      setD(await load());
      if (onChanged) onChanged();
    } catch (e) { setErr(e.response?.data?.error || 'The file could not be uploaded. Please try again.'); }
    setBusy('');
    if (fileInput.current) fileInput.current.value = '';
  }

  if (!d) return null;
  const none = !d.items.length;
  return createPortal(
    <Modal
      title={(
        <span className="vag-title">
          {'Agreement'}
          {!none && <span className="vag-badge" title="Agreements on file">{d.items.length}</span>}
        </span>
      )}
      onClose={onClose}
      footer={<button type="button" className="btn" onClick={onClose}>Close</button>}
    >
      <div className="vag-body">
        {d.denied && <p className="vag-none">You cannot open this agreement.</p>}
        {!d.denied && none && <p className="vag-none">{d.esignWaiting ? 'This agreement is made but not signed yet. Open it below to see where it is.' : NONE_WORDS}</p>}
        {!d.denied && none && d.canUpload && (
          <div className="vag-up">
            <input ref={fileInput} type="file" accept={UPLOAD_ACCEPT} style={{ display: 'none' }} onChange={(e) => upload(e.target.files && e.target.files[0])} />
            <button type="button" className="btn btn-primary" disabled={busy === 'upload'} onClick={() => fileInput.current && fileInput.current.click()}>
              {busy === 'upload' ? 'Uploading…' : 'Upload agreement'}
            </button>
            <div className="small-muted" style={{ fontSize: 12, marginTop: 6 }}>PDF, Word or picture, up to 10 MB.</div>
          </div>
        )}
        {d.items.length > 0 && (
          <ul className="saf-list">
            {d.items.map((it) => (
              <li key={it.key} className="saf-row">
                <div className="saf-info">
                  <div className="saf-label">{it.label}</div>
                  <div className="saf-meta">{it.meta}{it.tag && <span className="saf-tag">{it.tag}</span>}</div>
                </div>
                <div className="saf-actions">
                  <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => pickItem(it, false)}>{it.canShow ? 'View' : 'Download'}</button>
                  {it.canShow && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => pickItem(it, true)}>Download</button>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {d.esign && (
          <div className="vag-esign">
            <button type="button" className="btn" onClick={() => { onClose(); navigate(`/agreements/${clientId}`); }}>Open e-sign agreement</button>
          </div>
        )}
        {err && <div className="error-text">{err}</div>}
      </div>
    </Modal>,
    document.body,
  );
}

// THE button. Label is always exactly "View agreement", one line.
//   esign = true / false when the screen already knows whether an e-sign agreement document exists; leave it out and the window asks.
export function ViewAgreementButton({ clientId, esign, className = 'btn btn-sm', style, onChanged }) {
  const show = useCanViewAgreement();
  const [open, setOpen] = useState(false);
  if (!show || !clientId) return null;
  return (
    <>
      <button type="button" className={`${className} vag-btn`} style={{ whiteSpace: 'nowrap', ...style }} onClick={(e) => { e.stopPropagation(); setOpen(true); }}>View agreement</button>
      {open && <ViewAgreementWindow clientId={clientId} esign={esign} onChanged={onChanged} onClose={() => setOpen(false)} />}
    </>
  );
}

// "View agreement" where there is no client row (the BDE workspace): ask which client, then show the same window.
export function ViewAgreementPicker({ clients = [], className = 'btn' }) {
  const clientLabel = useClientLabel();
  const show = useCanViewAgreement();
  const [ask, setAsk] = useState(false);
  const [id, setId] = useState('');
  const [view, setView] = useState('');
  if (!show) return null;
  return (
    <>
      <button type="button" className={`${className} vag-btn`} style={{ whiteSpace: 'nowrap' }} onClick={() => { setId(''); setAsk(true); }}>View agreement</button>
      {ask && (
        <Modal
          title="View agreement"
          onClose={() => setAsk(false)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setAsk(false)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={!id} onClick={() => { setView(id); setAsk(false); }}>View agreement</button>
            </>
          )}
        >
          <label className="field">
            <span>Which client?</span>
            <Combo value={id} onChange={(e) => setId(e.target.value)}>
              <option value="">Pick a client</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{clientLabel(c)}</option>)}
            </Combo>
          </label>
        </Modal>
      )}
      {view && <ViewAgreementWindow clientId={view} onClose={() => setView('')} />}
    </>
  );
}

// The list of imported signed files for a client (for the card). `skip` = do not even ask.
export function useSignedFiles(clientId, { skip = false, refreshKey } = {}) {
  const [data, setData] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    if (skip || !clientId) { setData(null); return undefined; }
    api.get(`/agreement/${clientId}/signed-files`)
      .then((r) => { if (live) setData(r.data && r.data.has ? r.data : null); })
      .catch(() => { if (live) setData(null); });
    return () => { live = false; };
  }, [clientId, skip, refreshKey, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, reload };
}

function FileRow({ clientId, f, canRemove, onRemoved, onError }) {
  const [busy, setBusy] = useState('');
  const item = { path: `/agreement/${clientId}/signed-files/${f.id}`, mime: f.mime, canShow: f.canShow, fileName: f.fileName };
  async function open(download) {
    setBusy(download ? 'dl' : 'open'); onError('');
    try { await openAgreementFile(item, download); } catch { onError('Could not open the file. Please try again.'); }
    setBusy('');
  }
  async function remove() {
    if (!window.confirm('Take this file off the client? The file itself stays safely stored on the server.')) return;
    setBusy('rm'); onError('');
    try { await api.delete(`/agreement/${clientId}/signed-files/${f.id}`); onRemoved(); } catch (e) { onError(e.response?.data?.error || 'Could not remove it. Please try again.'); }
    setBusy('');
  }
  return (
    <li className="saf-row">
      <div className="saf-info">
        <div className="saf-label">{f.label}</div>
        <div className="saf-meta">
          {metaLine(f)}
          {f.kind && f.kind !== 'Signed agreement' && <span className="saf-tag">{f.kind}</span>}
        </div>
      </div>
      <div className="saf-actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => open(false)}>{f.canShow ? 'View' : 'Download'}</button>
        {f.canShow && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => open(true)}>Download</button>}
        {canRemove && <button type="button" className="btn btn-sm btn-ghost" disabled={!!busy} onClick={remove}>Remove</button>}
      </div>
    </li>
  );
}

// The card that lists every imported signed file of the client.
export default function SignedAgreementFiles({ clientId, skip = false, refreshKey }) {
  const { data, reload } = useSignedFiles(clientId, { skip, refreshKey });
  const [err, setErr] = useState('');
  if (!data) return null;
  return (
    <div className="card section saf-card" aria-label="Signed agreements on file">
      <h3 className="saf-head">{`Signed agreements · ${data.count} on file`}</h3>
      <ul className="saf-list">
        {data.files.map((f) => (
          <FileRow key={f.id} clientId={clientId} f={f} canRemove={!!data.canRemove} onRemoved={reload} onError={setErr} />
        ))}
      </ul>
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}
