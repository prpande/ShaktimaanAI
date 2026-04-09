import type { ResolvedConfig } from "../config/loader.js";

export type PipelineStage =
  | "questions" | "research" | "design" | "structure" | "plan"
  | "impl" | "review" | "validate" | "pr"
  | "quick" | "quick-triage" | "quick-execute" | "slack-io"
  | "recovery";

export type RunStatus = "running" | "hold" | "complete" | "failed";

export interface CompletedStage {
  stage: string;
  completedAt: string;
  outputFile?: string;
  durationSeconds?: number;
  costUsd?: number;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
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
  repoRoot?: string;
  invocationCwd?: string;

  // Retry counters
  validateRetryCount?: number;
  reviewRetryCount: number;
  reviewIssues: ReviewIssue[];
  suggestionRetryUsed: boolean;   // NEW — resets each impl cycle
  validateFailCount: number;      // NEW — tracks post-review validate failures

  // Spec 3 fields
  stageHints: Record<string, string[]>;
  retryAttempts: Record<string, number>;
  pausedAtStage?: string;
  holdReason?: "budget_exhausted" | "approval_required" | "user_paused" | "awaiting_fix";
  holdDetail?: string;
  budgetResetAtIndex?: number;

  // Token optimization: Astra-determined MCP requirements and repo summary
  requiredMcpServers?: string[];
  repoSummary?: string;

  // Recovery agent fields
  terminalFailure?: boolean;
  recoveryDiagnosis?: string;
  recoveryReEntryStage?: string;
  recoveryIssueUrl?: string;
  recoveryIssueNumber?: number;
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
  stageHints?: Record<string, string[]>;
  model?: string;
  requiredMcpServers?: string[];
  repoSummary?: string;
}

export interface AgentRunResult {
  success: boolean;
  output: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
  streamLogPath?: string;
}

export type AgentRunnerFn = (options: AgentRunOptions) => Promise<AgentRunResult>;

export interface AstraTriageResult {
  action: "answer" | "route_pipeline" | "control_command";
  directAnswer?: string | null;

  // Control command path
  controlOp?: "approve" | "cancel" | "skip" | "pause" |
              "resume" | "modify_stages" | "restart_stage" | "retry" | "recover" |
              "shutdown" | null;
  extractedSlug?: string | null;

  // Pipeline routing path
  taskTitle?: string | null;
  recommendedStages?: string[] | null;
  stageHints?: Record<string, string> | null;
  enrichedContext?: string | null;
  repoSummary?: string | null;
  requiredMcpServers?: string[] | null;

  // Metadata
  confidence: number;
  reasoning: string;
}
