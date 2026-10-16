import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { CodemodeCallList } = await jiti.import("./CodemodeToolView.tsx");

function render(args, name = "bash") {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(CodemodeCallList, {
    calls: [{ id: "nested-bash", name, args, status: "running" }], omitted: 0, isError: false,
  })));
}

test("nested Bash descriptions are readable while the original compact arguments stay inspectable", () => {
  const html = render(JSON.stringify({ description: "\u202eInspect <files>\nnow", command: "rg -n relevant components/" }));
  assert.match(html, /title="Inspect &lt;files&gt; now"/);
  assert.match(html, /rg -n relevant components\//);
});

test("truncated, malformed and legacy nested Bash args retain their existing view", () => {
  for (const args of ['{"description":"unfinished', '{"command":"printf legacy"}', 'null', '[1]', '{"description":3}', '']) {
    assert.doesNotThrow(() => render(args));
  }
  assert.match(render('{"command":"printf legacy"}'), /printf legacy/);
  assert.match(render('{"description":"partial'), /partial/);
});
