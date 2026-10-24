import { useCallback, useEffect, useState } from 'react';
import { shared, errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { Banner, Btn, Empty, PageHead, Panel, Pill, Tabs, TinyBtn, fmtDateTime } from '../ui.jsx';
import '../library/library.css';

// INBOX & REPLIES > Needs review: replies the system could NOT match with confidence (the number belongs to more than one record, or to nobody we know).
// Nothing is written on any record until a person picks the right one. A person may only pick among the people shown, and only people they may see.
// Server: GET /api/omni/replies/review, POST .../:id/resolve, POST .../:id/dismiss.
export default function ReviewPage() {
  const { toast } = useOmni();
  const [tab, setTab] = useState('open');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [why, setWhy] = useState({});
  const [busy, setBusy] = useState('');
  const load = useCallback(() => { shared.get('/replies/review', { status: tab }).then((r) => { setD(r); setErr(''); }).catch((e) => setErr(errOf(e, 'The list could not be read.'))); }, [tab]);
  useEffect(() => { load(); }, [load]);
  const pick = async (row, p) => {
    setBusy(row.id);
    try { const r = await shared.post(`/replies/review/${row.id}/resolve`, { personType: p.type, personId: p.id }); toast(r.ok); load(); } catch (e) { setErr(errOf(e, 'That did not work.')); } finally { setBusy(''); }
  };
  const dismiss = async (row) => {
    setBusy(row.id);
    try { const r = await shared.post(`/replies/review/${row.id}/dismiss`, { reason: why[row.id] || '' }); toast(r.ok); load(); } catch (e) { setErr(errOf(e, 'That did not work.')); } finally { setBusy(''); }
  };
  return (
    <div>
      <PageHead eyebrow="Replies that need a person" title="Needs review" lead="We could not tell with confidence who wrote these replies. Pick the right person, or dismiss it. Until then nothing is written on anybody's record." />
      {err && <Banner tone="error">{err}</Banner>}
      <Tabs value={tab} onChange={setTab} tabs={[['open', 'To check', tab === 'open' && d ? d.total : undefined], ['done', 'Checked']]} />
      {!d ? <div className="card panel">Loading…</div> : d.rows.length === 0 ? <Empty title={tab === 'open' ? 'Nothing to check' : 'Nothing checked yet'}>{tab === 'open' ? 'Every reply was matched with confidence.' : ''}</Empty> : d.rows.map((r) => (
        <Panel key={r.id} title={`${r.channel || 'Message'} from ${r.from || 'unknown'}${r.fromName ? ` (${r.fromName})` : ''}`} sub={`${fmtDateTime(r.at)} · ${r.reasonWords}${r.numberLabel ? ` · came to the WhatsApp number ${r.numberLabel}` : ''}`} right={r.status === 'open' ? <Pill tone="warn" dot>To check</Pill> : <Pill tone={r.status === 'dismissed' ? 'draft' : 'live'} dot>{r.status === 'dismissed' ? 'Dismissed' : 'Matched'}</Pill>} style={{ marginBottom: 12 }}>
          <div className="rev-reply">{r.text || '(no words)'}</div>
          {r.status === 'open' ? (
            <>
              {r.possible.length > 0 ? (
                <div>
                  <b style={{ fontSize: 11 }}>It could be:</b>
                  <div className="lib-inline" style={{ marginTop: 6 }}>{r.possible.map((p) => <Btn key={p.type + p.id} small disabled={busy === r.id} onClick={() => pick(r, p)} title="Put this reply on this person's record">{p.typeWord}: {p.name}{p.depts.length ? ` · ${p.depts.join(', ')}` : ''}</Btn>)}</div>
                </div>
              ) : <div className="lib-sub">Nobody we know has this number or address. If you recognise the sender, add the number to their record first; otherwise dismiss it.</div>}
              <div className="lib-inline" style={{ marginTop: 8 }}>
                <input className="input" placeholder="Why dismiss it? (a few words)" value={why[r.id] || ''} onChange={(e) => setWhy({ ...why, [r.id]: e.target.value })} aria-label="Reason" />
                <TinyBtn disabled={busy === r.id || (why[r.id] || '').trim().length < 3} onClick={() => dismiss(r)}>Dismiss</TinyBtn>
              </div>
            </>
          ) : <div className="lib-sub">{r.resolution}{r.resolvedByName ? ` · by ${r.resolvedByName}` : ''}{r.resolvedAt ? ` · ${fmtDateTime(r.resolvedAt)}` : ''}</div>}
        </Panel>
      ))}
    </div>
  );
}
