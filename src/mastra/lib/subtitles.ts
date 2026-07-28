export type SubtitleFormat = 'srt' | 'ass';

export interface SubtitleCue {
  /**
   * Derived from the position of the cue in the file, so parsing the same
   * source twice always yields the same ids. That is what lets the workflow
   * re-read the original file at assembly time instead of carrying the whole
   * document through every step.
   */
  id: string;
  text: string;
  /** Shown to the translator as pacing context; never translated. */
  start?: string;
  end?: string;
  /** ASS style name, which tells apart dialogue from signs and captions. */
  style?: string;
}

const BOM = /^\uFEFF/;

function usesCrlf(raw: string): boolean {
  return raw.includes('\r\n');
}

function toLines(raw: string): string[] {
  return raw.replace(BOM, '').replace(/\r\n/g, '\n').split('\n');
}

export function parseSubtitles(
  raw: string,
  format: SubtitleFormat,
): SubtitleCue[] {
  return format === 'srt' ? parseSrt(raw) : parseAss(raw);
}

/**
 * Returns the document with translated cue text substituted in. Timings, cue
 * numbering, styles, and every ASS section other than the dialogue text are
 * copied through untouched. Cues with no translation keep their source text.
 */
export function rebuildSubtitles(
  raw: string,
  format: SubtitleFormat,
  translations: Map<string, string>,
): string {
  return format === 'srt'
    ? rebuildSrt(raw, translations)
    : rebuildAss(raw, translations);
}

/**
 * Groups cues into batches bounded by both characters and cue count. Order is
 * preserved so the translator always sees neighbouring cues together and can
 * carry a sentence that runs across a cue break.
 */
export function batchCues(
  cues: SubtitleCue[],
  maxChars: number,
  maxCues = 80,
): SubtitleCue[][] {
  const batches: SubtitleCue[][] = [];
  let current: SubtitleCue[] = [];
  let currentChars = 0;

  for (const cue of cues) {
    const cost = cue.id.length + cue.text.length;

    if (
      current.length > 0 &&
      (currentChars + cost > maxChars || current.length >= maxCues)
    ) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(cue);
    currentChars += cost;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/* ------------------------------- SubRip (SRT) ------------------------------ */

type SrtBlock =
  | { kind: 'cue'; id: string; number: string; timing: string; text: string }
  | { kind: 'raw'; text: string };

const SRT_TIMING = /^(\S+)\s+-->\s+(\S+)(.*)$/;

/**
 * Blocks separated by a blank line, each one an optional cue number, a timing
 * line, and the text. Anything that has no timing line is kept verbatim so a
 * malformed or annotated file still round-trips.
 */
function parseSrtBlocks(raw: string): SrtBlock[] {
  const blocks: SrtBlock[] = [];
  let cueNumber = 0;

  for (const chunk of toLines(raw)
    .join('\n')
    .split(/\n\s*\n/)) {
    if (chunk.trim() === '') continue;

    const lines = chunk.split('\n');
    const timingAt = lines.findIndex((line) => line.includes('-->'));

    if (timingAt < 0) {
      blocks.push({ kind: 'raw', text: chunk });
      continue;
    }

    cueNumber += 1;
    blocks.push({
      kind: 'cue',
      id: `cue-${cueNumber}`,
      number: lines.slice(0, timingAt).join('\n').trim() || String(cueNumber),
      timing: lines[timingAt].trim(),
      text: lines
        .slice(timingAt + 1)
        .join('\n')
        .trim(),
    });
  }

  return blocks;
}

function parseSrt(raw: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];

  for (const block of parseSrtBlocks(raw)) {
    if (block.kind !== 'cue' || block.text === '') continue;

    const timing = SRT_TIMING.exec(block.timing);
    cues.push({
      id: block.id,
      text: block.text,
      ...(timing ? { start: timing[1], end: timing[2] } : {}),
    });
  }

  return cues;
}

function rebuildSrt(raw: string, translations: Map<string, string>): string {
  const eol = usesCrlf(raw) ? '\r\n' : '\n';

  const rendered = parseSrtBlocks(raw).map((block) => {
    if (block.kind === 'raw') return block.text;

    const text = translations.get(block.id) ?? block.text;
    return [block.number, block.timing, text].join('\n');
  });

  return `${rendered.join('\n\n')}\n`.replace(/\n/g, eol);
}

/* ------------------------- Advanced SubStation Alpha ------------------------ */

/** Standard v4+ layout, used when the Events section omits its Format line. */
const DEFAULT_ASS_FIELDS = [
  'layer',
  'start',
  'end',
  'style',
  'name',
  'marginl',
  'marginr',
  'marginv',
  'effect',
  'text',
];

interface AssDialogue {
  id: string;
  lineIndex: number;
  /** Everything up to and including the comma before the text field. */
  head: string;
  text: string;
  start?: string;
  end?: string;
  style?: string;
}

function parseAssFields(formatLine: string): string[] {
  const fields = formatLine
    .slice(formatLine.indexOf(':') + 1)
    .split(',')
    .map((field) => field.trim().toLowerCase());

  return fields.includes('text') ? fields : DEFAULT_ASS_FIELDS;
}

/** Offset of the nth comma-separated field, counting from after the `Dialogue:` colon. */
function fieldOffset(line: string, fieldIndex: number): number | null {
  let offset = line.indexOf(':') + 1;
  if (offset === 0) return null;

  for (let i = 0; i < fieldIndex; i += 1) {
    const comma = line.indexOf(',', offset);
    if (comma < 0) return null;
    offset = comma + 1;
  }

  return offset;
}

/**
 * Override tags, hard spaces, and line breaks are markup rather than words, so a
 * cue made only of those (a vector drawing, a positioning-only line) has nothing
 * to translate.
 */
function assVisibleText(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\[Nnh]/g, ' ')
    .trim();
}

function isDrawing(text: string): boolean {
  return /\{[^}]*\\p[1-9]/.test(text);
}

function collectAssDialogues(raw: string): AssDialogue[] {
  const lines = toLines(raw);
  const dialogues: AssDialogue[] = [];

  let inEvents = false;
  let fields = DEFAULT_ASS_FIELDS;

  lines.forEach((line, lineIndex) => {
    const section = /^\s*\[(.+)\]\s*$/.exec(line);
    if (section) {
      inEvents = section[1].trim().toLowerCase() === 'events';
      if (inEvents) fields = DEFAULT_ASS_FIELDS;
      return;
    }

    if (!inEvents) return;

    if (/^\s*Format\s*:/i.test(line)) {
      fields = parseAssFields(line);
      return;
    }

    // Comment lines are not rendered by any player, so translating them would
    // only burn tokens.
    if (!/^\s*Dialogue\s*:/i.test(line)) return;

    const textIndex = fields.indexOf('text');
    const offset = fieldOffset(line, textIndex);
    if (offset === null) return;

    const values = line.slice(line.indexOf(':') + 1).split(',');
    const valueAt = (name: string): string | undefined => {
      const at = fields.indexOf(name);
      return at >= 0 && at < textIndex ? values[at]?.trim() : undefined;
    };

    const start = valueAt('start');
    const end = valueAt('end');
    const style = valueAt('style');

    dialogues.push({
      id: `line-${lineIndex}`,
      lineIndex,
      head: line.slice(0, offset),
      text: line.slice(offset),
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
      ...(style ? { style } : {}),
    });
  });

  return dialogues;
}

function parseAss(raw: string): SubtitleCue[] {
  return collectAssDialogues(raw)
    .filter(
      (dialogue) =>
        !isDrawing(dialogue.text) && assVisibleText(dialogue.text) !== '',
    )
    .map(({ id, text, start, end, style }) => ({
      id,
      text,
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
      ...(style ? { style } : {}),
    }));
}

function rebuildAss(raw: string, translations: Map<string, string>): string {
  const eol = usesCrlf(raw) ? '\r\n' : '\n';
  const lines = toLines(raw);

  for (const dialogue of collectAssDialogues(raw)) {
    const translation = translations.get(dialogue.id);
    if (translation === undefined) continue;

    // A translation that leaked a real newline would split one dialogue line
    // into two and corrupt the Events section.
    lines[dialogue.lineIndex] =
      dialogue.head + translation.replace(/\r?\n/g, '\\N');
  }

  return lines.join(eol);
}
