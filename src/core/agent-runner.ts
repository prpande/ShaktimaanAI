import { loadTemplate, hydrateTemplate } from "./template.js";
import type { AgentRunOptions, AgentRunResult } from "./types.js";

// ─── Tool permission tables ──────────────────────────────────────────────────

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];
const ALL_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];

interface StageToolPermissions {
  allowed: string[];
  disallowed: string[];
}

const STAGE_TOOL_MAP: Record<string, StageToolPermissions> = {
  questions:  { allowed: ["Read", "Glob", "Grep"],             disallowed: ["Write", "Edit", "Bash"] },
  research:   { allowed: ["Read", "Glob", "Grep", "Bash"],     disallowed: ["Write", "Edit"] },
  design:     { allowed: ["Read", "Glob", "Grep"],             disallowed: ["Write", "Edit", "Bash"] },
  structure:  { allowed: ["Read", "Glob", "Grep"],             disallowed: ["Write", "Edit", "Bash"] },
  plan:       { allowed: ["Read", "Glob", "Grep"],             disallowed: ["Write", "Edit", "Bash"] },
  impl:       { allowed: [...ALL_TOOLS],                        disallowed: [] },
  validate:   { allowed: ["Read", "Bash", "Glob", "Grep"],     disallowed: ["Write", "Edit"] },
  review:     { allowed: ["Read", "Glob", "Grep"],             disallowed: ["Write", "Edit", "Bash"] },
  pr:         { allowed: ["Bash"],                              disallowed: ["Write", "Edit"] },
  classify:   { allowed: [],                                    disallowed: [...ALL_TOOLS] },
};

const DEFAULT_PERMISSIONS: StageToolPermissions = {
  allowed: [...READ_ONLY_TOOLS],
  disallowed: [],
};

/**
 * Returns the allowed and disallowed tool lists for the given pipeline stage.
 * Unknown stages get the safe read-only default.
 */
export function getStageTools(stage: string): StageToolPermissions {
  return STAGE_TOOL_MAP[stage] ?? { ...DEFAULT_PERMISSIONS };
}

// ─── System prompt builder ───────────────────────────────────────────────────

/**
 * Loads the stage prompt template and hydrates it with all pipeline variables.
 */
export function buildSystemPrompt(options: AgentRunOptions): string {
  const { stage, slug, taskContent, previousOutput, outputPath, config, templateDir } = options;

  const template = loadTemplate(templateDir, stage);

  const agentName = config.agents.names[stage] ?? stage;

  const vars: Record<string, string> = {
    AGENT_NAME: agentName,
    AGENT_ROLE: stage,
    TASK_CONTENT: taskContent,
    PREVIOUS_OUTPUT: previousOutput || "(none)",
    OUTPUT_PATH: outputPath,
    PIPELINE_CONTEXT: `Pipeline: ShaktimaanAI | Task: ${slug} | Stage: ${stage}`,
  };

  return hydrateTemplate(template, vars);
}

// ─── Agent runner ────────────────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 30;
const DEFAULT_TIMEOUT_MINUTES = 30;

/**
 * Runs the Claude agent SDK for the given stage and options.
 * Uses per-stage tool permissions, a hydrated system prompt, and enforces a
 * configurable timeout via AbortController.
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const { stage, cwd, config, logger, abortController: externalAbort } = options;

  const startMs = Date.now();
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const { allowed: allowedTools, disallowed: disallowedTools } = getStageTools(stage);
  const systemPrompt = buildSystemPrompt(options);

  const maxTurns = config.agents.maxTurns[stage] ?? DEFAULT_MAX_TURNS;
  const timeoutMinutes = config.agents.timeoutsMinutes[stage] ?? DEFAULT_TIMEOUT_MINUTES;
  const timeoutMs = timeoutMinutes * 60 * 1000;

  // Use provided abortController or create our own
  const abortController = externalAbort ?? new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  timeoutHandle = setTimeout(() => {
    logger.warn(`[agent-runner] Stage "${stage}" timed out after ${timeoutMinutes}m — aborting`);
    abortController.abort();
  }, timeoutMs);

  try {
    let output = "";
    let costUsd = 0;
    let turns = 0;

    const messages = query({
      prompt: systemPrompt,
      allowedTools,
      disallowedTools,
      maxTurns,
      cwd,
      abortController,
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
    });

    for await (const message of messages) {
      if (message.type === "result") {
        if (message.subtype === "success") {
          output = (message as unknown as { result: string }).result ?? "";
          costUsd = (message as unknown as { total_cost_usd?: number }).total_cost_usd ?? 0;
          turns = (message as unknown as { num_turns?: number }).num_turns ?? 0;
        } else {
          // error subtype
          const errors = (message as unknown as { errors?: string[] }).errors ?? [];
          return {
            success: false,
            output: "",
            costUsd: 0,
            turns: 0,
            durationMs: Date.now() - startMs,
            error: errors.join("; ") || "Agent returned error result",
          };
        }
      }
    }

    return {
      success: true,
      output,
      costUsd,
      turns,
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[agent-runner] Stage "${stage}" threw: ${message}`);
    return {
      success: false,
      output: "",
      costUsd: 0,
      turns: 0,
      durationMs: Date.now() - startMs,
      error: message,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}
