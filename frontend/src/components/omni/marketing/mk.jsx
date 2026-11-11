import { useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Pill, Banner, TinyBtn, Btn } from '../ui.jsx';
import './marketing.css';

// Shared parts of the AI Marketing screens (Omni-Channel > AI Marketing). Wording rule of Omni-Channel: the word "Draft" is never shown to people.
export const MK_STATUS = {
  draft: ['draft', 'Saved, not sent for approval'],
  waiting: ['warn', 'Waiting for approval'],
  changes: ['red', 'Changes needed'],
  approved: ['live', 'Approved'],
};
export const MkStatus = ({ status }) => { const [tone, words] = MK_STATUS[status] || ['draft', status]; return <Pill tone={tone} dot>{words}</Pill>; };

export function useMkMeta() {
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let on = true;
    omni.get('/gs/marketing/meta').then((m) => { if (on) setMeta(m); }).catch((e) => { if (on) setErr(errOf(e, 'AI Marketing could not be opened.')); });
    return () => { on = false; };
  }, []);
  return { meta, err };
}

// what the AI is, said plainly: the test sandbox only has an offline sample writer
export function AiBanner({ ai }) {
  const t = ai && (ai.text || ai);
  if (!t) return null;
  if (t.demo) return <Banner tone="test"><b>Test sandbox.</b> The AI here is an offline sample writer: it builds simple example messages from your brief and sends nothing anywhere. The live app uses the real AI model.</Banner>;
  if (!t.ready) return <Banner tone="error"><b>AI is not ready.</b> {t.reason || 'The AI model is not connected.'} An Admin can connect it in Administration &gt; Integrations &gt; AI Assistant.</Banner>;
  return null;
}
export const aiLabel = (ai) => (!ai ? '' : ai.demo ? 'Sample writer (test sandbox)' : `${ai.provider || 'AI'}${ai.model ? ` · ${ai.model}` : ''}`);

// one editable text per channel (texts = { channel: text }); `channels` come from the meta (key, label, icon, color, limit, hint)
export function TextsEditor({ chans, texts, subject, onTexts, onSubject, flagsOf, readOnly, onRevise, reviseBusy }) {
  const [active, setActive] = useState(chans[0] && chans[0].key);
  const [instr, setInstr] = useState('');
  useEffect(() => { if (!chans.some((c) => c.key === active)) setActive(chans[0] && chans[0].key); }, [chans]); // eslint-disable-line react-hooks/exhaustive-deps
  const ch = chans.find((c) => c.key === active) || chans[0];
  if (!ch) return null;
  const text = texts[ch.key] || '';
  const over = text.length > ch.limit;
  const flags = flagsOf ? flagsOf(ch.key, text) : [];
  const chips = ['Shorter', 'More urgent', 'Friendlier', 'More formal'];
  return (
    <div>
      <div className="mk-ed-tabs" role="tablist" aria-label="Channels">
        {chans.map((c) => <button type="button" key={c.key} role="tab" aria-selected={c.key === ch.key} className={`mk-ed-tab${c.key === ch.key ? ' on' : ''}`} onClick={() => setActive(c.key)}><i style={{ background: c.color }}>{c.icon}</i>{c.label}{(texts[c.key] || '').length > c.limit ? <span style={{ color: '#b3261e' }}>!</span> : null}</button>)}
      </div>
      {ch.key === 'email' && (
        <div className="field" style={{ marginBottom: 8 }}><label>EMAIL SUBJECT</label><input value={subject || ''} disabled={readOnly} maxLength={200} onChange={(e) => onSubject(e.target.value)} placeholder="Subject line" /></div>
      )}
      <textarea style={{ width: '100%', minHeight: 150, border: '1px solid var(--line)', borderRadius: 10, padding: 11, font: 'inherit', fontSize: 12.5 }} value={text} disabled={readOnly} onChange={(e) => onTexts({ ...texts, [ch.key]: e.target.value })} placeholder={`The ${ch.label} message…`} aria-label={`${ch.label} message`} />
      <div className={`mk-count${over ? ' over' : ''}`}><span>{text.length.toLocaleString('en-IN')} / {ch.limit.toLocaleString('en-IN')} characters{over ? ' · too long' : ''}</span><span>{ch.hint}{ch.send ? '' : ' · saved text only, nothing is posted from here'}</span></div>
      {flags.length > 0 && <div className="mk-flag">Your brand voice says never to use: <b>{flags.join(', ')}</b>. Change the words before you ask for approval.</div>}
      {!readOnly && onRevise && (
        <div className="mk-revise">
          {chips.map((c) => <TinyBtn key={c} disabled={reviseBusy || !text.trim()} onClick={() => onRevise(ch.key, c)}>{c}</TinyBtn>)}
          <input className="mk-instr" value={instr} onChange={(e) => setInstr(e.target.value)} placeholder="Or say what to change…" aria-label="What should the AI change" maxLength={200} />
          <Btn small disabled={reviseBusy || !text.trim() || instr.trim().length < 3} onClick={() => { onRevise(ch.key, instr.trim()); setInstr(''); }}>{reviseBusy ? 'Rewriting…' : '✦ Rewrite'}</Btn>
        </div>
      )}
    </div>
  );
}

// a read-only look at the words of every channel (approvals, lists)
export function TextsPreview({ chans, texts, subject }) {
  const have = chans.filter((c) => texts[c.key]);
  const [active, setActive] = useState(have[0] && have[0].key);
  useEffect(() => { if (!have.some((c) => c.key === active)) setActive(have[0] && have[0].key); }, [have.map((c) => c.key).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const ch = have.find((c) => c.key === active) || have[0];
  if (!ch) return <div style={{ fontSize: 11, color: 'var(--muted)' }}>No text.</div>;
  return (
    <div className="mk-preview">
      <div className="mk-ed-tabs" style={{ margin: 0 }}>{have.map((c) => <button type="button" key={c.key} className={`mk-ed-tab${c.key === ch.key ? ' on' : ''}`} onClick={() => setActive(c.key)}><i style={{ background: c.color }}>{c.icon}</i>{c.label}</button>)}</div>
      {ch.key === 'email' && subject ? <div style={{ fontSize: 11, marginTop: 8 }}><span style={{ color: 'var(--muted)' }}>Subject: </span><b>{subject}</b></div> : null}
      <pre>{texts[ch.key]}</pre>
    </div>
  );
}
