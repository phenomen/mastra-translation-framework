import path from 'node:path';

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import {
  buildHtmlReviewPrompt,
  buildHtmlTranslationPrompt,
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
  TRANSLATION_RUNS_DIR,
} from '../config';
import { chunkDocument } from '../lib/chunking';
import {
  defaultOutputFileName,
  detectDocumentKind,
  isOfficeKind,
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
import { batchHtmlEntries, flattenHtml, rebuildHtml } from '../lib/html';
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
import {
  convertPdfToMarkdown,
  resolveUseRemoteOcr,
} from '../tools/datalab-ocr-tool';
import { readGlossaryFile, writeGlossaryFile } from '../tools/glossary-tools';
import {
  convertOfficeToMarkdown,
  convertPdfToMarkdownLocal,
} from '../tools/office-tools';
import { planPdfParts, splitPdfByRanges } from '../tools/pdf-tools';

const documentKindSchema = z.enum([
  'pdf',
  'json',
  'html',
  'markdown',
  'text',
  'srt',
  'ass',
  'docx',
  'rtf',
  'odt',
]);
const outputFormatSchema = z.enum([
  'markdown',
  'text',
  'json',
  'html',
  'srt',
  'ass',
]);

const runContextSchema = z.object({
  runDir: z.string(),
  sourcePaths: z.array(z.string()).min(1),
  kind: documentKindSchema,
  outputFormat: outputFormatSchema,
  outputPaths: z.array(z.string()).min(1),
  glossaryPath: z.string(),
  targetLanguage: z.string(),
  sourceLanguage: z.string().optional(),
  styleGuide: z.string(),
  maxPartChars: z.number(),
  maxPagesPerPart: z.number(),
  minPagesPerPart: z.number(),
  remoteOCR: z.boolean(),
  skipEditor: z.boolean(),
});

const sourcePartSchema = z.object({
  index: z.number(),
  sourcePath: z.string(),
  sourceIndex: z.number(),
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
  sourcePaths: z
    .array(z.string())
    .min(1)
    .describe(
      'One or more documents of the same type (.md, .pdf, .txt, .json, .html, .htm, .srt, .ass, .docx, .rtf, .odt). A single file is just an array of one. All files share the glossary and style guide; terminology established in earlier files applies to later ones.',
    ),
  glossaryPath: z
    .string()
    .optional()
    .describe(
      'Path to glossary (.md, .txt, .json, .csv). Omit to start with an empty glossary.',
    ),
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
    .describe(
      'For a single document, the output file path. For multiple documents, a directory where each output is written. Defaults inside the run directory.',
    ),
  maxPartChars: z.number().int().min(500).optional(),
  maxPagesPerPart: z.number().int().min(1).optional(),
  minPagesPerPart: z.number().int().min(1).optional(),
  remoteOCR: z
    .boolean()
    .optional()
    .describe(
      'Use Datalab remote OCR for PDFs. When omitted, remote OCR is used only if DATALAB_API_KEY is set; otherwise local officeparser text extraction is used. Set false to force local extraction even when a key is present.',
    ),
  skipEditor: z
    .boolean()
    .optional()
    .describe(
      'When true, skip the editor review pass and assemble output from the first-pass translation. Faster and cheaper; terminology established late in the run is not back-applied.',
    ),
});

const documentOutputSchema = z.object({
  sourcePath: z.string(),
  outputPath: z.string(),
  partCount: z.number(),
});

const workflowOutputSchema = z.object({
  outputPath: z.string(),
  outputs: z.array(documentOutputSchema),
  glossaryPath: z.string(),
  reportPath: z.string(),
  runDir: z.string(),
  outputFormat: outputFormatSchema,
  partSource: z.string(),
  partCount: z.number(),
  documentCount: z.number(),
  glossaryTermCount: z.number(),
  issueCount: z.number(),
});
type RunContext = z.infer<typeof runContextSchema>;
type SourcePart = z.infer<typeof sourcePartSchema>;
type TranslatedPart = z.infer<typeof translatedPartSchema>;

function padIndex(index: number): string {
  return String(index).padStart(3, '0');
}

/**
 * One output path per source. A provided outputPath is the file for a single
 * document, or the directory that holds every file when translating several.
 * Basename collisions across sources get a doc-NNN- prefix.
 */
function resolveOutputPaths(
  sourcePaths: string[],
  targetLanguage: string,
  outputFormat: z.infer<typeof outputFormatSchema>,
  runDir: string,
  outputPath?: string,
): string[] {
  if (sourcePaths.length === 1) {
    return [
      outputPath ??
        path.posix.join(
          runDir,
          defaultOutputFileName(sourcePaths[0]!, targetLanguage, outputFormat),
        ),
    ];
  }

  const outputDir = outputPath ?? runDir;
  const fileNames = sourcePaths.map((sourcePath) =>
    defaultOutputFileName(sourcePath, targetLanguage, outputFormat),
  );
  const counts = new Map<string, number>();
  for (const name of fileNames) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  return sourcePaths.map((sourcePath, index) => {
    const fileName = fileNames[index]!;
    const uniqueName =
      (counts.get(fileName) ?? 0) > 1
        ? `doc-${padIndex(index + 1)}-${fileName}`
        : fileName;
    return path.posix.join(outputDir, uniqueName);
  });
}

/** Subdirectory under the run for per-document caches when translating several files. */
function documentCacheDir(
  sourcePaths: string[],
  sourceIndex: number,
): string | undefined {
  if (sourcePaths.length === 1) return undefined;
  const base = path.basename(
    sourcePaths[sourceIndex]!,
    path.extname(sourcePaths[sourceIndex]!),
  );
  return `doc-${padIndex(sourceIndex + 1)}-${base}`;
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
    const sourcePaths = [...new Set(inputData.sourcePaths)];
    const { targetLanguage } = inputData;

    for (const sourcePath of sourcePaths) {
      await assertWorkspaceFile(sourcePath, 'Source document');
    }

    const kinds = sourcePaths.map((sourcePath) =>
      detectDocumentKind(sourcePath),
    );
    const kind = kinds[0]!;
    if (kinds.some((entry) => entry !== kind)) {
      const summary = sourcePaths
        .map((sourcePath, index) => `${sourcePath} (${kinds[index]})`)
        .join(', ');
      throw new Error(
        `All source documents must be the same type. Got: ${summary}.`,
      );
    }

    const outputFormat = outputFormatForKind(kind);

    const runDir = path.posix.join(TRANSLATION_RUNS_DIR, runId);
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

    const outputPaths = resolveOutputPaths(
      sourcePaths,
      targetLanguage,
      outputFormat,
      runDir,
      inputData.outputPath,
    );

    return {
      runDir,
      sourcePaths,
      kind,
      outputFormat,
      outputPaths,
      glossaryPath,
      targetLanguage,
      ...(inputData.sourceLanguage
        ? { sourceLanguage: inputData.sourceLanguage }
        : {}),
      styleGuide: styleGuideParts.filter(Boolean).join('\n\n'),
      maxPartChars: inputData.maxPartChars ?? DEFAULT_MAX_PART_CHARS,
      maxPagesPerPart: inputData.maxPagesPerPart ?? DEFAULT_MAX_PAGES_PER_PART,
      minPagesPerPart: inputData.minPagesPerPart ?? DEFAULT_MIN_PAGES_PER_PART,
      remoteOCR: resolveUseRemoteOcr(inputData.remoteOCR),
      skipEditor: inputData.skipEditor ?? false,
    };
  },
});

/**
 * Splits by bookmarks or a verified table of contents, then converts each part
 * to markdown. Uses Datalab remote OCR when `remoteOCR` is true; otherwise
 * extracts embedded text locally via officeparser (no OCR). Markdown is cached
 * under `ocr/` so a retry after a network failure does not re-spend Datalab
 * credits. Each result is then re-chunked under `maxPartChars` on h1/h2
 * boundaries before translation. Multiple PDFs are processed in order so later
 * documents inherit terminology established earlier in the shared glossary.
 */
const preparePdfPartsStep = createStep({
  id: 'prepare-pdf-parts',
  description:
    'Plan chapter ranges, split each PDF, convert each part to markdown (remote OCR or local text extraction), then chunk oversized parts on headings.',
  inputSchema: runContextSchema,
  outputSchema: partsStageSchema,
  retries: 2,
  execute: async ({ inputData: run, writer }) => {
    const parts: SourcePart[] = [];
    const partSources: string[] = [];
    let nextIndex = 1;

    for (
      let sourceIndex = 0;
      sourceIndex < run.sourcePaths.length;
      sourceIndex++
    ) {
      const sourcePath = run.sourcePaths[sourceIndex]!;
      const cacheDir = documentCacheDir(run.sourcePaths, sourceIndex);

      if (run.sourcePaths.length > 1) {
        await writer?.write(
          `Preparing PDF ${sourceIndex + 1} of ${run.sourcePaths.length}: ${sourcePath}\n`,
        );
      }

      const bytes = await readWorkspaceBytes(sourcePath);
      const plan = await planPdfParts(bytes, {
        maxPagesPerPart: run.maxPagesPerPart,
        minPagesPerPart: run.minPagesPerPart,
      });

      if (plan.ranges.length === 0) {
        throw new Error(
          `Could not determine any page ranges for "${sourcePath}".`,
        );
      }

      const baseName = path.basename(sourcePath, path.extname(sourcePath));
      const splitParts = await splitPdfByRanges(
        bytes,
        plan.ranges,
        path.posix.join(
          run.runDir,
          'source-parts',
          ...(cacheDir ? [cacheDir] : []),
        ),
        baseName,
      );

      const ocrDir = path.posix.join(
        run.runDir,
        'ocr',
        ...(cacheDir ? [cacheDir] : []),
      );
      const partsDir = path.posix.join(run.runDir, 'parts');
      await ensureWorkspaceDir(ocrDir);
      await ensureWorkspaceDir(partsDir);

      const partsBefore = parts.length;

      for (const part of splitParts) {
        const ocrPath = path.posix.join(
          ocrDir,
          `part-${padIndex(part.index)}.md`,
        );
        let markdown: string;

        if (await workspaceFileExists(ocrPath)) {
          markdown = await readWorkspaceText(ocrPath);
        } else {
          const modeLabel = run.remoteOCR
            ? 'via remote OCR'
            : 'via local text extraction';
          await writer?.write(
            `Converting part ${part.index} of ${splitParts.length} (pages ${part.startPage}-${part.endPage}) ${modeLabel}\n`,
          );

          const partBytes = await readWorkspaceBytes(part.partPath);
          if (run.remoteOCR) {
            const outcome = await convertPdfToMarkdown(
              partBytes,
              path.basename(part.partPath),
            );
            markdown = outcome.markdown;
          } else {
            markdown = await convertPdfToMarkdownLocal(partBytes);
          }
          await writeWorkspaceFile(ocrPath, markdown);
        }

        const chunks = chunkDocument(
          stripPageSeparators(markdown),
          run.maxPartChars,
        );

        if (chunks.length === 0) continue;

        for (const chunk of chunks) {
          const index = nextIndex;
          nextIndex += 1;
          const title = chunk.title ?? part.title;

          await writeWorkspaceFile(
            path.posix.join(partsDir, `part-${padIndex(index)}.md`),
            chunk.content,
          );

          parts.push({
            index,
            sourcePath,
            sourceIndex,
            ...(title ? { title } : {}),
            content: chunk.content,
            startPage: part.startPage,
            endPage: part.endPage,
          });
        }
      }

      const produced = parts.length - partsBefore;
      if (produced === 0) {
        throw new Error(
          `Document "${sourcePath}" produced no translatable content after ${run.remoteOCR ? 'OCR' : 'local text extraction'}.`,
        );
      }

      partSources.push(
        produced > splitParts.length ? `${plan.source}+headings` : plan.source,
      );
    }

    return {
      run,
      partSource:
        run.sourcePaths.length > 1
          ? `multi-document:${partSources.join(',')}`
          : partSources[0]!,
      parts,
    };
  },
});

const chunkTextPartsStep = createStep({
  id: 'chunk-text-parts',
  description:
    'Split text or markdown documents into parts on heading boundaries.',
  inputSchema: runContextSchema,
  outputSchema: partsStageSchema,
  execute: async ({ inputData: run, writer }) => {
    const parts: SourcePart[] = [];
    let nextIndex = 1;
    let multiPart = false;

    for (
      let sourceIndex = 0;
      sourceIndex < run.sourcePaths.length;
      sourceIndex++
    ) {
      const sourcePath = run.sourcePaths[sourceIndex]!;

      if (run.sourcePaths.length > 1) {
        await writer?.write(
          `Chunking document ${sourceIndex + 1} of ${run.sourcePaths.length}: ${sourcePath}\n`,
        );
      }

      const content = await readWorkspaceText(sourcePath);
      const chunks = chunkDocument(content, run.maxPartChars);

      if (chunks.length === 0) {
        throw new Error(
          `Document "${sourcePath}" has no translatable content.`,
        );
      }

      if (chunks.length > 1) multiPart = true;

      for (const chunk of chunks) {
        const index = nextIndex;
        nextIndex += 1;

        await writeWorkspaceFile(
          path.posix.join(run.runDir, 'parts', `part-${padIndex(index)}.md`),
          chunk.content,
        );
        parts.push({
          index,
          sourcePath,
          sourceIndex,
          ...(chunk.title ? { title: chunk.title } : {}),
          content: chunk.content,
        });
      }
    }

    return {
      run,
      partSource:
        run.sourcePaths.length > 1
          ? multiPart
            ? 'multi-document:headings'
            : 'multi-document:single-part'
          : multiPart
            ? 'headings'
            : 'single-part',
      parts,
    };
  },
});

/**
 * Office documents become markdown once via officeparser, then follow the same
 * heading-based chunking as native markdown. The converted markdown is cached
 * so a retry does not re-parse the binary.
 */
const prepareOfficePartsStep = createStep({
  id: 'prepare-office-parts',
  description:
    'Convert DOCX, RTF, or ODT documents to markdown, then split on heading boundaries.',
  inputSchema: runContextSchema,
  outputSchema: partsStageSchema,
  execute: async ({ inputData: run, writer }) => {
    if (!isOfficeKind(run.kind)) {
      throw new Error(
        `prepare-office-parts received unexpected kind "${run.kind}".`,
      );
    }

    const parts: SourcePart[] = [];
    let nextIndex = 1;
    let multiPart = false;

    for (
      let sourceIndex = 0;
      sourceIndex < run.sourcePaths.length;
      sourceIndex++
    ) {
      const sourcePath = run.sourcePaths[sourceIndex]!;
      const cacheDir = documentCacheDir(run.sourcePaths, sourceIndex);
      const markdownPath = path.posix.join(
        run.runDir,
        ...(cacheDir ? [cacheDir] : []),
        'source.md',
      );
      let markdown: string;

      if (await workspaceFileExists(markdownPath)) {
        markdown = await readWorkspaceText(markdownPath);
      } else {
        await writer?.write(
          `Converting ${path.basename(sourcePath)} to markdown\n`,
        );
        markdown = await convertOfficeToMarkdown(
          await readWorkspaceBytes(sourcePath),
          run.kind,
        );
        await writeWorkspaceFile(markdownPath, markdown);
      }

      const chunks = chunkDocument(markdown, run.maxPartChars);

      if (chunks.length === 0) {
        throw new Error(
          `Document "${sourcePath}" has no translatable content after conversion.`,
        );
      }

      if (chunks.length > 1) multiPart = true;

      for (const chunk of chunks) {
        const index = nextIndex;
        nextIndex += 1;

        await writeWorkspaceFile(
          path.posix.join(run.runDir, 'parts', `part-${padIndex(index)}.md`),
          chunk.content,
        );
        parts.push({
          index,
          sourcePath,
          sourceIndex,
          ...(chunk.title ? { title: chunk.title } : {}),
          content: chunk.content,
        });
      }
    }

    return {
      run,
      partSource:
        run.sourcePaths.length > 1
          ? multiPart
            ? 'multi-document:office-headings'
            : 'multi-document:office-single-part'
          : multiPart
            ? 'office-headings'
            : 'office-single-part',
      parts,
    };
  },
});

const flattenJsonPartsStep = createStep({
  id: 'flatten-json-parts',
  description:
    'Flatten i18n resource bundles into batches of translatable string values.',
  inputSchema: runContextSchema,
  outputSchema: partsStageSchema,
  execute: async ({ inputData: run, writer }) => {
    const parts: SourcePart[] = [];
    let nextIndex = 1;

    for (
      let sourceIndex = 0;
      sourceIndex < run.sourcePaths.length;
      sourceIndex++
    ) {
      const sourcePath = run.sourcePaths[sourceIndex]!;

      if (run.sourcePaths.length > 1) {
        await writer?.write(
          `Flattening JSON ${sourceIndex + 1} of ${run.sourcePaths.length}: ${sourcePath}\n`,
        );
      }

      const raw = await readWorkspaceText(sourcePath);

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new Error(
          `"${sourcePath}" is not valid JSON: ${(error as Error).message}`,
        );
      }

      const entries = flattenStrings(parsed);
      if (entries.length === 0) {
        throw new Error(
          `"${sourcePath}" contains no translatable string values.`,
        );
      }

      const batches = batchEntries(entries, run.maxPartChars);
      for (const batch of batches) {
        const index = nextIndex;
        nextIndex += 1;
        parts.push({
          index,
          sourcePath,
          sourceIndex,
          entries: batch,
        });
      }
    }

    return {
      run,
      partSource:
        run.sourcePaths.length > 1
          ? 'multi-document:json-batches'
          : 'json-batches',
      parts,
    };
  },
});

/**
 * Only text nodes and selected attributes become translatable content. Tags,
 * scripts, styles, and every other region stay on disk and are re-read at
 * assembly time, so the output is the source file with its strings swapped out.
 */
const flattenHtmlPartsStep = createStep({
  id: 'flatten-html-parts',
  description:
    'Extract translatable HTML text nodes and attributes into batches.',
  inputSchema: runContextSchema,
  outputSchema: partsStageSchema,
  execute: async ({ inputData: run, writer }) => {
    const parts: SourcePart[] = [];
    let nextIndex = 1;

    for (
      let sourceIndex = 0;
      sourceIndex < run.sourcePaths.length;
      sourceIndex++
    ) {
      const sourcePath = run.sourcePaths[sourceIndex]!;

      if (run.sourcePaths.length > 1) {
        await writer?.write(
          `Extracting HTML ${sourceIndex + 1} of ${run.sourcePaths.length}: ${sourcePath}\n`,
        );
      }

      const raw = await readWorkspaceText(sourcePath);
      const entries = flattenHtml(raw);

      if (entries.length === 0) {
        throw new Error(`"${sourcePath}" contains no translatable HTML text.`);
      }

      const batches = batchHtmlEntries(entries, run.maxPartChars);
      for (const batch of batches) {
        const index = nextIndex;
        nextIndex += 1;
        parts.push({
          index,
          sourcePath,
          sourceIndex,
          entries: batch,
        });
      }
    }

    return {
      run,
      partSource:
        run.sourcePaths.length > 1
          ? 'multi-document:html-batches'
          : 'html-batches',
      parts,
    };
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
    'Parse SRT or ASS subtitle files into batches of consecutive cues.',
  inputSchema: runContextSchema,
  outputSchema: partsStageSchema,
  execute: async ({ inputData: run, writer }) => {
    const parts: SourcePart[] = [];
    let nextIndex = 1;

    for (
      let sourceIndex = 0;
      sourceIndex < run.sourcePaths.length;
      sourceIndex++
    ) {
      const sourcePath = run.sourcePaths[sourceIndex]!;

      if (run.sourcePaths.length > 1) {
        await writer?.write(
          `Parsing subtitles ${sourceIndex + 1} of ${run.sourcePaths.length}: ${sourcePath}\n`,
        );
      }

      const raw = await readWorkspaceText(sourcePath);
      const cues = parseSubtitles(raw, run.kind as SubtitleKind);

      if (cues.length === 0) {
        throw new Error(
          `"${sourcePath}" contains no translatable subtitle cues.`,
        );
      }

      const batches = batchCues(cues, run.maxPartChars);
      for (const batch of batches) {
        const index = nextIndex;
        nextIndex += 1;
        parts.push({
          index,
          sourcePath,
          sourceIndex,
          cues: batch,
        });
      }
    }

    return {
      run,
      partSource:
        run.sourcePaths.length > 1
          ? 'multi-document:subtitle-cues'
          : 'subtitle-cues',
      parts,
    };
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
    'prepare-office-parts': partsStageSchema.optional(),
    'flatten-json-parts': partsStageSchema.optional(),
    'flatten-html-parts': partsStageSchema.optional(),
    'parse-subtitle-parts': partsStageSchema.optional(),
    'chunk-text-parts': partsStageSchema.optional(),
  }),
  outputSchema: partsStageSchema,
  execute: async ({ inputData }) => {
    // Only the branch that ran contributes a key.
    const stage =
      inputData['prepare-pdf-parts'] ??
      inputData['prepare-office-parts'] ??
      inputData['flatten-json-parts'] ??
      inputData['flatten-html-parts'] ??
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
        `Translating part ${part.index} of ${parts.length}${
          run.sourcePaths.length > 1 ? ` (${part.sourcePath})` : ''
        }\n`,
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

      if (run.kind === 'html') {
        const entries = part.entries ?? [];
        const response = await translator.generate(
          buildHtmlTranslationPrompt(context, partContext, entries),
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
            // than leaving a hole in the page.
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

    if (run.skipEditor) {
      await writer?.write(
        'Skipping editor review; assembling first-pass translation\n',
      );
      return {
        run,
        partSource,
        parts,
        reviewed: translated,
        issues: [],
      };
    }

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
        `Reviewing part ${part.index} of ${translated.length}${
          run.sourcePaths.length > 1
            ? ` (${sourceByIndex.get(part.index)?.sourcePath ?? 'unknown'})`
            : ''
        }\n`,
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

      if (run.kind === 'html') {
        const sourceByPointer = new Map(
          (source?.entries ?? []).map((entry) => [entry.pointer, entry.value]),
        );
        const reviewEntries = (part.entries ?? []).map((entry) => ({
          pointer: entry.pointer,
          source: sourceByPointer.get(entry.pointer) ?? '',
          translation: entry.translation,
        }));

        const response = await editor.generate(
          buildHtmlReviewPrompt(context, partContext, reviewEntries),
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
    'Write each localized document, the final glossary, and a run report.',
  inputSchema: reviewStageSchema,
  outputSchema: workflowOutputSchema,
  execute: async ({ inputData }) => {
    const { run, partSource, parts, reviewed, issues } = inputData;
    const reviewedByIndex = new Map(reviewed.map((part) => [part.index, part]));

    const outputs: Array<z.infer<typeof documentOutputSchema>> = [];

    for (
      let sourceIndex = 0;
      sourceIndex < run.sourcePaths.length;
      sourceIndex++
    ) {
      const sourcePath = run.sourcePaths[sourceIndex]!;
      const outputPath = run.outputPaths[sourceIndex]!;
      const documentParts = parts.filter(
        (part) => part.sourceIndex === sourceIndex,
      );
      const documentReviewed = documentParts.map((part) =>
        reviewedByIndex.get(part.index)!,
      );

      let content: string;

      if (run.kind === 'json') {
        const original = JSON.parse(
          await readWorkspaceText(sourcePath),
        ) as unknown;
        const translations = new Map<string, string>();
        for (const part of documentReviewed) {
          for (const entry of part.entries ?? [])
            translations.set(entry.pointer, entry.translation);
        }
        content = `${JSON.stringify(rebuildWithTranslations(original, translations), null, 2)}\n`;
      } else if (run.kind === 'html') {
        const original = await readWorkspaceText(sourcePath);
        const translations = new Map<string, string>();
        for (const part of documentReviewed) {
          for (const entry of part.entries ?? [])
            translations.set(entry.pointer, entry.translation);
        }
        content = rebuildHtml(original, translations);
      } else if (isSubtitleKind(run.kind)) {
        const original = await readWorkspaceText(sourcePath);
        const translations = new Map<string, string>();
        for (const part of documentReviewed) {
          for (const cue of part.cues ?? [])
            translations.set(cue.id, cue.translation);
        }
        content = rebuildSubtitles(original, run.kind, translations);
      } else {
        const joined = documentReviewed
          .map((part) => part.content?.trim() ?? '')
          .filter(Boolean)
          .join('\n\n');
        content = run.outputFormat === 'text' ? stripMarkdown(joined) : joined;
      }

      await writeWorkspaceFile(outputPath, content);
      outputs.push({
        sourcePath,
        outputPath,
        partCount: documentParts.length,
      });
    }

    const glossary = await readGlossaryFile(run.glossaryPath);
    const reportPath = path.posix.join(run.runDir, 'report.json');

    await writeWorkspaceFile(
      reportPath,
      `${JSON.stringify(
        {
          sourcePaths: run.sourcePaths,
          outputs,
          kind: run.kind,
          outputFormat: run.outputFormat,
          targetLanguage: run.targetLanguage,
          sourceLanguage: run.sourceLanguage ?? null,
          remoteOCR: run.kind === 'pdf' ? run.remoteOCR : null,
          skipEditor: run.skipEditor,
          partSource,
          partCount: parts.length,
          documentCount: run.sourcePaths.length,
          glossaryTermCount: glossary.terms.length,
          issues,
          parts: parts.map((part) => ({
            index: part.index,
            sourcePath: part.sourcePath,
            sourceIndex: part.sourceIndex,
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
      outputPath: outputs[0]!.outputPath,
      outputs,
      glossaryPath: run.glossaryPath,
      reportPath,
      runDir: run.runDir,
      outputFormat: run.outputFormat,
      partSource,
      partCount: parts.length,
      documentCount: run.sourcePaths.length,
      glossaryTermCount: glossary.terms.length,
      issueCount: issues.length,
    };
  },
});

export const localizeDocumentWorkflow = createWorkflow({
  id: 'localizeDocumentWorkflow',
  description:
    'Localize one or more plain text, markdown, PDF, office (DOCX/RTF/ODT), JSON, HTML, or subtitle (SRT/ASS) documents of the same type into a target language using a shared terminology glossary, then optionally review the result for correctness and consistency.',
  inputSchema: workflowInputSchema,
  outputSchema: workflowOutputSchema,
})
  .then(prepareRunStep)
  .branch([
    [async ({ inputData }) => inputData.kind === 'pdf', preparePdfPartsStep],
    [
      async ({ inputData }) =>
        inputData.kind === 'docx' ||
        inputData.kind === 'rtf' ||
        inputData.kind === 'odt',
      prepareOfficePartsStep,
    ],
    [async ({ inputData }) => inputData.kind === 'json', flattenJsonPartsStep],
    [async ({ inputData }) => inputData.kind === 'html', flattenHtmlPartsStep],
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
