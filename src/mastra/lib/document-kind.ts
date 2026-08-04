import path from 'node:path';

export type DocumentKind =
  | 'pdf'
  | 'json'
  | 'html'
  | 'markdown'
  | 'text'
  | 'srt'
  | 'ass'
  | 'docx'
  | 'rtf'
  | 'odt';

export type OutputFormat =
  | 'markdown'
  | 'text'
  | 'json'
  | 'html'
  | 'srt'
  | 'ass';

export const SUBTITLE_KINDS = ['srt', 'ass'] as const;

export type SubtitleKind = (typeof SUBTITLE_KINDS)[number];

export function isSubtitleKind(kind: DocumentKind): kind is SubtitleKind {
  return kind === 'srt' || kind === 'ass';
}

/** Office documents converted to markdown via officeparser before translation. */
export const OFFICE_KINDS = ['docx', 'rtf', 'odt'] as const;

export type OfficeKind = (typeof OFFICE_KINDS)[number];

export function isOfficeKind(kind: DocumentKind): kind is OfficeKind {
  return kind === 'docx' || kind === 'rtf' || kind === 'odt';
}

export function detectDocumentKind(filename: string): DocumentKind {
  const extension = path.extname(filename).toLowerCase();

  if (extension === '.pdf') return 'pdf';
  if (extension === '.json') return 'json';
  if (extension === '.html' || extension === '.htm') return 'html';
  if (extension === '.srt') return 'srt';
  // SSA is the older revision of the same container; the dialogue lines that
  // get translated are laid out identically.
  if (extension === '.ass' || extension === '.ssa') return 'ass';
  if (extension === '.docx') return 'docx';
  if (extension === '.rtf') return 'rtf';
  if (extension === '.odt') return 'odt';
  if (extension === '.md' || extension === '.markdown' || extension === '.mdx')
    return 'markdown';
  return 'text';
}

/** Each input kind has exactly one output format; there is nothing to choose. */
const FORMAT_BY_KIND: Record<DocumentKind, OutputFormat> = {
  pdf: 'markdown',
  markdown: 'markdown',
  text: 'text',
  json: 'json',
  html: 'html',
  srt: 'srt',
  ass: 'ass',
  docx: 'markdown',
  rtf: 'markdown',
  odt: 'markdown',
};

export function outputFormatForKind(kind: DocumentKind): OutputFormat {
  return FORMAT_BY_KIND[kind];
}

const EXTENSION_BY_FORMAT: Record<OutputFormat, string> = {
  markdown: '.md',
  text: '.txt',
  json: '.json',
  html: '.html',
  srt: '.srt',
  ass: '.ass',
};

export function outputExtension(
  format: OutputFormat,
  sourcePath?: string,
): string {
  // Subtitles and HTML are written back with the same extension they arrived
  // with, so `.ssa` does not become `.ass` and `.htm` does not become `.html`.
  if (
    sourcePath &&
    (format === 'srt' || format === 'ass' || format === 'html')
  ) {
    const extension = path.extname(sourcePath).toLowerCase();
    if (extension) return extension;
  }

  return EXTENSION_BY_FORMAT[format];
}

export function defaultOutputFileName(
  sourcePath: string,
  targetLanguage: string,
  format: OutputFormat,
): string {
  const base = path.basename(sourcePath, path.extname(sourcePath));
  const languageTag = targetLanguage
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return `${base}.${languageTag || 'translated'}${outputExtension(format, sourcePath)}`;
}

/** Collapses markdown emphasis, headings, and link syntax for plain-text output. */
export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/^```[^\n]*\n([\s\S]*?)```$/gm, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
