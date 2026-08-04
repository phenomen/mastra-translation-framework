import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { detectDocumentKind } from '../lib/document-kind';
import { flattenHtml } from '../lib/html';
import { readWorkspaceText } from '../lib/workspace-paths';

async function readHtmlEntries(htmlPath: string) {
  const kind = detectDocumentKind(htmlPath);
  if (kind !== 'html') {
    throw new Error(
      `"${htmlPath}" is not an HTML file. Expected a .html or .htm extension.`,
    );
  }

  const raw = await readWorkspaceText(htmlPath);
  return { entries: flattenHtml(raw) };
}

export const inspectHtmlTool = createTool({
  id: 'inspect_html',
  description:
    'Parse an HTML file and report how many translatable text nodes and attributes it holds, plus a sample of them. Use this to check a page before starting a localization run.',
  inputSchema: z.object({
    htmlPath: z.string().describe('Workspace-relative path to the HTML file.'),
    sampleSize: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe('How many sample entries to return. Defaults to 8.'),
  }),
  outputSchema: z.object({
    htmlPath: z.string(),
    entryCount: z.number(),
    textCount: z.number(),
    attributeCount: z.number(),
    sample: z.array(
      z.object({
        pointer: z.string(),
        value: z.string(),
      }),
    ),
  }),
  execute: async ({ htmlPath, sampleSize }) => {
    const { entries } = await readHtmlEntries(htmlPath);
    const limit = sampleSize ?? 8;

    return {
      htmlPath,
      entryCount: entries.length,
      textCount: entries.filter((entry) => entry.pointer.startsWith('t-'))
        .length,
      attributeCount: entries.filter((entry) => entry.pointer.startsWith('a-'))
        .length,
      sample: entries.slice(0, limit),
    };
  },
});

export const htmlTools = {
  inspect_html: inspectHtmlTool,
};
