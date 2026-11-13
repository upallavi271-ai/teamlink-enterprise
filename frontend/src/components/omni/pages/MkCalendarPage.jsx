import { useCallback, useEffect, useMemo, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { getState } from '../omniStore.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Banner, Field, GsModal, ConfirmModal, Kpi, Kpis, Tabs, fmtDateTime } from '../ui.jsx';
import { useMkMeta, aiReady, AiBanner, MkImg } from '../marketing/mk.jsx';
import '../marketing/marketing.css';

// AI MARKETING > CONTENT CALENDAR: what goes out on which day (Facebook, Instagram, LinkedIn, X, WhatsApp, email), in India time.
// Month / week / list views, drag a post to another day, "Plan a week with AI" (ideas only: a person picks what goes on the calendar).
// Nothing is published from here: each post is posted by hand and marked as posted (the screen says so). Server: marketing/calendar.js.
const IST = 19800000;
const istToday = () => new Date(Date.now() + IST).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dow = (d) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
const mondayOf = (d) => addDays(d, -dow(d));
const monthOf = (d) => d.slice(0, 7);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STATUS = {
  idea: { label: 'Idea', bg: '#f1f5f9', fg: '#475569' },
  planned: { label: 'Planned', bg: '#e0f2fe', fg: '#075985' },
  ready: { label: 'Ready', bg: '#dcfce7', fg: '#166534' },
  posted: { label: 'Posted', bg: '#ede9fe', fg: '#5b21b6' },
  skipped: { label: 'Skipped', bg: '#f5f5f4', fg: '#78716c' },
};
const OPEN = ['idea', 'planned', 'ready'];
// a new post today starts at the next full hour (+1), so it is never overdue the moment it is made; other days start at 10:00
const defaultTime = (date) => {
  if (date !== istToday()) return '10:00';
  const h = new Date(Date.now() + IST).getUTCHours() + 2;
  return h > 21 ? '21:30' : `${String(h).padStart(2, '0')}:00`;
};
const blankEntry = (date) => ({ id: '', title: '', date, time: defaultTime(date), platforms: ['facebook', 'instagram', 'linkedin'], text: '', mediaUrl: '', status: 'planned', note: '', contentId: '', canEdit: true });

function Chip({ e, plats, onOpen, draggable }) {
  const st = STATUS[e.status] || STATUS.planned;
  return (
    <button type="button" className="mkc-chip" draggable={draggable} onDragStart={(ev) => { ev.dataTransfer.setData('text/plain', e.id); ev.dataTransfer.effectAllowed = 'move'; }}
      onClick={(ev) => { ev.stopPropagation(); onOpen(e); }} title={`${e.time} · ${e.title} · ${st.label}${e.overdue ? ' · overdue' : ''}`}
      style={{ background: e.overdue ? '#fee2e2' : st.bg, color: e.overdue ? '#991b1b' : st.fg, textDecoration: e.status === 'skipped' ? 'line-through' : 'none' }}>
      <span className="mkc-time">{e.time}</span>
      <span className="mkc-icons">{e.platforms.map((k) => { const p = plats.find((x) => x.key === k); return p ? <i key={k} style={{ background: p.color }}>{p.icon}</i> : null; })}</span>
      <span className="mkc-title">{e.overdue ? '⚠ ' : ''}{e.title}</span>
    </button>
  );
}

export default function MkCalendarPage() {
  const { toast } = useOmni();
  const { meta } = useMkMeta();
  const [cursor, setCursor] = useState(istToday());
  const [view, setView] = useState('month');
  const [plats, setPlats] = useState([]);
  const [canWrite, setCanWrite] = useState(false);
  const [entries, setEntries] = useState(null);
  const [err, setErr] = useState('');
  const [fPlat, setFPlat] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [ed, setEd] = useState(null); // the post being edited / added
  const [busy, setBusy] = useState('');
  const [del, setDel] = useState(null);
  const [postedAsk, setPostedAsk] = useState(null); // { entry, url }
  const [planOpen, setPlanOpen] = useState(false);
  const [showPlats, setShowPlats] = useState(false);

  // the dates on screen
  const range = useMemo(() => {
    if (view === 'week') { const s = mondayOf(cursor); return { from: s, to: addDays(s, 7) }; }
    if (view === 'list') { const t = istToday(); return { from: addDays(t, -14), to: addDays(t, 90) }; }
    const first = `${monthOf(cursor)}-01`; const s = mondayOf(first); return { from: s, to: addDays(s, 42) };
  }, [view, cursor]);
  const load = useCallback(() => {
    setErr('');
    omni.get('/gs/marketing/calendar', { from: `${range.from}T00:00:00+05:30`, to: `${range.to}T00:00:00+05:30` })
      .then((d) => { setEntries(d.entries || []); setCanWrite(!!d.canWrite); })
      .catch((e) => setErr(errOf(e, 'The calendar could not be read.')));
  }, [range]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { omni.get('/gs/marketing/calendar/platforms').then((d) => setPlats(d.platforms || [])).catch(() => setPlats([])); }, []);

  if (err && !entries) return <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Try again</button></Banner>;
  if (!entries || !plats.length) return <div className="card panel">Loading…</div>;

  const shown = entries.filter((e) => (!fPlat || e.platforms.includes(fPlat)) && (!fStatus || (fStatus === 'overdue' ? e.overdue : e.status === fStatus)));
  const byDay = shown.reduce((m, e) => { (m[e.date] = m[e.date] || []).push(e); return m; }, {});
  const today = istToday();
  const inMonth = view === 'month' ? entries.filter((e) => monthOf(e.date) === monthOf(cursor)) : entries;
  const cnt = (fn) => inMonth.filter(fn).length;

  const save = async () => {
    if (!ed.title.trim()) { toast('Give the post a short name'); return; }
    if (!ed.platforms.length) { toast('Pick at least one platform'); return; }
    setBusy('save');
    try {
      const body = { title: ed.title, date: ed.date, time: ed.time, platforms: ed.platforms, text: ed.text, mediaUrl: ed.mediaUrl, status: ed.status, note: ed.note, contentId: ed.contentId, ...(!ed.id && getState().dept ? { department: getState().dept } : {}) };
      if (ed.id) await omni.put(`/gs/marketing/calendar/${ed.id}`, body); else await omni.post('/gs/marketing/calendar', body);
      toast(ed.id ? 'Saved' : 'Added to the calendar'); setEd(null); load();
    } catch (e) { toast(errOf(e, 'It could not be saved.')); } finally { setBusy(''); }
  };
  const moveTo = async (id, date) => {
    const e = entries.find((x) => x.id === id);
    if (!e || e.date === date || !e.canEdit || !OPEN.includes(e.status)) return;
    setEntries((list) => list.map((x) => (x.id === id ? { ...x, date } : x))); // move at once, put back if the server says no
    try { await omni.put(`/gs/marketing/calendar/${id}`, { date, time: e.time }); toast(`Moved to ${date}`); load(); } catch (x) { toast(errOf(x, 'It could not be moved.')); load(); }
  };
  const markPosted = async () => {
    const { entry, url } = postedAsk; setBusy('posted');
    try { const r = await omni.post(`/gs/marketing/calendar/${entry.id}/posted`, { postUrl: url.trim() }); toast(r.ok); setPostedAsk(null); setEd(null); load(); } catch (e) { toast(errOf(e, 'It could not be marked.')); } finally { setBusy(''); }
  };
  const skip = async (e) => { setBusy('skip'); try { const r = await omni.post(`/gs/marketing/calendar/${e.id}/skip`, {}); toast(r.ok); setEd(null); load(); } catch (x) { toast(errOf(x, 'It could not be skipped.')); } finally { setBusy(''); } };
  const reopen = async (e) => { setBusy('reopen'); try { await omni.put(`/gs/marketing/calendar/${e.id}`, { reopen: true, status: 'planned' }); toast('Back on the plan'); setEd(null); load(); } catch (x) { toast(errOf(x, 'It could not be reopened.')); } finally { setBusy(''); } };
  const remove = async () => { const e = del; setDel(null); try { await omni.del(`/gs/marketing/calendar/${e.id}`); toast('Deleted'); setEd(null); load(); } catch (x) { toast(errOf(x, 'It could not be deleted.')); } };
  const open = (e) => setEd({ ...e });
  const add = (date) => { if (!canWrite) return; setEd(blankEntry(date < today ? today : date)); };

  const shift = (n) => setCursor((c) => (view === 'week' ? addDays(c, 7 * n) : (() => { const [y, m] = c.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 10); })()));
  const heading = view === 'week' ? `${range.from} – ${addDays(range.from, 6)}` : view === 'list' ? 'The next three months' : `${MONTHS[Number(cursor.slice(5, 7)) - 1]} ${cursor.slice(0, 4)}`;

  const dayCell = (d) => {
    const list = byDay[d] || [];
    const off = view === 'month' && monthOf(d) !== monthOf(cursor);
    return (
      <div key={d} className={`mkc-day${off ? ' off' : ''}${d === today ? ' today' : ''}`} onDragOver={(ev) => { if (canWrite) ev.preventDefault(); }} onDrop={(ev) => { ev.preventDefault(); moveTo(ev.dataTransfer.getData('text/plain'), d); }}
        onDoubleClick={() => add(d)}>
        <div className="mkc-dnum"><span>{view === 'week' ? `${DAYS[dow(d)]} ${Number(d.slice(8))}` : Number(d.slice(8))}</span>{canWrite && d >= today ? <button type="button" className="mkc-add" onClick={() => add(d)} aria-label={`Add a post on ${d}`}>+</button> : null}</div>
        {list.map((e) => <Chip key={e.id} e={e} plats={plats} onOpen={open} draggable={canWrite && e.canEdit && OPEN.includes(e.status)} />)}
      </div>
    );
  };

  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Content Calendar" lead="Plan what goes out on which day. Drag a post to move it. Everything is in India time.">
        {canWrite && <Btn onClick={() => setPlanOpen(true)} disabled={!(meta && aiReady(meta.ai))} title={meta && !aiReady(meta.ai) ? 'The AI is not ready' : ''}>✦ Plan a week with AI</Btn>}
        {canWrite && <Btn primary onClick={() => add(today)}>+ New post</Btn>}
      </PageHead>
      {meta ? <AiBanner ai={meta.ai} /> : null}
      <Banner tone="info"><b>Posting is done by hand for now.</b> Open a post, copy the words, post them on the page, then press “Mark as posted”. Automatic posting to Facebook, Instagram and LinkedIn is added once the company's developer apps are approved. <button type="button" className="tiny-btn" style={{ marginLeft: 6 }} onClick={() => setShowPlats(!showPlats)}>{showPlats ? 'Hide' : 'Show'} platform status</button></Banner>
      {showPlats ? <div className="mkc-plats">{plats.map((p) => <div key={p.key} className="card"><b><i style={{ background: p.color }}>{p.icon}</i>{p.label}</b><small>{p.words}</small></div>)}</div> : null}
      {err ? <Banner tone="error">{err}</Banner> : null}
      {!canWrite ? <Banner tone="info">You can look at the calendar of your department. Only Marketing and Admins change it.</Banner> : null}

      <Kpis>
        <Kpi label="Ideas" icon="💡" value={cnt((e) => e.status === 'idea')} meta={view === 'month' ? 'This month' : 'On screen'} onClick={() => setFStatus(fStatus === 'idea' ? '' : 'idea')} />
        <Kpi label="Planned" icon="▦" value={cnt((e) => e.status === 'planned')} meta="Words may still be missing" onClick={() => setFStatus(fStatus === 'planned' ? '' : 'planned')} />
        <Kpi label="Ready" icon="✔" value={cnt((e) => e.status === 'ready')} meta="Words written" tone="good" onClick={() => setFStatus(fStatus === 'ready' ? '' : 'ready')} />
        <Kpi label="Posted" icon="➤" value={cnt((e) => e.status === 'posted')} meta="Marked as posted" onClick={() => setFStatus(fStatus === 'posted' ? '' : 'posted')} />
        <Kpi label="Overdue" icon="⚠" value={cnt((e) => e.overdue)} meta="Time passed, not posted" tone={cnt((e) => e.overdue) ? 'down' : undefined} onClick={() => setFStatus(fStatus === 'overdue' ? '' : 'overdue')} />
      </Kpis>

      <Panel style={{ marginTop: 14 }}
        title={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{view !== 'list' && <TinyBtn onClick={() => shift(-1)} aria-label="Earlier">‹</TinyBtn>}<span>{heading}</span>{view !== 'list' && <TinyBtn onClick={() => shift(1)} aria-label="Later">›</TinyBtn>}<TinyBtn onClick={() => setCursor(istToday())}>Today</TinyBtn></span>}
        right={(
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={fPlat} onChange={(e) => setFPlat(e.target.value)} aria-label="Platform"><option value="">All platforms</option>{plats.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select>
            <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} aria-label="Status"><option value="">Every status</option>{Object.entries(STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}<option value="overdue">Overdue</option></select>
            <Tabs value={view} onChange={setView} tabs={[['month', 'Month'], ['week', 'Week'], ['list', 'List']]} />
          </div>
        )}>
        {view === 'list' ? (
          shown.length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)', padding: '14px 0' }}>Nothing planned{fPlat || fStatus ? ' that matches the filter' : ''}. {canWrite ? 'Press “+ New post” or “Plan a week with AI”.' : ''}</div> : (
            <div className="mkc-list">{shown.map((e) => (
              <div key={e.id} className="mk-row" style={{ cursor: 'pointer' }} onClick={() => open(e)}>
                <div style={{ minWidth: 92 }}><b>{e.date}</b><small>{DAYS[dow(e.date)]} {e.time}</small></div>
                <div style={{ flex: 1, minWidth: 0 }}><Chip e={e} plats={plats} onOpen={open} draggable={false} /><small style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>{e.text || 'No words yet.'}</small></div>
                <small style={{ minWidth: 110, textAlign: 'right' }}>{e.ownerName}</small>
              </div>
            ))}</div>
          )
        ) : (
          <>
            <div className="mkc-grid mkc-head">{DAYS.map((d) => <div key={d}>{d}</div>)}</div>
            <div className={`mkc-grid${view === 'week' ? ' week' : ''}`}>{Array.from({ length: view === 'week' ? 7 : 42 }, (_, i) => dayCell(addDays(range.from, i)))}</div>
            {canWrite ? <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>Tip: press + on a day (or double-click it) to add a post; drag a post to another day to move it.</div> : null}
          </>
        )}
      </Panel>

      {ed ? <EntryModal ed={ed} setEd={setEd} plats={plats} busy={busy} canWrite={canWrite} onSave={save} onClose={() => setEd(null)} onPosted={(e) => setPostedAsk({ entry: e, url: '' })} onSkip={skip} onReopen={reopen} onDelete={(e) => setDel(e)} toast={toast} /> : null}
      {postedAsk ? (
        <GsModal title={`Mark "${postedAsk.entry.title}" as posted`} sub="Paste the link of the post if you have it (optional)." width={460} onClose={() => setPostedAsk(null)}
          foot={<><Btn onClick={() => setPostedAsk(null)}>Cancel</Btn><Btn primary disabled={busy === 'posted'} onClick={markPosted}>{busy === 'posted' ? 'Saving…' : '➤ Mark as posted'}</Btn></>}>
          <Field label="LINK OF THE POST"><input value={postedAsk.url} onChange={(e) => setPostedAsk({ ...postedAsk, url: e.target.value })} placeholder="https://www.linkedin.com/feed/update/…" maxLength={500} /></Field>
        </GsModal>
      ) : null}
      {planOpen ? <PlanModal plats={plats} onClose={() => setPlanOpen(false)} onAdded={() => { setPlanOpen(false); load(); }} toast={toast} /> : null}
      {del ? <ConfirmModal danger title={`Delete "${del.title}"?`} text="It is taken off the calendar." yes="Delete" onNo={() => setDel(null)} onYes={remove} /> : null}
    </div>
  );
}

// add / change one post
function EntryModal({ ed, setEd, plats, busy, canWrite, onSave, onClose, onPosted, onSkip, onReopen, onDelete, toast }) {
  const [srcs, setSrcs] = useState(null);
  const [srcErr, setSrcErr] = useState('');
  const [copied, setCopied] = useState(false);
  const [pics, setPics] = useState(null); // approved AI pictures (marketing/images.js)
  const loadPics = () => omni.get('/gs/marketing/images', { status: 'approved' }).then((d) => setPics((d.items || []).filter((p) => p.publicPath))).catch(() => setPics([]));
  const picUrl = (p) => `${window.location.origin}${p.publicPath}`;
  const isOpen = OPEN.includes(ed.status) || !ed.id;
  const edit = canWrite && ed.canEdit !== false && isOpen;
  const chosen = plats.filter((p) => ed.platforms.includes(p.key));
  const limit = chosen.length ? Math.min(...chosen.map((p) => p.limit)) : 5000;
  const strict = chosen.find((p) => p.limit === limit);
  const over = ed.text.length > limit;
  const loadSrcs = () => { setSrcErr(''); omni.get('/gs/marketing/calendar/sources').then((d) => setSrcs(d.items || [])).catch((e) => setSrcErr(errOf(e, 'The approved content could not be read.'))); };
  // approved AI content: take the words written for one of the chosen platforms, else the closest channel
  const useSource = (id) => {
    const it = (srcs || []).find((x) => x.id === id); if (!it) return;
    const t = it.texts || {};
    const key = ed.platforms.find((k) => t[k]) || ['linkedin', 'facebook', 'instagram', 'whatsapp', 'email', 'sms'].find((k) => t[k]);
    setEd({ ...ed, text: key ? t[key] : '', title: ed.title || it.title, contentId: it.id, status: ed.status === 'idea' ? 'planned' : ed.status });
    toast(`Words taken from "${it.title}"${key ? ` (${key})` : ''}`);
  };
  const copy = async () => { try { await navigator.clipboard.writeText(ed.text); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { toast('Copying is blocked in this browser: select the words and copy them'); } };
  const toggle = (k) => setEd({ ...ed, platforms: ed.platforms.includes(k) ? ed.platforms.filter((x) => x !== k) : [...ed.platforms, k] });
  return (
    <GsModal title={ed.id ? (edit ? 'Change the post' : ed.title) : 'Add a post'} sub={ed.id ? `${(STATUS[ed.status] || {}).label || ed.status}${ed.overdue ? ' · overdue' : ''}${ed.ownerName ? ` · ${ed.ownerName}` : ''}` : 'It goes on the calendar. Nothing is posted by itself.'} width={640} onClose={onClose}
      foot={(
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', width: '100%', justifyContent: 'flex-end' }}>
          {ed.id && canWrite && ed.canEdit !== false ? <Btn danger onClick={() => onDelete(ed)}>Delete</Btn> : null}
          {ed.id && canWrite && ed.canEdit !== false && isOpen ? <Btn disabled={!!busy} onClick={() => onSkip(ed)}>Skip</Btn> : null}
          {ed.id && canWrite && ed.canEdit !== false && !isOpen ? <Btn disabled={!!busy} onClick={() => onReopen(ed)}>Put back on the plan</Btn> : null}
          {ed.id && canWrite && ed.canEdit !== false && isOpen ? <Btn disabled={!!busy || !ed.text.trim()} onClick={() => onPosted(ed)} title={ed.text.trim() ? '' : 'Write the words first'}>➤ Mark as posted</Btn> : null}
          <Btn onClick={onClose}>{edit ? 'Cancel' : 'Close'}</Btn>
          {edit ? <Btn primary disabled={busy === 'save' || over} onClick={onSave}>{busy === 'save' ? 'Saving…' : ed.id ? 'Save' : 'Add to calendar'}</Btn> : null}
        </div>
      )}>
      <div className="form-grid">
        <Field label="NAME" full><input value={ed.title} maxLength={120} disabled={!edit} onChange={(e) => setEd({ ...ed, title: e.target.value })} placeholder="Walk-in drive reminder" /></Field>
        <Field label="DATE"><input type="date" value={ed.date} disabled={!edit} onChange={(e) => setEd({ ...ed, date: e.target.value })} /></Field>
        <Field label="TIME (IST)"><input type="time" value={ed.time} disabled={!edit} onChange={(e) => setEd({ ...ed, time: e.target.value })} /></Field>
        <Field label="STATUS" hint="Ready = the words are final.">
          <select value={isOpen ? ed.status : ed.status} disabled={!edit} onChange={(e) => setEd({ ...ed, status: e.target.value })}>
            {(isOpen ? ['idea', 'planned', 'ready'] : [ed.status]).map((k) => <option key={k} value={k}>{STATUS[k].label}</option>)}
          </select>
        </Field>
        <Field label="WHERE" full>
          <div className="mk-ch-pick">{plats.map((p) => <label key={p.key} className={ed.platforms.includes(p.key) ? 'on' : ''}><input type="checkbox" checked={ed.platforms.includes(p.key)} disabled={!edit} onChange={() => toggle(p.key)} />{p.label}</label>)}</div>
        </Field>
        {edit ? (
          <Field label="TAKE THE WORDS FROM APPROVED AI CONTENT" full hint="Only approved words are offered. You can still change them here.">
            {srcs === null ? <TinyBtn onClick={loadSrcs}>Show approved content</TinyBtn>
              : srcs.length === 0 ? <small style={{ color: 'var(--muted)' }}>No approved AI content yet. Write some in AI Content and get it approved.</small>
                : <select value="" onChange={(e) => useSource(e.target.value)}><option value="">Pick approved content…</option>{srcs.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select>}
            {srcErr ? <small style={{ color: '#b3261e' }}>{srcErr}</small> : null}
          </Field>
        ) : null}
        <Field label="THE WORDS" full>
          <textarea style={{ minHeight: 140 }} value={ed.text} disabled={!edit} onChange={(e) => setEd({ ...ed, text: e.target.value })} placeholder="What the post says…" maxLength={6000} />
          <div className={`mk-count${over ? ' over' : ''}`}><span>{ed.text.length.toLocaleString('en-IN')} / {limit.toLocaleString('en-IN')} characters{strict ? ` (${strict.label} is the shortest)` : ''}{over ? ' · too long' : ''}</span><span><TinyBtn disabled={!ed.text.trim()} onClick={copy}>{copied ? '✓ Copied' : '⧉ Copy the words'}</TinyBtn></span></div>
        </Field>
        <Field label="PICTURE OR VIDEO LINK (OPTIONAL)" full>
          <input value={ed.mediaUrl} maxLength={500} disabled={!edit} onChange={(e) => setEd({ ...ed, mediaUrl: e.target.value })} placeholder="https://…" />
          {edit ? (
            pics === null ? <div style={{ marginTop: 6 }}><TinyBtn onClick={loadPics}>◩ Pick an approved AI picture or video</TinyBtn></div>
              : pics.length === 0 ? <small style={{ color: 'var(--muted)' }}>No approved AI pictures yet. Make one in AI Images and get it approved.</small>
                : <div className="mki-pick" style={{ marginTop: 6 }}>{pics.map((p) => <button type="button" key={p.id} className={ed.mediaUrl === picUrl(p) ? 'on' : ''} title={`${p.kind === 'video' ? 'Video: ' : ''}${p.title}`} onClick={() => setEd({ ...ed, mediaUrl: ed.mediaUrl === picUrl(p) ? '' : picUrl(p) })}><MkImg id={p.id} alt={p.title} video={p.kind === 'video'} controls={false} style={{ height: '100%', borderRadius: 8, ...(p.kind === 'video' ? { background: '#000' } : {}) }} /></button>)}</div>
          ) : null}
        </Field>
        <Field label="NOTE (OPTIONAL)" full><input value={ed.note} maxLength={500} disabled={!(canWrite && ed.canEdit !== false)} onChange={(e) => setEd({ ...ed, note: e.target.value })} placeholder="For example: use the photo from the Hyderabad drive" /></Field>
      </div>
      {ed.id && isOpen ? (
        <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <small style={{ color: 'var(--muted)' }}>Post it by hand:</small>
          {chosen.filter((p) => p.home).map((p) => <a key={p.key} className="tiny-btn" href={p.home} target="_blank" rel="noopener noreferrer">Open {p.label} ↗</a>)}
        </div>
      ) : null}
      {ed.status === 'posted' ? <div className="mk-note ok" style={{ marginTop: 10 }}>Posted{ed.postedByName ? ` by ${ed.postedByName}` : ''}{ed.postedAt ? ` · ${fmtDateTime(ed.postedAt)}` : ''}{ed.postUrl ? <> · <a href={ed.postUrl} target="_blank" rel="noopener noreferrer">open the post ↗</a></> : ''}</div> : null}
    </GsModal>
  );
}

// "Plan a week with AI": ideas only, a person ticks which go on the calendar
function PlanModal({ plats, onClose, onAdded, toast }) {
  const nextMonday = (() => { const t = istToday(); return addDays(t, 7 - dow(t)); })();
  const [f, setF] = useState({ startDate: nextMonday, days: 7, perDay: 1, platforms: ['facebook', 'instagram', 'linkedin'], theme: '' });
  const [ideas, setIdeas] = useState(null);
  const [pick, setPick] = useState([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const gen = async () => {
    if (!f.platforms.length) { setErr('Pick at least one platform.'); return; }
    setBusy('gen'); setErr(''); setIdeas(null);
    try { const r = await omni.post('/gs/marketing/calendar/plan', f); setIdeas(r.ideas); setPick(r.ideas.map((_, i) => i)); } catch (e) { setErr(errOf(e, 'The AI could not plan it.')); } finally { setBusy(''); }
  };
  const addAll = async () => {
    const list = ideas.filter((_, i) => pick.includes(i));
    if (!list.length) { setErr('Tick at least one idea.'); return; }
    setBusy('add'); setErr('');
    try { const r = await omni.post('/gs/marketing/calendar/bulk', { entries: list.map((x) => ({ ...x, ...(getState().dept ? { department: getState().dept } : {}) })) }); toast(r.ok); onAdded(); } catch (e) { setErr(errOf(e, 'They could not be added.')); } finally { setBusy(''); }
  };
  return (
    <GsModal title="Plan a week with AI" sub="The AI suggests posts in your brand voice. Nothing is added until you pick the ideas you like." width={720} onClose={onClose}
      foot={ideas ? <><Btn onClick={() => setIdeas(null)}>← Change the plan</Btn><Btn primary disabled={busy === 'add' || !pick.length} onClick={addAll}>{busy === 'add' ? 'Adding…' : `Add ${pick.length} to the calendar`}</Btn></> : <><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={busy === 'gen'} onClick={gen}>{busy === 'gen' ? 'Planning…' : '✦ Suggest posts'}</Btn></>}>
      {!ideas ? (
        <div className="form-grid">
          <Field label="FIRST DAY"><input type="date" value={f.startDate} min={istToday()} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
          <Field label="HOW MANY DAYS"><select value={f.days} onChange={(e) => setF({ ...f, days: Number(e.target.value) })}>{[3, 5, 7, 10, 14].map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
          <Field label="POSTS A DAY"><select value={f.perDay} onChange={(e) => setF({ ...f, perDay: Number(e.target.value) })}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
          <Field label="WHERE" full><div className="mk-ch-pick">{plats.map((p) => <label key={p.key} className={f.platforms.includes(p.key) ? 'on' : ''}><input type="checkbox" checked={f.platforms.includes(p.key)} onChange={() => setF({ ...f, platforms: f.platforms.includes(p.key) ? f.platforms.filter((x) => x !== p.key) : [...f.platforms, p.key] })} />{p.label}</label>)}</div></Field>
          <Field label="THEME (OPTIONAL)" full hint="For example: nursing jobs in Hyderabad, or a walk-in drive on Saturday."><input value={f.theme} maxLength={200} onChange={(e) => setF({ ...f, theme: e.target.value })} /></Field>
        </div>
      ) : (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}><small>{ideas.length} ideas · each goes on the calendar as an Idea, so you can still change it</small><TinyBtn onClick={() => setPick(pick.length === ideas.length ? [] : ideas.map((_, i) => i))}>{pick.length === ideas.length ? 'Untick all' : 'Tick all'}</TinyBtn></div>
          <div style={{ display: 'grid', gap: 6, maxHeight: '48vh', overflow: 'auto' }}>
            {ideas.map((x, i) => (
              <label key={`${x.date}${i}`} className="mk-row" style={{ cursor: 'pointer', alignItems: 'flex-start' }}>
                <input type="checkbox" checked={pick.includes(i)} onChange={() => setPick(pick.includes(i) ? pick.filter((y) => y !== i) : [...pick, i])} style={{ marginTop: 3 }} />
                <div style={{ flex: 1, minWidth: 0 }}><b>{x.title}</b><small>{DAYS[dow(x.date)]} {x.date} · {x.time}</small><div style={{ fontSize: 11.5, whiteSpace: 'pre-wrap', marginTop: 4 }}>{x.text}</div></div>
              </label>
            ))}
          </div>
        </div>
      )}
      {err ? <div className="mk-flag" role="alert">{err}</div> : null}
    </GsModal>
  );
}
