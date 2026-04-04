import type { TaskMeta } from "../task/parser.js";

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
}

export interface AgentRunOptions {
  stage: string;
  slug: string;
  taskContent: string;
  previousOutput: string;
  outputPath: string;
  cwd: string;
  config: import("../config/loader.js").ResolvedConfig;
  templateDir: string;
  abortController?: AbortController;
  logger: import("./logger.js").TaskLogger;
}

export interface AgentRunResult {
  success: boolean;
  output: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  error?: string;
}

export type AgentRunnerFn = (options: AgentRunOptions) => Promise<AgentRunResult>;
