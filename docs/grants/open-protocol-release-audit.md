# Open protocol release audit

Status: blocked for public release as of 19 October 2026.

## Code ownership

The extracted build uses `src/core/types.ts`, `src/kernel/kernel.ts` and
`src/kernel/state-machine.ts`. Git history attributes commits touching these
paths to Yasin Karademir and `Cursor Agent`. Agent attribution alone does not
establish who owns the generated or edited expression. Before release, the
applicant must retain evidence that all contributors had authority to license
the work, including the applicable AI tool terms and any contractor/employment
agreements.

## Package boundary

`packages/open-protocol/package.json` declares zero runtime dependencies. Its
TypeScript build graph is limited to the public entry point and the three
authoritative protocol source files. PostgreSQL, payment confirmation,
transport, JWT/JWKS, frontend and composition modules are not compiled into
the package.

## Dependency licensing

Development dependencies are TypeScript and `@types/node`, plus their locked
transitive dependencies. Their package metadata must be captured and reviewed
against the selected release license. This audit must be repeated whenever the
lockfile changes.

The package-local lock currently resolves TypeScript 5.9.3 (declared
Apache-2.0), `@types/node` 22.20.5 (declared MIT) and `undici-types` 6.21.0
(declared MIT). `packages/open-protocol/DEPENDENCY_LICENSES.md` records the
inventory; human verification of the corresponding license texts remains a
release gate.

The parent V2 repository contains other dependencies, but they are not runtime
dependencies or packed files of `@zinesh/open-protocol`.

## Decision

- Apache-2.0: not applied.
- Public package registry publication: not authorized.
- New public repository transfer: not authorized.
- Allowed now: private development branch, tests, build artifact inspection
  and pull-request review inside the existing repository.

Release is unblocked only after a human signs off code ownership, dependency
licenses, third-party notices, chosen FLOS license text and NLnet AI
provenance.
