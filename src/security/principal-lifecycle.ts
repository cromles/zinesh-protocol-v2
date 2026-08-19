import type { ActorId, Timestamp } from '../core/types';
import type { Capability, ExternalIdentity, PrincipalRecord, PrincipalType } from './trusted-ingress';

export interface LifecycleContext {
  readonly occurredAt: Timestamp;
  readonly correlationId: string;
}

export interface CreatePrincipalInput {
  readonly principalId: string;
  readonly type: PrincipalType;
  readonly actorId?: ActorId;
  readonly identity: ExternalIdentity;
  readonly capabilities?: ReadonlyArray<Capability>;
  readonly context: LifecycleContext;
}

export type LifecycleResult =
  | { readonly ok: true; readonly principal: PrincipalRecord }
  | { readonly ok: false; readonly kind: 'CONFLICT' | 'NOT_FOUND' | 'INVALID' };

export interface PrincipalLifecycleAuthority {
  create(input: CreatePrincipalInput): Promise<LifecycleResult>;
  get(principalId: string): Promise<PrincipalRecord | null>;
  setEnabled(principalId: string, enabled: boolean, expectedVersion: number, context: LifecycleContext): Promise<LifecycleResult>;
  setActorMapping(principalId: string, actorId: ActorId, expectedVersion: number, context: LifecycleContext): Promise<LifecycleResult>;
  assignCapability(principalId: string, capability: Capability, expectedVersion: number, context: LifecycleContext): Promise<LifecycleResult>;
  revokeCapability(principalId: string, capability: Capability, expectedVersion: number, context: LifecycleContext): Promise<LifecycleResult>;
  attachIdentity(principalId: string, identity: ExternalIdentity, expectedVersion: number, context: LifecycleContext): Promise<LifecycleResult>;
}
