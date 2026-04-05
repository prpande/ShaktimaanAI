import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAgentPrompt } from "./agent-config.js";
import { gatherRepoContext } from "./repo-context.js";
import { parseTaskFile } from "../task/parser.js";
import { DEFAULT_STAGE_TOOLS, STAGE_CONTEXT_RULES } from "../config/defaults.js";
import { createStreamLogger } from "./stream-logger.js";
import type { AgentRunOptions, AgentRunResult } from "./types.js";
import type { ResolvedConfig } from "../config/loader.js";

// ─── findShippedAgentsDir ────────────────────────────────────────────────────

function findShippedAgentsDir(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    // When running from dist/cli.js: agents are at dist/agents/ (peer dir)
    const peerAgents = join(thisDir, "agents");
    if (existsSync(peerAgents)) return peerAgents;
    // Dev / project root: agents/ is at the package root
    const rootAgents = join(thisDir, "..", "..", "agents");
    if (existsSync(rootAgents)) return rootAgents;
    return peerAgents;
  } catch {
    return join(process.cwd(), "agents");
  }
}

/** Resolves the agents directory: config override or shipped agents. */
export function resolveAgentsDir(config: ResolvedConfig): string {
  return config.pipeline.agentsDir || findShippedAgentsDir();
}

// ─── Tool permission resolver ────────────────────────────────────────────────

/**
 * Resolves tool permissions for a pipeline stage.
 * Priority: config.agents.tools[stage] (highest) → DEFAULT_STAGE_TOOLS → read-only fallback.
 */
export function resolveToolPermissions(
  stage: string,
  config: ResolvedConfig,
): { allowed: string[]; disallowed: string[] } {
  // Config-level override wins (shkmn.config.json agents.tools.{stage})
  const configTools = config.agents.tools[stage];
  if (configTools) {
    const stageDefaults = DEFAULT_STAGE_TOOLS[stage] ?? { allowed: ["Read", "Glob", "Grep"], disallowed: [] as string[] };
    return {
      allowed: configTools.allowed ?? stageDefaults.allowed,
      disallowed: configTools.disallowed ?? stageDefaults.disallowed,
    };
  }

  // Code-level defaults
  return DEFAULT_STAGE_TOOLS[stage] ?? { allowed: ["Read", "Glob", "Grep"], disallowed: [] };
}

// ─── Max turns resolver ───────────────────────────────────────────────────────

/**
 * Resolves the max turns for a pipeline stage.
 * Priority: config.agents.maxTurns[stage] ?? 30
 */
export function resolveMaxTurns(stage: string, config: ResolvedConfig): number {
  return config.agents.maxTurns[stage] ?? 30;
}

// ─── Timeout resolver ─────────────────────────────────────────────────────────

/**
 * Resolves the timeout in minutes for a pipeline stage.
 * Priority: config.agents.timeoutsMinutes[stage] ?? 30
 */
export function resolveTimeoutMinutes(stage: string, config: ResolvedConfig): number {
  return config.agents.timeoutsMinutes[stage] ?? 30;
}

// ─── System prompt builder ───────────────────────────────────────────────────

/**
 * Composes the system prompt from sections based on stage context rules.
 * No template hydration — sections are assembled directly.
 */
export function buildSystemPrompt(options: AgentRunOptions): string {
  const { stage, slug, taskContent, previousOutput, outputPath, config } = options;

  const agentsDir = resolveAgentsDir(config);
  const agentInstructions = loadAgentPrompt(agentsDir, stage);

  const rules = STAGE_CONTEXT_RULES[stage] ?? {
    includeTaskContent: true,
    previousOutputLabel: "Previous Output",
    includeRepoContext: true,
  };

  const agentName = config.agents.names[stage] ?? stage;
  const taskMeta = parseTaskFile(taskContent);
  const stageList = (taskMeta.stages.length > 0 ? taskMeta.stages : config.agents.defaultStages).join(", ");

  const sections: string[] = [];

  // Identity
  sections.push(`# Identity\n\nYou are ${agentName}, the ${stage} agent in the ShaktimaanAI pipeline.`);

  // Pipeline context
  sections.push(`## Pipeline Context\n\nPipeline: ShaktimaanAI | Task: ${slug} | Stage: ${stage}\nStage sequence for this task: ${stageList}`);

  // Task content (conditional)
  if (rules.includeTaskContent) {
    sections.push(`## Task\n\n${taskContent}`);
  }

  // Previous output (conditional)
  if (rules.previousOutputLabel !== null) {
    const content = previousOutput || "(none)";
    sections.push(`## ${rules.previousOutputLabel}\n\n${content}`);
  }

  // Repo context (conditional)
  if (rules.includeRepoContext) {
    const repoContext = gatherRepoContext(taskMeta.repo);
    sections.push(`## Repo Context\n\n${repoContext}`);
  }

  // User Guidance (stage hints from task file + runtime options)
  const taskFileHint = taskMeta.stageHints[stage];
  const runtimeHints = options.stageHints?.[stage] ?? [];
  const allHints: string[] = [
    ...(taskFileHint ? [taskFileHint] : []),
    ...runtimeHints,
  ];
  if (allHints.length > 0) {
    const bullets = allHints.map((h) => `- ${h}`).join("\n");
    sections.push(
      `## User Guidance\n\nThe user has provided the following instructions for this stage:\n${bullets}`,
    );
  }

  // Agent instructions
  sections.push(`---\n\n${agentInstructions}`);

  // Output path
  sections.push(`---\n\nWrite your output to: ${outputPath}`);

  return sections.join("\n\n");
}

// ─── Agent runner ────────────────────────────────────────────────────────────

/**
 * Runs the Claude agent SDK for the given stage and options.
 * Uses per-stage tool permissions from defaults, a composed system prompt,
 * and enforces a configurable timeout via AbortController.
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const { stage, cwd, config, logger, abortController: externalAbort } = options;

  const startMs = Date.now();
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const { allowed: allowedTools, disallowed: disallowedTools } = resolveToolPermissions(stage, config);
  const systemPrompt = buildSystemPrompt(options);
  const streamLogPath = options.outputPath.replace(/\.md$/, "-stream.jsonl");
  const streamLogger = createStreamLogger(streamLogPath);
  const maxTurns = resolveMaxTurns(stage, config);
  const timeoutMinutes = resolveTimeoutMinutes(stage, config);
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
      options: {
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
      },
    });

    for await (const message of messages) {
      // Capture all SDK messages to JSONL for observability
      try {
        if (message.type === "result") {
          const msg = message as Record<string, unknown>;
          streamLogger.log({
            type: message.type,
            subtype: msg.subtype,
            costUsd: msg.total_cost_usd,
            turns: msg.num_turns,
          });
        } else {
          const { type, ...rest } = message as Record<string, unknown>;
          streamLogger.log({ type, ...rest });
        }
      } catch {
        // Stream logging must never interrupt the pipeline
      }

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
      streamLogPath,
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
    streamLogger.close();
    clearTimeout(timeoutHandle);
  }
}
