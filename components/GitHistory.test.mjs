import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./GitHistory.tsx", import.meta.url), "utf8");

test("an expanded commit shows its full message without relying on hover", () => {
  // The subject wraps instead of ellipsizing once the commit is expanded.
  assert.match(source, /style=\{isExpanded\s*\? \{[^}]*whiteSpace: "normal"/);
  assert.match(source, /<CommitMessage commit=\{detail\.data\.commit\} \/>/);
  // The body is clamped, with a toggle only when lines are hidden.
  assert.match(source, /WebkitLineClamp: BODY_CLAMP_LINES/);
  assert.match(source, /element\.scrollHeight > element\.clientHeight \+ 1/);
  assert.match(source, /\(overflowing \|\| showAll\) &&/);
  assert.match(source, /t\(showAll \? "gitHistory\.showLess" : "gitHistory\.showMore"\)/);
  // Exact metadata and a tap target to copy the full hash.
  assert.match(source, /copyText\(commit\.sha\)/);
  assert.match(source, /new Date\(commit\.authoredAt\)\.toLocaleString\(locale\)/);
});

test("commit details are fetched once per commit and dropped on a cwd change", () => {
  assert.match(source, /if \(existing && existing\.state !== "error"\) return;/);
  assert.match(source, /if \(cwdRef\.current !== requestCwd\) return;/);
});
