import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { DuckDBStore } from '@mastra/duckdb';
import { MastraCompositeStore } from '@mastra/core/storage';
import {
  MastraStorageExporter,
  MastraPlatformExporter,
  Observability,
  SensitiveDataFilter,
} from '@mastra/observability';

import { editorAgent } from './agents/editor-agent';
import { localizationAgent } from './agents/localization-agent';
import { translatorAgent } from './agents/translator-agent';
import { documentTools } from './tools/document-tools';
import { ocrTools } from './tools/datalab-ocr-tool';
import { glossaryTools } from './tools/glossary-tools';
import { pdfTools } from './tools/pdf-tools';

import { localizeDocumentWorkflow } from './workflows/localize-document';
import { workspace } from './workspace';

export const mastra = new Mastra({
  agents: { localizationAgent, translatorAgent, editorAgent },
  workflows: { localizeDocumentWorkflow },
  workspace,
  tools: {
    ...glossaryTools,
    ...documentTools,
    ...pdfTools,
    ...ocrTools,
  },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: 'mastra-storage',
      url: process.env.TURSO_DATABASE_URL || 'file:./mastra.db',
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    }),
    domains: {
      observability: await new DuckDBStore().getStore('observability'),
    },
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [new MastraStorageExporter(), new MastraPlatformExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});
