const aiModel = process.env.AI_MODEL;

if (!aiModel) {
  throw new Error('AI_MODEL environment variable is required');
}

export const AI_MODEL = aiModel;

export const DEFAULT_MAX_PART_CHARS = 20_000;

export const DEFAULT_MAX_PAGES_PER_PART = 20;

export const DEFAULT_MIN_PAGES_PER_PART = 2;

export const TOC_SCAN_PAGES = 10;

export const DATALAB_BASE_URL = 'https://www.datalab.to';

export const DATALAB_POLL_INTERVAL_MS = 3_000;

export const DATALAB_MAX_WAIT_MS = 15 * 60 * 1_000;

export const TRANSLATION_RUNS_DIR = 'translation';
