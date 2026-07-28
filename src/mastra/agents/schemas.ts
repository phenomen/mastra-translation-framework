import { z } from 'zod';

export const proposedTermSchema = z.object({
  source: z
    .string()
    .describe('The term exactly as it appears in the source text.'),
  target: z
    .string()
    .describe('The translation to use consistently from now on.'),
  notes: z
    .string()
    .optional()
    .describe('Why this rendering was chosen, or usage constraints.'),
});

export const issueSchema = z.object({
  severity: z.enum(['low', 'medium', 'high']),
  description: z.string().describe('What was wrong and what was changed.'),
});

export const translationSchema = z.object({
  translation: z.string().describe('The full translated text for this part.'),
  newTerms: z
    .array(proposedTermSchema)
    .default([])
    .describe(
      'Recurring domain terms established while translating this part. Empty when no new term was established.',
    ),
});

export const reviewSchema = z.object({
  correctedTranslation: z
    .string()
    .describe(
      'The full corrected translation, or the input unchanged if it was already correct.',
    ),
  issues: z
    .array(issueSchema)
    .default([])
    .describe('Problems found. Empty when the translation was clean.'),
});

export const jsonTranslationSchema = z.object({
  entries: z
    .array(
      z.object({
        pointer: z
          .string()
          .describe('The JSON Pointer, copied verbatim from the input.'),
        translation: z.string().describe('The translated string value.'),
      }),
    )
    .describe('One entry per input string, in the same order.'),
  newTerms: z
    .array(proposedTermSchema)
    .default([])
    .describe(
      'Recurring domain terms established while translating this part. Empty when no new term was established.',
    ),
});

export const jsonReviewSchema = z.object({
  entries: z.array(
    z.object({
      pointer: z.string(),
      correctedTranslation: z.string(),
    }),
  ),
  issues: z
    .array(issueSchema)
    .default([])
    .describe('Problems found. Empty when the translation was clean.'),
});

export const subtitleTranslationSchema = z.object({
  cues: z
    .array(
      z.object({
        id: z.string().describe('The cue id, copied verbatim from the input.'),
        translation: z
          .string()
          .describe('The translated cue text, with its markup preserved.'),
      }),
    )
    .describe('One entry per input cue, in the same order.'),
  newTerms: z
    .array(proposedTermSchema)
    .default([])
    .describe(
      'Recurring domain terms established while translating this part. Empty when no new term was established.',
    ),
});

export const subtitleReviewSchema = z.object({
  cues: z.array(
    z.object({
      id: z.string(),
      correctedTranslation: z.string(),
    }),
  ),
  issues: z
    .array(issueSchema)
    .default([])
    .describe('Problems found. Empty when the translation was clean.'),
});

export type TranslationResult = z.infer<typeof translationSchema>;
export type ReviewResult = z.infer<typeof reviewSchema>;
export type JsonTranslationResult = z.infer<typeof jsonTranslationSchema>;
export type JsonReviewResult = z.infer<typeof jsonReviewSchema>;
export type SubtitleTranslationResult = z.infer<
  typeof subtitleTranslationSchema
>;
export type SubtitleReviewResult = z.infer<typeof subtitleReviewSchema>;
export type LocalizationIssue = z.infer<typeof issueSchema>;
