# Spec 9 — Centralized Path Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize all runtime directory and file path construction into a single `buildPaths()` function on `ResolvedConfig`, eliminating 80+ ad-hoc `join()` calls across 26+ files.

**Architecture:** A new `src/config/paths.ts` module exports `buildPaths(runtimeDir)` which returns a frozen `RuntimePaths` object containing pre-resolved system paths, stage/terminal dictionaries, and a `resolveTask()` factory. This object is attached to `ResolvedConfig.paths` during config loading. All downstream modules consume `config.paths.*` instead of constructing paths themselves.

**Tech Stack:** TypeScript, Node.js `path.join`, Vitest

---

## File Structure

| File | Responsibility |
|---|---|
| `src/config/paths.ts` | **NEW** — `buildPaths()`, `RuntimePaths` type, `TaskPaths` type, `resolveTask()` |
| `src/config/schema.ts` | **MODIFY** — add `paths` to `ResolvedConfig` |
| `src/config/defaults.ts` | **MODIFY** — add `paths` to `ShkmnConfig` |
| `src/config/loader.ts` | **MODIFY** — call `buildPaths()`, attach to config |
| `src/config/resolve-path.ts` | **DELETE** — logic absorbed by `buildPaths()` and `loader.ts` |
| `src/runtime/dirs.ts` | **MODIFY** — accept `RuntimePaths` instead of `string` |
| `src/commands/init.ts` | **MODIFY** — use `buildPaths()` directly, fix config write path |
| `src/commands/start.ts` | **MODIFY** — use `config.paths.*` |
| `src/commands/stop.ts` | **MODIFY** — use `config.paths.*` |
| `src/commands/status.ts` | **MODIFY** — use `config.paths.*` |
| `src/commands/logs.ts` | **MODIFY** — use `config.paths.*` |
| `src/commands/history.ts` | **MODIFY** — use `config.paths.*` |
| `src/commands/approve.ts` | **MODIFY** — use `config.paths.*` (via approval-handler) |
| `src/commands/recover.ts` | **MODIFY** — use `config.paths.*` |
| `src/commands/doctor.ts` | **MODIFY** — use `config.paths.*` |
| `src/commands/stats.ts` | **MODIFY** — use `config.paths.*` |
| `src/core/pipeline.ts` | **MODIFY** — use `config.paths.*` for all directory operations |
| `src/core/pipeline-utils.ts` | **MODIFY** — `moveTaskDir` uses paths from caller |
| `src/core/stage-runner.ts` | **MODIFY** — receive `TaskPaths`, drop all `join()` |
| `src/core/watcher.ts` | **MODIFY** — use `config.paths.*` for all paths |
| `src/core/slack-queue.ts` | **MODIFY** — use `config.paths.*` for all Slack files |
| `src/core/worktree.ts` | **MODIFY** — receive paths from caller |
| `src/core/recovery.ts` | **MODIFY** — use `config.paths.*` |
| `src/core/recovery-reentry.ts` | **MODIFY** — use `config.paths.*` |
| `src/core/astra-triage.ts` | **MODIFY** — use `config.paths.*` |
| `src/core/approval-handler.ts` | **MODIFY** — use `config.paths.*` |
| `src/core/interactions.ts` | **MODIFY** — receive `interactionsDir` from caller |
| `src/surfaces/slack-notifier.ts` | **MODIFY** — use `config.paths.*` |
| `src/surfaces/slack-surface.ts` | **MODIFY** — use `config.paths.*` |
| `tests/config/paths.test.ts` | **NEW** — unit tests for `buildPaths()` and `resolveTask()` |
| `tests/config/resolve-path.test.ts` | **DELETE** — replaced by `paths.test.ts` |

---

### Task 1: Create `src/config/paths.ts` with types and `buildPaths()`

**Files:**
- Create: `src/config/paths.ts`
- Test: `tests/config/paths.test.ts`

- [ ] **Step 1: Write the test file for `buildPaths()` system paths**

```typescript
// tests/config/paths.test.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { buildPaths } from "../../src/config/paths.js";

describe("buildPaths", () => {
  const runtimeDir = "/test/runtime";
  const paths = buildPaths(runtimeDir);

  it("returns runtimeDir unchanged", () => {
    expect(paths.runtimeDir).toBe(runtimeDir);
  });

  it("builds stage directories from STAGE_DIR_MAP", () => {
    expect(paths.stages.questions).toBe(join(runtimeDir, "01-questions"));
    expect(paths.stages.impl).toBe(join(runtimeDir, "06-impl"));
    expect(paths.stages.pr).toBe(join(runtimeDir, "09-pr"));
  });

  it("builds terminal directories", () => {
    expect(paths.terminals.inbox).toBe(join(runtimeDir, "00-inbox"));
    expect(paths.terminals.complete).toBe(join(runtimeDir, "10-complete"));
    expect(paths.terminals.failed).toBe(join(runtimeDir, "11-failed"));
    expect(paths.terminals.hold).toBe(join(runtimeDir, "12-hold"));
  });

  it("builds non-stage directories", () => {
    expect(paths.logsDir).toBe(join(runtimeDir, "logs"));
    expect(paths.historyDir).toBe(join(runtimeDir, "history"));
    expect(paths.dailyLogDir).toBe(join(runtimeDir, "history", "daily-log"));
    expect(paths.monthlyReportsDir).toBe(join(runtimeDir, "history", "monthly-reports"));
    expect(paths.interactionsDir).toBe(join(runtimeDir, "interactions"));
    expect(paths.diagnosticsDir).toBe(join(runtimeDir, "diagnostics"));
    expect(paths.astraResponsesDir).toBe(join(runtimeDir, "astra-responses"));
    expect(paths.worktreesDir).toBe(join(runtimeDir, "worktrees"));
  });

  it("builds system file paths", () => {
    expect(paths.pidFile).toBe(join(runtimeDir, "shkmn.pid"));
    expect(paths.worktreeManifest).toBe(join(runtimeDir, "worktree-manifest.json"));
    expect(paths.usageBudget).toBe(join(runtimeDir, "usage-budget.json"));
    expect(paths.envFile).toBe(join(runtimeDir, ".env"));
    expect(paths.configFile).toBe(join(runtimeDir, "shkmn.config.json"));
  });

  it("builds Slack file paths", () => {
    expect(paths.slackOutbox).toBe(join(runtimeDir, "slack-outbox.jsonl"));
    expect(paths.slackInbox).toBe(join(runtimeDir, "slack-inbox.jsonl"));
    expect(paths.slackSent).toBe(join(runtimeDir, "slack-sent.jsonl"));
    expect(paths.slackThreads).toBe(join(runtimeDir, "slack-threads.json"));
    expect(paths.slackCursor).toBe(join(runtimeDir, "slack-cursor.json"));
    expect(paths.slackProcessed).toBe(join(runtimeDir, "slack-processed.json"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config/paths.test.ts`
Expected: FAIL — `Cannot find module '../../src/config/paths.js'`

- [ ] **Step 3: Write `src/config/paths.ts` with types and `buildPaths()`**

```typescript
// src/config/paths.ts
import { join } from "node:path";
import { STAGE_DIR_MAP, type PipelineStageName } from "../core/stage-map.js";

export interface TaskPaths {
  readonly taskDir: string;
  readonly artifactsDir: string;
  readonly outputFile: string | undefined;
  readonly runStateFile: string;
  readonly taskFile: string;
}

export interface RuntimePaths {
  readonly runtimeDir: string;
  readonly stages: Readonly<Record<PipelineStageName, string>>;
  readonly terminals: Readonly<{
    inbox: string;
    complete: string;
    failed: string;
    hold: string;
  }>;
  readonly logsDir: string;
  readonly historyDir: string;
  readonly dailyLogDir: string;
  readonly monthlyReportsDir: string;
  readonly interactionsDir: string;
  readonly diagnosticsDir: string;
  readonly astraResponsesDir: string;
  readonly worktreesDir: string;
  readonly pidFile: string;
  readonly worktreeManifest: string;
  readonly usageBudget: string;
  readonly envFile: string;
  readonly configFile: string;
  readonly slackOutbox: string;
  readonly slackInbox: string;
  readonly slackSent: string;
  readonly slackThreads: string;
  readonly slackCursor: string;
  readonly slackProcessed: string;
  resolveTask(slug: string, stage: PipelineStageName, location: "pending" | "done", retryNumber?: number): TaskPaths;
  resolveTask(slug: string, terminal: "hold" | "complete" | "failed" | "inbox"): TaskPaths;
}

const TERMINAL_DIR_MAP: Record<string, string> = {
  inbox: "00-inbox",
  complete: "10-complete",
  failed: "11-failed",
  hold: "12-hold",
};

export function buildPaths(runtimeDir: string): RuntimePaths {
  const stages = {} as Record<PipelineStageName, string>;
  for (const [name, dir] of Object.entries(STAGE_DIR_MAP)) {
    stages[name as PipelineStageName] = join(runtimeDir, dir);
  }

  const terminals = {
    inbox: join(runtimeDir, TERMINAL_DIR_MAP.inbox),
    complete: join(runtimeDir, TERMINAL_DIR_MAP.complete),
    failed: join(runtimeDir, TERMINAL_DIR_MAP.failed),
    hold: join(runtimeDir, TERMINAL_DIR_MAP.hold),
  };

  function resolveTask(slug: string, stageOrTerminal: string, location?: string, retryNumber?: number): TaskPaths {
    let taskDir: string;
    let outputFile: string | undefined;

    if (location === "pending" || location === "done") {
      // Pipeline stage
      const stageDir = STAGE_DIR_MAP[stageOrTerminal];
      if (!stageDir) throw new Error(`Unknown stage: "${stageOrTerminal}"`);
      taskDir = join(runtimeDir, stageDir, location, slug);
      const suffix = retryNumber && retryNumber >= 1 ? `-r${retryNumber}` : "";
      outputFile = join(taskDir, "artifacts", `${stageOrTerminal}-output${suffix}.md`);
    } else {
      // Terminal directory
      const termDir = TERMINAL_DIR_MAP[stageOrTerminal];
      if (!termDir) throw new Error(`Unknown terminal: "${stageOrTerminal}"`);
      taskDir = join(runtimeDir, termDir, slug);
      outputFile = undefined;
    }

    return {
      taskDir,
      artifactsDir: join(taskDir, "artifacts"),
      outputFile,
      runStateFile: join(taskDir, "run-state.json"),
      taskFile: join(taskDir, "task.task"),
    };
  }

  return Object.freeze({
    runtimeDir,
    stages: Object.freeze(stages),
    terminals: Object.freeze(terminals),
    logsDir: join(runtimeDir, "logs"),
    historyDir: join(runtimeDir, "history"),
    dailyLogDir: join(runtimeDir, "history", "daily-log"),
    monthlyReportsDir: join(runtimeDir, "history", "monthly-reports"),
    interactionsDir: join(runtimeDir, "interactions"),
    diagnosticsDir: join(runtimeDir, "diagnostics"),
    astraResponsesDir: join(runtimeDir, "astra-responses"),
    worktreesDir: join(runtimeDir, "worktrees"),
    pidFile: join(runtimeDir, "shkmn.pid"),
    worktreeManifest: join(runtimeDir, "worktree-manifest.json"),
    usageBudget: join(runtimeDir, "usage-budget.json"),
    envFile: join(runtimeDir, ".env"),
    configFile: join(runtimeDir, "shkmn.config.json"),
    slackOutbox: join(runtimeDir, "slack-outbox.jsonl"),
    slackInbox: join(runtimeDir, "slack-inbox.jsonl"),
    slackSent: join(runtimeDir, "slack-sent.jsonl"),
    slackThreads: join(runtimeDir, "slack-threads.json"),
    slackCursor: join(runtimeDir, "slack-cursor.json"),
    slackProcessed: join(runtimeDir, "slack-processed.json"),
    resolveTask,
  } as RuntimePaths);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config/paths.test.ts`
Expected: PASS — all system path tests green

- [ ] **Step 5: Add `resolveTask()` tests to the test file**

Append to `tests/config/paths.test.ts`:

```typescript
describe("resolveTask", () => {
  const runtimeDir = "/test/runtime";
  const paths = buildPaths(runtimeDir);

  it("resolves pipeline stage task paths (pending)", () => {
    const tp = paths.resolveTask("my-task", "impl", "pending");
    expect(tp.taskDir).toBe(join(runtimeDir, "06-impl", "pending", "my-task"));
    expect(tp.artifactsDir).toBe(join(runtimeDir, "06-impl", "pending", "my-task", "artifacts"));
    expect(tp.outputFile).toBe(join(runtimeDir, "06-impl", "pending", "my-task", "artifacts", "impl-output.md"));
    expect(tp.runStateFile).toBe(join(runtimeDir, "06-impl", "pending", "my-task", "run-state.json"));
    expect(tp.taskFile).toBe(join(runtimeDir, "06-impl", "pending", "my-task", "task.task"));
  });

  it("resolves pipeline stage task paths (done)", () => {
    const tp = paths.resolveTask("my-task", "design", "done");
    expect(tp.taskDir).toBe(join(runtimeDir, "03-design", "done", "my-task"));
    expect(tp.outputFile).toBe(join(runtimeDir, "03-design", "done", "my-task", "artifacts", "design-output.md"));
  });

  it("resolves retry suffix for retryNumber >= 1", () => {
    const tp = paths.resolveTask("my-task", "validate", "pending", 2);
    expect(tp.outputFile).toBe(join(runtimeDir, "08-validate", "pending", "my-task", "artifacts", "validate-output-r2.md"));
  });

  it("omits retry suffix for retryNumber 0", () => {
    const tp = paths.resolveTask("my-task", "impl", "pending", 0);
    expect(tp.outputFile).toBe(join(runtimeDir, "06-impl", "pending", "my-task", "artifacts", "impl-output.md"));
  });

  it("resolves terminal task paths with undefined outputFile", () => {
    const tp = paths.resolveTask("my-task", "hold");
    expect(tp.taskDir).toBe(join(runtimeDir, "12-hold", "my-task"));
    expect(tp.artifactsDir).toBe(join(runtimeDir, "12-hold", "my-task", "artifacts"));
    expect(tp.outputFile).toBeUndefined();
    expect(tp.runStateFile).toBe(join(runtimeDir, "12-hold", "my-task", "run-state.json"));
  });

  it("resolves all terminal types", () => {
    expect(paths.resolveTask("t", "inbox").taskDir).toBe(join(runtimeDir, "00-inbox", "t"));
    expect(paths.resolveTask("t", "complete").taskDir).toBe(join(runtimeDir, "10-complete", "t"));
    expect(paths.resolveTask("t", "failed").taskDir).toBe(join(runtimeDir, "11-failed", "t"));
    expect(paths.resolveTask("t", "hold").taskDir).toBe(join(runtimeDir, "12-hold", "t"));
  });

  it("throws for unknown stage", () => {
    expect(() => paths.resolveTask("t", "bogus" as any, "pending")).toThrow('Unknown stage: "bogus"');
  });

  it("throws for unknown terminal", () => {
    expect(() => paths.resolveTask("t", "bogus" as any)).toThrow('Unknown terminal: "bogus"');
  });
});
```

- [ ] **Step 6: Run test to verify all pass**

Run: `npx vitest run tests/config/paths.test.ts`
Expected: PASS — all `buildPaths` and `resolveTask` tests green

- [ ] **Step 7: Commit**

```bash
git add src/config/paths.ts tests/config/paths.test.ts
git commit -m "feat: add centralized path resolver (buildPaths + resolveTask)"
```

---

### Task 2: Wire `buildPaths()` into config loading and types

**Files:**
- Modify: `src/config/defaults.ts:103-109` (ShkmnConfig interface)
- Modify: `src/config/loader.ts:58-124` (resolveConfig function)
- Modify: `src/config/schema.ts` (if ResolvedConfig needs separate update)
- Test: `tests/config/loader.test.ts` (existing)

- [ ] **Step 1: Add `paths` to `ShkmnConfig` interface in `src/config/defaults.ts`**

At line 103, add `RuntimePaths` import and the `paths` property:

```typescript
// Add to imports at top of defaults.ts:
import type { RuntimePaths } from "./paths.js";

// In ShkmnConfig interface (line ~103), add after the opening brace:
export interface ShkmnConfig {
  paths: RuntimePaths;
  pipeline: {
    runtimeDir: string;
    // ... rest unchanged
```

- [ ] **Step 2: Call `buildPaths()` in `resolveConfig()` in `src/config/loader.ts`**

Add import at top:
```typescript
import { buildPaths } from "./paths.js";
```

In `resolveConfig()` (around line 58), after the `runtimeDir` absolute path check (line 46-48), add `buildPaths` call and include `paths` in the returned object. Find the return statement and add `paths`:

```typescript
// After line 48 (absolute path check), add:
const paths = buildPaths(resolved.pipeline.runtimeDir);

// In the return object, add paths as the first property:
return {
  paths,
  pipeline: { ... },
  // ... rest unchanged
};
```

- [ ] **Step 3: Run existing loader tests to verify nothing breaks**

Run: `npx vitest run tests/config/loader.test.ts`
Expected: PASS — existing tests still work (they don't assert on `paths` yet)

- [ ] **Step 4: Run full test suite to verify no regressions**

Run: `npm test`
Expected: PASS — all tests still green

- [ ] **Step 5: Commit**

```bash
git add src/config/defaults.ts src/config/loader.ts
git commit -m "feat: wire buildPaths() into ResolvedConfig via config loader"
```

---

### Task 3: Update `runtime/dirs.ts` to accept `RuntimePaths`

**Files:**
- Modify: `src/runtime/dirs.ts:6-45`
- Test: `tests/runtime/dirs.test.ts` (existing)

- [ ] **Step 1: Rewrite `src/runtime/dirs.ts` to use `RuntimePaths`**

Replace the entire file content:

```typescript
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RuntimePaths } from "../config/paths.js";

/**
 * Collects all directories that should exist under the runtime root.
 * Derives paths from the RuntimePaths object — no hardcoded directory names.
 */
function getAllDirPaths(paths: RuntimePaths): string[] {
  const dirs: string[] = [];

  // Stage directories with pending/done subdirs
  for (const stageDir of Object.values(paths.stages)) {
    dirs.push(stageDir);
    dirs.push(join(stageDir, "pending"));
    dirs.push(join(stageDir, "done"));
  }

  // Terminal directories (no pending/done)
  for (const termDir of Object.values(paths.terminals)) {
    dirs.push(termDir);
  }

  // Non-stage directories
  dirs.push(paths.logsDir);
  dirs.push(paths.historyDir);
  dirs.push(paths.dailyLogDir);
  dirs.push(paths.monthlyReportsDir);
  dirs.push(paths.interactionsDir);
  dirs.push(paths.diagnosticsDir);
  dirs.push(paths.astraResponsesDir);
  dirs.push(paths.worktreesDir);

  return dirs;
}

export function createRuntimeDirs(paths: RuntimePaths): void {
  for (const dir of getAllDirPaths(paths)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function verifyRuntimeDirs(paths: RuntimePaths): {
  valid: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  for (const dir of getAllDirPaths(paths)) {
    if (!existsSync(dir)) {
      missing.push(dir);
    }
  }
  return { valid: missing.length === 0, missing };
}
```

- [ ] **Step 2: Update all callers of `createRuntimeDirs` and `verifyRuntimeDirs`**

In `src/commands/init.ts` (line 262): change `createRuntimeDirs(answers.runtimeDir)` — this will be updated in Task 4.

In `src/commands/start.ts` (line 34): change `verifyRuntimeDirs(config.pipeline.runtimeDir)` to `verifyRuntimeDirs(config.paths)`.

```typescript
// src/commands/start.ts line 34 — change:
const { valid, missing } = verifyRuntimeDirs(config.pipeline.runtimeDir);
// to:
const { valid, missing } = verifyRuntimeDirs(config.paths);
```

- [ ] **Step 3: Run dirs test and start test**

Run: `npx vitest run tests/runtime/dirs.test.ts tests/commands/start.test.ts`
Expected: PASS (update test fixtures if they pass `string` to createRuntimeDirs — change to pass `buildPaths(tmpDir)`)

- [ ] **Step 4: Commit**

```bash
git add src/runtime/dirs.ts src/commands/start.ts
git commit -m "refactor: runtime/dirs accepts RuntimePaths instead of string"
```

---

### Task 4: Fix `init` command — config write path bug

**Files:**
- Modify: `src/commands/init.ts:262-270`
- Test: `tests/commands/init.test.ts` (existing)

- [ ] **Step 1: Add `buildPaths` import to `src/commands/init.ts`**

```typescript
import { buildPaths } from "../config/paths.js";
```

- [ ] **Step 2: Update `runInitWizard()` to use `buildPaths()`**

Replace lines 262-270:

```typescript
// OLD (lines 262-270):
//   createRuntimeDirs(answers.runtimeDir);
//   log.success(`Created runtime directories at: ${answers.runtimeDir}`);
//   writeInitConfig(answers.runtimeDir, answers);
//   log.success(`Written shkmn.config.json to: ${answers.runtimeDir}`);
//   writeInitEnv(answers.runtimeDir);
//   log.success(`Written .env template to: ${answers.runtimeDir}`);

// NEW:
  const runtimeDir = join(answers.runtimeDir, "runtime");
  const paths = buildPaths(runtimeDir);

  createRuntimeDirs(paths);
  log.success(`Created runtime directories at: ${runtimeDir}`);

  // Override runtimeDir in answers so config JSON stores the full path
  writeInitConfig(paths.configFile, { ...answers, runtimeDir });
  log.success(`Written shkmn.config.json to: ${runtimeDir}`);

  writeInitEnv(paths.envFile);
  log.success(`Written .env template to: ${runtimeDir}`);
```

- [ ] **Step 3: Update `writeInitConfig` signature to accept config file path directly**

Change `writeInitConfig` (line 26) from `dir: string` to `configFilePath: string`:

```typescript
// OLD:
export function writeInitConfig(dir: string, answers: InitAnswers): void {
  // ...
  const configPath = join(dir, "shkmn.config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// NEW:
export function writeInitConfig(configFilePath: string, answers: InitAnswers): void {
  // ...
  writeFileSync(configFilePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
```

- [ ] **Step 4: Update `writeInitEnv` similarly to accept file path directly**

Change `writeInitEnv` (line ~82) from `dir: string` to `envFilePath: string`:

```typescript
// OLD:
function writeInitEnv(dir: string): void {
  const envPath = join(dir, ".env");
  // ...

// NEW:
function writeInitEnv(envFilePath: string): void {
  const envPath = envFilePath;
  // ...
```

- [ ] **Step 5: Add `join` import if not already present**

Verify `import { join } from "node:path"` exists in init.ts.

- [ ] **Step 6: Run init tests**

Run: `npx vitest run tests/commands/init.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/commands/init.ts
git commit -m "fix: init writes config to ~/.shkmn/runtime/ matching resolve-path"
```

---

### Task 5: Delete `resolve-path.ts` and absorb its logic

**Files:**
- Delete: `src/config/resolve-path.ts`
- Delete: `tests/config/resolve-path.test.ts`
- Modify: `src/config/loader.ts:17-52` (loadConfig)
- Modify: any files importing `resolveConfigPath`

- [ ] **Step 1: Find all imports of `resolveConfigPath`**

Run: `grep -rn "resolveConfigPath\|resolve-path" src/ tests/`

Expected callers: `src/config/loader.ts`, `src/commands/doctor.ts`, and any command that calls `loadConfig()`.

- [ ] **Step 2: Inline config resolution logic into `loadConfig()` in `src/config/loader.ts`**

The `resolveConfigPath()` logic (env var → cwd → home fallback) should stay in `loader.ts` but reference `buildPaths` for the home path. Replace the import:

```typescript
// OLD import:
import { resolveConfigPath } from "./resolve-path.js";

// NEW — inline the logic. In loadConfig():
export function loadConfig(explicitPath?: string): ResolvedConfig {
  const configPath = explicitPath ?? findConfigPath();
  // ... rest unchanged
}

function findConfigPath(): string {
  const envPath = process.env.SHKMN_CONFIG;
  if (envPath && existsSync(envPath)) return envPath;

  const localPath = join(process.cwd(), "shkmn.config.json");
  if (existsSync(localPath)) return localPath;

  const homePath = join(homedir(), ".shkmn", "runtime", "shkmn.config.json");
  if (existsSync(homePath)) return homePath;

  console.error(
    "Config not found. Searched:\n" +
    `  $SHKMN_CONFIG=${envPath ?? "(not set)"}\n` +
    `  ${localPath}\n` +
    `  ${homePath}\n` +
    "Run 'shkmn init' to create a config."
  );
  process.exit(1);
}
```

Add `import { existsSync } from "node:fs"` and `import { homedir } from "node:os"` if not present.

- [ ] **Step 3: Update `src/commands/doctor.ts` if it imports `resolveConfigPath` directly**

Replace any `resolveConfigPath()` call with the config path from `loadConfig()` or inline the same fallback logic. Check doctor.ts lines 284-287.

- [ ] **Step 4: Delete `src/config/resolve-path.ts` and `tests/config/resolve-path.test.ts`**

```bash
rm src/config/resolve-path.ts tests/config/resolve-path.test.ts
```

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: PASS — no remaining imports of deleted file

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: delete resolve-path.ts, inline config resolution into loader"
```

---

### Task 6: Migrate CLI commands to `config.paths`

**Files:**
- Modify: `src/commands/start.ts:30,44,50,114`
- Modify: `src/commands/stop.ts:19,53`
- Modify: `src/commands/status.ts:51,62`
- Modify: `src/commands/logs.ts:43`
- Modify: `src/commands/history.ts:20,24`
- Modify: `src/commands/recover.ts:24,65`
- Modify: `src/commands/doctor.ts:136,284-287`
- Modify: `src/commands/stats.ts:350`
- Test: existing command tests

- [ ] **Step 1: Migrate `src/commands/start.ts`**

```typescript
// Line 30 — OLD: const envPath = join(dirname(configPath), ".env");
// NEW: const envPath = config.paths.envFile;

// Line 44 — OLD: const logDir = join(config.pipeline.runtimeDir, "logs");
// NEW: const logDir = config.paths.logsDir;

// Line 50 — OLD: const manifestPath = join(config.pipeline.runtimeDir, "worktree-manifest.json");
// NEW: const manifestPath = config.paths.worktreeManifest;

// Line 114 — OLD: const pidFile = join(config.pipeline.runtimeDir, "shkmn.pid");
// NEW: const pidFile = config.paths.pidFile;
```

Remove unused `join` and `dirname` imports if no other usages remain.

- [ ] **Step 2: Migrate `src/commands/stop.ts`**

```typescript
// Line 19 — OLD: const pidFile = join(runtimeDir, "shkmn.pid");
// NEW: const pidFile = config.paths.pidFile;

// Line 53 — OLD: const inboxDir = join(runtimeDir, "00-inbox");
// NEW: const inboxDir = config.paths.terminals.inbox;
```

- [ ] **Step 3: Migrate `src/commands/status.ts`**

```typescript
// Line 51 — OLD: const runStatePath = join(config.pipeline.runtimeDir, task.dir, task.slug, "run-state.json");
// NEW: Use config.paths.resolveTask() to get the run state path based on task stage and location.

// Line 62 — OLD: const runStatePath = join(config.pipeline.runtimeDir, "12-hold", task.slug, "run-state.json");
// NEW: const tp = config.paths.resolveTask(task.slug, "hold");
//      const runStatePath = tp.runStateFile;
```

- [ ] **Step 4: Migrate `src/commands/logs.ts`**

```typescript
// Line 43 — OLD: const logFile = join(config.pipeline.runtimeDir, "logs", `${resolved}.log`);
// NEW: const logFile = join(config.paths.logsDir, `${resolved}.log`);
```

Note: the filename part (`${resolved}.log`) is dynamic per-slug, so `join` with `config.paths.logsDir` is appropriate here — the base directory comes from paths, only the filename is constructed.

- [ ] **Step 5: Migrate `src/commands/history.ts`**

```typescript
// Line 20 — OLD: const dirPath = join(runtimeDir, dir);
// where dir iterates ["10-complete", "11-failed"]
// NEW: iterate [config.paths.terminals.complete, config.paths.terminals.failed] directly

// Line 24 — OLD: const statePath = join(dirPath, slug, "run-state.json");
// NEW: keep join(dirPath, slug, "run-state.json") since dirPath is now from config.paths.terminals.*
// OR use resolveTask: const tp = config.paths.resolveTask(slug, "complete"); tp.runStateFile
```

- [ ] **Step 6: Migrate `src/commands/recover.ts`**

```typescript
// Line 24 — OLD: const holdDir = join(runtimeDir, "12-hold");
// NEW: const holdDir = config.paths.terminals.hold;

// Line 65 — OLD: const stateFile = join(runtimeDir, "12-hold", slug, "run-state.json");
// NEW: const tp = config.paths.resolveTask(slug, "hold");
//      const stateFile = tp.runStateFile;
```

- [ ] **Step 7: Migrate `src/commands/doctor.ts`**

```typescript
// Line 136 — OLD: const envPath = join(dirname(configPath), ".env");
// NEW: const envPath = config.paths.envFile;
// (Only if config is available at this point in doctor; if not, use the same inline fallback)

// Lines 284-287 — OLD: hardcoded config search paths
// NEW: use findConfigPath() from loader or inline
```

- [ ] **Step 8: Migrate `src/commands/stats.ts`**

```typescript
// Line 350 — OLD: const interactionsDir = join(options.runtimeDir, "interactions");
// NEW: const interactionsDir = config.paths.interactionsDir;
```

- [ ] **Step 9: Run all command tests**

Run: `npx vitest run tests/commands/`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/commands/
git commit -m "refactor: migrate all CLI commands to config.paths"
```

---

### Task 7: Migrate pipeline core — `pipeline.ts` and `pipeline-utils.ts`

**Files:**
- Modify: `src/core/pipeline.ts:68-78,114,158,191,235-243,251,311,338,390,421,428,447,460-461,477-481,491-495,515,544,567-568,582-583,613,687-688,705`
- Modify: `src/core/pipeline-utils.ts:138-190` (moveTaskDir)
- Test: `tests/core/pipeline.test.ts` (existing)

- [ ] **Step 1: Rewrite `initTaskDir` in `pipeline.ts` (lines 68-78)**

```typescript
// OLD:
export function initTaskDir(runtimeDir: string, slug: string, stageDir: string, taskFilePath: string): string {
  const taskDir = join(runtimeDir, stageDir, "pending", slug);
  mkdirSync(join(taskDir, "artifacts"), { recursive: true });
  copyFileSync(taskFilePath, join(taskDir, "task.task"));
  return taskDir;
}

// NEW — accept TaskPaths:
export function initTaskDir(tp: TaskPaths, taskFilePath: string): string {
  mkdirSync(tp.artifactsDir, { recursive: true });
  copyFileSync(taskFilePath, tp.taskFile);
  return tp.taskDir;
}
```

Update import: `import type { TaskPaths } from "../config/paths.js";`

- [ ] **Step 2: Migrate `loadBudgetConfig` in `src/config/loader.ts` (line 131)**

```typescript
// OLD: export function loadBudgetConfig(runtimeDir: string): BudgetConfig {
//        const filePath = join(runtimeDir, "usage-budget.json");
// NEW: export function loadBudgetConfig(budgetFilePath: string): BudgetConfig {
//        const filePath = budgetFilePath;
```

Update caller in `pipeline.ts` (line 120):
```typescript
// OLD: return loadBudgetConfig(runtimeDir);
// NEW: return loadBudgetConfig(config.paths.usageBudget);
```

- [ ] **Step 3: Replace all `join(runtimeDir, "12-hold", slug)` with `config.paths.resolveTask(slug, "hold").taskDir`**

This affects lines: 235, 428, 461, 568, 582, 687. Each instance follows the same pattern:

```typescript
// OLD: const holdDir = join(runtimeDir, "12-hold", slug);
// NEW: const holdDir = config.paths.resolveTask(slug, "hold").taskDir;
```

- [ ] **Step 4: Replace all `join(runtimeDir, "11-failed", slug)` with `config.paths.resolveTask(slug, "failed").taskDir`**

This affects line 191:

```typescript
// OLD: const failedTaskDir = join(runtimeDir, "11-failed", slug);
// NEW: const failedTaskDir = config.paths.resolveTask(slug, "failed").taskDir;
```

- [ ] **Step 5: Replace `join(runtimeDir, "interactions")` (line 114)**

```typescript
// OLD: const interactionsDir = join(runtimeDir, "interactions");
// NEW: const interactionsDir = config.paths.interactionsDir;
```

- [ ] **Step 6: Replace `join(runtimeDir, "worktree-manifest.json")` (lines 251, 338)**

```typescript
// OLD: const manifestPath = join(runtimeDir, "worktree-manifest.json");
// NEW: const manifestPath = config.paths.worktreeManifest;
```

- [ ] **Step 7: Replace `join(runtimeDir, "worktrees")` (line 311)**

```typescript
// OLD: const worktreesDir = join(runtimeDir, "worktrees");
// NEW: const worktreesDir = config.paths.worktreesDir;
```

- [ ] **Step 8: Replace `join(runtimeDir, stageSubdir, slug)` (line 421) in `resumeRun`**

```typescript
// OLD: const taskDir = join(runtimeDir, stageSubdir, slug);
// NEW: Use resolveTask based on parsed stage and location from stageSubdir
```

- [ ] **Step 9: Replace all `moveTaskDir` calls to use `config.paths.stages` and `config.paths.terminals`**

Each `moveTaskDir` call currently uses string subdirs like `"12-hold"`, `join(STAGE_DIR_MAP[stage], "pending")`. These should now use paths from `config.paths`:

```typescript
// OLD: moveTaskDir(runtimeDir, slug, "12-hold", join(STAGE_DIR_MAP[nextStage], "pending"));
// NEW: moveTaskDir(runtimeDir, slug, "12-hold", join(STAGE_DIR_MAP[nextStage], "pending"));
// Note: moveTaskDir itself still takes runtimeDir + subdirectory strings internally.
// The key change is that callers use STAGE_DIR_MAP (which is the source of truth) —
// these are already correct. The "12-hold", "11-failed", "10-complete" literals should
// be replaced with constants derived from TERMINAL_DIR_MAP or paths.terminals.
```

For `moveTaskDir` in `pipeline-utils.ts`, the function signature stays the same (it takes `runtimeDir`, `slug`, `fromSubdir`, `toSubdir`) because it performs the actual filesystem rename. But callers should derive subdir strings from the stage-map/terminal-map rather than hardcoding.

Create a helper in `paths.ts` to extract the subdir portion:

```typescript
// Add to src/config/paths.ts:
export { TERMINAL_DIR_MAP };
```

Then in pipeline.ts, replace hardcoded terminal strings:

```typescript
// OLD: moveTaskDir(runtimeDir, slug, fromSubdir, "11-failed");
// NEW: moveTaskDir(runtimeDir, slug, fromSubdir, TERMINAL_DIR_MAP.failed);

// OLD: moveTaskDir(runtimeDir, slug, "12-hold", ...);
// NEW: moveTaskDir(runtimeDir, slug, TERMINAL_DIR_MAP.hold, ...);

// OLD: moveTaskDir(runtimeDir, slug, ..., "10-complete");
// NEW: moveTaskDir(runtimeDir, slug, ..., TERMINAL_DIR_MAP.complete);
```

- [ ] **Step 10: Run pipeline tests**

Run: `npx vitest run tests/core/pipeline.test.ts tests/core/pipeline-control.test.ts tests/core/pipeline-budget.test.ts`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add src/core/pipeline.ts src/core/pipeline-utils.ts src/config/paths.ts
git commit -m "refactor: migrate pipeline.ts to config.paths and TERMINAL_DIR_MAP"
```

---

### Task 8: Migrate `stage-runner.ts`

**Files:**
- Modify: `src/core/stage-runner.ts:86,123,133,176,183,319-323,358,386-390,466-470,477-481,482,498-502,503,527-531`
- Test: `tests/core/pipeline.test.ts` (covers stage-runner indirectly)

- [ ] **Step 1: Replace `join(runtimeDir, "logs")` (line 86)**

```typescript
// OLD: const taskLogger = createTaskLogger(join(runtimeDir, "logs"), slug);
// NEW: const taskLogger = createTaskLogger(config.paths.logsDir, slug);
```

- [ ] **Step 2: Replace artifact path construction (lines 123, 133)**

```typescript
// OLD:
// const artifactsDir = join(currentTaskDir, "artifacts");
// const outputPath = join(artifactsDir, `${stage}-output${outputSuffix}.md`);

// NEW — use resolveTask to derive these:
// const tp = config.paths.resolveTask(slug, stage, "pending", retryCount);
// const artifactsDir = tp.artifactsDir;
// const outputPath = tp.outputFile!;
```

Note: The exact integration depends on how `currentTaskDir` is tracked in the stage loop. The key point is that `artifactsDir` and `outputPath` come from `resolveTask()` rather than ad-hoc `join()`.

- [ ] **Step 3: Replace all `"12-hold"`, `"11-failed"`, `"10-complete"` literals**

Use `TERMINAL_DIR_MAP.hold`, `TERMINAL_DIR_MAP.failed`, `TERMINAL_DIR_MAP.complete` from `paths.ts`:

```typescript
import { TERMINAL_DIR_MAP } from "../config/paths.js";

// Line 176 — OLD: moveTaskDir(runtimeDir, slug, join(STAGE_DIR_MAP[stage], "pending"), "12-hold");
// NEW: moveTaskDir(runtimeDir, slug, join(STAGE_DIR_MAP[stage], "pending"), TERMINAL_DIR_MAP.hold);

// Line 319 — OLD: moveTaskDir(runtimeDir, slug, ..., "11-failed");
// NEW: moveTaskDir(runtimeDir, slug, ..., TERMINAL_DIR_MAP.failed);

// Line 477-481 — OLD: moveTaskDir(..., "12-hold");
// NEW: moveTaskDir(..., TERMINAL_DIR_MAP.hold);

// Line 498-502 — OLD: moveTaskDir(..., "10-complete");
// NEW: moveTaskDir(..., TERMINAL_DIR_MAP.complete);
```

- [ ] **Step 4: Replace `readRunState(join(runtimeDir, "12-hold", slug))` calls**

```typescript
// Lines 183, 482 — OLD: readRunState(join(runtimeDir, "12-hold", slug))
// NEW: readRunState(config.paths.resolveTask(slug, "hold").taskDir)

// Line 503 — OLD: readRunState(join(runtimeDir, "10-complete", slug))
// NEW: readRunState(config.paths.resolveTask(slug, "complete").taskDir)
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/core/pipeline.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/stage-runner.ts
git commit -m "refactor: migrate stage-runner to config.paths and TERMINAL_DIR_MAP"
```

---

### Task 9: Migrate watcher and Slack modules

**Files:**
- Modify: `src/core/watcher.ts:88,116,121,137,172,194,204,214,246-247,285,296,325,332,467`
- Modify: `src/core/slack-queue.ts:68,72,76,80,85,92,114,146-150`
- Modify: `src/surfaces/slack-notifier.ts:210`
- Modify: `src/surfaces/slack-surface.ts:67,78`
- Test: `tests/core/watcher.test.ts`, `tests/core/slack-queue.test.ts`, `tests/surfaces/slack-notifier.test.ts`, `tests/surfaces/slack-surface.test.ts`

- [ ] **Step 1: Migrate `src/core/watcher.ts` — Slack file paths**

```typescript
// Line 88 — OLD: const processedTsPath = join(runtimeDir, "slack-processed.json");
// NEW: const processedTsPath = config.paths.slackProcessed;

// Line 116 — OLD: const p = join(runtimeDir, f.name);
// Replace the ensureSlackFiles loop with config.paths references:
// Use config.paths.slackOutbox, .slackInbox, .slackSent, .slackThreads, .slackCursor

// Line 121 — OLD: const responsesDir = join(runtimeDir, "astra-responses");
// NEW: const responsesDir = config.paths.astraResponsesDir;

// Line 137 — OLD: const outboxPath = join(runtimeDir, "slack-outbox.jsonl");
// NEW: const outboxPath = config.paths.slackOutbox;
```

- [ ] **Step 2: Migrate `src/core/watcher.ts` — terminal directory paths**

```typescript
// Line 172 — OLD: const holdDir = join(runtimeDir, "12-hold");
// NEW: const holdDir = config.paths.terminals.hold;

// Line 246 — OLD: if (existsSync(join(runtimeDir, "12-hold", entry.slug))) {
// NEW: if (existsSync(config.paths.resolveTask(entry.slug, "hold").taskDir)) {

// Line 247 — OLD: const controlPath = join(runtimeDir, "00-inbox", `slack-approve-...`);
// NEW: const controlPath = join(config.paths.terminals.inbox, `slack-approve-...`);

// Line 285 — OLD: const triageFile = join(runtimeDir, "astra-responses", `triage-...`);
// NEW: const triageFile = join(config.paths.astraResponsesDir, `triage-...`);

// Line 296 — OLD: const controlPath = join(runtimeDir, "00-inbox", `slack-...`);
// NEW: const controlPath = join(config.paths.terminals.inbox, `slack-...`);

// Line 325 — OLD: const outputDir = join(runtimeDir, "astra-responses");
// NEW: const outputDir = config.paths.astraResponsesDir;

// Line 467 — OLD: const inboxDir = join(runtimeDir, "00-inbox");
// NEW: const inboxDir = config.paths.terminals.inbox;
```

- [ ] **Step 3: Migrate `src/core/slack-queue.ts`**

All functions receive `runtimeDir: string`. Change them to accept `config` or the specific path strings. The simplest approach: pass the relevant `config.paths.slack*` path from the caller.

```typescript
// Line 68 — OLD: return readJsonl<OutboxEntry>(join(runtimeDir, "slack-outbox.jsonl"));
// NEW: return readJsonl<OutboxEntry>(config.paths.slackOutbox);

// Line 72 — OLD: return readJsonl<InboxEntry>(join(runtimeDir, "slack-inbox.jsonl"));
// NEW: return readJsonl<InboxEntry>(config.paths.slackInbox);

// Line 76 — OLD: writeFileSync(join(runtimeDir, "slack-inbox.jsonl"), "", "utf-8");
// NEW: writeFileSync(config.paths.slackInbox, "", "utf-8");

// Line 80 — OLD: return readJsonl<SentEntry>(join(runtimeDir, "slack-sent.jsonl"));
// NEW: return readJsonl<SentEntry>(config.paths.slackSent);

// Line 85 — OLD: JSON.parse(readFileSync(join(runtimeDir, "slack-threads.json"), "utf-8"));
// NEW: JSON.parse(readFileSync(config.paths.slackThreads, "utf-8"));

// Line 92 — OLD: writeFileSync(join(runtimeDir, "slack-threads.json"), ...);
// NEW: writeFileSync(config.paths.slackThreads, ...);

// Line 114 — OLD: readFileSync(join(runtimeDir, "slack-cursor.json"), "utf-8");
// NEW: readFileSync(config.paths.slackCursor, "utf-8");

// Lines 146-150 — OLD: files object with join() calls
// NEW: files: {
//   outbox: config.paths.slackOutbox,
//   inbox: config.paths.slackInbox,
//   sent: config.paths.slackSent,
//   threads: config.paths.slackThreads,
//   cursor: config.paths.slackCursor,
// }
```

- [ ] **Step 4: Migrate `src/surfaces/slack-notifier.ts`**

```typescript
// Line 210 — OLD: const outboxPath = join(runtimeDir, "slack-outbox.jsonl");
// NEW: const outboxPath = config.paths.slackOutbox;
```

- [ ] **Step 5: Migrate `src/surfaces/slack-surface.ts`**

```typescript
// Line 67 — OLD: const filePath = path.join(runtimeDir, CURSOR_FILENAME);
// NEW: const filePath = config.paths.slackCursor;

// Line 78 — OLD: const filePath = path.join(runtimeDir, CURSOR_FILENAME);
// NEW: const filePath = config.paths.slackCursor;
```

Remove the `CURSOR_FILENAME` constant.

- [ ] **Step 6: Run Slack and watcher tests**

Run: `npx vitest run tests/core/watcher.test.ts tests/core/slack-queue.test.ts tests/surfaces/slack-notifier.test.ts tests/surfaces/slack-surface.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/watcher.ts src/core/slack-queue.ts src/surfaces/slack-notifier.ts src/surfaces/slack-surface.ts
git commit -m "refactor: migrate watcher and Slack modules to config.paths"
```

---

### Task 10: Migrate remaining core modules

**Files:**
- Modify: `src/core/recovery.ts:80,90,102,113,152,186,354,430`
- Modify: `src/core/recovery-reentry.ts:84`
- Modify: `src/core/astra-triage.ts:114`
- Modify: `src/core/approval-handler.ts:22,41`
- Modify: `src/core/worktree.ts:50,72`
- Modify: `src/core/interactions.ts:35,79,93`
- Test: existing tests for each module

- [ ] **Step 1: Migrate `src/core/recovery.ts`**

```typescript
// Line 80 — OLD: const pendingDir = join(runtimeDir, stageDir, "pending");
// NEW: const pendingDir = join(config.paths.stages[stage], "pending");
// (where stage is the key from iterating STAGE_DIR_MAP)

// Line 90 — OLD: const doneDir = join(runtimeDir, stageDir, "done");
// NEW: const doneDir = join(config.paths.stages[stage], "done");

// Line 102 — OLD: const holdDir = join(runtimeDir, "12-hold");
// NEW: const holdDir = config.paths.terminals.hold;

// Line 113 — OLD: const inboxDir = join(runtimeDir, "00-inbox");
// NEW: const inboxDir = config.paths.terminals.inbox;

// Line 152 — OLD: const failedDir = join(runtimeDir, "11-failed");
// NEW: const failedDir = config.paths.terminals.failed;

// Line 186 — OLD: const holdDir = join(runtimeDir, "12-hold");
// NEW: const holdDir = config.paths.terminals.hold;

// Line 354 — OLD: join(runtimeDir, "12-hold", failure.slug)
// NEW: config.paths.resolveTask(failure.slug, "hold").taskDir

// Line 430 — OLD: const holdDir = join(runtimeDir, "12-hold");
// NEW: const holdDir = config.paths.terminals.hold;
```

- [ ] **Step 2: Migrate `src/core/recovery-reentry.ts`**

```typescript
// Line 84 — OLD: const holdDir = join(runtimeDir, "12-hold", slug);
// NEW: const holdDir = config.paths.resolveTask(slug, "hold").taskDir;
```

- [ ] **Step 3: Migrate `src/core/astra-triage.ts`**

```typescript
// Line 114 — OLD: outputPath: join(config.pipeline.runtimeDir, "astra-responses", `triage-${...}.md`)
// NEW: outputPath: join(config.paths.astraResponsesDir, `triage-${...}.md`)
```

- [ ] **Step 4: Migrate `src/core/approval-handler.ts`**

```typescript
// Line 22 — OLD: const taskPath = join(runtimeDir, "12-hold", slug);
// NEW: const taskPath = config.paths.resolveTask(slug, "hold").taskDir;
// (or: join(config.paths.terminals.hold, slug) if config isn't available in this function signature)

// Line 41 — OLD: const holdDir = join(runtimeDir, "12-hold");
// NEW: const holdDir = config.paths.terminals.hold;
```

- [ ] **Step 5: Migrate `src/core/worktree.ts`**

```typescript
// Line 72 — OLD: const manifestPath = join(dirname(worktreesDir), "worktree-manifest.json");
// NEW: Accept manifestPath as parameter from caller (pipeline.ts passes config.paths.worktreeManifest)
```

- [ ] **Step 6: Migrate `src/core/interactions.ts`**

This module already receives `dir` as a parameter — no change needed to the function signatures. The callers (pipeline.ts, watcher.ts) already pass `config.paths.interactionsDir` after Tasks 7 and 9.

Verify no `join()` calls with `runtimeDir` exist in this file.

- [ ] **Step 7: Run recovery and remaining core tests**

Run: `npx vitest run tests/core/recovery.test.ts tests/core/recovery-startup.test.ts tests/core/recovery-reentry.test.ts tests/core/approval-handler.test.ts tests/core/astra-triage.test.ts tests/core/worktree.test.ts tests/core/interactions.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/core/recovery.ts src/core/recovery-reentry.ts src/core/astra-triage.ts src/core/approval-handler.ts src/core/worktree.ts src/core/interactions.ts
git commit -m "refactor: migrate remaining core modules to config.paths"
```

---

### Task 11: Update test fixtures that construct paths with `join(runtimeDir, ...)`

**Files:**
- Modify: `tests/commands/recover.test.ts`
- Modify: `tests/core/recovery-startup.test.ts`
- Modify: `tests/core/recovery-reentry.test.ts`
- Modify: `tests/core/slug-resolver.test.ts`
- Modify: `tests/surfaces/slack-surface.test.ts`
- Modify: `tests/runtime/dirs.test.ts`

- [ ] **Step 1: Update test helpers to use `buildPaths()`**

In each test file that constructs paths with `join(tmpDir, "12-hold", ...)` or similar, replace with `buildPaths(tmpDir)`:

```typescript
import { buildPaths } from "../../src/config/paths.js";

// In beforeEach or setup:
const paths = buildPaths(tmpDir);

// Replace: join(tmpDir, "12-hold", slug) → paths.resolveTask(slug, "hold").taskDir
// Replace: join(tmpDir, "06-impl", "pending") → join(paths.stages.impl, "pending")
```

- [ ] **Step 2: Update `tests/runtime/dirs.test.ts`**

This test calls `createRuntimeDirs(tmpDir)` — change to `createRuntimeDirs(buildPaths(tmpDir))`.

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: PASS — all tests green

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test: update test fixtures to use buildPaths() instead of ad-hoc join()"
```

---

### Task 12: Validation — verify no remaining ad-hoc path construction

**Files:** None (validation only)

- [ ] **Step 1: Grep for remaining `join(.*runtimeDir` outside `paths.ts`**

Run: `grep -rn "join(.*runtimeDir" src/ | grep -v "src/config/paths.ts"`
Expected: Zero matches

- [ ] **Step 2: Grep for hardcoded terminal directory strings outside `paths.ts` and `stage-map.ts`**

Run: `grep -rn '"00-inbox"\|"10-complete"\|"11-failed"\|"12-hold"\|"astra-responses"' src/ | grep -v "src/config/paths.ts" | grep -v "src/core/stage-map.ts"`
Expected: Zero matches

- [ ] **Step 3: Grep for hardcoded Slack file names outside `paths.ts`**

Run: `grep -rn '"slack-outbox\|"slack-inbox\|"slack-sent\|"slack-threads\|"slack-cursor\|"slack-processed' src/ | grep -v "src/config/paths.ts"`
Expected: Zero matches

- [ ] **Step 4: Grep for hardcoded system file names outside `paths.ts`**

Run: `grep -rn '"shkmn.pid"\|"worktree-manifest.json"\|"usage-budget.json"' src/ | grep -v "src/config/paths.ts"`
Expected: Zero matches

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: PASS — all tests green

- [ ] **Step 6: Run build**

Run: `npm run build`
Expected: PASS — clean build, no TypeScript errors

- [ ] **Step 7: Commit final validation**

If any stragglers were found and fixed in steps 1-4:

```bash
git add -A
git commit -m "fix: remove remaining ad-hoc path construction"
```

- [ ] **Step 8: Final validation summary**

Verify all spec validation criteria:
1. `shkmn init` followed by `shkmn start` works without config-not-found error
2. `grep -r 'join(.*runtimeDir' src/` returns zero matches outside `src/config/paths.ts`
3. Hardcoded directory strings eliminated from all files except `paths.ts` and `stage-map.ts`
4. All existing tests pass
5. Build succeeds
