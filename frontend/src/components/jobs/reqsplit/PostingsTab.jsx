import { useCallback, useEffect, useState } from 'react';
import api from '../../../api';
import StatusChip from '../../ui/StatusChip.jsx';
import PostStepDialog from './PostStepDialog.jsx';
import { Logo, JobFieldsPanel } from './PostScreens.jsx';
import { cardState, cardOf, tableStatus } from './postWizard.js';
import './reqsplit.css';

// ---------------------------------------------------------------------------
// THE "POSTINGS" TAB of a saved job (founder's diagram "Manual Job Posting to Naukri / Shine", 2026-10-16). It merges into the old
// Distribute tab: this card is on top, the older copy-and-post cards stay below ("Others").
//   * one big button per portal -> the same Post screens (Naukri keeps "then open Shine"); TeamLink never signs in or posts for you
//   * Post Status table, one honest word per portal: Not Posted / Pending / Posted / Posted (by hand) / Failed (+ the plain reason, Retry)
//   * the job's details as copy-ready parts + Copy all + Download JD, to paste into the portal's own Post-a-Job form
// No second source of truth: the words come from the posting-sites rows, the post-status chips and the Naukri->Shine flow rows.
// <PostingsTab job={requirement} canPost onChanged>{the older cards}</PostingsTab>
// ---------------------------------------------------------------------------
const PORTALS = ['naukri', 'shine', 'indeed', 'linkedin'];
// Social media (2026-10-31): TeamLink posts these itself, through the accounts an Admin connected in Integrations > Social Media
const SOCIAL = [['facebook', 'Facebook'], ['instagram', 'Instagram'], ['linkedinpost', 'LinkedIn post'], ['threads', 'Threads']];
const BTN = { post: 'Post', continue: 'Continue', retry: 'Retry', view: 'Open again' };

export default function PostingsTab({ job, canPost, onChanged, children }) {
  const [sites, setSites] = useState([]);
  const [chips, setChips] = useState([]);
  const [flow, setFlow] = useState(null);
  const [dlg, setDlg] = useState(null); // { targets }
  const [panel, setPanel] = useState('naukri');

  const load = useCallback(async () => {
    const [a, b, c] = await Promise.all([
      api.get(`/requirements/${job.id}/posting-sites`).then((r) => r.data.sites || []).catch(() => null),
      api.get(`/job-broadcast/jobs/${job.id}/post-status`).then((r) => r.data.chips || []).catch(() => null),
      api.get(`/job-flow/jobs/${job.id}`).then((r) => r.data).catch(() => null),
    ]);
    if (a) setSites(a);
    if (b) setChips(b);
    if (c) setFlow(c);
  }, [job.id]);
  useEffect(() => { load(); }, [load]);

  const rows = PORTALS.map((id) => {
    const state = cardState(id, { site: sites.find((s) => s.id === id) || null, chip: chips.find((c) => c.place === id) || null, flow });
    return { id, name: (cardOf(id) || {}).name || id, state, t: tableStatus(state) };
  });
  const socialRows = SOCIAL.map(([id, name]) => {
    const state = cardState(id, { chip: chips.find((c) => c.place === id) || null });
    return { id, name, state, t: tableStatus(state) };
  });
  const pending = [...rows, ...socialRows].some((r) => r.t.word === 'Pending');
  useEffect(() => {
    if (!pending || dlg) return undefined;
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [pending, dlg, load]);

  const open = (targets) => { if (PORTALS.includes(targets[0])) setPanel(targets[0]); setDlg({ targets }); }; // the details panel is for the four job sites only
  const goOthers = () => { const el = document.getElementById('pt-others'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  return (
    <div className="pt">
      <div className="pw-card">
        <h3 className="pw-h1">Post Job on External Portals</h3>
        <p className="pw-sub">Naukri, Shine, Indeed and LinkedIn are posted by you: you sign in and press Post on the site yourself. TeamLink never signs in or posts to them for you. Facebook, Instagram, LinkedIn post and Threads are below: those TeamLink posts for you.</p>
        {!canPost && <div className="ps-hint">You can see where this requirement is posted. Posting is done by your team lead or the client manager.</div>}
        <div className="pt-btns" role="group" aria-label="Post on a portal">
          {rows.map((r) => (
            <button type="button" key={r.id} className="pt-big" disabled={!canPost} onClick={() => open([r.id])} aria-label={`Post on ${r.name}`}>
              <Logo id={r.id} /><span className="pw-tname">{r.name}</span>
            </button>
          ))}
          <button type="button" className="pt-big" onClick={goOthers} aria-label="Other places"><span className="pw-logo pw-lg-web">+</span><span className="pw-tname">Others</span></button>
        </div>
        <div className="pt-social">
          <h4 className="pt-social-h">Post on social media <small>(TeamLink posts it for you on your connected pages)</small></h4>
          <div className="pt-btns pt-4" role="group" aria-label="Post on social media">
            {socialRows.map((r) => (
              <button type="button" key={r.id} className="pt-big" disabled={!canPost} onClick={() => open([r.id])} aria-label={`Post on ${r.name}`}>
                <Logo id={r.id} /><span className="pw-tname">{r.name}</span>
              </button>
            ))}
          </div>
        </div>

        <h4 className="pw-h2">Post Status</h4>
        <div className="pt-table" role="table" aria-label="Post status">
          <div className="pt-tr pt-th" role="row"><span role="columnheader">Portal</span><span role="columnheader">Status</span><span role="columnheader">Details</span><span role="columnheader" /></div>
          {rows.map((r) => (
            <div className="pt-tr" role="row" key={r.id}>
              <span role="cell"><b>{r.name}</b></span>
              <span role="cell"><StatusChip tone={r.t.tone}>{r.t.word}</StatusChip></span>
              <span role="cell" className="ps-hint">{r.t.reason}{r.state.link && <> <a href={r.state.link} target="_blank" rel="noreferrer">View requirement</a></>}</span>
              <span role="cell">{canPost && <button type="button" className={`btn btn-sm${r.t.action === 'retry' || r.t.action === 'post' ? ' btn-primary' : ''}`} onClick={() => open([r.id])}>{BTN[r.t.action]}</button>}</span>
            </div>
          ))}
          {socialRows.map((r) => (
            <div className="pt-tr" role="row" key={r.id}>
              <span role="cell"><b>{r.name}</b></span>
              <span role="cell"><StatusChip tone={r.t.tone}>{r.t.word}</StatusChip></span>
              <span role="cell" className="ps-hint">{r.t.reason}{r.state.link && <> <a href={r.state.link} target="_blank" rel="noreferrer">View post</a></>}</span>
              <span role="cell">{canPost && <button type="button" className={`btn btn-sm${r.t.action === 'retry' || r.t.action === 'post' ? ' btn-primary' : ''}`} onClick={() => open([r.id])}>{BTN[r.t.action]}</button>}</span>
            </div>
          ))}
          <div className="pt-tr" role="row"><span role="cell"><b>Others</b></span><span role="cell" /><span role="cell" className="ps-hint">Foundit, Apna, WhatsApp and other places are in the list below.</span><span role="cell"><button type="button" className="btn btn-sm" onClick={goOthers}>See list</button></span></div>
        </div>
        <div className="ps-hint">Posted (by hand) means you pressed that you posted it. TeamLink cannot look inside Naukri, Shine, Indeed or LinkedIn.</div>

        <div className="pw-handbtns">
          {PORTALS.map((id) => <button type="button" key={id} className={`rsp-tab${panel === id ? ' on' : ''}`} onClick={() => setPanel(id)}>{`Details for ${(cardOf(id) || {}).name}`}</button>)}
        </div>
        <JobFieldsPanel key={panel} jobId={job.id} board={panel} fallbackJob={job} />
      </div>

      <div id="pt-others">{children}</div>
      {dlg && (
        <PostStepDialog
          job={job}
          sources={String(job.postingSources || '').split(',').map((x) => x.trim()).filter(Boolean)}
          startTargets={dlg.targets}
          onClose={() => { setDlg(null); load(); }}
          onChanged={() => { load(); if (onChanged) onChanged(); }}
        />
      )}
    </div>
  );
}
