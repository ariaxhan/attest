#!/usr/bin/env python3
"""Three real Attest actors plus the video-script token-gated approval."""
import html
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

BASE = os.environ['ATTEST_URL'].rstrip('/')
REVIEW_SECRET = os.environ['REVIEW_SECRET']
ROOT = Path(__file__).resolve().parents[2]
SNAPSHOTS = ROOT / 'dryrun'
SNAPSHOTS.mkdir(exist_ok=True)

def http(method, path, body=None, form=None, headers=None, raw=False):
    command = ['curl', '-sS', '-m', '40', '-w', '\n%{http_code}', '-X', method]
    for key, value in (headers or {}).items(): command += ['-H', f'{key}: {value}']
    if body is not None: command += ['-H', 'content-type: application/json', '--data', json.dumps(body)]
    if form is not None:
        for key, value in form.items(): command += ['--data-urlencode', f'{key}={value}']
    result = subprocess.run(command + [BASE + path], capture_output=True, text=True, check=True)
    payload, status = result.stdout.rsplit('\n', 1)
    return int(status), payload if raw else json.loads(payload)

def git(*args, cwd, token=None):
    command = ['git'] + (['-c', 'http.extraHeader=Authorization: Bearer ' + token] if token else []) + list(args)
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True)
    if result.returncode: raise RuntimeError(result.stderr.replace(token or '\0', '[redacted]')[:900])
    return result.stdout.strip()

def wait(change_id, states=('merged', 'held'), timeout=240, deploy=False):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status, state = http('GET', '/api/changes/' + change_id)
        if status == 200 and state['state'] in states:
            if deploy and state['state'] == 'merged' and not (state.get('deploy_url') or state.get('deploy_error')): time.sleep(2); continue
            return state
        time.sleep(2)
    raise AssertionError(f'timeout on {change_id}: {state}')

def snapshot(path, filename, marker):
    status, data = http('GET', path, raw=True)
    assert status == 200 and marker in data, (path, status, marker)
    target = SNAPSHOTS / filename
    target.write_text(data)
    print(f'snapshot={target} bytes={len(data)}', flush=True)

def claim(project, manifest):
    status, task = http('POST', f'/api/projects/{project}/tasks', {'manifest': manifest}, headers={'x-review-key': REVIEW_SECRET})
    assert status == 201, (status, task)
    return task

def push(task, manifest, filename, content):
    token = task['token']['plaintext']
    with tempfile.TemporaryDirectory() as parent:
        repo = Path(parent) / 'repo'
        git('clone', '-q', task['remote'], str(repo), cwd=parent, token=token)
        git('config', 'user.name', manifest['agent'], cwd=repo)
        git('config', 'user.email', 'demo@attest.invalid', cwd=repo)
        git('config', 'commit.gpgsign', 'false', cwd=repo)
        dest = repo / filename
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content)
        (repo / 'attest.manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        git('add', '.', cwd=repo)
        git('commit', '-qm', manifest['task'], cwd=repo)
        ref = git('rev-parse', 'HEAD', cwd=repo)
        git('push', 'origin', 'HEAD:main', cwd=repo, token=token)
        return ref

def submit(task, manifest, ref, receipts):
    status, change = http('POST', '/api/changes', {'task_id': task['id'], 'repo': task['fork'], 'ref': ref, 'manifest': manifest, 'receipts': receipts}, headers={'x-review-key': REVIEW_SECRET})
    assert status == 202, (status, change)
    return change['id']

def approve(state, reviewer_key):
    hold = next(h for h in state['holds'] if h['state'] == 'open')
    status, page = http('POST', f'/holds/{hold["id"]}/issue', form={'review_key': reviewer_key}, raw=True)
    assert status == 200, (status, page[:200])
    token = html.unescape(re.search(r'<code>([^<]+)</code>', page).group(1))
    status, _ = http('POST', f'/holds/{hold["id"]}/approve', form={'token': token}, raw=True)
    assert status == 303, status
    return wait(state['id'], states=('merged',), deploy=True)

def live(url, marker):
    deadline = time.time() + 90
    while time.time() < deadline:
        result = subprocess.run(['curl', '-sS', '-m', '30', '-w', '\n%{http_code}', url], capture_output=True, text=True, check=True)
        body, code = result.stdout.rsplit('\n', 1)
        if code == '200' and marker in body:
            print(f'curl={url} status=200 marker={marker}', flush=True)
            return
        time.sleep(2)
    raise AssertionError((url, code, body[:100]))

def manifest(agent, task, scope, evidence=None, change_class=None):
    result = {'task': task, 'principal': 'aria', 'agent': agent, 'scope': scope, 'evidence_required': ['test-log'] if evidence is None else evidence}
    if change_class: result['change_class'] = change_class
    return result

def main():
    tag = time.strftime('%Y%m%d%H%M%S', time.gmtime())
    repo_name = f'attest-dryrun-{tag}'
    reviewer_key = REVIEW_SECRET
    demo_policy = {'verdict':'ship', 'min_confidence':0.6, 'max_risk':2, 'min_evidence_complete':0.9}
    status, project = http('POST', '/api/projects', {'name': repo_name, 'policy': demo_policy}, headers={'x-review-key': reviewer_key})
    assert status == 201, (status, project)
    project_id = project['id']
    print(f'project={repo_name} id={project_id} policy={demo_policy}', flush=True)
    status, seed = http('POST', f'/api/projects/{project_id}/bootstrap', headers={'x-review-key': reviewer_key})
    assert status == 200, (status, seed)
    with tempfile.TemporaryDirectory() as parent:
        repo = Path(parent) / 'repo'
        git('clone', '-q', seed['remote'], str(repo), cwd=parent, token=seed['token']['plaintext'])
        git('config', 'user.name', 'Attest demo seed', cwd=repo)
        git('config', 'user.email', 'seed@attest.invalid', cwd=repo)
        git('config', 'commit.gpgsign', 'false', cwd=repo)
        (repo / 'src').mkdir()
        (repo / 'src/worker.js').write_text("export default { fetch() { return new Response('ATTEST-BASELINE'); } };\n")
        (repo / 'README.md').write_text('# Attest demo Worker\n\nChanges flow through Attest.\n')
        git('add', '.', cwd=repo)
        git('commit', '-qm', 'Seed demo Worker', cwd=repo)
        git('push', 'origin', 'HEAD:main', cwd=repo, token=seed['token']['plaintext'])
    print('step1=PASS seeded real Artifacts repo', flush=True)

    a = manifest('Agent A feature', 'Add live feature marker', ['src/'])
    b_overlap = manifest('Agent B collision', 'Overlapping feature attempt', ['src/worker.js'])
    b = manifest('Agent B collision', 'Add rerouted documentation', ['docs/'])
    c = manifest('Agent C evidence failure', 'Add evidence checklist without test log', ['tests/'])
    task_a = claim(project_id, a)
    status, conflict = http('POST', f'/api/projects/{project_id}/tasks', {'manifest': b_overlap}, headers={'x-review-key': reviewer_key})
    assert status == 409 and conflict.get('conflicting_task') == task_a['id'], (status, conflict)
    task_b = claim(project_id, b)
    task_c = claim(project_id, c)
    print(f'step2=PASS forks={task_a["fork"]},{task_b["fork"]},{task_c["fork"]}; manifests issued', flush=True)
    print(f'step3=PASS Agent B conflict={conflict["conflicting_task"]} before fork; rerouted=docs/', flush=True)
    snapshot('/board', 'coordination-board-claims.html', 'Agent B collision')
    assert 'Flagged before fork' in (SNAPSHOTS / 'coordination-board-claims.html').read_text()

    marker = f'ATTEST-FEATURE-{tag}'
    with ThreadPoolExecutor(max_workers=3) as actors:
        refs = [actors.submit(push, task_a, a, 'src/worker.js', f"export default {{ fetch() {{ return new Response('{marker}'); }} }};\n"),
                actors.submit(push, task_b, b, 'docs/feature.md', f'# Rerouted agent documentation {tag}\n'),
                actors.submit(push, task_c, c, 'tests/checklist.md', '# Test plan claimed; test log deliberately absent.\n')]
        ref_a, ref_b, ref_c = [future.result() for future in refs]
    change_a = submit(task_a, a, ref_a, {'test-log': 'PASS: curl fixture and source marker validated'})
    state_a = wait(change_a, deploy=True)
    assert state_a['state'] == 'merged' and state_a['deploy_url'], state_a
    live(state_a['deploy_url'], marker)
    assert state_a['preview_url'], state_a
    live(state_a['preview_url'], marker)
    snapshot('/changes/' + change_a, 'change-view-feature.html', 'Change View')

    change_b = submit(task_b, b, ref_b, {'test-log': 'PASS: docs content and link reviewed'})
    state_b = wait(change_b, deploy=True)
    if state_b['state'] == 'held':
        print(f'Agent B policy hold={state_b["holds"][0]["reason"]}; approving rerouted work', flush=True)
        state_b = approve(state_b, reviewer_key)
    assert state_b['state'] == 'merged' and state_b['deploy_url'], state_b
    live(state_b['deploy_url'], marker)

    change_c = submit(task_c, c, ref_c, {})
    state_c = wait(change_c)
    assert state_c['state'] == 'held' and state_c['evidence_state'] == 'UNVERIFIED', state_c
    assert 'test-log' in state_c['holds'][0]['reason'], state_c
    print(f'step4=PASS A/B merged; C held={state_c["holds"][0]["reason"]}; verdict models={len(state_c["verdicts"])}', flush=True)
    print(f'step5=PASS live={state_a["deploy_url"]} preview={state_a["preview_url"]}', flush=True)
    snapshot('/changes/' + change_c, 'change-view-evidence.html', 'UNVERIFIED')

    d = manifest('Agent A feature', 'Request production deploy approval', ['ops/'], [], 'production deploy')
    task_d = claim(project_id, d)
    ref_d = push(task_d, d, 'ops/deploy.txt', 'Production deploy requested through one-time token.\n')
    change_d = submit(task_d, d, ref_d, {})
    state_d = wait(change_d)
    assert state_d['state'] == 'held' and 'token-gated class' in state_d['holds'][0]['reason'], state_d
    status, queue = http('GET', '/queue?project=' + project_id, raw=True)
    assert status == 200 and queue.count('<article>') == 2 and 'UNVERIFIED receipts: test-log' in queue and 'token-gated class: production deploy' in queue
    snapshot('/queue?project=' + project_id, 'verdict-queue-two-holds.html', 'token-gated class: production deploy')
    print(f'step6=PASS exactly expected project holds C={change_c} deploy={change_d}; token approval follows', flush=True)
    state_d = approve(state_d, reviewer_key)
    live(state_d['deploy_url'], marker)
    status, remaining = http('GET', '/queue?project=' + project_id, raw=True)
    assert status == 200 and remaining.count('<article>') == 1 and 'UNVERIFIED receipts: test-log' in remaining
    print(f'token_approval=PASS change={change_d} state=merged', flush=True)
    snapshot('/board', 'coordination-board-final.html', 'Recent collisions')
    snapshot('/changes/' + change_d, 'change-view-approved.html', 'Change View')
    print('DRY RUN PASS', flush=True)

if __name__ == '__main__': main()
