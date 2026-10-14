import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Anonymous, opt-out usage telemetry (PostHog, US cloud).
 *
 * Sends one `cli_command_run` per invocation (command, version, os, duration, exit code)
 * and, after a real eval, one `eval_run_completed` with counts and spend. Never sends
 * argument values, model or suite ids, paths, prompts, responses or file contents.
 *
 * Off when DO_NOT_TRACK=1, YARDSTICK_TELEMETRY=0, CI is set, or under vitest. A random
 * install id lives in <config dir>/yardstick/telemetry.json; the first run prints a notice.
 * Events go out from a detached child process with a 3s timeout, so the CLI never waits.
 */

// Public PostHog project key (client key, safe to commit).
const POSTHOG_KEY = "phc_oLm8fb7L4CXDqGdJcc7a6boCtR8rVjf6dNx7G995eGdy";
const BATCH_URL = "https://us.i.posthog.com/batch/";

type Props = Record<string, string | number | boolean | null>;

export function telemetryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const dnt = (env.DO_NOT_TRACK ?? "").trim();
  if (dnt !== "" && dnt !== "0" && dnt.toLowerCase() !== "false") return true;
  if ((env.YARDSTICK_TELEMETRY ?? "").trim() === "0") return true;
  if (env.CI || env.VITEST) return true;
  return false;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "yardstick");
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "yardstick");
  return join(homedir(), ".config", "yardstick");
}

/** The install id, created on first use. Returns null if the config dir isn't writable. */
function installId(dir: string): { id: string; firstRun: boolean } | null {
  const file = join(dir, "telemetry.json");
  try {
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { install_id?: unknown };
      if (typeof saved.install_id === "string" && saved.install_id) {
        return { id: saved.install_id, firstRun: false };
      }
    }
    const id = randomUUID();
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ install_id: id }, null, 2)}\n`);
    return { id, firstRun: true };
  } catch {
    return null;
  }
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

const queued: { event: string; properties: Props }[] = [];

/** Queue an extra event; it goes out with cli_command_run when the process exits. */
export function track(event: string, properties: Props = {}): void {
  queued.push({ event, properties });
}

/**
 * Start telemetry for this invocation: prints the one-time notice and arranges for
 * the events to be sent as the process exits (whatever the exit path).
 */
export function startTelemetry(command: string, flags: Props = {}): void {
  if (telemetryDisabled()) return;
  const install = installId(configDir());
  if (!install) return;
  if (install.firstRun) {
    process.stderr.write(
      "yardstick collects anonymous usage data (command, version, OS, duration, exit code; " +
        "never arguments, paths or model output).\n" +
        "Opt out with YARDSTICK_TELEMETRY=0 or DO_NOT_TRACK=1. See README > Telemetry.\n\n",
    );
  }
  const started = Date.now();
  const base: Props = { app: "yardstick", version: version(), os: process.platform };
  process.once("exit", (code) => {
    const events = [
      {
        event: "cli_command_run",
        properties: {
          ...flags,
          command,
          duration_ms: Date.now() - started,
          exit_code: code,
          arch: process.arch,
          node_version: process.versions.node,
        },
      },
      ...queued,
    ].map((e) => ({
      event: e.event,
      distinct_id: install.id,
      timestamp: new Date().toISOString(),
      properties: { ...base, ...e.properties, $process_person_profile: false },
    }));
    send(events);
  });
}

function send(batch: object[]): void {
  const body = JSON.stringify({ api_key: POSTHOG_KEY, batch });
  const script =
    "fetch(process.argv[1],{method:'POST',headers:{'Content-Type':'application/json'}," +
    "body:process.env.YS_TELEMETRY_BODY,signal:AbortSignal.timeout(3000)}).catch(()=>{})";
  try {
    const child = spawn(process.execPath, ["-e", script, BATCH_URL], {
      detached: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH ?? "", YS_TELEMETRY_BODY: body },
    });
    child.unref();
  } catch {
    // telemetry must never affect the CLI
  }
}
