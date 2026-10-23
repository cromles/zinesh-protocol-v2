import { makeActorId, makeAmount, makeCellId, makeCommandId, makeTimestamp } from '../core/types';
import {
  AdaptiveAdmissionController,
  baselineAdmissionPolicy,
} from './adaptive-admission';
import type { AdmissionContext, AdmissionDecision, AdmissionPolicy } from './adaptive-admission';
import type { VerifiedPrincipal } from './trusted-ingress';

const principal = {
  principalId: 'principal-admission', type: 'ACTOR', enabled: true,
  actorId: makeActorId('admission-payer'), capabilities: ['ACT_AS_SELF'], mappingVersion: 4,
} as VerifiedPrincipal;

const command = {
  commandId: makeCommandId('admission-command'), cellId: makeCellId('admission-cell'), type: 'CreateCell' as const,
  payload: {
    payer: makeActorId('admission-payer'), payee: makeActorId('admission-payee'),
    description: 'Adaptive admission controller contract.', amount: makeAmount(100n), currency: 'TRY' as const,
    fundingDeadline: makeTimestamp(2_000_000), completionDeadline: makeTimestamp(3_000_000),
  },
};

function policy(decision: AdmissionDecision): AdmissionPolicy {
  return { version: 'candidate-v7', async evaluate() { return decision; } };
}

describe('adaptive admission controller', () => {
  test('baseline policy preserves existing authorized traffic', async () => {
    await expect(new AdaptiveAdmissionController(baselineAdmissionPolicy).evaluate(principal, command))
      .resolves.toEqual({
        mode: 'ENFORCE', policyVersion: 'baseline-v1',
        observed: { disposition: 'ALLOW', reason: 'BASELINE_ALLOW' },
        effective: 'ALLOW', policyFailed: false,
      });
  });

  test.each([
    ['CHALLENGE', 'ADDITIONAL_PROOF_REQUIRED'],
    ['QUARANTINE', 'PRINCIPAL_QUARANTINED'],
    ['DENY', 'POLICY_DENY'],
  ] as const)('enforce mode turns %s into a rejection without granting authority', async (disposition, reason) => {
    const result = await new AdaptiveAdmissionController(policy({ disposition, reason })).evaluate(principal, command);
    expect(result).toMatchObject({ mode: 'ENFORCE', effective: 'REJECT', policyFailed: false,
      observed: { disposition, reason } });
  });

  test('limit requires a bounded retry interval', async () => {
    const valid = await new AdaptiveAdmissionController(policy({
      disposition: 'LIMIT', reason: 'RISK_LIMIT', retryAfterSeconds: 30,
    })).evaluate(principal, command);
    expect(valid).toMatchObject({ effective: 'REJECT', observed: { retryAfterSeconds: 30 }, policyFailed: false });

    const invalid = await new AdaptiveAdmissionController(policy({
      disposition: 'LIMIT', reason: 'RISK_LIMIT', retryAfterSeconds: 0,
    })).evaluate(principal, command);
    expect(invalid).toMatchObject({ effective: 'REJECT', policyFailed: true,
      observed: { disposition: 'DENY', reason: 'INVALID_ADMISSION_DECISION' } });
  });

  test('shadow mode records candidate quarantine but cannot change execution', async () => {
    const result = await new AdaptiveAdmissionController(policy({
      disposition: 'QUARANTINE', reason: 'PRINCIPAL_QUARANTINED',
    }), 'SHADOW').evaluate(principal, command);
    expect(result).toMatchObject({ mode: 'SHADOW', effective: 'ALLOW', policyFailed: false,
      observed: { disposition: 'QUARANTINE' } });
  });

  test.each(['ENFORCE', 'SHADOW'] as const)('policy failure is opaque and mode-safe in %s', async (mode) => {
    const failing: AdmissionPolicy = { version: 'failing-v1', async evaluate() {
      throw new Error('secret model endpoint and credential');
    } };
    const result = await new AdaptiveAdmissionController(failing, mode).evaluate(principal, command);
    expect(result).toEqual({
      mode, policyVersion: 'failing-v1', policyFailed: true,
      observed: { disposition: 'DENY', reason: 'ADMISSION_POLICY_FAILURE' },
      effective: mode === 'SHADOW' ? 'ALLOW' : 'REJECT',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('policy receives a minimal immutable context rather than credentials or command payload', async () => {
    let captured: AdmissionContext | undefined;
    const inspecting: AdmissionPolicy = { version: 'inspect-v1', async evaluate(context) {
      captured = context;
      return { disposition: 'ALLOW', reason: 'BASELINE_ALLOW' };
    } };
    await new AdaptiveAdmissionController(inspecting).evaluate(principal, command);
    expect(captured).toEqual({
      principal: { principalId: 'principal-admission', type: 'ACTOR', capabilities: ['ACT_AS_SELF'], mappingVersion: 4 },
      command: { type: 'CreateCell' },
    });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured!.principal)).toBe(true);
    expect(Object.isFrozen(captured!.principal.capabilities)).toBe(true);
    expect(JSON.stringify(captured)).not.toContain('description');
    expect(JSON.stringify(captured)).not.toContain('amount');
    expect(JSON.stringify(captured)).not.toContain('credential');
  });

  test('invalid policy output and version fail safely', async () => {
    const malformed: AdmissionPolicy = { version: 'malformed-v1', async evaluate() {
      return { disposition: 'ALLOW', reason: 'POLICY_DENY' } as AdmissionDecision;
    } };
    await expect(new AdaptiveAdmissionController(malformed).evaluate(principal, command)).resolves.toMatchObject({
      effective: 'REJECT', policyFailed: true,
      observed: { disposition: 'DENY', reason: 'INVALID_ADMISSION_DECISION' },
    });
    expect(() => new AdaptiveAdmissionController({
      version: 'unsafe version', async evaluate() { return { disposition: 'ALLOW', reason: 'BASELINE_ALLOW' }; },
    })).toThrow('Invalid admission policy version');
  });
});
