import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Notice, Section, useLoad, Pills } from '../kit.jsx';
import { t } from '../../../i18n.jsx';

// ---------------------------------------------------------------------------
// ATS settings -> Integrations -> App catalogue (14.03, ATS wave 2 Z). Every built-in connector of the ATS with its LIVE status and a
// "Set up" link to where it is switched on. Nothing is installed: each app is already in TeamLink and needs only its keys or switch.
// Backend: GET /api/ats-plus/apps (utils/atsPlus/appsZ.js).
// ---------------------------------------------------------------------------
const TONE_STYLE = {
  green: { background: '#e7f6ec', color: '#1d6b3d' }, blue: { background: '#e8f0fe', color: '#1a4fb4' },
  amber: { background: '#fff4e0', color: '#8a5300' }, grey: { background: '#f1f3f5', color: '#4b5563' },
};
export default function AppCatalogueZ() {
  const { data, err } = useLoad('/ats-plus/apps');
  const [cat, setCat] = useState('all');
  const [q, setQ] = useState('');
  const shown = useMemo(() => (data ? data.apps.filter((a) => (cat === 'all' || a.category === cat) && (!q || `${a.name} ${a.what}`.toLowerCase().includes(q.toLowerCase()))) : []), [data, cat, q]);
  return (
    <Section title={t('App catalogue')} note="Every app that comes with the TeamLink ATS, with its real status today. Nothing to install: an app is switched on where its Set up link goes. Apps marked 'needs founder account' need an outside account (partner, vendor or Google / Microsoft app) that only the founder can open.">
      <Notice tone="red">{err}</Notice>
      {data && (
        <>
          <div className="small-muted" style={{ marginBottom: 6 }} data-testid="apps-counts">{data.total} apps · {Object.entries(data.counts).map(([k, n]) => `${t(k)} ${n}`).join(' · ')}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="search" aria-label="Find an app" placeholder={t('Find an app')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Pills value={cat} onChange={setCat} options={[['all', t('All')], ...data.categories.map((c) => [c, c])]} />
          <div className="apps-z-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
            {shown.map((a) => (
              <div key={a.id} className="card" data-testid="app-card" data-app={a.id} style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                  <b style={{ flex: 1 }}>{a.name}</b>
                  <span className="status" style={{ ...TONE_STYLE[a.tone], borderRadius: 999, padding: '1px 8px', fontSize: 12, whiteSpace: 'nowrap' }}>{t(a.status)}</span>
                </div>
                <div className="small-muted">{a.what}</div>
                {a.detail && <div className="small-muted" style={{ fontSize: 12 }}>{a.detail}</div>}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 'auto' }}>
                  <span className="small-muted" style={{ fontSize: 12, flex: 1 }}>{a.category}{a.needsFounder ? ` · ${t('needs founder account')}` : ''}</span>
                  {a.setUpLink && <Link className="btn btn-sm" to={a.setUpLink}>{t('Set up')}</Link>}
                </div>
              </div>
            ))}
          </div>
          {!shown.length && <div className="small-muted">No app matches.</div>}
        </>
      )}
    </Section>
  );
}
