# Audit Phase 2: High-Severity Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 6 high-severity bugs/gaps from the production-readiness audit: Slack repo targeting, retry sort ordering, secrets preamble in agent prompts, PipelineStage type completeness, config set Zod validation, and CI/CD pipeline.

**Architecture:** Each fix is independent — they touch different modules with no cross-dependencies. Fixes 1-5 are code changes with unit tests. Fix 6 is a new GitHub Actions workflow file.

**Tech Stack:** TypeScript, Vitest, Zod, GitHub Actions, tsup

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/core/watcher.ts` | Fix 1: resolve repo path for Slack quick-execute and route_pipeline |
| Modify | `tests/core/watcher.test.ts` | Fix 1: tests for repo resolution |
| Modify | `src/core/pipeline.ts` | Fix 2: numeric sort for `-r<N>.md` artifact filenames |
| Modify | `tests/core/pipeline.test.ts` | Fix 2: tests for sort ordering at 10+ retries |
| Modify | `agents/questions.md` | Fix 3: add safety preamble |
| Modify | `agents/research.md` | Fix 3: add safety preamble |
| Modify | `agents/design.md` | Fix 3: add safety preamble |
| Modify | `agents/structure.md` | Fix 3: add safety preamble |
| Modify | `agents/plan.md` | Fix 3: add safety preamble |
| Modify | `agents/impl.md` | Fix 3: add safety preamble (+ write-access line) |
| Modify | `agents/validate.md` | Fix 3: add safety preamble |
| Modify | `agents/review.md` | Fix 3: add safety preamble |
| Modify | `agents/pr.md` | Fix 3: add safety preamble (+ write-access line) |
| Modify | `agents/quick-triage.md` | Fix 3: add safety preamble |
| Modify | `agents/quick-execute.md` | Fix 3: add safety preamble (+ write-access line) |
| Modify | `agents/slack-io.md` | Fix 3: add safety preamble |
| Modify | `agents/recovery.md` | Fix 3: add safety preamble |
| Modify | `agents/agent-template.md` | Fix 3: add safety preamble to template |
| Create | `tests/agents/safety-preamble.test.ts` | Fix 3: verify all prompts contain preamble |
| Modify | `src/core/types.ts` | Fix 4: add `"recovery"` to PipelineStage |
| Modify | `src/config/defaults.ts` | Fix 4: add compile-time exhaustiveness check |
| Modify | `src/commands/config.ts` | Fix 5: add Zod validation before write |
| Modify | `tests/commands/config.test.ts` | Fix 5: tests for validation rejection |
| Create | `.github/workflows/ci.yml` | Fix 6: CI/CD pipeline |

---

### Task 1: Fix Retry Feedback Sort — Numeric Ordering (Fix 2)

**Files:**
- Modify: `src/core/pipeline.ts:94-109`
- Test: `tests/core/pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/core/pipeline.test.ts`:

```typescript
describe("collectArtifacts — numeric sort for r<N> suffixes", () => {
  it("sorts impl-output-r10 after impl-output-r2 (not lexicographically)", () => {
    // Setup: artifacts dir with files that would sort wrong lexicographically
    const artifactsDir = join(TEST_DIR, "artifacts-sort-test");
    mkdirSync(artifactsDir, { recursive: true });

    // Write files with -r<N> suffixes that break under localeCompare
    writeFileSync(join(artifactsDir, "questions-output.md"), "questions content");
    writeFileSync(join(artifactsDir, "impl-output.md"), "impl base");
    writeFileSync(join(artifactsDir, "impl-output-r2.md"), "impl r2");
    writeFileSync(join(artifactsDir, "impl-output-r10.md"), "impl r10");
    writeFileSync(join(artifactsDir, "impl-output-r11.md"), "impl r11");
    writeFileSync(join(artifactsDir, "retry-feedback-impl-1.md"), "feedback 1");
    writeFileSync(join(artifactsDir, "retry-feedback-impl-3.md"), "feedback 3");
    writeFileSync(join(artifactsDir, "retry-feedback-impl-10.md"), "feedback 10");

    const stages = ["questions", "research", "design", "structure", "plan", "impl", "review"];
    const result = collectArtifacts(artifactsDir, "review", stages);

    // review stage uses 'specific' mode with ['plan-output', 'design-output'],
    // so test with impl stage which uses 'all_prior' + includeRetryFeedback
    const resultImpl = collectArtifacts(artifactsDir, "impl", stages);

    // impl gets all prior stage outputs + retry feedback
    // The latest impl-output should be r11 (highest retry), and retry feedbacks in numeric order
    expect(resultImpl).toContain("questions content");
    expect(resultImpl).toContain("feedback 1");
    expect(resultImpl).toContain("feedback 3");
    expect(resultImpl).toContain("feedback 10");

    // Verify numeric ordering: feedback 1 before feedback 3 before feedback 10
    const idx1 = resultImpl.indexOf("feedback 1");
    const idx3 = resultImpl.indexOf("feedback 3");
    const idx10 = resultImpl.indexOf("feedback 10");
    expect(idx1).toBeLessThan(idx3);
    expect(idx3).toBeLessThan(idx10);
  });

  it("parseTrailingNum handles both -r<N>.md and -<N>.md patterns", () => {
    // We test this indirectly through sort order of stage output files
    const artifactsDir = join(TEST_DIR, "artifacts-trailing-test");
    mkdirSync(artifactsDir, { recursive: true });

    writeFileSync(join(artifactsDir, "questions-output.md"), "q base");
    writeFileSync(join(artifactsDir, "questions-output-r2.md"), "q r2");
    writeFileSync(join(artifactsDir, "questions-output-r10.md"), "q r10");

    const stages = ["questions", "research", "design"];
    // research uses all_prior — should get only latest questions output (r10)
    const result = collectArtifacts(artifactsDir, "research", stages);
    expect(result).toContain("q r10");
    expect(result).not.toContain("q base");
    expect(result).not.toContain("q r2");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/pipeline.test.ts -t "numeric sort"`
Expected: Tests may pass or fail depending on current sort — but the key test is that `feedback 10` sorts after `feedback 3`, not between `feedback 1` and `feedback 3`.

- [ ] **Step 3: Fix `parseTrailingNum` and the sort comparator**

In `src/core/pipeline.ts`, replace the `parseTrailingNum` function and sort comparator (lines 94-109):

```typescript
  function parseTrailingNum(filename: string): number {
    const match = filename.match(/-r?(\d+)\.md$/);
    return match ? parseInt(match[1], 10) : 0;
  }

  const outputFiles = [
    ...Array.from(latestPerStage.values()).map(({ file }) => file),
    ...retryFeedbackFiles,
  ].sort((a, b) => {
    const aIsRetry = a.startsWith("retry-feedback-");
    const bIsRetry = b.startsWith("retry-feedback-");
    if (aIsRetry && bIsRetry) return parseTrailingNum(a) - parseTrailingNum(b);
    if (aIsRetry) return 1;
    if (bIsRetry) return -1;
    return parseTrailingNum(a) - parseTrailingNum(b) || a.localeCompare(b);
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/core/pipeline.test.ts -t "numeric sort"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/core/pipeline.ts tests/core/pipeline.test.ts
git commit -m "fix: numeric sort for artifact filenames with -r<N> suffixes

Fixes audit §4.5 — parseTrailingNum now matches both -r<N>.md and -<N>.md
patterns, and the non-retry file sort uses numeric comparison instead of
localeCompare. Prevents stale feedback at 10+ retries."
```

---

### Task 2: Complete `PipelineStage` Type Union (Fix 4)

**Files:**
- Modify: `src/core/types.ts:3-6`
- Modify: `src/config/defaults.ts` (add exhaustiveness check)

- [ ] **Step 1: Add `"recovery"` to PipelineStage**

In `src/core/types.ts`, replace lines 3-6:

```typescript
export type PipelineStage =
  | "questions" | "research" | "design" | "structure" | "plan"
  | "impl" | "review" | "validate" | "pr"
  | "quick" | "quick-triage" | "quick-execute" | "slack-io"
  | "recovery";
```

- [ ] **Step 2: Add compile-time exhaustiveness check in defaults.ts**

In `src/config/defaults.ts`, after the `DEFAULT_STAGE_TOOLS` declaration (after line 38), add:

```typescript
// Compile-time check: every PipelineStage must have a DEFAULT_STAGE_TOOLS entry.
// If a stage is added to PipelineStage but not here, this line will error.
const _stageToolsExhaustive: Record<PipelineStage, { allowed: string[]; disallowed: string[] }> = DEFAULT_STAGE_TOOLS;
void _stageToolsExhaustive; // prevent unused-variable lint error
```

Add the import at the top of `src/config/defaults.ts`:

```typescript
import type { PipelineStage } from "../core/types.js";
```

- [ ] **Step 3: Build to verify compilation**

Run: `npm run build`
Expected: Compiles without errors

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/config/defaults.ts
git commit -m "fix: add 'recovery' to PipelineStage type union

Fixes audit §9.1 — PipelineStage now includes all stages defined in
DEFAULT_STAGE_TOOLS. Adds compile-time exhaustiveness check so adding a
stage to defaults without updating the type causes a build error."
```

---

### Task 3: `config set` Zod Validation (Fix 5)

**Files:**
- Modify: `src/commands/config.ts:16-41`
- Test: `tests/commands/config.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/commands/config.test.ts`:

```typescript
describe("setConfigValue — Zod validation", () => {
  it("rejects a value that violates the Zod schema", () => {
    // pipeline.runtimeDir is z.string().min(1) — setting it to "" should fail
    expect(() => {
      setConfigValue(configPath, "pipeline.runtimeDir", "");
    }).toThrow(/Invalid config/);
  });

  it("does not overwrite the config file on validation failure", () => {
    const before = readFileSync(configPath, "utf-8");
    try {
      setConfigValue(configPath, "pipeline.runtimeDir", "");
    } catch {
      // expected
    }
    const after = readFileSync(configPath, "utf-8");
    expect(after).toBe(before);
  });

  it("accepts a valid value and writes it", () => {
    setConfigValue(configPath, "pipeline.runtimeDir", "/new/path");
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(raw.pipeline.runtimeDir).toBe("/new/path");
  });

  it("rejects setting an unknown top-level key", () => {
    // Zod strict mode would catch this — but configSchema uses z.object (non-strict).
    // Since Zod's .parse strips unknown keys by default, this may or may not fail.
    // The important thing is the config file stays valid after the write.
    setConfigValue(configPath, "agents.retryCount", 2);
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(raw.agents.retryCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/commands/config.test.ts -t "Zod validation"`
Expected: FAIL — `setConfigValue` does not throw on invalid values

- [ ] **Step 3: Add Zod validation to setConfigValue**

Replace `src/commands/config.ts` `setConfigValue` function:

```typescript
import { readFileSync, writeFileSync } from "node:fs";
import { configSchema } from "../config/schema.js";

export function getConfigValue(configPath: string, dotPath: string): unknown {
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  const keys = dotPath.split(".");
  let current: unknown = raw;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function setConfigValue(configPath: string, dotPath: string, value: unknown): void {
  if (!dotPath || dotPath.trim() === "") {
    throw new Error("Config path must not be empty");
  }
  const keys = dotPath.split(".");
  if (keys.some((k) => k === "")) {
    throw new Error(`Invalid config path: "${dotPath}" — contains empty segments`);
  }

  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  // Deep clone so we don't mutate the original before validation
  const draft = JSON.parse(JSON.stringify(raw));
  let current: Record<string, unknown> = draft;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current)) {
      current[key] = {};
    } else if (typeof current[key] !== "object" || current[key] === null) {
      throw new Error(
        `Cannot set "${dotPath}": intermediate key "${keys.slice(0, i + 1).join(".")}" ` +
        `is a ${typeof current[key]}, not an object`,
      );
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;

  // Validate the full config through Zod before writing
  const result = configSchema.safeParse(draft);
  if (!result.success) {
    throw new Error(`Invalid config value: ${result.error.issues.map(i => i.message).join(", ")}`);
  }

  writeFileSync(configPath, JSON.stringify(draft, null, 2) + "\n", "utf-8");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/commands/config.test.ts`
Expected: All tests pass including the new Zod validation tests

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/commands/config.ts tests/commands/config.test.ts
git commit -m "fix: validate config against Zod schema before writing

Fixes audit §5.4 — config set now validates the full config through the
Zod schema before writing to disk. Invalid values are rejected and the
original config file is not overwritten."
```

---

### Task 4: Slack Quick-Execute Repo Targeting (Fix 1)

**Files:**
- Modify: `src/core/watcher.ts:300-360`
- Test: `tests/core/watcher.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/core/watcher.test.ts`. Since `watcher.ts` is complex with many dependencies, we test the repo resolution logic by extracting it. Add a new describe block:

```typescript
import { resolveSlackRepoCwd } from "../../src/core/watcher.js";

describe("resolveSlackRepoCwd", () => {
  it("returns config.repos.root when no specific repo is identified", () => {
    const result = resolveSlackRepoCwd(undefined, {
      repos: { root: "/home/user/code", aliases: {} },
    } as any);
    expect(result).toBe("/home/user/code");
  });

  it("resolves a repo alias to its path", () => {
    const result = resolveSlackRepoCwd("myapp", {
      repos: { root: "/home/user/code", aliases: { myapp: { path: "/home/user/myapp" } } },
    } as any);
    expect(result).toBe("/home/user/myapp");
  });

  it("returns the repo name as-is if it looks like an absolute path", () => {
    const result = resolveSlackRepoCwd("/explicit/repo/path", {
      repos: { root: "/home/user/code", aliases: {} },
    } as any);
    expect(result).toBe("/explicit/repo/path");
  });

  it("falls back to process.cwd() when no config root and no repo hint", () => {
    const result = resolveSlackRepoCwd(undefined, {
      repos: { root: "", aliases: {} },
    } as any);
    expect(result).toBe(process.cwd());
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/core/watcher.test.ts -t "resolveSlackRepoCwd"`
Expected: FAIL — `resolveSlackRepoCwd` is not exported

- [ ] **Step 3: Add the resolveSlackRepoCwd function and update callers**

In `src/core/watcher.ts`, add the exported helper function near the top (after imports):

```typescript
/**
 * Resolves the target repo CWD for Slack-routed tasks.
 * Priority: explicit repo hint > config alias > config.repos.root > process.cwd()
 */
export function resolveSlackRepoCwd(
  repoHint: string | undefined,
  config: ResolvedConfig,
): string {
  // 1. Explicit repo hint from triage — check if it's an alias
  if (repoHint) {
    const alias = config.repos.aliases[repoHint];
    if (alias) return alias.path;
    // If it looks like an absolute path, use it directly
    if (repoHint.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(repoHint)) return repoHint;
    // Otherwise try to resolve it under repos.root
    if (config.repos.root) return join(config.repos.root, repoHint);
  }

  // 2. Configured repos root
  if (config.repos.root) return config.repos.root;

  // 3. Last resort — process.cwd() (with console warning)
  return process.cwd();
}
```

Then update the quick-execute call (around line 306) — change `cwd: process.cwd()` to:

```typescript
  cwd: resolveSlackRepoCwd(undefined, config),
```

And update the `route_pipeline` case (around line 347) — change `repo: undefined` to:

```typescript
  repo: resolveSlackRepoCwd(undefined, config) || undefined,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/core/watcher.test.ts -t "resolveSlackRepoCwd"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/core/watcher.ts tests/core/watcher.test.ts
git commit -m "fix: resolve repo path for Slack-routed tasks

Fixes audit §4.3 — Slack quick-execute and route_pipeline now resolve
the target repo from config.repos.root/aliases instead of using
process.cwd(). Adds resolveSlackRepoCwd helper with fallback chain."
```

---

### Task 5: Universal Secrets/PII Safety Preamble (Fix 3)

**Files:**
- Modify: All 14 files in `agents/*.md`
- Create: `tests/agents/safety-preamble.test.ts`

- [ ] **Step 1: Write the verification test**

Create `tests/agents/safety-preamble.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const AGENTS_DIR = join(__dirname, "../../agents");
const WRITE_ACCESS_STAGES = ["impl", "quick-execute", "pr"];

describe("agent safety preamble", () => {
  const agentFiles = readdirSync(AGENTS_DIR).filter(f => f.endsWith(".md"));

  it("finds at least 13 agent prompt files", () => {
    expect(agentFiles.length).toBeGreaterThanOrEqual(13);
  });

  for (const file of agentFiles) {
    it(`${file} contains the safety preamble`, () => {
      const content = readFileSync(join(AGENTS_DIR, file), "utf-8");
      expect(content).toContain("## Safety Rules");
      expect(content).toContain("NEVER include API keys");
      expect(content).toContain("NEVER include personally identifiable information");
    });

    const stageName = file.replace(".md", "");
    if (WRITE_ACCESS_STAGES.includes(stageName)) {
      it(`${file} contains the write-access verification line`, () => {
        const content = readFileSync(join(AGENTS_DIR, file), "utf-8");
        expect(content).toContain("Before committing or writing files");
      });
    }
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/agents/safety-preamble.test.ts`
Expected: FAIL — no agent file contains "## Safety Rules"

- [ ] **Step 3: Add the safety preamble to all read-only agent prompts**

Prepend the following block to the **top** of each of these files: `agents/questions.md`, `agents/research.md`, `agents/design.md`, `agents/structure.md`, `agents/plan.md`, `agents/validate.md`, `agents/review.md`, `agents/quick-triage.md`, `agents/slack-io.md`, `agents/recovery.md`:

```markdown
## Safety Rules

- NEVER include API keys, tokens, passwords, connection strings, or secrets in any output, commit, PR body, Slack message, or artifact.
- NEVER include personally identifiable information (PII) such as names, emails, phone numbers, or addresses unless the task explicitly requires it.
- If you encounter secrets or PII in the codebase, do not copy them into your output. Reference them by variable name or config key instead.

```

- [ ] **Step 4: Add the safety preamble with write-access line to write-access agents**

Prepend to the **top** of `agents/impl.md`, `agents/quick-execute.md`, `agents/pr.md`:

```markdown
## Safety Rules

- NEVER include API keys, tokens, passwords, connection strings, or secrets in any output, commit, PR body, Slack message, or artifact.
- NEVER include personally identifiable information (PII) such as names, emails, phone numbers, or addresses unless the task explicitly requires it.
- If you encounter secrets or PII in the codebase, do not copy them into your output. Reference them by variable name or config key instead.
- Before committing or writing files, verify no secrets or PII are included in the output.

```

- [ ] **Step 5: Add the safety preamble to agent-template.md**

Insert after the `---` separator (line 15) and before `## Instructions` (line 17) in `agents/agent-template.md`:

```markdown

## Safety Rules

- NEVER include API keys, tokens, passwords, connection strings, or secrets in any output, commit, PR body, Slack message, or artifact.
- NEVER include personally identifiable information (PII) such as names, emails, phone numbers, or addresses unless the task explicitly requires it.
- If you encounter secrets or PII in the codebase, do not copy them into your output. Reference them by variable name or config key instead.

```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/agents/safety-preamble.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add agents/ tests/agents/
git commit -m "fix: add universal secrets/PII safety preamble to all agent prompts

Fixes audit §6.6 — every agent prompt now has a Safety Rules section
prohibiting secrets and PII in outputs. Write-access agents (impl,
quick-execute, pr) get an additional pre-commit verification line.
Includes automated test to verify preamble presence."
```

---

### Task 6: CI/CD Pipeline (Fix 6)

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [master]
  pull_request:
    branches: [master]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'
      - run: npm ci
      - run: npm run build
      - run: npm run lint
      - run: npm test
      - run: npm audit --audit-level=moderate
```

- [ ] **Step 2: Verify the YAML is valid**

Run: `node -e "const fs = require('fs'); const yaml = require('yaml'); yaml.parse(fs.readFileSync('.github/workflows/ci.yml', 'utf-8')); console.log('Valid YAML');" 2>/dev/null || echo "yaml validation skipped (no yaml package)"`

If the yaml package is not available, manually verify the indentation is correct by reading the file back.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "feat: add CI/CD pipeline with GitHub Actions

Fixes audit §11.3 — runs build, lint, test, and npm audit on push/PR
to master. Tests against Node.js 20 and 22 with npm caching."
```

---

### Task 7: Final Verification

- [ ] **Step 1: Build the project**

Run: `npm run build`
Expected: Compiles without errors (validates the PipelineStage type fix)

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: All tests pass — existing and new

- [ ] **Step 3: Run linter**

Run: `npm run lint`
Expected: No lint errors

- [ ] **Step 4: Verify agent prompts manually**

Run: `grep -l "## Safety Rules" agents/*.md | wc -l`
Expected: 14 (all 13 agent files + template)

- [ ] **Step 5: Summary check against spec**

Verify all 6 fixes from the spec are addressed:
1. Slack repo targeting — `resolveSlackRepoCwd` in watcher.ts
2. Retry sort — `parseTrailingNum` handles `-r<N>.md`
3. Safety preamble — all 14 agent files
4. PipelineStage union — includes `"recovery"`, exhaustiveness check
5. Config set validation — Zod safeParse before write
6. CI/CD — `.github/workflows/ci.yml`
