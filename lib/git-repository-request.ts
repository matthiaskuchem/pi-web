import fs from "fs";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "./file-access";
import { resolveRepositoryRoot } from "./git-history";

export type GitRepositoryRequest =
  | { ok: true; cwd: string; repositoryRoot: string | null; allowedRoots: Set<string> }
  | { ok: false; response: NextResponse };

function fail(error: string, status: number): GitRepositoryRequest {
  return { ok: false, response: NextResponse.json({ error }, { status }) };
}

/**
 * Route checks for the Git history routes. The cwd must be an existing
 * directory inside the allowed roots, as for /api/git/status. History covers
 * the whole repository, so its top level must be allowed too: a cwd below a
 * repository root outside the allowed roots gets no history.
 */
export async function checkGitRepositoryRequest(rawCwd: string | null): Promise<GitRepositoryRequest> {
  const cwd = rawCwd?.trim() ?? "";
  if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
    return fail("cwd must be an absolute path", 400);
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots)) return fail("Access denied", 403);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return fail("Directory not found", 404);
  }
  if (!stat.isDirectory()) return fail("Not a directory", 400);
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) return fail("Access denied", 403);

  const repositoryRoot = await resolveRepositoryRoot(cwd);
  if (repositoryRoot && !isExistingFilePathAllowed(repositoryRoot, allowedRoots)) {
    return fail("Access denied", 403);
  }
  return { ok: true, cwd, repositoryRoot, allowedRoots };
}
