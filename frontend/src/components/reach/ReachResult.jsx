import './reach.css';

// The result summary of a bulk contact: one tile per plain status word (Sent, Not connected,
// No consent, No phone, Duplicate, Skipped …) and the people behind each, so nobody has to guess.
// people: [{ name, code, word, tone, reason }]  ·  extra: [{ code, word, tone, count }] for rows not in `people`
const ORDER = ['sent', 'opened', 'answered', 'ok', 'not_connected', 'skipped_by_you', 'failed', 'no_consent', 'no_phone', 'no_email', 'duplicate', 'limit', 'quiet', 'opted_out', 'switch_off', 'test', 'outside', 'skipped'];

export default function ReachResult({ people, extra = [], headline }) {
  const groups = new Map();
  (people || []).forEach((p) => {
    if (!groups.has(p.code)) groups.set(p.code, { code: p.code, word: p.word, tone: p.tone, people: [], count: 0 });
    const g = groups.get(p.code); g.people.push(p); g.count += 1;
  });
  extra.forEach((x) => {
    if (!x.count) return;
    const g = groups.get(x.code) || { code: x.code, word: x.word, tone: x.tone, people: [], count: 0 };
    g.count += x.count; groups.set(x.code, g);
  });
  const list = [...groups.values()].sort((a, b) => (ORDER.indexOf(a.code) + 100) % 100 - (ORDER.indexOf(b.code) + 100) % 100);
  return (
    <div className="rch-result">
      {headline && <div className="rch-headline">{headline}</div>}
      <div className="rch-tiles">
        {list.map((g) => (
          <div key={g.code} className={`rch-tile is-${g.tone || 'orange'}`}>
            <b>{g.count}</b>
            <span>{g.word}</span>
          </div>
        ))}
      </div>
      {list.filter((g) => g.people.length > 0 && !['sent', 'opened', 'answered'].includes(g.code)).map((g) => (
        <details key={g.code} className="rch-det" open={list.length <= 3}>
          <summary><span className={`rch-pill is-${g.tone || 'orange'}`}>{g.word}</span> {g.count} {g.count === 1 ? 'person' : 'people'}</summary>
          <ul>
            {g.people.map((p, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <li key={i}><b>{p.name}</b>{p.reason ? <span className="small-muted"> — {p.reason}</span> : null}</li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
