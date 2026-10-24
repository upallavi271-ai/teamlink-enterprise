import { Btn, NotConnected, Empty } from '../ui.jsx';

// ---------------------------------------------------------------------------
// Analytics > Social Media Analytics: the real screen shell with an honest "No social account connected" state. The Social / Facebook / Instagram pages
// (another part of Omni-Channel) own the connection; until an account is connected there are no posts and no numbers, so NOTHING here is made up:
// every card shows "—" and every chart says why it is empty.
// ---------------------------------------------------------------------------
const KPIS = [['Total Reach', '📈', '#11985a'], ['Total Likes', '❤', '#de5c63'], ['Total Posts', '👁', '#4d7ddb'], ['Total Comments', '💬', '#ef9b35'], ['Total Engagement', '👥', '#7867d9']];
const CHARTS = [['📈', 'Reach & Engagement Over Time'], ['✨', 'Interaction Breakdown'], ['❤', 'Detailed Engagement Metrics'], ['👁', 'Reach Trend Analysis']];

export default function SocialTab({ go }) {
  return (
    <div>
      <div className="card panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 50, height: 50, borderRadius: 16, background: 'var(--green-3)', display: 'grid', placeItems: 'center', fontSize: 18, fontWeight: 900, color: 'var(--green-2)' }}>?</div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 900 }}>No social account connected</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#a9b4ae' }} /><span style={{ fontSize: 10, color: 'var(--muted)' }}>Facebook, Instagram, LinkedIn and others are not linked yet</span></div>
          </div>
        </div>
        <Btn primary onClick={() => go('social')}>Open Social Media</Btn>
      </div>
      <NotConnected name="Social media accounts" why="Analytics shows the reach, likes, comments and shares of your posts once an account is connected and posts were published from Omni-Channel. None of that exists yet, so no numbers are shown (and none are made up)."
        steps={['Open Social Media and choose an account to connect (Facebook, Instagram, LinkedIn ...).', 'An Admin saves the account keys; they are stored encrypted.', 'Publish a post from Social Media. Its numbers appear here after the platform reports them.']} />
      <div className="ov-social-kpis">
        {KPIS.map(([label, icon, color]) => (
          <div key={label} className="card metric an-metric" style={{ '--c': color }}><small>{label}</small><b style={{ fontSize: 20, color: 'var(--muted)' }}>—</b><span className="an-ico">{icon}</span></div>
        ))}
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 14, marginTop: 16 }}>
        {CHARTS.map(([icon, title]) => (
          <div className="card panel" key={title}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ fontSize: 14 }}>{icon}</span><b style={{ fontSize: 13 }}>{title}</b></div>
            <Empty title="No data yet">Connect an account and publish a post.</Empty>
          </div>
        ))}
      </div>
      <div className="card panel an-wide">
        <b style={{ fontSize: 14 }}>Post Performance</b>
        <div className="table-scroll" style={{ marginTop: 14 }}>
          <table className="table"><thead><tr><th>CONTENT</th><th>PLATFORM</th><th>VIEWS</th><th>LIKES</th><th>COMMENTS</th><th>FOLLOWERS</th><th>VISITS</th><th style={{ color: 'var(--accent)' }}>INTERACTIONS</th></tr></thead>
            <tbody><tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--muted)', padding: '26px 0' }}>No posts yet: connect an account and publish from Social Media to see performance here.</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
