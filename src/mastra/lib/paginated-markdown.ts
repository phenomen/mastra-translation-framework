/**
 * Datalab's `paginate: true` option separates pages with a horizontal rule carrying
 * the page number, for example `{0}------------------------------------------------`.
 * The markers are kept while parts are being tracked and stripped before assembly.
 */
const PAGE_SEPARATOR = /^[ \t]*\{(\d+)\}[ \t]*-{6,}[ \t]*$/;

export interface MarkdownPage {
  page: number;
  content: string;
}

export function splitPaginatedMarkdown(markdown: string): MarkdownPage[] {
  const pages: MarkdownPage[] = [];
  let currentPage = 0;
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join('\n').trim();
    if (content) pages.push({ page: currentPage, content });
    buffer = [];
  };

  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const match = PAGE_SEPARATOR.exec(line);

    if (match) {
      flush();
      currentPage = Number.parseInt(match[1], 10);
      continue;
    }

    buffer.push(line);
  }

  flush();
  return pages;
}

export function stripPageSeparators(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !PAGE_SEPARATOR.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
