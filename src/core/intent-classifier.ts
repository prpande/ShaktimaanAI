import type { AgentRunOptions, AgentRunResult, AgentRunnerFn } from "./types.js";
import type { ResolvedConfig } from "../config/loader.js";

// ─── ClassifyResult ──────────────────────────────────────────────────────────

export interface ClassifyResult {
  intent: "create_task" | "approve" | "status" | "cancel" | "unknown";
  confidence: number;
  extractedSlug: string | null;
  extractedContent: string | null;
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
];

// ─── classifyByKeywords ──────────────────────────────────────────────────────

/**
 * Attempts to classify the input by matching against keyword patterns.
 * Returns a ClassifyResult if a pattern matches, or null if none match.
 */
export function classifyByKeywords(input: string): ClassifyResult | null {
  const trimmed = input.trim();

  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(trimmed)) {
      return {
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

const UNKNOWN_RESULT: ClassifyResult = {
  intent: "unknown",
  confidence: 0,
  extractedSlug: null,
  extractedContent: null,
};

/**
 * Classifies the input by calling the agent runner with stage "classify".
 * Parses JSON from the result (stripping markdown code fences).
 * Returns an "unknown" result on any failure.
 */
export async function classifyByLLM(
  input: string,
  runAgentFn: AgentRunnerFn,
  config: ResolvedConfig,
  templateDir: string,
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
      templateDir,
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

  try {
    const parsed = JSON.parse(json) as Partial<ClassifyResult>;
    return {
      intent: parsed.intent ?? "unknown",
      confidence: parsed.confidence ?? 0,
      extractedSlug: parsed.extractedSlug ?? null,
      extractedContent: parsed.extractedContent ?? null,
    };
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
  templateDir: string,
  logger: Logger,
  confidenceThreshold = 0.7,
): Promise<ClassifyResult> {
  const keywordResult = classifyByKeywords(input);

  if (keywordResult !== null && keywordResult.confidence >= confidenceThreshold) {
    return keywordResult;
  }

  // Fallback to LLM
  return classifyByLLM(input, runAgentFn, config, templateDir, logger);
}
