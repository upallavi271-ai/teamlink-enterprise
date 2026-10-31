import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { agreementBlind } from '../../utils/agreementPrivacy.js';
import useClientLabel from '../clients/useClientLabel.js'; // one company, many locations: "Name - Location" for same-name clients (2026-10-22)
import { DEPTS, deptLabel } from '../../atsVocab';
import './signedAgreementFiles.css';
import { StampPicker } from './TeamLinkSeal.jsx';
import shrinkImage from './shrinkImage.js';

// TEAMLINK'S COMPANY STAMP for the DigiLocker copies (founder 2026-10-31: "digilocker ni base cheskoni & stamp upload chese option
// vundali"): saved once (Agreement settings), printed on every agreement PDF to eSign. Only who may set it (Super Admin / Admin)
// sees this row: the GET answers 403 to anyone else and the row stays hidden.
function TeamLinkStampRow() {
  const [st, setSt] = useState(null);
  const [img, setImg] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => {
    api.get('/agreement/settings/teamlink-seal').then((r) => {
      setSt(r.data);
      if (r.data && r.data.hasStamp) {
        api.get('/agreement/settings/teamlink-seal/file/stamp', { responseType: 'blob' })
          .then((b) => setImg((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(b.data); })).catch(() => setImg(''));
      }
    }).catch(() => setSt(false));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!st) return null;
  const save = async () => {
    setBusy(true); setMsg('');
    try {
      const small = await shrinkImage(file);
      const f = new FormData();
      f.append('kind', 'stamp');
      f.append('file', small, small.name || 'stamp.png');
      await api.post('/agreement/settings/teamlink-seal', f);
      setFile(null); setMsg('TeamLink stamp saved. It is printed on every agreement PDF to eSign.'); load();
    } catch (e) {
      const st = e.response && e.response.status;
      setMsg(e.response?.data?.error || (st === 413 ? 'That picture is too big for the server. Try a smaller photo or a scan.' : `The stamp could not be saved${st ? ` (error ${st})` : ''}. Please try again.`));
    } finally { setBusy(false); }
  };
  return (
    <div style={{ border: '1px dashed var(--border, #d5dbe5)', borderRadius: 8, padding: 10, marginBottom: 8 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>TeamLink stamp {st.hasStamp ? <span style={{ color: 'var(--green, #15803d)', fontSize: 13 }}>✓ saved</span> : <span style={{ color: '#9a6700', fontSize: 13 }}>not saved yet</span>}</div>
      {st.hasStamp && img && <img src={img} alt="TeamLink stamp" style={{ maxWidth: 90, maxHeight: 90, display: 'block', marginBottom: 6 }} />}
      <StampPicker file={file} onFile={setFile} />
      <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} disabled={busy || !file} onClick={save}>{busy ? 'Saving…' : (st.hasStamp ? 'Replace TeamLink stamp' : 'Save TeamLink stamp')}</button>
      {msg && <div className="small-muted" style={{ fontSize: 12, marginTop: 4 }}>{msg}</div>}
    </div>
  );
}

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
// the three papers the BDE team uploads (founder 2026-10-29); the server checks who may (routes/agreementSignedFiles.js)
const PAPERS = [['vasu', 'Vasu sir confirmation'], ['client', 'Client confirmation'], ['agreement', 'Signed agreement']];
// THE TWO DIGILOCKER COPIES (founder 2026-10-31): each side eSigns its own copy of the same agreement with Aadhaar in
// DigiLocker (free; DigiLocker keeps one signature per PDF). The server takes a copy only when its signature checks valid.
const DL = [
  { type: 'dlteamlink', kind: 'TeamLink eSigned copy (DigiLocker)', side: 'TeamLink' },
  { type: 'dlclient', kind: 'Client eSigned copy (DigiLocker)', side: 'Client' },
];
const DL_KINDS = DL.map((x) => x.kind);
const whenOf = (iso) => { try { return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const CLIENT_DEPTS = DEPTS.filter((x) => !['BDE', 'HR', 'Accounts'].includes(x));

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
  // signing is DigiLocker only (2026-10-31): with a DigiLocker copy on file, the two signed copies below ARE the signed agreement,
  // so the old "signed in TeamLink" entry (the online-link flow) is not listed
  const hasDl = ((sf && sf.files) || []).some((f) => DL_KINDS.includes(f.kind));
  if (ex && ex.pdfAvailable && !hasDl) {
    const no = String(ex.agreementId || 'agreement').replace(/[^w.-]/g, '');
    items.push({
      key: 'esign', label: 'Signed agreement', meta: [ex.agreementId, ex.signedBy ? `signed by ${ex.signedBy}` : null, ex.signedAt ? `on ${niceDate(String(ex.signedAt).slice(0, 10))}` : null].filter(Boolean).join(' · '),
      tag: ex.status === 'ACTIVE' ? 'Active' : '', path: `/agreement/${clientId}/pdf`, mime: 'application/pdf', canShow: true, fileName: `${no}-signed.pdf`,
    });
  }
  if (own && own.has && own.own !== false) {
    items.push({
      key: 'own', label: "Client's own agreement", meta: [own.name, 'Uploaded file'].filter(Boolean).join(' · '),
      path: `/agreement/${clientId}/own-file`, mime: own.mime, canShow: !!own.canShow, fileName: own.name,
    });
  }
  // the newest DigiLocker copy of each side, shown side by side (not in the plain list)
  const dl = {};
  ((sf && sf.files) || []).filter((f) => DL_KINDS.includes(f.kind)).sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt)).forEach((f) => {
    if (!dl[f.kind]) dl[f.kind] = { ...f, path: `/agreement/${clientId}/signed-files/${f.id}` };
  });
  ((sf && sf.files) || []).filter((f) => !DL_KINDS.includes(f.kind)).forEach((f) => items.push({
    key: f.id, label: f.label, meta: metaLine(f), tag: f.kind && f.kind !== 'Signed agreement' ? f.kind : '',
    path: `/agreement/${clientId}/signed-files/${f.id}`, mime: f.mime, canShow: f.canShow, fileName: f.fileName,
  }));
  return { items, dl, esign: es, esignWaiting: !!es && !(ex && ex.pdfAvailable), canUpload: !!(sf && sf.canRemove), canAdd: !!(sf && sf.canAdd), denied: !!(sf && sf.denied && !items.length && !Object.keys(dl).length) };
}

// The window (and the "one file opens at once" rule). Mount it to use it; onClose when it is done.
export function ViewAgreementWindow({ clientId, esign, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const fileInput = useRef(null);
  const paperInput = useRef(null);
  const paperType = useRef('');
  const [note, setNote] = useState('');
  // who eSigns TeamLink's copy (name as on Aadhaar): printed in the PDF's Name / Sign (founder 2026-10-31). Starts as the signatory
  // in Agreement settings (readable by Super Admin / Admin); left empty, the server prints that signatory anyway.
  const [esignAs, setEsignAs] = useState({ name: '', title: '' });
  useEffect(() => {
    api.get('/agreement/settings/teamlink-seal').then((r) => setEsignAs((v) => (v.name ? v : { name: (r.data && r.data.signatoryName && !/^\[/.test(r.data.signatoryName) ? r.data.signatoryName : ''), title: (r.data && r.data.signatoryTitle && !/^\[/.test(r.data.signatoryTitle) ? r.data.signatoryTitle : '') }))).catch(() => {});
  }, []);
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
      // one file opens at once - not for the BDE team / Admin, who also add papers here
      if (!data.denied && !data.canAdd && data.items.length === 1 && !Object.keys(data.dl || {}).length && (!data.esign || data.items[0].key === 'esign')) {
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
  // Vasu sir confirmation / Client confirmation / Signed agreement: one more signed file each time
  async function addPaper(file) {
    const type = paperType.current;
    if (!file || !type) return;
    setErr(''); setNote(''); setBusy(`paper-${type}`);
    try {
      const f = new FormData();
      f.append('file', file);
      const r = await api.post(`/agreement/${clientId}/signed-files?type=${type}`, f);
      setNote(r.data?.message || 'Uploaded.');
      setD(await load());
      if (onChanged) onChanged();
    } catch (e) { setErr(e.response?.data?.error || 'The file could not be uploaded. Please try again.'); }
    setBusy('');
    if (paperInput.current) paperInput.current.value = '';
  }
  const hasPaper = (label) => !!(d && d.items.some((it) => it.label === label));

  if (!d) return null;
  const none = !d.items.length && !Object.keys(d.dl || {}).length;
  const dlShown = !d.denied && (Object.keys(d.dl || {}).length > 0 || (d.canAdd && d.esign));
  const dlBoth = DL.every((x) => d.dl && d.dl[x.kind] && d.dl[x.kind].esign && d.dl[x.kind].esign.valid);
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
        {/* AADHAAR eSIGN THROUGH DIGILOCKER: TeamLink's copy on the left, the client's on the right, each checked valid */}
        {dlShown && (
          <div className="vag-up" style={{ marginTop: 12 }}>
            <div className="saf-label" style={{ marginBottom: 4 }}>Aadhaar eSign through DigiLocker (free)</div>
            <div className="small-muted" style={{ fontSize: 12, marginBottom: 8, lineHeight: 1.5 }}>
              1. TeamLink stamp saved (once). 2. Download the agreement PDF to eSign: the TeamLink stamp is printed on it.
              {' '}3. The TeamLink director eSigns it in DigiLocker; upload that file on the left. 4. Send to client: on their link the client
              {' '}puts their stamp on, eSigns in DigiLocker and submits - their copy appears on the right by itself.
              {' '}Both copies together are the signed agreement (signed in counterparts).
            </div>
            <TeamLinkStampRow />
            {d.esign && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'flex-end', marginBottom: 6 }}>
                <label className="field" style={{ margin: 0, minWidth: 200 }}><span style={{ fontSize: 12 }}>Who eSigns for TeamLink (name as on Aadhaar)</span>
                  <input value={esignAs.name} maxLength={80} placeholder="e.g. Vasudeva Rao Chitturi" onChange={(e) => setEsignAs({ ...esignAs, name: e.target.value })} /></label>
                <label className="field" style={{ margin: 0, minWidth: 140 }}><span style={{ fontSize: 12 }}>Designation</span>
                  <input value={esignAs.title} maxLength={80} placeholder="e.g. MD" onChange={(e) => setEsignAs({ ...esignAs, title: e.target.value })} /></label>
              </div>
            )}
            {d.esign && (
              <button type="button" className="btn btn-sm" style={{ marginBottom: 8 }} disabled={!!busy} onClick={() => pickItem({ key: 'fresh', path: `/agreement/${clientId}/pdf?fresh=1${esignAs.name.trim() ? `&signer=${encodeURIComponent(esignAs.name.trim())}&title=${encodeURIComponent(esignAs.title.trim())}` : ''}`, mime: 'application/pdf', canShow: true, fileName: 'agreement-to-eSign.pdf' }, true)}>
                Download agreement PDF to eSign
              </button>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
              {DL.map((x) => {
                const f = d.dl && d.dl[x.kind];
                const ok = f && f.esign && f.esign.valid;
                return (
                  <div key={x.type} style={{ border: `1px solid ${ok ? 'var(--green, #15803d)' : 'var(--border, #d5dbe5)'}`, borderRadius: 8, padding: 10 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>For {x.side}</div>
                    {f ? (
                      <>
                        <div style={{ color: ok ? 'var(--green, #15803d)' : 'var(--danger, #b42318)', fontWeight: 600, fontSize: 13 }}>{ok ? '✓ Valid Aadhaar eSign' : 'Signature not checked'}</div>
                        {f.esign && f.esign.signer && <div style={{ fontSize: 13 }}>Signed by <b>{f.esign.signer}</b></div>}
                        {f.esign && f.esign.signedAt && <div className="small-muted" style={{ fontSize: 12 }}>{whenOf(f.esign.signedAt)}</div>}
                        {f.esign && f.esign.issuer && <div className="small-muted" style={{ fontSize: 12 }}>Certificate: {f.esign.issuer}</div>}
                        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                          <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => pickItem({ ...f, key: f.id }, false)}>View</button>
                          <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => pickItem({ ...f, key: f.id }, true)}>Download</button>
                        </div>
                      </>
                    ) : <div className="small-muted" style={{ fontSize: 13 }}>Not uploaded yet</div>}
                    {d.canAdd && (
                      <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} disabled={!!busy} onClick={() => { paperType.current = x.type; if (paperInput.current) paperInput.current.click(); }}>
                        {busy === `paper-${x.type}` ? 'Checking…' : (f ? 'Upload again' : `Upload ${x.side} eSigned PDF`)}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {dlBoth && <div style={{ marginTop: 8, color: 'var(--green, #15803d)', fontWeight: 600, fontSize: 13 }}>Both sides signed with Aadhaar eSign. The agreement is Active.</div>}
            {/* one page with both signatures side by side, checked again when it is made (TeamLink's summary, 2026-10-31) */}
            {Object.keys(d.dl || {}).length > 0 && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Signature summary (both sides):</span>
                <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => pickItem({ key: 'sum', path: `/agreement/${clientId}/esign-summary`, mime: 'application/pdf', canShow: true, fileName: 'signature-summary.pdf' }, false)}>View</button>
                <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => pickItem({ key: 'sumd', path: `/agreement/${clientId}/esign-summary?download=1`, mime: 'application/pdf', canShow: true, fileName: 'signature-summary.pdf' }, true)}>Download</button>
              </div>
            )}
            <div className="small-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
              Checked here: the PDF carries a digital signature, it verifies with the signer&apos;s certificate, and the file was not changed after signing. A merged or printed copy has no signature and is refused. Adobe Acrobat Reader also checks the certificate chain.
            </div>
          </div>
        )}
        {!d.denied && d.canAdd && (
          <div className="vag-up" style={{ marginTop: 12 }}>
            <div className="saf-label" style={{ marginBottom: 6 }}>Upload papers</div>
            <input ref={paperInput} type="file" accept={UPLOAD_ACCEPT} style={{ display: 'none' }} onChange={(e) => addPaper(e.target.files && e.target.files[0])} />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {PAPERS.map(([type, label]) => (
                <button
                  key={type}
                  type="button"
                  className="btn btn-sm"
                  disabled={!!busy}
                  onClick={() => { paperType.current = type; if (paperInput.current) paperInput.current.click(); }}
                >
                  {busy === `paper-${type}` ? 'Uploading…' : `${hasPaper(label) ? '✓ ' : ''}${label}`}
                </button>
              ))}
            </div>
            <div className="small-muted" style={{ fontSize: 12, marginTop: 6 }}>PDF, Word or picture, up to 10 MB. Each upload is kept; nothing is replaced.</div>
            {note && <div className="small-muted" style={{ marginTop: 4, color: 'var(--green, #15803d)' }}>{note}</div>}
          </div>
        )}
        {/* "Open e-sign agreement" (the online signing link page) is gone: signing is Aadhaar eSign in DigiLocker only (founder 2026-10-31) */}
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

// A CLIENT THAT SIGNED OUTSIDE THE ATS (founder 2026-10-29): name, location, department -> it is in Clients at once
// (POST /agreement/new-client-signed); onAdded(id) then opens the View agreement window for its papers. Used by the
// View agreement picker (BDE dashboard) and the Clients page button. The server decides who may (BDE team, Admin).
export function AddSignedClientDialog({ onClose, onAdded, onOpenExisting, onBack }) {
  const [nc, setNc] = useState({ name: '', location: '', department: '' });
  const [ncErr, setNcErr] = useState('');
  const [ncBusy, setNcBusy] = useState(false);
  const [existing, setExisting] = useState('');
  async function addClient() {
    setNcErr(''); setExisting(''); setNcBusy(true);
    try {
      const r = await api.post('/agreement/new-client-signed', nc);
      onAdded(r.data.client.id, r.data);
    } catch (e) {
      setNcErr(e.response?.data?.error || 'Could not add the client. Please try again.');
      if (e.response?.data?.clientId) setExisting(e.response.data.clientId);
    }
    setNcBusy(false);
  }
  return createPortal(
    <Modal
      title="New client — agreement already signed"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onBack || onClose}>{onBack ? 'Back' : 'Cancel'}</button>
          {existing && onOpenExisting && <button type="button" className="btn" onClick={() => onOpenExisting(existing)}>Open that client</button>}
          <button type="button" className="btn btn-primary" disabled={ncBusy || nc.name.trim().length < 2 || !nc.location.trim() || !nc.department} onClick={addClient}>{ncBusy ? 'Adding…' : 'Add client, then upload papers'}</button>
        </>
      )}
    >
      <div className="small-muted" style={{ marginBottom: 8 }}>For a client who signed before they were in the ATS. They show in Clients at once; next you upload the signed papers.</div>
      <label className="field"><span>Client name (as on the agreement)</span><input value={nc.name} maxLength={160} onChange={(e) => setNc({ ...nc, name: e.target.value })} /></label>
      <label className="field"><span>Location (city / branch)</span><input value={nc.location} maxLength={120} onChange={(e) => setNc({ ...nc, location: e.target.value })} /></label>
      <label className="field">
        <span>Department</span>
        <Combo value={nc.department} onChange={(e) => setNc({ ...nc, department: e.target.value })}>
          <option value="">Pick one</option>
          {CLIENT_DEPTS.map((x) => <option key={x} value={x}>{deptLabel(x)}</option>)}
        </Combo>
      </label>
      {ncErr && <div className="error-text">{ncErr}</div>}
    </Modal>,
    document.body,
  );
}

// The Clients page button: add the client, then its papers are uploaded in the View agreement window that opens.
export function AddSignedClientButton({ className = 'btn', onAdded }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState('');
  return (
    <>
      <button type="button" className={className} style={{ whiteSpace: 'nowrap' }} title="A client who already signed an agreement but is not in the ATS yet" onClick={() => setOpen(true)}>+ Client with signed agreement</button>
      {open && (
        <AddSignedClientDialog
          onClose={() => setOpen(false)}
          onAdded={(id) => { setOpen(false); setView(id); if (onAdded) onAdded(id); }}
          onOpenExisting={(id) => { setOpen(false); setView(id); }}
        />
      )}
      {view && <ViewAgreementWindow clientId={view} onClose={() => setView('')} onChanged={onAdded} />}
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
  const [adding, setAdding] = useState(false); // a client that signed OUTSIDE the ATS (AddSignedClientDialog)
  // every client whose agreement this login may open (a BDE: all of them, view only - 2026-10-29), not just the clients
  // the screen happens to list; the screen's own list stays the fallback
  const [all, setAll] = useState(null);
  useEffect(() => {
    if (!ask || all) return;
    api.get('/agreement/viewable-clients').then((r) => setAll(r.data.rows || [])).catch(() => setAll([]));
  }, [ask, all]);
  const list = all && all.length ? all : clients;
  if (!show) return null;
  return (
    <>
      <button type="button" className={`${className} vag-btn`} style={{ whiteSpace: 'nowrap' }} onClick={() => { setId(''); setAdding(false); setAsk(true); }}>View agreement</button>
      {ask && adding && (
        <AddSignedClientDialog
          onClose={() => setAsk(false)}
          onBack={() => setAdding(false)}
          onAdded={(newId) => { setAll(null); setAdding(false); setAsk(false); setView(newId); }}
          onOpenExisting={(oldId) => { setAsk(false); setView(oldId); }}
        />
      )}
      {ask && !adding && (
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
              {list.map((c) => <option key={c.id} value={c.id}>{clientLabel(c)}</option>)}
            </Combo>
          </label>
          <div className="small-muted" style={{ marginTop: 8 }}>
            {'Client signed but not in the ATS yet? '}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAdding(true)}>+ Add new client from a signed agreement</button>
          </div>
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
