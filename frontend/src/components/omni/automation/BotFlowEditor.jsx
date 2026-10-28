import { useEffect, useRef, useState } from 'react';
import Combo from '../../Combo.jsx';
import omni, { errOf } from '../omniApi.js';
import { Btn, GsModal } from '../ui.jsx';

// ---------------------------------------------------------------------------
// BOT BUILDER > the flow editor (the prototype's "Edit workflow" modal, for a bot flow). A flow is: trigger words -> optional condition -> one action
// (auto-reply text, or hand the chat to a person) -> what to do when the condition is not met. WhatsApp only. A new flow is Off. The bot only answers for
// real when the flow is On AND an Admin switched "Bot auto-replies" on AND Test mode is off AND the person agreed to WhatsApp messages.
// ---------------------------------------------------------------------------
const COND = [['none', 'No condition: always'], ['number', 'The message has a number (like an order number)'], ['hours', 'It came in business hours'], ['after_hours', 'It came after business hours']];

export default function BotFlowEditor({ flow, deptNames, isAdmin, focus, onClose, onSaved, toast }) {
  const [name, setName] = useState(flow ? flow.name : 'FAQ bot');
  const [words, setWords] = useState(flow ? flow.keywords.join('\n') : '');
  const [matchMode, setMatchMode] = useState(flow ? flow.matchMode : 'any');
  const [cond, setCond] = useState(flow ? flow.cond : { type: 'none' });
  const [act, setAct] = useState(flow ? flow.act : { type: 'reply', text: '' });
  const [otherwise, setOtherwise] = useState(flow ? flow.otherwise : 'nothing');
  const [department, setDepartment] = useState(flow ? flow.department : '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [tryText, setTryText] = useState('');
  const [tryOut, setTryOut] = useState(null);

  const setType = (type) => setCond(type === 'number' ? { type, digits: cond.digits || 4 } : (type === 'hours' || type === 'after_hours' ? { type, start: cond.start || '09:30', end: cond.end || '18:30' } : { type }));
  const save = async () => {
    setErr('');
    if (!name.trim()) { toast('Give the flow a name'); setErr('Give the flow a name.'); return; }
    setBusy(true);
    try {
      const payload = { name: name.trim(), keywords: words.split(/[\n,]/).map((x) => x.trim()).filter(Boolean), matchMode, cond, act, otherwise, department };
      const r = flow ? await omni.put(`/gs/bots/flows/${flow.id}`, payload) : await omni.post('/gs/bots/flows', payload);
      onSaved(r.flow, !flow); onClose();
    } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  };
  const tryIt = async () => {
    if (!flow) return;
    setTryOut(null);
    try { setTryOut(await omni.post(`/gs/bots/flows/${flow.id}/try`, { text: tryText })); } catch (e) { setTryOut({ words: errOf(e, 'It could not be tried.') }); }
  };
  const body = useRef(null);
  useEffect(() => {
    if (!focus) return undefined;
    const t = setTimeout(() => { const el = body.current && body.current.querySelector('.wf-focus'); if (el) el.scrollIntoView({ block: 'center' }); }, 90);
    return () => clearTimeout(t);
  }, [focus]);
  return (
    <GsModal title={flow ? 'Edit workflow' : 'New bot flow'} sub="Trigger words, an optional condition, then what the bot does. Changes apply to the live flow when you save." width={660} onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={busy} onClick={save}>{busy ? 'Saving…' : (flow ? '💾 Save workflow' : 'Create flow')}</Btn></>}>
      <div ref={body}>
      <div className="field"><label>FLOW NAME</label><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></div>
      <div className="wf-list">
        <div className={`wf-step${focus === 'Trigger' ? ' wf-focus' : ''}`}>
          <div className="wf-step-head">STEP 1 · TRIGGER</div>
          <div className="rcsa-grid">
            <div className="rcsa-f full"><label>Trigger words (one on each line)</label><textarea className="au-textarea" style={{ minHeight: 70 }} value={words} onChange={(e) => setWords(e.target.value)} placeholder={'price\nfee\nhow much'} /></div>
            <div className="rcsa-f full"><label>The bot answers when</label>
              <Combo value={matchMode} onChange={(e) => setMatchMode(e.target.value)}>
                <option value="any">The message contains any of these words</option>
                <option value="exact">The whole message is exactly one of them</option>
              </Combo>
            </div>
          </div>
        </div>
        <div className={`wf-step${(focus === 'Condition' || focus === 'Branch') ? ' wf-focus' : ''}`}>
          <div className="wf-step-head">STEP 2 · CONDITION (OPTIONAL)</div>
          <div className="rcsa-grid">
            <div className="rcsa-f full"><label>Only when</label>
              <Combo value={cond.type} onChange={(e) => setType(e.target.value)}>{COND.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Combo>
            </div>
            {cond.type === 'number' && <div className="rcsa-f"><label>At least this many digits</label><input inputMode="numeric" value={cond.digits || ''} onChange={(e) => setCond({ ...cond, digits: Number(e.target.value.replace(/\D/g, '')) || '' })} /></div>}
            {(cond.type === 'hours' || cond.type === 'after_hours') && (
              <>
                <div className="rcsa-f"><label>Business hours start (India time)</label><input type="time" value={cond.start || '09:30'} onChange={(e) => setCond({ ...cond, start: e.target.value })} /></div>
                <div className="rcsa-f"><label>Business hours end</label><input type="time" value={cond.end || '18:30'} onChange={(e) => setCond({ ...cond, end: e.target.value })} /></div>
              </>
            )}
            {cond.type !== 'none' && (
              <div className="rcsa-f full"><label>If the condition is not met</label>
                <Combo value={otherwise} onChange={(e) => setOtherwise(e.target.value)}>
                  <option value="nothing">Stay quiet</option>
                  <option value="handoff">Hand the chat to a person</option>
                </Combo>
              </div>
            )}
          </div>
        </div>
        <div className={`wf-step${(focus === 'Action' || focus === 'Goal') ? ' wf-focus' : ''}`}>
          <div className="wf-step-head">STEP {cond.type === 'none' ? 2 : 3} · ACTION</div>
          <div className="rcsa-grid">
            <div className="rcsa-f full"><label>The bot will</label>
              <Combo value={act.type} onChange={(e) => setAct({ ...act, type: e.target.value })}>
                <option value="reply">Send an auto-reply</option>
                <option value="handoff">Hand the chat to a person (the bot then stays quiet for 24 hours)</option>
              </Combo>
            </div>
            <div className="rcsa-f full"><label>{act.type === 'reply' ? 'Reply text ({{first_name}} puts the name in)' : 'Short note to the person (optional)'}</label>
              <textarea className="au-textarea" maxLength={act.type === 'reply' ? 1000 : 500} value={act.text || ''} onChange={(e) => setAct({ ...act, text: e.target.value })}
                placeholder={act.type === 'reply' ? 'Hi {{first_name}}, our fee is on the website. A colleague will help you if you need more.' : 'A colleague will reply to you shortly.'} />
            </div>
          </div>
        </div>
        <div className="wf-step">
          <div className="wf-step-head">WHO IT IS FOR</div>
          <div className="rcsa-grid">
            <div className="rcsa-f full"><label>Department</label>
              <Combo departments value={department} onChange={(e) => setDepartment(e.target.value)}>
                <option value="">{isAdmin ? 'All departments' : 'Pick a department'}</option>
                {deptNames.map((d) => <option key={d} value={d}>{d}</option>)}
              </Combo>
              <small style={{ fontSize: 9, color: 'var(--muted)' }}>The bot answers only chats that belong to this department.</small>
            </div>
          </div>
        </div>
      </div>
      <div className="au-box">
        <b>Safe by design.</b> STOP and unsubscribe messages are never answered: they always stop WhatsApp messages to that person. The bot never answers a person who opted out, answers at most once every 10 minutes in a chat, and only on WhatsApp.
      </div>
      {flow && (
        <div className="field"><label>TRY A MESSAGE (NOTHING IS SENT)</label>
          <div className="au-row"><input style={{ flex: 1, minWidth: 160 }} value={tryText} placeholder="Type what a customer might write" onChange={(e) => setTryText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') tryIt(); }} /><Btn onClick={tryIt} disabled={!tryText.trim()}>Try</Btn></div>
          <div className="au-sub">Tries the saved version of this flow.</div>
          {tryOut && <div className="au-ok" role="status" style={{ background: '#f1f4f9', borderColor: '#d9e2f0', color: '#33425e' }}>{tryOut.words}</div>}
        </div>
      )}
      {err && <div className="au-err" role="alert">{err}</div>}
      </div>
    </GsModal>
  );
}
