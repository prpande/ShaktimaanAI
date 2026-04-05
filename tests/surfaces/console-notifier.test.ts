import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createConsoleNotifier } from "../../src/surfaces/console-notifier.js";
import type { NotifyEvent } from "../../src/surfaces/types.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeEvent<T extends NotifyEvent["type"]>(
  type: T,
  extra: Omit<Extract<NotifyEvent, { type: T }>, "type" | "slug" | "timestamp">,
): Extract<NotifyEvent, { type: T }> {
  return {
    type,
    slug: "my-task",
    timestamp: "2026-01-01T12:00:00.000Z",
    ...extra,
  } as Extract<NotifyEvent, { type: T }>;
}

// ─── ConsoleNotifier ─────────────────────────────────────────────────────────

describe("ConsoleNotifier", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("returns an object with a notify function", () => {
    const notifier = createConsoleNotifier();
    expect(typeof notifier.notify).toBe("function");
  });

  it("logs task_created with title and stages", async () => {
    const notifier = createConsoleNotifier();
    await notifier.notify(makeEvent("task_created", { title: "Add logging", source: "jira", stages: ["impl", "review"] }));
    expect(spy).toHaveBeenCalledOnce();
    const line: string = spy.mock.calls[0][0];
    expect(line).toContain("task_created");
    expect(line).toContain("my-task");
    expect(line).toContain("Add logging");
    expect(line).toContain("impl");
  });

  it("logs stage_started with stage name", async () => {
    const notifier = createConsoleNotifier();
    await notifier.notify(makeEvent("stage_started", { stage: "design" }));
    const line: string = spy.mock.calls[0][0];
    expect(line).toContain("stage_started");
    expect(line).toContain("my-task");
    expect(line).toContain("design");
  });

  it("logs stage_completed with artifact path", async () => {
    const notifier = createConsoleNotifier();
    await notifier.notify(makeEvent("stage_completed", { stage: "impl", artifactPath: "/tmp/output.md" }));
    const line: string = spy.mock.calls[0][0];
    expect(line).toContain("stage_completed");
    expect(line).toContain("impl");
    expect(line).toContain("/tmp/output.md");
  });

  it("logs task_held with artifact url", async () => {
    const notifier = createConsoleNotifier();
    await notifier.notify(makeEvent("task_held", { stage: "review", artifactUrl: "http://example.com/pr/42" }));
    const line: string = spy.mock.calls[0][0];
    expect(line).toContain("task_held");
    expect(line).toContain("review");
    expect(line).toContain("http://example.com/pr/42");
  });

  it("logs task_approved with approvedBy and no feedback", async () => {
    const notifier = createConsoleNotifier();
    await notifier.notify(makeEvent("task_approved", { approvedBy: "alice" }));
    const line: string = spy.mock.calls[0][0];
    expect(line).toContain("task_approved");
    expect(line).toContain("alice");
  });

  it("logs task_approved with feedback when present", async () => {
    const notifier = createConsoleNotifier();
    await notifier.notify(makeEvent("task_approved", { approvedBy: "bob", feedback: "looks good" }));
    const line: string = spy.mock.calls[0][0];
    expect(line).toContain("bob");
    expect(line).toContain("looks good");
  });

  it("logs task_completed with no prUrl", async () => {
    const notifier = createConsoleNotifier();
    await notifier.notify(makeEvent("task_completed", {}));
    const line: string = spy.mock.calls[0][0];
    expect(line).toContain("task_completed");
    expect(line).toContain("my-task");
  });

  it("logs task_completed with prUrl when present", async () => {
    const notifier = createConsoleNotifier();
    await notifier.notify(makeEvent("task_completed", { prUrl: "https://github.com/org/repo/pull/99" }));
    const line: string = spy.mock.calls[0][0];
    expect(line).toContain("task_completed");
    expect(line).toContain("https://github.com/org/repo/pull/99");
  });

  it("logs task_failed with stage and error", async () => {
    const notifier = createConsoleNotifier();
    await notifier.notify(makeEvent("task_failed", { stage: "validate", error: "tests failed" }));
    const line: string = spy.mock.calls[0][0];
    expect(line).toContain("task_failed");
    expect(line).toContain("validate");
    expect(line).toContain("tests failed");
  });

  it("logs task_cancelled with cancelledBy", async () => {
    const notifier = createConsoleNotifier();
    await notifier.notify(makeEvent("task_cancelled", { cancelledBy: "carol" }));
    const line: string = spy.mock.calls[0][0];
    expect(line).toContain("task_cancelled");
    expect(line).toContain("carol");
  });

  it("logs task_paused with pausedBy", async () => {
    const notifier = createConsoleNotifier();
    await notifier.notify(makeEvent("task_paused", { pausedBy: "dave" }));
    const line: string = spy.mock.calls[0][0];
    expect(line).toContain("task_paused");
    expect(line).toContain("dave");
  });

  it("logs task_resumed with resumedBy", async () => {
    const notifier = createConsoleNotifier();
    await notifier.notify(makeEvent("task_resumed", { resumedBy: "eve" }));
    const line: string = spy.mock.calls[0][0];
    expect(line).toContain("task_resumed");
    expect(line).toContain("eve");
  });

  it("logs stage_retried with stage and attempt number", async () => {
    const notifier = createConsoleNotifier();
    await notifier.notify(makeEvent("stage_retried", { stage: "impl", attempt: 3, feedback: "fix tests" }));
    const line: string = spy.mock.calls[0][0];
    expect(line).toContain("stage_retried");
    expect(line).toContain("impl");
    expect(line).toContain("3");
  });

  it("logs stage_skipped with stage name", async () => {
    const notifier = createConsoleNotifier();
    await notifier.notify(makeEvent("stage_skipped", { stage: "questions" }));
    const line: string = spy.mock.calls[0][0];
    expect(line).toContain("stage_skipped");
    expect(line).toContain("questions");
  });

  it("logs stages_modified with old and new stages", async () => {
    const notifier = createConsoleNotifier();
    await notifier.notify(makeEvent("stages_modified", { oldStages: ["impl", "review"], newStages: ["impl", "validate", "review"] }));
    const line: string = spy.mock.calls[0][0];
    expect(line).toContain("stages_modified");
    expect(line).toContain("impl");
    expect(line).toContain("validate");
  });

  it("includes the timestamp in the output", async () => {
    const notifier = createConsoleNotifier();
    await notifier.notify(makeEvent("task_created", { title: "T", source: "cli", stages: ["impl"] }));
    const line: string = spy.mock.calls[0][0];
    expect(line).toContain("2026-01-01T12:00:00.000Z");
  });

  it("calls console.log exactly once per event", async () => {
    const notifier = createConsoleNotifier();
    await notifier.notify(makeEvent("stage_started", { stage: "plan" }));
    expect(spy).toHaveBeenCalledOnce();
  });
});
