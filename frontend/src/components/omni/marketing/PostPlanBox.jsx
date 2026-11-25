import { useEffect, useMemo, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Btn, GsModal, Banner, fmtDateTime } from '../ui.jsx';

// "POST AFTER THE CLIENT APPROVES" (AI Images): the team picks the connected accounts and checks the words (caption + hashtags, written from the banner's own words, never invented; the team can edit them).
// The client sees the exact picture, accounts and words on their private page and ticks their own permission; only then, and only for the version they approved, does TeamLink post (server: marketing/itemPlan.js).
// Nothing here asks for a username or password: the accounts are the ones an Admin connected (official sign-in) in Administration > Integrations > Social Media.
const WORD = { facebook: 'Facebook', instagram: 'Instagram', x: 'X' };
const ORDER = ['facebook', 'instagram', 'x'];

export function PostPlanBox({ item, toast, onChanged, onDirty }) {
  const [plan, setPlan] = useState(item.plan || null);
  const [acc, setAcc] = useState(null); // { allowed, accounts }
  const [on, setOn] = useState(!!item.plan);
  const [picked, setPicked] = useState((item.plan && item.plan.accounts ? item.plan.accounts : []).map((a) => a.accountId));
  const [caption, setCaption] = useState(item.plan ? item.plan.caption : '');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { omni.get('/gs/marketing/projects/accounts').then(setAcc).catch((e) => setErr(errOf(e, 'The connected accounts could not be read.'))); }, []);
  const accounts = useMemo(() => ((acc && acc.accounts) || []).filter((a) => a.status !== 'Removed').sort((a, b) => ORDER.indexOf(a.platform) - ORDER.indexOf(b.platform) || String(a.name).localeCompare(String(b.name))), [acc]);
  const same = plan && JSON.stringify([...picked].sort()) === JSON.stringify((plan.accounts || []).map((a) => a.accountId).sort()) && caption === plan.caption;
  const dirty = on && !same;
  useEffect(() => { if (onDirty) onDirty(dirty); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = accounts.filter((a) => picked.includes(a.id));
  const hasX = chosen.some((a) => a.platform === 'x');
  const toggle = (id) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const suggest = async () => {
    setBusy('suggest'); setErr('');
    try { const d = await omni.get(`/gs/marketing/images/${item.id}/post-plan/suggest`); setCaption(d.text || ''); } catch (e) { setErr(errOf(e, 'The words could not be written.')); } finally { setBusy(''); }
  };
  const turnOn = (v) => { setOn(v); setErr(''); if (v && !caption.trim() && !plan) suggest(); };
  const save = async () => {
    setBusy('save'); setErr('');
    try { const r = await omni.put(`/gs/marketing/images/${item.id}/post-plan`, { accountIds: picked, caption: caption.trim() }); setPlan(r.plan); setCaption(r.plan.caption); toast && toast('Saved: it will be posted only after the client approves and allows it'); onChanged && onChanged(); } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(''); }
  };
  const off = async () => {
    setBusy('off'); setErr('');
    try { await omni.del(`/gs/marketing/images/${item.id}/post-plan`); setPlan(null); setOn(false); setPicked([]); setCaption(''); toast && toast('It will not be posted by itself'); onChanged && onChanged(); } catch (e) { setErr(errOf(e, 'It could not be switched off.')); } finally { setBusy(''); }
  };
  const retry = async () => {
    setBusy('retry'); setErr('');
    try { const r = await omni.post(`/gs/marketing/images/${item.id}/post-plan/retry`, {}); if (r.plan) setPlan(r.plan); toast && toast(r.state === 'posted' ? 'Posted' : 'Tried again: see the result below'); onChanged && onChanged(); } catch (e) { setErr(errOf(e, 'It could not be tried again.')); } finally { setBusy(''); }
  };
  const locked = plan && ['posting', 'posted'].includes(plan.state);
  return (
    <div data-testid="post-plan" style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px', marginTop: 10 }}>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, fontWeight: 700 }}>
        <input type="checkbox" checked={on} disabled={!!locked || !!busy} onChange={(e) => (e.target.checked ? turnOn(true) : (plan ? off() : turnOn(false)))} style={{ marginTop: 2 }} />
        <span>Post it on the client's accounts after the client approves it</span>
      </label>
      <div style={{ fontSize: 11, color: 'var(--muted)', margin: '3px 0 0 24px' }}>The client sees the picture, the accounts and these exact words, and ticks their own permission. Nothing is posted without that tick, and only the version they approved is posted. TeamLink never asks for a username or password: it uses the accounts an Admin connected.</div>
      {err ? <div style={{ marginTop: 8 }}><Banner tone="error">{err}</Banner></div> : null}
      {on && acc && !acc.allowed ? <div style={{ marginTop: 8 }}><Banner tone="warn">Posting from TeamLink is switched off. An Admin switches it on in AI Marketing &gt; AI usage &gt; Posting to client accounts.</Banner></div> : null}
      {on && acc && acc.allowed && !accounts.length ? <div style={{ marginTop: 8 }}><Banner tone="warn">No Facebook Page, Instagram or X account is connected yet: connect the account first (Administration &gt; Integrations &gt; Social Media). Nothing posts until then.</Banner></div> : null}
      {on ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: '#166534', margin: '4px 0 6px' }}>POST ON</div>
          {accounts.map((a) => (
            <label key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, margin: '4px 0', opacity: a.status === 'Connected' ? 1 : 0.55 }}>
              <input type="checkbox" checked={picked.includes(a.id)} disabled={a.status !== 'Connected' || !!locked} onChange={() => toggle(a.id)} />
              <span><b>{a.name}</b> · {WORD[a.platform] || a.platform}{a.parentName ? ` · on ${a.parentName}` : ''}{a.status !== 'Connected' ? ` · ${a.status}: connect the account first` : ''}</span>
            </label>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 4px' }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: '#166534' }}>CAPTION AND HASHTAGS</span>
            <Btn small disabled={!!busy || !!locked} onClick={suggest} title="Writes the words from the banner's own words (heading, services, who it is for, website). Nothing is invented.">{busy === 'suggest' ? 'Writing…' : 'Write the words from the banner'}</Btn>
          </div>
          <textarea value={caption} maxLength={2200} disabled={!!locked} onChange={(e) => setCaption(e.target.value)} aria-label="The caption and hashtags to post" style={{ width: '100%', boxSizing: 'border-box', minHeight: 110, border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', font: 'inherit', fontSize: 12.5 }} />
          <div style={{ fontSize: 11, marginTop: 4, color: hasX && caption.trim().length > 280 ? '#b91c1c' : 'var(--muted)' }}>{caption.trim().length} characters{hasX ? ' · X allows 280' : ''} · written from the banner's own words: check them, you can change anything.</div>
          {plan && plan.consent && dirty ? <div style={{ marginTop: 6 }}><Banner tone="warn">The client already allowed the earlier words. If you save a change, that permission is cancelled and the client has to allow the new words.</Banner></div> : null}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Btn small primary disabled={!!busy || !!locked || !dirty || !picked.length || !caption.trim() || (hasX && caption.trim().length > 280) || !(acc && acc.allowed)} onClick={save}>{busy === 'save' ? 'Saving…' : (plan ? 'Save the change' : 'Save: post after the client approves')}</Btn>
            {plan && !locked ? <Btn small disabled={!!busy} onClick={off}>{busy === 'off' ? 'Switching off…' : 'Do not post by itself'}</Btn> : null}
          </div>
          {dirty ? <div style={{ fontSize: 11, color: '#92400e', marginTop: 6 }}>Not saved yet: press Save before you send it to the client, or the client will not be asked.</div> : null}
        </div>
      ) : null}
      {plan ? <PlanStatus plan={plan} busy={busy} retry={retry} /> : null}
    </div>
  );
}

// what happened with the plan: the state in plain words, the client's permission, and each account's result with the link
export function PlanStatus({ plan, busy = '', retry = null }) {
  const tone = { posted: '#166534', failed: '#b91c1c', blocked: '#b91c1c', consent: '#92400e', review: '#92400e' }[plan.state] || '#1d4fa8';
  return (
    <div data-testid="plan-status" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.55 }}>
      <b style={{ color: tone }}>{plan.label}</b>
      {!(plan.results || []).length && (plan.accounts || []).length ? <span style={{ color: 'var(--muted)' }}> · on {plan.accounts.map((a) => `${a.name} (${a.platformWord})`).join(', ')}</span> : null}
      {plan.state === 'armed' && !plan.switchOn ? <span style={{ color: '#92400e' }}> · posting from TeamLink is switched off by an Admin</span> : null}
      {plan.consent ? <span style={{ color: 'var(--muted)' }}> · the client ({plan.consent.by}) allowed it on {fmtDateTime(plan.consent.at)}</span> : null}
      {plan.reason ? <div style={{ color: '#b91c1c' }}>{plan.reason}</div> : null}
      {(plan.results || []).map((x, i) => <div key={`${x.name}${i}`}>{x.ok ? '✓' : '✗'} <b>{x.name}</b> ({x.platformWord}){x.ok && x.url ? <> · <a href={x.url} target="_blank" rel="noopener noreferrer">open the post</a></> : null}{!x.ok && x.error ? ` · ${x.error}` : ''}</div>)}
      {plan.canRetry && retry ? <div style={{ marginTop: 4 }}><Btn small primary disabled={!!busy} onClick={retry}>{busy === 'retry' ? 'Posting…' : 'Retry'}</Btn></div> : null}
    </div>
  );
}

export default function PostPlanModal({ item, onClose, onChanged, toast }) {
  return (
    <GsModal title={`Post after the client approves: ${item.title}`} sub="Set the accounts and the words now. The client reads them and ticks their own permission before anything is posted." width={600} onClose={onClose} foot={<Btn onClick={onClose}>Close</Btn>}>
      <PostPlanBox item={item} toast={toast} onChanged={onChanged} />
    </GsModal>
  );
}
