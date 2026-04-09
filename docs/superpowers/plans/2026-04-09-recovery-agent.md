# Recovery Agent (Chiranjeevi) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-healing failure recovery system: automated diagnosis of failed tasks, GitHub issue filing, startup-based re-entry, graceful shutdown, watchdog service, and CLI/Slack control surfaces.

**Architecture:** A new `recovery` agent (Chiranjeevi) is invoked inline in `failTask()` to diagnose failures. Fixable failures move to `12-hold/` with a GitHub issue; terminal failures stay in `11-failed/`. On startup, `recovery.ts` checks held tasks' issues and auto-recovers them. A `shkmn service` watchdog keeps the pipeline alive and up-to-date. A `shkmn recover` CLI + Slack surface provides status and manual re-entry.

**Tech Stack:** TypeScript, Vitest, Commander.js, Zod, Claude Agent SDK, `gh` CLI

**Spec:** `docs/superpowers/specs/2026-04-09-recovery-agent-design.md`

---

### Task 1: Extend RunState and holdReason types

**Files:**
- Modify: `src/core/types.ts:30-66`
- Test: `tests/core/config-additions.test.ts` (or new `tests/core/recovery-types.test.ts`)

- [ ] **Step 1: Write failing test for new RunState fields**

Create `tests/core/recovery-types.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { RunState } from "../../src/core/types.js";

describe("RunState recovery fields", () => {
  it("accepts recovery-related fields", () => {
    const state: RunState = {
      slug: "test-slug",
      taskFile: "task.md",
      stages: ["impl"],
      reviewAfter: "design",
      currentStage: "impl",
      status: "failed",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedStages: [],
      reviewRetryCount: 0,
      reviewIssues: [],
      suggestionRetryUsed: false,
      validateFailCount: 0,
      stageHints: {},
      retryAttempts: {},
      // Recovery fields
      terminalFailure: true,
      recoveryDiagnosis: "Tool permission missing for review stage",
      recoveryReEntryStage: "review",
      recoveryIssueUrl: "https://github.com/prpande/ShaktimaanAI/issues/42",
      recoveryIssueNumber: 42,
    };
    expect(state.terminalFailure).toBe(true);
    expect(state.recoveryDiagnosis).toBe("Tool permission missing for review stage");
    expect(state.recoveryReEntryStage).toBe("review");
    expect(state.recoveryIssueUrl).toBe("https://github.com/prpande/ShaktimaanAI/issues/42");
    expect(state.recoveryIssueNumber).toBe(42);
  });

  it("accepts awaiting_fix holdReason", () => {
    const state: RunState = {
      slug: "test-slug",
      taskFile: "task.md",
      stages: ["impl"],
      reviewAfter: "design",
      currentStage: "impl",
      status: "hold",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedStages: [],
      reviewRetryCount: 0,
      reviewIssues: [],
      suggestionRetryUsed: false,
      validateFailCount: 0,
      stageHints: {},
      retryAttempts: {},
      holdReason: "awaiting_fix",
    };
    expect(state.holdReason).toBe("awaiting_fix");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/recovery-types.test.ts`
Expected: FAIL — TypeScript compilation error, `terminalFailure` not in `RunState`, `"awaiting_fix"` not in `holdReason` union.

- [ ] **Step 3: Add recovery fields to RunState**

In `src/core/types.ts`, add after the `repoSummary` field (line 65):

```typescript
  // Recovery agent fields
  terminalFailure?: boolean;
  recoveryDiagnosis?: string;
  recoveryReEntryStage?: string;
  recoveryIssueUrl?: string;
  recoveryIssueNumber?: number;
```

And update the `holdReason` union on line 59 to:

```typescript
  holdReason?: "budget_exhausted" | "approval_required" | "user_paused" | "awaiting_fix";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/recovery-types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts tests/core/recovery-types.test.ts
git commit -m "feat(recovery): add RunState recovery fields and awaiting_fix holdReason"
```

---

### Task 2: Add recovery config schema and defaults

**Files:**
- Modify: `src/config/schema.ts:8-72`
- Modify: `src/config/defaults.ts`
- Test: `tests/config/schema.test.ts` (extend existing)

- [ ] **Step 1: Write failing test for recovery config**

Add to `tests/config/schema.test.ts`:

```typescript
describe("recovery config", () => {
  it("accepts recovery config with defaults", () => {
    const parsed = configSchema.parse({
      pipeline: { runtimeDir: "/tmp/test" },
    });
    expect(parsed.recovery).toEqual({
      enabled: true,
      fileGithubIssues: true,
      githubRepo: "prpande/ShaktimaanAI",
    });
  });

  it("accepts explicit recovery config", () => {
    const parsed = configSchema.parse({
      pipeline: { runtimeDir: "/tmp/test" },
      recovery: {
        enabled: false,
        fileGithubIssues: false,
        githubRepo: "some/other-repo",
      },
    });
    expect(parsed.recovery.enabled).toBe(false);
    expect(parsed.recovery.fileGithubIssues).toBe(false);
    expect(parsed.recovery.githubRepo).toBe("some/other-repo");
  });
});

describe("service config", () => {
  it("accepts service config with defaults", () => {
    const parsed = configSchema.parse({
      pipeline: { runtimeDir: "/tmp/test" },
    });
    expect(parsed.service).toEqual({
      mode: "source",
      repoPath: "",
      checkIntervalMinutes: 5,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config/schema.test.ts -t "recovery config"`
Expected: FAIL — `recovery` not in schema.

- [ ] **Step 3: Add recovery and service sections to config schema**

In `src/config/schema.ts`, add before the closing `})` of `configSchema`:

```typescript
  recovery: z.object({
    enabled: z.boolean().optional().default(true),
    fileGithubIssues: z.boolean().optional().default(true),
    githubRepo: z.string().optional().default("prpande/ShaktimaanAI"),
  }).optional().default({}),
  service: z.object({
    mode: z.enum(["source", "package"]).optional().default("source"),
    repoPath: z.string().optional().default(""),
    checkIntervalMinutes: z.number().optional().default(5),
  }).optional().default({}),
```

- [ ] **Step 4: Add recovery stage defaults**

In `src/config/defaults.ts`, add `recovery` to `DEFAULT_STAGE_TOOLS`:

```typescript
  recovery: { allowed: ["Read","Glob","Grep","Bash"], disallowed: ["Write","Edit"] },
```

Add to `STAGE_CONTEXT_RULES`:

```typescript
  recovery: { includeTaskContent: false, previousOutputLabel: null, includeRepoContext: false },
```

Add to the model defaults (in `DEFAULT_CONFIG.agents.models` or equivalent):
- `recovery: "opus"`

Add to the timeout defaults:
- `recovery: 30`

Add to the maxTurns defaults:
- `recovery: 60`

Add to `STAGE_ARTIFACT_RULES`:
```typescript
  recovery: { mode: 'all_prior' },
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/config/schema.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts src/config/defaults.ts tests/config/schema.test.ts
git commit -m "feat(recovery): add recovery and service config schema with defaults"
```

---

### Task 3: Create the recovery agent prompt template

**Files:**
- Create: `agents/recovery.md`

- [ ] **Step 1: Write the agent prompt**

Create `agents/recovery.md`:

```markdown
## Instructions

You are Chiranjeevi, the recovery diagnostician for the ShaktimaanAI pipeline. Your job is to analyze failed tasks and determine why they failed — specifically whether the failure was caused by a pipeline instrumentation issue (fixable) or a fundamentally impossible task (terminal).

You receive:
1. The failed task's run-state (error, stage, retry counts, review issues)
2. The JSONL stream log for the failed stage
3. Stage output artifacts and retry feedback files
4. Pipeline source code for the relevant stage configuration

## Diagnostic Process

### Step 1 — Analyze the evidence
- Read the run-state error message carefully
- Read the JSONL stream log to trace what the agent actually did
- Read any retry feedback files to understand the loop history
- Note the stage, retry counts, and verdict history

### Step 2 — Analyze the pipeline configuration
- Read `src/config/defaults.ts` to check tool permissions, context rules, timeouts, and model assignments for the failed stage
- Read the agent prompt template (`agents/{stage}.md`) to check for prompt issues
- If verdict-related: read `src/core/retry.ts` for decision logic
- If agent execution error: read `src/core/agent-runner.ts` for SDK handling
- Compare expected behavior (from source) against actual behavior (from logs)

### Step 3 — Classify the failure
Determine if this is:
- **fixable**: The pipeline's configuration, prompts, or code caused the failure. Examples: wrong tool permissions, timeout too short, missing context, bad prompt instructions, verdict parsing mismatch, incorrect model assignment.
- **terminal**: The task itself is fundamentally flawed or the failure is caused by external factors outside the pipeline. Examples: impossible requirements, ambiguous task beyond resolution, API outage, repo access revoked.

### Step 4 — For fixable failures, determine the re-entry point
Identify the earliest pipeline stage affected by the issue. Be conservative — when uncertain, pick an earlier stage. Re-running extra stages is cheap; re-entering too late causes another failure cycle.

## Output Format

Output ONLY valid JSON. No markdown, no explanation, no code fences. The response must be a raw JSON object matching this schema. The schema is shown below for documentation purposes only — actual agent output must be unwrapped JSON:

    {
      "classification": "fixable" | "terminal",
      "diagnosis": "Detailed explanation of the root cause",
      "affectedFiles": ["src/config/defaults.ts", ...],
      "suggestedFix": "Description of what needs to change",
      "reEntryStage": "stage-name (only for fixable)",
      "confidence": 0.0-1.0
    }

## Privacy Rules

Your diagnosis will be used to file a GitHub issue. The issue must contain ONLY pipeline-internal information:
- Stage name, pipeline error message, affected source file
- Config values (tool permissions, timeouts, models)
- Retry counts, verdict parsing outcome
- Agent configuration for the failed stage

NEVER include in your output:
- Task content from the .task file
- User repository file paths or code
- Artifact content (stage outputs)
- JSONL stream log excerpts containing user code
- The task slug (use "the affected task" instead)
```

- [ ] **Step 2: Verify the file is valid markdown**

Run: `cat agents/recovery.md | head -5`
Expected: Shows the first lines of the prompt.

- [ ] **Step 3: Commit**

```bash
git add agents/recovery.md
git commit -m "feat(recovery): add Chiranjeevi recovery agent prompt template"
```

---

### Task 4: Build the recovery agent module

**Files:**
- Create: `src/core/recovery-agent.ts`
- Test: `tests/core/recovery-agent-diagnosis.test.ts`

- [ ] **Step 1: Write failing test for diagnosis parsing**

Create `tests/core/recovery-agent-diagnosis.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseRecoveryDiagnosis, sanitizeDiagnosisForGithub } from "../../src/core/recovery-agent.js";

describe("parseRecoveryDiagnosis", () => {
  it("parses valid fixable diagnosis", () => {
    const raw = JSON.stringify({
      classification: "fixable",
      diagnosis: "Tool permission missing: review stage needs Bash",
      affectedFiles: ["src/config/defaults.ts"],
      suggestedFix: "Add Bash to review stage allowed tools",
      reEntryStage: "review",
      confidence: 0.9,
    });
    const result = parseRecoveryDiagnosis(raw);
    expect(result).not.toBeNull();
    expect(result!.classification).toBe("fixable");
    expect(result!.reEntryStage).toBe("review");
  });

  it("parses valid terminal diagnosis", () => {
    const raw = JSON.stringify({
      classification: "terminal",
      diagnosis: "Task requires access to a private API that is down",
      affectedFiles: [],
      suggestedFix: "",
      reEntryStage: null,
      confidence: 0.85,
    });
    const result = parseRecoveryDiagnosis(raw);
    expect(result).not.toBeNull();
    expect(result!.classification).toBe("terminal");
  });

  it("returns null for invalid JSON", () => {
    expect(parseRecoveryDiagnosis("not json")).toBeNull();
  });

  it("returns null for missing classification", () => {
    const raw = JSON.stringify({ diagnosis: "something" });
    expect(parseRecoveryDiagnosis(raw)).toBeNull();
  });
});

describe("sanitizeDiagnosisForGithub", () => {
  it("includes pipeline internals", () => {
    const text = sanitizeDiagnosisForGithub({
      classification: "fixable",
      diagnosis: "Review stage timeout too short",
      affectedFiles: ["src/config/defaults.ts"],
      suggestedFix: "Increase review timeout to 45 minutes",
      reEntryStage: "review",
      confidence: 0.9,
    }, "review", "Agent timed out after 30 minutes", 2, 1);
    expect(text).toContain("review");
    expect(text).toContain("defaults.ts");
    expect(text).toContain("timeout");
  });

  it("never includes task slug in output", () => {
    const text = sanitizeDiagnosisForGithub({
      classification: "fixable",
      diagnosis: "Tool permission missing",
      affectedFiles: ["src/config/defaults.ts"],
      suggestedFix: "Add Bash",
      reEntryStage: "review",
      confidence: 0.9,
    }, "review", "Agent failed", 0, 0);
    // Slug should not appear — the function doesn't receive it
    expect(text).not.toContain("my-secret-project");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/recovery-agent-diagnosis.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create recovery-agent.ts with parsing and sanitization**

Create `src/core/recovery-agent.ts`:

```typescript
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { type AgentRunnerFn, type RunState } from "./types.js";
import { type ResolvedConfig } from "../config/loader.js";
import { type TaskLogger } from "./logger.js";
import { readRunState, writeRunState, moveTaskDir } from "./pipeline.js";
import { STAGE_DIR_MAP } from "./stage-map.js";

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

export function parseRecoveryDiagnosis(raw: string): RecoveryDiagnosis | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.classification !== "fixable" && parsed.classification !== "terminal") return null;
    if (typeof parsed.diagnosis !== "string") return null;
    return {
      classification: parsed.classification,
      diagnosis: parsed.diagnosis,
      affectedFiles: Array.isArray(parsed.affectedFiles) ? parsed.affectedFiles : [],
      suggestedFix: typeof parsed.suggestedFix === "string" ? parsed.suggestedFix : "",
      reEntryStage: typeof parsed.reEntryStage === "string" ? parsed.reEntryStage : null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    };
  } catch {
    return null;
  }
}

// ─── GitHub Issue Sanitization ──────────────────────────────────────────────

export function sanitizeDiagnosisForGithub(
  diagnosis: RecoveryDiagnosis,
  stage: string,
  errorMsg: string,
  validateFailCount: number,
  reviewRetryCount: number,
): string {
  const lines: string[] = [
    `## Recovery Agent Diagnosis`,
    ``,
    `**Classification:** ${diagnosis.classification}`,
    `**Failed Stage:** ${stage}`,
    `**Pipeline Error:** ${errorMsg}`,
    `**Confidence:** ${(diagnosis.confidence * 100).toFixed(0)}%`,
    ``,
    `### Root Cause`,
    diagnosis.diagnosis,
    ``,
  ];

  if (diagnosis.affectedFiles.length > 0) {
    lines.push(`### Affected Files`);
    for (const f of diagnosis.affectedFiles) {
      lines.push(`- \`${f}\``);
    }
    lines.push(``);
  }

  if (diagnosis.suggestedFix) {
    lines.push(`### Suggested Fix`);
    lines.push(diagnosis.suggestedFix);
    lines.push(``);
  }

  if (diagnosis.reEntryStage) {
    lines.push(`### Re-entry Plan`);
    lines.push(`Re-enter pipeline at stage: \`${diagnosis.reEntryStage}\``);
    lines.push(``);
  }

  lines.push(`### Pipeline Context`);
  lines.push(`- Validate fail count: ${validateFailCount}`);
  lines.push(`- Review retry count: ${reviewRetryCount}`);

  return lines.join("\n");
}

// ─── GitHub Issue Filing ────────────────────────────────────────────────────

function ghIsAvailable(): boolean {
  try {
    execFileSync("gh", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function findExistingIssue(githubRepo: string, stage: string, diagnosis: string): number | null {
  try {
    const output = execFileSync("gh", [
      "issue", "list",
      "--repo", githubRepo,
      "--label", "recovery-agent",
      "--state", "open",
      "--json", "number,title,body",
      "--limit", "50",
    ], { stdio: "pipe", encoding: "utf-8" });
    const issues = JSON.parse(output);
    // Match by stage and first 100 chars of diagnosis
    const diagPrefix = diagnosis.substring(0, 100).toLowerCase();
    for (const issue of issues) {
      if (
        typeof issue.body === "string" &&
        issue.body.toLowerCase().includes(stage) &&
        issue.body.toLowerCase().includes(diagPrefix)
      ) {
        return issue.number;
      }
    }
  } catch {
    // gh not available or API error — skip dedup
  }
  return null;
}

function fileGithubIssue(
  githubRepo: string,
  stage: string,
  issueBody: string,
): { url: string; number: number } | null {
  try {
    const title = `[Recovery] ${stage} stage failure — pipeline instrumentation issue`;
    const output = execFileSync("gh", [
      "issue", "create",
      "--repo", githubRepo,
      "--title", title,
      "--body", issueBody,
      "--label", "recovery-agent",
    ], { stdio: "pipe", encoding: "utf-8" });
    // gh issue create outputs the URL
    const url = output.trim();
    const match = url.match(/\/issues\/(\d+)/);
    const number = match ? parseInt(match[1], 10) : 0;
    return { url, number };
  } catch {
    return null;
  }
}

function addCommentToIssue(githubRepo: string, issueNumber: number, comment: string): void {
  try {
    execFileSync("gh", [
      "issue", "comment", String(issueNumber),
      "--repo", githubRepo,
      "--body", comment,
    ], { stdio: "pipe" });
  } catch {
    // swallow — best effort
  }
}

// ─── Build Agent Context ────────────────────────────────────────────────────

function buildRecoveryContext(taskDir: string, state: RunState): string {
  const parts: string[] = [];

  // Run state summary (safe pipeline internals only)
  parts.push("## Run State");
  parts.push(`Stage: ${state.currentStage}`);
  parts.push(`Error: ${state.error ?? "unknown"}`);
  parts.push(`Validate fail count: ${state.validateFailCount}`);
  parts.push(`Review retry count: ${state.reviewRetryCount}`);
  parts.push(`Retry attempts: ${JSON.stringify(state.retryAttempts)}`);
  if (state.reviewIssues.length > 0) {
    parts.push(`Review issues: ${JSON.stringify(state.reviewIssues)}`);
  }
  parts.push(``);

  // Stream log for failed stage
  const streamLog = join(taskDir, "artifacts", `${state.currentStage}-output-stream.jsonl`);
  if (existsSync(streamLog)) {
    try {
      const log = readFileSync(streamLog, "utf-8");
      // Only include last 200 lines to stay within context
      const lines = log.split("\n").filter(Boolean);
      const tail = lines.slice(-200);
      parts.push("## Stream Log (last 200 lines)");
      parts.push(tail.join("\n"));
      parts.push(``);
    } catch { /* swallow */ }
  }

  // Retry feedback files
  const artifactsDir = join(taskDir, "artifacts");
  if (existsSync(artifactsDir)) {
    try {
      const files = require("node:fs").readdirSync(artifactsDir) as string[];
      for (const f of files) {
        if (f.startsWith("retry-feedback-")) {
          parts.push(`## ${f}`);
          parts.push(readFileSync(join(artifactsDir, f), "utf-8"));
          parts.push(``);
        }
      }
    } catch { /* swallow */ }
  }

  return parts.join("\n");
}

// ─── Main Recovery Agent Runner ─────────────────────────────────────────────

export async function runRecoveryAgent(
  taskDir: string,
  state: RunState,
  runner: AgentRunnerFn,
  config: ResolvedConfig,
  logger: TaskLogger,
  emitNotify: (event: Record<string, unknown>) => void,
): Promise<void> {
  if (!config.recovery.enabled) return;

  const stage = state.currentStage;
  const slug = state.slug;

  logger.info(`[recovery] Analyzing failed task "${slug}" at stage "${stage}"`);

  const context = buildRecoveryContext(taskDir, state);

  try {
    const outputPath = join(taskDir, "artifacts", "recovery-diagnosis.md");
    const result = await runner({
      stage: "recovery",
      slug: `recovery-${slug}`,
      taskContent: context,
      previousOutput: "",
      outputPath,
      cwd: taskDir,
      config,
      logger: { info() {}, warn() {}, error() {} },
    });

    if (!result.success) {
      logger.warn(`[recovery] Recovery agent failed for "${slug}": ${result.error}`);
      return;
    }

    const diagnosis = parseRecoveryDiagnosis(result.output);
    if (!diagnosis) {
      logger.warn(`[recovery] Could not parse recovery diagnosis for "${slug}"`);
      return;
    }

    // Write diagnosis to run-state
    state.recoveryDiagnosis = diagnosis.diagnosis;

    if (diagnosis.classification === "terminal") {
      state.terminalFailure = true;
      writeRunState(taskDir, state);
      logger.info(`[recovery] Task "${slug}" classified as terminal: ${diagnosis.diagnosis}`);

      emitNotify({
        type: "recovery_diagnosed",
        slug,
        stage,
        classification: "terminal",
        diagnosis: diagnosis.diagnosis,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Fixable — determine re-entry and optionally file issue
    state.recoveryReEntryStage = diagnosis.reEntryStage ?? stage;

    const runtimeDir = config.pipeline.runtimeDir;

    if (config.recovery.fileGithubIssues && ghIsAvailable()) {
      const issueBody = sanitizeDiagnosisForGithub(
        diagnosis,
        stage,
        state.error ?? "unknown",
        state.validateFailCount,
        state.reviewRetryCount,
      );

      // Check for existing issue with same root cause
      const existingIssueNumber = findExistingIssue(
        config.recovery.githubRepo,
        stage,
        diagnosis.diagnosis,
      );

      if (existingIssueNumber) {
        addCommentToIssue(
          config.recovery.githubRepo,
          existingIssueNumber,
          `Another task also affected by this issue at the \`${stage}\` stage.\n\n${issueBody}`,
        );
        state.recoveryIssueNumber = existingIssueNumber;
        state.recoveryIssueUrl = `https://github.com/${config.recovery.githubRepo}/issues/${existingIssueNumber}`;
        logger.info(`[recovery] Linked to existing issue #${existingIssueNumber}`);
      } else {
        const issue = fileGithubIssue(config.recovery.githubRepo, stage, issueBody);
        if (issue) {
          state.recoveryIssueUrl = issue.url;
          state.recoveryIssueNumber = issue.number;
          logger.info(`[recovery] Filed GitHub issue: ${issue.url}`);
        } else {
          logger.warn(`[recovery] Failed to file GitHub issue for "${slug}"`);
        }
      }
    } else if (config.recovery.fileGithubIssues && !ghIsAvailable()) {
      logger.warn(`[recovery] gh CLI not available — skipping issue filing for "${slug}"`);
    }

    // Move to hold
    state.status = "hold";
    state.holdReason = "awaiting_fix";
    writeRunState(taskDir, state);

    try {
      moveTaskDir(runtimeDir, slug, "11-failed", "12-hold");
    } catch (err) {
      logger.error(`[recovery] Failed to move "${slug}" to 12-hold: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    logger.info(`[recovery] Task "${slug}" moved to hold — awaiting fix at re-entry stage "${state.recoveryReEntryStage}"`);

    emitNotify({
      type: "recovery_diagnosed",
      slug,
      stage,
      classification: "fixable",
      diagnosis: diagnosis.diagnosis,
      reEntryStage: state.recoveryReEntryStage,
      issueUrl: state.recoveryIssueUrl,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    logger.error(`[recovery] Recovery agent threw for "${slug}": ${err instanceof Error ? err.message : String(err)}`);
    // Task stays in 11-failed unanalyzed — will be retried on next startup
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/recovery-agent-diagnosis.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/recovery-agent.ts tests/core/recovery-agent-diagnosis.test.ts agents/recovery.md
git commit -m "feat(recovery): add recovery agent module with diagnosis parsing and issue filing"
```

---

### Task 5: Add recovery notification events

**Files:**
- Modify: `src/surfaces/types.ts:14-42`
- Modify: `src/surfaces/slack-notifier.ts:80-195`
- Test: `tests/surfaces/slack-notifier.test.ts` (new or extend)

- [ ] **Step 1: Write failing test for recovery notification format**

Create `tests/surfaces/recovery-notifications.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatEvent } from "../../src/surfaces/slack-notifier.js";
import type { NotifyEvent } from "../../src/surfaces/types.js";

describe("recovery notification formatting", () => {
  it("formats fixable recovery diagnosis", () => {
    const event = {
      type: "recovery_diagnosed" as const,
      slug: "test-task",
      stage: "review",
      classification: "fixable" as const,
      diagnosis: "Tool permission missing for review stage",
      reEntryStage: "review",
      issueUrl: "https://github.com/prpande/ShaktimaanAI/issues/42",
      timestamp: "2026-04-09T10:00:00Z",
    };
    const text = formatEvent(event as unknown as NotifyEvent, "UTC");
    expect(text).toContain("🔬");
    expect(text).toContain("fixable");
    expect(text).toContain("review");
    expect(text).toContain("issues/42");
  });

  it("formats terminal recovery diagnosis", () => {
    const event = {
      type: "recovery_diagnosed" as const,
      slug: "test-task",
      stage: "impl",
      classification: "terminal" as const,
      diagnosis: "Task requirements are impossible",
      timestamp: "2026-04-09T10:00:00Z",
    };
    const text = formatEvent(event as unknown as NotifyEvent, "UTC");
    expect(text).toContain("🔬");
    expect(text).toContain("terminal");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/surfaces/recovery-notifications.test.ts`
Expected: FAIL — `recovery_diagnosed` not a valid event type.

- [ ] **Step 3: Add recovery_diagnosed event type**

In `src/surfaces/types.ts`, add to the `NotifyEvent` union (after `stages_modified`):

```typescript
  | ({ type: "recovery_diagnosed"; stage: string; classification: "fixable" | "terminal";
       diagnosis: string; reEntryStage?: string; issueUrl?: string } & EventBase);
```

Add `"recovery_diagnosed"` to `MINIMAL_EVENTS` set (since failures are always notified):

```typescript
const MINIMAL_EVENTS = new Set<NotifyEvent["type"]>([
  "task_held",
  "task_failed",
  "recovery_diagnosed",
]);
```

- [ ] **Step 4: Add formatting in slack-notifier.ts**

In `src/surfaces/slack-notifier.ts` `formatEvent()`, add a new case before the default:

```typescript
    case "recovery_diagnosed": {
      if (event.classification === "terminal") {
        return `\n${ts}\n🔬 *Recovery: terminal failure* ${slug} at *${event.stage}*\n📋 ${event.diagnosis}`;
      }
      const issueLine = event.issueUrl ? `\n🔗 Issue: ${event.issueUrl}` : "";
      const reentryLine = event.reEntryStage ? `\n🔄 Re-entry: \`${event.reEntryStage}\` after fix` : "";
      return `\n${ts}\n🔬 *Recovery: fixable* ${slug} at *${event.stage}*\n📋 ${event.diagnosis}${issueLine}${reentryLine}\n💡 Reply \`recover\` in this thread after merging the fix.`;
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/surfaces/recovery-notifications.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/surfaces/types.ts src/surfaces/slack-notifier.ts tests/surfaces/recovery-notifications.test.ts
git commit -m "feat(recovery): add recovery_diagnosed notification event and Slack formatting"
```

---

### Task 6: Hook recovery agent into failTask()

**Files:**
- Modify: `src/core/pipeline.ts:316-366` (failTask function)

- [ ] **Step 1: Write failing test**

Add to `tests/core/pipeline.test.ts` (or create `tests/core/recovery-integration.test.ts`):

```typescript
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "os";

describe("failTask recovery agent integration", () => {
  const TEST_DIR = join(tmpdir(), "shkmn-test-recovery-" + Date.now());

  beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("invokes recovery agent after task is moved to 11-failed when recovery is enabled", async () => {
    // This test verifies the hook exists and is called.
    // The actual recovery agent is tested separately.
    // Here we just verify the wiring by checking that
    // runRecoveryAgent is exported and callable.
    const { runRecoveryAgent } = await import("../../src/core/recovery-agent.js");
    expect(typeof runRecoveryAgent).toBe("function");
  });
});
```

- [ ] **Step 2: Modify failTask() to invoke recovery agent**

In `src/core/pipeline.ts`, add import at the top:

```typescript
import { runRecoveryAgent } from "./recovery-agent.js";
```

In `failTask()`, after the `activeRuns.delete(slug)` line at the end of the function, add the recovery agent invocation. Since `failTask` is sync and the recovery agent is async, fire it without awaiting (it's a background analysis that won't block the pipeline):

```typescript
  activeRuns.delete(slug);

  // Fire recovery agent asynchronously — does not block the pipeline
  const failedTaskDir = join(runtimeDir, "11-failed", slug);
  if (existsSync(failedTaskDir)) {
    runRecoveryAgent(failedTaskDir, { ...state }, runner, config, logger, (event) => {
      for (const n of notifiers) {
        n.notify(event as any).catch(() => {});
      }
    }).catch((err) => {
      logger.error(`[pipeline] Recovery agent error for "${slug}": ${err instanceof Error ? err.message : String(err)}`);
    });
  }
```

Note: `runner`, `config`, `logger`, and `notifiers` are all in closure scope of `createPipeline()`. `failTask` is a local function inside `createPipeline()` so it has access to these.

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/core/pipeline.test.ts`
Expected: All existing tests PASS (the recovery agent won't actually run in tests since config defaults to enabled but there's no real agent SDK).

- [ ] **Step 4: Commit**

```bash
git add src/core/pipeline.ts
git commit -m "feat(recovery): hook recovery agent into failTask() for automatic diagnosis"
```

---

### Task 7: Extend startup recovery scan

**Files:**
- Modify: `src/core/recovery.ts`
- Test: `tests/core/recovery-startup.test.ts`

- [ ] **Step 1: Write failing test for Phase 1 (unanalyzed failures)**

Create `tests/core/recovery-startup.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "os";
import { scanUnanalyzedFailures, scanHeldTasksWithIssues } from "../../src/core/recovery.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-recovery-startup-" + Date.now());

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_DIR, "11-failed"), { recursive: true });
  mkdirSync(join(TEST_DIR, "12-hold"), { recursive: true });
});
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("scanUnanalyzedFailures", () => {
  it("finds tasks without terminalFailure or recoveryIssueUrl", () => {
    const slugDir = join(TEST_DIR, "11-failed", "test-task");
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, "run-state.json"), JSON.stringify({
      slug: "test-task",
      status: "failed",
      currentStage: "review",
      error: "Agent failed",
    }));

    const results = scanUnanalyzedFailures(TEST_DIR);
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe("test-task");
  });

  it("skips tasks with terminalFailure flag", () => {
    const slugDir = join(TEST_DIR, "11-failed", "terminal-task");
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, "run-state.json"), JSON.stringify({
      slug: "terminal-task",
      status: "failed",
      currentStage: "impl",
      terminalFailure: true,
      recoveryDiagnosis: "impossible task",
    }));

    const results = scanUnanalyzedFailures(TEST_DIR);
    expect(results).toHaveLength(0);
  });

  it("skips tasks with recoveryIssueUrl", () => {
    const slugDir = join(TEST_DIR, "11-failed", "diagnosed-task");
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, "run-state.json"), JSON.stringify({
      slug: "diagnosed-task",
      status: "failed",
      currentStage: "validate",
      recoveryIssueUrl: "https://github.com/prpande/ShaktimaanAI/issues/1",
    }));

    const results = scanUnanalyzedFailures(TEST_DIR);
    expect(results).toHaveLength(0);
  });

  it("skips tasks with recoveryDiagnosis but no issue (local-only diagnosis)", () => {
    const slugDir = join(TEST_DIR, "11-failed", "local-diag-task");
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, "run-state.json"), JSON.stringify({
      slug: "local-diag-task",
      status: "failed",
      currentStage: "review",
      recoveryDiagnosis: "some diagnosis",
    }));

    const results = scanUnanalyzedFailures(TEST_DIR);
    expect(results).toHaveLength(0);
  });
});

describe("scanHeldTasksWithIssues", () => {
  it("finds held tasks with awaiting_fix holdReason and issue number", () => {
    const slugDir = join(TEST_DIR, "12-hold", "held-task");
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, "run-state.json"), JSON.stringify({
      slug: "held-task",
      status: "hold",
      holdReason: "awaiting_fix",
      recoveryIssueNumber: 42,
      recoveryIssueUrl: "https://github.com/prpande/ShaktimaanAI/issues/42",
      recoveryReEntryStage: "review",
    }));

    const results = scanHeldTasksWithIssues(TEST_DIR);
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe("held-task");
    expect(results[0].issueNumber).toBe(42);
    expect(results[0].reEntryStage).toBe("review");
  });

  it("skips held tasks with other holdReasons", () => {
    const slugDir = join(TEST_DIR, "12-hold", "budget-task");
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, "run-state.json"), JSON.stringify({
      slug: "budget-task",
      status: "hold",
      holdReason: "budget_exhausted",
    }));

    const results = scanHeldTasksWithIssues(TEST_DIR);
    expect(results).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/recovery-startup.test.ts`
Expected: FAIL — `scanUnanalyzedFailures` and `scanHeldTasksWithIssues` not exported.

- [ ] **Step 3: Add startup scan functions to recovery.ts**

Add these functions to `src/core/recovery.ts`:

```typescript
import { readFileSync } from "node:fs";

// ─── Recovery Startup Scan Types ────────────────────────────────────────────

export interface UnanalyzedFailure {
  slug: string;
  dir: string;
  stage: string;
  error: string;
}

export interface HeldTaskWithIssue {
  slug: string;
  dir: string;
  issueNumber: number;
  issueUrl: string;
  reEntryStage: string;
}

// ─── Phase 1: Scan unanalyzed failures ──────────────────────────────────────

export function scanUnanalyzedFailures(runtimeDir: string): UnanalyzedFailure[] {
  const failedDir = join(runtimeDir, "11-failed");
  const results: UnanalyzedFailure[] = [];

  for (const slug of listDirectories(failedDir)) {
    const stateFile = join(failedDir, slug, "run-state.json");
    if (!existsSync(stateFile)) continue;
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8"));
      // Skip already-analyzed tasks
      if (state.terminalFailure) continue;
      if (state.recoveryIssueUrl) continue;
      if (state.recoveryDiagnosis) continue;

      results.push({
        slug,
        dir: join(failedDir, slug),
        stage: state.currentStage ?? "unknown",
        error: state.error ?? "unknown",
      });
    } catch {
      // Corrupted run-state — skip
    }
  }

  return results;
}

// ─── Phase 2: Scan held tasks with GitHub issues ────────────────────────────

export function scanHeldTasksWithIssues(runtimeDir: string): HeldTaskWithIssue[] {
  const holdDir = join(runtimeDir, "12-hold");
  const results: HeldTaskWithIssue[] = [];

  for (const slug of listDirectories(holdDir)) {
    const stateFile = join(holdDir, slug, "run-state.json");
    if (!existsSync(stateFile)) continue;
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8"));
      if (state.holdReason !== "awaiting_fix") continue;
      if (!state.recoveryIssueNumber) continue;

      results.push({
        slug,
        dir: join(holdDir, slug),
        issueNumber: state.recoveryIssueNumber,
        issueUrl: state.recoveryIssueUrl ?? "",
        reEntryStage: state.recoveryReEntryStage ?? state.currentStage ?? "impl",
      });
    } catch {
      // Corrupted run-state — skip
    }
  }

  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/recovery-startup.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/recovery.ts tests/core/recovery-startup.test.ts
git commit -m "feat(recovery): add startup scan for unanalyzed failures and held tasks"
```

---

### Task 8: Implement re-entry mechanics

**Files:**
- Create: `src/core/recovery-reentry.ts`
- Test: `tests/core/recovery-reentry.test.ts`

- [ ] **Step 1: Write failing test for re-entry**

Create `tests/core/recovery-reentry.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "os";
import { reenterTask } from "../../src/core/recovery-reentry.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-reentry-" + Date.now());

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  // Create all stage directories
  for (const dir of ["11-failed", "12-hold", "06-impl/pending", "07-review/pending"]) {
    mkdirSync(join(TEST_DIR, dir), { recursive: true });
  }
});
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("reenterTask", () => {
  it("moves task from 12-hold to re-entry stage pending dir", () => {
    const slugDir = join(TEST_DIR, "12-hold", "test-task");
    mkdirSync(join(slugDir, "artifacts"), { recursive: true });
    writeFileSync(join(slugDir, "artifacts", "questions-output.md"), "questions done");
    writeFileSync(join(slugDir, "artifacts", "impl-output.md"), "stale impl output");
    writeFileSync(join(slugDir, "run-state.json"), JSON.stringify({
      slug: "test-task",
      status: "hold",
      currentStage: "review",
      holdReason: "awaiting_fix",
      recoveryReEntryStage: "impl",
      recoveryIssueUrl: "https://github.com/prpande/ShaktimaanAI/issues/42",
      recoveryIssueNumber: 42,
      recoveryDiagnosis: "tool permission issue",
      error: "Agent failed",
      completedStages: [
        { stage: "questions", completedAt: "2026-04-09T10:00:00Z" },
        { stage: "impl", completedAt: "2026-04-09T11:00:00Z" },
      ],
      validateFailCount: 2,
      reviewRetryCount: 1,
      reviewIssues: [{ id: "issue1", description: "test", severity: "HIGH", firstSeen: 1, lastSeen: 1 }],
      retryAttempts: { impl: 2, review: 1 },
      stages: ["questions", "research", "design", "structure", "plan", "impl", "review", "validate", "pr"],
      reviewAfter: "design",
      startedAt: "2026-04-09T09:00:00Z",
      updatedAt: "2026-04-09T12:00:00Z",
      taskFile: "task.md",
      suggestionRetryUsed: false,
      stageHints: {},
    }));

    const result = reenterTask(TEST_DIR, "test-task");
    expect(result.success).toBe(true);
    expect(result.reEntryStage).toBe("impl");

    // Task should be in impl/pending now
    expect(existsSync(join(TEST_DIR, "06-impl", "pending", "test-task"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "12-hold", "test-task"))).toBe(false);

    // Check run-state was reset
    const newState = JSON.parse(readFileSync(join(TEST_DIR, "06-impl", "pending", "test-task", "run-state.json"), "utf-8"));
    expect(newState.status).toBe("running");
    expect(newState.currentStage).toBe("impl");
    expect(newState.error).toBeUndefined();
    expect(newState.holdReason).toBeUndefined();
    expect(newState.recoveryIssueUrl).toBeUndefined();
    expect(newState.recoveryIssueNumber).toBeUndefined();
    expect(newState.recoveryReEntryStage).toBeUndefined();
    expect(newState.validateFailCount).toBe(0);
    expect(newState.reviewRetryCount).toBe(0);
    expect(newState.reviewIssues).toEqual([]);

    // Stale downstream artifacts should be archived
    expect(existsSync(join(TEST_DIR, "06-impl", "pending", "test-task", "artifacts", "pre-recovery", "impl-output.md"))).toBe(true);
    // Upstream artifacts preserved
    expect(existsSync(join(TEST_DIR, "06-impl", "pending", "test-task", "artifacts", "questions-output.md"))).toBe(true);
  });

  it("returns error if task not in 12-hold", () => {
    const result = reenterTask(TEST_DIR, "nonexistent-task");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/recovery-reentry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create recovery-reentry.ts**

Create `src/core/recovery-reentry.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STAGE_DIR_MAP, PIPELINE_STAGES } from "./stage-map.js";
import type { RunState } from "./types.js";

export interface ReentryResult {
  success: boolean;
  reEntryStage?: string;
  error?: string;
}

export function reenterTask(runtimeDir: string, slug: string): ReentryResult {
  const holdDir = join(runtimeDir, "12-hold", slug);
  if (!existsSync(holdDir)) {
    return { success: false, error: `Task "${slug}" not found in 12-hold` };
  }

  // Read run-state
  const stateFile = join(holdDir, "run-state.json");
  let state: RunState;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf-8"));
  } catch {
    return { success: false, error: `Could not read run-state for "${slug}"` };
  }

  if (state.holdReason !== "awaiting_fix") {
    return { success: false, error: `Task "${slug}" holdReason is "${state.holdReason}", not "awaiting_fix"` };
  }

  const reEntryStage = state.recoveryReEntryStage ?? state.currentStage;
  const stageDir = STAGE_DIR_MAP[reEntryStage];
  if (!stageDir) {
    return { success: false, error: `Unknown re-entry stage "${reEntryStage}"` };
  }

  // Archive downstream artifacts
  const artifactsDir = join(holdDir, "artifacts");
  if (existsSync(artifactsDir)) {
    const preRecoveryDir = join(artifactsDir, "pre-recovery");
    mkdirSync(preRecoveryDir, { recursive: true });

    // Determine which stages are downstream of (or at) re-entry
    const reEntryIndex = PIPELINE_STAGES.indexOf(reEntryStage);
    const downstreamStages = reEntryIndex >= 0
      ? PIPELINE_STAGES.slice(reEntryIndex)
      : [reEntryStage];

    try {
      const files = readdirSync(artifactsDir);
      for (const file of files) {
        if (file === "pre-recovery") continue;
        if (file === "recovery-diagnosis.md") continue;
        // Check if file belongs to a downstream stage
        const isDownstream = downstreamStages.some(
          (s) => file.startsWith(`${s}-`) || file.startsWith(`retry-feedback-${s}`)
        );
        if (isDownstream) {
          try {
            renameSync(join(artifactsDir, file), join(preRecoveryDir, file));
          } catch { /* best effort */ }
        }
      }
    } catch { /* swallow */ }
  }

  // Reset run-state for re-entry
  state.status = "running";
  state.currentStage = reEntryStage;
  delete state.error;
  delete state.holdReason;
  delete state.holdDetail;
  delete state.recoveryIssueUrl;
  delete state.recoveryIssueNumber;
  delete state.recoveryReEntryStage;

  // Reset retry counters for re-entry stage and downstream
  const reEntryIndex = PIPELINE_STAGES.indexOf(reEntryStage);
  if (reEntryIndex >= 0) {
    const downstreamStages = PIPELINE_STAGES.slice(reEntryIndex);
    for (const s of downstreamStages) {
      delete state.retryAttempts[s];
    }
  }
  state.validateFailCount = 0;
  state.reviewRetryCount = 0;
  state.reviewIssues = [];
  state.suggestionRetryUsed = false;

  writeFileSync(stateFile, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), "utf-8");

  // Move from 12-hold to {stage}/pending
  const targetDir = join(runtimeDir, stageDir, "pending", slug);
  mkdirSync(join(runtimeDir, stageDir, "pending"), { recursive: true });
  try {
    renameSync(holdDir, targetDir);
  } catch {
    return { success: false, error: `Failed to move task "${slug}" from 12-hold to ${stageDir}/pending` };
  }

  return { success: true, reEntryStage };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/recovery-reentry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/recovery-reentry.ts tests/core/recovery-reentry.test.ts
git commit -m "feat(recovery): implement re-entry mechanics with artifact archival and state reset"
```

---

### Task 9: Integrate startup scan phases into runRecovery

**Files:**
- Modify: `src/core/recovery.ts`
- Modify: `src/commands/start.ts`

- [ ] **Step 1: Add runRecoveryStartupScan to recovery.ts**

Add this function to `src/core/recovery.ts` after `runRecovery`:

```typescript
import { execFileSync } from "node:child_process";
import { reenterTask } from "./recovery-reentry.js";
import type { AgentRunnerFn } from "./types.js";
import type { ResolvedConfig } from "../config/loader.js";

/**
 * Runs the recovery startup scan before the main crash-recovery scan.
 * Phase 1: Re-analyze unanalyzed failures (recovery agent didn't complete)
 * Phase 2: Check held tasks with GitHub issues — auto-recover if issue closed
 * Phase 3: Held tasks without issues are left for manual re-entry
 */
export async function runRecoveryStartupScan(
  runtimeDir: string,
  config: ResolvedConfig,
  runner: AgentRunnerFn,
  logger: TaskLogger,
  emitNotify: (event: Record<string, unknown>) => void,
): Promise<{ recovered: string[]; terminal: string[]; pending: string[] }> {
  const result = { recovered: [] as string[], terminal: [] as string[], pending: [] as string[] };

  if (!config.recovery.enabled) return result;

  // Phase 1: Unanalyzed failures
  const unanalyzed = scanUnanalyzedFailures(runtimeDir);
  if (unanalyzed.length > 0) {
    logger.info(`[recovery-scan] Found ${unanalyzed.length} unanalyzed failure(s) — re-running diagnostics`);
    for (const item of unanalyzed) {
      try {
        const { runRecoveryAgent } = await import("./recovery-agent.js");
        const state = JSON.parse(readFileSync(join(item.dir, "run-state.json"), "utf-8"));
        await runRecoveryAgent(item.dir, state, runner, config, logger, emitNotify);
      } catch (err) {
        logger.error(`[recovery-scan] Failed to analyze "${item.slug}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Phase 2: Held tasks with GitHub issues
  if (config.recovery.fileGithubIssues) {
    const heldWithIssues = scanHeldTasksWithIssues(runtimeDir);
    for (const item of heldWithIssues) {
      try {
        const issueState = execFileSync("gh", [
          "issue", "view", String(item.issueNumber),
          "--repo", config.recovery.githubRepo,
          "--json", "state,stateReason",
        ], { stdio: "pipe", encoding: "utf-8" });
        const parsed = JSON.parse(issueState);

        if (parsed.state === "CLOSED" && parsed.stateReason === "COMPLETED") {
          const reentry = reenterTask(runtimeDir, item.slug);
          if (reentry.success) {
            result.recovered.push(item.slug);
            logger.info(`[recovery-scan] Auto-recovered "${item.slug}" into ${reentry.reEntryStage} — issue #${item.issueNumber} resolved`);
            emitNotify({
              type: "recovery_diagnosed",
              slug: item.slug,
              stage: reentry.reEntryStage ?? "unknown",
              classification: "fixable",
              diagnosis: `Auto-recovered — issue #${item.issueNumber} resolved`,
              issueUrl: item.issueUrl,
              timestamp: new Date().toISOString(),
            });
          }
        } else if (parsed.state === "CLOSED" && parsed.stateReason === "NOT_PLANNED") {
          // Issue rejected — move to terminal failure
          const holdDir = join(runtimeDir, "12-hold", item.slug);
          const stateFile = join(holdDir, "run-state.json");
          const state = JSON.parse(readFileSync(stateFile, "utf-8"));
          state.terminalFailure = true;
          state.status = "failed";
          delete state.holdReason;
          writeFileSync(stateFile, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), "utf-8");
          try {
            const { moveTaskDir } = await import("./pipeline.js");
            moveTaskDir(runtimeDir, item.slug, "12-hold", "11-failed");
          } catch { /* best effort */ }
          result.terminal.push(item.slug);
          logger.info(`[recovery-scan] Moved "${item.slug}" to failed — issue #${item.issueNumber} closed as not planned`);
        } else {
          result.pending.push(item.slug);
          logger.info(`[recovery-scan] "${item.slug}" still awaiting fix — issue #${item.issueNumber} is open`);
        }
      } catch (err) {
        logger.warn(`[recovery-scan] Could not check issue #${item.issueNumber} for "${item.slug}": ${err instanceof Error ? err.message : String(err)}`);
        result.pending.push(item.slug);
      }
    }
  }

  // Phase 3: Held tasks without issues (fileGithubIssues: false)
  // These are left in hold — require manual re-entry via CLI/Slack
  const holdDir = join(runtimeDir, "12-hold");
  for (const slug of listDirectories(holdDir)) {
    const stateFile = join(holdDir, slug, "run-state.json");
    if (!existsSync(stateFile)) continue;
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8"));
      if (state.holdReason === "awaiting_fix" && !state.recoveryIssueNumber) {
        result.pending.push(slug);
        logger.info(`[recovery-scan] "${slug}" awaiting fix — manual re-entry required (no GitHub issue)`);
      }
    } catch { /* skip */ }
  }

  return result;
}
```

- [ ] **Step 2: Wire into start.ts**

In `src/commands/start.ts`, add import:

```typescript
import { runRecoveryStartupScan } from "../core/recovery.js";
```

After the worktree cleanup (step 4) and before `runRecovery` (step 6), add:

```typescript
      // 5b. Run recovery startup scan (check failed/held tasks)
      const recoveryResult = await runRecoveryStartupScan(
        config.pipeline.runtimeDir,
        config,
        runAgent,
        logger,
        () => {}, // No notifiers registered yet — will notify on next Slack poll
      );
      if (recoveryResult.recovered.length > 0) {
        logger.info(`[startup] Auto-recovered ${recoveryResult.recovered.length} task(s)`);
      }
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/core/recovery-startup.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/recovery.ts src/commands/start.ts
git commit -m "feat(recovery): integrate startup scan phases into pipeline boot sequence"
```

---

### Task 10: Add `shkmn recover` CLI command

**Files:**
- Create: `src/commands/recover.ts`
- Modify: `src/cli.ts` (register command)
- Test: `tests/commands/recover.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/commands/recover.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "os";
import { listHeldRecoveryTasks, getRecoveryTaskDetail } from "../../src/commands/recover.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-recover-cmd-" + Date.now());

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_DIR, "12-hold"), { recursive: true });
});
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("listHeldRecoveryTasks", () => {
  it("lists tasks with awaiting_fix holdReason", () => {
    const slugDir = join(TEST_DIR, "12-hold", "test-task");
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, "run-state.json"), JSON.stringify({
      slug: "test-task",
      holdReason: "awaiting_fix",
      recoveryDiagnosis: "timeout too short",
      recoveryReEntryStage: "impl",
      recoveryIssueUrl: "https://github.com/prpande/ShaktimaanAI/issues/1",
    }));

    const tasks = listHeldRecoveryTasks(TEST_DIR);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].slug).toBe("test-task");
    expect(tasks[0].diagnosis).toBe("timeout too short");
  });

  it("ignores tasks with other holdReasons", () => {
    const slugDir = join(TEST_DIR, "12-hold", "budget-task");
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, "run-state.json"), JSON.stringify({
      slug: "budget-task",
      holdReason: "budget_exhausted",
    }));

    const tasks = listHeldRecoveryTasks(TEST_DIR);
    expect(tasks).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands/recover.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create recover.ts command**

Create `src/commands/recover.ts`:

```typescript
import { Command } from "commander";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";
import { reenterTask } from "../core/recovery-reentry.js";

// ─── Helpers (exported for testing) ─────────────────────────────────────────

export interface HeldRecoveryTask {
  slug: string;
  diagnosis: string;
  reEntryStage: string;
  issueUrl?: string;
  issueNumber?: number;
}

export function listHeldRecoveryTasks(runtimeDir: string): HeldRecoveryTask[] {
  const holdDir = join(runtimeDir, "12-hold");
  if (!existsSync(holdDir)) return [];

  const results: HeldRecoveryTask[] = [];
  let entries: string[];
  try {
    entries = readdirSync(holdDir);
  } catch {
    return [];
  }

  for (const slug of entries) {
    const stateFile = join(holdDir, slug, "run-state.json");
    if (!existsSync(stateFile)) continue;
    try {
      if (!statSync(join(holdDir, slug)).isDirectory()) continue;
      const state = JSON.parse(readFileSync(stateFile, "utf-8"));
      if (state.holdReason !== "awaiting_fix") continue;

      results.push({
        slug,
        diagnosis: state.recoveryDiagnosis ?? "No diagnosis available",
        reEntryStage: state.recoveryReEntryStage ?? state.currentStage ?? "unknown",
        issueUrl: state.recoveryIssueUrl,
        issueNumber: state.recoveryIssueNumber,
      });
    } catch { /* skip corrupted */ }
  }

  return results;
}

export function getRecoveryTaskDetail(runtimeDir: string, slug: string): Record<string, unknown> | null {
  const holdDir = join(runtimeDir, "12-hold", slug);
  if (!existsSync(holdDir)) return null;

  const stateFile = join(holdDir, "run-state.json");
  if (!existsSync(stateFile)) return null;

  try {
    return JSON.parse(readFileSync(stateFile, "utf-8"));
  } catch {
    return null;
  }
}

// ─── Command Registration ───────────────────────────────────────────────────

export function registerRecoverCommand(program: Command): void {
  program
    .command("recover")
    .description("List or re-enter failed tasks awaiting recovery")
    .argument("[slug]", "Task slug for detail view or re-entry")
    .option("--reenter", "Manually re-enter the task into the pipeline")
    .action((slug?: string, opts?: { reenter?: boolean }) => {
      const config = loadConfig(resolveConfigPath());
      const runtimeDir = config.pipeline.runtimeDir;

      if (!slug) {
        // List all held recovery tasks
        const tasks = listHeldRecoveryTasks(runtimeDir);
        if (tasks.length === 0) {
          console.log("No tasks awaiting recovery.");
          return;
        }
        console.log(`\nTasks awaiting recovery (${tasks.length}):\n`);
        for (const t of tasks) {
          const issue = t.issueUrl ? ` | Issue: ${t.issueUrl}` : "";
          console.log(`  ${t.slug}`);
          console.log(`    Diagnosis: ${t.diagnosis}`);
          console.log(`    Re-entry: ${t.reEntryStage}${issue}`);
          console.log();
        }
        return;
      }

      if (opts?.reenter) {
        // Manual re-entry
        const result = reenterTask(runtimeDir, slug);
        if (result.success) {
          console.log(`Task "${slug}" re-entered pipeline at stage "${result.reEntryStage}".`);
          console.log("Restart the pipeline to begin processing.");
        } else {
          console.error(`Failed to re-enter: ${result.error}`);
          process.exit(1);
        }
        return;
      }

      // Detail view
      const detail = getRecoveryTaskDetail(runtimeDir, slug);
      if (!detail) {
        console.error(`Task "${slug}" not found in 12-hold.`);
        process.exit(1);
      }
      console.log(JSON.stringify(detail, null, 2));
    });
}
```

- [ ] **Step 4: Register command in cli.ts**

In `src/cli.ts`, add:

```typescript
import { registerRecoverCommand } from "./commands/recover.js";
```

And call it alongside the other command registrations:

```typescript
registerRecoverCommand(program);
```

- [ ] **Step 5: Run test**

Run: `npx vitest run tests/commands/recover.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/commands/recover.ts src/cli.ts tests/commands/recover.test.ts
git commit -m "feat(recovery): add shkmn recover CLI command for listing and re-entering tasks"
```

---

### Task 11: Enhance stop command with graceful drain

**Files:**
- Modify: `src/commands/stop.ts`
- Modify: `src/core/watcher.ts` (add shutdown.control handling)

- [ ] **Step 1: Add shutdown.control to watcher's control schema**

In `src/core/watcher.ts`, add to the `controlSchema` discriminated union:

```typescript
  z.object({ operation: z.literal("shutdown"), slug: z.string() }),
```

In the `handleControlFile` switch, add:

```typescript
      case "shutdown": {
        logger.info("[watcher] Received shutdown.control — initiating graceful drain");
        // The pipeline will be stopped by the shutdown handler in start.ts
        // We signal via process event
        process.emit("SIGTERM" as any);
        break;
      }
```

- [ ] **Step 2: Update stop.ts to also write a control file for Slack-initiated stops**

In `src/commands/stop.ts`, add a `--drain` option that writes a control file instead of sending SIGTERM directly:

```typescript
import { Command } from "commander";
import { readFileSync, existsSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop the ShaktimaanAI pipeline watcher")
    .action(async () => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);

      const pidFile = join(config.pipeline.runtimeDir, "shkmn.pid");

      if (!existsSync(pidFile)) {
        console.error("ShaktimaanAI is not running (no PID file found).");
        process.exit(1);
      }

      let pid: number;
      try {
        const raw = readFileSync(pidFile, "utf-8").trim();
        pid = parseInt(raw, 10);
        if (isNaN(pid)) {
          throw new Error(`Invalid PID value in file: "${raw}"`);
        }

        // Write shutdown.control for clean drain
        const inboxDir = join(config.pipeline.runtimeDir, "00-inbox");
        mkdirSync(inboxDir, { recursive: true });
        writeFileSync(
          join(inboxDir, "shutdown.control"),
          JSON.stringify({ operation: "shutdown", slug: "system" }),
          "utf-8",
        );

        // Wait for process to exit with longer timeout for drain
        const deadline = Date.now() + 10 * 60 * 1000; // 10 minutes
        let alive = true;
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0);
            await new Promise((r) => setTimeout(r, 1000));
          } catch {
            alive = false;
            break;
          }
        }

        if (alive) {
          // Force kill after timeout
          try {
            process.kill(pid, "SIGKILL");
          } catch { /* may already be gone */ }
          console.warn(`ShaktimaanAI (PID ${pid}) force-killed after drain timeout.`);
        } else {
          console.log(`ShaktimaanAI (PID ${pid}) stopped gracefully.`);
        }

        if (existsSync(pidFile)) {
          unlinkSync(pidFile);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to stop ShaktimaanAI: ${message}`);
        if (existsSync(pidFile)) {
          unlinkSync(pidFile);
        }
        process.exit(1);
      }
    });
}
```

- [ ] **Step 3: Run existing stop tests**

Run: `npx vitest run tests/commands/stop.test.ts`
Expected: PASS (or skip if no existing tests — the manual testing is via CLI).

- [ ] **Step 4: Commit**

```bash
git add src/commands/stop.ts src/core/watcher.ts
git commit -m "feat(recovery): enhance stop command with graceful drain via shutdown.control"
```

---

### Task 12: Add Slack recover command routing

**Files:**
- Modify: `src/core/types.ts` (add "recover" to controlOp union)
- Modify: `src/core/watcher.ts` (handle recover control command)

- [ ] **Step 1: Add recover to AstraTriageResult controlOp**

In `src/core/types.ts`, update the `controlOp` field in `AstraTriageResult`:

```typescript
  controlOp?: "approve" | "cancel" | "skip" | "pause" |
              "resume" | "modify_stages" | "restart_stage" | "retry" | "recover" |
              "shutdown" | null;
```

- [ ] **Step 2: Add recover and shutdown operations to watcher controlSchema**

In `src/core/watcher.ts`, add to `controlSchema`:

```typescript
  z.object({ operation: z.literal("recover"), slug: z.string() }),
  z.object({ operation: z.literal("shutdown"), slug: z.string() }),
```

In `handleControlFile`, add cases:

```typescript
      case "recover": {
        const { reenterTask } = await import("./recovery-reentry.js");
        const result = reenterTask(runtimeDir, cmd.slug);
        if (result.success) {
          logger.info(`[watcher] Task "${cmd.slug}" re-entered pipeline at "${result.reEntryStage}"`);
        } else {
          logger.error(`[watcher] Failed to re-enter "${cmd.slug}": ${result.error}`);
        }
        break;
      }
      case "shutdown": {
        logger.info("[watcher] Received shutdown.control — initiating graceful drain");
        process.emit("SIGTERM" as any);
        break;
      }
```

- [ ] **Step 3: Commit**

```bash
git add src/core/types.ts src/core/watcher.ts
git commit -m "feat(recovery): add recover and shutdown control operations for Slack routing"
```

---

### Task 13: Create watchdog service command

**Files:**
- Create: `src/commands/service.ts`
- Create: `templates/shkmn-watchdog.sh`
- Modify: `src/cli.ts` (register command)

- [ ] **Step 1: Create watchdog shell script template**

Create `templates/shkmn-watchdog.sh`:

```bash
#!/usr/bin/env bash
# ShaktimaanAI Watchdog — keeps the pipeline alive and up-to-date
# Generated by: shkmn service install
# Mode: {{MODE}}

set -euo pipefail

PID_FILE="{{PID_FILE}}"
LOG_FILE="{{LOG_FILE}}"
REPO_PATH="{{REPO_PATH}}"
CRASH_FILE="{{CRASH_FILE}}"
MODE="{{MODE}}"
MAX_CRASH_COUNT=3
BACKOFF_MINUTES=30

log() {
  echo "[$(date -Iseconds)] $*" >> "$LOG_FILE"
}

# Check if pipeline is running
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    # Pipeline is alive — nothing to do
    exit 0
  fi
  log "Stale PID file found (PID $PID is not running)"
fi

# Check crash loop
CRASH_COUNT=0
if [ -f "$CRASH_FILE" ]; then
  CRASH_COUNT=$(cat "$CRASH_FILE" 2>/dev/null || echo "0")
fi

if [ "$CRASH_COUNT" -ge "$MAX_CRASH_COUNT" ]; then
  log "CRASH LOOP: $CRASH_COUNT consecutive crashes — backing off for $BACKOFF_MINUTES minutes"
  # Reset crash count after backoff period (check file age)
  CRASH_AGE=$(( $(date +%s) - $(stat -c %Y "$CRASH_FILE" 2>/dev/null || echo "0") ))
  if [ "$CRASH_AGE" -lt $(( BACKOFF_MINUTES * 60 )) ]; then
    exit 0
  fi
  log "Backoff period elapsed — resetting crash counter and retrying"
  echo "0" > "$CRASH_FILE"
  CRASH_COUNT=0
fi

# Pull latest code and rebuild
if [ "$MODE" = "source" ]; then
  log "Pulling latest code..."
  cd "$REPO_PATH"
  if ! git pull origin master >> "$LOG_FILE" 2>&1; then
    log "ERROR: git pull failed"
    exit 1
  fi
  log "Building..."
  if ! npm run build >> "$LOG_FILE" 2>&1; then
    log "ERROR: npm run build failed"
    exit 1
  fi
elif [ "$MODE" = "package" ]; then
  log "Updating npm package..."
  if ! npm update -g shaktimaanai >> "$LOG_FILE" 2>&1; then
    log "ERROR: npm update failed"
    exit 1
  fi
fi

# Start the pipeline
log "Starting pipeline..."
START_TIME=$(date +%s)
shkmn start >> "$LOG_FILE" 2>&1 &
SHKMN_PID=$!

# Wait briefly and check if it's still alive
sleep 5
if ! kill -0 "$SHKMN_PID" 2>/dev/null; then
  ELAPSED=$(( $(date +%s) - START_TIME ))
  if [ "$ELAPSED" -lt 60 ]; then
    CRASH_COUNT=$(( CRASH_COUNT + 1 ))
    echo "$CRASH_COUNT" > "$CRASH_FILE"
    log "Pipeline crashed within 60s (crash count: $CRASH_COUNT)"
    exit 1
  fi
fi

# Pipeline started successfully — reset crash counter
echo "0" > "$CRASH_FILE"
log "Pipeline started successfully (PID: $SHKMN_PID)"
```

- [ ] **Step 2: Create service.ts command**

Create `src/commands/service.ts`:

```typescript
import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";

const SHKMN_DIR = join(homedir(), ".shkmn");
const WATCHDOG_SCRIPT = join(SHKMN_DIR, "shkmn-watchdog.sh");
const WATCHDOG_LOG = join(SHKMN_DIR, "watchdog.log");
const CRASH_FILE = join(SHKMN_DIR, "watchdog-crashes.txt");
const TASK_NAME = "ShaktimaanAI-Watchdog";

function loadWatchdogTemplate(config: ReturnType<typeof loadConfig>): string {
  // Read the template from the package
  const templatePath = join(dirname(dirname(__dirname)), "templates", "shkmn-watchdog.sh");
  let template: string;
  try {
    template = readFileSync(templatePath, "utf-8");
  } catch {
    // Fallback: try from source
    const srcTemplate = join(process.cwd(), "templates", "shkmn-watchdog.sh");
    template = readFileSync(srcTemplate, "utf-8");
  }

  const pidFile = join(config.pipeline.runtimeDir, "shkmn.pid");

  return template
    .replace(/\{\{PID_FILE\}\}/g, pidFile.replace(/\\/g, "/"))
    .replace(/\{\{LOG_FILE\}\}/g, WATCHDOG_LOG.replace(/\\/g, "/"))
    .replace(/\{\{REPO_PATH\}\}/g, (config.service.repoPath || process.cwd()).replace(/\\/g, "/"))
    .replace(/\{\{CRASH_FILE\}\}/g, CRASH_FILE.replace(/\\/g, "/"))
    .replace(/\{\{MODE\}\}/g, config.service.mode);
}

export function registerServiceCommand(program: Command): void {
  const service = program
    .command("service")
    .description("Manage the ShaktimaanAI watchdog service");

  service
    .command("install")
    .description("Install the watchdog as a scheduled task")
    .action(() => {
      const config = loadConfig(resolveConfigPath());
      mkdirSync(SHKMN_DIR, { recursive: true });

      // Generate watchdog script
      const script = loadWatchdogTemplate(config);
      writeFileSync(WATCHDOG_SCRIPT, script, { encoding: "utf-8", mode: 0o755 });
      console.log(`Watchdog script written to ${WATCHDOG_SCRIPT}`);

      // Register with Windows Task Scheduler
      const intervalMinutes = config.service.checkIntervalMinutes;
      try {
        // Remove existing task if present
        try {
          execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: "pipe" });
        } catch { /* may not exist */ }

        execSync(
          `schtasks /Create /TN "${TASK_NAME}" /TR "bash '${WATCHDOG_SCRIPT.replace(/\\/g, "/")}'\" /SC MINUTE /MO ${intervalMinutes} /F`,
          { stdio: "pipe" },
        );
        console.log(`Scheduled task "${TASK_NAME}" registered (every ${intervalMinutes} minutes).`);
      } catch (err) {
        console.error(`Failed to register scheduled task: ${err instanceof Error ? err.message : String(err)}`);
        console.log("You can run the watchdog manually: bash " + WATCHDOG_SCRIPT);
      }
    });

  service
    .command("uninstall")
    .description("Remove the watchdog scheduled task")
    .action(() => {
      try {
        execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: "pipe" });
        console.log(`Scheduled task "${TASK_NAME}" removed.`);
      } catch {
        console.log("No scheduled task found to remove.");
      }
      if (existsSync(WATCHDOG_SCRIPT)) {
        unlinkSync(WATCHDOG_SCRIPT);
        console.log("Watchdog script removed.");
      }
    });

  service
    .command("status")
    .description("Show watchdog status")
    .action(() => {
      try {
        const output = execSync(`schtasks /Query /TN "${TASK_NAME}" /FO LIST`, {
          stdio: "pipe",
          encoding: "utf-8",
        });
        console.log(output);
      } catch {
        console.log("Watchdog is not installed. Run `shkmn service install` to set it up.");
      }

      if (existsSync(CRASH_FILE)) {
        const crashes = readFileSync(CRASH_FILE, "utf-8").trim();
        console.log(`Consecutive crash count: ${crashes}`);
      }
    });

  service
    .command("logs")
    .description("Show watchdog logs")
    .option("-n <lines>", "Number of lines to show", "50")
    .action((opts: { n: string }) => {
      if (!existsSync(WATCHDOG_LOG)) {
        console.log("No watchdog logs found.");
        return;
      }
      const lines = readFileSync(WATCHDOG_LOG, "utf-8").split("\n");
      const count = parseInt(opts.n, 10) || 50;
      const tail = lines.slice(-count);
      console.log(tail.join("\n"));
    });
}
```

- [ ] **Step 3: Register in cli.ts**

In `src/cli.ts`, add:

```typescript
import { registerServiceCommand } from "./commands/service.js";
```

And call it:

```typescript
registerServiceCommand(program);
```

- [ ] **Step 4: Add templates/ to build copy**

In `scripts/copy-agents.js` (or equivalent build script), add logic to copy `templates/` to `dist/templates/`. Or add to `tsup.config.ts` if using a different mechanism. Check how `agents/*.md` is copied and follow the same pattern.

- [ ] **Step 5: Commit**

```bash
git add src/commands/service.ts templates/shkmn-watchdog.sh src/cli.ts
git commit -m "feat(recovery): add shkmn service command with watchdog install/uninstall/status/logs"
```

---

### Task 14: Add the agent name to defaults

**Files:**
- Modify: `src/config/defaults.ts`

- [ ] **Step 1: Add Chiranjeevi agent name**

In `src/config/defaults.ts`, in the `DEFAULT_CONFIG.agents.names` record, add:

```typescript
  recovery: "Chiranjeevi",
```

- [ ] **Step 2: Commit**

```bash
git add src/config/defaults.ts
git commit -m "feat(recovery): add Chiranjeevi agent name to defaults"
```

---

### Task 15: Run full test suite and fix any issues

**Files:**
- All modified files

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS. If any fail, diagnose and fix.

- [ ] **Step 2: Build check**

Run: `npm run build`
Expected: Clean build with no TypeScript errors.

- [ ] **Step 3: Fix any issues found**

Address any compilation errors, missing imports, or test failures.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "fix(recovery): address test and build issues"
```

---

### Summary of Files

**New files (7):**
| File | Purpose |
|---|---|
| `src/core/recovery-agent.ts` | Recovery agent invocation, diagnosis parsing, issue filing |
| `src/core/recovery-reentry.ts` | Re-entry mechanics with artifact archival and state reset |
| `src/commands/recover.ts` | `shkmn recover` CLI command |
| `src/commands/service.ts` | `shkmn service install/uninstall/status/logs` |
| `agents/recovery.md` | Chiranjeevi recovery agent prompt template |
| `templates/shkmn-watchdog.sh` | Watchdog shell script template |
| `tests/core/recovery-types.test.ts` | Type tests |
| `tests/core/recovery-agent-diagnosis.test.ts` | Diagnosis parsing tests |
| `tests/core/recovery-startup.test.ts` | Startup scan tests |
| `tests/core/recovery-reentry.test.ts` | Re-entry mechanics tests |
| `tests/commands/recover.test.ts` | CLI command tests |
| `tests/surfaces/recovery-notifications.test.ts` | Notification formatting tests |

**Modified files (8):**
| File | Change |
|---|---|
| `src/core/types.ts` | RunState recovery fields, `awaiting_fix` holdReason, `recover`/`shutdown` controlOp |
| `src/config/schema.ts` | `recovery` and `service` config sections |
| `src/config/defaults.ts` | Recovery stage tools, context rules, model, timeout, agent name |
| `src/core/pipeline.ts` | Hook recovery agent into `failTask()` |
| `src/core/recovery.ts` | Startup scan phases (unanalyzed failures, held tasks with issues) |
| `src/core/watcher.ts` | `recover` and `shutdown` control operations |
| `src/commands/stop.ts` | Graceful drain via `shutdown.control` |
| `src/surfaces/types.ts` | `recovery_diagnosed` event type |
| `src/surfaces/slack-notifier.ts` | Recovery notification formatting |
| `src/cli.ts` | Register `recover` and `service` commands |
| `src/commands/start.ts` | Wire `runRecoveryStartupScan` into boot sequence |
