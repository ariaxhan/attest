#!/usr/bin/env python3
"""Live Monday smoke: three changes, Git readback, and HTML snapshots."""
import json, os, subprocess, tempfile, time, urllib.request, urllib.error
BASE = os.environ['ATTEST_URL'].rstrip('/')
REVIEW_SECRET = os.environ['REVIEW_SECRET']

def call(method, path, body=None):
    command = ['curl','-sS','-m','30','-w','\n%{http_code}','-X',method,BASE+path]
    if body is not None: command += ['-H','content-type: application/json','-H','x-review-key: '+REVIEW_SECRET,'--data',json.dumps(body)]
    p = subprocess.run(command,capture_output=True,text=True,check=True)
    payload,code = p.stdout.rsplit('\n',1)
    return int(code),json.loads(payload)

def git(*args, cwd, token=None):
    command = ['git'] + (['-c', 'http.extraHeader=Authorization: Bearer ' + token] if token else []) + list(args)
    p = subprocess.run(command, cwd=cwd, capture_output=True, text=True)
    if p.returncode: raise RuntimeError(p.stderr.replace(token or '\0', '[redacted]')[:600])
    return p.stdout.strip()

def wait(change_id, desired, timeout=100):
    for _ in range(timeout // 2):
        status, state = call('GET', '/api/changes/' + change_id)
        if status == 200 and state['state'] in desired: return state
        time.sleep(2)
    raise AssertionError((status, state))

name = 'attest-mon-' + str(int(time.time()))
status, project = call('POST', '/api/projects', {'name':name}); assert status == 201, (status,project)
print(f'project={project["id"]} repo={name}', flush=True)

for label, scope, receipts in [
    ('clean', ['src/health.js'], {'test-log':'12/12 passing; health endpoint tested'}),
    ('missing', ['src/missing.js'], {}),
    ('ambiguous', ['src/ambiguous.js','src/shared'], {'test-log':'tests inconclusive; shared behavior may be changed outside the claimed scope; human review requested'}),
]:
    task_text = 'Ambiguous scope: possibly alters shared behavior outside claimed paths; request human review' if label == 'ambiguous' else f'{label} health change'
    manifest = {'task':task_text,'principal':'aria','agent':f'smoke-{label}','scope':scope,'evidence_required':['test-log']}
    status, task = call('POST',f'/api/projects/{project["id"]}/tasks',{'manifest':manifest}); assert status == 201, (status,task)
    token = task['token']['plaintext']
    with tempfile.TemporaryDirectory() as parent:
        root = os.path.join(parent,'repo')
        git('clone','-q',task['remote'],root,cwd=parent,token=token)
        git('config','user.name','Attest smoke',cwd=root)
        git('config','user.email','smoke@attest.invalid',cwd=root)
        git('config','commit.gpgsign','false',cwd=root)
        os.makedirs(os.path.join(root,'src'),exist_ok=True)
        with open(os.path.join(root,'attest.manifest.json'),'w') as out: json.dump(manifest,out)
        with open(os.path.join(root,scope[0]),'w') as out: out.write(f'export const {label} = true;\n')
        git('add','.',cwd=root); git('commit','-qm',f'{label} change',cwd=root)
        ref = git('rev-parse','HEAD',cwd=root)
        git('push','origin','HEAD:main',cwd=root,token=token)
    status, change = call('POST','/api/changes',{'task_id':task['id'],'repo':task['fork'],'ref':ref,'manifest':manifest,'receipts':receipts}); assert status == 202,(status,change)
    state = wait(change['id'], {'held','merged'})
    verdicts = [state['verdict']]
    print(f'{label}: change={change["id"]} state={state["state"]} evidence={state["evidence_state"]} verdict={state["verdict"]["state"]} model={state["verdict"].get("model")} error={state["verdict"].get("error")} steps={len(state["steps"])}',flush=True)
    if label == 'clean':
        assert state['state'] == 'merged',state
    elif label == 'missing':
        assert state['evidence_state'] == 'UNVERIFIED' and state['state'] == 'held',state
    else:
        assert [v['model'] for v in state['verdicts']] == ['clef','clef-flash'],state
    if label == 'clean':
        status, history = call('GET',f'/api/projects/{project["id"]}/log')
        assert status == 200 and (history[0].get('hash') or history[0].get('oid')) == ref,(status,history)
        print(f'project_main_readback={ref}',flush=True)

for path, filename in [('/queue','verdict-queue.html'),('/board','coordination-board.html')]:
    html = subprocess.run(['curl','-fsS','-m','30',BASE+path],capture_output=True,text=True,check=True).stdout
    assert '<!doctype html>' in html and len(html) > 500
    if path == '/queue': assert 'review_key' in html and 'token_plain' not in html
    with open(os.path.join(os.path.dirname(__file__),'..',filename),'w') as out: out.write(html)
    print(f'snapshot={filename} bytes={len(html)}',flush=True)
print('SMOKE 2 PASS',flush=True)
