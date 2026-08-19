/**
 * ZINESH PROTOCOL V2 — Clock
 *
 * Application owns wall-clock access. Kernel receives time only through
 * DeterministicContext.now (and, for a few commands, payload.currentTime
 * which Application aligns to that same value).
 *
 * Date.now() is permitted here. It must never appear in src/kernel/.
 */

import { makeTimestamp } from '../core/types';
import type { Timestamp } from '../core/types';

export interface Clock {
  now(): Timestamp;
}

/** Production clock. Converts Date.now() through makeTimestamp. */
export function systemClock(): Clock {
  return {
    now(): Timestamp {
      return makeTimestamp(Date.now());
    },
  };
}

/** Deterministic clock for tests. Always returns the supplied timestamp. */
export function fixedClock(at: Timestamp): Clock {
  return {
    now(): Timestamp {
      return at;
    },
  };
}
