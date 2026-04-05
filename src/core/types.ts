import type { ResolvedConfig } from "../config/loader.js";

export type PipelineStage =
  | "questions" | "research" | "design" | "structure" | "plan"
  | "impl" | "validate" | "review" | "pr";

export type RunStatus = "running" | "hold" | "complete" | "failed";

export interface CompletedStage {
  stage: string;
  completedAt: string;
  outputFile?: string;
  costUsd?: number;
  turns?: number;
}

export interface ReviewIssue {
  id: string;
  description: string;
  severity: string;
  firstSeen: number;
  lastSeen: number;
}

export interface RunState {
  slug: string;
  taskFile: string;
  stages: string[];
  reviewAfter: string;
  currentStage: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  completedStages: CompletedStage[];
  error?: string;

  // Execution working directory fields
  workDir?: string;
  worktreePath?: string;
  invocationCwd?: string;

  // Retry counters
  validateRetryCount: number;
  reviewRetryCount: number;
  reviewIssues: ReviewIssue[];

  // Spec 3 fields
  stageHints: Record<string, string[]>;
  retryAttempt: number;
  pausedAtStage?: string;
}

export interface AgentRunOptions {
  stage: string;
  slug: string;
  taskContent: string;
  previousOutput: string;
  outputPath: string;
  cwd: string;
  config: ResolvedConfig;
  abortController?: AbortController;
  logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

export interface AgentRunResult {
  success: boolean;
  output: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  error?: string;
  streamLogPath?: string;
}

export type AgentRunnerFn = (options: AgentRunOptions) => Promise<AgentRunResult>;
