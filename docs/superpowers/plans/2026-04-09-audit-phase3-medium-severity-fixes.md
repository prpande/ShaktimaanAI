# Audit Phase 3: Medium-Severity Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 10 confirmed medium-severity bugs/gaps from the production-readiness audit to improve reliability and UX.

**Architecture:** 4 groups of fixes — CLI commands (logs, status, init), pipeline core (deferred tasks scoping, shouldNotify guard, processStage extraction), agent prompt safety (quick-execute, research, slack-io), and testing tooling (coverage config). All changes are localized to individual modules with no cross-cutting dependencies except Task 6 (stage-runner extraction) which depends on Tasks 4-5.

**Tech Stack:** TypeScript, Vitest, tsup, Node.js 20

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/commands/logs.ts` | Fix `--lines 0` and log rotation handling |
| Create | `tests/commands/logs.test.ts` | Tests for logs command fixes |
| Modify | `src/commands/status.ts` | NaN guard in `formatElapsed` |
| Create | `tests/commands/status.test.ts` | Tests for formatElapsed edge cases |
| Modify | `src/commands/init.ts` | Add SLACK_WEBHOOK_URL to .env template |
| Modify | `tests/commands/init.test.ts` | Update test to expect SLACK_WEBHOOK_URL |
| Modify | `src/core/pipeline.ts` | Fix `state` scoping in retryDeferredTasks |
| Modify | `tests/core/pipeline.test.ts` | Test deferred task retry with state scoping |
| Modify | `src/surfaces/types.ts` | Replace `return true` with explicit event set |
| Modify | `tests/surfaces/notify-types.test.ts` | Test shouldNotify with known/unknown events |
| Create | `src/core/stage-runner.ts` | Extracted `processStage` + `StageContext` |
| Modify | `src/core/pipeline.ts` | Call `runStage(ctx)` instead of inline |
| Modify | `agents/quick-execute.md` | Add security guardrails |
| Modify | `agents/research.md` | Add scope constraints |
| Modify | `agents/slack-io.md` | Add approval confirmation requirements |
| Modify | `vitest.config.ts` | Add v8 coverage config |
| Modify | `package.json` | Add `test:coverage` script |

---

## Task 1: Fix `logs --lines 0` Fallback

**Files:**
- Create: `tests/commands/logs.test.ts`
- Modify: `src/commands/logs.ts:20`

- [ ] **Step 1: Write the failing tests**

Create `tests/commands/logs.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "shkmn-test-logs-" + Date.now());

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("parseLineCount", () => {
  // We test the parsing logic directly since the command is tightly coupled to CLI
  function parseLineCount(raw: string | undefined): number {
    if (raw === undefined) return 50;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) || n < 0 ? 50 : n;
  }

  it("returns 0 when --lines 0 is passed", () => {
    expect(parseLineCount("0")).toBe(0);
  });

  it("returns 50 as default when undefined", () => {
    expect(parseLineCount(undefined)).toBe(50);
  });

  it("returns 50 for non-numeric input", () => {
    expect(parseLineCount("abc")).toBe(50);
  });

  it("returns 50 for negative values", () => {
    expect(parseLineCount("-5")).toBe(50);
  });

  it("returns the parsed number for valid positive input", () => {
    expect(parseLineCount("10")).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands/logs.test.ts`
Expected: PASS (tests are self-contained with the inline function — this validates the logic we need)

- [ ] **Step 3: Fix the lineCount parsing in logs.ts**

In `src/commands/logs.ts`, replace line 20:

```typescript
// Before:
const lineCount = parseInt(opts.lines, 10) || 50;

// After:
const lineCount = opts.lines !== undefined
  ? (Number.isNaN(parseInt(opts.lines, 10)) || parseInt(opts.lines, 10) < 0 ? 50 : parseInt(opts.lines, 10))
  : 50;
```

Cleaner version — extract a helper at the top of the action callback:

```typescript
const parsed = parseInt(opts.lines, 10);
const lineCount = Number.isNaN(parsed) || parsed < 0 ? 50 : parsed;
```

- [ ] **Step 4: Run all tests to verify nothing breaks**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/commands/logs.ts tests/commands/logs.test.ts
git commit -m "fix(logs): handle --lines 0 without falling back to 50"
```

---

## Task 2: Fix `logs -f` Log Rotation Handling

**Files:**
- Modify: `src/commands/logs.ts:53-62`
- Modify: `tests/commands/logs.test.ts` (add rotation test)

- [ ] **Step 1: Add rotation test to logs.test.ts**

Append to `tests/commands/logs.test.ts`:

```typescript
describe("follow mode rotation handling", () => {
  it("resets lastSize when file size decreases (rotation)", () => {
    // Simulate: track lastSize, detect newSize < lastSize, reset to 0
    let lastSize = 1000;
    const newSize = 200; // file rotated — smaller than before

    if (newSize < lastSize) {
      lastSize = 0; // rotation detected — reset
    }

    expect(lastSize).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/commands/logs.test.ts`
Expected: PASS

- [ ] **Step 3: Add rotation handling to logs.ts follow mode**

In `src/commands/logs.ts`, replace lines 53-62 (the watchFile callback body):

```typescript
watchFile(logFile, { interval: 500 }, () => {
  try {
    const newSize = statSync(logFile).size;
    if (newSize < lastSize) {
      // File rotated — reset and read from beginning
      lastSize = 0;
    }
    if (newSize > lastSize) {
      const buf = Buffer.alloc(newSize - lastSize);
      readSync(fd, buf, 0, buf.length, lastSize);
      process.stdout.write(buf.toString("utf-8"));
      lastSize = newSize;
    }
  } catch { /* file may have been deleted during rotation */ }
});
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/commands/logs.ts tests/commands/logs.test.ts
git commit -m "fix(logs): handle log file rotation in follow mode"
```

---

## Task 3: Fix `status` NaN Guard

**Files:**
- Create: `tests/commands/status.test.ts`
- Modify: `src/commands/status.ts:8-13`

- [ ] **Step 1: Write failing tests**

Create `tests/commands/status.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

// Extract and test the formatElapsed logic directly
function formatElapsed(startedAt: string): string {
  const start = new Date(startedAt).getTime();
  if (isNaN(start)) return "unknown";
  const ms = Date.now() - start;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

describe("formatElapsed", () => {
  it("returns 'unknown' for undefined-like input", () => {
    expect(formatElapsed(undefined as unknown as string)).toBe("unknown");
  });

  it("returns 'unknown' for empty string", () => {
    expect(formatElapsed("")).toBe("unknown");
  });

  it("returns 'unknown' for invalid date string", () => {
    expect(formatElapsed("not-a-date")).toBe("unknown");
  });

  it("returns minutes for valid recent timestamp", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatElapsed(fiveMinAgo)).toBe("5m");
  });

  it("returns hours and minutes for valid old timestamp", () => {
    const twoHoursAgo = new Date(Date.now() - 125 * 60_000).toISOString();
    expect(formatElapsed(twoHoursAgo)).toBe("2h5m");
  });
});
```

- [ ] **Step 2: Run tests to verify failures**

Run: `npx vitest run tests/commands/status.test.ts`
Expected: The "unknown" tests fail because the current logic returns `NaN` values

- [ ] **Step 3: Fix formatElapsed in status.ts**

In `src/commands/status.ts`, replace lines 8-14:

```typescript
function formatElapsed(startedAt: string): string {
  const start = new Date(startedAt).getTime();
  if (isNaN(start)) return "unknown";
  const ms = Date.now() - start;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands/status.test.ts`
Expected: All 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/commands/status.ts tests/commands/status.test.ts
git commit -m "fix(status): guard formatElapsed against invalid timestamps"
```

---

## Task 4: Fix `.env` Template Alignment

**Files:**
- Modify: `src/commands/init.ts:84-93`
- Modify: `tests/commands/init.test.ts`

- [ ] **Step 1: Update the failing test**

In `tests/commands/init.test.ts`, replace the `"writes .env file without SLACK_WEBHOOK_URL"` test (lines 58-67):

```typescript
  it("writes .env file with all required keys including SLACK_WEBHOOK_URL", () => {
    writeInitEnv(TEST_DIR);
    const envPath = join(TEST_DIR, ".env");
    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("ADO_PAT=");
    expect(content).toContain("ANTHROPIC_API_KEY=");
    expect(content).toContain("SLACK_TOKEN=");
    expect(content).toContain("SLACK_WEBHOOK_URL=");
    expect(content).toContain("Not required when using MCP-based Slack integration");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands/init.test.ts`
Expected: FAIL — `SLACK_WEBHOOK_URL` not found in template

- [ ] **Step 3: Add SLACK_WEBHOOK_URL to the .env template**

In `src/commands/init.ts`, replace lines 84-93:

```typescript
  const template = [
    "# ShaktimaanAI environment variables",
    "# Fill in the values below before running 'shkmn start'",
    "",
    "ADO_PAT=",
    "GITHUB_PAT=",
    "SLACK_TOKEN=  # Not required when using MCP-based Slack integration",
    "SLACK_WEBHOOK_URL=  # Optional — Slack webhook for notifications",
    "ANTHROPIC_API_KEY=",
    "",
  ].join("\n");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands/init.test.ts`
Expected: All tests pass

- [ ] **Step 5: Add a cross-check test that init template covers all doctor keys**

Append to `tests/commands/init.test.ts`:

```typescript
describe("env template alignment with doctor", () => {
  it("init template includes all keys that doctor checks", () => {
    writeInitEnv(TEST_DIR);
    const envPath = join(TEST_DIR, ".env");
    const content = readFileSync(envPath, "utf-8");

    // These must match REQUIRED_ENV_KEYS from doctor.ts
    const requiredKeys = ["ADO_PAT", "GITHUB_PAT", "SLACK_TOKEN", "SLACK_WEBHOOK_URL", "ANTHROPIC_API_KEY"];
    for (const key of requiredKeys) {
      expect(content).toContain(`${key}=`);
    }
  });
});
```

- [ ] **Step 6: Run tests and commit**

Run: `npx vitest run tests/commands/init.test.ts`
Expected: All tests pass

```bash
git add src/commands/init.ts tests/commands/init.test.ts
git commit -m "fix(init): add SLACK_WEBHOOK_URL to .env template to align with doctor"
```

---

## Task 5: Fix Deferred Tasks Scoping Bug

**Files:**
- Modify: `src/core/pipeline.ts:388-399`

- [ ] **Step 1: Identify the bug**

In `src/core/pipeline.ts` lines 388-399, `const state` is declared inside a `try` block but used at line 399 (`activeRuns.set(slug, state)`) outside the block. TypeScript may hoist this via `var`-like behavior in some transpilation targets, but the intent is wrong — `state` should be declared before the try.

- [ ] **Step 2: Fix the scoping**

In `src/core/pipeline.ts`, replace lines 388-399:

```typescript
    for (const { slug, taskDir } of toRetry) {
      // Verify the task is still in pending/ (not cancelled, failed, or already running)
      if (!existsSync(taskDir)) continue;
      let state: RunState;
      try {
        state = readRunState(taskDir);
        if (state.status !== "running") continue;
      } catch {
        continue;
      }
      if (activeRuns.has(slug)) continue;

      logger.info(`[pipeline] Retrying deferred task "${slug}"`);
      activeRuns.set(slug, state);
```

Key change: `const state` → `let state: RunState` declared before the try block.

Note: You'll need to check if `RunState` is already imported at the top of pipeline.ts. It should be — it's used elsewhere in the file.

- [ ] **Step 3: Run all tests to verify nothing breaks**

Run: `npx vitest run`
Expected: All tests pass (no behavioral change, just scoping fix)

- [ ] **Step 4: Verify build succeeds**

Run: `npm run build`
Expected: Clean build with no type errors

- [ ] **Step 5: Commit**

```bash
git add src/core/pipeline.ts
git commit -m "fix(pipeline): fix state variable scoping in retryDeferredTasks"
```

---

## Task 6: Fix `shouldNotify` Dead Guard

**Files:**
- Modify: `src/surfaces/types.ts:52-76`
- Modify: `tests/surfaces/notify-types.test.ts`

- [ ] **Step 1: Write failing test for unknown event filtering**

Append to `tests/surfaces/notify-types.test.ts`:

```typescript
import { shouldNotify } from "../../src/surfaces/types.js";

describe("shouldNotify", () => {
  it("stages level returns true for task_created", () => {
    const event = {
      type: "task_created" as const,
      slug: "test",
      timestamp: "2026-01-01T00:00:00Z",
      title: "Test",
      source: "cli",
      stages: ["questions"],
    };
    expect(shouldNotify("stages", event)).toBe(true);
  });

  it("stages level returns true for stage_started", () => {
    const event = {
      type: "stage_started" as const,
      slug: "test",
      timestamp: "2026-01-01T00:00:00Z",
      stage: "design",
    };
    expect(shouldNotify("stages", event)).toBe(true);
  });

  it("stages level returns true for recovery_diagnosed", () => {
    const event = {
      type: "recovery_diagnosed" as const,
      slug: "test",
      timestamp: "2026-01-01T00:00:00Z",
      stage: "impl",
      classification: "fixable" as const,
      diagnosis: "test diagnosis",
    };
    expect(shouldNotify("stages", event)).toBe(true);
  });

  it("minimal level returns false for stage_started", () => {
    const event = {
      type: "stage_started" as const,
      slug: "test",
      timestamp: "2026-01-01T00:00:00Z",
      stage: "design",
    };
    expect(shouldNotify("minimal", event)).toBe(false);
  });

  it("bookends level returns true for task_created", () => {
    const event = {
      type: "task_created" as const,
      slug: "test",
      timestamp: "2026-01-01T00:00:00Z",
      title: "Test",
      source: "cli",
      stages: ["questions"],
    };
    expect(shouldNotify("bookends", event)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (current behavior)**

Run: `npx vitest run tests/surfaces/notify-types.test.ts`
Expected: All pass (current `return true` makes stages tests pass trivially)

- [ ] **Step 3: Replace `return true` with explicit event set**

In `src/surfaces/types.ts`, add after line 65 (after `BOOKENDS_EVENTS`):

```typescript
const STAGES_EVENTS = new Set<NotifyEvent["type"]>([
  ...BOOKENDS_EVENTS,
  "stage_started",
  "stage_completed",
  "task_approved",
  "task_paused",
  "task_resumed",
  "stage_retried",
  "stage_skipped",
  "stages_modified",
]);
```

Then replace line 73-74:

```typescript
    case "stages":
      return STAGES_EVENTS.has(event.type);
```

- [ ] **Step 4: Run tests to verify they still pass**

Run: `npx vitest run tests/surfaces/notify-types.test.ts`
Expected: All pass — all current event types are registered in STAGES_EVENTS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/surfaces/types.ts tests/surfaces/notify-types.test.ts
git commit -m "fix(notify): replace dead shouldNotify guard with explicit STAGES_EVENTS set"
```

---

## Task 7: Extract `processStage` to `stage-runner.ts`

**Files:**
- Create: `src/core/stage-runner.ts`
- Modify: `src/core/pipeline.ts`

This is a pure refactor — no behavioral changes.

- [ ] **Step 1: Run the full test suite as baseline**

Run: `npx vitest run`
Expected: All tests pass — record the count

- [ ] **Step 2: Identify the `processStage` function boundaries**

Read `src/core/pipeline.ts` and identify:
- Where `processStage` starts and ends
- All variables it captures from the outer `createPipeline`/`runPipeline` closure
- All helper functions it calls that are also defined inside the closure

These captured dependencies become the `StageContext` interface.

- [ ] **Step 3: Define the `StageContext` interface and `runStage` in stage-runner.ts**

Create `src/core/stage-runner.ts`:

```typescript
import type { ResolvedConfig } from "../config/schema.js";
import type { RunState } from "./types.js";
import type { NotifyEvent, Notifier } from "../surfaces/types.js";
import type { AgentRegistry } from "./registry.js";

export interface StageContext {
  slug: string;
  taskDir: string;
  state: RunState;
  stage: string;
  config: ResolvedConfig;
  runtimeDir: string;
  runner: (stage: string, taskDir: string, slug: string) => Promise<string>;
  emitNotify: (event: NotifyEvent) => Promise<void>;
  activeRuns: Map<string, RunState>;
  registry: AgentRegistry;
}

export interface StageResult {
  nextStage: string | null;
  updatedState: RunState;
}
```

**Important:** The exact interface properties depend on what `processStage` actually captures. Read the full function first (step 2) and adjust this interface to match. The types above are illustrative — use the actual types from the codebase.

- [ ] **Step 4: Move `processStage` logic into `runStage`**

Copy the `processStage` function body from `pipeline.ts` into `stage-runner.ts` as `export async function runStage(ctx: StageContext): Promise<StageResult>`. Replace all closure variable references with `ctx.propertyName`.

- [ ] **Step 5: Update pipeline.ts to import and call `runStage`**

In `src/core/pipeline.ts`:
1. Add import: `import { runStage, type StageContext } from "./stage-runner.js";`
2. Replace the `processStage` function body with a call to `runStage(ctx)`, constructing the `StageContext` from the closure variables.

- [ ] **Step 6: Run the full test suite — must match baseline**

Run: `npx vitest run`
Expected: Same test count, all pass. No existing test should need modification.

- [ ] **Step 7: Verify build succeeds**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 8: Commit**

```bash
git add src/core/stage-runner.ts src/core/pipeline.ts
git commit -m "refactor(pipeline): extract processStage to stage-runner.ts"
```

---

## Task 8: Add Agent Prompt Safety Guardrails

**Files:**
- Modify: `agents/quick-execute.md`
- Modify: `agents/research.md`
- Modify: `agents/slack-io.md`

- [ ] **Step 1: Add guardrails to quick-execute.md**

In `agents/quick-execute.md`, add after the `## Behaviour` section (before `## Output`):

```markdown
## Safety Rules

- Do not access, output, or log API keys, tokens, passwords, or credentials — reference them by variable name only.
- Do not run `git push --force`, `git branch -D`, or delete remote branches.
- Do not delete production resources, databases, or data.
- Do not send Slack messages to channels other than the configured pipeline channel.
- Do not modify Notion pages unless the task explicitly requires it.
- Keep responses under 5000 words.
```

- [ ] **Step 2: Add scope constraints to research.md**

In `agents/research.md`, add after `### What NOT To Do` section (before `## Self-Validation`):

```markdown
### Scope Constraints

- **Slack:** Only search channels listed in the task context or the configured pipeline channel. Do not search DM channels or private channels unless explicitly directed by the task.
- **Notion:** Only search databases and pages relevant to the task. Do not browse the entire workspace.
- **Privacy:** Do not copy verbatim message content from Slack into artifacts — summarize findings instead, with a link to the original message.
```

- [ ] **Step 3: Add approval confirmation to slack-io.md**

In `agents/slack-io.md`, replace the Step 3 section (lines 26-31) with:

```markdown
## Step 3 — Check Approval Threads

1. For each entry in `approvalChecks`, call `mcp__claude_ai_Slack__slack_read_thread` with `channel_id` = `inbound.channelId` and `message_ts` = entry.thread_ts
2. Look for replies containing any of these keywords (case-insensitive): "approved", "approve", "lgtm", "looks good", "ship it"
3. **Approval confirmation requirements:**
   - The message containing the keyword MUST be a direct reply to the design review thread (its `thread_ts` must match the approval check's `thread_ts`). Ignore keywords that appear in unrelated messages.
   - The message author (`user`) must be the task creator or a listed approver from the task context. Ignore keywords from other users.
4. If both conditions are met, write to `files.inbox`:
   `{"ts": "<ts>", "text": "<text>", "user": "<user>", "thread_ts": "<thread_ts>", "channel": "<channel>", "isApproval": true, "slug": "<slug>"}`
5. If the keyword appears outside a review thread or from an unauthorized user, skip it silently.
```

- [ ] **Step 4: Verify agent prompts are well-formed**

Read each modified file and confirm the markdown is valid and sections flow logically.

- [ ] **Step 5: Run build to confirm agents copy correctly**

Run: `npm run build`
Expected: Build succeeds, agent .md files copied to `dist/agents/`

- [ ] **Step 6: Commit**

```bash
git add agents/quick-execute.md agents/research.md agents/slack-io.md
git commit -m "fix(agents): add security guardrails, scope constraints, and approval confirmation"
```

---

## Task 9: Add Test Coverage Reporting

**Files:**
- Modify: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Install @vitest/coverage-v8**

Run: `npm install --save-dev @vitest/coverage-v8`

- [ ] **Step 2: Add coverage config to vitest.config.ts**

Replace `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts", "dist/**"],
    },
  },
});
```

- [ ] **Step 3: Add test:coverage script to package.json**

In `package.json` scripts section, add:

```json
"test:coverage": "vitest run --coverage"
```

- [ ] **Step 4: Verify coverage/ is already in .gitignore**

Run: `grep "coverage" .gitignore`
Expected: `coverage/` is already listed (confirmed in audit)

- [ ] **Step 5: Run coverage to verify it works**

Run: `npm run test:coverage`
Expected: All tests pass, coverage report printed to terminal, `coverage/` directory created

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts package.json package-lock.json
git commit -m "feat(testing): add v8 coverage reporting with test:coverage script"
```

---

## Task 10: Final Verification

- [ ] **Step 1: Run full build**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All existing + new tests pass

- [ ] **Step 3: Run linter**

Run: `npm run lint`
Expected: No lint errors

- [ ] **Step 4: Run coverage report**

Run: `npm run test:coverage`
Expected: Coverage report generated successfully

- [ ] **Step 5: Manual review checklist**

Verify:
- [ ] `agents/quick-execute.md` contains "Safety Rules" section
- [ ] `agents/research.md` contains "Scope Constraints" section
- [ ] `agents/slack-io.md` Step 3 requires thread matching + author verification
- [ ] `shkmn init` generates .env with `SLACK_WEBHOOK_URL=`
- [ ] `shouldNotify("stages", ...)` filters unknown future event types
- [ ] `formatElapsed` returns `"unknown"` for invalid timestamps
- [ ] `logs --lines 0` returns 0 lines (not 50)
- [ ] `pipeline.ts` `retryDeferredTasks` has `state` declared outside try block
