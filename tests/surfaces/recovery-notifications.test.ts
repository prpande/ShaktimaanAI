import { describe, it, expect } from "vitest";
import { formatEvent } from "../../src/surfaces/slack-notifier.js";
import type { NotifyEvent } from "../../src/surfaces/types.js";

describe("recovery notification formatting", () => {
  it("formats fixable recovery diagnosis", () => {
    const event: NotifyEvent = {
      type: "recovery_diagnosed",
      slug: "test-task",
      stage: "review",
      classification: "fixable",
      diagnosis: "Tool permission missing for review stage",
      reEntryStage: "review",
      issueUrl: "https://github.com/prpande/ShaktimaanAI/issues/42",
      timestamp: "2026-04-09T10:00:00Z",
    };
    const text = formatEvent(event, "UTC");
    expect(text).toContain("🔬");
    expect(text).toContain("fixable");
    expect(text).toContain("review");
    expect(text).toContain("issues/42");
    expect(text).toContain("recover");
  });

  it("formats terminal recovery diagnosis", () => {
    const event: NotifyEvent = {
      type: "recovery_diagnosed",
      slug: "test-task",
      stage: "impl",
      classification: "terminal",
      diagnosis: "Task requirements are impossible",
      timestamp: "2026-04-09T10:00:00Z",
    };
    const text = formatEvent(event, "UTC");
    expect(text).toContain("🔬");
    expect(text).toContain("terminal");
    expect(text).toContain("impossible");
  });
});
