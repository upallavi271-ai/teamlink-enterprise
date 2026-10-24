import { Panel, Kpis, Kpi, fmtNum, Banner } from '../ui.jsx';
import { monthWords } from './adminUtil.jsx';

// Billing > "Your credits": for EVERYBODY who uses Omni-Channel (not Finance). The credits you were given this month, what you used, what is left, per way
// (Email / WhatsApp / SMS / Call). Test-mode messages are shown apart: nobody got them and they never use credits.
export default function BillingMine({ mine }) {
  const low = mine.left !== null && mine.given > 0 && mine.left / mine.given <= 0.1;
  return (
    <>
      <Kpis>
        <Kpi label="Credits given" icon="✦" value={mine.given === null ? 'No limit' : fmtNum(mine.given)} meta={monthWords(mine.month)} />
        <Kpi label="Credits used" icon="⌁" value={fmtNum(mine.used)} meta="Real messages only" />
        <Kpi label="Credits left" icon="◉" value={mine.left === null ? 'No limit' : fmtNum(mine.left)} tone={low || mine.left === 0 ? 'down' : 'up'} meta={mine.left === null ? 'Your login has no monthly limit' : (mine.left === 0 ? 'Used up: ask an Admin for more' : (low ? 'Running low' : 'Resets next month'))} />
        <Kpi label="Test messages" icon="◌" value={fmtNum(mine.testMessages)} meta="Not sent to anybody, not charged" />
      </Kpis>
      <Panel title="Your credits" sub={`${mine.words} Every real message spends credits; a rehearsal in Test mode does not.`}>
        <div className="card table-card"><div className="table-scroll"><table className="table">
          <thead><tr><th>Way</th><th className="num">Messages sent</th><th className="num">Credits used</th><th className="num">Credits per message</th><th className="num">Test messages</th><th className="num">Did not go</th></tr></thead>
          <tbody>{mine.channels.map((c) => (
            <tr key={c.channel}><td><b>{c.word}</b></td><td className="num">{fmtNum(c.messages)}</td><td className="num">{fmtNum(c.credits)}</td><td className="num">{fmtNum(mine.cost[c.channel])}</td><td className="num">{fmtNum(c.testMessages)}</td><td className="num">{fmtNum(c.failed)}</td></tr>
          ))}</tbody>
        </table></div></div>
        <div className="adm-note">{mine.calls && mine.calls.recorded ? `Call minutes this month: ${fmtNum(mine.calls.minutes)}.` : 'Call minutes: Not recorded. A logged call costs no credits.'}</div>
        {mine.enforce ? <div className="adm-note">When your credits reach zero, real sending stops for you until an Admin gives you more.</div> : <div className="adm-note">Credits are counted but sending is not blocked (an Admin can turn blocking on).</div>}
      </Panel>
      {mine.exempt && <Banner tone="info">Admins and the logins an Admin chose have no limit. Your messages are still counted here.</Banner>}
    </>
  );
}
