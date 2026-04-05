import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { listActiveSlugs, resolveSlug } from "../../src/core/slug-resolver.js";
import { STAGE_DIR_MAP } from "../../src/core/stage-map.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function mkSlugDir(runtimeDir: string, relPath: string): void {
  fs.mkdirSync(path.join(runtimeDir, relPath), { recursive: true });
}

// ─── setup / teardown ────────────────────────────────────────────────────────

let runtimeDir: string;

beforeEach(() => {
  runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "shaktimaan-test-"));
});

afterEach(() => {
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});

// ─── listActiveSlugs ─────────────────────────────────────────────────────────

describe("listActiveSlugs", () => {
  it("returns empty array when runtimeDir is empty", () => {
    expect(listActiveSlugs(runtimeDir)).toEqual([]);
  });

  it("finds slugs in pending and done subdirs of stage dirs", () => {
    mkSlugDir(runtimeDir, "06-impl/pending/fix-auth-bug-20260405103000");
    mkSlugDir(runtimeDir, "06-impl/done/old-task-20260101000000");

    const slugs = listActiveSlugs(runtimeDir);
    const slugNames = slugs.map((t) => t.slug);
    expect(slugNames).toContain("fix-auth-bug-20260405103000");
    expect(slugNames).toContain("old-task-20260101000000");
  });

  it("finds slugs across multiple stage dirs", () => {
    mkSlugDir(runtimeDir, "01-questions/pending/question-slug-20260405000001");
    mkSlugDir(runtimeDir, "05-plan/pending/plan-slug-20260405000002");
    mkSlugDir(runtimeDir, "09-pr/done/pr-slug-20260405000003");

    const slugs = listActiveSlugs(runtimeDir);
    const slugNames = slugs.map((t) => t.slug);
    expect(slugNames).toContain("question-slug-20260405000001");
    expect(slugNames).toContain("plan-slug-20260405000002");
    expect(slugNames).toContain("pr-slug-20260405000003");
  });

  it("finds slugs in 12-hold and marks status as held", () => {
    mkSlugDir(runtimeDir, "12-hold/held-task-20260405000004");

    const slugs = listActiveSlugs(runtimeDir);
    const holdTask = slugs.find((t) => t.slug === "held-task-20260405000004");
    expect(holdTask).toBeDefined();
    expect(holdTask!.status).toBe("held");
    expect(holdTask!.dir).toBe("12-hold");
  });

  it("ignores 10-complete directory", () => {
    mkSlugDir(runtimeDir, "10-complete/complete-task-20260405000005");

    const slugs = listActiveSlugs(runtimeDir);
    const slugNames = slugs.map((t) => t.slug);
    expect(slugNames).not.toContain("complete-task-20260405000005");
  });

  it("ignores 11-failed directory", () => {
    mkSlugDir(runtimeDir, "11-failed/failed-task-20260405000006");

    const slugs = listActiveSlugs(runtimeDir);
    const slugNames = slugs.map((t) => t.slug);
    expect(slugNames).not.toContain("failed-task-20260405000006");
  });

  it("ignores files (non-directories) inside stage subdirs", () => {
    mkSlugDir(runtimeDir, "06-impl/pending");
    fs.writeFileSync(
      path.join(runtimeDir, "06-impl/pending/not-a-slug.txt"),
      "hello",
    );

    const slugs = listActiveSlugs(runtimeDir);
    const slugNames = slugs.map((t) => t.slug);
    expect(slugNames).not.toContain("not-a-slug.txt");
  });

  it("sets stage based on DIR_STAGE_MAP for pipeline stages", () => {
    mkSlugDir(runtimeDir, "06-impl/pending/impl-task-20260405000007");

    const slugs = listActiveSlugs(runtimeDir);
    const task = slugs.find((t) => t.slug === "impl-task-20260405000007");
    expect(task).toBeDefined();
    expect(task!.stage).toBe("impl");
    expect(task!.dir).toBe("06-impl/pending");
  });

  it("sets status active for pipeline stage slugs", () => {
    mkSlugDir(runtimeDir, "01-questions/pending/active-task-20260405000008");

    const slugs = listActiveSlugs(runtimeDir);
    const task = slugs.find((t) => t.slug === "active-task-20260405000008");
    expect(task).toBeDefined();
    expect(task!.status).toBe("active");
  });
});

// ─── resolveSlug ─────────────────────────────────────────────────────────────

describe("resolveSlug", () => {
  beforeEach(() => {
    mkSlugDir(runtimeDir, "06-impl/pending/fix-auth-bug-20260405103000");
    mkSlugDir(runtimeDir, "06-impl/pending/fix-auth-token-20260405104000");
    mkSlugDir(runtimeDir, "05-plan/pending/add-logging-20260405105000");
    mkSlugDir(runtimeDir, "12-hold/refactor-db-20260405106000");
  });

  it("returns exact match as a string", () => {
    const result = resolveSlug("fix-auth-bug-20260405103000", runtimeDir);
    expect(result).toBe("fix-auth-bug-20260405103000");
  });

  it("returns single prefix match as a string", () => {
    const result = resolveSlug("add-log", runtimeDir);
    expect(result).toBe("add-logging-20260405105000");
  });

  it("returns ambiguous prefix match as an array", () => {
    const result = resolveSlug("fix-auth", runtimeDir);
    expect(Array.isArray(result)).toBe(true);
    expect((result as string[]).length).toBe(2);
    expect(result).toContain("fix-auth-bug-20260405103000");
    expect(result).toContain("fix-auth-token-20260405104000");
  });

  it("returns single keyword match as a string", () => {
    const result = resolveSlug("refactor", runtimeDir);
    expect(result).toBe("refactor-db-20260405106000");
  });

  it("returns keyword match where all words must appear in slug", () => {
    const result = resolveSlug("auth bug", runtimeDir);
    expect(result).toBe("fix-auth-bug-20260405103000");
  });

  it("returns ambiguous keyword match as an array when multiple slugs match", () => {
    const result = resolveSlug("auth", runtimeDir);
    expect(Array.isArray(result)).toBe(true);
    expect((result as string[]).length).toBe(2);
  });

  it("returns empty array when no match found", () => {
    const result = resolveSlug("nonexistent-query", runtimeDir);
    expect(Array.isArray(result)).toBe(true);
    expect((result as string[]).length).toBe(0);
  });

  it("exact match takes priority over prefix/keyword matches", () => {
    // "fix-auth-bug-20260405103000" is both exact AND would be a keyword match
    const result = resolveSlug("fix-auth-bug-20260405103000", runtimeDir);
    expect(typeof result).toBe("string");
    expect(result).toBe("fix-auth-bug-20260405103000");
  });

  it("prefix match takes priority over keyword match", () => {
    // "add-log" is a prefix of "add-logging-..." and keyword "log" would also match
    const result = resolveSlug("add-log", runtimeDir);
    expect(typeof result).toBe("string");
    expect(result).toBe("add-logging-20260405105000");
  });
});
