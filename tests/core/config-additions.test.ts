import { describe, it, expect } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/loader.js";

describe("config worktree section", () => {
  it("defaults to retentionDays=7 and cleanupOnStartup=true", () => {
    const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/test" } });
    const resolved = resolveConfig(parsed);
    expect(resolved.worktree.retentionDays).toBe(7);
    expect(resolved.worktree.cleanupOnStartup).toBe(true);
  });

  it("accepts partial overrides", () => {
    const parsed = configSchema.parse({
      pipeline: { runtimeDir: "/tmp/test" },
      worktree: { retentionDays: 14 },
    });
    const resolved = resolveConfig(parsed);
    expect(resolved.worktree.retentionDays).toBe(14);
    expect(resolved.worktree.cleanupOnStartup).toBe(true);
  });

  it("can disable cleanupOnStartup", () => {
    const parsed = configSchema.parse({
      pipeline: { runtimeDir: "/tmp/test" },
      worktree: { cleanupOnStartup: false },
    });
    const resolved = resolveConfig(parsed);
    expect(resolved.worktree.cleanupOnStartup).toBe(false);
  });
});

describe("config review section", () => {
  it("defaults to enforceSuggestions=true", () => {
    const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/test" } });
    const resolved = resolveConfig(parsed);
    expect(resolved.review.enforceSuggestions).toBe(true);
  });

  it("can set enforceSuggestions to false", () => {
    const parsed = configSchema.parse({
      pipeline: { runtimeDir: "/tmp/test" },
      review: { enforceSuggestions: false },
    });
    const resolved = resolveConfig(parsed);
    expect(resolved.review.enforceSuggestions).toBe(false);
  });
});

describe("config agents section additions", () => {
  it("defaults maxValidateRetries=2 and maxReviewRecurrence=3", () => {
    const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/test" } });
    const resolved = resolveConfig(parsed);
    expect(resolved.agents.maxValidateRetries).toBe(2);
    expect(resolved.agents.maxReviewRecurrence).toBe(3);
  });

  it("accepts custom values", () => {
    const parsed = configSchema.parse({
      pipeline: { runtimeDir: "/tmp/test" },
      agents: { maxValidateRetries: 5, maxReviewRecurrence: 1 },
    });
    const resolved = resolveConfig(parsed);
    expect(resolved.agents.maxValidateRetries).toBe(5);
    expect(resolved.agents.maxReviewRecurrence).toBe(1);
  });
});
