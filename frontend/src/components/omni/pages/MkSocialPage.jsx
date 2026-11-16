import { useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, Panel, Pill, Banner, Empty } from '../ui.jsx';
import { useMkMeta } from '../marketing/mk.jsx';

// AI MARKETING > SOCIAL ACCOUNTS (2026-11-16, simple like Green Start): the Facebook Pages, Instagram accounts and X accounts connected for posting, and whether posting from TeamLink is
// allowed. Connecting or changing an account is done in Administration > Integrations > Social Media (an Admin); this screen only shows the state. Server: marketing/projects.js accounts().
const NAME = { facebook: 'Facebook', instagram: 'Instagram', x: 'X' };
export default function MkSocialPage() {
  const { go } = useOmni();
  const { meta } = useMkMeta();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = () => { setErr(''); omni.get('/gs/marketing/projects/accounts').then(setD).catch((e) => setErr(errOf(e, 'The social accounts could not be read.'))); };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (err && !d) return <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Try again</button></Banner>;
  if (!d) return <div className="card panel">Loading…</div>;
  const accounts = d.accounts || [];
  const isAdmin = !!(meta && meta.isAdmin);
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Social accounts" lead="The accounts your team can post to. A post is public, so each click asks you to confirm.">
        <Btn onClick={load}>Refresh</Btn>
        {isAdmin && <a className="btn btn-primary" href="/admin/integrations" target="_blank" rel="noopener noreferrer">Connect or change accounts ↗</a>}
      </PageHead>
      <Panel title="Posting from TeamLink" sub={d.allowed ? 'On: an approved project shows Facebook, Instagram and X buttons.' : 'Off: the team copies the words, downloads the file and posts by hand.'} right={isAdmin ? <Btn small onClick={() => go('mkusage')}>Change it (AI usage)</Btn> : <Pill tone={d.allowed ? 'live' : 'draft'} dot>{d.allowed ? 'On' : 'Off'}</Pill>} />
      <Panel title={`${accounts.length} connected account${accounts.length === 1 ? '' : 's'}`} style={{ marginTop: 14 }}>
        {accounts.length === 0 ? (
          <Empty title="No social account is connected yet">{isAdmin ? 'Press "Connect or change accounts" and add a Facebook Page, an Instagram account or an X account.' : 'Ask an Admin to connect a Facebook Page, an Instagram account or an X account (Administration > Integrations > Social Media).'}</Empty>
        ) : (
          <table className="mk-table"><thead><tr><th>ACCOUNT</th><th>WHERE</th><th>STATE</th></tr></thead>
            <tbody>{accounts.map((a) => (
              <tr key={a.id}>
                <td><b>{a.name}</b>{a.username ? <div style={{ fontSize: 11, color: 'var(--muted)' }}>@{String(a.username).replace(/^@/, '')}</div> : null}</td>
                <td>{NAME[a.platform] || a.platform}{a.parentName ? <div style={{ fontSize: 11, color: 'var(--muted)' }}>{a.parentName}</div> : null}</td>
                <td>{/connected|active|ok/i.test(String(a.status)) ? <Pill tone="live" dot>{a.status}</Pill> : <span title={a.error}><Pill tone="warn" dot>{a.status || 'Check it'}</Pill>{a.error ? <small> {a.error}</small> : null}</span>}</td>
              </tr>
            ))}</tbody></table>
        )}
      </Panel>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10 }}>LinkedIn and YouTube are not connected for posting from here yet.</div>
    </div>
  );
}
