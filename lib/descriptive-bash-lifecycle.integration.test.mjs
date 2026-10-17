import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { AgentSessionWrapper, startRpcSession } = await jiti.import("./rpc-manager.ts");
const { PROJECT_COMMAND_EXTENSION_PATH } = await jiti.import("./project-command-env.ts");

const globalBash = (version) => `export default function (pi) {
  const tool = { name: "bash", label: "global Bash ${version}", description: "Global Bash ${version}",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    execute: async () => { throw new Error("Global Bash ${version} must not execute in Pi Web"); } };
  pi.registerTool(tool);
  pi.on("session_start", () => pi.registerTool(tool));
}`;

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-bash-lifecycle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir; });
  const faux = fauxProvider({ models: [{ id: "descriptive-bash" }] });
  // Reopened RPC sessions construct their own runtime; never contact a real provider.
  const originalCreate = ModelRuntime.create;
  ModelRuntime.create = async (...args) => {
    const runtime = await originalCreate.apply(ModelRuntime, args);
    runtime.registerNativeProvider(faux.provider);
    return runtime;
  };
  t.after(() => { ModelRuntime.create = originalCreate; });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const services = await createAgentSessionServices({ cwd: dir, agentDir: dir, modelRuntime, settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true } });
  const { session: parent } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(dir, join(dir, "sessions")), model: faux.getModel("descriptive-bash") });
  t.after(() => parent.dispose());
  // Persist a normal session to exercise its actual RPC start/reopen path.
  faux.setResponses([fauxAssistantMessage([fauxText("ready")])]);
  await parent.prompt("Prepare the synthetic lifecycle test");
  await mkdir(join(dir, "extensions"), { recursive: true });
  const globalBashPath = join(dir, "extensions", "changing-global-bash.ts");
  await writeFile(globalBashPath, globalBash("initial"));
  return { dir, faux, parent, globalBashPath };
}

function respondWithBash(faux, marker) {
  const input = { description: "Print a fixed synthetic lifecycle marker", command: `printf ${marker}` };
  faux.setResponses([
    (context) => {
      const declared = getCurrentTools(context.messages).find((tool) => tool.name === "bash");
      assert.ok(declared?.parameters.required.includes("description"), "the provider request requires description");
      return fauxAssistantMessage([fauxToolCall("bash", input)], { stopReason: "toolUse" });
    },
    fauxAssistantMessage([fauxText("completed")]),
  ]);
  return input;
}

function assertBash(wrapper, input, marker) {
  const definition = wrapper.inner.getToolDefinition("bash");
  assert.ok(definition.parameters.required.includes("description"));
  assert.ok(wrapper.inner.getActiveToolNames().includes("bash"));
  assert.equal(wrapper.inner.getAllTools().find((tool) => tool.name === "bash").sourceInfo.path, PROJECT_COMMAND_EXTENSION_PATH);
  const messages = wrapper.inner.messages;
  const call = messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).findLast((block) => block.type === "toolCall" && block.name === "bash");
  assert.deepEqual(call.arguments, input);
  const result = messages.findLast((message) => message.role === "toolResult");
  assert.equal(result.isError, false);
  assert.equal(result.content[0].text, marker);
}

test("normal RPC startup, reload and reopen ignore changing discovered global Bash replacements", async (t) => {
  const { faux, parent, globalBashPath } = await setup(t);
  const id = parent.sessionId, file = parent.sessionFile;
  parent.dispose();
  let wrapper;
  t.after(async () => { if (wrapper?.isAlive()) await wrapper.shutdown(); });
  for (const stage of ["startup", "reload", "reopen"]) {
    await writeFile(globalBashPath, globalBash(stage));
    if (stage !== "reload") {
      if (wrapper) await wrapper.shutdown();
      wrapper = (await startRpcSession(id, file)).session;
      await wrapper.waitUntilReady();
    } else {
      await wrapper.send({ type: "reload" });
    }
    const input = respondWithBash(faux, stage);
    await wrapper.inner.prompt("Print the synthetic marker");
    assertBash(wrapper, input, stage);
  }
  // Code mode reaches the same schema/executor, not a second description-less Bash.
  wrapper.inner.setActiveToolsByName(["bash", "codemode"]);
  let codeDeclaration;
  faux.setResponses([
    (context) => {
      codeDeclaration = getCurrentTools(context.messages).find((tool) => tool.name === "codemode");
      return fauxAssistantMessage([fauxToolCall("codemode", {
        code: `const result = await tools.bash({ description: "Print a nested synthetic marker", command: "printf nested" });
let missingDescription;
try { await tools.bash({ command: "printf forbidden" }); } catch (error) { missingDescription = String(error); }
return JSON.stringify({ result, missingDescription, declaration: await describeTool("bash") });`,
      })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage([fauxText("completed")]),
  ]);
  await wrapper.inner.prompt("Check nested Bash calls");
  assert.equal(wrapper.inner.messages.at(-1).errorMessage, undefined);
  assert.ok(codeDeclaration, "model receives Code mode");
  const nested = wrapper.inner.messages.findLast((message) => message.role === "toolResult");
  assert.equal(nested.isError, false);
  const output = JSON.parse(nested.content.find((block) => block.type === "text" && block.text.startsWith("{")).text);
  assert.equal(output.result.output, "nested");
  assert.match(output.missingDescription, /description: must have required properties description/);
  assert.match(output.declaration, /description: string/);
  assert.deepEqual(nested.details.calls.map((call) => call.status), ["ok", "error"]);
});

for (const loadExtensions of [false, true]) {
  test(`child with extensions ${loadExtensions ? "on" : "off"} keeps Pi Web Bash through spawn, reload, resume and RPC reopen`, async (t) => {
    const { dir, faux, parent, globalBashPath } = await setup(t);
    await mkdir(join(dir, "agents"));
    await writeFile(join(dir, "agents", "shell.md"), `---\ndescription: Synthetic shell profile\ntools: bash\nload_extensions: ${loadExtensions}\nload_skills: false\n---\nRun the delegated shell command.\n`);
    let child;
    const wrappers = new Map();
    const controller = createSubagentController({
      getSession: (id) => id === parent.sessionId
        ? { inner: parent, cwd: dir, sessionFile: parent.sessionFile, isAlive: () => true, isRunning: () => false }
        : wrappers.get(id),
      registerSession(inner, options) {
        child = new AgentSessionWrapper(inner, options);
        child.start(); child.beginExtensionBinding(); wrappers.set(inner.sessionId, child);
      },
      reopenSession: async () => { throw new Error("unused"); }, resolveSessionPath: async () => child.sessionFile,
      invalidateSessionList() {}, isBuiltInSubagentsEnabled: () => true,
    });
    t.after(async () => { if (child?.isAlive()) await child.shutdown(); });
    let input = respondWithBash(faux, "spawn");
    const execution = await controller.extensionRuntime.start({ parentContext: parent, parentToolCallId: "synthetic-start", profile: "shell", task: "Print a synthetic marker", description: "Synthetic lifecycle" });
    assert.equal((await execution.completion).status, "completed");
    assertBash(child, input, "spawn");
    await writeFile(globalBashPath, globalBash("reload"));
    await child.send({ type: "reload" });
    input = respondWithBash(faux, "resume");
    const resumed = await controller.extensionRuntime.resume({ parentContext: parent, parentToolCallId: "synthetic-resume", sessionId: child.inner.sessionId, task: "Print another synthetic marker", description: "Synthetic resume" });
    assert.equal((await resumed.completion).status, "completed");
    assertBash(child, input, "resume");
    const id = child.inner.sessionId, file = child.sessionFile;
    await child.shutdown();
    await writeFile(globalBashPath, globalBash("reopen"));
    child = (await startRpcSession(id, file)).session;
    await child.waitUntilReady();
    input = respondWithBash(faux, "reopen");
    await child.inner.prompt("Print the last synthetic marker");
    assertBash(child, input, "reopen");
  });
}
