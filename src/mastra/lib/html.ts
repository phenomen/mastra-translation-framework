import { parse, type DefaultTreeAdapterMap } from 'parse5';

export interface HtmlStringEntry {
  /**
   * Stable id derived from document order (`t-12`, `a-3`), so re-parsing the
   * same source always yields the same pointers for assembly.
   */
  pointer: string;
  value: string;
}

interface LocatedEntry {
  pointer: string;
  value: string;
  start: number;
  end: number;
  kind: 'text' | 'attr';
  /** Quote character wrapping an attribute value, when present. */
  quote?: '"' | "'";
}

type TreeNode = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type TextNode = DefaultTreeAdapterMap['textNode'];

/** Elements whose text content is code, data, or non-prose and must not be translated. */
const SKIP_ELEMENTS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'code',
  'pre',
  'kbd',
  'samp',
  'var',
  'svg',
  'math',
]);

const TRANSLATABLE_ATTRS = new Set([
  'alt',
  'title',
  'placeholder',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
]);

const META_NAME_VALUES = new Set([
  'description',
  'keywords',
  'author',
  'application-name',
]);

const META_PROPERTY_VALUES = new Set([
  'og:title',
  'og:description',
  'og:site_name',
  'twitter:title',
  'twitter:description',
  'twitter:label1',
  'twitter:label2',
]);

function isElement(node: TreeNode): node is Element {
  return (
    typeof (node as Element).tagName === 'string' &&
    Array.isArray((node as Element).attrs)
  );
}

function isTextNode(node: TreeNode): node is TextNode {
  return (node as TextNode).nodeName === '#text';
}

function attrValue(element: Element, name: string): string | undefined {
  const found = element.attrs.find(
    (attr) => attr.name.toLowerCase() === name.toLowerCase(),
  );
  return found?.value;
}

function shouldTranslateMetaContent(element: Element): boolean {
  if (element.tagName.toLowerCase() !== 'meta') return false;

  const name = attrValue(element, 'name')?.trim().toLowerCase();
  if (name && META_NAME_VALUES.has(name)) return true;

  const property = attrValue(element, 'property')?.trim().toLowerCase();
  if (property && META_PROPERTY_VALUES.has(property)) return true;

  return false;
}

function isTranslatableAttr(element: Element, attrName: string): boolean {
  const lower = attrName.toLowerCase();
  if (TRANSLATABLE_ATTRS.has(lower)) return true;
  if (lower === 'content' && shouldTranslateMetaContent(element)) return true;
  return false;
}

/**
 * Attribute locations from parse5 cover `name="value"` (or `'…'` / unquoted).
 * Returns the absolute range of the value only, plus the quote style used.
 */
function attributeValueRange(
  raw: string,
  attrStart: number,
  attrEnd: number,
): { start: number; end: number; quote?: '"' | "'" } | null {
  const source = raw.slice(attrStart, attrEnd);
  const eq = source.indexOf('=');
  if (eq < 0) return null;

  let i = eq + 1;
  while (i < source.length && /\s/.test(source[i]!)) i += 1;
  if (i >= source.length) return null;

  const first = source[i]!;
  if (first === '"' || first === "'") {
    if (source[source.length - 1] !== first) return null;
    return {
      start: attrStart + i + 1,
      end: attrEnd - 1,
      quote: first,
    };
  }

  return { start: attrStart + i, end: attrEnd };
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value: string, quote?: '"' | "'"): string {
  let escaped = value.replace(/&/g, '&amp;');
  if (quote === '"') {
    escaped = escaped.replace(/"/g, '&quot;');
  } else if (quote === "'") {
    escaped = escaped.replace(/'/g, '&#39;');
  } else {
    escaped = escaped
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/\s/g, ' ');
  }
  return escaped;
}

function collectLocated(raw: string): LocatedEntry[] {
  const document = parse(raw, {
    sourceCodeLocationInfo: true,
    // Treat <noscript> as data so its markup is not walked as page content.
    scriptingEnabled: true,
  });

  const entries: LocatedEntry[] = [];
  let textCount = 0;
  let attrCount = 0;

  const walk = (node: TreeNode, skipped: boolean): void => {
    if (isTextNode(node)) {
      if (skipped) return;
      const loc = node.sourceCodeLocation;
      if (!loc) return;
      if (node.value.trim().length === 0) return;

      textCount += 1;
      entries.push({
        pointer: `t-${textCount}`,
        value: node.value,
        start: loc.startOffset,
        end: loc.endOffset,
        kind: 'text',
      });
      return;
    }

    if (!isElement(node)) return;

    const tag = node.tagName.toLowerCase();
    const childSkipped = skipped || SKIP_ELEMENTS.has(tag);

    const loc = node.sourceCodeLocation;
    if (!childSkipped && loc?.attrs) {
      for (const attr of node.attrs) {
        if (!isTranslatableAttr(node, attr.name)) continue;
        if (attr.value.trim().length === 0) continue;

        const attrLoc = loc.attrs[attr.name];
        if (!attrLoc) continue;

        const range = attributeValueRange(
          raw,
          attrLoc.startOffset,
          attrLoc.endOffset,
        );
        if (!range) continue;

        attrCount += 1;
        entries.push({
          pointer: `a-${attrCount}`,
          value: attr.value,
          start: range.start,
          end: range.end,
          kind: 'attr',
          ...(range.quote ? { quote: range.quote } : {}),
        });
      }
    }

    for (const child of node.childNodes) {
      walk(child, childSkipped);
    }

    // <template> content lives on a separate fragment.
    if (tag === 'template' && 'content' in node && node.content) {
      for (const child of node.content.childNodes) {
        walk(child, true);
      }
    }
  };

  for (const child of document.childNodes) {
    walk(child, false);
  }

  return entries;
}

/**
 * Collects every translatable text node and selected attribute values.
 * Whitespace-only strings are skipped so they are not spent as model tokens.
 */
export function flattenHtml(raw: string): HtmlStringEntry[] {
  return collectLocated(raw).map(({ pointer, value }) => ({ pointer, value }));
}

/**
 * Returns the document with translated strings substituted in place. Tags,
 * attribute names, comments, doctype, and every non-translated region are
 * copied through untouched. Missing translations keep the source text.
 */
export function rebuildHtml(
  raw: string,
  translations: Map<string, string>,
): string {
  const located = collectLocated(raw);
  // Apply from the end so earlier offsets stay valid.
  const ordered = [...located].sort((a, b) => b.start - a.start);

  let result = raw;
  for (const entry of ordered) {
    const translation = translations.get(entry.pointer);
    if (translation === undefined) continue;

    const replacement =
      entry.kind === 'attr'
        ? escapeAttr(translation, entry.quote)
        : escapeText(translation);

    result =
      result.slice(0, entry.start) + replacement + result.slice(entry.end);
  }

  return result;
}

/**
 * Groups entries into batches bounded by both total characters and entry count,
 * since a batch with many tiny strings still produces a large structured reply.
 */
export function batchHtmlEntries(
  entries: HtmlStringEntry[],
  maxChars: number,
  maxEntries = 100,
): HtmlStringEntry[][] {
  const batches: HtmlStringEntry[][] = [];
  let current: HtmlStringEntry[] = [];
  let currentChars = 0;

  for (const entry of entries) {
    const cost = entry.pointer.length + entry.value.length;

    if (
      current.length > 0 &&
      (currentChars + cost > maxChars || current.length >= maxEntries)
    ) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(entry);
    currentChars += cost;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}
