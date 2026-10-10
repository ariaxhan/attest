# Future work

The October demo build is deliberately bounded. These parts of spec §2 are deferred:

- Import an existing Git repository into Artifacts. The demo creates repos in Attest.
- Consume Artifacts push events automatically. Agents submit pushed refs to the Attest API, which enqueues the Workflow.
- Verify the committed `attest.manifest.json` against D1 at intake, and require authenticated HTTP agent identities. Fork-scoped Git tokens already protect pushes; the HTTP API needs its own auth boundary.
- Store the agent's full versioned instructions, memory, and reasoning handoff in Git history. The current context trail includes manifest identity and timestamped Workflow steps.
- Expand the file summary into a richer Git diff and check claims against file contents. The current view lists changed paths and status, and Clef sees those paths.
- Stream Board updates through the project Durable Object. The demo Board polls every five seconds.
- Manage preview retention and cleanup. Each nonmerged preview gets its own Worker script and URL.

The spec explicitly excludes blame views, syntax themes, stars, follows, general issue tracking, self-hosting, and broad GitHub import. Those remain outside the demo build.
