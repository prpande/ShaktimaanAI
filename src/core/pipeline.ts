import { mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from "node:fs";
import { join, basename } from "node:path";

import { type TaskMeta } from "../task/parser.js";
import { type ResolvedConfig } from "../config/loader.js";
import { type AgentRunnerFn, type RunState, type CompletedStage } from "./types.js";
import { type AgentRegistry } from "./registry.js";
import { type TaskLogger, createTaskLogger } from "./logger.js";

// ─── Stage ↔ Directory Maps ────────────────────────────────────────────────

export const STAGE_DIR_MAP: Record<string, string> = {
  questions: "01-questions",
  research: "02-research",
  design: "03-design",
  structure: "04-structure",
  plan: "05-plan",
  impl: "06-impl",
  validate: "07-validate",
  review: "08-review",
  pr: "09-pr",
};

export const DIR_STAGE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(STAGE_DIR_MAP).map(([stage, dir]) => [dir, stage]),
);

// ─── Pure Utilities ─────────────────────────────────────────────────────────

export function getNextStage(currentStage: string, stages: string[]): string | null {
  const idx = stages.indexOf(currentStage);
  if (idx === -1 || idx === stages.length - 1) return null;
  return stages[idx + 1];
}

export function isReviewGate(completedStage: string, reviewAfter: string): boolean {
  return completedStage === reviewAfter;
}

// ─── RunState Factory & I/O ─────────────────────────────────────────────────

export function createRunState(
  slug: string,
  taskMeta: TaskMeta,
  config: ResolvedConfig,
): RunState {
  const now = new Date().toISOString();
  const stages =
    taskMeta.stages.length > 0
      ? [...taskMeta.stages]
      : [...config.agents.defaultStages];
  const reviewAfter =
    taskMeta.reviewAfter !== ""
      ? taskMeta.reviewAfter
      : config.agents.defaultReviewAfter;

  return {
    slug,
    taskFile: "task.task",
    stages,
    reviewAfter,
    currentStage: "",
    status: "running",
    startedAt: now,
    updatedAt: now,
    completedStages: [],
  };
}

const RUN_STATE_FILE = "run-state.json";

export function readRunState(taskDir: string): RunState {
  const raw = readFileSync(join(taskDir, RUN_STATE_FILE), "utf-8");
  return JSON.parse(raw) as RunState;
}

export function writeRunState(taskDir: string, state: RunState): void {
  const updated: RunState = { ...state, updatedAt: new Date().toISOString() };
  writeFileSync(join(taskDir, RUN_STATE_FILE), JSON.stringify(updated, null, 2), "utf-8");
}

// ─── Directory Helpers ──────────────────────────────────────────────────────

export function initTaskDir(
  runtimeDir: string,
  slug: string,
  stageDir: string,
  taskFilePath: string,
): string {
  const taskDir = join(runtimeDir, stageDir, "pending", slug);
  mkdirSync(join(taskDir, "artifacts"), { recursive: true });
  copyFileSync(taskFilePath, join(taskDir, "task.task"));
  return taskDir;
}

export function moveTaskDir(
  runtimeDir: string,
  slug: string,
  fromSubdir: string,
  toSubdir: string,
): string {
  const src = join(runtimeDir, fromSubdir, slug);
  const destParent = join(runtimeDir, toSubdir);
  mkdirSync(destParent, { recursive: true });
  const dest = join(destParent, slug);
  renameSync(src, dest);
  return dest;
}

// ─── Pipeline Interfaces (type-only exports) ────────────────────────────────

export interface PipelineOptions {
  config: ResolvedConfig;
  registry: AgentRegistry;
  runner: AgentRunnerFn;
  logger: TaskLogger;
}

export interface Pipeline {
  run(slug: string, taskMeta: TaskMeta): Promise<RunState>;
  abort(): void;
}

// ─── Placeholder (Task 7 replaces this) ─────────────────────────────────────

export function createPipeline(_options: PipelineOptions): Pipeline {
  throw new Error("Not implemented");
}
