import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { Banner, Btn, ConfirmModal, DataTable, Empty, PageHead, Pill, Tabs } from '../ui.jsx';
import { CHANNELS, CH_WORD, STATUS_TABS, PromptModal, n0, saveBlob } from './shared.jsx';

const NOT_CONNECTED = {
  rcs: ['RCS is planned', 'RCS (rich messages on the phone) is not connected yet. No RCS campaign can be made, so nothing is shown here. Nothing is faked.'],
  facebook: ['Facebook is not connected', 'Facebook campaigns need a connected Facebook Page. Connect it on the Facebook page of Omni-Channel; until then there is nothing to show here.'],
  instagram: ['Instagram is not connected', 'Instagram campaigns need a connected Instagram account. Connect it on the Instagram page of Omni-Channel; until then there is nothing to show here.'],
};
const SORTS = [['created', 'Newest first'], ['name', 'Name (A to Z)'], ['status', 'Status'], ['audience', 'Biggest audience'], ['sent', 'Most sent'], ['engagement', 'Best engagement'], ['conversions', 'Most conversions']];

// the All Campaigns page: channel tabs, status tabs, search, objective, the table and the row actions
export default function CampaignList({ onOpen, onAnalytics, onNew, onEdit }) {
  const { acc, go, toast, dept } = useOmni();
  const [sp, setSp] = useSearchParams();
  const [channel, setChannel] = useState(sp.get('channel') || 'all');
  const [status, setStatus] = useState(sp.get('status') || 'all');
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [objective, setObjective] = useState('all');
  const [sort, setSort] = useState('created');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [menu, setMenu] = useState('');
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async (quiet) => {
    const my = ++seq.current;
    if (!quiet) setLoading(true);
    try {
      const d = await omni.get('/gs/campaigns/list', { channel, status, q: qLive, objective, sort, dir: sort === 'name' ? 'asc' : 'desc', page, pageSize });
      if (my === seq.current) { setData(d); setErr(''); }
    } catch (e) { if (my === seq.current) setErr(errOf(e, 'The campaigns could not be loaded.')); } finally { if (my === seq.current) setLoading(false); }
  }, [channel, status, qLive, objective, sort, page, pageSize, dept]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setTimeout(() => { setQLive(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { const t = setInterval(() => load(true), 20000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (!menu) return undefined; const h = () => setMenu(''); window.addEventListener('click', h); return () => window.removeEventListener('click', h); }, [menu]);

  const pickChannel = (c) => { setChannel(c); setPage(1); const n = new URLSearchParams(sp); if (c === 'all') n.delete('channel'); else n.set('channel', c); setSp(n, { replace: true }); };
  const act = async (fn, okText) => { setBusy(true); try { const r = await fn(); toast(okText || r.ok || r.message || 'Done'); load(true); } catch (e) { toast(errOf(e, 'That did not work.')); } finally { setBusy(false); setDialog(null); } };
  const exportCsv = async () => {
    try {
      if (!data || !data.total) { toast('No campaigns to export with the current filters'); return; }
      saveBlob(await omni.blob('/gs/campaigns/export', { channel, status, q: qLive, objective, sort }), 'campaigns_export.csv'); toast('campaigns_export.csv downloaded');
    } catch (e) { toast(errOf(e, 'The file could not be made.')); }
  };
  const exportRow = async (r) => { try { saveBlob(await omni.blob(`/gs/campaigns/campaign/${r.key}/export.csv`), `${r.name.toLowerCase().replace(/\W+/g, '-')}.csv`); toast(`"${r.name}" exported`); } catch (e) { toast(errOf(e, 'The file could not be made.')); } };

  const edit = (r) => { if (r.can && r.can.edit) onEdit(r.key); else { onOpen(r.key); toast('This campaign was already sent, so its words cannot be changed. Use Duplicate to make a new one.'); } };
  const toggle = (r) => (r.can.pause ? act(() => omni.post(`/gs/campaigns/campaign/${r.key}/pause`), `"${r.name}" paused — nothing further will send`) : act(() => omni.post(`/gs/campaigns/campaign/${r.key}/resume`), `"${r.name}" resumed`));

  const cols = [
    { id: 'name', label: 'Campaign', render: (r) => <span className="campaign-name cmp-names">{r.name}{r.job && <span className="cmp-sub">{r.job.title}{r.job.reqCode ? ` · ${r.job.reqCode}` : ''}</span>}</span> },
    { id: 'objective', label: 'Objective', render: (r) => r.objective },
    { id: 'audience', label: 'Audience', render: (r) => (r.audience ? n0(r.audience) : '—') },
    { id: 'channels', label: 'Channels', render: (r) => <span title={r.channels.map((c) => c.words).join(' · ')}>{r.channels.map((c) => c.code).join(' · ')}</span> },
    { id: 'status', label: 'Status', render: (r) => <Pill tone={r.statusTone}>{r.statusWords}</Pill> },
    {
      id: 'sent', label: 'Sent / Failed',
      render: (r) => {
        const nm = r.numbers; const any = nm.sent + nm.failed > 0;
        const tip = `Delivered ${nm.delivered} · Read ${nm.read} · Replied ${nm.replied} · Clicked ${nm.clicked} · Applied ${nm.applied}${nm.toCall ? ` · To call ${nm.toCall}` : ''}`;
        if (!any) return <span style={{ color: 'var(--muted)' }} title={nm.toCall ? `${nm.toCall} calls waiting` : tip}>{nm.toCall ? `${nm.toCall} to call` : '—'}</span>;
        return <span title={tip}><span style={{ color: 'var(--green-2)', fontWeight: 800 }}>✓ {n0(nm.sent)}</span> <span style={{ color: 'var(--muted)' }}>|</span> <span style={{ color: 'var(--red)', fontWeight: 800 }}>✕ {n0(nm.failed)}</span>{r.rehearsal && <span className="cmp-test" title="Test mode: nothing was really sent">Test</span>}</span>;
      },
    },
    { id: 'engagement', label: 'Engagement', render: (r) => (r.engagement == null ? '—' : <span title="People who read, replied or clicked, out of those sent">{r.engagement}%</span>) },
    { id: 'conversions', label: 'Conversions', render: (r) => (r.conversions ? n0(r.conversions) : '—') },
    {
      id: 'action', label: 'Action',
      render: (r) => (
        <div className="row-acts" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="tiny-btn" title="View details" onClick={() => onAnalytics(r.key)}>👁</button>
          <button type="button" className="tiny-btn" title="Edit campaign" onClick={() => edit(r)}>✎</button>
          <button type="button" className="tiny-btn" title="Duplicate" disabled={!r.can.duplicate} onClick={() => setDialog({ type: 'dup', r })}>⧉</button>
          <button type="button" className="tiny-btn" title={r.can.resume ? 'Resume' : 'Pause'} disabled={!(r.can.pause || r.can.resume) || busy} onClick={() => toggle(r)}>{r.can.resume && !r.can.pause ? '▶' : '⏸'}</button>
          <div className="dropdown" style={{ display: 'inline-block', position: 'relative' }}>
            <button type="button" className="tiny-btn" title="More" onClick={(e) => { e.stopPropagation(); setMenu(menu === r.key ? '' : r.key); }}>⋯</button>
            {menu === r.key && (
              <div className="menu show" style={{ right: 0 }}>
                <button type="button" onClick={() => onAnalytics(r.key)}>Open analytics</button>
                <button type="button" onClick={() => onOpen(r.key)}>Open command center</button>
                <button type="button" onClick={() => exportRow(r)}>Export as CSV</button>
                {r.can.remove && <button type="button" className="danger" onClick={() => setDialog({ type: 'del', r })}>Delete campaign</button>}
              </div>
            )}
          </div>
        </div>
      ),
    },
  ];

  const tabs = STATUS_TABS.map(([id, label]) => [id, label, data ? data.tabs[id] : undefined]);
  const ncon = NOT_CONNECTED[channel];
  const mustWait = data && acc && acc.canApprove && data.approvalsWaiting > 0;
  return (
    <div>
      <PageHead eyebrow="Campaign history" title="All Campaigns" lead="History for this workspace, by channel.">
        <Btn onClick={exportCsv}>⬇ Export</Btn>
        <Btn onClick={() => { load(); toast('Campaigns refreshed'); }}>↻ Refresh</Btn>
        {data && data.canCreate && <Btn primary onClick={onNew}>＋ New Campaign</Btn>}
      </PageHead>
      {err && <Banner tone="error">{err}</Banner>}
      {data && data.testMode && <Banner tone="test"><b>Test mode is ON.</b> Campaigns here are rehearsals: everything is made and logged, but nothing is really sent to anybody.</Banner>}
      {mustWait && <Banner tone="info">{data.approvalsWaiting} {data.approvalsWaiting === 1 ? 'campaign is' : 'campaigns are'} waiting for your approval. <button type="button" className="link-btn" onClick={() => { setStatus('approval'); setPage(1); }}>Open them →</button></Banner>}
      <div className="console-tabs" style={{ marginBottom: 10 }} role="tablist">
        {CHANNELS.map((c) => {
          const active = channel === c.id;
          const count = data ? data.channelCounts[c.id] : 0;
          return <button key={c.id} type="button" role="tab" aria-selected={active} className="console-tab" style={active ? { color: c.color, borderColor: c.color, background: '#fff' } : undefined} onClick={() => pickChannel(c.id)}>{c.icon} {c.label} <b style={{ marginLeft: 4, opacity: 0.6 }}>{count}</b></button>;
        })}
      </div>
      <div className="toolbar" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
        <Tabs tabs={tabs} value={status} onChange={(v) => { setStatus(v); setPage(1); }} />
      </div>
      {ncon && (!data || data.channelCounts[channel] === 0)
        ? <div className="card panel"><Empty title={ncon[0]}>{ncon[1]}</Empty><div style={{ textAlign: 'center' }}>{channel !== 'rcs' && <Btn onClick={() => go(channel === 'facebook' ? 'fbchannel' : 'igchannel')}>{channel === 'facebook' ? 'Open the Facebook page' : 'Open the Instagram page'}</Btn>}</div></div>
        : (
          <DataTable
            columns={cols} rows={data ? data.rows : []} rowKey={(r) => r.key} onRow={(r) => onOpen(r.key)} persistKey="campaigns" loading={loading} searchPlaceholder="Search campaigns..."
            empty={data && data.channelCounts.all === 0 ? 'No campaigns yet. Press New Campaign to make the first one.' : 'No campaigns match these filters.'}
            pageSizes={[10, 20, 50]}
            server={{ total: data ? data.total : 0, page, pageSize, onPage: setPage, onPageSize: (n) => { setPageSize(n); setPage(1); }, query: q, onQuery: setQ }}
            toolbar={(
              <>
                <select className="select" aria-label="Objective" value={objective} onChange={(e) => { setObjective(e.target.value); setPage(1); }}>
                  <option value="all">All objectives</option>
                  {(data ? data.objectives : []).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                <select className="select" aria-label="Sort by" value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}>
                  {SORTS.map(([v, l]) => <option key={v} value={v}>Sort: {l}</option>)}
                </select>
              </>
            )}
          />
        )}
      {channel !== 'all' && !ncon && data && data.channelCounts[channel] === 0 && <p style={{ fontSize: 11, color: 'var(--muted)' }}>No {CH_WORD[channel]} campaign yet.</p>}
      {dialog && dialog.type === 'dup' && (
        <PromptModal title="Duplicate campaign" label="New campaign name" initial={`${dialog.r.name} copy`} okLabel="Duplicate" busy={busy}
          validate={(v) => (!v.trim() ? 'Give the campaign a name.' : '')} onCancel={() => setDialog(null)}
          onSubmit={(name) => act(() => omni.post(`/gs/campaigns/campaign/${dialog.r.key}/duplicate`, { name }), `"${name}" created as not sent yet`)} />
      )}
      {dialog && dialog.type === 'del' && (
        <ConfirmModal title={`Delete "${dialog.r.name}"?`} text="This campaign was never sent, so nobody was messaged. The campaign is removed." yes="Delete campaign" danger onNo={() => setDialog(null)}
          onYes={() => act(() => omni.del(`/gs/campaigns/campaign/${dialog.r.key}`), `"${dialog.r.name}" deleted`)} />
      )}
    </div>
  );
}
