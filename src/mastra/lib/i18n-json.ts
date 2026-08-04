export interface JsonStringEntry {
  /** RFC 6901 JSON Pointer, so keys containing dots or slashes stay unambiguous. */
  pointer: string;
  value: string;
}

export function encodePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Collects every translatable string leaf. Whitespace-only values are skipped so
 * they are not spent as model tokens, and are left untouched on rebuild.
 */
export function flattenStrings(root: unknown): JsonStringEntry[] {
  const entries: JsonStringEntry[] = [];

  const walk = (value: unknown, pointer: string): void => {
    if (typeof value === 'string') {
      if (value.trim().length > 0) entries.push({ pointer, value });
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${pointer}/${index}`));
      return;
    }

    if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        walk(child, `${pointer}/${encodePointerSegment(key)}`);
      }
    }
  };

  walk(root, '');
  return entries;
}

export function isTranslatableJsonBundle(root: unknown): boolean {
  if (typeof root !== 'object' || root === null) return false;
  return flattenStrings(root).length > 0;
}

/**
 * Returns a deep copy with translated strings applied. Keys, ordering, arrays,
 * and every non-string value are preserved exactly; missing translations keep
 * the original text.
 */
export function rebuildWithTranslations(
  root: unknown,
  translations: Map<string, string>,
): unknown {
  const walk = (value: unknown, pointer: string): unknown => {
    if (typeof value === 'string') {
      return translations.get(pointer) ?? value;
    }

    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, `${pointer}/${index}`));
    }

    if (typeof value === 'object' && value !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        result[key] = walk(child, `${pointer}/${encodePointerSegment(key)}`);
      }
      return result;
    }

    return value;
  };

  return walk(root, '');
}

/**
 * Groups entries into batches bounded by both total characters and entry count,
 * since a batch with many tiny strings still produces a large structured reply.
 */
export function batchEntries(
  entries: JsonStringEntry[],
  maxChars: number,
  maxEntries = 100,
): JsonStringEntry[][] {
  const batches: JsonStringEntry[][] = [];
  let current: JsonStringEntry[] = [];
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
