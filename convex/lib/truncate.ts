// Adapted from vercel/eve (Apache-2.0): packages/eve/src/execution/sandbox/truncate-output.ts

/**
 * Shared output truncation for tool results.
 *
 * Every tool that can return unbounded text (command output, file reads, web
 * pages) bounds it here, before the result enters the conversation, so a
 * single `cat` of a log or a long article cannot eat the model's context. The
 * budget is in lines and bytes rather than characters, and whole lines are
 * kept, so what the model sees is never cut mid-line.
 *
 * Byte counts use TextEncoder rather than Buffer, so this runs in Convex's
 * default runtime and in the runner as well as in Node actions.
 */

/** Maximum number of lines kept after truncation. */
export const MAX_OUTPUT_LINES = 2000;

/** Maximum byte size of the truncated output. */
export const MAX_OUTPUT_BYTES = 50 * 1024;

/** Maximum length of a single line before it is truncated. */
export const MAX_LINE_LENGTH = 2000;

/** Suffix appended to lines exceeding {@link MAX_LINE_LENGTH}. */
export const LINE_TRUNCATION_SUFFIX = " [truncated]";

/** Result of a {@link truncateTail} or {@link truncateHead} call. */
export interface TruncationResult {
  /** The truncated output text. */
  readonly output: string;
  /** True when the output was shortened. */
  readonly truncated: boolean;
  /** Total number of lines in the original input. */
  readonly totalLines: number;
  /** Number of lines included in the truncated output. */
  readonly outputLines: number;
}

const utf8 = new TextEncoder();

/**
 * Keeps the **first** lines of `text` that fit within the line and byte
 * budgets. File contents and web pages are more informative at the beginning.
 */
export function truncateHead(text: string): TruncationResult {
  return truncateByDirection(text, "head");
}

/**
 * Keeps the **last** lines of `text` that fit within the line and byte
 * budgets. Command output puts its errors and results at the end.
 */
export function truncateTail(text: string): TruncationResult {
  return truncateByDirection(text, "tail");
}

/** The two directions differ only in where iteration starts. */
function truncateByDirection(text: string, direction: "head" | "tail"): TruncationResult {
  const rawLines = text.split("\n");
  const totalLines = countLogicalLines(rawLines);
  const fromStart = direction === "head";

  const kept: string[] = [];
  let bytes = 0;

  const start = fromStart ? 0 : rawLines.length - 1;
  const step = fromStart ? 1 : -1;

  for (let i = start; i >= 0 && i < rawLines.length && kept.length < MAX_OUTPUT_LINES; i += step) {
    const line = capLineLength(rawLines[i] ?? "");
    const lineBytes = utf8.encode(line).length + 1;

    if (bytes + lineBytes > MAX_OUTPUT_BYTES && kept.length > 0) {
      break;
    }

    kept.push(line);
    bytes += lineBytes;
  }

  if (!fromStart) {
    kept.reverse();
  }

  return {
    output: kept.join("\n"),
    outputLines: kept.length,
    totalLines,
    truncated: kept.length < totalLines,
  };
}

/** Caps one line at {@link MAX_LINE_LENGTH} characters. */
export function capLineLength(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) {
    return line;
  }
  return line.slice(0, MAX_LINE_LENGTH) + LINE_TRUNCATION_SUFFIX;
}

/** A trailing empty element from `split("\n")` is not a separate line. */
function countLogicalLines(lines: readonly string[]): number {
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.length - 1;
  }
  return lines.length;
}
