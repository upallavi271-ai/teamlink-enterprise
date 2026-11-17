// ---------------------------------------------------------------------------
// NAMES OF THE OMNI-CHANNEL WORKSPACES (founder 2026-11-17: "when a number is assigned, the Meta name of the number should show in the
// workspace list, and which department the number is assigned to; a workspace is made new for it").
//
// A WhatsApp number's department decides its Omni-Channel (Green Start) workspace (utils/omniDeptLogins.js). The workspace list there shows
// only the workspace NAME, so the name carries the facts:
//     the number's Meta (verified) name known:   "<Meta name> · <Department> dept"      e.g. "Nonit Consultants · Medical dept"
//     not known yet (Meta not asked / no answer): "Teamlink <Department>"                 e.g. "Teamlink Medical" (the name used until now)
//     a second workspace with the same name:      "... - 2", "... - 3"
// Several places read a workspace's department back from its NAME (ad leads -> CRM department, AI calls -> Voice Calling workspace, a number
// connected inside Omni-Channel -> its department): deptOfName() understands every form above, so none of them breaks when a workspace is renamed.
// renameWorkspaces() renames only workspaces whose name already follows this convention (never a hand-made name, never a number the Super Admin
// pinned by hand), and never to a name another workspace has.
// ---------------------------------------------------------------------------
const SEP = ' · ';
const INDEX = /\s+-\s+\d+$/;
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ');
const lower = (s) => norm(s).toLowerCase();

// "medical" -> "Medical"; short names stay capitals ("hr" -> "HR", "r&d" -> "R&D", "bde" -> "BDE")
const title = (d) => String(d || '').trim().replace(/\s+/g, ' ').split(' ')
  .map((w) => (w.replace(/[^a-z]/gi, '').length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
  .join(' ');

// Meta's name for a number, made safe to sit in a workspace name (the separator character never appears inside it)
const cleanMeta = (m) => norm(m).replace(/·/g, '-').slice(0, 60);

/** The workspace name for a number: { dept, meta?, index? } -> "Nonit Consultants · Medical dept" | "Teamlink Medical" (+ " - 2"). */
function nameFor({ dept, meta, index = 1 }) {
  const d = title(dept);
  const m = cleanMeta(meta);
  const base = m ? `${m}${SEP}${d} dept` : `Teamlink ${d}`;
  return index > 1 ? `${base} - ${index}` : base;
}

/** The department a workspace name stands for, or null when the name is not in this convention ("Main workspace"). */
function deptOfName(name) {
  const n = norm(name).replace(INDEX, '');
  const suffixed = /^.+?\s·\s(.+?)\sdept$/i.exec(n);
  if (suffixed) return suffixed[1].trim() || null;
  const plain = /^teamlink\s+(.+)$/i.exec(n);
  return plain ? plain[1].trim() : null;
}

/**
 * A workspace that already stands for this department: the convention above, or the older looser names the code always accepted
 * ("Medical", "... Medical"). canon turns a department name into its comparable form.
 */
function belongs(wsName, dept, canon = lower) {
  const d = canon(dept);
  const viaName = deptOfName(wsName);
  if (viaName && canon(viaName) === d) return true;
  const bare = lower(wsName).replace(INDEX, '');
  return bare === d || bare.endsWith(` ${d}`);
}

/**
 * Give the workspaces of the plan the name of their number's Meta name + department. plan = [{ number: { verifiedName }, dept, ws: { id, name },
 * manual? }]; wss = every workspace (id, name); call(method, path, { ws, body }) = the Green Start API with the company login.
 * -> { done: [{ from, to }], failed: ["<name>: why"] }. Updates ws.name (and the same workspace in wss) after each rename.
 */
async function renameWorkspaces({ plan, wss, call, canon = lower }) {
  const done = [];
  const failed = [];
  const taken = (nm, id) => wss.some((w) => w.id !== id && lower(w.name) === lower(nm));
  for (const p of plan) {
    if (!p || p.manual || !p.ws || !p.ws.id) continue; // eslint-disable-line no-continue
    const meta = cleanMeta(p.number && p.number.verifiedName);
    if (!meta) continue; // eslint-disable-line no-continue -- Meta has not given a name yet: the workspace keeps the name it has
    const cur = String(p.ws.name || '');
    const owned = deptOfName(cur);
    if (!owned || canon(owned) !== canon(p.dept)) continue; // eslint-disable-line no-continue -- not named by this convention for this department: never touched
    const want = nameFor({ dept: p.dept, meta });
    if (lower(cur).replace(INDEX, '') === lower(want)) continue; // eslint-disable-line no-continue -- already named so (or "<name> - 2")
    let next = want;
    for (let k = 2; taken(next, p.ws.id) && k <= 20; k += 1) next = nameFor({ dept: p.dept, meta, index: k });
    if (taken(next, p.ws.id)) continue; // eslint-disable-line no-continue
    try {
      // eslint-disable-next-line no-await-in-loop
      await call('PATCH', `/workspaces/${p.ws.id}`, { ws: p.ws.id, body: { name: next } });
      done.push({ from: cur, to: next });
      p.ws.name = next;
      const w = wss.find((x) => x.id === p.ws.id);
      if (w) w.name = next;
    } catch (err) {
      failed.push(`${cur}: ${String((err && err.message) || err).slice(0, 160)}`);
    }
  }
  return { done, failed };
}

module.exports = { SEP, title, cleanMeta, nameFor, deptOfName, belongs, renameWorkspaces };
