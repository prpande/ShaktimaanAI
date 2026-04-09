import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

import {
  createWorktree,
  removeWorktree,
  listWorktrees,
  cleanupExpired,
  recordWorktreeCompletion,
  resolveParentRepo,
  type WorktreeInfo,
} from "../../src/core/worktree.js";

// Git operations on Windows are slow — allow 60s per test and 30s for hooks
const TEST_TIMEOUT = 60_000;
const HOOK_TIMEOUT = 120_000;

let TEST_DIR: string;
let REPO_DIR: string;

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Test repo");
  execSync("git add .", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "initial commit"', { cwd: dir, stdio: "pipe" });
}

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `shkmn-wt-test-${randomUUID()}`);
  REPO_DIR = join(TEST_DIR, "repo");
  initGitRepo(REPO_DIR);
}, HOOK_TIMEOUT);

afterEach(() => {
  // Force-remove worktrees first, then clean up test dir
  try {
    execSync("git worktree prune", { cwd: REPO_DIR, stdio: "pipe" });
  } catch {
    // ignore
  }
  rmSync(TEST_DIR, { recursive: true, force: true });
}, HOOK_TIMEOUT);

// ─── createWorktree ─────────────────────────────────────────────────────────

describe("createWorktree", () => {
  it("creates a worktree directory with branch shkmn/{slug}", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    const worktreePath = createWorktree(REPO_DIR, "my-task-123", worktreesDir);

    expect(worktreePath).toBe(join(worktreesDir, "my-task-123"));
    expect(existsSync(worktreePath)).toBe(true);

    // Branch should exist
    const branches = execSync("git branch", { cwd: REPO_DIR, encoding: "utf-8" });
    expect(branches).toContain("shkmn/my-task-123");
  }, TEST_TIMEOUT);

  it("returns the same path if worktree already exists (idempotent for crash recovery)", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    const path1 = createWorktree(REPO_DIR, "my-task-abc", worktreesDir);
    // Call again — should not throw, should return same path
    const path2 = createWorktree(REPO_DIR, "my-task-abc", worktreesDir);
    expect(path1).toBe(path2);
    expect(existsSync(path2)).toBe(true);
  }, TEST_TIMEOUT);

  it("uses custom base branch when provided", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    // Create a feature branch first
    execSync("git checkout -b feature/base", { cwd: REPO_DIR, stdio: "pipe" });
    execSync("git checkout -", { cwd: REPO_DIR, stdio: "pipe" });

    const worktreePath = createWorktree(REPO_DIR, "branched-task", worktreesDir, "feature/base");
    expect(existsSync(worktreePath)).toBe(true);
  }, TEST_TIMEOUT);
});

// ─── removeWorktree ──────────────────────────────────────────────────────────

describe("removeWorktree", () => {
  it("removes the worktree directory and deletes the branch", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    const worktreePath = createWorktree(REPO_DIR, "remove-task", worktreesDir);

    removeWorktree(REPO_DIR, worktreePath, "remove-task");

    expect(existsSync(worktreePath)).toBe(false);

    const branches = execSync("git branch", { cwd: REPO_DIR, encoding: "utf-8" });
    expect(branches).not.toContain("shkmn/remove-task");
  }, TEST_TIMEOUT);

  it("does not throw if worktree was already removed", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    const worktreePath = createWorktree(REPO_DIR, "gone-task", worktreesDir);
    removeWorktree(REPO_DIR, worktreePath, "gone-task");

    // Second removal should not throw
    expect(() => removeWorktree(REPO_DIR, worktreePath, "gone-task")).not.toThrow();
  }, TEST_TIMEOUT);
});

// ─── listWorktrees ───────────────────────────────────────────────────────────

describe("listWorktrees", () => {
  it("returns empty array when no shkmn worktrees exist", () => {
    const result = listWorktrees(REPO_DIR);
    expect(result).toEqual([]);
  }, TEST_TIMEOUT);

  it("lists all shkmn/* worktrees", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    createWorktree(REPO_DIR, "task-alpha", worktreesDir);
    createWorktree(REPO_DIR, "task-beta", worktreesDir);

    const result = listWorktrees(REPO_DIR);
    const slugs = result.map((w: WorktreeInfo) => w.slug).sort();
    expect(slugs).toEqual(["task-alpha", "task-beta"]);
  }, TEST_TIMEOUT);

  it("returned WorktreeInfo has required fields", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    createWorktree(REPO_DIR, "task-check", worktreesDir);

    const result = listWorktrees(REPO_DIR);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBeTruthy();
    expect(result[0].branch).toBe("shkmn/task-check");
    expect(result[0].slug).toBe("task-check");
  }, TEST_TIMEOUT);
});

// ─── recordWorktreeCompletion / cleanupExpired ───────────────────────────────

describe("cleanupExpired", () => {
  it("removes worktrees whose completedAt is older than retentionDays", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    const manifestPath = join(TEST_DIR, "worktree-manifest.json");
    const worktreePath = createWorktree(REPO_DIR, "old-task", worktreesDir);

    // Record completion with a date 8 days ago
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 8);
    recordWorktreeCompletion(manifestPath, {
      slug: "old-task",
      repoPath: REPO_DIR,
      worktreePath,
      completedAt: oldDate.toISOString(),
    });

    const removed = cleanupExpired(manifestPath, 7);
    expect(removed).toContain(worktreePath);
    expect(existsSync(worktreePath)).toBe(false);
  }, TEST_TIMEOUT);

  it("keeps worktrees within retentionDays", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    const manifestPath = join(TEST_DIR, "worktree-manifest.json");
    const worktreePath = createWorktree(REPO_DIR, "new-task", worktreesDir);

    // Record completion with today's date
    recordWorktreeCompletion(manifestPath, {
      slug: "new-task",
      repoPath: REPO_DIR,
      worktreePath,
      completedAt: new Date().toISOString(),
    });

    const removed = cleanupExpired(manifestPath, 7);
    expect(removed).toHaveLength(0);
    expect(existsSync(worktreePath)).toBe(true);
  }, TEST_TIMEOUT);

  it("returns empty array when manifest does not exist", () => {
    const manifestPath = join(TEST_DIR, "nonexistent-manifest.json");
    const removed = cleanupExpired(manifestPath, 7);
    expect(removed).toEqual([]);
  }, TEST_TIMEOUT);
});

// ─── Shell injection prevention ─────────────────────────────────────────────

describe("shell injection prevention", () => {
  it("uses execFileSync instead of execSync (no shell interpretation)", () => {
    const source = readFileSync(
      join(__dirname, "../../src/core/worktree.ts"),
      "utf-8",
    );
    // Must not use execSync (shell-based execution)
    expect(source).not.toMatch(/\bexecSync\b/);
    // Must use execFileSync (argument-array based, no shell)
    expect(source).toMatch(/\bexecFileSync\b/);
  });

  it("does not execute shell metacharacters in baseBranch", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    // A baseBranch containing shell metacharacters should fail as an
    // invalid git ref, NOT execute the injected command.
    // With execFileSync, the string is passed as a literal argument to git.
    expect(() =>
      createWorktree(REPO_DIR, "inject-test", worktreesDir, '$(echo pwned)'),
    ).toThrow(); // git will reject the invalid ref
  }, TEST_TIMEOUT);
});

describe("resolveParentRepo", () => {
  it("resolves the parent repo from a worktree .git file", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    const worktreePath = createWorktree(REPO_DIR, "resolve-test", worktreesDir);

    const resolved = resolveParentRepo(worktreePath);
    expect(resolved).not.toBeNull();
    // Normalize both sides: slashes, case, and Windows 8.3 short paths (tmpdir may return short form)
    const normalize = (p: string) => realpathSync.native(p).replace(/\\/g, "/").toLowerCase();
    expect(normalize(resolved!)).toBe(normalize(REPO_DIR));
  }, TEST_TIMEOUT);

  it("returns null for a regular git repo (not a worktree)", () => {
    const resolved = resolveParentRepo(REPO_DIR);
    expect(resolved).toBeNull();
  }, TEST_TIMEOUT);

  it("returns null for a non-git directory", () => {
    const plainDir = join(TEST_DIR, "plain");
    mkdirSync(plainDir, { recursive: true });
    const resolved = resolveParentRepo(plainDir);
    expect(resolved).toBeNull();
  }, TEST_TIMEOUT);

  it("resolves the parent repo from a worktree of a bare repo", () => {
    const bareDir = join(TEST_DIR, "bare-repo");
    mkdirSync(bareDir, { recursive: true });
    execSync("git init --bare", { cwd: bareDir, stdio: "pipe" });

    // Bare repos need at least one ref to create a worktree from
    // Create a temporary regular repo, push to bare, then create worktree from bare
    const tempRepo = join(TEST_DIR, "temp-repo");
    mkdirSync(tempRepo, { recursive: true });
    execSync("git init", { cwd: tempRepo, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: tempRepo, stdio: "pipe" });
    execSync('git config user.name "Test"', { cwd: tempRepo, stdio: "pipe" });
    writeFileSync(join(tempRepo, "README.md"), "# Test");
    execSync("git add .", { cwd: tempRepo, stdio: "pipe" });
    execSync('git commit -m "initial"', { cwd: tempRepo, stdio: "pipe" });
    execSync(`git push "${bareDir}" HEAD:main`, { cwd: tempRepo, stdio: "pipe" });

    // Now create worktree from the bare repo
    const worktreePath = join(TEST_DIR, "bare-wt");
    execSync(`git worktree add "${worktreePath}" -b shkmn/bare-test main`, { cwd: bareDir, stdio: "pipe" });

    const resolved = resolveParentRepo(worktreePath);
    expect(resolved).not.toBeNull();

    const normalize = (p: string) => realpathSync.native(p).replace(/\\/g, "/").toLowerCase();
    expect(normalize(resolved!)).toBe(normalize(bareDir));
  }, TEST_TIMEOUT);
});
