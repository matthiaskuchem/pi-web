import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { validateToolArguments, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, SettingsManager, ModelRuntime, SessionManager, createAgentSession, createBashToolDefinition, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createProjectCommandBashExtension, preferProjectCommandBashExtension, PROJECT_COMMAND_EXTENSION_PATH } = await jiti.import("./project-command-env.ts");
const { subagentExtensionLoaderOptions, subagentToolOptions } = await jiti.import("./subagents.ts");
const text = (result) => result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");

async function setup(t, { child = false, defaultTools, loadExtensions = false, extensions, replacement } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-descriptive-bash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = SettingsManager.inMemory({ ...(defaultTools ? { defaultTools } : {}) });
  const options = { cwd: dir, settings };
  const childOptions = subagentExtensionLoaderOptions({ loadExtensions, extensions }, options);
  const path = join(dir, "bash-description.ts");
  if (replacement) await writeFile(path, replacement);
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: settings,
    // Synthetic resources only: never discover shared/global extensions or settings.
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    ...(child ? childOptions : {
      extensionFactories: [createProjectCommandBashExtension(options)],
      extensionsOverride: preferProjectCommandBashExtension,
    }),
    ...(replacement ? { additionalExtensionPaths: [path] } : {}),
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
  return { dir, settings, options, loader, tool, execute, context };
}

for (const child of [false, true]) {
  test(`${child ? "child without external extensions" : "normal session"} has descriptive protected Bash automatically, including reload`, async (t) => {
    const { tool, execute, loader, settings, context, dir } = await setup(t, { child });
    const original = createBashToolDefinition(dir);
    for (const key of ["outputSchema", "constrainedSampling"]) assert.deepEqual(tool[key], original[key], key);
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");
    assert.equal(tool.defaultActive, false);
    assert.equal(tool.prepareArguments, undefined);
    assert.deepEqual(tool.parameters.required, ["description", "command"]);
    assert.deepEqual(tool.parameters.properties.command, original.parameters.properties.command);
    assert.deepEqual(tool.parameters.properties.timeout, original.parameters.properties.timeout);
    assert.match(tool.description, /For every bash call, provide a description/);
    assert.ok(tool.promptGuidelines.some((line) => line.includes("consequential")));

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
    await loader.reload();
    const reloaded = loader.getExtensions().extensions.find((extension) => extension.path === PROJECT_COMMAND_EXTENSION_PATH).tools.get("bash").definition;
    assert.deepEqual(reloaded.parameters.required, ["description", "command"]);
    assert.equal(text(await reloaded.execute("reload", { description: "Print a fixed reload marker", command: "printf reloaded" }, undefined, undefined, context)), "reloaded");
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

test("a plain CLI-style SDK loader still has the original Bash schema and executor", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cli-bash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().extensions, []);
  const original = createBashToolDefinition(dir);
  assert.equal(original.parameters.properties.description, undefined);
  assert.deepEqual(original.parameters.required, ["command"]);
  assert.equal(text(await original.execute("cli", { command: "printf cli-unchanged" })), "cli-unchanged");
});

const replacement = `export default function (pi) {
  const bash = { name: "bash", label: "external Bash", description: "explicit replacement",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    execute: async () => { throw new Error("External Bash must never execute in Pi Web"); } };
  pi.registerTool(bash);
  pi.on("session_start", () => pi.registerTool(bash));
  pi.registerTool({ ...bash, name: "external_helper", description: "external helper",
    execute: async () => ({ content: [{ type: "text", text: "external helper retained" }] }) });
}`;
for (const child of [false, true]) {
  test(`${child ? "child" : "normal"} keeps Pi Web Bash despite an external replacement and its reload`, async (t) => {
    const { tool, execute, loader } = await setup(t, { child, loadExtensions: true, replacement });
    assert.ok(tool.parameters.required.includes("description"));
    assert.equal(text(await execute({ description: "Print a host ownership marker", command: "printf host-owned" })), "host-owned");
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions[0].path, PROJECT_COMMAND_EXTENSION_PATH);
    assert.ok(loaded.extensions[0].tools.get("bash").definition.parameters.required.includes("description"));
    const helper = loaded.extensions.flatMap((extension) => [...extension.tools.values()]).find((tool) => tool.definition.name === "external_helper");
    assert.equal(text(await helper.definition.execute("helper", {})), "external helper retained");
  });
}

test("a CLI-style loader still follows independently changed global Bash extensions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cli-global-bash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "global-bash.ts");
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [path], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  for (const version of ["first", "changed"]) {
    await writeFile(path, `export default function (pi) {
      pi.registerTool({ name: "bash", label: "global Bash", description: "${version}",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        execute: async () => ({ content: [{ type: "text", text: "${version}" }] }) });
    }`);
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const tool = loader.getExtensions().extensions[0].tools.get("bash").definition;
    assert.equal(tool.parameters.properties.description, undefined);
    assert.equal(text(await tool.execute("cli", { command: "not executed locally" })), version);
  }
});

test("child scope drops an excluded external Bash owner before selecting the host tool", async (t) => {
  const { tool, execute } = await setup(t, { child: true, loadExtensions: true, extensions: [], replacement });
  assert.ok(tool.parameters.required.includes("description"));
  assert.equal(text(await execute({ description: "Print a scoped child marker", command: "printf scoped" })), "scoped");
});

for (const [child, external] of [[false, false], [false, true], [true, false], [true, true]]) {
  test(`${child ? "child" : "normal"} model request uses Pi Web Bash ${external ? "despite a late external replacement" : "without an external extension"}; history retains it`, async (t) => {
    const { dir, settings, loader } = await setup(t, { child, defaultTools: ["read"], loadExtensions: external, ...(external ? { replacement } : {}) });
    const faux = fauxProvider({ models: [{ id: "synthetic-bash" }] });
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel("synthetic-bash"), settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir),
      ...(child ? subagentToolOptions({ tools: ["read", "bash"] }) : {}) });
    t.after(() => session.dispose());
    await session.bindExtensions({ onError: (error) => assert.fail(`Synthetic extension failed: ${error.message}`) });
    if (!child) {
      assert.ok(!session.getActiveToolNames().includes("bash"));
      await session.reload();
      assert.ok(!session.getActiveToolNames().includes("bash"));
      session.setActiveToolsByName(["bash"]);
    }
    const input = { description: "Print a fixed in-memory history marker", command: "printf history-marker" };
    faux.setResponses([
      (context) => {
        const declared = getCurrentTools(context.messages).find((tool) => tool.name === "bash");
        assert.ok(declared, "model receives Bash declaration");
        assert.ok(declared.parameters.required.includes("description"), "model receives required description field");
        assert.match(getCurrentSystemPrompt(context.messages), /For every bash call, provide a description/);
        return fauxAssistantMessage([fauxToolCall("bash", input)], { stopReason: "toolUse" });
      },
      fauxAssistantMessage([fauxText("done")]),
    ]);
    await session.prompt("Run the synthetic tool");
    assert.equal(session.getAllTools().find((tool) => tool.name === "bash").sourceInfo.path, PROJECT_COMMAND_EXTENSION_PATH);
    if (external) {
      assert.ok(loader.getExtensions().extensions.find((extension) => extension.path !== PROJECT_COMMAND_EXTENSION_PATH).tools.has("bash"), "external session_start attempted to re-register Bash");
      assert.equal(session.getAllTools().some((tool) => tool.name === "external_helper"), !child, "the child's tool allowlist still applies");
    }
    const messages = session.messages;
    const call = messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).find((block) => block.type === "toolCall");
    assert.deepEqual(call.arguments, input);
    const result = messages.find((message) => message.role === "toolResult");
    assert.equal(result.isError, false);
    assert.equal(text(result), "history-marker");
  });
}
