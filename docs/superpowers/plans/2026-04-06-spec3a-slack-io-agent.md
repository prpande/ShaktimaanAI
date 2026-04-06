# Spec 3a: Slack I/O Agent (Narada) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the Slack integration by replacing stubs with an MCP-based Slack I/O agent (Narada) that reads and writes Slack messages through file-based queues.

**Architecture:** A dedicated Haiku-model agent (Narada) is spawned per poll tick by the watcher. It reads the outbox file, sends messages via MCP tools, reads the Slack channel for inbound messages, checks approval threads, and writes results to inbox/sent/cursor files. The watcher post-processes these files to create .task and .control files.

**Tech Stack:** TypeScript ESM, vitest, @anthropic-ai/claude-agent-sdk, chokidar, zod, MCP Slack tools

---

### Task 1: Config — Agent Names (Gargi + Narada swap, add slackIO)

**Files:**
- Modify: `src/config/defaults.ts:1-17`
- Modify: `tests/config/defaults.test.ts:4-27`

- [ ] **Step 1: Update test expectations for agent names**

In `tests/config/defaults.test.ts`, update the agent name tests:

```typescript
  it("has all 16 agent name entries", () => {
    expect(Object.keys(DEFAULT_AGENT_NAMES)).toHaveLength(16);
  });

  it("includes all expected agent roles", () => {
    const roles = [
      "questions", "research", "design", "structure", "plan",
      "workTree", "impl", "validate", "review", "pr",
      "watcher", "taskCreator", "approvalHandler", "intentClassifier",
      "slackIO",
    ];
    for (const role of roles) {
      expect(DEFAULT_AGENT_NAMES).toHaveProperty(role);
    }
  });

  it("maps questions to Gargi", () => {
    expect(DEFAULT_AGENT_NAMES.questions).toBe("Gargi");
  });

  it("maps slackIO to Narada", () => {
    expect(DEFAULT_AGENT_NAMES.slackIO).toBe("Narada");
  });

  it("maps watcher to Heimdall", () => {
    expect(DEFAULT_AGENT_NAMES.watcher).toBe("Heimdall");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config/defaults.test.ts`
Expected: FAIL — "Narada" !== "Gargi", no "slackIO" property, length 15 !== 16

- [ ] **Step 3: Update DEFAULT_AGENT_NAMES**

In `src/config/defaults.ts`, change lines 1-17:

```typescript
export const DEFAULT_AGENT_NAMES = {
  questions: "Gargi",
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
  quick: "Astra",
  slackIO: "Narada",
} as const satisfies Record<string, string>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config/defaults.test.ts`
Expected: PASS

- [ ] **Step 5: Update init test expectation**

In `tests/commands/init.test.ts`, line 37, change:
```typescript
    expect(config.agents.names.questions).toBe("Gargi");
```

- [ ] **Step 6: Run full test suite to check for breakage**

Run: `npx vitest run`
Expected: All 572+ tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/config/defaults.ts tests/config/defaults.test.ts tests/commands/init.test.ts
git commit -m "feat: rename questions agent to Gargi, add slackIO agent Narada"
```

---

### Task 2: Config — Per-Stage Model Override (`agents.models`)

**Files:**
- Modify: `src/config/defaults.ts:53-110,112-196`
- Modify: `src/config/schema.ts`
- Modify: `src/config/loader.ts:44-106`
- Modify: `tests/config/defaults.test.ts`
- Modify: `tests/config/schema.test.ts`

- [ ] **Step 1: Write failing test for agents.models in defaults**

In `tests/config/defaults.test.ts`, add inside `describe("DEFAULT_CONFIG", ...)`:

```typescript
  it("has agents.models with per-stage model assignments", () => {
    expect(DEFAULT_CONFIG.agents.models).toBeDefined();
    expect(DEFAULT_CONFIG.agents.models["slack-io"]).toBe("haiku");
    expect(DEFAULT_CONFIG.agents.models.classify).toBe("haiku");
    expect(DEFAULT_CONFIG.agents.models.impl).toBe("opus");
    expect(DEFAULT_CONFIG.agents.models.questions).toBe("sonnet");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config/defaults.test.ts`
Expected: FAIL — `models` is undefined

- [ ] **Step 3: Add `models` to ShkmnConfig interface**

In `src/config/defaults.ts`, inside the `agents` section of `ShkmnConfig` interface (after line 94 `tools:`), add:

```typescript
    models: Record<string, string>;
```

- [ ] **Step 4: Add `models` to DEFAULT_CONFIG**

In `src/config/defaults.ts`, inside `DEFAULT_CONFIG.agents` (after `tools: {},` around line 180), add:

```typescript
    models: {
      questions: "sonnet",
      research: "opus",
      design: "opus",
      structure: "sonnet",
      plan: "opus",
      impl: "opus",
      review: "sonnet",
      validate: "sonnet",
      pr: "sonnet",
      classify: "haiku",
      "slack-io": "haiku",
      quick: "sonnet",
    },
```

- [ ] **Step 5: Add `models` to Zod schema**

In `src/config/schema.ts`, inside the `agents:` section, add:

```typescript
    models: z.record(z.string(), z.string()).optional().default({}),
```

- [ ] **Step 6: Add `models` to resolveConfig**

In `src/config/loader.ts`, inside the `agents:` section of `resolveConfig` (after the `tools` merge), add:

```typescript
      models: { ...da.models, ...parsed.agents?.models },
```

- [ ] **Step 7: Add schema test**

In `tests/config/schema.test.ts`, add:

```typescript
  it("accepts agents.models override", () => {
    const result = configSchema.safeParse({
      pipeline: { runtimeDir: "/tmp" },
      agents: { models: { impl: "haiku", "slack-io": "opus" } },
    });
    expect(result.success).toBe(true);
  });
```

- [ ] **Step 8: Run tests**

Run: `npx vitest run tests/config/defaults.test.ts tests/config/schema.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/config/defaults.ts src/config/schema.ts src/config/loader.ts tests/config/defaults.test.ts tests/config/schema.test.ts
git commit -m "feat: add per-stage model override (agents.models) config"
```

---

### Task 3: Config — Slack dmUserIds + slack-io stage config

**Files:**
- Modify: `src/config/defaults.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/loader.ts`
- Modify: `tests/config/defaults.test.ts`

- [ ] **Step 1: Write failing test for dmUserIds and slack-io stage config**

In `tests/config/defaults.test.ts`:

```typescript
  it("has slack.dmUserIds defaulting to empty array", () => {
    expect(DEFAULT_CONFIG.slack.dmUserIds).toEqual([]);
  });
```

Add to `DEFAULT_STAGE_TOOLS` describe:

```typescript
  it("has entries for all 12 stages (including slack-io)", () => {
    const ALL_STAGES_WITH_SLACK = [...ALL_STAGES, "slack-io"];
    for (const stage of ALL_STAGES_WITH_SLACK) {
      expect(DEFAULT_STAGE_TOOLS).toHaveProperty(stage);
    }
    expect(Object.keys(DEFAULT_STAGE_TOOLS)).toHaveLength(12);
  });

  it("slack-io has MCP Slack tools and Read/Write", () => {
    const { allowed, disallowed } = DEFAULT_STAGE_TOOLS["slack-io"];
    expect(allowed).toContain("mcp__claude_ai_Slack__*");
    expect(allowed).toContain("Read");
    expect(allowed).toContain("Write");
    expect(disallowed).toContain("Bash");
  });
```

Add to `STAGE_CONTEXT_RULES` describe:

```typescript
  it("has entries for all 12 stages (including slack-io)", () => {
    const ALL_STAGES_WITH_SLACK = [...ALL_STAGES, "slack-io"];
    for (const stage of ALL_STAGES_WITH_SLACK) {
      expect(STAGE_CONTEXT_RULES).toHaveProperty(stage);
    }
    expect(Object.keys(STAGE_CONTEXT_RULES)).toHaveLength(12);
  });

  it("slack-io includes task content but no repo context", () => {
    expect(STAGE_CONTEXT_RULES["slack-io"].includeTaskContent).toBe(true);
    expect(STAGE_CONTEXT_RULES["slack-io"].includeRepoContext).toBe(false);
    expect(STAGE_CONTEXT_RULES["slack-io"].previousOutputLabel).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify failures**

Run: `npx vitest run tests/config/defaults.test.ts`
Expected: FAIL — dmUserIds undefined, slack-io missing from stage tools/rules, counts wrong

- [ ] **Step 3: Add dmUserIds to ShkmnConfig, DEFAULT_CONFIG, schema, loader**

In `src/config/defaults.ts`, add to `ShkmnConfig.slack`:
```typescript
    dmUserIds: string[];
```

In `DEFAULT_CONFIG.slack`, add:
```typescript
    dmUserIds: [],
```

In `src/config/schema.ts`, add inside the `slack:` section:
```typescript
    dmUserIds: z.array(z.string()).optional().default([]),
```

In `src/config/loader.ts`, add inside the `slack:` resolution:
```typescript
      dmUserIds: parsed.slack?.dmUserIds ?? d.slack.dmUserIds,
```

- [ ] **Step 4: Add slack-io to DEFAULT_STAGE_TOOLS and STAGE_CONTEXT_RULES**

In `src/config/defaults.ts`, add to `DEFAULT_STAGE_TOOLS`:
```typescript
  "slack-io":  { allowed: ["mcp__claude_ai_Slack__*","Read","Write"], disallowed: ["Edit","Bash","Glob","Grep"] },
```

Add to `STAGE_CONTEXT_RULES`:
```typescript
  "slack-io": { includeTaskContent: true, previousOutputLabel: null, includeRepoContext: false },
```

Add to `DEFAULT_CONFIG.agents.maxTurns`:
```typescript
      "slack-io": 15,
```

Add to `DEFAULT_CONFIG.agents.timeoutsMinutes`:
```typescript
      "slack-io": 2,
```

- [ ] **Step 5: Fix count assertions in existing tests**

In `tests/config/defaults.test.ts`, update the original `DEFAULT_STAGE_TOOLS` count test:
```typescript
  it("has entries for all 12 stages", () => {
```
And change `toHaveLength(11)` to `toHaveLength(12)`.

Update the original `STAGE_CONTEXT_RULES` count test similarly: `toHaveLength(11)` → `toHaveLength(12)`.

Update the `ALL_STAGES` arrays to include `"slack-io"`.

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/config/defaults.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/config/defaults.ts src/config/schema.ts src/config/loader.ts tests/config/defaults.test.ts
git commit -m "feat: add slack.dmUserIds config and slack-io stage tools/context/timeouts"
```

---

### Task 4: Agent Runner — Per-stage model override

**Files:**
- Modify: `src/core/agent-runner.ts:182-228`
- Modify: `tests/core/agent-runner.test.ts`

- [ ] **Step 1: Write failing test for model override**

In `tests/core/agent-runner.test.ts`, find or add a describe block for `resolveModel` and add:

```typescript
import { resolveToolPermissions, resolveMaxTurns, resolveTimeoutMinutes } from "../../src/core/agent-runner.js";

describe("model resolution", () => {
  it("returns model from config.agents.models when set", () => {
    const config = makeConfig({ models: { impl: "haiku" } });
    expect(config.agents.models.impl).toBe("haiku");
  });

  it("returns undefined for stages not in config.agents.models", () => {
    const config = makeConfig();
    expect(config.agents.models["nonexistent"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it passes (config plumbing works)**

Run: `npx vitest run tests/core/agent-runner.test.ts`
Expected: PASS (this validates the config flow; the actual SDK `model` param is integration-level)

- [ ] **Step 3: Update runAgent to pass model to SDK**

In `src/core/agent-runner.ts`, inside `runAgent()`, after `const timeoutMs = ...` (around line 194), add:

```typescript
  const model = config.agents.models?.[stage];
```

Then in the `query()` call options (around line 213-228), add `model` to the options object:

```typescript
    const messages = query({
      prompt: systemPrompt,
      options: {
        ...(model ? { model } : {}),
        allowedTools,
        disallowedTools,
        maxTurns,
        cwd,
        abortController,
        permissionMode: "bypassPermissions" as const,
        allowDangerouslySkipPermissions: true,
      },
    });
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/agent-runner.ts tests/core/agent-runner.test.ts
git commit -m "feat: pass per-stage model override to Agent SDK query()"
```

---

### Task 5: NotifyEvent — Add slackThread to task_created

**Files:**
- Modify: `src/surfaces/types.ts:15`
- Modify: `tests/surfaces/types.test.ts`

- [ ] **Step 1: Add slackThread to task_created event type**

In `src/surfaces/types.ts`, line 15, change:

```typescript
  | ({ type: "task_created";    title: string; source: string; stages: string[] } & EventBase)
```

to:

```typescript
  | ({ type: "task_created";    title: string; source: string; stages: string[]; slackThread?: string } & EventBase)
```

- [ ] **Step 2: Run tests to verify nothing breaks**

Run: `npx vitest run tests/surfaces/`
Expected: All PASS (optional field, no existing tests check for it)

- [ ] **Step 3: Commit**

```bash
git add src/surfaces/types.ts
git commit -m "feat: add optional slackThread field to task_created NotifyEvent"
```

---

### Task 6: Pipeline — Emit task_approved event

**Files:**
- Modify: `src/core/pipeline.ts:688-723`
- Modify: `tests/core/pipeline-control.test.ts`

- [ ] **Step 1: Write failing test**

In `tests/core/pipeline-control.test.ts`, add after the `addNotifier` describe block:

```typescript
describe("approveAndResume", () => {
  it("emits task_approved event", async () => {
    const slug = "approve-notify";
    setupTaskInDir(slug, "12-hold", {
      currentStage: "questions",
      status: "hold",
      stages: ["questions", "research", "impl"],
    });

    const events: NotifyEvent[] = [];
    const testNotifier: Notifier = {
      async notify(event: NotifyEvent) { events.push(event); },
    };

    const config = makeConfig();
    const registry = createAgentRegistry(5);
    const pipeline = createPipeline({ config, registry, runner: noopRunner, logger: noopLogger });
    pipeline.addNotifier(testNotifier);

    await pipeline.approveAndResume(slug, "looks good");

    expect(events.some(e => e.type === "task_approved")).toBe(true);
    const approved = events.find(e => e.type === "task_approved")!;
    expect(approved).toMatchObject({
      type: "task_approved",
      slug: "approve-notify",
      approvedBy: "user",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/pipeline-control.test.ts`
Expected: FAIL — no task_approved event emitted

- [ ] **Step 3: Add event emission to approveAndResume**

In `src/core/pipeline.ts`, inside `approveAndResume()`, add after `writeRunState(holdDir, state);` (line 716) and before the `moveTaskDir` call (line 717):

```typescript
      emitNotify({
        type: "task_approved",
        slug,
        approvedBy: "user",
        feedback: feedback ?? "",
        timestamp: new Date().toISOString(),
      });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/pipeline-control.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/pipeline.ts tests/core/pipeline-control.test.ts
git commit -m "fix: emit task_approved event in approveAndResume"
```

---

### Task 7: Pipeline — Add slackThread to task_created event emission

**Files:**
- Modify: `src/core/pipeline.ts:670-677`

- [ ] **Step 1: Update startRun event emission**

In `src/core/pipeline.ts`, change the `task_created` event at lines 670-677 from:

```typescript
      emitNotify({
        type: "task_created",
        slug,
        title: slug,
        source: "cli",
        stages: state.stages,
        timestamp: new Date().toISOString(),
      });
```

to:

```typescript
      emitNotify({
        type: "task_created",
        slug,
        title: slug,
        source: "cli",
        stages: state.stages,
        slackThread: taskMeta.slackThread || undefined,
        timestamp: new Date().toISOString(),
      });
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/core/pipeline.ts
git commit -m "feat: include slackThread in task_created event from task metadata"
```

---

### Task 8: Slack Notifier — Rewrite to use file-based outbox

**Files:**
- Modify: `src/surfaces/slack-notifier.ts` (full rewrite)
- Modify: `tests/surfaces/slack-notifier.test.ts` (full rewrite)

- [ ] **Step 1: Write new tests for file-based outbox notifier**

Replace `tests/surfaces/slack-notifier.test.ts` entirely:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createSlackNotifier } from "../../src/surfaces/slack-notifier.js";
import type { NotifyEvent } from "../../src/surfaces/types.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

let TEST_DIR: string;

function makeEvent<T extends NotifyEvent["type"]>(
  type: T,
  slug: string,
  extra: Omit<Extract<NotifyEvent, { type: T }>, "type" | "slug" | "timestamp">,
): Extract<NotifyEvent, { type: T }> {
  return {
    type,
    slug,
    timestamp: "2026-01-01T12:00:00.000Z",
    ...extra,
  } as Extract<NotifyEvent, { type: T }>;
}

function readOutbox(): Array<Record<string, unknown>> {
  const outboxPath = join(TEST_DIR, "slack-outbox.jsonl");
  if (!existsSync(outboxPath)) return [];
  const content = readFileSync(outboxPath, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line));
}

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `shkmn-slack-notifier-${randomUUID()}`);
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SlackNotifier (file-based outbox)", () => {
  describe("notify level filtering", () => {
    it("appends task_failed to outbox at minimal level", async () => {
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "minimal", runtimeDir: TEST_DIR });
      await notifier.notify(makeEvent("task_failed", "my-task", { stage: "impl", error: "tests failed" }));
      expect(readOutbox()).toHaveLength(1);
    });

    it("skips task_created at minimal level", async () => {
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "minimal", runtimeDir: TEST_DIR });
      await notifier.notify(makeEvent("task_created", "my-task", { title: "T", source: "cli", stages: ["impl"] }));
      expect(readOutbox()).toHaveLength(0);
    });

    it("appends task_created at bookends level", async () => {
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "bookends", runtimeDir: TEST_DIR });
      await notifier.notify(makeEvent("task_created", "my-task", { title: "T", source: "cli", stages: ["impl"] }));
      expect(readOutbox()).toHaveLength(1);
    });

    it("appends all events at stages level", async () => {
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", runtimeDir: TEST_DIR });
      await notifier.notify(makeEvent("stage_started", "my-task", { stage: "impl" }));
      await notifier.notify(makeEvent("stage_completed", "my-task", { stage: "impl", artifactPath: "/tmp/out.md" }));
      expect(readOutbox()).toHaveLength(2);
    });
  });

  describe("outbox entry format", () => {
    it("writes correct fields to outbox JSONL", async () => {
      const notifier = createSlackNotifier({ channelId: "C999", notifyLevel: "stages", runtimeDir: TEST_DIR });
      await notifier.notify(makeEvent("task_created", "my-slug", { title: "Fix bug", source: "cli", stages: ["impl"] }));
      const entries = readOutbox();
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry.slug).toBe("my-slug");
      expect(entry.type).toBe("task_created");
      expect(entry.channel).toBe("C999");
      expect(entry.text).toContain("Fix bug");
      expect(entry.id).toMatch(/^evt-/);
      expect(entry.addedAt).toBeDefined();
    });
  });

  describe("threading via slack-threads.json", () => {
    it("sets thread_ts to null for task_created (root message)", async () => {
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", runtimeDir: TEST_DIR });
      await notifier.notify(makeEvent("task_created", "my-task", { title: "T", source: "cli", stages: ["impl"] }));
      const entries = readOutbox();
      expect(entries[0].thread_ts).toBeNull();
    });

    it("reads thread_ts from slack-threads.json for non-created events", async () => {
      // Pre-populate thread map
      writeFileSync(join(TEST_DIR, "slack-threads.json"), JSON.stringify({ "my-task": "1234567890.000100" }));
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", runtimeDir: TEST_DIR });
      await notifier.notify(makeEvent("stage_started", "my-task", { stage: "impl" }));
      const entries = readOutbox();
      expect(entries[0].thread_ts).toBe("1234567890.000100");
    });

    it("sets thread_ts to null when slug not in thread map", async () => {
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", runtimeDir: TEST_DIR });
      await notifier.notify(makeEvent("stage_started", "unknown-slug", { stage: "impl" }));
      const entries = readOutbox();
      expect(entries[0].thread_ts).toBeNull();
    });

    it("uses slackThread from task_created event as thread_ts", async () => {
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", runtimeDir: TEST_DIR });
      await notifier.notify(makeEvent("task_created", "slack-task", { title: "T", source: "slack", stages: ["impl"], slackThread: "9999999999.000001" }));
      const entries = readOutbox();
      expect(entries[0].thread_ts).toBe("9999999999.000001");
    });
  });

  describe("error handling", () => {
    it("does not throw if runtimeDir is missing", async () => {
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", runtimeDir: "/nonexistent/path" });
      await expect(
        notifier.notify(makeEvent("stage_started", "my-task", { stage: "impl" })),
      ).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run test to verify failures**

Run: `npx vitest run tests/surfaces/slack-notifier.test.ts`
Expected: FAIL — old SlackNotifier expects sendMessage callback

- [ ] **Step 3: Rewrite slack-notifier.ts**

Replace `src/surfaces/slack-notifier.ts` entirely:

```typescript
import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { Notifier, NotifyEvent, NotifyLevel } from "./types.js";
import { shouldNotify } from "./types.js";

// ─── Options ──────────────────────────────────────────────────────────────────

export interface SlackNotifierOptions {
  channelId: string;
  notifyLevel: NotifyLevel;
  runtimeDir: string;
}

// ─── formatEvent ─────────────────────────────────────────────────────────────

export function formatEvent(event: NotifyEvent): string {
  const slug = `\`${event.slug}\``;

  switch (event.type) {
    case "task_created":
      return `:rocket: *Task created* ${slug} — *${event.title}* (source: ${event.source}) stages: [${event.stages.join(", ")}]`;

    case "stage_started":
      return `:arrow_forward: *Stage started* ${slug} — \`${event.stage}\``;

    case "stage_completed":
      return `:white_check_mark: *Stage completed* ${slug} — \`${event.stage}\` artifact: ${event.artifactPath}`;

    case "task_held":
      return `:hand: *Task held* ${slug} — stage \`${event.stage}\` awaiting review: ${event.artifactUrl}`;

    case "task_approved": {
      const fb = event.feedback != null ? ` — feedback: "${event.feedback}"` : "";
      return `:thumbsup: *Task approved* ${slug} by ${event.approvedBy}${fb}`;
    }

    case "task_completed": {
      const pr = event.prUrl != null ? ` PR: ${event.prUrl}` : "";
      return `:tada: *Task completed* ${slug}${pr}`;
    }

    case "task_failed":
      return `:x: *Task failed* ${slug} — stage \`${event.stage}\` error: "${event.error}"`;

    case "task_cancelled":
      return `:no_entry_sign: *Task cancelled* ${slug} by ${event.cancelledBy}`;

    case "task_paused":
      return `:double_vertical_bar: *Task paused* ${slug} by ${event.pausedBy}`;

    case "task_resumed":
      return `:arrow_forward: *Task resumed* ${slug} by ${event.resumedBy}`;

    case "stage_retried":
      return `:repeat: *Stage retried* ${slug} — \`${event.stage}\` attempt ${event.attempt} feedback: "${event.feedback}"`;

    case "stage_skipped":
      return `:fast_forward: *Stage skipped* ${slug} — \`${event.stage}\``;

    case "stages_modified":
      return `:pencil: *Stages modified* ${slug} — old: [${event.oldStages.join(", ")}] new: [${event.newStages.join(", ")}]`;
  }
}

// ─── Thread map helpers ─────────────────────────────────────────────────────

function loadThreadMap(runtimeDir: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(runtimeDir, "slack-threads.json"), "utf-8"));
  } catch {
    return {};
  }
}

// ─── createSlackNotifier ──────────────────────────────────────────────────────

export function createSlackNotifier(options: SlackNotifierOptions): Notifier {
  const { channelId, notifyLevel, runtimeDir } = options;
  const outboxPath = join(runtimeDir, "slack-outbox.jsonl");

  return {
    async notify(event: NotifyEvent): Promise<void> {
      if (!shouldNotify(notifyLevel, event)) return;

      const text = formatEvent(event);
      const threadMap = loadThreadMap(runtimeDir);

      let thread_ts: string | null = null;
      if (event.type === "task_created" && "slackThread" in event && event.slackThread) {
        thread_ts = event.slackThread;
      } else if (event.type !== "task_created") {
        thread_ts = threadMap[event.slug] ?? null;
      }

      const id = `evt-${Date.now()}-${randomBytes(3).toString("hex")}`;
      const entry = {
        id,
        slug: event.slug,
        type: event.type,
        channel: channelId,
        text,
        thread_ts,
        addedAt: new Date().toISOString(),
      };

      try {
        mkdirSync(dirname(outboxPath), { recursive: true });
        appendFileSync(outboxPath, JSON.stringify(entry) + "\n", "utf-8");
      } catch {
        // swallow errors silently — never crash the pipeline
      }
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/surfaces/slack-notifier.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/surfaces/slack-notifier.ts tests/surfaces/slack-notifier.test.ts
git commit -m "feat: rewrite SlackNotifier to use file-based outbox queue"
```

---

### Task 9: Slack Surface — Remove fetchChannelMessages, keep utilities

**Files:**
- Modify: `src/surfaces/slack-surface.ts`
- Modify: `tests/surfaces/slack-surface.test.ts`

- [ ] **Step 1: Remove fetchChannelMessages and getBotUserId**

In `src/surfaces/slack-surface.ts`, remove the `fetchChannelMessages()` function, the `getBotUserId()` function, and the `cachedBotUserId` variable. Keep everything else (SlackMessage, SlackCursor, filterMessages, stripPrefix, loadCursor, saveCursor).

The file should become:

```typescript
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── filterMessages ───────────────────────────────────────────────────────────

export function filterMessages(
  messages: SlackMessage[],
  botUserId: string,
  lastSeenTs: string,
  requirePrefix: boolean,
  prefix: string,
): SlackMessage[] {
  return messages.filter((msg) => {
    if (msg.user === botUserId) return false;
    if (parseFloat(msg.ts) <= parseFloat(lastSeenTs)) return false;
    if (msg.thread_ts !== undefined) return true;
    if (requirePrefix) {
      return msg.text.toLowerCase().startsWith(prefix.toLowerCase());
    }
    return true;
  });
}

// ─── stripPrefix ─────────────────────────────────────────────────────────────

export function stripPrefix(text: string, prefix: string): string {
  if (text.toLowerCase().startsWith(prefix.toLowerCase())) {
    return text.slice(prefix.length).trim();
  }
  return text;
}

// ─── Cursor persistence ───────────────────────────────────────────────────────

const CURSOR_FILENAME = "slack-cursor.json";
const DEFAULT_CURSOR: SlackCursor = { channelTs: "now", dmTs: "now" };

export function loadCursor(runtimeDir: string): SlackCursor {
  const filePath = path.join(runtimeDir, CURSOR_FILENAME);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as SlackCursor;
  } catch {
    return { ...DEFAULT_CURSOR };
  }
}

export function saveCursor(runtimeDir: string, cursor: SlackCursor): void {
  const filePath = path.join(runtimeDir, CURSOR_FILENAME);
  fs.writeFileSync(filePath, JSON.stringify(cursor, null, 2), "utf8");
}
```

- [ ] **Step 2: Run existing surface tests**

Run: `npx vitest run tests/surfaces/slack-surface.test.ts`
Expected: All PASS (tests only cover filterMessages, stripPrefix, cursor — not fetchChannelMessages)

- [ ] **Step 3: Commit**

```bash
git add src/surfaces/slack-surface.ts
git commit -m "refactor: remove fetchChannelMessages REST code, replaced by Narada MCP agent"
```

---

### Task 10: Slack Queue Utilities (new module)

**Files:**
- Create: `src/core/slack-queue.ts`
- Create: `tests/core/slack-queue.test.ts`

- [ ] **Step 1: Write tests for slack queue utilities**

Create `tests/core/slack-queue.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  readOutbox,
  readInbox,
  clearInbox,
  readSentLog,
  loadThreadMap,
  saveThreadMap,
  buildNaradaPayload,
} from "../../src/core/slack-queue.js";

let TEST_DIR: string;

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `shkmn-slack-queue-${randomUUID()}`);
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("readOutbox", () => {
  it("returns empty array when file does not exist", () => {
    expect(readOutbox(TEST_DIR)).toEqual([]);
  });

  it("parses JSONL lines into array", () => {
    const outboxPath = join(TEST_DIR, "slack-outbox.jsonl");
    writeFileSync(outboxPath, '{"id":"a","text":"hello"}\n{"id":"b","text":"world"}\n');
    const entries = readOutbox(TEST_DIR);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe("a");
    expect(entries[1].id).toBe("b");
  });

  it("skips blank lines", () => {
    const outboxPath = join(TEST_DIR, "slack-outbox.jsonl");
    writeFileSync(outboxPath, '{"id":"a"}\n\n{"id":"b"}\n');
    expect(readOutbox(TEST_DIR)).toHaveLength(2);
  });
});

describe("readInbox", () => {
  it("returns empty array when file does not exist", () => {
    expect(readInbox(TEST_DIR)).toEqual([]);
  });

  it("parses JSONL lines", () => {
    writeFileSync(join(TEST_DIR, "slack-inbox.jsonl"), '{"ts":"1","text":"hi"}\n');
    expect(readInbox(TEST_DIR)).toHaveLength(1);
  });
});

describe("clearInbox", () => {
  it("writes empty file", () => {
    writeFileSync(join(TEST_DIR, "slack-inbox.jsonl"), '{"ts":"1"}\n');
    clearInbox(TEST_DIR);
    expect(readFileSync(join(TEST_DIR, "slack-inbox.jsonl"), "utf-8")).toBe("");
  });
});

describe("readSentLog", () => {
  it("returns empty array when file does not exist", () => {
    expect(readSentLog(TEST_DIR)).toEqual([]);
  });

  it("parses JSONL lines", () => {
    writeFileSync(join(TEST_DIR, "slack-sent.jsonl"), '{"id":"evt-1","ts":"1.1"}\n');
    expect(readSentLog(TEST_DIR)).toHaveLength(1);
  });
});

describe("loadThreadMap / saveThreadMap", () => {
  it("returns empty object when file does not exist", () => {
    expect(loadThreadMap(TEST_DIR)).toEqual({});
  });

  it("round-trips thread map", () => {
    saveThreadMap(TEST_DIR, { "slug-a": "1.1", "slug-b": "2.2" });
    expect(loadThreadMap(TEST_DIR)).toEqual({ "slug-a": "1.1", "slug-b": "2.2" });
  });
});

describe("buildNaradaPayload", () => {
  it("builds correct payload from queue state", () => {
    // Setup outbox
    writeFileSync(join(TEST_DIR, "slack-outbox.jsonl"), '{"id":"evt-1","slug":"s1","text":"hi","channel":"C1","thread_ts":null}\n');

    // Setup cursor
    writeFileSync(join(TEST_DIR, "slack-cursor.json"), '{"channelTs":"100.0","dmTs":"100.0"}');

    // Setup thread map with a held task
    saveThreadMap(TEST_DIR, { "held-task": "200.0" });

    const payload = buildNaradaPayload(TEST_DIR, {
      channelId: "C1",
      allowDMs: false,
      dmUserIds: [],
      heldSlugs: ["held-task"],
    });

    expect(payload.outbox).toHaveLength(1);
    expect(payload.inbound.channelId).toBe("C1");
    expect(payload.inbound.oldest).toBe("100.0");
    expect(payload.approvalChecks).toHaveLength(1);
    expect(payload.approvalChecks[0].slug).toBe("held-task");
    expect(payload.approvalChecks[0].thread_ts).toBe("200.0");
  });

  it("skips approval checks for held tasks without threads", () => {
    writeFileSync(join(TEST_DIR, "slack-cursor.json"), '{"channelTs":"100.0","dmTs":"100.0"}');

    const payload = buildNaradaPayload(TEST_DIR, {
      channelId: "C1",
      allowDMs: false,
      dmUserIds: [],
      heldSlugs: ["no-thread-task"],
    });

    expect(payload.approvalChecks).toHaveLength(0);
  });

  it("includes DM user IDs when allowDMs is true", () => {
    writeFileSync(join(TEST_DIR, "slack-cursor.json"), '{"channelTs":"100.0","dmTs":"50.0"}');

    const payload = buildNaradaPayload(TEST_DIR, {
      channelId: "C1",
      allowDMs: true,
      dmUserIds: ["U111", "U222"],
      heldSlugs: [],
    });

    expect(payload.inbound.dmUserIds).toEqual(["U111", "U222"]);
    expect(payload.inbound.dmOldest).toBe("50.0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/slack-queue.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement slack-queue.ts**

Create `src/core/slack-queue.ts`:

```typescript
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OutboxEntry {
  id: string;
  slug: string;
  type: string;
  channel: string;
  text: string;
  thread_ts: string | null;
  addedAt: string;
}

export interface InboxEntry {
  ts: string;
  text: string;
  user: string;
  thread_ts?: string;
  channel: string;
  isApproval?: boolean;
  slug?: string;
}

export interface SentEntry {
  id: string;
  slug: string;
  ts: string;
  sentAt: string;
}

export interface NaradaPayload {
  outbox: OutboxEntry[];
  inbound: {
    channelId: string;
    oldest: string;
    dmUserIds: string[];
    dmOldest: string;
  };
  approvalChecks: Array<{ slug: string; thread_ts: string }>;
  files: {
    outbox: string;
    inbox: string;
    sent: string;
    threads: string;
    cursor: string;
  };
}

// ─── File helpers ───────────────────────────────────────────────────────────

function readJsonl<T>(filePath: string): T[] {
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    if (!content) return [];
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

// ─── Queue operations ───────────────────────────────────────────────────────

export function readOutbox(runtimeDir: string): OutboxEntry[] {
  return readJsonl<OutboxEntry>(join(runtimeDir, "slack-outbox.jsonl"));
}

export function readInbox(runtimeDir: string): InboxEntry[] {
  return readJsonl<InboxEntry>(join(runtimeDir, "slack-inbox.jsonl"));
}

export function clearInbox(runtimeDir: string): void {
  writeFileSync(join(runtimeDir, "slack-inbox.jsonl"), "", "utf-8");
}

export function readSentLog(runtimeDir: string): SentEntry[] {
  return readJsonl<SentEntry>(join(runtimeDir, "slack-sent.jsonl"));
}

export function loadThreadMap(runtimeDir: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(runtimeDir, "slack-threads.json"), "utf-8"));
  } catch {
    return {};
  }
}

export function saveThreadMap(runtimeDir: string, map: Record<string, string>): void {
  writeFileSync(join(runtimeDir, "slack-threads.json"), JSON.stringify(map, null, 2), "utf-8");
}

// ─── Payload builder ────────────────────────────────────────────────────────

export function buildNaradaPayload(
  runtimeDir: string,
  opts: {
    channelId: string;
    allowDMs: boolean;
    dmUserIds: string[];
    heldSlugs: string[];
  },
): NaradaPayload {
  const outbox = readOutbox(runtimeDir);
  const threadMap = loadThreadMap(runtimeDir);

  let channelTs = "now";
  let dmTs = "now";
  try {
    const cursor = JSON.parse(readFileSync(join(runtimeDir, "slack-cursor.json"), "utf-8"));
    channelTs = cursor.channelTs ?? "now";
    dmTs = cursor.dmTs ?? "now";
  } catch { /* use defaults */ }

  const approvalChecks: Array<{ slug: string; thread_ts: string }> = [];
  for (const slug of opts.heldSlugs) {
    if (threadMap[slug]) {
      approvalChecks.push({ slug, thread_ts: threadMap[slug] });
    }
  }

  return {
    outbox,
    inbound: {
      channelId: opts.channelId,
      oldest: channelTs,
      dmUserIds: opts.allowDMs ? opts.dmUserIds : [],
      dmOldest: dmTs,
    },
    approvalChecks,
    files: {
      outbox: join(runtimeDir, "slack-outbox.jsonl"),
      inbox: join(runtimeDir, "slack-inbox.jsonl"),
      sent: join(runtimeDir, "slack-sent.jsonl"),
      threads: join(runtimeDir, "slack-threads.json"),
      cursor: join(runtimeDir, "slack-cursor.json"),
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/core/slack-queue.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/slack-queue.ts tests/core/slack-queue.test.ts
git commit -m "feat: add slack queue utilities (outbox, inbox, sent log, thread map, payload builder)"
```

---

### Task 11: Narada Agent Prompt

**Files:**
- Create: `agents/slack-io.md`

- [ ] **Step 1: Write the agent prompt**

Create `agents/slack-io.md`:

```markdown
# Instructions

You are the Slack I/O agent. Your job is to send outbound messages and read inbound messages from Slack using MCP tools, then write results to files.

Your task content is a JSON payload with `outbox`, `inbound`, `approvalChecks`, and `files` sections.

## Step 1 — Send Outbox Messages

1. Read the outbox file at `files.outbox`
2. For each entry, call `mcp__claude_ai_Slack__slack_send_message` with:
   - `channel_id`: entry.channel
   - `text`: entry.text
   - `thread_ts`: entry.thread_ts (omit if null)
3. After each successful send, append a line to `files.sent`:
   `{"id": "<entry.id>", "slug": "<entry.slug>", "ts": "<returned ts>", "sentAt": "<ISO timestamp>"}`
4. If the entry type is `task_created`, also update `files.threads` — read the current JSON object, add `"<slug>": "<returned ts>"`, write it back.
5. After processing all entries, re-write `files.outbox` with ONLY the entries that failed to send. If all succeeded, write an empty file.

## Step 2 — Read Inbound Messages

1. Call `mcp__claude_ai_Slack__slack_read_channel` with `channel_id` = `inbound.channelId` and `oldest` = `inbound.oldest`
2. If `inbound.dmUserIds` is non-empty, call `mcp__claude_ai_Slack__slack_read_channel` for each user ID with `oldest` = `inbound.dmOldest`
3. For each new message, write a line to `files.inbox`:
   `{"ts": "<ts>", "text": "<text>", "user": "<user>", "thread_ts": "<thread_ts or omit>", "channel": "<channel>"}`

## Step 3 — Check Approval Threads

1. For each entry in `approvalChecks`, call `mcp__claude_ai_Slack__slack_read_thread` with `channel_id` = `inbound.channelId` and `message_ts` = entry.thread_ts
2. Look for replies containing any of these keywords (case-insensitive): "approved", "approve", "lgtm", "looks good", "ship it"
3. If found, write to `files.inbox`:
   `{"ts": "<ts>", "text": "<text>", "user": "<user>", "thread_ts": "<thread_ts>", "channel": "<channel>", "isApproval": true, "slug": "<slug>"}`

## Step 4 — Update Cursor

1. Read `files.cursor` (JSON with `channelTs` and `dmTs`)
2. Set `channelTs` to the newest message timestamp seen from channel reads
3. Set `dmTs` to the newest message timestamp seen from DM reads (if any)
4. Write the updated cursor back to `files.cursor`

## Error Handling

- If a `slack_send_message` fails, leave the entry in the outbox (do not add to sent log)
- If `slack_read_channel` fails, write an empty inbox and continue to the next step
- If `slack_read_thread` fails for a thread, skip it and continue to the next
- Never crash — complete as many steps as possible

## Output

Write a brief summary of what was done: how many messages sent, how many received, how many approvals detected.
```

- [ ] **Step 2: Commit**

```bash
git add agents/slack-io.md
git commit -m "feat: add Narada (slack-io) agent prompt for MCP-based Slack I/O"
```

---

### Task 12: Watcher — Agent-mediated Slack polling

**Files:**
- Modify: `src/core/watcher.ts` (major rewrite of pollSlack and imports)
- Modify: `tests/core/watcher.test.ts`

- [ ] **Step 1: Write new watcher Slack polling tests**

In `tests/core/watcher.test.ts`, add:

```typescript
import { writeFileSync, readFileSync, existsSync } from "node:fs";

describe("Slack polling integration", () => {
  it("builds Narada payload and calls runner with slack-io stage", async () => {
    const runnerCalls: Array<{ stage: string }> = [];
    const slackRunner = async (opts: any) => {
      runnerCalls.push({ stage: opts.stage });
      return { success: true, output: "done", costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 50 };
    };

    const slackConfig = {
      ...DEFAULT_CONFIG,
      slack: { ...DEFAULT_CONFIG.slack, enabled: true, channelId: "C123" },
      pipeline: { ...DEFAULT_CONFIG.pipeline, runtimeDir: TEST_DIR },
    };

    // Write cursor so pollSlack doesn't use "now"
    writeFileSync(join(TEST_DIR, "slack-cursor.json"), '{"channelTs":"100.0","dmTs":"100.0"}');

    const pipeline = makeMockPipeline();
    const watcher = createWatcher({
      runtimeDir: TEST_DIR,
      pipeline,
      logger: mockLogger,
      config: slackConfig,
      runner: slackRunner,
    });

    watcher.start();
    await delay(1000);

    // Trigger one poll cycle
    await delay(slackConfig.slack.pollIntervalSeconds * 1000 + 1000);

    await watcher.stop();

    expect(runnerCalls.length).toBeGreaterThanOrEqual(1);
    expect(runnerCalls[0].stage).toBe("slack-io");
  }, 40000);

  it("processes inbox approval entries as .control files", async () => {
    const slackConfig = {
      ...DEFAULT_CONFIG,
      slack: { ...DEFAULT_CONFIG.slack, enabled: true, channelId: "C123" },
      pipeline: { ...DEFAULT_CONFIG.pipeline, runtimeDir: TEST_DIR },
    };

    // Pre-populate inbox with an approval
    writeFileSync(
      join(TEST_DIR, "slack-inbox.jsonl"),
      '{"ts":"300.0","text":"approved","user":"U789","thread_ts":"200.0","channel":"C123","isApproval":true,"slug":"my-held-task"}\n',
    );

    // Pre-populate cursor
    writeFileSync(join(TEST_DIR, "slack-cursor.json"), '{"channelTs":"100.0","dmTs":"100.0"}');

    // Create held task dir so approval is valid
    const { mkdirSync: mkd } = await import("node:fs");
    mkd(join(TEST_DIR, "12-hold", "my-held-task"), { recursive: true });

    const noopSlackRunner = async () => ({
      success: true, output: "done", costUsd: 0, turns: 1,
      inputTokens: 0, outputTokens: 0, durationMs: 50,
    });

    const approveCalls: string[] = [];
    const pipeline = {
      ...makeMockPipeline(),
      async approveAndResume(slug: string) { approveCalls.push(slug); },
    };

    const watcher = createWatcher({
      runtimeDir: TEST_DIR,
      pipeline,
      logger: mockLogger,
      config: slackConfig,
      runner: noopSlackRunner,
    });

    watcher.start();

    // Wait for first poll
    await delay(slackConfig.slack.pollIntervalSeconds * 1000 + 2000);

    await watcher.stop();

    // Check a .control file was written for the approval
    const inboxFiles = (await import("node:fs")).readdirSync(join(TEST_DIR, "00-inbox"));
    const controlFiles = inboxFiles.filter(f => f.endsWith(".control"));
    expect(controlFiles.length).toBeGreaterThanOrEqual(1);
  }, 40000);
});
```

- [ ] **Step 2: Run test to verify failures**

Run: `npx vitest run tests/core/watcher.test.ts`
Expected: FAIL — `runner` not in WatcherOptions, pollSlack doesn't use agent runner

- [ ] **Step 3: Update WatcherOptions and rewrite pollSlack**

In `src/core/watcher.ts`, update the imports and WatcherOptions:

```typescript
import chokidar, { type FSWatcher } from "chokidar";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { z } from "zod";
import { parseTaskFile } from "../task/parser.js";

import { type Pipeline } from "./pipeline.js";
import { type TaskLogger } from "./logger.js";
import { type ResolvedConfig } from "../config/loader.js";
import { type AgentRunnerFn } from "./types.js";
import { filterMessages, stripPrefix, loadCursor } from "../surfaces/slack-surface.js";
import { classifyByKeywords } from "./intent-classifier.js";
import { createTask } from "./task-creator.js";
import { buildNaradaPayload, readInbox, clearInbox, readSentLog, loadThreadMap, saveThreadMap } from "./slack-queue.js";
```

Update the `WatcherOptions` interface:

```typescript
export interface WatcherOptions {
  runtimeDir: string;
  pipeline: Pipeline;
  logger: TaskLogger;
  config: ResolvedConfig;
  runner?: AgentRunnerFn;
}
```

Replace the `pollSlack` function and Slack interval setup inside `createWatcher`:

```typescript
  let slackPollInProgress = false;

  async function pollSlack(): Promise<void> {
    if (!runner) return;
    slackPollInProgress = true;

    try {
      // Find held task slugs for approval checking
      const holdDir = join(runtimeDir, "12-hold");
      let heldSlugs: string[] = [];
      try {
        heldSlugs = readdirSync(holdDir).filter((f) => !f.startsWith("."));
      } catch { /* no hold dir */ }

      // Build Narada payload
      const payload = buildNaradaPayload(runtimeDir, {
        channelId: config.slack.channelId,
        allowDMs: config.slack.allowDMs,
        dmUserIds: config.slack.dmUserIds,
        heldSlugs,
      });

      // If DMs enabled but no user IDs configured, warn
      if (config.slack.allowDMs && config.slack.dmUserIds.length === 0) {
        logger.warn("[watcher] Slack DM polling enabled but no dmUserIds configured — skipping DMs");
      }

      // Spawn Narada
      const abortController = new AbortController();
      await runner({
        stage: "slack-io",
        slug: "slack-io-poll",
        taskContent: JSON.stringify(payload, null, 2),
        previousOutput: "",
        outputPath: join(runtimeDir, "slack-io-output.md"),
        cwd: runtimeDir,
        config,
        abortController,
        logger: { info() {}, warn() {}, error() {} },
      });

      // Post-process: read inbox
      const inboxEntries = readInbox(runtimeDir);

      for (const entry of inboxEntries) {
        if (entry.isApproval && entry.slug) {
          // Verify task is actually held
          if (existsSync(join(runtimeDir, "12-hold", entry.slug))) {
            const controlPath = join(runtimeDir, "00-inbox", `slack-approve-${entry.ts.replace(".", "-")}.control`);
            writeFileSync(controlPath, JSON.stringify({
              operation: "approve",
              slug: entry.slug,
              feedback: `Approved via Slack by ${entry.user}`,
            }), "utf-8");
            logger.info(`[watcher] Slack approval detected for ${entry.slug}`);
          }
        } else {
          // Classify and route as task or control
          const text = config.slack.requirePrefix
            ? stripPrefix(entry.text, config.slack.prefix)
            : entry.text;

          const classified = classifyByKeywords(text);
          const intent = classified?.intent ?? "create_task";

          if (intent === "create_task" || intent === "unknown") {
            createTask(
              { source: "slack", content: text, slackThread: entry.thread_ts ?? entry.ts },
              runtimeDir,
              config,
            );
            logger.info(`[watcher] Slack: created task from message ${entry.ts}`);
          } else if (classified?.extractedSlug) {
            const controlPayload: Record<string, unknown> = { operation: intent, slug: classified.extractedSlug };
            if (classified.extractedFeedback) controlPayload.feedback = classified.extractedFeedback;
            if (classified.extractedStages) controlPayload.stages = classified.extractedStages;

            const controlPath = join(runtimeDir, "00-inbox", `slack-${entry.ts.replace(".", "-")}.control`);
            writeFileSync(controlPath, JSON.stringify(controlPayload), "utf-8");
            logger.info(`[watcher] Slack: wrote control file for ${intent} on ${classified.extractedSlug}`);
          } else {
            logger.warn(`[watcher] Slack: classified as "${intent}" but no slug extracted from: "${text}"`);
          }
        }
      }

      // Clear inbox after processing
      if (inboxEntries.length > 0) {
        clearInbox(runtimeDir);
      }

      // Update thread map from sent log
      const sentEntries = readSentLog(runtimeDir);
      if (sentEntries.length > 0) {
        const threadMap = loadThreadMap(runtimeDir);
        // Narada already updates threads.json, but we verify here
        logger.info(`[watcher] Slack: ${sentEntries.length} message(s) confirmed sent`);
      }
    } finally {
      slackPollInProgress = false;
    }
  }
```

Then update the Slack interval setup inside `start()`:

```typescript
      if (config.slack.enabled && config.slack.channelId) {
        const pollMs = config.slack.pollIntervalSeconds * 1000;
        slackInterval = setInterval(() => {
          if (slackPollInProgress) return;
          pollSlack().catch((err: unknown) => {
            logger.error(`[watcher] Slack poll error: ${err instanceof Error ? err.message : String(err)}`);
          });
        }, pollMs);
        logger.info(`[watcher] Slack polling enabled (${config.slack.pollIntervalSeconds}s interval)`);
      }
```

Also update the `createWatcher` function to destructure `runner`:

```typescript
  const { runtimeDir, pipeline, logger, config, runner } = options;
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/core/watcher.test.ts`
Expected: All PASS (existing tests pass because `runner` is optional; new tests use mock runner)

- [ ] **Step 5: Run full suite**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/watcher.ts tests/core/watcher.test.ts
git commit -m "feat: replace Slack polling stub with agent-mediated Narada I/O"
```

---

### Task 13: Start Command — Wire runner and update notifier

**Files:**
- Modify: `src/commands/start.ts`

- [ ] **Step 1: Update start.ts**

In `src/commands/start.ts`, update the SlackNotifier registration (lines 71-83):

```typescript
      if (config.slack.enabled && config.slack.channelId) {
        const { createSlackNotifier } = await import("../surfaces/slack-notifier.js");
        pipeline.addNotifier(createSlackNotifier({
          channelId: config.slack.channelId,
          notifyLevel: config.slack.notifyLevel,
          runtimeDir: config.pipeline.runtimeDir,
        }));
        logger.info("[start] SlackNotifier registered (file-based outbox)");
      }
```

Update the watcher creation (lines 86-91) to pass the runner:

```typescript
      activeWatcher = createWatcher({
        runtimeDir: config.pipeline.runtimeDir,
        pipeline,
        logger,
        config,
        runner: runAgent,
      });
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/commands/start.ts
git commit -m "feat: wire Narada runner and file-based SlackNotifier in start command"
```

---

### Task 14: Init Wizard — Slack prompts + cleanup

**Files:**
- Modify: `src/commands/init.ts`
- Modify: `tests/commands/init.test.ts`

- [ ] **Step 1: Write test for .env cleanup**

In `tests/commands/init.test.ts`, update the `.env` test:

```typescript
  it("writes .env file without SLACK_WEBHOOK_URL", () => {
    writeInitEnv(TEST_DIR);
    const envPath = join(TEST_DIR, ".env");
    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("ADO_PAT=");
    expect(content).toContain("ANTHROPIC_API_KEY=");
    expect(content).not.toContain("SLACK_WEBHOOK_URL");
    expect(content).toContain("SLACK_TOKEN=");
    expect(content).toContain("# Not required when using MCP-based Slack integration");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands/init.test.ts`
Expected: FAIL — SLACK_WEBHOOK_URL still present

- [ ] **Step 3: Update writeInitEnv**

In `src/commands/init.ts`, update the `.env` template (lines 79-89):

```typescript
  const template = [
    "# ShaktimaanAI environment variables",
    "# Fill in the values below before running 'shkmn start'",
    "",
    "ADO_PAT=",
    "GITHUB_PAT=",
    "SLACK_TOKEN=  # Not required when using MCP-based Slack integration",
    "ANTHROPIC_API_KEY=",
    "",
  ].join("\n");
```

- [ ] **Step 4: Update writeInitConfig for Slack fields**

In `src/commands/init.ts`, update the `slack` section in `writeInitConfig` (lines 40-45):

```typescript
    slack: {
      enabled: d.slack.enabled,
      channel: d.slack.channel,
      channelId: d.slack.channelId,
      pollIntervalSeconds: d.slack.pollIntervalSeconds,
      notifyLevel: d.slack.notifyLevel,
      requirePrefix: d.slack.requirePrefix,
      prefix: d.slack.prefix,
      allowDMs: d.slack.allowDMs,
      dmUserIds: d.slack.dmUserIds,
    },
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/commands/init.test.ts`
Expected: All PASS

- [ ] **Step 6: Run full suite**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/commands/init.ts tests/commands/init.test.ts
git commit -m "feat: remove SLACK_WEBHOOK_URL from .env, add Slack fields to init config"
```

---

### Task 15: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS (572+ original + new tests)

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Build succeeds, `dist/cli.js` and `dist/agents/slack-io.md` present

- [ ] **Step 3: Verify agent file is bundled**

Run: `ls dist/agents/slack-io.md`
Expected: File exists

- [ ] **Step 4: Commit any remaining changes**

If any uncommitted files remain:

```bash
git add -A
git commit -m "chore: final cleanup for Spec 3a Slack I/O Agent"
```
