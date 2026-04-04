import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hydrateTemplate } from "./template.js";
import type { AgentRunOptions, AgentRunResult } from "./types.js";

/** Loads a prompt-{name}.md file from templateDir. Kept local until Task 5 rewires to agent-config. */
function loadTemplate(templateDir: string, templateName: string): string {
  const filePath = join(templateDir, `prompt-${templateName}.md`);
  try {
    return readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Template not found for stage "${templateName}" at "${filePath}". ` +
      `Ensure templates are bundled in dist/ during build. ` +
      `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

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
    let receivedResult = false;

    const messages = query({
      prompt: systemPrompt,
      allowedTools,
      disallowedTools,
      maxTurns,
      cwd,
      abortController,
      // The Agent SDK requires bypassPermissions for non-interactive (headless)
      // agent runs. Per-stage tool restrictions are enforced via allowedTools /
      // disallowedTools above — the SDK's own permission UI is designed for
      // interactive CLI use and cannot be used in a pipeline context.
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
    });

    for await (const message of messages) {
      if (message.type === "result") {
        receivedResult = true;
        if (message.subtype === "success") {
          const msg = message as Record<string, unknown>;
          output = typeof msg.result === "string" ? msg.result : "";
          costUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
          turns = typeof msg.num_turns === "number" ? msg.num_turns : 0;
        } else {
          // error subtype
          const msg = message as Record<string, unknown>;
          const errors = Array.isArray(msg.errors) ? (msg.errors as string[]) : [];
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

    if (!receivedResult) {
      return {
        success: false,
        output: "",
        costUsd: 0,
        turns: 0,
        durationMs: Date.now() - startMs,
        error: "No result message received from agent — stream completed without a result",
      };
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
