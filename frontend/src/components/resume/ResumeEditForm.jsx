// ---------------------------------------------------------------------------
// EDIT RESUME — one calm column. Same six fields the server already takes
// (headline, summary, skills, education, experience, other) and the same
// strings: nothing is parsed away. Only the way they are typed changed:
//   Headline / Summary / Other   fields that grow with the text (no inner scrollbar)
//   Skills                       removable chips + an add box (stored as "a, b, c")
//   Education                    one line per degree (stored one per line)
//   Work experience              one card per job, split at blank lines (stored
//                                joined by a blank line)
// One sticky bar at the bottom: Save (main) and Cancel.
// ---------------------------------------------------------------------------
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './ResumeEditForm.css';

function AutoArea({
  value, onChange, minRows = 2, placeholder, label,
}) {
  const ref = useRef(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  };
  useLayoutEffect(fit, [value]);
  // The box also re-fits when its width changes (window resize, sidebar, fonts loading).
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') { window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit); }
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => { if (el.clientWidth !== w) { w = el.clientWidth; fit(); } });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <textarea
      ref={ref}
      className="ref-area"
      rows={minRows}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

const splitSkills = (s) => {
  const seen = new Set();
  return String(s || '').split(/[,;\n]+/).map((x) => x.trim()).filter((x) => {
    const k = x.toLowerCase();
    if (!x || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
const splitLines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
const splitBlocks = (s) => String(s || '').split(/\n\s*\n/).map((x) => x.replace(/^\s*\n+|\s+$/g, '')).filter((x) => x.trim());

function Section({ title, hint, children }) {
  return (
    <section className="ref-sec">
      <h4 className="ref-h">{title}</h4>
      <div className="ref-hint">{hint}</div>
      {children}
    </section>
  );
}

function SkillsEditor({ value, onChange }) {
  const [chips, setChips] = useState(() => splitSkills(value));
  const [text, setText] = useState('');
  const commit = (list) => { setChips(list); onChange(list.join(', ')); };
  const add = (raw) => {
    const add1 = splitSkills(raw);
    if (!add1.length) { setText(''); return; }
    commit(splitSkills([...chips, ...add1].join(',')));
    setText('');
  };
  return (
    <div className="ref-skills">
      <div className="ref-chips">
        {chips.length === 0 && <span className="small-muted">No skills yet.</span>}
        {chips.map((s) => (
          <span key={s} className="ref-chip">
            {s}
            <button type="button" className="ref-chip-x" aria-label={`Remove ${s}`} onClick={() => commit(chips.filter((x) => x !== s))}>×</button>
          </span>
        ))}
      </div>
      <div className="ref-addrow">
        <input
          className="ref-input"
          value={text}
          placeholder="Type a skill, press Enter"
          aria-label="Add a skill"
          onChange={(e) => {
            const v = e.target.value;
            if (/[,;]/.test(v)) add(v); else setText(v);
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(text); } }}
          onBlur={() => { if (text.trim()) add(text); }}
        />
        <button type="button" className="btn btn-sm" onClick={() => add(text)} disabled={!text.trim()}>Add</button>
      </div>
    </div>
  );
}

function EducationEditor({ value, onChange }) {
  const [rows, setRows] = useState(() => { const r = splitLines(value); return r.length ? r : ['']; });
  const commit = (list) => { setRows(list); onChange(list.map((x) => x.trim()).filter(Boolean).join('\n')); };
  return (
    <div className="ref-rows">
      {rows.map((r, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={i} className="ref-row">
          <AutoArea
            value={r}
            minRows={1}
            placeholder="e.g. B.Tech · CSE · College · 2022"
            label={`Degree ${i + 1}`}
            onChange={(v) => commit(rows.map((x, j) => (j === i ? v : x)))}
          />
          {rows.length > 1 && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => commit(rows.filter((_, j) => j !== i))}>Remove</button>
          )}
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={() => setRows([...rows, ''])}>+ Add a degree</button>
    </div>
  );
}

function ExperienceEditor({ value, onChange }) {
  const [blocks, setBlocks] = useState(() => { const b = splitBlocks(value); return b.length ? b : ['']; });
  const commit = (list) => {
    setBlocks(list);
    onChange(list.map((x) => x.replace(/\s+$/g, '')).filter((x) => x.trim()).join('\n\n'));
  };
  return (
    <div className="ref-jobs">
      {blocks.map((b, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={i} className="ref-job">
          <div className="ref-job-head">
            <b>{blocks.length > 1 ? `Job ${i + 1}` : 'Job'}</b>
            {blocks.length > 1 && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => commit(blocks.filter((_, j) => j !== i))}>Remove this job</button>
            )}
          </div>
          <AutoArea
            value={b}
            minRows={4}
            label={`Work experience, job ${i + 1}`}
            placeholder={'Role · Company · Jan 2022 – Present\n• What you did\n• Result'}
            onChange={(v) => commit(blocks.map((x, j) => (j === i ? v : x)))}
          />
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={() => setBlocks([...blocks, ''])}>+ Add another job</button>
    </div>
  );
}

export default function ResumeEditForm({
  draft, setDraft, nextLabel, startsFrom, busy, onSave, onCancel,
}) {
  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));
  return (
    <div className="ref">
      <div className="ref-top">
        <h3 className="ref-title">{`Edit resume → ${nextLabel}`}</h3>
        <div className="small-muted">{`Starting from ${startsFrom || 'the current resume'}. The original file is never changed.`}</div>
      </div>

      <Section title="Headline" hint="One line: the role and years, e.g. Staff Nurse · 3 years.">
        <input className="ref-input" value={draft.headline || ''} aria-label="Headline" onChange={(e) => set('headline')(e.target.value)} />
      </Section>
      <Section title="Summary" hint="2–3 lines about the person.">
        <AutoArea value={draft.summary || ''} minRows={3} label="Summary" onChange={set('summary')} />
      </Section>
      <Section title="Skills" hint="Type one, press Enter. Tap × to remove.">
        <SkillsEditor value={draft.skills || ''} onChange={set('skills')} />
      </Section>
      <Section title="Education" hint="One line per degree.">
        <EducationEditor value={draft.education || ''} onChange={set('education')} />
      </Section>
      <Section title="Work experience" hint="One block per job: Role · Company · Dates, then bullet points.">
        <ExperienceEditor value={draft.experience || ''} onChange={set('experience')} />
      </Section>
      <Section title="Anything else" hint="Certificates, languages, awards. Free text.">
        <AutoArea value={draft.other || ''} minRows={3} label="Additional information" onChange={set('other')} />
      </Section>

      <div className="small-muted ref-privacy">Phone numbers, e-mail addresses, street addresses and profile links are removed from the TeamLink-format PDF / DOCX automatically.</div>
      <div className="ref-bar">
        <div className="ref-bar-btns">
          <button type="button" className="btn btn-primary" disabled={busy === 'save'} onClick={onSave}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        </div>
        <div className="small-muted ref-bar-note">Saves a new edited copy; the original upload stays unchanged.</div>
      </div>
    </div>
  );
}
