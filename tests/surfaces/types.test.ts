import { describe, it, expect } from "vitest";
import { shouldNotify } from "../../src/surfaces/types.js";
import type { NotifyEvent, NotifyLevel } from "../../src/surfaces/types.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeEvent<T extends NotifyEvent["type"]>(
  type: T,
  extra: Omit<Extract<NotifyEvent, { type: T }>, "type" | "slug" | "timestamp">,
): Extract<NotifyEvent, { type: T }> {
  return {
    type,
    slug: "test-slug",
    timestamp: new Date().toISOString(),
    ...extra,
  } as Extract<NotifyEvent, { type: T }>;
}

// ─── shouldNotify ────────────────────────────────────────────────────────────

describe("shouldNotify", () => {
  // minimal level
  describe("minimal", () => {
    const level: NotifyLevel = "minimal";

    it("passes task_held", () => {
      expect(shouldNotify(level, makeEvent("task_held", { stage: "review", artifactUrl: "http://x" }))).toBe(true);
    });

    it("passes task_failed", () => {
      expect(shouldNotify(level, makeEvent("task_failed", { stage: "impl", error: "boom" }))).toBe(true);
    });

    it("blocks task_created", () => {
      expect(shouldNotify(level, makeEvent("task_created", { title: "T", source: "jira", stages: ["impl"] }))).toBe(false);
    });

    it("blocks task_completed", () => {
      expect(shouldNotify(level, makeEvent("task_completed", {}))).toBe(false);
    });

    it("blocks task_cancelled", () => {
      expect(shouldNotify(level, makeEvent("task_cancelled", { cancelledBy: "user" }))).toBe(false);
    });

    it("blocks stage_started", () => {
      expect(shouldNotify(level, makeEvent("stage_started", { stage: "impl" }))).toBe(false);
    });

    it("blocks stage_completed", () => {
      expect(shouldNotify(level, makeEvent("stage_completed", { stage: "impl", artifactPath: "/tmp/out" }))).toBe(false);
    });

    it("blocks task_approved", () => {
      expect(shouldNotify(level, makeEvent("task_approved", { approvedBy: "user" }))).toBe(false);
    });

    it("blocks task_paused", () => {
      expect(shouldNotify(level, makeEvent("task_paused", { pausedBy: "user" }))).toBe(false);
    });

    it("blocks task_resumed", () => {
      expect(shouldNotify(level, makeEvent("task_resumed", { resumedBy: "user" }))).toBe(false);
    });

    it("blocks stage_retried", () => {
      expect(shouldNotify(level, makeEvent("stage_retried", { stage: "impl", attempt: 2, feedback: "try again" }))).toBe(false);
    });

    it("blocks stage_skipped", () => {
      expect(shouldNotify(level, makeEvent("stage_skipped", { stage: "research" }))).toBe(false);
    });

    it("blocks stages_modified", () => {
      expect(shouldNotify(level, makeEvent("stages_modified", { oldStages: ["a"], newStages: ["b"] }))).toBe(false);
    });
  });

  // bookends level
  describe("bookends", () => {
    const level: NotifyLevel = "bookends";

    it("passes task_held", () => {
      expect(shouldNotify(level, makeEvent("task_held", { stage: "review", artifactUrl: "http://x" }))).toBe(true);
    });

    it("passes task_failed", () => {
      expect(shouldNotify(level, makeEvent("task_failed", { stage: "impl", error: "boom" }))).toBe(true);
    });

    it("passes task_created", () => {
      expect(shouldNotify(level, makeEvent("task_created", { title: "T", source: "jira", stages: ["impl"] }))).toBe(true);
    });

    it("passes task_completed", () => {
      expect(shouldNotify(level, makeEvent("task_completed", {}))).toBe(true);
    });

    it("passes task_cancelled", () => {
      expect(shouldNotify(level, makeEvent("task_cancelled", { cancelledBy: "user" }))).toBe(true);
    });

    it("blocks stage_started", () => {
      expect(shouldNotify(level, makeEvent("stage_started", { stage: "impl" }))).toBe(false);
    });

    it("blocks stage_completed", () => {
      expect(shouldNotify(level, makeEvent("stage_completed", { stage: "impl", artifactPath: "/tmp/out" }))).toBe(false);
    });

    it("blocks task_approved", () => {
      expect(shouldNotify(level, makeEvent("task_approved", { approvedBy: "user" }))).toBe(false);
    });

    it("blocks stage_retried", () => {
      expect(shouldNotify(level, makeEvent("stage_retried", { stage: "impl", attempt: 2, feedback: "try again" }))).toBe(false);
    });

    it("blocks stages_modified", () => {
      expect(shouldNotify(level, makeEvent("stages_modified", { oldStages: ["a"], newStages: ["b"] }))).toBe(false);
    });
  });

  // stages level
  describe("stages", () => {
    const level: NotifyLevel = "stages";

    it("passes task_created", () => {
      expect(shouldNotify(level, makeEvent("task_created", { title: "T", source: "jira", stages: ["impl"] }))).toBe(true);
    });

    it("passes stage_started", () => {
      expect(shouldNotify(level, makeEvent("stage_started", { stage: "impl" }))).toBe(true);
    });

    it("passes stage_completed", () => {
      expect(shouldNotify(level, makeEvent("stage_completed", { stage: "impl", artifactPath: "/tmp/out" }))).toBe(true);
    });

    it("passes task_held", () => {
      expect(shouldNotify(level, makeEvent("task_held", { stage: "review", artifactUrl: "http://x" }))).toBe(true);
    });

    it("passes task_approved", () => {
      expect(shouldNotify(level, makeEvent("task_approved", { approvedBy: "user" }))).toBe(true);
    });

    it("passes task_completed", () => {
      expect(shouldNotify(level, makeEvent("task_completed", {}))).toBe(true);
    });

    it("passes task_failed", () => {
      expect(shouldNotify(level, makeEvent("task_failed", { stage: "impl", error: "boom" }))).toBe(true);
    });

    it("passes task_cancelled", () => {
      expect(shouldNotify(level, makeEvent("task_cancelled", { cancelledBy: "user" }))).toBe(true);
    });

    it("passes task_paused", () => {
      expect(shouldNotify(level, makeEvent("task_paused", { pausedBy: "user" }))).toBe(true);
    });

    it("passes task_resumed", () => {
      expect(shouldNotify(level, makeEvent("task_resumed", { resumedBy: "user" }))).toBe(true);
    });

    it("passes stage_retried", () => {
      expect(shouldNotify(level, makeEvent("stage_retried", { stage: "impl", attempt: 2, feedback: "try again" }))).toBe(true);
    });

    it("passes stage_skipped", () => {
      expect(shouldNotify(level, makeEvent("stage_skipped", { stage: "research" }))).toBe(true);
    });

    it("passes stages_modified", () => {
      expect(shouldNotify(level, makeEvent("stages_modified", { oldStages: ["a"], newStages: ["b"] }))).toBe(true);
    });
  });
});
