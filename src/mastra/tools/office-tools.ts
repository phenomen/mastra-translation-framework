import path from 'node:path';

import { createTool } from '@mastra/core/tools';
import { OfficeConverter } from 'officeparser';
import { z } from 'zod';

import {
  detectDocumentKind,
  isOfficeKind,
  type OfficeKind,
} from '../lib/document-kind';
import { readWorkspaceBytes } from '../lib/workspace-paths';

/**
 * Converts a DOCX, RTF, or ODT buffer to markdown via officeparser.
 * `fileType` is passed explicitly so buffer inputs do not rely on magic bytes.
 */
export async function convertOfficeToMarkdown(
  bytes: Buffer,
  fileType: OfficeKind,
): Promise<string> {
  const { value } = await OfficeConverter.convert(bytes, 'md', {
    parseConfig: { fileType },
  });

  const markdown = typeof value === 'string' ? value : '';
  if (!markdown.trim()) {
    throw new Error(
      `officeparser returned an empty markdown result for ${fileType.toUpperCase()}.`,
    );
  }

  return markdown;
}

/**
 * Extracts embedded text from a PDF to markdown via officeparser.
 * OCR is intentionally disabled — scanned/image-only PDFs will yield little or no text.
 */
export async function convertPdfToMarkdownLocal(
  bytes: Buffer,
): Promise<string> {
  const { value } = await OfficeConverter.convert(bytes, 'md', {
    parseConfig: { fileType: 'pdf', ocr: false },
    generatorConfig: { includeImages: false },
  });

  const markdown = typeof value === 'string' ? value : '';
  if (!markdown.trim()) {
    throw new Error(
      'officeparser returned an empty markdown result for PDF. The file may be scanned or image-only; enable remote OCR (DATALAB_API_KEY / remoteOCR) for those.',
    );
  }

  return markdown;
}

export const convertOfficeToMarkdownTool = createTool({
  id: 'convert_office_to_markdown',
  description:
    'Convert a DOCX, RTF, or ODT document from the workspace to markdown using officeparser. Use for inspection; full localization runs go through localizeDocumentWorkflow.',
  inputSchema: z.object({
    documentPath: z
      .string()
      .describe('Workspace-relative path to a .docx, .rtf, or .odt file.'),
  }),
  outputSchema: z.object({
    documentPath: z.string(),
    kind: z.enum(['docx', 'rtf', 'odt']),
    markdown: z.string(),
    byteLength: z.number(),
  }),
  execute: async ({ documentPath }) => {
    const kind = detectDocumentKind(documentPath);
    if (!isOfficeKind(kind)) {
      throw new Error(
        `"${documentPath}" is not a DOCX, RTF, or ODT file (detected kind: ${kind}).`,
      );
    }

    const bytes = await readWorkspaceBytes(documentPath);
    const markdown = await convertOfficeToMarkdown(bytes, kind);

    return {
      documentPath: path.posix.normalize(documentPath.replace(/\\/g, '/')),
      kind,
      markdown,
      byteLength: bytes.byteLength,
    };
  },
});

export const officeTools = {
  convert_office_to_markdown: convertOfficeToMarkdownTool,
};
