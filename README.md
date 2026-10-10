# Attest

Attest is a change control plane for parallel coding agents. Agents claim file scopes before work, receive isolated Git forks and short lived write tokens, and submit an intent manifest with evidence. A Cloudflare Workflow checks the committed ref, changed paths, and R2 receipts, asks Clef for a scored verdict, then merges an eligible change or places it in a human review queue. The coordination board exposes claims and collisions before agents overwrite one another.

The public repository is a single source import commit from the contest build; the live build's development history and proof receipts are separate.

## Architecture

| Primitive | Role |
| --- | --- |
| Worker | HTTP API, board, review queue, change view |
| Artifacts | Project repos, task forks, scoped Git tokens and history |
| Queue | Asynchronous change intake |
| Workflow | Evidence, verdict, policy, merge and demo deploy steps |
| D1 | Projects, tasks, changes, verdicts, holds and workflow trail |
| R2 | Evidence receipt bodies |
| Durable Object | Per-project coordination state |
| Workers AI Clef | Flash verdict, full Clef second opinion when flagged |

## Prerequisites

- Cloudflare account with Workers Paid, Artifacts, Workers AI, D1, R2, Queues and Workflows access.
- Node.js/npm, Python 3, Git and curl. `npm ci` installs the project dependency. Install [Wrangler 4](https://developers.cloudflare.com/workers/wrangler/install-and-update/) separately or run it with `npx wrangler`.
- A Cloudflare API token for Wrangler resource creation and deployment. Demo deploys also need a token authorized to edit Workers Scripts and workers.dev routes; install that token as a Worker secret. Keep token values outside this repository.

## Deploy your own instance

Use a unique lowercase suffix, such as `myname-2026`, for every resource. These commands run from the repository root. Set `CLOUDFLARE_API_TOKEN` in your shell using your own secret manager; do not put it in a checked-in file.

```sh
npm ci
cp wrangler.toml.example wrangler.toml
npx wrangler d1 create attest-myname-2026
npx wrangler r2 bucket create attest-myname-2026-receipts
npx wrangler queues create attest-myname-2026-events
```

Edit `wrangler.toml` in one pass: replace `attest-example` in the Worker, Artifacts namespace, D1, R2, Queue and Workflow names with your unique suffix; replace `YOUR_CLOUDFLARE_ACCOUNT_ID` with your account ID and `YOUR_D1_DATABASE_ID` with the UUID printed by `d1 create`. The Artifacts namespace is provisioned through its Worker binding. Keep the binding names and class names intact. `wrangler.toml` is ignored by Git because it identifies your account and resources.

```sh
npx wrangler d1 migrations apply attest-myname-2026 --remote
npx wrangler deploy
npx wrangler secret put REVIEW_SECRET
npx wrangler secret put DEMO_DEPLOY_TOKEN
```

At each secret prompt, paste a different value. `REVIEW_SECRET` is an owner/reviewer key you generate; use the same value in your local shell for the test scripts. `DEMO_DEPLOY_TOKEN` is a Cloudflare API token with Worker script and workers.dev route edit permissions for the demonstration deployments. `CLOUDFLARE_API_TOKEN` remains a shell credential for Wrangler and is never a Worker binding. The deploy output prints the Worker URL. Set `ATTEST_URL` to that URL and `REVIEW_SECRET` to your locally held reviewer key, then check `curl "$ATTEST_URL/"` for `{"ok":true,"service":"attest"}`. `.env.example` lists the variable names; it contains no values.

## Exercise the system

```sh
python3 scripts/smoke.py
python3 scripts/smoke2.py
python3 scripts/demo-agents/run.py
```

The scripts read `ATTEST_URL` and `REVIEW_SECRET` from the environment. `smoke.py` checks project creation, pre-work scope collision, fork push and missing-receipt hold. `smoke2.py` checks a merge, evidence hold, Clef escalation, project-main readback, and UI snapshots. The demo creates a new `attest-dryrun-*` project, runs three agents, verifies the collision/reroute and evidence hold, tests live/preview Workers, then uses a one-time reviewer token for a gated deploy. It writes HTML snapshots under `dryrun/`. Each run creates new Artifacts repos and D1 records. `seed_demo.py` is optional; it seeds a separate `attest-demo` project for recording.

## Policy and review

The default policy requires a `ship` verdict with confidence at least **0.85**, risk at most **2**, and deterministic receipt completeness at least **0.9**. Missing required R2 receipts are labeled `UNVERIFIED` and held. Changed files outside the claimed scope are held. A low confidence, hold, or high risk Flash answer triggers full Clef; model failures leave an unverdicted hold. Production deploy and other token-gated change classes always require a human action in `/queue`. A reviewer enters the key to issue a one-time approval token or reject with a reason. The demo uses an explicitly supplied project policy with a **0.6** confidence floor to keep the live scenario repeatable; ordinary projects retain 0.85.

## Limitations

- Owner access to the HTTP API uses the shared `REVIEW_SECRET` header/key; it is not per-user identity or a production-grade authorization service.
- Artifacts' Worker binding does not write Git refs. Attest clones the fork in memory, checks the submitted head and project-main ancestry, pushes with a project-scoped token, then reads back project main. The merge is Git push based, not an Artifacts transaction.
- Clef score questions require a list of level descriptions in `criteria`; choice questions use criteria maps. The model's evidence probability is retained, while the merge gate uses the deterministic R2 receipt fraction.
- The demo deploy path uploads `src/worker.js` to Workers Scripts. It is intentionally a narrow proof path, not a general build pipeline or sandbox for arbitrary repository code.
