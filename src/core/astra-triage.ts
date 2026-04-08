import { join } from "node:path";
import { z } from "zod";
import type { AstraTriageResult } from "./types.js";
import type { AgentRunnerFn, AgentRunResult } from "./types.js";
import type { ResolvedConfig } from "../config/loader.js";

// ─── Triage result parser ───────────────────────────────────────────────────

const triageResultSchema = z.object({
  action: z.enum(["answer", "route_pipeline", "control_command"]),
  controlOp: z.enum([
    "approve", "cancel", "skip", "pause",
    "resume", "modify_stages", "restart_stage", "retry",
  ]).nullable().optional(),
  extractedSlug: z.string().nullable().optional(),
  taskTitle: z.string().trim().min(1).nullable().optional(),
  recommendedStages: z.array(z.string()).nullable().optional(),
  stageHints: z.record(z.string(), z.string()).nullable().optional(),
  enrichedContext: z.string().nullable().optional(),
  repoSummary: z.string().nullable().optional(),
  requiredMcpServers: z.array(z.string()).nullable().optional(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export function parseTriageResult(raw: string): AstraTriageResult | null {
  let json = raw.trim();

  // Strip markdown code fences — handles ```json\n...\n``` and variants
  const fenceMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i);
  if (fenceMatch) {
    json = fenceMatch[1].trim();
  }

  // Also try extracting a JSON object directly if no fences
  if (!fenceMatch) {
    const objMatch = json.match(/\{[\s\S]*\}/);
    if (objMatch) {
      json = objMatch[0];
    }
  }

  try {
    const parsed = JSON.parse(json);
    const result = triageResultSchema.parse(parsed);
    return result;
  } catch {
    return null;
  }
}

// ─── Triage runner ──────────────────────────────────────────────────────────

type Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };

export interface AstraInput {
  message: string;
  threadTs?: string;
  channelId: string;
  userId: string;
  source: "slack" | "cli";
}

export async function runAstraTriage(
  input: AstraInput,
  runAgentFn: AgentRunnerFn,
  config: ResolvedConfig,
  logger: Logger,
  messageTs?: string,
): Promise<AstraTriageResult | null> {
  const taskContent = [
    `## Incoming Message`,
    ``,
    `From: ${input.userId}`,
    `Channel: ${input.channelId}`,
    `Source: ${input.source}`,
    ...(input.threadTs ? [`Thread: ${input.threadTs}`] : []),
    ``,
    `### Message`,
    ``,
    input.message,
  ].join("\n");

  let result: AgentRunResult;
  try {
    result = await runAgentFn({
      stage: "quick-triage",
      slug: "astra-triage",
      taskContent,
      previousOutput: "",
      outputPath: join(config.pipeline.runtimeDir, "astra-responses", `triage-${messageTs?.replace(".", "-") ?? "output"}-output.md`),
      cwd: process.cwd(),
      config,
      logger,
    });
  } catch (err) {
    logger.error(`[astra-triage] Agent runner threw: ${(err as Error).message}`);
    return null;
  }

  if (!result.success || !result.output) {
    logger.warn(`[astra-triage] Agent failed: ${result.error ?? "no output"}`);
    return null;
  }

  const parsed = parseTriageResult(result.output);
  if (!parsed) {
    logger.warn(`[astra-triage] Failed to parse triage result from output: ${result.output.slice(0, 500)}`);
    return null;
  }

  return parsed;
}
