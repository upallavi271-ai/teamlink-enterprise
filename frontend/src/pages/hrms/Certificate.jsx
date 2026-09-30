import { useEffect, useState } from 'react';
import api from '../../api';
import { Modal } from '../../components/proto.jsx';
import logo from '../../assets/teamlink-full-logo.png';

// ---------------------------------------------------------------------------
// COURSE CERTIFICATE — "View Certificate" and "Download Certificate".
//
// Both read GET /lms/certificates/:assignmentId, which answers only to the
// learner themselves or somebody whose data scope reaches them. View lays the
// payload out here (and Print sends that same layout to the printer); Download
// fetches the PDF the server draws from the SAME payload
// (backend utils/certificatePdf.js), so the two can never disagree.
// ---------------------------------------------------------------------------

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}

// Download is a real file: fetched with the login token (a plain link could
// not carry it), then handed to the browser as a blob.
export async function downloadCertificate(assignmentId, certificateId) {
  const res = await api.get(`/lms/certificates/${assignmentId}/pdf`, { responseType: 'blob' });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${certificateId || 'certificate'}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// The certificate itself. Inline styles only — it is also written into the
// print window, which has none of the app's stylesheet.
function CertificateBody({ cert }) {
  const detail = [
    cert.category,
    cert.duration,
    cert.score != null ? `Assessment score ${cert.score}% (pass mark ${cert.passMark}%)` : null,
  ].filter(Boolean).join('  ·  ');
  return (
    <div style={{ border: '3px solid #1f2a44', padding: 6, background: '#fff', color: '#1f2a44' }}>
      <div style={{ border: '1px solid #0f766e', padding: '28px 32px', textAlign: 'center', fontFamily: 'Georgia, "Times New Roman", serif' }}>
        <img src={logo} alt="TeamLink" style={{ height: 34, marginBottom: 6 }} />
        <div style={{ fontFamily: 'Helvetica, Arial, sans-serif', fontWeight: 700, letterSpacing: 2, fontSize: 12.5, textTransform: 'uppercase' }}>
          {cert.organisation}
        </div>
        <div style={{ fontSize: 30, fontWeight: 700, margin: '18px 0 14px' }}>Certificate of Completion</div>
        <div style={{ fontFamily: 'Helvetica, Arial, sans-serif', color: '#5b6474', fontSize: 13 }}>This is to certify that</div>
        <div style={{ fontSize: 28, fontStyle: 'italic', fontWeight: 700, color: '#0f766e', margin: '8px 0 2px' }}>{cert.employeeName}</div>
        {(cert.employeeCode || cert.department) && (
          <div style={{ fontFamily: 'Helvetica, Arial, sans-serif', color: '#5b6474', fontSize: 11 }}>
            {[cert.employeeCode, cert.department].filter(Boolean).join(' · ')}
          </div>
        )}
        <div style={{ fontFamily: 'Helvetica, Arial, sans-serif', color: '#5b6474', fontSize: 13, marginTop: 12 }}>
          has successfully completed the course
        </div>
        <div style={{ fontFamily: 'Helvetica, Arial, sans-serif', fontSize: 20, fontWeight: 700, margin: '6px 0 4px' }}>{cert.courseTitle}</div>
        {detail && <div style={{ fontFamily: 'Helvetica, Arial, sans-serif', color: '#5b6474', fontSize: 11 }}>{detail}</div>}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, marginTop: 34, fontFamily: 'Helvetica, Arial, sans-serif' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{fmtDate(cert.completedAt)}</div>
            <div style={{ borderTop: '1px solid #5b6474', marginTop: 4, paddingTop: 4, color: '#5b6474', fontSize: 10.5 }}>Date of completion</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{cert.certificateId}</div>
            <div style={{ borderTop: '1px solid #5b6474', marginTop: 4, paddingTop: 4, color: '#5b6474', fontSize: 10.5 }}>Certificate ID</div>
          </div>
        </div>
        <div style={{ fontFamily: 'Helvetica, Arial, sans-serif', color: '#5b6474', fontSize: 9.5, marginTop: 18 }}>
          Issued {fmtDate(cert.issuedAt)} by {cert.organisation}. Verify this certificate by its ID with the HR team.
        </div>
      </div>
    </div>
  );
}

export default function CertificateModal({ assignmentId, onClose }) {
  const [cert, setCert] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get(`/lms/certificates/${assignmentId}`)
      .then((res) => setCert(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not open this certificate.'));
  }, [assignmentId]);

  async function download() {
    setBusy(true); setError('');
    try { await downloadCertificate(assignmentId, cert?.certificateId); } catch {
      setError('Could not download the certificate.');
    } finally { setBusy(false); }
  }

  // Print: the certificate alone, in its own window, landscape.
  function print() {
    const node = document.getElementById('lms-certificate');
    if (!node) return;
    const w = window.open('', '_blank', 'width=1100,height=800');
    if (!w) { setError('Allow pop-ups for this site to print.'); return; }
    // The logo's src is made absolute so the new window can load it.
    const html = node.innerHTML.replace(/src="([^"]+)"/g, (m, src) => `src="${new URL(src, window.location.href).href}"`);
    w.document.write(`<!doctype html><html><head><title>${cert.certificateId}</title>
<style>@page{size:A4 landscape;margin:12mm}body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}</style>
</head><body>${html}<script>window.onload=function(){window.focus();window.print();}</script></body></html>`);
    w.document.close();
  }

  return (
    <Modal
      title="Certificate"
      onClose={onClose}
      wide
      footer={cert && (
        <>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
          <button className="btn btn-sm" onClick={print}>Print</button>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={download}>{busy ? 'Preparing…' : 'Download Certificate (PDF)'}</button>
        </>
      )}
    >
      {error && <div className="error-text">{error}</div>}
      {!cert && !error && <div className="small-muted">Loading certificate…</div>}
      {cert && <div id="lms-certificate"><CertificateBody cert={cert} /></div>}
    </Modal>
  );
}
