import { formatGlossaryForPrompt, type GlossaryTerm } from '../lib/glossary';

export interface PromptContext {
  targetLanguage: string;
  sourceLanguage?: string;
  styleGuide: string;
  terms: GlossaryTerm[];
}

export interface PartContext {
  index: number;
  total: number;
  title?: string;
}

const NO_STYLE_GUIDE =
  '(No style guide provided. Use a neutral, professional register appropriate to the document type.)';

function header(context: PromptContext, part: PartContext): string {
  const sourceLine = context.sourceLanguage
    ? `Source language: ${context.sourceLanguage}`
    : 'Source language: detect it from the text.';

  const titleLine = part.title ? `\nSection title: ${part.title}` : '';

  return `Target language: ${context.targetLanguage}
${sourceLine}
Part ${part.index} of ${part.total}.${titleLine}

=== STYLE GUIDE ===
${context.styleGuide.trim() || NO_STYLE_GUIDE}

=== GLOSSARY ===
${formatGlossaryForPrompt(context.terms)}`;
}

export function buildTextTranslationPrompt(
  context: PromptContext,
  part: PartContext,
  content: string,
): string {
  return `${header(context, part)}

Translate the part below into ${context.targetLanguage}.

=== SOURCE START ===
${content}
=== SOURCE END ===`;
}

export function buildTextReviewPrompt(
  context: PromptContext,
  part: PartContext,
  source: string,
  translation: string,
): string {
  return `${header(context, part)}

Review the translation below against its source. The glossary above is final and complete, so terms that were added after this part was translated still apply to it.

=== SOURCE START ===
${source}
=== SOURCE END ===

=== TRANSLATION START ===
${translation}
=== TRANSLATION END ===`;
}

export interface SubtitleCueInput {
  id: string;
  text: string;
  start?: string;
  end?: string;
  style?: string;
}

export interface SubtitleReviewCue extends SubtitleCueInput {
  translation: string;
}

/**
 * The two containers differ in exactly one way that matters to a translator:
 * how a line break inside a cue is written, and what markup has to survive.
 */
function subtitleMarkupRules(format: 'srt' | 'ass'): string {
  if (format === 'ass') {
    return `- The text is an ASS dialogue field. Write line breaks as the literal two characters \\N, never as a real newline. \\n and \\h must also stay as written.
- Copy every override block in braces, such as {\\an8}, {\\i1}, {\\pos(320,400)}, or {\\fad(200,200)}, character for character, and keep it attached to the same word it precedes. Never translate anything inside braces.
- Keep the drawing and karaoke tags untouched.`;
  }

  return `- The text is a SubRip cue body. Keep its line breaks: a cue that arrives as two lines must come back as two lines, broken at a natural phrase boundary in the target language.
- Copy any inline markup, such as <i>, <b>, <u>, or <font color="#ffffff">, and keep the tags around the same words.`;
}

export function buildSubtitleTranslationPrompt(
  context: PromptContext,
  part: PartContext,
  format: 'srt' | 'ass',
  cues: SubtitleCueInput[],
): string {
  return `${header(context, part)}

Translate these subtitle cues into ${context.targetLanguage}.

Return one entry per input cue, with the id copied exactly and only the text translated. Never translate or alter an id, and never merge, split, drop, or reorder cues.

Subtitle rules:
- Cues are consecutive and form continuous dialogue. Read the whole batch before translating so a sentence that runs across several cues stays coherent, but keep each cue's share of that sentence inside its own cue.
- Subtitles are read under time pressure. Prefer the shortest natural phrasing, and do not let a cue grow much longer than its source; the reader has only the time between its start and end timestamps.
- Timestamps and the style name are context only. Never output them.
- Speaker dashes, ellipses that mark a sentence continuing into the next cue, and sound or music markers keep their function in the target language.
${subtitleMarkupRules(format)}

=== CUES (JSON) ===
${JSON.stringify(cues, null, 2)}`;
}

export function buildSubtitleReviewPrompt(
  context: PromptContext,
  part: PartContext,
  format: 'srt' | 'ass',
  cues: SubtitleReviewCue[],
): string {
  return `${header(context, part)}

Review these translated subtitle cues. The glossary above is final and grew after some of these cues were translated, so terms added later still apply.

Return one entry per input cue, with the id copied exactly.

Check in particular:
- Reading speed. A cue that is far longer than its source, or too long for the gap between its timestamps, needs tightening.
- Continuity across cues, including sentences split over several cues and consistent forms of address between speakers.
- Markup integrity. Broken or moved markup is always a high severity issue.
${subtitleMarkupRules(format)}

=== CUES (JSON) ===
${JSON.stringify(cues, null, 2)}`;
}

export interface JsonEntryInput {
  pointer: string;
  value: string;
}

export function buildJsonTranslationPrompt(
  context: PromptContext,
  part: PartContext,
  entries: JsonEntryInput[],
): string {
  return `${header(context, part)}

Translate the string values of this localization resource bundle into ${context.targetLanguage}.

Return one entry per input string, with the pointer copied exactly and only the value translated. Never translate or alter a pointer. Preserve every interpolation placeholder character for character. Leave values that are purely a code, identifier, or URL unchanged.

=== ENTRIES (JSON) ===
${JSON.stringify(entries, null, 2)}`;
}

export interface JsonReviewEntry {
  pointer: string;
  source: string;
  translation: string;
}

export function buildJsonReviewPrompt(
  context: PromptContext,
  part: PartContext,
  entries: JsonReviewEntry[],
): string {
  return `${header(context, part)}

Review these translated resource strings. Pay particular attention to interpolation placeholders and to glossary terms, since the glossary above is final and grew after some of these strings were translated.

Return one entry per input, with the pointer copied exactly.

=== ENTRIES (JSON) ===
${JSON.stringify(entries, null, 2)}`;
}

export function buildHtmlTranslationPrompt(
  context: PromptContext,
  part: PartContext,
  entries: JsonEntryInput[],
): string {
  return `${header(context, part)}

Translate these HTML text segments into ${context.targetLanguage}.

Each entry is a text node or a translatable attribute value (alt, title, placeholder, aria-label, meta description, and similar). Tags, attribute names, scripts, styles, and code blocks stay on disk and are never sent here.

Return one entry per input string, with the pointer copied exactly and only the value translated. Never translate or alter a pointer. Never add HTML tags, entities, or markup to a value — plain text only; escaping is handled when the document is rebuilt.

HTML rules:
- Adjacent entries often form continuous prose split by inline tags. Read the whole batch before translating so the sentence stays coherent, but keep each segment's share of that sentence inside its own entry.
- Preserve leading and trailing whitespace on a value when it is significant (for example a space that separates words across an inline tag).
- Leave values that are purely a URL, email address, code identifier, or number unchanged.
- Do not invent attribute values or alt text that were not in the source.

=== ENTRIES (JSON) ===
${JSON.stringify(entries, null, 2)}`;
}

export function buildHtmlReviewPrompt(
  context: PromptContext,
  part: PartContext,
  entries: JsonReviewEntry[],
): string {
  return `${header(context, part)}

Review these translated HTML text segments. Pay particular attention to glossary terms and to continuity across adjacent segments that form one sentence, since the glossary above is final and grew after some of these strings were translated.

Return one entry per input, with the pointer copied exactly. Corrected values must stay plain text with no HTML tags or entities added.

=== ENTRIES (JSON) ===
${JSON.stringify(entries, null, 2)}`;
}
