# Spec 4: End-to-End Pipeline Validation

**Date:** 2026-04-05
**Status:** Design approved
**Scope:** Validate the ShaktimaanAI pipeline against a real scenario, fix issues found, and establish a graduation gate for trusting the pipeline with production work (Spec 4 Dashboard).

---

## 1. Overview

Specs 1-3 built the pipeline engine, all 10 agents, CLI commands, and Slack surface. All are covered by unit/integration tests (34 files, 6,276 lines). What's missing is proof that the whole system works end-to-end with real tasks flowing through real agents.

This spec defines an E2E validation that:
- Feeds the pipeline real tasks targeting its own codebase (dogfooding)
- Validates every stage's output against explicit quality criteria
- Stress-tests crash recovery with a chaos protocol
- Exercises all CLI control commands against live runs
- Tracks cost and token usage per stage with optimization analysis
- Fixes any issues found during the run (not read-only observation)
- Establishes a graduation gate for Spec 4 (Dashboard) — with the user making the final go/no-go decision

---

## 2. Validation Structure

Four phases, run in order:

### Phase 1 — Clean Baseline Run (`shkmn stats` command)

Feed the pipeline a real task with no interruptions. Validate every stage's artifacts. Establish cost/duration baselines.

### Phase 2 — Chaos Run (`shkmn doctor` command)

Feed a second task with aggressive kill-and-recover cycles at every other stage transition. Validate recovery correctness and artifact integrity.

### Phase 3 — CLI & Control Operations Validation

Exercise all 11 CLI control commands against live runs during Phases 1 and 2, plus throwaway sub-runs for destructive commands.

### Phase 4 — Validation Report & Graduation Gate

Compare clean vs chaos results. Produce cost analysis with optimization recommendations. Present all results to the user for a go/no-go decision on Spec 4.

---

## 3. Task Definitions

### Task 1: `shkmn stats` (Clean Baseline)

> Add a `shkmn stats` command that reads the daily interaction JSONL files from `interactions/` and the per-task `interactions.md` files. It should display: per-stage average duration (wall-clock), per-stage average token usage (input + output), per-stage average cost in USD, total pipeline averages, and the most expensive stage. Output should be a formatted table to stdout. Add a `--json` flag for machine-readable output.

### Task 2: `shkmn doctor` (Chaos Run)

> Add a `shkmn doctor` command that performs system health checks: (1) verify `gh` CLI is authenticated, (2) verify `az` CLI is authenticated, (3) validate `shkmn.config.json` against the Zod schema, (4) check that all 13 runtime stage directories exist, (5) verify the `.env` file exists and contains required keys, (6) check that agent prompt files exist in `agents/`, (7) report results as a checklist with pass/fail per check and a summary line. Add a `--fix` flag that attempts to auto-repair missing directories and missing config defaults.

Both tasks are scoped to exercise all pipeline stages meaningfully — they need real design decisions, have testable outputs, and exercise the full TDD cycle.

---

## 4. Stage-by-Stage Validation Criteria

### 00-inbox to 01-questions (Narada)
- Task file parsed correctly, slug generated
- Questions are specific to the task, not generic boilerplate
- Questions reference actual codebase concepts (e.g., existing interaction log format, config schema)
- At least 5 targeted technical questions

### 02-research (Chitragupta)
- Research addresses the questions generated (without having seen the original task — "hidden task" design)
- Findings reference real files and code patterns in the repo
- No hallucinated file paths or function names

### 03-design (Vishwakarma)
- Architectural decisions are coherent with existing patterns (Commander.js commands, Zod schemas, etc.)
- Design doesn't reinvent things that already exist in the codebase
- Review gate triggers here — reviewer examines the design, provides feedback or approves

### 04-structure (Vastu)
- Vertical slices are sensible decompositions of the design
- Each slice is independently implementable and testable
- Slices are ordered by dependency

### 05-plan (Chanakya)
- Plan maps to the slices from structure
- Each step has clear inputs, outputs, and acceptance criteria
- TDD approach specified per slice

### 06-impl (Karigar — TDD cycle)
- **Red:** Failing test written first, test actually fails
- **Green:** Minimal code to pass the test, test now passes
- **Refactor:** Code improved without breaking tests
- Cycle repeats per vertical slice
- Git worktree used for isolation

### 07-validate (Dharma)
- Discovers and runs the correct build/test commands (`npm run build`, `npm test`)
- All tests pass, including the new ones
- No regressions in existing tests

### 08-review (Drona)
- Review identifies real issues (if any), not rubber-stamp approvals
- If issues found, loops back to Karigar — loop-back actually works
- Review gate triggers here — reviewer examines Drona's findings and the code

### 09-pr (Garuda)
- Branch pushed, PR created via `gh`
- PR description references the task and summarizes changes
- PR is actually mergeable (no conflicts, CI would pass)

### 10-complete
- Task lands here, status reflects completion
- Interaction logs captured for all stages
- Duration and cost recorded

---

## 5. Fix-As-You-Go Protocol

The validation is not a read-only observation. When the pipeline deviates from spec, we diagnose, fix, and re-run the affected stage before continuing.

### Triage Categories

**P0 — Blocker (fix immediately, re-run stage):**
- Pipeline crashes or hangs
- Agent produces empty or nonsensical output
- Stage transition fails (task stuck, not moved)
- Recovery doesn't pick up after kill
- TDD cycle broken (test not written first, or passing test written as "red")
- Review gate doesn't pause when expected

**P1 — Degraded (fix immediately, re-run stage if output was affected):**
- Agent output is generic/boilerplate instead of task-specific
- Agent hallucinates file paths or function names
- Design contradicts existing codebase patterns
- Worktree not created/cleaned properly
- Interaction logs missing or incomplete

**P2 — Improvement (log, fix between Phase 1 and Phase 2):**
- Agent prompt could be sharper (produces correct but verbose/unfocused output)
- Token usage unnecessarily high for a stage
- CLI output formatting issues
- Minor gaps in interaction logging

**P3 — Observation (log for future):**
- Ideas for better agent prompts
- Architectural improvements that aren't bugs
- Nice-to-haves spotted during the run

### Fix Workflow

1. Document the issue: what stage, what happened, what was expected
2. Diagnose: is it a code bug, prompt issue, config problem, or design gap?
3. Fix: patch the code or prompt directly
4. Re-run: restart the affected stage with `shkmn restart-stage` and validate the fix
5. Continue the pipeline

**Between Phase 1 and Phase 2:** Address all accumulated P2 items, so the chaos run tests an improved pipeline.

**All fixes are committed as they happen** with clear commit messages referencing the validation (e.g., `fix(validation): sharpen Narada prompt to avoid generic questions`).

---

## 6. Chaos Protocol

### Kill Schedule for Phase 2

| Kill # | When | Type | What We Verify |
|--------|------|------|----------------|
| 1 | During stage 01-questions (Narada mid-execution) | Kill during active agent | Recovery resumes the agent run, or restarts the stage cleanly |
| 2 | After stage 02-research completes, before 03-design starts | Kill at stage transition | Recovery detects completed research, moves to design |
| 3 | During stage 03-design (Vishwakarma mid-execution) | Kill during active agent | Partial artifacts handled — no corruption, clean restart |
| 4 | After stage 05-plan completes, before 06-impl starts | Kill at stage transition | Recovery picks up at impl with plan artifacts intact |
| 5 | During stage 06-impl (Karigar mid-TDD cycle) | Kill during TDD red-green | Most critical — worktree state preserved, partial impl handled correctly |
| 6 | After stage 07-validate, before 08-review | Kill at stage transition | Test results preserved, review stage gets correct input |
| 7 | During stage 09-pr (Garuda mid-execution) | Kill during PR creation | No duplicate PRs, no orphaned branches, clean retry |

### Kill Method

`Ctrl+C` / process kill of the `shkmn start` watcher process.

### After Each Kill

1. Wait 5 seconds (simulate real crash, not instant restart)
2. Run `shkmn start` to restart the watcher
3. Verify recovery scanner detects the task and its current stage
4. Verify the pipeline resumes from the correct point (not from scratch)
5. Validate that any artifacts from before the kill are intact
6. Let the stage complete, validate its output against the same rubric as Phase 1

### Special Attention: Kill #5 (Mid-Impl)

- Does the git worktree survive the kill?
- Are partially written files left in a consistent state?
- Does Karigar resume the TDD cycle from the correct slice, or restart the whole impl?
- Are previously passing tests still passing after recovery?

---

## 7. CLI & Control Operations Validation

### Tested During Phase 1 (Clean Run)

| Command | When to Test | What We Verify |
|---------|-------------|----------------|
| `shkmn status` | At every stage transition | Shows correct task slug, current stage, duration, arrow notation matching spec |
| `shkmn logs` | During at least 3 active agent runs | Streams real-time agent output, `--follow` mode works |
| `shkmn pause` | During stage 04-structure | Pipeline halts, task stays in current stage |
| `shkmn resume` | After pause test | Pipeline continues from paused stage, no artifact loss |
| `shkmn approve` | At every review gate (design, review) | Resumes from hold, feedback passed to next stage |
| `shkmn retry` | If any stage produces subpar output | Re-runs with feedback string, agent sees the feedback |

### Tested During Phase 2 or Via Throwaway Sub-Run

| Command | How to Test | What We Verify |
|---------|------------|----------------|
| `shkmn skip` | Start a throwaway task, skip one stage | Next stage starts without previous stage's artifacts, pipeline handles gracefully |
| `shkmn cancel` | Start a throwaway task, cancel mid-run | Task moves to failed/cancelled state, worktree cleaned up, no orphaned state |
| `shkmn modify-stages` | During chaos run, remove a non-critical stage | Pipeline adjusts its stage list mid-run, skips removed stage |
| `shkmn restart-stage` | After any fix-as-you-go repair | Current stage re-runs cleanly with same inputs |
| `shkmn history` | After Phase 1 completes | Shows completed task with correct slug, duration, stage count |

Destructive commands (`cancel`, `skip`) are tested on throwaway tasks to protect the main validation runs.

---

## 8. Cost Tracking & Optimization Analysis

### Metrics Per Stage

- **Input tokens** — prompt size sent to Claude
- **Output tokens** — response generated
- **Wall-clock duration** — start to completion (seconds)
- **USD cost** — calculated from token counts at current API pricing
- **Agent retries** — how many times the agent was re-invoked (loop-backs, recovery restarts)

### Data Sources

- Per-task `interactions.md` files (already written by the pipeline)
- Daily JSONL logs in `interactions/`
- Stream logger JSONL files (raw Agent SDK messages with token metadata)

### Output: Per-Phase Cost Table

```
| Stage       | Tokens (in) | Tokens (out) | Duration | Cost    | Retries |
|-------------|-------------|--------------|----------|---------|---------|
| questions   | —           | —            | —        | —       | —       |
| research    | —           | —            | —        | —       | —       |
| design      | —           | —            | —        | —       | —       |
| structure   | —           | —            | —        | —       | —       |
| plan        | —           | —            | —        | —       | —       |
| impl        | —           | —            | —        | —       | —       |
| validate    | —           | —            | —        | —       | —       |
| review      | —           | —            | —        | —       | —       |
| pr          | —           | —            | —        | —       | —       |
| TOTAL       | —           | —            | —        | —       | —       |
```

### Output: Clean vs Chaos Comparison

```
| Metric              | Clean Run | Chaos Run | Delta   |
|---------------------|-----------|-----------|---------|
| Total cost          | —         | —         | —       |
| Total duration      | —         | —         | —       |
| Recovery overhead   | N/A       | —         | —       |
| Wasted tokens       | 0         | —         | —       |
```

### Optimization Analysis Questions

- Which stages consume the most tokens relative to their output value?
- Are agent prompts pulling in too much context (large system prompts)?
- Could any stage's prompt be trimmed without degrading output quality?
- Is the "hidden task" design for Chitragupta (research) causing token waste by making it re-derive what it could have been told?
- Are review loop-backs (Drona to Karigar) cost-efficient or would sharper impl prompts be cheaper?
- Recovery cost overhead — is it acceptable or does it indicate redundant re-work?

---

## 9. Graduation Gate

### Review Checklist

After both phases complete, the following checklist is presented to the user:

| # | Criterion | Pass Condition |
|---|-----------|----------------|
| G1 | Full pipeline traversal | Both tasks completed inbox to PR with no manual stage skips |
| G2 | Artifact quality | Every stage's output passes its validation rubric (Section 4) — no stage required more than 2 fix-as-you-go interventions |
| G3 | TDD integrity | Karigar wrote failing tests before implementation in every slice, verified by git history in the worktree |
| G4 | Review gates functional | Pipeline paused at every configured review gate, resumed correctly on approve |
| G5 | Recovery resilience | All 7 chaos kills recovered correctly — correct stage, no artifact corruption, no duplicate work |
| G6 | CLI operations | All 11 control commands behaved as specified |
| G7 | PRs mergeable | Both PRs pass build, tests green, no conflicts, code is reviewable quality |
| G8 | Cost reasonable | Total cost for clean run is under $20 (if above, optimization must bring it under before graduation) |

### Soft Signals

- Chaos run cost overhead under 60% of clean run
- No more than 3 P2 improvements logged across both phases
- Agent prompts needed no more than 2 rewrites total
- Recovery adds no more than 2 minutes average overhead per kill

### Decision

The user reviews all results — cost report, artifact quality assessment, chaos recovery results, CLI validation, fix log, and optimization recommendations — and makes the final go/no-go decision on whether the pipeline is trusted for Spec 4 (Dashboard).

- If the user says proceed: move to Spec 4 Dashboard design and implementation
- If the user flags concerns: address them and re-run affected phases until satisfied

The checklist and soft signals serve as a structured guide for the user's review, not an automated pass/fail gate.

---

## 10. Operator Role

During the entire validation, Claude acts as the operator:
- **Triggers** both tasks via `shkmn task`
- **Monitors** every stage transition via `shkmn status` and `shkmn logs`
- **Reviews** all artifacts against the validation rubric (Section 4)
- **Approves** review gates after examining the output
- **Executes** the chaos protocol (kill, wait, restart)
- **Diagnoses and fixes** any issues found (Section 5)
- **Tests** all CLI commands (Section 7)
- **Produces** the cost report and optimization analysis (Section 8)
- **Presents** the graduation gate results to the user for final decision (Section 9)
