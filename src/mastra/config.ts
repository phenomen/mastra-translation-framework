/**
 * The `vercel/` prefix routes through the Vercel AI Gateway with AI_GATEWAY_API_KEY.
 * Dropping it would send the call straight to the provider, which needs that
 * provider's own key instead.
 */
export const LOCALIZATION_MODEL =
  process.env.LOCALIZATION_MODEL || 'vercel/google/gemini-3.6-flash';

export const DEFAULT_MAX_PART_CHARS = 12_000;

export const DEFAULT_MAX_PAGES_PER_PART = 40;

export const DEFAULT_MIN_PAGES_PER_PART = 2;

/** PLAN.md specifies scanning the first 15 pages for a table of contents. */
export const TOC_SCAN_PAGES = 15;

export const DATALAB_BASE_URL = 'https://www.datalab.to';

/** Datalab's free tier allows only 5 concurrent requests, so parts convert one at a time. */
export const DATALAB_POLL_INTERVAL_MS = 3_000;

export const DATALAB_MAX_WAIT_MS = 15 * 60 * 1_000;

export const LOCALIZATION_RUNS_DIR = 'localization';
