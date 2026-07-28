import type { OutlineStart } from './page-ranges';

export interface TocCandidate {
  title: string;
  /** The page number as printed in the table of contents, not the physical page. */
  printedPage: number;
}

/** `Chapter One .......... 12`, `1.2 Scope    45`, `Appendix A — 210` */
const TOC_LINE = /^(.+?)[\s.·:_–—-]{2,}(\d{1,4})$/;

const MIN_TITLE_LENGTH = 3;

export interface TocScan {
  candidates: TocCandidate[];
  /** Last physical page that looked like part of the contents listing. */
  tocEndPage: number;
}

/** A page needs at least this many entries before it counts as a contents page. */
const MIN_CANDIDATES_PER_PAGE = 2;

const MIN_TOTAL_CANDIDATES = 3;

/**
 * Scans page by page rather than over concatenated text, because the contents
 * listing repeats every chapter title. Without knowing where the listing ends, a
 * search for a chapter's real page matches the contents page itself and yields an
 * offset of zero.
 */
export function scanTocPages(
  pages: Array<{ num: number; text: string }>,
): TocScan | null {
  const contentsPages = pages
    .map((page) => ({
      num: page.num,
      candidates: parseTocCandidates(page.text),
    }))
    .filter((page) => page.candidates.length >= MIN_CANDIDATES_PER_PAGE);

  if (contentsPages.length === 0) return null;

  const candidates = dedupeByTitle(
    contentsPages.flatMap((page) => page.candidates),
  );
  if (candidates.length < MIN_TOTAL_CANDIDATES) return null;

  return {
    candidates,
    tocEndPage: Math.max(...contentsPages.map((page) => page.num)),
  };
}

export function parseTocCandidates(text: string): TocCandidate[] {
  const candidates: TocCandidate[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = TOC_LINE.exec(line);
    if (!match) continue;

    const title = match[1].replace(/[\s.·:_–—-]+$/, '').trim();
    const printedPage = Number.parseInt(match[2], 10);

    if (title.length < MIN_TITLE_LENGTH) continue;
    if (!Number.isInteger(printedPage) || printedPage < 1) continue;
    // A line that is mostly digits is more likely a stray table row than a heading.
    if (/^\d+$/.test(title)) continue;

    candidates.push({ title, printedPage });
  }

  return dedupeByTitle(candidates);
}

function dedupeByTitle(candidates: TocCandidate[]): TocCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = normalizeForMatch(candidate.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Titles are matched loosely because OCR and text extraction reflow whitespace and
 * often break a heading across lines. Comparing the first few significant words
 * is far more reliable than an exact substring test.
 */
export function titleAppearsIn(title: string, pageText: string): boolean {
  const normalizedTitle = normalizeForMatch(title);
  const normalizedPage = normalizeForMatch(pageText);
  if (!normalizedTitle || !normalizedPage) return false;

  if (normalizedPage.includes(normalizedTitle)) return true;

  const words = normalizedTitle.split(' ').filter((word) => word.length > 2);
  if (words.length === 0) return false;

  const probe = words.slice(0, 4).join(' ');
  return probe.length >= MIN_TITLE_LENGTH && normalizedPage.includes(probe);
}

export function tocCandidatesToStarts(
  candidates: TocCandidate[],
  pageOffset: number,
  totalPages: number,
): OutlineStart[] {
  return candidates
    .map((candidate) => ({
      title: candidate.title,
      startPage: candidate.printedPage + pageOffset,
    }))
    .filter((start) => start.startPage >= 1 && start.startPage <= totalPages);
}
