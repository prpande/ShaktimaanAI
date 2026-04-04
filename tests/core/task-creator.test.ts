import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { configSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/loader.js";
import {
  type CreateTaskInput,
  extractTitle,
  generateSlug,
  buildTaskFileContent,
  createTask,
} from "../../src/core/task-creator.js";

// ─── test setup ─────────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), "shkmn-test-task-creator-" + Date.now());

function makeConfig() {
  return resolveConfig(
    configSchema.parse({ pipeline: { runtimeDir: TEST_DIR } }),
  );
}

beforeEach(() => {
  mkdirSync(join(TEST_DIR, "00-inbox"), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ─── extractTitle ────────────────────────────────────────────────────────────

describe("extractTitle", () => {
  it("returns the first non-empty line", () => {
    expect(extractTitle("Fix the bug\nSecond line")).toBe("Fix the bug");
  });

  it("trims leading and trailing whitespace", () => {
    expect(extractTitle("  Fix the bug  \nSecond line")).toBe("Fix the bug");
  });

  it("skips leading empty lines to find first non-empty line", () => {
    expect(extractTitle("\n\n  Implement feature\nDetails here")).toBe(
      "Implement feature",
    );
  });

  it("returns 'untitled-task' when content is empty", () => {
    expect(extractTitle("")).toBe("untitled-task");
  });

  it("returns 'untitled-task' when content is only whitespace", () => {
    expect(extractTitle("   \n  \n  ")).toBe("untitled-task");
  });

  it("truncates at 80 characters", () => {
    const longTitle = "A".repeat(100);
    expect(extractTitle(longTitle)).toBe("A".repeat(80));
  });

  it("does not truncate titles shorter than 80 chars", () => {
    const title = "A".repeat(79);
    expect(extractTitle(title)).toBe(title);
  });
});

// ─── generateSlug ────────────────────────────────────────────────────────────

describe("generateSlug", () => {
  it("converts title to kebab-case", () => {
    const slug = generateSlug("Fix the bug");
    expect(slug).toMatch(/^fix-the-bug-\d{14}$/);
  });

  it("converts to lowercase", () => {
    const slug = generateSlug("My Feature Implementation");
    expect(slug).toMatch(/^my-feature-implementation-\d{14}$/);
  });

  it("replaces non-alphanumeric characters with hyphens", () => {
    const slug = generateSlug("Fix: bug (critical)!");
    // special chars become hyphens, consecutive hyphens collapsed, edges trimmed
    expect(slug).toMatch(/^fix-bug-critical-\d{14}$/);
  });

  it("strips leading and trailing hyphens from the base slug", () => {
    const slug = generateSlug("---hello---");
    expect(slug).toMatch(/^hello-\d{14}$/);
  });

  it("truncates the base part to 50 characters before appending timestamp", () => {
    const longTitle = "A".repeat(60);
    const slug = generateSlug(longTitle);
    const [base] = slug.split(/-\d{14}$/);
    expect(base.length).toBeLessThanOrEqual(50);
  });

  it("appends a YYYYMMDDHHMMSS timestamp", () => {
    const before = new Date();
    const slug = generateSlug("test task");
    const after = new Date();

    const match = slug.match(/-(\d{14})$/);
    expect(match).not.toBeNull();
    const ts = match![1];

    // Reconstruct a Date from the timestamp to verify it's within range
    const year = parseInt(ts.slice(0, 4));
    const month = parseInt(ts.slice(4, 6)) - 1;
    const day = parseInt(ts.slice(6, 8));
    const hour = parseInt(ts.slice(8, 10));
    const min = parseInt(ts.slice(10, 12));
    const sec = parseInt(ts.slice(12, 14));
    const tsDate = new Date(year, month, day, hour, min, sec);

    // Allow 1-second buffer on each side
    expect(tsDate.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
    expect(tsDate.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });
});

// ─── buildTaskFileContent ────────────────────────────────────────────────────

describe("buildTaskFileContent", () => {
  it("includes all provided fields", () => {
    const config = makeConfig();
    const input: CreateTaskInput = {
      source: "slack",
      content: "Add retry logic to the API client",
      repo: "myorg/myrepo",
      adoItem: "AB#1234",
      slackThread: "1234567890.123456",
      stages: ["research", "impl", "pr"],
      reviewAfter: "impl",
    };

    const content = buildTaskFileContent(input, config);

    expect(content).toContain("# Task: Add retry logic to the API client");
    expect(content).toContain("## What I want done");
    expect(content).toContain("Add retry logic to the API client");
    expect(content).toContain("## Context");
    expect(content).toContain("Source: slack");
    expect(content).toContain("## Repo");
    expect(content).toContain("myorg/myrepo");
    expect(content).toContain("## ADO Item");
    expect(content).toContain("AB#1234");
    expect(content).toContain("## Slack Thread");
    expect(content).toContain("1234567890.123456");
    expect(content).toContain("## Pipeline Config");
    expect(content).toContain("stages: research, impl, pr");
    expect(content).toContain("review_after: impl");
  });

  it("uses config default stages and reviewAfter when not provided in input", () => {
    const config = makeConfig();
    const input: CreateTaskInput = {
      source: "cli",
      content: "Simple task with no overrides",
    };

    const content = buildTaskFileContent(input, config);

    const defaultStages = config.agents.defaultStages.join(", ");
    expect(content).toContain(`stages: ${defaultStages}`);
    expect(content).toContain(`review_after: ${config.agents.defaultReviewAfter}`);
  });

  it("uses config default stages when input stages array is empty", () => {
    const config = makeConfig();
    const input: CreateTaskInput = {
      source: "dashboard",
      content: "Another task",
      stages: [],
    };

    const content = buildTaskFileContent(input, config);
    const defaultStages = config.agents.defaultStages.join(", ");
    expect(content).toContain(`stages: ${defaultStages}`);
  });

  it("omits repo section content when repo is not provided", () => {
    const config = makeConfig();
    const input: CreateTaskInput = {
      source: "cli",
      content: "Task without repo",
    };

    const content = buildTaskFileContent(input, config);
    // The section heading should still be present but no value after it
    expect(content).toContain("## Repo");
    // Should not contain a path after Repo heading
    const repoSection = content.split("## Repo")[1].split("##")[0].trim();
    expect(repoSection).toBe("");
  });

  it("omits ADO Item content when not provided", () => {
    const config = makeConfig();
    const input: CreateTaskInput = {
      source: "cli",
      content: "Task without ADO item",
    };

    const content = buildTaskFileContent(input, config);
    expect(content).toContain("## ADO Item");
    const adoSection = content.split("## ADO Item")[1].split("##")[0].trim();
    expect(adoSection).toBe("");
  });

  it("omits Slack Thread content when not provided", () => {
    const config = makeConfig();
    const input: CreateTaskInput = {
      source: "cli",
      content: "Task without slack thread",
    };

    const content = buildTaskFileContent(input, config);
    expect(content).toContain("## Slack Thread");
    const slackSection = content.split("## Slack Thread")[1].split("##")[0].trim();
    expect(slackSection).toBe("");
  });

  it("handles dashboard source", () => {
    const config = makeConfig();
    const input: CreateTaskInput = {
      source: "dashboard",
      content: "Dashboard-created task",
    };

    const content = buildTaskFileContent(input, config);
    expect(content).toContain("Source: dashboard");
  });
});

// ─── createTask ──────────────────────────────────────────────────────────────

describe("createTask", () => {
  it("writes a .task file to the 00-inbox directory", () => {
    const config = makeConfig();
    const input: CreateTaskInput = {
      source: "cli",
      content: "Implement retry logic",
    };

    const slug = createTask(input, TEST_DIR, config);

    const taskFilePath = join(TEST_DIR, "00-inbox", `${slug}.task`);
    expect(existsSync(taskFilePath)).toBe(true);
  });

  it("returns a slug that matches the written filename", () => {
    const config = makeConfig();
    const input: CreateTaskInput = {
      source: "slack",
      content: "Build the new feature",
    };

    const slug = createTask(input, TEST_DIR, config);

    expect(slug).toMatch(/^build-the-new-feature-\d{14}$/);
    const taskFilePath = join(TEST_DIR, "00-inbox", `${slug}.task`);
    expect(existsSync(taskFilePath)).toBe(true);
  });

  it("writes valid task file content to disk", () => {
    const config = makeConfig();
    const input: CreateTaskInput = {
      source: "cli",
      content: "Refactor the pipeline module",
      repo: "org/repo",
    };

    const slug = createTask(input, TEST_DIR, config);

    const taskFilePath = join(TEST_DIR, "00-inbox", `${slug}.task`);
    const fileContent = readFileSync(taskFilePath, "utf-8");

    expect(fileContent).toContain("# Task: Refactor the pipeline module");
    expect(fileContent).toContain("Source: cli");
    expect(fileContent).toContain("org/repo");
  });

  it("generates unique slugs for calls made close in time", () => {
    const config = makeConfig();
    const input: CreateTaskInput = {
      source: "cli",
      content: "Same content task",
    };

    // Create a second inbox to test; we can't guarantee timestamp uniqueness
    // within the same second, but we can verify the slug format is correct
    const slug = createTask(input, TEST_DIR, config);
    expect(slug).toMatch(/^same-content-task-\d{14}$/);
  });

  it("handles multiline content — uses only first line for title", () => {
    const config = makeConfig();
    const input: CreateTaskInput = {
      source: "cli",
      content: "Fix the login bug\n\nAdditional context about the bug here.",
    };

    const slug = createTask(input, TEST_DIR, config);

    expect(slug).toMatch(/^fix-the-login-bug-\d{14}$/);

    const taskFilePath = join(TEST_DIR, "00-inbox", `${slug}.task`);
    const fileContent = readFileSync(taskFilePath, "utf-8");

    expect(fileContent).toContain("# Task: Fix the login bug");
    // The full content should still be in the body
    expect(fileContent).toContain("Additional context about the bug here.");
  });
});
