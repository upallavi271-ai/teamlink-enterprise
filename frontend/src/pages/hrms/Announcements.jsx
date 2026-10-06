import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  PanelPad, AssignRow, TwoCol, QaRow,
  NumHead, FeatureTiles, FeatureScreen, FeatureTable,
} from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin, canManageServices } from '../../permissions';
import Combo from '../../components/Combo.jsx';
import PeopleFilterBar, { peopleMatches, textMatches } from '../../components/PeopleFilterBar.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { ListEmpty } from '../../components/ui/ListFilters.jsx';
import AudiencePicker, { DeliverVia, EMPTY_AUDIENCE, audienceReady } from '../../components/AudiencePicker.jsx';
import {
  ComposeModal, Field, AiAssist, CheckLine, useSubmit,
} from '../../components/ComposeForm.jsx';
import { useSearchParams } from 'react-router-dom';
import { JoinMeeting, meetingLinkError } from '../../components/MeetingLink.jsx';

const CATEGORIES = ['General', 'Policy', 'Event', 'Holiday'];
// An announcement is not per employee and has no status, so its filters are
// its own: title / text, category, the date posted and (More) who it was sent
// to and whether it is pinned.
const EMPTY_AN_FILTERS = { q: '', category: '', target: '', pinned: '', from: '', to: '' };
const postedOf = (a) => a.date || a.createdAt;
const AN_SORTS = [
  ['pinned', 'Pinned first', null], // the server's order: pinned, then newest
  ['new', 'Newest first', (a, b) => String(postedOf(b)).localeCompare(String(postedOf(a)))],
  ['old', 'Oldest first', (a, b) => String(postedOf(a)).localeCompare(String(postedOf(b)))],
  ['title', 'Title A–Z', (a, b) => String(a.title || '').localeCompare(String(b.title || ''))],
];

// The prototype's three Announcement feature tiles (AN_FEATURES, line 4428).
export const AN_FEATURES = [
  ['compose', 'Compose & Target Announcement'],
  ['delivery', 'Delivery Tracking'],
  ['archive', 'Announcement Archive'],
];

// THE REFERENCE FORM. Every other Employee Services / Performance create form
// follows this layout (components/ComposeForm.jsx): Title *, AI Assist, Body *,
// Category, Send to (components/AudiencePicker.jsx — Everyone, one or MANY
// departments, or named employees), Also deliver via, Pin to top, then
// [Post Announcement] [Cancel].
function NewAnnouncementModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ title: '', body: '', category: 'General', pinned: false, meetingLink: '', meetingAt: '' });
  const [audience, setAudience] = useState(EMPTY_AUDIENCE);
  const [channels, setChannels] = useState([]);
  const { busy, error, setError, run } = useSubmit();
  const linkError = meetingLinkError(form.meetingLink);

  async function submit() {
    if (!form.title.trim()) { setError('Enter a title.'); return; }
    if (!form.body.trim()) { setError('Enter the announcement text.'); return; }
    if (linkError) { setError(linkError); return; }
    if (!audienceReady(audience)) { setError(audience.mode === 'departments' ? 'Pick at least one department.' : 'Pick at least one employee.'); return; }
    const link = form.meetingLink.trim();
    const res = await run(() => api.post('/announcements', {
      ...form, meetingLink: link, meetingAt: link ? form.meetingAt : '', audience, channels, date: new Date().toISOString().slice(0, 10),
    }), 'Could not post the announcement');
    if (res) onSaved(res.data);
  }

  return (
    <ComposeModal title="New Announcement" onClose={onClose} onSubmit={submit} submitLabel="Post Announcement" busy={busy} error={error} wide>
      <Field label="Title" required><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
      <AiAssist kind="announcement" title={form.title} text={form.body} onText={(body) => setForm((f) => ({ ...f, body }))} />
      <Field label="Body" required><textarea rows="5" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></Field>
      <Field label="Category">
        <Combo creatable value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </Combo>
      </Field>
      {/* Optional — for a meeting, event or training. People get a
          "Join meeting" button on the notice board and in their bell. */}
      <div className="mtg-fields">
        <Field label="Meeting link (optional)">
          <input type="url" inputMode="url" placeholder="https://meet.google.com/..." value={form.meetingLink} onChange={(e) => setForm({ ...form, meetingLink: e.target.value })} />
          {form.meetingLink.trim() && linkError
            ? <div className="mtg-err">{linkError}</div>
            : <div className="mtg-hint">Paste a Google Meet, Zoom or Teams link. People will see a “Join meeting” button.</div>}
        </Field>
        {form.meetingLink.trim() && !linkError && (
          <Field label="Meeting date & time (optional)">
            <input type="datetime-local" value={form.meetingAt} onChange={(e) => setForm({ ...form, meetingAt: e.target.value })} />
          </Field>
        )}
      </div>
      <AudiencePicker value={audience} onChange={setAudience} />
      <DeliverVia value={channels} onChange={setChannels} />
      <CheckLine checked={form.pinned} onChange={(pinned) => setForm({ ...form, pinned })}>Pin to top</CheckLine>
    </ComposeModal>
  );
}

export default function Announcements({ view, onOpen, onBack }) {
  const { user } = useAuth();
  // isHR here DRAWS WRITE CONTROLS, so it asks the write permission and not
  // only the read one. A Manager and an Assistant Manager are view-only (§3,
  // §4) and still hold Employee Management/view, so isHR() alone would have
  // gone on offering them every button on this screen. Both halves, because
  // the screen is an administration screen AND these are writes.
  const isHR = hasHrmsAdmin(user) && canManageServices(user);
  const [announcements, setAnnouncements] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [sent, setSent] = useState('');
  const [nf, setNf] = useState(EMPTY_AN_FILTERS);
  const [sort, setSort] = useState('pinned');

  function load() {
    api.get('/announcements').then((res) => setAnnouncements(res.data));
  }
  useEffect(load, []);

  // ONE ANNOUNCEMENT OPENED — from its title on the notice board, or from a
  // notification (the bell links here with ?open=<title>&at=<sent time>,
  // because a Notification row has no id column for it). The match is the
  // newest announcement with that title posted closest to that time.
  const [params, setParams] = useSearchParams();
  const [openedId, setOpenedId] = useState(null);
  const wantTitle = params.get('open');
  const wantAt = params.get('at');
  useEffect(() => {
    if (!wantTitle || !announcements.length) return;
    const t = new Date(wantAt || Date.now()).getTime();
    const same = announcements.filter((a) => a.title === wantTitle)
      .sort((a, b) => Math.abs(new Date(a.createdAt).getTime() - t) - Math.abs(new Date(b.createdAt).getTime() - t));
    if (same[0]) setOpenedId(same[0].id);
    const next = new URLSearchParams(params);
    next.delete('open'); next.delete('at');
    setParams(next, { replace: true });
  }, [wantTitle, wantAt, announcements]); // eslint-disable-line react-hooks/exhaustive-deps
  const opened = openedId ? announcements.find((a) => a.id === openedId) : null;
  const detail = opened && (
    <div className="mtg-detail" role="region" aria-label="Announcement">
      <div className="mtg-d-top">
        <div>
          <h3>{opened.pinned && '📌 '}{opened.title}</h3>
          <div className="mtg-d-meta">{[opened.category || 'General', opened.target, opened.date, opened.postedBy && `by ${opened.postedBy}`].filter(Boolean).join(' · ')}</div>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setOpenedId(null)}>Close</button>
      </div>
      <div className="mtg-d-body">{opened.body}</div>
      {opened.meetingLink && <JoinMeeting href={opened.meetingLink} when={opened.meetingWhen} />}
    </div>
  );

  async function togglePin(a) { await api.put(`/announcements/${a.id}/pin`); load(); }

  const newButton = isHR && <button className="btn btn-primary btn-sm" onClick={() => setModalOpen(true)}>+ New Announcement</button>;
  const sortCmp = (AN_SORTS.find(([k]) => k === sort) || AN_SORTS[0])[2];
  const filtered = announcements.filter((a) => textMatches(`${a.title} ${a.body || ''}`, nf.q)
    && (!nf.category || (a.category || 'General') === nf.category)
    && (!nf.target || (a.target || '') === nf.target)
    && (!nf.pinned || (nf.pinned === 'Pinned' ? !!a.pinned : !a.pinned))
    && peopleMatches(a, { from: nf.from, to: nf.to }, undefined, undefined, postedOf));
  const shown = sortCmp ? [...filtered].sort(sortCmp) : filtered;
  const page = usePaged(shown);
  const categories = [...new Set([...CATEGORIES, ...announcements.map((a) => a.category).filter(Boolean)])];
  const targets = [...new Set(announcements.map((a) => a.target).filter(Boolean))].sort();
  const setN = (k, v) => setNf((f) => ({ ...f, [k]: v }));
  const bar = (
    <PeopleFilterBar
      filters={nf} setFilters={setNf} people={false} search="Title or text" shown={shown.length} total={announcements.length}
      dates="Posted on" labels={{ category: 'Category', target: 'Sent to', pinned: 'Pinned' }} moreKeys={['target', 'pinned']}
      more={(
        <>
          <Combo value={nf.target} title="Sent to" onChange={(e) => setN('target', e.target.value)}>
            <option value="">Sent to anyone</option>
            {targets.map((t) => <option key={t}>{t}</option>)}
          </Combo>
          <Combo value={nf.pinned} title="Pinned" onChange={(e) => setN('pinned', e.target.value)}>
            <option value="">Pinned or not</option>
            <option>Pinned</option>
            <option>Not pinned</option>
          </Combo>
        </>
      )}
    >
      <Combo value={nf.category} title="Category" onChange={(e) => setN('category', e.target.value)}>
        <option value="">All categories</option>
        {categories.map((c) => <option key={c}>{c}</option>)}
      </Combo>
      <label className="lf-sort">
        Sort
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          {AN_SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
    </PeopleFilterBar>
  );
  const nfLike = { activeCount: Object.values(nf).filter(Boolean).length, clear: () => setNf(EMPTY_AN_FILTERS) };
  const none = <ListEmpty lf={nfLike} noun="announcements" />;
  const pager = <Pager page={page} noun="announcements" />;

  const modal = modalOpen && (
    <NewAnnouncementModal
      onClose={() => setModalOpen(false)}
      onSaved={(a) => { setModalOpen(false); setSent(`Posted to ${a.target || 'everyone'} — ${a.reached ?? 0} employee(s). ${a.deliveryText || ''}`); load(); }}
    />
  );

  if (view === 'compose') {
    return (
      <FeatureScreen title="Compose & Target Announcement" sub="Write an announcement and choose who receives it." onBack={onBack}>
        <PanelPad style={{ marginTop: 14 }}>
          {newButton}
          <div className="cell-muted" style={{ fontSize: 12, marginTop: 10 }}>Send to everyone, to one or several departments, or to individual employees — and optionally by Email, SMS or WhatsApp as well.</div>
          {sent && <div className="notice" style={{ marginTop: 10 }}>{sent}</div>}
        </PanelPad>
        {modal}
      </FeatureScreen>
    );
  }
  if (view === 'delivery') {
    return (
      <FeatureScreen title="Delivery Tracking" sub="Who each announcement reached and what every channel actually did." onBack={onBack}>
        {bar}
        <FeatureTable
          heads={['Announcement', 'Target', 'Delivery']}
          empty={none}
          rows={page.slice.map((a) => (
            <tr key={a.id}>
              <td>{a.title}</td>
              <td className="cell-muted">{a.target || '—'}</td>
              <td className="cell-muted">{a.deliveryText || 'In-app notice board only (posted before delivery tracking).'}</td>
            </tr>
          ))}
        />
        {pager}
      </FeatureScreen>
    );
  }
  if (view === 'archive') {
    return (
      <FeatureScreen title="Announcement Archive" sub="Every announcement ever posted." onBack={onBack}>
        {bar}
        <FeatureTable
          heads={['Date', 'Title', 'Category', 'Pinned']}
          empty={none}
          rows={page.slice.map((a) => (
            <tr key={a.id}>
              <td>{a.date || '—'}</td>
              <td>{a.title}</td>
              <td className="cell-muted">{a.category || 'General'}</td>
              <td className="cell-muted">{a.pinned ? 'Pinned' : '—'}</td>
            </tr>
          ))}
        />
        {pager}
      </FeatureScreen>
    );
  }

  return (
    <div>
      <QaRow style={{ marginBottom: 14 }}>{newButton}</QaRow>
      {sent && <div className="notice">{sent}</div>}
      {detail}
      {bar}
      <TwoCol style={{ alignItems: 'start' }}>
        <PanelPad>
          <NumHead n={1} title="Notice Board" />
          {shown.length === 0 ? none : page.slice.map((a) => (
            <AssignRow key={a.id}>
              <span>
                {a.pinned && '📌 '}<button type="button" className="mtg-open-title" onClick={() => setOpenedId(a.id)} title="Open this announcement">{a.title}</button><br />
                <span className="cell-muted" style={{ fontSize: 11.5 }}>{a.body} · {a.target || ''} · {a.date || ''}</span>
                {a.meetingLink && <><br /><JoinMeeting small href={a.meetingLink} when={a.meetingWhen} /></>}
              </span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className={`status ${a.category === 'Policy' ? 'pending' : 'active'}`}>{a.category || 'General'}</span>
                {isHR && <button className="btn btn-sm" onClick={() => togglePin(a)}>{a.pinned ? 'Unpin' : 'Pin'}</button>}
              </span>
            </AssignRow>
          ))}
          {shown.length > 0 && pager}
        </PanelPad>
        <FeatureTiles features={AN_FEATURES} onOpen={onOpen} />
      </TwoCol>
      {modal}
    </div>
  );
}
