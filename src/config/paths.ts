import { join } from "node:path";
import { STAGE_DIR_MAP, type PipelineStageName } from "../core/stage-map.js";

// ─── TaskPaths ────────────────────────────────────────────────────────────────

export interface TaskPaths {
  readonly taskDir: string;
  readonly artifactsDir: string;
  readonly outputFile: string | undefined;
  readonly runStateFile: string;
  readonly taskFile: string;
}

// ─── Terminal names and their directory mappings ──────────────────────────────

export type TerminalName = "inbox" | "complete" | "failed" | "hold";

export const TERMINAL_DIR_MAP: Readonly<Record<TerminalName, string>> = Object.freeze({
  inbox:    "00-inbox",
  complete: "10-complete",
  failed:   "11-failed",
  hold:     "12-hold",
});

// ─── RuntimePaths ─────────────────────────────────────────────────────────────

export interface RuntimePaths {
  readonly runtimeDir: string;

  // Stage directories (pipeline stages)
  readonly stages: Readonly<Record<PipelineStageName, string>>;

  // Terminal directories
  readonly terminals: Readonly<{
    inbox: string;
    complete: string;
    failed: string;
    hold: string;
  }>;

  // Non-stage directories
  readonly logsDir: string;
  readonly historyDir: string;
  readonly dailyLogDir: string;
  readonly monthlyReportsDir: string;
  readonly interactionsDir: string;
  readonly diagnosticsDir: string;
  readonly astraResponsesDir: string;
  readonly worktreesDir: string;

  // System files
  readonly pidFile: string;
  readonly worktreeManifest: string;
  readonly usageBudget: string;
  readonly envFile: string;
  readonly configFile: string;

  // Slack files
  readonly slackOutbox: string;
  readonly slackInbox: string;
  readonly slackSent: string;
  readonly slackThreads: string;
  readonly slackCursor: string;
  readonly slackProcessed: string;

  // Task path resolver — pipeline stage overload
  resolveTask(slug: string, stage: PipelineStageName, location: "pending" | "done", retryNumber?: number): TaskPaths;
  // Task path resolver — terminal overload
  resolveTask(slug: string, terminal: TerminalName): TaskPaths;
}

// ─── buildPaths ───────────────────────────────────────────────────────────────

export function buildPaths(runtimeDir: string): RuntimePaths {
  // Build stages dictionary from STAGE_DIR_MAP
  const stages = Object.freeze(
    Object.fromEntries(
      Object.entries(STAGE_DIR_MAP).map(([stage, dir]) => [stage, join(runtimeDir, dir)])
    )
  ) as Readonly<Record<PipelineStageName, string>>;

  // Build terminals
  const terminals = Object.freeze({
    inbox:    join(runtimeDir, TERMINAL_DIR_MAP.inbox),
    complete: join(runtimeDir, TERMINAL_DIR_MAP.complete),
    failed:   join(runtimeDir, TERMINAL_DIR_MAP.failed),
    hold:     join(runtimeDir, TERMINAL_DIR_MAP.hold),
  });

  // resolveTask closure
  function resolveTask(slug: string, stageOrTerminal: string, location?: "pending" | "done", retryNumber?: number): TaskPaths {
    // Determine if this is a pipeline stage or terminal
    if (location !== undefined) {
      // Pipeline stage overload
      const stageDirName = STAGE_DIR_MAP[stageOrTerminal];
      if (!stageDirName) {
        throw new Error(`Unknown pipeline stage: "${stageOrTerminal}"`);
      }
      const taskDir = join(runtimeDir, stageDirName, location, slug);
      const artifactsDir = join(taskDir, "artifacts");
      const suffix = retryNumber && retryNumber >= 1 ? `-r${retryNumber}` : "";
      const outputFile = join(artifactsDir, `${stageOrTerminal}-output${suffix}.md`);
      return Object.freeze({
        taskDir,
        artifactsDir,
        outputFile,
        runStateFile: join(taskDir, "run-state.json"),
        taskFile: join(taskDir, "task.task"),
      });
    } else {
      // Terminal overload
      const terminalDirName = TERMINAL_DIR_MAP[stageOrTerminal as TerminalName];
      if (!terminalDirName) {
        throw new Error(`Unknown terminal: "${stageOrTerminal}"`);
      }
      const taskDir = join(runtimeDir, terminalDirName, slug);
      const artifactsDir = join(taskDir, "artifacts");
      return Object.freeze({
        taskDir,
        artifactsDir,
        outputFile: undefined,
        runStateFile: join(taskDir, "run-state.json"),
        taskFile: join(taskDir, "task.task"),
      });
    }
  }

  return Object.freeze({
    runtimeDir,
    stages,
    terminals,

    // Non-stage directories
    logsDir:           join(runtimeDir, "logs"),
    historyDir:        join(runtimeDir, "history"),
    dailyLogDir:       join(runtimeDir, "history", "daily-log"),
    monthlyReportsDir: join(runtimeDir, "history", "monthly-reports"),
    interactionsDir:   join(runtimeDir, "interactions"),
    diagnosticsDir:    join(runtimeDir, "diagnostics"),
    astraResponsesDir: join(runtimeDir, "astra-responses"),
    worktreesDir:      join(runtimeDir, "worktrees"),

    // System files
    pidFile:           join(runtimeDir, "shkmn.pid"),
    worktreeManifest:  join(runtimeDir, "worktree-manifest.json"),
    usageBudget:       join(runtimeDir, "usage-budget.json"),
    envFile:           join(runtimeDir, ".env"),
    configFile:        join(runtimeDir, "shkmn.config.json"),

    // Slack files
    slackOutbox:   join(runtimeDir, "slack-outbox.json"),
    slackInbox:    join(runtimeDir, "slack-inbox.json"),
    slackSent:     join(runtimeDir, "slack-sent.json"),
    slackThreads:  join(runtimeDir, "slack-threads.json"),
    slackCursor:   join(runtimeDir, "slack-cursor.json"),
    slackProcessed: join(runtimeDir, "slack-processed.json"),

    resolveTask: resolveTask as RuntimePaths["resolveTask"],
  });
}
