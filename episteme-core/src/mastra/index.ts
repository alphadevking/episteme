// episteme-core/src/mastra/index.ts
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore, MemoryLibSQL } from '@mastra/libsql';
import { MastraCompositeStore } from '@mastra/core/storage';
import { dbClient } from './db';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';
import { Memory } from '@mastra/memory';
import { groundedToolUsageScorer, faithfulnessScorer } from './scorers/episteme-scorer';
import { epistemeChatAgent } from './agents/episteme-chat-agent';
import { verificationWorkflow } from './workflows/verification-workflow';
import { chatRoute } from '@mastra/ai-sdk';
import { VercelDeployer } from '@mastra/deployer-vercel';
import {
  listDocumentsHandler,
  ingestDocumentHandler,
  deleteDocumentHandler,
  reingestDocumentHandler,
  updateFreshnessHandler,
} from './server/kb-routes';

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
          const e = value as Error & { code?: unknown; cause?: unknown };
          const code = (e as any)?.code ?? (e as any)?.cause?.code;
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
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new DefaultExporter(), // Persists traces to storage for Mastra Studio
          new CloudExporter(), // Sends traces to Mastra Cloud (if MASTRA_CLOUD_ACCESS_TOKEN is set)
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
  deployer: new VercelDeployer(),
  server: {
    apiRoutes: [
      chatRoute({ path: '/chat/:agentId' }),
      { path: '/api/kb/documents',                     method: 'GET',    handler: listDocumentsHandler },
      { path: '/api/kb/documents',                     method: 'POST',   handler: ingestDocumentHandler },
      { path: '/api/kb/documents/:docId',              method: 'DELETE', handler: deleteDocumentHandler },
      { path: '/api/kb/documents/:docId/reingest',     method: 'POST',   handler: reingestDocumentHandler },
      { path: '/api/kb/documents/:docId/freshness',    method: 'POST',   handler: updateFreshnessHandler },
    ],
  },
});
