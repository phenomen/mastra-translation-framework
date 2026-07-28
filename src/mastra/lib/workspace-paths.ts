import path from 'node:path';

import { workspaceFilesystem } from '../workspace';

/**
 * Convenience wrappers over the shared workspace filesystem for the workflow
 * and the localization tools, which pass workspace-relative paths around as
 * plain strings. The provider resolves those paths against its own base path
 * and rejects anything that escapes it, so nothing here needs to police paths.
 */

/** Normalizes a caller-supplied path to the posix form used in reports and step output. */
function normalize(relativePath: string): string {
  const posix = relativePath.split(path.sep).join('/');
  return path.posix.normalize(posix).replace(/^\/+/, '');
}

export async function readWorkspaceText(relativePath: string): Promise<string> {
  return (await workspaceFilesystem.readFile(relativePath, {
    encoding: 'utf8',
  })) as string;
}

/** Omitting an encoding is what makes the provider hand back raw bytes. */
export async function readWorkspaceBytes(
  relativePath: string,
): Promise<Buffer> {
  return (await workspaceFilesystem.readFile(relativePath)) as Buffer;
}

export async function writeWorkspaceFile(
  relativePath: string,
  contents: string | Uint8Array,
): Promise<string> {
  await workspaceFilesystem.writeFile(relativePath, contents, {
    recursive: true,
  });
  return normalize(relativePath);
}

export async function workspaceFileExists(
  relativePath: string,
): Promise<boolean> {
  try {
    const info = await workspaceFilesystem.stat(relativePath);
    return info.type === 'file';
  } catch {
    return false;
  }
}

export async function assertWorkspaceFile(
  relativePath: string,
  label: string,
): Promise<void> {
  if (await workspaceFileExists(relativePath)) return;

  const onDisk = workspaceFilesystem.resolveAbsolutePath(relativePath);

  throw new Error(
    onDisk
      ? `${label} not found at "${onDisk}". Paths are relative to the workspace directory (${workspaceFilesystem.basePath}).`
      : `${label} path "${relativePath}" resolves outside the workspace directory (${workspaceFilesystem.basePath}).`,
  );
}

export async function ensureWorkspaceDir(
  relativePath: string,
): Promise<string> {
  await workspaceFilesystem.mkdir(relativePath, { recursive: true });
  return normalize(relativePath);
}
