export type GitFileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict";

export interface GitFileStatus {
  filePath: string;
  status: GitFileStatusKind;
  code: "M" | "A" | "D" | "R" | "U" | "C";
  indexStatus: string;
  worktreeStatus: string;
}

export interface GitStatusResponse {
  isGitRepository: boolean;
  repositoryRoot: string | null;
  files: GitFileStatus[];
  additions: number;
  deletions: number;
}

export interface GitFileDiffResponse {
  supported: boolean;
  status?: GitFileStatusKind;
  patch?: string;
}

export interface GitCommitSummary {
  sha: string;
  shortSha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Author date, milliseconds since the epoch. */
  authoredAt: number;
  subject: string;
}

export interface GitLogResponse {
  isGitRepository: boolean;
  repositoryRoot: string | null;
  /** Checked-out branch of the cwd's worktree; null when detached or not a repository. */
  branch: string | null;
  /** Commit the page was read from; pass it back as `rev` so later pages stay on the same history. */
  head: string | null;
  commits: GitCommitSummary[];
  hasMore: boolean;
}

export type GitCommitFileStatusKind = "modified" | "added" | "deleted" | "renamed" | "copied";

export interface GitCommitFile {
  filePath: string;
  /** Source path of a rename or copy. */
  oldFilePath?: string;
  status: GitCommitFileStatusKind;
  code: "M" | "A" | "D" | "R" | "C";
  /** Null for binary files. */
  additions: number | null;
  deletions: number | null;
}

export interface GitCommitResponse {
  commit: GitCommitSummary & { body: string };
  files: GitCommitFile[];
}

export interface GitCommitFileDiffResponse {
  supported: boolean;
  reason?: "binary" | "too-large";
  status?: GitCommitFileStatusKind;
  patch?: string;
}

/** What a commit-diff tab remembers about the file it shows. */
export interface CommitDiffTarget {
  cwd: string;
  repositoryRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authoredAt: number;
  filePath: string;
  oldFilePath?: string;
}
