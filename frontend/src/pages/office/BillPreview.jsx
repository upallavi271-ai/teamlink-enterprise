// The bill / invoice preview (one-page spec 11): the file shown in place, with
// View (open it in a new tab) and Download. The file comes from the same
// guarded route as before (GET /office-expenses/:id/proof/file) — Super
// Admin, Admin and Accounts only; ?inline=1 asks for it inline, and only
// Download asks for it as an attachment.
import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { saveBlob } from './officeUtil';

export default function BillPreview({ expense, onClose }) {
  const [url, setUrl] = useState(null);
  const [mime, setMime] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const name = expense.bill?.name || expense.proofName || 'bill';

  useEffect(() => {
    let live = true;
    let made = null;
    api.get(`/office-expenses/${expense.id}/proof/file`, { params: { inline: 1 }, responseType: 'blob' })
      .then((r) => {
        if (!live) return;
        made = URL.createObjectURL(r.data);
        setMime(r.data.type || r.headers?.['content-type'] || '');
        setUrl(made);
      })
      .catch(() => { if (live) setErr('The bill could not be opened — the file may no longer be on the server.'); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [expense.id]);

  const download = async () => {
    setBusy(true);
    try {
      const r = await api.get(`/office-expenses/${expense.id}/proof/file`, { responseType: 'blob' });
      saveBlob(r, name);
    } catch { setErr('The bill could not be downloaded.'); }
    setBusy(false);
  };
  const view = () => { if (url) window.open(url, '_blank', 'noopener,noreferrer'); };
  const isPdf = /pdf/i.test(mime) || /\.pdf$/i.test(name);

  return (
    <Modal
      title="Bill / Invoice"
      note={`${expense.expenseCode || ''}${expense.billNumber ? ` · ${expense.billNumber}` : ''} · ${name}`}
      size="wide oe-bill-modal"
      onClose={onClose}
      footer={(
        <>
          <span style={{ marginRight: 'auto' }} className="small-muted">{name}</span>
          <button type="button" className="btn" onClick={view} disabled={!url}>View</button>
          <button type="button" className="btn btn-primary" onClick={download} disabled={busy}>{busy ? 'Preparing…' : 'Download'}</button>
        </>
      )}
    >
      {err && <div className="notice red"><span>{err}</span></div>}
      {!url && !err && <div className="small-muted"><span className="oe-spin oe-spin-sm" aria-hidden="true" /> Opening the bill…</div>}
      {url && (isPdf
        ? <iframe className="oe-bill-frame" src={url} title={`Bill ${name}`} />
        : <div className="oe-bill-img"><img src={url} alt={`Bill ${name}`} /></div>)}
    </Modal>
  );
}
