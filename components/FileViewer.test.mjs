import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import ts from "typescript";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("the source view is the lazily loaded CodeMirror editor", () => {
  // Static highlighting is gone from the file viewer; chat code blocks keep it.
  assert.doesNotMatch(source, /react-syntax-highlighter/);
  assert.match(source, /const CodeEditor = dynamic\(\(\) => import\("\.\/CodeEditor"\), \{ ssr: false \}\);/);
  assert.match(source, /import type \{ CodeEditorHandle, SelectedLineRange \} from "\.\/CodeEditor";/);
  // Read-only until the Edit switch, and only for files the server marked editable.
  assert.match(source, /readOnly=\{!editing \|\| !canEdit\}/);
  assert.match(source, /const canEdit = data\?\.editable === true && !isDeletedDiff;/);
});

test("upstream HTML and CSV/TSV previews keep the editor hidden and the correct chunk controls", () => {
  const hasPreviewStart = source.indexOf("  const hasPreview = ");
  const hasPreviewStatement = source.slice(hasPreviewStart, source.indexOf(";\n", hasPreviewStart) + 1);
  const hasPreview = new Function("data", "isHtml", "isMarkdown", "isDelimitedTable", "HTML_PREVIEW_MAX_BYTES", `${hasPreviewStatement}\nreturn hasPreview;`);
  const cap = 10 * 1024 * 1024;
  const partial = { truncated: true, size: 900 * 1024 };
  assert.equal(hasPreview(partial, true, false, false, cap), true);
  assert.equal(hasPreview({ ...partial, size: cap + 1 }, true, false, false, cap), false);
  assert.equal(hasPreview(partial, false, true, false, cap), false);
  assert.equal(hasPreview(partial, false, false, true, cap), true);

  const start = source.indexOf("  const showDiff = ");
  const statements = source.slice(start, source.indexOf("  const canEdit = ", start));
  const modes = new Function("effectiveDisplayMode", "hasGitDiff", "isHtml", "isMarkdown", "isDelimitedTable", "data", `${statements}\nreturn { showSource, showLoadMore, showTablePreview };`);
  assert.deepEqual(modes("preview", false, false, false, true, partial), { showSource: false, showLoadMore: true, showTablePreview: true });
  assert.equal(modes("preview", false, true, false, false, partial).showLoadMore, false);
  assert.equal(modes("source", false, true, false, false, partial).showLoadMore, true);
  assert.match(source, /srcDoc=\{data\?\.truncated \? htmlFull\?\.text : content\}/);
  assert.match(source, /<DelimitedTable[\s\S]*scrollRef=\{contentRef\}/);
});

test("the editor stays mounted while a preview or diff is shown", () => {
  // Unmounting it would drop unsaved text and undo history.
  assert.match(source, /display: showSource \? "block" : "none"/);
  assert.match(source, /const previewSource = previewDraft \?\? data\?\.content \?\? "";/);
});

test("reads ask for the editable whole file; saves never carry a session reference", () => {
  assert.match(source, /getFileApiUrl\(filePath, "read", sourceSessionId, offset \? \{ offset \} : \{ edit: 1 \}\)/);
  assert.match(source, /fetch\(getFileApiUrl\(filePath, "save"\), \{/);
  assert.match(source, /body: JSON\.stringify\(\{ content, baseHash \}\)/);
});

test("a successful save refreshes the explorer's Git status", () => {
  const save = source.slice(source.indexOf("const save = useCallback("));
  assert.match(save, /handle\.markSaved\(content\);\s*recordDraft\(\);\s*onFileSaved\?\.\(\);/);
});

test("a save holds live synchronization until its response lands", () => {
  const synchronize = source.slice(source.indexOf("const synchronize = useCallback("));
  assert.match(synchronize, /if \(savingRef\.current\) \{\s*pendingSyncRef\.current = true;\s*return;/);
  const save = source.slice(source.indexOf("const save = useCallback("));
  assert.match(save, /contentRequestRef\.current\+\+;/);
  assert.match(save, /if \(pendingSyncRef\.current\) \{\s*pendingSyncRef\.current = false;\s*synchronize\(\);/);
});

test("a change on disk under unsaved edits becomes a conflict, never a silent reload", () => {
  const apply = source.slice(source.indexOf("const applyDiskVersion = useCallback("));
  assert.match(apply, /if \(next\.hash && next\.hash === baseHashRef\.current\) return;\s*if \(dirtyRef\.current\) \{\s*setDiskConflict\(\{ kind: "changed", disk: next \}\);/);
});

test("only editable file tabs own drafts, not special read-only tabs for the same path", async () => {
  const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const tabs = await readFile(new URL("./TabBar.tsx", import.meta.url), "utf8");
  assert.match(shell, /if \(closingTab && !closingTab\.kind && getFileEditDraft\(closingTab\.filePath\)\)/);
  assert.match(tabs, /const isDirty = !tab\.kind && dirtyPaths\.has\(tab\.filePath\);/);
});

test("markdown preview keeps app links and opens web and app links in a new tab (#1108)", () => {
  assert.match(source, /urlTransform=\{onOpenFile \? markdownUrlTransform : markdownAppUrlTransform\}/);
  assert.match(
    source,
    /return isExternalMarkdownHref\(href\)\s*\? <a href=\{href\} \{\.\.\.props\} target="_blank" rel="noopener noreferrer">\{children\}<\/a>\s*: <a href=\{href\} \{\.\.\.props\}>\{children\}<\/a>;/,
  );
});

test("markdown preview links carry PDF page fragments", () => {
  assert.match(source, /parsePdfPageFragment/);
  assert.match(source, /onOpenFile\(linkedFile, parsePdfPageFragment\(href\) \?\? undefined\)/);
});

test("the Diff view's line-number gutter is pinned only in diffs of at most PINNED_GUTTER_MAX_ROWS rows", () => {
  // Upstream's test also covers its Prism source view; this fork shows source
  // in CodeMirror, whose gutter stays put by itself. Evaluate the module's own
  // style constants and the Diff view's rows instead of matching its text.
  const file = ts.createSourceFile("FileViewer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const constants = (...names) => {
    const statements = names.map((name) => {
      const statement = file.statements.find((node) =>
        ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
          ts.isIdentifier(declaration.name) && declaration.name.text === name,
        ),
      );
      assert.ok(statement, `${name} is declared in the module`);
      return statement.getText(file);
    });
    const { outputText } = ts.transpileModule(`${statements.join("\n")}\nreturn [${names.join(", ")}];`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
    return new Function(outputText)();
  };
  const [codeStyle, gutterStyle, maxRows, pinnedStyle] = constants("FILE_CODE_STYLE", "FILE_LINE_NUMBER_STYLE", "PINNED_GUTTER_MAX_ROWS", "FILE_PINNED_LINE_NUMBER_STYLE");

  const diffView = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "DiffView");
  const { outputText: diffOutput } = ts.transpileModule(`return ${diffView.getText(file)}`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } });
  const diffNumberStyle = (rowCount) => {
    const added = Array.from({ length: rowCount }, (_, index) => ({ type: "added", text: "line", oldLineNo: null, newLineNo: index + 1 }));
    const DiffView = new Function("React", "useI18n", "diffLines", "PINNED_GUTTER_MAX_ROWS", "FILE_CODE_STYLE", "FILE_LINE_NUMBER_STYLE", "FILE_PINNED_LINE_NUMBER_STYLE", diffOutput)(
      React, () => ({ t: (key) => key }), () => added, maxRows, codeStyle, gutterStyle, pinnedStyle,
    );
    return DiffView({ patch: "" }).props.children[0].props.children[0].props.children[0].props.style;
  };

  for (const [key, value] of Object.entries(gutterStyle)) assert.equal(pinnedStyle[key], value, key);
  assert.equal(pinnedStyle.position, "sticky");
  assert.equal(pinnedStyle.left, 0);
  assert.ok(pinnedStyle.zIndex >= 1, "the pinned gutter must stack above the scrolling text");
  assert.equal(diffNumberStyle(maxRows), pinnedStyle);
  assert.equal(diffNumberStyle(maxRows + 1), gutterStyle);
  assert.equal(gutterStyle.position, undefined);
  // The gutter repeats the code line's height in px.
  assert.equal(parseFloat(gutterStyle.lineHeight), Number((codeStyle.fontSize * codeStyle.lineHeight).toFixed(1)));
});
