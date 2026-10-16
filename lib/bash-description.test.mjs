import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { bashDescription } = await createJiti(import.meta.url).import("./bash-description.ts");

test("descriptions are display-only strings with terminal/bidi controls removed and whitespace folded", () => {
  const input = { description: "\x1b[31mInspect\x1b[0m\n\u202e files\t now\u200b" };
  assert.equal(bashDescription(input), "Inspect files now");
  assert.equal(input.description, "\x1b[31mInspect\x1b[0m\n\u202e files\t now\u200b");
  assert.equal(bashDescription({ description: "Inspect \x1b]0;window title\x07files" }), "Inspect files");
  assert.equal(bashDescription({ description: "Inspect \x1b]8;;https://untrusted.invalid\x1b\\files\x1b]8;;\x1b\\" }), "Inspect files");
  assert.equal(bashDescription({ description: "Inspect \x1bPignored control string\x1b\\files" }), "Inspect files");
  assert.equal(bashDescription({ description: "Inspect\x1b]0;unfinished" }), "Inspect");
  assert.equal(bashDescription({ description: "Inspect \x9b31mfiles" }), "Inspect files");
  assert.equal(bashDescription({ description: "**Inspect** <files> & folders" }), "**Inspect** <files> & folders");
});

test("missing, malformed and blank descriptions do not invent explanations", () => {
  for (const input of [null, undefined, [], {}, "text", { description: 12 }, { description: {} }, { description: "\u202e\x1b[31m \n" }]) {
    assert.equal(bashDescription(input), "");
  }
});
