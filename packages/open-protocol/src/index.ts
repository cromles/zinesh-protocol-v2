/**
 * Public, infrastructure-free protocol surface.
 *
 * The build intentionally compiles the authoritative V2 domain sources into
 * this package artifact. It does not import PostgreSQL, HTTP, payment or JWT
 * adapters and introduces no second copy of the state machine.
 */
export * from '../../../src/core/types';
export * from '../../../src/kernel/kernel';
export { cellKernel, cellKernelHandlers } from '../../../src/kernel/state-machine';
