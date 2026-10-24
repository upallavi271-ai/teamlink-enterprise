import { useEffect, useState } from 'react';
import api from '../../api';

// The client's own agreement kept as a file (PDF, Word or picture). Shows its name and two plain buttons:
// "Open the file" (a PDF / picture opens in a new tab) and "Download". Nothing is shown when there is no file
// or when this login may not read the agreement (the server refuses; we stay quiet).
export default function OwnAgreementFile({ clientId, show, refreshKey }) {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    if (!show || !clientId) { setInfo(null); return undefined; }
    api.get(`/agreement/${clientId}/own-file/info`)
      .then((r) => { if (live) setInfo(r.data && r.data.has && r.data.own !== false ? r.data : null); })
      .catch(() => { if (live) setInfo(null); });
    return () => { live = false; };
  }, [clientId, show, refreshKey]);
  if (!info) return null;

  async function get(download) {
    setErr('');
    try {
      const r = await api.get(`/agreement/${clientId}/own-file`, { responseType: 'blob', params: download ? { download: 1 } : {} });
      const blob = new Blob([r.data], { type: info.mime || r.data.type });
      const url = URL.createObjectURL(blob);
      if (download || !info.canShow) {
        const a = document.createElement('a');
        a.href = url; a.download = info.name || 'agreement'; document.body.appendChild(a); a.click(); a.remove();
      } else {
        window.open(url, '_blank', 'noopener');
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      setErr('Could not open the file. Please try again.');
    }
  }

  return (
    <div className="small-muted" style={{ fontSize: 12.5, marginTop: 8 }}>
      <span>{`The client's agreement file: ${info.name}`}</span>{' '}
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => get(false)}>{info.canShow ? 'Open the file' : 'Download the file'}</button>
      {info.canShow && <button type="button" className="btn btn-sm btn-ghost" onClick={() => get(true)}>Download</button>}
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}
