import { z } from "zod";
import type { AgentRunOptions, AgentRunResult, AgentRunnerFn } from "./types.js";
import type { ResolvedConfig } from "../config/loader.js";

// ─── ClassifyResult ──────────────────────────────────────────────────────────

export interface ClassifyResult {
  intent: "create_task" | "approve" | "status" | "cancel" | "skip" | "pause" | "resume" | "modify_stages" | "restart_stage" | "retry" | "unknown";
  confidence: number;
  extractedSlug: string | null;
  extractedContent: string | null;
  extractedStages: string[] | null;
  extractedFeedback: string | null;
  stageHints: Record<string, string> | null;
  complexity: "quick" | "pipeline" | null;
  complexityConfidence: number;
}

// ─── Slug pattern ────────────────────────────────────────────────────────────

/**
 * Matches a kebab-case slug with a 14-digit timestamp suffix.
 * Pattern: at least two kebab segments before the timestamp, e.g. fix-auth-bug-20260404103000
 */
const SLUG_PATTERN = /([a-z0-9]+-){2,}\d{14}/;

function extractSlug(input: string): string | null {
  const match = input.match(SLUG_PATTERN);
  return match ? match[0] : null;
}

// ─── Keyword pattern table ───────────────────────────────────────────────────

interface KeywordRule {
  pattern: RegExp;
  intent: ClassifyResult["intent"];
  confidence: number;
}

const KEYWORD_RULES: KeywordRule[] = [
  {
    pattern: /^(create|add|new|make)\s+(task|ticket|item|story)/i,
    intent: "create_task",
    confidence: 0.95,
  },
  {
    pattern: /^(approve|lgtm|ship it|go ahead)/i,
    intent: "approve",
    confidence: 0.95,
  },
  {
    pattern: /^(status|what'?s\s+running|progress|show tasks)/i,
    intent: "status",
    confidence: 0.95,
  },
  {
    pattern: /^(cancel|stop|kill|abort)\s+/i,
    intent: "cancel",
    confidence: 0.95,
  },
  {
    pattern: /^(skip)\s+/i,
    intent: "skip",
    confidence: 0.95,
  },
  {
    pattern: /^(pause|hold on)\s+/i,
    intent: "pause",
    confidence: 0.95,
  },
  {
    pattern: /^(resume|continue)\s+/i,
    intent: "resume",
    confidence: 0.95,
  },
  {
    pattern: /^(retry|redo)\s+/i,
    intent: "retry",
    confidence: 0.95,
  },
  {
    pattern: /^(restart)\s+/i,
    intent: "restart_stage",
    confidence: 0.95,
  },
  {
    pattern: /^(modify.stages|change.stages|drop|add.stage)\s+/i,
    intent: "modify_stages",
    confidence: 0.95,
  },
];

// ─── UNKNOWN_RESULT ──────────────────────────────────────────────────────────

const UNKNOWN_RESULT: ClassifyResult = {
  intent: "unknown",
  confidence: 0,
  extractedSlug: null,
  extractedContent: null,
  extractedStages: null,
  extractedFeedback: null,
  stageHints: null,
  complexity: null,
  complexityConfidence: 0,
};

// ─── classifyByKeywords ──────────────────────────────────────────────────────

/**
 * Attempts to classify the input by matching against keyword patterns.
 * Returns a ClassifyResult if a pattern matches, or null if none match.
 *
 * Checks quick/full pipeline prefixes first before the keyword rules loop.
 */
export function classifyByKeywords(input: string): ClassifyResult | null {
  const trimmed = input.trim();

  // Quick prefix: "quick: <text>"
  const quickMatch = trimmed.match(/^quick:\s*(.+)$/i);
  if (quickMatch) {
    return {
      ...UNKNOWN_RESULT,
      intent: "create_task",
      confidence: 0.95,
      extractedSlug: extractSlug(trimmed),
      extractedContent: quickMatch[1].trim(),
      complexity: "quick",
      complexityConfidence: 1.0,
    };
  }

  // Full pipeline prefix: "full pipeline: <text>"
  const fullPipelineMatch = trimmed.match(/^full pipeline:\s*(.+)$/i);
  if (fullPipelineMatch) {
    return {
      ...UNKNOWN_RESULT,
      intent: "create_task",
      confidence: 0.95,
      extractedSlug: extractSlug(trimmed),
      extractedContent: fullPipelineMatch[1].trim(),
      complexity: "pipeline",
      complexityConfidence: 1.0,
    };
  }

  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(trimmed)) {
      return {
        ...UNKNOWN_RESULT,
        intent: rule.intent,
        confidence: rule.confidence,
        extractedSlug: extractSlug(trimmed),
        extractedContent: null,
      };
    }
  }

  return null;
}

// ─── classifyByLLM ───────────────────────────────────────────────────────────

type Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };

/**
 * Classifies the input by calling the agent runner with stage "classify".
 * Parses JSON from the result (stripping markdown code fences).
 * Returns an "unknown" result on any failure.
 */
export async function classifyByLLM(
  input: string,
  runAgentFn: AgentRunnerFn,
  config: ResolvedConfig,
  logger: Logger,
): Promise<ClassifyResult> {
  let result: AgentRunResult;

  try {
    result = await runAgentFn({
      stage: "classify",
      slug: "",
      taskContent: input,
      previousOutput: "",
      outputPath: "",
      cwd: process.cwd(),
      config,
      logger,
    });
  } catch (err) {
    logger.error(`[intent-classifier] LLM runner threw: ${(err as Error).message}`);
    return { ...UNKNOWN_RESULT };
  }

  if (!result.success || !result.output) {
    logger.warn(`[intent-classifier] LLM runner failed: ${result.error ?? "no output"}`);
    return { ...UNKNOWN_RESULT };
  }

  // Strip markdown code fences if present
  let json = result.output.trim();
  json = json.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  const classifySchema = z.object({
    intent: z
      .enum(["create_task", "approve", "status", "cancel", "skip", "pause", "resume", "modify_stages", "restart_stage", "retry", "unknown"])
      .catch("unknown"),
    confidence: z.number().min(0).max(1).catch(0),
    extractedSlug: z.string().nullable().catch(null),
    extractedContent: z.string().nullable().catch(null),
    extractedStages: z.array(z.string()).nullable().catch(null),
    extractedFeedback: z.string().nullable().catch(null),
    stageHints: z.record(z.string(), z.string()).nullable().catch(null),
    complexity: z.enum(["quick", "pipeline"]).nullable().catch(null),
    complexityConfidence: z.number().min(0).max(1).catch(0),
  });

  try {
    const raw = JSON.parse(json);
    const parsed = classifySchema.parse(raw);
    return parsed;
  } catch (err) {
    logger.warn(`[intent-classifier] Failed to parse LLM JSON: ${(err as Error).message}`);
    return { ...UNKNOWN_RESULT };
  }
}

// ─── classifyIntent ──────────────────────────────────────────────────────────

/**
 * Classifies user intent from natural language input.
 * Tries keyword matching first. Falls back to LLM if no match or confidence
 * is below the threshold.
 *
 * @param confidenceThreshold - Minimum confidence to accept a keyword match (default 0.7)
 */
export async function classifyIntent(
  input: string,
  runAgentFn: AgentRunnerFn,
  config: ResolvedConfig,
  logger: Logger,
  confidenceThreshold = 0.7,
): Promise<ClassifyResult> {
  const keywordResult = classifyByKeywords(input);

  if (keywordResult !== null && keywordResult.confidence >= confidenceThreshold) {
    return keywordResult;
  }

  // Fallback to LLM
  return classifyByLLM(input, runAgentFn, config, logger);
}
