# Audit Phase 2: High-Severity Fixes

**Date:** 2026-04-09
**Source:** [Production-Readiness Audit](../../production-readiness-audit.md) — Phase 2 (P1)
**Scope:** 6 confirmed high-severity bugs/gaps required for reliable operation
**Prerequisite:** Phase 1 complete

---

## Audit Reconciliation

The audit identified 9 items for Phase 2. After code verification (2026-04-09), 4 were already fixed or moved:

| Audit # | Finding | Status | Evidence |
|---------|---------|--------|----------|
| 4.1 | Missing `task_completed` on approval | **FIXED** | `pipeline.ts:1032-1044` — emits notification correctly |
| 4.2 | PID file deleted while process running | **FIXED** | `stop.ts:42-50` — only deletes on failed kill check |
| 4.3 | Slack tasks target wrong repo | **OPEN** | `watcher.ts:306` — `process.cwd()` in quick-execute |
| 4.4 | `modifyStages` skips currentStage check | **FIXED** | `pipeline.ts:1215-1220` — validation in place |
| 4.5 | Retry feedback sort breaks at 10+ | **OPEN** | `pipeline.ts:109` — uses `localeCompare` |
| 6.6 | No secrets preamble in agent prompts | **OPEN** | Verified: no prompt has universal secrets rule |
| 9.1 | `PipelineStage` union incomplete | **OPEN** | `types.ts:3-6` — missing `recovery` |
| 11.3 | No CI/CD pipeline | **OPEN** | `.github/workflows/` does not exist |
| 5.4 | `config set` bypasses Zod validation | **MOVED FROM PHASE 3** | Confirmed critical enough for Phase 2 |

**Remaining scope: 6 fixes across 5 modules.**

---

## Fix 1: Slack Quick-Execute Repo Targeting

### Audit Reference

- **Audit §4.3** — "Slack `route_pipeline` hardcodes `repo` to `process.cwd()`"
- **Severity:** P1 — every Slack-routed quick-execute task runs in the wrong directory

### Current Behavior

**File:** `src/core/watcher.ts`, line 306

```typescript
const executeResult = await runner({
  stage: "quick-execute",
  slug: `astra-exec-${entry.ts.replace(".", "-")}`,
  taskContent: astraInput.message,
  previousOutput: triageResult.enrichedContext ?? "",
  outputPath: join(outputDir, `${entry.ts.replace(".", "-")}.md`),
  cwd: process.cwd(),  // BUG: daemon CWD, not target repo
  config,
  logger: { info() {}, warn() {}, error() {} },
});
```

The daemon's `cwd` is the runtime directory (where `shkmn start` was invoked), not the target repository. Agents run in the wrong directory and fail to find the codebase.

### Required Changes

**Module: `src/core/watcher.ts`**

1. Resolve the target repo path using this priority chain:
   - `triageResult.enrichedContext` — if triage identified a specific repo, parse it
   - `config.repos.root` — the configured repository root
   - `config.repos.aliases` — if the task mentions a known alias, resolve to its path
   - Fall back to `process.cwd()` only as a last resort, with a warning log

2. Apply the same resolution to the `route_pipeline` case (line 352) where `repo: undefined` is passed to `createTask`.

### Testing Requirements

- Test that quick-execute uses `config.repos.root` when no specific repo is identified
- Test that `route_pipeline` passes a resolved repo path, not `undefined`
- Test the fallback chain: triageResult > config.repos.root > process.cwd()

### Success Criteria

Slack-routed tasks (both quick-execute and pipeline) target the correct repository. No task should silently run against the daemon's CWD.

---

## Fix 2: Retry Feedback Sort — Numeric Ordering

### Audit Reference

- **Audit §4.5** — "`retryFeedbackFiles` lexicographic sort breaks at 10+ retries"
- **Severity:** P1 — impl agent receives stale feedback, potentially regressing fixes

### Current Behavior

**File:** `src/core/pipeline.ts`, lines 103-110

```typescript
.sort((a, b) => {
  const aIsRetry = a.startsWith("retry-feedback-");
  const bIsRetry = b.startsWith("retry-feedback-");
  if (aIsRetry && bIsRetry) return parseTrailingNum(a) - parseTrailingNum(b);
  if (aIsRetry) return 1;
  if (bIsRetry) return -1;
  return a.localeCompare(b);  // BUG: lexicographic for stage outputs
});
```

Retry feedback files are sorted numerically (correct), but stage output files use `localeCompare`. The artifact naming convention uses `-r<N>.md` suffixes (e.g., `impl-output-r2.md`, `impl-output-r10.md`). The `parseRetryNum` function (line 26) extracts the retry number from `-r<N>` suffixes, and `collectArtifacts` already selects only the latest output per stage. However, `parseTrailingNum` (used for the final sort at line 109) matches `-(\d+).md$` — this pattern does **not** match the `-r<N>.md` convention, so the numeric sort for non-retry files is ineffective.

### Required Changes

**Module: `src/core/pipeline.ts`**

1. Update `parseTrailingNum` to match the actual `-r<N>.md` artifact naming convention:
   ```typescript
   function parseTrailingNum(filename: string): number {
     const match = filename.match(/-r?(\d+)\.md$/);
     return match ? parseInt(match[1], 10) : 0;
   }
   ```
   This handles both `retry-feedback-impl-3.md` (plain numeric) and `impl-output-r10.md` (`-r<N>`) formats.

2. Replace the final `a.localeCompare(b)` with numeric-aware sorting:
   ```
   return parseTrailingNum(a) - parseTrailingNum(b) || a.localeCompare(b);
   ```

### Testing Requirements

- Test sort order with files: `impl-output.md`, `impl-output-r2.md`, ..., `impl-output-r10.md`, `impl-output-r11.md`
- Verify `impl-output-r2.md` sorts before `impl-output-r10.md`
- Test mixed retry-feedback and stage-output files maintain correct relative ordering
- Verify `parseTrailingNum` handles both `-r<N>.md` and `-<N>.md` patterns

### Success Criteria

At any retry count (including 10+), the impl agent receives feedback files in chronological order.

---

## Fix 3: Universal Secrets/PII Preamble in Agent Prompts

### Audit Reference

- **Audit §6.6** — "No secrets/PII guardrails in agent prompts"
- **Severity:** P1 — agents could inadvertently include API keys, tokens, or PII in outputs

### Current Behavior

No agent prompt contains a universal prohibition against including secrets or PII in outputs. The `review.md` prompt checks for hardcoded credentials as a review criterion, and `recovery.md` has privacy rules about PII. But agents with write access (`impl`, `quick-execute`, `pr`) have no explicit guardrails.

### Required Changes

**Module: `agents/*.md` (all 12 prompt files)**

1. Add a universal preamble section to every agent prompt. Place it at the top, before role-specific instructions:

   ```markdown
   ## Safety Rules
   
   - NEVER include API keys, tokens, passwords, connection strings, or secrets in any output, commit, PR body, Slack message, or artifact.
   - NEVER include personally identifiable information (PII) such as names, emails, phone numbers, or addresses unless the task explicitly requires it.
   - If you encounter secrets or PII in the codebase, do not copy them into your output. Reference them by variable name or config key instead.
   ```

2. For agents with write access (`impl`, `quick-execute`, `pr`), add an additional line:
   ```markdown
   - Before committing or writing files, verify no secrets or PII are included in the output.
   ```

**Module: `agents/agent-template.md`**

3. Add the safety preamble to the agent template so new agents inherit it automatically.

### Testing Requirements

- Verify all 12 agent prompt files contain the safety preamble after the fix
- Verify `agent-template.md` includes the preamble

### Success Criteria

Every agent prompt in `agents/` contains the secrets/PII safety rules. No agent can claim it wasn't instructed to avoid secrets.

---

## Fix 4: Complete `PipelineStage` Type Union

### Audit Reference

- **Audit §9.1** — "`PipelineStage` union type is incomplete"
- **Severity:** P1 (upgraded from P2) — type unsafety allows invalid stage names to pass silently

### Current Behavior

**File:** `src/core/types.ts`, lines 3-6

```typescript
export type PipelineStage =
  | "questions" | "research" | "design" | "structure" | "plan"
  | "impl" | "review" | "validate" | "pr"
  | "quick" | "quick-triage" | "quick-execute" | "slack-io";
```

Missing: `"recovery"` — which is defined in `DEFAULT_STAGE_TOOLS`, `STAGE_CONTEXT_RULES`, `STAGE_ARTIFACT_RULES`, `maxTurns`, `timeoutsMinutes`, and `models` in `defaults.ts`.

### Required Changes

**Module: `src/core/types.ts`**

1. Add `"recovery"` to the `PipelineStage` union type.

2. Add a compile-time exhaustiveness check: create a const assertion that maps `PipelineStage` to `DEFAULT_STAGE_TOOLS` keys, so any future stage added to defaults but not to the type causes a build error.

### Testing Requirements

- Verify `npm run build` succeeds with the updated type
- Verify that removing a stage from the union causes a compile error (manual check)

### Success Criteria

`PipelineStage` is the single source of truth for valid stage names. Adding a stage to `defaults.ts` without updating `types.ts` produces a compile-time error.

---

## Fix 5: `config set` Zod Validation

### Audit Reference

- **Audit §5.4** — "`config set` bypasses Zod validation"
- **Severity:** P2 (upgraded to Phase 2) — users can corrupt config that crashes `shkmn start`

### Current Behavior

**File:** `src/commands/config.ts`, lines 16-41

`setConfigValue` directly mutates the JSON object and writes it back without schema validation. Users can set invalid types, unknown keys, or structurally broken values that pass `set` but crash `start`.

### Required Changes

**Module: `src/commands/config.ts`**

1. After mutating the config object and before writing to disk, validate the full config through the Zod schema:
   ```typescript
   import { configSchema } from "../config/schema.js";
   // ... after mutation ...
   const result = configSchema.safeParse(raw);
   if (!result.success) {
     throw new Error(`Invalid config value: ${result.error.issues.map(i => i.message).join(", ")}`);
   }
   ```

2. The original JSON file must NOT be overwritten if validation fails. The mutation happens on an in-memory copy; only write on successful validation.

### Testing Requirements

- Test that `config set agents.retryCount "not-a-number"` fails with a validation error
- Test that `config set agents.retryCount 2` succeeds
- Test that the original config file is unchanged after a failed `set`
- Test that setting a valid nested path works end-to-end

### Success Criteria

`shkmn config set` rejects any value that would produce an invalid config. The config file on disk is always valid according to the Zod schema.

---

## Fix 6: CI/CD Pipeline

### Audit Reference

- **Audit §11.3** — "No CI/CD pipeline"
- **Severity:** P1 — no automated quality gates before merge

### Current State

No `.github/workflows/` directory exists. Tests run only locally via `npm test`. ESLint is configured (`eslint.config.js`) but not enforced in CI.

### Required Changes

**Module: `.github/workflows/ci.yml`**

1. Create a GitHub Actions workflow triggered on `push` and `pull_request` to `master`:

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

2. The workflow must:
   - Test on Node.js 20 and 22 (current LTS and latest)
   - Cache npm dependencies for speed
   - Run build, lint, test, and audit as separate steps (so failures are easy to diagnose)
   - Fail on moderate+ vulnerabilities in `npm audit`

### Testing Requirements

- Push the workflow to a branch and verify it runs on GitHub Actions
- Verify the workflow fails when a test fails (break a test intentionally)
- Verify the workflow fails when lint has errors

### Success Criteria

Every PR to `master` must pass build, lint, test, and audit before merge. Branch protection can then be configured to require the CI check.

---

## Verification Plan

After implementing all 6 fixes:

1. `npm run build` — compiles without errors (type union fix validated)
2. `npm test` — all existing + new tests pass
3. `npm run lint` — no errors (ESLint catches inconsistencies)
4. Manual review: all 12 agent prompts contain the safety preamble
5. CI workflow runs successfully on the PR branch
