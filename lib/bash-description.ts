// Display-only, untrusted tool input: never Markdown, approval, or shell input.
// Keep this client-safe (in particular, no RegExp lookbehind for iOS 16.2).
export function bashDescription(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const value = (input as Record<string, unknown>).description;
  if (typeof value !== "string") return "";
  return value
    // CSI, OSC links/titles, and terminal control strings (including unfinished ones).
    .replace(/\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\|$)|[PX^_][\s\S]*?(?:\x1b\\|\x07|$)|\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/\x9b[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
