import { describe, it, expect } from "vitest";
import {
  formatTime,
  formatDuration,
  formatTokens,
  formatMetrics,
} from "../../src/surfaces/slack-notifier.js";

describe("formatTime", () => {
  it("formats UTC timestamp", () => {
    expect(formatTime("2026-01-01T14:27:00.000Z", "UTC")).toBe("2:27 PM UTC");
  });

  it("formats Asia/Kolkata timezone", () => {
    // 14:27 UTC = 19:57 IST (UTC+5:30)
    const result = formatTime("2026-01-01T14:27:00.000Z", "Asia/Kolkata");
    expect(result).toMatch(/7:57 PM/);
  });
});

describe("formatDuration", () => {
  it("formats seconds only", () => {
    expect(formatDuration(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(274)).toBe("4m 34s");
  });

  it("formats minutes only when seconds are 0", () => {
    expect(formatDuration(120)).toBe("2m");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(6300)).toBe("1h 45m");
  });

  it("formats hours only when minutes are 0", () => {
    expect(formatDuration(3600)).toBe("1h");
  });
});

describe("formatTokens", () => {
  it("formats token counts with commas", () => {
    expect(formatTokens(410, 7353)).toBe("410 in / 7,353 out");
  });

  it("handles undefined as 0", () => {
    expect(formatTokens(undefined, undefined)).toBe("0 in / 0 out");
  });

  it("formats large numbers", () => {
    expect(formatTokens(1234567, 9876543)).toBe("1,234,567 in / 9,876,543 out");
  });
});

describe("formatMetrics", () => {
  it("formats all metrics", () => {
    const result = formatMetrics({
      durationSeconds: 274,
      costUsd: 0.88,
      turns: 27,
      inputTokens: 410,
      outputTokens: 7353,
    });
    expect(result).toContain("4m 34s");
    expect(result).toContain("$0.88");
    expect(result).toContain("27 turns");
    expect(result).toContain("410 in / 7,353 out");
  });

  it("formats partial metrics (no tokens)", () => {
    const result = formatMetrics({
      durationSeconds: 60,
      costUsd: 0.12,
    });
    expect(result).toContain("1m");
    expect(result).toContain("$0.12");
    expect(result).not.toContain("in /");
  });

  it("returns empty string for no metrics", () => {
    expect(formatMetrics({})).toBe("");
  });
});
