import { NextRequest, NextResponse } from "next/server";
import { getGitLog, isCommitId } from "@/lib/git-history";
import { checkGitRepositoryRequest } from "@/lib/git-repository-request";
import type { GitLogResponse } from "@/lib/git-types";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const checked = await checkGitRepositoryRequest(params.get("cwd"));
    if (!checked.ok) return checked.response;

    const rev = params.get("rev")?.trim() || null;
    if (rev && !isCommitId(rev)) {
      return NextResponse.json({ error: "rev must be a commit id" }, { status: 400 });
    }
    const skip = Number(params.get("skip") ?? 0);
    if (!Number.isInteger(skip) || skip < 0) {
      return NextResponse.json({ error: "skip must be a non-negative integer" }, { status: 400 });
    }

    if (!checked.repositoryRoot) {
      const empty: GitLogResponse = {
        isGitRepository: false,
        repositoryRoot: null,
        branch: null,
        head: null,
        commits: [],
        hasMore: false,
      };
      return NextResponse.json(empty);
    }
    return NextResponse.json(await getGitLog(checked.repositoryRoot, { rev, skip }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
