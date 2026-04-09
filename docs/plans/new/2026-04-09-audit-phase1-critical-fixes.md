# Audit Phase 1: Critical Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two P0 bugs — worktree cleanup recording the wrong `repoPath` (leaking worktrees forever), and the PR agent staging secrets via `git add -A`.

**Architecture:** Fix 1 adds a `resolveParentRepo()` utility in `worktree.ts` that reads the `.git` file inside a worktree to derive the parent repo, then uses it in `pipeline.ts`'s `recordCompletionIfWorktree` fallback chain. Fix 2 replaces the `git add -A` in the PR agent prompt with `git add -u` + an explicit exclusion list and pre-commit verification, and adds `.gitignore` enforcement in `createWorktree`.

**Tech Stack:** TypeScript, Vitest, Node.js `fs`/`child_process`, git CLI

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/core/worktree.ts` | Add `resolveParentRepo()`, add `.gitignore` enforcement in `createWorktree` |
| Modify | `src/core/pipeline.ts` | Fix `recordCompletionIfWorktree` fallback chain |
| Modify | `agents/pr.md` | Replace `git add -A` with safe staging sequence |
| Modify | `tests/core/worktree.test.ts` | Add tests for `resolveParentRepo`, `.gitignore` enforcement, correct `repoPath` in cleanup |

---

## Task 1: Add `resolveParentRepo` utility to `worktree.ts`

**Files:**
- Modify: `src/core/worktree.ts`
- Modify: `tests/core/worktree.test.ts`

- [ ] **Step 1: Write failing tests for `resolveParentRepo`**

Add to `tests/core/worktree.test.ts`:

```typescript
import {
  createWorktree,
  removeWorktree,
  listWorktrees,
  cleanupExpired,
  recordWorktreeCompletion,
  resolveParentRepo,        // ADD THIS
  type WorktreeInfo,
} from "../../src/core/worktree.js";

// After the existing "shell injection prevention" describe block:

describe("resolveParentRepo", () => {
  it("resolves the parent repo from a worktree .git file", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    const worktreePath = createWorktree(REPO_DIR, "resolve-test", worktreesDir);

    const resolved = resolveParentRepo(worktreePath);
    // Normalize paths for comparison (Windows vs Unix)
    expect(resolved).not.toBeNull();
    expect(resolved!.replace(/\\/g, "/").toLowerCase())
      .toBe(REPO_DIR.replace(/\\/g, "/").toLowerCase());
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/worktree.test.ts -t "resolveParentRepo"`
Expected: FAIL — `resolveParentRepo` is not exported from `worktree.ts`

- [ ] **Step 3: Implement `resolveParentRepo` in `worktree.ts`**

Add after the existing imports at the top of `src/core/worktree.ts`:

```typescript
import { statSync } from "node:fs";
```

Add the `statSync` to the existing import from `node:fs` (merge with `existsSync`, `readFileSync`, etc.).

Add before the `// ─── Manifest helpers` section:

```typescript
/**
 * Resolves the parent repository path from a git worktree directory.
 * Worktrees have a `.git` file (not directory) containing:
 *   gitdir: /path/to/parent/.git/worktrees/<name>
 * Returns the parent repo root, or null if the path is not a worktree.
 */
export function resolveParentRepo(worktreePath: string): string | null {
  try {
    const dotGit = join(worktreePath, ".git");
    // Worktrees have a .git *file*, not a directory
    const stat = statSync(dotGit);
    if (stat.isDirectory()) return null; // Regular repo, not a worktree

    const content = readFileSync(dotGit, "utf-8").trim();
    // Format: "gitdir: /path/to/parent/.git/worktrees/<name>"
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) return null;

    const gitdir = match[1].trim();
    // Walk up from .git/worktrees/<name> → .git → repo root
    // gitdir points to: <parent-repo>/.git/worktrees/<worktree-name>
    const dotGitDir = dirname(dirname(gitdir)); // .git/worktrees/<name> → .git
    return dirname(dotGitDir); // .git → repo root
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/worktree.test.ts -t "resolveParentRepo"`
Expected: PASS — all 3 tests green

- [ ] **Step 5: Commit**

```bash
git add src/core/worktree.ts tests/core/worktree.test.ts
git commit -m "feat(worktree): add resolveParentRepo utility to derive parent repo from worktree .git file"
```

---

## Task 2: Fix `recordCompletionIfWorktree` fallback chain in `pipeline.ts`

**Files:**
- Modify: `src/core/pipeline.ts:443-456`
- Modify: `tests/core/worktree.test.ts` (integration test for cleanup with correct repoPath)

- [ ] **Step 1: Write failing test for correct repoPath derivation via cleanupExpired**

Add to `tests/core/worktree.test.ts` inside the existing `cleanupExpired` describe block:

```typescript
  it("successfully cleans up when repoPath was derived from worktree metadata", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    const manifestPath = join(TEST_DIR, "worktree-manifest.json");
    const worktreePath = createWorktree(REPO_DIR, "derived-repo-task", worktreesDir);

    // Simulate what the fixed pipeline does: resolve parent from worktree
    const derivedRepo = resolveParentRepo(worktreePath);
    expect(derivedRepo).not.toBeNull();

    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 8);
    recordWorktreeCompletion(manifestPath, {
      slug: "derived-repo-task",
      repoPath: derivedRepo!, // derived, not hardcoded
      worktreePath,
      completedAt: oldDate.toISOString(),
    });

    const removed = cleanupExpired(manifestPath, 7);
    expect(removed).toContain(worktreePath);
    expect(existsSync(worktreePath)).toBe(false);

    // Branch should also be removed
    const branches = execSync("git branch", { cwd: REPO_DIR, encoding: "utf-8" });
    expect(branches).not.toContain("shkmn/derived-repo-task");
  }, TEST_TIMEOUT);

  it("fails cleanup when repoPath is the worktree itself (demonstrates the bug)", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    const manifestPath = join(TEST_DIR, "worktree-manifest.json");
    const worktreePath = createWorktree(REPO_DIR, "bad-repo-task", worktreesDir);

    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 8);
    // Record with worktreePath as repoPath — the bug we're fixing
    recordWorktreeCompletion(manifestPath, {
      slug: "bad-repo-task",
      repoPath: worktreePath, // BUG: same as worktreePath
      worktreePath,
      completedAt: oldDate.toISOString(),
    });

    // Cleanup runs but the worktree removal will fail silently
    // because git worktree remove runs with cwd=worktreePath (self-referential)
    const removed = cleanupExpired(manifestPath, 7);
    // It reports it as removed (from manifest) but the directory still exists
    expect(removed).toContain(worktreePath);
    // The branch is NOT cleaned up because the cwd was wrong
    const branches = execSync("git branch", { cwd: REPO_DIR, encoding: "utf-8" });
    expect(branches).toContain("shkmn/bad-repo-task");
  }, TEST_TIMEOUT);
```

- [ ] **Step 2: Run tests to verify the new tests pass (they test the existing behavior)**

Run: `npx vitest run tests/core/worktree.test.ts -t "cleanupExpired"`
Expected: PASS — these tests validate the existing behavior (both the correct and broken paths)

- [ ] **Step 3: Fix `recordCompletionIfWorktree` in `pipeline.ts`**

In `src/core/pipeline.ts`, update the import to include `resolveParentRepo`:

```typescript
import { createWorktree, recordWorktreeCompletion, resolveParentRepo } from "./worktree.js";
```

Replace the `recordCompletionIfWorktree` function (lines 443-456) with:

```typescript
  function recordCompletionIfWorktree(state: RunState): void {
    if (!state.worktreePath) return;
    const manifestPath = join(runtimeDir, "worktree-manifest.json");

    // Resolution chain for repoPath:
    // 1. state.repoRoot (set when task had explicit repo)
    // 2. Derive from worktree .git metadata
    // 3. Fall back to config.repos.root
    let repoPath = state.repoRoot ?? null;
    if (!repoPath) {
      repoPath = resolveParentRepo(state.worktreePath);
    }
    if (!repoPath && config.repos.root) {
      repoPath = config.repos.root;
    }

    // Guard: if repoPath is still null or equals worktreePath, skip recording
    if (!repoPath || repoPath === state.worktreePath) {
      logger.warn(
        `[pipeline] Cannot determine parent repo for worktree "${state.slug}" — ` +
        `skipping manifest recording to avoid broken cleanup. ` +
        `worktreePath="${state.worktreePath}"`,
      );
      return;
    }

    try {
      recordWorktreeCompletion(manifestPath, {
        slug: state.slug,
        repoPath,
        worktreePath: state.worktreePath,
        completedAt: new Date().toISOString(),
      });
    } catch {
      // log but don't fail the pipeline
    }
  }
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run tests/core/worktree.test.ts`
Expected: PASS — all tests green

- [ ] **Step 5: Commit**

```bash
git add src/core/pipeline.ts tests/core/worktree.test.ts
git commit -m "fix(pipeline): resolve correct repoPath in worktree manifest to prevent cleanup failures

Previously, recordCompletionIfWorktree fell back to worktreePath when
repoRoot was undefined, causing cleanupExpired to run git worktree remove
from the worktree directory itself (self-referential cwd). This made
cleanup silently fail, leaking worktrees and shkmn/* branches.

The fallback chain now: state.repoRoot → resolveParentRepo(worktreePath)
→ config.repos.root → skip with warning."
```

---

## Task 3: Replace `git add -A` with safe staging in `agents/pr.md`

**Files:**
- Modify: `agents/pr.md`
- Modify: `tests/core/worktree.test.ts` (prompt content assertion)

- [ ] **Step 1: Write failing test asserting pr.md does NOT contain `git add -A`**

Add to `tests/core/worktree.test.ts` (new describe block at the end):

```typescript
describe("PR agent prompt safety", () => {
  it("does not contain 'git add -A' or 'git add .'", () => {
    const prPrompt = readFileSync(
      join(__dirname, "../../agents/pr.md"),
      "utf-8",
    );
    expect(prPrompt).not.toMatch(/git add -A/);
    expect(prPrompt).not.toMatch(/git add \./);
  });

  it("contains the sensitive file exclusion list", () => {
    const prPrompt = readFileSync(
      join(__dirname, "../../agents/pr.md"),
      "utf-8",
    );
    expect(prPrompt).toMatch(/\.env/);
    expect(prPrompt).toMatch(/\.pem/);
    expect(prPrompt).toMatch(/\.key/);
    expect(prPrompt).toMatch(/credentials/);
    expect(prPrompt).toMatch(/git add -u/);
  });

  it("contains pre-commit verification step", () => {
    const prPrompt = readFileSync(
      join(__dirname, "../../agents/pr.md"),
      "utf-8",
    );
    expect(prPrompt).toMatch(/git diff --cached --name-only/);
    expect(prPrompt).toMatch(/git reset HEAD/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/worktree.test.ts -t "PR agent prompt safety"`
Expected: FAIL — `git add -A` is present, exclusion list is missing

- [ ] **Step 3: Replace Step 1 in `agents/pr.md` with safe staging**

Replace the entire content of `agents/pr.md` with:

```markdown
## Step 1 — Verify Working Tree

Ensure all changes are committed:

```bash
git status --short
git log --oneline -10
```

If there are uncommitted changes, use **safe staging** (NEVER use `git add -A` or `git add .`):

### 1a. Stage tracked file changes only

```bash
git add -u
```

### 1b. Check for new untracked files that should be included

```bash
git diff --name-only --diff-filter=A HEAD || true
git ls-files --others --exclude-standard
```

For each untracked file, verify it is NOT in the exclusion list below before staging it with `git add <file>`.

### Sensitive File Exclusion List — NEVER stage these

- `.env`, `.env.*`, `.env.local`
- `*.local`
- `credentials.*`, `secrets.*`
- `*.pem`, `*.key`, `*.p12`, `*.pfx`
- `shkmn.config.json`
- Any file whose content contains `API_KEY=`, `SECRET=`, `CLIENT_SECRET=`, `TOKEN=`, `PASSWORD=`, or `CONNECTION_STRING=`

If you are unsure whether a file is sensitive, do NOT stage it.

### 1c. Pre-commit verification

Before committing, verify no sensitive files are staged:

```bash
git diff --cached --name-only
```

Scan the output for any file matching the exclusion patterns above. If found, unstage immediately:

```bash
git reset HEAD <sensitive-file>
```

### 1d. Commit

```bash
git commit -m "chore: stage remaining changes before PR"
```

If the working tree is already clean, proceed.

---

## Step 2 — Push Branch

```bash
# Get the current branch name
git branch --show-current

# Push to remote (set upstream on first push)
git push -u origin HEAD
```

If the push fails due to authentication or remote not configured, output an error and halt. Do NOT attempt to create the PR.

---

## Step 3 — Discover PR Template

Check for project-defined PR templates in this order:

```bash
ls .github/PULL_REQUEST_TEMPLATE.md .github/pull_request_template.md docs/pull_request_template.md 2>/dev/null
```

If a template exists, read it and use its structure for the PR body.

If no template exists, use the default structure in Step 4.

---

## Step 4 — Extract ADO Item ID

From the task content, extract the ADO item ID if present. Look for patterns like:
- `AB#1234` — Azure Boards work item
- `ADO Item: 1234`
- `Work Item: 1234`

If found, include a link in the format: `Resolves AB#<ID>`

---

## Step 5 — Create Pull Request

Use `gh pr create` to create the PR.

### If a PR template was found (Step 3):

Fill in the template structure using:
- The task description for the "what" and "why"
- The validation report (from previous output) for test results
- The ADO item ID if present

```bash
gh pr create \
  --title "<concise title describing what this PR does>" \
  --body "$(cat <<'PREOF'
<template-filled content>
PREOF
)"
```

### If no template was found:

```bash
gh pr create \
  --title "<concise title describing what this PR does>" \
  --body "$(cat <<'PREOF'
## Summary

- <bullet 1: primary change>
- <bullet 2: secondary change if applicable>
- <bullet 3 if applicable>

## Test Results

<Paste the test status from the validation report — passed/failed counts and key output>

## ADO

Resolves AB#<ID>
(Remove this section if no ADO item)
PREOF
)"
```

**Rules for the PR body:**
- Do NOT include the review verdict or review findings — those are internal pipeline state
- Do NOT include retry counts or pipeline metadata
- DO include what changed, why, and test evidence
- Keep the title under 72 characters
- The branch name is already set by the impl agent (shkmn/{slug}) — do not create a new branch

---

## Step 6 — Output PR URL

After successful creation, output the PR URL:

```
**PR Created:** <url>
```

This is the final line of your output.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/worktree.test.ts -t "PR agent prompt safety"`
Expected: PASS — all 3 assertions green

- [ ] **Step 5: Commit**

```bash
git add agents/pr.md tests/core/worktree.test.ts
git commit -m "fix(pr-agent): replace git add -A with safe staging to prevent secret leaks

The PR agent (Garuda) previously ran 'git add -A' which staged all files
indiscriminately, including .env files, credentials, and debug artifacts.

Now uses 'git add -u' for tracked files only, with an explicit exclusion
list for sensitive patterns and a pre-commit verification step that
unstages any accidentally included sensitive files."
```

---

## Task 4: Add `.gitignore` enforcement in `createWorktree`

**Files:**
- Modify: `src/core/worktree.ts`
- Modify: `tests/core/worktree.test.ts`

- [ ] **Step 1: Write failing test for `.gitignore` enforcement**

Add to `tests/core/worktree.test.ts` inside the `createWorktree` describe block:

```typescript
  it("ensures .gitignore in worktree excludes sensitive patterns", () => {
    const worktreesDir = join(TEST_DIR, "worktrees");
    const worktreePath = createWorktree(REPO_DIR, "gitignore-test", worktreesDir);

    const gitignorePath = join(worktreePath, ".gitignore");
    expect(existsSync(gitignorePath)).toBe(true);

    const content = readFileSync(gitignorePath, "utf-8");
    expect(content).toContain(".env");
    expect(content).toContain("*.pem");
    expect(content).toContain("*.key");
    expect(content).toContain("credentials.*");
    expect(content).toContain("shkmn.config.json");
  }, TEST_TIMEOUT);

  it("appends missing patterns to an existing .gitignore", () => {
    // Pre-create a .gitignore in the repo before creating worktree
    writeFileSync(join(REPO_DIR, ".gitignore"), "node_modules/\n");
    execSync("git add .gitignore", { cwd: REPO_DIR, stdio: "pipe" });
    execSync('git commit -m "add gitignore"', { cwd: REPO_DIR, stdio: "pipe" });

    const worktreesDir = join(TEST_DIR, "worktrees");
    const worktreePath = createWorktree(REPO_DIR, "existing-gitignore", worktreesDir);

    const content = readFileSync(join(worktreePath, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules/");
    expect(content).toContain(".env");
    expect(content).toContain("*.key");
  }, TEST_TIMEOUT);

  it("does not duplicate patterns in existing .gitignore", () => {
    writeFileSync(join(REPO_DIR, ".gitignore"), ".env\nnode_modules/\n");
    execSync("git add .gitignore", { cwd: REPO_DIR, stdio: "pipe" });
    execSync('git commit -m "add gitignore with .env"', { cwd: REPO_DIR, stdio: "pipe" });

    const worktreesDir = join(TEST_DIR, "worktrees");
    const worktreePath = createWorktree(REPO_DIR, "no-dup-gitignore", worktreesDir);

    const content = readFileSync(join(worktreePath, ".gitignore"), "utf-8");
    const envMatches = content.match(/^\.env$/gm);
    expect(envMatches).toHaveLength(1); // not duplicated
  }, TEST_TIMEOUT);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/worktree.test.ts -t "ensures .gitignore" -t "appends missing" -t "does not duplicate"`
Expected: FAIL — `.gitignore` is not created/enforced by `createWorktree`

- [ ] **Step 3: Add `.gitignore` enforcement to `createWorktree` in `worktree.ts`**

Add after the manifest recording in `createWorktree` (before the `return worktreePath;` at line 59), and add the constant and helper:

Add the constant near the top of the file (after imports):

```typescript
const SENSITIVE_GITIGNORE_PATTERNS = [
  ".env",
  ".env.*",
  "*.local",
  "credentials.*",
  "secrets.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "shkmn.config.json",
];
```

Add the helper before the `// ─── Manifest helpers` section:

```typescript
/**
 * Ensures that the worktree's .gitignore includes all sensitive-file patterns.
 * Appends missing patterns without duplicating existing ones.
 */
function ensureSensitiveGitignore(worktreePath: string): void {
  const gitignorePath = join(worktreePath, ".gitignore");
  let existing = "";
  try {
    existing = readFileSync(gitignorePath, "utf-8");
  } catch {
    // No .gitignore yet — will create one
  }

  const existingLines = new Set(existing.split(/\r?\n/).map(l => l.trim()));
  const missing = SENSITIVE_GITIGNORE_PATTERNS.filter(p => !existingLines.has(p));

  if (missing.length === 0) return;

  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const block = `${separator}\n# ShaktimaanAI: sensitive file exclusions\n${missing.join("\n")}\n`;
  writeFileSync(gitignorePath, existing + block, "utf-8");
}
```

Then add the call inside `createWorktree`, after the manifest recording try/catch block and before `return worktreePath;`:

```typescript
  // Ensure .gitignore excludes sensitive files
  ensureSensitiveGitignore(worktreePath);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/worktree.test.ts`
Expected: PASS — all tests green (including new `.gitignore` tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/worktree.ts tests/core/worktree.test.ts
git commit -m "fix(worktree): enforce .gitignore with sensitive file exclusions on creation

createWorktree now ensures the worktree has a .gitignore covering .env,
credentials, keys, and other sensitive patterns. Appends missing patterns
to existing .gitignore without duplicating."
```

---

## Task 5: Run full test suite and verify build

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: PASS — all existing + new tests green, zero failures

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: PASS — clean build, `agents/pr.md` copied to `dist/agents/pr.md`

- [ ] **Step 3: Verify the built `pr.md` has safe staging**

Run: `grep -c "git add -A" dist/agents/pr.md` → should output `0`
Run: `grep -c "git add -u" dist/agents/pr.md` → should output `1`

- [ ] **Step 4: Final commit (if any lint/build fixes needed)**

Only if build or test revealed issues; otherwise skip.
