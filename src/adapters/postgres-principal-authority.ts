import type { Pool, PoolClient } from 'pg';
import { makeActorId } from '../core/types';
import type { ActorId } from '../core/types';
import type {
  Capability, ExternalIdentity, PrincipalAuthority, PrincipalRecord, PrincipalType,
} from '../security/trusted-ingress';
import type {
  CreatePrincipalInput, LifecycleContext, LifecycleResult, PrincipalLifecycleAuthority,
} from '../security/principal-lifecycle';

interface PrincipalRow {
  principal_id: string; principal_type: PrincipalType; actor_id: string | null;
  enabled: boolean; mapping_version: string;
}

function persistenceConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    ['23505', '23514', '23503'].includes(String((error as { code: unknown }).code));
}

export class PostgresPrincipalAuthority implements PrincipalAuthority, PrincipalLifecycleAuthority {
  constructor(private readonly pool: Pool) {}

  async resolve(identity: ExternalIdentity): Promise<PrincipalRecord | null> {
    const result = await this.pool.query<PrincipalRow>(
      `SELECT p.principal_id,p.principal_type,p.actor_id,p.enabled,p.mapping_version
       FROM external_identities e JOIN principals p ON p.principal_id=e.principal_id
       WHERE e.issuer=$1 AND e.subject=$2`, [identity.issuer, identity.subject],
    );
    return result.rows[0] === undefined ? null : this.toRecord(this.pool, result.rows[0]);
  }

  async get(principalId: string): Promise<PrincipalRecord | null> {
    const result = await this.pool.query<PrincipalRow>(
      `SELECT principal_id,principal_type,actor_id,enabled,mapping_version
       FROM principals WHERE principal_id=$1`, [principalId],
    );
    return result.rows[0] === undefined ? null : this.toRecord(this.pool, result.rows[0]);
  }

  async create(input: CreatePrincipalInput): Promise<LifecycleResult> {
    if (!this.validCreate(input)) return { ok: false, kind: 'INVALID' };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO principals(principal_id,principal_type,actor_id,enabled,mapping_version)
         VALUES($1,$2,$3,TRUE,1)`, [input.principalId, input.type, input.actorId ?? null],
      );
      await client.query(
        'INSERT INTO external_identities(issuer,subject,principal_id) VALUES($1,$2,$3)',
        [input.identity.issuer, input.identity.subject, input.principalId],
      );
      for (const capability of input.capabilities ?? []) {
        await client.query(
          'INSERT INTO principal_capabilities(principal_id,capability) VALUES($1,$2)',
          [input.principalId, capability],
        );
      }
      await this.audit(client, input.principalId, input.type, input.actorId ?? null,
        'CREATE', 1, null, input.context);
      await client.query('COMMIT');
      return { ok: true, principal: (await this.get(input.principalId))! };
    } catch (error) {
      await client.query('ROLLBACK');
      if (persistenceConflict(error)) return { ok: false, kind: 'CONFLICT' };
      throw error;
    } finally { client.release(); }
  }

  setEnabled(principalId: string, enabled: boolean, expectedVersion: number, context: LifecycleContext) {
    return this.mutate(principalId, expectedVersion, context, enabled ? 'ENABLE' : 'DISABLE', null,
      async (client) => client.query(
        `UPDATE principals SET enabled=$3,mapping_version=mapping_version+1
         WHERE principal_id=$1 AND mapping_version=$2`, [principalId, expectedVersion, enabled],
      ));
  }

  setActorMapping(principalId: string, actorId: ActorId, expectedVersion: number, context: LifecycleContext) {
    return this.mutate(principalId, expectedVersion, context, 'ACTOR_MAPPING', null,
      async (client) => client.query(
        `UPDATE principals SET actor_id=$3,mapping_version=mapping_version+1
         WHERE principal_id=$1 AND mapping_version=$2 AND principal_type='ACTOR'`,
        [principalId, expectedVersion, actorId],
      ));
  }

  assignCapability(principalId: string, capability: Capability, expectedVersion: number, context: LifecycleContext) {
    return this.mutate(principalId, expectedVersion, context, 'CAPABILITY_ASSIGN', capability,
      async (client) => {
        const updated = await client.query(
          `UPDATE principals SET mapping_version=mapping_version+1
           WHERE principal_id=$1 AND mapping_version=$2`, [principalId, expectedVersion],
        );
        if (updated.rowCount === 1) await client.query(
          'INSERT INTO principal_capabilities(principal_id,capability) VALUES($1,$2)',
          [principalId, capability],
        );
        return updated;
      });
  }

  revokeCapability(principalId: string, capability: Capability, expectedVersion: number, context: LifecycleContext) {
    return this.mutate(principalId, expectedVersion, context, 'CAPABILITY_REVOKE', capability,
      async (client) => {
        const updated = await client.query(
          `UPDATE principals SET mapping_version=mapping_version+1
           WHERE principal_id=$1 AND mapping_version=$2
             AND EXISTS(SELECT 1 FROM principal_capabilities WHERE principal_id=$1 AND capability=$3)`,
          [principalId, expectedVersion, capability],
        );
        if (updated.rowCount === 1) await client.query(
          'DELETE FROM principal_capabilities WHERE principal_id=$1 AND capability=$2',
          [principalId, capability],
        );
        return updated;
      });
  }

  attachIdentity(principalId: string, identity: ExternalIdentity, expectedVersion: number, context: LifecycleContext) {
    return this.mutate(principalId, expectedVersion, context, 'IDENTITY_ATTACH', null,
      async (client) => {
        const updated = await client.query(
          `UPDATE principals SET mapping_version=mapping_version+1
           WHERE principal_id=$1 AND mapping_version=$2`, [principalId, expectedVersion],
        );
        if (updated.rowCount === 1) await client.query(
          'INSERT INTO external_identities(issuer,subject,principal_id) VALUES($1,$2,$3)',
          [identity.issuer, identity.subject, principalId],
        );
        return updated;
      });
  }

  private async mutate(
    principalId: string, expectedVersion: number, context: LifecycleContext,
    operation: string, capability: Capability | null,
    change: (client: PoolClient) => Promise<{ rowCount: number | null }>,
  ): Promise<LifecycleResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const changed = await change(client);
      if (changed.rowCount !== 1) {
        await client.query('ROLLBACK');
        const exists = await this.get(principalId);
        return { ok: false, kind: exists === null ? 'NOT_FOUND' : 'CONFLICT' };
      }
      const row = (await client.query<PrincipalRow>(
        `SELECT principal_id,principal_type,actor_id,enabled,mapping_version
         FROM principals WHERE principal_id=$1`, [principalId],
      )).rows[0]!;
      await this.audit(client, row.principal_id, row.principal_type, row.actor_id,
        operation, Number(row.mapping_version), capability, context);
      await client.query('COMMIT');
      return { ok: true, principal: (await this.get(principalId))! };
    } catch (error) {
      await client.query('ROLLBACK');
      if (persistenceConflict(error)) return { ok: false, kind: 'CONFLICT' };
      throw error;
    } finally { client.release(); }
  }

  private async toRecord(queryable: Pick<Pool, 'query'>, row: PrincipalRow): Promise<PrincipalRecord> {
    const capabilities = await queryable.query<{ capability: Capability }>(
      'SELECT capability FROM principal_capabilities WHERE principal_id=$1 ORDER BY capability',
      [row.principal_id],
    );
    const base = {
      principalId: row.principal_id, type: row.principal_type, enabled: row.enabled,
      capabilities: capabilities.rows.map((item) => item.capability),
      mappingVersion: Number(row.mapping_version),
    };
    return row.actor_id === null ? base : { ...base, actorId: makeActorId(row.actor_id) };
  }

  private validCreate(input: CreatePrincipalInput): boolean {
    if (!input.principalId || !input.identity.issuer || !input.identity.subject ||
        !input.context.correlationId || input.context.occurredAt < 0) return false;
    if ((input.type === 'ACTOR') !== (input.actorId !== undefined)) return false;
    const allowed: Record<PrincipalType, ReadonlyArray<Capability>> = {
      ACTOR: ['ACT_AS_SELF'], GATEWAY: ['CONFIRM_FUNDING'], SYSTEM: [],
    };
    return (input.capabilities ?? []).every((capability) => allowed[input.type].includes(capability));
  }

  private audit(
    client: PoolClient, principalId: string, type: PrincipalType, actorId: string | null,
    operation: string, version: number, capability: Capability | null, context: LifecycleContext,
  ): Promise<unknown> {
    return client.query(
      `INSERT INTO principal_audit(principal_id,principal_type,actor_id,operation,
       mapping_version,capability,occurred_at,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [principalId, type, actorId, operation, version, capability,
        context.occurredAt, context.correlationId],
    );
  }
}
