export interface DocumentPart {
  index: number;
  title?: string;
  content: string;
}

interface Section {
  title?: string;
  lines: string[];
}

const HEADING_PATTERN = /^(#{1,6})\s+(.*\S)\s*$/;
const FENCE_PATTERN = /^\s*(```|~~~)/;

/** Preferred cut points when packing up to the character budget. */
const PRIMARY_HEADING_LEVELS = new Set([1, 2]);

/**
 * Splits a document into parts small enough to translate in one call.
 *
 * Strategy:
 * 1. Cut on h1/h2 boundaries (ignoring headings inside fenced code).
 * 2. Greedily pack consecutive sections until `maxPartChars` would be exceeded,
 *    so the cut lands on the nearest prior h1/h2 once the budget is full.
 * 3. If a single h1/h2 section is still too large, split it on deeper headings,
 *    then fall back to paragraph packing and hard line splits.
 */
export function chunkDocument(
  content: string,
  maxPartChars: number,
): DocumentPart[] {
  const normalized = content.replace(/\r\n/g, '\n');
  if (normalized.trim().length === 0) return [];

  if (normalized.length <= maxPartChars) {
    return [{ index: 1, content: normalized.trim() }];
  }

  const lines = normalized.split('\n');
  const primaryLevel = primarySplitLevel(lines);

  const primarySections =
    primaryLevel === null
      ? [{ lines }]
      : splitAtHeadingLevel(lines, primaryLevel);

  const atomic = primarySections.flatMap((section) =>
    expandOversizedSection(section, maxPartChars),
  );

  return packSections(atomic, maxPartChars);
}

/**
 * Returns 2 when the doc has any h2 (split on h1 and h2), 1 when only h1,
 * or null when there are no primary headings.
 */
function primarySplitLevel(lines: string[]): number | null {
  const levels = collectHeadingLevels(lines).filter((level) =>
    PRIMARY_HEADING_LEVELS.has(level),
  );
  if (levels.length === 0) return null;
  return Math.max(...levels);
}

/**
 * Break an oversized section into pieces that each fit the budget, preferring
 * deeper markdown headings before paragraph packing.
 */
function expandOversizedSection(
  section: Section,
  maxPartChars: number,
): Section[] {
  const text = sectionText(section);
  if (!text) return [];
  if (text.length <= maxPartChars) return [section];

  const deeperLevels = collectHeadingLevels(section.lines)
    .filter((level) => level >= 3)
    .sort((a, b) => a - b);

  for (const level of deeperLevels) {
    const subsections = splitAtHeadingLevel(section.lines, level);
    if (subsections.length <= 1) continue;

    return subsections.flatMap((subsection) =>
      expandOversizedSection(subsection, maxPartChars),
    );
  }

  return packBlocks(text, maxPartChars).map((piece) => ({
    ...(section.title ? { title: section.title } : {}),
    lines: piece.split('\n'),
  }));
}

/**
 * Merge consecutive atomic sections until adding the next one would exceed the
 * budget — that is the "nearest prior h1/h2" cut the caller asked for.
 */
function packSections(
  sections: Section[],
  maxPartChars: number,
): DocumentPart[] {
  const parts: DocumentPart[] = [];
  let current: Section[] = [];
  let currentLength = 0;

  const flush = () => {
    if (current.length === 0) return;

    const content = current
      .map(sectionText)
      .filter((piece) => piece.length > 0)
      .join('\n\n');

    if (content) {
      const title = current.find((section) => section.title)?.title;
      parts.push({
        index: parts.length + 1,
        ...(title ? { title } : {}),
        content,
      });
    }

    current = [];
    currentLength = 0;
  };

  for (const section of sections) {
    const text = sectionText(section);
    if (!text) continue;

    if (text.length > maxPartChars) {
      flush();
      for (const piece of packBlocks(text, maxPartChars)) {
        parts.push({
          index: parts.length + 1,
          ...(section.title ? { title: section.title } : {}),
          content: piece,
        });
      }
      continue;
    }

    const separator = currentLength > 0 ? 2 : 0;
    if (
      currentLength > 0 &&
      currentLength + separator + text.length > maxPartChars
    ) {
      flush();
    }

    current.push(section);
    currentLength += (currentLength > 0 ? 2 : 0) + text.length;
  }

  flush();
  return parts;
}

function collectHeadingLevels(lines: string[]): number[] {
  const levels = new Set<number>();
  let inFence = false;

  for (const line of lines) {
    if (FENCE_PATTERN.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = HEADING_PATTERN.exec(line);
    if (match) levels.add(match[1].length);
  }

  return [...levels].sort((a, b) => a - b);
}

function splitAtHeadingLevel(lines: string[], maxLevel: number): Section[] {
  const sections: Section[] = [];
  let current: Section = { lines: [] };
  let inFence = false;

  for (const line of lines) {
    if (FENCE_PATTERN.test(line)) {
      inFence = !inFence;
      current.lines.push(line);
      continue;
    }

    const match = inFence ? null : HEADING_PATTERN.exec(line);

    if (match && match[1].length <= maxLevel) {
      if (sectionText(current)) sections.push(current);
      current = { title: match[2], lines: [line] };
      continue;
    }

    current.lines.push(line);
  }

  if (sectionText(current)) sections.push(current);
  return sections;
}

function sectionText(section: Section): string {
  return section.lines.join('\n').trim();
}

/**
 * Greedily packs blank-line-separated blocks up to the limit. Fenced code blocks
 * are treated as single atomic blocks so they are never cut in half.
 */
function packBlocks(text: string, maxChars: number): string[] {
  const blocks = splitIntoBlocks(text);
  const packed: string[] = [];
  let current: string[] = [];
  let currentLength = 0;

  const flush = () => {
    if (current.length > 0) {
      packed.push(current.join('\n\n').trim());
      current = [];
      currentLength = 0;
    }
  };

  for (const block of blocks) {
    if (block.length > maxChars) {
      flush();
      packed.push(...hardSplit(block, maxChars));
      continue;
    }

    if (currentLength > 0 && currentLength + block.length + 2 > maxChars)
      flush();

    current.push(block);
    currentLength += block.length + 2;
  }

  flush();
  return packed.filter((piece) => piece.length > 0);
}

function splitIntoBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = () => {
    const joined = current.join('\n').trim();
    if (joined) blocks.push(joined);
    current = [];
  };

  for (const line of text.split('\n')) {
    if (FENCE_PATTERN.test(line)) {
      inFence = !inFence;
      current.push(line);
      if (!inFence) flush();
      continue;
    }

    if (!inFence && line.trim() === '') {
      flush();
      continue;
    }

    current.push(line);
  }

  flush();
  return blocks;
}

/** Last resort for a single block larger than the limit: break on line boundaries. */
function hardSplit(block: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const line of block.split('\n')) {
    if (currentLength > 0 && currentLength + line.length + 1 > maxChars) {
      pieces.push(current.join('\n'));
      current = [];
      currentLength = 0;
    }

    current.push(line);
    currentLength += line.length + 1;
  }

  if (current.length > 0) pieces.push(current.join('\n'));
  return pieces;
}
