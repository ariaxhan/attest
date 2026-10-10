import { WorkflowEntrypoint } from 'cloudflare:workers';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import { MemoryFS } from './memory-fs.js';

const json = (value, status = 200) => Response.json(value, { status });
const fail = (message, status = 400) => json({ error: message }, status);
const policyDefault = { verdict: 'ship', min_confidence: 0.85, max_risk: 2, min_evidence_complete: 0.9 };
const id = () => crypto.randomUUID();
const name = (v) => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{2,62}$/.test(v);
const demoRepo = repo => /^attest-(demo|dryrun-[a-z0-9-]+)$/.test(repo || '');
const text = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 512;
const scope = (v) => Array.isArray(v) && v.length > 0 && v.every(x => text(x) && !x.includes('..'));
const evidence = (v) => Array.isArray(v) && v.every(x => text(x));
const validManifest = (m) => m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).every(k => ['task','principal','agent','scope','evidence_required','change_class'].includes(k)) && text(m.task) && text(m.principal) && text(m.agent) && scope(m.scope) && evidence(m.evidence_required) && (m.change_class === undefined || ['production deploy','deletion','policy change'].includes(m.change_class));
const overlap = (a, b) => a === b || a.startsWith(b.replace(/\/$/, '') + '/') || b.startsWith(a.replace(/\/$/, '') + '/');
function policyDecision(manifest, evidenceState, verdict, policy) {
  if (['production deploy', 'deletion', 'policy change'].includes(manifest.change_class)) return `token-gated class: ${manifest.change_class}`;
  if (evidenceState.state === 'UNVERIFIED') return `UNVERIFIED receipts: ${evidenceState.missing.join(', ')}`;
  if (verdict.outsideScope?.length) return `files outside claimed scope: ${verdict.outsideScope.map(f => f.path).join(', ')}`;
  if (verdict.state === 'unverdicted') return `UNVERDICTED: ${verdict.error || 'Clef unavailable'}`;
  if (verdict.state !== policy.verdict || verdict.confidence < policy.min_confidence || verdict.risk > policy.max_risk || evidenceState.fraction < policy.min_evidence_complete) return 'verdict below merge policy';
  return null;
}
const recordStep = (db, changeId, step, state, detail = {}) => db.prepare('INSERT INTO workflow_steps(change_id,step,state,detail_json) VALUES(?,?,?,?) ON CONFLICT(change_id,step) DO UPDATE SET state=excluded.state,detail_json=excluded.detail_json,updated_at=CURRENT_TIMESTAMP').bind(changeId, step, state, JSON.stringify(detail)).run();
const questions = {
  evidence_complete: { type: 'noul', instructions: 'Do receipts exist for every claim in the manifest?' },
  scope_respected: { type: 'noul', instructions: 'Does the change stay inside the claimed scope?' },
  claims_match: { type: 'noul', instructions: 'Does the manifest match the described change and receipts?' },
  change_kind: { type: 'choice', instructions: 'What kind of change is this?', criteria: { feature: 'New functionality', fix: 'Repair', refactor: 'Restructure', docs: 'Documentation', test: 'Tests' } },
  risk: { type: 'score', instructions: 'Rate blast radius from 0 to 4.', criteria: ['No risk','Minimal risk','Moderate risk','High risk','Severe risk'] },
  verdict: { type: 'choice', instructions: 'Should this change ship, be held for human review, or be rejected?', criteria: { ship: 'Safe to merge', 'hold-for-human': 'Needs human review', reject: 'Should not merge' } },
};
const answer = r => r?.answers || r;
const score = a => Number(a?.score ?? a?.value ?? 4);
const verdictOf = a => ({ state: a?.verdict?.choice || 'unverdicted', confidence: Number(a?.verdict?.probabilities?.[a?.verdict?.choice] || 0), risk: score(a?.risk) });
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
const page = (title, body) => new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><style>body{font:16px system-ui;margin:24px auto;padding:0 16px;max-width:880px;background:#fafafa;color:#222}nav a{margin-right:20px}article{background:white;border:1px solid #ddd;border-radius:10px;padding:16px;margin:12px 0;overflow-wrap:anywhere}small{color:#555}input,button{font:inherit;padding:8px;max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><nav><a href="/queue">Verdict Queue</a><a href="/board">Coordination Board</a></nav><h1>${escapeHtml(title)}</h1>${body}`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const changeLink = changeId => `/changes/${encodeURIComponent(changeId)}`;
async function changedFiles(env, change) {
  const task = await env.DB.prepare('SELECT remote,fork FROM tasks WHERE id=?').bind(change.task_id).first();
  const fork = await env.ARTIFACTS.get(task.fork);
  const token = await fork.createToken('read', 300);
  const fs = new MemoryFS(), dir = '/workspace';
  await fs.promises.mkdir(dir, { recursive: true });
  await git.clone({ fs, http, dir, url: task.remote, ref: 'main', singleBranch: true, onAuth: () => ({ username: 'x', password: token.plaintext.split('?expires=')[0] }) });
  const commit = await git.readCommit({ fs, dir, oid: change.ref });
  const parent = commit.commit.parent[0];
  const paths = new Set(await git.listFiles({ fs, dir, ref: change.ref }));
  if (parent) for (const path of await git.listFiles({ fs, dir, ref: parent })) paths.add(path);
  const files = [];
  for (const path of paths) {
    const blob = async ref => { try { return (await git.readBlob({ fs, dir, oid: ref, filepath: path })).oid; } catch { return null; } };
    const before = parent ? await blob(parent) : null, after = await blob(change.ref);
    if (before !== after) files.push({ path, status: !before ? 'added' : !after ? 'deleted' : 'modified' });
  }
  return files.sort((a,b) => a.path.localeCompare(b.path));
}
async function changeView(env, changeId) {
  const row = await env.DB.prepare('SELECT c.*,t.task,t.agent,t.principal,t.scope_json,p.name AS project FROM changes c JOIN tasks t ON t.id=c.task_id JOIN projects p ON p.id=t.project_id WHERE c.id=?').bind(changeId).first();
  if (!row) return fail('change missing', 404);
  const manifest = JSON.parse(row.manifest_json);
  const receipts = (await env.DB.prepare('SELECT requirement,object_key FROM receipts WHERE change_id=?').bind(changeId).all()).results;
  const verdicts = (await env.DB.prepare('SELECT * FROM verdicts WHERE change_id=? ORDER BY created_at,rowid').bind(changeId).all()).results;
  const steps = (await env.DB.prepare('SELECT * FROM workflow_steps WHERE change_id=? ORDER BY updated_at,rowid').bind(changeId).all()).results;
  const files = await changedFiles(env, row);
  const receiptList = await Promise.all(manifest.evidence_required.map(async requirement => {
    const receipt = receipts.find(r => r.requirement === requirement);
    const verified = !!receipt && !!(await env.RECEIPTS.head(receipt.object_key));
    return `<li>${escapeHtml(requirement)} — <strong>${verified ? 'VERIFIED' : 'UNVERIFIED'}</strong>${verified ? ` · <a href="/api/changes/${encodeURIComponent(changeId)}/receipts/${encodeURIComponent(requirement)}">receipt</a>` : ''}</li>`;
  }));
  const field = (label, value) => `<p><strong>${label}:</strong> ${escapeHtml(value)}</p>`;
  return page('Change View', `<article><h2>${escapeHtml(manifest.task)}</h2>${field('Project',row.project)}${field('State',row.state)}${field('Principal',manifest.principal)}${field('Agent',manifest.agent)}${field('Scope',manifest.scope.join(', '))}${field('Commit',row.ref)}${field('Submitted',row.created_at)}${row.deploy_url ? `<p><a href="${escapeHtml(row.deploy_url)}">Live deployment</a></p>` : ''}${row.preview_url ? `<p><a href="${escapeHtml(row.preview_url)}">Preview</a></p>` : ''}${row.deploy_error ? field('Deploy error',row.deploy_error) : ''}</article><h2>Files changed (${files.length})</h2><article><ul>${files.map(f => `<li>${escapeHtml(f.status)} · ${escapeHtml(f.path)}</li>`).join('')}</ul></article><h2>Receipts</h2><article><ul>${receiptList.join('') || '<li>No receipts required</li>'}</ul></article><h2>Verdict distribution</h2>${verdicts.map(v => `<article><strong>${escapeHtml(v.model)} · ${escapeHtml(v.state)}</strong> · ${escapeHtml(v.created_at)}<pre>${escapeHtml(JSON.stringify(JSON.parse(v.probabilities_json),null,2))}</pre></article>`).join('') || '<p>Awaiting verdict.</p>'}<h2>Context trail</h2><article>${field('Task',row.task)}${field('Agent',row.agent)}<ol>${steps.map(s => `<li>${escapeHtml(s.updated_at)} · ${escapeHtml(s.step)} · ${escapeHtml(s.state)}<pre>${escapeHtml(JSON.stringify(JSON.parse(s.detail_json),null,2))}</pre></li>`).join('')}</ol></article>`);
}
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map(b => b.toString(16).padStart(2,'0')).join('');
const ownerAuthorized = async (request, env) => !!env.REVIEW_SECRET && await digest(request.headers.get('x-review-key') || '') === await digest(env.REVIEW_SECRET);
async function merge(env, change) {
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id=?').bind(change.task_id).first();
  const project = await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(task.project_id).first();
  const fork = await env.ARTIFACTS.get(task.fork);
  const source = await fork.log({ ref: change.ref, limit: 1 });
  if (!source.length) throw new Error('fork ref missing');
  const target = await env.ARTIFACTS.get(project.repo);
  const token = await target.createToken('write', 300);
  const readToken = await fork.createToken('read', 300);
  const fs = new MemoryFS(), dir = '/workspace';
  await fs.promises.mkdir(dir, { recursive: true });
  const auth = t => () => ({ username: 'x', password: t.plaintext.split('?expires=')[0] });
  await git.clone({ fs, http, dir, url: task.remote, ref: 'main', singleBranch: true, onAuth: auth(readToken) });
  let head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
  if (head !== change.ref) throw new Error('fork head differs from submitted ref');
  const prior = await target.log({ ref: 'main', limit: 1 });
  if (prior.length) {
    const history = await git.log({ fs, dir, ref: 'main', depth: 1000 });
    if (!history.some(c => c.oid === prior[0].hash || c.oid === prior[0].oid)) {
      const fetched = await git.fetch({ fs, http, dir, url: project.remote, ref: 'main', singleBranch: true, onAuth: auth(token) });
      if (!fetched.fetchHead) throw new Error('project main fetch failed');
      const combined = await git.merge({ fs, dir, ours: 'main', theirs: fetched.fetchHead, author: { name: 'Attest', email: 'merge@attest.invalid' }, message: `Merge ${change.ref} into project main`, mergeDriver: ({ path, contents }) => ({ cleanMerge: path === 'attest.manifest.json', mergedText: contents[1] }) });
      head = combined.oid;
    }
  }
  const pushed = await git.push({ fs, http, dir, url: project.remote, ref: 'main', onAuth: auth(token) });
  if (!pushed.ok) throw new Error('Git push rejected');
  const readback = await target.log({ ref: 'main', limit: 1 });
  if (readback[0]?.hash !== head && readback[0]?.oid !== head) throw new Error('project main readback mismatch');
  return head;
}
async function deployDemo(env, change, preview = false) {
  const project = await env.DB.prepare('SELECT p.repo FROM projects p JOIN tasks t ON t.project_id=p.id WHERE t.id=?').bind(change.task_id).first();
  if (!demoRepo(project?.repo)) return null;
  if (!env.DEMO_DEPLOY_TOKEN) throw new Error('DEMO_DEPLOY_TOKEN missing');
  const repo = await env.ARTIFACTS.get(preview ? change.repo : project.repo);
  const source = await repo.readFile({ ref: preview ? change.ref : 'main', path: 'src/worker.js' });
  if (!source) throw new Error('src/worker.js missing from deploy source');
  const script = preview ? `${project.repo}-preview-${change.id.slice(0,8)}` : project.repo;
  const api = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${script}`;
  const auth = { Authorization: `Bearer ${env.DEMO_DEPLOY_TOKEN}` };
  const body = new FormData();
  body.set('metadata', JSON.stringify({ main_module: 'worker.js', compatibility_date: '2025-10-01' }));
  body.set('worker.js', new Blob([await source.text()], { type: 'application/javascript+module' }), 'worker.js');
  const upload = await fetch(api, { method: 'PUT', headers: auth, body });
  const result = await upload.json();
  if (!upload.ok || !result.success) throw new Error(`Worker upload failed: ${JSON.stringify(result.errors || [])}`);
  const route = await fetch(`${api}/subdomain`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, previews_enabled: true }) });
  const routed = await route.json();
  if (!route.ok || !routed.success) throw new Error(`workers.dev route failed: ${JSON.stringify(routed.errors || [])}`);
  return `https://${script}.ariaxhan.workers.dev`;
}

export class ProjectState {
  constructor(state) { this.state = state; }
  async fetch() { return json({ ok: true }); }
}

export class ChangeWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const changeId = event.payload.change_id;
    const change = await step.do('fetch-change', async () => {
      const row = await this.env.DB.prepare('SELECT * FROM changes WHERE id=?').bind(changeId).first();
      if (!row) throw new Error('change missing');
      await recordStep(this.env.DB, changeId, 'fetch-change', 'complete', { ref: row.ref });
      return row;
    });
    const assembled = await step.do('assemble-evidence', async () => {
      const manifest = JSON.parse(change.manifest_json);
      const rows = await this.env.DB.prepare('SELECT requirement,object_key FROM receipts WHERE change_id=?').bind(changeId).all();
      const present = new Set();
      for (const row of rows.results) if (await this.env.RECEIPTS.head(row.object_key)) present.add(row.requirement);
      const missing = manifest.evidence_required.filter(r => !present.has(r));
      const state = missing.length ? 'UNVERIFIED' : 'verified';
      const fraction = manifest.evidence_required.length ? present.size / manifest.evidence_required.length : 1;
      await this.env.DB.prepare('UPDATE changes SET evidence_state=? WHERE id=?').bind(state, changeId).run();
      await recordStep(this.env.DB, changeId, 'assemble-evidence', 'complete', { state, missing, fraction });
      return { state, missing, fraction, present: [...present] };
    });
    await step.do('preview', async () => {
      try {
        const url = await deployDemo(this.env, change, true);
        if (url) await this.env.DB.prepare('UPDATE changes SET preview_url=? WHERE id=?').bind(url, changeId).run();
        await recordStep(this.env.DB, changeId, 'preview', 'complete', { url });
      } catch (error) {
        await recordStep(this.env.DB, changeId, 'preview', 'failed', { error: String(error) });
      }
    });
    const verdict = await step.do('verdict', async () => {
      const manifest = JSON.parse(change.manifest_json);
      const files = await changedFiles(this.env, change);
      const outsideScope = files.filter(f => f.path !== 'attest.manifest.json' && !manifest.scope.some(claim => f.path === claim || f.path.startsWith(claim.replace(/\/$/, '') + '/')));
      const state = JSON.stringify({ manifest, change: { repo: change.repo, ref: change.ref, files_changed: files, files_outside_claimed_scope: outsideScope }, receipts_present: assembled.present, receipts_missing: assembled.missing, deterministic_evidence_complete: assembled.fraction, notice: assembled.missing.length ? 'Required receipts are MISSING; claims are unverified.' : 'All required receipt objects are present.' });
      const run = async (model, binding) => {
        let lastError;
        for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const result = answer(await this.env.AI.run(binding, { model, state, questions }));
          const parsed = verdictOf(result);
          await this.env.DB.prepare('INSERT INTO verdicts(id,change_id,state,schema_json,probabilities_json,model,deterministic_evidence) VALUES(?,?,?,?,?,?,?)').bind(id(), changeId, parsed.state, JSON.stringify(questions), JSON.stringify(result), model, assembled.fraction).run();
          return parsed;
        } catch (error) {
          lastError = error;
          if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1000));
        }
        }
        const message = `after 3 attempts: ${String(lastError).slice(0, 900)}`;
        await this.env.DB.prepare('INSERT INTO verdicts(id,change_id,state,schema_json,probabilities_json,model,deterministic_evidence,error) VALUES(?,?,?,?,?,?,?,?)').bind(id(), changeId, 'unverdicted', JSON.stringify(questions), '{}', model, assembled.fraction, message).run();
        return { state: 'unverdicted', error: message, confidence: 0, risk: 4 };
      };
      let result = await run('clef-flash', '@cf/cloudflare/clef-flash');
      if (result.state !== 'unverdicted' && (result.confidence < 0.85 || result.state === 'hold-for-human' || result.risk > 2)) result = await run('clef', '@cf/cloudflare/clef');
      result.outsideScope = outsideScope;
      await recordStep(this.env.DB, changeId, 'verdict', 'complete', result);
      return result;
    });
    let reason = await step.do('policy', async () => {
      const manifest = JSON.parse(change.manifest_json);
      const project = await this.env.DB.prepare('SELECT p.policy_json FROM projects p JOIN tasks t ON t.project_id=p.id WHERE t.id=?').bind(change.task_id).first();
      const policy = project ? JSON.parse(project.policy_json) : policyDefault;
      const why = policyDecision(manifest, assembled, verdict, policy);
      await recordStep(this.env.DB, changeId, 'policy', 'complete', { result: why ? 'hold' : 'merge', reason: why, policy });
      return why;
    });
    await step.do('merge-or-hold', async () => {
      if (!reason) {
        try {
          const head = await merge(this.env, change);
          await this.env.DB.prepare("UPDATE changes SET state='merged' WHERE id=?").bind(changeId).run();
          await recordStep(this.env.DB, changeId, 'merge-or-hold', 'complete', { result: 'merged', head });
          await this.env.DB.prepare("UPDATE tasks SET state='complete' WHERE id=?").bind(change.task_id).run();
          try {
            const url = await deployDemo(this.env, change);
            if (url) await this.env.DB.prepare('UPDATE changes SET deploy_url=? WHERE id=?').bind(url, changeId).run();
            await recordStep(this.env.DB, changeId, 'deploy', 'complete', { url, head });
          } catch (error) {
            await this.env.DB.prepare('UPDATE changes SET deploy_error=? WHERE id=?').bind(String(error).slice(0,500),changeId).run();
            await recordStep(this.env.DB, changeId, 'deploy', 'failed', { error: String(error) });
          }
          return;
        } catch (error) { reason = `merge failed: ${String(error).slice(0, 500)}`; }
      }
      const token = crypto.randomUUID();
      await this.env.DB.prepare('INSERT INTO holds(id,change_id,reason,token_hash,token_plain) VALUES(?,?,?,?,?)').bind(id(), changeId, reason, await digest(token), token).run();
      await this.env.DB.prepare("UPDATE changes SET state='held' WHERE id=?").bind(changeId).run();
      await recordStep(this.env.DB, changeId, 'merge-or-hold', 'complete', { result: 'hold', reason });
    });
    const current = await this.env.DB.prepare('SELECT state FROM changes WHERE id=?').bind(changeId).first();
    if (current?.state === 'held') {
      const resolution = await step.waitForEvent('human-resolution', { type: 'human-resolution', timeout: '30 days' });
      await step.do('resolve-human', async () => {
        if (resolution.payload.action === 'reject') {
          await this.env.DB.prepare("UPDATE changes SET state='rejected' WHERE id=?").bind(changeId).run();
          await recordStep(this.env.DB, changeId, 'resolve-human', 'complete', { action: 'reject' });
        } else {
          try {
            const head = await merge(this.env, change);
            await this.env.DB.prepare("UPDATE changes SET state='merged' WHERE id=?").bind(changeId).run();
            await recordStep(this.env.DB, changeId, 'resolve-human', 'complete', { action: 'approve', head });
            await this.env.DB.prepare("UPDATE tasks SET state='complete' WHERE id=?").bind(change.task_id).run();
            try {
              const url = await deployDemo(this.env, change);
              if (url) await this.env.DB.prepare('UPDATE changes SET deploy_url=?,deploy_error=NULL WHERE id=?').bind(url,changeId).run();
              await recordStep(this.env.DB, changeId, 'deploy', 'complete', { url, head });
            } catch (error) {
              await this.env.DB.prepare('UPDATE changes SET deploy_error=? WHERE id=?').bind(String(error).slice(0,500),changeId).run();
              await recordStep(this.env.DB, changeId, 'deploy', 'failed', { error: String(error) });
            }
          } catch (error) {
            await this.env.DB.prepare("UPDATE holds SET state='open', reason=? WHERE change_id=?").bind(`merge failed: ${String(error).slice(0, 500)}`, changeId).run();
            await recordStep(this.env.DB, changeId, 'resolve-human', 'failed', { error: String(error) });
          }
        }
      });
    }
  }
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      const body = message.body;
      if (!body || !text(body.change_id) || !text(body.repo) || !text(body.ref)) { message.ack(); continue; }
      try {
        const instance = await env.CHANGE_WORKFLOW.create({ id: body.change_id, params: body });
        await env.DB.prepare('UPDATE changes SET workflow_id=? WHERE id=?').bind(instance.id, body.change_id).run();
        message.ack();
      } catch (error) { message.retry(); }
    }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/') return json({ ok: true, service: 'attest' });
      const viewMatch = path.match(/^\/changes\/([^/]+)$/);
      if (request.method === 'GET' && viewMatch) return changeView(env, viewMatch[1]);
      if (request.method === 'GET' && path === '/queue') {
        const projectFilter = url.searchParams.get('project');
        const query = "SELECT h.*,c.state AS change_state,c.ref,t.task,t.agent,v.model,v.state AS verdict_state,v.probabilities_json,v.error FROM holds h JOIN changes c ON c.id=h.change_id JOIN tasks t ON t.id=c.task_id LEFT JOIN verdicts v ON v.id=(SELECT id FROM verdicts WHERE change_id=c.id ORDER BY created_at DESC,rowid DESC LIMIT 1) WHERE h.state='open'" + (projectFilter ? ' AND t.project_id=?' : '') + ' ORDER BY h.created_at DESC LIMIT 100';
        const rows = (await (projectFilter ? env.DB.prepare(query).bind(projectFilter) : env.DB.prepare(query)).all()).results;
        return page('Verdict Queue', rows.map(r => `<article><h2><a href="${changeLink(r.change_id)}">${escapeHtml(r.task)}</a></h2><p>${escapeHtml(r.reason)} · ${escapeHtml(r.change_state)} · ${escapeHtml(r.model || 'no model')}</p><small>Agent ${escapeHtml(r.agent)} · ${escapeHtml(r.ref)}</small><pre>${escapeHtml(r.probabilities_json || '{}')}</pre>${r.error ? `<p>Error: ${escapeHtml(r.error)}</p>` : ''}<form method="post" action="/holds/${escapeHtml(r.id)}/issue"><input name="review_key" type="password" placeholder="Reviewer key" required><button>Issue one-time token</button></form><form method="post" action="/holds/${escapeHtml(r.id)}/approve"><input name="token" placeholder="Enter one-time token" required><button>Approve and merge</button></form><form method="post" action="/holds/${escapeHtml(r.id)}/reject"><input name="review_key" type="password" placeholder="Reviewer key" required><input name="reason" placeholder="Rejection reason" required><button>Reject</button></form></article>`).join('') || '<p>No open holds.</p>');
      }
      if (request.method === 'GET' && path === '/board') {
        const tasks = (await env.DB.prepare("SELECT t.*,p.name AS project FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.state='active' ORDER BY t.created_at DESC LIMIT 100").all()).results;
        const verdicts = (await env.DB.prepare("SELECT v.*,c.state AS change_state FROM verdicts v JOIN changes c ON c.id=v.change_id ORDER BY v.created_at DESC,v.rowid DESC LIMIT 20").all()).results;
        const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM holds WHERE state='open'").first();
        const collisions = (await env.DB.prepare('SELECT * FROM claim_conflicts ORDER BY created_at DESC LIMIT 20').all()).results;
        return page('Coordination Board', `<p>Open holds: <a href="/queue">${count.n}</a> · refreshes every 5 seconds</p><h2>Active claims</h2>${tasks.map(t => `<article><strong>${escapeHtml(t.project)} · ${escapeHtml(t.task)}</strong><p>${escapeHtml(t.agent)} · ${escapeHtml(t.scope_json)}</p><small>Fork ${escapeHtml(t.fork)} · ${escapeHtml(t.state)}</small></article>`).join('') || '<p>No active claims.</p>'}<h2>Recent collisions</h2>${collisions.map(c => `<article><strong>Flagged before fork</strong> · ${escapeHtml(c.agent)} · ${escapeHtml(c.scope_json)}<p>Conflicted with ${escapeHtml(c.conflicting_task)} at ${escapeHtml(c.created_at)}</p></article>`).join('') || '<p>No recent collisions.</p>'}<h2>Recent verdicts</h2>${verdicts.map(v => `<article><a href="${changeLink(v.change_id)}">${escapeHtml(v.change_id)}</a> · ${escapeHtml(v.model)} · ${escapeHtml(v.state)} · ${escapeHtml(v.change_state)}</article>`).join('')}`);
      }
      const actionMatch = path.match(/^\/holds\/([^/]+)\/(issue|approve|reject)$/);
      if (request.method === 'POST' && actionMatch) {
        const hold = await env.DB.prepare('SELECT h.*,c.workflow_id FROM holds h JOIN changes c ON c.id=h.change_id WHERE h.id=?').bind(actionMatch[1]).first();
        if (!hold || hold.state !== 'open') return fail('open hold missing', 404);
        const form = await request.formData();
        if (actionMatch[2] !== 'approve' && (!env.REVIEW_SECRET || await digest(String(form.get('review_key') || '')) !== await digest(env.REVIEW_SECRET))) return fail('reviewer key required', 403);
        if (actionMatch[2] === 'issue') return page('One-time approval token', `<p>Token for hold ${escapeHtml(hold.id)}. Enter it in the queue to approve. It works once.</p><code>${escapeHtml(hold.token_plain)}</code><p><a href="/queue">Back to queue</a></p>`);
        if (actionMatch[2] === 'approve' && (!hold.token_hash || await digest(String(form.get('token') || '')) !== hold.token_hash)) return fail('invalid token', 403);
        if (actionMatch[2] === 'reject' && !text(String(form.get('reason') || ''))) return fail('rejection reason required');
        const changed = await env.DB.prepare("UPDATE holds SET state=?,token_hash=NULL,token_plain=NULL,reason=?,resolved_at=CURRENT_TIMESTAMP WHERE id=? AND state='open'").bind(actionMatch[2] === 'approve' ? 'approved' : 'rejected', actionMatch[2] === 'approve' ? hold.reason : String(form.get('reason')), hold.id).run();
        if (!changed.meta.changes) return fail('hold already resolved', 409);
        const instance = await env.CHANGE_WORKFLOW.get(hold.workflow_id);
        await instance.sendEvent({ type: 'human-resolution', payload: { action: actionMatch[2] } });
        return Response.redirect(new URL('/queue', request.url), 303);
      }
      if (request.method === 'GET' && path === '/api/projects') {
        return json((await env.DB.prepare('SELECT id,name,repo,remote,policy_json,created_at FROM projects ORDER BY created_at DESC').all()).results);
      }
      if (request.method === 'POST' && path === '/api/projects') {
        const body = await request.json();
        if (!name(body.name)) return fail('name must be 3-63 lowercase letters, digits, hyphens');
        if (demoRepo(body.name) && !await ownerAuthorized(request, env)) return fail('reviewer key required',403);
        if (await env.DB.prepare('SELECT id FROM projects WHERE repo=?').bind(body.name).first()) return fail('project exists', 409);
        let policy = policyDefault;
        if (body.policy !== undefined) {
          if (!/^attest-dryrun-[a-z0-9-]+$/.test(body.name) || !await ownerAuthorized(request, env)) return fail('reviewer key required',403);
          if (body.policy?.verdict !== 'ship' || !Number.isFinite(body.policy.min_confidence) || body.policy.min_confidence < 0.6 || body.policy.min_confidence > 1 || body.policy.max_risk !== 2 || body.policy.min_evidence_complete !== 0.9) return fail('invalid demo policy');
          policy = body.policy;
        }
        const repo = await env.ARTIFACTS.create(body.name, { description: `Attest project ${body.name}`, setDefaultBranch: 'main' });
        const projectId = id();
        await env.DB.prepare('INSERT INTO projects(id,name,repo,remote,policy_json) VALUES(?,?,?,?,?)').bind(projectId, body.name, body.name, repo.remote, JSON.stringify(policy)).run();
        const projectObject = env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(projectId));
        await projectObject.fetch('https://project-state.internal/');
        return json({ id: projectId, name: body.name, repo: body.name, remote: repo.remote }, 201);
      }
      const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
      if (request.method === 'GET' && projectMatch) {
        const project = await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(projectMatch[1]).first();
        return project ? json({ ...project, policy: JSON.parse(project.policy_json) }) : fail('project missing', 404);
      }
      const logMatch = path.match(/^\/api\/projects\/([^/]+)\/log$/);
      if (request.method === 'GET' && logMatch) {
        const project = await env.DB.prepare('SELECT repo FROM projects WHERE id=?').bind(logMatch[1]).first();
        if (!project) return fail('project missing', 404);
        const repo = await env.ARTIFACTS.get(project.repo);
        return json(await repo.log({ ref: 'main', limit: 10 }));
      }
      const bootstrapMatch = path.match(/^\/api\/projects\/([^/]+)\/bootstrap$/);
      if (request.method === 'POST' && bootstrapMatch) {
        const project = await env.DB.prepare('SELECT repo,remote FROM projects WHERE id=?').bind(bootstrapMatch[1]).first();
        if (!project || !/^attest-(demo|dryrun-[a-z0-9-]+)$/.test(project.repo)) return fail('demo project missing',404);
        if (!env.REVIEW_SECRET || await digest(request.headers.get('x-review-key') || '') !== await digest(env.REVIEW_SECRET)) return fail('reviewer key required',403);
        const repo = await env.ARTIFACTS.get(project.repo);
        if ((await repo.log({ ref: 'main', limit: 1 })).length) return fail('project already seeded',409);
        const token = await repo.createToken('write',300);
        return json({ remote: project.remote, token: token.token || token });
      }
      const taskMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks$/);
      if (request.method === 'POST' && taskMatch) {
        const project = await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(taskMatch[1]).first();
        if (!project) return fail('project missing', 404);
        if (demoRepo(project.repo) && !await ownerAuthorized(request, env)) return fail('reviewer key required',403);
        const body = await request.json();
        const manifest = body.manifest;
        if (!validManifest(manifest)) return fail('valid manifest required');
        const active = (await env.DB.prepare("SELECT id,scope_json FROM tasks WHERE project_id=? AND state='active'").bind(project.id).all()).results;
        for (const task of active) if (JSON.parse(task.scope_json).some(a => manifest.scope.some(b => overlap(a,b)))) {
          await env.DB.prepare('INSERT INTO claim_conflicts(id,project_id,agent,scope_json,conflicting_task) VALUES(?,?,?,?,?)').bind(id(),project.id,manifest.agent,JSON.stringify(manifest.scope),task.id).run();
          return json({ error: 'scope conflict', conflicting_task: task.id }, 409);
        }
        const taskId = id();
        const forkName = `${project.repo}-task-${taskId.slice(0,8)}`;
        const source = await env.ARTIFACTS.get(project.repo);
        const fork = await source.fork(forkName, { defaultBranchOnly: true });
        const forkRepo = await env.ARTIFACTS.get(forkName);
        const token = await forkRepo.createToken('write', 86400);
        const remote = fork.remote || (await forkRepo.info()).remote;
        await env.DB.prepare('INSERT INTO tasks(id,project_id,task,principal,agent,scope_json,evidence_required_json,manifest_json,fork,remote) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(taskId, project.id, manifest.task, manifest.principal, manifest.agent, JSON.stringify(manifest.scope), JSON.stringify(manifest.evidence_required), JSON.stringify(manifest), forkName, remote).run();
        return json({ id: taskId, fork: forkName, remote, token: token.token || token, manifest, manifest_file: 'pending Git push by scoped agent' }, 201);
      }
      if (request.method === 'GET' && taskMatch) return json((await env.DB.prepare('SELECT id,project_id,task,principal,agent,scope_json,fork,remote,state FROM tasks WHERE project_id=?').bind(taskMatch[1]).all()).results);
      if (request.method === 'POST' && path === '/api/changes') {
        const body = await request.json();
        const task = await env.DB.prepare('SELECT t.*,p.repo AS project_repo FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?').bind(body.task_id).first();
        if (!task) return fail('task missing', 404);
        if (demoRepo(task.project_repo) && !await ownerAuthorized(request, env)) return fail('reviewer key required',403);
        if (!validManifest(body.manifest) || JSON.stringify(body.manifest) !== task.manifest_json) return fail('matching valid manifest required');
        if (body.repo !== task.fork || !text(body.ref)) return fail('repo/ref mismatch');
        if (body.receipts !== undefined && (!body.receipts || typeof body.receipts !== 'object' || Array.isArray(body.receipts) || Object.keys(body.receipts).some(k => !body.manifest.evidence_required.includes(k) || !text(body.receipts[k])))) return fail('invalid receipts');
        const changeId = id();
        await env.DB.prepare('INSERT INTO changes(id,task_id,repo,ref,manifest_json) VALUES(?,?,?,?,?)').bind(changeId, task.id, task.fork, body.ref, task.manifest_json).run();
        if (body.receipts !== undefined) {
          for (const [requirement, content] of Object.entries(body.receipts)) {
            const key = `${changeId}/${encodeURIComponent(requirement)}`;
            await env.RECEIPTS.put(key, content, { httpMetadata: { contentType: 'text/plain' } });
            await env.DB.prepare('INSERT INTO receipts(id,change_id,requirement,object_key,content_type) VALUES(?,?,?,?,?)').bind(id(), changeId, requirement, key, 'text/plain').run();
          }
        }
        await env.EVENTS.send({ change_id: changeId, repo: task.fork, ref: body.ref });
        return json({ id: changeId, state: 'submitted' }, 202);
      }
      const receiptMatch = path.match(/^\/api\/changes\/([^/]+)\/receipts\/([^/]+)$/);
      if (receiptMatch && request.method === 'PUT') {
        const change = await env.DB.prepare('SELECT c.*,p.repo AS project_repo FROM changes c JOIN tasks t ON t.id=c.task_id JOIN projects p ON p.id=t.project_id WHERE c.id=?').bind(receiptMatch[1]).first();
        if (!change) return fail('change missing', 404);
        if (demoRepo(change.project_repo) && !await ownerAuthorized(request, env)) return fail('reviewer key required',403);
        const requirement = decodeURIComponent(receiptMatch[2]);
        if (!JSON.parse(change.manifest_json).evidence_required.includes(requirement)) return fail('unknown requirement');
        const key = `${change.id}/${encodeURIComponent(requirement)}`;
        await env.RECEIPTS.put(key, request.body, { httpMetadata: { contentType: request.headers.get('content-type') || 'application/octet-stream' } });
        await env.DB.prepare('INSERT INTO receipts(id,change_id,requirement,object_key,content_type) VALUES(?,?,?,?,?) ON CONFLICT(change_id,requirement) DO UPDATE SET object_key=excluded.object_key,content_type=excluded.content_type').bind(id(), change.id, requirement, key, request.headers.get('content-type')).run();
        return json({ key, requirement }, 201);
      }
      if (receiptMatch && request.method === 'GET') {
        const row = await env.DB.prepare('SELECT object_key FROM receipts WHERE change_id=? AND requirement=?').bind(receiptMatch[1], decodeURIComponent(receiptMatch[2])).first();
        if (!row) return fail('receipt missing', 404);
        const blob = await env.RECEIPTS.get(row.object_key);
        return blob ? new Response(blob.body, { headers: { 'content-type': blob.httpMetadata?.contentType || 'application/octet-stream' } }) : fail('receipt blob missing', 404);
      }
      const changeMatch = path.match(/^\/api\/changes\/([^/]+)$/);
      if (changeMatch && request.method === 'GET') {
        const change = await env.DB.prepare('SELECT * FROM changes WHERE id=?').bind(changeMatch[1]).first();
        if (!change) return fail('change missing', 404);
        const steps = (await env.DB.prepare('SELECT * FROM workflow_steps WHERE change_id=?').bind(change.id).all()).results;
        const verdicts = (await env.DB.prepare('SELECT * FROM verdicts WHERE change_id=? ORDER BY created_at DESC,rowid DESC').bind(change.id).all()).results;
        const verdict = verdicts[0] || null;
        const holds = (await env.DB.prepare('SELECT * FROM holds WHERE change_id=?').bind(change.id).all()).results;
        return json({ ...change, steps, verdict, verdicts, holds: holds.map(({ token_hash, token_plain, ...hold }) => hold) });
      }
      return fail('not found', 404);
    } catch (error) { return fail(String(error), 500); }
  }
};
