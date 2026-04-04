import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hydrateTemplate } from "./template.js";
import { loadAgentConfig } from "./agent-config.js";
import { gatherRepoContext } from "./repo-context.js";
import { parseTaskFile } from "../task/parser.js";
import type { AgentRunOptions, AgentRunResult } from "./types.js";
import type { ResolvedConfig } from "../config/loader.js";

// ─── findShippedAgentsDir ────────────────────────────────────────────────────

function findShippedAgentsDir(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const projectRoot = join(thisDir, "..", "..");
    return join(projectRoot, "agents");
  } catch {
    return join(process.cwd(), "agents");
  }
}

// ─── Tool permission resolver ────────────────────────────────────────────────

const DEFAULT_READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];

/**
 * Resolves tool permissions for a pipeline stage.
 * If agentTools.allowed is non-empty, use it. Otherwise default to read-only tools.
 */
export function resolveToolPermissions(
  _stage: string,
  agentTools: { allowed: string[]; disallowed: string[] },
  _config: ResolvedConfig,
): { allowed: string[]; disallowed: string[] } {
  if (agentTools.allowed.length > 0) {
    return { allowed: agentTools.allowed, disallowed: agentTools.disallowed };
  }
  return { allowed: [...DEFAULT_READ_ONLY_TOOLS], disallowed: [] };
}

// ─── Max turns resolver ───────────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 30;

/**
 * Resolves the max turns for a pipeline stage.
 * Priority: config.agents.maxTurns[stage] ?? agentMaxTurns ?? 30
 */
export function resolveMaxTurns(
  stage: string,
  agentMaxTurns: number | undefined,
  config: ResolvedConfig,
): number {
  return config.agents.maxTurns[stage] ?? agentMaxTurns ?? DEFAULT_MAX_TURNS;
}

// ─── Timeout resolver ─────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MINUTES = 30;

/**
 * Resolves the timeout in minutes for a pipeline stage.
 * Priority: config.agents.timeoutsMinutes[stage] ?? agentTimeout ?? 30
 */
export function resolveTimeoutMinutes(
  stage: string,
  agentTimeout: number | undefined,
  config: ResolvedConfig,
): number {
  return config.agents.timeoutsMinutes[stage] ?? agentTimeout ?? DEFAULT_TIMEOUT_MINUTES;
}

// ─── System prompt builder ───────────────────────────────────────────────────

/**
 * Loads the stage prompt template from agent config and hydrates it with all
 * pipeline variables including repo context and stage list.
 */
export function buildSystemPrompt(options: AgentRunOptions): string {
  const { stage, slug, taskContent, previousOutput, outputPath, config } = options;

  // Determine agents directory: config override or shipped agents
  const agentsDir = config.pipeline.agentsDir || findShippedAgentsDir();

  // Load agent config from markdown file
  const agentConfig = loadAgentConfig(agentsDir, stage);

  // Parse task content to extract repo path and stages
  const taskMeta = parseTaskFile(taskContent);

  // Gather repo context
  const repoContext = gatherRepoContext(taskMeta.repo);

  // Resolve agent name from config (falls back to stage name)
  const agentName = config.agents.names[stage] ?? stage;

  // Build stage list from task meta or config defaults
  const stageList = (taskMeta.stages.length > 0 ? taskMeta.stages : config.agents.defaultStages).join(", ");

  const vars: Record<string, string> = {
    AGENT_NAME: agentName,
    AGENT_ROLE: stage,
    TASK_CONTENT: taskContent,
    PREVIOUS_OUTPUT: previousOutput || "(none)",
    OUTPUT_PATH: outputPath,
    PIPELINE_CONTEXT: `Pipeline: ShaktimaanAI | Task: ${slug} | Stage: ${stage}`,
    REPO_CONTEXT: repoContext,
    REPO_PATH: taskMeta.repo || "(none)",
    STAGE_LIST: stageList,
  };

  return hydrateTemplate(agentConfig.promptTemplate, vars);
}

// ─── Agent runner ────────────────────────────────────────────────────────────

/**
 * Runs the Claude agent SDK for the given stage and options.
 * Uses per-stage tool permissions from agent config, a hydrated system prompt,
 * and enforces a configurable timeout via AbortController.
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const { stage, cwd, config, logger, abortController: externalAbort } = options;

  const startMs = Date.now();
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  // Load agent config for tool permissions and timing
  const agentsDir = config.pipeline.agentsDir || findShippedAgentsDir();
  const agentConfig = loadAgentConfig(agentsDir, stage);

  const { allowed: allowedTools, disallowed: disallowedTools } = resolveToolPermissions(
    stage,
    agentConfig.tools,
    config,
  );
  const systemPrompt = buildSystemPrompt(options);

  const maxTurns = resolveMaxTurns(stage, agentConfig.maxTurns, config);
  const timeoutMinutes = resolveTimeoutMinutes(stage, agentConfig.timeoutMinutes, config);
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
