import { mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";

import { parseTaskFile, type TaskMeta } from "../task/parser.js";
import { type ResolvedConfig } from "../config/loader.js";
import { type AgentRunnerFn, type AgentRunOptions, type RunState, type CompletedStage } from "./types.js";
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
  startRun(taskFilePath: string): Promise<void>;
  resumeRun(slug: string, stageSubdir: string): Promise<void>;
  approveAndResume(slug: string, feedback?: string): Promise<void>;
  getActiveRuns(): RunState[];
}

// ─── Pipeline Factory ──────────────────────────────────────────────────────

export function createPipeline(options: PipelineOptions): Pipeline {
  const { config, registry, runner, logger } = options;
  const runtimeDir = config.pipeline.runtimeDir;
  const activeRuns = new Map<string, RunState>();

  async function processStage(slug: string, taskDir: string): Promise<void> {
    const state = readRunState(taskDir);
    const stage = state.currentStage;
    const taskLogger = createTaskLogger(join(runtimeDir, "logs"), slug);

    if (!registry.canStartAgent(stage)) {
      return; // queued — will be picked up later
    }

    const abortController = new AbortController();
    const agentName = config.agents.names[stage] ?? stage;
    const agentId = registry.register(slug, stage, agentName, abortController);

    // Collect previous outputs from artifacts/
    const artifactsDir = join(taskDir, "artifacts");
    let previousOutput = "";
    if (existsSync(artifactsDir)) {
      const files = readdirSync(artifactsDir).filter(f => f.endsWith(".md")).sort();
      for (const file of files) {
        previousOutput += readFileSync(join(artifactsDir, file), "utf-8") + "\n";
      }
    }

    // Read task content
    const taskContent = readFileSync(join(taskDir, "task.task"), "utf-8");

    const outputPath = join(artifactsDir, `${stage}-output.md`);

    const runOptions: AgentRunOptions = {
      stage,
      slug,
      taskContent,
      previousOutput: previousOutput.trim(),
      outputPath,
      cwd: taskDir,
      config,
      templateDir: join(runtimeDir, "templates"),
      abortController,
      logger: taskLogger,
    };

    let result;
    try {
      result = await runner(runOptions);
    } catch (err) {
      registry.unregister(agentId);
      state.status = "failed";
      state.error = (err as Error).message;
      writeRunState(taskDir, state);
      const failedDir = moveTaskDir(
        runtimeDir, slug,
        join(STAGE_DIR_MAP[stage], "pending"),
        "11-failed",
      );
      activeRuns.delete(slug);
      return;
    }

    registry.unregister(agentId);

    if (!result.success) {
      state.status = "failed";
      state.error = result.error ?? "Agent failed";
      writeRunState(taskDir, state);
      moveTaskDir(
        runtimeDir, slug,
        join(STAGE_DIR_MAP[stage], "pending"),
        "11-failed",
      );
      activeRuns.delete(slug);
      return;
    }

    // If agent didn't write outputPath file, create it from result.output
    if (!existsSync(outputPath)) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, result.output, "utf-8");
    }

    // Add completed stage
    state.completedStages.push({
      stage,
      completedAt: new Date().toISOString(),
      outputFile: `${stage}-output.md`,
      costUsd: result.costUsd,
      turns: result.turns,
    });

    // Move from pending to done
    const doneDir = moveTaskDir(
      runtimeDir, slug,
      join(STAGE_DIR_MAP[stage], "pending"),
      join(STAGE_DIR_MAP[stage], "done"),
    );

    // Check review gate
    if (isReviewGate(stage, state.reviewAfter)) {
      state.status = "hold";
      writeRunState(doneDir, state);
      moveTaskDir(
        runtimeDir, slug,
        join(STAGE_DIR_MAP[stage], "done"),
        "12-hold",
      );
      activeRuns.set(slug, readRunState(join(runtimeDir, "12-hold", slug)));
      return;
    }

    // Check next stage
    const nextStage = getNextStage(stage, state.stages);
    if (nextStage === null) {
      state.status = "complete";
      writeRunState(doneDir, state);
      moveTaskDir(
        runtimeDir, slug,
        join(STAGE_DIR_MAP[stage], "done"),
        "10-complete",
      );
      activeRuns.set(slug, readRunState(join(runtimeDir, "10-complete", slug)));
      return;
    }

    // Continue to next stage
    state.currentStage = nextStage;
    state.status = "running";
    writeRunState(doneDir, state);
    const nextTaskDir = moveTaskDir(
      runtimeDir, slug,
      join(STAGE_DIR_MAP[stage], "done"),
      join(STAGE_DIR_MAP[nextStage], "pending"),
    );
    await processStage(slug, nextTaskDir);
  }

  return {
    async startRun(taskFilePath: string): Promise<void> {
      const slug = basename(taskFilePath, ".task");
      const taskContent = readFileSync(taskFilePath, "utf-8");
      const taskMeta = parseTaskFile(taskContent);
      const state = createRunState(slug, taskMeta, config);

      const firstStage = state.stages[0];
      state.currentStage = firstStage;

      const stageDir = STAGE_DIR_MAP[firstStage];
      const taskDir = initTaskDir(runtimeDir, slug, stageDir, taskFilePath);
      writeRunState(taskDir, state);

      // Delete original inbox file
      unlinkSync(taskFilePath);

      activeRuns.set(slug, state);
      await processStage(slug, taskDir);
    },

    async resumeRun(slug: string, stageSubdir: string): Promise<void> {
      const taskDir = join(runtimeDir, stageSubdir, slug);
      const state = readRunState(taskDir);
      activeRuns.set(slug, state);
      await processStage(slug, taskDir);
    },

    async approveAndResume(slug: string, feedback?: string): Promise<void> {
      const holdDir = join(runtimeDir, "12-hold", slug);
      if (!existsSync(holdDir)) {
        throw new Error(`Task "${slug}" not found in hold`);
      }

      const state = readRunState(holdDir);
      const nextStage = getNextStage(state.currentStage, state.stages);

      if (nextStage === null) {
        state.status = "complete";
        writeRunState(holdDir, state);
        moveTaskDir(runtimeDir, slug, "12-hold", "10-complete");
        activeRuns.set(slug, readRunState(join(runtimeDir, "10-complete", slug)));
        return;
      }

      state.status = "running";
      state.currentStage = nextStage;

      if (feedback) {
        writeFileSync(
          join(holdDir, "artifacts", "review-feedback.md"),
          feedback,
          "utf-8",
        );
      }

      writeRunState(holdDir, state);
      const nextTaskDir = moveTaskDir(
        runtimeDir, slug,
        "12-hold",
        join(STAGE_DIR_MAP[nextStage], "pending"),
      );
      activeRuns.set(slug, state);
      await processStage(slug, nextTaskDir);
    },

    getActiveRuns(): RunState[] {
      return Array.from(activeRuns.values());
    },
  };
}
