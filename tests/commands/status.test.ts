import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatElapsed } from "../../src/commands/status.js";

describe("formatElapsed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'unknown' for undefined cast as string", () => {
    expect(formatElapsed(undefined as unknown as string)).toBe("unknown");
  });

  it("returns 'unknown' for empty string", () => {
    expect(formatElapsed("")).toBe("unknown");
  });

  it("returns 'unknown' for non-date string", () => {
    expect(formatElapsed("not-a-date")).toBe("unknown");
  });

  it("returns '5m' for a valid ISO timestamp 5 minutes ago", () => {
    const now = new Date("2026-04-09T12:00:00.000Z");
    vi.setSystemTime(now);
    const fiveMinAgo = new Date(now.getTime() - 5 * 60_000).toISOString();
    expect(formatElapsed(fiveMinAgo)).toBe("5m");
  });

  it("returns '2h5m' for a valid ISO timestamp 2 hours and 5 minutes ago", () => {
    const now = new Date("2026-04-09T12:00:00.000Z");
    vi.setSystemTime(now);
    const twoHoursFiveMinAgo = new Date(now.getTime() - (2 * 60 + 5) * 60_000).toISOString();
    expect(formatElapsed(twoHoursFiveMinAgo)).toBe("2h5m");
  });
});
