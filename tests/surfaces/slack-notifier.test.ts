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
