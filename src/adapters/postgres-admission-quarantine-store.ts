import type { Pool } from 'pg';
import type {
  AdmissionQuarantine, AdmissionQuarantineStore, QuarantineReason, QuarantineRelease,
} from '../security/admission-quarantine';
import { MAX_QUARANTINE_TTL_MS } from '../security/admission-quarantine';

interface QuarantineRow {
  quarantine_id: string;
  principal_id: string;
  reason: QuarantineReason;
  issued_at: string;
  expires_at: string;
  issued_by: string;
  correlation_id: string;
}

interface ReleaseRow {
  quarantine_id: string;
  released_at: string;
  released_by: string;
  correlation_id: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASONS = new Set<QuarantineReason>([
  'SECURITY_INCIDENT', 'BEHAVIORAL_ANOMALY', 'CREDENTIAL_COMPROMISE', 'MANUAL_REVIEW',
]);

export class PostgresAdmissionQuarantineStore implements AdmissionQuarantineStore {
  constructor(private readonly pool: Pool) {}

  async findActive(principalId: string, at: number): Promise<AdmissionQuarantine | null> {
    if (!safeId(principalId) || !timestamp(at)) throw new Error('Invalid quarantine lookup');
    const result = await this.pool.query<QuarantineRow>(
      `SELECT q.quarantine_id,q.principal_id,q.reason,q.issued_at,q.expires_at,q.issued_by,q.correlation_id
       FROM admission_quarantines q
       LEFT JOIN admission_quarantine_releases r ON r.quarantine_id=q.quarantine_id
       WHERE q.principal_id=$1 AND q.issued_at<=$2 AND q.expires_at>$2 AND r.quarantine_id IS NULL
       ORDER BY q.expires_at DESC,q.quarantine_id ASC LIMIT 1`,
      [principalId, at],
    );
    return result.rows[0] === undefined ? null : quarantineFromRow(result.rows[0]);
  }

  async issue(quarantine: AdmissionQuarantine): Promise<'ISSUED' | 'DUPLICATE' | 'CONFLICT' | 'INVALID'> {
    if (!validQuarantine(quarantine)) return 'INVALID';
    try {
      await this.pool.query(
        `INSERT INTO admission_quarantines(
          quarantine_id,principal_id,reason,issued_at,expires_at,issued_by,correlation_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [quarantine.quarantineId, quarantine.principalId, quarantine.reason, quarantine.issuedAt,
          quarantine.expiresAt, quarantine.issuedBy, quarantine.correlationId],
      );
      return 'ISSUED';
    } catch (error) {
      if (!constraintConflict(error)) throw error;
      const existing = await this.findIssued(quarantine.quarantineId, quarantine.correlationId);
      return existing !== null && sameQuarantineIntent(existing, quarantine) ? 'DUPLICATE' : 'CONFLICT';
    }
  }

  async release(release: QuarantineRelease): Promise<'RELEASED' | 'DUPLICATE' | 'CONFLICT' | 'NOT_FOUND' | 'INVALID'> {
    if (!validRelease(release)) return 'INVALID';
    const issued = await this.findIssued(release.quarantineId);
    if (issued === null) return 'NOT_FOUND';
    if (release.releasedAt < issued.issuedAt) return 'INVALID';
    try {
      await this.pool.query(
        `INSERT INTO admission_quarantine_releases(quarantine_id,released_at,released_by,correlation_id)
         VALUES($1,$2,$3,$4)`,
        [release.quarantineId, release.releasedAt, release.releasedBy, release.correlationId],
      );
      return 'RELEASED';
    } catch (error) {
      if (!constraintConflict(error)) throw error;
      const existing = await this.findRelease(release.quarantineId, release.correlationId);
      return existing !== null && sameReleaseIntent(existing, release) ? 'DUPLICATE' : 'CONFLICT';
    }
  }

  private async findIssued(quarantineId: string, correlationId?: string): Promise<AdmissionQuarantine | null> {
    const result = await this.pool.query<QuarantineRow>(
      `SELECT quarantine_id,principal_id,reason,issued_at,expires_at,issued_by,correlation_id
       FROM admission_quarantines WHERE quarantine_id=$1${correlationId === undefined ? '' : ' OR correlation_id=$2'}
       ORDER BY quarantine_id LIMIT 1`,
      correlationId === undefined ? [quarantineId] : [quarantineId, correlationId],
    );
    return result.rows[0] === undefined ? null : quarantineFromRow(result.rows[0]);
  }

  private async findRelease(quarantineId: string, correlationId: string): Promise<QuarantineRelease | null> {
    const result = await this.pool.query<ReleaseRow>(
      `SELECT quarantine_id,released_at,released_by,correlation_id FROM admission_quarantine_releases
       WHERE quarantine_id=$1 OR correlation_id=$2 ORDER BY quarantine_id LIMIT 1`,
      [quarantineId, correlationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : {
      quarantineId: row.quarantine_id, releasedAt: Number(row.released_at),
      releasedBy: row.released_by, correlationId: row.correlation_id,
    };
  }
}

function quarantineFromRow(row: QuarantineRow): AdmissionQuarantine {
  return {
    quarantineId: row.quarantine_id, principalId: row.principal_id, reason: row.reason,
    issuedAt: Number(row.issued_at), expiresAt: Number(row.expires_at),
    issuedBy: row.issued_by, correlationId: row.correlation_id,
  };
}

function validQuarantine(value: AdmissionQuarantine): boolean {
  return safeId(value.quarantineId) && safeId(value.principalId) && REASONS.has(value.reason)
    && timestamp(value.issuedAt) && timestamp(value.expiresAt) && value.expiresAt > value.issuedAt
    && value.expiresAt - value.issuedAt <= MAX_QUARANTINE_TTL_MS
    && safeId(value.issuedBy) && safeId(value.correlationId);
}

function validRelease(value: QuarantineRelease): boolean {
  return safeId(value.quarantineId) && timestamp(value.releasedAt)
    && safeId(value.releasedBy) && safeId(value.correlationId);
}

function sameQuarantineIntent(left: AdmissionQuarantine, right: AdmissionQuarantine): boolean {
  return left.quarantineId === right.quarantineId && left.principalId === right.principalId
    && left.reason === right.reason && left.expiresAt === right.expiresAt
    && left.issuedBy === right.issuedBy && left.correlationId === right.correlationId;
}

function sameReleaseIntent(left: QuarantineRelease, right: QuarantineRelease): boolean {
  return left.quarantineId === right.quarantineId
    && left.releasedBy === right.releasedBy && left.correlationId === right.correlationId;
}

function safeId(value: string): boolean { return SAFE_ID.test(value); }
function timestamp(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function constraintConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && ['23505', '23503', '23514'].includes(String((error as { code: unknown }).code));
}
