import path from 'node:path';

import { Format, toMarkdownBytes } from '@firecrawl/anydoc';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import {
  detectDocumentKind,
  isOfficeKind,
  type OfficeKind,
} from '../lib/document-kind';
import { readWorkspaceBytes } from '../lib/workspace-paths';

const OFFICE_FORMAT: Record<OfficeKind, Format> = {
  doc: Format.doc,
  docx: Format.docx,
  epub: Format.epub,
  rtf: Format.rtf,
  odt: Format.odt,
};

function isConvertError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  );
}

/**
 * Converts a DOC, DOCX, EPUB, RTF, or ODT buffer to markdown via @firecrawl/anydoc.
 * `fileType` is passed explicitly so buffer inputs do not rely on magic bytes.
 */
export async function convertOfficeToMarkdown(
  bytes: Buffer,
  fileType: OfficeKind,
): Promise<string> {
  const markdown = await toMarkdownBytes(bytes, OFFICE_FORMAT[fileType]);
  if (!markdown.trim()) {
    throw new Error(
      `@firecrawl/anydoc returned an empty markdown result for ${fileType.toUpperCase()}.`,
    );
  }

  return markdown;
}

/**
 * Extracts embedded text from a PDF to markdown via @firecrawl/anydoc.
 * Scanned/image-only PDFs cannot be read locally — use remote OCR for those.
 */
export async function convertPdfToMarkdownLocal(
  bytes: Buffer,
): Promise<string> {
  try {
    const markdown = await toMarkdownBytes(bytes, Format.pdf);
    if (!markdown.trim()) {
      throw new Error(
        '@firecrawl/anydoc returned an empty markdown result for PDF. The file may be scanned or image-only; enable remote OCR (remoteOCR) for those.',
      );
    }
    return markdown;
  } catch (error) {
    if (isConvertError(error) && error.code === 'unsupported') {
      throw new Error(
        'PDF could not be converted locally (likely scanned or image-only). Enable remote OCR (remoteOCR) for those.',
        { cause: error },
      );
    }
    throw error;
  }
}

export const convertOfficeToMarkdownTool = createTool({
  id: 'convert_office_to_markdown',
  description:
    'Convert a DOC, DOCX, EPUB, RTF, or ODT document from the workspace to markdown using @firecrawl/anydoc. Use for inspection; full localization runs go through localizeDocumentWorkflow.',
  inputSchema: z.object({
    documentPath: z
      .string()
      .describe(
        'Workspace-relative path to a .doc, .docx, .epub, .rtf, or .odt file.',
      ),
  }),
  outputSchema: z.object({
    documentPath: z.string(),
    kind: z.enum(['doc', 'docx', 'epub', 'rtf', 'odt']),
    markdown: z.string(),
    byteLength: z.number(),
  }),
  execute: async ({ documentPath }) => {
    const kind = detectDocumentKind(documentPath);
    if (!isOfficeKind(kind)) {
      throw new Error(
        `"${documentPath}" is not a DOC, DOCX, EPUB, RTF, or ODT file (detected kind: ${kind}).`,
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
