import './reqsplit.css';

// The sites a job really has a posting on, as small chips (Jobs list "Posted on", and anywhere a short answer is enough).
//   list = [{ portal, name, state: posted | queued | needs_help | failed, words, url }]  (backend jobPublish/postedOn.js)
// "Posted" shows ONLY for a posting the site confirmed; a Posted chip is a link to the live job when there is one.
const ICON = { posted: '✔', queued: '⟳', needs_help: '!', failed: '✖', expiring: '!', expired: '✖' }; // expiring / expired: a post a person marked by hand (job distribution)

export default function PostedOnChips({ list = [], empty = 'Not posted yet' }) {
  if (!list || list.length === 0) return <span className="small-muted">{empty}</span>;
  return (
    <span className="po-chips" role="list">
      {list.map((p) => {
        const inner = (
          <>
            <span aria-hidden="true">{ICON[p.state] || '○'}</span>
            <span>{`${p.name}: ${p.words}`}</span>
          </>
        );
        return (
          <span role="listitem" key={p.portal}>
            {p.url
              ? <a className={`po-chip ${p.state}`} href={p.url} target="_blank" rel="noreferrer" title="Open the live requirement on the site" onClick={(e) => e.stopPropagation()}>{inner}</a>
              : <span className={`po-chip ${p.state}`} title={p.words}>{inner}</span>}
          </span>
        );
      })}
    </span>
  );
}
