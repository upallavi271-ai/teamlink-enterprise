import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn } from '../ui.jsx';
import TemplateNav from '../templates/TemplateNav.jsx';
import TemplateList, { MetaReviewModal } from '../templates/TemplateList.jsx';
import TemplateForm from '../templates/TemplateForm.jsx';
import VoiceForm from '../templates/VoiceForm.jsx';
import FlowEditor from '../templates/FlowEditor.jsx';
import RcsGallery, { RcsCreateModal } from '../templates/RcsGallery.jsx';
import RcsEditor from '../templates/RcsEditor.jsx';
import RcsWizard from '../templates/RcsWizard.jsx';
import { PromptModal, useDebounced } from '../templates/tplCommon.jsx';
import '../templates/templates.css';

// MANAGE TEMPLATES (the prototype's Templates page): a nested tree on the left (WhatsApp / SMS / RCS / Voice / Email, accounts with counts, Flows), the list of templates,
// and the create / view / edit form. WhatsApp / SMS / Email templates are the template hub (nothing is copied); RCS, Flows and voice scripts are saved in their own tables.
// Nothing is sent from here. WhatsApp "approved" is only ever what Meta said or what an Admin recorded.
export default function TemplatesPage() {
  const { toast } = useOmni();
  const [params] = useSearchParams();
  const [meta, setMeta] = useState(null);
  const [tree, setTree] = useState(null);
  const startCh = ['whatsapp', 'sms', 'email', 'voice', 'rcs'].includes(params.get('channel')) ? params.get('channel') : 'whatsapp';
  const [sel, setSel] = useState({ group: startCh, account: startCh === 'rcs' ? '' : startCh, view: 'list', flowId: null });
  const [where, setWhere] = useState('Omni-Channel');
  const [q, setQ] = useState('');
  const [approval, setApproval] = useState('');
  const [list, setList] = useState({ items: [], total: 0, queue: null });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(null); // { item|null, mode }
  const [review, setReview] = useState(null);
  const [rcsTpls, setRcsTpls] = useState([]);
  const [rcsForm, setRcsForm] = useState(null); // { template, mode }
  const [rcsCreate, setRcsCreate] = useState(false);
  const [wizard, setWizard] = useState(false);
  const [flowPrompt, setFlowPrompt] = useState(false);
  const dq = useDebounced(q, 250);

  const loadTree = useCallback(() => omni.get('/gs/templates/tree', { where }).then(setTree).catch((e) => setErr(errOf(e, 'The templates could not be read.'))), [where]);
  useEffect(() => { omni.get('/gs/templates/meta').then(setMeta).catch(() => {}); }, []);
  useEffect(() => { loadTree(); }, [loadTree]);
  useEffect(() => { // first RCS assistant is selected by itself when RCS is chosen from the address
    if (tree && sel.group === 'rcs' && !sel.account) { const a = tree.groups.find((g) => g.key === 'rcs').families[0].accounts[0]; if (a) setSel((s) => ({ ...s, account: a.id })); }
  }, [tree, sel.group, sel.account]);

  const isRcs = sel.group === 'rcs';
  const loadList = useCallback(async () => {
    if (isRcs || sel.view !== 'list') return;
    setLoading(true);
    try { setList(await omni.get('/gs/templates/list', { channel: sel.group, where, q: dq || undefined, approval: approval || undefined })); setErr(''); } catch (e) { setErr(errOf(e, 'The templates could not be read.')); } finally { setLoading(false); }
  }, [isRcs, sel.group, sel.view, where, dq, approval]);
  useEffect(() => { loadList(); }, [loadList]);
  const loadRcs = useCallback(async () => {
    if (!isRcs || !sel.account) { setRcsTpls([]); return; }
    setLoading(true);
    try { setRcsTpls((await omni.get('/gs/templates/rcs/templates', { agentId: sel.account })).templates); setErr(''); } catch (e) { setErr(errOf(e, 'The RCS templates could not be read.')); } finally { setLoading(false); }
  }, [isRcs, sel.account]);
  useEffect(() => { loadRcs(); }, [loadRcs]);

  // "?create=1" from another page (the Console) opens the new-template form of that channel
  useEffect(() => { if (params.get('create') === '1' && meta && meta.canWrite && ['whatsapp', 'sms', 'email', 'voice'].includes(startCh)) setForm({ item: null, mode: 'create' }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [meta]);

  const account = tree && !isRcs ? (tree.groups.find((g) => g.key === sel.group) || { families: [] }).families[0].accounts[0] : null;
  const group = tree ? tree.groups.find((g) => g.key === sel.group) : null;
  const agent = isRcs && tree ? (group.families[0].accounts.find((a) => a.id === sel.account) || null) : null;
  const canWrite = !!(meta && meta.canWrite);
  const flows = group && sel.group === 'whatsapp' ? group.flows : (tree ? tree.groups[0].flows : []);

  const pickAccount = (g, id) => { setSel({ group: g, account: id, view: 'list', flowId: null }); setForm(null); setRcsForm(null); setQ(''); setApproval(''); setErr(''); };
  const refresh = () => { setQ(''); setApproval(''); loadTree(); loadList(); loadRcs(); toast('Templates refreshed'); };
  const afterSave = async (id, stay) => {
    await loadTree();
    const r = await omni.get('/gs/templates/list', { channel: sel.group, where: 'all' }).catch(() => ({ items: [] }));
    setList((o) => ({ ...o }));
    const it = (r.items || []).find((x) => x.id === id || x.key === id);
    await loadList();
    if (it) setForm({ item: it, mode: 'view', v: Date.now() }); else if (!stay) setForm(null);
  };
  const duplicate = async (t) => { try { await omni.post(`/gs/templates/outreach/${t.id}/duplicate`); toast(`Copy of "${t.name}" made`); await loadTree(); await loadList(); } catch (e) { setErr(errOf(e, 'It could not be copied.')); } };
  const archive = async (t) => {
    if (!window.confirm(`Remove "${t.name}"? It leaves the list; campaigns already sent with it keep their history.`)) return;
    try { await omni.del(t.source === 'voice' ? `/gs/templates/voice/${t.id}` : `/gs/templates/outreach/${t.id}`); toast(`"${t.name}" removed`); await loadTree(); await loadList(); } catch (e) { setErr(errOf(e, 'It could not be removed.')); }
  };
  const newFlow = async (name) => { try { const r = await omni.post('/gs/templates/flows', { name }); toast(`"${r.flow.name}" created`); setFlowPrompt(false); await loadTree(); setSel({ group: 'whatsapp', account: 'whatsapp', view: 'flow', flowId: r.flow.id }); setForm(null); } catch (e) { toast(errOf(e, 'The flow could not be made.')); setFlowPrompt(false); } };

  // RCS
  const rcsCreateTpl = async (name, type) => {
    try { const r = await omni.post('/gs/templates/rcs/templates', { agentId: sel.account, name, type }); setRcsCreate(false); toast(`"${name}" created as a ${r.template.typeWord}`); await loadTree(); await loadRcs(); setRcsForm({ template: r.template, mode: 'edit' }); } catch (e) { toast(errOf(e, 'It could not be made.')); }
  };
  const rcsDup = async (t) => { try { const r = await omni.post(`/gs/templates/rcs/templates/${t.id}/duplicate`); toast(`Duplicated as "${r.template.name}"`); await loadTree(); await loadRcs(); } catch (e) { toast(errOf(e, 'It could not be copied.')); } };
  const rcsDel = async (t) => { try { await omni.del(`/gs/templates/rcs/templates/${t.id}`); toast(`"${t.name}" deleted`); await loadTree(); await loadRcs(); } catch (e) { toast(errOf(e, 'It could not be deleted.')); } };

  const editing = isRcs && rcsForm;
  const formKey = form ? `${form.item ? form.item.key : 'new'}:${form.v || 0}` : '';

  let main;
  if (!tree) main = <div style={{ padding: 30, color: 'var(--muted)' }}>{err || 'Loading…'}</div>;
  else if (sel.view === 'flow') main = <FlowEditor key={sel.flowId} flowId={sel.flowId} types={meta ? meta.flowTypes : []} onChanged={loadTree} onGone={() => { loadTree(); pickAccount('whatsapp', 'whatsapp'); }} />;
  else if (isRcs) {
    if (!agent) {
      main = (
        <div className="rcs-empty"><b>No RCS assistant yet</b><p>An assistant is the sender of your RCS messages. Make one first, then add templates to it. RCS sending is planned: nothing is sent.</p>{canWrite ? <button type="button" className="set-cta" onClick={() => setWizard(true)}>＋ New RCS assistant</button> : null}</div>
      );
    } else if (rcsForm) {
      main = <RcsEditor key={`${rcsForm.template.id}:${rcsForm.mode}`} template={rcsForm.template} agent={{ name: agent.name }} mode={rcsForm.mode} canWrite={canWrite} onBack={() => { setRcsForm(null); loadRcs(); }} onSaved={(t) => { setRcsForm((o) => (o ? { ...o, template: t } : o)); loadRcs(); loadTree(); }} onMode={(m) => setRcsForm((o) => ({ ...o, mode: m }))} />;
    } else main = <RcsGallery agent={agent} templates={rcsTpls} loading={loading} canWrite={canWrite} onCreate={() => setRcsCreate(true)} onOpen={(t, m) => setRcsForm({ template: t, mode: m })} onDuplicate={rcsDup} onDelete={rcsDel} />;
  } else if (form) {
    main = sel.group === 'voice'
      ? <VoiceForm key={formKey} item={form.item} mode={form.mode} onBack={() => { setForm(null); loadList(); }} onSaved={async () => { await loadTree(); await loadList(); setForm(null); }} onMode={(m) => setForm((o) => ({ ...o, mode: m }))} />
      : <TemplateForm key={formKey} ch={sel.group} account={account} item={form.item} mode={form.mode} meta={meta} flows={flows} onBack={() => { setForm(null); loadList(); loadTree(); }} onSaved={afterSave} onMode={(m) => setForm((o) => ({ ...o, mode: m }))} onReview={setReview} onFlowsChanged={loadTree} />;
  } else {
    main = (
      <TemplateList ch={sel.group} account={account ? { ...account, icon: group.icon } : null} data={list} loading={loading} q={q} setQ={setQ} where={where} setWhere={setWhere} approval={approval} setApproval={setApproval} err={err} staffOnly={!!(meta && meta.staffOnly)}
        canWrite={canWrite} onCreate={() => setForm({ item: null, mode: 'create' })} onOpen={(t) => setForm({ item: t, mode: 'view' })} onRefresh={refresh} onDuplicate={duplicate} onArchive={archive} onReview={setReview} />
    );
  }

  return (
    <div id="templates" className={editing ? 'rcs-editing' : ''}>
      <PageHead eyebrow="Reusable content" title="Templates" lead="Build approved templates your team can reuse across campaigns and direct sends, organized by channel and account." />
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="tpl-shell">
          <TemplateNav tree={tree} sel={sel} canWrite={canWrite} onAccount={pickAccount} onFlow={(id) => { setSel({ group: 'whatsapp', account: 'whatsapp', view: 'flow', flowId: id }); setForm(null); }} onNewFlow={() => setFlowPrompt(true)} onNewAssistant={() => setWizard(true)} />
          <div className="tpl-main">{main}</div>
        </div>
      </div>
      {review ? <MetaReviewModal item={review} onClose={() => setReview(null)} onEdit={(t) => { setForm({ item: t, mode: 'edit' }); }} /> : null}
      {rcsCreate && agent ? <RcsCreateModal agentName={agent.name} existing={rcsTpls.map((t) => t.name)} onCancel={() => setRcsCreate(false)} onCreate={rcsCreateTpl} /> : null}
      {wizard ? <RcsWizard onClose={() => setWizard(false)} onCreated={async (a) => { await loadTree(); setSel({ group: 'rcs', account: a.id, view: 'list', flowId: null }); }} /> : null}
      {flowPrompt ? <PromptModal title="New WhatsApp Flow" label="Flow name" initial="Customer survey" okLabel="Create flow" validate={(v) => (!v.trim() ? 'Give the flow a name.' : (flows.some((x) => x.name.toLowerCase() === v.trim().toLowerCase()) ? 'A flow with that name already exists.' : ''))} onCancel={() => setFlowPrompt(false)} onOk={newFlow} /> : null}
    </div>
  );
}
