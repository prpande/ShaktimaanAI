import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAgentPrompt } from "./agent-config.js";
import { gatherRepoContext } from "./repo-context.js";
import { parseTaskFile } from "../task/parser.js";
import { DEFAULT_STAGE_TOOLS, STAGE_CONTEXT_RULES, STAGE_ARTIFACT_RULES, MCP_TOOL_PREFIXES } from "../config/defaults.js";
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
 * @deprecated Use buildAgentSystemPrompt + buildAgentUserPrompt instead.
 * Retained for backward compatibility with external callers.
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
  const EXECUTION_STAGES = new Set(["impl", "validate", "review", "pr"]);
  const isExecStage = EXECUTION_STAGES.has(stage);
  let pipelineCtx = `## Pipeline Context\n\nPipeline: ShaktimaanAI | Task: ${slug} | Stage: ${stage}\nStage sequence for this task: ${stageList}`;
  if (taskMeta.repo) {
    if (isExecStage && options.cwd !== taskMeta.repo) {
      // Execution stages run in a git worktree — direct all file operations there
      pipelineCtx += `\nTarget repository (original): ${taskMeta.repo}`;
      pipelineCtx += `\nWorking directory (YOUR worktree copy): ${options.cwd}`;
      pipelineCtx += `\nCRITICAL: You are working in a git worktree. ALL file reads, writes, and edits MUST use paths under your working directory (${options.cwd}), NOT the original repo path. The worktree is a full copy of the repo.`;
    } else {
      pipelineCtx += `\nTarget repository: ${taskMeta.repo}`;
      pipelineCtx += `\nIMPORTANT: Your working directory is NOT the repo root. Use absolute paths when reading repo files.`;
    }
    pipelineCtx += `\nIMPORTANT: On Windows, use forward slashes or escaped backslashes in paths. Do NOT use /c/Users/... paths in Node.js — use C:/Users/... instead.`;
  }
  sections.push(pipelineCtx);

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

  // Output instructions — agents with Write access write directly;
  // agents without Write access produce text output that the pipeline captures.
  const { disallowed } = resolveToolPermissions(stage, config);
  const canWrite = !disallowed.includes("Write");
  if (canWrite) {
    sections.push(`---\n\nWrite your output to: ${outputPath}`);
  } else {
    sections.push(
      `---\n\n## Output Instructions\n\n` +
      `Output your complete response as text. Do NOT attempt to write files — ` +
      `the pipeline will capture your text output automatically. ` +
      `Do NOT use Bash to write files (echo, cat heredoc, python, etc.).`,
    );
  }

  return sections.join("\n\n");
}

// ─── Split prompt builders (SDK isolation) ──────────────────────────────────

/**
 * Builds the system prompt: per-stage instructions that benefit from prompt
 * caching across turns within a single agent invocation.
 * Contains: identity, pipeline context, agent instructions, output instructions.
 * Does NOT contain: previous output, repo context, stage hints.
 * Note: includes task metadata (repo path, stage list) so it varies per task,
 * but remains stable across all turns of a single agent run.
 */
export function buildAgentSystemPrompt(options: AgentRunOptions): string {
  const { stage, slug, taskContent, config, outputPath } = options;

  const agentsDir = resolveAgentsDir(config);
  const agentInstructions = loadAgentPrompt(agentsDir, stage);
  const taskMeta = parseTaskFile(taskContent);

  const agentName = config.agents.names[stage] ?? stage;
  const stageList = (taskMeta.stages.length > 0 ? taskMeta.stages : config.agents.defaultStages).join(", ");

  const sections: string[] = [];

  // Identity
  sections.push(`# Identity\n\nYou are ${agentName}, the ${stage} agent in the ShaktimaanAI pipeline.`);

  // Pipeline context
  const EXECUTION_STAGES = new Set(["impl", "validate", "review", "pr"]);
  const isExecStage = EXECUTION_STAGES.has(stage);
  let pipelineCtx = `## Pipeline Context\n\nPipeline: ShaktimaanAI | Task: ${slug} | Stage: ${stage}\nStage sequence for this task: ${stageList}`;
  if (taskMeta.repo) {
    if (isExecStage && options.cwd !== taskMeta.repo) {
      pipelineCtx += `\nTarget repository (original): ${taskMeta.repo}`;
      pipelineCtx += `\nWorking directory (YOUR worktree copy): ${options.cwd}`;
      pipelineCtx += `\nCRITICAL: You are working in a git worktree. ALL file reads, writes, and edits MUST use paths under your working directory (${options.cwd}), NOT the original repo path. The worktree is a full copy of the repo.`;
    } else {
      pipelineCtx += `\nTarget repository: ${taskMeta.repo}`;
      pipelineCtx += `\nIMPORTANT: Your working directory is NOT the repo root. Use absolute paths when reading repo files.`;
    }
    pipelineCtx += `\nIMPORTANT: On Windows, use forward slashes or escaped backslashes in paths. Do NOT use /c/Users/... paths in Node.js — use C:/Users/... instead.`;
  }
  sections.push(pipelineCtx);

  // Agent instructions
  sections.push(`---\n\n${agentInstructions}`);

  // Output instructions
  const { disallowed } = resolveToolPermissions(stage, config);
  const canWrite = !disallowed.includes("Write");
  if (canWrite) {
    sections.push(`---\n\nWrite your output to: ${outputPath}`);
  } else {
    sections.push(
      `---\n\n## Output Instructions\n\n` +
      `Output your complete response as text. Do NOT attempt to write files — ` +
      `the pipeline will capture your text output automatically. ` +
      `Do NOT use Bash to write files (echo, cat heredoc, python, etc.).`,
    );
  }

  return sections.join("\n\n");
}

/**
 * Builds the user prompt: dynamic per-invocation content.
 * Contains: task content, previous stage outputs, repo context, stage hints.
 */
export function buildAgentUserPrompt(options: AgentRunOptions): string {
  const { stage, taskContent, previousOutput, config } = options;

  const rules = STAGE_CONTEXT_RULES[stage] ?? {
    includeTaskContent: true,
    previousOutputLabel: "Previous Output",
    includeRepoContext: true,
  };

  const artifactRules = STAGE_ARTIFACT_RULES[stage];
  const taskMeta = parseTaskFile(taskContent);

  const sections: string[] = [];

  // Task content (conditional)
  if (rules.includeTaskContent) {
    sections.push(`## Task\n\n${taskContent}`);
  }

  // Previous output (now scoped via STAGE_ARTIFACT_RULES in pipeline.ts)
  // previousOutputLabel: null means "do not include previous output at all"
  if (rules.previousOutputLabel !== null && previousOutput && previousOutput.trim()) {
    const label = rules.previousOutputLabel ?? "Previous Output";
    sections.push(`## ${label}\n\n${previousOutput}`);
  }

  // Repo context — either Astra's cached summary or live gatherRepoContext.
  // useRepoSummary stages fall back to gatherRepoContext when no summary is available
  // (e.g., CLI-created tasks that bypass triage).
  if (artifactRules?.useRepoSummary && options.repoSummary) {
    sections.push(`## Repo Context\n\n${options.repoSummary}`);
  } else if (rules.includeRepoContext || (artifactRules?.useRepoSummary && !options.repoSummary)) {
    const repoContext = gatherRepoContext(taskMeta.repo);
    sections.push(`## Repo Context\n\n${repoContext}`);
  }

  // User Guidance (stage hints)
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

  return sections.join("\n\n");
}


// ─── MCP tool filtering ─────────────────────────────────────────────────────

/**
 * Adjusts allowedTools based on Astra's requiredMcpServers.
 *
 * Two operations:
 * 1. ADD: For each required MCP server, adds its wildcard tool pattern
 *    (e.g., "mcp__claude_ai_Slack__*") if not already present. This ensures
 *    stages that don't normally have MCP tools can access them when the task
 *    requires it (e.g., impl needs Figma tools for a Figma-based task).
 * 2. REMOVE: Strips MCP tool patterns for servers the task doesn't need,
 *    avoiding unnecessary tool definitions in the prompt.
 *
 * Non-MCP tools pass through unchanged. When requiredMcpServers is empty
 * or undefined (CLI invocations without triage), all tools pass through
 * unchanged (backward compatible).
 */
export function filterMcpToolsByTaskNeeds(
  allowedTools: string[],
  requiredMcpServers?: string[],
): string[] {
  // No Astra guidance → pass all tools through (backward compatible)
  if (!requiredMcpServers || requiredMcpServers.length === 0) {
    return allowedTools;
  }

  // Build set of required MCP prefixes (normalize to lowercase for resilience)
  const requiredPrefixes = new Set<string>();
  for (const serverName of requiredMcpServers) {
    const prefix = MCP_TOOL_PREFIXES[serverName.toLowerCase().trim()];
    if (prefix) requiredPrefixes.add(prefix);
  }

  // Fail-open: if none of the server names mapped to known prefixes,
  // pass all tools through unchanged to avoid stripping MCP access.
  if (requiredPrefixes.size === 0) {
    return allowedTools;
  }

  // Start with non-MCP tools + MCP tools that match required servers
  const result = allowedTools.filter(tool => {
    if (!tool.startsWith("mcp__")) return true;
    return Array.from(requiredPrefixes).some(prefix =>
      tool.startsWith(prefix) || tool === prefix + "*",
    );
  });

  // Add wildcard patterns for required servers not already covered
  for (const prefix of requiredPrefixes) {
    const alreadyCovered = result.some(t => t.startsWith(prefix));
    if (!alreadyCovered) {
      result.push(prefix + "*");
    }
  }

  return result;
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
  const agentSystemPrompt = buildAgentSystemPrompt(options);
  const userPrompt = buildAgentUserPrompt(options);
  const streamLogPath = options.outputPath.replace(/\.md$/, "-stream.jsonl");
  const streamLogger = createStreamLogger(streamLogPath);
  const maxTurns = resolveMaxTurns(stage, config);
  const timeoutMinutes = resolveTimeoutMinutes(stage, config);
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const model = options.model ?? config.agents.models?.[stage];

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
    let inputTokens = 0;
    let outputTokens = 0;
    let receivedResult = false;

    // SDK isolation: settingSources:[] prevents hooks from loading (~40-50k tokens
    // saved per invocation). Cloud MCPs (Slack, Notion, Figma) load independently
    // of filesystem settings — verified via testing.
    //
    // When Astra provides requiredMcpServers, filterMcpToolsByTaskNeeds:
    // 1. ADDS MCP tool patterns for servers the task needs (e.g., impl gets
    //    Figma tools when the task references a Figma design)
    // 2. REMOVES MCP tool patterns for servers the task doesn't need
    const effectiveAllowedTools = filterMcpToolsByTaskNeeds(
      allowedTools,
      options.requiredMcpServers,
    );

    const messages = query({
      prompt: userPrompt,
      options: {
        systemPrompt: agentSystemPrompt,
        settingSources: [],
        ...(model ? { model } : {}),
        allowedTools: effectiveAllowedTools,
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
          const usageLog = msg.usage as Record<string, unknown> | undefined;
          streamLogger.log({
            type: message.type,
            subtype: msg.subtype,
            costUsd: msg.total_cost_usd,
            turns: msg.num_turns,
            inputTokens: typeof usageLog?.input_tokens === "number" ? usageLog.input_tokens : 0,
            outputTokens: typeof usageLog?.output_tokens === "number" ? usageLog.output_tokens : 0,
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
          const usage = msg.usage as Record<string, unknown> | undefined;
          inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
          outputTokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
        } else if (message.subtype === "error_max_turns") {
          // Agent hit turn limit but may have produced useful partial output.
          // Capture the output and cost, mark as success so the pipeline can
          // decide whether the partial output is sufficient for the stage.
          const msg = message as Record<string, unknown>;
          output = typeof msg.result === "string" ? msg.result : "";
          costUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
          turns = typeof msg.num_turns === "number" ? msg.num_turns : 0;
          const usage = msg.usage as Record<string, unknown> | undefined;
          inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
          outputTokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
          logger.warn(
            `[agent-runner] Stage "${stage}" hit max turns (${turns}) — using partial output (${output.length} chars)`,
          );
          break; // Stop reading stream after max turns to avoid wasted tokens
        } else {
          // Hard error subtype (abort, timeout, etc.)
          const msg = message as Record<string, unknown>;
          const errors = Array.isArray(msg.errors) ? (msg.errors as string[]) : [];
          return {
            success: false,
            output: "",
            costUsd: 0,
            turns: 0,
            inputTokens: 0,
            outputTokens: 0,
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
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - startMs,
        error: "No result message received from agent — stream completed without a result",
      };
    }

    return {
      success: true,
      output,
      costUsd,
      turns,
      inputTokens,
      outputTokens,
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
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - startMs,
      error: message,
    };
  } finally {
    streamLogger.close();
    clearTimeout(timeoutHandle);
  }
}
