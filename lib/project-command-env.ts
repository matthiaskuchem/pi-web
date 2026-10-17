import {
  createBashToolDefinition,
  createLocalBashOperations,
  getAgentDir,
  type BashOperations,
  type InlineExtension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { bashDescription } from "./bash-description";

const HOST_EXTENSION_NAME = "pi-web-project-command-environment";
export const PROJECT_COMMAND_EXTENSION_PATH = `<inline:${HOST_EXTENSION_NAME}>`;

const DESCRIPTION_GUIDANCE =
  "For every bash call, provide a description of what the command does and its immediate purpose, " +
  "in clear, active language. Use roughly 5–10 words for simple commands; explain pipelines and " +
  "scripts sufficiently to make their effect understandable. Explicitly mention consequential " +
  "effects such as writing or deleting files, installing software, or restarting services. " +
  "Describe the whole call, not just its first command. Do not include secrets. " +
  "The description explains the command; it is not an approval or a claim that it is safe.";
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
      const original = createBashToolDefinition(options.cwd);
      const execute = projectCommandBashExecute(options);
      pi.registerTool({
        ...original,
        // Pi Web owns this schema; no shared/CLI extension needs to be enabled.
        parameters: Type.Object({
          description: Type.String({
            minLength: 1,
            description: "Human-readable explanation of this command and its purpose in active voice. " +
              "Usually 5–10 words; use more context for scripts and pipelines. State consequential effects; never include secrets.",
          }),
          ...original.parameters.properties,
        }),
        description: `${original.description} ${DESCRIPTION_GUIDANCE}`,
        promptGuidelines: [...(original.promptGuidelines ?? []), DESCRIPTION_GUIDANCE],
        // Like the built-in, active only when defaultTools/a preset names it (#1235).
        defaultActive: false,
        prepareArguments: undefined,
        async execute(toolCallId, input, signal, onUpdate, context) {
          if (!bashDescription(input)) {
            throw new Error("bash requires a nonblank, human-readable description.");
          }
          // Description is inert metadata: only command/timeout reach the executor.
          return execute(toolCallId, { command: input.command, timeout: input.timeout }, signal, onUpdate, context);
        },
      });
    },
  };
}

export function preferProjectCommandBashExtension(base: LoadExtensionsResult): LoadExtensionsResult {
  const host = base.extensions.find((extension) => extension.path === PROJECT_COMMAND_EXTENSION_PATH);
  if (!host?.tools.has("bash")) return base;

  for (const extension of base.extensions) {
    // Keep other tools, handlers and providers; only Bash belongs to Pi Web.
    // Removing the shadowed registration also prevents child ext: grants from
    // treating the host's Bash as an external tool the profile selected.
    if (extension !== host) extension.tools.delete("bash");
  }
  return {
    ...base,
    // The SDK's first owner wins, including tools registered at session_start
    // or later. Keep the host first so a late external Bash cannot replace it.
    extensions: [host, ...base.extensions.filter((extension) => extension !== host)],
    // All Bash ownership conflicts are resolved here, including owners already
    // dropped by a child's scope. Preserve unrelated extension diagnostics.
    errors: base.errors.filter((error) => !error.error.startsWith('Tool "bash" conflicts with ')),
  };
}
