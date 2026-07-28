import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { detectDocumentKind, isSubtitleKind } from '../lib/document-kind';
import { parseSubtitles } from '../lib/subtitles';
import { readWorkspaceText } from '../lib/workspace-paths';

const cueSchema = z.object({
  id: z.string(),
  text: z.string(),
  start: z.string().optional(),
  end: z.string().optional(),
  style: z.string().optional(),
});

async function readSubtitleCues(subtitlePath: string) {
  const kind = detectDocumentKind(subtitlePath);

  if (!isSubtitleKind(kind)) {
    throw new Error(
      `"${subtitlePath}" is not a subtitle file. Expected a .srt, .ass, or .ssa extension.`,
    );
  }

  const raw = await readWorkspaceText(subtitlePath);
  return { format: kind, cues: parseSubtitles(raw, kind) };
}

export const inspectSubtitlesTool = createTool({
  id: 'inspect_subtitles',
  description:
    'Parse an SRT or ASS subtitle file and report its format, how many translatable cues it holds, the styles it uses, and a sample of cues. Use this to check a subtitle file before starting a localization run.',
  inputSchema: z.object({
    subtitlePath: z
      .string()
      .describe('Workspace-relative path to the subtitle file.'),
    sampleSize: z
      .number()
      .int()
      .min(0)
      .max(50)
      .default(5)
      .describe('How many leading cues to include in the sample.'),
  }),
  outputSchema: z.object({
    subtitlePath: z.string(),
    format: z.enum(['srt', 'ass']),
    cueCount: z.number(),
    characterCount: z.number(),
    firstStart: z.string().optional(),
    lastEnd: z.string().optional(),
    styles: z.array(z.string()),
    sample: z.array(cueSchema),
  }),
  execute: async ({ subtitlePath, sampleSize }) => {
    const { format, cues } = await readSubtitleCues(subtitlePath);

    const first = cues[0];
    const last = cues.at(-1);
    const styles = [
      ...new Set(
        cues
          .map((cue) => cue.style)
          .filter((style): style is string => !!style),
      ),
    ];

    return {
      subtitlePath,
      format,
      cueCount: cues.length,
      characterCount: cues.reduce((total, cue) => total + cue.text.length, 0),
      ...(first?.start ? { firstStart: first.start } : {}),
      ...(last?.end ? { lastEnd: last.end } : {}),
      styles,
      sample: cues.slice(0, sampleSize),
    };
  },
});

export const readSubtitleCuesTool = createTool({
  id: 'read_subtitle_cues',
  description:
    'Read the translatable cues of an SRT or ASS subtitle file, optionally a slice of them. Timings, cue numbering, and styling are excluded because only the dialogue text is ever translated.',
  inputSchema: z.object({
    subtitlePath: z
      .string()
      .describe('Workspace-relative path to the subtitle file.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Index of the first cue to return.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe('How many cues to return.'),
  }),
  outputSchema: z.object({
    subtitlePath: z.string(),
    format: z.enum(['srt', 'ass']),
    cueCount: z.number(),
    cues: z.array(cueSchema),
  }),
  execute: async ({ subtitlePath, offset, limit }) => {
    const { format, cues } = await readSubtitleCues(subtitlePath);

    return {
      subtitlePath,
      format,
      cueCount: cues.length,
      cues: cues.slice(offset, offset + limit),
    };
  },
});

export const subtitleTools = {
  inspect_subtitles: inspectSubtitlesTool,
  read_subtitle_cues: readSubtitleCuesTool,
};
