import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Panel, Btn, TinyBtn, Banner, Field, ConfirmModal, fmtDateTime } from '../ui.jsx';

// Client plans > Leads (server: marketing/clientLeads.js): the client's enquiry page and its links, the month's counts, the leads and their status.
const NEW_LEAD = { name: '', phone: '', source: 'phone', message: '' };
const phoneShown = (d) => (d ? `+${d}` : '');

export default function ClientLeadsPanel({ plan, month, toast, onClose }) {
  const [d, setD] = useState(null); const [err, setErr] = useState(''); const [page, setPage] = useState(null); const [add, setAdd] = useState(NEW_LEAD); const [busy, setBusy] = useState(false); const [gone, setGone] = useState(null);
  const base = `/gs/marketing/services/plans/${plan.id}/leads`;
  const load = useCallback(() => omni.get(base, { month }).then((x) => { setD(x); setErr(''); return x; }).catch((e) => setErr(errOf(e, 'The leads could not be read.'))), [base, month]);
  useEffect(() => { load().then((x) => x && setPage({ ...x.page, phone: phoneShown(x.page.phone), whatsapp: phoneShown(x.page.whatsapp) })); }, [load]);
  const run = async (fn, done) => { setBusy(true); try { await fn(); if (done) toast(done); await load(); return true; } catch (e) { toast(errOf(e, 'It could not be saved.')); return false; } finally { setBusy(false); } };
  const setP = (k) => (e) => setPage({ ...page, [k]: e.target.value });
  const setA = (k) => (e) => setAdd({ ...add, [k]: e.target.value });
  const savePage = (on) => run(async () => { const r = await omni.put(`${base}/page`, { heading: page.heading, phone: page.phone, whatsapp: page.whatsapp, privacyContact: page.privacyContact, on }); setPage({ ...r.page, phone: phoneShown(r.page.phone), whatsapp: phoneShown(r.page.whatsapp) }); }, 'Enquiry page saved');
  const addLead = () => run(async () => { await omni.post(base, add); setAdd(NEW_LEAD); }, 'Lead added');
  const change = (l, patch) => run(() => omni.put(`${base}/${l.id}`, patch));
  const linkOf = (source) => `${window.location.origin}${d.page.path}?s=${source}`;
  const copy = async (source) => { const u = linkOf(source); try { await navigator.clipboard.writeText(u); toast('Link copied'); } catch { window.prompt('Copy the link:', u); } };
  const download = async () => {
    try {
      const blob = await omni.blob(`${base}.csv`, { month });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `leads-${plan.clientName.replace(/[^\w-]+/g, '-')}-${month}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { toast(errOf(e, 'The file could not be made.')); }
  };
  const c = d && d.counts;
  return (
    <Panel title={`Leads: ${plan.clientName} · ${month}`} style={{ marginBottom: 12 }} right={<span style={{ display: 'flex', gap: 6 }}><TinyBtn disabled={!d || !d.leads.length} onClick={download}>⬇ Download</TinyBtn><TinyBtn onClick={onClose}>Close</TinyBtn></span>}>
      {err ? <Banner tone="error">{err}</Banner> : null}
      {!d || !page ? (err ? null : <div style={{ fontSize: 12 }}>Loading…</div>) : (
        <div>
          <div style={{ fontSize: 13, marginBottom: 10 }}>
            <b>{c.total}</b> enquiries · <b>{c.waiting}</b> not contacted · <b>{c.customers}</b> customers · <b>{c.callPresses}</b> call presses · <b>{c.whatsappPresses}</b> WhatsApp presses
          </div>
          <details open={!d.page.on} style={{ marginBottom: 12 }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>Enquiry page: {d.page.on ? 'On' : 'Off'}</summary>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 10, marginTop: 8 }}>
              <Field label="HEADING"><input value={page.heading} maxLength={120} placeholder={plan.clientName} onChange={setP('heading')} /></Field>
              <Field label="CALL NUMBER"><input value={page.phone} maxLength={20} inputMode="tel" onChange={setP('phone')} /></Field>
              <Field label="WHATSAPP NUMBER"><input value={page.whatsapp} maxLength={20} inputMode="tel" onChange={setP('whatsapp')} /></Field>
              <Field label="PRIVACY CONTACT (PHONE OR EMAIL)"><input value={page.privacyContact} maxLength={120} onChange={setP('privacyContact')} /></Field>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              {d.page.on ? <><Btn primary disabled={busy} onClick={() => savePage(true)}>Save</Btn><Btn disabled={busy} onClick={() => savePage(false)}>Switch off</Btn></>
                : <><Btn primary disabled={busy} onClick={() => savePage(true)}>Save and switch on</Btn><Btn disabled={busy} onClick={() => savePage(false)}>Save</Btn></>}
              {d.page.on ? <a className="tiny-btn" href={linkOf('direct')} target="_blank" rel="noopener noreferrer">Open page</a> : null}
            </div>
            {d.page.on ? (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: '#166534', marginBottom: 4 }}>COPY THE LINK FOR</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{d.linkSources.map(([k, w]) => <TinyBtn key={k} onClick={() => copy(k)}>🔗 {w}</TinyBtn>)}</div>
              </div>
            ) : null}
          </details>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 8, alignItems: 'end', marginBottom: 10 }}>
            <Field label="NAME"><input value={add.name} maxLength={100} onChange={setA('name')} /></Field>
            <Field label="PHONE"><input value={add.phone} maxLength={20} inputMode="tel" onChange={setA('phone')} /></Field>
            <Field label="CAME FROM"><select value={add.source} onChange={setA('source')}>{[...d.handSources, ...d.linkSources].map(([k, w]) => <option key={k} value={k}>{w}</option>)}</select></Field>
            <Field label="WHAT THEY NEED"><input value={add.message} maxLength={600} onChange={setA('message')} /></Field>
            <div><Btn primary disabled={busy || (!add.name.trim() && !add.phone.trim())} onClick={addLead}>＋ Add lead</Btn></div>
          </div>
          {!d.leads.length ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>No leads in this month.</div> : (
            <div style={{ overflowX: 'auto' }}>
              <table className="mk-table">
                <thead><tr><th>WHEN</th><th>NAME</th><th>PHONE</th><th>CAME FROM</th><th>MESSAGE</th><th>STATUS</th><th>NOTE</th><th /></tr></thead>
                <tbody>{d.leads.map((l) => (
                  <tr key={l.id}>
                    <td>{fmtDateTime(l.at)}{l.times > 1 ? <small style={{ display: 'block' }}>{l.times} times</small> : null}</td>
                    <td>{l.name || '—'}{l.email ? <small style={{ display: 'block' }}>{l.email}</small> : null}</td>
                    <td>{l.phone ? <a href={`tel:+${l.phone}`}>+{l.phone}</a> : '—'}</td>
                    <td>{l.sourceWords}<small style={{ display: 'block' }}>{l.how === 'form' ? 'Form' : `Added by ${l.addedByName}`}</small></td>
                    <td style={{ maxWidth: 220, whiteSpace: 'pre-wrap' }}>{l.message}</td>
                    <td><select aria-label={`status of ${l.name || l.phone}`} value={l.status} disabled={busy} onChange={(e) => change(l, { status: e.target.value })}>{d.statuses.map(([k, w]) => <option key={k} value={k}>{w}</option>)}</select></td>
                    <td><input aria-label={`note on ${l.name || l.phone}`} defaultValue={l.note} maxLength={500} onBlur={(e) => e.target.value !== l.note && change(l, { note: e.target.value })} /></td>
                    <td><TinyBtn aria-label={`delete ${l.name || l.phone}`} title="Delete" onClick={() => setGone(l)}>🗑</TinyBtn></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {gone ? <ConfirmModal title="Delete this lead?" text={`${gone.name || `+${gone.phone}`} is removed for good.`} yes="Delete" danger onNo={() => setGone(null)} onYes={() => { const l = gone; setGone(null); run(() => omni.del(`${base}/${l.id}`), 'Lead deleted'); }} /> : null}
    </Panel>
  );
}
