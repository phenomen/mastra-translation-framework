import path from 'node:path';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import {
  DATALAB_BASE_URL,
  DATALAB_MAX_WAIT_MS,
  DATALAB_POLL_INTERVAL_MS,
} from '../config';
import { readWorkspaceBytes } from '../lib/workspace-paths';

interface SubmitResponse {
  success?: boolean;
  error?: string | null;
  request_id: string;
  request_check_url: string;
}

interface ResultResponse {
  status: string;
  success?: boolean | null;
  error?: string | null;
  markdown?: string | null;
  result_url?: string | null;
  page_count?: number | null;
}

export interface OcrOutcome {
  markdown: string;
  pageCount?: number;
  requestId: string;
}

function requireApiKey(): string {
  const apiKey = process.env.DATALAB_API_KEY;
  if (!apiKey) {
    throw new Error(
      'DATALAB_API_KEY is not set. Add it to .env to run remote PDF OCR, or set remoteOCR to false to use local text extraction.',
    );
  }
  return apiKey;
}

/**
 * Remote Datalab OCR when `remoteOCR` is true, local officeparser when false.
 * When omitted, use remote OCR only if `DATALAB_API_KEY` is set.
 */
export function resolveUseRemoteOcr(remoteOCR?: boolean): boolean {
  if (remoteOCR === true) return true;
  if (remoteOCR === false) return false;
  return Boolean(process.env.DATALAB_API_KEY?.trim());
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_SUBMIT_ATTEMPTS = 4;

async function submitConversion(
  apiKey: string,
  bytes: Buffer,
  fileName: string,
): Promise<SubmitResponse> {
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }),
    fileName,
  );

  // These settings are fixed by PLAN.md.
  form.append('mode', 'balanced');
  form.append('paginate', 'true');
  form.append('output_format', 'markdown');
  form.append('disable_image_extraction', 'true');
  form.append('disable_image_captions', 'true');

  for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt += 1) {
    const response = await fetch(`${DATALAB_BASE_URL}/api/v1/convert`, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: form,
    });

    if (response.status === 429) {
      if (attempt === MAX_SUBMIT_ATTEMPTS) {
        throw new Error('Datalab rate limit (429) persisted across retries.');
      }
      await sleep(attempt * 15_000);
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `Datalab convert request failed with ${response.status} ${response.statusText}: ${await safeText(response)}`,
      );
    }

    const payload = (await response.json()) as SubmitResponse;
    if (payload.success === false || !payload.request_check_url) {
      throw new Error(
        `Datalab rejected the conversion: ${payload.error ?? 'unknown error'}`,
      );
    }

    return payload;
  }

  throw new Error('Datalab convert request could not be submitted.');
}

async function pollForResult(
  apiKey: string,
  checkUrl: string,
): Promise<ResultResponse> {
  const deadline = Date.now() + DATALAB_MAX_WAIT_MS;

  while (Date.now() < deadline) {
    const response = await fetch(checkUrl, {
      headers: { 'X-API-Key': apiKey },
    });

    if (response.status === 429) {
      await sleep(DATALAB_POLL_INTERVAL_MS * 5);
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `Datalab result check failed with ${response.status} ${response.statusText}: ${await safeText(response)}`,
      );
    }

    const payload = (await response.json()) as ResultResponse;
    if (payload.status === 'complete') return payload;

    await sleep(DATALAB_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Datalab conversion did not complete within ${Math.round(DATALAB_MAX_WAIT_MS / 60_000)} minutes.`,
  );
}

export async function convertPdfToMarkdown(
  bytes: Buffer,
  fileName: string,
): Promise<OcrOutcome> {
  const apiKey = requireApiKey();
  const submitted = await submitConversion(apiKey, bytes, fileName);
  const result = await pollForResult(apiKey, submitted.request_check_url);

  // The page-concurrency limit is reported here rather than as an HTTP error, so
  // `success` must be checked explicitly even on a completed request.
  if (result.success === false) {
    throw new Error(
      `Datalab conversion failed: ${result.error ?? 'unknown error'}`,
    );
  }

  let markdown = result.markdown ?? '';

  if (!markdown && result.result_url) {
    const download = await fetch(result.result_url);
    if (!download.ok) {
      throw new Error(
        `Failed to download Datalab result: ${download.status} ${download.statusText}`,
      );
    }
    const payload = (await download.json()) as ResultResponse;
    if (payload.success === false) {
      throw new Error(
        `Datalab conversion failed: ${payload.error ?? 'unknown error'}`,
      );
    }
    markdown = payload.markdown ?? '';
  }

  if (!markdown.trim()) {
    throw new Error('Datalab returned an empty markdown result.');
  }

  return {
    markdown,
    ...(typeof result.page_count === 'number'
      ? { pageCount: result.page_count }
      : {}),
    requestId: submitted.request_id,
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}

export const datalabOcrTool = createTool({
  id: 'datalab_ocr',
  description:
    'Convert a PDF to paginated markdown using the Datalab OCR API. Submits the document and polls until the conversion completes.',
  inputSchema: z.object({
    documentPath: z
      .string()
      .describe('Workspace-relative path to the PDF to convert.'),
  }),
  outputSchema: z.object({
    markdown: z.string(),
    pageCount: z.number().optional(),
    requestId: z.string(),
  }),
  execute: async ({ documentPath }) => {
    const bytes = await readWorkspaceBytes(documentPath);
    return convertPdfToMarkdown(bytes, path.basename(documentPath));
  },
});

export const ocrTools = {
  datalab_ocr: datalabOcrTool,
};
