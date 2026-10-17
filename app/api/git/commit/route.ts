import { NextRequest, NextResponse } from "next/server";
import { isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { getGitCommit, getGitCommitFileDiff, isCommitId } from "@/lib/git-history";
import { checkGitRepositoryRequest } from "@/lib/git-repository-request";

/** GET ?cwd=&sha= a commit and its changed files; with &path= that file's patch. */
export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const checked = await checkGitRepositoryRequest(params.get("cwd"));
    if (!checked.ok) return checked.response;
    if (!checked.repositoryRoot) {
      return NextResponse.json({ error: "Not a Git repository" }, { status: 404 });
    }

    const sha = params.get("sha")?.trim() ?? "";
    if (!isCommitId(sha)) {
      return NextResponse.json({ error: "sha must be a commit id" }, { status: 400 });
    }

    const filePath = params.get("path")?.trim();
    if (filePath === undefined) {
      const commit = await getGitCommit(checked.repositoryRoot, sha);
      return commit
        ? NextResponse.json(commit)
        : NextResponse.json({ error: "Commit not found" }, { status: 404 });
    }

    if (!filePath || (!filePath.startsWith("/") && !isWindowsAbsolutePath(filePath))) {
      return NextResponse.json({ error: "path must be an absolute path" }, { status: 400 });
    }
    if (!isFilePathAllowed(filePath, checked.allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    // getGitCommitFileDiff only answers for a file this commit changed.
    const diff = await getGitCommitFileDiff(checked.repositoryRoot, sha, filePath);
    return diff
      ? NextResponse.json(diff)
      : NextResponse.json({ error: "File not changed in this commit" }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
