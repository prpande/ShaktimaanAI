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
  ]).optional(),
  extractedSlug: z.string().optional(),
  recommendedStages: z.array(z.string()).optional(),
  stageHints: z.record(z.string(), z.string()).optional(),
  enrichedContext: z.string().optional(),
  repoSummary: z.string().optional(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export function parseTriageResult(raw: string): AstraTriageResult | null {
  let json = raw.trim();
  json = json.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

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
      stage: "quick",
      slug: "astra-triage",
      taskContent,
      previousOutput: "",
      outputPath: "",
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
    logger.warn(`[astra-triage] Failed to parse triage result from output`);
    return null;
  }

  return parsed;
}
