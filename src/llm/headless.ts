import { spawn } from "node:child_process";

export interface ClaudeOptions {
  /** Tools Claude can use during this run. Default: undefined = let Claude default decide. */
  allowedTools?: string[];
  /** Skip permission prompts. Only set true when running non-interactively with tools. */
  skipPermissions?: boolean;
  /** Override claude binary path. Default: resolved via PATH. */
  claudeBin?: string;
  /** Max attempts on transient failures. Default 2. */
  maxAttempts?: number;
  /** Timeout per attempt in ms. Default 120_000 (2 minutes). */
  timeoutMs?: number;
  /** Override the model flag passed to claude (--model). Default: unset (uses CLI default). */
  model?: string;
}

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_TIMEOUT_MS = 120_000;

export async function askClaude(prompt: string, opts: ClaudeOptions = {}): Promise<string> {
  const bin = opts.claudeBin ?? "claude";
  const args: string[] = ["-p"];
  if (opts.allowedTools !== undefined) {
    args.push("--allowedTools", opts.allowedTools.join(","));
  }
  if (opts.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  if (opts.model) {
    args.push("--model", opts.model);
  }

  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runOnce(bin, args, prompt, timeoutMs);
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
  throw lastError ?? new Error("askClaude failed without specific error");
}

function runOnce(
  bin: string,
  args: string[],
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.trim() || stdout.trim()}`));
      } else {
        resolve(stdout);
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export async function askClaudeJson<T = unknown>(
  prompt: string,
  opts: ClaudeOptions = {},
): Promise<T> {
  const fullPrompt =
    prompt.trim() +
    "\n\nRespond with ONLY a JSON code block (```json ... ```). No prose before or after.";
  const raw = await askClaude(fullPrompt, opts);
  return extractJson<T>(raw);
}

export function extractJson<T>(text: string): T {
  // Prefer fenced ```json ... ``` (or plain ``` ... ```)
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1]) as T;
    } catch {
      // fall through to other strategies
    }
  }
  // Find the first { or [ and try to parse from there
  const start = text.search(/[\[{]/);
  if (start >= 0) {
    try {
      return JSON.parse(text.slice(start).trim()) as T;
    } catch {
      // fall through
    }
  }
  // Last resort: raw parse
  try {
    return JSON.parse(text.trim()) as T;
  } catch {
    throw new Error(`could not parse JSON from claude output:\n${text.slice(0, 500)}`);
  }
}
