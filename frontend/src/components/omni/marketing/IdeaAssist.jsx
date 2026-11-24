import { useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { getState } from '../omniStore.js';
import { Btn } from '../ui.jsx';

// "✨ AI Assist" under YOUR IDEA OR CONCEPT (AI Images and AI Video; 2026-11-24, the same button the Employee Services forms have). The person types a title (or a few words, or has a client
// project open) and presses it: the AI writes the idea into the box, or improves what is already there. It only fills the box: the person reads it, changes it, then presses Create.
// kind 'video' | 'post'. title / heading / content: the optional fields below the box. idea: what the box holds now. onIdea(text): puts the new text in the box.
export default function IdeaAssist({ kind = 'video', title = '', heading = '', content = '', idea = '', projectId = '', clientName = '', disabled = false, onIdea }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [bad, setBad] = useState(false);
  const run = async () => {
    setNote(''); setBad(false);
    const typed = [title, heading, content, idea].some((v) => String(v || '').trim().length >= 2);
    if (!typed && !projectId) { setNote('Write a title or content above (or a few words in the box) first, so the AI knows the topic.'); setBad(true); return; }
    setBusy(true);
    try {
      const r = await omni.post('/gs/marketing/studio/idea-assist', { kind, title, heading, content, idea, ...(projectId ? { projectId } : {}), ...(clientName ? { clientName } : {}), ...(getState().dept ? { department: getState().dept } : {}) });
      onIdea(r.idea);
      if (r.note) { setNote(r.note); setBad(true); return; } // the AI was busy: the server laid out the person's own words instead, and says so
      const words = r.flags && r.flags.length ? ` It uses "${r.flags.join('", "')}", which your brand avoids: change it.` : '';
      setNote(r.demo ? 'Sample text (test mode, not written by AI). Read it and change it.' : `${String(idea || '').trim() ? 'Improved' : 'Written'}. Read it, change anything, then press Create.${words}`);
      setBad(!!words);
    } catch (e) { setNote(errOf(e, 'The AI is not available right now. You can write the idea yourself.')); setBad(true); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
      <Btn small disabled={busy || disabled} onClick={run} title="The AI writes the topic and the points from your title and content. You can change them before you press Create.">{busy ? 'Writing…' : '✨ AI Assist'}</Btn>
      {busy ? <span role="status" style={{ fontSize: 12, color: '#1d4fa8', fontWeight: 600 }}>The AI is writing the topic and the points. It can take up to 40 seconds: please wait here.</span> : note ? <span role="status" style={{ fontSize: 12, color: bad ? '#b45309' : '#166534', fontWeight: 600 }}>{note}</span> : <span style={{ fontSize: 12, color: 'var(--muted)' }}>Write a title or content above, then press AI Assist: it writes the topic and the points for you.</span>}
    </div>
  );
}
