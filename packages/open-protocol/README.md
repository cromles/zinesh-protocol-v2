# `@zinesh/open-protocol`

Development extraction of the deterministic Zinesh V2 agreement kernel. The
package contains commands, events, replay, transition guards, participant
authorization and dispute resolution. It performs no I/O and has no runtime
dependencies.

This package is **not licensed for public release yet**. The repository has no
confirmed project-wide FLOS license, and the authorship/rights review remains
open. Do not publish it to a registry or copy it to a public repository until
that review selects and applies a compatible license.

## Verify from a fresh checkout

```sh
cd packages/open-protocol
npm install
npm run typecheck
npm test
npm run pack:check
```

The emitted package artifact contains only compiled protocol files,
declarations, source maps and this documentation. It does not contain or
depend on PostgreSQL, payment gateways, web servers, JWT/JWKS code or the
commercial frontend.

## Minimal use

```ts
import {
  cellKernel,
  makeActorId,
  makeAmount,
  makeCellId,
  makeCommandId,
  makeEventId,
  makeTimestamp,
  nextVersion,
  ZERO_VERSION,
} from '@zinesh/open-protocol';

const cellId = makeCellId('agreement-1');
const initial = cellKernel.evolve(cellId, []);
if ('code' in initial) throw new Error(initial.message);

const result = cellKernel.applyCommand(
  initial,
  {
    commandId: makeCommandId('create-1'),
    cellId,
    type: 'CreateCell',
    payload: {
      payer: makeActorId('payer-1'),
      payee: makeActorId('payee-1'),
      description: 'Deliver the agreed work.',
      amount: makeAmount(10000n),
      currency: 'TRY',
      fundingDeadline: makeTimestamp(2_000_000),
      completionDeadline: makeTimestamp(5_000_000),
    },
  },
  nextVersion(ZERO_VERSION),
  {
    now: makeTimestamp(1_000_000),
    nextEventId: (index) => makeEventId(`create-1-${index}`),
  },
);
```

Persistence-level command-ID idempotency and optimistic concurrency remain
adapter responsibilities. The protocol itself rejects repeated pending
release/refund requests and validates replay version ordering.
