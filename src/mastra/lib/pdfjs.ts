import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * pdfjs-dist must use the legacy build in Node (the modern build expects DOM
 * APIs like DOMMatrix). A static import of
 * `pdfjs-dist/legacy/build/pdf.mjs` breaks under Mastra's Windows bundler:
 * the external subpath is rewritten with backslashes, and Node rejects it as
 * ERR_INVALID_MODULE_SPECIFIER.
 *
 * Resolve the entry at runtime and import via a file:// URL instead.
 */
const require = createRequire(import.meta.url);

type PdfjsLegacy = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
export type PdfjsGetDocument = PdfjsLegacy['getDocument'];

let pdfjsModule: Promise<PdfjsLegacy> | undefined;

export function loadPdfjs(): Promise<PdfjsLegacy> {
  pdfjsModule ??= import(
    pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href
  ) as Promise<PdfjsLegacy>;
  return pdfjsModule;
}
