"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import { getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { formatRelativeTime } from "@/lib/i18n/format";
import type {
  GitCommitFile,
  GitCommitFileStatusKind,
  GitCommitResponse,
  GitCommitSummary,
  GitLogResponse,
} from "@/lib/git-types";
import { getFileIcon } from "./FileIcons";

export interface GitCommitFileTarget {
  cwd: string;
  repositoryRoot: string;
  commit: GitCommitSummary;
  file: GitCommitFile;
}

interface Props {
  cwd: string;
  refreshKey?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Reports whether the cwd is in a Git repository, so the sidebar can lay the section out. */
  onAvailableChange?: (available: boolean) => void;
  onOpenCommitFile: (target: GitCommitFileTarget) => void;
}

type CommitDetails =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; data: GitCommitResponse };

const STATUS_COLORS: Record<GitCommitFileStatusKind, string> = {
  modified: "#d6a84b",
  added: "#4ade80",
  deleted: "#f87171",
  renamed: "#60a5fa",
  copied: "#60a5fa",
};

const STATUS_KEYS: Record<GitCommitFileStatusKind, string> = {
  modified: "files.modified",
  added: "files.added",
  deleted: "files.deleted",
  renamed: "files.renamed",
  copied: "gitHistory.copied",
};

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function fetchLog(cwd: string, rev: string | null, skip: number): Promise<GitLogResponse> {
  const params = new URLSearchParams({ cwd });
  if (rev) params.set("rev", rev);
  if (skip) params.set("skip", String(skip));
  return readJson<GitLogResponse>(await fetch(`/api/git/log?${params.toString()}`));
}

async function fetchCommit(cwd: string, sha: string): Promise<GitCommitResponse> {
  const params = new URLSearchParams({ cwd, sha });
  return readJson<GitCommitResponse>(await fetch(`/api/git/commit?${params.toString()}`));
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="9" height="9" viewBox="0 0 10 10" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
    >
      <polyline points="3 2 7 5 3 8" />
    </svg>
  );
}

const BODY_CLAMP_LINES = 4;

/** Full message and exact metadata of an expanded commit; the subject wraps in the row above. */
function CommitMessage({ commit }: { commit: GitCommitResponse["commit"] }) {
  const { locale, t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Offer "Show more" only when the clamped body actually hides lines.
  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element || showAll) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [commit.body, showAll]);

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const copyHash = () => {
    copyText(commit.sha).then(() => {
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <div style={{ padding: "0 8px 4px 24px", display: "flex", flexDirection: "column", gap: 3 }}>
      {commit.body && (
        <>
          <div
            ref={bodyRef}
            className="git-history-body"
            style={showAll ? undefined : {
              display: "-webkit-box",
              WebkitLineClamp: BODY_CLAMP_LINES,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {commit.body}
          </div>
          {(overflowing || showAll) && (
            <button
              type="button"
              className="git-history-text-button"
              onClick={() => setShowAll((value) => !value)}
              aria-expanded={showAll}
            >
              {t(showAll ? "gitHistory.showLess" : "gitHistory.showMore")}
            </button>
          )}
        </>
      )}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 6, rowGap: 2, fontSize: 10, color: "var(--text-dim)" }}>
        <button
          type="button"
          className="git-history-text-button"
          onClick={copyHash}
          title={`${t("gitHistory.copyHash")}: ${commit.sha}`}
          aria-label={`${t("gitHistory.copyHash")}: ${commit.sha}`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, fontFamily: "var(--font-mono)" }}
        >
          {commit.shortSha}
          {copied ? (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
        <span title={commit.authorEmail} style={{ overflowWrap: "anywhere" }}>{commit.authorName}</span>
        <span>{new Date(commit.authoredAt).toLocaleString(locale)}</span>
      </div>
      {commit.parents.length > 1 && (
        <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("gitHistory.mergeFirstParent")}</div>
      )}
    </div>
  );
}

function CommitFileRow({
  file,
  repositoryRoot,
  onOpen,
}: {
  file: GitCommitFile;
  repositoryRoot: string;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const rel = getRelativeFilePath(file.filePath, repositoryRoot);
  const lastSlash = rel.lastIndexOf("/");
  const dirPart = lastSlash >= 0 ? rel.slice(0, lastSlash + 1) : "";
  const baseName = lastSlash >= 0 ? rel.slice(lastSlash + 1) : rel;
  const title = file.oldFilePath
    ? `${getRelativeFilePath(file.oldFilePath, repositoryRoot)} → ${rel}`
    : rel;
  return (
    <button
      type="button"
      className="git-history-row"
      onClick={onOpen}
      title={title}
      style={{ paddingLeft: 24, height: 24 }}
    >
      <span
        title={t(STATUS_KEYS[file.status])}
        aria-label={t(STATUS_KEYS[file.status])}
        style={{
          width: 14,
          flexShrink: 0,
          textAlign: "center",
          color: STATUS_COLORS[file.status],
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        {file.code}
      </span>
      <span style={{ flexShrink: 0, display: "flex", alignItems: "center", opacity: 0.85 }}>
        {getFileIcon(getFileName(file.filePath), 13)}
      </span>
      <span style={{ display: "flex", minWidth: 0, flex: 1, fontSize: 12 }}>
        {dirPart && (
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, color: "var(--text-dim)" }}>
            {dirPart}
          </span>
        )}
        <span style={{ whiteSpace: "nowrap", flexShrink: 0, color: "var(--text)" }}>{baseName}</span>
      </span>
      {file.additions === null ? (
        <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)" }}>{t("gitHistory.binary")}</span>
      ) : (
        <span style={{ flexShrink: 0, display: "flex", gap: 4, fontSize: 10, fontFamily: "var(--font-mono)" }}>
          {file.additions > 0 && <span style={{ color: STATUS_COLORS.added }}>+{file.additions}</span>}
          {(file.deletions ?? 0) > 0 && <span style={{ color: STATUS_COLORS.deleted }}>-{file.deletions}</span>}
        </span>
      )}
    </button>
  );
}

export function GitHistory({ cwd, refreshKey, open, onOpenChange, onAvailableChange, onOpenCommitFile }: Props) {
  const { locale, t } = useI18n();
  const [log, setLog] = useState<GitLogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [details, setDetails] = useState<Record<string, CommitDetails>>({});
  const [reloadKey, setReloadKey] = useState(0);
  const requestRef = useRef(0);
  const logRef = useRef<GitLogResponse | null>(null);
  logRef.current = log;
  const detailsRef = useRef(details);
  detailsRef.current = details;
  const cwdRef = useRef(cwd);

  // A different cwd is a different history: start over.
  useEffect(() => {
    cwdRef.current = cwd;
    logRef.current = null;
    detailsRef.current = {};
    setLog(null);
    setError(null);
    setExpanded(new Set());
    setDetails({});
  }, [cwd]);

  useEffect(() => {
    const requestId = ++requestRef.current;
    fetchLog(cwd, null, 0)
      .then((next) => {
        if (requestId !== requestRef.current) return;
        setError(null);
        const current = logRef.current;
        // Unchanged head and branch: keep the pages already loaded.
        if (current && current.head === next.head && current.branch === next.branch) return;
        setLog(next);
      })
      .catch((reason: unknown) => {
        if (requestId !== requestRef.current) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [cwd, refreshKey, reloadKey]);

  const available = log?.isGitRepository === true;
  useEffect(() => {
    onAvailableChange?.(available);
  }, [available, onAvailableChange]);

  const loadMore = useCallback(async () => {
    const current = logRef.current;
    if (!current?.head || loadingMore) return;
    const requestId = requestRef.current;
    setLoadingMore(true);
    try {
      const next = await fetchLog(cwd, current.head, current.commits.length);
      if (requestId !== requestRef.current) return;
      setLog((prev) => prev && prev.head === next.head
        ? { ...prev, commits: [...prev.commits, ...next.commits], hasMore: next.hasMore }
        : prev);
    } catch (reason) {
      if (requestId === requestRef.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingMore(false);
    }
  }, [cwd, loadingMore]);

  const toggleCommit = useCallback((sha: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });
    // Commits never change: fetch each one's files once (again only after an error).
    const existing = detailsRef.current[sha];
    if (existing && existing.state !== "error") return;
    const requestCwd = cwd;
    const store = (detail: CommitDetails) => {
      if (cwdRef.current !== requestCwd) return;
      detailsRef.current = { ...detailsRef.current, [sha]: detail };
      setDetails(detailsRef.current);
    };
    store({ state: "loading" });
    fetchCommit(requestCwd, sha)
      .then((data) => store({ state: "ready", data }))
      .catch((reason: unknown) => store({
        state: "error",
        message: reason instanceof Error ? reason.message : String(reason),
      }));
  }, [cwd]);

  // Not a repository, or the first load failed: no section at all.
  if (!available) return null;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flex: 1,
            minWidth: 0,
            padding: "6px 10px",
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            textAlign: "left",
          }}
        >
          <Chevron open={open} />
          <span style={{ flexShrink: 0 }}>{t("gitHistory.title")}</span>
          {log?.branch && (
            <span
              title={log.branch}
              style={{
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontWeight: 400,
                letterSpacing: 0,
                textTransform: "none",
                color: "var(--text-dim)",
              }}
            >
              {log.branch}
            </span>
          )}
        </button>
        {open && (
          <button
            type="button"
            className="git-history-icon-button"
            onClick={() => setReloadKey((key) => key + 1)}
            title={t("gitHistory.refresh")}
            aria-label={t("gitHistory.refresh")}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        )}
      </div>
      {open && (
        <div className="scrollbar-subtle" style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", paddingBottom: 6 }}>
          {error && (
            <div role="alert" style={{ padding: "2px 10px 6px", fontSize: 11, color: "#f87171", overflowWrap: "anywhere" }}>
              {error}
            </div>
          )}
          {log && log.commits.length === 0 && !error && (
            <div style={{ padding: "2px 10px 6px", fontSize: 11, color: "var(--text-dim)" }}>{t("gitHistory.empty")}</div>
          )}
          {log?.commits.map((commit) => {
            const isExpanded = expanded.has(commit.sha);
            const detail = details[commit.sha];
            const date = new Date(commit.authoredAt);
            return (
              <div key={commit.sha}>
                <button
                  type="button"
                  className="git-history-row"
                  onClick={() => toggleCommit(commit.sha)}
                  aria-expanded={isExpanded}
                  title={`${commit.shortSha} · ${commit.authorName} · ${date.toLocaleString(locale)}\n${commit.subject}`}
                  style={{ alignItems: "flex-start", padding: "4px 8px 4px 10px" }}
                >
                  <span style={{ paddingTop: 4, color: "var(--text-dim)", display: "flex" }}><Chevron open={isExpanded} /></span>
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1, gap: 1 }}>
                    <span
                      style={isExpanded
                        ? { fontSize: 12, color: "var(--text)", whiteSpace: "normal", overflowWrap: "anywhere" }
                        : { fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {commit.subject || t("gitHistory.noMessage")}
                    </span>
                    <span style={{ display: "flex", gap: 6, fontSize: 10, color: "var(--text-dim)", minWidth: 0 }}>
                      <span style={{ fontFamily: "var(--font-mono)", flexShrink: 0 }}>{commit.shortSha}</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{commit.authorName}</span>
                      <span style={{ flexShrink: 0, marginLeft: "auto" }}>{formatRelativeTime(date, locale)}</span>
                    </span>
                  </span>
                </button>
                {isExpanded && (
                  <div style={{ paddingBottom: 4 }}>
                    {(!detail || detail.state === "loading") && (
                      <div style={{ padding: "2px 24px", fontSize: 11, color: "var(--text-dim)" }}>{t("i18n.loading")}</div>
                    )}
                    {detail?.state === "error" && (
                      <div role="alert" style={{ padding: "2px 24px", fontSize: 11, color: "#f87171", overflowWrap: "anywhere" }}>{detail.message}</div>
                    )}
                    {detail?.state === "ready" && (
                      <>
                        <CommitMessage commit={detail.data.commit} />
                        {detail.data.files.length === 0 && (
                          <div style={{ padding: "2px 24px", fontSize: 11, color: "var(--text-dim)" }}>{t("gitHistory.noFiles")}</div>
                        )}
                        {detail.data.files.map((file) => (
                          <CommitFileRow
                            key={file.filePath}
                            file={file}
                            repositoryRoot={log.repositoryRoot!}
                            onOpen={() => onOpenCommitFile({ cwd, repositoryRoot: log.repositoryRoot!, commit, file })}
                          />
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {log?.hasMore && (
            <button
              type="button"
              className="git-history-load-more"
              onClick={() => { void loadMore(); }}
              disabled={loadingMore}
            >
              {loadingMore ? t("i18n.loading") : t("i18n.loadMore")}
            </button>
          )}
        </div>
      )}
    </>
  );
}
