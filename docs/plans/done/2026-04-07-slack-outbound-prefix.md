# Slack Outbound Prefix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepend a configurable identifier (default `🤖 [ShaktimaanAI]`) to every outgoing Slack message, and filter those messages out when reading inbound to prevent the pipeline from processing its own messages.

**Architecture:** Add `outboundPrefix` to the Slack config schema with a default value. Pass it through `buildNaradaPayload` into the Narada payload. The `slack-io` agent prepends the prefix at send time and skips inbound messages that start with it at read time.

**Tech Stack:** TypeScript, Zod (schema validation), Vitest (tests), `agents/slack-io.md` (agent prompt)

---

## Files

| File | Change |
|------|--------|
| `src/config/schema.ts` | Add `outboundPrefix` field to `slack` Zod object |
| `src/core/slack-queue.ts` | Add `outboundPrefix` to `NaradaPayload` type; pass it from opts in `buildNaradaPayload` |
| `src/core/watcher.ts` | Pass `config.slack.outboundPrefix` to `buildNaradaPayload` |
| `agents/slack-io.md` | Prepend prefix in Step 1 (send); skip prefixed messages in Step 2 (read) |
| `tests/config/schema.test.ts` | Add test: `outboundPrefix` defaults to `🤖 [ShaktimaanAI]` |
| `tests/core/slack-queue.test.ts` | Add test: `buildNaradaPayload` includes `outboundPrefix` in payload |

---

### Task 1: Add `outboundPrefix` to config schema

**Files:**
- Modify: `src/config/schema.ts:24-35`
- Test: `tests/config/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Open `tests/config/schema.test.ts` and add this test inside the `describe("configSchema", ...)` block:

```ts
it("slack.outboundPrefix defaults to '🤖 [ShaktimaanAI]'", () => {
  const result = configSchema.parse({});
  expect(result.slack.outboundPrefix).toBe("🤖 [ShaktimaanAI]");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/config/schema.test.ts -t "outboundPrefix"
```

Expected: FAIL — `outboundPrefix` is undefined.

- [ ] **Step 3: Add field to schema**

In `src/config/schema.ts`, add one line to the `slack` Zod object (after line 34, before the closing `)`):

```ts
  slack: z.object({
    enabled: z.boolean().optional().default(false),
    channel: z.string().optional().default("#agent-pipeline"),
    channelId: z.string().optional().default(""),
    pollIntervalActiveSec: z.number().optional().default(300),
    pollIntervalIdleSec: z.number().optional().default(45),
    notifyLevel: z.enum(["minimal", "bookends", "stages"]).optional().default("bookends"),
    allowDMs: z.boolean().optional().default(false),
    requirePrefix: z.boolean().optional().default(true),
    prefix: z.string().optional().default("shkmn"),
    dmUserIds: z.array(z.string()).optional().default([]),
    outboundPrefix: z.string().optional().default("🤖 [ShaktimaanAI]"),
  }).optional().default({}),
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/config/schema.test.ts -t "outboundPrefix"
```

Expected: PASS

- [ ] **Step 5: Run full config tests to check nothing broke**

```bash
npx vitest run tests/config/schema.test.ts
```

Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts tests/config/schema.test.ts
git commit -m "feat(config): add slack.outboundPrefix with default 🤖 [ShaktimaanAI]"
```

---

### Task 2: Thread `outboundPrefix` through `NaradaPayload` and `buildNaradaPayload`

**Files:**
- Modify: `src/core/slack-queue.ts`
- Modify: `src/core/watcher.ts:140-145`
- Test: `tests/core/slack-queue.test.ts`

- [ ] **Step 1: Write the failing test**

Open `tests/core/slack-queue.test.ts` and add inside the `describe("buildNaradaPayload", ...)` block:

```ts
it("includes outboundPrefix in payload", () => {
  writeFileSync(join(TEST_DIR, "slack-cursor.json"), '{"channelTs":"1.0","dmTs":"1.0"}');

  const payload = buildNaradaPayload(TEST_DIR, {
    channelId: "C1",
    allowDMs: false,
    dmUserIds: [],
    heldSlugs: [],
    outboundPrefix: "🤖 [TestBot]",
  });

  expect(payload.outboundPrefix).toBe("🤖 [TestBot]");
});

it("uses default outboundPrefix when not provided", () => {
  writeFileSync(join(TEST_DIR, "slack-cursor.json"), '{"channelTs":"1.0","dmTs":"1.0"}');

  const payload = buildNaradaPayload(TEST_DIR, {
    channelId: "C1",
    allowDMs: false,
    dmUserIds: [],
    heldSlugs: [],
  });

  expect(payload.outboundPrefix).toBe("🤖 [ShaktimaanAI]");
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/core/slack-queue.test.ts -t "outboundPrefix"
```

Expected: FAIL — `outboundPrefix` is not a property on payload.

- [ ] **Step 3: Add `outboundPrefix` to `NaradaPayload` type**

In `src/core/slack-queue.ts`, add `outboundPrefix: string;` to the `NaradaPayload` interface (after the `approvalChecks` line):

```ts
export interface NaradaPayload {
  outbox: OutboxEntry[];
  inbound: {
    channelId: string;
    oldest: string;
    dmUserIds: string[];
    dmOldest: string;
  };
  approvalChecks: Array<{ slug: string; thread_ts: string }>;
  outboundPrefix: string;
  files: {
    outbox: string;
    inbox: string;
    sent: string;
    threads: string;
    cursor: string;
  };
}
```

- [ ] **Step 4: Add `outboundPrefix` to `buildNaradaPayload` opts and return value**

In `src/core/slack-queue.ts`, update the function signature and return value:

```ts
export function buildNaradaPayload(
  runtimeDir: string,
  opts: {
    channelId: string;
    allowDMs: boolean;
    dmUserIds: string[];
    heldSlugs: string[];
    outboundPrefix?: string;
  },
): NaradaPayload {
  // ... existing code unchanged ...

  return {
    outbox,
    inbound: {
      channelId: opts.channelId,
      oldest: channelTs,
      dmUserIds: opts.allowDMs ? opts.dmUserIds : [],
      dmOldest: dmTs,
    },
    approvalChecks,
    outboundPrefix: opts.outboundPrefix ?? "🤖 [ShaktimaanAI]",
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

- [ ] **Step 5: Pass `outboundPrefix` from config in `watcher.ts`**

In `src/core/watcher.ts`, update the `buildNaradaPayload` call (around line 140):

```ts
const payload = buildNaradaPayload(runtimeDir, {
  channelId: config.slack.channelId,
  allowDMs: config.slack.allowDMs,
  dmUserIds: config.slack.dmUserIds,
  heldSlugs,
  outboundPrefix: config.slack.outboundPrefix,
});
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
npx vitest run tests/core/slack-queue.test.ts -t "outboundPrefix"
```

Expected: PASS

- [ ] **Step 7: Run full slack-queue tests to check nothing broke**

```bash
npx vitest run tests/core/slack-queue.test.ts
```

Expected: all PASS

- [ ] **Step 8: Commit**

```bash
git add src/core/slack-queue.ts src/core/watcher.ts tests/core/slack-queue.test.ts
git commit -m "feat(slack-queue): thread outboundPrefix through NaradaPayload and watcher"
```

---

### Task 3: Update `slack-io` agent to prepend prefix on send and filter on read

**Files:**
- Modify: `agents/slack-io.md`

No automated test is possible for the agent prompt — the correctness is verified manually by running the pipeline end-to-end.

- [ ] **Step 1: Update the task content description line**

In `agents/slack-io.md` line 5, update to mention the new field:

```md
Your task content is a JSON payload with `outbox`, `inbound`, `approvalChecks`, `outboundPrefix`, and `files` sections.
```

- [ ] **Step 2: Update Step 1 (Send) to prepend prefix**

Replace the existing Step 1 section with:

```md
## Step 1 — Send Outbox Messages

1. Read the outbox file at `files.outbox`
2. For each entry, call `mcp__claude_ai_Slack__slack_send_message` with:
   - `channel_id`: entry.channel
   - `text`: `${outboundPrefix} ${entry.text}`
   - `thread_ts`: entry.thread_ts (omit if null)
3. After each successful send, append a line to `files.sent`:
   `{"id": "<entry.id>", "slug": "<entry.slug>", "ts": "<returned ts>", "sentAt": "<ISO timestamp>"}`
4. If the entry type is `task_created`, also update `files.threads` — read the current JSON object, add `"<slug>": "<returned ts>"`, write it back.
5. After processing all entries, re-write `files.outbox` with ONLY the entries that failed to send. If all succeeded, write an empty file.
```

- [ ] **Step 3: Update Step 2 (Read) to skip prefixed messages**

Replace the existing Step 2 section with:

```md
## Step 2 — Read Inbound Messages

1. Call `mcp__claude_ai_Slack__slack_read_channel` with `channel_id` = `inbound.channelId` and `oldest` = `inbound.oldest`
2. If `inbound.dmUserIds` is non-empty, call `mcp__claude_ai_Slack__slack_read_channel` for each user ID with `oldest` = `inbound.dmOldest`
3. For each new message, skip it if `text` starts with `outboundPrefix` (this filters out the pipeline's own messages). Otherwise, write a line to `files.inbox`:
   `{"ts": "<ts>", "text": "<text>", "user": "<user>", "thread_ts": "<thread_ts or omit>", "channel": "<channel>"}`
```

- [ ] **Step 4: Build to copy updated agent prompt to `dist/`**

```bash
npm run build
```

Expected: build succeeds, `dist/agents/slack-io.md` contains the updated prompt.

- [ ] **Step 5: Commit**

```bash
git add agents/slack-io.md
git commit -m "feat(slack-io): prepend outboundPrefix on send, skip prefixed messages on read"
```

---

### Task 4: Run full test suite and verify

- [ ] **Step 1: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: If any tests fail, fix them before proceeding**

- [ ] **Step 3: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address test failures after outbound prefix changes"
```
