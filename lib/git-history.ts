import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import { samePath, toNativePath } from "./paths";
import type {
  GitCommitFile,
  GitCommitFileDiffResponse,
  GitCommitResponse,
  GitCommitSummary,
  GitLogResponse,
} from "./git-types";

// Read-only history for the sidebar's Git history panel: commits of the
// checked-out branch, the files one commit changed and one file's patch.
// Every call reads objects only. Optional locks are off, so no index refresh
// is written. The repository's fsmonitor hook, external diff programs,
// textconv filters and signature verification are disabled, so a history
// read never runs a command the repository configured.

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const PATCH_MAX_BUFFER = TEXT_PREVIEW_MAX_BYTES * 4;
export const GIT_LOG_PAGE_SIZE = 20;
const SHORT_SHA_LENGTH = 7;
const COMMIT_ID = /^[0-9a-f]{4,64}$/i;
const LOG_FIELDS = 6;

class GitOutputTooLargeError extends Error {}

async function git(cwd: string, args: string[], maxBuffer = GIT_MAX_BUFFER): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C", cwd,
      "--literal-pathspecs",
      "-c", "core.fsmonitor=false",
      "-c", "core.quotePath=false",
      "-c", "log.showSignature=false",
      ...args,
    ], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer,
      env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new GitOutputTooLargeError("Git output too large");
    }
    throw error;
  }
}

export function isCommitId(value: string): boolean {
  return COMMIT_ID.test(value);
}

/** Top level of the work tree containing `cwd` (a linked worktree's own root), or null. */
export async function resolveRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    return root ? toNativePath(root) : null;
  } catch {
    return null;
  }
}

async function verifyCommit(repositoryRoot: string, rev: string): Promise<string | null> {
  try {
    const sha = (await git(repositoryRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`])).trim();
    return sha || null;
  } catch {
    return null;
  }
}

async function readBranch(repositoryRoot: string): Promise<string | null> {
  try {
    return (await git(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

function toCommitSummary(fields: string[]): GitCommitSummary {
  const [sha, parents, authorName, authorEmail, authoredAt, subject] = fields;
  return {
    sha,
    shortSha: sha.slice(0, SHORT_SHA_LENGTH),
    parents: parents ? parents.split(" ").filter(Boolean) : [],
    authorName,
    authorEmail,
    authoredAt: Number(authoredAt) * 1000,
    subject,
  };
}

/** Parses `git log -z --format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s` output. */
export function parseGitLog(output: string): GitCommitSummary[] {
  const tokens = output.split("\0");
  const commits: GitCommitSummary[] = [];
  for (let index = 0; index + LOG_FIELDS <= tokens.length; index += LOG_FIELDS) {
    const fields = tokens.slice(index, index + LOG_FIELDS);
    if (!isCommitId(fields[0])) break;
    commits.push(toCommitSummary(fields));
  }
  return commits;
}

const LOG_FORMAT = "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s";

export async function getGitLog(
  repositoryRoot: string,
  options: { rev?: string | null; skip?: number; limit?: number } = {},
): Promise<GitLogResponse> {
  const limit = options.limit ?? GIT_LOG_PAGE_SIZE;
  const skip = Math.max(0, Math.floor(options.skip ?? 0));
  const [branch, head] = await Promise.all([
    readBranch(repositoryRoot),
    verifyCommit(repositoryRoot, options.rev || "HEAD"),
  ]);
  const base = { isGitRepository: true, repositoryRoot, branch, head };
  // An unborn branch (no commit yet) has no history.
  if (!head) return { ...base, commits: [], hasMore: false };

  const output = await git(repositoryRoot, [
    "log",
    "-z",
    "--no-color",
    LOG_FORMAT,
    `--max-count=${limit + 1}`,
    `--skip=${skip}`,
    head,
    "--",
  ]);
  const commits = parseGitLog(output);
  return { ...base, commits: commits.slice(0, limit), hasMore: commits.length > limit };
}

/** Parses `git diff-tree -z --name-status` output into repository-relative entries. */
export function parseNameStatus(output: string): Array<{ code: string; path: string; oldPath?: string }> {
  const tokens = output.split("\0");
  const entries: Array<{ code: string; path: string; oldPath?: string }> = [];
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index++];
    if (!status) continue;
    const code = status[0];
    if (code === "R" || code === "C") {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      if (oldPath === undefined || newPath === undefined) break;
      entries.push({ code, path: newPath, oldPath });
    } else {
      const filePath = tokens[index++];
      if (filePath === undefined) break;
      entries.push({ code, path: filePath });
    }
  }
  return entries;
}

/** Parses `git diff-tree -z --numstat` output, keyed by the (new) repository-relative path. */
export function parseNumstat(output: string): Map<string, { additions: number | null; deletions: number | null }> {
  const tokens = output.split("\0");
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();
  let index = 0;
  while (index < tokens.length) {
    const record = tokens[index++];
    if (!record) continue;
    const parts = record.split("\t");
    if (parts.length < 3) continue;
    const [added, deleted] = parts;
    let filePath = parts.slice(2).join("\t");
    // A rename leaves the path empty and follows with the old and new path.
    if (filePath === "") {
      index++;
      filePath = tokens[index++] ?? "";
    }
    const binary = added === "-" || deleted === "-";
    stats.set(filePath, {
      additions: binary ? null : Number(added),
      deletions: binary ? null : Number(deleted),
    });
  }
  return stats;
}

const STATUS_BY_CODE: Record<string, Pick<GitCommitFile, "status" | "code">> = {
  A: { status: "added", code: "A" },
  D: { status: "deleted", code: "D" },
  M: { status: "modified", code: "M" },
  T: { status: "modified", code: "M" },
  R: { status: "renamed", code: "R" },
  C: { status: "copied", code: "C" },
};

/** Merge commits compare against their first parent; the root commit against the empty tree. */
function diffTreeRange(commit: GitCommitSummary): string[] {
  return commit.parents.length > 0 ? [commit.parents[0], commit.sha] : ["--root", commit.sha];
}

const DIFF_TREE_OPTIONS = ["-r", "-z", "-M", "--no-commit-id", "--no-ext-diff", "--no-textconv"];

async function readCommit(repositoryRoot: string, sha: string): Promise<GitCommitResponse["commit"] | null> {
  const full = await verifyCommit(repositoryRoot, sha);
  if (!full) return null;
  const output = await git(repositoryRoot, [
    "show",
    "-s",
    "--no-color",
    `${LOG_FORMAT}%x00%b`,
    full,
    "--",
  ]);
  const tokens = output.split("\0");
  if (tokens.length < LOG_FIELDS + 1) return null;
  return {
    ...toCommitSummary(tokens.slice(0, LOG_FIELDS)),
    body: tokens.slice(LOG_FIELDS).join("\0").trim(),
  };
}

async function readCommitFiles(repositoryRoot: string, commit: GitCommitSummary): Promise<GitCommitFile[]> {
  const range = diffTreeRange(commit);
  const [nameStatus, numstat] = await Promise.all([
    git(repositoryRoot, ["diff-tree", ...DIFF_TREE_OPTIONS, "--name-status", ...range, "--"]),
    git(repositoryRoot, ["diff-tree", ...DIFF_TREE_OPTIONS, "--numstat", ...range, "--"]),
  ]);
  const stats = parseNumstat(numstat);
  return parseNameStatus(nameStatus).map((entry): GitCommitFile => {
    const stat = stats.get(entry.path);
    return {
      filePath: toNativePath(path.join(repositoryRoot, entry.path)),
      ...(entry.oldPath !== undefined ? { oldFilePath: toNativePath(path.join(repositoryRoot, entry.oldPath)) } : {}),
      ...(STATUS_BY_CODE[entry.code] ?? STATUS_BY_CODE.M),
      additions: stat ? stat.additions : 0,
      deletions: stat ? stat.deletions : 0,
    };
  });
}

export async function getGitCommit(repositoryRoot: string, sha: string): Promise<GitCommitResponse | null> {
  if (!isCommitId(sha)) return null;
  const commit = await readCommit(repositoryRoot, sha);
  if (!commit) return null;
  return { commit, files: await readCommitFiles(repositoryRoot, commit) };
}

function toRepositoryPath(repositoryRoot: string, filePath: string): string {
  return path.relative(repositoryRoot, filePath).split(path.sep).join("/");
}

/**
 * Patch of one file in one commit. The file must be one the commit changed;
 * null otherwise, so a request can never name an arbitrary path.
 */
export async function getGitCommitFileDiff(
  repositoryRoot: string,
  sha: string,
  filePath: string,
): Promise<GitCommitFileDiffResponse | null> {
  const result = await getGitCommit(repositoryRoot, sha);
  if (!result) return null;
  const file = result.files.find((candidate) => samePath(candidate.filePath, filePath));
  if (!file) return null;
  if (file.additions === null) return { supported: false, reason: "binary", status: file.status };

  const pathspecs = [file.oldFilePath, file.filePath]
    .filter((value): value is string => Boolean(value))
    .map((value) => toRepositoryPath(repositoryRoot, value));
  try {
    const patch = await git(repositoryRoot, [
      "diff-tree",
      "-p",
      "--no-color",
      "--unified=3",
      ...DIFF_TREE_OPTIONS.filter((option) => option !== "-z"),
      ...diffTreeRange(result.commit),
      "--",
      ...pathspecs,
    ], PATCH_MAX_BUFFER);
    return { supported: true, status: file.status, patch };
  } catch (error) {
    if (error instanceof GitOutputTooLargeError) return { supported: false, reason: "too-large", status: file.status };
    throw error;
  }
}
