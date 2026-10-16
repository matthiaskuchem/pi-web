import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolArguments, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, SettingsManager, ModelRuntime, SessionManager, createAgentSession, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createProjectCommandBashExtension, preferUserBashExtension, composeDescriptiveBash } = await jiti.import("./project-command-env.ts");
const { subagentExtensionLoaderOptions } = await jiti.import("./subagents.ts");
const fixture = fileURLToPath(new URL("./__fixtures__/descriptive-bash/bash-description.ts", import.meta.url));
const text = (result) => result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");

async function setup(t, { child = false, defaultTools, compose = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-descriptive-bash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = SettingsManager.inMemory({ ...(defaultTools ? { defaultTools } : {}) });
  const options = { cwd: dir, settings };
  let original;
  const childOptions = subagentExtensionLoaderOptions({ loadExtensions: true }, options);
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: settings,
    ...(child ? childOptions : {}),
    // Explicit fixture only: never discover shared/global resources.
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fixture],
    extensionFactories: child || !compose ? [] : [createProjectCommandBashExtension(options)],
    extensionsOverride(base) {
      original = base.extensions.find((extension) => extension.path === fixture).tools.get("bash").definition;
      return !compose ? base : child ? childOptions.extensionsOverride(base) : preferUserBashExtension(base);
    },
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const definitions = loaded.extensions.flatMap((extension) => extension.tools.has("bash") ? [extension.tools.get("bash").definition] : []);
  assert.equal(definitions.length, 1);
  const tool = definitions[0];
  const context = {
    cwd: dir, model: undefined, thinkingLevel: "off",
    sessionManager: { getSessionId: () => "synthetic-session", getSessionFile: () => undefined },
  };
  const execute = (args, signal, onUpdate) => tool.execute("synthetic-call", args, signal, onUpdate, context);
  return { dir, settings, options, loader, original, tool, execute, context };
}

for (const child of [false, true]) {
  test(`${child ? "child" : "normal"} composition keeps the contract and protected execution through reload`, async (t) => {
    const setupResult = await setup(t, { child });
    const { original, tool, execute, loader, settings, context, dir } = setupResult;
    for (const key of ["parameters", "description", "promptGuidelines", "outputSchema", "constrainedSampling", "renderCall", "renderResult", "defaultActive"]) {
      assert.equal(tool[key], original[key], key);
    }
    assert.notEqual(tool.execute, original.execute);
    assert.equal(tool.defaultActive, false);
    assert.ok(tool.parameters.required.includes("description"));
    assert.ok(tool.parameters.required.includes("command"));

    const saved = {};
    const environment = { PORT: "30142", NODE_ENV: "production", NEXT_RUNTIME: "synthetic", PI_WEB_PASSWORD: "synthetic-password" };
    for (const [key, value] of Object.entries(environment)) { saved[key] = process.env[key]; process.env[key] = value; }
    t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
    const result = await execute({ description: "Inspect the synthetic shell environment", command: `node -e 'console.log(JSON.stringify({cwd:process.cwd(),port:process.env.PORT,mode:process.env.NODE_ENV,next:process.env.NEXT_RUNTIME,password:process.env.PI_WEB_PASSWORD,path:process.env.PATH,session:process.env.PI_SESSION_ID}))'` });
    const environmentResult = JSON.parse(text(result));
    assert.equal(environmentResult.cwd, dir);
    for (const key of ["port", "mode", "next", "password"]) assert.equal(environmentResult[key], undefined);
    assert.ok(environmentResult.path.split(delimiter).includes(join(getAgentDir(), "bin")));
    assert.equal(environmentResult.session, "synthetic-session");

    // Descriptions remain inert, and current shell settings still apply per call.
    settings.setShellCommandPrefix("export SYNTHETIC_PREFIX=first");
    assert.equal(text(await execute({ description: "$(exit 99); inert description", command: "printf %s \"$SYNTHETIC_PREFIX\"" })), "first");
    settings.setShellCommandPrefix("export SYNTHETIC_PREFIX=second");
    assert.equal(text(await execute({ description: "Read the updated synthetic prefix", command: "printf %s \"$SYNTHETIC_PREFIX\"" })), "second");
    // Settings remain in-memory; nothing is saved to shared settings.json.
    await loader.reload();
    const reloaded = loader.getExtensions().extensions.find((extension) => extension.path === fixture).tools.get("bash").definition;
    assert.notEqual(reloaded.execute, original.execute);
    assert.equal(text(await reloaded.execute("reload", { description: "Print a fixed reload marker", command: "printf reloaded" }, undefined, undefined, context)), "reloaded");
    assert.notEqual(tool.execute, original.execute); // cached original was not mutated
  });
}

test("required descriptions reject legacy, malformed and control-only executable calls", async (t) => {
  const { tool, execute } = await setup(t);
  for (const description of [undefined, "", "  "]) {
    assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "invalid", name: "bash", arguments: { command: "printf forbidden", ...(description === undefined ? {} : { description }) } }));
  }
  for (const description of [undefined, "", " \t", "\x1b[31m\x1b[0m", "\u202e\u200b", 12]) {
    await assert.rejects(execute({ description, command: "printf forbidden" }), /nonblank, human-readable description/);
  }
});

test("combined Bash preserves streaming, errors, cancellation and seconds-based timeout", { timeout: 15_000 }, async (t) => {
  const { execute } = await setup(t);
  let streamed = "";
  assert.equal(text(await execute({ description: "Print a fixed streaming marker", command: "printf streamed" }, undefined, (result) => { streamed += text(result); })), "streamed");
  assert.ok(streamed.includes("streamed"));
  const failure = await execute({ description: "Return a synthetic failure", command: "printf failed; exit 7" });
  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent.exit_code, 7);
  assert.match(text(failure), /failed[\s\S]*code 7/);
  const controller = new AbortController();
  const running = execute({ description: "Wait until this synthetic command is cancelled", command: "node -e 'console.log(\"started\");setInterval(()=>{},1000)'" }, controller.signal, () => controller.abort());
  await assert.rejects(running, /Command aborted/);
  await assert.rejects(execute({ description: "Check a fractional-second timeout", command: "node -e 'setInterval(()=>{},1000)'", timeout: 0.1 }), /Command timed out after 0.1 seconds/);
});

test("combined Bash retains truncation details and structured output", async (t) => {
  const { execute } = await setup(t);
  const result = await execute({ description: "Generate synthetic output to check truncation", command: "node -e 'for(let i=0;i<2100;i++)console.log(\"line \"+i)'" });
  assert.equal(result.details.truncation.truncated, true);
  assert.equal(result.structuredContent.exit_code, 0);
  assert.match(result.structuredContent.output, /^line 0\n/);
  assert.match(result.structuredContent.output, /line 2099\n$/);
  assert.match(text(result), /Showing lines/);
  assert.ok(result.details.fullOutputPath);
  t.after(() => rm(result.details.fullOutputPath, { force: true }));
});

test("CLI-style loading leaves the original executor untouched", async (t) => {
  const { original, tool } = await setup(t, { compose: false });
  assert.equal(tool.execute, original.execute);
});

test("unreviewed descriptive Bash revisions fail closed; unrelated replacements stay untouched", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-bash-revision-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "bash-description.ts");
  await writeFile(path, "// changed extension; must be reviewed again\n");
  const definition = { execute: () => { throw new Error("must not run"); } };
  const extension = { path, tools: new Map([["bash", { definition }]]) };
  const options = { cwd: dir, settings: { getShellPath() {}, getShellCommandPrefix() {} } };
  assert.throws(() => composeDescriptiveBash({ extensions: [extension] }, options), /cannot compose/);
  const unrelated = { ...extension, path: join(dir, "ssh-bash.ts") };
  assert.equal(composeDescriptiveBash({ extensions: [unrelated] }, options).extensions[0], unrelated);
  // Scope first: a child that excludes this extension must not compose or reject it.
  const scoped = subagentExtensionLoaderOptions({ loadExtensions: true, extensions: [] }, options);
  const base = { extensions: [extension], runtime: { pendingProviderRegistrations: [], pendingNativeProviderRegistrations: [], pendingVirtualModelRegistrations: [] } };
  assert.deepEqual(scoped.extensionsOverride(base).extensions, []);
});

test("real in-memory sessions keep Bash inactive when excluded and retain description in history", async (t) => {
  const { dir, settings, loader } = await setup(t, { defaultTools: ["read"] });
  const faux = fauxProvider({ models: [{ id: "synthetic-bash" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel("synthetic-bash"), settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir) });
  t.after(() => session.dispose());
  assert.ok(!session.getActiveToolNames().includes("bash"));
  await session.reload();
  assert.ok(!session.getActiveToolNames().includes("bash"));
  session.setActiveToolsByName(["bash"]);
  const input = { description: "Print a fixed in-memory history marker", command: "printf history-marker" };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", input)], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  await session.prompt("Run the synthetic tool");
  const messages = session.messages;
  const call = messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).find((block) => block.type === "toolCall");
  assert.deepEqual(call.arguments, input);
  const result = messages.find((message) => message.role === "toolResult");
  assert.equal(result.isError, false);
  assert.equal(text(result), "history-marker");
});
