import path from 'node:path';

import { createTool } from '@mastra/core/tools';
import { PDFDocument } from 'pdf-lib';
import { z } from 'zod';

import {
  DEFAULT_MAX_PAGES_PER_PART,
  DEFAULT_MIN_PAGES_PER_PART,
  TOC_SCAN_PAGES,
} from '../config';
import {
  fixedWindows,
  normalizeRanges,
  rangesFromStarts,
  toPdfLibIndices,
  type OutlineStart,
  type PageRange,
} from '../lib/page-ranges';
import { loadPdfjs, type PdfjsGetDocument } from '../lib/pdfjs';
import {
  scanTocPages,
  titleAppearsIn,
  tocCandidatesToStarts,
  type TocCandidate,
} from '../lib/toc';
import { readWorkspaceBytes, writeWorkspaceFile } from '../lib/workspace-paths';

export type PartPlanSource = 'outline' | 'toc' | 'windows';

export interface PdfPartPlan {
  source: PartPlanSource;
  totalPages: number;
  ranges: PageRange[];
  /** Physical page minus printed page, when the plan came from a table of contents. */
  pageOffset?: number;
}

interface PageText {
  num: number;
  text: string;
}

type OutlineItem = {
  title: string;
  dest: string | unknown[] | null;
  items?: unknown[];
};
type PdfDocumentProxy = Awaited<ReturnType<PdfjsGetDocument>['promise']>;
type PdfTextContent = Awaited<
  ReturnType<Awaited<ReturnType<PdfDocumentProxy['getPage']>>['getTextContent']>
>;

/**
 * pdf.js may detach the ArrayBuffer it is handed, so every consumer gets its own
 * copy of the bytes.
 */
function toOwnedBytes(bytes: Buffer): Uint8Array {
  return new Uint8Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

async function withPdfDocument<T>(
  bytes: Buffer,
  run: (doc: PdfDocumentProxy) => Promise<T>,
): Promise<T> {
  const { getDocument } = await loadPdfjs();
  const loadingTask = getDocument({
    data: toOwnedBytes(bytes),
    useSystemFonts: true,
  });

  try {
    return await run(await loadingTask.promise);
  } finally {
    await loadingTask.destroy();
  }
}

/** Join pdf.js text items, keeping EOL markers so TOC lines stay parseable. */
function textContentToString(content: PdfTextContent): string {
  const parts: string[] = [];

  for (const item of content.items) {
    if (!('str' in item)) continue;
    parts.push(item.str);
    parts.push(item.hasEOL ? '\n' : ' ');
  }

  return parts
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function resolveSelectedPages(
  totalPages: number,
  selection: { pages?: number[]; firstPage?: number; lastPage?: number },
): number[] {
  if (selection.pages?.length) {
    return unique(
      selection.pages.filter((page) => page >= 1 && page <= totalPages),
    );
  }

  const { firstPage, lastPage } = selection;

  // Match former pdf-parse semantics: first alone = first N pages, last alone =
  // last N pages, both together = inclusive range firstPage..lastPage.
  let from = 1;
  let to = totalPages;

  if (firstPage !== undefined && lastPage !== undefined) {
    from = firstPage;
    to = lastPage;
  } else if (firstPage !== undefined) {
    from = 1;
    to = firstPage;
  } else if (lastPage !== undefined) {
    from = totalPages - lastPage + 1;
    to = totalPages;
  }

  from = Math.max(1, Math.min(from, totalPages));
  to = Math.max(from, Math.min(to, totalPages));
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

export async function extractPdfPages(
  bytes: Buffer,
  selection: { pages?: number[]; firstPage?: number; lastPage?: number } = {},
): Promise<{ totalPages: number; pages: PageText[] }> {
  return withPdfDocument(bytes, async (doc) => {
    const totalPages = doc.numPages;
    const pageNumbers = resolveSelectedPages(totalPages, selection);
    const pages: PageText[] = [];

    for (const num of pageNumbers) {
      const page = await doc.getPage(num);
      try {
        const content = await page.getTextContent();
        pages.push({ num, text: textContentToString(content) });
      } finally {
        page.cleanup();
      }
    }

    return { totalPages, pages };
  });
}

async function readOutlineStarts(
  bytes: Buffer,
): Promise<{ totalPages: number; starts: OutlineStart[] }> {
  return withPdfDocument(bytes, async (doc) => {
    const totalPages = doc.numPages;
    const outline = await doc.getOutline();
    if (!outline || outline.length === 0) return { totalPages, starts: [] };

    let starts = await resolveOutlineLevel(doc, outline, totalPages);

    // A single root node such as "Contents" is useless as a split plan; in that
    // case the real chapters are one level deeper.
    if (starts.length < 2) {
      const children = outline.flatMap(
        (item) => (item.items ?? []) as typeof outline,
      );
      if (children.length > 0) {
        const deeper = await resolveOutlineLevel(doc, children, totalPages);
        if (deeper.length > starts.length) starts = deeper;
      }
    }

    return { totalPages, starts };
  });
}

async function resolveOutlineLevel(
  doc: PdfDocumentProxy,
  items: unknown[],
  totalPages: number,
): Promise<OutlineStart[]> {
  const starts: OutlineStart[] = [];

  for (const raw of items) {
    const item = raw as OutlineItem;
    if (!item || typeof item.title !== 'string') continue;

    const pageIndex = await resolveDestinationPageIndex(doc, item.dest);
    if (pageIndex === null) continue;

    const startPage = pageIndex + 1;
    if (startPage >= 1 && startPage <= totalPages) {
      starts.push({ title: item.title.trim(), startPage });
    }
  }

  return starts;
}

async function resolveDestinationPageIndex(
  doc: PdfDocumentProxy,
  dest: string | unknown[] | null,
): Promise<number | null> {
  try {
    const explicit =
      typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;

    const target = explicit[0];

    // Explicit destinations reference a page object; some use a bare page index.
    if (typeof target === 'number') return target;
    if (
      target &&
      typeof target === 'object' &&
      'num' in (target as Record<string, unknown>)
    ) {
      return await doc.getPageIndex(target as { num: number; gen: number });
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Reads the printed table of contents and, as PLAN.md requires, verifies that the
 * page numbers it claims actually match the document. Front matter usually shifts
 * printed numbers by a constant offset, so the offset is discovered and then
 * validated against a sample of entries.
 */
async function findTocStarts(
  bytes: Buffer,
  totalPages: number,
): Promise<{ starts: OutlineStart[]; pageOffset: number } | null> {
  const scanPages = Math.min(TOC_SCAN_PAGES, totalPages);
  const { pages } = await extractPdfPages(bytes, { firstPage: scanPages });
  const scan = scanTocPages(pages);
  if (!scan) return null;

  const { candidates, tocEndPage } = scan;
  const firstBodyPage = tocEndPage + 1;

  const offset = await discoverPageOffset(
    bytes,
    candidates,
    totalPages,
    firstBodyPage,
  );
  if (offset === null) return null;

  const verifiable = sampleEvenly(candidates, 8).filter((candidate) => {
    const page = candidate.printedPage + offset;
    return page >= firstBodyPage && page <= totalPages;
  });

  if (verifiable.length === 0) return null;

  const { pages: verifyPages } = await extractPdfPages(bytes, {
    pages: unique(
      verifiable.map((candidate) => candidate.printedPage + offset),
    ),
  });
  const textByPage = new Map(verifyPages.map((page) => [page.num, page.text]));

  const matches = verifiable.filter((candidate) => {
    const text = textByPage.get(candidate.printedPage + offset);
    return text ? titleAppearsIn(candidate.title, text) : false;
  }).length;

  // An unreliable offset produces a worse split than fixed windows, so demand
  // that most sampled chapters actually start where the offset predicts.
  if (matches * 2 < verifiable.length) return null;

  const starts = tocCandidatesToStarts(candidates, offset, totalPages).filter(
    (start) => start.startPage >= firstBodyPage,
  );

  return starts.length >= 2 ? { starts, pageOffset: offset } : null;
}

const MAX_OFFSET_SEARCH = 25;

async function discoverPageOffset(
  bytes: Buffer,
  candidates: TocCandidate[],
  totalPages: number,
  firstBodyPage: number,
): Promise<number | null> {
  for (const candidate of candidates.slice(0, 3)) {
    const from = Math.max(candidate.printedPage, firstBodyPage);
    const to = Math.min(from + MAX_OFFSET_SEARCH, totalPages);
    if (from > totalPages) continue;

    const window = Array.from(
      { length: to - from + 1 },
      (_, index) => from + index,
    );
    const { pages } = await extractPdfPages(bytes, { pages: window });

    const hit = pages.find((page) =>
      titleAppearsIn(candidate.title, page.text),
    );
    if (hit) return hit.num - candidate.printedPage;
  }

  return null;
}

export async function planPdfParts(
  bytes: Buffer,
  limits: { maxPagesPerPart?: number; minPagesPerPart?: number } = {},
): Promise<PdfPartPlan> {
  const maxPages = limits.maxPagesPerPart ?? DEFAULT_MAX_PAGES_PER_PART;
  const minPages = limits.minPagesPerPart ?? DEFAULT_MIN_PAGES_PER_PART;

  const { totalPages, starts } = await readOutlineStarts(bytes);
  const rangeLimits = { totalPages, minPages, maxPages };

  if (starts.length >= 2) {
    return {
      source: 'outline',
      totalPages,
      ranges: normalizeRanges(
        rangesFromStarts(starts, totalPages),
        rangeLimits,
      ),
    };
  }

  const toc = await findTocStarts(bytes, totalPages);
  if (toc) {
    return {
      source: 'toc',
      totalPages,
      pageOffset: toc.pageOffset,
      ranges: normalizeRanges(
        rangesFromStarts(toc.starts, totalPages),
        rangeLimits,
      ),
    };
  }

  return {
    source: 'windows',
    totalPages,
    ranges: fixedWindows(totalPages, maxPages),
  };
}

export interface SplitPart {
  index: number;
  partPath: string;
  startPage: number;
  endPage: number;
  title?: string;
}

export async function splitPdfByRanges(
  bytes: Buffer,
  ranges: PageRange[],
  outputDir: string,
  baseName: string,
): Promise<SplitPart[]> {
  const source = await PDFDocument.load(toOwnedBytes(bytes), {
    ignoreEncryption: true,
  });
  const parts: SplitPart[] = [];

  for (const [position, range] of ranges.entries()) {
    const target = await PDFDocument.create();
    const copied = await target.copyPages(source, toPdfLibIndices(range));
    for (const page of copied) target.addPage(page);

    const index = position + 1;
    const fileName = `${baseName}.part-${String(index).padStart(3, '0')}.pdf`;
    const partPath = await writeWorkspaceFile(
      path.posix.join(outputDir, fileName),
      await target.save(),
    );

    parts.push({
      index,
      partPath,
      startPage: range.startPage,
      endPage: range.endPage,
      ...(range.title ? { title: range.title } : {}),
    });
  }

  return parts;
}

function sampleEvenly<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const step = items.length / count;
  return Array.from(
    { length: count },
    (_, index) => items[Math.floor(index * step)],
  );
}

function unique(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

const pageRangeSchema = z.object({
  title: z.string().optional(),
  startPage: z
    .number()
    .int()
    .min(1)
    .describe('First page of the range, 1-based and inclusive.'),
  endPage: z
    .number()
    .int()
    .min(1)
    .describe('Last page of the range, 1-based and inclusive.'),
});

export const inspectPdfOutlineTool = createTool({
  id: 'inspect_pdf_outline',
  description:
    'Work out how a PDF should be divided into parts, preferring embedded bookmarks, then a verified printed table of contents, then fixed page windows.',
  inputSchema: z.object({
    documentPath: z.string().describe('Workspace-relative path to the PDF.'),
    maxPagesPerPart: z.number().int().min(1).optional(),
    minPagesPerPart: z.number().int().min(1).optional(),
  }),
  outputSchema: z.object({
    source: z.enum(['outline', 'toc', 'windows']),
    totalPages: z.number(),
    pageOffset: z.number().optional(),
    ranges: z.array(pageRangeSchema),
  }),
  execute: async ({ documentPath, maxPagesPerPart, minPagesPerPart }) => {
    const bytes = await readWorkspaceBytes(documentPath);
    return planPdfParts(bytes, { maxPagesPerPart, minPagesPerPart });
  },
});

export const extractPdfTextTool = createTool({
  id: 'extract_pdf_text',
  description:
    'Extract embedded text from a PDF, optionally limited to specific pages. Page numbers are 1-based. Scanned PDFs with no text layer return empty pages and need OCR instead.',
  inputSchema: z.object({
    documentPath: z.string().describe('Workspace-relative path to the PDF.'),
    pages: z
      .array(z.number().int().min(1))
      .optional()
      .describe('Specific 1-based page numbers.'),
    firstPage: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Alone: extract the first N pages. With lastPage: start of an inclusive range.',
      ),
    lastPage: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Alone: extract the last N pages. With firstPage: end of an inclusive range.',
      ),
  }),
  outputSchema: z.object({
    totalPages: z.number(),
    pages: z.array(z.object({ num: z.number(), text: z.string() })),
  }),
  execute: async ({ documentPath, pages, firstPage, lastPage }) => {
    const bytes = await readWorkspaceBytes(documentPath);
    return extractPdfPages(bytes, { pages, firstPage, lastPage });
  },
});

export const splitPdfTool = createTool({
  id: 'split_pdf',
  description:
    'Split a PDF into separate files, one per 1-based inclusive page range.',
  inputSchema: z.object({
    documentPath: z.string().describe('Workspace-relative path to the PDF.'),
    ranges: z.array(pageRangeSchema).min(1),
    outputDir: z
      .string()
      .describe('Workspace-relative directory to write the parts into.'),
  }),
  outputSchema: z.object({
    parts: z.array(
      z.object({
        index: z.number(),
        partPath: z.string(),
        startPage: z.number(),
        endPage: z.number(),
        title: z.string().optional(),
      }),
    ),
  }),
  execute: async ({ documentPath, ranges, outputDir }) => {
    const bytes = await readWorkspaceBytes(documentPath);
    const baseName = path.basename(documentPath, path.extname(documentPath));
    const parts = await splitPdfByRanges(bytes, ranges, outputDir, baseName);
    return { parts };
  },
});

export const pdfTools = {
  inspect_pdf_outline: inspectPdfOutlineTool,
  extract_pdf_text: extractPdfTextTool,
  split_pdf: splitPdfTool,
};
