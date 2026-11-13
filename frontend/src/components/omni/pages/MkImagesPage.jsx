import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { getState } from '../omniStore.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Banner, Field, Tabs, Empty, ConfirmModal, GsModal, fmtDateTime } from '../ui.jsx';
import { MkStatus, MkImg, downloadMkImg } from '../marketing/mk.jsx';
import '../marketing/marketing.css';

// AI MARKETING > AI IMAGES: marketing pictures from a short description with Google Gemini, in the brand colours and with the logo when the model can.
// Every picture is saved here; it is used (calendar, posts) only after approval, and only approved pictures get a public link. Server: marketing/images.js.
const STYLE_WORDS = { photo: 'Photo', illustration: 'Illustration', graphic: 'Social graphic', poster: 'Minimal poster', '3d': '3D' };
const STARTERS = [
  { label: 'Hiring poster', prompt: 'A confident young professional at a modern office desk, smiling, ready for a new job', headline: 'We are hiring', style: 'photo' },
  { label: 'Walk-in drive', prompt: 'A friendly crowd of job seekers with folders waiting at a bright office reception for interviews', headline: 'Walk-in drive this Saturday', style: 'photo' },
  { label: 'Nurses', prompt: 'A caring Indian staff nurse in a clean hospital corridor, warm light', headline: 'Staff nurses wanted', style: 'photo' },
  { label: 'Job tip', prompt: 'A simple flat illustration of a resume, a checklist and a pen on a desk', headline: '3 resume tips', style: 'illustration' },
  { label: 'Festival greeting', prompt: 'Diyas and soft rangoli patterns in warm colours, festive and calm', headline: 'Happy Diwali', style: 'graphic' },
  { label: 'Team culture', prompt: 'A small diverse team celebrating together around a laptop in a sunny office', headline: '', style: 'photo' },
];

export default function MkImagesPage() {
  const { toast, go } = useOmni();
  const [meta, setMeta] = useState(null);
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const [f, setF] = useState({ prompt: '', headline: '', style: 'photo', aspect: '1:1', count: 2, useColors: true, withLogo: true });
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [tab, setTab] = useState('');
  const [view, setView] = useState(null); // the picture opened large
  const [del, setDel] = useState(null);
  const [rename, setRename] = useState(null);
  const [waitSec, setWaitSec] = useState(0);

  const load = useCallback(() => {
    setErr('');
    omni.get('/gs/marketing/images/meta').then(setMeta).catch((e) => setErr(errOf(e, 'AI Images could not be opened.')));
    omni.get('/gs/marketing/images').then((d) => setList(d.items || [])).catch((e) => setErr(errOf(e, 'The pictures could not be read.')));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (err && (!meta || !list)) return <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Try again</button></Banner>;
  if (!meta || !list) return <div className="card panel">Loading…</div>;

  const ai = meta.ai || {};
  const left = Math.max(0, (meta.perDay || 0) - (meta.usedToday || 0));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  // the server makes the pictures in the background (Google can take longer than the web server waits); this asks every 3 seconds until done
  const create = async () => {
    setBusy('create'); setMsg(''); setWaitSec(0);
    try {
      const r = await omni.post('/gs/marketing/images', { ...f, ...(getState().dept ? { department: getState().dept } : {}) });
      let job = r.job;
      const t0 = Date.now();
      while (job && job.status === 'running') {
        await new Promise((res) => { setTimeout(res, 3000); }); // eslint-disable-line no-await-in-loop
        setWaitSec(Math.round((Date.now() - t0) / 1000));
        if (Date.now() - t0 > 6 * 60000) { setMsg('This is taking very long. The pictures are saved in the list below as soon as Google sends them: look again in a minute.'); break; }
        try { job = (await omni.get(`/gs/marketing/images/jobs/${job.id}`)).job; } catch (e) { if (e.response && e.response.status === 404) { job = null; load(); break; } } // eslint-disable-line no-await-in-loop
      }
      if (job && job.status === 'done') { toast(`${job.items.length} picture${job.items.length === 1 ? '' : 's'} made${job.demo ? ' (sandbox samples)' : ''}`); if (job.note) setMsg(job.note); setTab(''); }
      if (job && job.status === 'failed') { setMsg(job.error || 'The pictures could not be made.'); toast(job.error || 'The pictures could not be made.'); }
      load();
    } catch (e) { const m = errOf(e, 'The pictures could not be made.'); setMsg(m); toast(m); load(); } finally { setBusy(''); }
  };
  const act = async (it, what) => {
    setBusy(it.id);
    try {
      if (what === 'submit') { const r = await omni.post(`/gs/marketing/images/${it.id}/submit`); toast(r.ok); }
      load();
    } catch (e) { toast(errOf(e, 'That did not work.')); } finally { setBusy(''); }
  };
  const remove = async () => { const it = del; setDel(null); try { await omni.del(`/gs/marketing/images/${it.id}`); toast('Deleted'); setView(null); load(); } catch (e) { toast(errOf(e, 'It could not be deleted.')); } };
  const saveName = async () => { try { await omni.put(`/gs/marketing/images/${rename.id}`, { title: rename.title }); toast('Renamed'); setRename(null); load(); } catch (e) { toast(errOf(e, 'It could not be renamed.')); } };
  const copyLink = async (it) => { const url = `${window.location.origin}${it.publicPath}`; try { await navigator.clipboard.writeText(url); toast('Public link copied'); } catch { window.prompt('Copy the public link:', url); } };
  const download = async (it) => { try { await downloadMkImg(it.id, it.title); } catch (e) { toast(errOf(e, 'It could not be downloaded.')); } };

  const shown = tab ? list.filter((i) => i.status === tab) : list;
  const cnt = (s) => list.filter((i) => i.status === s).length;
  const ratio = (a) => { const [w, h] = String(a || '1:1').split(':').map(Number); return `${w} / ${h}`; };

  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="AI Images" lead="Describe a picture; the AI makes it in your brand colours, with your logo. A picture is used only after it is approved." />
      {ai.demo ? <Banner tone="test"><b>Test sandbox.</b> No picture is asked from any AI service here: a plain sample in your brand colours is made instead.</Banner> : null}
      {!ai.ready ? <Banner tone="error"><b>AI pictures are not ready.</b> {ai.reason} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Check again</button></Banner> : null}
      {ai.ready && ai.note ? <Banner tone="warn">{ai.note}</Banner> : null}
      {msg ? <Banner tone="error">{msg}</Banner> : null}

      {meta.canWrite ? (
        <div className="mk-two">
          <Panel title="1 · Describe the picture" sub={ai.ready && !ai.demo ? `Model: ${ai.model} · ${left} of ${meta.perDay} pictures left today` : undefined}>
            <div className="mk-revise" style={{ marginBottom: 10 }}>
              <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 700 }}>START FROM:</span>
              {STARTERS.map((s) => <TinyBtn key={s.label} onClick={() => setF({ ...f, prompt: s.prompt, headline: s.headline, style: s.style })}>{s.label}</TinyBtn>)}
            </div>
            <div className="form-grid">
              <Field label="WHAT SHOULD IT SHOW?" full hint="People, place, mood. Plain words work best."><textarea style={{ minHeight: 90 }} value={f.prompt} maxLength={1000} onChange={set('prompt')} placeholder="A smiling Indian nurse in a bright hospital corridor" /></Field>
              <Field label="HEADLINE ON THE PICTURE (OPTIONAL)" full hint="Short is best. Leave empty for a picture without words."><input value={f.headline} maxLength={80} onChange={set('headline')} placeholder="Staff nurses wanted" /></Field>
              <Field label="STYLE"><select value={f.style} onChange={set('style')}>{meta.styles.map((s) => <option key={s} value={s}>{STYLE_WORDS[s] || s}</option>)}</select></Field>
              <Field label="SIZE"><select value={f.aspect} onChange={set('aspect')}>{meta.aspects.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}</select></Field>
              <Field label="HOW MANY"><select value={f.count} onChange={(e) => setF({ ...f, count: Number(e.target.value) })}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
              <Field label="BRAND" full>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11 }}>
                  <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={f.useColors} onChange={(e) => setF({ ...f, useColors: e.target.checked })} />Use the brand colours <span style={{ display: 'inline-flex', gap: 2 }}>{['primary', 'secondary', 'accent'].map((k) => <i key={k} style={{ width: 12, height: 12, borderRadius: 3, background: meta.colors[k], display: 'inline-block' }} />)}</span></label>
                  <label style={{ display: 'flex', gap: 5, alignItems: 'center', opacity: meta.hasLogo && ai.logoInput ? 1 : 0.55 }} title={!meta.hasLogo ? 'Upload a logo in Brand voice first' : !ai.logoInput ? 'This model cannot take the logo' : ''}><input type="checkbox" checked={f.withLogo && meta.hasLogo && !!ai.logoInput} disabled={!meta.hasLogo || !ai.logoInput} onChange={(e) => setF({ ...f, withLogo: e.target.checked })} />Put our logo on it</label>
                  {!meta.hasLogo ? <button type="button" className="link-btn" onClick={() => go('mkbrand')}>Upload a logo →</button> : null}
                </div>
              </Field>
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Btn primary disabled={busy === 'create' || !ai.ready || f.prompt.trim().length < 8 || (!ai.demo && left < f.count)} onClick={create}>{busy === 'create' ? `Making the pictures… ${waitSec ? `${waitSec}s` : ''}` : `✦ Make ${f.count} picture${f.count === 1 ? '' : 's'}`}</Btn>
              <span style={{ fontSize: 10, color: 'var(--muted)' }}>{!ai.ready ? 'Not ready: see the red note.' : f.prompt.trim().length < 8 ? 'Describe the picture in a sentence.' : !ai.demo && left < f.count ? `Only ${left} left today.` : busy === 'create' ? 'This can take up to a minute.' : 'Each picture counts against today’s limit.'}</span>
            </div>
          </Panel>
          <Panel title="How it works" sub="Nothing is posted from here.">
            <ol style={{ fontSize: 11.5, lineHeight: 1.8, margin: 0, paddingLeft: 18 }}>
              <li>Describe the picture, pick a size for where it will go.</li>
              <li>Keep the ones you like; delete the rest.</li>
              <li>Press <b>Ask for approval</b>. A Team Lead or an Admin approves it in <b>Approvals</b>.</li>
              <li>An approved picture can be downloaded, gets a public link, and can be picked in the <b>Content Calendar</b>.</li>
            </ol>
            <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 10 }}>Pictures are made by the AI service set in Administration &gt; Integrations ({ai.provider === 'cloudflare' ? 'Cloudflare Workers AI, free daily allowance' : ai.provider === 'gemini' ? 'Google Gemini' : 'none yet'}). Check every picture before you use it: AI can get hands, faces and spelling wrong.</div>
          </Panel>
        </div>
      ) : <Banner tone="info">You can look at the pictures of your department and approve them in Approvals. Only Marketing and Admins make pictures.</Banner>}

      <Panel title="Your pictures" sub="Newest first" style={{ marginTop: 14 }} right={<span className="pill live">{list.length}</span>}>
        <Tabs value={tab} onChange={setTab} tabs={[['', 'All', list.length], ['draft', 'Saved', cnt('draft')], ['waiting', 'Waiting', cnt('waiting')], ['changes', 'Changes needed', cnt('changes')], ['approved', 'Approved', cnt('approved')]]} />
        {shown.length === 0 ? <Empty title="No pictures here yet">{list.length ? 'Nothing with that status.' : 'Describe a picture above and press Make.'}</Empty> : (
          <div className="mki-grid">
            {shown.map((it) => (
              <div key={it.id} className="card mki-card">
                <div style={{ aspectRatio: ratio(it.aspect), overflow: 'hidden', borderRadius: 10, cursor: 'zoom-in' }}><MkImg id={it.id} alt={it.title} style={{ height: '100%' }} onClick={() => setView(it)} /></div>
                <b style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 8 }} title={it.title}>{it.title}</b>
                <div style={{ margin: '3px 0' }}><MkStatus status={it.status} /></div>
                <small style={{ color: 'var(--muted)', fontSize: 9.5 }}>{STYLE_WORDS[it.style] || it.style} · {it.aspect}{it.withLogo ? ' · logo' : ''}{it.demo ? ' · sample' : ''} · {fmtDateTime(it.createdAt)}{!it.mine ? ` · ${it.createdByName}` : ''}</small>
                {it.status === 'changes' && it.note ? <div className="mk-note">Sent back by {it.decidedByName}: {it.note}</div> : null}
                <div className="mk-acts" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  <TinyBtn onClick={() => download(it)}>⬇ Download</TinyBtn>
                  {it.canSubmit ? <TinyBtn disabled={busy === it.id} onClick={() => act(it, 'submit')}>Ask for approval</TinyBtn> : null}
                  {it.publicPath ? <TinyBtn onClick={() => copyLink(it)}>🔗 Copy link</TinyBtn> : null}
                  {it.canEdit ? <TinyBtn onClick={() => setRename({ id: it.id, title: it.title })} aria-label={`Rename ${it.title}`}>✎</TinyBtn> : null}
                  {it.canDelete ? <TinyBtn onClick={() => setDel(it)} aria-label={`Delete ${it.title}`}>🗑</TinyBtn> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {view ? (
        <GsModal title={view.title} sub={`${STYLE_WORDS[view.style] || view.style} · ${view.aspect}${view.model ? ` · ${view.model}` : ''}`} width={720} onClose={() => setView(null)}
          foot={<><Btn onClick={() => download(view)}>⬇ Download</Btn>{view.publicPath ? <Btn onClick={() => copyLink(view)}>🔗 Copy public link</Btn> : null}<Btn primary onClick={() => setView(null)}>Close</Btn></>}>
          <MkImg id={view.id} alt={view.title} style={{ maxHeight: '60vh', objectFit: 'contain', background: '#111' }} />
          <div style={{ fontSize: 11, marginTop: 8 }}><b>Asked for:</b> {view.prompt}{view.headline ? <> · <b>Headline:</b> “{view.headline}”</> : null}</div>
        </GsModal>
      ) : null}
      {rename ? (
        <GsModal title="Rename the picture" width={420} onClose={() => setRename(null)} foot={<><Btn onClick={() => setRename(null)}>Cancel</Btn><Btn primary disabled={!rename.title.trim()} onClick={saveName}>Save</Btn></>}>
          <Field label="NAME"><input autoFocus value={rename.title} maxLength={80} onChange={(e) => setRename({ ...rename, title: e.target.value })} /></Field>
        </GsModal>
      ) : null}
      {del ? <ConfirmModal danger title={`Delete "${del.title}"?`} text={del.status === 'approved' ? 'Its public link stops working and calendar posts that use it lose the picture.' : 'The picture is removed.'} yes="Delete" onNo={() => setDel(null)} onYes={remove} /> : null}
    </div>
  );
}
