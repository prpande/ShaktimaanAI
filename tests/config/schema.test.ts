import { describe, it, expect } from "vitest";
import { configSchema } from "../../src/config/schema.js";

describe("configSchema", () => {
  it("accepts a valid full config", () => {
    const valid = {
      pipeline: {
        runtimeDir: "/home/user/.shkmn",
        dashboardRepoLocal: "/home/user/dashboard",
        dashboardRepoUrl: "https://github.com/user/dashboard.git",
      },
      repos: {
        root: "/home/user/code",
        aliases: {
          myapp: { path: "/home/user/code/myapp", sequentialBuild: true },
        },
      },
      ado: { org: "https://dev.azure.com/myorg", project: "MyProj", defaultArea: "App" },
      slack: { enabled: false, channel: "#pipeline", channelId: "", pollIntervalActiveSec: 300, pollIntervalIdleSec: 45 },
      agents: {
        names: { questions: "CustomName" },
        defaultStages: ["research", "impl"],
        defaultReviewAfter: "research",
        maxConcurrentTotal: 2,
        maxTurns: { research: 20 },
        timeoutsMinutes: { research: 30 },
        heartbeatTimeoutMinutes: 5,
        retryCount: 2,
      },
      schedule: {
        rollupTime: "23:00",
        notionPushDay: "Friday",
        notionPushTime: "17:00",
        monthlyReportDay: 1,
        monthlyReportTime: "09:00",
      },
    };
    const result = configSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("accepts a minimal config (only pipeline.runtimeDir required)", () => {
    const minimal = { pipeline: { runtimeDir: "/tmp/shkmn" } };
    const result = configSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("rejects config with missing pipeline.runtimeDir", () => {
    const invalid = { pipeline: {} };
    const result = configSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects config with non-string runtimeDir", () => {
    const invalid = { pipeline: { runtimeDir: 123 } };
    const result = configSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("accepts agents.models override", () => {
    const result = configSchema.safeParse({
      pipeline: { runtimeDir: "/tmp" },
      agents: { models: { impl: "haiku", "slack-io": "opus" } },
    });
    expect(result.success).toBe(true);
  });

  it("allows partial agent names (user overrides only some)", () => {
    const partial = {
      pipeline: { runtimeDir: "/tmp/shkmn" },
      agents: { names: { questions: "MyQuestionBot" } },
    };
    const result = configSchema.safeParse(partial);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents?.names?.questions).toBe("MyQuestionBot");
    }
  });
});
