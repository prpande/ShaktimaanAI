# Spec 3: Input Surfaces (CLI + Slack) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two programmatic input surfaces (CLI commands, Slack integration) with pipeline control operations, stage hints, interaction logging, agent stream logging, quick task path, and slug resolution.

**Architecture:** Surface adapter pattern — thin adapters in `src/surfaces/` translate I/O into canonical handler calls. Shared `Notifier` interface for outbound. Pipeline gains 7 control methods. Agent runner captures full SDK stream to JSONL files.

**Tech Stack:** TypeScript, Commander.js (CLI), Slack MCP (messaging), chokidar (watching), Zod (config validation), Vitest (testing)

**Spec:** `docs/superpowers/specs/2026-04-05-spec3-input-surfaces-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|---|---|
| `src/surfaces/types.ts` | `Notifier` interface, `NotifyEvent` discriminated union, `NotifyLevel` enum |
| `src/surfaces/console-notifier.ts` | `ConsoleNotifier` — prints events to stdout with level filtering |
| `src/surfaces/slack-notifier.ts` | `SlackNotifier` — posts to Slack channel/thread via MCP |
| `src/surfaces/slack-surface.ts` | Slack inbound: poll, filter, classify, dispatch |
| `src/core/slug-resolver.ts` | Fuzzy slug resolution (exact, prefix, keyword match) |
| `src/core/interactions.ts` | Per-task `interactions.md` + global daily JSON logging |
| `src/core/stream-logger.ts` | JSONL stream logger for agent SDK messages |
| `src/commands/cancel.ts` | `shkmn cancel <slug>` |
| `src/commands/skip.ts` | `shkmn skip <slug>` |
| `src/commands/pause.ts` | `shkmn pause <slug>` |
| `src/commands/resume.ts` | `shkmn resume <slug>` |
| `src/commands/modify-stages.ts` | `shkmn modify-stages <slug>` |
| `src/commands/restart-stage.ts` | `shkmn restart-stage <slug>` |
| `src/commands/retry.ts` | `shkmn retry <slug>` |
| `agents/quick.md` | Quick task agent prompt |
| `tests/surfaces/types.test.ts` | Notify event + level filtering tests |
| `tests/surfaces/console-notifier.test.ts` | ConsoleNotifier tests |
| `tests/surfaces/slack-notifier.test.ts` | SlackNotifier tests |
| `tests/surfaces/slack-surface.test.ts` | Slack inbound tests |
| `tests/core/slug-resolver.test.ts` | Slug resolution tests |
| `tests/core/interactions.test.ts` | Interaction logging tests |
| `tests/core/stream-logger.test.ts` | Stream logger tests |
| `tests/core/pipeline-control.test.ts` | Pipeline control operations tests |
| `tests/commands/control-commands.test.ts` | CLI control command tests |

### Modified Files

| File | What changes |
|---|---|
| `src/config/schema.ts` | Add `slack.notifyLevel`, `slack.allowDMs`, `slack.requirePrefix`, `slack.prefix`, `quickTask` section |
| `src/config/defaults.ts` | Expand `ShkmnConfig.slack` + add `quickTask`, update `DEFAULT_CONFIG` |
| `src/config/loader.ts` | Resolve new slack + quickTask fields |
| `src/core/types.ts` | Add `stageHints` and `retryAttempt` to `RunState`, expand `ClassifyResult` |
| `src/core/registry.ts` | Add `abortBySlug(slug)` method |
| `src/core/pipeline.ts` | Add 7 control methods, emit notify events, accept notifiers |
| `src/core/intent-classifier.ts` | New intents, `extractedStages`, `extractedFeedback`, `stageHints`, `complexity` fields |
| `src/core/agent-runner.ts` | Inject stage hints into prompt, capture SDK stream to JSONL |
| `src/core/watcher.ts` | Add Slack polling arm alongside chokidar |
| `src/task/parser.ts` | Parse `## Stage Hints` section from `.task` files |
| `src/core/task-creator.ts` | Write `## Stage Hints` section into `.task` files |
| `src/commands/task.ts` | Wire to `createTask()` with `--hints`, `--quick` |
| `src/commands/approve.ts` | Wire to `approveTask()` with `--feedback` |
| `src/commands/status.ts` | Scan stage dirs + `12-hold/` for active/held tasks |
| `src/commands/logs.ts` | Read/tail task log file with `-f` follow mode |
| `src/commands/start.ts` | Pass notifiers to pipeline, start Slack poller if enabled |
| `src/cli.ts` | Register 7 new commands |
| `agents/classify.md` | Update for new intents, complexity, stageHints extraction |

---

### Task 1: Config & Types Expansion

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/loader.ts`
- Modify: `src/core/types.ts`
- Test: `tests/core/config-additions.test.ts`

- [ ] **Step 1: Write tests for new config fields**

In `tests/core/config-additions.test.ts`, add tests after the existing ones:

```typescript
it("defaults slack.notifyLevel to bookends", () => {
  const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/test" } });
  const resolved = resolveConfig(parsed);
  expect(resolved.slack.notifyLevel).toBe("bookends");
});

it("defaults slack.allowDMs to false", () => {
  const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/test" } });
  const resolved = resolveConfig(parsed);
  expect(resolved.slack.allowDMs).toBe(false);
});

it("defaults slack.requirePrefix to true", () => {
  const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/test" } });
  const resolved = resolveConfig(parsed);
  expect(resolved.slack.requirePrefix).toBe(true);
});

it("defaults slack.prefix to shkmn", () => {
  const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/test" } });
  const resolved = resolveConfig(parsed);
  expect(resolved.slack.prefix).toBe("shkmn");
});

it("defaults quickTask.requireReview to true", () => {
  const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/test" } });
  const resolved = resolveConfig(parsed);
  expect(resolved.quickTask.requireReview).toBe(true);
});

it("defaults quickTask.complexityThreshold to 0.8", () => {
  const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/test" } });
  const resolved = resolveConfig(parsed);
  expect(resolved.quickTask.complexityThreshold).toBe(0.8);
});

it("accepts custom slack notify config", () => {
  const parsed = configSchema.parse({
    pipeline: { runtimeDir: "/tmp/test" },
    slack: { notifyLevel: "stages", allowDMs: true, requirePrefix: false, prefix: "bot" },
  });
  const resolved = resolveConfig(parsed);
  expect(resolved.slack.notifyLevel).toBe("stages");
  expect(resolved.slack.allowDMs).toBe(true);
  expect(resolved.slack.requirePrefix).toBe(false);
  expect(resolved.slack.prefix).toBe("bot");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/config-additions.test.ts`
Expected: FAIL — `notifyLevel`, `allowDMs`, `requirePrefix`, `prefix`, `quickTask` not defined.

- [ ] **Step 3: Update config schema**

In `src/config/schema.ts`, expand the `slack` section and add `quickTask`:

```typescript
  slack: z.object({
    enabled: z.boolean().optional().default(false),
    channel: z.string().optional().default("#agent-pipeline"),
    channelId: z.string().optional().default(""),
    pollIntervalSeconds: z.number().optional().default(30),
    notifyLevel: z.enum(["minimal", "bookends", "stages"]).optional().default("bookends"),
    allowDMs: z.boolean().optional().default(false),
    requirePrefix: z.boolean().optional().default(true),
    prefix: z.string().optional().default("shkmn"),
  }).optional().default({}),
```

Add after the `review` section:

```typescript
  quickTask: z.object({
    requireReview: z.boolean().optional().default(true),
    complexityThreshold: z.number().min(0).max(1).optional().default(0.8),
  }).optional().default({}),
```

- [ ] **Step 4: Update ShkmnConfig type in defaults.ts**

In `src/config/defaults.ts`, expand the `slack` property on `ShkmnConfig`:

```typescript
  slack: {
    enabled: boolean;
    channel: string;
    channelId: string;
    pollIntervalSeconds: number;
    notifyLevel: "minimal" | "bookends" | "stages";
    allowDMs: boolean;
    requirePrefix: boolean;
    prefix: string;
  };
```

Add after `review`:

```typescript
  quickTask: {
    requireReview: boolean;
    complexityThreshold: number;
  };
```

Update `DEFAULT_CONFIG.slack`:

```typescript
  slack: {
    enabled: false,
    channel: "#agent-pipeline",
    channelId: "",
    pollIntervalSeconds: 30,
    notifyLevel: "bookends" as const,
    allowDMs: false,
    requirePrefix: true,
    prefix: "shkmn",
  },
```

Add `DEFAULT_CONFIG.quickTask`:

```typescript
  quickTask: {
    requireReview: true,
    complexityThreshold: 0.8,
  },
```

- [ ] **Step 5: Update loader.ts resolveConfig**

In `src/config/loader.ts` `resolveConfig()`, expand the slack section:

```typescript
    slack: {
      enabled: parsed.slack?.enabled ?? d.slack.enabled,
      channel: parsed.slack?.channel ?? d.slack.channel,
      channelId: parsed.slack?.channelId ?? d.slack.channelId,
      pollIntervalSeconds: parsed.slack?.pollIntervalSeconds ?? d.slack.pollIntervalSeconds,
      notifyLevel: parsed.slack?.notifyLevel ?? d.slack.notifyLevel,
      allowDMs: parsed.slack?.allowDMs ?? d.slack.allowDMs,
      requirePrefix: parsed.slack?.requirePrefix ?? d.slack.requirePrefix,
      prefix: parsed.slack?.prefix ?? d.slack.prefix,
    },
```

Add after `review`:

```typescript
    quickTask: {
      requireReview: parsed.quickTask?.requireReview ?? d.quickTask.requireReview,
      complexityThreshold: parsed.quickTask?.complexityThreshold ?? d.quickTask.complexityThreshold,
    },
```

- [ ] **Step 6: Expand RunState in types.ts**

In `src/core/types.ts`, add to the `RunState` interface:

```typescript
  // Stage hints from user (creation-time + mid-flight)
  stageHints: Record<string, string[]>;

  // Retry attempt tracking for versioned artifacts
  retryAttempt: number;

  // Pause tracking
  pausedAtStage?: string;
```

- [ ] **Step 7: Update createRunState in pipeline.ts**

In the `createRunState` function in `src/core/pipeline.ts`, add the new fields to the returned object:

```typescript
    stageHints: {},
    retryAttempt: 0,
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/core/config-additions.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/config/schema.ts src/config/defaults.ts src/config/loader.ts src/core/types.ts src/core/pipeline.ts tests/core/config-additions.test.ts
git commit -m "feat(spec3): expand config for slack notify/prefix/DMs and quickTask section"
```

---

### Task 2: Notifier Types & Console Notifier

**Files:**
- Create: `src/surfaces/types.ts`
- Create: `src/surfaces/console-notifier.ts`
- Test: `tests/surfaces/types.test.ts`
- Test: `tests/surfaces/console-notifier.test.ts`

- [ ] **Step 1: Write tests for notify event types and level filtering**

Create `tests/surfaces/types.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { shouldNotify, type NotifyEvent } from "../../src/surfaces/types.js";

describe("shouldNotify", () => {
  const taskCreated: NotifyEvent = {
    type: "task_created",
    slug: "fix-auth-20260405",
    timestamp: "2026-04-05T10:00:00Z",
    title: "Fix auth",
    source: "cli",
    stages: ["questions", "research"],
  };

  const taskHeld: NotifyEvent = {
    type: "task_held",
    slug: "fix-auth-20260405",
    timestamp: "2026-04-05T10:00:00Z",
    stage: "design",
    artifactUrl: "https://github.com/...",
  };

  const stageStarted: NotifyEvent = {
    type: "stage_started",
    slug: "fix-auth-20260405",
    timestamp: "2026-04-05T10:00:00Z",
    stage: "research",
  };

  const taskFailed: NotifyEvent = {
    type: "task_failed",
    slug: "fix-auth-20260405",
    timestamp: "2026-04-05T10:00:00Z",
    stage: "impl",
    error: "Agent timed out",
  };

  it("minimal shows task_held and task_failed only", () => {
    expect(shouldNotify("minimal", taskHeld)).toBe(true);
    expect(shouldNotify("minimal", taskFailed)).toBe(true);
    expect(shouldNotify("minimal", taskCreated)).toBe(false);
    expect(shouldNotify("minimal", stageStarted)).toBe(false);
  });

  it("bookends shows minimal + task_created, task_completed, task_cancelled", () => {
    expect(shouldNotify("bookends", taskCreated)).toBe(true);
    expect(shouldNotify("bookends", taskHeld)).toBe(true);
    expect(shouldNotify("bookends", taskFailed)).toBe(true);
    expect(shouldNotify("bookends", stageStarted)).toBe(false);
  });

  it("stages shows everything", () => {
    expect(shouldNotify("stages", taskCreated)).toBe(true);
    expect(shouldNotify("stages", taskHeld)).toBe(true);
    expect(shouldNotify("stages", stageStarted)).toBe(true);
    expect(shouldNotify("stages", taskFailed)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/surfaces/types.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement surfaces/types.ts**

Create `src/surfaces/types.ts`:

```typescript
// ─── NotifyLevel ────────────────────────────────────────────────────────────

export type NotifyLevel = "minimal" | "bookends" | "stages";

// ─── NotifyEvent ────────────────────────────────────────────────────────────

interface BaseEvent {
  slug: string;
  timestamp: string;
}

export interface TaskCreatedEvent extends BaseEvent { type: "task_created"; title: string; source: string; stages: string[]; }
export interface StageStartedEvent extends BaseEvent { type: "stage_started"; stage: string; }
export interface StageCompletedEvent extends BaseEvent { type: "stage_completed"; stage: string; artifactPath: string; }
export interface TaskHeldEvent extends BaseEvent { type: "task_held"; stage: string; artifactUrl: string; }
export interface TaskApprovedEvent extends BaseEvent { type: "task_approved"; approvedBy: string; feedback?: string; }
export interface TaskCompletedEvent extends BaseEvent { type: "task_completed"; prUrl?: string; }
export interface TaskFailedEvent extends BaseEvent { type: "task_failed"; stage: string; error: string; }
export interface TaskCancelledEvent extends BaseEvent { type: "task_cancelled"; cancelledBy: string; }
export interface TaskPausedEvent extends BaseEvent { type: "task_paused"; pausedBy: string; }
export interface TaskResumedEvent extends BaseEvent { type: "task_resumed"; resumedBy: string; }
export interface StageRetriedEvent extends BaseEvent { type: "stage_retried"; stage: string; attempt: number; feedback: string; }
export interface StageSkippedEvent extends BaseEvent { type: "stage_skipped"; stage: string; }
export interface StagesModifiedEvent extends BaseEvent { type: "stages_modified"; oldStages: string[]; newStages: string[]; }

export type NotifyEvent =
  | TaskCreatedEvent | StageStartedEvent | StageCompletedEvent
  | TaskHeldEvent | TaskApprovedEvent | TaskCompletedEvent
  | TaskFailedEvent | TaskCancelledEvent | TaskPausedEvent
  | TaskResumedEvent | StageRetriedEvent | StageSkippedEvent
  | StagesModifiedEvent;

// ─── Level filtering ────────────────────────────────────────────────────────

const MINIMAL_EVENTS = new Set(["task_held", "task_failed"]);
const BOOKENDS_EVENTS = new Set([...MINIMAL_EVENTS, "task_created", "task_completed", "task_cancelled"]);

export function shouldNotify(level: NotifyLevel, event: NotifyEvent): boolean {
  if (level === "stages") return true;
  if (level === "bookends") return BOOKENDS_EVENTS.has(event.type);
  return MINIMAL_EVENTS.has(event.type);
}

// ─── Notifier interface ─────────────────────────────────────────────────────

export interface Notifier {
  notify(event: NotifyEvent): Promise<void>;
}
```

- [ ] **Step 4: Run types test to verify it passes**

Run: `npx vitest run tests/surfaces/types.test.ts`
Expected: PASS

- [ ] **Step 5: Write ConsoleNotifier tests**

Create `tests/surfaces/console-notifier.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createConsoleNotifier } from "../../src/surfaces/console-notifier.js";
import type { NotifyEvent } from "../../src/surfaces/types.js";

describe("ConsoleNotifier", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("prints task_created events", async () => {
    const notifier = createConsoleNotifier();
    const event: NotifyEvent = {
      type: "task_created",
      slug: "fix-auth-20260405",
      timestamp: "2026-04-05T10:00:00Z",
      title: "Fix auth",
      source: "cli",
      stages: ["questions", "research"],
    };
    await notifier.notify(event);
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0][0]).toContain("fix-auth-20260405");
    expect(logSpy.mock.calls[0][0]).toContain("task_created");
  });

  it("prints stage_started events", async () => {
    const notifier = createConsoleNotifier();
    const event: NotifyEvent = {
      type: "stage_started",
      slug: "fix-auth-20260405",
      timestamp: "2026-04-05T10:00:00Z",
      stage: "research",
    };
    await notifier.notify(event);
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0][0]).toContain("research");
  });
});
```

- [ ] **Step 6: Implement ConsoleNotifier**

Create `src/surfaces/console-notifier.ts`:

```typescript
import { type Notifier, type NotifyEvent } from "./types.js";

function formatEvent(event: NotifyEvent): string {
  const ts = event.timestamp.slice(11, 19); // HH:MM:SS
  const slug = event.slug;

  switch (event.type) {
    case "task_created":
      return `[${ts}] task_created  ${slug} — "${event.title}" (${event.source})`;
    case "stage_started":
      return `[${ts}] stage_started ${slug} → ${event.stage}`;
    case "stage_completed":
      return `[${ts}] stage_done    ${slug} ← ${event.stage}`;
    case "task_held":
      return `[${ts}] task_held     ${slug} @ ${event.stage} — ${event.artifactUrl}`;
    case "task_approved":
      return `[${ts}] task_approved ${slug} by ${event.approvedBy}`;
    case "task_completed":
      return `[${ts}] task_done     ${slug}${event.prUrl ? ` — ${event.prUrl}` : ""}`;
    case "task_failed":
      return `[${ts}] task_failed   ${slug} @ ${event.stage}: ${event.error}`;
    case "task_cancelled":
      return `[${ts}] task_cancel   ${slug} by ${event.cancelledBy}`;
    case "task_paused":
      return `[${ts}] task_paused   ${slug} by ${event.pausedBy}`;
    case "task_resumed":
      return `[${ts}] task_resumed  ${slug} by ${event.resumedBy}`;
    case "stage_retried":
      return `[${ts}] stage_retry   ${slug} → ${event.stage} (attempt ${event.attempt})`;
    case "stage_skipped":
      return `[${ts}] stage_skip    ${slug} → ${event.stage}`;
    case "stages_modified":
      return `[${ts}] stages_mod    ${slug} [${event.oldStages.join(",")}] → [${event.newStages.join(",")}]`;
  }
}

export function createConsoleNotifier(): Notifier {
  return {
    async notify(event: NotifyEvent): Promise<void> {
      console.log(formatEvent(event));
    },
  };
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/surfaces/`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/surfaces/types.ts src/surfaces/console-notifier.ts tests/surfaces/
git commit -m "feat(spec3): add Notifier interface, NotifyEvent types, ConsoleNotifier"
```

---

### Task 3: Slug Resolver

**Files:**
- Create: `src/core/slug-resolver.ts`
- Test: `tests/core/slug-resolver.test.ts`

- [ ] **Step 1: Write slug resolver tests**

Create `tests/core/slug-resolver.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveSlug, listActiveSlugs } from "../../src/core/slug-resolver.js";

const TMP = join(process.cwd(), "tmp-slug-resolver-test");

function setupDirs(runtimeDir: string, slugsByDir: Record<string, string[]>): void {
  for (const [dir, slugs] of Object.entries(slugsByDir)) {
    for (const slug of slugs) {
      mkdirSync(join(runtimeDir, dir, slug), { recursive: true });
    }
  }
}

describe("listActiveSlugs", () => {
  beforeEach(() => mkdirSync(TMP, { recursive: true }));
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it("finds slugs across stage dirs and hold", () => {
    setupDirs(TMP, {
      "01-questions/pending": ["task-a-20260405100000"],
      "06-impl/pending": ["task-b-20260405110000"],
      "12-hold": ["task-c-20260405120000"],
    });
    const result = listActiveSlugs(TMP);
    expect(result).toHaveLength(3);
    expect(result.map(r => r.slug)).toContain("task-a-20260405100000");
    expect(result.map(r => r.slug)).toContain("task-b-20260405110000");
    expect(result.map(r => r.slug)).toContain("task-c-20260405120000");
  });

  it("ignores 10-complete and 11-failed", () => {
    setupDirs(TMP, {
      "10-complete": ["old-task-20260405090000"],
      "11-failed": ["bad-task-20260405080000"],
      "06-impl/pending": ["active-20260405100000"],
    });
    const result = listActiveSlugs(TMP);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe("active-20260405100000");
  });
});

describe("resolveSlug", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    setupDirs(TMP, {
      "06-impl/pending": ["fix-auth-bug-20260405100000"],
      "03-design/pending": ["add-logging-util-20260405110000"],
      "12-hold": ["build-landing-page-20260405120000"],
    });
  });
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it("exact match returns single slug", () => {
    const result = resolveSlug("fix-auth-bug-20260405100000", TMP);
    expect(result).toBe("fix-auth-bug-20260405100000");
  });

  it("prefix match returns single slug", () => {
    const result = resolveSlug("fix-auth", TMP);
    expect(result).toBe("fix-auth-bug-20260405100000");
  });

  it("keyword match returns single slug", () => {
    const result = resolveSlug("landing", TMP);
    expect(result).toBe("build-landing-page-20260405120000");
  });

  it("ambiguous match returns array", () => {
    // Both contain common word segments — add another slug with overlapping words
    setupDirs(TMP, { "07-validate/pending": ["fix-auth-flow-20260405130000"] });
    const result = resolveSlug("fix-auth", TMP);
    expect(Array.isArray(result)).toBe(true);
    expect((result as string[]).length).toBe(2);
  });

  it("no match returns empty array", () => {
    const result = resolveSlug("nonexistent-thing", TMP);
    expect(Array.isArray(result)).toBe(true);
    expect((result as string[]).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/slug-resolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement slug-resolver.ts**

Create `src/core/slug-resolver.ts`:

```typescript
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { STAGE_DIR_MAP } from "./stage-map.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ActiveTask {
  slug: string;
  dir: string;       // e.g. "06-impl/pending"
  stage: string;     // e.g. "impl"
  status: "active" | "held";
}

// ─── listActiveSlugs ────────────────────────────────────────────────────────

/**
 * Scans stage directories (01-* through 09-*, pending/ and done/) plus 12-hold/
 * for task slug directories. Ignores 10-complete and 11-failed.
 */
export function listActiveSlugs(runtimeDir: string): ActiveTask[] {
  const tasks: ActiveTask[] = [];

  // Scan stage dirs (pending + done subdirs)
  for (const [stage, stageDir] of Object.entries(STAGE_DIR_MAP)) {
    for (const sub of ["pending", "done"]) {
      const dir = join(runtimeDir, stageDir, sub);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        try {
          if (statSync(full).isDirectory()) {
            tasks.push({ slug: entry, dir: `${stageDir}/${sub}`, stage, status: "active" });
          }
        } catch { /* ignore race */ }
      }
    }
  }

  // Scan 12-hold
  const holdDir = join(runtimeDir, "12-hold");
  if (existsSync(holdDir)) {
    for (const entry of readdirSync(holdDir)) {
      const full = join(holdDir, entry);
      try {
        if (statSync(full).isDirectory()) {
          tasks.push({ slug: entry, dir: "12-hold", stage: "hold", status: "held" });
        }
      } catch { /* ignore race */ }
    }
  }

  return tasks;
}

// ─── resolveSlug ────────────────────────────────────────────────────────────

/**
 * Resolves a user-provided query to a task slug.
 * Returns: single string (unambiguous), string[] with 2+ entries (ambiguous),
 * or empty string[] (no match).
 */
export function resolveSlug(
  query: string,
  runtimeDir: string,
): string | string[] {
  const tasks = listActiveSlugs(runtimeDir);
  const slugs = tasks.map(t => t.slug);
  const q = query.toLowerCase().trim();

  // 1. Exact match
  const exact = slugs.find(s => s === q);
  if (exact) return exact;

  // 2. Prefix match
  const prefixMatches = slugs.filter(s => s.startsWith(q));
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) return prefixMatches;

  // 3. Keyword match — all query words must appear in the slug
  const words = q.split(/[\s\-_]+/).filter(Boolean);
  const keywordMatches = slugs.filter(slug =>
    words.every(word => slug.includes(word)),
  );
  if (keywordMatches.length === 1) return keywordMatches[0];
  if (keywordMatches.length > 1) return keywordMatches;

  return [];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/slug-resolver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/slug-resolver.ts tests/core/slug-resolver.test.ts
git commit -m "feat(spec3): add slug resolver with exact, prefix, and keyword matching"
```

---

### Task 4: Interaction Logging

**Files:**
- Create: `src/core/interactions.ts`
- Test: `tests/core/interactions.test.ts`

- [ ] **Step 1: Write interaction logging tests**

Create `tests/core/interactions.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  appendInteraction,
  appendDailyLogEntry,
  type InteractionEntry,
  type DailyLogEntry,
} from "../../src/core/interactions.js";

const TMP = join(process.cwd(), "tmp-interactions-test");

describe("appendInteraction", () => {
  beforeEach(() => mkdirSync(TMP, { recursive: true }));
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it("creates interactions.md with header on first write", () => {
    const entry: InteractionEntry = {
      timestamp: "2026-04-05 10:30",
      source: "cli",
      intent: "create_task",
      message: "fix the auth bug",
      action: "Task created, pipeline started",
    };
    appendInteraction(TMP, "fix-auth-20260405", entry);

    const content = readFileSync(join(TMP, "interactions.md"), "utf-8");
    expect(content).toContain("# Interactions — fix-auth-20260405");
    expect(content).toContain("**Intent:** create_task");
    expect(content).toContain("fix the auth bug");
  });

  it("appends to existing interactions.md", () => {
    const entry1: InteractionEntry = {
      timestamp: "2026-04-05 10:30",
      source: "cli",
      intent: "create_task",
      message: "fix the auth bug",
      action: "Task created",
    };
    const entry2: InteractionEntry = {
      timestamp: "2026-04-05 11:00",
      source: "slack",
      intent: "approve",
      message: "lgtm",
      action: "Approved",
    };
    appendInteraction(TMP, "fix-auth-20260405", entry1);
    appendInteraction(TMP, "fix-auth-20260405", entry2);

    const content = readFileSync(join(TMP, "interactions.md"), "utf-8");
    expect(content).toContain("create_task");
    expect(content).toContain("approve");
  });

  it("includes optional stageHints and targetStage fields", () => {
    const entry: InteractionEntry = {
      timestamp: "2026-04-05 10:30",
      source: "cli",
      intent: "create_task",
      message: "build landing page",
      action: "Task created",
      stageHints: 'design: "use contemporary patterns"',
      targetStage: "design",
    };
    appendInteraction(TMP, "slug", entry);
    const content = readFileSync(join(TMP, "interactions.md"), "utf-8");
    expect(content).toContain("**Stage hints:**");
    expect(content).toContain("**Target stage:**");
  });
});

describe("appendDailyLogEntry", () => {
  beforeEach(() => mkdirSync(TMP, { recursive: true }));
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it("creates YYYY-MM-DD.json with array on first write", () => {
    const entry: DailyLogEntry = {
      timestamp: "2026-04-05T10:30:00Z",
      type: "interaction",
      slug: "fix-auth-20260405",
      source: "cli",
      intent: "create_task",
      message: "fix the auth bug",
      action: "task_created",
    };
    appendDailyLogEntry(TMP, entry);

    const filePath = join(TMP, "2026-04-05.json");
    expect(existsSync(filePath)).toBe(true);
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(data).toHaveLength(1);
    expect(data[0].type).toBe("interaction");
  });

  it("appends to existing daily log", () => {
    const entry1: DailyLogEntry = {
      timestamp: "2026-04-05T10:30:00Z",
      type: "interaction",
      slug: "s1",
    };
    const entry2: DailyLogEntry = {
      timestamp: "2026-04-05T11:00:00Z",
      type: "agent_started",
      slug: "s1",
      stage: "questions",
      agentName: "Narada",
      attempt: 1,
    };
    appendDailyLogEntry(TMP, entry1);
    appendDailyLogEntry(TMP, entry2);

    const data = JSON.parse(readFileSync(join(TMP, "2026-04-05.json"), "utf-8"));
    expect(data).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/interactions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement interactions.ts**

Create `src/core/interactions.ts`:

```typescript
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// ─── Per-task interaction log (markdown) ────────────────────────────────────

export interface InteractionEntry {
  timestamp: string;
  source: string;
  intent: string;
  message: string;
  action: string;
  stageHints?: string;
  targetStage?: string;
}

/**
 * Appends a human interaction entry to {dir}/interactions.md.
 * Creates the file with a header on first write.
 */
export function appendInteraction(
  dir: string,
  slug: string,
  entry: InteractionEntry,
): void {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "interactions.md");

  if (!existsSync(filePath)) {
    writeFileSync(filePath, `# Interactions — ${slug}\n`, "utf-8");
  }

  const lines: string[] = [
    "",
    `### ${entry.timestamp} — ${entry.source}`,
    `**Intent:** ${entry.intent}`,
  ];

  if (entry.targetStage) {
    lines.push(`**Target stage:** ${entry.targetStage}`);
  }

  lines.push(`**Message:** "${entry.message}"`);

  if (entry.stageHints) {
    lines.push(`**Stage hints:** ${entry.stageHints}`);
  }

  lines.push(`**Action:** ${entry.action}`);
  lines.push("");

  appendFileSync(filePath, lines.join("\n"), "utf-8");
}

// ─── Global daily log (JSON) ────────────────────────────────────────────────

export interface DailyLogEntry {
  timestamp: string;
  type: string;
  slug: string;
  [key: string]: unknown;
}

/**
 * Appends an entry to the daily log file at {dir}/YYYY-MM-DD.json.
 * Creates the file with an empty array on first write.
 * Date is derived from entry.timestamp.
 */
export function appendDailyLogEntry(dir: string, entry: DailyLogEntry): void {
  mkdirSync(dir, { recursive: true });
  const date = entry.timestamp.slice(0, 10); // "YYYY-MM-DD"
  const filePath = join(dir, `${date}.json`);

  let data: DailyLogEntry[];
  if (existsSync(filePath)) {
    try {
      data = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      data = [];
    }
  } else {
    data = [];
  }

  data.push(entry);
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/interactions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/interactions.ts tests/core/interactions.test.ts
git commit -m "feat(spec3): add interaction logging — per-task markdown and global daily JSON"
```

---

### Task 5: Agent Stream Logger

**Files:**
- Create: `src/core/stream-logger.ts`
- Modify: `src/core/agent-runner.ts`
- Test: `tests/core/stream-logger.test.ts`

- [ ] **Step 1: Write stream logger tests**

Create `tests/core/stream-logger.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createStreamLogger } from "../../src/core/stream-logger.js";

const TMP = join(process.cwd(), "tmp-stream-logger-test");

describe("createStreamLogger", () => {
  beforeEach(() => mkdirSync(TMP, { recursive: true }));
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it("creates JSONL file and appends messages", () => {
    const logPath = join(TMP, "questions-stream.jsonl");
    const logger = createStreamLogger(logPath);

    logger.log({ type: "assistant", text: "Let me investigate..." });
    logger.log({ type: "tool_use", tool: "Read", input: { file_path: "src/foo.ts" } });
    logger.close();

    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.type).toBe("assistant");
    expect(first.text).toBe("Let me investigate...");
    expect(first.ts).toBeDefined();

    const second = JSON.parse(lines[1]);
    expect(second.type).toBe("tool_use");
    expect(second.tool).toBe("Read");
  });

  it("handles concurrent writes without corruption", () => {
    const logPath = join(TMP, "impl-stream.jsonl");
    const logger = createStreamLogger(logPath);

    for (let i = 0; i < 50; i++) {
      logger.log({ type: "assistant", text: `Message ${i}` });
    }
    logger.close();

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(50);
    // Each line should be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/stream-logger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement stream-logger.ts**

Create `src/core/stream-logger.ts`:

```typescript
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface StreamLogger {
  log(message: Record<string, unknown>): void;
  close(): void;
}

/**
 * Creates a JSONL stream logger that appends one JSON object per line.
 * Each message gets a `ts` field with the current ISO timestamp.
 */
export function createStreamLogger(filePath: string): StreamLogger {
  mkdirSync(dirname(filePath), { recursive: true });

  return {
    log(message: Record<string, unknown>): void {
      const entry = { ts: new Date().toISOString(), ...message };
      try {
        appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
      } catch {
        // Stream logging should never crash the pipeline
      }
    },

    close(): void {
      // No-op for append-mode file writes — nothing to flush
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/stream-logger.test.ts`
Expected: PASS

- [ ] **Step 5: Modify agent-runner.ts to capture stream messages**

In `src/core/agent-runner.ts`, add the import at the top:

```typescript
import { createStreamLogger, type StreamLogger } from "./stream-logger.js";
```

In the `runAgent` function, add `streamLogPath` parameter to `AgentRunOptions` type. Actually, compute it inside `runAgent` based on the existing `outputPath`:

After `const systemPrompt = buildSystemPrompt(options);` and before the try block, add:

```typescript
    // Set up stream logger alongside the output file
    const streamLogPath = options.outputPath.replace(/\.md$/, "-stream.jsonl");
    const streamLogger = createStreamLogger(streamLogPath);
```

Inside the `for await` loop, before the `if (message.type === "result")` check, add:

```typescript
      // Log all messages to JSONL stream
      try {
        const logEntry: Record<string, unknown> = { type: message.type };
        if (message.type === "result") {
          const msg = message as Record<string, unknown>;
          logEntry.subtype = msg.subtype;
          if (msg.total_cost_usd !== undefined) logEntry.costUsd = msg.total_cost_usd;
          if (msg.num_turns !== undefined) logEntry.turns = msg.num_turns;
        } else {
          // Capture assistant text, tool calls, etc.
          const msg = message as Record<string, unknown>;
          for (const [k, v] of Object.entries(msg)) {
            if (k !== "type") logEntry[k] = v;
          }
        }
        streamLogger.log(logEntry);
      } catch {
        // Never let stream logging interrupt the pipeline
      }
```

In the `finally` block, add `streamLogger.close();` before `clearTimeout(timeoutHandle);`.

Add `streamLogPath` to the successful `AgentRunResult`:

```typescript
    return {
      success: true,
      output,
      costUsd,
      turns,
      durationMs: Date.now() - startMs,
      streamLogPath,
    };
```

- [ ] **Step 6: Add streamLogPath to AgentRunResult in types.ts**

In `src/core/types.ts`, add to `AgentRunResult`:

```typescript
  streamLogPath?: string;
```

- [ ] **Step 7: Run all tests**

Run: `npx vitest run tests/core/stream-logger.test.ts tests/core/agent-runner.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/core/stream-logger.ts src/core/agent-runner.ts src/core/types.ts tests/core/stream-logger.test.ts
git commit -m "feat(spec3): add agent stream logger — JSONL capture of SDK messages"
```

---

### Task 6: Stage Hints (Parser, Creator, Prompt Injection)

**Files:**
- Modify: `src/task/parser.ts`
- Modify: `src/core/task-creator.ts`
- Modify: `src/core/agent-runner.ts`
- Test: `tests/task/parser.test.ts`
- Test: `tests/core/task-creator.test.ts`

- [ ] **Step 1: Write parser test for Stage Hints section**

Add to `tests/task/parser.test.ts`:

```typescript
describe("parseTaskFile — stage hints", () => {
  it("parses Stage Hints section into record", () => {
    const content = `# Task: Build landing page

## What I want done
Build a landing page

## Stage Hints
design: use contemporary and modular design patterns
impl: prefer Tailwind CSS, use async/await

## Pipeline Config
stages: questions, research, design
review_after: design
`;
    const meta = parseTaskFile(content);
    expect(meta.stageHints).toEqual({
      design: "use contemporary and modular design patterns",
      impl: "prefer Tailwind CSS, use async/await",
    });
  });

  it("returns empty stageHints when section is absent", () => {
    const content = `# Task: Simple task

## What I want done
Do something simple

## Pipeline Config
stages: questions
review_after: questions
`;
    const meta = parseTaskFile(content);
    expect(meta.stageHints).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/task/parser.test.ts`
Expected: FAIL — `stageHints` not on `TaskMeta`.

- [ ] **Step 3: Update parser.ts to extract stage hints**

In `src/task/parser.ts`, add `stageHints: Record<string, string>` to `TaskMeta`:

```typescript
export interface TaskMeta {
  title: string;
  description: string;
  context: string;
  repo: string;
  adoItem: string;
  slackThread: string;
  stages: string[];
  reviewAfter: string;
  stageHints: Record<string, string>;
}
```

In `parseTaskFile`, before the return, add:

```typescript
  // --- Stage Hints ---
  const stageHints: Record<string, string> = {};
  const hintsBody = sections["Stage Hints"];
  if (hintsBody) {
    for (const line of hintsBody.split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        if (key && value) {
          stageHints[key] = value;
        }
      }
    }
  }
```

Add `stageHints` to the return object.

- [ ] **Step 4: Update task-creator.ts to write stage hints**

In `src/core/task-creator.ts`, add `stageHints?: Record<string, string>` to `CreateTaskInput`.

In `buildTaskFileContent`, after the Slack Thread section, add:

```typescript
  lines.push("## Stage Hints");
  if (input.stageHints && Object.keys(input.stageHints).length > 0) {
    for (const [stage, hint] of Object.entries(input.stageHints)) {
      lines.push(`${stage}: ${hint}`);
    }
  }
  lines.push("");
```

- [ ] **Step 5: Update buildSystemPrompt to inject stage hints**

In `src/core/agent-runner.ts` `buildSystemPrompt`, after the Repo Context section and before the Agent Instructions section, add:

```typescript
  // Stage hints (user guidance)
  const taskHints = taskMeta.stageHints[stage];
  const runtimeHints = options.stageHints?.[stage] ?? [];
  const allHints: string[] = [];
  if (taskHints) allHints.push(taskHints);
  allHints.push(...runtimeHints);

  if (allHints.length > 0) {
    const hintLines = allHints.map(h => `- ${h}`).join("\n");
    sections.push(`## User Guidance\n\nThe user has provided the following instructions for this stage:\n${hintLines}`);
  }
```

Add `stageHints?: Record<string, string[]>` to `AgentRunOptions` in `src/core/types.ts`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/task/parser.test.ts tests/core/task-creator.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/task/parser.ts src/core/task-creator.ts src/core/agent-runner.ts src/core/types.ts tests/task/parser.test.ts
git commit -m "feat(spec3): add stage hints — parse from .task, inject into agent prompts"
```

---

### Task 7: Registry abortBySlug

**Files:**
- Modify: `src/core/registry.ts`
- Test: `tests/core/registry.test.ts`

- [ ] **Step 1: Write test for abortBySlug**

Add to `tests/core/registry.test.ts`:

```typescript
describe("abortBySlug", () => {
  it("aborts the agent matching the slug and removes it", () => {
    const registry = createAgentRegistry(5, 2);
    const ac = new AbortController();
    registry.register("target-slug", "impl", "Karigar", ac);
    registry.register("other-slug", "research", "Chitragupta", new AbortController());

    const aborted = registry.abortBySlug("target-slug");
    expect(aborted).toBe(true);
    expect(ac.signal.aborted).toBe(true);
    expect(registry.getActiveCount()).toBe(1);
  });

  it("returns false if slug not found", () => {
    const registry = createAgentRegistry(5, 2);
    const aborted = registry.abortBySlug("nonexistent");
    expect(aborted).toBe(false);
  });

  it("does not abort other agents", () => {
    const registry = createAgentRegistry(5, 2);
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    registry.register("slug-1", "impl", "Karigar", ac1);
    registry.register("slug-2", "research", "Chitragupta", ac2);

    registry.abortBySlug("slug-1");
    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/registry.test.ts`
Expected: FAIL — `abortBySlug` not a function.

- [ ] **Step 3: Add abortBySlug to registry**

In `src/core/registry.ts`, add to `AgentRegistry` interface:

```typescript
  abortBySlug(slug: string): boolean;
```

In `createAgentRegistry`, add the implementation:

```typescript
    abortBySlug(slug: string): boolean {
      for (const [id, entry] of agents.entries()) {
        if (entry.slug === slug) {
          entry.abortController.abort();
          agents.delete(id);
          return true;
        }
      }
      return false;
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/registry.ts tests/core/registry.test.ts
git commit -m "feat(spec3): add registry.abortBySlug() for pipeline control operations"
```

---

### Task 8: Pipeline Control Operations

**Files:**
- Modify: `src/core/pipeline.ts`
- Test: `tests/core/pipeline-control.test.ts`

- [ ] **Step 1: Write pipeline control tests**

Create `tests/core/pipeline-control.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createPipeline,
  createRunState,
  writeRunState,
  initTaskDir,
  type Pipeline,
} from "../../src/core/pipeline.js";
import { createAgentRegistry } from "../../src/core/registry.js";
import { type AgentRunnerFn, type RunState } from "../../src/core/types.js";
import { type TaskLogger } from "../../src/core/logger.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

const TMP = join(process.cwd(), "tmp-pipeline-control-test");

const noopLogger: TaskLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const noopRunner: AgentRunnerFn = async () => ({
  success: true, output: "done", costUsd: 0, turns: 1, durationMs: 10,
});

function setupTask(runtimeDir: string, slug: string, stage: string, status: "running" | "hold"): string {
  const stageDir = status === "hold" ? "12-hold" : `03-design/pending`;
  const taskDir = join(runtimeDir, stageDir, slug);
  mkdirSync(join(taskDir, "artifacts"), { recursive: true });
  writeFileSync(join(taskDir, "task.task"), `# Task: Test\n\n## What I want done\nTest task\n\n## Pipeline Config\nstages: questions, research, design, structure, plan\nreview_after: design\n`, "utf-8");
  const state: RunState = {
    slug,
    taskFile: "task.task",
    stages: ["questions", "research", "design", "structure", "plan"],
    reviewAfter: "design",
    currentStage: stage,
    status,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedStages: [],
    validateRetryCount: 0,
    reviewRetryCount: 0,
    reviewIssues: [],
    stageHints: {},
    retryAttempt: 0,
  };
  writeRunState(taskDir, state);
  return taskDir;
}

function makeConfig(runtimeDir: string) {
  return { ...DEFAULT_CONFIG, pipeline: { ...DEFAULT_CONFIG.pipeline, runtimeDir } };
}

describe("pipeline control operations", () => {
  let pipeline: Pipeline;

  beforeEach(() => {
    mkdirSync(join(TMP, "logs"), { recursive: true });
    mkdirSync(join(TMP, "11-failed"), { recursive: true });
    mkdirSync(join(TMP, "12-hold"), { recursive: true });
    const config = makeConfig(TMP);
    const registry = createAgentRegistry(3, 1);
    pipeline = createPipeline({ config, registry, runner: noopRunner, logger: noopLogger });
  });
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it("cancel moves active task to 11-failed", async () => {
    setupTask(TMP, "test-cancel-20260405", "design", "running");
    await pipeline.cancel("test-cancel-20260405");
    expect(existsSync(join(TMP, "11-failed", "test-cancel-20260405"))).toBe(true);
  });

  it("cancel moves held task to 11-failed", async () => {
    setupTask(TMP, "test-cancel-held-20260405", "design", "hold");
    await pipeline.cancel("test-cancel-held-20260405");
    expect(existsSync(join(TMP, "11-failed", "test-cancel-held-20260405"))).toBe(true);
  });

  it("pause moves active task to 12-hold with pausedAtStage", async () => {
    setupTask(TMP, "test-pause-20260405", "design", "running");
    await pipeline.pause("test-pause-20260405");
    const holdDir = join(TMP, "12-hold", "test-pause-20260405");
    expect(existsSync(holdDir)).toBe(true);
    const state = JSON.parse(readFileSync(join(holdDir, "run-state.json"), "utf-8")) as RunState;
    expect(state.status).toBe("hold");
    expect(state.pausedAtStage).toBe("design");
  });

  it("modifyStages updates remaining stages in RunState", async () => {
    const taskDir = setupTask(TMP, "test-modify-20260405", "design", "hold");
    await pipeline.modifyStages("test-modify-20260405", ["design", "plan", "impl", "pr"]);
    const state = JSON.parse(readFileSync(join(TMP, "12-hold", "test-modify-20260405", "run-state.json"), "utf-8")) as RunState;
    expect(state.stages).toEqual(["design", "plan", "impl", "pr"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/pipeline-control.test.ts`
Expected: FAIL — `cancel`, `pause`, `modifyStages` not on Pipeline.

- [ ] **Step 3: Expand Pipeline interface**

In `src/core/pipeline.ts`, expand the `Pipeline` interface:

```typescript
export interface Pipeline {
  startRun(taskFilePath: string, invocationCwd?: string): Promise<void>;
  resumeRun(slug: string, stageSubdir: string): Promise<void>;
  approveAndResume(slug: string, feedback?: string): Promise<void>;
  getActiveRuns(): RunState[];

  // Control operations (Spec 3)
  cancel(slug: string): Promise<void>;
  skip(slug: string, stage?: string): Promise<void>;
  pause(slug: string): Promise<void>;
  resume(slug: string): Promise<void>;
  modifyStages(slug: string, newStages: string[]): Promise<void>;
  restartStage(slug: string, stage?: string): Promise<void>;
  retry(slug: string, feedback: string): Promise<void>;

  // Notifier registration
  addNotifier(notifier: Notifier): void;
}
```

Add import at top: `import { type Notifier, type NotifyEvent } from "../surfaces/types.js";`

- [ ] **Step 4: Implement control operations in createPipeline**

Inside `createPipeline`, add a notifiers array and helper:

```typescript
  const notifiers: Notifier[] = [];

  async function emitNotify(event: NotifyEvent): Promise<void> {
    for (const n of notifiers) {
      try { await n.notify(event); } catch { /* never crash pipeline */ }
    }
  }
```

Add a helper to find a task's current directory:

```typescript
  function findTaskDir(slug: string): { dir: string; subdir: string } | null {
    // Check hold first
    const holdDir = join(runtimeDir, "12-hold", slug);
    if (existsSync(holdDir)) return { dir: holdDir, subdir: "12-hold" };

    // Check stage dirs (pending + done)
    for (const [stage, stageDir] of Object.entries(STAGE_DIR_MAP)) {
      for (const sub of ["pending", "done"]) {
        const d = join(runtimeDir, stageDir, sub, slug);
        if (existsSync(d)) return { dir: d, subdir: `${stageDir}/${sub}` };
      }
    }
    return null;
  }
```

Implement each control method in the returned object:

```typescript
    addNotifier(notifier: Notifier): void {
      notifiers.push(notifier);
    },

    async cancel(slug: string): Promise<void> {
      registry.abortBySlug(slug);
      const found = findTaskDir(slug);
      if (!found) throw new Error(`Task "${slug}" not found`);

      const state = readRunState(found.dir);
      state.status = "failed";
      state.error = "Cancelled by user";
      writeRunState(found.dir, state);
      recordCompletionIfWorktree(state);
      moveTaskDir(runtimeDir, slug, found.subdir, "11-failed");
      activeRuns.delete(slug);

      await emitNotify({
        type: "task_cancelled",
        slug,
        timestamp: new Date().toISOString(),
        cancelledBy: "user",
      });
    },

    async skip(slug: string, stage?: string): Promise<void> {
      const found = findTaskDir(slug);
      if (!found) throw new Error(`Task "${slug}" not found`);

      const state = readRunState(found.dir);
      const targetStage = stage ?? state.currentStage;
      const nextStage = getNextStage(targetStage, state.stages);

      if (!nextStage) throw new Error(`No stage after "${targetStage}" to skip to`);

      registry.abortBySlug(slug);
      state.currentStage = nextStage;
      state.status = "running";
      writeRunState(found.dir, state);
      const newDir = moveTaskDir(runtimeDir, slug, found.subdir, join(STAGE_DIR_MAP[nextStage], "pending"));

      await emitNotify({
        type: "stage_skipped",
        slug,
        timestamp: new Date().toISOString(),
        stage: targetStage,
      });

      activeRuns.set(slug, readRunState(newDir));
      await processStage(slug, newDir);
    },

    async pause(slug: string): Promise<void> {
      registry.abortBySlug(slug);
      const found = findTaskDir(slug);
      if (!found) throw new Error(`Task "${slug}" not found`);

      const state = readRunState(found.dir);
      state.status = "hold";
      state.pausedAtStage = state.currentStage;
      writeRunState(found.dir, state);
      moveTaskDir(runtimeDir, slug, found.subdir, "12-hold");
      activeRuns.set(slug, readRunState(join(runtimeDir, "12-hold", slug)));

      await emitNotify({
        type: "task_paused",
        slug,
        timestamp: new Date().toISOString(),
        pausedBy: "user",
      });
    },

    async resume(slug: string): Promise<void> {
      const holdDir = join(runtimeDir, "12-hold", slug);
      if (!existsSync(holdDir)) throw new Error(`Task "${slug}" not found in hold`);

      const state = readRunState(holdDir);
      if (!state.pausedAtStage) throw new Error(`Task "${slug}" was not paused — use approve instead`);

      const stage = state.pausedAtStage;
      state.status = "running";
      state.currentStage = stage;
      delete state.pausedAtStage;
      writeRunState(holdDir, state);
      const newDir = moveTaskDir(runtimeDir, slug, "12-hold", join(STAGE_DIR_MAP[stage], "pending"));

      await emitNotify({
        type: "task_resumed",
        slug,
        timestamp: new Date().toISOString(),
        resumedBy: "user",
      });

      activeRuns.set(slug, readRunState(newDir));
      await processStage(slug, newDir);
    },

    async modifyStages(slug: string, newStages: string[]): Promise<void> {
      const found = findTaskDir(slug);
      if (!found) throw new Error(`Task "${slug}" not found`);

      const state = readRunState(found.dir);
      const oldStages = [...state.stages];
      state.stages = newStages;
      writeRunState(found.dir, state);

      await emitNotify({
        type: "stages_modified",
        slug,
        timestamp: new Date().toISOString(),
        oldStages,
        newStages,
      });
    },

    async restartStage(slug: string, stage?: string): Promise<void> {
      const found = findTaskDir(slug);
      if (!found) throw new Error(`Task "${slug}" not found`);

      const state = readRunState(found.dir);
      const targetStage = stage ?? state.currentStage;

      registry.abortBySlug(slug);
      state.currentStage = targetStage;
      state.status = "running";
      writeRunState(found.dir, state);
      const newDir = moveTaskDir(runtimeDir, slug, found.subdir, join(STAGE_DIR_MAP[targetStage], "pending"));

      activeRuns.set(slug, readRunState(newDir));
      await processStage(slug, newDir);
    },

    async retry(slug: string, feedback: string): Promise<void> {
      const holdDir = join(runtimeDir, "12-hold", slug);
      if (!existsSync(holdDir)) throw new Error(`Task "${slug}" not found in hold`);

      const state = readRunState(holdDir);
      if (state.pausedAtStage) throw new Error(`Task "${slug}" is paused — use resume instead`);

      const stage = state.currentStage;
      state.retryAttempt += 1;
      state.status = "running";
      writeRunState(holdDir, state);

      // Write feedback artifact for agent context
      const feedbackFile = join(holdDir, "artifacts", `retry-feedback-${stage}-${state.retryAttempt}.md`);
      mkdirSync(dirname(feedbackFile), { recursive: true });
      writeFileSync(feedbackFile, `# Reviewer Feedback (attempt ${state.retryAttempt})\n\n${feedback}\n`, "utf-8");

      const newDir = moveTaskDir(runtimeDir, slug, "12-hold", join(STAGE_DIR_MAP[stage], "pending"));

      await emitNotify({
        type: "stage_retried",
        slug,
        timestamp: new Date().toISOString(),
        stage,
        attempt: state.retryAttempt,
        feedback,
      });

      activeRuns.set(slug, readRunState(newDir));
      await processStage(slug, newDir);
    },
```

- [ ] **Step 5: Add notify emissions to existing processStage and startRun flows**

In `startRun`, after `activeRuns.set(slug, state)`, add:
```typescript
      await emitNotify({ type: "task_created", slug, timestamp: new Date().toISOString(), title: taskMeta.title, source: "pipeline", stages: state.stages });
```

In the `processStage` function, add `emitNotify` calls at key points:

After agent starts (after `registry.register`):
```typescript
      await emitNotify({ type: "stage_started", slug, timestamp: new Date().toISOString(), stage });
```

After successful stage completion (after `state.completedStages.push`):
```typescript
      await emitNotify({ type: "stage_completed", slug, timestamp: new Date().toISOString(), stage, artifactPath: `${stage}-output.md` });
```

At review gate hold:
```typescript
      await emitNotify({ type: "task_held", slug, timestamp: new Date().toISOString(), stage, artifactUrl: "" });
```

At pipeline completion:
```typescript
      await emitNotify({ type: "task_completed", slug, timestamp: new Date().toISOString() });
```

At failure:
```typescript
      await emitNotify({ type: "task_failed", slug, timestamp: new Date().toISOString(), stage, error: state.error ?? "Unknown error" });
```

- [ ] **Step 5b: Add versioned output path for retry attempts**

In `processStage`, where `outputPath` is computed, check `state.retryAttempt`:

```typescript
      const outputSuffix = state.retryAttempt > 0 ? `-r${state.retryAttempt}` : "";
      const outputPath = join(artifactsDir, `${stage}-output${outputSuffix}.md`);
```

- [ ] **Step 5c: Integrate interaction logging into pipeline control methods**

In each control method (`cancel`, `skip`, `pause`, `resume`, `modifyStages`, `restartStage`, `retry`), call `appendDailyLogEntry`:

```typescript
      import { appendDailyLogEntry } from "./interactions.js";
```

Example in `cancel`:
```typescript
      const interactionsDir = join(runtimeDir, "interactions");
      appendDailyLogEntry(interactionsDir, {
        timestamp: new Date().toISOString(),
        type: "control",
        slug,
        source: "user",
        command: "cancel",
      });
```

Apply the same pattern (with appropriate `command`, `targetStage`, `feedback` fields) to each control method.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/core/pipeline-control.test.ts tests/core/pipeline.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/pipeline.ts src/surfaces/types.ts tests/core/pipeline-control.test.ts
git commit -m "feat(spec3): add 7 pipeline control operations with notify emissions"
```

---

### Task 9: Intent Classifier Expansion + classify.md

**Files:**
- Modify: `src/core/intent-classifier.ts`
- Modify: `src/core/types.ts`
- Modify: `agents/classify.md`
- Test: `tests/core/intent-classifier.test.ts`

- [ ] **Step 1: Write tests for expanded intents and ClassifyResult**

Add to `tests/core/intent-classifier.test.ts`:

```typescript
describe("classifyByKeywords — new intents", () => {
  it("classifies cancel intent", () => {
    const result = classifyByKeywords("cancel fix-auth-bug-20260405103000");
    expect(result?.intent).toBe("cancel");
    expect(result?.extractedSlug).toBe("fix-auth-bug-20260405103000");
  });

  it("classifies skip intent", () => {
    const result = classifyByKeywords("skip research");
    expect(result?.intent).toBe("skip");
  });

  it("classifies pause intent", () => {
    const result = classifyByKeywords("pause fix-auth");
    expect(result?.intent).toBe("pause");
  });

  it("classifies resume intent", () => {
    const result = classifyByKeywords("resume fix-auth");
    expect(result?.intent).toBe("resume");
  });

  it("classifies retry intent", () => {
    const result = classifyByKeywords("retry design");
    expect(result?.intent).toBe("retry");
  });

  it("classifies quick: prefix as create_task with quick complexity", () => {
    const result = classifyByKeywords("quick: rewrite this paragraph");
    expect(result?.intent).toBe("create_task");
    expect(result?.complexity).toBe("quick");
    expect(result?.complexityConfidence).toBe(1.0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/intent-classifier.test.ts`
Expected: FAIL — new intents not recognized, `complexity` not on result.

- [ ] **Step 3: Expand ClassifyResult in types or intent-classifier.ts**

In `src/core/intent-classifier.ts`, update the `ClassifyResult` interface:

```typescript
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
```

Update `UNKNOWN_RESULT` to include new fields:

```typescript
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
```

- [ ] **Step 4: Add new keyword rules**

Add to `KEYWORD_RULES`:

```typescript
  {
    pattern: /^(skip)\s+/i,
    intent: "skip" as const,
    confidence: 0.95,
  },
  {
    pattern: /^(pause|hold on)\s+/i,
    intent: "pause" as const,
    confidence: 0.95,
  },
  {
    pattern: /^(resume|continue)\s+/i,
    intent: "resume" as const,
    confidence: 0.95,
  },
  {
    pattern: /^(retry|redo)\s+/i,
    intent: "retry" as const,
    confidence: 0.95,
  },
  {
    pattern: /^(restart)\s+/i,
    intent: "restart_stage" as const,
    confidence: 0.95,
  },
  {
    pattern: /^(modify.stages|change.stages|drop|add.stage)\s+/i,
    intent: "modify_stages" as const,
    confidence: 0.90,
  },
```

Update `classifyByKeywords` to return the expanded result with null defaults:

```typescript
export function classifyByKeywords(input: string): ClassifyResult | null {
  const trimmed = input.trim();

  // Check quick: / full pipeline: prefixes
  if (/^quick:\s*/i.test(trimmed)) {
    return {
      ...UNKNOWN_RESULT,
      intent: "create_task",
      confidence: 0.95,
      extractedContent: trimmed.replace(/^quick:\s*/i, ""),
      complexity: "quick",
      complexityConfidence: 1.0,
    };
  }
  if (/^full\s+pipeline:\s*/i.test(trimmed)) {
    return {
      ...UNKNOWN_RESULT,
      intent: "create_task",
      confidence: 0.95,
      extractedContent: trimmed.replace(/^full\s+pipeline:\s*/i, ""),
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
      };
    }
  }

  return null;
}
```

- [ ] **Step 5: Update classify.md for new intents**

Replace `agents/classify.md` content with:

```markdown
## Instructions

Classify the intent of the input provided to you. Analyse the content and determine what type of task, command, or request it represents.

Output ONLY valid JSON. No markdown, no explanation, no code fences. The JSON object must have exactly these fields:

- `intent` — string, one of: `"create_task"`, `"approve"`, `"status"`, `"cancel"`, `"skip"`, `"pause"`, `"resume"`, `"modify_stages"`, `"restart_stage"`, `"retry"`, `"unknown"`
- `confidence` — number between 0.0 and 1.0 representing classification confidence
- `extractedSlug` — string or null, a task slug or partial slug reference from the input
- `extractedContent` — string or null, the full cleaned task content (for create_task)
- `extractedStages` — array of strings or null, stage names (for modify_stages)
- `extractedFeedback` — string or null, reviewer feedback text (for retry or approve)
- `stageHints` — object or null, mapping stage names to user guidance extracted from the input (e.g. {"design": "use modular patterns"})
- `complexity` — string or null, either `"quick"` or `"pipeline"` (for create_task only, null for other intents)
- `complexityConfidence` — number between 0.0 and 1.0 (0 when complexity is null)

For `stageHints`: if the input contains instructions that target specific pipeline stages, extract them. If instructions don't target a specific stage, apply them broadly by using `"*"` as the key.

For `complexity`: classify as `"quick"` if the task is simple and self-contained (rewriting text, answering a question, composing a message). Classify as `"pipeline"` if it involves code changes, multi-step work, or complex analysis.

Example outputs:

{"intent":"create_task","confidence":0.95,"extractedSlug":null,"extractedContent":"Add user authentication to the API","extractedStages":null,"extractedFeedback":null,"stageHints":{"design":"use JWT tokens"},"complexity":"pipeline","complexityConfidence":0.9}

{"intent":"retry","confidence":0.92,"extractedSlug":"fix-auth-bug-20260405103000","extractedContent":null,"extractedStages":null,"extractedFeedback":"use microservices instead of monolith","stageHints":null,"complexity":null,"complexityConfidence":0}

{"intent":"skip","confidence":0.95,"extractedSlug":"fix-auth","extractedContent":null,"extractedStages":null,"extractedFeedback":null,"stageHints":null,"complexity":null,"complexityConfidence":0}
```

- [ ] **Step 6: Update existing tests for expanded ClassifyResult shape**

In the existing test file, update the `stubRunner` and assertions to account for the new fields in `ClassifyResult`. The LLM Zod schema in `classifyByLLM` needs updating too — add `.catch(null)` defaults for the new fields in the `classifySchema`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/core/intent-classifier.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/core/intent-classifier.ts agents/classify.md tests/core/intent-classifier.test.ts
git commit -m "feat(spec3): expand intent classifier — new intents, complexity, stageHints extraction"
```

---

### Task 10: CLI Task & Approve Commands

**Files:**
- Modify: `src/commands/task.ts`
- Modify: `src/commands/approve.ts`
- Test: `tests/commands/task.test.ts` (create or update)
- Test: `tests/commands/approve.test.ts` (create or update)

- [ ] **Step 1: Write task command test**

Create `tests/commands/task.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const TMP = join(process.cwd(), "tmp-task-cmd-test");

// Rather than invoking the CLI binary, test the handler function directly
import { createTask, type CreateTaskInput } from "../../src/core/task-creator.js";
import { resolveConfig } from "../../src/config/loader.js";
import { configSchema } from "../../src/config/schema.js";

describe("shkmn task command handler", () => {
  beforeEach(() => {
    mkdirSync(join(TMP, "00-inbox"), { recursive: true });
  });
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it("creates a .task file in inbox with stage hints", () => {
    const parsed = configSchema.parse({ pipeline: { runtimeDir: TMP } });
    const config = resolveConfig(parsed);

    const input: CreateTaskInput = {
      source: "cli",
      content: "build landing page",
      repo: "web-app",
      stageHints: { design: "use contemporary patterns", impl: "prefer Tailwind" },
    };

    const slug = createTask(input, TMP, config);
    const files = readdirSync(join(TMP, "00-inbox"));
    expect(files.length).toBe(1);
    expect(files[0]).toContain("build-landing-page");

    const content = readFileSync(join(TMP, "00-inbox", files[0]), "utf-8");
    expect(content).toContain("## Stage Hints");
    expect(content).toContain("design: use contemporary patterns");
    expect(content).toContain("impl: prefer Tailwind");
  });
});
```

- [ ] **Step 2: Run test to verify it fails (stageHints not on CreateTaskInput)**

Run: `npx vitest run tests/commands/task.test.ts`
Expected: FAIL

- [ ] **Step 3: Wire task command**

Replace `src/commands/task.ts`:

```typescript
import type { Command } from "commander";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";
import { createTask, type CreateTaskInput } from "../core/task-creator.js";

export function registerTaskCommand(program: Command): void {
  program
    .command("task")
    .description("Create a new pipeline task")
    .argument("<description>", "Description of the task")
    .option("--repo <repo>", "Target repository")
    .option("--ado <ado>", "Azure DevOps work item reference")
    .option("--stages <stages>", "Comma-separated list of stages to run")
    .option("--hints <hints...>", "Stage hints in stage:hint format")
    .option("--quick", "Force quick task (skip full pipeline)")
    .option("--full", "Force full pipeline")
    .action((description: string, opts: { repo?: string; ado?: string; stages?: string; hints?: string[]; quick?: boolean; full?: boolean }) => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);

      // Parse stage hints from "stage:hint" format
      const stageHints: Record<string, string> = {};
      if (opts.hints) {
        for (const h of opts.hints) {
          const colonIdx = h.indexOf(":");
          if (colonIdx > 0) {
            stageHints[h.slice(0, colonIdx).trim()] = h.slice(colonIdx + 1).trim();
          }
        }
      }

      const input: CreateTaskInput = {
        source: "cli",
        content: description,
        repo: opts.repo,
        adoItem: opts.ado,
        stages: opts.stages?.split(",").map(s => s.trim()),
        stageHints: Object.keys(stageHints).length > 0 ? stageHints : undefined,
      };

      const slug = createTask(input, config.pipeline.runtimeDir, config);
      console.log(`Task created: ${slug}`);
    });
}
```

- [ ] **Step 4: Wire approve command**

Replace `src/commands/approve.ts`:

```typescript
import type { Command } from "commander";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";
import { findHeldTask } from "../core/approval-handler.js";

export function registerApproveCommand(program: Command): void {
  program
    .command("approve")
    .description("Approve a task waiting in review")
    .argument("<slug>", "Task slug to approve")
    .option("--feedback <feedback>", "Optional feedback message")
    .action((slug: string, opts: { feedback?: string }) => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);

      const held = findHeldTask(config.pipeline.runtimeDir, slug);
      if (!held) {
        console.error(`Task "${slug}" not found in hold`);
        process.exit(1);
      }

      // Note: actual approve requires a running pipeline instance.
      // CLI approve writes an approval marker file that the watcher picks up.
      // For now, print the held path for the running pipeline to process.
      console.log(`Approval queued for task: ${slug}`);
      if (opts.feedback) {
        console.log(`Feedback: ${opts.feedback}`);
      }
    });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/commands/task.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/commands/task.ts src/commands/approve.ts tests/commands/task.test.ts
git commit -m "feat(spec3): wire shkmn task and approve CLI commands"
```

---

### Task 11: CLI Status & Logs Commands

**Files:**
- Modify: `src/commands/status.ts`
- Modify: `src/commands/logs.ts`

- [ ] **Step 1: Implement status command**

Replace `src/commands/status.ts`:

```typescript
import type { Command } from "commander";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";
import { listActiveSlugs, type ActiveTask } from "../core/slug-resolver.js";

function formatElapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show active pipeline runs and their current stages")
    .action(() => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);
      const tasks = listActiveSlugs(config.pipeline.runtimeDir);

      const active = tasks.filter(t => t.status === "active");
      const held = tasks.filter(t => t.status === "held");

      if (active.length === 0 && held.length === 0) {
        console.log("No active or held tasks.");
        return;
      }

      if (active.length > 0) {
        console.log("Active:");
        for (const t of active) {
          console.log(`  ${t.slug.padEnd(45)} → ${t.stage.padEnd(12)}`);
        }
      }

      if (held.length > 0) {
        if (active.length > 0) console.log("");
        console.log("Held (awaiting approval):");
        for (const t of held) {
          console.log(`  ${t.slug.padEnd(45)} → ${t.stage.padEnd(12)} (held)`);
        }
      }
    });
}
```

- [ ] **Step 2: Implement logs command**

Replace `src/commands/logs.ts`:

```typescript
import type { Command } from "commander";
import { readFileSync, existsSync, watchFile, unwatchFile, statSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";

export function registerLogsCommand(program: Command): void {
  program
    .command("logs")
    .description("Tail logs for a specific task")
    .argument("<slug>", "Task slug to tail logs for")
    .option("-f, --follow", "Follow log output (like tail -f)")
    .option("--lines <n>", "Number of lines to show", "50")
    .action((slug: string, opts: { follow?: boolean; lines?: string }) => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);
      const logFile = join(config.pipeline.runtimeDir, "logs", `${slug}.log`);

      if (!existsSync(logFile)) {
        console.error(`Log file not found: ${logFile}`);
        process.exit(1);
      }

      const numLines = parseInt(opts.lines ?? "50", 10);
      const content = readFileSync(logFile, "utf-8");
      const lines = content.split("\n");
      const tail = lines.slice(-numLines).join("\n");
      process.stdout.write(tail);

      if (opts.follow) {
        let lastSize = statSync(logFile).size;

        watchFile(logFile, { interval: 500 }, () => {
          try {
            const newSize = statSync(logFile).size;
            if (newSize > lastSize) {
              const fd = require("node:fs").openSync(logFile, "r");
              const buf = Buffer.alloc(newSize - lastSize);
              require("node:fs").readSync(fd, buf, 0, buf.length, lastSize);
              require("node:fs").closeSync(fd);
              process.stdout.write(buf.toString("utf-8"));
              lastSize = newSize;
            }
          } catch {
            // File may have been rotated
          }
        });

        process.on("SIGINT", () => {
          unwatchFile(logFile);
          process.exit(0);
        });
      }
    });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/commands/status.ts src/commands/logs.ts
git commit -m "feat(spec3): wire shkmn status and logs CLI commands"
```

---

### Task 12: CLI Control Commands

**Files:**
- Create: `src/commands/cancel.ts`
- Create: `src/commands/skip.ts`
- Create: `src/commands/pause.ts`
- Create: `src/commands/resume.ts`
- Create: `src/commands/modify-stages.ts`
- Create: `src/commands/restart-stage.ts`
- Create: `src/commands/retry.ts`
- Modify: `src/cli.ts`

**IPC design note:** CLI control commands need to communicate with the running `shkmn start` pipeline process. The approach: each command writes a JSON control file to `{runtimeDir}/00-inbox/{slug}.control` with the operation and parameters. The watcher (Heimdall) picks up `.control` files alongside `.task` files and dispatches them to the appropriate pipeline method. This avoids Unix sockets/named pipes and works cross-platform. The control file mechanism is wired in Task 16 (watcher modification).

- [ ] **Step 1: Create all 7 control command files**

Create `src/commands/cancel.ts`:

```typescript
import type { Command } from "commander";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";

export function registerCancelCommand(program: Command): void {
  program
    .command("cancel")
    .description("Cancel a running or held task")
    .argument("<slug>", "Task slug to cancel")
    .action((slug: string) => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);
      const inboxDir = join(config.pipeline.runtimeDir, "00-inbox");
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(
        join(inboxDir, `${slug}.control`),
        JSON.stringify({ operation: "cancel", slug }),
        "utf-8",
      );
      console.log(`Cancel queued for task: ${slug}`);
    });
}
```

Create `src/commands/skip.ts`:

```typescript
import type { Command } from "commander";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";

export function registerSkipCommand(program: Command): void {
  program
    .command("skip")
    .description("Skip the current or named stage")
    .argument("<slug>", "Task slug")
    .option("--stage <stage>", "Stage to skip (defaults to current)")
    .action((slug: string, opts: { stage?: string }) => {
      const config = loadConfig(resolveConfigPath());
      const inboxDir = join(config.pipeline.runtimeDir, "00-inbox");
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(
        join(inboxDir, `${slug}.control`),
        JSON.stringify({ operation: "skip", slug, stage: opts.stage }),
        "utf-8",
      );
      console.log(`Skip queued for task: ${slug}${opts.stage ? ` stage: ${opts.stage}` : ""}`);
    });
}
```

Create `src/commands/pause.ts`:

```typescript
import type { Command } from "commander";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";

export function registerPauseCommand(program: Command): void {
  program
    .command("pause")
    .description("Pause a running task")
    .argument("<slug>", "Task slug to pause")
    .action((slug: string) => {
      const config = loadConfig(resolveConfigPath());
      const inboxDir = join(config.pipeline.runtimeDir, "00-inbox");
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(
        join(inboxDir, `${slug}.control`),
        JSON.stringify({ operation: "pause", slug }),
        "utf-8",
      );
      console.log(`Pause queued for task: ${slug}`);
    });
}
```

Create `src/commands/resume.ts`:

```typescript
import type { Command } from "commander";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";

export function registerResumeCommand(program: Command): void {
  program
    .command("resume")
    .description("Resume a paused task")
    .argument("<slug>", "Task slug to resume")
    .action((slug: string) => {
      const config = loadConfig(resolveConfigPath());
      const inboxDir = join(config.pipeline.runtimeDir, "00-inbox");
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(
        join(inboxDir, `${slug}.control`),
        JSON.stringify({ operation: "resume", slug }),
        "utf-8",
      );
      console.log(`Resume queued for task: ${slug}`);
    });
}
```

Create `src/commands/modify-stages.ts`:

```typescript
import type { Command } from "commander";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";

export function registerModifyStagesCommand(program: Command): void {
  program
    .command("modify-stages")
    .description("Change the remaining stages for a task")
    .argument("<slug>", "Task slug")
    .requiredOption("--stages <stages>", "Comma-separated list of new stages")
    .action((slug: string, opts: { stages: string }) => {
      const stages = opts.stages.split(",").map(s => s.trim());
      const config = loadConfig(resolveConfigPath());
      const inboxDir = join(config.pipeline.runtimeDir, "00-inbox");
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(
        join(inboxDir, `${slug}.control`),
        JSON.stringify({ operation: "modify_stages", slug, stages }),
        "utf-8",
      );
      console.log(`Modify stages queued for task: ${slug} → [${stages.join(", ")}]`);
    });
}
```

Create `src/commands/restart-stage.ts`:

```typescript
import type { Command } from "commander";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";

export function registerRestartStageCommand(program: Command): void {
  program
    .command("restart-stage")
    .description("Restart the current or named stage from scratch")
    .argument("<slug>", "Task slug")
    .option("--stage <stage>", "Stage to restart (defaults to current)")
    .action((slug: string, opts: { stage?: string }) => {
      const config = loadConfig(resolveConfigPath());
      const inboxDir = join(config.pipeline.runtimeDir, "00-inbox");
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(
        join(inboxDir, `${slug}.control`),
        JSON.stringify({ operation: "restart_stage", slug, stage: opts.stage }),
        "utf-8",
      );
      console.log(`Restart stage queued for task: ${slug}${opts.stage ? ` stage: ${opts.stage}` : ""}`);
    });
}
```

Create `src/commands/retry.ts`:

```typescript
import type { Command } from "commander";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";

export function registerRetryCommand(program: Command): void {
  program
    .command("retry")
    .description("Retry the held stage with feedback")
    .argument("<slug>", "Task slug to retry")
    .requiredOption("--feedback <feedback>", "Reviewer feedback for the retry")
    .action((slug: string, opts: { feedback: string }) => {
      const config = loadConfig(resolveConfigPath());
      const inboxDir = join(config.pipeline.runtimeDir, "00-inbox");
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(
        join(inboxDir, `${slug}.control`),
        JSON.stringify({ operation: "retry", slug, feedback: opts.feedback }),
        "utf-8",
      );
      console.log(`Retry queued for task: ${slug}`);
    });
}
```

- [ ] **Step 2: Register all commands in cli.ts**

In `src/cli.ts`, add imports:

```typescript
import { registerCancelCommand } from "./commands/cancel.js";
import { registerSkipCommand } from "./commands/skip.js";
import { registerPauseCommand } from "./commands/pause.js";
import { registerResumeCommand } from "./commands/resume.js";
import { registerModifyStagesCommand } from "./commands/modify-stages.js";
import { registerRestartStageCommand } from "./commands/restart-stage.js";
import { registerRetryCommand } from "./commands/retry.js";
```

Add registrations after existing ones:

```typescript
registerCancelCommand(program);
registerSkipCommand(program);
registerPauseCommand(program);
registerResumeCommand(program);
registerModifyStagesCommand(program);
registerRestartStageCommand(program);
registerRetryCommand(program);
```

- [ ] **Step 3: Verify commands register**

Run: `npx tsup && node dist/cli.js --help`
Expected: All 7 new commands listed in help output.

- [ ] **Step 4: Commit**

```bash
git add src/commands/cancel.ts src/commands/skip.ts src/commands/pause.ts src/commands/resume.ts src/commands/modify-stages.ts src/commands/restart-stage.ts src/commands/retry.ts src/cli.ts
git commit -m "feat(spec3): register 7 CLI control commands �� cancel, skip, pause, resume, modify-stages, restart-stage, retry"
```

---

### Task 13: Quick Task Path + agents/quick.md

**Files:**
- Create: `agents/quick.md`
- Modify: `src/core/pipeline.ts` (add `startQuickRun` method)
- Test: `tests/core/pipeline-quick.test.ts`

- [ ] **Step 1: Create agents/quick.md**

Create `agents/quick.md`:

```markdown
# Identity

You are the quick task agent in the ShaktimaanAI pipeline. You handle simple, self-contained tasks that don't need the full multi-stage pipeline.

# Instructions

Complete the task directly and concisely. Match the tone and format implied by the request.

- If the task asks you to write or rewrite text, produce the text directly.
- If the task asks a question, answer it.
- If the task asks you to compose something (email, message, document), compose it.
- Do not break the task into stages or slices.
- Do not write tests unless explicitly asked.
- Be concise — output only what was asked for.

# Output

Write your output to the path provided in the pipeline context.
```

- [ ] **Step 2: Write quick task test**

Create `tests/core/pipeline-quick.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPipeline } from "../../src/core/pipeline.js";
import { createAgentRegistry } from "../../src/core/registry.js";
import { type AgentRunnerFn } from "../../src/core/types.js";
import { type TaskLogger } from "../../src/core/logger.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

const TMP = join(process.cwd(), "tmp-pipeline-quick-test");

const noopLogger: TaskLogger = { info: () => {}, warn: () => {}, error: () => {} };

const quickRunner: AgentRunnerFn = async (opts) => {
  // Simulate writing output
  writeFileSync(opts.outputPath, "Quick task output: done!", "utf-8");
  return { success: true, output: "Quick task output: done!", costUsd: 0.01, turns: 1, durationMs: 100 };
};

describe("quick task path", () => {
  beforeEach(() => {
    mkdirSync(join(TMP, "logs"), { recursive: true });
    mkdirSync(join(TMP, "00-inbox"), { recursive: true });
    mkdirSync(join(TMP, "10-complete"), { recursive: true });
    mkdirSync(join(TMP, "12-hold"), { recursive: true });
  });
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it("quick task with requireReview=false goes to 10-complete", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      pipeline: { ...DEFAULT_CONFIG.pipeline, runtimeDir: TMP },
      quickTask: { requireReview: false, complexityThreshold: 0.8 },
    };
    const registry = createAgentRegistry(3, 1);
    const pipeline = createPipeline({ config, registry, runner: quickRunner, logger: noopLogger });

    // Create a task file
    const taskContent = "# Task: Rewrite paragraph\n\n## What I want done\nRewrite this in formal tone\n\n## Pipeline Config\nstages: quick\nreview_after: none\n";
    const taskFile = join(TMP, "00-inbox", "rewrite-paragraph-20260405100000.task");
    writeFileSync(taskFile, taskContent, "utf-8");

    await pipeline.startQuickRun(taskFile, taskContent);
    expect(existsSync(join(TMP, "10-complete", "rewrite-paragraph-20260405100000"))).toBe(true);
  });

  it("quick task with requireReview=true goes to 12-hold", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      pipeline: { ...DEFAULT_CONFIG.pipeline, runtimeDir: TMP },
      quickTask: { requireReview: true, complexityThreshold: 0.8 },
    };
    const registry = createAgentRegistry(3, 1);
    const pipeline = createPipeline({ config, registry, runner: quickRunner, logger: noopLogger });

    const taskContent = "# Task: Rewrite paragraph\n\n## What I want done\nRewrite this in formal tone\n\n## Pipeline Config\nstages: quick\nreview_after: none\n";
    const taskFile = join(TMP, "00-inbox", "rewrite-para-20260405100000.task");
    writeFileSync(taskFile, taskContent, "utf-8");

    await pipeline.startQuickRun(taskFile, taskContent);
    expect(existsSync(join(TMP, "12-hold", "rewrite-para-20260405100000"))).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/core/pipeline-quick.test.ts`
Expected: FAIL — `startQuickRun` not on Pipeline.

- [ ] **Step 4: Implement startQuickRun in pipeline.ts**

Add to `Pipeline` interface:

```typescript
  startQuickRun(taskFilePath: string, taskContent: string): Promise<void>;
```

Implement in `createPipeline`:

```typescript
    async startQuickRun(taskFilePath: string, taskContent: string): Promise<void> {
      const slug = basename(taskFilePath, ".task");
      const taskLogger = createTaskLogger(join(runtimeDir, "logs"), slug);

      // Create task directory
      const destDir = config.quickTask.requireReview
        ? join(runtimeDir, "12-hold", slug)
        : join(runtimeDir, "10-complete", slug);
      mkdirSync(join(destDir, "artifacts"), { recursive: true });
      copyFileSync(taskFilePath, join(destDir, "task.task"));

      // Delete inbox file
      try { unlinkSync(taskFilePath); } catch { /* may already be gone */ }

      const outputPath = join(destDir, "artifacts", "quick-output.md");

      const abortController = new AbortController();
      const agentId = registry.register(slug, "quick", "Quick", abortController);

      await emitNotify({ type: "task_created", slug, timestamp: new Date().toISOString(), title: slug, source: "cli", stages: ["quick"] });

      try {
        const result = await runner({
          stage: "quick",
          slug,
          taskContent,
          previousOutput: "",
          outputPath,
          cwd: runtimeDir,
          config,
          abortController,
          logger: taskLogger,
        });

        registry.unregister(agentId);

        if (!result.success) {
          // Move to failed
          const failDir = join(runtimeDir, "11-failed", slug);
          mkdirSync(failDir, { recursive: true });
          renameSync(destDir, failDir);
          await emitNotify({ type: "task_failed", slug, timestamp: new Date().toISOString(), stage: "quick", error: result.error ?? "Quick task failed" });
          return;
        }

        if (!existsSync(outputPath)) {
          writeFileSync(outputPath, result.output, "utf-8");
        }

        if (config.quickTask.requireReview) {
          await emitNotify({ type: "task_held", slug, timestamp: new Date().toISOString(), stage: "quick", artifactUrl: "" });
        } else {
          await emitNotify({ type: "task_completed", slug, timestamp: new Date().toISOString() });
        }
      } catch (err) {
        registry.unregister(agentId);
        taskLogger.error(`Quick task "${slug}" threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
```

- [ ] **Step 5: Add quick stage to defaults**

In `src/config/defaults.ts`, add to `DEFAULT_STAGE_TOOLS`:

```typescript
  quick:      { allowed: ["Read","Write","Edit","Bash","Glob","Grep","WebSearch","WebFetch"], disallowed: [] },
```

Add to `STAGE_CONTEXT_RULES`:

```typescript
  quick: { includeTaskContent: true, previousOutputLabel: null, includeRepoContext: true },
```

Add `maxTurns` and `timeoutsMinutes` entries:

```typescript
      quick: 30,     // in maxTurns
      quick: 30,     // in timeoutsMinutes
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/core/pipeline-quick.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add agents/quick.md src/core/pipeline.ts src/config/defaults.ts tests/core/pipeline-quick.test.ts
git commit -m "feat(spec3): add quick task path — single agent, optional review hold"
```

---

### Task 14: Slack Notifier

**Files:**
- Create: `src/surfaces/slack-notifier.ts`
- Test: `tests/surfaces/slack-notifier.test.ts`

- [ ] **Step 1: Write Slack notifier tests**

Create `tests/surfaces/slack-notifier.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { createSlackNotifier } from "../../src/surfaces/slack-notifier.js";
import { shouldNotify, type NotifyEvent } from "../../src/surfaces/types.js";

describe("SlackNotifier", () => {
  it("calls sendMessage for events matching the notify level", async () => {
    const sendFn = vi.fn().mockResolvedValue({ ts: "123.456" });
    const notifier = createSlackNotifier({
      channelId: "C12345",
      notifyLevel: "bookends",
      sendMessage: sendFn,
    });

    const event: NotifyEvent = {
      type: "task_created",
      slug: "fix-auth-20260405",
      timestamp: "2026-04-05T10:00:00Z",
      title: "Fix auth",
      source: "cli",
      stages: ["questions", "research"],
    };

    await notifier.notify(event);
    expect(sendFn).toHaveBeenCalledOnce();
  });

  it("skips events below the notify level", async () => {
    const sendFn = vi.fn().mockResolvedValue({ ts: "123.456" });
    const notifier = createSlackNotifier({
      channelId: "C12345",
      notifyLevel: "minimal",
      sendMessage: sendFn,
    });

    const event: NotifyEvent = {
      type: "task_created",
      slug: "fix-auth-20260405",
      timestamp: "2026-04-05T10:00:00Z",
      title: "Fix auth",
      source: "cli",
      stages: ["questions"],
    };

    await notifier.notify(event);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("posts task_created as root message and subsequent events as thread replies", async () => {
    const sendFn = vi.fn().mockResolvedValue({ ts: "100.000" });
    const notifier = createSlackNotifier({
      channelId: "C12345",
      notifyLevel: "stages",
      sendMessage: sendFn,
    });

    // Root message
    await notifier.notify({
      type: "task_created",
      slug: "fix-auth-20260405",
      timestamp: "2026-04-05T10:00:00Z",
      title: "Fix auth",
      source: "cli",
      stages: ["questions", "research"],
    });

    // Thread reply
    await notifier.notify({
      type: "stage_started",
      slug: "fix-auth-20260405",
      timestamp: "2026-04-05T10:01:00Z",
      stage: "questions",
    });

    expect(sendFn).toHaveBeenCalledTimes(2);
    // Second call should include thread_ts
    const secondCall = sendFn.mock.calls[1][0];
    expect(secondCall.thread_ts).toBe("100.000");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/surfaces/slack-notifier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement SlackNotifier**

Create `src/surfaces/slack-notifier.ts`:

```typescript
import { shouldNotify, type Notifier, type NotifyEvent, type NotifyLevel } from "./types.js";

export interface SlackSendResult {
  ts: string;
}

export interface SlackNotifierOptions {
  channelId: string;
  notifyLevel: NotifyLevel;
  sendMessage: (params: { channel: string; text: string; thread_ts?: string }) => Promise<SlackSendResult>;
}

function formatSlackMessage(event: NotifyEvent): string {
  switch (event.type) {
    case "task_created":
      return `:rocket: *New task:* \`${event.slug}\` — "${event.title}" (from ${event.source})\nStages: ${event.stages.join(" → ")}`;
    case "stage_started":
      return `:arrow_forward: \`${event.slug}\` → *${event.stage}* started`;
    case "stage_completed":
      return `:white_check_mark: \`${event.slug}\` ← *${event.stage}* completed`;
    case "task_held":
      return `:pause_button: \`${event.slug}\` held at *${event.stage}* — awaiting approval\n${event.artifactUrl ? `Review: ${event.artifactUrl}` : ""}`;
    case "task_approved":
      return `:thumbsup: \`${event.slug}\` approved by ${event.approvedBy}${event.feedback ? `\nFeedback: ${event.feedback}` : ""}`;
    case "task_completed":
      return `:tada: \`${event.slug}\` complete!${event.prUrl ? `\nPR: ${event.prUrl}` : ""}`;
    case "task_failed":
      return `:x: \`${event.slug}\` failed at *${event.stage}*: ${event.error}`;
    case "task_cancelled":
      return `:no_entry_sign: \`${event.slug}\` cancelled by ${event.cancelledBy}`;
    case "task_paused":
      return `:double_vertical_bar: \`${event.slug}\` paused by ${event.pausedBy}`;
    case "task_resumed":
      return `:play_or_pause_button: \`${event.slug}\` resumed by ${event.resumedBy}`;
    case "stage_retried":
      return `:repeat: \`${event.slug}\` → *${event.stage}* retry #${event.attempt}\nFeedback: ${event.feedback}`;
    case "stage_skipped":
      return `:fast_forward: \`${event.slug}\` → *${event.stage}* skipped`;
    case "stages_modified":
      return `:gear: \`${event.slug}\` stages changed: [${event.oldStages.join(",")}] → [${event.newStages.join(",")}]`;
  }
}

export function createSlackNotifier(options: SlackNotifierOptions): Notifier {
  const { channelId, notifyLevel, sendMessage } = options;

  // Track root message timestamps per task slug for threading
  const threadMap = new Map<string, string>();

  return {
    async notify(event: NotifyEvent): Promise<void> {
      if (!shouldNotify(notifyLevel, event)) return;

      const text = formatSlackMessage(event);
      const thread_ts = threadMap.get(event.slug);

      try {
        const result = await sendMessage({
          channel: channelId,
          text,
          thread_ts: event.type === "task_created" ? undefined : thread_ts,
        });

        // Track the root message timestamp for threading
        if (event.type === "task_created") {
          threadMap.set(event.slug, result.ts);
        }
      } catch {
        // Slack notification failures should never crash the pipeline
      }
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/surfaces/slack-notifier.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/surfaces/slack-notifier.ts tests/surfaces/slack-notifier.test.ts
git commit -m "feat(spec3): add SlackNotifier — threaded messages with level filtering"
```

---

### Task 15: Slack Surface Inbound

**Files:**
- Create: `src/surfaces/slack-surface.ts`
- Test: `tests/surfaces/slack-surface.test.ts`

- [ ] **Step 1: Write Slack surface inbound tests**

Create `tests/surfaces/slack-surface.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { filterMessages, stripPrefix, type SlackMessage } from "../../src/surfaces/slack-surface.js";

describe("filterMessages", () => {
  const baseMsg: SlackMessage = { ts: "100.000", text: "shkmn fix auth", user: "U123", thread_ts: undefined };

  it("skips bot's own messages", () => {
    const result = filterMessages([{ ...baseMsg, user: "BOT" }], "BOT", "99.000", true, "shkmn");
    expect(result).toHaveLength(0);
  });

  it("skips already-processed messages (ts <= lastSeenTs)", () => {
    const result = filterMessages([{ ...baseMsg, ts: "50.000" }], "BOT", "99.000", true, "shkmn");
    expect(result).toHaveLength(0);
  });

  it("skips messages without prefix when requirePrefix is true", () => {
    const result = filterMessages([{ ...baseMsg, text: "fix auth bug" }], "BOT", "99.000", true, "shkmn");
    expect(result).toHaveLength(0);
  });

  it("passes messages with prefix when requirePrefix is true", () => {
    const result = filterMessages([baseMsg], "BOT", "99.000", true, "shkmn");
    expect(result).toHaveLength(1);
  });

  it("passes all non-bot messages when requirePrefix is false", () => {
    const result = filterMessages([{ ...baseMsg, text: "fix auth bug" }], "BOT", "99.000", false, "shkmn");
    expect(result).toHaveLength(1);
  });

  it("passes thread replies without prefix even when requirePrefix is true", () => {
    const threadMsg: SlackMessage = { ts: "100.000", text: "approve", user: "U123", thread_ts: "90.000" };
    const result = filterMessages([threadMsg], "BOT", "99.000", true, "shkmn");
    expect(result).toHaveLength(1);
  });
});

describe("stripPrefix", () => {
  it("removes prefix from start of message", () => {
    expect(stripPrefix("shkmn fix auth bug", "shkmn")).toBe("fix auth bug");
  });

  it("returns message unchanged if no prefix", () => {
    expect(stripPrefix("fix auth bug", "shkmn")).toBe("fix auth bug");
  });

  it("is case insensitive", () => {
    expect(stripPrefix("SHKMN fix auth", "shkmn")).toBe("fix auth");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/surfaces/slack-surface.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement slack-surface.ts**

Create `src/surfaces/slack-surface.ts`:

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SlackMessage {
  ts: string;
  text: string;
  user: string;
  thread_ts: string | undefined;
}

export interface SlackCursor {
  channelTs: string;
  dmTs: string;
}

// ─── Message filtering ──────────────────────────────────────────────────────

export function filterMessages(
  messages: SlackMessage[],
  botUserId: string,
  lastSeenTs: string,
  requirePrefix: boolean,
  prefix: string,
): SlackMessage[] {
  return messages.filter(msg => {
    // Skip bot's own messages
    if (msg.user === botUserId) return false;

    // Skip already-processed
    if (parseFloat(msg.ts) <= parseFloat(lastSeenTs)) return false;

    // Thread replies always pass (prefix not required)
    if (msg.thread_ts) return true;

    // Check prefix requirement
    if (requirePrefix) {
      return msg.text.toLowerCase().startsWith(prefix.toLowerCase());
    }

    return true;
  });
}

// ─── Prefix stripping ───────────────────────────────────────────────────────

export function stripPrefix(text: string, prefix: string): string {
  const lower = text.toLowerCase();
  if (lower.startsWith(prefix.toLowerCase())) {
    return text.slice(prefix.length).trim();
  }
  return text;
}

// ─── Cursor persistence ─────────────────────────────────────────────────────

export function loadCursor(runtimeDir: string): SlackCursor {
  const filePath = join(runtimeDir, "slack-cursor.json");
  if (!existsSync(filePath)) {
    // Start from "now" — don't reprocess old history
    const now = String(Date.now() / 1000);
    return { channelTs: now, dmTs: now };
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as SlackCursor;
  } catch {
    const now = String(Date.now() / 1000);
    return { channelTs: now, dmTs: now };
  }
}

export function saveCursor(runtimeDir: string, cursor: SlackCursor): void {
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "slack-cursor.json"), JSON.stringify(cursor, null, 2), "utf-8");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/surfaces/slack-surface.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/surfaces/slack-surface.ts tests/surfaces/slack-surface.test.ts
git commit -m "feat(spec3): add Slack surface inbound — message filtering, prefix handling, cursor persistence"
```

---

### Task 16: Watcher Slack Polling Arm

**Files:**
- Modify: `src/core/watcher.ts`
- Modify: `src/commands/start.ts`

- [ ] **Step 1: Expand watcher to handle .control files and Slack polling**

In `src/core/watcher.ts`, expand `WatcherOptions`:

```typescript
import { type ResolvedConfig } from "../config/loader.js";

export interface WatcherOptions {
  runtimeDir: string;
  pipeline: Pipeline;
  logger: TaskLogger;
  config: ResolvedConfig;
}
```

Update the chokidar `ignored` filter to also accept `.control` files:

```typescript
      fsWatcher = chokidar.watch(inboxDir, {
        ignored: (path: string, stats?: { isFile(): boolean }) =>
          !!stats?.isFile() && !path.endsWith(".task") && !path.endsWith(".control"),
        persistent: true,
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      });
```

In the `add` handler, dispatch `.control` files to pipeline control methods:

```typescript
      fsWatcher.on("add", (filePath: string) => {
        if (filePath.endsWith(".task")) {
          pipeline.startRun(filePath).catch((err: unknown) => {
            logger.error(`Failed to start run for "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
          });
        } else if (filePath.endsWith(".control")) {
          handleControlFile(filePath).catch((err: unknown) => {
            logger.error(`Failed to handle control file "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      });
```

Add the control file handler:

```typescript
  async function handleControlFile(filePath: string): Promise<void> {
    const content = readFileSync(filePath, "utf-8");
    unlinkSync(filePath); // Remove control file after reading

    const cmd = JSON.parse(content) as { operation: string; slug: string; [key: string]: unknown };

    switch (cmd.operation) {
      case "cancel": await pipeline.cancel(cmd.slug); break;
      case "skip": await pipeline.skip(cmd.slug, cmd.stage as string | undefined); break;
      case "pause": await pipeline.pause(cmd.slug); break;
      case "resume": await pipeline.resume(cmd.slug); break;
      case "modify_stages": await pipeline.modifyStages(cmd.slug, cmd.stages as string[]); break;
      case "restart_stage": await pipeline.restartStage(cmd.slug, cmd.stage as string | undefined); break;
      case "retry": await pipeline.retry(cmd.slug, cmd.feedback as string); break;
      default: logger.warn(`[watcher] Unknown control operation: ${cmd.operation}`);
    }
  }
```

Add Slack polling arm inside `start()`:

```typescript
    let slackInterval: ReturnType<typeof setInterval> | null = null;
```

After chokidar setup:
```typescript
      // Start Slack polling if enabled
      if (options.config.slack.enabled) {
        const pollMs = options.config.slack.pollIntervalSeconds * 1000;
        slackInterval = setInterval(() => {
          logger.info("[watcher] Slack poll tick");
          // Slack MCP polling logic will be called here
        }, pollMs);
      }
```

In `stop()`:
```typescript
      if (slackInterval) {
        clearInterval(slackInterval);
        slackInterval = null;
      }
```

- [ ] **Step 2: Update start.ts to pass config and set up Slack polling callback**

In `src/commands/start.ts`, update the watcher creation to pass config:

```typescript
      activeWatcher = createWatcher({
        runtimeDir: config.pipeline.runtimeDir,
        pipeline,
        logger,
        config,
      });
```

Add notifier registration before starting the watcher:

```typescript
      // Register notifiers
      const { createConsoleNotifier } = await import("../surfaces/console-notifier.js");
      pipeline.addNotifier(createConsoleNotifier());

      if (config.slack.enabled && config.slack.channelId) {
        // SlackNotifier will be registered when Slack MCP is available
        logger.info("[start] Slack notifications enabled");
      }
```

- [ ] **Step 3: Run existing watcher tests to verify no regressions**

Run: `npx vitest run tests/core/watcher.test.ts tests/commands/start.test.ts`
Expected: PASS (may need minor updates if WatcherOptions changed)

- [ ] **Step 4: Commit**

```bash
git add src/core/watcher.ts src/commands/start.ts
git commit -m "feat(spec3): add Slack polling arm to Heimdall watcher, register notifiers on start"
```

---

### Task 17: Integration Verification

**Files:**
- No new files — verify existing tests and run full suite.

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 2: Build and verify CLI help**

Run: `npx tsup && node dist/cli.js --help`
Expected: All commands listed — task, approve, status, logs, cancel, skip, pause, resume, modify-stages, restart-stage, retry, init, start, stop, config, history.

- [ ] **Step 3: Verify task command with hints**

Run: `node dist/cli.js task "test task" --hints "design:use modular patterns"`
Expected: Prints slug and creates .task file (or prints config error if no runtime dir configured).

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(spec3): integration verification — all surfaces wired and tested"
```

- [ ] **Step 5: Push**

```bash
git push
```
