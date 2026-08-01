// episteme-core/src/mastra/workflows/verification-workflow.test.ts
/**
 * Drives the claim workflow through both human handoff gates.
 *
 * WHY THIS EXISTS: the two suspend steps used to read their resume payload as
 * the return value of `suspend()`:
 *
 *   const resumeData = await suspend({ ... }) as { hodUserId: string, ... };
 *
 * `suspend()` returns a sentinel that aborts the step; it never yields the
 * payload. The resume value arrives on the NEXT invocation as `resumeData`, so
 * every field read off that cast would have been wrong the moment an admin
 * actually resumed a claim. TypeScript objected — and the `as` silenced it.
 * Nothing invoked this workflow, so nothing caught it.
 *
 * A type error was the only symptom of a real defect, which is why the fix
 * declared resumeSchema/suspendSchema rather than widening the cast, and why
 * this test drives the state machine end to end instead of asserting on types.
 *
 * No credentials and no network: every step is pure (logging plus schema
 * validation), and storage is a temp file.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { createClient } from '@libsql/client';
import { verificationWorkflow } from './verification-workflow';

const claimInput = () => ({
  claimId:       randomUUID(),
  userId:        randomUUID(),
  institutionId: randomUUID(),
  claimType:     'transcript' as const,
  description:   'Requesting an official transcript for postgraduate applications.',
  submittedAt:   new Date().toISOString(),
  isUrgent:      false,
});

describe('verification workflow — human handoff gates', () => {
  let dir: string;
  let client: ReturnType<typeof createClient>;
  let mastra: Mastra;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'episteme-wf-'));
    client = createClient({ url: `file:${join(dir, 'wf.db')}` });
    mastra = new Mastra({
      workflows: { verificationWorkflow },
      storage: new LibSQLStore({ id: 'wf-store', client }),
      logger: false,
    });
  });

  after(async () => {
    client?.close();
    // Best-effort: Windows can hold the .db locked past close() (EBUSY).
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      .catch(() => {});
  });

  test('suspends for admin assignment, then for HOD decision, then completes', async () => {
    const input = claimInput();
    const run = await mastra.getWorkflowById('verification-workflow').createRun();

    // Gate 1 — parks waiting for the admin.
    const started = await run.start({ inputData: input });
    assert.equal(started.status, 'suspended');

    // Gate 1 resumed — the payload must reach the step as `resumeData`. Under
    // the old `await suspend(...) as {...}` code this is exactly where the
    // wrong object was read.
    const assignment = {
      hodUserId:    randomUUID(),
      departmentId: randomUUID(),
      assignedAt:   new Date().toISOString(),
      assignedBy:   randomUUID(),
    };
    const assigned = await run.resume({ step: 'awaitAdminAssignment', resumeData: assignment });
    assert.equal(assigned.status, 'suspended', 'should now be parked at the HOD gate');

    // Gate 2 — the HOD decides, and the workflow runs to completion.
    const decision = {
      decision:    'approved' as const,
      reviewedBy:  randomUUID(),
      reviewedAt:  new Date().toISOString(),
      reviewNotes: 'Records verified against the student register.',
    };
    const done = await run.resume({ step: 'awaitHodDecision', resumeData: decision });

    assert.equal(done.status, 'success');
    assert.equal(done.status === 'success' ? done.result.outcome : null, 'approved');
    assert.equal(done.status === 'success' ? done.result.claimId : null, input.claimId);
  });

  /**
   * The resume payload comes from the admin UI, so it is a trust boundary.
   * `resumeSchema` is what makes Mastra validate it; the previous `as` cast
   * asserted the shape without checking it, so a malformed resume would have
   * propagated undefined values into the claim record.
   */
  test('rejects a malformed resume payload instead of propagating it', async () => {
    const run = await mastra.getWorkflowById('verification-workflow').createRun();
    const started = await run.start({ inputData: claimInput() });
    assert.equal(started.status, 'suspended');

    const outcome = await run
      .resume({
        step: 'awaitAdminAssignment',
        // hodUserId missing, departmentId not a UUID.
        resumeData: { departmentId: 'not-a-uuid', assignedAt: new Date().toISOString(), assignedBy: randomUUID() } as never,
      })
      .then((r) => r.status, () => 'threw');

    // Observed: Mastra throws on the schema violation. Asserted a little wider
    // than that (a 'failed' status would be equally correct), but narrow enough
    // to exclude the two ways this test could pass for the wrong reason —
    // completing anyway, or quietly re-suspending without validating.
    assert.ok(
      outcome !== 'success' && outcome !== 'suspended',
      `malformed resume should be rejected, got status "${outcome}"`,
    );
  });
});
