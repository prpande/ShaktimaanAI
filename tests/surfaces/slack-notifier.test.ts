import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createSlackNotifier, formatEvent } from "../../src/surfaces/slack-notifier.js";
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
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "minimal", outboxPath: join(TEST_DIR, "slack-outbox.jsonl"), threadsPath: join(TEST_DIR, "slack-threads.json") });
      await notifier.notify(makeEvent("task_failed", "my-task", { stage: "impl", error: "tests failed" }));
      expect(readOutbox()).toHaveLength(1);
    });

    it("skips task_created at minimal level", async () => {
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "minimal", outboxPath: join(TEST_DIR, "slack-outbox.jsonl"), threadsPath: join(TEST_DIR, "slack-threads.json") });
      await notifier.notify(makeEvent("task_created", "my-task", { title: "T", source: "cli", stages: ["impl"] }));
      expect(readOutbox()).toHaveLength(0);
    });

    it("appends task_created at bookends level", async () => {
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "bookends", outboxPath: join(TEST_DIR, "slack-outbox.jsonl"), threadsPath: join(TEST_DIR, "slack-threads.json") });
      await notifier.notify(makeEvent("task_created", "my-task", { title: "T", source: "cli", stages: ["impl"] }));
      expect(readOutbox()).toHaveLength(1);
    });

    it("appends all events at stages level", async () => {
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", outboxPath: join(TEST_DIR, "slack-outbox.jsonl"), threadsPath: join(TEST_DIR, "slack-threads.json") });
      await notifier.notify(makeEvent("stage_started", "my-task", { stage: "impl" }));
      await notifier.notify(makeEvent("stage_completed", "my-task", { stage: "impl", artifactPath: "/tmp/out.md" }));
      expect(readOutbox()).toHaveLength(2);
    });
  });

  describe("outbox entry format", () => {
    it("writes correct fields to outbox JSONL", async () => {
      const notifier = createSlackNotifier({ channelId: "C999", notifyLevel: "stages", outboxPath: join(TEST_DIR, "slack-outbox.jsonl"), threadsPath: join(TEST_DIR, "slack-threads.json") });
      await notifier.notify(makeEvent("task_created", "my-slug", { title: "Fix bug", source: "cli", stages: ["impl"] }));
      const entries = readOutbox();
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry.slug).toBe("my-slug");
      expect(entry.type).toBe("task_created");
      expect(entry.channel).toBe("C999");
      expect(entry.text).toContain("my-slug");
      expect(entry.id).toMatch(/^evt-/);
      expect(entry.addedAt).toBeDefined();
    });
  });

  describe("threading via slack-threads.json", () => {
    it("sets thread_ts to null for task_created (root message)", async () => {
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", outboxPath: join(TEST_DIR, "slack-outbox.jsonl"), threadsPath: join(TEST_DIR, "slack-threads.json") });
      await notifier.notify(makeEvent("task_created", "my-task", { title: "T", source: "cli", stages: ["impl"] }));
      const entries = readOutbox();
      expect(entries[0].thread_ts).toBeNull();
    });

    it("reads thread_ts from slack-threads.json for non-created events", async () => {
      writeFileSync(join(TEST_DIR, "slack-threads.json"), JSON.stringify({ "my-task": "1234567890.000100" }));
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", outboxPath: join(TEST_DIR, "slack-outbox.jsonl"), threadsPath: join(TEST_DIR, "slack-threads.json") });
      await notifier.notify(makeEvent("stage_started", "my-task", { stage: "impl" }));
      const entries = readOutbox();
      expect(entries[0].thread_ts).toBe("1234567890.000100");
    });

    it("sets thread_ts to null when slug not in thread map", async () => {
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", outboxPath: join(TEST_DIR, "slack-outbox.jsonl"), threadsPath: join(TEST_DIR, "slack-threads.json") });
      await notifier.notify(makeEvent("stage_started", "unknown-slug", { stage: "impl" }));
      const entries = readOutbox();
      expect(entries[0].thread_ts).toBeNull();
    });

    it("uses slackThread from task_created event as thread_ts", async () => {
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", outboxPath: join(TEST_DIR, "slack-outbox.jsonl"), threadsPath: join(TEST_DIR, "slack-threads.json") });
      await notifier.notify(makeEvent("task_created", "slack-task", { title: "T", source: "slack", stages: ["impl"], slackThread: "9999999999.000001" }));
      const entries = readOutbox();
      expect(entries[0].thread_ts).toBe("9999999999.000001");
    });
  });

  describe("error handling", () => {
    it("does not throw if outbox dir is missing", async () => {
      const notifier = createSlackNotifier({
        channelId: "C123",
        notifyLevel: "stages",
        outboxPath: "/nonexistent/path/slack-outbox.jsonl",
        threadsPath: "/nonexistent/path/slack-threads.json",
      });
      await expect(
        notifier.notify(makeEvent("stage_started", "my-task", { stage: "impl" })),
      ).resolves.toBeUndefined();
    });

    it("logs a warning when outbox write fails", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const notifier = createSlackNotifier({
        channelId: "C123",
        notifyLevel: "stages",
        outboxPath: "/\0invalid/slack-outbox.jsonl",
        threadsPath: "/nonexistent/slack-threads.json",
      });
      await notifier.notify(makeEvent("task_failed", "test-task", { stage: "impl", error: "boom" }));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[slack-notifier] Failed to write outbox entry:"),
      );
      warnSpy.mockRestore();
    });
  });
});

describe("formatEvent (enriched)", () => {
  const tz = "UTC";

  it("stage_started includes timestamp and agent name", () => {
    const msg = formatEvent(
      makeEvent("stage_started", "my-task", { stage: "design", agentName: "Vishwakarma" }),
      tz,
    );
    expect(msg).toContain("▶️ *design* started `my-task` — Vishwakarma");
    expect(msg).toContain("12:00 PM UTC");
    expect(msg).toMatch(/^\n/);
  });

  it("stage_completed includes metrics and model", () => {
    const msg = formatEvent(
      makeEvent("stage_completed", "my-task", {
        stage: "design",
        artifactPath: "design-output.md",
        durationSeconds: 274,
        costUsd: 0.88,
        model: "opus",
        inputTokens: 410,
        outputTokens: 7353,
        turns: 27,
        agentName: "Vishwakarma",
      }),
      tz,
    );
    expect(msg).toContain("✅ *design* completed `my-task` — Vishwakarma (opus)");
    expect(msg).toContain("4m 34s");
    expect(msg).toContain("$0.88");
    expect(msg).toContain("27 turns");
    expect(msg).toContain("410 in / 7,353 out");
  });

  it("stage_completed with verdict shows verdict line", () => {
    const msg = formatEvent(
      makeEvent("stage_completed", "my-task", {
        stage: "review",
        artifactPath: "review-output.md",
        verdict: "APPROVED_WITH_SUGGESTIONS",
        agentName: "Drono",
      }),
      tz,
    );
    expect(msg).toContain("📋 Verdict: APPROVED_WITH_SUGGESTIONS");
  });

  it("task_held with budget reason shows budget detail", () => {
    const msg = formatEvent(
      makeEvent("task_held", "my-task", {
        stage: "impl",
        artifactUrl: "",
        holdReason: "budget_exhausted",
        holdDetail: "opus task limit at 209%",
        agentName: "Karigar",
        model: "opus",
      }),
      tz,
    );
    expect(msg).toContain("✋ *impl* held `my-task` — Karigar (opus)");
    expect(msg).toContain("💸 Budget exhausted: opus task limit at 209%");
  });

  it("task_held with approval reason shows approval message", () => {
    const msg = formatEvent(
      makeEvent("task_held", "my-task", {
        stage: "design",
        artifactUrl: "",
        holdReason: "approval_required",
        agentName: "Vishwakarma",
      }),
      tz,
    );
    expect(msg).toContain("✋ *design* completed `my-task` — awaiting approval");
  });

  it("task_failed includes metrics", () => {
    const msg = formatEvent(
      makeEvent("task_failed", "my-task", {
        stage: "validate",
        error: "Unknown validate verdict",
        durationSeconds: 207,
        costUsd: 0.12,
        model: "haiku",
        inputTokens: 200,
        outputTokens: 1800,
        turns: 8,
        agentName: "Dharma",
      }),
      tz,
    );
    expect(msg).toContain("❌ *validate* failed `my-task` — Dharma (haiku)");
    expect(msg).toContain("Unknown validate verdict");
    expect(msg).toContain("3m 27s");
    expect(msg).toContain("$0.12");
  });

  it("task_created shows stages list", () => {
    const msg = formatEvent(
      makeEvent("task_created", "spec4-dashboard", {
        title: "Dashboard Feature",
        source: "cli",
        stages: ["design", "plan", "impl", "review", "validate", "pr"],
      }),
      tz,
    );
    expect(msg).toContain("🚀 *Task created* `spec4-dashboard`");
    expect(msg).toContain("design, plan, impl, review, validate, pr");
  });

  it("task_completed with completedStages shows summary table", () => {
    const msg = formatEvent(
      makeEvent("task_completed", "spec4-dashboard", {
        completedStages: [
          { stage: "questions", completedAt: "2026-01-01T12:03:00Z", durationSeconds: 179, costUsd: 0.38, turns: 5, inputTokens: 500, outputTokens: 4064, model: "sonnet" },
          { stage: "impl", completedAt: "2026-01-01T12:15:00Z", durationSeconds: 720, costUsd: 3.74, turns: 40, inputTokens: 2000, outputTokens: 39194, model: "opus" },
        ],
        startedAt: "2026-01-01T12:00:00Z",
        agentNames: { questions: "Gargi", impl: "Karigar" },
      }),
      tz,
    );
    expect(msg).toContain("🎉 *Task completed* `spec4-dashboard`");
    expect(msg).toContain("📊 *Pipeline Summary*");
    expect(msg).toContain("$4.12");
    expect(msg).toContain("| questions | Gargi | sonnet | 2m 59s |");
    expect(msg).toContain("| impl | Karigar | opus | 12m |");
  });

  it("task_completed without completedStages falls back gracefully", () => {
    const msg = formatEvent(
      makeEvent("task_completed", "my-task", {}),
      tz,
    );
    expect(msg).toContain("🎉 *Task completed* `my-task`");
    expect(msg).not.toContain("Pipeline Summary");
  });

  it("task_approved includes feedback when present", () => {
    const msg = formatEvent(
      makeEvent("task_approved", "my-task", { approvedBy: "user", feedback: "Looks good" }),
      tz,
    );
    expect(msg).toContain("👍 *Task approved* `my-task` by user");
    expect(msg).toContain("Looks good");
  });

  it("stage_retried shows attempt and feedback", () => {
    const msg = formatEvent(
      makeEvent("stage_retried", "my-task", { stage: "impl", attempt: 2, feedback: "Fix auth tests" }),
      tz,
    );
    expect(msg).toContain("🔁 *impl* retried `my-task` — attempt 2");
    expect(msg).toContain("Fix auth tests");
  });

  it("all messages start with newline", () => {
    const events: NotifyEvent[] = [
      makeEvent("stage_started", "s", { stage: "impl" }),
      makeEvent("stage_completed", "s", { stage: "impl", artifactPath: "x" }),
      makeEvent("task_created", "s", { title: "T", source: "cli", stages: ["impl"] }),
      makeEvent("task_completed", "s", {}),
      makeEvent("task_failed", "s", { stage: "impl", error: "e" }),
      makeEvent("task_held", "s", { stage: "impl", artifactUrl: "" }),
      makeEvent("task_cancelled", "s", { cancelledBy: "user" }),
      makeEvent("task_paused", "s", { pausedBy: "user" }),
      makeEvent("task_resumed", "s", { resumedBy: "user" }),
      makeEvent("stage_retried", "s", { stage: "impl", attempt: 1, feedback: "f" }),
      makeEvent("stage_skipped", "s", { stage: "impl" }),
      makeEvent("stages_modified", "s", { oldStages: ["a"], newStages: ["b"] }),
      makeEvent("task_approved", "s", { approvedBy: "user" }),
    ];
    for (const event of events) {
      const msg = formatEvent(event, tz);
      expect(msg, `${event.type} should start with newline`).toMatch(/^\n/);
    }
  });
});
