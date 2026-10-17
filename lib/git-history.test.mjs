import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./git-history.ts");
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

async function createRepository(t) {
  const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-web-git-history-")));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const repo = path.join(tempRoot, "repo");
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  return repo;
}

async function commitFile(repo, relativePath, content, message) {
  await mkdir(path.dirname(path.join(repo, relativePath)), { recursive: true });
  await writeFile(path.join(repo, relativePath), content);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

test("pages the checked-out branch's history from a fixed head", async (t) => {
  const repo = await createRepository(t);
  for (let index = 1; index <= 5; index++) {
    await commitFile(repo, "counter.txt", `${index}\n`, `commit ${index}`);
  }
  const { getGitLog, resolveRepositoryRoot } = await loadSubject();
  const root = await resolveRepositoryRoot(path.join(repo));
  assert.equal(root, repo);

  const first = await getGitLog(root, { limit: 2 });
  assert.equal(first.branch, "main");
  assert.deepEqual(first.commits.map((commit) => commit.subject), ["commit 5", "commit 4"]);
  assert.equal(first.hasMore, true);
  assert.equal(first.commits[0].authorName, "Pi Web Test");
  assert.equal(first.commits[0].shortSha, first.commits[0].sha.slice(0, 7));

  // A new commit on top must not shift the following pages.
  await commitFile(repo, "counter.txt", "6\n", "commit 6");
  const second = await getGitLog(root, { rev: first.head, skip: 2, limit: 2 });
  assert.deepEqual(second.commits.map((commit) => commit.subject), ["commit 3", "commit 2"]);
  const last = await getGitLog(root, { rev: first.head, skip: 4, limit: 2 });
  assert.deepEqual(last.commits.map((commit) => commit.subject), ["commit 1"]);
  assert.equal(last.hasMore, false);
});

test("follows the branch checked out in a linked worktree", async (t) => {
  const repo = await createRepository(t);
  await commitFile(repo, "a.txt", "a\n", "on main");
  const linked = `${repo}-feature`;
  t.after(() => rm(linked, { recursive: true, force: true }));
  await git(repo, ["worktree", "add", "-b", "feature/x", linked]);
  await commitFile(linked, "b.txt", "b\n", "on feature");

  const { getGitLog, resolveRepositoryRoot } = await loadSubject();
  const log = await getGitLog(await resolveRepositoryRoot(linked));
  assert.equal(log.branch, "feature/x");
  assert.deepEqual(log.commits.map((commit) => commit.subject), ["on feature", "on main"]);
  const mainLog = await getGitLog(repo);
  assert.deepEqual(mainLog.commits.map((commit) => commit.subject), ["on main"]);
});

test("an unborn branch and a non-repository have no history", async (t) => {
  const repo = await createRepository(t);
  const { getGitLog, resolveRepositoryRoot } = await loadSubject();
  const log = await getGitLog(repo);
  assert.deepEqual(log.commits, []);
  assert.equal(log.head, null);
  assert.equal(await resolveRepositoryRoot(os.tmpdir()), null);
});

test("lists a commit's files with renames, deletions, binaries and the root commit", async (t) => {
  const repo = await createRepository(t);
  const rootSha = await commitFile(repo, "src/old-name.ts", "export const value = 1;\nexport const other = 2;\nexport const third = 3;\n", "initial");
  await writeFile(path.join(repo, "gone.txt"), "bye\n");
  await writeFile(path.join(repo, "image.bin"), Buffer.from([0, 1, 2, 3]));
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "add more"]);
  await git(repo, ["mv", "src/old-name.ts", "src/new name.ts"]);
  await rm(path.join(repo, "gone.txt"));
  await writeFile(path.join(repo, "image.bin"), Buffer.from([0, 9, 9, 9]));
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "subject line", "-m", "Body text."]);
  const sha = await git(repo, ["rev-parse", "HEAD"]);

  const { getGitCommit } = await loadSubject();
  const result = await getGitCommit(repo, sha.slice(0, 10));
  assert.equal(result.commit.sha, sha);
  assert.equal(result.commit.subject, "subject line");
  assert.equal(result.commit.body, "Body text.");
  const byPath = Object.fromEntries(result.files.map((file) => [path.relative(repo, file.filePath), file]));
  assert.deepEqual(Object.keys(byPath).sort(), ["gone.txt", "image.bin", path.join("src", "new name.ts")]);
  assert.equal(byPath[path.join("src", "new name.ts")].status, "renamed");
  assert.equal(byPath[path.join("src", "new name.ts")].oldFilePath, path.join(repo, "src", "old-name.ts"));
  assert.equal(byPath["gone.txt"].status, "deleted");
  assert.equal(byPath["gone.txt"].deletions, 1);
  assert.equal(byPath["image.bin"].additions, null);

  const root = await getGitCommit(repo, rootSha);
  assert.deepEqual(root.files.map((file) => [file.status, file.additions]), [["added", 3]]);
});

test("merge commits list what they changed against the first parent", async (t) => {
  const repo = await createRepository(t);
  await commitFile(repo, "base.txt", "base\n", "base");
  await git(repo, ["switch", "-c", "topic"]);
  await commitFile(repo, "topic.txt", "topic\n", "topic work");
  await git(repo, ["switch", "main"]);
  await commitFile(repo, "main.txt", "main\n", "main work");
  await git(repo, ["merge", "--no-ff", "-m", "merge topic", "topic"]);
  const merge = await git(repo, ["rev-parse", "HEAD"]);

  const { getGitCommit } = await loadSubject();
  const result = await getGitCommit(repo, merge);
  assert.equal(result.commit.parents.length, 2);
  assert.deepEqual(result.files.map((file) => path.relative(repo, file.filePath)), ["topic.txt"]);
});

test("returns one file's patch and refuses files the commit did not change", async (t) => {
  const repo = await createRepository(t);
  await commitFile(repo, "a.txt", "one\ntwo\n", "initial");
  await writeFile(path.join(repo, "b.txt"), "untouched\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "add b"]);
  const sha = await commitFile(repo, "a.txt", "one\nTWO\n", "change a");
  await git(repo, ["mv", "a.txt", "c.txt"]);
  await git(repo, ["commit", "-m", "rename a"]);
  const renameSha = await git(repo, ["rev-parse", "HEAD"]);

  const { getGitCommitFileDiff } = await loadSubject();
  const diff = await getGitCommitFileDiff(repo, sha, path.join(repo, "a.txt"));
  assert.equal(diff.supported, true);
  assert.equal(diff.status, "modified");
  assert.match(diff.patch, /^-two$/m);
  assert.match(diff.patch, /^\+TWO$/m);
  assert.doesNotMatch(diff.patch, /b\.txt/);

  assert.equal(await getGitCommitFileDiff(repo, sha, path.join(repo, "b.txt")), null);
  assert.equal(await getGitCommitFileDiff(repo, sha, "/etc/passwd"), null);
  assert.equal(await getGitCommitFileDiff(repo, "0".repeat(40), path.join(repo, "a.txt")), null);

  const rename = await getGitCommitFileDiff(repo, renameSha, path.join(repo, "c.txt"));
  assert.equal(rename.status, "renamed");
  assert.match(rename.patch, /rename from a\.txt/);
  assert.match(rename.patch, /rename to c\.txt/);
});

test("rejects revisions that are not commit ids", async () => {
  const { getGitCommit, isCommitId } = await loadSubject();
  assert.equal(isCommitId("HEAD"), false);
  assert.equal(isCommitId("--output=/tmp/x"), false);
  assert.equal(isCommitId("abc"), false);
  assert.equal(isCommitId("abcd1234"), true);
  assert.equal(await getGitCommit(os.tmpdir(), "--all"), null);
});

test("parses NUL-delimited log, name-status and numstat output", async () => {
  const { parseGitLog, parseNameStatus, parseNumstat } = await loadSubject();
  const sha = "a".repeat(40);
  assert.deepEqual(parseGitLog([sha, "", "Ann", "ann@example.invalid", "1700000000", "first", ""].join("\0")), [{
    sha,
    shortSha: "aaaaaaa",
    parents: [],
    authorName: "Ann",
    authorEmail: "ann@example.invalid",
    authoredAt: 1_700_000_000_000,
    subject: "first",
  }]);
  assert.deepEqual(parseNameStatus("M\0a.ts\0R087\0old.ts\0new.ts\0D\0gone\0"), [
    { code: "M", path: "a.ts" },
    { code: "R", path: "new.ts", oldPath: "old.ts" },
    { code: "D", path: "gone" },
  ]);
  assert.deepEqual([...parseNumstat(["1\t2\ta.ts", "-\t-\tbin", "3\t0\t", "old.ts", "new.ts", ""].join("\0")).entries()], [
    ["a.ts", { additions: 1, deletions: 2 }],
    ["bin", { additions: null, deletions: null }],
    ["new.ts", { additions: 3, deletions: 0 }],
  ]);
});
