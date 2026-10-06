// ---------------------------------------------------------------------------
// THE AGREEMENT TEXT, drawn like the user's Word document (2026-10-05):
// "Vendor Services Agreement" title, numbered bold section headings, a) b)
// clauses, the section 8 table with borders, the two-column signature block.
// It only DRAWS the text the server built (utils/vendorAgreement.js) — the
// same text the draft stores and the PDF prints. An older stored document
// (the 16-clause one) is shown as plain text, as before.
//
//   words   values to highlight (the live preview)
//   signer    the client's side   } { name, title, date, signNode, stampNode,
//   teamlink  TeamLink's side     }   waiting } — fills the signature block
//             once signed (never typed into the text). signNode / stampNode are
//             the real signature + stamp IMAGES (the same ones the PDF prints);
//             "waiting" says who has not signed yet ("Waiting for …").
// ---------------------------------------------------------------------------
import { useMemo } from 'react';
import './agreementLink.css';

const esc = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function Mark({ text, re, set }) {
  if (!re) return text;
  return String(text).split(re).map((p, i) => (set.has(p) ? <mark key={i}>{p}</mark> : p));
}

// Both sides of the signature block from an execution summary — the SAME
// facts the PDF prints (routes/agreementSeal.js executedSummary).
//   x   { company, clientSide, signedAt, teamlinkName, teamlinkTitle }
//   img (kind) => a React node showing that stored image
export function signersFrom(x, img) {
  const d = (v) => (v ? new Date(v).toLocaleDateString('en-GB').split('/').join('-') : '');
  const tl = (x && x.company) || {};
  const cl = (x && x.clientSide) || {};
  return {
    teamlink: {
      name: tl.signedBy || x.teamlinkName || '', title: x.teamlinkTitle || '', date: tl.hasSignature ? d(tl.sealedAt) : '',
      signNode: tl.hasSignature ? img('company-sign') : null, stampNode: tl.hasStamp ? img('company-stamp') : null,
      waiting: tl.hasSignature ? null : 'Waiting for TeamLink signature', waitingStamp: 'Waiting for TeamLink stamp',
    },
    signer: {
      name: cl.signedBy || '', title: cl.signedByTitle || '', date: x.signedAt ? d(x.signedAt) : '',
      signNode: cl.hasSignature ? img('client-sign') : (cl.esign ? <span className="agrd-esign">Digitally signed with Aadhaar eSign (eMudhra)</span> : null),
      stampNode: cl.hasStamp ? img('client-stamp') : null,
      waiting: cl.hasSignature || cl.esign ? null : 'Waiting for client signature', waitingStamp: 'Waiting for client stamp',
    },
  };
}

export const isVendorText = (t) => String(t || '').startsWith('Vendor Services Agreement');

export default function AgreementDocView({ text, words = [], signer = null, teamlink = null, className = '' }) {
  const { re, set } = useMemo(() => {
    const list = words.filter((w) => w && String(w).trim().length > 1);
    return {
      re: list.length ? new RegExp(`(${list.map(esc).sort((a, b) => b.length - a.length).join('|')})`, 'g') : null,
      set: new Set(list.map(String)),
    };
  }, [words]);
  const M = (t) => <Mark text={t} re={re} set={set} />;

  if (!isVendorText(text)) {
    return <div className={`agrd agrd-plain ${className}`}>{text ? M(text) : 'No agreement document yet.'}</div>;
  }
  const lines = String(text).split('\n');
  const out = [];
  let i = 0;
  let special = false;
  while (i < lines.length) {
    const t = lines[i].replace(/\s+$/, '');
    if (i === 0) { out.push(<h2 key="t" className="agrd-title">{t}</h2>); i += 1; continue; }
    if (!t) { i += 1; continue; }
    if (/^\|.*\|$/.test(t)) {
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { rows.push(lines[i].trim().slice(1, -1).split('|').map((c) => c.trim())); i += 1; }
      out.push(
        <table key={`tb${i}`} className="agrd-table">
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>{r.map((c, ci) => (ri === 0 ? <th key={ci}>{M(c)}</th> : <td key={ci}>{M(c)}</td>))}</tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    if (t.includes('\t')) {
      const rows = [];
      while (i < lines.length && lines[i].includes('\t')) { rows.push(lines[i].split('\t').map((c) => c.trim())); i += 1; }
      const fill = (cell, side) => {
        const m = cell.match(/^(Name|Designation|Sign|Date):\s*(.*)$/);
        if (!m) return { label: null, value: cell };
        let v = m[2];
        const who = side === 'right' ? signer : teamlink;
        if (!v && who) v = ({ Name: who.name, Designation: who.title, Sign: who.sign, Date: who.date })[m[1]] || '';
        if (m[1] === 'Sign' && who && who.signNode) return { label: 'Sign', node: who.signNode };
        if (m[1] === 'Sign' && !v && who && who.waiting) return { label: 'Sign', node: <span className="agrd-wait">{who.waiting}</span> };
        return { label: m[1], value: v };
      };
      const stampOf = (side) => {
        const who = side === 'right' ? signer : teamlink;
        if (!who) return null;
        if (who.stampNode) return who.stampNode;
        return <span className="agrd-wait">{who.waitingStamp || 'Stamp not added yet'}</span>;
      };
      out.push(
        <div key={`sg${i}`} className="agrd-sign">
          {['left', 'right'].map((side, si) => (
            <div key={side} className="agrd-sign-col">
              {rows.map((r, ri) => {
                if (ri === 0) return <div key={ri} className="agrd-sign-party">{M(r[si] || '')}</div>;
                const f = fill(r[si] || '', side);
                return (
                  <div key={ri} className="agrd-sign-row">
                    <b>{f.label ? `${f.label}:` : ''}</b>
                    {f.node ? <span className="agrd-img">{f.node}</span> : <span className={f.label === 'Sign' && f.value ? 'agrd-typed' : ''}>{f.value ? M(f.value) : ''}</span>}
                  </div>
                );
              })}
              {(signer || teamlink) && (
                <div className="agrd-sign-row">
                  <b>Stamp:</b>
                  <span className="agrd-img">{stampOf(side)}</span>
                </div>
              )}
            </div>
          ))}
        </div>,
      );
      continue;
    }
    const head = t.match(/^(\d+\.\s+[^:]+:)(.*)$/);
    if (head) {
      out.push(<p key={i} className="agrd-head"><b>{head[1]}</b>{head[2] ? M(head[2]) : null}</p>);
    } else if (/^[a-z]\.\s/.test(t)) {
      out.push(<p key={i} className="agrd-clause">{M(t)}</p>);
    } else if (t === 'Special terms:') {
      special = true;
      out.push(<p key={i} className="agrd-clause"><b>{t}</b></p>);
    } else if (special && !/^This Agreement has been executed/.test(t)) {
      out.push(<p key={i} className="agrd-clause">{M(t)}</p>);
    } else {
      special = false;
      out.push(<p key={i} className="agrd-para">{M(t)}</p>);
    }
    i += 1;
  }
  return <div className={`agrd ${className}`}>{out}</div>;
}
