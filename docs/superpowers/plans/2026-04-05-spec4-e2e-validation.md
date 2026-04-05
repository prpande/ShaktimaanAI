# Spec 4: End-to-End Pipeline Validation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is an **operational validation plan**, not a code implementation plan. Tasks are executed by running the pipeline and validating its output, with code fixes applied as issues are found.

**Goal:** Prove the ShaktimaanAI pipeline works end-to-end by running two real tasks through it — one clean, one under chaos conditions — then present results for the user's go/no-go decision on Spec 4 (Dashboard).

**Architecture:** Phase 1 (clean baseline with `shkmn stats`) validates every agent produces quality output. Phase 2 (chaos run with `shkmn doctor`) validates crash recovery. Phase 3 validates all CLI commands. Phase 4 produces a cost report and graduation gate assessment.

**Tech Stack:** ShaktimaanAI pipeline (`shkmn` CLI), Claude Agent SDK, git worktrees, Vitest

**Spec:** `docs/superpowers/specs/2026-04-05-spec4-e2e-validation-design.md`

---

## Prerequisites

Before starting, verify the environment is ready:

- [ ] **Step 1: Build the project**

Run: `cd C:/src/ShaktimaanAI && npm run build`
Expected: Clean build, no errors

- [ ] **Step 2: Run existing tests**

Run: `npm test`
Expected: All 34 test files pass, no regressions

- [ ] **Step 3: Verify auth tools**

Run: `gh auth status && az account show`
Expected: Both authenticated

- [ ] **Step 4: Initialize runtime if needed**

Run: `shkmn init` (if not already initialized)
Expected: Config file and runtime directories exist

- [ ] **Step 5: Verify runtime directories**

Run: `ls "$(node -e "const c=require('./dist/config/loader.js'); console.log(c.loadConfig().pipeline.runtimeDir)")"` 
Expected: All 13 stage directories (00-inbox through 12-hold) exist

- [ ] **Step 6: Ensure clean state**

Run: `shkmn status`
Expected: No active tasks. If any exist, cancel or complete them first.

- [ ] **Step 7: Create validation log file**

Create: `docs/superpowers/validation/2026-04-05-e2e-validation-log.md`

This file tracks every observation, issue, fix, and cost measurement throughout the validation. Format:

```markdown
# E2E Validation Log — 2026-04-05

## Phase 1: Clean Baseline (shkmn stats)

### Stage: questions
- **Start time:** 
- **End time:** 
- **Tokens (in/out):** 
- **Cost:** 
- **Artifact quality:** [PASS/FAIL — notes]
- **Issues found:** [P0/P1/P2/P3 — description]

(repeat per stage)

## Phase 2: Chaos Run (shkmn doctor)
(same structure + recovery notes per kill)

## Phase 3: CLI Validation
(checklist per command)

## Phase 4: Cost Report & Graduation
(tables and analysis)
```

---

## Task 1: Start the Pipeline Watcher

**Files:**
- Runtime: `{runtimeDir}/shkmn.pid`

- [ ] **Step 1: Start Heimdall in a background terminal**

Run: `shkmn start`
Expected: Watcher starts, prints "Heimdall watching {runtimeDir}/00-inbox/", PID file created.

Keep this process running in a separate terminal for the duration of Phase 1.

- [ ] **Step 2: Verify watcher is running**

Run: `shkmn status`
Expected: "No active tasks" (watcher is running but no tasks submitted yet)

---

## Task 2: Phase 1 — Submit Clean Baseline Task (shkmn stats)

**Files:**
- Created by pipeline: `{runtimeDir}/00-inbox/add-shkmn-stats-command.task`

- [ ] **Step 1: Submit the task**

Run:
```bash
shkmn task "Add a shkmn stats command that reads the daily interaction JSONL files from interactions/ and the per-task interactions.md files. It should display: per-stage average duration (wall-clock), per-stage average token usage (input + output), per-stage average cost in USD, total pipeline averages, and the most expensive stage. Output should be a formatted table to stdout. Add a --json flag for machine-readable output." --repo C:/src/ShaktimaanAI
```

Expected: Slug generated (e.g., `add-shkmn-stats-command`), task file written to inbox, watcher picks it up.

- [ ] **Step 2: Verify task was picked up**

Run: `shkmn status`
Expected: Shows the task as active with current stage `questions`

- [ ] **Step 3: Record submission in validation log**

Log: task slug, submission time, initial status

---

## Task 3: Phase 1 — Validate Questions Stage (Narada)

- [ ] **Step 1: Monitor the questions stage**

Run: `shkmn logs <slug> -f`
Expected: Stream shows Narada agent executing

- [ ] **Step 2: Wait for stage completion**

Run: `shkmn status` (poll until stage advances to `research`)

- [ ] **Step 3: Read the questions artifact**

Read: `{runtimeDir}/01-questions/done/<slug>/artifacts/questions-output.md`

Validate against rubric:
- [ ] Questions are specific to the `shkmn stats` task (not generic boilerplate)
- [ ] Questions reference actual codebase concepts (interaction JSONL format, existing log structure, Commander.js patterns)
- [ ] At least 5 targeted technical questions
- [ ] No hallucinated file paths or concepts

- [ ] **Step 4: Check stream log for cost data**

Read: `{runtimeDir}/01-questions/done/<slug>/artifacts/questions-output-stream.jsonl`
Extract: input tokens, output tokens, duration. Record in validation log.

- [ ] **Step 5: Triage any issues**

If FAIL on any rubric item:
- P0/P1: Diagnose root cause (agent prompt? context injection? config?). Fix the code/prompt. Run `shkmn restart-stage <slug>`. Re-validate.
- P2/P3: Log for later. Continue.

---

## Task 4: Phase 1 — Validate Research Stage (Chitragupta)

- [ ] **Step 1: Monitor research stage**

Run: `shkmn status` (verify stage is `research`)
Run: `shkmn logs <slug> -f`

- [ ] **Step 2: Wait for stage completion**

Poll `shkmn status` until stage advances to `design`

- [ ] **Step 3: Read the research artifact**

Read: `{runtimeDir}/02-research/done/<slug>/artifacts/research-output.md`

Validate against rubric:
- [ ] Research addresses the questions from Narada (without seeing the original task — "hidden task" design)
- [ ] Findings reference real files: `src/core/interactions.ts`, `src/core/stream-logger.ts`, log format in `{runtimeDir}/logs/`
- [ ] No hallucinated file paths or function names — cross-check every path mentioned against the actual repo
- [ ] Research is substantive, not surface-level paraphrasing of questions

- [ ] **Step 4: Record cost data from stream log**

- [ ] **Step 5: Triage any issues**

Same protocol as Task 3 Step 5.

---

## Task 5: Phase 1 — Validate Design Stage (Vishwakarma) + Review Gate

- [ ] **Step 1: Monitor design stage**

Run: `shkmn status` (verify stage is `design`)
Run: `shkmn logs <slug> -f`

- [ ] **Step 2: Wait for design completion and review gate hold**

The pipeline should pause after design (default `reviewAfter: "design"`).
Run: `shkmn status`
Expected: Task shows status `hold` in `12-hold/`

- [ ] **Step 3: Read the design artifact**

Read: `{runtimeDir}/12-hold/<slug>/artifacts/design-output.md`

Validate against rubric:
- [ ] Architecture is coherent with existing patterns (Commander.js command structure, Zod schemas, existing `src/commands/*.ts` pattern)
- [ ] Design doesn't reinvent things that already exist (e.g., uses existing `interactions.ts` reader, doesn't propose a new logging system)
- [ ] Proposes a sensible data model for stats aggregation
- [ ] Addresses the `--json` flag requirement

- [ ] **Step 4: Test CLI pause behavior**

Run: `shkmn status`
Expected: Task clearly shows as "held" at design review gate with duration

- [ ] **Step 5: Approve the review gate**

If design passes rubric:
Run: `shkmn approve <slug>`

If design needs improvement:
Run: `shkmn approve <slug> --feedback "Specific feedback about what to improve"`

Expected: Task resumes, moves to `structure` stage

- [ ] **Step 6: Verify resume**

Run: `shkmn status`
Expected: Task shows as active in `structure` stage

- [ ] **Step 7: Record cost data and log review gate behavior**

---

## Task 6: Phase 1 — Validate Structure Stage (Vastu)

- [ ] **Step 1: Monitor and wait for structure completion**

Run: `shkmn status` / `shkmn logs <slug> -f`

- [ ] **Step 2: Read the structure artifact**

Read: `{runtimeDir}/04-structure/done/<slug>/artifacts/structure-output.md`

Validate against rubric:
- [ ] Vertical slices are sensible decompositions of the design
- [ ] Each slice is independently implementable and testable
- [ ] Slices are ordered by dependency (e.g., data parsing before display formatting before --json flag)
- [ ] Slice count is reasonable (3-6 for this task size)

- [ ] **Step 3: Record cost data, triage issues**

---

## Task 7: Phase 1 — Validate Plan Stage (Chanakya)

- [ ] **Step 1: Monitor and wait for plan completion**

- [ ] **Step 2: Read the plan artifact**

Read: `{runtimeDir}/05-plan/done/<slug>/artifacts/plan-output.md`

Validate against rubric:
- [ ] Plan maps to the slices from structure
- [ ] Each step has clear inputs, outputs, and acceptance criteria
- [ ] TDD approach specified per slice (test first, then implement)
- [ ] File paths are accurate (e.g., `src/commands/stats.ts`, `tests/commands/stats.test.ts`)
- [ ] Plan references correct existing interfaces and patterns

- [ ] **Step 3: Record cost data, triage issues**

---

## Task 8: Phase 1 — Validate Impl Stage (Karigar — TDD Cycle)

- [ ] **Step 1: Monitor impl stage**

Run: `shkmn status` (verify stage is `impl`)
Run: `shkmn logs <slug> -f`

This stage will take longest. Monitor for:
- Git worktree creation at `{runtimeDir}/worktrees/<slug>`
- Branch `shkmn/<slug>` created

- [ ] **Step 2: Verify worktree was created**

Run: `git worktree list` (from the ShaktimaanAI repo root)
Expected: Entry for `{runtimeDir}/worktrees/<slug>` on branch `shkmn/<slug>`

- [ ] **Step 3: Wait for impl completion**

Poll `shkmn status` until stage advances to `validate`

- [ ] **Step 4: Validate TDD cycle from git history**

Run (from worktree):
```bash
cd "{runtimeDir}/worktrees/<slug>"
git log --oneline --all
```

Validate against rubric:
- [ ] **Red:** At least one commit with a failing test (commit message or diff shows test added before implementation)
- [ ] **Green:** Subsequent commit shows implementation making the test pass
- [ ] **Refactor:** Optional cleanup commits without breaking tests
- [ ] Cycle repeats per vertical slice (not all tests lumped together)

- [ ] **Step 5: Read the impl artifact**

Read: `{runtimeDir}/06-impl/done/<slug>/artifacts/impl-output.md`

Check that the agent reports TDD cycle completion per slice.

- [ ] **Step 6: Spot-check the actual code**

Read the new `src/commands/stats.ts` (or whatever path Karigar chose) in the worktree.
- [ ] Code follows existing command patterns (Commander.js action handler, config loading)
- [ ] Tests exist and are meaningful (not trivial assertions)
- [ ] No obvious bugs or missing imports

- [ ] **Step 7: Record cost data (this will likely be the most expensive stage)**

---

## Task 9: Phase 1 — Validate Validate Stage (Dharma)

- [ ] **Step 1: Monitor validate stage**

Run: `shkmn status` / `shkmn logs <slug> -f`

- [ ] **Step 2: Wait for validate completion**

- [ ] **Step 3: Read the validate artifact**

Read: `{runtimeDir}/07-validate/done/<slug>/artifacts/validate-output.md`

Validate against rubric:
- [ ] Dharma discovered the correct build command (`npm run build`)
- [ ] Dharma discovered the correct test command (`npm test` or `npx vitest run`)
- [ ] All tests pass, including the new ones from Karigar
- [ ] No regressions in existing 34 test files
- [ ] Verdict is "approve" (or "retry" with specific issues noted)

- [ ] **Step 4: If verdict is "retry"**

The pipeline should automatically loop back to impl (Karigar). Monitor the retry:
- Verify feedback artifact was written
- Verify Karigar receives the feedback
- Verify the fix addresses the issue
- Wait for validate to re-run
- Max 2 retries before failure

- [ ] **Step 5: Record cost data, including any retry overhead**

---

## Task 10: Phase 1 — Validate Review Stage (Drona) + Review Gate

- [ ] **Step 1: Monitor review stage**

Run: `shkmn status` / `shkmn logs <slug> -f`

- [ ] **Step 2: Wait for review completion and review gate hold**

Expected: Pipeline pauses after review (second review gate).
Run: `shkmn status`
Expected: Task in `12-hold/`

- [ ] **Step 3: Read the review artifact**

Read: `{runtimeDir}/12-hold/<slug>/artifacts/review-output.md`

Validate against rubric:
- [ ] Review identifies real issues (if any), not a rubber-stamp "looks good"
- [ ] If issues found, they are specific and actionable
- [ ] Review covers: code quality, test coverage, naming conventions, error handling

- [ ] **Step 4: Review the code myself**

Read the implementation in the worktree. Cross-check Drona's findings:
- [ ] Did Drona catch issues I can see?
- [ ] Did Drona flag false positives?
- [ ] Is the code actually mergeable quality?

- [ ] **Step 5: Approve or provide feedback**

If code is good:
Run: `shkmn approve <slug>`

If issues remain:
Run: `shkmn approve <slug> --feedback "Specific issues to fix"`
Then monitor the retry loop (Drona → Karigar → Dharma → Drona cycle)

- [ ] **Step 6: Record cost data and review gate behavior**

---

## Task 11: Phase 1 — Validate PR Stage (Garuda) + Completion

- [ ] **Step 1: Monitor PR stage**

Run: `shkmn status` / `shkmn logs <slug> -f`

- [ ] **Step 2: Wait for PR creation**

- [ ] **Step 3: Verify the PR**

Run: `gh pr list --head "shkmn/<slug>"`
Expected: PR exists

Run: `gh pr view <pr-number>`
Validate:
- [ ] PR title references the task
- [ ] PR description summarizes changes
- [ ] PR has no merge conflicts
- [ ] PR diff contains the expected files (command, tests, CLI registration)

- [ ] **Step 4: Verify task completion**

Run: `shkmn status`
Expected: Task no longer active

Run: `shkmn history`
Expected: Task shows as completed with duration

Check: `{runtimeDir}/10-complete/<slug>/` exists with all artifacts

- [ ] **Step 5: Record final cost data for Phase 1**

- [ ] **Step 6: Compile Phase 1 cost table in validation log**

Aggregate all stage cost data into the per-phase cost table:
```
| Stage     | Tokens (in) | Tokens (out) | Duration | Cost  | Retries |
|-----------|-------------|--------------|----------|-------|---------|
| questions | —           | —            | —        | —     | —       |
| ...       |             |              |          |       |         |
| TOTAL     | —           | —            | —        | —     | —       |
```

---

## Task 12: Phase 1 — Test CLI Commands During Clean Run

These tests are interspersed throughout Phase 1 at natural points. Record results here.

- [ ] **Step 1: Test `shkmn status` (at every stage transition)**

Already tested throughout Tasks 3-11. Record: did it show correct slug, stage, duration, and arrow notation at every check?

- [ ] **Step 2: Test `shkmn logs` (during at least 3 agent runs)**

Already tested throughout. Record: did `-f` (follow) mode stream real-time output?

- [ ] **Step 3: Test `shkmn pause` (during structure stage — Task 6)**

Run during Task 6 Step 1, before structure completes:
Run: `shkmn pause <slug>`
Expected: Pipeline halts, `shkmn status` shows "held/paused"
Verify: task stays in current stage directory

- [ ] **Step 4: Test `shkmn resume` (after pause)**

Run: `shkmn resume <slug>`
Expected: Pipeline continues from paused stage
Verify: `shkmn status` shows active in structure stage again

- [ ] **Step 5: Test `shkmn approve` (at review gates)**

Already tested in Tasks 5 and 10. Record: did feedback get passed through?

- [ ] **Step 6: Test `shkmn history` (after Phase 1 completion)**

Run: `shkmn history`
Expected: Shows completed `add-shkmn-stats-command` with correct duration and stage count

- [ ] **Step 7: Record CLI validation results in log**

---

## Task 13: Fix P2 Issues Between Phases

- [ ] **Step 1: Review all P2/P3 issues from Phase 1**

Read the validation log. Collect all P2 items.

- [ ] **Step 2: Fix P2 items**

For each P2 issue:
1. Diagnose root cause
2. Apply fix (code or prompt edit)
3. Commit with message: `fix(validation): <description>`

- [ ] **Step 3: Rebuild**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 4: Run tests to verify fixes don't break anything**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Restart the watcher with the improved pipeline**

Kill the existing `shkmn start` process, then restart:
Run: `shkmn start`

---

## Task 14: Phase 2 — Submit Chaos Run Task (shkmn doctor)

- [ ] **Step 1: Submit the task**

Run:
```bash
shkmn task "Add a shkmn doctor command that performs system health checks: (1) verify gh CLI is authenticated, (2) verify az CLI is authenticated, (3) validate shkmn.config.json against the Zod schema, (4) check that all 13 runtime stage directories exist, (5) verify the .env file exists and contains required keys, (6) check that agent prompt files exist in agents/, (7) report results as a checklist with pass/fail per check and a summary line. Add a --fix flag that attempts to auto-repair missing directories and missing config defaults." --repo C:/src/ShaktimaanAI
```

Expected: Slug generated (e.g., `add-shkmn-doctor-command`), task picked up by watcher

- [ ] **Step 2: Verify task was picked up**

Run: `shkmn status`
Expected: Task active in `questions` stage

---

## Task 15: Phase 2 — Chaos Kill #1: During Questions (Narada Mid-Execution)

- [ ] **Step 1: Wait for questions stage to start**

Run: `shkmn status` — confirm stage is `questions`
Run: `shkmn logs <slug> -f` — confirm agent is actively executing

- [ ] **Step 2: Kill the pipeline process**

Kill the `shkmn start` process (Ctrl+C in the watcher terminal, or `kill $(cat {runtimeDir}/shkmn.pid)`)

- [ ] **Step 3: Wait 5 seconds**

Simulate real crash delay.

- [ ] **Step 4: Restart the pipeline**

Run: `shkmn start`
Expected: Recovery scanner runs, detects task in `01-questions/pending/<slug>/`

- [ ] **Step 5: Verify recovery**

Run: `shkmn status`
Expected: Task is active again in `questions` stage
Verify: no artifact corruption — read `run-state.json` from the task directory

- [ ] **Step 6: Let questions complete and validate output**

Same rubric as Task 3. Record any quality differences vs Phase 1.

- [ ] **Step 7: Log recovery result**

Record: recovery time, whether stage restarted or resumed, any token waste from the killed partial run.

---

## Task 16: Phase 2 — Chaos Kill #2: After Research, Before Design (Stage Transition)

- [ ] **Step 1: Wait for research to complete**

Poll `shkmn status` until research is done and task is about to enter design.

- [ ] **Step 2: Kill immediately at transition**

Kill the `shkmn start` process.

- [ ] **Step 3: Wait 5 seconds, restart**

Run: `shkmn start`

- [ ] **Step 4: Verify recovery**

Expected: Recovery detects task in `02-research/done/<slug>/` and advances to `03-design/pending/`
Run: `shkmn status` — should show `design` stage

- [ ] **Step 5: Verify research artifacts are intact**

Read: `{runtimeDir}/02-research/done/<slug>/artifacts/research-output.md`
Expected: Complete, uncorrupted output from research stage

- [ ] **Step 6: Log recovery result**

---

## Task 17: Phase 2 — Chaos Kill #3: During Design (Vishwakarma Mid-Execution)

- [ ] **Step 1: Wait for design stage to start, agent actively executing**

- [ ] **Step 2: Kill mid-execution**

- [ ] **Step 3: Wait 5 seconds, restart**

- [ ] **Step 4: Verify recovery**

Expected: Task found in `03-design/pending/<slug>/`, design stage restarts cleanly.
Check: no partial/corrupt `design-output.md` in artifacts (should either be absent or complete from a previous attempt)

- [ ] **Step 5: Let design complete, validate, approve review gate**

Same rubric as Task 5.

- [ ] **Step 6: Log recovery result**

---

## Task 18: Phase 2 — Let Structure and Plan Run Clean

- [ ] **Step 1: Let structure and plan stages complete without interruption**

These stages need to complete to provide good input for the impl kill test.
Validate both outputs against rubric (same as Tasks 6 and 7).

- [ ] **Step 2: Record cost data for structure and plan**

---

## Task 19: Phase 2 — Chaos Kill #4: After Plan, Before Impl (Stage Transition)

- [ ] **Step 1: Wait for plan to complete, task about to enter impl**

- [ ] **Step 2: Kill at transition**

- [ ] **Step 3: Wait 5 seconds, restart**

- [ ] **Step 4: Verify recovery**

Expected: Plan artifacts intact, task moves to `06-impl/pending/`
Verify: `run-state.json` shows plan in `completedStages[]`

- [ ] **Step 5: Log recovery result**

---

## Task 20: Phase 2 — Chaos Kill #5: During Impl (Karigar Mid-TDD — MOST CRITICAL)

- [ ] **Step 1: Wait for impl stage to start, Karigar actively coding**

Run: `shkmn logs <slug> -f` — wait until you see TDD cycle activity (test creation, file writes)

- [ ] **Step 2: Kill mid-TDD cycle**

Kill while Karigar is between red and green phases if possible (or mid-slice).

- [ ] **Step 3: Wait 5 seconds, restart**

- [ ] **Step 4: Verify worktree survived**

Run: `git worktree list`
Expected: Worktree at `{runtimeDir}/worktrees/<slug>` still exists

Check worktree state:
```bash
cd "{runtimeDir}/worktrees/<slug>"
git status
git log --oneline -5
```
Expected: Files are in a consistent state (no partial writes that corrupt syntax)

- [ ] **Step 5: Verify recovery**

Expected: Task found in `06-impl/pending/<slug>/`, impl stage restarts.

Critical checks:
- [ ] Does Karigar resume TDD from the correct slice or restart all slices?
- [ ] Are previously committed tests still passing?
- [ ] Is the worktree branch intact with prior commits?

- [ ] **Step 6: Let impl complete, validate TDD cycle**

Same rubric as Task 8. Record whether recovery caused any quality degradation.

- [ ] **Step 7: Log recovery result with special detail**

This is the most important recovery test. Document thoroughly: worktree state, branch integrity, TDD cycle continuity, any wasted tokens.

---

## Task 21: Phase 2 — Chaos Kill #6: After Validate, Before Review (Stage Transition)

- [ ] **Step 1: Wait for validate to complete**

- [ ] **Step 2: Kill at transition**

- [ ] **Step 3: Wait 5 seconds, restart**

- [ ] **Step 4: Verify recovery**

Expected: Validate results preserved, task moves to `08-review/pending/`

- [ ] **Step 5: Verify validate artifacts are intact**

Read: validate output. Confirm test results are complete.

- [ ] **Step 6: Log recovery result**

---

## Task 22: Phase 2 — Validate Review + Chaos Kill #7: During PR (Garuda Mid-Execution)

- [ ] **Step 1: Let review complete, approve review gate**

Same rubric as Task 10. Approve when satisfied.

- [ ] **Step 2: Wait for PR stage to start, Garuda actively executing**

Run: `shkmn logs <slug> -f`

- [ ] **Step 3: Kill mid-PR creation**

- [ ] **Step 4: Wait 5 seconds, restart**

- [ ] **Step 5: Verify recovery**

Critical checks:
- [ ] No duplicate PRs created (check `gh pr list --head "shkmn/<slug>"`)
- [ ] No orphaned branches (check `git branch -a | grep shkmn/<slug>`)
- [ ] PR stage restarts cleanly

- [ ] **Step 6: Let PR complete, validate**

Same rubric as Task 11.

- [ ] **Step 7: Compile Phase 2 cost table**

Same format as Task 11 Step 6, plus recovery overhead column.

- [ ] **Step 8: Log all recovery results**

---

## Task 23: Phase 2 — Test Destructive CLI Commands (Throwaway Tasks)

- [ ] **Step 1: Submit throwaway task for cancel test**

Run:
```bash
shkmn task "Throwaway task for cancel testing — ignore this" --repo C:/src/ShaktimaanAI
```

Wait for it to reach questions stage.

- [ ] **Step 2: Test `shkmn cancel`**

Run: `shkmn cancel <throwaway-slug>`
Expected: Task moves to `11-failed/`, status shows "Cancelled by user"
Verify: worktree cleaned up (if one was created), no orphaned state

- [ ] **Step 3: Submit throwaway task for skip test**

Run:
```bash
shkmn task "Throwaway task for skip testing — ignore this" --repo C:/src/ShaktimaanAI
```

Wait for it to reach questions stage.

- [ ] **Step 4: Test `shkmn skip`**

Run: `shkmn skip <throwaway-slug>`
Expected: Task advances to research without questions output
Verify: pipeline handles missing questions artifact gracefully in research stage

- [ ] **Step 5: Cancel the skip test task**

Run: `shkmn cancel <throwaway-slug>`

- [ ] **Step 6: Test `shkmn modify-stages` on chaos run task (if still running)**

If the doctor task is between stages:
Run: `shkmn modify-stages <slug> --remove structure` (or similar non-critical stage modification)
Expected: Pipeline adjusts stage list, skips the removed stage

If not feasible on the live task, test on a throwaway.

- [ ] **Step 7: Test `shkmn restart-stage`**

This is tested naturally during fix-as-you-go (whenever we fix a P0/P1 issue and re-run a stage). Record all occurrences.

- [ ] **Step 8: Test `shkmn retry`**

If any stage produced subpar output during Phase 2:
Run: `shkmn retry <slug> --feedback "Specific feedback"`
Expected: Stage re-runs with feedback visible to the agent

- [ ] **Step 9: Record all CLI test results**

---

## Task 24: Phase 4 — Compile Validation Report

- [ ] **Step 1: Compile the clean vs chaos comparison table**

```markdown
| Metric              | Clean Run | Chaos Run | Delta   |
|---------------------|-----------|-----------|---------|
| Total cost          | $—        | $—        | —%      |
| Total duration      | —         | —         | —%      |
| Recovery overhead   | N/A       | $—        | —       |
| Wasted tokens       | 0         | —         | —       |
| Stages completed    | 9/9       | 9/9       | —       |
| Fix interventions   | —         | —         | —       |
| Agent retries       | —         | —         | —       |
```

- [ ] **Step 2: Compile per-stage cost breakdown (both phases)**

Side-by-side comparison table showing each stage's cost in clean vs chaos.

- [ ] **Step 3: Write optimization analysis**

Answer these questions with data:
- Which stages consume the most tokens relative to their output value?
- Are agent prompts pulling in too much context?
- Could any stage's prompt be trimmed without degrading quality?
- Is the "hidden task" design for Chitragupta causing token waste?
- Are review loop-backs cost-efficient?
- What is the recovery cost overhead per kill?

- [ ] **Step 4: Compile graduation gate checklist**

```markdown
| # | Criterion                | Result     | Notes |
|---|--------------------------|------------|-------|
| G1 | Full pipeline traversal | PASS/FAIL  | —     |
| G2 | Artifact quality        | PASS/FAIL  | —     |
| G3 | TDD integrity           | PASS/FAIL  | —     |
| G4 | Review gates functional  | PASS/FAIL  | —     |
| G5 | Recovery resilience     | PASS/FAIL  | —     |
| G6 | CLI operations          | PASS/FAIL  | —     |
| G7 | PRs mergeable           | PASS/FAIL  | —     |
| G8 | Cost reasonable (<$20)  | PASS/FAIL  | —     |
```

- [ ] **Step 5: Compile fix log**

List all P0/P1/P2/P3 issues found, what was fixed, and what remains.

- [ ] **Step 6: Write soft signals assessment**

- Chaos run cost overhead vs clean run: —% (target: <60%)
- P2 improvements logged: — (target: <3)
- Agent prompt rewrites: — (target: <2)
- Recovery overhead per kill: — (target: <2 min)

- [ ] **Step 7: Save the complete validation report**

Write to: `docs/superpowers/validation/2026-04-05-e2e-validation-report.md`
Commit: `docs(validation): add E2E pipeline validation report`

- [ ] **Step 8: Present results to user for go/no-go decision**

Present:
1. Graduation gate checklist (G1-G8)
2. Cost tables (per-stage, clean vs chaos)
3. Optimization recommendations
4. Fix log
5. Soft signals

Ask: "Based on these results, would you like to proceed with Spec 4 (Dashboard), or are there concerns to address first?"
