// "VIEW STATEMENT": the actual bank statement one bank line came from, that line highlighted and scrolled to, every other
// entry of the statement still there (GET /bank/statement-of/:txnId, utils/bankStatementView.js). Read only.
//   Original file      the uploaded file as the bank sent it, read again on the server - shown when the file is on the server
//   Imported records   the same statement's rows as imported (the bank's own columns), clearly marked as imported records
// A line added by hand, or one no longer on file, says "Bank Statement Not Available" - nothing else is ever opened.
// Opened from an invoice payment (InvoiceDetail.jsx) and from the bank line window (TxnDetail.jsx).
import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { money2, fmtD } from '../invoices/invFormat';
import './unallocated.css';

const HL = { background: '#fff3c4', outline: '2px solid #e0a800', fontWeight: 600 };

export default function StatementView({ txnId, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('');
  const [dlErr, setDlErr] = useState('');
  const hl = useRef(null);

  useEffect(() => {
    let live = true;
    setD(null); setErr('');
    api.get(`/bank/statement-of/${encodeURIComponent(txnId)}`)
      .then((r) => { if (!live) return; setD(r.data); setTab(r.data.original && r.data.original.view ? 'original' : 'imported'); })
      .catch((e) => { if (live) setErr(e.response?.data?.error || 'Bank Statement Not Available.'); });
    return () => { live = false; };
  }, [txnId]);
  // the highlighted row comes into view once the table is drawn (and again when the tab changes)
  useEffect(() => {
    if (hl.current) hl.current.scrollIntoView({ block: 'center' });
  }, [d, tab]);

  const download = async () => {
    setDlErr('');
    try {
      const res = await api.get(d.original.download, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url; a.download = d.original.name || 'statement'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { setDlErr('The original file could not be downloaded.'); }
  };

  const s = d && d.statement;
  const o = d && d.original;
  const im = d && d.imported;
  return (
    <Modal size="xwide" title="Bank statement" onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
      {err && <div className="notice red"><span><b>Bank Statement Not Available.</b> {err.replace(/^Bank Statement Not Available\s*-?\s*/, '')}</span></div>}
      {!d && !err && <div className="small-muted">Opening the statement…</div>}
      {d && !d.available && (
        <>
          <div className="notice red"><span><b>Bank Statement Not Available.</b> {d.reason.replace(/^Bank Statement Not Available\s*-?\s*/, '')}</span></div>
          <div className="small-muted" style={{ marginTop: 8 }}>
            The bank line itself: {fmtD(d.line.date)} · {d.line.narration} · {d.line.type === 'Credit' ? 'credit' : 'debit'} {money2(d.line.amount)}{d.line.reference ? ` · Ref ${d.line.reference}` : ''}{d.account ? ` · ${d.account.label}` : ''}
          </div>
        </>
      )}
      {d && d.available && (
        <>
          <div className="td-grid td-stmt">
            <div className="td-kv"><i>Bank account</i><b>{s.account ? s.account.label : '—'}</b></div>
            <div className="td-kv"><i>Statement file</i><b>{s.file || '—'}</b></div>
            <div className="td-kv"><i>Statement period</i><b>{s.from || s.to ? `${s.from ? fmtD(s.from) : '…'} to ${s.to ? fmtD(s.to) : '…'}` : '—'}</b></div>
            <div className="td-kv"><i>Imported on</i><b>{s.importedOn ? `${fmtD(s.importedOn)}${s.importedBy ? ` by ${s.importedBy}` : ''}` : '—'}</b></div>
            <div className="td-kv"><i>Opening / closing balance</i><b>{s.openingBalance != null ? money2(s.openingBalance) : '—'} / {s.closingBalance != null ? money2(s.closingBalance) : '—'}</b></div>
            <div className="td-kv"><i>This payment&apos;s line</i><b>{fmtD(d.line.date)} · {money2(d.line.amount)}{d.line.sourceLine ? ` · row ${d.line.sourceLine}` : ''}</b></div>
          </div>
          {s.recordMissing && <div className="notice amber" style={{ marginBottom: 8 }}><span>The record of this statement import is gone; the lines imported with it are shown.</span></div>}

          <div className="tabbar" style={{ marginBottom: 8 }}>
            {o.view && <button type="button" className={`tab-btn ${tab === 'original' ? 'active' : ''}`} onClick={() => setTab('original')}>Original statement file</button>}
            <button type="button" className={`tab-btn ${tab === 'imported' ? 'active' : ''}`} onClick={() => setTab('imported')}>Imported records ({im.rows.length})</button>
            {o.download && <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={download}>Download original file</button>}
          </div>
          {dlErr && <div className="notice red"><span>{dlErr}</span></div>}

          {tab === 'original' && o.view && (
            <>
              <div className="small-muted" style={{ marginBottom: 6 }}>
                {o.name} as uploaded{o.view.sheets > 1 ? ` · sheet "${o.view.sheet}"` : ''} · row numbers as in the file.
                {o.view.highlightRow ? ` Row ${o.view.highlightRow} is this payment's line.` : ' This line\'s row could not be found in the file for sure - see Imported records.'}
              </div>
              <div className="tbl-wrap" style={{ maxHeight: '58vh', overflow: 'auto' }}>
                <table>
                  <tbody>
                    {o.view.rows.map((r) => (
                      <tr key={r.n} ref={r.n === o.view.highlightRow ? hl : undefined} style={r.n === o.view.highlightRow ? HL : undefined} aria-current={r.n === o.view.highlightRow ? 'true' : undefined}>
                        <td className="small-muted">{r.n}</td>
                        {r.cells.map((c, k) => <td key={k}>{c}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {tab === 'imported' && (
            <>
              <div className="notice amber" style={{ marginBottom: 6 }}>
                <span>
                  <b>Imported records - not the bank&apos;s own document.</b> These are the rows of this statement as they were imported, in the bank&apos;s own columns.
                  {!o.kept && ' The original file was not kept (it was imported before files were stored).'}
                  {o.kept && !o.view && ` The original file${o.name ? ` (${o.name})` : ''} is not on this server.`}
                  {s.skipped > 0 && ` ${s.skipped} row(s) of the file were already on file from an earlier statement and are not repeated here.`}
                </span>
              </div>
              <div className="tbl-wrap" style={{ maxHeight: '58vh', overflow: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Row</th>
                      {im.columns.length
                        ? im.columns.map((c) => <th key={c}>{c}</th>)
                        : <><th>Date</th><th>Value date</th><th>Narration</th><th>Reference</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></>}
                      <th>Status / matched to</th>
                    </tr>
                  </thead>
                  <tbody>
                    {im.rows.map((r) => (
                      <tr key={r.txnId} ref={r.highlight ? hl : undefined} style={r.highlight ? HL : undefined} aria-current={r.highlight ? 'true' : undefined}>
                        <td className="small-muted">{r.rowNo || '—'}</td>
                        {r.cells && im.columns.length
                          ? r.cells.map((c, k) => <td key={k}>{c}</td>)
                          : (im.columns.length
                            ? <td colSpan={im.columns.length}>{fmtD(r.date)} · {r.narration} · {r.credit != null ? `credit ${money2(r.credit)}` : `debit ${money2(r.debit)}`}</td>
                            : <><td>{fmtD(r.date)}</td><td>{r.valueDate ? fmtD(r.valueDate) : '—'}</td><td>{r.narration}</td><td>{r.reference || '—'}</td><td className="num">{r.debit != null ? money2(r.debit) : ''}</td><td className="num">{r.credit != null ? money2(r.credit) : ''}</td><td className="num">{r.balance != null ? money2(r.balance) : '—'}</td></>)}
                        <td>
                          {r.state}
                          {r.invoices.length > 0 && <div className="small-muted">{r.invoices.map((x) => `${x.invoiceNumber || 'invoice'} ${money2(x.amount)}`).join(', ')}</div>}
                          {r.highlight && <div><b>← this payment</b></div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
