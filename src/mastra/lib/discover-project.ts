import path from "node:path";

import { detectDocumentKind, type DocumentKind } from "./document-kind";
import {
  assertWorkspaceDir,
  listWorkspaceDir,
  type WorkspaceDirEntry,
} from "./workspace-paths";

/** Run-output and VCS folders that are never part of a localization project. */
const SKIP_DIRECTORY_NAMES = new Set([
  "translation",
  "localization",
  "node_modules",
  ".git",
  ".mastra",
]);

const GLOSSARY_NAME_PATTERN =
  /(?:^|[-_.\s])(glossary|terminolog(?:y|ies)|terms|vocab(?:ulary)?)(?:$|[-_.\s])/i;

const STYLE_NAME_PATTERN =
  /(?:^|[-_.\s])(style[-_]?guide|guide|instruction|styleguide|style|tone|voice)(?:$|[-_.\s])/i;

const GLOSSARY_EXTENSIONS = new Set([
  ".csv",
  ".json",
  ".md",
  ".markdown",
  ".txt",
]);

const STYLE_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

/** Exact basenames preferred when several glossary candidates exist. */
const PREFERRED_GLOSSARY_NAMES = [
  "glossary.csv",
  "glossary.json",
  "glossary.md",
  "glossary.txt",
  "terms.csv",
  "terminology.csv",
  "terms.json",
];

/** Exact basenames preferred when several style-guide candidates exist. */
const PREFERRED_STYLE_NAMES = [
  "guide.md",
  "guide.txt",
  "instruction.md",
  "instruction.txt",
  "style_guide.md",
  "style-guide.md",
  "style.md",
  "style.txt",
  "styleguide.md",
  "tone.md",
];

/** Prefer these source kinds when a folder mixes several document types. */
const SOURCE_KIND_PRIORITY: DocumentKind[] = [
  "pdf",
  "docx",
  "odt",
  "rtf",
  "srt",
  "ass",
  "json",
  "markdown",
  "text",
];

export type DiscoveredProject = {
  directoryPath: string;
  sourcePaths: string[];
  sourceKind: DocumentKind | null;
  sourcesByKind: Partial<Record<DocumentKind, string[]>>;
  glossaryPath: string | null;
  glossaryCandidates: string[];
  styleGuidePath: string | null;
  styleGuideCandidates: string[];
  skipped: Array<{ path: string; reason: string }>;
  notes: string[];
};

function basenameLower(filePath: string): string {
  return path.posix.basename(filePath).toLowerCase();
}

function extensionOf(filePath: string): string {
  return path.posix.extname(filePath).toLowerCase();
}

function isGlossaryCandidate(filePath: string): boolean {
  const name = basenameLower(filePath);
  return (
    GLOSSARY_EXTENSIONS.has(extensionOf(filePath)) &&
    GLOSSARY_NAME_PATTERN.test(name)
  );
}

function isStyleGuideCandidate(filePath: string): boolean {
  const name = basenameLower(filePath);
  // A glossary named "glossary-style.csv" should stay a glossary.
  if (isGlossaryCandidate(filePath)) return false;
  return (
    STYLE_EXTENSIONS.has(extensionOf(filePath)) && STYLE_NAME_PATTERN.test(name)
  );
}

function pickPreferred(
  candidates: string[],
  preferredNames: string[],
): string | null {
  if (candidates.length === 0) return null;

  const byName = new Map(
    candidates.map((candidate) => [basenameLower(candidate), candidate]),
  );
  for (const preferred of preferredNames) {
    const match = byName.get(preferred);
    if (match) return match;
  }

  return [...candidates].sort((a, b) => a.localeCompare(b))[0] ?? null;
}

function pickSourceKind(
  sourcesByKind: Partial<Record<DocumentKind, string[]>>,
): DocumentKind | null {
  const kinds = SOURCE_KIND_PRIORITY.filter(
    (kind) => (sourcesByKind[kind]?.length ?? 0) > 0,
  );
  if (kinds.length === 0) return null;

  let best = kinds[0]!;
  let bestCount = sourcesByKind[best]!.length;

  for (const kind of kinds.slice(1)) {
    const count = sourcesByKind[kind]!.length;
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }

  return best;
}

async function collectFiles(
  directoryPath: string,
  recursive: boolean,
): Promise<{ files: string[]; skipped: DiscoveredProject["skipped"] }> {
  const files: string[] = [];
  const skipped: DiscoveredProject["skipped"] = [];
  const queue = [directoryPath];

  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries: WorkspaceDirEntry[];

    try {
      entries = await listWorkspaceDir(current);
    } catch (error) {
      skipped.push({
        path: current,
        reason: `Could not list directory: ${(error as Error).message}`,
      });
      continue;
    }

    for (const entry of entries) {
      if (entry.type === "directory") {
        if (SKIP_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
          skipped.push({
            path: entry.path,
            reason: "Skipped known output or system directory",
          });
          continue;
        }
        if (entry.name.startsWith(".")) {
          skipped.push({
            path: entry.path,
            reason: "Skipped hidden directory",
          });
          continue;
        }
        if (recursive) queue.push(entry.path);
        continue;
      }

      if (entry.name.startsWith(".")) {
        skipped.push({
          path: entry.path,
          reason: "Skipped hidden file",
        });
        continue;
      }

      files.push(entry.path);
    }
  }

  files.sort((a, b) => a.localeCompare(b));
  return { files, skipped };
}

/**
 * Inspect a workspace project folder and classify source documents, glossary,
 * and style guide files by name and extension.
 */
export async function discoverLocalizationProject(
  directoryPath: string,
  options: { recursive?: boolean } = {},
): Promise<DiscoveredProject> {
  const recursive = options.recursive ?? true;
  const normalized =
    directoryPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || ".";

  await assertWorkspaceDir(normalized, "Project directory");

  const { files, skipped } = await collectFiles(normalized, recursive);
  const notes: string[] = [];

  const glossaryCandidates = files.filter(isGlossaryCandidate);
  const styleGuideCandidates = files.filter(isStyleGuideCandidate);
  const claimed = new Set([...glossaryCandidates, ...styleGuideCandidates]);

  const sourcesByKind: Partial<Record<DocumentKind, string[]>> = {};
  for (const filePath of files) {
    if (claimed.has(filePath)) continue;

    const kind = detectDocumentKind(filePath);
    // Bare .txt/.md without glossary/style names are treated as sources. JSON
    // without a glossary-like name is treated as an i18n bundle.
    const bucket = sourcesByKind[kind] ?? [];
    bucket.push(filePath);
    sourcesByKind[kind] = bucket;
  }

  const glossaryPath = pickPreferred(
    glossaryCandidates,
    PREFERRED_GLOSSARY_NAMES,
  );
  const styleGuidePath = pickPreferred(
    styleGuideCandidates,
    PREFERRED_STYLE_NAMES,
  );
  const sourceKind = pickSourceKind(sourcesByKind);
  const sourcePaths = sourceKind ? [...(sourcesByKind[sourceKind] ?? [])] : [];

  const otherKinds = Object.entries(sourcesByKind)
    .filter(([kind]) => kind !== sourceKind)
    .map(([kind, paths]) => `${kind} (${paths?.length ?? 0})`);

  if (sourcePaths.length === 0) {
    notes.push(
      "No source documents found after setting aside glossary and style-guide files.",
    );
  } else if (otherKinds.length > 0) {
    notes.push(
      `Selected ${sourcePaths.length} ${sourceKind} file(s) as sources. Other types were left out: ${otherKinds.join(", ")}. Pass a different subset if that is wrong.`,
    );
  }

  if (!glossaryPath) {
    notes.push(
      "No glossary file found (looked for names like glossary.csv or terms.json). The run can proceed with an empty glossary.",
    );
  } else if (glossaryCandidates.length > 1) {
    notes.push(
      `Using "${glossaryPath}" as the glossary. Other candidates: ${glossaryCandidates
        .filter((candidate) => candidate !== glossaryPath)
        .join(", ")}.`,
    );
  }

  if (!styleGuidePath) {
    notes.push(
      "No style guide found (looked for names like style.md or style-guide.txt).",
    );
  } else if (styleGuideCandidates.length > 1) {
    notes.push(
      `Using "${styleGuidePath}" as the style guide. Other candidates: ${styleGuideCandidates
        .filter((candidate) => candidate !== styleGuidePath)
        .join(", ")}.`,
    );
  }

  return {
    directoryPath: normalized,
    sourcePaths,
    sourceKind,
    sourcesByKind,
    glossaryPath,
    glossaryCandidates,
    styleGuidePath,
    styleGuideCandidates,
    skipped,
    notes,
  };
}
