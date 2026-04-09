# Spec 2c: Execution Agents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add git worktree management, validate→impl and review→impl retry loops with issue tracking, and production prompts for all 4 execution agents.

**Architecture:** Worktree manager handles git worktree lifecycle (pipeline owns it, agents just work in the directory). Retry module provides decision functions for validate→impl (simple counter) and review→impl (issue-tracking with recurrence detection). Pipeline engine gets targeted modifications for workDir resolution, verdict parsing, and retry integration.

**Tech Stack:** TypeScript, Node.js 20+, vitest. No new npm dependencies.

**Reference:** [Spec 2c Design](../specs/2026-04-04-spec2c-execution-agents-design.md) | [Spec 2b Plan](./2026-04-04-spec2b-alignment-agents.md)

---

## File Structure

```
src/
├── core/
│   ├── worktree.ts              ← NEW: git worktree lifecycle
│   ├── retry.ts                 ← NEW: verdict parsing, retry decisions, issue tracking
│   ├── types.ts                 ← MODIFY: add workDir, worktreePath, invocationCwd, validateRetryCount, reviewRetryCount, reviewIssues, ReviewIssue
│   └── pipeline.ts              ← MODIFY: workDir resolution, verdict parsing, retry loop
├── config/
│   ├── defaults.ts              ← MODIFY: add worktree and review sections, maxValidateRetries, maxReviewRecurrence
│   ├── schema.ts                ← MODIFY: add worktree and review Zod schemas
│   └── loader.ts                ← MODIFY: resolve worktree and review fields
agents/
├── impl.md                      ← REWRITE: TDD workflow, retry awareness, per-slice commits
├── validate.md                  ← REWRITE: structured verdict, machine-parseable output
├── review.md                    ← REWRITE: numbered findings [R{n}], issue tracking, holistic re-review
└── pr.md                        ← REWRITE: PR template discovery, ADO linking
tests/
├── core/
│   ├── worktree.test.ts          ← NEW
│   ├── retry.test.ts             ← NEW
│   └── pipeline.test.ts          ← MODIFY: add workDir resolution + retry tests
```

---

## Task 1: Config Additions

**Files:**
- Modify: `src/config/defaults.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/loader.ts`

Add `worktree` and `review` top-level config sections, and `maxValidateRetries` / `maxReviewRecurrence` to the `agents` section.

### Step 1.1 — Write failing test for new config fields

- [ ] Add to `tests/core/pipeline.test.ts` (after existing `createRunState` tests):

```typescript
// In tests/core/pipeline.test.ts — add inside describe("createRunState") block

it("initializes validateRetryCount, reviewRetryCount, and reviewIssues", () => {
  const config = makeConfig();
  const taskMeta = parseTaskFile(SAMPLE_TASK);
  const state = createRunState("add-logging", taskMeta, config);

  expect(state.validateRetryCount).toBe(0);
  expect(state.reviewRetryCount).toBe(0);
  expect(state.reviewIssues).toEqual([]);
});
```

- [ ] Create `tests/core/config-additions.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/loader.js";

describe("config worktree section", () => {
  it("defaults to retentionDays=7 and cleanupOnStartup=true", () => {
    const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/test" } });
    const resolved = resolveConfig(parsed);
    expect(resolved.worktree.retentionDays).toBe(7);
    expect(resolved.worktree.cleanupOnStartup).toBe(true);
  });

  it("accepts partial overrides", () => {
    const parsed = configSchema.parse({
      pipeline: { runtimeDir: "/tmp/test" },
      worktree: { retentionDays: 14 },
    });
    const resolved = resolveConfig(parsed);
    expect(resolved.worktree.retentionDays).toBe(14);
    expect(resolved.worktree.cleanupOnStartup).toBe(true);
  });

  it("can disable cleanupOnStartup", () => {
    const parsed = configSchema.parse({
      pipeline: { runtimeDir: "/tmp/test" },
      worktree: { cleanupOnStartup: false },
    });
    const resolved = resolveConfig(parsed);
    expect(resolved.worktree.cleanupOnStartup).toBe(false);
  });
});

describe("config review section", () => {
  it("defaults to enforceSuggestions=true", () => {
    const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/test" } });
    const resolved = resolveConfig(parsed);
    expect(resolved.review.enforceSuggestions).toBe(true);
  });

  it("can set enforceSuggestions to false", () => {
    const parsed = configSchema.parse({
      pipeline: { runtimeDir: "/tmp/test" },
      review: { enforceSuggestions: false },
    });
    const resolved = resolveConfig(parsed);
    expect(resolved.review.enforceSuggestions).toBe(false);
  });
});

describe("config agents section additions", () => {
  it("defaults maxValidateRetries=2 and maxReviewRecurrence=3", () => {
    const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/test" } });
    const resolved = resolveConfig(parsed);
    expect(resolved.agents.maxValidateRetries).toBe(2);
    expect(resolved.agents.maxReviewRecurrence).toBe(3);
  });

  it("accepts custom values", () => {
    const parsed = configSchema.parse({
      pipeline: { runtimeDir: "/tmp/test" },
      agents: { maxValidateRetries: 5, maxReviewRecurrence: 1 },
    });
    const resolved = resolveConfig(parsed);
    expect(resolved.agents.maxValidateRetries).toBe(5);
    expect(resolved.agents.maxReviewRecurrence).toBe(1);
  });
});
```

- [ ] Run tests — expect failures (fields don't exist yet): `npx vitest run tests/core/config-additions.test.ts`

### Step 1.2 — Update `src/config/schema.ts`

- [ ] Replace the file contents with:

```typescript
import { z } from "zod";

const repoAliasSchema = z.object({
  path: z.string(),
  sequentialBuild: z.boolean().optional(),
});

export const configSchema = z.object({
  pipeline: z.object({
    runtimeDir: z.string().min(1, "pipeline.runtimeDir is required"),
    agentsDir: z.string().optional().default(""),
    dashboardRepoLocal: z.string().optional().default(""),
    dashboardRepoUrl: z.string().optional().default(""),
  }),
  repos: z.object({
    root: z.string().optional().default(""),
    aliases: z.record(z.string(), repoAliasSchema).optional().default({}),
  }).optional().default({}),
  ado: z.object({
    org: z.string().optional().default(""),
    project: z.string().optional().default(""),
    defaultArea: z.string().optional().default(""),
  }).optional().default({}),
  slack: z.object({
    enabled: z.boolean().optional().default(false),
    channel: z.string().optional().default("#agent-pipeline"),
    channelId: z.string().optional().default(""),
    pollIntervalSeconds: z.number().optional().default(30),
  }).optional().default({}),
  agents: z.object({
    names: z.record(z.string(), z.string()).optional().default({}),
    defaultStages: z.array(z.string()).optional(),
    defaultReviewAfter: z.string().optional(),
    maxConcurrentTotal: z.number().optional(),
    maxConcurrentValidate: z.number().optional(),
    maxTurns: z.record(z.string(), z.number()).optional(),
    timeoutsMinutes: z.record(z.string(), z.number()).optional(),
    heartbeatTimeoutMinutes: z.number().optional(),
    retryCount: z.number().optional(),
    maxValidateRetries: z.number().optional(),
    maxReviewRecurrence: z.number().optional(),
  }).optional().default({}),
  schedule: z.object({
    rollupTime: z.string().optional(),
    notionPushDay: z.string().optional(),
    notionPushTime: z.string().optional(),
    monthlyReportDay: z.number().optional(),
    monthlyReportTime: z.string().optional(),
  }).optional().default({}),
  worktree: z.object({
    retentionDays: z.number().optional().default(7),
    cleanupOnStartup: z.boolean().optional().default(true),
  }).optional().default({}),
  review: z.object({
    enforceSuggestions: z.boolean().optional().default(true),
  }).optional().default({}),
});

export type ConfigInput = z.input<typeof configSchema>;
export type ConfigParsed = z.output<typeof configSchema>;
```

### Step 1.3 — Update `src/config/defaults.ts`

- [ ] Add new sections to `ShkmnConfig` interface and `DEFAULT_CONFIG`. Replace file contents:

```typescript
export const DEFAULT_AGENT_NAMES: Record<string, string> = {
  questions: "Narada",
  research: "Chitragupta",
  design: "Vishwakarma",
  structure: "Vastu",
  plan: "Chanakya",
  workTree: "Hanuman",
  impl: "Karigar",
  validate: "Dharma",
  review: "Drona",
  pr: "Garuda",
  watcher: "Heimdall",
  taskCreator: "Brahma",
  approvalHandler: "Indra",
  intentClassifier: "Sutradhaar",
};

export type AgentRole = keyof typeof DEFAULT_AGENT_NAMES;

export interface ShkmnConfig {
  pipeline: {
    runtimeDir: string;
    agentsDir: string;
    dashboardRepoLocal: string;
    dashboardRepoUrl: string;
  };
  repos: {
    root: string;
    aliases: Record<string, { path: string; sequentialBuild?: boolean }>;
  };
  ado: {
    org: string;
    project: string;
    defaultArea: string;
  };
  slack: {
    enabled: boolean;
    channel: string;
    channelId: string;
    pollIntervalSeconds: number;
  };
  agents: {
    names: Record<string, string>;
    defaultStages: string[];
    defaultReviewAfter: string;
    maxConcurrentTotal: number;
    maxConcurrentValidate: number;
    maxTurns: Record<string, number>;
    timeoutsMinutes: Record<string, number>;
    heartbeatTimeoutMinutes: number;
    retryCount: number;
    maxValidateRetries: number;
    maxReviewRecurrence: number;
  };
  schedule: {
    rollupTime: string;
    notionPushDay: string;
    notionPushTime: string;
    monthlyReportDay: number;
    monthlyReportTime: string;
  };
  worktree: {
    retentionDays: number;
    cleanupOnStartup: boolean;
  };
  review: {
    enforceSuggestions: boolean;
  };
}

export const DEFAULT_CONFIG: ShkmnConfig = {
  pipeline: {
    runtimeDir: "",
    agentsDir: "",
    dashboardRepoLocal: "",
    dashboardRepoUrl: "",
  },
  repos: {
    root: "",
    aliases: {},
  },
  ado: {
    org: "",
    project: "",
    defaultArea: "",
  },
  slack: {
    enabled: false,
    channel: "#agent-pipeline",
    channelId: "",
    pollIntervalSeconds: 30,
  },
  agents: {
    names: { ...DEFAULT_AGENT_NAMES },
    defaultStages: [
      "questions", "research", "design", "structure", "plan",
      "impl", "validate", "review", "pr",
    ],
    defaultReviewAfter: "design",
    maxConcurrentTotal: 3,
    maxConcurrentValidate: 1,
    maxTurns: {
      questions: 15,
      research: 30,
      design: 20,
      structure: 15,
      plan: 20,
      impl: 60,
      validate: 10,
      review: 30,
      classify: 5,
    },
    timeoutsMinutes: {
      questions: 15,
      research: 45,
      design: 30,
      structure: 20,
      plan: 30,
      impl: 90,
      validate: 15,
      review: 45,
      classify: 2,
    },
    heartbeatTimeoutMinutes: 10,
    retryCount: 1,
    maxValidateRetries: 2,
    maxReviewRecurrence: 3,
  },
  schedule: {
    rollupTime: "23:55",
    notionPushDay: "Friday",
    notionPushTime: "18:00",
    monthlyReportDay: 1,
    monthlyReportTime: "08:00",
  },
  worktree: {
    retentionDays: 7,
    cleanupOnStartup: true,
  },
  review: {
    enforceSuggestions: true,
  },
};
```

### Step 1.4 — Update `src/config/loader.ts`

- [ ] Add `worktree` and `review` sections to `ResolvedConfig`, and update `resolveConfig`. Replace file contents:

```typescript
import { readFileSync } from "node:fs";
import { configSchema, type ConfigParsed } from "./schema.js";
import { DEFAULT_CONFIG, DEFAULT_AGENT_NAMES } from "./defaults.js";

export interface ResolvedConfig {
  pipeline: {
    runtimeDir: string;
    agentsDir: string;
    dashboardRepoLocal: string;
    dashboardRepoUrl: string;
  };
  repos: {
    root: string;
    aliases: Record<string, { path: string; sequentialBuild?: boolean }>;
  };
  ado: {
    org: string;
    project: string;
    defaultArea: string;
  };
  slack: {
    enabled: boolean;
    channel: string;
    channelId: string;
    pollIntervalSeconds: number;
  };
  agents: {
    names: Record<string, string>;
    defaultStages: string[];
    defaultReviewAfter: string;
    maxConcurrentTotal: number;
    maxConcurrentValidate: number;
    maxTurns: Record<string, number>;
    timeoutsMinutes: Record<string, number>;
    heartbeatTimeoutMinutes: number;
    retryCount: number;
    maxValidateRetries: number;
    maxReviewRecurrence: number;
  };
  schedule: {
    rollupTime: string;
    notionPushDay: string;
    notionPushTime: string;
    monthlyReportDay: number;
    monthlyReportTime: string;
  };
  worktree: {
    retentionDays: number;
    cleanupOnStartup: boolean;
  };
  review: {
    enforceSuggestions: boolean;
  };
}

/**
 * Reads a JSON config file from disk, validates with the Zod schema, and
 * returns a fully resolved config merged with defaults.
 */
export function loadConfig(configPath: string): ResolvedConfig {
  let raw: string;
  raw = readFileSync(configPath, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse config file as JSON at "${configPath}": ${(err as Error).message}`);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const messages = result.error.issues
      .map((i) => {
        const path = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
        return `${path}${i.message}`;
      })
      .join("; ");
    throw new Error(`Invalid config at "${configPath}": ${messages}`);
  }

  return resolveConfig(result.data);
}

/**
 * Merges a validated (Zod-parsed) config with defaults to produce a
 * fully resolved config with all fields present.
 */
export function resolveConfig(parsed: ConfigParsed): ResolvedConfig {
  const d = DEFAULT_CONFIG;
  const da = d.agents;

  return {
    pipeline: {
      runtimeDir: parsed.pipeline.runtimeDir,
      agentsDir: parsed.pipeline.agentsDir ?? d.pipeline.agentsDir,
      dashboardRepoLocal: parsed.pipeline.dashboardRepoLocal ?? d.pipeline.dashboardRepoLocal,
      dashboardRepoUrl: parsed.pipeline.dashboardRepoUrl ?? d.pipeline.dashboardRepoUrl,
    },
    repos: {
      root: parsed.repos?.root ?? d.repos.root,
      aliases: parsed.repos?.aliases ?? d.repos.aliases,
    },
    ado: {
      org: parsed.ado?.org ?? d.ado.org,
      project: parsed.ado?.project ?? d.ado.project,
      defaultArea: parsed.ado?.defaultArea ?? d.ado.defaultArea,
    },
    slack: {
      enabled: parsed.slack?.enabled ?? d.slack.enabled,
      channel: parsed.slack?.channel ?? d.slack.channel,
      channelId: parsed.slack?.channelId ?? d.slack.channelId,
      pollIntervalSeconds: parsed.slack?.pollIntervalSeconds ?? d.slack.pollIntervalSeconds,
    },
    agents: {
      names: { ...DEFAULT_AGENT_NAMES, ...parsed.agents?.names },
      defaultStages: parsed.agents?.defaultStages ?? [...da.defaultStages],
      defaultReviewAfter: parsed.agents?.defaultReviewAfter ?? da.defaultReviewAfter,
      maxConcurrentTotal: parsed.agents?.maxConcurrentTotal ?? da.maxConcurrentTotal,
      maxConcurrentValidate: parsed.agents?.maxConcurrentValidate ?? da.maxConcurrentValidate,
      maxTurns: { ...da.maxTurns, ...parsed.agents?.maxTurns },
      timeoutsMinutes: { ...da.timeoutsMinutes, ...parsed.agents?.timeoutsMinutes },
      heartbeatTimeoutMinutes: parsed.agents?.heartbeatTimeoutMinutes ?? da.heartbeatTimeoutMinutes,
      retryCount: parsed.agents?.retryCount ?? da.retryCount,
      maxValidateRetries: parsed.agents?.maxValidateRetries ?? da.maxValidateRetries,
      maxReviewRecurrence: parsed.agents?.maxReviewRecurrence ?? da.maxReviewRecurrence,
    },
    schedule: {
      rollupTime: parsed.schedule?.rollupTime ?? d.schedule.rollupTime,
      notionPushDay: parsed.schedule?.notionPushDay ?? d.schedule.notionPushDay,
      notionPushTime: parsed.schedule?.notionPushTime ?? d.schedule.notionPushTime,
      monthlyReportDay: parsed.schedule?.monthlyReportDay ?? d.schedule.monthlyReportDay,
      monthlyReportTime: parsed.schedule?.monthlyReportTime ?? d.schedule.monthlyReportTime,
    },
    worktree: {
      retentionDays: parsed.worktree?.retentionDays ?? d.worktree.retentionDays,
      cleanupOnStartup: parsed.worktree?.cleanupOnStartup ?? d.worktree.cleanupOnStartup,
    },
    review: {
      enforceSuggestions: parsed.review?.enforceSuggestions ?? d.review.enforceSuggestions,
    },
  };
}

/**
 * Loads a .env file into process.env without overwriting existing variables.
 * Silently does nothing if the file does not exist.
 */
export function loadEnvFile(envPath: string): void {
  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    // File not found or unreadable — silently skip
    return;
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    // Skip blank lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes (single or double)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}
```

### Step 1.5 — Run and verify tests pass

- [ ] `npx vitest run tests/core/config-additions.test.ts`
- [ ] `npx vitest run tests/core/pipeline.test.ts` (existing tests still pass)

### Step 1.6 — Commit

- [ ] `git add src/config/defaults.ts src/config/schema.ts src/config/loader.ts tests/core/config-additions.test.ts`
- [ ] `git commit -m "feat(config): add worktree, review sections and maxValidateRetries/maxReviewRecurrence"`

---

## Task 2: RunState Type Extensions

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/pipeline.ts` (`createRunState` only)

Add new fields to `RunState` and the `ReviewIssue` interface. Initialize them in `createRunState`.

### Step 2.1 — Update `src/core/types.ts`

- [ ] Replace file contents:

```typescript
import type { ResolvedConfig } from "../config/loader.js";

export type PipelineStage =
  | "questions" | "research" | "design" | "structure" | "plan"
  | "impl" | "validate" | "review" | "pr";

export type RunStatus = "running" | "hold" | "complete" | "failed";

export interface CompletedStage {
  stage: string;
  completedAt: string;
  outputFile?: string;
  costUsd?: number;
  turns?: number;
}

export interface ReviewIssue {
  id: string;           // hash derived from severity + first sentence of description
  description: string;
  severity: string;     // "MUST_FIX" | "SHOULD_FIX" | "SUGGESTION"
  firstSeen: number;    // iteration number (reviewRetryCount when first encountered)
  lastSeen: number;     // iteration number (reviewRetryCount when last seen)
}

export interface RunState {
  slug: string;
  taskFile: string;
  stages: string[];
  reviewAfter: string;
  currentStage: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  completedStages: CompletedStage[];
  error?: string;

  // Execution working directory fields
  workDir?: string;           // effective cwd for execution agents
  worktreePath?: string;      // git worktree path (only for repo-backed tasks)
  invocationCwd?: string;     // directory where the task was created from

  // Retry counters
  validateRetryCount: number;
  reviewRetryCount: number;
  reviewIssues: ReviewIssue[];
}

export interface AgentRunOptions {
  stage: string;
  slug: string;
  taskContent: string;
  previousOutput: string;
  outputPath: string;
  cwd: string;
  config: ResolvedConfig;
  templateDir: string;
  abortController?: AbortController;
  logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

export interface AgentRunResult {
  success: boolean;
  output: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  error?: string;
}

export type AgentRunnerFn = (options: AgentRunOptions) => Promise<AgentRunResult>;
```

### Step 2.2 — Update `createRunState` in `src/core/pipeline.ts`

- [ ] In `createRunState`, replace the returned object to include new fields:

```typescript
// CHANGE: update the return statement in createRunState
  return {
    slug,
    taskFile: "task.task",
    stages,
    reviewAfter,
    currentStage: "",
    status: "running",
    startedAt: now,
    updatedAt: now,
    completedStages: [],
    validateRetryCount: 0,
    reviewRetryCount: 0,
    reviewIssues: [],
  };
```

### Step 2.3 — Run tests

- [ ] `npx vitest run tests/core/pipeline.test.ts` (the new `createRunState` test from Task 1 should now pass)

### Step 2.4 — Commit

- [ ] `git add src/core/types.ts src/core/pipeline.ts`
- [ ] `git commit -m "feat(types): add RunState retry fields and ReviewIssue interface"`

---

## Task 3: Worktree Manager

**Files:**
- Create: `src/core/worktree.ts`
- Create: `tests/core/worktree.test.ts`

### Step 3.1 — Write failing tests

- [ ] Create `tests/core/worktree.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

import {
  createWorktree,
  removeWorktree,
  listWorktrees,
  cleanupExpired,
  recordWorktreeCompletion,
  type WorktreeInfo,
} from "../../src/core/worktree.js";

let TEST_DIR: string;
let REPO_DIR: string;

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Test repo");
  execSync("git add .", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "initial commit"', { cwd: dir, stdio: "pipe" });
}

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `shkmn-wt-test-${randomUUID()}`);
  REPO_DIR = join(TEST_DIR, "repo");
  initGitRepo(REPO_DIR);
});

afterEach(() => {
  // Force-remove worktrees first, then clean up test dir
  try {
    execSync("git worktree prune", { cwd: REPO_DIR, stdio: "pipe" });
  } catch {
    // ignore
  }
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ─── createWorktree ─────────────────────────────────────────────────────────

describe("createWorktree", () => {
  it("creates a worktree directory with branch shkmn/{slug}", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    const worktreePath = createWorktree(REPO_DIR, "my-task-123", worktreesDir);

    expect(worktreePath).toBe(join(worktreesDir, "my-task-123"));
    expect(existsSync(worktreePath)).toBe(true);

    // Branch should exist
    const branches = execSync("git branch", { cwd: REPO_DIR, encoding: "utf-8" });
    expect(branches).toContain("shkmn/my-task-123");
  });

  it("returns the same path if worktree already exists (idempotent for crash recovery)", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    const path1 = createWorktree(REPO_DIR, "my-task-abc", worktreesDir);
    // Call again — should not throw, should return same path
    const path2 = createWorktree(REPO_DIR, "my-task-abc", worktreesDir);
    expect(path1).toBe(path2);
    expect(existsSync(path2)).toBe(true);
  });

  it("uses custom base branch when provided", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    // Create a feature branch first
    execSync("git checkout -b feature/base", { cwd: REPO_DIR, stdio: "pipe" });
    execSync("git checkout -", { cwd: REPO_DIR, stdio: "pipe" });

    const worktreePath = createWorktree(REPO_DIR, "branched-task", worktreesDir, "feature/base");
    expect(existsSync(worktreePath)).toBe(true);
  });
});

// ─── removeWorktree ──────────────────────────────────────────────────────────

describe("removeWorktree", () => {
  it("removes the worktree directory and deletes the branch", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    const worktreePath = createWorktree(REPO_DIR, "remove-task", worktreesDir);

    removeWorktree(REPO_DIR, worktreePath, "remove-task");

    expect(existsSync(worktreePath)).toBe(false);

    const branches = execSync("git branch", { cwd: REPO_DIR, encoding: "utf-8" });
    expect(branches).not.toContain("shkmn/remove-task");
  });

  it("does not throw if worktree was already removed", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    const worktreePath = createWorktree(REPO_DIR, "gone-task", worktreesDir);
    removeWorktree(REPO_DIR, worktreePath, "gone-task");

    // Second removal should not throw
    expect(() => removeWorktree(REPO_DIR, worktreePath, "gone-task")).not.toThrow();
  });
});

// ─── listWorktrees ───────────────────────────────────────────────────────────

describe("listWorktrees", () => {
  it("returns empty array when no shkmn worktrees exist", () => {
    const result = listWorktrees(REPO_DIR);
    expect(result).toEqual([]);
  });

  it("lists all shkmn/* worktrees", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    createWorktree(REPO_DIR, "task-alpha", worktreesDir);
    createWorktree(REPO_DIR, "task-beta", worktreesDir);

    const result = listWorktrees(REPO_DIR);
    const slugs = result.map((w: WorktreeInfo) => w.slug).sort();
    expect(slugs).toEqual(["task-alpha", "task-beta"]);
  });

  it("returned WorktreeInfo has required fields", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    createWorktree(REPO_DIR, "task-check", worktreesDir);

    const result = listWorktrees(REPO_DIR);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBeTruthy();
    expect(result[0].branch).toBe("shkmn/task-check");
    expect(result[0].slug).toBe("task-check");
  });
});

// ─── recordWorktreeCompletion / cleanupExpired ───────────────────────────────

describe("cleanupExpired", () => {
  it("removes worktrees whose completedAt is older than retentionDays", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    const manifestPath = join(TEST_DIR, "worktree-manifest.json");
    const worktreePath = createWorktree(REPO_DIR, "old-task", worktreesDir);

    // Record completion with a date 8 days ago
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 8);
    recordWorktreeCompletion(manifestPath, {
      slug: "old-task",
      repoPath: REPO_DIR,
      worktreePath,
      completedAt: oldDate.toISOString(),
    });

    const removed = cleanupExpired(manifestPath, 7);
    expect(removed).toContain(worktreePath);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("keeps worktrees within retentionDays", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    const manifestPath = join(TEST_DIR, "worktree-manifest.json");
    const worktreePath = createWorktree(REPO_DIR, "new-task", worktreesDir);

    // Record completion with today's date
    recordWorktreeCompletion(manifestPath, {
      slug: "new-task",
      repoPath: REPO_DIR,
      worktreePath,
      completedAt: new Date().toISOString(),
    });

    const removed = cleanupExpired(manifestPath, 7);
    expect(removed).toHaveLength(0);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("returns empty array when manifest does not exist", () => {
    const manifestPath = join(TEST_DIR, "nonexistent-manifest.json");
    const removed = cleanupExpired(manifestPath, 7);
    expect(removed).toEqual([]);
  });
});
```

- [ ] Run to see failures: `npx vitest run tests/core/worktree.test.ts`

### Step 3.2 — Create `src/core/worktree.ts`

- [ ] Create file:

```typescript
import { execSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WorktreeInfo {
  path: string;
  branch: string;
  slug: string;
}

export interface WorktreeManifestEntry {
  slug: string;
  repoPath: string;
  worktreePath: string;
  completedAt: string;
}

/**
 * Creates a git worktree for the given repo at {worktreesDir}/{slug}.
 * Creates branch shkmn/{slug} from HEAD (or baseBranch if provided).
 * If the worktree already exists (crash recovery), returns its path unchanged.
 */
export function createWorktree(
  repoPath: string,
  slug: string,
  worktreesDir: string,
  baseBranch?: string,
): string {
  const worktreePath = join(worktreesDir, slug);
  const branchName = `shkmn/${slug}`;

  // If the worktree path already exists, assume it's a crash-recovery scenario — reuse it.
  if (existsSync(worktreePath)) {
    return worktreePath;
  }

  mkdirSync(worktreesDir, { recursive: true });

  // Build the git worktree add command
  // -b creates a new branch; if baseBranch is given, branch from it
  const baseRef = baseBranch ?? "HEAD";
  execSync(
    `git worktree add -b "${branchName}" "${worktreePath}" ${baseRef}`,
    { cwd: repoPath, stdio: "pipe" },
  );

  return worktreePath;
}

/**
 * Removes a git worktree and deletes the associated shkmn/{slug} branch.
 * Does not throw if the worktree or branch is already gone.
 */
export function removeWorktree(
  repoPath: string,
  worktreePath: string,
  slug: string,
): void {
  const branchName = `shkmn/${slug}`;

  // Remove the worktree (--force handles detached HEAD or unclean state)
  try {
    execSync(`git worktree remove --force "${worktreePath}"`, {
      cwd: repoPath,
      stdio: "pipe",
    });
  } catch {
    // If the worktree directory is already gone, git worktree prune will clean metadata
    try {
      execSync("git worktree prune", { cwd: repoPath, stdio: "pipe" });
    } catch {
      // ignore
    }
  }

  // Delete the branch
  try {
    execSync(`git branch -D "${branchName}"`, { cwd: repoPath, stdio: "pipe" });
  } catch {
    // Branch may already be deleted — ignore
  }
}

/**
 * Lists all ShaktimaanAI-managed worktrees (branches matching shkmn/*) for a repo.
 * Parses `git worktree list --porcelain` output.
 */
export function listWorktrees(repoPath: string): WorktreeInfo[] {
  let output: string;
  try {
    output = execSync("git worktree list --porcelain", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch {
    return [];
  }

  // Each worktree entry is separated by a blank line
  const entries = output.trim().split(/\n\n+/);
  const result: WorktreeInfo[] = [];

  for (const entry of entries) {
    const lines = entry.trim().split("\n");
    const pathLine = lines.find(l => l.startsWith("worktree "));
    const branchLine = lines.find(l => l.startsWith("branch "));

    if (!pathLine || !branchLine) continue;

    const path = pathLine.replace(/^worktree /, "").trim();
    // branch line format: "branch refs/heads/shkmn/slug"
    const branchRef = branchLine.replace(/^branch /, "").trim();
    const branch = branchRef.replace(/^refs\/heads\//, "");

    if (!branch.startsWith("shkmn/")) continue;

    const slug = branch.replace(/^shkmn\//, "");
    result.push({ path, branch, slug });
  }

  return result;
}

/**
 * Records a worktree completion entry in the manifest file.
 * Creates the manifest if it doesn't exist. Overwrites existing entry for the same slug.
 */
export function recordWorktreeCompletion(
  manifestPath: string,
  entry: WorktreeManifestEntry,
): void {
  let entries: WorktreeManifestEntry[] = [];
  if (existsSync(manifestPath)) {
    try {
      entries = JSON.parse(readFileSync(manifestPath, "utf-8")) as WorktreeManifestEntry[];
    } catch {
      entries = [];
    }
  }

  // Replace existing entry for same slug or append
  const idx = entries.findIndex(e => e.slug === entry.slug);
  if (idx !== -1) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }

  writeFileSync(manifestPath, JSON.stringify(entries, null, 2), "utf-8");
}

/**
 * Scans the worktree manifest and removes entries older than retentionDays.
 * Returns an array of worktree paths that were removed.
 */
export function cleanupExpired(manifestPath: string, retentionDays: number): string[] {
  if (!existsSync(manifestPath)) return [];

  let entries: WorktreeManifestEntry[];
  try {
    entries = JSON.parse(readFileSync(manifestPath, "utf-8")) as WorktreeManifestEntry[];
  } catch {
    return [];
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const removed: string[] = [];
  const remaining: WorktreeManifestEntry[] = [];

  for (const entry of entries) {
    const completedAt = new Date(entry.completedAt);
    if (completedAt < cutoff) {
      removeWorktree(entry.repoPath, entry.worktreePath, entry.slug);
      removed.push(entry.worktreePath);
    } else {
      remaining.push(entry);
    }
  }

  writeFileSync(manifestPath, JSON.stringify(remaining, null, 2), "utf-8");
  return removed;
}
```

### Step 3.3 — Run and verify tests pass

- [ ] `npx vitest run tests/core/worktree.test.ts`

### Step 3.4 — Commit

- [ ] `git add src/core/worktree.ts tests/core/worktree.test.ts`
- [ ] `git commit -m "feat(worktree): add git worktree lifecycle manager with manifest-based cleanup"`

---

## Task 4: Retry Logic — Verdict Parsing

**Files:**
- Create: `src/core/retry.ts` (verdict parsing functions only; decision functions added in Task 5)
- Create: `tests/core/retry.test.ts`

### Step 4.1 — Write failing tests for verdict parsing

- [ ] Create `tests/core/retry.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  parseAgentVerdict,
  parseReviewFindings,
  issueHash,
} from "../../src/core/retry.js";

// ─── parseAgentVerdict ───────────────────────────────────────────────────────

describe("parseAgentVerdict", () => {
  describe("validate stage verdicts", () => {
    it("detects READY_FOR_REVIEW in bold markdown format", () => {
      const output = `
## Validation Report
Build: PASS
Tests: PASS

**Verdict:** READY_FOR_REVIEW
      `;
      expect(parseAgentVerdict(output, "validate")).toBe("READY_FOR_REVIEW");
    });

    it("detects NEEDS_FIXES in bold markdown format", () => {
      const output = `
Build failed at src/core/pipeline.ts line 42.

**Verdict:** NEEDS_FIXES
      `;
      expect(parseAgentVerdict(output, "validate")).toBe("NEEDS_FIXES");
    });

    it("detects READY_FOR_REVIEW case-insensitively", () => {
      const output = "**verdict:** ready_for_review";
      expect(parseAgentVerdict(output, "validate")).toBe("READY_FOR_REVIEW");
    });

    it("returns unknown when no verdict present", () => {
      expect(parseAgentVerdict("Some output with no verdict", "validate")).toBe("unknown");
    });
  });

  describe("review stage verdicts", () => {
    it("detects APPROVED", () => {
      const output = "All checks pass.\n\n**Verdict:** APPROVED";
      expect(parseAgentVerdict(output, "review")).toBe("APPROVED");
    });

    it("detects APPROVED_WITH_SUGGESTIONS", () => {
      const output = "Minor notes.\n\n**Verdict:** APPROVED_WITH_SUGGESTIONS";
      expect(parseAgentVerdict(output, "review")).toBe("APPROVED_WITH_SUGGESTIONS");
    });

    it("detects CHANGES_REQUIRED", () => {
      const output = "Critical issues found.\n\n**Verdict:** CHANGES_REQUIRED";
      expect(parseAgentVerdict(output, "review")).toBe("CHANGES_REQUIRED");
    });

    it("returns unknown for unrecognized review verdicts", () => {
      expect(parseAgentVerdict("No verdict here", "review")).toBe("unknown");
    });
  });

  describe("other stages", () => {
    it("returns unknown for stages that don't have verdicts", () => {
      expect(parseAgentVerdict("Some output", "impl")).toBe("unknown");
      expect(parseAgentVerdict("Some output", "questions")).toBe("unknown");
    });
  });
});

// ─── parseReviewFindings ─────────────────────────────────────────────────────

describe("parseReviewFindings", () => {
  it("parses a single MUST_FIX finding", () => {
    const output = `
[R1] MUST_FIX: Missing null check in parseConfig — config.agents could be undefined
  File: src/config/loader.ts:45
    `;
    const findings = parseReviewFindings(output);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("MUST_FIX");
    expect(findings[0].description).toContain("Missing null check");
    expect(findings[0].id).toBeTruthy();
  });

  it("parses multiple findings of mixed severity", () => {
    const output = `
[R1] MUST_FIX: No error handling in fetchData — will crash on network failure
[R2] SHOULD_FIX: Variable name 'x' is not descriptive enough
[R3] SUGGESTION: Consider extracting this logic into a helper function
    `;
    const findings = parseReviewFindings(output);
    expect(findings).toHaveLength(3);
    expect(findings[0].severity).toBe("MUST_FIX");
    expect(findings[1].severity).toBe("SHOULD_FIX");
    expect(findings[2].severity).toBe("SUGGESTION");
  });

  it("returns empty array when no findings present", () => {
    const output = "**Verdict:** APPROVED\n\nAll looks good!";
    expect(parseReviewFindings(output)).toEqual([]);
  });

  it("each finding has a unique id based on severity + first sentence", () => {
    const output = `
[R1] MUST_FIX: Error A — details here
[R2] MUST_FIX: Error B — different issue
    `;
    const findings = parseReviewFindings(output);
    expect(findings[0].id).not.toBe(findings[1].id);
  });

  it("same issue generates same id across different outputs", () => {
    const output1 = "[R1] MUST_FIX: Missing null check in parseConfig\n";
    const output2 = "[R3] MUST_FIX: Missing null check in parseConfig\n";
    const f1 = parseReviewFindings(output1);
    const f2 = parseReviewFindings(output2);
    expect(f1[0].id).toBe(f2[0].id);
  });
});

// ─── issueHash ───────────────────────────────────────────────────────────────

describe("issueHash", () => {
  it("returns a non-empty string", () => {
    expect(issueHash("MUST_FIX", "Missing null check")).toBeTruthy();
  });

  it("returns the same hash for the same input", () => {
    expect(issueHash("MUST_FIX", "Missing null check")).toBe(
      issueHash("MUST_FIX", "Missing null check"),
    );
  });

  it("returns different hashes for different inputs", () => {
    expect(issueHash("MUST_FIX", "Error A")).not.toBe(
      issueHash("MUST_FIX", "Error B"),
    );
    expect(issueHash("MUST_FIX", "Same error")).not.toBe(
      issueHash("SHOULD_FIX", "Same error"),
    );
  });

  it("is case and whitespace insensitive", () => {
    expect(issueHash("MUST_FIX", "  Missing null check  ")).toBe(
      issueHash("must_fix", "missing null check"),
    );
  });
});
```

- [ ] Run to see failures: `npx vitest run tests/core/retry.test.ts`

### Step 4.2 — Create `src/core/retry.ts` with parsing functions

- [ ] Create file (interfaces and parsing only; decision functions in Task 5):

```typescript
import type { ReviewIssue } from "./types.js";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface StageOutcome {
  stage: string;
  success: boolean;
  verdict: string;
  output: string;
}

export interface RetryDecision {
  action: "continue" | "retry" | "fail";
  retryTarget?: string;
  feedbackContent?: string;
  reason: string;
}

// ─── issueHash ───────────────────────────────────────────────────────────────

/**
 * Produces a stable hash from a severity string and the first sentence of a
 * description. Case-insensitive and whitespace-insensitive.
 * Used to track the "same" issue across review iterations.
 */
export function issueHash(severity: string, description: string): string {
  // Extract first sentence (up to first period, exclamation, question mark or end)
  const firstSentence = description.split(/[.!?]/)[0] ?? description;
  const normalized = `${severity}|${firstSentence}`
    .toLowerCase()
    .replace(/[\s\W]+/g, "");

  // Simple djb2 hash — good enough for issue identity
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash) ^ normalized.charCodeAt(i);
    hash = hash >>> 0; // keep as unsigned 32-bit
  }
  return hash.toString(16).padStart(8, "0");
}

// ─── parseAgentVerdict ───────────────────────────────────────────────────────

const VALIDATE_VERDICTS = ["READY_FOR_REVIEW", "NEEDS_FIXES"] as const;
const REVIEW_VERDICTS = ["APPROVED_WITH_SUGGESTIONS", "APPROVED", "CHANGES_REQUIRED"] as const;

/**
 * Extracts the verdict from agent output.
 * Looks for the pattern: **Verdict:** VERDICT_TEXT (case-insensitive).
 * Returns the matched verdict in uppercase or "unknown".
 */
export function parseAgentVerdict(output: string, stage: string): string {
  // Match **Verdict:** followed by the verdict text (case-insensitive label)
  const match = output.match(/\*\*verdict:\*\*\s*([A-Z_]+)/i);
  if (!match) return "unknown";

  const raw = match[1].toUpperCase();

  if (stage === "validate") {
    const found = VALIDATE_VERDICTS.find(v => v === raw);
    return found ?? "unknown";
  }

  if (stage === "review") {
    const found = REVIEW_VERDICTS.find(v => v === raw);
    return found ?? "unknown";
  }

  return "unknown";
}

// ─── parseReviewFindings ─────────────────────────────────────────────────────

/**
 * Parses review output for findings in the format:
 *   [R{n}] SEVERITY: description
 *
 * Returns an array of ReviewIssue with ids, descriptions, and severities.
 * firstSeen and lastSeen are set to 0 here — callers set the iteration values.
 */
export function parseReviewFindings(output: string): ReviewIssue[] {
  // Match lines like: [R1] MUST_FIX: Some description here — with trailing context
  const pattern = /\[R\d+\]\s+(MUST_FIX|SHOULD_FIX|SUGGESTION):\s*(.+)/g;
  const findings: ReviewIssue[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(output)) !== null) {
    const severity = match[1];
    const description = match[2].trim();
    const id = issueHash(severity, description);
    findings.push({
      id,
      severity,
      description,
      firstSeen: 0,
      lastSeen: 0,
    });
  }

  return findings;
}
```

### Step 4.3 — Run tests

- [ ] `npx vitest run tests/core/retry.test.ts` (parsing tests should pass)

### Step 4.4 — Commit

- [ ] `git add src/core/retry.ts tests/core/retry.test.ts`
- [ ] `git commit -m "feat(retry): add verdict parsing and issue hash for retry logic"`

---

## Task 5: Retry Logic — Decision Functions

**Files:**
- Modify: `src/core/retry.ts` (add decision functions)
- Modify: `tests/core/retry.test.ts` (add decision function tests)

### Step 5.1 — Add decision function tests

- [ ] Append to `tests/core/retry.test.ts`:

```typescript
import {
  parseAgentVerdict,
  parseReviewFindings,
  issueHash,
  decideAfterValidate,
  decideAfterReview,
} from "../../src/core/retry.js";
import type { ReviewIssue } from "../../src/core/types.js";

// ─── decideAfterValidate ─────────────────────────────────────────────────────

describe("decideAfterValidate", () => {
  const outcomeReady = {
    stage: "validate",
    success: true,
    verdict: "READY_FOR_REVIEW",
    output: "All tests pass.\n\n**Verdict:** READY_FOR_REVIEW",
  };

  const outcomeNeedsFixes = (output = "Build failed.\n\n**Verdict:** NEEDS_FIXES") => ({
    stage: "validate",
    success: true,
    verdict: "NEEDS_FIXES",
    output,
  });

  it("returns continue when READY_FOR_REVIEW", () => {
    const decision = decideAfterValidate(outcomeReady, 0, 2);
    expect(decision.action).toBe("continue");
  });

  it("returns retry when NEEDS_FIXES and retryCount < maxRetries", () => {
    const decision = decideAfterValidate(outcomeNeedsFixes(), 0, 2);
    expect(decision.action).toBe("retry");
    expect(decision.retryTarget).toBe("impl");
    expect(decision.feedbackContent).toBeTruthy();
  });

  it("retry feedback contains the failure output", () => {
    const output = "TypeScript error: TS2322 at src/core/pipeline.ts:42\n\n**Verdict:** NEEDS_FIXES";
    const decision = decideAfterValidate(outcomeNeedsFixes(output), 1, 2);
    expect(decision.feedbackContent).toContain("TS2322");
  });

  it("returns fail when NEEDS_FIXES and retryCount >= maxRetries", () => {
    const decision = decideAfterValidate(outcomeNeedsFixes(), 2, 2);
    expect(decision.action).toBe("fail");
    expect(decision.reason).toContain("max");
  });

  it("returns fail for unknown verdict", () => {
    const decision = decideAfterValidate(
      { stage: "validate", success: true, verdict: "unknown", output: "no verdict" },
      0,
      2,
    );
    expect(decision.action).toBe("fail");
  });
});

// ─── decideAfterReview ───────────────────────────────────────────────────────

describe("decideAfterReview", () => {
  function makeIssue(id: string, severity: string, firstSeen: number, lastSeen: number): ReviewIssue {
    return { id, description: `Issue ${id}`, severity, firstSeen, lastSeen };
  }

  const approvedOutcome = {
    stage: "review",
    success: true,
    verdict: "APPROVED",
    output: "**Verdict:** APPROVED",
  };

  const suggestionsOutcome = {
    stage: "review",
    success: true,
    verdict: "APPROVED_WITH_SUGGESTIONS",
    output: "[R1] SUGGESTION: Consider renaming x to something descriptive\n\n**Verdict:** APPROVED_WITH_SUGGESTIONS",
  };

  const changesOutcome = (output: string) => ({
    stage: "review",
    success: true,
    verdict: "CHANGES_REQUIRED",
    output,
  });

  it("returns continue for APPROVED", () => {
    const decision = decideAfterReview(approvedOutcome, [], 1, 3, true);
    expect(decision.action).toBe("continue");
  });

  it("returns continue for APPROVED_WITH_SUGGESTIONS when enforceSuggestions=false", () => {
    const decision = decideAfterReview(suggestionsOutcome, [], 1, 3, false);
    expect(decision.action).toBe("continue");
  });

  it("returns retry for APPROVED_WITH_SUGGESTIONS when enforceSuggestions=true", () => {
    const decision = decideAfterReview(suggestionsOutcome, [], 1, 3, true);
    expect(decision.action).toBe("retry");
    expect(decision.retryTarget).toBe("impl");
  });

  it("returns retry for CHANGES_REQUIRED with new issues (no previous)", () => {
    const output = "[R1] MUST_FIX: Error A\n\n**Verdict:** CHANGES_REQUIRED";
    const decision = decideAfterReview(changesOutcome(output), [], 1, 3, true);
    expect(decision.action).toBe("retry");
    expect(decision.retryTarget).toBe("impl");
  });

  it("returns retry for CHANGES_REQUIRED with only new issues even on iteration 3", () => {
    const output = "[R1] MUST_FIX: Brand new issue\n\n**Verdict:** CHANGES_REQUIRED";
    const decision = decideAfterReview(changesOutcome(output), [], 3, 3, true);
    // New issues always get a retry
    expect(decision.action).toBe("retry");
  });

  it("returns fail when a recurring issue has been seen >= maxRecurrence times", () => {
    // Issue has appeared twice before (firstSeen=1, lastSeen=2) and appears again in iteration 3
    const existingIssue = makeIssue("aabbccdd", "MUST_FIX", 1, 2);
    // Build output where the same issue (same hash) appears
    const sameDescription = `Issue aabbccdd`;
    // We'll use a known-hash approach: make an issue whose id matches
    const output = `[R1] MUST_FIX: ${sameDescription}\n\n**Verdict:** CHANGES_REQUIRED`;
    const findings = parseReviewFindings(output);
    // Simulate that the finding matches a previous issue
    const prevIssue = { ...existingIssue, id: findings[0].id };
    const decision = decideAfterReview(changesOutcome(output), [prevIssue], 3, 2, true);
    expect(decision.action).toBe("fail");
    expect(decision.reason).toContain("recurrence");
  });

  it("feedback content includes findings from current review", () => {
    const output = "[R1] MUST_FIX: Missing null guard in loader\n\n**Verdict:** CHANGES_REQUIRED";
    const decision = decideAfterReview(changesOutcome(output), [], 1, 3, true);
    expect(decision.feedbackContent).toContain("Missing null guard");
  });

  it("returns fail for unknown review verdict", () => {
    const decision = decideAfterReview(
      { stage: "review", success: true, verdict: "unknown", output: "no verdict" },
      [],
      1,
      3,
      true,
    );
    expect(decision.action).toBe("fail");
  });
});
```

- [ ] Run to see failures (functions not yet implemented): `npx vitest run tests/core/retry.test.ts`

### Step 5.2 — Add decision functions to `src/core/retry.ts`

- [ ] Append to `src/core/retry.ts`:

```typescript
import type { ReviewIssue } from "./types.js";

// ─── decideAfterValidate ─────────────────────────────────────────────────────

/**
 * Decides what to do after the validate stage completes.
 * 
 * - READY_FOR_REVIEW → continue
 * - NEEDS_FIXES, retryCount < maxRetries → retry impl with feedback
 * - NEEDS_FIXES, retryCount >= maxRetries → fail
 * - unknown verdict → fail (agent did not produce parseable output)
 */
export function decideAfterValidate(
  outcome: StageOutcome,
  retryCount: number,
  maxRetries: number,
): RetryDecision {
  if (outcome.verdict === "READY_FOR_REVIEW") {
    return { action: "continue", reason: "Validation passed" };
  }

  if (outcome.verdict === "NEEDS_FIXES") {
    if (retryCount < maxRetries) {
      return {
        action: "retry",
        retryTarget: "impl",
        feedbackContent: buildValidateFeedback(outcome.output, retryCount + 1),
        reason: `Validation failed — retry ${retryCount + 1}/${maxRetries}`,
      };
    }
    return {
      action: "fail",
      reason: `Validation failed and max retries (${maxRetries}) exhausted`,
    };
  }

  return {
    action: "fail",
    reason: `Unknown validate verdict "${outcome.verdict}" — cannot proceed`,
  };
}

function buildValidateFeedback(output: string, attempt: number): string {
  return [
    `# Validate Feedback — Retry Attempt ${attempt}`,
    "",
    "The validation stage reported failures. Address ALL of the following before re-submitting.",
    "",
    "## Failure Output",
    "",
    output.trim(),
  ].join("\n");
}

// ─── decideAfterReview ────────────────────────────────────────────────────────

/**
 * Decides what to do after the review stage completes.
 *
 * Rules:
 * - APPROVED → continue
 * - APPROVED_WITH_SUGGESTIONS + enforceSuggestions=false → continue
 * - APPROVED_WITH_SUGGESTIONS + enforceSuggestions=true → retry (suggestions are actionable)
 * - CHANGES_REQUIRED with any recurring issue persisted >= maxRecurrence → fail
 * - CHANGES_REQUIRED with new issues → retry (progress being made)
 * - CHANGES_REQUIRED with only recurring issues below maxRecurrence → retry
 * - unknown verdict → fail
 */
export function decideAfterReview(
  outcome: StageOutcome,
  previousIssues: ReviewIssue[],
  currentIteration: number,
  maxRecurrence: number,
  enforceSuggestions: boolean,
): RetryDecision {
  if (outcome.verdict === "APPROVED") {
    return { action: "continue", reason: "Review approved" };
  }

  if (outcome.verdict === "APPROVED_WITH_SUGGESTIONS") {
    if (!enforceSuggestions) {
      return { action: "continue", reason: "Review approved with suggestions (not enforced)" };
    }
    const currentFindings = parseReviewFindings(outcome.output).map(f => ({
      ...f,
      firstSeen: currentIteration,
      lastSeen: currentIteration,
    }));
    return {
      action: "retry",
      retryTarget: "impl",
      feedbackContent: buildReviewFeedback(currentFindings, currentIteration),
      reason: "Review has suggestions — enforcing address before continue",
    };
  }

  if (outcome.verdict === "CHANGES_REQUIRED") {
    const currentFindings = parseReviewFindings(outcome.output);

    // Categorize findings
    const recurring: ReviewIssue[] = [];
    const newIssues: ReviewIssue[] = [];

    for (const finding of currentFindings) {
      const prev = previousIssues.find(p => p.id === finding.id);
      if (prev) {
        recurring.push({ ...prev, lastSeen: currentIteration });
      } else {
        newIssues.push({ ...finding, firstSeen: currentIteration, lastSeen: currentIteration });
      }
    }

    // Check if any recurring issue has exceeded maxRecurrence
    const exhaustedIssues = recurring.filter(
      r => (currentIteration - r.firstSeen + 1) >= maxRecurrence,
    );

    if (exhaustedIssues.length > 0) {
      return {
        action: "fail",
        reason: `Review failed: ${exhaustedIssues.length} issue(s) have recurred ${maxRecurrence}+ times without resolution`,
      };
    }

    // New issues or recurring below threshold → retry
    const allCurrentIssues = [
      ...recurring,
      ...newIssues,
    ];
    const hasNewIssues = newIssues.length > 0;

    return {
      action: "retry",
      retryTarget: "impl",
      feedbackContent: buildReviewFeedback(allCurrentIssues, currentIteration),
      reason: hasNewIssues
        ? `Review found ${newIssues.length} new issue(s) — retrying impl`
        : `Review found ${recurring.length} recurring issue(s) below max recurrence — retrying impl`,
    };
  }

  return {
    action: "fail",
    reason: `Unknown review verdict "${outcome.verdict}" — cannot proceed`,
  };
}

function buildReviewFeedback(issues: ReviewIssue[], iteration: number): string {
  const lines = [
    `# Review Feedback — Iteration ${iteration}`,
    "",
    "The review stage identified the following issues. Address ALL MUST_FIX items. Address SHOULD_FIX items unless there is a clear justification.",
    "",
    "## Findings",
    "",
  ];

  for (const issue of issues) {
    const recurrence = issue.firstSeen < iteration
      ? ` *(recurring since iteration ${issue.firstSeen})*`
      : "";
    lines.push(`- **${issue.severity}**${recurrence}: ${issue.description}`);
  }

  return lines.join("\n");
}
```

### Step 5.3 — Run and verify all retry tests pass

- [ ] `npx vitest run tests/core/retry.test.ts`

### Step 5.4 — Commit

- [ ] `git add src/core/retry.ts tests/core/retry.test.ts`
- [ ] `git commit -m "feat(retry): add decideAfterValidate and decideAfterReview decision functions"`

---

## Task 6: Pipeline Modifications — WorkDir Resolution

**Files:**
- Modify: `src/core/pipeline.ts`
- Modify: `tests/core/pipeline.test.ts`

### Step 6.1 — Write failing tests

- [ ] Add to `tests/core/pipeline.test.ts`:

```typescript
// ─── workDir resolution ──────────────────────────────────────────────────────

describe("pipeline workDir resolution", () => {
  it("uses invocationCwd when no repo and no repos.root configured", async () => {
    createRuntimeDirs(TEST_DIR);
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-impl.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-validate.md"), "template", "utf-8");

    const taskContent = makeSimpleTask("impl, validate");
    const inboxPath = join(TEST_DIR, "00-inbox", "work-dir-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    let capturedCwd: string | undefined;
    const trackingRunner = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      if (options.stage === "impl") {
        capturedCwd = options.cwd;
      }
      if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
        writeFileSync(options.outputPath, `Output for ${options.stage} — **Verdict:** READY_FOR_REVIEW`);
      }
      return {
        success: true,
        output: options.stage === "validate"
          ? "All pass.\n\n**Verdict:** READY_FOR_REVIEW"
          : `Output for ${options.stage}`,
        costUsd: 0,
        turns: 1,
        durationMs: 10,
      };
    };

    const config = makeConfig();
    const registry = createAgentRegistry(3, 1);
    const invocationCwd = join(TEST_DIR, "invocation-dir");
    mkdirSync(invocationCwd, { recursive: true });

    const pipeline = createPipeline({
      config,
      registry,
      runner: trackingRunner,
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath, invocationCwd);

    // impl stage should have used invocationCwd as its cwd
    expect(capturedCwd).toBe(invocationCwd);
  });

  it("uses repos.root/{slug} when repos.root is configured and no task repo", async () => {
    const reposRoot = join(TEST_DIR, "repos");
    mkdirSync(reposRoot, { recursive: true });
    createRuntimeDirs(TEST_DIR);
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-impl.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-validate.md"), "template", "utf-8");

    const taskContent = makeSimpleTask("impl, validate");
    const inboxPath = join(TEST_DIR, "00-inbox", "repos-root-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    let capturedCwd: string | undefined;
    const trackingRunner = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      if (options.stage === "impl") capturedCwd = options.cwd;
      if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
        writeFileSync(options.outputPath, `Output — **Verdict:** READY_FOR_REVIEW`);
      }
      return {
        success: true,
        output: options.stage === "validate"
          ? "**Verdict:** READY_FOR_REVIEW"
          : "done",
        costUsd: 0, turns: 1, durationMs: 10,
      };
    };

    const config = makeConfig({ repos: { root: reposRoot, aliases: {} } });
    const registry = createAgentRegistry(3, 1);
    const pipeline = createPipeline({
      config, registry, runner: trackingRunner,
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath);

    expect(capturedCwd).toBe(join(reposRoot, "repos-root-task"));
    expect(existsSync(join(reposRoot, "repos-root-task"))).toBe(true);
  });

  it("stores workDir in run state after impl stage", async () => {
    createRuntimeDirs(TEST_DIR);
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-impl.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-validate.md"), "template", "utf-8");

    const taskContent = makeSimpleTask("impl, validate");
    const inboxPath = join(TEST_DIR, "00-inbox", "state-work-dir-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    const stubRunner = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
        writeFileSync(options.outputPath, `Output — **Verdict:** READY_FOR_REVIEW`);
      }
      return {
        success: true,
        output: "**Verdict:** READY_FOR_REVIEW",
        costUsd: 0, turns: 1, durationMs: 10,
      };
    };

    const invocationCwd = join(TEST_DIR, "inv-cwd");
    mkdirSync(invocationCwd, { recursive: true });

    const config = makeConfig();
    const registry = createAgentRegistry(3, 1);
    const pipeline = createPipeline({
      config, registry, runner: stubRunner,
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath, invocationCwd);

    const completeDir = join(TEST_DIR, "10-complete", "state-work-dir-task");
    const finalState = readRunState(completeDir);
    expect(finalState.workDir).toBe(invocationCwd);
  });
});
```

- [ ] Run to see failures: `npx vitest run tests/core/pipeline.test.ts`

### Step 6.2 — Modify `src/core/pipeline.ts`

The pipeline changes are surgical. Here are the exact modifications to make:

**Change 1:** Update the `startRun` signature to accept optional `invocationCwd`:

```typescript
// REPLACE this signature in startRun:
async startRun(taskFilePath: string): Promise<void> {

// WITH:
async startRun(taskFilePath: string, invocationCwd?: string): Promise<void> {
```

**Change 2:** In `startRun`, set `invocationCwd` on the state before writing:

```typescript
// AFTER:
const firstStage = state.stages[0];
state.currentStage = firstStage;

// ADD:
if (invocationCwd) {
  state.invocationCwd = invocationCwd;
}
```

**Change 3:** Update the `Pipeline` interface to match:

```typescript
// REPLACE in Pipeline interface:
startRun(taskFilePath: string): Promise<void>;

// WITH:
startRun(taskFilePath: string, invocationCwd?: string): Promise<void>;
```

**Change 4:** Add `mkdirSync` import for `repos.root/{slug}` creation (already imported — verify it's in the import list at the top of the file).

**Change 5:** Add the execution stage list constant and `resolveWorkDir` helper function. Add these near the top of `createPipeline`, before `processStage`:

```typescript
// ADD after the activeRuns Map declaration:
const EXECUTION_STAGES = new Set(["impl", "validate", "review", "pr"]);

function resolveWorkDir(state: RunState): string {
  // Resolution chain:
  // 1. workDir already set (retry or resume) → reuse
  if (state.workDir) return state.workDir;

  // 2. No repo path on task — check repos.root
  if (config.repos.root) {
    const dir = join(config.repos.root, state.slug);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // 3. Fall back to invocation cwd
  return state.invocationCwd ?? runtimeDir;
}
```

**Change 6:** In `processStage`, before running an agent, resolve `workDir` when entering `impl`:

```typescript
// ADD after:
//   const taskLogger = createTaskLogger(join(runtimeDir, "logs"), slug);
// and BEFORE:
//   if (!registry.canStartAgent(stage)) {

// INSERT:
      // Resolve workDir when entering impl for the first time
      if (stage === "impl" && !state.workDir) {
        state.workDir = resolveWorkDir(state);
        writeRunState(currentTaskDir, state);
      }
```

**Change 7:** Override `cwd` for execution stages when building `runOptions`:

```typescript
// REPLACE in runOptions construction:
      const runOptions: AgentRunOptions = {
        stage,
        slug,
        taskContent,
        previousOutput: previousOutput.trim(),
        outputPath,
        cwd: currentTaskDir,
        config,
        templateDir: join(runtimeDir, "templates"),
        abortController,
        logger: taskLogger,
      };

// WITH:
      // Execution stages (impl, validate, review, pr) work in the resolved workDir.
      // Alignment stages work in the task directory as before.
      const stageCwd = EXECUTION_STAGES.has(stage) && state.workDir
        ? state.workDir
        : currentTaskDir;

      const runOptions: AgentRunOptions = {
        stage,
        slug,
        taskContent,
        previousOutput: previousOutput.trim(),
        outputPath,
        cwd: stageCwd,
        config,
        templateDir: join(runtimeDir, "templates"),
        abortController,
        logger: taskLogger,
      };
```

- [ ] Apply all 7 changes to `src/core/pipeline.ts`

### Step 6.3 — Run and verify tests pass

- [ ] `npx vitest run tests/core/pipeline.test.ts`

### Step 6.4 — Commit

- [ ] `git add src/core/pipeline.ts`
- [ ] `git commit -m "feat(pipeline): resolve workDir before impl, use it as cwd for execution stages"`

---

## Task 7: Pipeline Modifications — Retry Integration

**Files:**
- Modify: `src/core/pipeline.ts`
- Modify: `tests/core/pipeline.test.ts`

This is the most complex change. After validate or review succeeds (agent didn't crash), the pipeline parses the verdict, decides what to do, and either continues, retries (sends back to impl), or fails.

### Step 7.1 — Write failing tests

- [ ] Add to `tests/core/pipeline.test.ts`:

```typescript
// ─── retry integration ───────────────────────────────────────────────────────

describe("pipeline retry integration", () => {
  function makeRetryTask(): string {
    return makeSimpleTask("impl, validate, review, pr");
  }

  it("retries impl when validate returns NEEDS_FIXES (within maxRetries)", async () => {
    createRuntimeDirs(TEST_DIR);
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    for (const s of ["impl", "validate", "review", "pr"]) {
      writeFileSync(join(templatesDir, `prompt-${s}.md`), "template", "utf-8");
    }

    const taskContent = makeRetryTask();
    const inboxPath = join(TEST_DIR, "00-inbox", "retry-validate-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    let validateCallCount = 0;
    let implCallCount = 0;

    const retryRunner = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
      }

      if (options.stage === "impl") {
        implCallCount++;
        if (options.outputPath) writeFileSync(options.outputPath, "impl output");
        return { success: true, output: "impl done", costUsd: 0, turns: 1, durationMs: 10 };
      }

      if (options.stage === "validate") {
        validateCallCount++;
        // Fail first time, pass second time
        const verdict = validateCallCount === 1 ? "NEEDS_FIXES" : "READY_FOR_REVIEW";
        const output = `Build output.\n\n**Verdict:** ${verdict}`;
        if (options.outputPath) writeFileSync(options.outputPath, output);
        return { success: true, output, costUsd: 0, turns: 1, durationMs: 10 };
      }

      if (options.stage === "review") {
        const output = "Looks good.\n\n**Verdict:** APPROVED";
        if (options.outputPath) writeFileSync(options.outputPath, output);
        return { success: true, output, costUsd: 0, turns: 1, durationMs: 10 };
      }

      if (options.outputPath) writeFileSync(options.outputPath, "pr done");
      return { success: true, output: "pr done", costUsd: 0, turns: 1, durationMs: 10 };
    };

    const config = makeConfig();
    const registry = createAgentRegistry(3, 1);
    const invCwd = join(TEST_DIR, "inv-cwd-retry");
    mkdirSync(invCwd, { recursive: true });
    const pipeline = createPipeline({
      config, registry, runner: retryRunner,
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath, invCwd);

    expect(implCallCount).toBe(2);    // impl ran twice
    expect(validateCallCount).toBe(2); // validate ran twice

    const completeDir = join(TEST_DIR, "10-complete", "retry-validate-task");
    expect(existsSync(completeDir)).toBe(true);
    const state = readRunState(completeDir);
    expect(state.status).toBe("complete");
    expect(state.validateRetryCount).toBe(1);
  });

  it("fails task when validate NEEDS_FIXES exceeds maxRetries", async () => {
    createRuntimeDirs(TEST_DIR);
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    for (const s of ["impl", "validate"]) {
      writeFileSync(join(templatesDir, `prompt-${s}.md`), "template", "utf-8");
    }

    const taskContent = makeSimpleTask("impl, validate");
    const inboxPath = join(TEST_DIR, "00-inbox", "exhaust-validate-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    const alwaysFailRunner = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
        writeFileSync(options.outputPath, "**Verdict:** NEEDS_FIXES");
      }
      return {
        success: true,
        output: "Build failed.\n\n**Verdict:** NEEDS_FIXES",
        costUsd: 0, turns: 1, durationMs: 10,
      };
    };

    // maxValidateRetries=1 means 1 retry allowed (2 total validate runs)
    const config = makeConfig({ agents: { maxValidateRetries: 1 } });
    const registry = createAgentRegistry(3, 1);
    const invCwd = join(TEST_DIR, "inv-cwd-exhaust");
    mkdirSync(invCwd, { recursive: true });
    const pipeline = createPipeline({
      config, registry, runner: alwaysFailRunner,
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath, invCwd);

    const failedDir = join(TEST_DIR, "11-failed", "exhaust-validate-task");
    expect(existsSync(failedDir)).toBe(true);
    const state = readRunState(failedDir);
    expect(state.status).toBe("failed");
    expect(state.error).toContain("max");
  });

  it("writes retry-feedback artifact before sending task back to impl", async () => {
    createRuntimeDirs(TEST_DIR);
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    for (const s of ["impl", "validate"]) {
      writeFileSync(join(templatesDir, `prompt-${s}.md`), "template", "utf-8");
    }

    const taskContent = makeSimpleTask("impl, validate");
    const inboxPath = join(TEST_DIR, "00-inbox", "feedback-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    let implArtifactsDir: string | undefined;
    let validateRunCount = 0;

    const feedbackRunner = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
      }
      if (options.stage === "impl") {
        implArtifactsDir = dirname(options.outputPath);
        if (options.outputPath) writeFileSync(options.outputPath, "impl done");
        return { success: true, output: "impl done", costUsd: 0, turns: 1, durationMs: 10 };
      }
      validateRunCount++;
      if (validateRunCount === 1) {
        const out = "TypeScript error TS2345\n\n**Verdict:** NEEDS_FIXES";
        if (options.outputPath) writeFileSync(options.outputPath, out);
        return { success: true, output: out, costUsd: 0, turns: 1, durationMs: 10 };
      }
      // Second validate passes
      const out = "All clear.\n\n**Verdict:** READY_FOR_REVIEW";
      if (options.outputPath) writeFileSync(options.outputPath, out);
      return { success: true, output: out, costUsd: 0, turns: 1, durationMs: 10 };
    };

    const config = makeConfig();
    const registry = createAgentRegistry(3, 1);
    const invCwd = join(TEST_DIR, "inv-cwd-feedback");
    mkdirSync(invCwd, { recursive: true });
    const pipeline = createPipeline({
      config, registry, runner: feedbackRunner,
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath, invCwd);

    // After completion the artifacts dir should contain a retry feedback file
    const completeDir = join(TEST_DIR, "10-complete", "feedback-task");
    const artifactsDir = join(completeDir, "artifacts");
    const feedbackFiles = existsSync(artifactsDir)
      ? readdirSync(artifactsDir).filter(f => f.startsWith("retry-feedback-validate"))
      : [];
    expect(feedbackFiles.length).toBeGreaterThan(0);
  });

  it("retries impl when review returns CHANGES_REQUIRED with new issues", async () => {
    createRuntimeDirs(TEST_DIR);
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    for (const s of ["impl", "validate", "review", "pr"]) {
      writeFileSync(join(templatesDir, `prompt-${s}.md`), "template", "utf-8");
    }

    const taskContent = makeRetryTask();
    const inboxPath = join(TEST_DIR, "00-inbox", "review-retry-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    let reviewCallCount = 0;

    const reviewRetryRunner = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
      }
      if (options.stage === "impl") {
        if (options.outputPath) writeFileSync(options.outputPath, "impl done");
        return { success: true, output: "impl done", costUsd: 0, turns: 1, durationMs: 10 };
      }
      if (options.stage === "validate") {
        const out = "Tests pass.\n\n**Verdict:** READY_FOR_REVIEW";
        if (options.outputPath) writeFileSync(options.outputPath, out);
        return { success: true, output: out, costUsd: 0, turns: 1, durationMs: 10 };
      }
      if (options.stage === "review") {
        reviewCallCount++;
        if (reviewCallCount === 1) {
          const out = "[R1] MUST_FIX: Missing error handling in fetchData\n\n**Verdict:** CHANGES_REQUIRED";
          if (options.outputPath) writeFileSync(options.outputPath, out);
          return { success: true, output: out, costUsd: 0, turns: 1, durationMs: 10 };
        }
        const out = "All issues resolved.\n\n**Verdict:** APPROVED";
        if (options.outputPath) writeFileSync(options.outputPath, out);
        return { success: true, output: out, costUsd: 0, turns: 1, durationMs: 10 };
      }
      if (options.outputPath) writeFileSync(options.outputPath, "pr done");
      return { success: true, output: "pr done", costUsd: 0, turns: 1, durationMs: 10 };
    };

    const config = makeConfig();
    const registry = createAgentRegistry(3, 1);
    const invCwd = join(TEST_DIR, "inv-cwd-review-retry");
    mkdirSync(invCwd, { recursive: true });
    const pipeline = createPipeline({
      config, registry, runner: reviewRetryRunner,
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath, invCwd);

    expect(reviewCallCount).toBe(2);

    const completeDir = join(TEST_DIR, "10-complete", "review-retry-task");
    expect(existsSync(completeDir)).toBe(true);
    const state = readRunState(completeDir);
    expect(state.reviewRetryCount).toBe(1);
  });
});
```

- [ ] Add `readdirSync` to the imports at the top of the test file if not already present
- [ ] Run to see failures: `npx vitest run tests/core/pipeline.test.ts`

### Step 7.2 — Modify `src/core/pipeline.ts` to add retry integration

Add the following import at the top of the file (after existing imports):

```typescript
import { parseAgentVerdict, decideAfterValidate, decideAfterReview } from "./retry.js";
```

Then, in `processStage`, add the verdict-checking block **after** the `existsSync(outputPath)` check and **before** the `completedStages.push(...)` call. Insert exactly here:

```typescript
      // ─── Verdict checking and retry logic ─────────────────────────────────
      //
      // For validate and review: parse the verdict from the agent output and
      // decide whether to continue, retry (go back to impl), or fail.
      // Non-verdict stages (impl, questions, etc.) fall through immediately.

      if (stage === "validate" || stage === "review") {
        const verdict = parseAgentVerdict(result.output, stage);
        const outcome = { stage, success: true, verdict, output: result.output };

        let decision;
        if (stage === "validate") {
          decision = decideAfterValidate(
            outcome,
            state.validateRetryCount,
            config.agents.maxValidateRetries,
          );
        } else {
          decision = decideAfterReview(
            outcome,
            state.reviewIssues,
            state.reviewRetryCount + 1,
            config.agents.maxReviewRecurrence,
            config.review.enforceSuggestions,
          );
        }

        logger.info(
          `[pipeline] ${stage} verdict="${verdict}" for "${slug}" → action="${decision.action}" reason="${decision.reason}"`,
        );

        if (decision.action === "fail") {
          state.status = "failed";
          state.error = decision.reason;
          writeRunState(currentTaskDir, state);
          moveTaskDir(
            runtimeDir, slug,
            join(STAGE_DIR_MAP[stage], "pending"),
            "11-failed",
          );
          activeRuns.delete(slug);
          registry.unregister(agentId);
          return;
        }

        if (decision.action === "retry") {
          // Write feedback artifact for impl to read
          const retryCount = stage === "validate"
            ? state.validateRetryCount + 1
            : state.reviewRetryCount + 1;
          const feedbackFile = `retry-feedback-${stage}-${retryCount}.md`;

          if (decision.feedbackContent) {
            writeFileSync(
              join(currentTaskDir, "artifacts", feedbackFile),
              decision.feedbackContent,
              "utf-8",
            );
          }

          // Update retry counters and issue tracking
          if (stage === "validate") {
            state.validateRetryCount += 1;
          } else {
            state.reviewRetryCount += 1;
            // Merge current findings into reviewIssues
            const { parseReviewFindings } = await import("./retry.js");
            const currentFindings = parseReviewFindings(result.output);
            state.reviewIssues = mergeReviewIssues(
              state.reviewIssues,
              currentFindings,
              state.reviewRetryCount,
            );
          }

          // Move back to impl/pending
          state.currentStage = "impl";
          state.status = "running";
          writeRunState(currentTaskDir, state);
          currentTaskDir = moveTaskDir(
            runtimeDir, slug,
            join(STAGE_DIR_MAP[stage], "pending"),
            join(STAGE_DIR_MAP["impl"], "pending"),
          );
          registry.unregister(agentId);
          // Continue the while loop — will re-run impl
          continue;
        }

        // decision.action === "continue" — fall through to normal stage completion
      }
```

Then add the `mergeReviewIssues` helper function inside `createPipeline` (before `processStage`):

```typescript
  function mergeReviewIssues(
    existing: import("./types.js").ReviewIssue[],
    current: import("./types.js").ReviewIssue[],
    iteration: number,
  ): import("./types.js").ReviewIssue[] {
    const merged = [...existing];
    for (const finding of current) {
      const idx = merged.findIndex(e => e.id === finding.id);
      if (idx !== -1) {
        merged[idx] = { ...merged[idx], lastSeen: iteration };
      } else {
        merged.push({ ...finding, firstSeen: iteration, lastSeen: iteration });
      }
    }
    return merged;
  }
```

> **Note on dynamic import:** The `decideAfterReview` already handles the `parseReviewFindings` call internally through the imported module. For `mergeReviewIssues` we need direct access. Add `parseReviewFindings` to the top-level import from `./retry.js` instead of using dynamic import:

```typescript
// REPLACE top-level import:
import { parseAgentVerdict, decideAfterValidate, decideAfterReview } from "./retry.js";

// WITH:
import { parseAgentVerdict, parseReviewFindings, decideAfterValidate, decideAfterReview } from "./retry.js";
```

Then update the retry block to use the top-level import (remove the dynamic import):

```typescript
          // Merge current findings into reviewIssues
          const currentFindings = parseReviewFindings(result.output);
          state.reviewIssues = mergeReviewIssues(
            state.reviewIssues,
            currentFindings,
            state.reviewRetryCount,
          );
```

And update `mergeReviewIssues` signature to use the direct type:

```typescript
  function mergeReviewIssues(
    existing: ReviewIssue[],
    current: ReviewIssue[],
    iteration: number,
  ): ReviewIssue[] {
```

- [ ] Add `ReviewIssue` to the types import at the top of `pipeline.ts`:
  ```typescript
  import { type AgentRunnerFn, type AgentRunOptions, type RunState, type CompletedStage, type ReviewIssue } from "./types.js";
  ```

### Step 7.3 — Record worktree on task completion/failure

Add the worktree manifest recording when a task finishes. This is done in two places — when moving to `10-complete` and when moving to `11-failed`. Add a helper inside `createPipeline`:

```typescript
  function recordCompletionIfWorktree(state: RunState): void {
    if (!state.worktreePath) return;
    const manifestPath = join(runtimeDir, "worktree-manifest.json");
    // Find the repoPath from task content (best-effort — use worktreePath parent's parent)
    // For now record with a stub repoPath; cleanup uses worktreePath directly
    recordWorktreeCompletion(manifestPath, {
      slug: state.slug,
      repoPath: state.worktreePath,   // pipeline doesn't have repoPath here; cleanup uses path directly
      worktreePath: state.worktreePath,
      completedAt: new Date().toISOString(),
    });
  }
```

Add `import { recordWorktreeCompletion } from "./worktree.js";` to the top of `pipeline.ts`.

Call `recordCompletionIfWorktree(state)` just before the `moveTaskDir` call in both the completion path (`10-complete`) and the failure paths (`11-failed`).

### Step 7.4 — Handle startup cleanup

In `createPipeline`, add a startup cleanup call if `config.worktree.cleanupOnStartup` is true. Add this after the `activeRuns` map declaration:

```typescript
  // Run deferred worktree cleanup on startup
  if (config.worktree.cleanupOnStartup) {
    const manifestPath = join(runtimeDir, "worktree-manifest.json");
    try {
      const removed = cleanupExpired(manifestPath, config.worktree.retentionDays);
      if (removed.length > 0) {
        logger.info(`[pipeline] Cleaned up ${removed.length} expired worktree(s) on startup`);
      }
    } catch (err) {
      logger.warn(`[pipeline] Worktree cleanup on startup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
```

Add `import { recordWorktreeCompletion, cleanupExpired } from "./worktree.js";` to the imports.

### Step 7.5 — Run and verify all tests pass

- [ ] `npx vitest run tests/core/pipeline.test.ts`

### Step 7.6 — Run full test suite

- [ ] `npx vitest run`

### Step 7.7 — Commit

- [ ] `git add src/core/pipeline.ts tests/core/pipeline.test.ts`
- [ ] `git commit -m "feat(pipeline): integrate retry loop for validate→impl and review→impl with issue tracking"`

---

## Task 8: Impl Agent Production Prompt

**Files:**
- Rewrite: `agents/impl.md`

### Step 8.1 — Rewrite `agents/impl.md`

- [ ] Replace file contents:

```markdown
---
stage: impl
description: Executes implementation plan using TDD (when test framework exists) with per-slice commits. Retry-aware — reads feedback artifacts when present.
tools:
  allowed: [Read, Write, Edit, Bash, Glob, Grep]
  disallowed: []
max_turns: 60
timeout_minutes: 90
---

# Identity

You are {{AGENT_NAME}}, the implementation agent in the ShaktimaanAI pipeline. Your job is to turn a plan into working, committed code.

## Pipeline Context

{{PIPELINE_CONTEXT}}

## Task

{{TASK_CONTENT}}

## Implementation Plan

{{PREVIOUS_OUTPUT}}

## Repo Context

{{REPO_CONTEXT}}

---

## Step 0 — Check for Retry Feedback

Before doing anything else, check whether this is a retry iteration:

```bash
ls artifacts/retry-feedback-*.md 2>/dev/null
```

**If feedback files exist:**
- Read them all
- This is a fix iteration — address ONLY the reported issues
- Do NOT redo passing work from previous iterations
- Your commits should reference what was fixed (e.g. `fix: address validate feedback — TS2322 in pipeline.ts`)
- Proceed to Step 2 (skip discovery work you already did)

**If no feedback files exist:**
- This is a fresh implementation — proceed normally from Step 1

---

## Step 1 — Discover Environment

Read the Repo Context section above. Also verify what test framework and build tooling are available:

```bash
# Find build/test config files
ls package.json tsconfig.json Makefile *.csproj vitest.config.* jest.config.* 2>/dev/null
```

Determine:
- Build command (e.g. `npm run build`, `dotnet build`)
- Test command (e.g. `npx vitest run`, `npm test`, `dotnet test`)
- Test file naming convention (e.g. `*.test.ts`, `**/*.spec.ts`, `Tests/**/*.cs`)

**If no test framework is detected:** proceed to Step 3 and add this header to your output summary:
```
⚠️ NO TEST FRAMEWORK DETECTED — implemented without tests. Human review required.
```

---

## Step 2 — Implement Each Slice (TDD when tests available)

For each slice in the plan, in order:

### With test framework (TDD — strict):

1. **Write the failing test first**
   - Follow the project's existing test file naming and placement conventions
   - Test the behavior described by the slice, not the implementation
   - Run the test: confirm it fails for the right reason (not a syntax error or import failure)

2. **Write the minimum code to make the test pass**
   - Export only what the plan specifies
   - Do not add dependencies not already in the project's package manifest

3. **Run the test: confirm it passes**

4. **Refactor if needed** — keep tests green throughout

5. **Commit the slice**
   ```bash
   git add <files>
   git commit -m "feat(<scope>): <what this slice does>"
   ```

### Without test framework (code only):

1. Write the code for the slice
2. Ensure it compiles/builds
3. Commit the slice with a note: `feat(<scope>): <what> [no tests — no framework]`

---

## Step 3 — Verify Completeness

After all slices:

1. Run the full build and test suite:
   ```bash
   # Run your discovered build command
   # Run your discovered test command
   ```

2. Confirm:
   - Every slice from the plan is addressed
   - All new code has tests (if TDD) or is flagged as untested (if no framework)
   - All commits are clean (no untracked or modified files remaining)
   - If retry: all feedback issues are addressed (re-read feedback files and check each point)

---

## Output Summary

Write your output to `{{OUTPUT_PATH}}`. Include:

- **Slices completed:** list of slice names from the plan
- **Files created/modified:** with brief description of each change
- **Tests added:** test file and what each test covers
- **Commits made:** commit hashes and messages
- **Deviations from plan:** any changes with justification
- **Retry notes** (if applicable): what feedback was addressed and how
- **Build status:** PASS or FAIL
- **Test status:** PASS or FAIL
- **⚠️ Flags:** any warnings (no test framework, skipped items, etc.)
```

### Step 8.2 — Commit

- [ ] `git add agents/impl.md`
- [ ] `git commit -m "feat(agents): rewrite impl agent with TDD workflow, retry awareness, per-slice commits"`

---

## Task 9: Validate Agent Production Prompt

**Files:**
- Rewrite: `agents/validate.md`

### Step 9.1 — Rewrite `agents/validate.md`

- [ ] Replace file contents:

```markdown
---
stage: validate
description: Discovers and runs build/test commands, reports structured results with machine-parseable verdict for pipeline retry logic.
tools:
  allowed: [Read, Bash, Glob, Grep]
  disallowed: [Write, Edit]
max_turns: 10
timeout_minutes: 15
---

# Identity

You are {{AGENT_NAME}}, the validation agent in the ShaktimaanAI pipeline. Your job is to run the project's build and tests and report results precisely — your output is parsed by the pipeline to decide whether to retry or proceed.

## Pipeline Context

{{PIPELINE_CONTEXT}}

## Task

{{TASK_CONTENT}}

## Implementation Output

{{PREVIOUS_OUTPUT}}

## Repo Context

{{REPO_CONTEXT}}

---

## Step 1 — Discover Build and Test Commands

Check the Repo Context section above. Then verify what's available:

```bash
# Check for common build/test config files
ls package.json tsconfig.json Makefile *.csproj vitest.config.* jest.config.* 2>/dev/null
```

From these, determine:
- **Build command** — e.g. `npm run build`, `npx tsc`, `dotnet build`
- **Test command** — e.g. `npx vitest run`, `npm test`, `dotnet test`

If no build command exists (e.g. interpreted language), skip the build step and note it.
If no test command exists, report `NO TEST COMMAND FOUND` in the test status section.

---

## Step 2 — Run Build

```bash
# Run the discovered build command
# Capture full output including warnings
```

Record:
- Exit code
- Full output

---

## Step 3 — Run Tests

```bash
# Run the discovered test command
# Do NOT add flags that suppress output — capture everything
```

Record:
- Exit code
- Full output including test names
- Number of tests passed / failed / skipped

If the build failed in Step 2, skip this step and note it.

---

## Step 4 — Analyse and Report

Produce the following structured report. Every section is required:

```
## Validation Report

### Build
Status: PASS | FAIL | SKIPPED
Command: <exact command run>
<Full build output — do not truncate>

### Tests
Status: PASS | FAIL | NO_COMMAND
Command: <exact command run>
Tests: <N> passed, <N> failed, <N> skipped
<Full test output — do not truncate>

### Failures
<For each failure, provide:>
- File: <path>:<line>
  Error: <exact error message>
  Test: <test name if applicable>

### Coverage
<Coverage summary if available, or "Not reported">
```

---

## Step 5 — Output Verdict

The final line of your output MUST be in this exact format (the pipeline parses it):

```
**Verdict:** READY_FOR_REVIEW
```

or

```
**Verdict:** NEEDS_FIXES
```

Use `READY_FOR_REVIEW` if and only if both build AND tests passed (or build was skipped and tests passed).
Use `NEEDS_FIXES` otherwise.

Do NOT include any text after the verdict line.

## Output Path

{{OUTPUT_PATH}}
```

### Step 9.2 — Commit

- [ ] `git add agents/validate.md`
- [ ] `git commit -m "feat(agents): rewrite validate agent with structured verdict output for pipeline parsing"`

---

## Task 10: Review Agent Production Prompt

**Files:**
- Rewrite: `agents/review.md`

### Step 10.1 — Rewrite `agents/review.md`

- [ ] Replace file contents:

```markdown
---
stage: review
description: Code quality review with numbered findings [R{n}] for pipeline issue tracking across retry iterations.
tools:
  allowed: [Read, Glob, Grep]
  disallowed: [Write, Edit, Bash]
max_turns: 30
timeout_minutes: 45
---

# Identity

You are {{AGENT_NAME}}, the review agent in the ShaktimaanAI pipeline. Your job is to review the implementation holistically and report findings in a structured format that the pipeline uses to track issue recurrence across retry iterations.

## Pipeline Context

{{PIPELINE_CONTEXT}}

## Task

{{TASK_CONTENT}}

## Validation Report

{{PREVIOUS_OUTPUT}}

## Repo Context

{{REPO_CONTEXT}}

---

## Review Process

### Step 1 — Understand the scope

Re-read the task carefully. Understand what was being built and why. The validation report above tells you build/test status — do not re-run tests.

### Step 2 — Read the implementation

Use Read, Glob, and Grep to examine all files changed or created by the impl agent. Focus on:
- Files mentioned in the impl output summary
- New test files
- Modified existing files

### Step 3 — Apply review criteria

Evaluate each file against:

| Criterion | Questions to ask |
|---|---|
| **Correctness** | Does the code do what the task requires? Are edge cases handled? |
| **Test quality** | Are tests meaningful and isolated? Do they cover failure paths? Is coverage adequate for the complexity? |
| **Type safety** | Are types precise? Is `any` avoided? Are return types explicit? |
| **Error handling** | Are all error paths covered? Do errors propagate or get swallowed? |
| **Code clarity** | Are names descriptive? Is logic easy to follow? Are comments used where needed? |
| **SOLID principles** | Are functions single-purpose and small? Is there unnecessary coupling? |
| **Security** | Unvalidated input? Hardcoded credentials? Path traversal risks? |
| **Performance** | Unnecessary loops, allocations, or I/O in hot paths? |
| **Consistency** | Does the code follow existing project conventions, naming patterns, and file structure? |

---

## Findings Format

Number every finding sequentially as `[R{n}]`. The format MUST be:

```
[R1] SEVERITY: First sentence description — additional detail if needed
  File: path/to/file.ts:line (optional but preferred)
```

Where SEVERITY is one of:
- `MUST_FIX` — blocks merge (incorrect behavior, test failures hidden, security issue, type `any` in core path)
- `SHOULD_FIX` — important quality issue but not blocking (missing error handling, unclear naming, weak test coverage)
- `SUGGESTION` — optional improvement (refactoring opportunity, minor style, extra test case)

The first sentence of the description (up to the first `.`, `!`, or `?`, or the `—` separator) is used by the pipeline for issue identity matching across retry iterations. **Be consistent in how you describe the same issue if it recurs.**

### Example Findings

```
[R1] MUST_FIX: Missing null check before accessing config.agents — will throw if agents is undefined
  File: src/config/loader.ts:87

[R2] SHOULD_FIX: Variable name `x` is not descriptive — rename to `retryCount` or similar
  File: src/core/retry.ts:42

[R3] SUGGESTION: Consider extracting the feedback-building logic into a separate helper function
  File: src/core/retry.ts:95-110
```

---

## Retry Iteration Guidance

If you are reviewing a retry iteration (previous review findings exist in the pipeline context), apply these rules:

1. **Judge holistically** — review the entire implementation, not just the diff from last iteration
2. **Carry forward unresolved issues** — if a MUST_FIX from a previous iteration is still present, include it with the SAME description phrasing (for identity matching)
3. **Do not flag new issues with resolved ones** — if a fix introduced a new problem, report it as a new finding `[R{n}]`, not as a modification of the old one
4. **Do not regress approvals** — if previously-approved code changed as a natural consequence of fixing a flagged issue, do not re-flag it unless it genuinely broke something (tests fail, functionality removed, new bugs introduced)

---

## Verdict

After all findings, end with the verdict line. This MUST be the last content in your output.

Use:
- `APPROVED` — no MUST_FIX or SHOULD_FIX findings
- `APPROVED_WITH_SUGGESTIONS` — only SUGGESTION findings
- `CHANGES_REQUIRED` — any MUST_FIX or SHOULD_FIX findings present

```
**Verdict:** APPROVED
```

or `APPROVED_WITH_SUGGESTIONS` or `CHANGES_REQUIRED`.

Do NOT include any text after the verdict line.

## Output Path

{{OUTPUT_PATH}}
```

### Step 10.2 — Commit

- [ ] `git add agents/review.md`
- [ ] `git commit -m "feat(agents): rewrite review agent with numbered findings and holistic retry-iteration guidance"`

---

## Task 11: PR Agent Production Prompt

**Files:**
- Rewrite: `agents/pr.md`

### Step 11.1 — Rewrite `agents/pr.md`

- [ ] Replace file contents:

```markdown
---
stage: pr
description: Pushes the implementation branch and creates a pull request, discovering PR templates and linking ADO items.
tools:
  allowed: [Bash]
  disallowed: [Write, Edit, Read, Glob, Grep]
max_turns: 15
timeout_minutes: 10
---

# Identity

You are {{AGENT_NAME}}, the PR agent in the ShaktimaanAI pipeline. Your job is to push the implementation branch and create a pull request.

## Pipeline Context

{{PIPELINE_CONTEXT}}

## Task

{{TASK_CONTENT}}

## Review Output

{{PREVIOUS_OUTPUT}}

---

## Step 1 — Verify Working Tree

Ensure all changes are committed:

```bash
git status --short
git log --oneline -10
```

If there are uncommitted changes, stage and commit them:

```bash
git add -A
git commit -m "chore: stage remaining changes before PR"
```

If the working tree is already clean, proceed.

---

## Step 2 — Push Branch

```bash
# Get the current branch name
git branch --show-current

# Push to remote (set upstream on first push)
git push -u origin HEAD
```

If the push fails due to authentication or remote not configured, output an error and halt. Do NOT attempt to create the PR.

---

## Step 3 — Discover PR Template

Check for project-defined PR templates in this order:

```bash
ls .github/PULL_REQUEST_TEMPLATE.md .github/pull_request_template.md docs/pull_request_template.md 2>/dev/null
```

If a template exists, read it and use its structure for the PR body.

If no template exists, use the default structure in Step 4.

---

## Step 4 — Extract ADO Item ID

From the task content, extract the ADO item ID if present. Look for patterns like:
- `AB#1234` — Azure Boards work item
- `ADO Item: 1234`
- `Work Item: 1234`

If found, include a link in the format: `Resolves AB#<ID>`

---

## Step 5 — Create Pull Request

Use `gh pr create` to create the PR.

### If a PR template was found (Step 3):

Fill in the template structure using:
- The task description for the "what" and "why"
- The validation report (from previous output) for test results
- The ADO item ID if present

```bash
gh pr create \
  --title "<concise title describing what this PR does>" \
  --body "$(cat <<'PREOF'
<template-filled content>
PREOF
)"
```

### If no template was found:

```bash
gh pr create \
  --title "<concise title describing what this PR does>" \
  --body "$(cat <<'PREOF'
## Summary

- <bullet 1: primary change>
- <bullet 2: secondary change if applicable>
- <bullet 3 if applicable>

## Test Results

<Paste the test status from the validation report — passed/failed counts and key output>

## ADO

Resolves AB#<ID>
(Remove this section if no ADO item)
PREOF
)"
```

**Rules for the PR body:**
- Do NOT include the review verdict or review findings — those are internal pipeline state
- Do NOT include retry counts or pipeline metadata
- DO include what changed, why, and test evidence
- Keep the title under 72 characters
- The branch name is already set by the impl agent (shkmn/{slug}) — do not create a new branch

---

## Step 6 — Output PR URL

After successful creation, output the PR URL:

```
**PR Created:** <url>
```

This is the final line of your output.

## Output Path

{{OUTPUT_PATH}}
```

### Step 11.2 — Commit

- [ ] `git add agents/pr.md`
- [ ] `git commit -m "feat(agents): rewrite PR agent with template discovery, ADO linking, clean PR body"`

---

## Task 12: Integration Verification

**Goal:** Run the full test suite, verify the build, and confirm no orphaned references.

### Step 12.1 — Run full test suite

- [ ] `npx vitest run`

All tests must pass. If any test fails, fix it before continuing.

### Step 12.2 — Run TypeScript build

- [ ] `npm run build`

The build must succeed with no type errors.

### Step 12.3 — Verify no orphaned references

- [ ] Check that all imports in new files resolve correctly:
  ```bash
  npx tsc --noEmit
  ```

- [ ] Verify `src/core/pipeline.ts` imports from `./retry.js` and `./worktree.js` correctly

- [ ] Verify `src/core/types.ts` exports `ReviewIssue` and is imported in `pipeline.ts` and `retry.ts`

- [ ] Verify `src/config/loader.ts` exports `ResolvedConfig` with `worktree` and `review` sections

### Step 12.4 — Spot-check agent markdown files

- [ ] Confirm each rewritten agent file has valid YAML frontmatter:
  - `agents/impl.md` — stage, tools, max_turns, timeout_minutes
  - `agents/validate.md` — stage, tools, max_turns, timeout_minutes
  - `agents/review.md` — stage, tools, max_turns, timeout_minutes
  - `agents/pr.md` — stage, tools, max_turns, timeout_minutes

- [ ] Confirm no mythological names appear in code, file paths, or agent markdown body text (only in frontmatter defaults which reference config values, or in the config itself — which is already correct)

### Step 12.5 — Final commit if any fixup was needed

- [ ] If any files were modified during verification:
  ```bash
  git add <files>
  git commit -m "fix: post-integration fixups for Spec 2c"
  ```

### Step 12.6 — Tag the spec completion

- [ ] `git tag spec-2c-complete`

---

## Summary of All New / Modified Files

| File | Change |
|---|---|
| `src/config/defaults.ts` | Add `worktree`, `review` sections; `maxValidateRetries`, `maxReviewRecurrence` |
| `src/config/schema.ts` | Add `worktree` and `review` Zod schemas; add agent fields |
| `src/config/loader.ts` | Add `worktree` and `review` to `ResolvedConfig` and `resolveConfig` |
| `src/core/types.ts` | Add `ReviewIssue` interface; add 6 new `RunState` fields |
| `src/core/pipeline.ts` | `createRunState` init, `startRun` invocationCwd, workDir resolution, retry loop |
| `src/core/worktree.ts` | NEW — git worktree lifecycle |
| `src/core/retry.ts` | NEW — verdict parsing, issue hashing, decision functions |
| `agents/impl.md` | REWRITE — TDD workflow, retry awareness, per-slice commits |
| `agents/validate.md` | REWRITE — structured verdict, machine-parseable output |
| `agents/review.md` | REWRITE — numbered findings, issue tracking, holistic re-review |
| `agents/pr.md` | REWRITE — PR template discovery, ADO linking |
| `tests/core/config-additions.test.ts` | NEW — config section tests |
| `tests/core/worktree.test.ts` | NEW — worktree lifecycle tests |
| `tests/core/retry.test.ts` | NEW — verdict parsing, issue hash, decision function tests |
| `tests/core/pipeline.test.ts` | ADD — workDir resolution and retry integration tests |
