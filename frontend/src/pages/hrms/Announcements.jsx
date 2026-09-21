import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  PanelPad, AssignRow, EmptyMini, TwoCol, QaRow,
  NumHead, FeatureTiles, FeatureScreen, FeatureTable, Modal,
} from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin } from '../../permissions';
import Combo from '../../components/Combo.jsx';

const CATEGORIES = ['General', 'Policy', 'Event', 'Holiday'];

// The prototype's three Announcement feature tiles (AN_FEATURES, line 4428).
export const AN_FEATURES = [
  ['compose', 'Compose & Target Announcement'],
  ['delivery', 'Delivery Tracking'],
  ['archive', 'Announcement Archive'],
];

function NewAnnouncementModal({ departments, onClose, onSaved }) {
  const [form, setForm] = useState({ title: '', body: '', category: 'General', target: 'All Employees', pinned: false });
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    if (!form.title.trim()) { setError('Enter a title.'); return; }
    try {
      await api.post('/announcements', { ...form, body: form.body || '—', date: new Date().toISOString().slice(0, 10) });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not post the announcement');
    }
  }

  return (
    <Modal
      title="New Announcement"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={submit}>Send</button></>}
    >
      <div className="field"><label>Title</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
      <div className="field"><label>Body</label><textarea rows="3" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></div>
      <div className="grid-2">
        <div className="field">
          <label>Category</label>
          <Combo creatable value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </Combo>
        </div>
        <div className="field">
          <label>Target</label>
          <Combo value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })}>
            <option>All Employees</option>
            {departments.map((d) => <option key={d}>{d} Department</option>)}
          </Combo>
        </div>
      </div>
      <div className="field">
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} /> Pin to top
        </label>
      </div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

export default function Announcements({ view, onOpen, onBack }) {
  const { user } = useAuth();
  const isHR = hasHrmsAdmin(user);
  const [announcements, setAnnouncements] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);

  function load() {
    api.get('/announcements').then((res) => setAnnouncements(res.data));
    api.get('/admin/departments').then((res) => setDepartments(res.data.map((d) => d.name))).catch(() => setDepartments([]));
  }
  useEffect(load, []);

  async function togglePin(a) { await api.put(`/announcements/${a.id}/pin`); load(); }

  const newButton = isHR && <button className="btn btn-primary btn-sm" onClick={() => setModalOpen(true)}>+ New Announcement</button>;
  const modal = modalOpen && (
    <NewAnnouncementModal departments={departments} onClose={() => setModalOpen(false)} onSaved={() => { setModalOpen(false); load(); }} />
  );

  if (view === 'compose') {
    return (
      <FeatureScreen title="Compose & Target Announcement" sub="Write an announcement and choose who receives it." onBack={onBack}>
        <PanelPad style={{ marginTop: 14 }}>
          {newButton}
          <div className="cell-muted" style={{ fontSize: 12, marginTop: 10 }}>Targeting options: All Employees, or a single department.</div>
        </PanelPad>
        {modal}
      </FeatureScreen>
    );
  }
  if (view === 'delivery') {
    return (
      <FeatureScreen title="Delivery Tracking" sub="Which channels each announcement went out on (simulated)." onBack={onBack}>
        <FeatureTable
          heads={['Announcement', 'Target', 'Delivery']}
          empty="No announcements yet."
          rows={announcements.map((a) => (
            <tr key={a.id}>
              <td>{a.title}</td>
              <td className="cell-muted">{a.target || '—'}</td>
              <td className="cell-muted">Email: Sent · WhatsApp: Sent</td>
            </tr>
          ))}
        />
      </FeatureScreen>
    );
  }
  if (view === 'archive') {
    return (
      <FeatureScreen title="Announcement Archive" sub="Every announcement ever posted." onBack={onBack}>
        <FeatureTable
          heads={['Date', 'Title', 'Category', 'Pinned']}
          empty="No announcements yet."
          rows={announcements.map((a) => (
            <tr key={a.id}>
              <td>{a.date || '—'}</td>
              <td>{a.title}</td>
              <td className="cell-muted">{a.category || 'General'}</td>
              <td className="cell-muted">{a.pinned ? 'Pinned' : '—'}</td>
            </tr>
          ))}
        />
      </FeatureScreen>
    );
  }

  return (
    <div>
      <QaRow style={{ marginBottom: 14 }}>{newButton}</QaRow>
      <TwoCol style={{ alignItems: 'start' }}>
        <PanelPad>
          <NumHead n={1} title="Notice Board" />
          {announcements.length === 0 ? <EmptyMini>No announcements posted.</EmptyMini> : announcements.map((a) => (
            <AssignRow key={a.id}>
              <span>
                {a.pinned && '📌 '}<b>{a.title}</b><br />
                <span className="cell-muted" style={{ fontSize: 11.5 }}>{a.body} · {a.target || ''} · {a.date || ''}</span>
              </span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className={`status ${a.category === 'Policy' ? 'pending' : 'active'}`}>{a.category || 'General'}</span>
                {isHR && <button className="btn btn-sm" onClick={() => togglePin(a)}>{a.pinned ? 'Unpin' : 'Pin'}</button>}
              </span>
            </AssignRow>
          ))}
        </PanelPad>
        <FeatureTiles features={AN_FEATURES} onOpen={onOpen} />
      </TwoCol>
      {modal}
    </div>
  );
}
