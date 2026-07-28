export type GlossaryFormat = 'json' | 'csv' | 'markdown' | 'text';

export type GlossaryOrigin = 'seed' | 'translator';

export interface GlossaryTerm {
  source: string;
  target: string;
  notes?: string;
  origin: GlossaryOrigin;
}

export interface Glossary {
  terms: GlossaryTerm[];
}

const SOURCE_KEYS = ['source', 'term', 'src', 'from', 'key', 'original', 'en'];
const TARGET_KEYS = [
  'target',
  'translation',
  'tgt',
  'to',
  'value',
  'translated',
];
const NOTES_KEYS = [
  'notes',
  'note',
  'comment',
  'context',
  'description',
  'group',
];

/**
 * Separators are tried in this order rather than by position, so `a = b: c`
 * splits on `=` and keeps `b: c` as the target.
 */
const PAIR_SEPARATORS = ['\t', '=>', '->', '=', '—', '–', ':', ';'];

export function detectGlossaryFormat(filename: string): GlossaryFormat {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  return 'text';
}

export function parseGlossary(
  content: string,
  format: GlossaryFormat,
  origin: GlossaryOrigin = 'seed',
): GlossaryTerm[] {
  switch (format) {
    case 'json':
      return parseJsonGlossary(content, origin);
    case 'csv':
      return parseCsvGlossary(content, origin);
    case 'markdown':
      return parseMarkdownGlossary(content, origin);
    case 'text':
      return parseTextGlossary(content, origin);
  }
}

function normalizeKey(source: string): string {
  return source.trim().toLowerCase();
}

function makeTerm(
  source: unknown,
  target: unknown,
  notes: unknown,
  origin: GlossaryOrigin,
): GlossaryTerm | null {
  const sourceText = typeof source === 'string' ? source.trim() : '';
  const targetText = typeof target === 'string' ? target.trim() : '';
  if (!sourceText || !targetText) return null;

  const notesText = typeof notes === 'string' ? notes.trim() : '';
  return {
    source: sourceText,
    target: targetText,
    ...(notesText ? { notes: notesText } : {}),
    origin,
  };
}

function pickKey(
  record: Record<string, unknown>,
  candidates: string[],
): unknown {
  for (const [key, value] of Object.entries(record)) {
    if (candidates.includes(key.trim().toLowerCase())) return value;
  }
  return undefined;
}

function parseJsonGlossary(
  content: string,
  origin: GlossaryOrigin,
): GlossaryTerm[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Glossary is not valid JSON: ${(error as Error).message}`);
  }

  const entries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.terms)
      ? parsed.terms
      : null;

  if (entries) {
    return entries
      .map((entry) => {
        if (!isRecord(entry)) return null;
        return makeTerm(
          pickKey(entry, SOURCE_KEYS),
          pickKey(entry, TARGET_KEYS),
          pickKey(entry, NOTES_KEYS),
          origin,
        );
      })
      .filter((term): term is GlossaryTerm => term !== null);
  }

  // Flat `{ "source": "target" }` map.
  if (isRecord(parsed)) {
    return Object.entries(parsed)
      .map(([source, target]) => makeTerm(source, target, undefined, origin))
      .filter((term): term is GlossaryTerm => term !== null);
  }

  return [];
}

/**
 * Quote-aware but line-based: a quoted field containing a literal newline is not
 * supported, which glossary rows never need.
 */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',' || char === ';') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  fields.push(current);
  return fields.map((field) => field.trim());
}

function parseCsvGlossary(
  content: string,
  origin: GlossaryOrigin,
): GlossaryTerm[] {
  const rows = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map(splitCsvLine);

  if (rows.length === 0) return [];

  let sourceIndex = 0;
  let targetIndex = 1;
  let notesIndex = 2;
  let dataRows = rows;

  const header = rows[0].map((field) => field.toLowerCase());
  const hasHeader = header.some((field) => SOURCE_KEYS.includes(field));

  if (hasHeader) {
    sourceIndex = header.findIndex((field) => SOURCE_KEYS.includes(field));
    targetIndex = header.findIndex((field) => TARGET_KEYS.includes(field));
    notesIndex = header.findIndex((field) => NOTES_KEYS.includes(field));
    dataRows = rows.slice(1);
  }

  return dataRows
    .map((row) =>
      makeTerm(
        row[sourceIndex],
        targetIndex >= 0 ? row[targetIndex] : undefined,
        notesIndex >= 0 ? row[notesIndex] : undefined,
        origin,
      ),
    )
    .filter((term): term is GlossaryTerm => term !== null);
}

function parseMarkdownGlossary(
  content: string,
  origin: GlossaryOrigin,
): GlossaryTerm[] {
  const terms: GlossaryTerm[] = [];
  const leftovers: string[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('|')) {
      const cells = line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim());

      // Skip table separator rows such as `|---|:--:|`.
      if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
      // Skip the header row.
      if (cells.some((cell) => SOURCE_KEYS.includes(cell.toLowerCase())))
        continue;

      const term = makeTerm(cells[0], cells[1], cells[2], origin);
      if (term) terms.push(term);
      continue;
    }

    leftovers.push(line.replace(/^[-*+]\s+/, ''));
  }

  terms.push(...parseTextGlossary(leftovers.join('\n'), origin));
  return terms;
}

function parseTextGlossary(
  content: string,
  origin: GlossaryOrigin,
): GlossaryTerm[] {
  const terms: GlossaryTerm[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*+]\s+/, '');
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    const separator = PAIR_SEPARATORS.find((candidate) =>
      line.includes(candidate),
    );
    if (!separator) continue;

    const splitAt = line.indexOf(separator);
    const term = makeTerm(
      line.slice(0, splitAt),
      line.slice(splitAt + separator.length),
      undefined,
      origin,
    );
    if (term) terms.push(term);
  }

  return terms;
}

/**
 * Later terms never overwrite earlier ones, and seed terms always win over
 * translator-proposed ones regardless of order.
 */
export function mergeTerms(...groups: GlossaryTerm[][]): GlossaryTerm[] {
  const byKey = new Map<string, GlossaryTerm>();

  for (const group of groups) {
    for (const term of group) {
      const key = normalizeKey(term.source);
      const existing = byKey.get(key);

      if (!existing) {
        byKey.set(key, term);
        continue;
      }

      if (existing.origin === 'translator' && term.origin === 'seed') {
        byKey.set(key, term);
      }
    }
  }

  return [...byKey.values()];
}

export function formatGlossaryForPrompt(terms: GlossaryTerm[]): string {
  if (terms.length === 0) {
    return '(The glossary is empty. Establish terminology as you go and report it.)';
  }

  const rows = terms.map((term) => {
    const notes = term.notes ? ` — ${term.notes}` : '';
    return `- ${term.source} => ${term.target}${notes}`;
  });

  return rows.join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
