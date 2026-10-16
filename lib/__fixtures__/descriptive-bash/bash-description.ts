import { stripVTControlCharacters } from "node:util";
import {
  createBashToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DESCRIPTION_GUIDANCE =
  "For every bash call, provide a description of what the command does and its immediate purpose, " +
  "in clear, active language. Use roughly 5–10 words for simple commands; explain pipelines and " +
  "scripts sufficiently to make their effect understandable. Explicitly mention consequential " +
  "effects such as writing or deleting files, installing software, or restarting services. " +
  "Describe the whole call, not just its first command. Do not include secrets. " +
  "The description explains the command; it is not an approval or a claim that it is safe.";

// Plain display text, never terminal instructions, links, or bidi controls.
// Do not mutate the stored argument or use this text to construct a command.
function displayDescription(value: unknown): string {
  if (typeof value !== "string") return "";
  return stripVTControlCharacters(value)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export default function (pi: ExtensionAPI) {
  const original = createBashToolDefinition(process.cwd());
  const parameters = Type.Object({
    description: Type.String({
      minLength: 1,
      pattern: "\\S",
      description:
        "Human-readable explanation of this command and its purpose in active voice. " +
        "Usually 5–10 words; use more context for scripts and pipelines. State consequential effects; never include secrets.",
    }),
    ...original.parameters.properties,
  });

  pi.registerTool({
    ...original,
    // Replacing bash must not add it to a session that excluded shell access.
    defaultActive: false,
    description: `${original.description} ${DESCRIPTION_GUIDANCE}`,
    promptGuidelines: [...(original.promptGuidelines ?? []), DESCRIPTION_GUIDANCE],
    parameters,
    // Do not adapt description-less calls into the required new schema.
    prepareArguments: undefined,

    async execute(toolCallId, args, signal, onUpdate, ctx) {
      if (!displayDescription(args.description)) {
        throw new Error("bash requires a nonblank, human-readable description.");
      }
      // Use the effective session settings, not a second settings/config loader.
      // Only command/timeout reach Bash; description is inert call metadata.
      const { shellPath, shellCommandPrefix } = pi.getSettings();
      const bash = createBashToolDefinition(ctx.cwd, {
        shellPath,
        commandPrefix: shellCommandPrefix,
      });
      return bash.execute(toolCallId, { command: args.command, timeout: args.timeout }, signal, onUpdate, ctx);
    },

    renderCall(args, theme, context) {
      // Keep Pi's command preview, expansion, timeout display and timer state.
      // Its cached call component must not be confused with our outer container.
      const previous = context.lastComponent instanceof Container ? context.lastComponent : undefined;
      const command = original.renderCall!(args, theme, {
        ...context,
        lastComponent: previous?.children.at(-1),
      });
      const description = displayDescription(args?.description);
      const container = previous ?? new Container();
      container.clear();
      if (description) {
        container.addChild(new Text(theme.fg("accent", description), 0, 0));
      }
      container.addChild(command);
      return container;
    },
    // renderResult and all execution/output metadata are inherited unchanged.
  });
}
