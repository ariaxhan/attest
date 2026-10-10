#!/usr/bin/env python3
"""Deployed Attest core smoke. Requires git and network; prints no tokens."""
import json
import os
import subprocess
import tempfile
import time

BASE = os.environ['ATTEST_URL'].rstrip('/')
REVIEW_SECRET = os.environ['REVIEW_SECRET']

def call(method, path, body=None):
    command = ['curl', '-sS', '-m', '30', '-w', '\n%{http_code}', '-X', method, BASE + path]
    if body is not None:
        command += ['-H', 'content-type: application/json', '-H', 'x-review-key: ' + REVIEW_SECRET, '--data', json.dumps(body)]
    result = subprocess.run(command, capture_output=True, text=True, check=True)
    payload, code = result.stdout.rsplit('\n', 1)
    return int(code), json.loads(payload)

def git(*args, cwd, token=None):
    command = ['git']
    if token:
        command += ['-c', 'http.extraHeader=Authorization: Bearer ' + token]
    command += list(args)
    result = subprocess.run(command, cwd=cwd, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.replace(token or '\0', '[redacted]')[:500])
    return result.stdout.strip()

name = 'attest-smoke-' + str(int(time.time()))
status, project = call('POST', '/api/projects', {'name': name})
assert status == 201, (status, project)
print(f'1 project 201 id={project["id"]} repo={project["repo"]}')
manifest = {'task': 'Add health endpoint', 'principal': 'aria', 'agent': 'smoke-agent', 'scope': ['src/health.js'], 'evidence_required': ['test-log']}
status, task = call('POST', '/api/projects/' + project['id'] + '/tasks', {'manifest': manifest})
assert status == 201, (status, task)
print(f'2 claim 201 id={task["id"]} fork={task["fork"]} token=issued')
status, conflict = call('POST', '/api/projects/' + project['id'] + '/tasks', {'manifest': {**manifest, 'agent': 'overlap-agent'}})
assert status == 409 and conflict['error'] == 'scope conflict', (status, conflict)
print(f'3 overlap 409 conflicting_task={conflict["conflicting_task"]}')
token = task['token']['plaintext']
with tempfile.TemporaryDirectory() as root:
    git('init', '-q', '-b', 'main', cwd=root)
    git('config', 'user.name', 'Attest smoke', cwd=root)
    git('config', 'user.email', 'smoke@attest.invalid', cwd=root)
    git('config', 'commit.gpgsign', 'false', cwd=root)
    with open(os.path.join(root, 'attest.manifest.json'), 'w') as out:
        json.dump(manifest, out, indent=2)
        out.write('\n')
    os.makedirs(os.path.join(root, 'src'))
    with open(os.path.join(root, 'src', 'health.js'), 'w') as out:
        out.write('export const health = () => ({ ok: true });\n')
    git('add', 'attest.manifest.json', 'src/health.js', cwd=root)
    git('commit', '-qm', 'Add health endpoint with intent manifest', cwd=root)
    ref = git('rev-parse', 'HEAD', cwd=root)
    git('remote', 'add', 'origin', task['remote'], cwd=root)
    git('push', '-u', 'origin', 'main', cwd=root, token=token)
print(f'4 fork push manifest=attest.manifest.json ref={ref[:12]}')
status, change = call('POST', '/api/changes', {'task_id': task['id'], 'repo': task['fork'], 'ref': ref, 'manifest': manifest})
assert status == 202, (status, change)
print(f'5 change 202 id={change["id"]} missing_receipt=test-log')
for attempt in range(30):
    status, state = call('GET', '/api/changes/' + change['id'])
    if status == 200 and state['state'] == 'held':
        break
    time.sleep(2)
assert status == 200 and state['state'] == 'held', (status, state)
assert state['evidence_state'] == 'UNVERIFIED', state
assert state['verdict']['state'] in ('ship', 'hold-for-human', 'reject', 'unverdicted'), state
assert len(state['steps']) == 5, state
assert len(state['holds']) == 1, state
print(f'6 workflow steps={len(state["steps"])} verdict={state["verdict"]["state"]} evidence=UNVERIFIED hold=1')
print('SMOKE PASS')
