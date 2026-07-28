import {
  LocalFilesystem,
  LocalSandbox,
  WORKSPACE_TOOLS,
  Workspace,
} from '@mastra/core/workspace';

/**
 * A relative `basePath` resolves against the working directory the CLI sets,
 * which is `src/mastra/public` under `mastra dev` and `.mastra/output` under
 * `mastra start`. Both are created by the command that uses them, so source
 * documents go in whichever one you are running against.
 *
 * @see https://mastra.ai/reference/workspace/local-filesystem
 */
const WORKSPACE_BASE_PATH = './workspace';

/**
 * `contained` keeps every path the agents and workflow supply inside the
 * workspace, including after symlink resolution.
 */
export const workspaceFilesystem = new LocalFilesystem({
  id: 'localization-workspace-filesystem',
  basePath: WORKSPACE_BASE_PATH,
  contained: true,
});

export const workspace = new Workspace({
  id: 'localization-workspace',
  name: 'Localization Workspace',
  filesystem: workspaceFilesystem,
  sandbox: new LocalSandbox({ workingDirectory: WORKSPACE_BASE_PATH }),
  tools: {
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: {
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: {
      requireApproval: true,
    },
  },
});
