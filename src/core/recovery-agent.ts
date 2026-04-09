import { existsSync, readFileSync, readdirSync, openSync, statSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { type AgentRunnerFn, type RunState } from "./types.js";
import { type ResolvedConfig } from "../config/loader.js";
import { type TaskLogger } from "./logger.js";
import { readRunState, writeRunState, moveTaskDir } from "./pipeline.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RecoveryDiagnosis {
  classification: "fixable" | "terminal";
  diagnosis: string;
  affectedFiles: string[];
  suggestedFix: string;
  reEntryStage: string | null;
  confidence: number;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/**
 * Parses the raw JSON output from the recovery agent into a typed diagnosis.
 * Returns null if the JSON is invalid or missing required fields.
 */
export function parseRecoveryDiagnosis(raw: string): RecoveryDiagnosis | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;

  // classification must be "fixable" or "terminal"
  if (obj.classification !== "fixable" && obj.classification !== "terminal") {
    return null;
  }

  // diagnosis must be a string
  if (typeof obj.diagnosis !== "string") {
    return null;
  }

  return {
    classification: obj.classification,
    diagnosis: obj.diagnosis,
    affectedFiles: Array.isArray(obj.affectedFiles)
      ? obj.affectedFiles.filter((f): f is string => typeof f === "string")
      : [],
    suggestedFix: typeof obj.suggestedFix === "string" ? obj.suggestedFix : "",
    reEntryStage: typeof obj.reEntryStage === "string" ? obj.reEntryStage : null,
    confidence: typeof obj.confidence === "number" ? obj.confidence : 0,
  };
}

// ─── GitHub Issue Body ──────────────────────────────────────────────────────

/**
 * Formats a sanitized markdown body for a GitHub issue.
 * Receives only pipeline internals — no slug, task content, or user data.
 */
export function sanitizeDiagnosisForGithub(
  diagnosis: RecoveryDiagnosis,
  stage: string,
  errorMsg: string,
  validateFailCount: number,
  reviewRetryCount: number,
): string {
  const lines: string[] = [
    "## Recovery Agent Diagnosis",
    "",
    `**Classification:** ${diagnosis.classification}`,
    "",
    `### Failed Stage`,
    `\`${stage}\``,
    "",
    `### Pipeline Error`,
    "```",
    errorMsg,
    "```",
    "",
    `### Root Cause`,
    diagnosis.diagnosis,
    "",
  ];

  if (diagnosis.affectedFiles.length > 0) {
    lines.push("### Affected Files");
    for (const f of diagnosis.affectedFiles) {
      lines.push(`- \`${f}\``);
    }
    lines.push("");
  }

  if (diagnosis.suggestedFix) {
    lines.push("### Suggested Fix");
    lines.push(diagnosis.suggestedFix);
    lines.push("");
  }

  if (diagnosis.reEntryStage) {
    lines.push("### Re-entry Plan");
    lines.push(`Resume from stage: \`${diagnosis.reEntryStage}\``);
    lines.push("");
  }

  lines.push("### Pipeline Context");
  lines.push(`- Validate fail count: ${validateFailCount}`);
  lines.push(`- Review retry count: ${reviewRetryCount}`);
  lines.push("");
  lines.push(`**Confidence:** ${(diagnosis.confidence * 100).toFixed(0)}%`);
  lines.push("");
  lines.push("---");
  lines.push("*Filed automatically by Chiranjeevi (recovery agent)*");

  return lines.join("\n");
}

// ─── GitHub CLI Helpers (private) ───────────────────────────────────────────

function ghIsAvailable(): boolean {
  try {
    execFileSync("gh", ["--version"], { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function findExistingIssue(
  githubRepo: string,
  stage: string,
  diagnosis: string,
): { number: number; url: string } | null {
  try {
    const prefix = diagnosis.slice(0, 80);
    const searchQuery = `recovery-agent stage:${stage} "${prefix}" in:body`;
    const result = execFileSync("gh", [
      "issue", "list",
      "--repo", githubRepo,
      "--label", "recovery-agent",
      "--state", "open",
      "--search", searchQuery,
      "--json", "number,url",
      "--limit", "1",
    ], { stdio: "pipe", timeout: 30_000 });

    const issues = JSON.parse(result.toString("utf-8"));
    if (Array.isArray(issues) && issues.length > 0) {
      return { number: issues[0].number, url: issues[0].url };
    }
  } catch {
    // Search failed — treat as no existing issue
  }
  return null;
}

function fileGithubIssue(
  githubRepo: string,
  stage: string,
  issueBody: string,
): { url: string; number: number | null } | null {
  try {
    const title = `[Recovery] ${stage} stage failure`;
    const result = execFileSync("gh", [
      "issue", "create",
      "--repo", githubRepo,
      "--title", title,
      "--body", issueBody,
      "--label", "recovery-agent",
    ], { stdio: "pipe", timeout: 30_000 });

    const output = result.toString("utf-8").trim();
    // gh issue create outputs the issue URL
    const urlMatch = output.match(/https:\/\/github\.com\/[^\s]+/);
    const numberMatch = output.match(/\/issues\/(\d+)/);

    if (urlMatch) {
      const parsed = numberMatch ? parseInt(numberMatch[1], 10) : NaN;
      return {
        url: urlMatch[0],
        number: parsed > 0 ? parsed : null,
      };
    }
  } catch {
    // Issue creation failed — non-fatal
  }
  return null;
}

function addCommentToIssue(
  githubRepo: string,
  issueNumber: number,
  comment: string,
): void {
  try {
    execFileSync("gh", [
      "issue", "comment",
      String(issueNumber),
      "--repo", githubRepo,
      "--body", comment,
    ], { stdio: "pipe", timeout: 30_000 });
  } catch {
    // Comment failed — non-fatal
  }
}

// ─── Recovery Context Builder (private) ─────────────────────────────────────

function buildRecoveryContext(taskDir: string, state: RunState): string {
  const sections: string[] = [];

  // 1. Run-state summary (safe pipeline internals)
  sections.push("## Run State Summary");
  sections.push(`- Current stage: ${state.currentStage}`);
  sections.push(`- Status: ${state.status}`);
  if (state.error) sections.push(`- Error: ${state.error}`);
  sections.push(`- Validate fail count: ${state.validateFailCount}`);
  sections.push(`- Review retry count: ${state.reviewRetryCount}`);
  if (state.reviewIssues.length > 0) {
    sections.push("- Review issues:");
    for (const issue of state.reviewIssues) {
      sections.push(`  - [${issue.severity}] ${issue.description}`);
    }
  }
  sections.push(`- Completed stages: ${state.completedStages.map((s) => s.stage).join(", ") || "none"}`);
  sections.push("");

  // 2. Last 200 lines of JSONL stream log for the failed stage
  const artifactsDir = join(taskDir, "artifacts");
  if (existsSync(artifactsDir)) {
    try {
      const files = readdirSync(artifactsDir);
      const logFile = files.find(
        (f) => f.includes(state.currentStage) && f.endsWith(".jsonl"),
      );
      if (logFile) {
        const logPath = join(artifactsDir, logFile);
        const fileSize = statSync(logPath).size;
        const TAIL_BYTES = 64 * 1024; // 64KB — enough for 200+ lines without loading entire file
        let tailContent: string;

        if (fileSize <= TAIL_BYTES) {
          tailContent = readFileSync(logPath, "utf-8");
        } else {
          const buf = Buffer.alloc(TAIL_BYTES);
          const fd = openSync(logPath, "r");
          try {
            readSync(fd, buf, 0, TAIL_BYTES, fileSize - TAIL_BYTES);
          } finally {
            closeSync(fd);
          }
          // Drop first partial line (we likely landed mid-line)
          const raw = buf.toString("utf-8");
          const firstNewline = raw.indexOf("\n");
          tailContent = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
        }

        const lines = tailContent.split("\n");
        const tail = lines.slice(-200).join("\n");
        sections.push("## JSONL Stream Log (last 200 lines)");
        sections.push("```jsonl");
        sections.push(tail);
        sections.push("```");
        sections.push("");
      }
    } catch {
      // Log reading failed — non-fatal
    }

    // 3. Retry feedback files
    try {
      const files = readdirSync(artifactsDir);
      const feedbackFiles = files.filter((f) => f.startsWith("retry-feedback-"));
      for (const f of feedbackFiles) {
        const content = readFileSync(join(artifactsDir, f), "utf-8");
        sections.push(`## Retry Feedback: ${f}`);
        sections.push(content);
        sections.push("");
      }
    } catch {
      // Feedback reading failed — non-fatal
    }
  }

  return sections.join("\n");
}

// ─── Main Recovery Agent Runner ─────────────────────────────────────────────

/**
 * Runs the recovery agent on a failed task.
 *
 * 1. Checks config.recovery.enabled — returns early if false
 * 2. Builds context from task dir (run-state, JSONL logs, retry feedback)
 * 3. Calls runner() with stage "recovery"
 * 4. Parses diagnosis from agent output
 * 5. For terminal: marks state.terminalFailure, emits notification
 * 6. For fixable: optionally files/dedupes GitHub issue, moves task to 12-hold
 * 7. Catches all errors — if recovery agent itself fails, task stays in 11-failed
 */
export async function runRecoveryAgent(
  taskDir: string,
  state: RunState,
  runner: AgentRunnerFn,
  config: ResolvedConfig,
  logger: TaskLogger,
  emitNotify: (payload: Record<string, unknown>) => void,
): Promise<void> {
  // 1. Check if recovery is enabled
  if (!config.recovery.enabled) {
    logger.info(`Recovery agent disabled — skipping for "${state.slug}"`);
    return;
  }

  try {
    // 2. Build context
    const context = buildRecoveryContext(taskDir, state);
    logger.info(`Running recovery agent for "${state.slug}" (stage: ${state.currentStage})`);

    // 3. Call the runner
    const result = await runner({
      stage: "recovery",
      slug: state.slug,
      taskContent: context,
      previousOutput: "",
      outputPath: join(taskDir, "artifacts", "recovery-output.md"),
      cwd: state.workDir ?? taskDir,
      config,
      logger,
    });

    if (!result.success) {
      logger.warn(`Recovery agent run failed for "${state.slug}": ${result.error ?? "unknown error"}`);
      return;
    }

    // 4. Parse diagnosis
    const diagnosis = parseRecoveryDiagnosis(result.output);
    if (!diagnosis) {
      logger.warn(`Recovery agent returned unparseable diagnosis for "${state.slug}"`);
      return;
    }

    logger.info(`Recovery diagnosis for "${state.slug}": ${diagnosis.classification} — ${diagnosis.diagnosis}`);

    const failedStage = state.currentStage;

    // 5. Terminal failure
    if (diagnosis.classification === "terminal") {
      state.terminalFailure = true;
      state.recoveryDiagnosis = diagnosis.diagnosis;
      writeRunState(taskDir, state);

      emitNotify({
        type: "recovery_diagnosed",
        slug: state.slug,
        stage: failedStage,
        classification: "terminal",
        diagnosis: diagnosis.diagnosis,
        timestamp: new Date().toISOString(),
      });

      logger.info(`Task "${state.slug}" marked as terminal failure`);
      return;
    }

    // 6. Fixable — optionally file/dedupe GitHub issue
    let issueUrl: string | undefined;
    let issueNumber: number | null | undefined;

    if (config.recovery.fileGithubIssues && ghIsAvailable()) {
      const githubRepo = config.recovery.githubRepo;
      const existing = findExistingIssue(githubRepo, failedStage, diagnosis.diagnosis);

      if (existing) {
        // Dedupe: add comment to existing issue
        const comment = `Recovery agent triggered again for stage \`${failedStage}\`.\n\n**Diagnosis:** ${diagnosis.diagnosis}\n**Confidence:** ${(diagnosis.confidence * 100).toFixed(0)}%`;
        addCommentToIssue(githubRepo, existing.number, comment);
        issueUrl = existing.url;
        issueNumber = existing.number;
        logger.info(`Deduped to existing issue #${existing.number} for "${state.slug}"`);
      } else {
        // File new issue
        const issueBody = sanitizeDiagnosisForGithub(
          diagnosis,
          failedStage,
          state.error ?? "Unknown error",
          state.validateFailCount,
          state.reviewRetryCount,
        );
        const created = fileGithubIssue(githubRepo, failedStage, issueBody);
        if (created) {
          issueUrl = created.url;
          issueNumber = created.number;
          logger.info(`Filed GitHub issue ${created.url} for "${state.slug}"`);
        }
      }
    }

    // Update state with recovery fields
    state.recoveryDiagnosis = diagnosis.diagnosis;
    state.recoveryReEntryStage = diagnosis.reEntryStage ?? undefined;
    state.recoveryIssueUrl = issueUrl;
    state.recoveryIssueNumber = issueNumber ?? undefined;
    state.status = "hold";
    state.holdReason = "awaiting_fix";
    state.holdDetail = `Recovery: ${diagnosis.diagnosis}`;
    writeRunState(taskDir, state);

    // Move from 11-failed to 12-hold
    const runtimeDir = join(taskDir, "..", "..");
    moveTaskDir(runtimeDir, state.slug, "11-failed", "12-hold");

    emitNotify({
      type: "recovery_diagnosed",
      slug: state.slug,
      stage: failedStage,
      classification: "fixable",
      diagnosis: diagnosis.diagnosis,
      reEntryStage: diagnosis.reEntryStage,
      issueUrl,
      timestamp: new Date().toISOString(),
    });

    logger.info(`Task "${state.slug}" moved to hold (awaiting fix)`);
  } catch (err) {
    // 7. Recovery agent itself failed — task stays in 11-failed unanalyzed
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Recovery agent crashed for "${state.slug}": ${errorMsg}`);
  }
}
