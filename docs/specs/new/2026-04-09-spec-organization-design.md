# Spec Organization: Lifecycle Folder Structure

**Date:** 2026-04-09
**Scope:** Reorganize all specs, plans, and validation docs from flat `docs/superpowers/` into lifecycle-tracked folders under `docs/specs/`, `docs/plans/`, and `docs/validation/`.
**Approach:** Folder-based state — files physically move between `new/`, `pending/`, `done/` as work progresses.

---

## 1. Problem

All 19 specs, 16 plans, and 1 validation log live in flat directories under `docs/superpowers/`. There is no way to tell from the filesystem which specs have been implemented, which are in progress, and which haven't been started. As the spec count grows, this makes it hard to answer "what work is remaining?"

---

## 2. Design

### 2.1 Directory Structure

```
docs/
├── specs/
│   ├── new/          # Spec written, implementation not started
│   ├── pending/      # Implementation in progress or partially done
│   └── done/         # Fully implemented and verified
├── plans/
│   ├── new/          # Plan written, execution not started
│   ├── pending/      # Execution in progress
│   └── done/         # Fully executed
├── validation/
│   ├── new/          # Validation defined, not yet run
│   ├── pending/      # Validation in progress
│   └── done/         # Validation complete
└── superpowers/
    └── specs/
        └── 2026-04-04-shaktimaanai-system-design.md  # Master architecture doc (stays here)
```

The master system design document (`2026-04-04-shaktimaanai-system-design.md`) stays in `docs/superpowers/specs/` — it is a living architecture reference, not a feature spec with a lifecycle.

### 2.2 Lifecycle Rules

A file's location is the single source of truth for its status:

| Location | Meaning |
|----------|---------|
| `new/` | Document written and reviewed, but no implementation work has started |
| `pending/` | Implementation is in progress or partially complete |
| `done/` | Fully implemented, all tests pass, merged to master |

**Movement rules:**
- Specs move `new/` → `pending/` when implementation begins (first commit on a feature branch)
- Specs move `pending/` → `done/` when implementation is complete and merged
- Plans follow the same lifecycle independently — a plan can be `done/` (fully executed) while its spec is still `pending/` (if the spec covers more than the plan addressed)
- Validation docs move `pending/` → `done/` when the validation run is complete and results are recorded

### 2.3 Naming Convention

Filenames remain unchanged — date-prefixed as they are today:
```
YYYY-MM-DD-<topic>-design.md    (specs)
YYYY-MM-DD-<topic>.md           (plans)
YYYY-MM-DD-<topic>-log.md       (validation)
```

---

## 3. Initial File Placement

### 3.1 Specs

**`docs/specs/done/`** (14 files):

| File | Evidence |
|------|----------|
| `2026-04-04-spec2b-alignment-agents-design.md` | PR #7 merged; all alignment agent prompts exist |
| `2026-04-04-spec2c-execution-agents-design.md` | All execution agents implemented; worktree, retry logic complete |
| `2026-04-04-spec2d-agent-prompt-simplification-design.md` | Frontmatter stripped; buildSystemPrompt() in agent-runner.ts |
| `2026-04-05-spec3-input-surfaces-design.md` | PR #3 merged; all CLI commands and Slack surface implemented |
| `2026-04-05-spec4-e2e-validation-design.md` | E2E validation exercise complete; validation log exists |
| `2026-04-06-spec3a-slack-io-agent-design.md` | PR #8 merged; slack-io.md and slack-queue.ts complete |
| `2026-04-06-spec5a-pipeline-review-loop-optimization-design.md` | PR #7 merged; retry.ts with sub-classification |
| `2026-04-06-spec5b-token-budget-awareness-design.md` | budget-schema.ts, budget.ts fully implemented |
| `2026-04-07-astra-quick-triage-execute-design.md` | quick-triage.md, quick-execute.md, astra-triage.ts complete |
| `2026-04-07-slack-outbound-prefix-design.md` | outboundPrefix in config and slack-queue.ts |
| `2026-04-08-code-review-findings-fix-design.md` | PR #15 merged; all 25 findings addressed |
| `2026-04-08-enriched-slack-notifications-design.md` | NotifyEvent enrichment in types.ts and slack-notifier.ts |
| `2026-04-08-spec6a-pipeline-safety-observability-design.md` | PR #16 merged; budget-reset, verdict parsing |
| `2026-04-08-spec6b-cleanup-hygiene-design.md` | PR #16 merged; stale PID, worktree cleanup |

**`docs/specs/pending/`** (3 files):

| File | Reason |
|------|--------|
| `2026-04-08-smart-task-slug-design.md` | Partially implemented — taskTitle in AstraTriageResult exists but full slug pipeline not verified |
| `2026-04-08-token-optimization-design.md` | Partially implemented — SDK isolation done but some optimization items may remain |
| `2026-04-08-pipeline-diagnostics-skill-design.md` | Implemented as a Claude Code skill, not as pipeline code — needs verification of scope |

**`docs/specs/new/`** (4 files):

| File | Reason |
|------|--------|
| `2026-04-09-audit-phase1-critical-fixes-design.md` | Just written, no implementation started |
| `2026-04-09-audit-phase2-high-severity-fixes-design.md` | Just written, no implementation started |
| `2026-04-09-audit-phase3-medium-severity-fixes-design.md` | Just written, no implementation started |
| `2026-04-09-audit-phase4-polish-design.md` | Just written, no implementation started |

### 3.2 Plans

**`docs/plans/done/`** (16 files):

All existing plan files. Each corresponds to a spec that has been implemented:

- `2026-04-04-spec1-core-foundation-cli.md`
- `2026-04-04-spec2a-pipeline-infrastructure.md`
- `2026-04-04-spec2b-alignment-agents.md`
- `2026-04-04-spec2c-execution-agents.md`
- `2026-04-04-spec2d-agent-prompt-simplification.md`
- `2026-04-05-spec3-input-surfaces.md`
- `2026-04-05-spec3-review-fixes.md`
- `2026-04-05-spec4-e2e-validation.md`
- `2026-04-06-spec3a-slack-io-agent.md`
- `2026-04-06-spec5a-pipeline-review-loop-optimization.md`
- `2026-04-07-astra-quick-triage-execute.md`
- `2026-04-07-slack-outbound-prefix.md`
- `2026-04-08-code-review-findings-fix.md`
- `2026-04-08-pipeline-diagnostics-skill.md`
- `2026-04-08-token-optimization.md`
- `2026-04-09-recovery-agent.md`

**`docs/plans/new/`** and **`docs/plans/pending/`**: Empty initially. Plans for the 4 audit specs will land here when written.

### 3.3 Validation

**`docs/validation/done/`** (1 file):
- `2026-04-05-e2e-validation-log.md`

**`docs/validation/new/`** and **`docs/validation/pending/`**: Empty initially.

---

## 4. Migration Steps

1. Create the new directory structure (`docs/specs/{new,pending,done}`, `docs/plans/{new,pending,done}`, `docs/validation/{new,pending,done}`)
2. Move each spec from `docs/superpowers/specs/` to the appropriate subfolder under `docs/specs/`
3. Move each plan from `docs/superpowers/plans/` to `docs/plans/done/`
4. Move validation log from `docs/superpowers/validation/` to `docs/validation/done/`
5. Keep `docs/superpowers/specs/2026-04-04-shaktimaanai-system-design.md` in place
6. Remove empty `docs/superpowers/specs/`, `docs/superpowers/plans/`, `docs/superpowers/validation/` directories (git will clean up empty dirs)
7. Update any cross-references in docs that point to old paths (README.md, CLAUDE.md)
8. Use `git mv` for all moves to preserve history

---

## 5. Future Workflow

When creating new specs/plans:

1. Write the spec → save to `docs/specs/new/`
2. Write the plan → save to `docs/plans/new/`
3. Begin implementation → `git mv` spec and plan to `pending/`
4. Complete implementation → `git mv` spec and plan to `done/`

Quick status check at any time:
```bash
ls docs/specs/new/       # what hasn't been started
ls docs/specs/pending/   # what's in progress
ls docs/specs/done/      # what's complete
```
