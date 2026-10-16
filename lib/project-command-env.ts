import {
  createBashToolDefinition,
  createLocalBashOperations,
  getAgentDir,
  type BashOperations,
  type InlineExtension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

const HOST_EXTENSION_NAME = "pi-web-project-command-environment";
const HOST_EXTENSION_PATH = `<inline:${HOST_EXTENSION_NAME}>`;
// Pi's own abort path settles well within this once the process tree is gone.
const ABORT_SETTLE_GRACE_MS = 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type ProjectShellSettings = {
  getShellCommandPrefix(): string | undefined;
  getShellPath(): string | undefined;
};

type ProjectCommandBashOperationsOptions = {
  abortSettleGraceMs?: number;
  agentBinDir?: string;
  baseEnvironment?: NodeJS.ProcessEnv;
  localOperations?: BashOperations;
  platform?: NodeJS.Platform;
  shellPath?: string;
};

type BashExecResult = Awaited<ReturnType<BashOperations["exec"]>>;

function isHostRuntimeVariable(name: string, platform: NodeJS.Platform): boolean {
  const comparableName = platform === "win32" ? name.toUpperCase() : name;
  return comparableName === "PORT"
    || comparableName === "NODE_ENV"
    || comparableName.startsWith("NEXT_")
    // The browser login password guards this server; commands run on behalf of
    // a project (and the model reading their output) have no use for it.
    || comparableName === "PI_WEB_PASSWORD";
}

export function sanitizeProjectCommandEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  for (const name of Object.keys(environment)) {
    if (isHostRuntimeVariable(name, platform)) delete environment[name];
  }
  return environment;
}

function withAgentBinDirectory(
  environment: NodeJS.ProcessEnv,
  agentBinDir: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const pathKey = platform === "win32"
    ? Object.keys(environment).find((name) => name.toUpperCase() === "PATH") ?? "PATH"
    : "PATH";
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const currentPath = environment[pathKey] ?? "";
  const pathEntries = currentPath.split(pathDelimiter).filter(Boolean);
  if (!pathEntries.includes(agentBinDir)) {
    environment[pathKey] = [agentBinDir, currentPath].filter(Boolean).join(pathDelimiter);
  }
  return environment;
}

export function createProjectCommandBashOperations(
  options: ProjectCommandBashOperationsOptions = {},
): BashOperations {
  const {
    abortSettleGraceMs = ABORT_SETTLE_GRACE_MS,
    agentBinDir = join(getAgentDir(), "bin"),
    baseEnvironment = process.env,
    localOperations = createLocalBashOperations({ shellPath: options.shellPath }),
    platform = process.platform,
  } = options;

  return {
    exec(command, cwd, executionOptions) {
      const environment = withAgentBinDirectory(
        sanitizeProjectCommandEnvironment(executionOptions.env ?? baseEnvironment, platform),
        agentBinDir,
        platform,
      );
      const { onData, signal, timeout } = executionOptions;
      let released = false;
      const execution = localOperations.exec(command, cwd, {
        ...executionOptions,
        env: environment,
        // Callers finalize their output once the command is released; a
        // survivor must not append to it afterwards.
        onData: (data) => {
          if (!released) onData(data);
        },
      });
      // Pi rejects any other timeout before it starts the command.
      const timeoutMs = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
        ? timeout * 1000
        : undefined;
      if (!signal && timeoutMs === undefined) return execution;

      // On Stop or a timeout, pi kills the shell's process tree but then keeps
      // reading until every inherited stdout/stderr handle falls idle. A
      // descendant the kill cannot reach (its own session on POSIX, an orphan
      // `taskkill /T` misses on Windows) can keep writing and hold the tool
      // call, and with it Stop and any steering, until the script ends on its
      // own (#647). The errors are pi's own, so the bash tool reports them as
      // "Command aborted" and "Command timed out".
      return new Promise<BashExecResult>((resolve, reject) => {
        const timers: ReturnType<typeof setTimeout>[] = [];
        const release = () => {
          released = true;
          for (const timer of timers) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const releaseAfter = (delayMs: number, error: Error) => {
          timers.push(setTimeout(() => {
            release();
            reject(error);
          }, Math.min(delayMs, MAX_TIMER_DELAY_MS)));
        };
        const onAbort = () => releaseAfter(abortSettleGraceMs, new Error("aborted"));
        if (timeoutMs !== undefined) {
          releaseAfter(timeoutMs + abortSettleGraceMs, new Error(`timeout:${timeout}`));
        }
        execution.then((result) => {
          release();
          resolve(result);
        }, (error: unknown) => {
          release();
          reject(error);
        });
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

type ProjectCommandOptions = { cwd: string; settings: ProjectShellSettings };
type BashExecute = ReturnType<typeof createBashToolDefinition>["execute"];

function projectCommandBashExecute(options: ProjectCommandOptions): BashExecute {
  return (toolCallId, params, signal, onUpdate, context) => {
    const executionDefinition = createBashToolDefinition(context?.cwd ?? options.cwd, {
      commandPrefix: options.settings.getShellCommandPrefix(),
      operations: createProjectCommandBashOperations({
        shellPath: options.settings.getShellPath(),
      }),
    });
    return executionDefinition.execute(toolCallId, params, signal, onUpdate, context);
  };
}

export function createProjectCommandBashExtension(options: ProjectCommandOptions): InlineExtension {
  return {
    name: HOST_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.registerTool({
        ...createBashToolDefinition(options.cwd),
        // Like the built-in, active only when defaultTools/a preset names it (#1235).
        defaultActive: false,
        execute: projectCommandBashExecute(options),
      });
    },
  };
}

// Reviewed pi0 source, also kept verbatim as a synthetic test fixture. This is
// deliberately NOT a general adapter for description-shaped Bash replacements:
// those might implement SSH, sandboxing, approval or background execution.
const DESCRIPTIVE_BASH_SHA256 = "fe89ced304b5f8009ea1aef0b66a6f626dc6afeacbb1f2f1ad9dac38e05c2494";

function composeBashExtension(
  extension: LoadExtensionsResult["extensions"][number],
  execute: BashExecute,
) {
  const registered = extension.tools.get("bash");
  if (!registered || basename(extension.path) !== "bash-description.ts") return extension;

  let reviewed = false;
  try {
    const stat = statSync(extension.path);
    reviewed = stat.isFile() && stat.size <= 64 * 1024
      && createHash("sha256").update(readFileSync(extension.path)).digest("hex") === DESCRIPTIVE_BASH_SHA256;
  } catch { /* Fail closed, without including source or filesystem error details. */ }
  if (!reviewed) {
    throw new Error("Pi Web cannot compose this bash-description.ts revision. Review its source and update the descriptive Bash integration before reloading.");
  }

  const tools = new Map(extension.tools);
  tools.set("bash", {
    ...registered,
    definition: {
      ...registered.definition,
      // Keep the extension's schema, guidance, activation policy and renderers.
      // Only the reviewed local execution is replaced with Pi Web's executor.
      async execute(toolCallId, params, signal, onUpdate, context) {
        const input = params as { description?: unknown; command: string; timeout?: number };
        const description = typeof input.description === "string"
          ? stripVTControlCharacters(input.description).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim()
          : "";
        if (!description) throw new Error("bash requires a nonblank, human-readable description.");
        return execute(toolCallId, { command: input.command, timeout: input.timeout }, signal, onUpdate, context);
      },
    },
  });
  // Resource-loader objects can be cached/shared; never mutate their definitions.
  return { ...extension, tools };
}

/** Child sessions have no fallback Bash extension, but use the same composition. */
export function composeDescriptiveBash(base: LoadExtensionsResult, options: ProjectCommandOptions): LoadExtensionsResult {
  const execute = projectCommandBashExecute(options);
  return { ...base, extensions: base.extensions.map((extension) => composeBashExtension(extension, execute)) };
}

export function preferUserBashExtension(base: LoadExtensionsResult): LoadExtensionsResult {
  const hostExtensionIndex = base.extensions.findIndex((extension) => extension.path === HOST_EXTENSION_PATH);
  if (hostExtensionIndex < 0) return base;

  const userBashOwner = base.extensions
    .slice(0, hostExtensionIndex)
    .find((extension) => extension.tools.has("bash"));
  if (!userBashOwner) return base;

  return {
    ...base,
    extensions: base.extensions
      .filter((_, index) => index !== hostExtensionIndex)
      .map((extension) => extension === userBashOwner
        ? composeBashExtension(extension, base.extensions[hostExtensionIndex].tools.get("bash")!.definition.execute as BashExecute)
        : extension),
    errors: base.errors.filter((error) => !(
      error.path === HOST_EXTENSION_PATH
      && error.error === `Tool "bash" conflicts with ${userBashOwner.path}`
    )),
  };
}
