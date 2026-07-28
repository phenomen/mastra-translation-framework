/**
 * Page ranges are stored 1-based and inclusive throughout, matching pdf-parse and
 * printed page labels. `toPdfLibIndices` is the single place that converts to the
 * 0-based indices pdf-lib and pdfjs-dist expect.
 */
export interface PageRange {
  title?: string;
  startPage: number;
  endPage: number;
}

export interface OutlineStart {
  title: string;
  startPage: number;
}

export interface RangeLimits {
  totalPages: number;
  minPages: number;
  maxPages: number;
}

export function toPdfLibIndices(range: PageRange): number[] {
  const length = range.endPage - range.startPage + 1;
  return Array.from({ length }, (_, offset) => range.startPage - 1 + offset);
}

export function pageCount(range: PageRange): number {
  return range.endPage - range.startPage + 1;
}

/**
 * Turns chapter start pages into contiguous ranges covering the whole document.
 * Any pages before the first start become a leading "Front matter" range so no
 * content is silently dropped.
 */
export function rangesFromStarts(
  starts: OutlineStart[],
  totalPages: number,
): PageRange[] {
  const seen = new Set<number>();
  const sorted = starts
    .filter((start) => Number.isInteger(start.startPage))
    .map((start) => ({
      ...start,
      startPage: clamp(start.startPage, 1, totalPages),
    }))
    .sort((a, b) => a.startPage - b.startPage)
    .filter((start) => {
      if (seen.has(start.startPage)) return false;
      seen.add(start.startPage);
      return true;
    });

  if (sorted.length === 0) return [];

  const ranges: PageRange[] = [];

  if (sorted[0].startPage > 1) {
    ranges.push({
      title: 'Front matter',
      startPage: 1,
      endPage: sorted[0].startPage - 1,
    });
  }

  sorted.forEach((start, index) => {
    const next = sorted[index + 1];
    ranges.push({
      title: start.title,
      startPage: start.startPage,
      endPage: next ? next.startPage - 1 : totalPages,
    });
  });

  return ranges.filter((range) => range.endPage >= range.startPage);
}

export function fixedWindows(
  totalPages: number,
  pagesPerPart: number,
): PageRange[] {
  const ranges: PageRange[] = [];
  const size = Math.max(1, pagesPerPart);

  for (let start = 1; start <= totalPages; start += size) {
    ranges.push({
      startPage: start,
      endPage: Math.min(start + size - 1, totalPages),
    });
  }

  return ranges;
}

/** Merges runt ranges into their neighbours, then splits any range that is too long. */
export function normalizeRanges(
  ranges: PageRange[],
  limits: RangeLimits,
): PageRange[] {
  return splitOversized(mergeUndersized(ranges, limits), limits);
}

function mergeUndersized(
  ranges: PageRange[],
  limits: RangeLimits,
): PageRange[] {
  const merged: PageRange[] = [];

  for (const range of ranges) {
    const previous = merged[merged.length - 1];

    if (
      previous &&
      pageCount(previous) < limits.minPages &&
      pageCount(previous) + pageCount(range) <= limits.maxPages
    ) {
      merged[merged.length - 1] = {
        title: previous.title,
        startPage: previous.startPage,
        endPage: range.endPage,
      };
      continue;
    }

    merged.push({ ...range });
  }

  // A trailing runt has no following range to absorb it, so fold it backwards.
  if (merged.length > 1) {
    const last = merged[merged.length - 1];
    const previous = merged[merged.length - 2];
    if (
      pageCount(last) < limits.minPages &&
      pageCount(previous) + pageCount(last) <= limits.maxPages
    ) {
      merged.splice(merged.length - 2, 2, {
        title: previous.title,
        startPage: previous.startPage,
        endPage: last.endPage,
      });
    }
  }

  return merged;
}

function splitOversized(ranges: PageRange[], limits: RangeLimits): PageRange[] {
  const result: PageRange[] = [];

  for (const range of ranges) {
    if (pageCount(range) <= limits.maxPages) {
      result.push(range);
      continue;
    }

    for (
      let start = range.startPage;
      start <= range.endPage;
      start += limits.maxPages
    ) {
      result.push({
        title: range.title,
        startPage: start,
        endPage: Math.min(start + limits.maxPages - 1, range.endPage),
      });
    }
  }

  return result;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
