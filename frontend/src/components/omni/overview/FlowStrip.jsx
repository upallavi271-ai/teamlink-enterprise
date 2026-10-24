import { useEffect, useState } from 'react';
import omni from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { fmtNum } from '../ui.jsx';

// ---------------------------------------------------------------------------
// "HOW IT WORKS": the compact, clickable 10-step strip at the top of the Dashboard. Every step shows a REAL count and a "what to do next" hint, from
// GET /api/outreach/gs/overview/flow (outreach/flow.js). A step opens the page where it is done. Tones: ok (in place), todo (nothing there yet), warn (needs a look).
// "Details" opens a plain list: what happens in the step and who does it. The open / closed choice is remembered in this browser only.
// ---------------------------------------------------------------------------
const KEY = 'tl_omni_flow_open';
const readOpen = () => { try { return window.localStorage.getItem(KEY) !== '0'; } catch { return true; } };
const writeOpen = (v) => { try { window.localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* fine */ } };
const MARK = { ok: '✓', warn: '!', todo: null };

export default function FlowStrip() {
  const { go } = useOmni();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(readOpen);
  const [detail, setDetail] = useState(false);
  useEffect(() => {
    let on = true;
    omni.get('/gs/overview/flow').then((d) => { if (on) setData(d); }).catch(() => { if (on) setErr('The steps could not be loaded.'); });
    return () => { on = false; };
  }, []);
  const toggle = () => { const v = !open; setOpen(v); writeOpen(v); };
  if (err) return <div className="card panel ov-flow" role="alert" style={{ color: '#9b1c1c', fontSize: 11 }}>{err}</div>;
  if (!data) return <div className="card panel ov-flow" style={{ fontSize: 11, color: 'var(--muted)' }}>Loading the steps…</div>;
  const next = data.next;
  const openStep = (s) => { if (s.page) go(s.page, s.params); };
  return (
    <div className="card panel ov-flow" aria-label="How it works">
      <div className="ov-flow-head">
        <div className="ov-flow-title">How it works<small>Ten steps from a new contact to a joined candidate. Tap a step to open it.</small></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {next && <div className="ov-flow-next" role="status">What to do next: <b>Step {next.n}, {next.title}</b> <span>{next.hint}</span></div>}
          {open && <button type="button" className="tiny-btn" style={{ height: 30, padding: '0 10px' }} onClick={() => setDetail(!detail)} aria-expanded={detail}>{detail ? 'Hide details' : 'Details'}</button>}
          <button type="button" className="tiny-btn" style={{ height: 30, padding: '0 10px' }} onClick={toggle} aria-expanded={open}>{open ? 'Hide' : 'Show'}</button>
        </div>
      </div>
      {open && (
        <>
          <div className="ov-steps" role="list">
            {data.steps.map((s) => (
              <button type="button" role="listitem" key={s.id} className={`ov-step ${s.tone}`} disabled={!s.page} onClick={() => openStep(s)} title={`${s.words}\nWho: ${s.who}${s.mine ? ' (you)' : ''}`}>
                <span className="ov-step-top"><span className="ov-num">{MARK[s.tone] || s.n}</span><b>{s.title}</b></span>
                <span className="ov-count">{s.count === null || s.count === undefined ? '—' : fmtNum(s.count)}<small>{s.countLabel}</small></span>
                <span className="ov-hint">{s.hint}</span>
                {s.end && <span className="ov-end">End of the flow</span>}
              </button>
            ))}
          </div>
          {detail && (
            <div className="ov-flow-detail">
              {data.steps.map((s) => (
                <div key={s.id}><b>{s.n}. {s.title}.</b> {s.words}<em>Who: {s.who}{s.mine ? ' · you can do this' : ''}</em></div>
              ))}
            </div>
          )}
          {data.testMode && <div style={{ fontSize: 9, color: '#8a6410', marginTop: 8 }}>Test mode is ON: campaigns are only rehearsed, nothing goes to real people.</div>}
        </>
      )}
    </div>
  );
}
