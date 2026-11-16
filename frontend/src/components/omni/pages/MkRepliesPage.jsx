import { useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Pill, Banner, Empty, fmtDateTime } from '../ui.jsx';

// AI MARKETING > CLIENT REPLIES (2026-11-16, simple like Green Start): everything clients said or decided, newest first, in one list: an approval link they answered, an option they
// chose, changes they asked for, a WhatsApp message they wrote. Read only (server: marketing/replies.js). Each row opens the place where it is handled.
const TONE = { good: 'live', warn: 'warn', info: 'draft' };
export default function MkRepliesPage() {
  const { go } = useOmni();
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const load = () => { setErr(''); omni.get('/gs/marketing/replies').then((d) => setList(d.replies || [])).catch((e) => setErr(errOf(e, 'The client replies could not be read.'))); };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (err && !list) return <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Try again</button></Banner>;
  if (!list) return <div className="card panel">Loading…</div>;
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Client replies" lead="What your clients answered or wrote, newest first (the last 60 days).">
        <Btn onClick={load}>Refresh</Btn>
      </PageHead>
      <Panel title={`${list.length} repl${list.length === 1 ? 'y' : 'ies'}`}>
        {list.length === 0 ? <Empty title="No client has answered yet">When a client approves, chooses an option, asks for changes or writes on WhatsApp, it appears here.</Empty> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mk-table"><thead><tr><th>WHEN</th><th>CLIENT</th><th>ABOUT</th><th>THEY</th><th>THEIR WORDS</th><th /></tr></thead>
              <tbody>{list.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.at)}</td>
                  <td><b>{r.client}</b>{r.who ? <div style={{ fontSize: 11, color: 'var(--muted)' }}>{r.who}</div> : null}</td>
                  <td>{r.what}</td>
                  <td><Pill tone={TONE[r.tone] || 'draft'} dot>{r.answer}</Pill></td>
                  <td style={{ maxWidth: 320, fontSize: 12 }}>{r.text || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                  <td><TinyBtn onClick={() => go(r.page, r.open ? { open: r.open } : undefined)}>Open</TinyBtn></td>
                </tr>
              ))}</tbody></table>
          </div>
        )}
      </Panel>
    </div>
  );
}
