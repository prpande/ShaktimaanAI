import { describe, it, expect, vi } from "vitest";
import { createSlackNotifier } from "../../src/surfaces/slack-notifier.js";
import type { NotifyEvent, NotifyLevel } from "../../src/surfaces/types.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

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

function makeSendMessage() {
  let counter = 0;
  return vi.fn(async (_params: { channel: string; text: string; thread_ts?: string }) => {
    counter++;
    return { ts: `ts-${counter}` };
  });
}

// ─── SlackNotifier ────────────────────────────────────────────────────────────

describe("SlackNotifier", () => {
  describe("notify level filtering", () => {
    it("calls sendMessage for task_failed at minimal level", async () => {
      const sendMessage = makeSendMessage();
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "minimal", sendMessage });
      await notifier.notify(makeEvent("task_failed", "my-task", { stage: "impl", error: "tests failed" }));
      expect(sendMessage).toHaveBeenCalledOnce();
    });

    it("calls sendMessage for task_held at minimal level", async () => {
      const sendMessage = makeSendMessage();
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "minimal", sendMessage });
      await notifier.notify(makeEvent("task_held", "my-task", { stage: "review", artifactUrl: "http://example.com/pr/1" }));
      expect(sendMessage).toHaveBeenCalledOnce();
    });

    it("skips task_created at minimal level", async () => {
      const sendMessage = makeSendMessage();
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "minimal", sendMessage });
      await notifier.notify(makeEvent("task_created", "my-task", { title: "T", source: "cli", stages: ["impl"] }));
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("skips stage_started at bookends level", async () => {
      const sendMessage = makeSendMessage();
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "bookends", sendMessage });
      await notifier.notify(makeEvent("stage_started", "my-task", { stage: "impl" }));
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("calls sendMessage for task_created at bookends level", async () => {
      const sendMessage = makeSendMessage();
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "bookends", sendMessage });
      await notifier.notify(makeEvent("task_created", "my-task", { title: "T", source: "cli", stages: ["impl"] }));
      expect(sendMessage).toHaveBeenCalledOnce();
    });

    it("calls sendMessage for all events at stages level", async () => {
      const sendMessage = makeSendMessage();
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", sendMessage });
      await notifier.notify(makeEvent("stage_started", "my-task", { stage: "impl" }));
      await notifier.notify(makeEvent("stage_completed", "my-task", { stage: "impl", artifactPath: "/tmp/out.md" }));
      expect(sendMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe("threading", () => {
    it("posts task_created as root message (no thread_ts)", async () => {
      const sendMessage = makeSendMessage();
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", sendMessage });
      await notifier.notify(makeEvent("task_created", "my-task", { title: "T", source: "cli", stages: ["impl"] }));
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "C123", thread_ts: undefined }),
      );
    });

    it("posts subsequent events as thread replies using stored ts", async () => {
      const sendMessage = makeSendMessage();
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", sendMessage });
      await notifier.notify(makeEvent("task_created", "my-task", { title: "T", source: "cli", stages: ["impl"] }));
      const rootTs = sendMessage.mock.results[0].value;
      await notifier.notify(makeEvent("stage_started", "my-task", { stage: "impl" }));
      const threadTs = (await rootTs).ts;
      expect(sendMessage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ thread_ts: threadTs }),
      );
    });

    it("uses correct thread_ts for different slugs independently", async () => {
      const sendMessage = makeSendMessage();
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", sendMessage });
      await notifier.notify(makeEvent("task_created", "task-a", { title: "A", source: "cli", stages: ["impl"] }));
      await notifier.notify(makeEvent("task_created", "task-b", { title: "B", source: "cli", stages: ["impl"] }));
      const tsA = (await sendMessage.mock.results[0].value).ts;
      const tsB = (await sendMessage.mock.results[1].value).ts;
      await notifier.notify(makeEvent("stage_started", "task-a", { stage: "impl" }));
      await notifier.notify(makeEvent("stage_started", "task-b", { stage: "impl" }));
      expect(sendMessage).toHaveBeenNthCalledWith(3, expect.objectContaining({ thread_ts: tsA }));
      expect(sendMessage).toHaveBeenNthCalledWith(4, expect.objectContaining({ thread_ts: tsB }));
    });

    it("posts event without thread_ts if task_created was never sent for that slug", async () => {
      const sendMessage = makeSendMessage();
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", sendMessage });
      await notifier.notify(makeEvent("stage_started", "unknown-slug", { stage: "impl" }));
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: undefined }),
      );
    });
  });

  describe("message formatting", () => {
    it("formats task_created with title, source, and stages", async () => {
      const sendMessage = makeSendMessage();
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", sendMessage });
      await notifier.notify(makeEvent("task_created", "my-task", { title: "Add logging", source: "jira", stages: ["impl", "review"] }));
      const text: string = sendMessage.mock.calls[0][0].text;
      expect(text).toContain("Add logging");
      expect(text).toContain("jira");
    });

    it("formats task_failed with stage and error", async () => {
      const sendMessage = makeSendMessage();
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", sendMessage });
      await notifier.notify(makeEvent("task_failed", "my-task", { stage: "validate", error: "tests failed" }));
      const text: string = sendMessage.mock.calls[0][0].text;
      expect(text).toContain("validate");
      expect(text).toContain("tests failed");
    });

    it("formats task_completed with prUrl when present", async () => {
      const sendMessage = makeSendMessage();
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", sendMessage });
      await notifier.notify(makeEvent("task_completed", "my-task", { prUrl: "https://github.com/org/repo/pull/99" }));
      const text: string = sendMessage.mock.calls[0][0].text;
      expect(text).toContain("https://github.com/org/repo/pull/99");
    });

    it("formats task_held with artifact url", async () => {
      const sendMessage = makeSendMessage();
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", sendMessage });
      await notifier.notify(makeEvent("task_held", "my-task", { stage: "review", artifactUrl: "http://example.com/pr/42" }));
      const text: string = sendMessage.mock.calls[0][0].text;
      expect(text).toContain("http://example.com/pr/42");
    });

    it("formats stage_started with stage name", async () => {
      const sendMessage = makeSendMessage();
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", sendMessage });
      await notifier.notify(makeEvent("stage_started", "my-task", { stage: "design" }));
      const text: string = sendMessage.mock.calls[0][0].text;
      expect(text).toContain("design");
    });

    it("sends to the configured channelId", async () => {
      const sendMessage = makeSendMessage();
      const notifier = createSlackNotifier({ channelId: "C999XYZ", notifyLevel: "stages", sendMessage });
      await notifier.notify(makeEvent("stage_started", "my-task", { stage: "impl" }));
      expect(sendMessage.mock.calls[0][0].channel).toBe("C999XYZ");
    });
  });

  describe("error handling", () => {
    it("swallows errors from sendMessage silently", async () => {
      const sendMessage = vi.fn(async () => { throw new Error("Slack down"); });
      const notifier = createSlackNotifier({ channelId: "C123", notifyLevel: "stages", sendMessage });
      await expect(
        notifier.notify(makeEvent("stage_started", "my-task", { stage: "impl" })),
      ).resolves.toBeUndefined();
    });
  });
});
