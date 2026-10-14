# Source and AI provenance

Status: development record for review; not a license grant.

## Authoritative source

The package build compiles these existing V2 files without modifying their
commercial call sites:

- `src/core/types.ts`
- `src/kernel/kernel.ts`
- `src/kernel/state-machine.ts`

Git history visible on 14 October 2026 attributes changes in those paths to
Yasin Karademir and `Cursor Agent`. A bot/agent commit identity is not proof of
copyright ownership or permission. Yasin Karademir must verify the underlying
human authorship, employment/contract status, tool terms and redistribution
rights before public release.

## Dependency review

The package manifest has no runtime dependencies. Its development-only tools
are TypeScript and `@types/node`; their exact transitive licenses must be
captured from the generated lockfile and reviewed before release. The full V2
application's PostgreSQL, React, Vite, Jest and web dependencies are outside
the package artifact.

No Apache-2.0 or other license is applied by this extraction. License selection
is deliberately blocked pending the rights and dependency audit.

## AI assistance record for this extraction

- Tool: OpenAI Codex in ChatGPT Work Mode.
- Date: 14 October 2026.
- Requested task: extract the deterministic V2 kernel into an independent
  TypeScript package; exclude PostgreSQL/payment/web dependencies; add tests;
  preserve V2; audit licensing; document AI assistance; prepare a branch and
  pull request.
- Contribution: package/build configuration, public entry point, focused
  protocol tests, documentation and audit notes.
- Human review required: correctness, security, authorship, licensing, grant
  claims and all release decisions.

The complete original user prompt and unedited assistant/tool transcript must
be exported from the actual ChatGPT conversation if NLnet requires submission.
This summary is not a substitute and does not reconstruct hidden reasoning or
missing historical logs.
