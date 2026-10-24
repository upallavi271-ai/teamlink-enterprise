import TemplateLibrary from '../TemplateLibrary.jsx';

// "My job templates" under the job post preview: pick a saved text to fill the tabs (rename / update / delete too),
// or save the texts now on screen. Shared list: components/jobs/TemplateLibrary.jsx.
export default function MyJobTemplates({ live, jobTitle = '' }) {
  return (
    <details className="rsp-lib">
      <summary>My job templates</summary>
      <div style={{ fontSize: 12, color: '#5b6b85', margin: '4px 0' }}>Also managed in Omni-Channel &gt; Templates.</div>
      <TemplateLibrary texts={live.data ? live.texts : null} jobTitle={jobTitle} onUse={(t) => live.setMany(t.texts || {})} />
    </details>
  );
}
