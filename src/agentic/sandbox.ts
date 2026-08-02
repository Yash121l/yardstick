import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

/**
 * The scratch directory an agent is pointed at.
 *
 * Every A1 run happens in a fresh copy under the OS temp dir. Nothing here
 * writes to the task fixtures, so a misbehaving agent cannot corrupt the
 * fixture set for every subsequent run.
 */
export interface Sandbox {
  dir: string;
  /** Path -> sha256 at creation, for detecting what the agent changed. */
  baseline: Map<string, string>;
}

function hashFile(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** Every file under `dir`, relative-path keyed, excluding heavy build output. */
export function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const skip = new Set(["node_modules", ".git", "dist", "__pycache__", ".venv"]);
  const walk = (cur: string): void => {
    for (const name of readdirSync(cur)) {
      if (skip.has(name)) continue;
      const full = join(cur, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.set(relative(dir, full), hashFile(full));
    }
  };
  walk(dir);
  return out;
}

/**
 * Create the scratch copy an agent works in.
 *
 * `node_modules` is symlinked in from the harness rather than installed. The
 * tasks need a toolchain — an agent told to fix a failing suite has to be able
 * to run it — and a per-task `npm install` would dominate the wall-clock figure
 * A1 exists to measure, besides needing network access mid-run.
 *
 * The link is writable, because a symlink cannot be made read-only. That is not
 * a new hole: the agent already runs as the invoking user (see agents.yaml), so
 * anything it could do to the harness through this link it could do directly.
 * The snapshot deliberately skips node_modules, so nothing there is mistaken
 * for the agent's work.
 */
export function createSandbox(taskDir: string, slug: string, harnessRoot?: string): Sandbox {
  // realpathSync matters: on macOS os.tmpdir() is /var/... which is a symlink
  // to /private/var/.... Vite resolves module ids through the real path and
  // then cannot match them against a root given by the symlinked one, so a
  // whole test file fails to load and the suite reports "no tests" rather than
  // an error. Canonicalise once, here.
  const root = realpathSync(mkdtempSync(join(tmpdir(), `yardstick-a1-${slug}-`)));
  const dir = join(root, "work");
  cpSync(taskDir, dir, { recursive: true });

  const modules = join(harnessRoot ?? process.cwd(), "node_modules");
  if (existsSync(modules) && !existsSync(join(dir, "node_modules"))) {
    symlinkSync(modules, join(dir, "node_modules"), "dir");
  }
  return { dir, baseline: snapshot(dir) };
}

/**
 * Remove a sandbox, refusing to touch anything that is not under the OS temp
 * dir. A recursive delete driven by a path that came from config deserves a
 * guard, even when the path is one this module produced.
 */
export function destroySandbox(sb: Sandbox): void {
  const root = resolve(sb.dir, "..");
  // Both sides canonicalised: createSandbox stores the real path, and on macOS
  // os.tmpdir() returns the symlinked one, so a raw comparison never matches.
  const tmp = realpathSync(tmpdir());
  if (!root.startsWith(tmp + sep)) {
    throw new Error(`refusing to remove ${root}: not under ${tmp}`);
  }
  rmSync(root, { recursive: true, force: true });
}

export interface SpawnResult {
  exitCode: number | null;
  timedOut: boolean;
  wallMs: number;
  stdout: string;
  stderr: string;
}

/** Cap captured output so one runaway agent cannot exhaust memory. */
const MAX_CAPTURE = 2_000_000;

export async function runCommand(
  command: string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<SpawnResult> {
  const [bin, ...args] = command;
  if (!bin) throw new Error("empty command");
  const started = Date.now();

  return await new Promise<SpawnResult>((resolvePromise) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (buf: Buffer, into: "o" | "e"): void => {
      const s = buf.toString("utf8");
      if (into === "o") stdout = (stdout + s).slice(0, MAX_CAPTURE);
      else stderr = (stderr + s).slice(0, MAX_CAPTURE);
    };
    child.stdout.on("data", (b: Buffer) => append(b, "o"));
    child.stderr.on("data", (b: Buffer) => append(b, "e"));

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first so the agent can flush; SIGKILL if it ignores that.
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, opts.timeoutMs);

    const done = (code: number | null): void => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code,
        timedOut,
        wallMs: Date.now() - started,
        stdout,
        stderr,
      });
    };
    child.on("error", (err) => {
      stderr += `\nspawn failed: ${err.message}`;
      done(null);
    });
    child.on("close", done);
  });
}

/**
 * Render the agent invocation template.
 *
 * Placeholders: {model} {dir} {promptFile} {prompt}
 *
 * The template is split on whitespace BEFORE substitution, so a value
 * containing spaces stays a single argv entry instead of being re-split into
 * several. Nothing is passed through a shell.
 */
export function renderInvocation(
  template: string,
  vars: { model: string; dir: string; promptFile: string; prompt: string },
): string[] {
  const tokens = template.trim().split(/\s+/).filter(Boolean);
  return tokens.map((tok) =>
    tok
      .replaceAll("{model}", vars.model)
      .replaceAll("{dir}", vars.dir)
      .replaceAll("{promptFile}", vars.promptFile)
      .replaceAll("{prompt}", vars.prompt),
  );
}

/** Files the agent added, changed or deleted, relative to the sandbox root. */
export function diffAgainstBaseline(sb: Sandbox): {
  added: string[];
  changed: string[];
  removed: string[];
} {
  const now = snapshot(sb.dir);
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [p, h] of now) {
    const before = sb.baseline.get(p);
    if (before === undefined) added.push(p);
    else if (before !== h) changed.push(p);
  }
  for (const p of sb.baseline.keys()) if (!now.has(p)) removed.push(p);
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

/** Copy hidden grading assets in after the agent has finished, never before. */
export function installHiddenAssets(sb: Sandbox, from: string, to = "hidden-tests"): boolean {
  if (!existsSync(from)) return false;
  cpSync(from, join(sb.dir, to), { recursive: true });
  return true;
}

/** A stable id for one agent run, used as the attempt id. */
export function runId(): string {
  return randomUUID();
}
