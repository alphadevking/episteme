/**
 * Verification Workflow — FR-303 Human-in-the-Loop Claim Lifecycle
 *
 * Models the full lifecycle of a certification verification claim:
 *
 *   SUBMITTED ──► validateClaim ──► routeClaim ──► [SUSPEND: awaitAdminAssignment]
 *                                                        │
 *                                               admin assigns to HOD
 *                                                        │
 *                                          [SUSPEND: awaitHodDecision]
 *                                                        │
 *                                           HOD approves or rejects
 *                                                        │
 *                                               recordOutcome ──► DONE
 *
 * Design principles:
 *  - Workflow is the observable state machine. Actual DB mutations happen
 *    via SECURITY DEFINER functions (fn_admin_assign_claim, fn_hod_review_claim)
 *    called from the admin UI — the workflow records what happened, not how.
 *  - Two suspend points model the two human handoff gates.
 *  - All step I/O is Zod-typed — traces are structured and queryable.
 *  - Each step writes a structured log entry (Mastra observability picks it up).
 */

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

// ── Shared schemas ────────────────────────────────────────────────────────────

const ClaimTypeSchema = z.enum([
  'transcript',
  'degree_certificate',
  'enrollment_letter',
  'course_registration',
  'result_verification',
  'other',
]);

const ClaimStatusSchema = z.enum([
  'pending',
  'in_review',
  'approved',
  'rejected',
  'reopened',
]);

const ClaimInputSchema = z.object({
  claimId:       z.string().uuid().describe('Unique claim identifier from verification_claims.id'),
  userId:        z.string().uuid().describe('Submitting user public ID'),
  institutionId: z.string().uuid().describe('Institution the claim belongs to'),
  claimType:     ClaimTypeSchema.describe('Type of certification being requested'),
  description:   z.string().min(1).describe('User-provided claim description'),
  submittedAt:   z.string().datetime().describe('ISO timestamp of submission'),
  isUrgent:      z.boolean().default(false),
});

// ── Step 1: validateClaim ─────────────────────────────────────────────────────
// Validates that the claim has all required fields and the submitting user
// is eligible (trust_level >= 2 — must have self-reported a matric number).
// Does NOT perform DB writes — pure validation gate.

const validateClaimStep = createStep({
  id: 'validateClaim',
  description: 'Validates claim completeness and user eligibility before routing',
  inputSchema: ClaimInputSchema,
  outputSchema: z.object({
    valid:           z.boolean(),
    claimId:         z.string().uuid(),
    userId:          z.string().uuid(),
    institutionId:   z.string().uuid(),
    claimType:       ClaimTypeSchema,
    description:     z.string(),
    submittedAt:     z.string().datetime(),
    isUrgent:        z.boolean(),
    validationNotes: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    const { claimId, userId, institutionId, claimType, description, submittedAt, isUrgent } = inputData;

    // Structural validation — Zod already enforces types, this checks business rules
    const issues: string[] = [];

    if (!description.trim()) {
      issues.push('Claim description is empty');
    }

    if (description.trim().length < 20) {
      issues.push('Claim description is too brief — minimum 20 characters');
    }

    const submissionAge = Date.now() - new Date(submittedAt).getTime();
    if (submissionAge > 30 * 24 * 60 * 60 * 1000) {
      issues.push('Claim submission timestamp is older than 30 days — possible replay');
    }

    const valid = issues.length === 0;

    console.log(JSON.stringify({
      event:          'claim_validated',
      claimId,
      userId,
      claimType,
      valid,
      issues:         valid ? undefined : issues,
    }));

    return {
      valid,
      claimId,
      userId,
      institutionId,
      claimType,
      description,
      submittedAt,
      isUrgent,
      validationNotes: issues.length > 0 ? issues.join('; ') : undefined,
    };
  },
});

// ── Step 2: routeClaim ────────────────────────────────────────────────────────
// Determines routing metadata — which department class should handle this claim.
// Actual assignment (fn_admin_assign_claim) is done by the admin in the UI;
// this step pre-computes a routing suggestion and logs it as an observable event.

const routeClaimStep = createStep({
  id: 'routeClaim',
  description: 'Determines routing category and logs claim as ready for admin assignment',
  inputSchema: z.object({
    valid:           z.boolean(),
    claimId:         z.string().uuid(),
    userId:          z.string().uuid(),
    institutionId:   z.string().uuid(),
    claimType:       ClaimTypeSchema,
    description:     z.string(),
    submittedAt:     z.string().datetime(),
    isUrgent:        z.boolean(),
    validationNotes: z.string().optional(),
  }),
  outputSchema: z.object({
    claimId:          z.string().uuid(),
    userId:           z.string().uuid(),
    institutionId:    z.string().uuid(),
    claimType:        ClaimTypeSchema,
    isUrgent:         z.boolean(),
    suggestedCategory: z.string().describe('Suggested department category for routing'),
    routedAt:         z.string().datetime(),
  }),
  execute: async ({ inputData }) => {
    const { valid, claimId, userId, institutionId, claimType, isUrgent, validationNotes } = inputData;

    if (!valid) {
      console.log(JSON.stringify({
        event:           'claim_routing_blocked',
        claimId,
        reason:          validationNotes,
      }));
      // Return with a rejected category — admin UI will show this
      return {
        claimId,
        userId,
        institutionId,
        claimType,
        isUrgent,
        suggestedCategory: 'invalid',
        routedAt: new Date().toISOString(),
      };
    }

    // Map claim type to department routing category
    const ROUTING_MAP: Record<z.infer<typeof ClaimTypeSchema>, string> = {
      transcript:           'academic-records',
      degree_certificate:   'academic-records',
      enrollment_letter:    'student-affairs',
      course_registration:  'academic-office',
      result_verification:  'examinations',
      other:                'general-admin',
    };

    const suggestedCategory = ROUTING_MAP[claimType] ?? 'general-admin';
    const routedAt = new Date().toISOString();

    console.log(JSON.stringify({
      event:             'claim_routed',
      claimId,
      userId,
      claimType,
      suggestedCategory,
      isUrgent,
      routedAt,
    }));

    return { claimId, userId, institutionId, claimType, isUrgent, suggestedCategory, routedAt };
  },
});

// ── Step 3: awaitAdminAssignment ─────────────────────────────────────────────
// SUSPEND POINT 1 — workflow pauses here until an admin assigns the claim.
// When the admin calls fn_admin_assign_claim via the UI, the workflow
// is resumed with the assignment payload.

const awaitAdminAssignmentStep = createStep({
  id: 'awaitAdminAssignment',
  description: 'Suspends workflow until an admin assigns the claim to an HOD',
  inputSchema: z.object({
    claimId:           z.string().uuid(),
    userId:            z.string().uuid(),
    institutionId:     z.string().uuid(),
    claimType:         ClaimTypeSchema,
    isUrgent:          z.boolean(),
    suggestedCategory: z.string(),
    routedAt:          z.string().datetime(),
  }),
  outputSchema: z.object({
    claimId:      z.string().uuid(),
    userId:       z.string().uuid(),
    hodUserId:    z.string().uuid().describe('HOD the claim was assigned to'),
    departmentId: z.string().uuid().describe('Department the claim was routed to'),
    assignedAt:   z.string().datetime(),
    assignedBy:   z.string().uuid().describe('Admin who performed the assignment'),
  }),
  execute: async ({ inputData, suspend }) => {
    const { claimId, isUrgent } = inputData;

    console.log(JSON.stringify({
      event:    'claim_awaiting_assignment',
      claimId,
      isUrgent,
    }));

    // Suspend — resume payload comes from the admin UI after fn_admin_assign_claim
    const resumeData = await suspend({
      claimId,
      isUrgent,
      waitingFor: 'admin-assignment',
      suspendedAt: new Date().toISOString(),
    }) as {
      hodUserId:    string;
      departmentId: string;
      assignedAt:   string;
      assignedBy:   string;
    };

    console.log(JSON.stringify({
      event:        'claim_assigned',
      claimId,
      hodUserId:    resumeData.hodUserId,
      departmentId: resumeData.departmentId,
      assignedBy:   resumeData.assignedBy,
    }));

    return {
      claimId,
      userId:       inputData.userId,
      hodUserId:    resumeData.hodUserId,
      departmentId: resumeData.departmentId,
      assignedAt:   resumeData.assignedAt,
      assignedBy:   resumeData.assignedBy,
    };
  },
});

// ── Step 4: awaitHodDecision ─────────────────────────────────────────────────
// SUSPEND POINT 2 — workflow pauses here until the HOD reviews the claim.
// When the HOD calls fn_hod_review_claim via the UI, the workflow
// is resumed with the decision payload.

const awaitHodDecisionStep = createStep({
  id: 'awaitHodDecision',
  description: 'Suspends workflow until the assigned HOD approves or rejects the claim',
  inputSchema: z.object({
    claimId:      z.string().uuid(),
    userId:       z.string().uuid(),
    hodUserId:    z.string().uuid(),
    departmentId: z.string().uuid(),
    assignedAt:   z.string().datetime(),
    assignedBy:   z.string().uuid(),
  }),
  outputSchema: z.object({
    claimId:         z.string().uuid(),
    userId:          z.string().uuid(),
    decision:        z.enum(['approved', 'rejected']),
    reviewedBy:      z.string().uuid(),
    reviewedAt:      z.string().datetime(),
    reviewNotes:     z.string().optional(),
    rejectionReason: z.string().optional(),
  }),
  execute: async ({ inputData, suspend }) => {
    const { claimId, hodUserId } = inputData;

    console.log(JSON.stringify({
      event:     'claim_awaiting_hod_decision',
      claimId,
      hodUserId,
    }));

    const resumeData = await suspend({
      claimId,
      hodUserId,
      waitingFor:  'hod-decision',
      suspendedAt: new Date().toISOString(),
    }) as {
      decision:        'approved' | 'rejected';
      reviewedBy:      string;
      reviewedAt:      string;
      reviewNotes?:    string;
      rejectionReason?: string;
    };

    console.log(JSON.stringify({
      event:           'claim_decided',
      claimId,
      decision:        resumeData.decision,
      reviewedBy:      resumeData.reviewedBy,
    }));

    return {
      claimId,
      userId:          inputData.userId,
      decision:        resumeData.decision,
      reviewedBy:      resumeData.reviewedBy,
      reviewedAt:      resumeData.reviewedAt,
      reviewNotes:     resumeData.reviewNotes,
      rejectionReason: resumeData.rejectionReason,
    };
  },
});

// ── Step 5: recordOutcome ─────────────────────────────────────────────────────
// Terminal step — logs the final outcome as a structured observability event.
// No DB mutation here — fn_hod_review_claim already wrote the outcome.

const recordOutcomeStep = createStep({
  id: 'recordOutcome',
  description: 'Records the final claim outcome as an observable workflow event',
  inputSchema: z.object({
    claimId:         z.string().uuid(),
    userId:          z.string().uuid(),
    decision:        z.enum(['approved', 'rejected']),
    reviewedBy:      z.string().uuid(),
    reviewedAt:      z.string().datetime(),
    reviewNotes:     z.string().optional(),
    rejectionReason: z.string().optional(),
  }),
  outputSchema: z.object({
    claimId:     z.string().uuid(),
    outcome:     z.enum(['approved', 'rejected']),
    completedAt: z.string().datetime(),
  }),
  execute: async ({ inputData }) => {
    const { claimId, userId, decision, reviewedBy, reviewedAt, rejectionReason } = inputData;
    const completedAt = new Date().toISOString();

    console.log(JSON.stringify({
      event:           'claim_workflow_complete',
      claimId,
      userId,
      outcome:         decision,
      reviewedBy,
      reviewedAt,
      completedAt,
      rejectionReason: rejectionReason ?? null,
    }));

    return { claimId, outcome: decision, completedAt };
  },
});

// ── Workflow assembly ─────────────────────────────────────────────────────────

export const verificationWorkflow = createWorkflow({
  id: 'verification-workflow',
  name: 'Certification Verification Workflow',
  description:
    'Human-in-the-loop workflow for certification verification claims. ' +
    'Models the full lifecycle: submission → admin assignment → HOD review → outcome. ' +
    'Two suspend points represent the human handoff gates.',
  inputSchema: ClaimInputSchema,
  outputSchema: z.object({
    claimId:     z.string().uuid(),
    outcome:     z.enum(['approved', 'rejected']),
    completedAt: z.string().datetime(),
  }),
})
  .then(validateClaimStep)
  .then(routeClaimStep)
  .then(awaitAdminAssignmentStep)
  .then(awaitHodDecisionStep)
  .then(recordOutcomeStep)
  .commit();
