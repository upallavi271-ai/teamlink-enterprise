import { useMemo, useState } from 'react';
import './multipick.css';
import { resolveCustom, sameOption, CUSTOM_MAX } from './customValue.js';
import { matchesText, noMatchText } from './searchMatch.js';

// ---------------------------------------------------------------------------
// MULTIPICK (2026-10-13): pick SEVERAL from a list. The picked ones are chips inside ONE box with a caret (click the box
// or the caret to open the list; no separate text links). The list opens right under the box (in the page, not floating,
// so a window never clips it). Used for Departments, Preferred locations and Recruiters on a job.
//
//   options  [{ value, label, sub?, tag?, group? }]   sub = grey line (e.g. workload), tag = small green word
//   value    [value, ...]  (order matters: the first is the MAIN one when `mainLabel` is given)
//   special  [{ value, label }]  one-click choices that stand alone (Remote / Any location); picking one clears the rest
//   add      { label, onAdd(name) -> Promise<value|null> }  inline "Add a new ..." (only for people allowed to)
//   other    { label, typeLabel, onAdd(name) -> value|Promise<value|null> }  an "Other (type it)" row at the END of the list
//   single   one choice only (picking replaces; the list closes)
//   notInList(v) -> true  marks a chip "not in the list" (a typed value)
//   allowCustom (2026-10-14)  when the typed text matches nothing the list ends with 'Use “React”' (customLabel: 'Add' for
//            shared lists). Enter picks the first match; with no match Enter picks the custom row. The typed value
//            becomes a chip. A case-insensitive match picks the existing option instead. validateCustom(text) -> error
//            string | falsy. onCreateOption(text) -> value | Promise<value|null> (shared lists): the returned value is used.
// ---------------------------------------------------------------------------
export default function MultiPick({
  options = [], value = [], onChange, placeholder = 'Pick…', searchPlaceholder = 'Type to search', emptyText = 'Nothing to pick.',
  special = [], add = null, other = null, single = false, notInList = null, mainLabel = '', disabled = false, loading = false, labelOf = null, id,
  allowCustom = false, customLabel = 'Use', validateCustom = null, onCreateOption = null, maxCustomLength = CUSTOM_MAX,
}) {
  const [otherOpen, setOtherOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [otherErr, setOtherErr] = useState('');
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState('');
  const [addErr, setAddErr] = useState('');
  const [customErr, setCustomErr] = useState('');
  const [act, setAct] = useState(0);
  const byValue = useMemo(() => new Map([...options, ...special].map((o) => [o.value, o])), [options, special]);
  const specialSet = useMemo(() => new Set(special.map((s) => s.value)), [special]);
  const nameOf = (v) => (labelOf ? labelOf(v) : (byValue.get(v) ? byValue.get(v).label : v));
  const set = (next) => { if (onChange) onChange(next); };
  const toggle = (v) => {
    if (disabled) return;
    if (specialSet.has(v)) { set(value.includes(v) ? [] : [v]); return; }
    if (single) { set(value.includes(v) ? [] : [v]); if (!value.includes(v)) setOpen(false); return; }
    const base = value.filter((x) => !specialSet.has(x));
    set(base.includes(v) ? base.filter((x) => x !== v) : [...base, v]);
  };
  const makeMain = (v) => set([v, ...value.filter((x) => x !== v)]);
  // Values the person typed earlier (not in the list) stay visible and tickable, as "Your own".
  const ownValues = useMemo(() => (allowCustom ? value.filter((v) => !byValue.has(v)) : []), [allowCustom, value, byValue]);
  const shown = useMemo(() => {
    return options.filter((o) => matchesText(`${o.label} ${o.sub || ''} ${o.group || ''}`, q));
  }, [options, q]);
  const ownShown = ownValues.filter((v) => matchesText(v, q));
  const groups = useMemo(() => {
    const out = []; const idx = new Map();
    shown.forEach((o) => {
      const g = o.group || '';
      if (!idx.has(g)) { idx.set(g, out.length); out.push({ g, list: [] }); }
      out[idx.get(g)].list.push(o);
    });
    return out;
  }, [shown]);

  const typedText = q.trim();
  const exactHit = !!typedText && (!!sameOption(options, typedText) || value.some((v) => String(v).toLowerCase() === typedText.toLowerCase()));
  const showCustom = allowCustom && !disabled && !!typedText && !exactHit;

  async function doCustom() {
    setCustomErr('');
    const r = resolveCustom(options, q, validateCustom);
    if (r.error !== undefined && r.value === undefined) { if (r.error) setCustomErr(r.error); return; }
    let v = r.value;
    try {
      if (!r.existing && onCreateOption) { const made = await onCreateOption(v); if (!made) return; v = made; }
    } catch (e) {
      setCustomErr((e && e.response && e.response.data && e.response.data.error) || 'That did not save. Try again.');
      return;
    }
    if (single) set([v]);
    else if (!value.includes(v)) set([...value.filter((x) => !specialSet.has(x)), v]);
    setQ('');
    if (single) setOpen(false);
  }

  function onSearchKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length) setAct((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown.length) { toggle(shown[Math.min(act, shown.length - 1)].value); if (!single) setQ(''); setAct(0); }
      else if (showCustom) doCustom();
    } else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  }

  async function doOther() {
    const name = typed.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || !other) return;
    setOtherErr('');
    try {
      const same = options.find((o) => String(o.value).toLowerCase() === name.toLowerCase());
      const v = same ? same.value : await other.onAdd(name);
      if (v) {
        if (single) set([v]); else if (!value.includes(v)) set([...value.filter((x) => !specialSet.has(x)), v]);
        setTyped(''); setOtherOpen(false); setQ('');
        if (single) setOpen(false);
      }
    } catch (e) {
      setOtherErr((e && e.response && e.response.data && e.response.data.error) || 'That did not save. Try again.');
    }
  }

  async function doAdd() {
    const name = adding.trim();
    if (name.length < 2 || !add) return;
    setAddErr('');
    try {
      const v = await add.onAdd(name);
      if (v) { toggle(v); setAdding(''); setQ(''); }
    } catch (e) {
      setAddErr((e && e.response && e.response.data && e.response.data.error) || 'That did not save. Try again.');
    }
  }

  const ctlKey = (e) => {
    if (disabled) return;
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  };
  const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };

  return (
    <div className={`mpk${disabled ? ' is-off' : ''}`} id={id}>
      <div
        className={`mpk-chips${disabled ? '' : ' is-ctl'}${open ? ' is-open' : ''}`}
        role={disabled ? undefined : 'combobox'}
        aria-haspopup={disabled ? undefined : 'listbox'}
        aria-expanded={disabled ? undefined : open}
        tabIndex={disabled ? undefined : 0}
        onClick={() => { if (!disabled) setOpen((o) => !o); }}
        onKeyDown={ctlKey}
      >
        {value.length === 0 && <span className="mpk-none">{placeholder}</span>}
        {value.map((v, i) => (
          <span key={v} className={`mpk-chip${i === 0 && mainLabel && value.length > 1 ? ' is-main' : ''}`}>
            {i === 0 && mainLabel && value.length > 1 && <em className="mpk-main">{mainLabel}</em>}
            {nameOf(v)}
            {notInList && !specialSet.has(v) && notInList(v) && <small className="mpk-nil">not in the list</small>}
            {!disabled && i > 0 && mainLabel && !specialSet.has(v) && <button type="button" className="mpk-up" title={`Make ${nameOf(v)} the ${mainLabel.toLowerCase()} one`} onClick={stop(() => makeMain(v))}>↑</button>}
            {!disabled && <button type="button" className="mpk-x" aria-label={`Remove ${nameOf(v)}`} onClick={stop(() => set(value.filter((x) => x !== v)))}>×</button>}
          </span>
        ))}
        {!disabled && <span className="mpk-caret" aria-hidden="true" />}
      </div>
      {open && !disabled && (
        <div className="mpk-panel">
          {special.length > 0 && (
            <div className="mpk-special">
              {special.map((s) => (
                <button key={s.value} type="button" className={`mpk-sp${value.includes(s.value) ? ' on' : ''}`} onClick={() => toggle(s.value)}>{s.label}</button>
              ))}
            </div>
          )}
          <input className="mpk-search" autoFocus value={q} onChange={(e) => { setQ(e.target.value); setCustomErr(''); setAct(0); }} onKeyDown={onSearchKey} placeholder={allowCustom ? `${searchPlaceholder} or type your own` : searchPlaceholder} maxLength={allowCustom ? maxCustomLength : undefined} />
          <div className="mpk-list" role="listbox" aria-multiselectable={single ? undefined : 'true'}>
            {loading && <div className="mpk-empty">Loading…</div>}
            {!loading && shown.length === 0 && ownShown.length === 0 && !showCustom && <div className="mpk-empty">{q.trim() ? noMatchText(q) : emptyText}</div>}
            {ownShown.map((v) => (
              <label key={`own:${v}`} role="option" aria-selected="true" className="mpk-opt on">
                <input type="checkbox" checked onChange={() => toggle(v)} />
                <span className="mpk-txt"><b>{`Your own: ${v}`}</b></span>
              </label>
            ))}
            {groups.map((gr) => (
              <div key={gr.g || 'x'}>
                {gr.g && <div className="mpk-group">{gr.g}</div>}
                {gr.list.map((o) => {
                  const on = value.includes(o.value);
                  return (
                    <label key={o.value} role="option" aria-selected={on} className={`mpk-opt${on ? ' on' : ''}${(q.trim() || act > 0) && shown[Math.min(act, shown.length - 1)] === o ? ' act' : ''}`}>
                      <input type="checkbox" checked={on} onChange={() => toggle(o.value)} />
                      <span className="mpk-txt">
                        <b>{o.label}</b>
                        {o.sub && <small>{o.sub}</small>}
                      </span>
                      {o.tag && <span className="mpk-tag">{o.tag}</span>}
                    </label>
                  );
                })}
              </div>
            ))}
            {showCustom && (
              <div role="option" aria-selected="false" tabIndex={0} className="mpk-opt mpk-custom" onClick={doCustom} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doCustom(); } }}>
                <span className="mpk-txt"><b>{customLabel} “{typedText.replace(/\s+/g, ' ').slice(0, maxCustomLength)}”</b></span>
              </div>
            )}
          </div>
          {customErr && <div className="error-text">{customErr}</div>}
          {other && (
            <div className="mpk-other">
              <button type="button" className={`mpk-opt mpk-other-btn${otherOpen ? ' on' : ''}`} aria-expanded={otherOpen} onClick={() => setOtherOpen((o) => !o)}>
                <span className="mpk-txt"><b>{other.label || 'Other (type it)'}</b></span>
                <span aria-hidden="true">{otherOpen ? '▴' : '▾'}</span>
              </button>
              {otherOpen && (
                <div className="mpk-add mpk-other-box">
                  <label className="mpk-other-l">{other.typeLabel || 'Type the place'}</label>
                  <input autoFocus value={typed} maxLength={60} onChange={(e) => setTyped(e.target.value)} placeholder={other.placeholder || 'For example Vijayawada'} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doOther(); } }} />
                  <button type="button" className="btn btn-sm btn-primary" disabled={typed.trim().length < 2} onClick={doOther}>Add</button>
                  {otherErr && <div className="error-text">{otherErr}</div>}
                </div>
              )}
            </div>
          )}
          {add && (
            <div className="mpk-add">
              <input value={adding} maxLength={60} onChange={(e) => setAdding(e.target.value)} placeholder={add.label} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } }} />
              <button type="button" className="btn btn-sm" disabled={adding.trim().length < 2} onClick={doAdd}>Add</button>
              {addErr && <div className="error-text">{addErr}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
