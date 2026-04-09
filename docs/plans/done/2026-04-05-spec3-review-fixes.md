# Spec 3 Review Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all critical issues, wiring gaps, and important code issues found during the Spec 3 review.

**Architecture:** Fixes are organized by priority — critical bugs first, then wiring gaps, then code improvements.

**Tech Stack:** TypeScript, Vitest, Zod

**Spec:** `docs/superpowers/specs/2026-04-05-spec3-input-surfaces-design.md`

---

## Fix 1: Critical — Daily log race condition (C1)

**Files:**
- Modify: `src/core/interactions.ts`
- Modify: `tests/core/interactions.test.ts`

**Problem:** `appendDailyLogEntry` does read-modify-write (read JSON array → push → write), losing entries under concurrent writes.

- [ ] **Step 1:** Change `appendDailyLogEntry` to use JSONL append (like `stream-logger.ts`), not JSON array rewrite. Each entry is one JSON line appended via `appendFileSync`. Rename the file format to `YYYY-MM-DD.jsonl`.

```typescript
export function appendDailyLogEntry(dir: string, entry: DailyLogEntry): void {
  mkdirSync(dir, { recursive: true });
  const date = entry.timestamp.slice(0, 10);
  const filePath = join(dir, `${date}.jsonl`);
  try {
    appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Logging should never crash the pipeline
  }
}
```

- [ ] **Step 2:** Add a `readDailyLog(dir, date): DailyLogEntry[]` helper that reads a `.jsonl` file and parses each line.

- [ ] **Step 3:** Update tests — change assertions from `JSON.parse(readFileSync(...))` array to line-by-line JSONL parsing.

- [ ] **Step 4:** Run: `npx vitest run tests/core/interactions.test.ts` → PASS

- [ ] **Step 5:** Commit: `fix(spec3): use JSONL append for daily log — eliminates race condition`

---

## Fix 2: Critical — Add "quick" to STAGE_DIR_MAP (C2)

**Files:**
- Modify: `src/core/stage-map.ts`
- Modify: `src/runtime/dirs.ts` (if it creates runtime dirs)
- Modify: `src/core/pipeline.ts` — guard in `retry`/`restartStage` for quick tasks

**Problem:** `STAGE_DIR_MAP` has no "quick" entry. Pipeline control ops on quick tasks crash.

- [ ] **Step 1:** Add guard in `retry` and `restartStage` that rejects quick tasks with a clear error:

```typescript
if (!STAGE_DIR_MAP[targetStage]) {
  throw new Error(`Cannot ${operation} stage "${targetStage}" — no stage directory mapping exists`);
}
```

- [ ] **Step 2:** Add test in `pipeline-control.test.ts` verifying retry on a quick-stage task throws descriptively.

- [ ] **Step 3:** Run: `npx vitest run tests/core/pipeline-control.test.ts` → PASS

- [ ] **Step 4:** Commit: `fix(spec3): guard pipeline control ops against unmapped stages`

---

## Fix 3: Critical — Control file delete-after-process (C3)

**Files:**
- Modify: `src/core/watcher.ts`

**Problem:** `unlinkSync` is called before the pipeline operation. Crash between delete and processing loses the command.

- [ ] **Step 1:** Move `unlinkSync(filePath)` to AFTER the switch statement in `handleControlFile`:

```typescript
async function handleControlFile(filePath: string): Promise<void> {
  const content = readFileSync(filePath, "utf-8");
  const cmd = JSON.parse(content) as { operation: string; slug: string; [key: string]: unknown };

  switch (cmd.operation) {
    case "cancel": await pipeline.cancel(cmd.slug); break;
    // ... all cases ...
  }

  // Delete only after successful processing
  try { unlinkSync(filePath); } catch { /* may already be gone */ }
}
```

- [ ] **Step 2:** Commit: `fix(spec3): delete control file after processing, not before`

---

## Fix 4: Validate control file payload with Zod (I2)

**Files:**
- Modify: `src/core/watcher.ts`

**Problem:** Control file JSON is unsafely cast. Malformed payloads silently produce wrong behavior.

- [ ] **Step 1:** Add a Zod schema for control file payloads:

```typescript
import { z } from "zod";

const controlSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("cancel"), slug: z.string() }),
  z.object({ operation: z.literal("skip"), slug: z.string(), stage: z.string().optional() }),
  z.object({ operation: z.literal("pause"), slug: z.string() }),
  z.object({ operation: z.literal("resume"), slug: z.string() }),
  z.object({ operation: z.literal("approve"), slug: z.string(), feedback: z.string().optional() }),
  z.object({ operation: z.literal("modify_stages"), slug: z.string(), stages: z.array(z.string()) }),
  z.object({ operation: z.literal("restart_stage"), slug: z.string(), stage: z.string().optional() }),
  z.object({ operation: z.literal("retry"), slug: z.string(), feedback: z.string() }),
]);
```

- [ ] **Step 2:** Parse with `controlSchema.safeParse(JSON.parse(content))`. Log validation errors and delete the file on parse failure.

- [ ] **Step 3:** Commit: `fix(spec3): validate control file payloads with Zod schema`

---

## Fix 5: Validate modifyStages input (I1)

**Files:**
- Modify: `src/core/pipeline.ts`
- Test: `tests/core/pipeline-control.test.ts`

**Problem:** `modifyStages` accepts any array without checking for valid stage names, duplicates, or empty arrays.

- [ ] **Step 1:** Add validation at the top of `modifyStages`:

```typescript
if (newStages.length === 0) throw new Error("Cannot set empty stage list");
const validStages = new Set([...Object.keys(STAGE_DIR_MAP), "quick"]);
const invalid = newStages.filter(s => !validStages.has(s));
if (invalid.length > 0) throw new Error(`Invalid stage names: ${invalid.join(", ")}`);
const dupes = newStages.filter((s, i) => newStages.indexOf(s) !== i);
if (dupes.length > 0) throw new Error(`Duplicate stage names: ${dupes.join(", ")}`);
```

- [ ] **Step 2:** Add tests: empty array throws, invalid names throw, duplicates throw.

- [ ] **Step 3:** Commit: `fix(spec3): validate modifyStages for empty, invalid, and duplicate stages`

---

## Fix 6: Make retryAttempt per-stage (I3)

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/pipeline.ts`

**Problem:** `retryAttempt` is a global counter. First review retry after two design retries gets suffix `-r3` instead of `-r1`.

- [ ] **Step 1:** Change `retryAttempt: number` to `retryAttempts: Record<string, number>` in `RunState`. Initialize as `{}`.

- [ ] **Step 2:** In `retry()`, increment per-stage: `state.retryAttempts[stage] = (state.retryAttempts[stage] ?? 0) + 1`

- [ ] **Step 3:** In `processStage`, compute suffix from `state.retryAttempts[stage] ?? 0`.

- [ ] **Step 4:** Update tests that reference `retryAttempt`.

- [ ] **Step 5:** Commit: `fix(spec3): make retry attempt counter per-stage, not global`

---

## Fix 7: Wire interaction logging into pipeline and commands (W3)

**Files:**
- Modify: `src/core/pipeline.ts`
- Modify: `src/core/watcher.ts`

**Problem:** `appendInteraction` and `appendDailyLogEntry` exist but are never called.

- [ ] **Step 1:** In `processStage`, after each `emitNotify` call, also call `appendDailyLogEntry` with the corresponding entry:

```typescript
const interactionsDir = join(runtimeDir, "interactions");

// After stage_started emit:
appendDailyLogEntry(interactionsDir, {
  timestamp: new Date().toISOString(),
  type: "agent_started",
  slug,
  stage,
  agentName: config.agents.names[stage] ?? stage,
  attempt: state.retryAttempts[stage] ?? 0,
});
```

Add similar calls for `agent_completed`, `agent_failed`, `stage_transition`.

- [ ] **Step 2:** In each pipeline control method (`cancel`, `skip`, `pause`, `resume`, `retry`, `modifyStages`, `restartStage`), add `appendDailyLogEntry` with type `"control"`.

- [ ] **Step 3:** In `handleControlFile` in watcher.ts, call `appendInteraction` for the task's current directory:

```typescript
// After successful dispatch:
const found = findTaskDir(cmd.slug); // may need to expose or duplicate
if (found) {
  appendInteraction(found.dir, cmd.slug, {
    timestamp: new Date().toISOString(),
    source: "user",
    intent: cmd.operation,
    message: JSON.stringify(cmd),
    action: `${cmd.operation} executed`,
  });
}
```

- [ ] **Step 4:** Add `appendInteraction` call in `startRun` for task creation.

- [ ] **Step 5:** Run tests, commit: `feat(spec3): wire interaction logging into pipeline lifecycle and control ops`

---

## Fix 8: Wire slug resolution into CLI commands (W4)

**Files:**
- Modify: `src/commands/cancel.ts` (and all 6 other control commands)
- Modify: `src/commands/approve.ts`

**Problem:** CLI commands pass raw slugs without fuzzy resolution.

- [ ] **Step 1:** Create a shared helper `src/commands/resolve-slug-or-exit.ts`:

```typescript
import { resolveSlug } from "../core/slug-resolver.js";

export function resolveSlugOrExit(query: string, runtimeDir: string): string {
  const result = resolveSlug(query, runtimeDir);
  if (Array.isArray(result)) {
    if (result.length === 0) {
      console.error(`No active or held task matches "${query}".`);
      process.exit(1);
    }
    console.error(`Multiple tasks match "${query}":`);
    for (const s of result) console.error(`  ${s}`);
    console.error("Specify the full slug or a more specific prefix.");
    process.exit(1);
  }
  return result;
}
```

- [ ] **Step 2:** In each control command, replace the raw `slug` argument with `resolveSlugOrExit(slug, config.pipeline.runtimeDir)` before writing the `.control` file.

- [ ] **Step 3:** Also apply to `approve`, `status` (for listing), and `logs` commands.

- [ ] **Step 4:** Commit: `feat(spec3): wire slug resolution into all CLI commands`

---

## Fix 9: Wire quick task routing (W2)

**Files:**
- Modify: `src/core/watcher.ts` or `src/core/pipeline.ts`
- Modify: `src/commands/task.ts`

**Problem:** `startQuickRun` exists but nothing calls it. `--quick`/`--full` flags are dead code.

- [ ] **Step 1:** In `task.ts`, when `--quick` flag is set, write a `.task` file with `stages: quick` in the pipeline config section.

- [ ] **Step 2:** In watcher's `.task` handler (or in `pipeline.startRun`), check if the task file has `stages: quick`. If so, call `startQuickRun` instead of `startRun`.

```typescript
// In watcher.ts add handler or in pipeline.startRun:
const taskContent = readFileSync(filePath, "utf-8");
const meta = parseTaskFile(taskContent);
if (meta.stages.length === 1 && meta.stages[0] === "quick") {
  pipeline.startQuickRun(filePath, taskContent);
} else {
  pipeline.startRun(filePath);
}
```

- [ ] **Step 3:** Test: create a task file with `stages: quick`, verify it routes to `startQuickRun`.

- [ ] **Step 4:** Commit: `feat(spec3): route quick tasks to startQuickRun based on stages`

---

## Fix 10: Register SlackNotifier when enabled (W5)

**Files:**
- Modify: `src/commands/start.ts`

**Problem:** Even with `slack.enabled: true`, no `SlackNotifier` is instantiated.

- [ ] **Step 1:** In `start.ts`, after the ConsoleNotifier registration, if Slack is enabled:

```typescript
if (config.slack.enabled && config.slack.channelId) {
  const { createSlackNotifier } = await import("../surfaces/slack-notifier.js");
  pipeline.addNotifier(createSlackNotifier({
    channelId: config.slack.channelId,
    notifyLevel: config.slack.notifyLevel,
    sendMessage: async (params) => {
      // TODO: Wire to Slack MCP tool call
      logger.info(`[slack] Would send to ${params.channel}: ${params.text.slice(0, 100)}...`);
      return { ts: String(Date.now() / 1000) };
    },
  }));
  logger.info("[start] SlackNotifier registered");
}
```

The `sendMessage` implementation is a placeholder that logs — the actual Slack MCP wiring depends on runtime MCP availability and is a follow-up.

- [ ] **Step 2:** Commit: `feat(spec3): register SlackNotifier when slack.enabled with placeholder sendMessage`

---

## Fix 11: Logs follow mode — use offset reads (I4)

**Files:**
- Modify: `src/commands/logs.ts`

**Problem:** Follow mode re-reads entire file on every poll.

- [ ] **Step 1:** Replace the current follow implementation with offset-based reading:

```typescript
if (opts.follow) {
  let lastSize = statSync(logFile).size;
  const fd = openSync(logFile, "r");

  watchFile(logFile, { interval: 500 }, () => {
    try {
      const newSize = statSync(logFile).size;
      if (newSize > lastSize) {
        const buf = Buffer.alloc(newSize - lastSize);
        readSync(fd, buf, 0, buf.length, lastSize);
        process.stdout.write(buf.toString("utf-8"));
        lastSize = newSize;
      }
    } catch { /* file may have rotated */ }
  });

  process.on("SIGINT", () => {
    closeSync(fd);
    unwatchFile(logFile);
    process.exit(0);
  });
}
```

- [ ] **Step 2:** Commit: `fix(spec3): use offset reads in logs follow mode for O(1) updates`

---

## Fix 12: CLI control commands — extract shared helper (S7)

**Files:**
- Create: `src/commands/write-control.ts`
- Modify: all 7 control commands + approve

**Problem:** 8 commands duplicate the same boilerplate (resolve config, mkdir inbox, write JSON, print).

- [ ] **Step 1:** Create `src/commands/write-control.ts`:

```typescript
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";
import { resolveSlugOrExit } from "./resolve-slug-or-exit.js";

export function writeControlFile(
  slug: string,
  payload: Record<string, unknown>,
): void {
  const config = loadConfig(resolveConfigPath());
  const resolved = resolveSlugOrExit(slug, config.pipeline.runtimeDir);
  const inboxDir = join(config.pipeline.runtimeDir, "00-inbox");
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(
    join(inboxDir, `${resolved}.control`),
    JSON.stringify({ ...payload, slug: resolved }),
    "utf-8",
  );
}
```

- [ ] **Step 2:** Refactor each control command to use `writeControlFile`.

- [ ] **Step 3:** Commit: `refactor(spec3): extract shared writeControlFile helper for CLI commands`

---

## Fix 13: Status output format (S1)

**Files:**
- Modify: `src/commands/status.ts`

**Problem:** Output missing duration and arrow notation per spec.

- [ ] **Step 1:** Read `run-state.json` from each task dir to get `startedAt`. Compute elapsed time. Format as spec shows:

```
Active:
  fix-auth-bug-20260405103000   → research    (12m)

Held (awaiting approval):
  build-landing-20260405090000  → design      (held 45m)
```

- [ ] **Step 2:** Commit: `fix(spec3): match status output format to spec — add duration and arrow notation`

---

## Deferred (Document as Known Gaps)

These are noted as intentional deferments for future work:

| # | Gap | Reason |
|---|---|---|
| D1 | Slack polling MCP integration | Requires runtime MCP availability — placeholder in place |
| D2 | Thread context slug resolution | Requires Slack message metadata not available in current MCP |
| D3 | `artifactUrl` GitHub URL generation | Requires dashboard repo URL config + file path mapping |
| D4 | task_created source tracking | Requires surface context to flow through to startRun |
| D5 | Mid-flight hint accumulation | Requires a control op to add hints — not defined in current CLI |
| D6 | Quick task escalation | Needs "full pipeline" reply handling in Slack |
| D7 | Complexity clarification below threshold | Needs interactive response capability |
| D8 | Interaction log copy-forward on stage transition | Low priority — final copy in complete/failed is sufficient |
| D9 | SlackNotifier thread map persistence | Nice-to-have for process restart resilience |
