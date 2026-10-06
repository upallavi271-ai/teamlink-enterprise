import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import { initials } from '../../atsVocab';
import { workflowStages } from '../../permissions';
import { FunnelChart } from '../charts';
import StepPopup, { popupForDrop } from './StepPopups.jsx';
import './CandidateBoard.css';

// ATS LAYOUT v3 (2026-10-03): columns Sourced → Verified → TL check → BDE
// Review → Shared with Client → Interview → Selected → Joined, plus Rejected
// (separate, red). A card shows the name, the days in the step (green ≤ 3,
// yellow 4–7, red after 7 or late) and the recruiter; a held card shows an
// "On hold" badge in the column it was paused at. Dropping on a step that
// needs a decision opens its popup (Verify, TL check, BDE Review, Reject,
// Joined, Interview); the server re-checks every move. On top: a job picker,
// that job's summary and a funnel strip of the column counts.
const shortMoney = (v) => (v ? String(v) : '');

// ---------------------------------------------------------------------------
// PROGRESS BOARD (Candidates §7, 2026-10-03) — "who is at which step, with
// whom, and for how long", in one look.
//
// One column per step (New · Recruiter check · Team lead check · Client check ·
// Interview · Selected · Offer · Joined) with its count and the first cards.
// "Show more" loads the next cards of ONE column. Everything is counted and
// cut on the server (GET /candidates/board) with the list's own filters, so
// 23,000+ people cost one small answer.
//
// Drag a card to another column: allowed only where the server says this
// role may drop (column.canDrop); the server re-checks every move
// (POST /candidates/board/move → the ordinary stage rules) and its refusal is
// shown in plain words. A move can be undone right away.
// ---------------------------------------------------------------------------
const shortDate = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '');
const daysText = (n) => (n == null ? '' : n === 0 ? 'Today in this step' : `${n} day${n === 1 ? '' : 's'} in this step`);

export default function CandidateBoard({
  params, user, reloadKey = 0, onOpen, onNeedInterview, onChanged,
  jobOptions = null, jobId = '', onJob = null,
}) {
  const [popup, setPopup] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null);
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState('');
  const [busy, setBusy] = useState('');
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const key = JSON.stringify(params || {});
  const mayDrag = workflowStages(user).some((s) => !['HOLD', 'REJECTED'].includes(s));

  useEffect(() => {
    seq.current += 1;
    const mine = seq.current;
    setLoading(true);
    api.get('/candidates/board', { params })
      .then((res) => { if (mine === seq.current) { setData(res.data); setError(''); } })
      .catch((err) => { if (mine === seq.current) setError(err.response?.data?.error || 'Could not load the board. Please try again.'); })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [key, reloadKey, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  async function showMore(col) {
    setBusy(`more:${col.key}`);
    try {
      const res = await api.get('/candidates/board', { params: { ...params, column: col.key, offset: col.cards.length } });
      const got = (res.data.columns || [])[0];
      if (got) {
        setData((d) => ({
          ...d,
          columns: d.columns.map((c) => (c.key === col.key ? { ...c, cards: [...c.cards, ...got.cards], more: got.more, count: got.count } : c)),
        }));
      }
    } catch (err) {
      setFlash({ ok: false, text: err.response?.data?.error || 'Could not load more people. Please try again.' });
    } finally {
      setBusy('');
    }
  }

  const colOf = (cardId) => (data ? (data.columns.find((c) => c.cards.some((x) => x.id === cardId)) || {}).key : null);

  async function drop(col) {
    const card = drag;
    setDrag(null);
    setOver('');
    if (!card || !col || colOf(card.id) === col.key) return;
    if (!col.canDrop) {
      setFlash({ ok: false, text: `Your role can't move people to ${col.label}. Ask the person who owns that step.` });
      return;
    }
    // v3: a step that needs a decision opens its popup first.
    const kind = popupForDrop(colOf(card.id), col.key, card);
    if (kind) { setFlash(null); setPopup({ kind, app: card }); return; }
    setBusy(card.id);
    setFlash(null);
    try {
      const res = await api.post('/candidates/board/move', { applicationId: card.id, column: col.key });
      setFlash({ ok: true, text: `Moved. ${card.name} is now at ${col.label}.`, undo: { id: card.id, stage: card.stage, name: card.name } });
      // Show the move at once; the server's own answer follows a moment later.
      const from = colOf(card.id);
      const movedCard = {
        ...card, stage: res.data.stage, stageLabel: res.data.stageLabel, daysInStep: 0, movedBy: (user && user.name) || 'You', movedAt: new Date().toISOString(),
      };
      setData((d) => ({
        ...d,
        columns: d.columns.map((c) => {
          if (c.key === from) return { ...c, count: Math.max(0, c.count - 1), cards: c.cards.filter((x) => x.id !== card.id) };
          if (c.key === col.key) return { ...c, count: c.count + 1, cards: [movedCard, ...c.cards] };
          return c;
        }),
      }));
      setTimeout(() => setTick((t) => t + 1), 900);
      if (onChanged) onChanged();
    } catch (err) {
      setFlash({ ok: false, text: `${card.name} was not moved: ${err.response?.data?.error || 'that move is not allowed.'}` });
    } finally {
      setBusy('');
    }
  }

  async function undo(u) {
    setFlash(null);
    try {
      await api.patch(`/applications/${u.id}/stage`, { stage: u.stage, comment: 'Undo on the Progress board' });
      setFlash({ ok: true, text: `${u.name} is back where they were.` });
      setTick((t) => t + 1);
      if (onChanged) onChanged();
    } catch (err) {
      setFlash({ ok: false, text: `Could not undo: ${err.response?.data?.error || 'that move is not allowed.'}` });
    }
  }

  if (error) return <div className="error-text">{error}</div>;
  if (!data) return <div className="small-muted cboard-loading">Loading the board…</div>;
  const elsewhere = data.elsewhere || {};
  const rq = data.requirement;
  const mainCols = data.columns.filter((c) => !c.side);
  const scrollTo = (key) => {
    const el = document.getElementById(`cboard-col-${key}`);
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
  };
  return (
    <div className={`cboard${loading ? ' is-loading' : ''}`}>
      {onJob && (
        <div className="cboard-job-pick">
          <label className="lph-facet">
            <span className="lph-facet-lbl">Job</span>
            <select value={jobId} onChange={(e) => onJob(e.target.value)}>
              <option value="">All jobs</option>
              {(jobOptions || []).map((o) => <option key={o.value} value={o.value}>{`${o.label}${o.count != null ? ` (${Number(o.count).toLocaleString('en-IN')})` : ''}`}</option>)}
            </select>
          </label>
          {!jobId && <span className="small-muted">Pick a job to see its own board.</span>}
        </div>
      )}
      {rq && (
        <div className="cboard-top2">
        <div className="cboard-sum" aria-label="Job summary">
          <div className="cboard-sum-main">
            <b>{rq.title}</b>
            <span className="small-muted">{[rq.reqCode, rq.clientName, rq.department, rq.location].filter(Boolean).join(' · ')}</span>
          </div>
          <div className="cboard-sum-facts">
            <span><b>{`${rq.filled} of ${rq.openings || 0}`}</b> filled</span>
            <span><b>{rq.inProcess}</b> in process</span>
            {rq.urgency && <span className={`cboard-urg is-${String(rq.urgency).toLowerCase()}`}>{rq.urgency}</span>}
            {rq.budget && <span>{`Budget ${shortMoney(rq.budget)}`}</span>}
            <span>{rq.dueDate ? `Due ${shortDate(rq.dueDate)}` : 'No due date'}</span>
          </div>
        </div>
        {data.total > 0 && (
          <div className="cboard-funnel">
            <FunnelChart
              title="How far people got"
              // Reached at least this step = everyone in this column and after it.
              steps={mainCols.map((c, i) => ({ label: c.label, value: mainCols.slice(i).reduce((n, x) => n + x.count, 0), onClick: () => scrollTo(c.key) }))}
            />
          </div>
        )}
        </div>
      )}
      <div className="cboard-top small-muted">
        {data.total > 0 ? `${data.total.toLocaleString('en-IN')} people on the board` : 'Nobody matches these filters.'}
        {elsewhere.hold > 0 && <span>{` · ${elsewhere.hold.toLocaleString('en-IN')} on hold (yellow badge)`}</span>}
        {mayDrag && <span className="cboard-tip">{' · Drag a card to the next step.'}</span>}
      </div>
      {flash && (
        <div className={`notice${flash.ok ? '' : ' red'} cboard-flash`} role="status">
          <span>{flash.text}</span>
          {flash.undo && workflowStages(user).includes(flash.undo.stage) && <button type="button" className="btn btn-sm" onClick={() => undo(flash.undo)}>Undo</button>}
          <button type="button" className="link-btn" onClick={() => setFlash(null)}>Close</button>
        </div>
      )}
      <div className="cboard-cols">
        {data.columns.map((col) => {
          const dropHere = drag && colOf(drag.id) !== col.key;
          return (
            <section
              key={col.key}
              id={`cboard-col-${col.key}`}
              className={`cboard-col${col.side ? ' is-side' : ''}${over === col.key ? (col.canDrop ? ' is-over' : ' is-locked') : ''}${dropHere && !col.canDrop ? ' is-dim' : ''}`}
              aria-label={`${col.label}: ${col.count}`}
              onDragOver={(e) => { if (dropHere) { e.preventDefault(); setOver(col.key); } }}
              onDragLeave={() => setOver((o) => (o === col.key ? '' : o))}
              onDrop={(e) => { e.preventDefault(); drop(col); }}
            >
              <header className="cboard-head">
                <span className="cboard-title">{col.label}</span>
                {col.count > 0 && <span className="cboard-n">{col.count.toLocaleString('en-IN')}</span>}
              </header>
              {dropHere && !col.canDrop && <div className="cboard-lock small-muted">Your role can&apos;t move people here</div>}
              <div className="cboard-cards">
                {col.cards.length === 0 && <div className="small-muted cboard-empty">No one here</div>}
                {col.cards.map((card) => (
                  <article
                    key={card.id}
                    className={`cboard-card is-${card.tone || 'blue'}${busy === card.id ? ' is-busy' : ''}`}
                    draggable={mayDrag && busy !== card.id}
                    onDragStart={(e) => { setDrag(card); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', card.id); } catch { /* old browsers */ } }}
                    onDragEnd={() => { setDrag(null); setOver(''); }}
                    onClick={() => onOpen && onOpen(card)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && onOpen) onOpen(card); }}
                    tabIndex={0}
                    role="button"
                    title="Open the profile"
                  >
                    <div className="cboard-card-top">
                      <span className="avatarsm">{initials(card.name)}</span>
                      <b className="cboard-name">{card.name}</b>
                      {card.onHold && <span className="cboard-hold" title={card.heldAt ? `Paused at ${card.heldAt}` : 'On hold'}>On hold</span>}
                    </div>
                    <div className={`cboard-days is-${card.tone || 'blue'}`}>
                      {col.side
                        ? (card.daysInStep ? `Rejected ${card.daysInStep} day${card.daysInStep === 1 ? '' : 's'} ago` : 'Rejected today')
                        : (card.dueStatus === 'overdue' ? `Late · ${daysText(card.daysInStep)}` : daysText(card.daysInStep))}
                    </div>
                    <div className="cboard-meta">
                      {card.recruiter ? `Recruiter: ${card.recruiter}` : 'No recruiter named'}
                    </div>
                    {!jobId && (
                      <div className="cboard-job small-muted">
                        {card.requirementTitle || 'No job'}
                        {card.clientName && ` · ${card.clientName}`}
                      </div>
                    )}
                    {card.movedBy && <div className="small-muted cboard-moved">{`Moved by ${card.movedBy}, ${shortDate(card.movedAt)}`}</div>}
                  </article>
                ))}
                {col.more && (
                  <button type="button" className="btn btn-sm cboard-more" disabled={busy === `more:${col.key}`} onClick={() => showMore(col)}>
                    {busy === `more:${col.key}` ? 'Loading…' : `Show more (${(col.count - col.cards.length).toLocaleString('en-IN')} left)`}
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
      {popup && (
        <StepPopup
          kind={popup.kind}
          app={popup.app}
          user={user}
          onClose={() => setPopup(null)}
          onNeedInterview={onNeedInterview}
          onDone={(x) => {
            setFlash({ ok: true, text: x.text || 'Saved.', undo: x.undo || null });
            setTimeout(() => setTick((t) => t + 1), 400);
            if (onChanged) onChanged();
          }}
        />
      )}
    </div>
  );
}
