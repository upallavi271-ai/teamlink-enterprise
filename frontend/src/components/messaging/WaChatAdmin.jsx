import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Combo from '../Combo.jsx';
import AsyncCombo, { candidateSearcher } from '../AsyncCombo.jsx';

// ---------------------------------------------------------------------------
// ADMIN ONLY (at the bottom of the chats list)
//   1. "Test: pretend the candidate replied" - ONLY in Test mode. The server refuses it when real WhatsApp sending is on.
//      It goes through the SAME code the real webhook uses, so the founder sees the whole flow on localhost without Meta.
//   2. "Remove test messages" - deletes only what the tool made.
//   3. How to receive REAL replies on this computer (the tunnel steps), and the warning about the live site.
// ---------------------------------------------------------------------------
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const KINDS = [['text', 'A text'], ['image', 'A photo'], ['document', 'A PDF'], ['stop', 'The word STOP']];

export default function WaChatAdmin({ cfg, selected, onDone }) {
  const [st, setSt] = useState(null);
  const [kind, setKind] = useState('text');
  const [text, setText] = useState('Yes, I am interested. When can I come?');
  const [pick, setPick] = useState(null);
  const [numberId, setNumberId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const searcher = useMemo(() => candidateSearcher(api), []);

  const load = useCallback(() => api.get('/wa-chats/test/status').then((r) => setSt(r.data)).catch(() => setSt(null)), []);
  useEffect(() => { load(); }, [load]);

  const person = pick || (selected && selected.audience === 'candidates' ? { value: selected.personId, label: selected.name } : null);
  const numbers = (cfg && cfg.numbers && !cfg.numbers.legacy ? cfg.numbers.numbers : []) || [];

  const go = async () => {
    if (!person) return;
    setBusy(true); setMsg(null);
    try {
      await api.post('/wa-chats/test/simulate-reply', { personId: person.value, kind: kind === 'stop' ? 'text' : kind, stop: kind === 'stop', text: kind === 'stop' ? undefined : text, numberId: numberId || undefined });
      setMsg({ ok: true, text: 'Done. The pretend reply is in the chat list now (marked TEST).' });
      load(); if (onDone) onDone();
    } catch (e) { setMsg({ ok: false, text: errOf(e, 'The pretend reply did not work.') }); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm('Remove every pretend (TEST) message? Real messages stay.')) return;
    setBusy(true); setMsg(null);
    try { const r = await api.post('/wa-chats/test/remove', {}); setMsg({ ok: true, text: `Removed ${r.data.removed.candidateMessages + r.data.removed.conversationMessages} pretend messages.` }); load(); if (onDone) onDone(true); } catch (e) { setMsg({ ok: false, text: errOf(e, 'Could not remove them.') }); } finally { setBusy(false); }
  };

  const sim = cfg && cfg.simulate;
  return (
    <details className="wc-admin">
      <summary>Admin: test tools and help for real replies</summary>
      <div className="wc-admin-body">
        <h4>Test: pretend the candidate replied <span className="wc-testtag">TEST</span></h4>
        {sim && !sim.available && <div className="msg-box orange">{sim.why || 'Not available.'}</div>}
        {sim && sim.available && (
          <>
            <div className="small-muted">Nothing goes to Meta or to a real person. The reply is made like a real WhatsApp reply, so you can see the unread count, the chat, the follow-up mark and the bell. It works only in Test mode.</div>
            <div className="wc-fu-row">
              <label htmlFor="wc-sim-who">Who writes</label>
              <AsyncCombo id="wc-sim-who" value={person ? person.value : ''} selected={person} search={searcher} placeholder="Pick a candidate or type a name" emptyText="Type a name" onChange={(v, row) => setPick(v ? { value: v, label: row ? row.label : v } : null)} />
            </div>
            <div className="wc-fu-row">
              <label htmlFor="wc-sim-kind">They send</label>
              <Combo id="wc-sim-kind" value={kind} onChange={(e) => setKind(e.target.value)} emptyText="No such choice">
                {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Combo>
            </div>
            {numbers.length > 1 && (
              <div className="wc-fu-row">
                <label htmlFor="wc-sim-num">To number</label>
                <Combo id="wc-sim-num" value={numberId} onChange={(e) => setNumberId(e.target.value)} emptyText="No such number">
                  <option value="">The number they already chat on</option>
                  {numbers.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
                </Combo>
              </div>
            )}
            {kind !== 'stop' && (
              <div className="wc-fu-row">
                <label htmlFor="wc-sim-text">Words</label>
                <input id="wc-sim-text" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
              </div>
            )}
            <div className="wc-admin-btns">
              <button type="button" className="btn btn-sm btn-primary" disabled={busy || !person} onClick={go}>{busy ? 'Working…' : 'Make the pretend reply'}</button>
              <button type="button" className="btn btn-sm" disabled={busy || !st || !st.testMessages} onClick={remove}>Remove test messages{st && st.testMessages ? ` (${st.testMessages})` : ''}</button>
            </div>
          </>
        )}
        {msg && <div className={`msg-box ${msg.ok ? 'green' : 'red'}`} role="status">{msg.text}</div>}

        <h4>How to get REAL replies on this computer</h4>
        <ol className="wc-steps">
          <li>Keep TeamLink running here (the backend answers on port 4010).</li>
          <li>Open a tunnel that gives it a public https address, for example <code>ngrok http 4010</code> or <code>cloudflared tunnel --url http://localhost:4010</code>. Copy the https address it shows.</li>
          <li>In Meta (developers.facebook.com) open your <b>test</b> WhatsApp app, then WhatsApp &gt; Configuration. Callback URL: <code>{'<that address>'}{(cfg && cfg.webhook && cfg.webhook.path) || '/api/webhooks/whatsapp'}</code>. Verify token: the same one saved in <Link to="/admin/integrations">Integrations &gt; WhatsApp</Link>. Press Verify and save.</li>
          <li>Under Webhook fields, switch on <b>messages</b>. Save the app secret in the same Integrations page (replies are checked with it).</li>
          <li>Send a WhatsApp message from your phone to the test number. It appears here by itself within about 10 seconds.</li>
        </ol>
        <div className="msg-box red"><b>Do not move the live site&apos;s webhook.</b> A Meta app has only one callback address. If you point the live app to your computer, the live TeamLink stops receiving replies. Use a separate Meta test app or test number for this computer.</div>
        <div className="small-muted">
          {cfg && cfg.webhook && cfg.webhook.seenAt ? `WhatsApp last called this server on ${new Date(cfg.webhook.seenAt).toLocaleString('en-IN')} (${cfg.webhook.count} calls).` : 'WhatsApp has not called this server yet.'}
          {' '}Open <Link to="/admin/integrations">Integrations &gt; WhatsApp numbers</Link> and press Reconnect to check the connection.
        </div>
      </div>
    </details>
  );
}
