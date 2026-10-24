import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import CampaignDialog from './CampaignDialog.jsx';
import './broadcast.css';

// ---------------------------------------------------------------------------
// ONE "POST TO ALL SELECTED PLACES" BUTTON. Each place answers with what really happened:
//   Posted · Queued · Running · Needs your help (by hand) · Not connected (set up in Integrations) · Failed [Retry]
// Nothing is shown as Posted unless the place confirmed it. Server: POST /job-broadcast/jobs/:id/post-everywhere,
// GET /job-broadcast/jobs/:id/post-status (live chips, looked at again while something is going).
// ---------------------------------------------------------------------------
const PLACES = [
  ['naukri', 'Naukri', 'Posted for you if the company login is saved'],
  ['indeed', 'Indeed', 'Goes into our job feed'],
  ['shine', 'Shine', 'Posted for you if the company login is saved'],
  ['foundit', 'Foundit', 'Posted for you if the company login is saved'],
  ['linkedin', 'LinkedIn', 'By hand: we keep the task and the text'],
  ['career', 'Our careers page', 'Live at once'],
  ['google', 'Google Jobs', 'Goes into our job feed'],
  ['whatsapp', 'WhatsApp contacts', 'Send to one of your contact lists'],
  ['email', 'Email list', 'Not built yet'],
];
const TONE = { posted: 'green', feed: 'green', running: 'blue', queued: 'blue', needs_help: 'yellow', not_connected: 'yellow', not_available: 'grey', failed: 'red', idle: 'grey', sent: 'green' };
const LABEL = { posted: 'Posted', feed: 'In our feed', running: 'Running', queued: 'Queued', needs_help: 'Needs your help', not_connected: 'Not connected', not_available: 'Not available yet', failed: 'Failed', idle: 'Not posted' };
const GOING = ['queued', 'running'];

export default function PostEverywhere({ requirementId, canPost = true, onChanged }) {
  const [picked, setPicked] = useState(['naukri', 'indeed', 'shine', 'career']);
  const [lists, setLists] = useState([]);
  const [listId, setListId] = useState('');
  const [chips, setChips] = useState([]);
  const [answer, setAnswer] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [dialog, setDialog] = useState(false);
  const polls = useRef(0);

  const loadStatus = () => api.get(`/job-broadcast/jobs/${requirementId}/post-status`).then((r) => setChips(r.data.chips || [])).catch(() => {});
  useEffect(() => { polls.current = 0; loadStatus(); api.get('/job-broadcast/lists').then((r) => setLists(r.data.lists || [])).catch(() => {}); }, [requirementId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!chips.some((c) => GOING.includes(c.state)) || polls.current > 60) return undefined;
    const t = setTimeout(() => { polls.current += 1; loadStatus(); }, 3000);
    return () => clearTimeout(t);
  }, [chips]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  async function post() {
    setBusy(true); setErr(''); setAnswer(null);
    try {
      const r = await api.post(`/job-broadcast/jobs/${requirementId}/post-everywhere`, { places: picked, listId: picked.includes('whatsapp') ? listId : undefined });
      setAnswer(r.data.results); polls.current = 0; await loadStatus(); if (onChanged) onChanged();
    } catch (e) {
      if (e.response?.status === 409 && e.response.data?.code === 'ACT_CONFIRM_SEND' && window.confirm(e.response.data.error)) {
        try { const r = await api.post(`/job-broadcast/jobs/${requirementId}/post-everywhere`, { places: picked, listId: picked.includes('whatsapp') ? listId : undefined }, { headers: { 'X-Act-Confirm': 'send' } }); setAnswer(r.data.results); await loadStatus(); } catch (e2) { setErr(e2.response?.data?.error || 'That did not work.'); }
      } else setErr(e.response?.data?.error || 'That did not work. Please try again.');
    } finally { setBusy(false); }
  }
  const retry = async (c) => { try { await api.post(`/job-publish/queue/${c.queueId}/retry`); polls.current = 0; await loadStatus(); } catch (e) { setErr(e.response?.data?.error || 'Could not try again.'); } };
  const showing = answer || null;

  return (
    <div className="bc-panel">
      <div className="bc-head"><b style={{ flex: 1 }}>Post this requirement</b><span className="bc-note">One click, every place you tick.</span></div>
      <div className="bc-body">
        {!canPost && <div className="bc-note">You can see where this requirement is posted. Your team lead or the client manager posts it.</div>}
        {canPost && (
          <>
            <div className="bc-places">
              {PLACES.map(([id, name, hint]) => (
                <label key={id} className={`bc-place${picked.includes(id) ? ' on' : ''}`}>
                  <input type="checkbox" checked={picked.includes(id)} onChange={() => toggle(id)} />
                  <span>{name}<small>{hint}</small></span>
                </label>
              ))}
            </div>
            {picked.includes('whatsapp') && (
              <div className="bc-row">
                <span style={{ fontWeight: 600, fontSize: 13 }}>Send to list</span>
                {lists.length === 0 && <span className="bc-note">No contact list yet. Add one in Candidates, Contact lists.</span>}
                {lists.map((l) => (
                  <button type="button" key={l.id} className={`bc-tab${listId === l.id ? ' on' : ''}`} onClick={() => setListId(l.id)}>{l.name}<span className="bc-n">({(l.totals.valid || 0) + (l.totals.candidate || 0) + (l.totals.other_list || 0)})</span></button>
                ))}
                {listId && <button type="button" className="btn btn-sm" onClick={() => setDialog(true)}>Check numbers, time and limits first</button>}
              </div>
            )}
            <div className="bc-row">
              <button type="button" className="btn btn-primary bc-big" disabled={busy || !picked.length} onClick={post}>{busy ? 'Posting…' : 'Post to all selected places'}</button>
              <span className="bc-note">The text is your ready template ("Use this"). Nothing is posted twice.</span>
            </div>
          </>
        )}
        {err && <div className="bc-err" role="alert">{err}</div>}
        {showing && (
          <div className="bc-chips" aria-label="What happened">
            {showing.map((x) => (
              <div className="bc-chip" key={x.place}>
                <b>{x.name}</b><StatusChip tone={TONE[x.state] || 'grey'}>{LABEL[x.state] || x.state}</StatusChip>
                <span className="bc-note" style={{ flex: 1 }}>{x.words}{x.detail && x.detail !== x.words ? ` · ${x.detail}` : ''}</span>
                {x.state === 'not_connected' && <Link className="btn btn-sm" to="/admin/integrations">Set up in Integrations</Link>}
              </div>
            ))}
          </div>
        )}
        <h4 style={{ fontSize: 12.5, margin: '12px 0 4px' }}>Where it is now</h4>
        {chips.length === 0 && <div className="bc-note">Not posted anywhere yet.</div>}
        <div className="bc-chips">
          {chips.map((c, i) => (
            <div className="bc-chip" key={`${c.place}${c.campaignId || ''}${i}`}>
              <b>{c.name}</b><StatusChip tone={TONE[c.state] || 'grey'}>{LABEL[c.state] || c.state}</StatusChip>
              <span className="bc-note" style={{ flex: 1 }}>{c.words}{c.error ? ` · ${c.error}` : ''}</span>
              {c.link && <a className="btn btn-sm" href={c.link} target="_blank" rel="noreferrer">View requirement</a>}
              {c.state === 'failed' && c.queueId && canPost && <button type="button" className="btn btn-sm btn-primary" onClick={() => retry(c)}>Retry</button>}
              {c.state === 'needs_help' && c.place !== 'whatsapp' && <span className="bc-note">Open "Posting sources" on the requirement to finish by hand.</span>}
              {c.campaignId && <Link className="btn btn-sm" to={`/candidates?tab=contacts&campaign=${c.campaignId}`}>See replies{c.replies ? ` (${c.replies})` : ''}</Link>}
            </div>
          ))}
        </div>
      </div>
      {dialog && <CampaignDialog jobId={requirementId} listId={listId} onClose={() => setDialog(false)} onStarted={() => { setDialog(false); loadStatus(); }} />}
    </div>
  );
}
