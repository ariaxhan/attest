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
const STYLES = `:root{--bg:#fff;--subtle:#f6f8fa;--ink:#1f2328;--muted:#59636e;--faint:#818c98;--line:#d1d9e0;--line2:#e3e8ee;--accent:#f38020;--ok:#1a7f37;--ok-bg:#dafbe1;--merged:#8250df;--merged-bg:#fbefff;--bad:#cf222e;--bad-bg:#ffebe9;--warn:#9a6700;--warn-bg:#fff8c5;--info:#0969da;--info-bg:#ddf4ff;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 var(--sans)}
a{color:var(--info);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:980px;margin:0 auto;padding:0 16px}
.top{background:#010409;color:#fff}.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:56px;flex-wrap:wrap}
.mark{color:#fff;font-weight:700;letter-spacing:.18em;font-size:16px}.mark:hover{text-decoration:none}.mark::before{content:"";display:inline-block;width:9px;height:9px;background:var(--accent);border-radius:2px;margin-right:9px;vertical-align:1px}
.top nav{display:flex;gap:2px;flex-wrap:wrap}.top nav a{color:#e6edf3;padding:5px 10px;border-radius:6px;font-size:14px}.top nav a:hover{background:rgba(255,255,255,.12);color:#fff;text-decoration:none}.top nav a[aria-current]{background:rgba(255,255,255,.16);color:#fff;font-weight:600}
main{padding:24px 16px 56px}h1{font-size:24px;line-height:1.25;margin:0 0 4px;font-weight:600}h2{font-size:16px;margin:28px 0 8px;font-weight:600}h3{font-size:15px;margin:0 0 4px;line-height:1.35;font-weight:600}
.lede{color:var(--muted);margin:0 0 10px;max-width:720px;font-size:14px}.summary{color:var(--ink);font-size:14px;margin:2px 0 14px}.summary b{font-weight:600}.meta{color:var(--muted);font-size:12.5px}
.box{border:1px solid var(--line);border-radius:8px;background:#fff;margin:12px 0;overflow:hidden}.box-h{background:var(--subtle);border-bottom:1px solid var(--line);padding:9px 16px;font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}.box-b{padding:14px 16px}
.card{border:1px solid var(--line);border-radius:8px;background:#fff;padding:14px 16px;margin:10px 0;overflow-wrap:anywhere}
.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.spread{justify-content:space-between}.row>*{min-width:0}
.pill{display:inline-block;max-width:100%;overflow-wrap:anywhere;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:500;line-height:18px;background:var(--subtle);color:var(--muted);border:1px solid var(--line2)}
.pill.ok{background:var(--ok-bg);color:var(--ok);border-color:#a6e8b8}.pill.warn{background:var(--warn-bg);color:var(--warn);border-color:#ecd28f}.pill.bad{background:var(--bad-bg);color:var(--bad);border-color:#ffc1bc}.pill.info{background:var(--info-bg);color:var(--info);border-color:#b6e3ff}.pill.merged{background:var(--merged-bg);color:var(--merged);border-color:#e4ccff}
.chip{display:inline-block;padding:1px 8px;border:1px solid var(--line);border-radius:999px;background:#fff;font:11.5px/1.6 var(--mono);color:var(--muted);margin:1px 4px 1px 0}.chip.ok{border-color:#a6e8b8;background:var(--ok-bg);color:var(--ok)}.chip.bad{border-color:#ffc1bc;background:var(--bad-bg);color:var(--bad)}
.hash{font:12px var(--mono);color:var(--faint)}
.kv{display:grid;grid-template-columns:120px 1fr;gap:5px 14px;margin:10px 0 0}.kv dt{color:var(--muted);font-size:13px}.kv dd{margin:0}
.stats{display:flex;gap:18px;flex-wrap:wrap;margin:10px 0}.stat{color:inherit;text-decoration:none}.stat b{font-size:15px;font-weight:600}.stat span{color:var(--muted);font-size:13px;margin-left:5px}
.listbox{border:1px solid var(--line);border-radius:8px;overflow:hidden;margin:12px 0;background:#fff}
.lrow{display:flex;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line2)}.lrow:last-child{border-bottom:0}.lrow:hover{background:var(--subtle)}
.dot{flex:0 0 auto;width:10px;height:10px;border-radius:50%;margin-top:5px}.dot.ok{background:var(--ok)}.dot.warn{background:#d4a72c}.dot.bad{background:var(--bad)}.dot.info{background:var(--info)}.dot.merged{background:var(--merged)}
.lmain{flex:1 1 auto;min-width:0}.ltitle{font-size:14.5px;font-weight:600}.ltitle a{color:var(--ink)}.ltitle a:hover{color:var(--info)}
.lreason{color:var(--ink);margin-top:2px}.lcheck{margin-top:4px;font-size:13px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.cicon{font-weight:700}.cicon.ok{color:var(--ok)}.cicon.bad{color:var(--bad)}.cicon.warn{color:#bf8700}.cicon.merged{color:var(--merged)}
.meter{display:inline-block;width:110px;height:6px;border-radius:3px;background:#eaeef2;overflow:hidden;vertical-align:middle}.meter b{display:block;height:100%;background:var(--info)}.meter.ok b{background:var(--ok)}.meter.bad b{background:var(--bad)}.meter.warn b{background:#d4a72c}
details.qd{margin-top:6px}details.qd summary{cursor:pointer;color:var(--muted);font-size:12.5px;list-style:none}details.qd summary:hover{color:var(--info)}details.qd summary::before{content:"▸  "}
.clef{margin-top:10px}.clef h4{margin:0 0 8px;font-size:13px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.bar{display:grid;grid-template-columns:150px 1fr 44px;align-items:center;gap:10px;font-size:12.5px;margin:4px 0}.bar span:first-child{color:var(--muted)}.bar i{display:block;height:6px;border-radius:3px;background:#eaeef2;overflow:hidden}.bar i b{display:block;height:100%;background:#8c959f}.bar.ok i b{background:var(--ok)}.bar.warn i b{background:#d4a72c}.bar.bad i b{background:var(--bad)}.bar em{font:600 11.5px var(--mono);font-style:normal;text-align:right;color:var(--muted)}
.sub{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);margin:10px 0 2px}
form{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}input{font:inherit;font-size:13px;padding:5px 10px;border:1px solid var(--line);border-radius:6px;background:#fff;min-width:0;flex:1 1 150px}input:focus{outline:2px solid #b6e3ff;border-color:var(--info)}
button,.btn{font:inherit;font-size:13px;font-weight:500;padding:5px 12px;border:1px solid var(--line);border-radius:6px;background:var(--subtle);color:var(--ink);cursor:pointer;white-space:nowrap;display:inline-block}button:hover,.btn:hover{background:#eff1f3;text-decoration:none}button.primary,.btn.primary{background:#1f883d;border-color:rgba(31,35,40,.15);color:#fff}button.primary:hover,.btn.primary:hover{background:#1a7f37}button.danger{background:#fff;color:var(--bad);border-color:var(--line)}button.danger:hover{background:var(--bad-bg)}
.actions{margin-top:10px;border-top:1px solid var(--line2);padding-top:8px}
.files{list-style:none;padding:0;margin:0}.files li{display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line2);font-size:13px}.files li:last-child{border:0}.files li.empty{font:italic 13.5px var(--sans);color:var(--muted)}
.checkrow{display:flex;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line2);font-size:13.5px;flex-wrap:wrap}.checkrow:last-child{border:0}
.mergebox{border:1px solid var(--line);border-radius:8px;padding:16px;margin:16px 0;background:#fff;display:flex;gap:12px;align-items:flex-start}.mergebox .cicon{font-size:18px;line-height:1.3}.mergebox.ok{border-color:#a6e8b8;background:#f0fff4}.mergebox.warn{border-color:#ecd28f;background:#fffdf0}.mergebox.bad{border-color:#ffc1bc;background:#fff5f4}.mergebox p{margin:0}.mergebox .sub2{color:var(--muted);font-size:13px;margin-top:2px}
.timeline{list-style:none;margin:0;padding:0 0 0 18px;border-left:2px solid var(--line2)}.timeline li{position:relative;padding:0 0 14px 6px}.timeline li::before{content:"";position:absolute;left:-25px;top:5px;width:11px;height:11px;border-radius:50%;background:#fff;border:2px solid var(--faint)}.timeline li:last-child{padding-bottom:0}
.hero h1{font-size:30px;max-width:720px;font-weight:600}.hero .lede{font-size:15px}.cta{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
.repostrip{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:4px 0 14px}.reponame{font-size:19px;font-weight:600}.repostats{color:var(--muted);font-size:13px}
.readme-b{padding:20px 24px}.readme-b h1{font-size:26px}.readme-sec{border-top:1px solid var(--line2);padding:14px 0 4px}.readme-sec:first-of-type{border-top:0}.readme-sec h3{font-size:16px}.readme-sec p{color:var(--muted);margin:4px 0 10px;max-width:680px}
.empty{color:var(--muted);font-style:italic}code.token{display:block;font:14px var(--mono);background:#010409;color:#fff;padding:12px;border-radius:8px;margin:10px 0}
footer{color:var(--faint);font-size:12.5px;border-top:1px solid var(--line2);padding-top:14px;margin-top:36px}
@media (max-width:640px){button,.btn{white-space:normal}.top nav a{padding:5px 7px;font-size:13px}main{padding:18px 12px 44px}.wrap{padding:0 12px}h1{font-size:21px}.hero h1{font-size:25px}.kv{grid-template-columns:1fr;gap:0}.kv dd{margin-bottom:7px}.bar{grid-template-columns:100px 1fr 40px;gap:8px}.readme-b{padding:16px}.meter{width:80px}}`;
const REPO_URL = 'https://github.com/ariaxhan/attest';
const html = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const page = (title, body, { refresh = true, active = '', lede = '', hideTitle = false } = {}) => html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="5">' : ''}<title>${escapeHtml(title)} · Attest</title><link rel="stylesheet" href="/styles.css"></head><body><header class="top"><div class="wrap"><a class="mark" href="/">ATTEST</a><nav>${[['/board','Board','board'],['/queue','Verdict Queue','queue'],[REPO_URL,'GitHub','']].map(([h,l,k]) => `<a href="${h}"${k && k === active ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav></div></header><main class="wrap">${hideTitle ? '' : `<h1>${escapeHtml(title)}</h1>`}${lede ? `<p class="lede">${lede}</p>` : ''}${body}</main></body></html>`);
const tone = s => { s = String(s || '').toLowerCase(); return /merged/.test(s) ? 'merged' : /shipped|^ship$|approved|^verified|done|complete|pass|deployed|^ok$/.test(s) ? 'ok' : /reject|unverified|unverdicted|fail|error|outside/.test(s) ? 'bad' : /hold|held|open|wait|token/.test(s) ? 'warn' : /active|running|pending|queued|submitted|verifying/.test(s) ? 'info' : ''; };
const pill = (s, label = s) => `<span class="pill ${tone(s)}">${escapeHtml(label)}</span>`;
const short = v => { v = String(v ?? ''); return `<code class="hash" title="${escapeHtml(v)}">${escapeHtml(v.length > 12 ? v.slice(0, 8) + '…' : v)}</code>`; };
const chips = (list, cls = '') => (list || []).map(x => `<span class="chip ${cls}">${escapeHtml(x)}</span>`).join('');
const parseJson = (v, fallback) => { try { return JSON.parse(v); } catch { return fallback; } };
const pct = p => `${Math.round(Math.max(0, Math.min(1, Number(p) || 0)) * 100)}%`;
const bar = (label, p, t = '') => `<div class="bar ${t}"><span>${escapeHtml(label)}</span><i><b style="width:${pct(p)}"></b></i><em>${pct(p)}</em></div>`;
function clef(probJson, head = '') {
  const a = parseJson(probJson || '{}', {}) || {};
  const yes = k => typeof a[k]?.noul === 'number' ? a[k].noul : null;
  const rows = [];
  for (const [k, label] of [['evidence_complete','Evidence complete'],['scope_respected','Scope respected'],['claims_match','Claims match']]) { const p = yes(k); if (p !== null) rows.push(bar(label, p, p >= .7 ? 'ok' : p >= .4 ? 'warn' : 'bad')); }
  if (a.risk?.probabilities) rows.push(`<div class="sub">Risk · score ${Number(a.risk.score ?? 0).toFixed(2)} / 4</div>` + Object.entries(a.risk.probabilities).map(([k, p]) => bar(a.risk.legend?.[k] || `Risk ${k}`, p, Number(k) >= 3 ? 'bad' : Number(k) === 2 ? 'warn' : 'ok')).join(''));
  if (a.change_kind?.probabilities) rows.push(`<div class="sub">Change kind · ${escapeHtml(a.change_kind.choice)}</div>` + Object.entries(a.change_kind.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, p]) => bar(k, p)).join(''));
  if (a.verdict?.probabilities) rows.push(`<div class="sub">Verdict</div>` + Object.entries(a.verdict.probabilities).map(([k, p]) => bar(k, p, tone(k))).join(''));
  return `<div class="clef">${head}${rows.join('') || '<p class="empty">No Clef distribution recorded.</p>'}</div>`;
}
const detailChips = d => Object.entries(parseJson(d || '{}', {}) || {}).map(([k, v]) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return `<span class="chip">${escapeHtml(k)}: ${escapeHtml(s.length > 90 ? s.slice(0, 87) + '…' : s)}</span>`; }).join('');
const changeLink = changeId => `/changes/${encodeURIComponent(changeId)}`;
const vparse = probJson => parseJson(probJson || '{}', {}) || {};
const vpick = probJson => { const a = vparse(probJson); const probs = a.verdict?.probabilities || {}; const word = a.verdict?.choice || Object.entries(probs).sort((x, y) => y[1] - x[1])[0]?.[0] || ''; return { word, p: Number(probs[word] ?? 0), risk: a.risk?.score }; };
const vicon = word => /ship/i.test(word) ? '<span class="cicon ok">✓</span>' : /reject/i.test(word) ? '<span class="cicon bad">✗</span>' : '<span class="cicon warn">●</span>';
const verdictLine = probJson => { const v = vpick(probJson); if (!v.word) return '<span class="meta">No verdict yet</span>'; return `${vicon(v.word)}<span><b>${escapeHtml(v.word)}</b> \u00B7 ${pct(v.p)}</span>`; };
const reasonText = r => { const s = String(r.reason || ''); if (/unverified/i.test(s)) { const names = s.split(':')[1]?.trim(); return `Missing proof${names ? ` — no ${escapeHtml(names.toLowerCase())} receipt on file` : ''}`; } if (/token|irreversible|class|policy/i.test(s)) return 'This kind of change needs a person\u2019s OK first.'; if (/confidence|verdict/i.test(s)) return 'Clef wasn\u2019t confident enough to merge this alone.'; return escapeHtml(s); };
const reasonLabel = r => { const s = String(r.reason || ''); if (/unverified/i.test(s)) return 'missing proof'; if (/token|irreversible|class|policy/i.test(s)) return 'needs a person'; if (/confidence|verdict/i.test(s)) return 'low confidence'; return s; };
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
  let comments = []; try { comments = (await env.DB.prepare('SELECT body,created_at FROM hold_comments WHERE change_id=? ORDER BY created_at,rowid').bind(changeId).all()).results; } catch { comments = []; }
  const files = await changedFiles(env, row);
  const receiptList = await Promise.all(manifest.evidence_required.map(async requirement => {
    const receipt = receipts.find(r => r.requirement === requirement);
    const verified = !!receipt && !!(await env.RECEIPTS.head(receipt.object_key));
    return `<li><span class="cicon ${verified ? 'ok' : 'bad'}">${verified ? '\u2713' : '\u2717'}</span><span><b>${escapeHtml(requirement)}</b> receipt</span><span class="meta">${verified ? 'Verified' : 'Unverified \u2014 nothing on file'}</span>${verified ? ` <a href="/api/changes/${encodeURIComponent(changeId)}/receipts/${encodeURIComponent(requirement)}">view receipt</a>` : ''}</li>`;
  }));
  const kv = (label, value) => `<dt>${label}</dt><dd>${value}</dd>`;
  const links = [row.deploy_url && `<a class="btn primary" href="${escapeHtml(row.deploy_url)}">Live deployment</a>`, row.preview_url && `<a class="btn" href="${escapeHtml(row.preview_url)}">Preview</a>`].filter(Boolean).join('');
    const mergeBox = row.state === 'merged' ? `<div class="mergebox ok"><span class="cicon ok">\u2713</span><div><p><b>This change was merged automatically.</b></p><p class="sub2">Policy checks passed \u2014 receipts verified and the verdict cleared the bar. No person had to look at it.</p></div></div>` : row.state === 'rejected' ? `<div class="mergebox bad"><span class="cicon bad">\u2717</span><div><p><b>This change was rejected.</b></p><p class="sub2">It will not merge.</p></div></div>` : `<div class="mergebox warn"><span class="cicon warn">\u25CF</span><div><p><b>Waiting for a human.</b></p><p class="sub2">This change is held in the review queue \u2014 it needs an OK from a person. <a href="/queue">Open the review queue</a></p></div></div>`;
  return page('Change View', `<section class="box"><div class="box-b"><div class="row spread"><h3>${escapeHtml(manifest.task)}</h3>${pill(row.state)}</div><dl class="kv">${kv('Project', escapeHtml(row.project))}${kv('Principal', escapeHtml(manifest.principal))}${kv('Agent', escapeHtml(manifest.agent))}${kv('Scope', chips(manifest.scope))}${kv('Change class', escapeHtml(manifest.change_class || 'standard'))}${kv('Submitted', `<span class="meta">${escapeHtml(row.created_at)}</span>`)}${row.deploy_error ? kv('Deploy error', `<span class="pill bad">${escapeHtml(row.deploy_error)}</span>`) : ''}</dl>${links ? `<div class="cta">${links}</div>` : ''}</div></section><section class="box"><div class="box-h">Checks</div><div class="box-b"><ul class="files">${receiptList.join('') || '<li class="empty">No receipts required</li>'}</ul>${verdicts.map(v => `<div class="checkrow"><span class="chip">${escapeHtml(v.model)}</span>${verdictLine(v.probabilities_json)}<span class="meta">${escapeHtml(v.created_at)}</span></div><details class="qd"><summary>Checks details</summary>${clef(v.probabilities_json, `<h4>${pill(v.state)}</h4>`)}${v.error ? `<p class="meta">Error: ${escapeHtml(v.error)}</p>` : ''}</details>`).join('') || '<p class="empty">Awaiting verdict.</p>'}</div></section><h2>Files changed \u00B7 ${files.length}</h2><section class="box"><div class="box-b"><ul class="files">${files.map(f => `<li><span class="pill ${f.status === 'deleted' ? 'bad' : f.status === 'added' ? 'ok' : 'info'}">${escapeHtml(f.status)}</span><span>${escapeHtml(f.path)}</span></li>`).join('') || '<li class="empty">No file changes.</li>'}</ul></div></section><h2>Context trail</h2><section class="box"><div class="box-b"><p class="meta">Task: ${escapeHtml(row.task)} \u00B7 Agent: ${escapeHtml(row.agent)}</p><ol class="timeline">${steps.map(s => `<li><div class="row"><strong>${escapeHtml(s.step)}</strong>${pill(s.state)}<span class="meta">${escapeHtml(s.updated_at)}</span></div><div>${detailChips(s.detail_json)}</div></li>`).join('') || '<li class="empty">No workflow steps yet.</li>'}</ol></div></section>${comments.length ? `<section class="box"><div class="box-h">Reviewer comments</div><div class="box-b">${comments.map(c => `<div class="checkrow"><span>${escapeHtml(c.body)}</span><span class="meta">${escapeHtml(c.created_at)}</span></div>`).join('')}</div></section>` : ''}${mergeBox}`);
}
async function landing(env) {
  const n = async q => (await env.DB.prepare(q).first())?.n ?? 0;
  const [projects, claims, holds, merged] = await Promise.all([n('SELECT COUNT(*) AS n FROM projects'), n("SELECT COUNT(*) AS n FROM tasks WHERE state='active'"), n("SELECT COUNT(*) AS n FROM holds WHERE state='open'"), n("SELECT COUNT(*) AS n FROM changes WHERE state='merged'")]);
  return page('Attest', `<div class="repostrip"><span class="reponame">attest</span><span class="pill info">Public</span><span class="repostats">${projects} projects \u00B7 ${claims} active claims \u00B7 ${holds} open holds \u00B7 ${merged} merged changes</span></div><section class="box"><div class="box-h">README</div><div class="readme-b"><section class="hero"><h1>Coding agents, working together \u2014 with every change checked.</h1><p class="lede">Attest is where AI agents do their coding work. Each agent gets its own copy of the project and says what it is about to change before it starts, so agents never overwrite each other. When a change is done, Attest checks it: did the agent do what it said, and where is the proof? Changes that check out are merged automatically. You only look at the ones that do not.</p><div class="cta"><a class="btn primary" href="/board">See the live board</a><a class="btn" href="/queue">Review queue</a><a class="btn" href="${REPO_URL}">Source on GitHub</a></div></section><div class="readme-sec"><h3>They book their files first</h3><p>Before an agent starts, it reserves the files it plans to touch. If another agent already has them, the new one waits or takes different work. That is how many agents can work on one project at the same time without wrecking each other\u2019s changes.</p></div><div class="readme-sec"><h3>Every change explains itself</h3><p>Each finished change comes with a short note: who asked for it, which agent did it, what it was supposed to do, and the proof it ran \u2014 test results, build logs. A change with no proof does not merge.</p></div><div class="readme-sec"><h3>You only review the problems</h3><p>Every change is scored automatically: did it stay in its lane, does the proof match the claim, how risky is it? Good changes merge on their own. Doubtful ones wait in a queue for you, and the risky kind needs your OK before it lands.</p></div></div></section><footer>Built on Workers, Artifacts, D1, R2, Queues, Workflows, Durable Objects and Workers AI \u00B7 MIT \u00B7 <a href="${REPO_URL}">${REPO_URL.replace('https://', '')}</a> \u00B7 <a href="/api/health">/api/health</a></footer>`, { refresh: false, hideTitle: true });
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
      if (path === '/api/health') return json({ ok: true, service: 'attest' });
      if (['GET', 'HEAD'].includes(request.method) && path === '/styles.css') return new Response(request.method === 'HEAD' ? null : STYLES, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=300' } });
      if (request.method === 'GET' && path === '/') return landing(env);
      const viewMatch = path.match(/^\/changes\/([^/]+)$/);
      if (request.method === 'GET' && viewMatch) return changeView(env, viewMatch[1]);
      if (request.method === 'GET' && path === '/queue') {
        const projectFilter = url.searchParams.get('project');
        const query = "SELECT h.*,c.state AS change_state,c.ref,t.task,t.agent,v.model,v.state AS verdict_state,v.probabilities_json,v.error FROM holds h JOIN changes c ON c.id=h.change_id JOIN tasks t ON t.id=c.task_id LEFT JOIN verdicts v ON v.id=(SELECT id FROM verdicts WHERE change_id=c.id ORDER BY created_at DESC,rowid DESC LIMIT 1) WHERE h.state='open'" + (projectFilter ? ' AND t.project_id=?' : '') + ' ORDER BY h.created_at DESC LIMIT 100';
        const rows = (await (projectFilter ? env.DB.prepare(query).bind(projectFilter) : env.DB.prepare(query)).all()).results;
                const cat = r => /unverified/i.test(r.reason || '') ? 'proof' : /token|irreversible|class|policy/i.test(r.reason || '') ? 'person' : 'conf';
        const nProof = rows.filter(r => cat(r) === 'proof').length, nPerson = rows.filter(r => cat(r) === 'person').length, nConf = rows.length - nProof - nPerson;
        const parts = [nProof && `${nProof} missing proof`, nConf && `${nConf} low-confidence`, nPerson && `${nPerson} need a person\u2019s OK`].filter(Boolean).join(' · ');
        const summary = rows.length ? `<p class="summary"><b>${rows.length} change${rows.length === 1 ? '' : 's'} waiting on you</b>${parts ? ` — ${parts}` : ''}</p>` : '';
        const rowHtml = r => `<div class="lrow"><span class="dot ${/unverified/i.test(r.reason || '') ? 'bad' : 'warn'}"></span><div class="lmain"><div class="row spread"><span class="ltitle"><a href="${changeLink(r.change_id)}">${escapeHtml(r.task)}</a></span><span class="row">${pill(r.change_state)}</span></div><div class="meta">${escapeHtml(r.agent)}</div><div class="lreason"><span class="pill ${tone(r.reason)}">${escapeHtml(reasonLabel(r))}</span> ${reasonText(r)}</div><div class="lcheck">${verdictLine(r.probabilities_json)}</div>${r.error ? `<p class="meta">Error: ${escapeHtml(r.error)}</p>` : ''}<details class="qd"><summary>Checks details</summary>${clef(r.probabilities_json)}</details><div class="actions"><form method="post" action="/holds/${escapeHtml(r.id)}/comment"><input name="comment" placeholder="Add a comment" required><button>Comment</button></form><form method="post" action="/holds/${escapeHtml(r.id)}/approve"><button class="primary">Approve and merge</button></form></div></div></div>`;
        return page('Verdict Queue', summary + (rows.length ? `<div class="listbox">${rows.map(rowHtml).join('')}</div>` : '<p class="empty">No open holds.</p>'), { active: 'queue', lede: 'You review only the exceptions: changes held for missing proof, low-confidence scores, or the risky kinds that need a person\u2019s OK.' });
      }
      if (request.method === 'GET' && path === '/board') {
        const tasks = (await env.DB.prepare("SELECT t.*,p.name AS project FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.state='active' ORDER BY t.created_at DESC LIMIT 100").all()).results;
        const verdicts = (await env.DB.prepare("SELECT v.*,c.state AS change_state,t.task AS task FROM verdicts v JOIN changes c ON c.id=v.change_id JOIN tasks t ON t.id=c.task_id ORDER BY v.created_at DESC,v.rowid DESC LIMIT 20").all()).results;
        const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM holds WHERE state='open'").first();
        const collisions = (await env.DB.prepare('SELECT * FROM claim_conflicts ORDER BY created_at DESC LIMIT 20').all()).results;
                return page('Coordination Board', `<p class="summary"><b>${tasks.length} agent${tasks.length === 1 ? '' : 's'} working right now</b> · ${count.n} change${count.n === 1 ? '' : 's'} waiting for review <span class="meta">· Live, refreshes every 5 seconds</span></p><h2>Active claims</h2>${tasks.length ? `<div class="listbox">${tasks.map(t => `<div class="lrow"><span class="dot info"></span><div class="lmain"><div class="row spread"><span class="ltitle">${escapeHtml(t.task)}</span>${pill(t.state)}</div><div class="meta">${escapeHtml(t.project)} · ${escapeHtml(t.agent)}</div><div class="row">${chips(parseJson(t.scope_json, [t.scope_json]))}</div></div></div>`).join('')}</div>` : '<p class="empty">No active claims.</p>'}<h2>Recent collisions</h2>${collisions.length ? `<div class="listbox">${collisions.map(c => `<div class="lrow"><span class="dot bad"></span><div class="lmain"><div class="row"><span class="pill bad">flagged before fork</span><strong>${escapeHtml(c.agent)}</strong></div><div class="row">${chips(parseJson(c.scope_json, [c.scope_json]))}</div><div class="meta">Conflicted with another claim · ${escapeHtml(c.created_at)}</div></div></div>`).join('')}</div>` : '<p class="empty">No recent collisions.</p>'}<h2>Recent verdicts</h2><div class="box"><div class="box-b"><ul class="files">${verdicts.map(v => `<li>${vicon(v.state)}<a href="${changeLink(v.change_id)}">${escapeHtml(v.task)}</a>${pill(v.state)}${pill(v.change_state)}</li>`).join('') || '<li class="empty">No verdicts yet.</li>'}</ul></div></div>`, { active: 'board', lede: 'Who is working on what, right now. Agents reserve their files before they start, so overlapping work is stopped before it begins \u2014 not discovered in a conflict later.' });
      }
      const actionMatch = path.match(/^\/holds\/([^/]+)\/(approve|comment)$/);
      if (request.method === 'POST' && actionMatch) {
        const hold = await env.DB.prepare('SELECT h.*,c.workflow_id FROM holds h JOIN changes c ON c.id=h.change_id WHERE h.id=?').bind(actionMatch[1]).first();
        if (!hold || hold.state !== 'open') return fail('open hold missing', 404);
        const form = await request.formData();
        if (actionMatch[2] === 'comment') {
          const comment = String(form.get('comment') || '').trim();
          if (!comment) return fail('comment required');
          await env.DB.prepare('CREATE TABLE IF NOT EXISTS hold_comments(id TEXT PRIMARY KEY, hold_id TEXT, change_id TEXT, body TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)').run();
          await env.DB.prepare('INSERT INTO hold_comments(id,hold_id,change_id,body) VALUES(?,?,?,?)').bind(id(), hold.id, hold.change_id, comment).run();
          return Response.redirect(new URL('/queue', request.url), 303);
        }
        const changed = await env.DB.prepare("UPDATE holds SET state='approved',token_hash=NULL,token_plain=NULL,resolved_at=CURRENT_TIMESTAMP WHERE id=? AND state='open'").bind(hold.id).run();
        if (!changed.meta.changes) return fail('hold already resolved', 409);
        const instance = await env.CHANGE_WORKFLOW.get(hold.workflow_id);
        await instance.sendEvent({ type: 'human-resolution', payload: { action: 'approve' } });
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
