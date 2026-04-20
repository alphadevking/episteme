// tools/claim-status-tool.ts
// Pure DB SELECT — no LLM reasoning, no Pinecone.
// Returns claim status for a user's own claim by claim ID.
//
// Auth: service-to-service via x-episteme-admin-key + x-episteme-user-id headers.
// The agent reads user_public_id from the system prompt context (injected by chat route).
// MASTRA_ADMIN_KEY is shared via environment — never sent to the model.
// This tool never mutates state and never falls back to web search.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

declare const process: { env: Record<string, string | undefined> };

const ClaimStatusSchema = z.object({
  found:             z.boolean(),
  claim_id:          z.string().optional(),
  claim_type:        z.string().optional(),
  status:            z.string().optional(),
  submitted_at:      z.string().optional(),
  reviewed_at:       z.string().optional(),
  department:        z.string().optional(),
  reviewer:          z.string().optional(),
  review_notes:      z.string().optional(),
  rejection_reason:  z.string().optional(),
  is_urgent:         z.boolean().optional(),
  message:           z.string().optional(),
});

export type ClaimStatusResult = z.infer<typeof ClaimStatusSchema>;

/**
 * Fetches claim status via the episteme-chat /api/claims/:id/status endpoint.
 * Uses service-to-service auth (admin key + user public ID) — no session cookie needed.
 *
 * The chat route injects `user_public_id=<uuid>` into the system prompt so the agent
 * can pass it here. Ownership is enforced server-side by filtering on user_id.
 */
export const claimStatusTool = createTool({
  id: 'claimStatusTool',
  description:
    'Returns the current status of a verification claim (transcript, degree, enrollment, etc.) ' +
    'submitted by the user. Only returns data for claims the caller owns — never exposes other users\' claims. ' +
    'Use this when a user asks "what is the status of my claim", "did my transcript request get approved", etc. ' +
    'Do NOT use this for any purpose other than reading claim status.',
  inputSchema: z.object({
    claim_id: z
      .string()
      .uuid()
      .describe('The UUID of the claim to check. Ask the user for this if they did not provide it.'),
    user_public_id: z
      .string()
      .uuid()
      .describe(
        'The public database ID of the authenticated user. ' +
        'Read this from the system context field user_public_id=<value>. ' +
        'Never ask the user for this — it is always present in the system context.'
      ),
  }),
  outputSchema: ClaimStatusSchema,
  execute: async (input) => {
    const { claim_id, user_public_id } = input as { claim_id: string; user_public_id: string };

    const chatBase  = process.env['EPISTEME_CHAT_BASE_URL'] ?? 'http://localhost:3000';
    const adminKey  = process.env['MASTRA_ADMIN_KEY'];

    if (!adminKey) {
      return {
        found:   false,
        message: 'Service configuration error: MASTRA_ADMIN_KEY is not set.',
      };
    }

    let res: Response;
    try {
      res = await fetch(`${chatBase}/api/claims/${encodeURIComponent(claim_id)}/status`, {
        headers: {
          'x-episteme-admin-key': adminKey,
          'x-episteme-user-id':   user_public_id,
        },
      });
    } catch {
      return {
        found:   false,
        message: 'Could not reach the claims service. Please try again later.',
      };
    }

    if (res.status === 404) {
      return {
        found:   false,
        message: 'No claim found with that ID. Please check the ID and try again.',
      };
    }

    if (res.status === 400 || res.status === 403) {
      return {
        found:   false,
        message: 'You do not have permission to view that claim.',
      };
    }

    if (!res.ok) {
      return {
        found:   false,
        message: 'An error occurred while fetching your claim status.',
      };
    }

    const data = await res.json() as ClaimStatusResult;
    return data;
  },
});
