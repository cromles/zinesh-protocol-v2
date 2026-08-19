/**
 * ZINESH PROTOCOL V2 — Event ID factory
 *
 * Application owns event ID generation. Kernel only calls
 * context.nextEventId(index) and never generates IDs itself.
 *
 * For a single command, index 0, 1, … must yield distinct EventId values.
 * Factory instance state is allowed; Kernel global mutable state is not.
 */

import { makeEventId } from '../core/types';
import type { EventId } from '../core/types';

export interface EventIdFactory {
  nextEventId(index: number): EventId;
}

/**
 * Monotonic factory. Distinct IDs per call; index is included so a
 * multi-event command is visually grouped without relying on randomness.
 */
export function createEventIdFactory(prefix = 'evt'): EventIdFactory {
  let sequence = 0;
  return {
    nextEventId(index: number): EventId {
      sequence += 1;
      return makeEventId(`${prefix}-${sequence}-${index}`);
    },
  };
}
