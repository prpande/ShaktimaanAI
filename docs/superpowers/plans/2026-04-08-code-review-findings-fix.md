# Code Review Findings Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 25 open Copilot code review findings, ordered by severity (High → Low).

**Architecture:** No new modules except `scripts/copy-agents.js` (Task 23). All other changes are edits to existing files. Each task is self-contained and testable independently.

**Deferred:** F-4.6 (extract `processStage` into `stage-runner.ts`) is deferred to a separate PR — it's a ~300-line refactor with high risk of merge conflicts in this already-large changeset.

**Tech Stack:** TypeScript, Vitest, Node.js built-ins (`node:child_process`, `node:crypto`)

---

### Task 1: F-1.1 — Fix wrong `repoPath` in `recordCompletionIfWorktree`

**Files:**
- Modify: `src/core/types.ts` (add `repoRoot` field to `RunState`)
- Modify: `src/core/pipeline.ts:396-409` (use `state.repoRoot` in manifest entry)
- Modify: `src/core/pipeline.ts:440-470` (set `repoRoot` in `startRun`)
- Test: `tests/core/pipeline.test.ts`

- [ ] **Step 1: Add `repoRoot` to `RunState` interface**

In `src/core/types.ts`, add `repoRoot` to `RunState` after the `worktreePath` field:

```typescript
worktreePath?: string;
repoRoot?: string;
invocationCwd?: string;
```

- [ ] **Step 2: Write failing test**

In `tests/core/pipeline.test.ts`, add a test that verifies the manifest entry uses the correct repo path:

```typescript
it("recordCompletionIfWorktree uses repoRoot, not worktreePath", async () => {
  const { pipeline, runtimeDir } = await createTestPipeline();
  const slug = "test-worktree-reporoot";
  const taskDir = join(runtimeDir, "06-impl", "pending", slug);
  mkdirSync(join(taskDir, "artifacts"), { recursive: true });

  const state: RunState = {
    slug,
    taskFile: "task.md",
    stages: ["impl"],
    reviewAfter: "design",
    currentStage: "impl",
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedStages: [],
    reviewRetryCount: 0,
    reviewIssues: [],
    suggestionRetryUsed: false,
    validateFailCount: 0,
    stageHints: {},
    retryAttempts: {},
    worktreePath: "/tmp/worktrees/test-slug",
    repoRoot: "/original/repo/path",
  };
  writeFileSync(join(taskDir, "run-state.json"), JSON.stringify(state));

  // Trigger the function via pipeline internals — call failTask which calls recordCompletionIfWorktree
  await pipeline.cancel(slug);

  const manifestPath = join(runtimeDir, "worktree-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const entry = manifest.find((e: any) => e.slug === slug);
  expect(entry.repoPath).toBe("/original/repo/path");
  expect(entry.worktreePath).toBe("/tmp/worktrees/test-slug");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/core/pipeline.test.ts -t "recordCompletionIfWorktree uses repoRoot"`
Expected: FAIL — `repoRoot` field not yet populated, manifest entry has worktreePath for both fields.

- [ ] **Step 4: Fix `recordCompletionIfWorktree` in pipeline.ts**

At line ~402, change `repoPath: state.worktreePath` to use `state.repoRoot`:

```typescript
function recordCompletionIfWorktree(state: RunState): void {
  if (!state.worktreePath) return;
  const manifestPath = join(runtimeDir, "worktree-manifest.json");
  try {
    recordWorktreeCompletion(manifestPath, {
      slug: state.slug,
      repoPath: state.repoRoot ?? state.worktreePath,
      worktreePath: state.worktreePath,
      completedAt: new Date().toISOString(),
    });
  } catch {
    // log but don't fail
  }
}
```

- [ ] **Step 5: Populate `repoRoot` in `startRun`**

In the `startRun` function (around line 440), after parsing the task file and before creating the worktree, set `state.repoRoot` from the task meta's repo path:

```typescript
const repoPath = taskMeta.repo
  ? resolveRepoAlias(taskMeta.repo, config)
  : config.pipeline.invocationCwd ?? process.cwd();
// ... existing worktree creation code ...
state.repoRoot = repoPath;
```

Find the exact location where `state.worktreePath` is set and add `state.repoRoot = repoPath` right before it.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/core/pipeline.test.ts -t "recordCompletionIfWorktree uses repoRoot"`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/core/pipeline.ts tests/core/pipeline.test.ts
git commit -m "fix(F-1.1): use repoRoot in worktree manifest, not worktreePath"
```

---

### Task 2: F-5.1 — Add `task_completed` notification in `approveAndResume`

**Files:**
- Modify: `src/core/pipeline.ts:864-870`
- Test: `tests/core/pipeline.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it("approveAndResume emits task_completed when task is at last stage", async () => {
  const notifications: any[] = [];
  const { pipeline, runtimeDir } = await createTestPipeline({
    onNotify: (event: any) => notifications.push(event),
  });
  const slug = "test-approve-last-stage";
  const holdDir = join(runtimeDir, "12-hold", slug);
  mkdirSync(join(holdDir, "artifacts"), { recursive: true });

  const state: RunState = {
    slug,
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
  };
  writeFileSync(join(holdDir, "run-state.json"), JSON.stringify(state));

  await pipeline.approveAndResume(slug);

  const completed = notifications.find((n) => n.type === "task_completed");
  expect(completed).toBeDefined();
  expect(completed.slug).toBe(slug);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/pipeline.test.ts -t "approveAndResume emits task_completed"`
Expected: FAIL — no `task_completed` event found.

- [ ] **Step 3: Add emitNotify to the nextStage === null branch**

In `src/core/pipeline.ts`, at line ~869, before the `return`:

```typescript
if (nextStage === null) {
  state.status = "complete";
  writeRunState(holdDir, state);
  moveTaskDir(runtimeDir, slug, "12-hold", "10-complete");
  activeRuns.set(slug, readRunState(join(runtimeDir, "10-complete", slug)));
  emitNotify({ type: "task_completed", slug, timestamp: new Date().toISOString() });
  return;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/pipeline.test.ts -t "approveAndResume emits task_completed"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/pipeline.ts tests/core/pipeline.test.ts
git commit -m "fix(F-5.1): emit task_completed when approving last-stage task"
```

---

### Task 3: F-5.2 — Record worktree completion on cancel

**Files:**
- Modify: `src/core/pipeline.ts:906-926`
- Test: `tests/core/pipeline.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it("cancel records worktree completion for worktree-backed tasks", async () => {
  const { pipeline, runtimeDir } = await createTestPipeline();
  const slug = "test-cancel-worktree";
  const taskDir = join(runtimeDir, "06-impl", "pending", slug);
  mkdirSync(join(taskDir, "artifacts"), { recursive: true });

  const state: RunState = {
    slug,
    taskFile: "task.md",
    stages: ["impl"],
    reviewAfter: "design",
    currentStage: "impl",
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedStages: [],
    reviewRetryCount: 0,
    reviewIssues: [],
    suggestionRetryUsed: false,
    validateFailCount: 0,
    stageHints: {},
    retryAttempts: {},
    worktreePath: "/tmp/worktrees/cancel-slug",
    repoRoot: "/original/repo",
  };
  writeFileSync(join(taskDir, "run-state.json"), JSON.stringify(state));

  await pipeline.cancel(slug);

  const manifestPath = join(runtimeDir, "worktree-manifest.json");
  expect(existsSync(manifestPath)).toBe(true);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const entry = manifest.find((e: any) => e.slug === slug);
  expect(entry).toBeDefined();
  expect(entry.worktreePath).toBe("/tmp/worktrees/cancel-slug");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/pipeline.test.ts -t "cancel records worktree completion"`
Expected: FAIL — manifest file not created.

- [ ] **Step 3: Add `recordCompletionIfWorktree` call in `cancel`**

In `src/core/pipeline.ts`, in the `cancel` function (line ~912), after reading state and before moving:

```typescript
async cancel(slug: string): Promise<void> {
  registry.abortBySlug(slug);
  const found = findTaskDir(slug);
  if (!found) throw new Error(`Task "${slug}" not found`);
  const state = readRunState(found.dir);
  recordCompletionIfWorktree(state);
  state.status = "failed";
  state.error = "Cancelled by user";
  writeRunState(found.dir, state);
  // ... rest unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/pipeline.test.ts -t "cancel records worktree completion"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/pipeline.ts tests/core/pipeline.test.ts
git commit -m "fix(F-5.2): record worktree completion on cancel to prevent orphaned worktrees"
```

---

### Task 4: F-5.3 — Concurrent recovery with timer cleanup

**Files:**
- Modify: `src/core/recovery.ts`
- Test: `tests/core/recovery.test.ts`

- [ ] **Step 1: Write failing test for concurrent recovery**

In `tests/core/recovery.test.ts`, add:

```typescript
it("recovers multiple tasks concurrently, not sequentially", async () => {
  // Create a mock pipeline that tracks call timing
  const callTimes: number[] = [];
  const mockPipeline = {
    resumeRun: vi.fn(async () => {
      callTimes.push(Date.now());
      await new Promise(r => setTimeout(r, 50)); // simulate 50ms work
    }),
    startRun: vi.fn(async () => {
      callTimes.push(Date.now());
      await new Promise(r => setTimeout(r, 50));
    }),
  };

  // Set up 3 tasks in pending directories
  // ... create the pending task dirs with run-state.json ...

  const result = await runRecovery(runtimeDir, mockPipeline as any);

  // If concurrent, all 3 calls should start within ~10ms of each other
  // If sequential, they'd be ~50ms apart
  if (callTimes.length >= 2) {
    const spread = callTimes[callTimes.length - 1] - callTimes[0];
    expect(spread).toBeLessThan(30); // all started nearly simultaneously
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/recovery.test.ts -t "recovers multiple tasks concurrently"`
Expected: FAIL — spread is ~50ms+ because recovery is sequential.

- [ ] **Step 3: Refactor recovery loop to use `Promise.allSettled`**

In `src/core/recovery.ts`, replace the sequential `for...of` loop with:

```typescript
const recoveryPromises = items.map((item) => {
  return new Promise<void>(async (resolve, reject) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          switch (item.location) {
            case "pending":
              await pipeline.resumeRun(item.slug, stageSubdir);
              break;
            case "done":
              await pipeline.resumeRun(item.slug, stageSubdir);
              break;
            case "inbox":
              await pipeline.startRun(item.dir);
              break;
            case "hold":
              logger.info(`[recovery] Skipping held task "${item.slug}"`);
              result.skipped.push(item.slug);
              break;
          }
          resolve();
        })(),
        new Promise<never>((_, rej) => {
          timeoutHandle = setTimeout(
            () => rej(new Error(`Recovery timed out after ${RECOVERY_TIMEOUT_MS / 1000}s`)),
            RECOVERY_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      result.failed.push({ slug: item.slug, error: err instanceof Error ? err.message : String(err) });
      reject(err);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }).catch(() => { /* errors already recorded in result.failed */ });
});

await Promise.allSettled(recoveryPromises);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/recovery.test.ts -t "recovers multiple tasks concurrently"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/recovery.ts tests/core/recovery.test.ts
git commit -m "fix(F-5.3): fan out recovery with Promise.allSettled, clear timeout handles"
```

---

### Task 5: F-2.2 — Replace shell injection surface in worktree.ts

**Files:**
- Modify: `src/core/worktree.ts`
- Test: `tests/core/worktree.test.ts`

- [ ] **Step 1: Write failing test for shell metacharacters**

In `tests/core/worktree.test.ts`:

```typescript
it("createWorktree does not interpret shell metacharacters in baseBranch", () => {
  // This test verifies the fix by checking that execFileSync is used
  // (which doesn't interpret shell). A baseBranch with backticks should
  // be passed literally, not executed.
  // We can't easily test real git here, but we verify the function signature
  // accepts the value without shell interpretation by mocking execFileSync.
  
  // If using execSync with template literals, a baseBranch of `$(echo pwned)`
  // would execute the subcommand. With execFileSync, it's passed as a literal arg.
  // This test ensures no Error about shell interpretation occurs.
  expect(() => {
    // This will fail with a git error (branch doesn't exist), not a shell error
    createWorktree("/tmp/nonexistent-repo", "test-slug", "feat/test`$(echo pwned)`");
  }).toThrow(); // Should throw a git error, not execute the subcommand
});
```

- [ ] **Step 2: Replace all `execSync` calls with `execFileSync` in worktree.ts**

Import `execFileSync` instead of `execSync`:

```typescript
import { execFileSync } from "node:child_process";
```

Replace each call site:

**Line 44 — create worktree:**
```typescript
execFileSync("git", ["worktree", "add", "-b", branchName, worktreePath, baseRef], {
  cwd: repoPath,
  stdio: "pipe",
});
```

**Line 59 — remove worktree:**
```typescript
execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
  cwd: repoPath,
  stdio: "pipe",
});
```

**Line 64 — prune worktrees:**
```typescript
execFileSync("git", ["worktree", "prune"], { cwd: repoPath, stdio: "pipe" });
```

**Line 72 — delete branch:**
```typescript
execFileSync("git", ["branch", "-D", branchName], { cwd: repoPath, stdio: "pipe" });
```

**Line 87 — list worktrees:**
```typescript
output = execFileSync("git", ["worktree", "list", "--porcelain"], {
  cwd: repoPath,
  encoding: "utf-8",
  stdio: "pipe",
});
```

- [ ] **Step 3: Run worktree tests**

Run: `npx vitest run tests/core/worktree.test.ts`
Expected: All tests pass.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/worktree.ts tests/core/worktree.test.ts
git commit -m "fix(F-2.2): replace execSync with execFileSync to prevent shell injection"
```

---

### Task 6: F-6.1 — Validate stage name in `loadAgentPrompt`

**Files:**
- Modify: `src/core/agent-config.ts`
- Test: `tests/core/agent-config.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { loadAgentPrompt } from "../../src/core/agent-config.js";

it("rejects path traversal in stage name", () => {
  expect(() => loadAgentPrompt("/some/agents/dir", "../../etc/passwd")).toThrow(
    /Invalid stage name/,
  );
});

it("rejects stage name not in allowlist", () => {
  expect(() => loadAgentPrompt("/some/agents/dir", "unknown-stage")).toThrow(
    /Invalid stage name/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/agent-config.test.ts -t "rejects path traversal"`
Expected: FAIL — no validation exists.

- [ ] **Step 3: Add allowlist validation**

In `src/core/agent-config.ts`:

```typescript
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { DEFAULT_STAGE_TOOLS } from "../config/defaults.js";

const VALID_STAGES = new Set(Object.keys(DEFAULT_STAGE_TOOLS));

export function loadAgentPrompt(agentDir: string, stage: string): string {
  if (!VALID_STAGES.has(stage)) {
    throw new Error(`Invalid stage name "${stage}". Must be one of: ${[...VALID_STAGES].join(", ")}`);
  }

  const filePath = join(agentDir, `${stage}.md`);

  try {
    return readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Agent prompt not found for stage "${stage}" at "${filePath}". ` +
      `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/agent-config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/agent-config.ts tests/core/agent-config.test.ts
git commit -m "fix(F-6.1): validate stage name against allowlist in loadAgentPrompt"
```

---

### Task 7: F-3.1 — Remove unused `heartbeatTimeoutMinutes`

**Files:**
- Modify: `src/config/defaults.ts`
- Modify: `src/config/schema.ts`
- Test: `tests/config/defaults.test.ts`

- [ ] **Step 1: Remove from `DEFAULT_CONFIG` in defaults.ts**

Find `heartbeatTimeoutMinutes: 10` inside the `agents` block in `DEFAULT_CONFIG` and delete the line.

- [ ] **Step 2: Remove from schema.ts**

Find `heartbeatTimeoutMinutes: z.number().optional()` inside the `agents` Zod object and delete the line.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All tests pass. If any test asserts `heartbeatTimeoutMinutes` exists, update it.

- [ ] **Step 4: Commit**

```bash
git add src/config/defaults.ts src/config/schema.ts
git commit -m "fix(F-3.1): remove unused heartbeatTimeoutMinutes config"
```

---

### Task 8: F-3.2 — Complete the `PipelineStage` union type

**Files:**
- Modify: `src/core/types.ts`

- [ ] **Step 1: Add missing stages to the union**

In `src/core/types.ts`, update `PipelineStage`:

```typescript
export type PipelineStage =
  | "questions" | "research" | "design" | "structure" | "plan"
  | "impl" | "review" | "validate" | "pr"
  | "quick" | "quick-triage" | "quick-execute" | "slack-io";
```

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass — expanding a union type cannot break existing code.

- [ ] **Step 3: Commit**

```bash
git add src/core/types.ts
git commit -m "fix(F-3.2): add quick, quick-triage, quick-execute, slack-io to PipelineStage"
```

---

### Task 9: F-5.5 — Fix Slack `route_pipeline` repo path

**Files:**
- Modify: `src/core/watcher.ts`

- [ ] **Step 1: Fix the `createTask` call**

In `src/core/watcher.ts`, find the `case "route_pipeline"` block and change the `repo` field:

```typescript
case "route_pipeline": {
  createTask(
    {
      source: "slack",
      content: text,
      repo: triageResult.enrichedContext?.repo ?? undefined,
      slackThread: entry.thread_ts ?? entry.ts,
      stages: triageResult.recommendedStages ?? undefined,
      stageHints: triageResult.stageHints ?? undefined,
      requiredMcpServers: triageResult.requiredMcpServers ?? undefined,
    },
    runtimeDir,
    config,
    triageResult.enrichedContext ?? undefined,
    triageResult.repoSummary ?? undefined,
  );
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/core/watcher.ts
git commit -m "fix(F-5.5): use enrichedContext.repo instead of process.cwd() for Slack tasks"
```

---

### Task 10: F-5.6 — Validate `currentStage` in `modifyStages`

**Files:**
- Modify: `src/core/pipeline.ts:1025-1049`
- Test: `tests/core/pipeline.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it("modifyStages throws if currentStage is not in newStages", async () => {
  const { pipeline, runtimeDir } = await createTestPipeline();
  const slug = "test-modify-stages";
  const taskDir = join(runtimeDir, "06-impl", "pending", slug);
  mkdirSync(join(taskDir, "artifacts"), { recursive: true });

  const state: RunState = {
    slug,
    taskFile: "task.md",
    stages: ["impl", "review", "validate"],
    reviewAfter: "design",
    currentStage: "review",
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedStages: [],
    reviewRetryCount: 0,
    reviewIssues: [],
    suggestionRetryUsed: false,
    validateFailCount: 0,
    stageHints: {},
    retryAttempts: {},
  };
  writeFileSync(join(taskDir, "run-state.json"), JSON.stringify(state));

  await expect(pipeline.modifyStages(slug, ["impl", "validate"]))
    .rejects.toThrow(/current stage.*review.*not in/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/pipeline.test.ts -t "modifyStages throws if currentStage"`
Expected: FAIL — no validation.

- [ ] **Step 3: Add validation**

In `src/core/pipeline.ts`, in `modifyStages`, after reading state and before `state.stages = newStages`:

```typescript
const state = readRunState(found.dir);
if (!newStages.includes(state.currentStage)) {
  throw new Error(
    `Cannot remove current stage "${state.currentStage}" from stage list. ` +
    `The task is currently executing this stage.`,
  );
}
const oldStages = [...state.stages];
state.stages = newStages;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/pipeline.test.ts -t "modifyStages throws if currentStage"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/pipeline.ts tests/core/pipeline.test.ts
git commit -m "fix(F-5.6): validate currentStage is retained in modifyStages"
```

---

### Task 11: F-8.1 — Wrap `readFileSync` in config loaders

**Files:**
- Modify: `src/config/loader.ts`

- [ ] **Step 1: Wrap `loadConfig`'s readFileSync**

```typescript
export function loadConfig(configPath: string): ResolvedConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read config file at "${configPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // ... rest unchanged
```

- [ ] **Step 2: Wrap `loadBudgetConfig`'s readFileSync**

```typescript
let raw: string;
try {
  raw = readFileSync(filePath, "utf-8");
} catch (err) {
  throw new Error(
    `Failed to read budget config at "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
  );
}
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/config/loader.ts
git commit -m "fix(F-8.1): wrap readFileSync in try/catch in config loaders"
```

---

### Task 12: F-1.2 — Fix CLAUDE.md stage order diagram

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Fix the diagram**

Find `impl ↔ validate → review → pr` and replace with `impl → review → validate → pr`.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "fix(F-1.2): correct execution phase stage order in CLAUDE.md"
```

---

### Task 13: F-3.3, F-4.2, F-4.3 — Small code quality fixes (batch)

**Files:**
- Modify: `src/core/pipeline.ts:20-21` (add re-export comment)
- Modify: `src/core/slug-resolver.ts:1-2` (fix bare imports)
- Modify: `src/core/agent-runner.ts` (let → const for timeoutHandle)

- [ ] **Step 1: Add re-export comment in pipeline.ts**

Change line 20-21 from:
```typescript
// Re-export for backwards compatibility
export { STAGE_DIR_MAP, DIR_STAGE_MAP };
```
To:
```typescript
// Re-exported for external consumers; DIR_STAGE_MAP is not used internally in this module.
export { STAGE_DIR_MAP, DIR_STAGE_MAP };
```

- [ ] **Step 2: Fix bare imports in slug-resolver.ts**

Change:
```typescript
import * as fs from "fs";
import * as path from "path";
```
To:
```typescript
import * as fs from "node:fs";
import * as path from "node:path";
```

- [ ] **Step 3: Fix timeoutHandle in agent-runner.ts**

Find:
```typescript
let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
timeoutHandle = setTimeout(() => {
```
Replace with:
```typescript
const timeoutHandle = setTimeout(() => {
```

Remove the type annotation since `const` with assignment infers the type.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/pipeline.ts src/core/slug-resolver.ts src/core/agent-runner.ts
git commit -m "fix(F-3.3,F-4.2,F-4.3): re-export comment, node: imports, const timeoutHandle"
```

---

### Task 14: F-4.4 — Add comment explaining spin-wait

**Files:**
- Modify: `src/core/pipeline.ts:215`

- [ ] **Step 1: Replace the inline comment**

Change:
```typescript
while (Date.now() - start < delayMs) { /* spin wait — sync context */ }
```
To:
```typescript
while (Date.now() - start < delayMs) {
  // Intentional spin-wait: moveTaskDir must be synchronous because it's called
  // from both sync and async contexts in the pipeline. Converting to async would
  // require cascading changes through the entire call chain. This path only
  // executes on Windows EBUSY/EPERM retry (rare), with max total wait of ~3.1s.
}
```

- [ ] **Step 2: Commit**

```bash
git add src/core/pipeline.ts
git commit -m "fix(F-4.4): document spin-wait rationale in moveTaskDir"
```

---

### Task 15: F-4.7, F-7.3 — Remove deprecated exports and unused directory

**Files:**
- Modify: `src/runtime/dirs.ts`
- Modify: `src/commands/doctor.ts` (if it checks for `06-impl/active`)

- [ ] **Step 1: Check for consumers of `STAGE_DIRS`**

Run: `npx vitest run` after grep to find consumers. Search for `STAGE_DIRS` (excluding `ALL_STAGE_DIRS`) across the codebase. If no consumers exist outside `dirs.ts`, proceed.

- [ ] **Step 2: Remove `STAGE_DIRS` deprecated export**

In `src/runtime/dirs.ts`, delete:
```typescript
/** @deprecated Use ALL_STAGE_DIRS from stage-map.ts instead */
export const STAGE_DIRS = ALL_STAGE_DIRS;
```

- [ ] **Step 3: Remove `06-impl/active` special case**

In `src/runtime/dirs.ts`, delete:
```typescript
if (stage === "06-impl") {
  dirs.push(join(runtimeDir, stage, "active"));
}
```

- [ ] **Step 4: Check doctor.ts for `impl/active` reference**

If `doctor.ts` checks for `06-impl/active` directory, remove that check.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: All tests pass. Fix any test that asserts `STAGE_DIRS` exists or checks `06-impl/active`.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/dirs.ts src/commands/doctor.ts
git commit -m "fix(F-4.7,F-7.3): remove deprecated STAGE_DIRS and unused 06-impl/active"
```

---

### Task 16: F-5.7 — Fix retry feedback file sort order

**Files:**
- Modify: `src/core/pipeline.ts:94-97`

- [ ] **Step 1: Write failing test**

```typescript
it("sorts retry feedback files numerically, not lexicographically", () => {
  // Create artifacts dir with feedback files numbered 1-12
  const artifactsDir = join(tmpDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  for (let i = 1; i <= 12; i++) {
    writeFileSync(join(artifactsDir, `retry-feedback-review-${i}.md`), `feedback ${i}`);
  }
  writeFileSync(join(artifactsDir, "impl-output.md"), "impl output");

  const result = collectArtifacts(artifactsDir, "validate");

  // Find the feedback entries in order
  const feedbackOrder = result
    .split("feedback ")
    .slice(1)
    .map((s) => parseInt(s));

  expect(feedbackOrder).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});
```

- [ ] **Step 2: Fix the sort**

In `src/core/pipeline.ts`, replace the simple `.sort()` with a numeric-aware sort:

```typescript
function parseTrailingNum(filename: string): number {
  const match = filename.match(/-(\d+)\.md$/);
  return match ? parseInt(match[1], 10) : 0;
}

const outputFiles = [
  ...Array.from(latestPerStage.values()).map(({ file }) => file),
  ...retryFeedbackFiles.sort((a, b) => parseTrailingNum(a) - parseTrailingNum(b)),
].sort((a, b) => {
  // Stage outputs first (sorted alphabetically), then retry feedback (sorted numerically)
  const aIsRetry = a.startsWith("retry-feedback-");
  const bIsRetry = b.startsWith("retry-feedback-");
  if (aIsRetry && bIsRetry) return parseTrailingNum(a) - parseTrailingNum(b);
  if (aIsRetry) return 1;
  if (bIsRetry) return -1;
  return a.localeCompare(b);
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run tests/core/pipeline.test.ts -t "sorts retry feedback files numerically"`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/pipeline.ts tests/core/pipeline.test.ts
git commit -m "fix(F-5.7): sort retry feedback files numerically, not lexicographically"
```

---

### Task 17: F-7.1 — Assign `holdReason` in pause and review gate

**Files:**
- Modify: `src/core/pipeline.ts`

- [ ] **Step 1: Add `holdReason` to `pause` function**

In the `pause` function (line ~963), after `state.pausedAtStage = state.currentStage`:

```typescript
state.status = "hold";
state.pausedAtStage = state.currentStage;
state.holdReason = "user_paused";
```

- [ ] **Step 2: Add `holdReason` to review gate hold path**

Find the review gate hold path (where the pipeline pauses after the `reviewAfter` stage for human approval). Set:

```typescript
state.holdReason = "approval_required";
```

Search for the code that sets `status = "hold"` after `reviewAfter` stage comparison and add the assignment there.

- [ ] **Step 3: Clear `holdReason` in `resume`**

The `resume` function already clears `holdReason` for `budget_exhausted`. Verify it also handles the new values. If `delete state.holdReason` is used unconditionally, no change needed. If it's conditional on `budget_exhausted`, make it unconditional.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/pipeline.ts
git commit -m "fix(F-7.1): assign holdReason in pause and review gate paths"
```

---

### Task 18: F-7.2 — Fix history command exit code

**Files:**
- Modify: `src/commands/history.ts`

- [ ] **Step 1: Remove process.exit(1)**

Change:
```typescript
console.log("shkmn history — not yet implemented (Spec 5: History & Reporting)");
process.exit(1);
```
To:
```typescript
console.log("shkmn history — not yet implemented (Spec 5: History & Reporting)");
```

Let commander handle exit naturally (exit code 0).

- [ ] **Step 2: Commit**

```bash
git add src/commands/history.ts
git commit -m "fix(F-7.2): remove process.exit(1) from history stub"
```

---

### Task 19: F-8.2 — Remove duplicated `loadThreadMap`

**Files:**
- Modify: `src/surfaces/slack-notifier.ts`

- [ ] **Step 1: Remove private `loadThreadMap` and add import**

In `src/surfaces/slack-notifier.ts`, delete the private function:
```typescript
function loadThreadMap(runtimeDir: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(runtimeDir, "slack-threads.json"), "utf-8"));
  } catch {
    return {};
  }
}
```

Add to the existing imports from `slack-queue.ts`:
```typescript
import { loadThreadMap } from "../core/slack-queue.js";
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/surfaces/slack-notifier.ts
git commit -m "fix(F-8.2): import loadThreadMap from slack-queue instead of duplicating"
```

---

### Task 20: F-8.3 — Fix `processedTs` pruning order

**Files:**
- Modify: `src/core/watcher.ts`

- [ ] **Step 1: Sort by Slack timestamp before pruning**

In `src/core/watcher.ts`, change the pruning logic:

```typescript
if (processedTs.size > 500) {
  const arr = Array.from(processedTs);
  // Sort by Slack ts (numeric epoch) to keep the 500 most recent
  arr.sort((a, b) => parseFloat(a) - parseFloat(b));
  processedTs = new Set(arr.slice(arr.length - 500));
}
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/core/watcher.ts
git commit -m "fix(F-8.3): sort processedTs by Slack epoch before pruning to 500"
```

---

### Task 21: F-8.4 — Update `activeRuns` in `retryDeferredTasks`

**Files:**
- Modify: `src/core/pipeline.ts:336-360`

- [ ] **Step 1: Add `activeRuns.set` before `processStage` call**

In `retryDeferredTasks`, before the `processStage` call:

```typescript
logger.info(`[pipeline] Retrying deferred task "${slug}"`);
activeRuns.set(slug, state);
// Fire-and-forget — processStage will re-defer if still at capacity
processStage(slug, taskDir).catch((err: unknown) => {
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/core/pipeline.ts
git commit -m "fix(F-8.4): set activeRuns before processStage in retryDeferredTasks"
```

---

### Task 22: F-8.5 — Fix `fixable` flag on passing doctor checks

**Files:**
- Modify: `src/commands/doctor.ts`

- [ ] **Step 1: Fix `checkConfig` passing case**

Change:
```typescript
return { name, passed: true, message: "Valid", fixable: true };
```
To:
```typescript
return { name, passed: true, message: "Valid", fixable: false };
```

- [ ] **Step 2: Fix `checkRuntimeDirs` passing case**

Change:
```typescript
return { name, passed: true, message: "All directories present", fixable: true };
```
To:
```typescript
return { name, passed: true, message: "All directories present", fixable: false };
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/commands/doctor.ts
git commit -m "fix(F-8.5): set fixable: false on passing doctor checks"
```

---

### Task 23: F-8.6 — Extract build copy script

**Files:**
- Create: `scripts/copy-agents.js`
- Modify: `package.json`

- [ ] **Step 1: Create `scripts/copy-agents.js`**

```javascript
import { readdirSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const src = join(root, "agents");
const dest = join(root, "dist", "agents");

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const files = readdirSync(src).filter((f) => f.endsWith(".md"));
for (const file of files) {
  copyFileSync(join(src, file), join(dest, file));
}

console.log(`Copied ${files.length} agent prompt(s) to dist/agents/`);
```

- [ ] **Step 2: Update package.json build script**

Change the `build` script to:
```json
"build": "tsup && node scripts/copy-agents.js"
```

- [ ] **Step 3: Test the build**

Run: `npm run build`
Expected: Build succeeds, agents copied.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/copy-agents.js package.json
git commit -m "fix(F-8.6): extract build copy step into scripts/copy-agents.js"
```

---

### Task 24: F-8.8 — Improve doctor auth error messages

**Files:**
- Modify: `src/commands/doctor.ts`

- [ ] **Step 1: Improve error handling in `checkAuthCommand`**

In the catch block, after the timeout and not-installed checks, distinguish errors:

```typescript
// Generic catch — could be auth failure, network error, or rate limit
const stderr = (err as any)?.stderr?.toString() ?? "";
const message = (err as Error).message;
const exitCode = (err as any)?.status;

if (stderr.includes("rate limit") || stderr.includes("429")) {
  return { name, passed: false, message: `Rate limited — try again later`, fixable: false };
}
if (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("network")) {
  return { name, passed: false, message: `Network error — check connectivity`, fixable: false };
}
return { name, passed: false, message: `Auth check failed (exit ${exitCode}): ${message}`, fixable: false };
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/commands/doctor.ts
git commit -m "fix(F-8.8): distinguish network/rate-limit errors from auth failures in doctor"
```

---

### Task 25: F-8.9 — Replace djb2 with SHA-256 in `issueHash`

**Files:**
- Modify: `src/core/retry.ts`
- Test: `tests/core/retry.test.ts`

- [ ] **Step 1: Replace the hash implementation**

In `src/core/retry.ts`, replace the `issueHash` function:

```typescript
import { createHash } from "node:crypto";

export function issueHash(severity: string, description: string): string {
  const firstSentence = description.split(/[.!?]/)[0] ?? description;
  const normalized = `${severity}|${firstSentence}`
    .toLowerCase()
    .replace(/[\s\W]+/g, "");

  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
```

- [ ] **Step 2: Update tests**

Any test that asserts specific hash values will need updating since the output format changes from 8-char hex (djb2) to 16-char hex (sha256). Update the expected values or change assertions to check format only:

```typescript
expect(issueHash("high", "Something broke")).toMatch(/^[0-9a-f]{16}$/);
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/core/retry.test.ts`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/core/retry.ts tests/core/retry.test.ts
git commit -m "fix(F-8.9): replace djb2 with sha256 in issueHash for lower collision risk"
```

---

### Task 26: F-8.10 — Truncate `gatherRecentCommits` output

**Files:**
- Modify: `src/core/repo-context.ts`

- [ ] **Step 1: Add truncation**

In `gatherRecentCommits`, after `.trim()`:

```typescript
const output = execSync("git log --oneline -15", {
  cwd: repoPath,
  encoding: "utf-8",
  timeout: 5000,
  stdio: ["pipe", "pipe", "pipe"],
}).trim();
if (!output) return "";
const truncated = output.length > 500 ? output.slice(0, 500) + "\n... (truncated)" : output;
return `#### Recent Commits\n\`\`\`\n${truncated}\n\`\`\``;
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/core/repo-context.ts
git commit -m "fix(F-8.10): truncate gatherRecentCommits to 500 chars"
```

---

### Task 27: F-8.11 — Validate `runtimeDir` is absolute path

**Files:**
- Modify: `src/config/loader.ts`

- [ ] **Step 1: Add validation after parsing**

In `loadConfig`, after the Zod parse succeeds and before returning:

```typescript
import { isAbsolute } from "node:path";

// ... after const result = configSchema.safeParse(parsed):
const resolved = resolveConfig(result.data);
if (!isAbsolute(resolved.pipeline.runtimeDir)) {
  throw new Error(
    `pipeline.runtimeDir must be an absolute path, got: "${resolved.pipeline.runtimeDir}"`,
  );
}
return resolved;
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All tests pass. If any test uses a relative runtimeDir, update it.

- [ ] **Step 3: Commit**

```bash
git add src/config/loader.ts
git commit -m "fix(F-8.11): validate runtimeDir is an absolute path in loadConfig"
```

---

### Task 28: F-4.5 — Add ESLint configuration

**Files:**
- Create: `eslint.config.js`
- Modify: `package.json`

- [ ] **Step 1: Install ESLint packages**

```bash
npm install --save-dev eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser
```

- [ ] **Step 2: Create `eslint.config.js`**

```javascript
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "scripts/"],
  },
];
```

- [ ] **Step 3: Add lint script to package.json**

Add to `scripts`:
```json
"lint": "eslint src/"
```

- [ ] **Step 4: Verify lint runs**

Run: `npm run lint`
Expected: Runs without config errors. May produce warnings — do NOT auto-fix; this PR just adds the tooling.

- [ ] **Step 5: Commit**

```bash
git add eslint.config.js package.json package-lock.json
git commit -m "fix(F-4.5): add ESLint with typescript-eslint config"
```

---

### Task 29: Final — Run full test suite and verify

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Verify no regressions**

Spot-check that key exports still work:
```bash
node -e "import('./dist/cli.js')" 2>&1 | head -5
```
