// episteme-core/src/mastra/index.ts
import { Mastra } from '@mastra/core/mastra';
import { Observability, MastraStorageExporter } from '@mastra/observability';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { runtimeClient } from './db';
import { groundedToolUsageScorer, faithfulnessScorer } from './scorers/episteme-scorer';
import { epistemeChatAgent } from './agents/episteme-chat-agent';
import { verificationWorkflow } from './workflows/verification-workflow';
import { chatRoute } from '@mastra/ai-sdk';
import { VercelDeployer } from '@mastra/deployer-vercel';
import {
  listDocumentsHandler,
  ingestDocumentHandler,
  patchDocumentScopeHandler,
  deleteDocumentHandler,
  reingestDocumentHandler,
  updateFreshnessHandler,
  fetchPageHandler,
} from './server/kb-routes';
import { chatSecurityMiddleware } from './server/chat-security';
import { buildErrorReport, httpExceptionStatus } from './server/on-error';
import { warmupConnections } from './warmup';

// MCP server removed in favor of direct REST API communication

export const mastra = new Mastra({
  workflows: { verificationWorkflow },
  agents: { epistemeChatAgent },
  scorers: {
    groundedToolUsageScorer,
    faithfulnessScorer,
  },
  // No `memory` domain, and no Memory on the agent — see episteme-chat-agent.ts.
  // Conversation state is owned by Supabase and replayed by the chat proxy, so
  // Mastra memory held nothing anyone read while making storage a hard
  // dependency of every turn.
  //
  // Traces every agent turn, tool call, and eval score to the LibSQL store —
  // viewable in Studio (Observability tab) and queried by experiments.
  // Explicit exporter config; `default: { enabled: true }` is deprecated.
  observability: new Observability({
    configs: {
      episteme: {
        serviceName: 'episteme-core',
        exporters: [new MastraStorageExporter()],
      },
    },
  }),
  // Local, ephemeral, and therefore always reachable. Mastra persists an
  // agent's execution-workflow run here BEFORE the first step runs, so this
  // store sits in the fatal path of every chat turn — it must never be a
  // network resource. See db.ts.
  storage: new LibSQLStore({
    id: 'mastra-storage',
    client: runtimeClient,
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
    // Redact ONLY the fields that carry secrets or the system prompt.
    //
    // This list used to include `*.stack` and `*.cause`, and a `formatters.log`
    // hook additionally flattened every Error to {name, message, code}. The
    // 2026-08-01 storage outage surfaced as a bare 500 with no stack and no
    // cause anywhere in the logs; the root cause (LibSQLDB.createTable) was in
    // the deleted frames. Stacks are not the sensitive part — request/response
    // payloads are. Keep those out, keep stacks in.
    redact: {
      paths: [
        'requestBodyValues',
        '*.requestBodyValues',
        'responseBody',
        '*.responseBody',
      ],
      remove: true,
    },
  }),
  deployer: new VercelDeployer(),
  server: {
    // Logs the full error with a correlation id that is also returned to the
    // client, so a reported 500 maps to one exact stack. Without this, Mastra's
    // default handler returns a fixed "Internal Server Error" string and the
    // log line is the only copy of the cause. Inlined so `c` is typed by
    // Mastra's own bundled Hono — see server/on-error.ts.
    onError: (err, c) => {
      const status = httpExceptionStatus(err);
      // A deliberate 404/413 must not be laundered into a 500.
      if (status !== undefined) return c.json({ error: err.message }, status as 500);

      const { logPayload, body } = buildErrorReport(err, c.req.method, c.req.path);
      c.get('mastra')?.getLogger()?.error('Unhandled server error', logPayload);
      return c.json(body, 500);
    },
    // Authenticates the episteme-chat proxy and injects the trusted session
    // context (role/trust/institution/user) before the chat route runs.
    middleware: [chatSecurityMiddleware],
    apiRoutes: [
      chatRoute({ path: '/chat/:agentId' }),
      { path: '/kb/documents',                     method: 'GET',    handler: listDocumentsHandler },
      { path: '/kb/documents',                     method: 'POST',   handler: ingestDocumentHandler },
      // Fetch-only: proxy + cleanPageHtml, no extraction, no chunking, no write.
      // Distinct from POST /kb/documents { dryRun: true }, which runs the real
      // pipeline through chunking. This one costs no Unstructured quota, so it
      // is the cheap first pass when validating a harvest manifest.
      { path: '/kb/fetch',                         method: 'POST',   handler: fetchPageHandler },
      { path: '/kb/documents/:docId/scope',        method: 'PATCH',  handler: patchDocumentScopeHandler },
      { path: '/kb/documents/:docId',              method: 'DELETE', handler: deleteDocumentHandler },
      { path: '/kb/documents/:docId/reingest',     method: 'POST',   handler: reingestDocumentHandler },
      { path: '/kb/documents/:docId/freshness',    method: 'POST',   handler: updateFreshnessHandler },
    ],
  },
});

// Pay the Mistral-embed/Pinecone connection setup (~4-5s, measured) at boot,
// not on the first user's query. Non-blocking; failures are logged and ignored.
warmupConnections();
