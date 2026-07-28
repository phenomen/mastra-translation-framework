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

/**
 * Splits a document into parts small enough to translate in one call, preferring
 * heading boundaries and falling back to paragraph packing.
 *
 * Headings and fences inside code blocks are ignored so that a `#` comment in a
 * shell snippet never becomes a chapter break.
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
  const headingLevels = collectHeadingLevels(lines);

  let candidate: Section[] = [{ lines }];

  for (const level of headingLevels) {
    const sections = splitAtHeadingLevel(lines, level);
    if (sections.length <= 1) continue;

    candidate = sections;
    if (
      sections.every((section) => sectionText(section).length <= maxPartChars)
    )
      break;
  }

  const parts: DocumentPart[] = [];

  for (const section of candidate) {
    const text = sectionText(section);
    if (!text) continue;

    if (text.length <= maxPartChars) {
      parts.push({
        index: parts.length + 1,
        title: section.title,
        content: text,
      });
      continue;
    }

    for (const piece of packBlocks(text, maxPartChars)) {
      parts.push({
        index: parts.length + 1,
        title: section.title,
        content: piece,
      });
    }
  }

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
