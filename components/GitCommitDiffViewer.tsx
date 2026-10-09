"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getRelativeFilePath } from "@/lib/file-paths";
import type { CommitDiffTarget, GitCommitFileDiffResponse } from "@/lib/git-types";
import { DiffView } from "./FileViewer";

type DiffState =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; diff: GitCommitFileDiffResponse };

export function GitCommitDiffViewer({ target }: { target: CommitDiffTarget }) {
  const { locale, t } = useI18n();
  const [result, setResult] = useState<DiffState>({ state: "loading" });
  const { cwd, sha, filePath } = target;

  useEffect(() => {
    let cancelled = false;
    setResult({ state: "loading" });
    const params = new URLSearchParams({ cwd, sha, path: filePath });
    fetch(`/api/git/commit?${params.toString()}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as GitCommitFileDiffResponse & { error?: string };
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        if (!cancelled) setResult({ state: "ready", diff: body });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setResult({ state: "error", message: reason instanceof Error ? reason.message : String(reason) });
      });
    return () => { cancelled = true; };
  }, [cwd, sha, filePath]);

  const relativePath = getRelativeFilePath(target.filePath, target.repositoryRoot);
  const pathLabel = target.oldFilePath
    ? `${getRelativeFilePath(target.oldFilePath, target.repositoryRoot)} → ${relativePath}`
    : relativePath;
  const meta = `${target.shortSha} · ${target.subject} · ${target.authorName} · ${new Date(target.authoredAt).toLocaleString(locale)}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        className="file-viewer-toolbar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 12px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span className="file-viewer-path" style={{ fontFamily: "var(--font-mono)" }} title={pathLabel}>
          {pathLabel}
        </span>
        <span className="file-viewer-meta" title={meta}>{meta}</span>
      </div>
      <div className="file-viewer-content" style={{ flex: 1, overflow: "auto", background: "var(--bg)" }}>
        {result.state === "loading" && (
          <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-muted)" }}>{t("i18n.loading")}</div>
        )}
        {result.state === "error" && (
          <div role="alert" style={{ padding: "12px 16px", fontSize: 12, color: "#f87171" }}>{result.message}</div>
        )}
        {result.state === "ready" && (result.diff.supported && result.diff.patch !== undefined ? (
          <DiffView patch={result.diff.patch} />
        ) : (
          <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-dim)" }}>
            {t(result.diff.reason === "too-large" ? "gitHistory.diffTooLarge" : "gitHistory.diffBinary")}
          </div>
        ))}
      </div>
    </div>
  );
}
