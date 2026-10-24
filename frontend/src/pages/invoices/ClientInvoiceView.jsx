// The invoice window of a CLIENT INVOICE ("View" / "Printable invoice"): title
// "Invoice <No>", the summary line, the Client copy / Internal copy tabs, Close,
// and Print / Save as PDF. It shows the one document of all the candidates
// (GET /invoices/group/document), drawn by the same invoiceDocumentHtml the
// emailed / WhatsApp copy uses, so the paper, the screen and the sent copy agree.
import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import { money2, fmtD } from './invFormat';

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export default function ClientInvoiceView({ g, docHtml, onClose }) {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('client');
  const frame = useRef(null);

  useEffect(() => {
    let live = true;
    setDoc(null); setError('');
    api.get('/invoices/group/document', { params: { ids: g.ids.join(',') } })
      .then((r) => { if (live) setDoc(r.data); })
      .catch((e) => { if (live) setError(e.response?.data?.error || 'The invoice could not be opened.'); });
    return () => { live = false; };
  }, [g.key, g.ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const html = useMemo(() => {
    if (!doc) return '';
    const { style, inner } = docHtml(doc, mode);
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.invoiceNumber)} — ${esc(doc.client.name)}</title><style>${style}</style></head><body>${inner}</body></html>`;
  }, [doc, mode, docHtml]);

  const print = () => {
    const w = frame.current && frame.current.contentWindow;
    if (w) { try { w.focus(); w.print(); return; } catch { /* fall through */ } }
    const win = window.open('', '_blank');
    if (!win) { setError('Allow pop-ups to print'); return; }
    win.document.write(html);
    win.document.close();
    setTimeout(() => { try { win.focus(); win.print(); } catch { /* blocked */ } }, 450);
  };

  return (
    <div className="overlay show" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal xwide" role="dialog" aria-label={`Invoice ${g.invoiceNumber}`}>
        <div className="modal-head">
          <div>
            <h3>Invoice {doc ? doc.invoiceNumber : g.invoiceNumber}</h3>
            <div className="small-muted">
              {g.client} · {fmtD(g.invoiceDate)} — before GST {money2(g.billing)} · GST {money2(g.gst)}
              {' '}· after GST {money2(g.invoiceValue)} · TDS {money2(g.tds)} · receivable {money2(g.receivable)}
              {' '}· pending {money2(g.pending)}
            </div>
          </div>
          <button type="button" className="close-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          <div className="qa-row" style={{ marginBottom: 12 }}>
            <button type="button" className={`btn btn-sm ${mode === 'client' ? 'btn-primary' : ''}`} title="What the client receives — no recruiter, no department" onClick={() => setMode('client')}>📄 Client copy</button>
            <button type="button" className={`btn btn-sm ${mode === 'internal' ? 'btn-primary' : ''}`} title="Adds the recruiter, role and department for your own records" onClick={() => setMode('internal')}>🏛 Internal copy</button>
            <span style={{ flex: 1 }} />
            <span className="small-muted">
              {mode === 'client' ? 'This is the copy that gets emailed or sent on WhatsApp.' : 'For the office only — never send this one out.'}
            </span>
          </div>
          {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error}</span></div>}
          {!doc && !error && <div className="small-muted">Opening the invoice…</div>}
          {doc && !doc.company.gstin && (
            <div className="notice" style={{ marginBottom: 10 }}>
              <span><b>No company GSTIN is saved</b> — that is why the invoice prints without one. Fill the company profile in once and every invoice carries it.</span>
            </div>
          )}
          {doc && (
            <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'auto', background: '#fff', padding: 16 }}>
              <iframe ref={frame} title="Invoice preview" style={{ width: '100%', height: 640, border: 0, background: '#fff' }} srcDoc={html} />
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="button" className="btn btn-primary" disabled={!doc} onClick={print}>🖨 Print / Save as PDF</button>
        </div>
      </div>
    </div>
  );
}
