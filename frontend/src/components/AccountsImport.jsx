import { useState } from 'react';
import api from '../api';
import { Modal } from './proto.jsx';

// ---------------------------------------------------------------------------
// ACCOUNTS — IMPORT ANY FILE
//
// One dialog behind the Import button on every Accounts screen. Excel (xlsx,
// xls, xlsm, xlsb), OpenDocument, CSV, TSV or plain text — the server reads
// it, finds the header row, says what it thinks the sheet is (bank statement,
// expenses, invoices) and which column is which. Everything it guessed can be
// changed here before a single line is written; each change re-reads the file.
//
//   kind  'bank' | 'expenses' | 'invoices' — the screen's own kind, or '' to
//         let the file decide (the Accounts dashboard)
// ---------------------------------------------------------------------------

const CHECK = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, margin: 0 };
const BOX = { width: 16, height: 16, margin: 0, flex: 'none' };
const ROW = { display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 };
const inr = (n) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const d = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

const SAMPLE_COLUMNS = {
  bank: [['line', 'Row'], ['date', 'Date', d], ['description', 'Narration'], ['reference', 'Ref'], ['type', 'Type'], ['amount', 'Amount', inr], ['balance', 'Balance', inr]],
  expenses: [['line', 'Row'], ['expenseDate', 'Date', d], ['category', 'Category'], ['vendor', 'Paid to'], ['billNumber', 'Bill no'], ['base', 'Before GST', inr], ['gst', 'GST', inr], ['tds', 'TDS', inr], ['paidStatus', 'Status']],
  invoices: [['line', 'Row'], ['invoiceNumber', 'Invoice no'], ['invoiceDate', 'Date', d], ['client', 'Client'], ['candidate', 'Candidate'], ['amount', 'Before GST', inr], ['gst', 'GST', (v) => (v == null ? 'client rate' : inr(v))], ['received', 'Received', inr]],
};

export default function AccountsImport({ kind: fixedKind = '', bankAccountId = '', onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [pasted, setPasted] = useState('');
  const [kind, setKind] = useState(fixedKind);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);
  const [account, setAccount] = useState(bankAccountId);
  const [dedup, setDedup] = useState(true);
  const [autoPost, setAutoPost] = useState(true);
  const [createClients, setCreateClients] = useState(false);

  function form(f, choice) {
    const fd = new FormData();
    if (choice.kind) fd.append('kind', choice.kind);
    if (choice.sheet) fd.append('sheet', choice.sheet);
    if (choice.mapping) fd.append('mapping', JSON.stringify(choice.mapping));
    fd.append('file', f);
    return fd;
  }

  async function read(f, choice = {}) {
    if (!f) return;
    setErr(''); setBusy(true);
    try {
      const res = await api.post('/accounts-import/preview', form(f, { kind, ...choice }));
      setPreview(res.data);
      setKind(res.data.kind);
      if (res.data.kind === 'bank' && !account && res.data.summary.bankAccounts?.length) {
        setAccount(res.data.summary.bankAccounts[0].id);
      }
    } catch (e) {
      setPreview(null);
      setErr(e.response?.data?.error || 'That file could not be read.');
    } finally { setBusy(false); }
  }

  function choose(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setResult(null);
    read(f, { kind: fixedKind, sheet: '', mapping: null });
  }

  function usePasted() {
    if (!pasted.trim()) return;
    // Pasted rows are tab-separated when copied out of Excel, comma-separated
    // from a CSV — the server reads either.
    const f = new File([pasted], /\t/.test(pasted) ? 'pasted rows.tsv' : 'pasted rows.csv', { type: 'text/plain' });
    setFile(f);
    read(f, { kind: fixedKind, sheet: '', mapping: null });
  }

  const currentMapping = () => Object.fromEntries((preview?.mapping || []).map((m) => [m.field, m.columns]));
  const remap = (field, value) => {
    const next = currentMapping();
    next[field] = value === '' ? [] : value.split(',').map(Number);
    read(file, { sheet: preview.sheet, mapping: next });
  };

  async function commit() {
    setErr(''); setBusy(true);
    try {
      const fd = form(file, { kind: preview.kind, sheet: preview.sheet, mapping: currentMapping() });
      fd.append('dedup', dedup ? 'true' : 'false');
      if (preview.kind === 'bank') {
        if (account) fd.append('bankAccountId', account);
        fd.append('autoPost', autoPost ? 'true' : 'false');
      }
      if (preview.kind === 'invoices') fd.append('createClients', createClients ? 'true' : 'false');
      const res = await api.post('/accounts-import/commit', fd);
      setResult(res.data);
      if (onDone) onDone(res.data);
    } catch (e) {
      setErr(e.response?.data?.error || 'The import failed — nothing was written.');
    } finally { setBusy(false); }
  }

  if (result) {
    return (
      <Modal title="Import finished" onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
        <div className="notice">
          <span>
            <b>{result.imported}</b> {result.kind === 'bank' ? 'statement line(s)' : result.kind === 'expenses' ? 'expense(s)' : 'invoice(s)'} imported from <b>{file?.name}</b>.
            {result.duplicates > 0 && <> {result.duplicates} already on file — skipped, nothing overwritten.</>}
          </span>
        </div>
        <ul className="small-muted" style={{ margin: '10px 0 0 18px', lineHeight: 1.7 }}>
          {result.value != null && <li>Value {inr(result.value)}.</li>}
          {result.openingSetTo != null && <li>Opening balance worked out from the statement: {inr(result.openingSetTo)}.</li>}
          {result.autoPosted > 0 && <li>{result.autoPosted} credit(s) posted against client invoices — each can be undone on the Bank screen.</li>}
          {result.clientsCreated > 0 && <li>{result.clientsCreated} new client(s) added — fill in their GST and terms on the Clients screen.</li>}
          {result.paymentsRecorded > 0 && <li>{result.paymentsRecorded} receipt(s) recorded from the sheet.</li>}
          {result.noClient > 0 && <li>{result.noClient} line(s) not imported — no client on file with that name.</li>}
          {result.skippedLines > 0 && <li>{result.skippedLines} row(s) in the sheet were blank, totals or headings, and were passed over.</li>}
        </ul>
      </Modal>
    );
  }

  const s = preview?.summary || {};
  const cols = preview ? SAMPLE_COLUMNS[preview.kind] : [];
  const importable = preview && preview.permitted && s.rows > 0;

  return (
    <Modal
      wide
      title={fixedKind ? `Import ${fixedKind === 'bank' ? 'bank statement' : fixedKind}` : 'Import into Accounts'}
      onClose={onClose}
      footer={(
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !importable} onClick={commit}>
            {busy ? 'Working…' : importable ? `Import ${s.rows} line${s.rows === 1 ? '' : 's'}` : 'Import'}
          </button>
        </>
      )}
    >
      <div className="field">
        <label>File</label>
        <input type="file" onChange={choose} />
        <div className="small-muted" style={{ marginTop: 4 }}>
          Any spreadsheet: Excel <b>.xlsx .xls .xlsm .xlsb</b>, OpenDocument <b>.ods</b>, <b>.csv</b>, <b>.tsv</b> or <b>.txt</b> —
          straight from net banking, Tally, Zoho or your own register. Nothing is written until you press Import.
        </div>
      </div>
      {!preview && (
        <details style={{ marginBottom: 10 }}>
          <summary className="small-muted" style={{ cursor: 'pointer' }}>…or paste the rows instead</summary>
          <textarea
            rows={6}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 11.5, marginTop: 6 }}
            placeholder={'Copy the rows (with the heading row) out of Excel or a statement and paste them here'}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
          <button className="btn btn-sm" disabled={!pasted.trim() || busy} onClick={usePasted}>Read pasted rows</button>
        </details>
      )}

      {busy && !preview && <div className="small-muted">Reading the file…</div>}
      {err && <div className="notice amber" style={{ marginBottom: 10 }}><span>{err}</span></div>}

      {preview && (
        <>
          <div style={ROW}>
            <label className="field"><span>This file is</span>
              <select value={preview.kind} disabled={busy} onChange={(e) => { setKind(e.target.value); read(file, { kind: e.target.value, sheet: preview.sheet, mapping: null }); }}>
                {preview.kinds.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
              </select>
            </label>
            {preview.sheets.length > 1 && (
              <label className="field"><span>Sheet</span>
                <select value={preview.sheet} disabled={busy} onChange={(e) => read(file, { sheet: e.target.value, mapping: null })}>
                  {preview.sheets.map((n) => <option key={n}>{n}</option>)}
                </select>
              </label>
            )}
            <div className="small-muted" style={{ alignSelf: 'end', paddingBottom: 8 }}>
              Headings found on row {preview.headerRow} of <b>{preview.sheet}</b>
            </div>
          </div>

          {!preview.permitted && (
            <div className="notice red" style={{ marginBottom: 8 }}>
              <span>Your login can view but not add {preview.kindLabel.toLowerCase()} — ask an Accounts admin to import this file.</span>
            </div>
          )}

          <div className="notice" style={{ marginBottom: 8 }}>
            <span>
              <b>{s.rows} line(s) ready</b>
              {preview.kind === 'bank' && <> — {s.credits} credit(s) {inr(s.creditValue)} · {s.debits} debit(s) {inr(s.debitValue)} · {d(s.from)} to {d(s.to)}</>}
              {preview.kind === 'expenses' && <> — {inr(s.value)} including {inr(s.gst)} GST</>}
              {preview.kind === 'invoices' && <> — {inr(s.value)} before GST{s.received ? ` · ${inr(s.received)} received` : ''}</>}
              {s.skipped > 0 && <span className="small-muted"> · {s.skipped} blank / total / heading row(s) passed over</span>}
            </span>
          </div>

          {preview.problems.length > 0 && (
            <div className="notice amber" style={{ marginBottom: 8 }}>
              <ul style={{ margin: '0 0 0 16px' }}>{preview.problems.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          )}

          <div style={ROW}>
            {preview.kind === 'bank' && (
              <>
                {s.bankAccounts?.length > 0 && (
                  <label className="field"><span>Into bank account</span>
                    <select value={account} onChange={(e) => setAccount(e.target.value)}>
                      {s.bankAccounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.bank}{a.accNo ? ` · ****${String(a.accNo).slice(-4)}` : ''}{a.name ? ` · ${a.name}` : ''}</option>
                      ))}
                    </select>
                  </label>
                )}
                <label style={CHECK}><input type="checkbox" style={BOX} checked={autoPost} onChange={(e) => setAutoPost(e.target.checked)} /> Post credits that name a client straight to their invoices</label>
              </>
            )}
            <label style={CHECK}><input type="checkbox" style={BOX} checked={dedup} onChange={(e) => setDedup(e.target.checked)} /> Skip lines already on file</label>
            {preview.kind === 'invoices' && preview.clients?.unknown?.length > 0 && (
              <label style={CHECK}>
                <input type="checkbox" style={BOX} checked={createClients} onChange={(e) => setCreateClients(e.target.checked)} />
                {' '}Add the {preview.clients.unknown.length} client(s) not on file (otherwise their lines are left out)
              </label>
            )}
          </div>

          <details open={s.rows === 0} style={{ marginBottom: 10 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Which column is which</summary>
            <div className="grid-2" style={{ marginTop: 8 }}>
              {preview.mapping.map((m) => {
                const value = m.columns.join(',');
                return (
                  <label className="field" key={m.field}><span>{m.label}</span>
                    <select value={value} disabled={busy} onChange={(e) => remap(m.field, e.target.value)}>
                      <option value="">— not in this file —</option>
                      {m.columns.length > 1 && <option value={value}>{m.columnNames.join(' + ')}</option>}
                      {preview.columns.map((c, i) => <option key={i} value={String(i)}>{c}</option>)}
                    </select>
                  </label>
                );
              })}
            </div>
          </details>

          {preview.sample.length > 0 && (
            <div className="tbl-wrap">
              <table>
                <thead><tr>{cols.map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
                <tbody>
                  {preview.sample.map((r) => (
                    <tr key={r.line}>{cols.map(([k, , f]) => <td key={k}>{f ? f(r[k]) : (r[k] ?? '—')}</td>)}</tr>
                  ))}
                </tbody>
              </table>
              {s.rows > preview.sample.length && <div className="small-muted" style={{ padding: 6 }}>First {preview.sample.length} of {s.rows} shown.</div>}
            </div>
          )}
          {preview.skippedSample.length > 0 && (
            <div className="small-muted" style={{ marginTop: 6 }}>
              Passed over: {preview.skippedSample.map((k) => `row ${k.line} (${k.reason})`).join(', ')}{s.skipped > preview.skippedSample.length ? '…' : ''}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
