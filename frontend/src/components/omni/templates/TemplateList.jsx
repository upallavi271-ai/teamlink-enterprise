import { useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Btn, TinyBtn, Pill, GsModal } from '../ui.jsx';
import { langCode, AccountChips } from './tplCommon.jsx';
import { CODE_WORDS } from './policy.js';

// The template list of one channel account (WhatsApp / SMS / Email / Voice): the prototype's table (Template Name | Meta status | Category | Language | Last Updated | Actions)
// with an Edit button on EVERY row. Rows come from the template hub (server: /gs/templates/list).
const WHERE = [['Omni-Channel', 'Omni-Channel messages'], ['all', 'All places'], ['ATS', 'ATS messages'], ['HRMS / internal', 'HRMS / staff'], ['Job Portal', 'Job Portal']];
const CHANNEL_WORD = { whatsapp: 'whatsapp', sms: 'sms', email: 'email', voice: 'voice' };
const when = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—');

export function statusLabel(ch) { return ch === 'whatsapp' ? 'Meta status' : 'Status'; }

export function MetaReviewModal({ item, onClose, onEdit }) {
  const ex = item.extra || {}; const r = ex.review || {}; const meta = ex.meta || {};
  const issues = r.issues || [];
  const codes = [...new Set(issues.filter((i) => i.severity === 'error').map((i) => i.code))];
  const rejected = item.wa && item.wa.status === 'Rejected';
  const d = (x) => (x ? new Date(x).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—');
  return (
    <GsModal title={`Meta review — ${item.name}`} sub="WhatsApp Business message template result" width={600} onClose={onClose}
      foot={<><Btn onClick={onClose}>Close</Btn>{rejected && item.canEdit ? <Btn primary onClick={() => { onClose(); onEdit(item); }}>Edit &amp; resubmit</Btn> : null}</>}>
      <div className="mp-meta-grid">
        <div><label>Status</label><Pill tone={item.statusTone}>{item.statusWord}</Pill></div>
        <div><label>Category</label><b>{item.category}</b></div>
        <div><label>Submitted</label><b>{d(r.submittedAt || meta.submittedAt)}</b></div>
        <div><label>Reviewed</label><b>{d(r.reviewedAt)}</b></div>
        {meta.quality ? <div><label>Quality rating</label><b>{meta.quality}</b></div> : null}
        {meta.reason ? <div><label>Meta says</label><b>{meta.reason}</b></div> : null}
        {codes.length ? <div><label>Rejection codes</label><b>{codes.join(', ')}</b></div> : null}
      </div>
      {codes.length ? <div className="mp-codes">{codes.map((c) => <div className="mp-code-row" key={c}><span className="mp-code">{c}</span><span>{CODE_WORDS[c] || ''}</span></div>)}</div> : null}
      {r.metaError ? <div className="mp-code-row" style={{ marginTop: 8 }}><span className="mp-code">META</span><span>{r.metaError}</span></div> : null}
      {issues.length ? (
        <>
          <div className="mp-section-title">What the check found</div>
          <ul className="mp-list">{issues.map((v, i) => <li key={i} className={`mp-item mp-${v.severity}`}><span className="mp-code">{v.code}</span><div><b>{v.rule}</b><span>{v.message}</span><em>{v.severity === 'info' ? '' : 'Fix: '}{v.fix}</em></div></li>)}</ul>
        </>
      ) : <div className="mp-ok" style={{ marginTop: 12 }}>{r.submittedAt ? 'This template passed every policy check when it was sent.' : 'This template has not been sent to Meta yet, so there is no review to show.'}</div>}
      <p className="mp-note">The advice above comes from our own check of Meta&apos;s published template rules. Meta&apos;s real verdict is only the status shown at the top: it is copied from Meta (&quot;Check with Meta&quot;) or set by an Admin. Nothing is approved by guessing.</p>
    </GsModal>
  );
}

// A WhatsApp template belongs to the WhatsApp account at Meta, so one made in Omni-Channel shows here too, and Meta's approval reaches both apps
// (server: outreach/tplFromMeta.js, every 15 minutes by itself; an Admin can run it now).
function FromMetaBar({ isAdmin, onDone }) {
  const [last, setLast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { omni.get('/gs/templates/from-meta').then((r) => setLast(r.last)).catch(() => {}); }, []);
  async function run() {
    setBusy(true); setErr('');
    try { const r = await omni.post('/gs/templates/from-meta', {}); setLast(r.last); if (onDone) onDone(); } catch (e) { setErr(errOf(e, 'Meta could not be asked now.')); } finally { setBusy(false); }
  }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '0 0 10px', fontSize: 11, color: 'var(--muted)' }}>
      <span>Templates made here or in Omni-Channel get Meta&apos;s approval in both places (checked every 15 minutes).</span>
      {isAdmin ? <TinyBtn onClick={run} disabled={busy}>{busy ? 'Asking Meta…' : 'Bring approvals from Meta now'}</TinyBtn> : null}
      {last ? <span style={{ width: '100%' }}>Last check {new Date(last.at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}: {last.words}</span> : null}
      {err ? <span role="alert" style={{ color: '#9b1c1c', width: '100%' }}>{err}</span> : null}
    </div>
  );
}

export default function TemplateList({ ch, account, data, loading, q, setQ, where, setWhere, approval, setApproval, onCreate, onOpen, onRefresh, onDuplicate, onArchive, onReview, canWrite, err, staffOnly, isAdmin, onFromMeta }) {
  const rows = data.items || [];
  const queue = data.queue;
  const noun = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'email', voice: 'voice' }[ch];
  const showQueue = ch === 'whatsapp' && queue;
  return (
    <div>
      <div className="tpl-list-head">
        <div>
          <h2>{account && account.icon ? `${account.icon} ` : ''}{account ? account.name : noun}</h2>
          <p>Manage and organize your {noun} templates{account && account.sub ? ` · ${account.sub}` : ''}</p>
        </div>
        {canWrite ? <Btn primary onClick={onCreate}>＋ Create Template</Btn> : null}
      </div>
      {err ? <div role="alert" style={{ background: '#fdeced', border: '1px solid #f4c9cc', color: '#9b1c1c', borderRadius: 10, padding: '9px 12px', fontSize: 11, margin: '0 0 10px' }}>{err}</div> : null}
      {ch === 'whatsapp' && account && !account.connected ? (
        <div className="mp-gate" style={{ marginBottom: 10 }}>Not connected: Administration &gt; Integrations &gt; WhatsApp Business. You can write and save templates now; sending one to Meta needs the connection.</div>
      ) : null}
      {ch === 'whatsapp' && !staffOnly ? <FromMetaBar isAdmin={isAdmin} onDone={onFromMeta} /> : null}
      <div className="tpl-toolbar" style={{ flexWrap: 'wrap' }}>
        <input className="search" style={{ flex: 1, minWidth: 180 }} aria-label="Search templates" placeholder="Search by name or category..." value={q} onChange={(e) => setQ(e.target.value)} />
        {ch !== 'voice' && !staffOnly ? <select className="select" aria-label="Where the template is used" value={where} onChange={(e) => setWhere(e.target.value)} style={{ height: 36 }}>{WHERE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select> : null}
        <Btn onClick={onRefresh}>↻ Refresh</Btn>
      </div>
      {showQueue ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '0 0 12px', fontSize: 10, color: 'var(--muted)' }}>
          <button type="button" className={`tiny-btn${approval === 'queue' ? ' on' : ''}`} style={approval === 'queue' ? { background: 'var(--green-3)', borderColor: '#bfe3d0', color: 'var(--green-2)' } : undefined} onClick={() => setApproval(approval === 'queue' ? '' : 'queue')}>Approval queue ({(queue.pending || 0) + (queue.notSent || 0)})</button>
          <span>In review {queue.pending || 0} · Not sent to Meta {queue.notSent || 0} · Rejected {queue.rejected || 0}</span>
          {approval ? <TinyBtn onClick={() => setApproval('')}>Show all</TinyBtn> : null}
        </div>
      ) : null}
      <div className="table-scroll" style={{ border: '1px solid var(--line)', borderRadius: 14 }}>
        <table className="table">
          <thead><tr><th>Template Name</th><th>{statusLabel(ch)}</th><th>Category</th><th>Language</th><th>Last Updated</th><th>Actions</th></tr></thead>
          <tbody>
            {loading && !rows.length ? <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)', padding: '26px 0' }}>Loading…</td></tr> : null}
            {!loading && !rows.length ? <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)', padding: '26px 0' }}>{q ? 'No template matches that search.' : 'No templates yet for this account. Create one to get started.'}</td></tr> : null}
            {rows.map((t) => (
              <tr key={t.key}>
                <td className="campaign-name" style={{ overflowWrap: 'anywhere' }}>{t.name}{t.sourceWord && t.source !== 'outreach' && t.source !== 'voice' ? <div style={{ fontWeight: 600, fontSize: 9, color: 'var(--muted)' }}>{t.sourceWord}{t.group ? ` · ${t.group}` : ''}</div> : null}</td>
                <td>
                  <div className="mp-status-cell">
                    {t.statusWord === 'In review' ? <span className="mp-spin" /> : null}
                    <Pill tone={t.statusTone}>{t.statusWord}</Pill>
                    {t.source === 'outreach' && ch === 'whatsapp' && (t.extra && (t.extra.review || t.extra.meta)) ? <button type="button" className="mp-review-btn" onClick={() => onReview(t)}>{t.statusWord === 'Rejected' ? 'Why?' : 'Details'}</button> : null}
                  </div>
                  {t.source === 'outreach' && ch === 'whatsapp' ? <AccountChips chips={t.accountChips} /> : null}
                </td>
                <td>{t.category ? String(t.category).toUpperCase() : '—'}</td>
                <td>{t.language || t.waLanguage ? langCode(t.language || t.waLanguage) : '—'}</td>
                <td>{when(t.updatedAt)}</td>
                <td>
                  <div className="row-acts" style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    <TinyBtn onClick={() => onOpen(t)}>✎ Edit</TinyBtn>
                    {t.canEdit && (t.source === 'outreach') ? <TinyBtn onClick={() => onDuplicate(t)} title="Make a copy">⧉ Copy</TinyBtn> : null}
                    {t.canEdit && (t.source === 'outreach' || t.source === 'voice') ? <TinyBtn onClick={() => onArchive(t)} title="Remove this template">🗑 Archive</TinyBtn> : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 9, color: 'var(--muted)', marginTop: 10 }}>Showing {rows.length} of {data.total == null ? rows.length : data.total} results</p>
    </div>
  );
}
export { CHANNEL_WORD };
