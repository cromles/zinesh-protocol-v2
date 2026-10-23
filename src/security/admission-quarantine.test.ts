import { QuarantineAdmissionPolicy } from './admission-quarantine';
import type { AdmissionQuarantineReader } from './admission-quarantine';
import type { AdmissionContext } from './adaptive-admission';

const context: AdmissionContext = {
  principal: { principalId: 'principal-quarantine', type: 'ACTOR', capabilities: ['ACT_AS_SELF'], mappingVersion: 1 },
  command: { type: 'CreateCell' },
};

describe('durable quarantine admission policy', () => {
  test('allows when no active quarantine exists', async () => {
    const reader: AdmissionQuarantineReader = { async findActive(principalId, at) {
      expect(principalId).toBe('principal-quarantine');
      expect(at).toBe(1_000);
      return null;
    } };
    await expect(new QuarantineAdmissionPolicy(reader, () => 1_000).evaluate(context)).resolves.toEqual({
      disposition: 'ALLOW', reason: 'BASELINE_ALLOW',
    });
  });

  test('narrows access while an active quarantine exists', async () => {
    const reader: AdmissionQuarantineReader = { async findActive() {
      return {
        quarantineId: 'quarantine-1', principalId: 'principal-quarantine', reason: 'BEHAVIORAL_ANOMALY',
        issuedAt: 500, expiresAt: 1_500, issuedBy: 'security-operator', correlationId: 'incident-1',
      };
    } };
    await expect(new QuarantineAdmissionPolicy(reader, () => 1_000).evaluate(context)).resolves.toEqual({
      disposition: 'QUARANTINE', reason: 'PRINCIPAL_QUARANTINED',
    });
  });

  test('invalid clock and reader failure propagate to the fail-closed controller boundary', async () => {
    const reader: AdmissionQuarantineReader = { async findActive() { throw new Error('private database detail'); } };
    await expect(new QuarantineAdmissionPolicy(reader, () => 1_000).evaluate(context)).rejects
      .toThrow('private database detail');
    await expect(new QuarantineAdmissionPolicy(reader, () => -1).evaluate(context)).rejects
      .toThrow('Invalid quarantine clock');
  });
});
