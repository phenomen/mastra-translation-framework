import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { detectDocumentKind, isOfficeKind } from '../lib/document-kind';
import {
  readWorkspaceBytes,
  readWorkspaceText,
  writeWorkspaceFile,
} from '../lib/workspace-paths';

export const readDocumentTool = createTool({
  id: 'read_document',
  description:
    'Read a document from the workspace and report its kind. Text, markdown, JSON, and subtitle documents return their content; PDFs and office documents (DOCX, RTF, ODT) return only metadata because they must go through their conversion tools.',
  inputSchema: z.object({
    documentPath: z
      .string()
      .describe(
        'Workspace-relative path to the document (.txt, .md, .json, .srt, .ass, .pdf, .docx, .rtf, .odt).',
      ),
  }),
  outputSchema: z.object({
    documentPath: z.string(),
    kind: z.enum([
      'pdf',
      'json',
      'markdown',
      'text',
      'srt',
      'ass',
      'docx',
      'rtf',
      'odt',
    ]),
    byteLength: z.number(),
    content: z.string().optional(),
  }),
  execute: async ({ documentPath }) => {
    const kind = detectDocumentKind(documentPath);

    if (kind === 'pdf' || isOfficeKind(kind)) {
      const bytes = await readWorkspaceBytes(documentPath);
      return { documentPath, kind, byteLength: bytes.byteLength };
    }

    const content = await readWorkspaceText(documentPath);
    return {
      documentPath,
      kind,
      byteLength: Buffer.byteLength(content),
      content,
    };
  },
});

export const writeDocumentTool = createTool({
  id: 'write_document',
  description:
    'Write text content to a workspace-relative path, creating directories as needed.',
  inputSchema: z.object({
    documentPath: z.string().describe('Workspace-relative path to write to.'),
    content: z.string().describe('The content to write.'),
  }),
  outputSchema: z.object({
    documentPath: z.string(),
    byteLength: z.number(),
  }),
  execute: async ({ documentPath, content }) => {
    const written = await writeWorkspaceFile(documentPath, content);
    return { documentPath: written, byteLength: Buffer.byteLength(content) };
  },
});

export const documentTools = {
  read_document: readDocumentTool,
  write_document: writeDocumentTool,
};
