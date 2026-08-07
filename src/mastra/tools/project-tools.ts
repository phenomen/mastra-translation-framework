import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { discoverLocalizationProject } from '../lib/discover-project';

const documentKindSchema = z.enum([
  'pdf',
  'json',
  'html',
  'markdown',
  'text',
  'srt',
  'ass',
  'doc',
  'docx',
  'epub',
  'rtf',
  'odt',
]);

export const discoverProjectTool = createTool({
  id: 'discover_localization_project',
  description:
    'Inspect a workspace project directory and classify source documents, glossary, and style guide files. Use this when the user points at a folder instead of individual files. Returns the recommended sourcePaths plus glossaryPath and styleGuidePath to pass to localizeDocumentWorkflow.',
  inputSchema: z.object({
    directoryPath: z
      .string()
      .describe(
        'Workspace-relative project directory, for example "game" or "anime/season-1".',
      ),
    recursive: z
      .boolean()
      .optional()
      .describe(
        'When true (default), also scan subfolders. Skips translation run output directories and hidden folders.',
      ),
  }),
  outputSchema: z.object({
    directoryPath: z.string(),
    sourcePaths: z.array(z.string()),
    sourceKind: documentKindSchema.nullable(),
    sourcesByKind: z.record(z.string(), z.array(z.string())),
    glossaryPath: z.string().nullable(),
    glossaryCandidates: z.array(z.string()),
    styleGuidePath: z.string().nullable(),
    styleGuideCandidates: z.array(z.string()),
    skipped: z.array(
      z.object({
        path: z.string(),
        reason: z.string(),
      }),
    ),
    notes: z.array(z.string()),
  }),
  execute: async ({ directoryPath, recursive }) => {
    const discovered = await discoverLocalizationProject(directoryPath, {
      recursive: recursive ?? true,
    });

    return {
      ...discovered,
      sourcesByKind: Object.fromEntries(
        Object.entries(discovered.sourcesByKind).filter(
          (entry): entry is [string, string[]] => Array.isArray(entry[1]),
        ),
      ),
    };
  },
});

export const projectTools = {
  discover_localization_project: discoverProjectTool,
};
