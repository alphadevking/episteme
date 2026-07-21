// episteme-core/src/mastra/index.ts
import { Mastra } from '@mastra/core/mastra';
import { Observability, MastraStorageExporter } from '@mastra/observability';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore, MemoryLibSQL } from '@mastra/libsql';
import { MastraCompositeStore } from '@mastra/core/storage';
import { dbClient } from './db';
import { Memory } from '@mastra/memory';
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
} from './server/kb-routes';
import { chatSecurityMiddleware } from './server/chat-security';

// MCP server removed in favor of direct REST API communication

export const mastra = new Mastra({
  workflows: { verificationWorkflow },
  agents: { epistemeChatAgent },
  scorers: {
    groundedToolUsageScorer,
    faithfulnessScorer,
  },
  memory: {
    chatMemory: new Memory({
      options: {
        lastMessages: 20,
      },
    }),
  },
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
  storage: new MastraCompositeStore({
    id: 'composite',
    default: new LibSQLStore({
      id: "mastra-storage",
      client: dbClient,
    }),
    domains: {
      memory: new MemoryLibSQL({
        client: dbClient,
      }),
    },
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
    redact: {
      paths: [
        'err.stack',
        'error.stack',
        '*.stack',
        'err.cause',
        'error.cause',
        '*.cause',
        'requestBodyValues',
        '*.requestBodyValues',
        'responseBody',
        '*.responseBody',
      ],
      remove: true,
    },
    formatters: {
      log(object) {
        const anyObj = object as Record<string, unknown>;
        const compactError = (value: unknown) => {
          if (!(value instanceof Error)) return value;
          const e = value as Error & { code?: unknown; cause?: Record<string, unknown> };
          const code = e.code ?? e.cause?.code;
          return {
            name: e.name,
            message: e.message,
            ...(code !== undefined ? { code } : {}),
          };
        };

        if ('err' in anyObj) anyObj.err = compactError(anyObj.err);
        if ('error' in anyObj) anyObj.error = compactError(anyObj.error);

        return anyObj;
      },
    },
  }),
  deployer: new VercelDeployer(),
  server: {
    // Authenticates the episteme-chat proxy and injects the trusted session
    // context (role/trust/institution/user) before the chat route runs.
    middleware: [chatSecurityMiddleware],
    apiRoutes: [
      chatRoute({ path: '/chat/:agentId' }),
      { path: '/kb/documents',                     method: 'GET',    handler: listDocumentsHandler },
      { path: '/kb/documents',                     method: 'POST',   handler: ingestDocumentHandler },
      { path: '/kb/documents/:docId/scope',        method: 'PATCH',  handler: patchDocumentScopeHandler },
      { path: '/kb/documents/:docId',              method: 'DELETE', handler: deleteDocumentHandler },
      { path: '/kb/documents/:docId/reingest',     method: 'POST',   handler: reingestDocumentHandler },
      { path: '/kb/documents/:docId/freshness',    method: 'POST',   handler: updateFreshnessHandler },
    ],
  },
});
