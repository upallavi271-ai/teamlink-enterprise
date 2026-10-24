import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api';
import Modal from '../Modal.jsx';
import './newItems.css';

// ---------------------------------------------------------------------------
// THE "NEW" BUTTON ON EVERY DASHBOARD (user, 2026-10-13).
// One big button with a count: "New (3)". It opens a clear list of what reached this login and is not looked at yet -
// new jobs, new candidates, new interviews, agreements waiting, new messages - each with an Open button. An item stays New
// until it is opened (or "Mark all as seen"), then it moves to the Seen tab. GET/POST /api/new-items (routes/newItems.js).
// ---------------------------------------------------------------------------
const KIND = {
  job: { label: 'Requirements', one: 'Requirement', icon: '💼' },
  candidate: { label: 'Candidates', one: 'Candidate', icon: '👤' },
  interview: { label: 'Interviews', one: 'Interview', icon: '📅' },
  agreement: { label: 'Agreements', one: 'Agreement', icon: '📝' },
  message: { label: 'Messages', one: 'Message', icon: '💬' },
};
const KINDS = Object.keys(KIND);

function ago(at) {
  const t = new Date(at).getTime();
  if (!t) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 2) return 'just now';
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

// `module` ('hrms' | 'ats' | 'accounts') keeps only that product's news (founder 2026-10-24): the HRMS dashboard's New button lists HRMS lines
// only, the ATS dashboard's lists ATS lines only. Nothing else about the button changes. No module = everything (the home Dashboard).
export default function NewItems({ module = null }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('new');
  const [kind, setKind] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get('/new-items', { params: module ? { module } : {} }).then((r) => setData(r.data)).catch(() => setData((d) => d || false)), [module]);
  useEffect(() => {
    load();
    const t = setInterval(load, 90000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [load]);

  if (data === false) return null; // this login has nothing to show or the read failed: no button
  const count = data ? data.count : 0;
  const items = (data && data.items) || [];
  const fresh = items.filter((i) => !i.seen);
  const seen = items.filter((i) => i.seen);
  const list = (tab === 'new' ? fresh : seen).filter((i) => !kind || i.kind === kind);

  async function mark(keys, all = false) {
    setBusy(true);
    try { await api.post('/new-items/seen', { ...(all ? { all: true } : { keys }), ...(module ? { module } : {}) }); } catch { /* the list reloads below */ }
    await load();
    setBusy(false);
  }
  async function openItem(i) {
    if (!i.seen) await mark([i.key]);
    setOpen(false);
    navigate(i.link || '/');
  }

  return (
    <>
      <div className="nwi-bar">
        <button type="button" className={`nwi-btn${count ? ' has' : ''}`} onClick={() => { setTab(count ? 'new' : 'seen'); setKind(''); setOpen(true); }} aria-label={count ? `New: ${count} things to look at` : 'New: nothing new'}>
          <span className="nwi-bell" aria-hidden="true">🔔</span>
          <span className="nwi-t">{data ? `New (${count})` : 'New'}</span>
        </button>
        <span className="nwi-hint">
          {data === null ? 'Checking what is new…' : count
            ? `${count} new thing${count === 1 ? '' : 's'} for you. Press New to see ${count === 1 ? 'it' : 'them'}.`
            : 'You are all caught up. New requirements, people and messages will show here.'}
        </span>
      </div>
      {open && (
        <Modal
          title="What is new for you"
          size="wide"
          onClose={() => setOpen(false)}
          footer={(
            <>
              {tab === 'new' && fresh.length > 0 && <button type="button" className="btn" disabled={busy} onClick={() => mark([], true)}>Mark all as seen</button>}
              <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>Close</button>
            </>
          )}
        >
          <div className="nwi">
            <div className="nwi-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'new'} className={tab === 'new' ? 'on' : ''} onClick={() => setTab('new')}>{`New (${fresh.length})`}</button>
              <button type="button" role="tab" aria-selected={tab === 'seen'} className={tab === 'seen' ? 'on' : ''} onClick={() => setTab('seen')}>{`Seen (${seen.length})`}</button>
            </div>
            <div className="nwi-kinds">
              <button type="button" className={!kind ? 'on' : ''} onClick={() => setKind('')}>All</button>
              {KINDS.map((k) => {
                const n = (tab === 'new' ? fresh : seen).filter((i) => i.kind === k).length;
                return n ? <button key={k} type="button" className={kind === k ? 'on' : ''} onClick={() => setKind(kind === k ? '' : k)}>{`${KIND[k].label} (${n})`}</button> : null;
              })}
            </div>
            {list.length === 0 && (
              <div className="nwi-empty">
                {tab === 'new' ? 'You are all caught up. When a new requirement, person, interview or message reaches you, it shows here.' : 'Things you have opened show here.'}
              </div>
            )}
            <ul className="nwi-list">
              {list.map((i) => (
                <li key={i.key} className={i.seen ? 'is-seen' : ''}>
                  <span className="nwi-ic" aria-hidden="true">{(KIND[i.kind] || KIND.message).icon}</span>
                  <div className="nwi-body">
                    <div className="nwi-title"><span className="nwi-kind">{(KIND[i.kind] || KIND.message).one}</span> {i.title}</div>
                    {i.text && <div className="nwi-text">{i.text}</div>}
                    <div className="nwi-when">{ago(i.at)}</div>
                  </div>
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => openItem(i)}>Open</button>
                </li>
              ))}
            </ul>
          </div>
        </Modal>
      )}
    </>
  );
}
