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

describe("config slack notify/prefix/DMs additions", () => {
  it("defaults slack.notifyLevel to 'bookends'", () => {
    const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/test" } });
    const resolved = resolveConfig(parsed);
    expect(resolved.slack.notifyLevel).toBe("bookends");
  });

  it("defaults slack.allowDMs to false", () => {
    const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/test" } });
    const resolved = resolveConfig(parsed);
    expect(resolved.slack.allowDMs).toBe(false);
  });

  it("defaults slack.requirePrefix to true", () => {
    const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/test" } });
    const resolved = resolveConfig(parsed);
    expect(resolved.slack.requirePrefix).toBe(true);
  });

  it("defaults slack.prefix to 'shkmn'", () => {
    const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/test" } });
    const resolved = resolveConfig(parsed);
    expect(resolved.slack.prefix).toBe("shkmn");
  });

  it("accepts custom slack notify config", () => {
    const parsed = configSchema.parse({
      pipeline: { runtimeDir: "/tmp/test" },
      slack: {
        notifyLevel: "stages",
        allowDMs: true,
        requirePrefix: false,
        prefix: "bot",
      },
    });
    const resolved = resolveConfig(parsed);
    expect(resolved.slack.notifyLevel).toBe("stages");
    expect(resolved.slack.allowDMs).toBe(true);
    expect(resolved.slack.requirePrefix).toBe(false);
    expect(resolved.slack.prefix).toBe("bot");
  });
});

describe("config quickTask section", () => {
  it("defaults quickTask.requireReview to true", () => {
    const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/test" } });
    const resolved = resolveConfig(parsed);
    expect(resolved.quickTask.requireReview).toBe(true);
  });

  it("defaults quickTask.complexityThreshold to 0.8", () => {
    const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/test" } });
    const resolved = resolveConfig(parsed);
    expect(resolved.quickTask.complexityThreshold).toBe(0.8);
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

  it("defaults agents.tools to empty object", () => {
    const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/test" } });
    const resolved = resolveConfig(parsed);
    expect(resolved.agents.tools).toEqual({});
  });

  it("accepts per-stage tool overrides", () => {
    const parsed = configSchema.parse({
      pipeline: { runtimeDir: "/tmp/test" },
      agents: {
        tools: {
          impl: { allowed: ["Read", "Write", "Bash"], disallowed: [] },
          review: { allowed: ["Read", "Glob"] },
        },
      },
    });
    const resolved = resolveConfig(parsed);
    expect(resolved.agents.tools["impl"]).toEqual({ allowed: ["Read", "Write", "Bash"], disallowed: [] });
    expect(resolved.agents.tools["review"]).toEqual({ allowed: ["Read", "Glob"] });
  });
});
