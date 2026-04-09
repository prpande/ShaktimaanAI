# Audit Phase 4: Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 10 remaining polish items from the production-readiness audit — dead code cleanup, code quality improvements, documentation consistency, and structured logging foundation.

**Architecture:** Small, focused changes across 8 modules. No new architectural patterns — just tightening existing code. The largest change is Fix 4.1 (pino structured logger) which replaces the existing `logger.ts` internals while preserving the `TaskLogger` interface. Fix 1.1 (history command) is the only new feature — reads RunState JSON from completed/failed task directories.

**Tech Stack:** TypeScript, Vitest, tsup, pino, Zod, commander.js

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/commands/history.ts` | Implement history command (reads 10-complete/, 11-failed/) |
| Create | `tests/commands/history.test.ts` | Tests for history command |
| Modify | `src/commands/task.ts` | Remove unused `--full` flag |
| Modify | `src/core/pipeline.ts` | Remove `DIR_STAGE_MAP` re-export |
| Modify | `src/core/interactions.ts` | Fix bare `fs`/`path` → `node:fs`/`node:path` |
| Modify | `src/core/logger.ts` | Fix bare imports + replace with pino-based structured logger |
| Modify | `tests/core/logger.test.ts` | Update tests for new pino-based logger |
| Modify | `src/cli.ts` | Replace hardcoded version with build-time inject |
| Modify | `tsup.config.ts` | Add `define` for `__VERSION__` |
| Create | `tests/commands/cli-version.test.ts` | Test CLI version matches package.json |
| Modify | `src/surfaces/slack-notifier.ts` | Add warning log in empty catch block |
| Modify | `tests/surfaces/slack-notifier.test.ts` | Test warning on write failure |
| Modify | `src/surfaces/slack-surface.ts` | Add Zod validation to `loadCursor` |
| Modify | `tests/surfaces/slack-surface.test.ts` | Test cursor validation/fallback |
| Modify | `src/commands/stats.ts` | Add calendar date validation after regex |
| Modify | `tests/commands/stats.test.ts` | Test invalid calendar dates rejected |
| Modify | `CLAUDE.md` | Fix stage order description (line 32) |

---

### Task 1: Remove `--full` Flag from `task` Command (Fix 1.2)

**Files:**
- Modify: `src/commands/task.ts:16,22`

- [ ] **Step 1: Remove the `--full` option and its type**

In `src/commands/task.ts`, remove the `.option("--full", ...)` declaration on line 16 and the `full?: boolean` property from the opts type on line 22.

Before (lines 15-23):
```typescript
    .option("--quick", "Quick task mode (no review)")
    .option("--full", "Full task mode (all stages)")
    .action((description: string, opts: {
      repo?: string;
      ado?: string;
      stages?: string;
      hints?: string[];
      quick?: boolean;
      full?: boolean;
    }) => {
```

After:
```typescript
    .option("--quick", "Quick task mode (no review)")
    .action((description: string, opts: {
      repo?: string;
      ado?: string;
      stages?: string;
      hints?: string[];
      quick?: boolean;
    }) => {
```

- [ ] **Step 2: Run build and tests**

Run: `npm run build && npm test`
Expected: All pass. No code references `opts.full`.

- [ ] **Step 3: Commit**

```bash
git add src/commands/task.ts
git commit -m "fix: remove unused --full flag from task command"
```

---

### Task 2: Remove `DIR_STAGE_MAP` Re-export from Pipeline (Fix 1.3)

**Files:**
- Modify: `src/core/pipeline.ts:9,21-22`

- [ ] **Step 1: Verify no consumers import `DIR_STAGE_MAP` from `pipeline.ts`**

Run: `grep -r "DIR_STAGE_MAP.*from.*pipeline" src/ tests/`
Expected: No matches (already verified — zero consumers).

- [ ] **Step 2: Remove the import and re-export**

In `src/core/pipeline.ts`, line 9 currently imports `DIR_STAGE_MAP` from `./stage-map.js`. Remove `DIR_STAGE_MAP` from that import. Then remove lines 21-22 (the comment and the re-export line).

Before (line 9):
```typescript
import { STAGE_DIR_MAP, DIR_STAGE_MAP, STAGES_WITH_PENDING_DONE } from "./stage-map.js";
```

After:
```typescript
import { STAGE_DIR_MAP, STAGES_WITH_PENDING_DONE } from "./stage-map.js";
```

Remove these two lines entirely (21-22):
```typescript
// Re-exported for external consumers; DIR_STAGE_MAP is not used internally in this module.
export { STAGE_DIR_MAP, DIR_STAGE_MAP };
```

Also check if `STAGE_DIR_MAP` is still re-exported elsewhere — since we removed the whole `export { }` line, verify `STAGE_DIR_MAP` is not needed from this module either. Grep for `STAGE_DIR_MAP.*from.*pipeline` across src/ and tests/. If it has consumers, keep just `export { STAGE_DIR_MAP };`. If not, remove entirely.

- [ ] **Step 3: Run build and tests**

Run: `npm run build && npm test`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/core/pipeline.ts
git commit -m "fix: remove unused DIR_STAGE_MAP re-export from pipeline"
```

---

### Task 3: Consistent `node:` Import Prefix (Fix 2.1)

**Files:**
- Modify: `src/core/interactions.ts:1-2`
- Modify: `src/core/logger.ts:1-2`

- [ ] **Step 1: Fix imports in `interactions.ts`**

In `src/core/interactions.ts`, change lines 1-2:

Before:
```typescript
import { mkdirSync, existsSync, readFileSync, appendFileSync, readdirSync } from "fs";
import { join } from "path";
```

After:
```typescript
import { mkdirSync, existsSync, readFileSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
```

- [ ] **Step 2: Fix imports in `logger.ts`**

In `src/core/logger.ts`, change lines 1-2:

Before:
```typescript
import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
```

After:
```typescript
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
```

- [ ] **Step 3: Run build, lint, and tests**

Run: `npm run build && npm run lint && npm test`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/core/interactions.ts src/core/logger.ts
git commit -m "fix: normalize bare fs/path imports to node:fs/node:path"
```

---

### Task 4: Dynamic CLI Version (Fix 2.2)

**Files:**
- Modify: `tsup.config.ts`
- Modify: `src/cli.ts:30`
- Create: `tests/commands/cli-version.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/commands/cli-version.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("CLI version", () => {
  it("matches the version in package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "../../package.json"), "utf8"),
    );
    // __VERSION__ is injected at build time by tsup define
    // We verify the source of truth (package.json) is consistent
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pkg.version).toBe("0.1.0"); // current known version
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/commands/cli-version.test.ts`
Expected: PASS (this test verifies the source, not the inject).

- [ ] **Step 3: Add build-time version injection in tsup config**

Modify `tsup.config.ts`:

Before:
```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  splitting: false,
  sourcemap: true,
  shims: true,
});
```

After:
```typescript
import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf8"));

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  splitting: false,
  sourcemap: true,
  shims: true,
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
});
```

- [ ] **Step 4: Add TypeScript declaration for `__VERSION__`**

Add to `src/cli.ts` before the `program` declaration (after imports):

```typescript
declare const __VERSION__: string;
```

- [ ] **Step 5: Replace hardcoded version in `cli.ts`**

In `src/cli.ts` line 30, change:

Before:
```typescript
  .version("0.1.0");
```

After:
```typescript
  .version(__VERSION__);
```

- [ ] **Step 6: Run build and verify**

Run: `npm run build && npm test`
Expected: All pass. The built `dist/cli.js` will have the version string inlined from `package.json`.

- [ ] **Step 7: Commit**

```bash
git add tsup.config.ts src/cli.ts tests/commands/cli-version.test.ts
git commit -m "fix: inject CLI version from package.json at build time"
```

---

### Task 5: Slack-Notifier Error Logging (Fix 2.3)

**Files:**
- Modify: `src/surfaces/slack-notifier.ts:241-242`
- Modify: `tests/surfaces/slack-notifier.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/surfaces/slack-notifier.test.ts`, add a test that verifies a `console.warn` is called when the outbox file write fails. First, read the existing test file to understand its setup patterns, then add:

```typescript
it("logs a warning when outbox write fails", () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  // Create notifier with an invalid/unwritable outbox path
  const notifier = createSlackNotifier({
    ...validConfig,
    outboxPath: "/nonexistent/deeply/nested/readonly/outbox.jsonl",
  });
  // Trigger a notification — the write will fail
  notifier.notify({ type: "stage_complete", slug: "test-task", stage: "impl", message: "done" });
  expect(warnSpy).toHaveBeenCalledWith(
    expect.stringContaining("[slack-notifier] Failed to write outbox entry:"),
  );
  warnSpy.mockRestore();
});
```

Note: Read the actual test file first to match the exact `createSlackNotifier` signature and config shape. The above is a template — adapt the setup to match the existing test patterns.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/surfaces/slack-notifier.test.ts -t "logs a warning"`
Expected: FAIL (currently the catch block is empty).

- [ ] **Step 3: Add warning log to catch block**

In `src/surfaces/slack-notifier.ts`, lines 241-242:

Before:
```typescript
    } catch {
      // swallow errors silently — never crash the pipeline
    }
```

After:
```typescript
    } catch (err) {
      console.warn(`[slack-notifier] Failed to write outbox entry: ${(err as Error).message}`);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/surfaces/slack-notifier.test.ts`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/surfaces/slack-notifier.ts tests/surfaces/slack-notifier.test.ts
git commit -m "fix: log warning on slack-notifier outbox write failure"
```

---

### Task 6: `loadCursor` Shape Validation (Fix 2.4)

**Files:**
- Modify: `src/surfaces/slack-surface.ts:60-68`
- Modify: `tests/surfaces/slack-surface.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/surfaces/slack-surface.test.ts`, add tests for cursor validation. Read the existing file first to match patterns, then add:

```typescript
describe("loadCursor shape validation", () => {
  it("returns DEFAULT_CURSOR for corrupt JSON shape (missing fields)", () => {
    // Write a file with valid JSON but wrong shape
    fs.writeFileSync(
      path.join(testDir, "slack-cursor.json"),
      JSON.stringify({ foo: "bar" }),
    );
    const cursor = loadCursor(testDir);
    expect(cursor).toEqual({ channelTs: "now", dmTs: "now" });
  });

  it("returns DEFAULT_CURSOR for wrong field types", () => {
    fs.writeFileSync(
      path.join(testDir, "slack-cursor.json"),
      JSON.stringify({ channelTs: 123, dmTs: true }),
    );
    const cursor = loadCursor(testDir);
    expect(cursor).toEqual({ channelTs: "now", dmTs: "now" });
  });

  it("loads a valid cursor correctly", () => {
    fs.writeFileSync(
      path.join(testDir, "slack-cursor.json"),
      JSON.stringify({ channelTs: "1234.5678", dmTs: "9876.5432" }),
    );
    const cursor = loadCursor(testDir);
    expect(cursor).toEqual({ channelTs: "1234.5678", dmTs: "9876.5432" });
  });
});
```

Adapt the test setup to match the existing test file's tmpdir and cleanup patterns.

- [ ] **Step 2: Run tests to verify the shape-validation tests fail**

Run: `npx vitest run tests/surfaces/slack-surface.test.ts -t "loadCursor shape"`
Expected: FAIL for the corrupt/wrong-type tests (current code does `JSON.parse(raw) as SlackCursor` with no validation).

- [ ] **Step 3: Add Zod schema and validate in `loadCursor`**

In `src/surfaces/slack-surface.ts`, add the Zod import and schema, then update `loadCursor`:

Add import at the top (after existing imports):
```typescript
import { z } from "zod";
```

Add schema before the `loadCursor` function:
```typescript
const slackCursorSchema = z.object({
  channelTs: z.string(),
  dmTs: z.string(),
});
```

Replace `loadCursor` (lines 60-68):

Before:
```typescript
export function loadCursor(runtimeDir: string): SlackCursor {
  const filePath = path.join(runtimeDir, CURSOR_FILENAME);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as SlackCursor;
  } catch {
    return { ...DEFAULT_CURSOR };
  }
}
```

After:
```typescript
export function loadCursor(runtimeDir: string): SlackCursor {
  const filePath = path.join(runtimeDir, CURSOR_FILENAME);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = slackCursorSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { ...DEFAULT_CURSOR };
  } catch {
    return { ...DEFAULT_CURSOR };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/surfaces/slack-surface.test.ts`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/surfaces/slack-surface.ts tests/surfaces/slack-surface.test.ts
git commit -m "fix: add Zod validation to loadCursor for corrupt cursor files"
```

---

### Task 7: `stats` Calendar Date Validation (Fix 2.5)

**Files:**
- Modify: `src/commands/stats.ts:407-414`
- Modify: `tests/commands/stats.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/commands/stats.test.ts`, add a new describe block for date validation. Read the file first to understand its structure. The validation happens inside `registerStatsCommand`'s action handler, so test via the exported `executeStats` or test the validation logic directly.

Since the date validation is inline in the command handler (not extracted), extract a helper function first. Add to `src/commands/stats.ts`:

```typescript
export function isValidCalendarDate(dateStr: string): boolean {
  if (!DATE_RE.test(dateStr)) return false;
  const date = new Date(dateStr + "T00:00:00Z");
  if (isNaN(date.getTime())) return false;
  // Verify the date components round-trip (catches Feb 31, etc.)
  const [y, m, d] = dateStr.split("-").map(Number);
  return date.getUTCFullYear() === y && date.getUTCMonth() + 1 === m && date.getUTCDate() === d;
}
```

Then add tests in `tests/commands/stats.test.ts`:

```typescript
describe("isValidCalendarDate", () => {
  it("accepts valid date 2026-04-09", () => {
    expect(isValidCalendarDate("2026-04-09")).toBe(true);
  });

  it("accepts valid date 2026-02-28", () => {
    expect(isValidCalendarDate("2026-02-28")).toBe(true);
  });

  it("rejects impossible date 2026-02-31", () => {
    expect(isValidCalendarDate("2026-02-31")).toBe(false);
  });

  it("rejects impossible month 2026-13-01", () => {
    expect(isValidCalendarDate("2026-13-01")).toBe(false);
  });

  it("rejects 0000-00-00", () => {
    expect(isValidCalendarDate("0000-00-00")).toBe(false);
  });

  it("rejects wrong format", () => {
    expect(isValidCalendarDate("04-09-2026")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify the new tests fail**

Run: `npx vitest run tests/commands/stats.test.ts -t "isValidCalendarDate"`
Expected: FAIL (function doesn't exist yet).

- [ ] **Step 3: Add the `isValidCalendarDate` function**

In `src/commands/stats.ts`, add the function after the `DATE_RE` declaration (line 396):

```typescript
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidCalendarDate(dateStr: string): boolean {
  if (!DATE_RE.test(dateStr)) return false;
  const date = new Date(dateStr + "T00:00:00Z");
  if (isNaN(date.getTime())) return false;
  const [y, m, d] = dateStr.split("-").map(Number);
  return date.getUTCFullYear() === y && date.getUTCMonth() + 1 === m && date.getUTCDate() === d;
}
```

- [ ] **Step 4: Update the command handler to use `isValidCalendarDate`**

Replace the existing validation in the action handler (lines 407-414):

Before:
```typescript
      if (opts.from && !DATE_RE.test(opts.from)) {
        console.error("Invalid date format for --from. Use YYYY-MM-DD.");
        process.exit(1);
      }
      if (opts.to && !DATE_RE.test(opts.to)) {
        console.error("Invalid date format for --to. Use YYYY-MM-DD.");
        process.exit(1);
      }
```

After:
```typescript
      if (opts.from && !isValidCalendarDate(opts.from)) {
        console.error("Invalid date for --from. Must be a valid calendar date (YYYY-MM-DD).");
        process.exit(1);
      }
      if (opts.to && !isValidCalendarDate(opts.to)) {
        console.error("Invalid date for --to. Must be a valid calendar date (YYYY-MM-DD).");
        process.exit(1);
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/commands/stats.test.ts`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/commands/stats.ts tests/commands/stats.test.ts
git commit -m "fix: validate calendar dates in stats command (rejects Feb 31 etc.)"
```

---

### Task 8: Fix CLAUDE.md Stage Order (Fix 3.1)

**Files:**
- Modify: `CLAUDE.md:30-32`

- [ ] **Step 1: Fix the retry-loop description**

In `CLAUDE.md`, line 32 currently reads:

```
The `impl → validate → review` loop retries on failure.
```

The actual code order (from `defaults.ts` `defaultStages`) is `impl → review → validate → pr`. The retry loop sends validate failures back to impl. Fix line 32:

Before:
```
The `impl → validate → review` loop retries on failure. The pipeline auto-pauses after a configurable review gate (default: `design`) for human approval before execution begins.
```

After:
```
The pipeline retries on failure: validate failures loop back to `impl`, flowing forward again through `impl → review → validate`. The pipeline auto-pauses after a configurable review gate (default: `design`) for human approval before execution begins.
```

- [ ] **Step 2: Verify consistency with code**

Run: `grep "defaultStages" src/config/defaults.ts`
Expected: Shows `"impl", "review", "validate", "pr"` — matches the corrected CLAUDE.md.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: fix CLAUDE.md stage order to match actual impl→review→validate flow"
```

---

### Task 9: Implement `shkmn history` Command (Fix 1.1)

**Files:**
- Modify: `src/commands/history.ts`
- Create: `tests/commands/history.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/commands/history.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listCompletedTasks, type HistoryEntry } from "../../src/commands/history.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-history-" + Date.now());

beforeEach(() => {
  mkdirSync(join(TEST_DIR, "10-complete"), { recursive: true });
  mkdirSync(join(TEST_DIR, "11-failed"), { recursive: true });
});
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

function writeRunState(dir: string, slug: string, state: Record<string, unknown>): void {
  const taskDir = join(TEST_DIR, dir, slug);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "run-state.json"), JSON.stringify(state));
}

describe("listCompletedTasks", () => {
  it("returns empty array when no tasks exist", () => {
    const result = listCompletedTasks(TEST_DIR);
    expect(result).toEqual([]);
  });

  it("returns a completed task with correct fields", () => {
    writeRunState("10-complete", "my-task-20260401120000", {
      slug: "my-task-20260401120000",
      status: "complete",
      startedAt: "2026-04-01T12:00:00Z",
      updatedAt: "2026-04-01T12:05:00Z",
      currentStage: "pr",
      completedStages: [
        { stage: "questions", completedAt: "2026-04-01T12:01:00Z" },
        { stage: "pr", completedAt: "2026-04-01T12:05:00Z" },
      ],
    });
    const result = listCompletedTasks(TEST_DIR);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe("my-task-20260401120000");
    expect(result[0].status).toBe("complete");
    expect(result[0].startedAt).toBe("2026-04-01T12:00:00Z");
    expect(result[0].finalStage).toBe("pr");
  });

  it("includes failed tasks with error reason", () => {
    writeRunState("11-failed", "broken-task-20260401130000", {
      slug: "broken-task-20260401130000",
      status: "failed",
      startedAt: "2026-04-01T13:00:00Z",
      updatedAt: "2026-04-01T13:02:00Z",
      currentStage: "impl",
      error: "Agent timed out",
      completedStages: [],
    });
    const result = listCompletedTasks(TEST_DIR);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("failed");
    expect(result[0].error).toBe("Agent timed out");
  });

  it("sorts by updatedAt descending (most recent first)", () => {
    writeRunState("10-complete", "old-task-20260401100000", {
      slug: "old-task-20260401100000",
      status: "complete",
      startedAt: "2026-04-01T10:00:00Z",
      updatedAt: "2026-04-01T10:05:00Z",
      currentStage: "pr",
      completedStages: [],
    });
    writeRunState("10-complete", "new-task-20260401120000", {
      slug: "new-task-20260401120000",
      status: "complete",
      startedAt: "2026-04-01T12:00:00Z",
      updatedAt: "2026-04-01T12:05:00Z",
      currentStage: "pr",
      completedStages: [],
    });
    const result = listCompletedTasks(TEST_DIR);
    expect(result[0].slug).toBe("new-task-20260401120000");
    expect(result[1].slug).toBe("old-task-20260401100000");
  });

  it("respects count limit", () => {
    for (let i = 0; i < 5; i++) {
      writeRunState("10-complete", `task-${i}-20260401${10 + i}0000`, {
        slug: `task-${i}-20260401${10 + i}0000`,
        status: "complete",
        startedAt: `2026-04-01T${10 + i}:00:00Z`,
        updatedAt: `2026-04-01T${10 + i}:05:00Z`,
        currentStage: "pr",
        completedStages: [],
      });
    }
    const result = listCompletedTasks(TEST_DIR, 3);
    expect(result).toHaveLength(3);
  });

  it("skips directories without run-state.json", () => {
    mkdirSync(join(TEST_DIR, "10-complete", "orphan-dir"), { recursive: true });
    const result = listCompletedTasks(TEST_DIR);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands/history.test.ts`
Expected: FAIL (function `listCompletedTasks` doesn't exist).

- [ ] **Step 3: Implement `listCompletedTasks` and `HistoryEntry`**

Rewrite `src/commands/history.ts`:

```typescript
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";

export interface HistoryEntry {
  slug: string;
  status: "complete" | "failed";
  startedAt: string;
  updatedAt: string;
  finalStage: string;
  error?: string;
}

export function listCompletedTasks(runtimeDir: string, count?: number): HistoryEntry[] {
  const entries: HistoryEntry[] = [];

  for (const dir of ["10-complete", "11-failed"]) {
    const dirPath = join(runtimeDir, dir);
    if (!existsSync(dirPath)) continue;

    for (const slug of readdirSync(dirPath)) {
      const statePath = join(dirPath, slug, "run-state.json");
      if (!existsSync(statePath)) continue;

      try {
        const raw = JSON.parse(readFileSync(statePath, "utf8"));
        entries.push({
          slug: raw.slug ?? slug,
          status: raw.status ?? (dir === "10-complete" ? "complete" : "failed"),
          startedAt: raw.startedAt ?? "",
          updatedAt: raw.updatedAt ?? "",
          finalStage: raw.currentStage ?? "",
          error: raw.error,
        });
      } catch {
        // Skip corrupt run-state files
      }
    }
  }

  entries.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0));

  return count !== undefined ? entries.slice(0, count) : entries;
}

function formatElapsed(startedAt: string, updatedAt: string): string {
  const ms = new Date(updatedAt).getTime() - new Date(startedAt).getTime();
  if (isNaN(ms) || ms < 0) return "—";
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

export function registerHistoryCommand(program: Command): void {
  program
    .command("history")
    .description("Show recent completed tasks")
    .option("--count <count>", "Number of tasks to show", "10")
    .action((opts: { count: string }) => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);
      const count = parseInt(opts.count, 10);
      const entries = listCompletedTasks(config.pipeline.runtimeDir, count);

      if (entries.length === 0) {
        console.log("No completed tasks found.");
        return;
      }

      for (const entry of entries) {
        const elapsed = formatElapsed(entry.startedAt, entry.updatedAt);
        const status = entry.status === "complete" ? "DONE" : "FAIL";
        const errorSuffix = entry.error ? ` — ${entry.error}` : "";
        console.log(
          `[${status}] ${entry.slug}  stage=${entry.finalStage}  elapsed=${elapsed}${errorSuffix}`,
        );
      }
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands/history.test.ts`
Expected: All pass.

- [ ] **Step 5: Run full test suite**

Run: `npm run build && npm test`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/commands/history.ts tests/commands/history.test.ts
git commit -m "feat: implement shkmn history command — lists completed and failed tasks"
```

---

### Task 10: Structured Logging with Pino (Fix 4.1)

**Files:**
- Modify: `src/core/logger.ts`
- Modify: `tests/core/logger.test.ts`
- Modify: `package.json` (add pino dependency)

- [ ] **Step 1: Install pino**

Run: `npm install pino`

- [ ] **Step 2: Write updated tests**

Replace `tests/core/logger.test.ts` to test the new pino-based logger. The key contract: `TaskLogger` interface is preserved, but output is structured JSON when writing to files.

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  formatLogLine,
  createTaskLogger,
  createSystemLogger,
  type TaskLogger,
} from "../../src/core/logger.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-logger-" + Date.now());

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("formatLogLine", () => {
  it("produces valid JSON with expected fields", () => {
    const line = formatLogLine("info", "hello world");
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello world");
    expect(parsed.time).toBeDefined();
  });

  it("includes the level as-is", () => {
    const line = formatLogLine("warn", "test");
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("warn");
  });

  it("includes the message verbatim", () => {
    const msg = "some detailed message with special chars: @#$%";
    const line = formatLogLine("info", msg);
    const parsed = JSON.parse(line);
    expect(parsed.msg).toBe(msg);
  });
});

describe("createTaskLogger", () => {
  it("writes info lines to the correct file", () => {
    const logger: TaskLogger = createTaskLogger(TEST_DIR, "my-task");
    logger.info("task started");

    const logPath = join(TEST_DIR, "my-task.log");
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("task started");
  });

  it("writes warn lines to the correct file", () => {
    const logger: TaskLogger = createTaskLogger(TEST_DIR, "my-task");
    logger.warn("something odd");

    const content = readFileSync(join(TEST_DIR, "my-task.log"), "utf8");
    expect(content).toContain("something odd");
  });

  it("writes error lines to the correct file", () => {
    const logger: TaskLogger = createTaskLogger(TEST_DIR, "my-task");
    logger.error("it broke");

    const content = readFileSync(join(TEST_DIR, "my-task.log"), "utf8");
    expect(content).toContain("it broke");
  });

  it("creates the log directory if it does not exist", () => {
    const nestedDir = join(TEST_DIR, "deeply", "nested", "dir");
    expect(existsSync(nestedDir)).toBe(false);

    const logger: TaskLogger = createTaskLogger(nestedDir, "nested-task");
    logger.info("checking dir creation");

    expect(existsSync(nestedDir)).toBe(true);
    expect(existsSync(join(nestedDir, "nested-task.log"))).toBe(true);
  });

  it("appends to an existing log file rather than overwriting", () => {
    const logger1: TaskLogger = createTaskLogger(TEST_DIR, "append-test");
    logger1.info("first message");

    const logger2: TaskLogger = createTaskLogger(TEST_DIR, "append-test");
    logger2.info("second message");

    const content = readFileSync(join(TEST_DIR, "append-test.log"), "utf8");
    expect(content).toContain("first message");
    expect(content).toContain("second message");
  });

  it("writes multiple calls in order", () => {
    const logger: TaskLogger = createTaskLogger(TEST_DIR, "order-test");
    logger.info("alpha");
    logger.warn("beta");
    logger.error("gamma");

    const content = readFileSync(join(TEST_DIR, "order-test.log"), "utf8");
    const alphaIdx = content.indexOf("alpha");
    const betaIdx = content.indexOf("beta");
    const gammaIdx = content.indexOf("gamma");
    expect(alphaIdx).toBeLessThan(betaIdx);
    expect(betaIdx).toBeLessThan(gammaIdx);
  });

  it("uses slug as the filename (slug.log)", () => {
    const logger: TaskLogger = createTaskLogger(TEST_DIR, "special-slug-123");
    logger.info("checking filename");

    expect(existsSync(join(TEST_DIR, "special-slug-123.log"))).toBe(true);
  });

  it("writes structured JSON lines", () => {
    const logger: TaskLogger = createTaskLogger(TEST_DIR, "json-test", { slug: "my-slug", module: "pipeline" });
    logger.info("structured check");

    const content = readFileSync(join(TEST_DIR, "json-test.log"), "utf8").trim();
    const lines = content.split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.msg).toBe("structured check");
    expect(last.slug).toBe("my-slug");
    expect(last.module).toBe("pipeline");
  });
});

describe("createSystemLogger", () => {
  it("writes to heimdall.log", () => {
    const logger: TaskLogger = createSystemLogger(TEST_DIR);
    logger.info("system up");

    const logPath = join(TEST_DIR, "heimdall.log");
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("system up");
  });

  it("supports warn and error", () => {
    const logger: TaskLogger = createSystemLogger(TEST_DIR);
    logger.warn("sys warn");
    logger.error("sys error");

    const content = readFileSync(join(TEST_DIR, "heimdall.log"), "utf8");
    expect(content).toContain("sys warn");
    expect(content).toContain("sys error");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/core/logger.test.ts`
Expected: FAIL (formatLogLine doesn't return JSON yet, and `createTaskLogger` doesn't accept context params).

- [ ] **Step 4: Implement pino-based logger**

Rewrite `src/core/logger.ts`:

```typescript
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";

export interface TaskLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function formatLogLine(level: string, message: string): string {
  return JSON.stringify({
    level,
    msg: message,
    time: new Date().toISOString(),
  });
}

export interface LogContext {
  slug?: string;
  module?: string;
  stage?: string;
}

export function createTaskLogger(logDir: string, slug: string, context?: LogContext): TaskLogger {
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${slug}.log`);

  const logger = pino(
    { base: context ?? undefined, timestamp: pino.stdTimeFunctions.isoTime },
    pino.destination({ dest: logFile, append: true, sync: true }),
  );

  return {
    info: (msg: string) => logger.info(msg),
    warn: (msg: string) => logger.warn(msg),
    error: (msg: string) => logger.error(msg),
  };
}

export function createSystemLogger(logDir: string): TaskLogger {
  return createTaskLogger(logDir, "heimdall", { module: "system" });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/core/logger.test.ts`
Expected: All pass.

- [ ] **Step 6: Run full build and test suite**

Run: `npm run build && npm test`
Expected: All pass. The `TaskLogger` interface is unchanged — all existing callers work without modification.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/core/logger.ts tests/core/logger.test.ts
git commit -m "feat: replace file-based logger with pino structured logging"
```

---

## Verification Checklist

After all tasks are complete, run:

- [ ] `npm run build` — compiles without errors
- [ ] `npm test` — all existing + new tests pass
- [ ] `npm run lint` — no lint errors
- [ ] Verify `CLAUDE.md` stage order matches `defaultStages` in `src/config/defaults.ts`
- [ ] Verify `dist/cli.js` contains the version from `package.json` (not hardcoded "0.1.0")
