import path from 'node:path';

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import {
  buildJsonReviewPrompt,
  buildJsonTranslationPrompt,
  buildSubtitleReviewPrompt,
  buildSubtitleTranslationPrompt,
  buildTextReviewPrompt,
  buildTextTranslationPrompt,
  type PromptContext,
} from '../agents/prompts';
import {
  jsonReviewSchema,
  jsonTranslationSchema,
  reviewSchema,
  subtitleReviewSchema,
  subtitleTranslationSchema,
  translationSchema,
  type LocalizationIssue,
} from '../agents/schemas';
import {
  DEFAULT_MAX_PAGES_PER_PART,
  DEFAULT_MAX_PART_CHARS,
  DEFAULT_MIN_PAGES_PER_PART,
  LOCALIZATION_RUNS_DIR,
} from '../config';
import { chunkDocument } from '../lib/chunking';
import {
  defaultOutputFileName,
  detectDocumentKind,
  isSubtitleKind,
  outputFormatForKind,
  stripMarkdown,
  type SubtitleKind,
} from '../lib/document-kind';
import {
  detectGlossaryFormat,
  mergeTerms,
  parseGlossary,
  type GlossaryTerm,
} from '../lib/glossary';
import {
  batchEntries,
  flattenStrings,
  rebuildWithTranslations,
} from '../lib/i18n-json';
import { stripPageSeparators } from '../lib/paginated-markdown';
import { batchCues, parseSubtitles, rebuildSubtitles } from '../lib/subtitles';
import {
  assertWorkspaceFile,
  ensureWorkspaceDir,
  readWorkspaceBytes,
  readWorkspaceText,
  workspaceFileExists,
  writeWorkspaceFile,
} from '../lib/workspace-paths';
import { convertPdfToMarkdown } from '../tools/datalab-ocr-tool';
import { readGlossaryFile, writeGlossaryFile } from '../tools/glossary-tools';
import { planPdfParts, splitPdfByRanges } from '../tools/pdf-tools';

const documentKindSchema = z.enum([
  'pdf',
  'json',
  'markdown',
  'text',
  'srt',
  'ass',
]);
const outputFormatSchema = z.enum(['markdown', 'text', 'json', 'srt', 'ass']);

const runContextSchema = z.object({
  runDir: z.string(),
  sourcePath: z.string(),
  kind: documentKindSchema,
  outputFormat: outputFormatSchema,
  outputPath: z.string(),
  glossaryPath: z.string(),
  targetLanguage: z.string(),
  sourceLanguage: z.string().optional(),
  styleGuide: z.string(),
  maxPartChars: z.number(),
  maxPagesPerPart: z.number(),
  minPagesPerPart: z.number(),
});

const sourcePartSchema = z.object({
  index: z.number(),
  title: z.string().optional(),
  content: z.string().optional(),
  entries: z
    .array(z.object({ pointer: z.string(), value: z.string() }))
    .optional(),
  cues: z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        start: z.string().optional(),
        end: z.string().optional(),
        style: z.string().optional(),
      }),
    )
    .optional(),
  startPage: z.number().optional(),
  endPage: z.number().optional(),
});

const translatedPartSchema = z.object({
  index: z.number(),
  title: z.string().optional(),
  content: z.string().optional(),
  entries: z
    .array(z.object({ pointer: z.string(), translation: z.string() }))
    .optional(),
  cues: z
    .array(z.object({ id: z.string(), translation: z.string() }))
    .optional(),
});

const issueRecordSchema = z.object({
  partIndex: z.number(),
  severity: z.enum(['low', 'medium', 'high']),
  description: z.string(),
});

const partsStageSchema = z.object({
  run: runContextSchema,
  partSource: z.string(),
  parts: z.array(sourcePartSchema),
});

const translateStageSchema = partsStageSchema.extend({
  translated: z.array(translatedPartSchema),
});

const reviewStageSchema = partsStageSchema.extend({
  reviewed: z.array(translatedPartSchema),
  issues: z.array(issueRecordSchema),
});

const workflowInputSchema = z.object({
  sourcePath: z
    .string()
    .describe('Path to the document (.md, .pdf, .txt, .json, .srt, .ass)'),
  glossaryPath: z
    .string()
    .describe('Path to glossary (.md, .txt, .json, .csv)'),
  targetLanguage: z.string().describe('Language to translate into ("German")'),
  styleGuide: z
    .string()
    .optional()
    .describe('Guidance on tone, style, and conventions.'),
  styleGuidePath: z
    .string()
    .optional()
    .describe('Path to detailed style guide (.md, .txt)'),
  sourceLanguage: z
    .string()
    .optional()
    .describe('Detected automatically when omitted.'),
  outputPath: z
    .string()
    .optional()
    .describe('Defaults to a file inside the run directory.'),
  maxPartChars: z.number().int().min(500).optional(),
  maxPagesPerPart: z.number().int().min(1).optional(),
  minPagesPerPart: z.number().int().min(1).optional(),
});

const workflowOutputSchema = z.object({
  outputPath: z.string(),
  glossaryPath: z.string(),
  reportPath: z.string(),
  runDir: z.string(),
  outputFormat: outputFormatSchema,
  partSource: z.string(),
  partCount: z.number(),
  glossaryTermCount: z.number(),
  issueCount: z.number(),
});

type RunContext = z.infer<typeof runContextSchema>;
type SourcePart = z.infer<typeof sourcePartSchema>;
type TranslatedPart = z.infer<typeof translatedPartSchema>;

function padIndex(index: number): string {
  return String(index).padStart(3, '0');
}

function promptContext(run: RunContext, terms: GlossaryTerm[]): PromptContext {
  return {
    targetLanguage: run.targetLanguage,
    ...(run.sourceLanguage ? { sourceLanguage: run.sourceLanguage } : {}),
    styleGuide: run.styleGuide,
    terms,
  };
}

async function appendProposedTerms(
  glossaryPath: string,
  existing: GlossaryTerm[],
  proposed: Array<{ source: string; target: string; notes?: string }>,
): Promise<void> {
  if (proposed.length === 0) return;

  const additions: GlossaryTerm[] = proposed.map((term) => ({
    ...term,
    origin: 'translator',
  }));
  await writeGlossaryFile(glossaryPath, mergeTerms(existing, additions));
}

const prepareRunStep = createStep({
  id: 'prepare-run',
  description:
    'Resolve paths, seed the run glossary, and combine the style guide.',
  inputSchema: workflowInputSchema,
  outputSchema: runContextSchema,
  execute: async ({ inputData, runId }) => {
    const { sourcePath, targetLanguage } = inputData;

    await assertWorkspaceFile(sourcePath, 'Source document');

    const kind = detectDocumentKind(sourcePath);
    const outputFormat = outputFormatForKind(kind);

    const runDir = path.posix.join(LOCALIZATION_RUNS_DIR, runId);
    await ensureWorkspaceDir(runDir);

    const glossaryPath = path.posix.join(runDir, 'glossary.json');
    let seedTerms: GlossaryTerm[] = [];

    if (inputData.glossaryPath) {
      await assertWorkspaceFile(inputData.glossaryPath, 'Glossary');
      const raw = await readWorkspaceText(inputData.glossaryPath);
      seedTerms = mergeTerms(
        parseGlossary(raw, detectGlossaryFormat(inputData.glossaryPath)),
      );
    }

    await writeGlossaryFile(glossaryPath, seedTerms);

    const styleGuideParts = [inputData.styleGuide?.trim() ?? ''];
    if (inputData.styleGuidePath) {
      await assertWorkspaceFile(inputData.styleGuidePath, 'Style guide');
      styleGuideParts.push(
        (await readWorkspaceText(inputData.styleGuidePath)).trim(),
      );
    }

    const outputPath =
      inputData.outputPath ??
      path.posix.join(
        runDir,
        defaultOutputFileName(sourcePath, targetLanguage, outputFormat),
      );

    return {
      runDir,
      sourcePath,
      kind,
      outputFormat,
      outputPath,
      glossaryPath,
      targetLanguage,
      ...(inputData.sourceLanguage
        ? { sourceLanguage: inputData.sourceLanguage }
        : {}),
      styleGuide: styleGuideParts.filter(Boolean).join('\n\n'),
      maxPartChars: inputData.maxPartChars ?? DEFAULT_MAX_PART_CHARS,
      maxPagesPerPart: inputData.maxPagesPerPart ?? DEFAULT_MAX_PAGES_PER_PART,
      minPagesPerPart: inputData.minPagesPerPart ?? DEFAULT_MIN_PAGES_PER_PART,
    };
  },
});

/**
 * Splits by bookmarks or a verified table of contents, then OCRs each part.
 * Converted parts are cached on disk so a retry after a network failure does not
 * re-spend Datalab credits on work that already succeeded.
 */
const preparePdfPartsStep = createStep({
  id: 'prepare-pdf-parts',
  description:
    'Plan chapter ranges, split the PDF, and convert each part to markdown via OCR.',
  inputSchema: runContextSchema,
  outputSchema: partsStageSchema,
  retries: 2,
  execute: async ({ inputData: run, writer }) => {
    const bytes = await readWorkspaceBytes(run.sourcePath);
    const plan = await planPdfParts(bytes, {
      maxPagesPerPart: run.maxPagesPerPart,
      minPagesPerPart: run.minPagesPerPart,
    });

    if (plan.ranges.length === 0) {
      throw new Error(
        `Could not determine any page ranges for "${run.sourcePath}".`,
      );
    }

    const baseName = path.basename(
      run.sourcePath,
      path.extname(run.sourcePath),
    );
    const splitParts = await splitPdfByRanges(
      bytes,
      plan.ranges,
      path.posix.join(run.runDir, 'source-parts'),
      baseName,
    );

    const parts: SourcePart[] = [];

    for (const part of splitParts) {
      const markdownPath = path.posix.join(
        run.runDir,
        'parts',
        `part-${padIndex(part.index)}.md`,
      );
      let markdown: string;

      if (await workspaceFileExists(markdownPath)) {
        markdown = await readWorkspaceText(markdownPath);
      } else {
        await writer?.write(
          `Converting part ${part.index} of ${splitParts.length} (pages ${part.startPage}-${part.endPage})\n`,
        );
        const outcome = await convertPdfToMarkdown(
          await readWorkspaceBytes(part.partPath),
          path.basename(part.partPath),
        );
        markdown = outcome.markdown;
        await writeWorkspaceFile(markdownPath, markdown);
      }

      parts.push({
        index: part.index,
        ...(part.title ? { title: part.title } : {}),
        content: stripPageSeparators(markdown),
        startPage: part.startPage,
        endPage: part.endPage,
      });
    }

    return { run, partSource: plan.source, parts };
  },
});

const chunkTextPartsStep = createStep({
  id: 'chunk-text-parts',
  description:
    'Split a text or markdown document into parts on heading boundaries.',
  inputSchema: runContextSchema,
  outputSchema: partsStageSchema,
  execute: async ({ inputData: run }) => {
    const content = await readWorkspaceText(run.sourcePath);
    const chunks = chunkDocument(content, run.maxPartChars);

    if (chunks.length === 0) {
      throw new Error(
        `Document "${run.sourcePath}" has no translatable content.`,
      );
    }

    const parts: SourcePart[] = [];

    for (const chunk of chunks) {
      await writeWorkspaceFile(
        path.posix.join(
          run.runDir,
          'parts',
          `part-${padIndex(chunk.index)}.md`,
        ),
        chunk.content,
      );
      parts.push({
        index: chunk.index,
        ...(chunk.title ? { title: chunk.title } : {}),
        content: chunk.content,
      });
    }

    return {
      run,
      partSource: chunks.length > 1 ? 'headings' : 'single-part',
      parts,
    };
  },
});

const flattenJsonPartsStep = createStep({
  id: 'flatten-json-parts',
  description:
    'Flatten an i18n resource bundle into batches of translatable string values.',
  inputSchema: runContextSchema,
  outputSchema: partsStageSchema,
  execute: async ({ inputData: run }) => {
    const raw = await readWorkspaceText(run.sourcePath);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `"${run.sourcePath}" is not valid JSON: ${(error as Error).message}`,
      );
    }

    const entries = flattenStrings(parsed);
    if (entries.length === 0) {
      throw new Error(
        `"${run.sourcePath}" contains no translatable string values.`,
      );
    }

    const batches = batchEntries(entries, run.maxPartChars);
    const parts: SourcePart[] = batches.map((batch, position) => ({
      index: position + 1,
      entries: batch,
    }));

    return { run, partSource: 'json-batches', parts };
  },
});

/**
 * Only the dialogue text becomes translatable content. Timings, cue numbering,
 * styles, and every other field stay on disk and are re-read at assembly time,
 * so the output is the source file with its text swapped out.
 */
const parseSubtitlePartsStep = createStep({
  id: 'parse-subtitle-parts',
  description:
    'Parse an SRT or ASS subtitle file into batches of consecutive cues.',
  inputSchema: runContextSchema,
  outputSchema: partsStageSchema,
  execute: async ({ inputData: run }) => {
    const raw = await readWorkspaceText(run.sourcePath);
    const cues = parseSubtitles(raw, run.kind as SubtitleKind);

    if (cues.length === 0) {
      throw new Error(
        `"${run.sourcePath}" contains no translatable subtitle cues.`,
      );
    }

    const batches = batchCues(cues, run.maxPartChars);
    const parts: SourcePart[] = batches.map((batch, position) => ({
      index: position + 1,
      cues: batch,
    }));

    return { run, partSource: 'subtitle-cues', parts };
  },
});

/**
 * A named step rather than an inline `.map()`, because Mastra gives anonymous
 * mapping steps a random id per process. A run that outlives a dev-server reload
 * would then look for a step id that no longer exists and hand the next step
 * undefined.
 */
const selectPartsStageStep = createStep({
  id: 'select-parts-stage',
  description:
    'Forward the output of whichever part-extraction branch ran to the translation step.',
  inputSchema: z.object({
    'prepare-pdf-parts': partsStageSchema.optional(),
    'flatten-json-parts': partsStageSchema.optional(),
    'parse-subtitle-parts': partsStageSchema.optional(),
    'chunk-text-parts': partsStageSchema.optional(),
  }),
  outputSchema: partsStageSchema,
  execute: async ({ inputData }) => {
    // Only the branch that ran contributes a key.
    const stage =
      inputData['prepare-pdf-parts'] ??
      inputData['flatten-json-parts'] ??
      inputData['parse-subtitle-parts'] ??
      inputData['chunk-text-parts'];

    if (!stage) throw new Error('No part-extraction branch produced output.');
    return stage;
  },
});

/**
 * Parts are translated strictly in order, re-reading the glossary each time, so
 * terminology established in one part is binding on every later part.
 */
const translatePartsStep = createStep({
  id: 'translate-parts',
  description:
    'Translate every part in order, growing the glossary as terms are established.',
  inputSchema: partsStageSchema,
  outputSchema: translateStageSchema,
  execute: async ({ inputData, mastra, writer }) => {
    const { run, parts, partSource } = inputData;
    const translator = mastra.getAgent('translatorAgent');
    const translated: TranslatedPart[] = [];

    for (const part of parts) {
      const glossary = await readGlossaryFile(run.glossaryPath);
      const context = promptContext(run, glossary.terms);
      const partContext = {
        index: part.index,
        total: parts.length,
        ...(part.title ? { title: part.title } : {}),
      };

      await writer?.write(
        `Translating part ${part.index} of ${parts.length}\n`,
      );

      if (run.kind === 'json') {
        const entries = part.entries ?? [];
        const response = await translator.generate(
          buildJsonTranslationPrompt(context, partContext, entries),
          { structuredOutput: { schema: jsonTranslationSchema } },
        );
        const output = response.object;
        const byPointer = new Map(
          output.entries.map((entry) => [entry.pointer, entry.translation]),
        );

        translated.push({
          index: part.index,
          entries: entries.map((entry) => ({
            pointer: entry.pointer,
            // A pointer the model failed to return keeps its source text rather
            // than silently disappearing from the bundle.
            translation: byPointer.get(entry.pointer) ?? entry.value,
          })),
        });

        await appendProposedTerms(
          run.glossaryPath,
          glossary.terms,
          output.newTerms ?? [],
        );
        continue;
      }

      if (isSubtitleKind(run.kind)) {
        const cues = part.cues ?? [];
        const response = await translator.generate(
          buildSubtitleTranslationPrompt(context, partContext, run.kind, cues),
          { structuredOutput: { schema: subtitleTranslationSchema } },
        );
        const output = response.object;
        const byId = new Map(
          output.cues.map((cue) => [cue.id, cue.translation]),
        );

        translated.push({
          index: part.index,
          cues: cues.map((cue) => ({
            id: cue.id,
            // A cue the model failed to return keeps its source text rather
            // than leaving a blank on screen.
            translation: byId.get(cue.id) ?? cue.text,
          })),
        });

        await appendProposedTerms(
          run.glossaryPath,
          glossary.terms,
          output.newTerms ?? [],
        );
        continue;
      }

      const response = await translator.generate(
        buildTextTranslationPrompt(context, partContext, part.content ?? ''),
        { structuredOutput: { schema: translationSchema } },
      );
      const output = response.object;

      await writeWorkspaceFile(
        path.posix.join(
          run.runDir,
          'translated',
          `part-${padIndex(part.index)}.md`,
        ),
        output.translation,
      );

      translated.push({
        index: part.index,
        ...(part.title ? { title: part.title } : {}),
        content: output.translation,
      });

      await appendProposedTerms(
        run.glossaryPath,
        glossary.terms,
        output.newTerms ?? [],
      );
    }

    return { run, partSource, parts, translated };
  },
});

/**
 * Runs after all translation is complete, so the Editor sees the final glossary
 * and can fix terminology in parts that were translated before a term existed.
 */
const reviewPartsStep = createStep({
  id: 'review-parts',
  description:
    'Review every translated part against the source and the final glossary.',
  inputSchema: translateStageSchema,
  outputSchema: reviewStageSchema,
  execute: async ({ inputData, mastra, writer }) => {
    const { run, parts, partSource, translated } = inputData;
    const editor = mastra.getAgent('editorAgent');
    const glossary = await readGlossaryFile(run.glossaryPath);
    const context = promptContext(run, glossary.terms);

    const sourceByIndex = new Map(parts.map((part) => [part.index, part]));
    const reviewed: TranslatedPart[] = [];
    const issues: Array<z.infer<typeof issueRecordSchema>> = [];

    const recordIssues = (partIndex: number, found: LocalizationIssue[]) => {
      for (const issue of found) {
        issues.push({
          partIndex,
          severity: issue.severity,
          description: issue.description,
        });
      }
    };

    for (const part of translated) {
      const source = sourceByIndex.get(part.index);
      const partContext = {
        index: part.index,
        total: translated.length,
        ...(part.title ? { title: part.title } : {}),
      };

      await writer?.write(
        `Reviewing part ${part.index} of ${translated.length}\n`,
      );

      if (run.kind === 'json') {
        const sourceByPointer = new Map(
          (source?.entries ?? []).map((entry) => [entry.pointer, entry.value]),
        );
        const reviewEntries = (part.entries ?? []).map((entry) => ({
          pointer: entry.pointer,
          source: sourceByPointer.get(entry.pointer) ?? '',
          translation: entry.translation,
        }));

        const response = await editor.generate(
          buildJsonReviewPrompt(context, partContext, reviewEntries),
          { structuredOutput: { schema: jsonReviewSchema } },
        );
        const output = response.object;
        const corrected = new Map(
          output.entries.map((entry) => [
            entry.pointer,
            entry.correctedTranslation,
          ]),
        );

        reviewed.push({
          index: part.index,
          entries: (part.entries ?? []).map((entry) => ({
            pointer: entry.pointer,
            translation: corrected.get(entry.pointer) ?? entry.translation,
          })),
        });

        recordIssues(part.index, output.issues ?? []);
        continue;
      }

      if (isSubtitleKind(run.kind)) {
        const sourceById = new Map(
          (source?.cues ?? []).map((cue) => [cue.id, cue]),
        );
        const reviewCues = (part.cues ?? []).map((cue) => {
          const original = sourceById.get(cue.id);
          return {
            id: cue.id,
            text: original?.text ?? '',
            ...(original?.start ? { start: original.start } : {}),
            ...(original?.end ? { end: original.end } : {}),
            ...(original?.style ? { style: original.style } : {}),
            translation: cue.translation,
          };
        });

        const response = await editor.generate(
          buildSubtitleReviewPrompt(context, partContext, run.kind, reviewCues),
          { structuredOutput: { schema: subtitleReviewSchema } },
        );
        const output = response.object;
        const corrected = new Map(
          output.cues.map((cue) => [cue.id, cue.correctedTranslation]),
        );

        reviewed.push({
          index: part.index,
          cues: (part.cues ?? []).map((cue) => ({
            id: cue.id,
            translation: corrected.get(cue.id) ?? cue.translation,
          })),
        });

        recordIssues(part.index, output.issues ?? []);
        continue;
      }

      const response = await editor.generate(
        buildTextReviewPrompt(
          context,
          partContext,
          source?.content ?? '',
          part.content ?? '',
        ),
        { structuredOutput: { schema: reviewSchema } },
      );
      const output = response.object;

      await writeWorkspaceFile(
        path.posix.join(
          run.runDir,
          'reviewed',
          `part-${padIndex(part.index)}.md`,
        ),
        output.correctedTranslation,
      );

      reviewed.push({
        index: part.index,
        ...(part.title ? { title: part.title } : {}),
        content: output.correctedTranslation,
      });

      recordIssues(part.index, output.issues ?? []);
    }

    return { run, partSource, parts, reviewed, issues };
  },
});

const assembleOutputStep = createStep({
  id: 'assemble-output',
  description:
    'Write the localized document, the final glossary, and a run report.',
  inputSchema: reviewStageSchema,
  outputSchema: workflowOutputSchema,
  execute: async ({ inputData }) => {
    const { run, partSource, parts, reviewed, issues } = inputData;

    let content: string;

    if (run.kind === 'json') {
      const original = JSON.parse(
        await readWorkspaceText(run.sourcePath),
      ) as unknown;
      const translations = new Map<string, string>();
      for (const part of reviewed) {
        for (const entry of part.entries ?? [])
          translations.set(entry.pointer, entry.translation);
      }
      content = `${JSON.stringify(rebuildWithTranslations(original, translations), null, 2)}\n`;
    } else if (isSubtitleKind(run.kind)) {
      const original = await readWorkspaceText(run.sourcePath);
      const translations = new Map<string, string>();
      for (const part of reviewed) {
        for (const cue of part.cues ?? [])
          translations.set(cue.id, cue.translation);
      }
      content = rebuildSubtitles(original, run.kind, translations);
    } else {
      const joined = reviewed
        .map((part) => part.content?.trim() ?? '')
        .filter(Boolean)
        .join('\n\n');
      content = run.outputFormat === 'text' ? stripMarkdown(joined) : joined;
    }

    await writeWorkspaceFile(run.outputPath, content);

    const glossary = await readGlossaryFile(run.glossaryPath);
    const reportPath = path.posix.join(run.runDir, 'report.json');

    await writeWorkspaceFile(
      reportPath,
      `${JSON.stringify(
        {
          sourcePath: run.sourcePath,
          outputPath: run.outputPath,
          kind: run.kind,
          outputFormat: run.outputFormat,
          targetLanguage: run.targetLanguage,
          sourceLanguage: run.sourceLanguage ?? null,
          partSource,
          partCount: parts.length,
          glossaryTermCount: glossary.terms.length,
          issues,
          parts: parts.map((part) => ({
            index: part.index,
            title: part.title ?? null,
            startPage: part.startPage ?? null,
            endPage: part.endPage ?? null,
            entryCount: part.entries?.length ?? null,
            cueCount: part.cues?.length ?? null,
          })),
        },
        null,
        2,
      )}\n`,
    );

    return {
      outputPath: run.outputPath,
      glossaryPath: run.glossaryPath,
      reportPath,
      runDir: run.runDir,
      outputFormat: run.outputFormat,
      partSource,
      partCount: parts.length,
      glossaryTermCount: glossary.terms.length,
      issueCount: issues.length,
    };
  },
});

export const localizeDocumentWorkflow = createWorkflow({
  id: 'localizeDocumentWorkflow',
  description:
    'Localize a plain text, markdown, PDF, JSON, or subtitle (SRT/ASS) document into a target language using a terminology glossary, then review the result for correctness and consistency.',
  inputSchema: workflowInputSchema,
  outputSchema: workflowOutputSchema,
})
  .then(prepareRunStep)
  .branch([
    [async ({ inputData }) => inputData.kind === 'pdf', preparePdfPartsStep],
    [async ({ inputData }) => inputData.kind === 'json', flattenJsonPartsStep],
    [
      async ({ inputData }) =>
        inputData.kind === 'srt' || inputData.kind === 'ass',
      parseSubtitlePartsStep,
    ],
    [
      async ({ inputData }) =>
        inputData.kind === 'markdown' || inputData.kind === 'text',
      chunkTextPartsStep,
    ],
  ])
  .then(selectPartsStageStep)
  .then(translatePartsStep)
  .then(reviewPartsStep)
  .then(assembleOutputStep)
  .commit();
