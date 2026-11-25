import { useEffect, useState } from 'react';
import api from '../../api';
import PasswordAlertSetting from '../../components/PasswordAlertSetting.jsx';

// Company Setup — the prototype's companySetupView() (line 9693), field for
// field: a two-column screen with Company Information and Employment Policies
// on the left, Departments, Working Locations and Teams on the right.

// LETTER SIGNATORY (2026-11-25): the CEO / authorised signatory on every TeamLink letter. Set once here; every letter uses it.
function LetterSignatoryCard() {
  const [sig, setSig] = useState(null);
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [picture, setPicture] = useState(null); // a new picture, as a data URL
  const [removePicture, setRemovePicture] = useState(false);
  const [preview, setPreview] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  function apply(s) {
    setSig(s); setName(s.name || ''); setTitle(s.title || ''); setPicture(null); setRemovePicture(false);
  }
  useEffect(() => {
    api.get('/admin/letter-signatory').then((r) => apply(r.data)).catch(() => setErr('Could not load the letter signatory.'));
  }, []);
  useEffect(() => {
    if (!sig || !sig.hasSignature) { setPreview(''); return undefined; }
    let url = '';
    api.get('/admin/letter-signatory/picture', { responseType: 'blob' })
      .then((r) => { url = URL.createObjectURL(r.data); setPreview(url); })
      .catch(() => setPreview(''));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [sig && sig.signatureUpdatedAt, sig && sig.hasSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  function chooseFile(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!/^image\/(png|jpeg)$/.test(f.type)) { setErr('Choose a PNG or JPEG picture of the signature.'); return; }
    if (f.size > 300 * 1024) { setErr('The signature picture is larger than 300 KB. Use a smaller picture.'); return; }
    const reader = new FileReader();
    reader.onload = () => { setPicture(String(reader.result)); setRemovePicture(false); setErr(''); };
    reader.readAsDataURL(f);
  }

  async function save() {
    setBusy(true); setErr(''); setMsg('');
    try {
      const body = { name: name.trim(), title: title.trim() };
      if (picture) body.signatureDataUrl = picture;
      else if (removePicture) body.signatureDataUrl = '';
      const r = await api.put('/admin/letter-signatory', body);
      apply(r.data);
      setMsg('Saved. Every letter uses this signature from now on.');
    } catch (e) {
      setErr(e.response?.data?.error || 'That could not be saved.');
    } finally { setBusy(false); }
  }

  return (
    <div className="card section">
      <h3 style={{ fontSize: 14, marginBottom: 6 }}>Letter signatory</h3>
      <div className="small-muted" style={{ marginBottom: 10 }}>
        The person who signs every TeamLink letter (offer, relieving and service letters). Set it once; it is the same for everyone.
      </div>
      {err && <div className="error-text" style={{ marginBottom: 8 }}>{err}</div>}
      {msg && <div className="notice" style={{ marginBottom: 8 }}>{msg}</div>}
      <div className="grid-2">
        <div className="field"><label>Name</label>
          <input type="text" value={name} placeholder="e.g. the CEO's name" onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label>Title</label>
          <input type="text" value={title} placeholder="e.g. Chief Executive Officer" onChange={(e) => setTitle(e.target.value)} /></div>
      </div>
      <div className="field"><label>Signature picture <span className="small-muted">(PNG or JPEG, up to 300 KB; a PNG with a transparent background looks best)</span></label>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {picture || (preview && !removePicture) ? (
            <img alt="Signature" src={picture || preview} style={{ height: 52, border: '1px solid var(--line, #d9dce1)', borderRadius: 4, background: '#fff', padding: 4 }} />
          ) : <span className="small-muted">No signature picture yet.</span>}
          <input type="file" accept="image/png,image/jpeg" onChange={chooseFile} />
          {(sig && sig.hasSignature && !removePicture && !picture) && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRemovePicture(true)}>Remove picture</button>
          )}
          {removePicture && <span className="small-muted">The picture will be removed when you save.</span>}
        </div>
      </div>
      <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save signatory'}</button>
      {sig && sig.updatedByName && <div className="small-muted" style={{ marginTop: 8 }}>Last saved by {sig.updatedByName}.</div>}
    </div>
  );
}

export default function CompanySetup() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', hq: '', address: '' });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  function apply(res) {
    setData(res);
    setForm({
      name: res.name || '', email: res.email || '', phone: res.phone || '',
      hq: res.hq || '', address: res.address || '',
    });
  }

  useEffect(() => {
    api.get('/admin/company').then((res) => apply(res.data)).catch(() => setError('Could not load the company profile.'));
  }, []);

  async function save() {
    setError(''); setNotice('');
    try {
      const res = await api.put('/admin/company', form);
      apply(res.data);
      setNotice('Company information saved.');
    } catch (err) {
      setError(err.response?.data?.error || 'That change could not be saved.');
    }
  }

  if (!data) return <div className="page-head"><h1>Company Setup</h1></div>;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div>
      <div className="page-head">
        <div><h1>Company Setup</h1>
          <div className="page-sub">Company profile, departments, locations and working teams</div></div>
      </div>

      {error && <div className="error-text">{error}</div>}
      {notice && <div className="notice" style={{ marginBottom: 12 }}>{notice}</div>}

      <div className="two-col">
        <div>
          <div className="card section">
            <h3 style={{ fontSize: 14, marginBottom: 12 }}>Company Information</h3>
            <div className="grid-2">
              <div className="field"><label>Company Name</label>
                <input type="text" value={form.name} onChange={(e) => set({ name: e.target.value })} /></div>
              <div className="field"><label>Contact Email</label>
                <input type="text" value={form.email} onChange={(e) => set({ email: e.target.value })} /></div>
              <div className="field"><label>Contact Phone</label>
                <input type="text" value={form.phone} onChange={(e) => set({ phone: e.target.value })} /></div>
              <div className="field"><label>Headquarters</label>
                <input type="text" value={form.hq} onChange={(e) => set({ hq: e.target.value })} /></div>
            </div>
            <div className="field"><label>Address</label>
              <textarea rows="2" value={form.address} onChange={(e) => set({ address: e.target.value })} /></div>
            <button className="btn btn-primary btn-sm" onClick={save}>Save Company Info</button>
          </div>
          <LetterSignatoryCard />
          <PasswordAlertSetting />
          <div className="card">
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>Employment Policies</h3>
            {data.policies.map((p) => (
              <div className="kv" key={p}><span className="k">{p}</span><span className="status active">Active</span></div>
            ))}
          </div>
        </div>
        <div>
          <div className="card section">
            <h3 style={{ fontSize: 13, marginBottom: 10 }}>Departments</h3>
            {data.departments.map((d) => <span className="skillpill" key={d}>{d}</span>)}
            <div className="small-muted" style={{ marginTop: 8 }}>
              Departments are shared across HRMS and ATS requirement creation.
            </div>
          </div>
          <div className="card section">
            <h3 style={{ fontSize: 13, marginBottom: 10 }}>Working Locations</h3>
            {data.locations.map((l) => <span className="skillpill" key={l}>{l}</span>)}
          </div>
          <div className="card">
            <h3 style={{ fontSize: 13, marginBottom: 10 }}>Teams</h3>
            {/* Real teams from the Departments & Teams admin, not a fixed list. */}
            {data.teams.map((t) => (
              <div className="kv" key={`${t.department}/${t.name}`}>
                <span className="k">{t.name}</span><span>{t.department}</span>
              </div>
            ))}
            {data.teams.length === 0 && <div className="empty-mini">No teams yet — add them under Departments &amp; Teams.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
