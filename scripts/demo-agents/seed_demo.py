#!/usr/bin/env python3
"""Idempotently seed the clean attest-demo Artifacts project for recording."""
from pathlib import Path
import tempfile
from run import REVIEW_SECRET, http, git

name = 'attest-demo'
status, projects = http('GET', '/api/projects')
assert status == 200
project = next((item for item in projects if item['name'] == name), None)
if project is None:
    status, project = http('POST', '/api/projects', {'name': name}, headers={'x-review-key': REVIEW_SECRET})
    assert status == 201, (status, project)
status, history = http('GET', f'/api/projects/{project["id"]}/log')
assert status == 200
if history:
    print(f'project={name} id={project["id"]} already-seeded head={history[0].get("hash") or history[0].get("oid")}')
else:
    key = REVIEW_SECRET
    status, seed = http('POST', f'/api/projects/{project["id"]}/bootstrap', headers={'x-review-key': key})
    assert status == 200, (status, seed)
    token = seed['token']['plaintext']
    with tempfile.TemporaryDirectory() as parent:
        repo = Path(parent) / 'repo'
        git('clone', '-q', seed['remote'], str(repo), cwd=parent, token=token)
        git('config', 'user.name', 'Attest demo seed', cwd=repo)
        git('config', 'user.email', 'seed@attest.invalid', cwd=repo)
        git('config', 'commit.gpgsign', 'false', cwd=repo)
        (repo / 'src').mkdir()
        (repo / 'src/worker.js').write_text("export default { fetch() { return new Response('ATTEST-DEMO-READY'); } };\n")
        (repo / 'README.md').write_text('# Attest demo\n\nA small Cloudflare Worker. Agents claim scopes and deliver changes through Attest.\n')
        git('add', '.', cwd=repo)
        git('commit', '-qm', 'Seed clean demo Worker', cwd=repo)
        head = git('rev-parse', 'HEAD', cwd=repo)
        git('push', 'origin', 'HEAD:main', cwd=repo, token=token)
    print(f'project={name} id={project["id"]} seeded head={head}')
