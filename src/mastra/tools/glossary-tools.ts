import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import {
  detectGlossaryFormat,
  formatGlossaryForPrompt,
  mergeTerms,
  parseGlossary,
  type Glossary,
  type GlossaryTerm,
} from '../lib/glossary';
import { readWorkspaceText, writeWorkspaceFile } from '../lib/workspace-paths';

const termSchema = z.object({
  source: z.string().describe('The term as it appears in the source language.'),
  target: z.string().describe('The agreed translation in the target language.'),
  notes: z
    .string()
    .optional()
    .describe('Why this translation was chosen, or usage constraints.'),
});

const storedTermSchema = termSchema.extend({
  origin: z.enum(['seed', 'translator']),
});

export async function readGlossaryFile(
  glossaryPath: string,
): Promise<Glossary> {
  const raw = await readWorkspaceText(glossaryPath);
  const parsed = JSON.parse(raw) as unknown;

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as Glossary).terms)
  ) {
    throw new Error(
      `Glossary at "${glossaryPath}" is not a canonical glossary file.`,
    );
  }

  return parsed as Glossary;
}

export async function writeGlossaryFile(
  glossaryPath: string,
  terms: GlossaryTerm[],
): Promise<void> {
  await writeWorkspaceFile(
    glossaryPath,
    `${JSON.stringify({ terms }, null, 2)}\n`,
  );
}

export const loadGlossaryTool = createTool({
  id: 'load_glossary',
  description:
    'Read a glossary in plain text, markdown, JSON, or CSV format and write it as a canonical glossary JSON file that the translator can extend.',
  inputSchema: z.object({
    glossaryPath: z
      .string()
      .describe(
        'Workspace-relative path to the source glossary (.txt, .md, .json, or .csv).',
      ),
    outputPath: z
      .string()
      .describe(
        'Workspace-relative path to write the canonical glossary JSON to.',
      ),
  }),
  outputSchema: z.object({
    outputPath: z.string(),
    termCount: z.number(),
    format: z.enum(['json', 'csv', 'markdown', 'text']),
  }),
  execute: async ({ glossaryPath, outputPath }) => {
    const format = detectGlossaryFormat(glossaryPath);
    const content = await readWorkspaceText(glossaryPath);
    const terms = mergeTerms(parseGlossary(content, format, 'seed'));

    await writeGlossaryFile(outputPath, terms);

    return { outputPath, termCount: terms.length, format };
  },
});

export const readGlossaryTool = createTool({
  id: 'read_glossary',
  description:
    'Read a canonical glossary JSON file and return its terms, plus a compact rendering suitable for a prompt.',
  inputSchema: z.object({
    glossaryPath: z
      .string()
      .describe('Workspace-relative path to the canonical glossary JSON.'),
  }),
  outputSchema: z.object({
    terms: z.array(storedTermSchema),
    termCount: z.number(),
    rendered: z.string(),
  }),
  execute: async ({ glossaryPath }) => {
    const glossary = await readGlossaryFile(glossaryPath);

    return {
      terms: glossary.terms,
      termCount: glossary.terms.length,
      rendered: formatGlossaryForPrompt(glossary.terms),
    };
  },
});

export const appendGlossaryTermsTool = createTool({
  id: 'append_glossary_terms',
  description:
    'Merge newly established terms into a canonical glossary JSON file. Existing terms are never overwritten, so terminology stays stable across parts.',
  inputSchema: z.object({
    glossaryPath: z
      .string()
      .describe('Workspace-relative path to the canonical glossary JSON.'),
    terms: z.array(termSchema).describe('Terms to add.'),
  }),
  outputSchema: z.object({
    termCount: z.number(),
    addedCount: z.number(),
  }),
  execute: async ({ glossaryPath, terms }) => {
    const glossary = await readGlossaryFile(glossaryPath);
    const additions: GlossaryTerm[] = terms.map((term) => ({
      ...term,
      origin: 'translator',
    }));
    const merged = mergeTerms(glossary.terms, additions);

    await writeGlossaryFile(glossaryPath, merged);

    return {
      termCount: merged.length,
      addedCount: merged.length - glossary.terms.length,
    };
  },
});

export const glossaryTools = {
  load_glossary: loadGlossaryTool,
  read_glossary: readGlossaryTool,
  append_glossary_terms: appendGlossaryTermsTool,
};
