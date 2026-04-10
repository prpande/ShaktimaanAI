# Pipeline Validation Framework — Design Spec

**Date:** 2026-04-10
**Status:** Draft
**Scope:** An extensible, automated validation tool that exercises pipeline flows end-to-end, combining a deterministic CLI runner with an intelligent Claude skill wrapper. The AskUser flow (spec7) is the first scenario set.

---

## 1. Problem Statement

ShaktimaanAI's pipeline has grown in complexity — stage progression, hold/resume, retry loops, Slack IO, crash recovery, and now agent-user communication via AskUser. The existing validation approach (spec4) was a manual, fix-as-you-go process run once during development. There is no repeatable, automated way to verify that the full pipeline works correctly after changes.

The project needs a validation tool that can:
- Run scripted scenarios against the real pipeline infrastructure
- Operate at different fidelity levels (fast plumbing checks vs. full E2E with live agents)
- Work with or without a live Slack connection
- Produce structured reports for both humans and Claude to act on
- Scale to new scenario sets as the pipeline evolves

## 2. Design Principles

- **Additive only**: The validation tool observes and exercises the pipeline but never modifies its internals.
- **Mode matrix**: Four combinations of Slack (live/loopback) × agents (live/dry-run) test different layers independently.
- **Severity-tiered**: Results use P0-P3 triage. P0/P1 fail the run, P2/P3 are warnings.
- **Report only**: The tool diagnoses but does not fix. The user (or Claude) decides what to address.
- **Extensible**: Adding a new scenario set = adding a file + registering it.

## 3. Architecture: Runner + Skill Hybrid

The system has two layers:

**Layer 1 — `shkmn validate` (deterministic runner):**
Discovers scenario sets, manages mode configuration, executes scenarios through `setup()` → `execute()` → `verify()` → `teardown()` lifecycle hooks, collects results, and generates reports. This is the repeatable backbone that can run in CI or from the terminal.

**Layer 2 — `/validate-pipeline` skill (intelligent orchestrator):**
A Claude skill that wraps the CLI command and adds capabilities the runner can't provide: pre-flight environment checks, contextual reply generation in live mode, failure root-cause analysis, regression detection against prior runs, and severity re-assessment based on context.

## 4. Core Types

```typescript
interface Scenario {
  id: string;                          // e.g., "askuser.single-question"
  name: string;                        // Human-readable name
  description: string;
  severity: "P0" | "P1" | "P2" | "P3";  // If this fails, how bad is it
  supportedModes: {
    slack: ("live" | "loopback")[];
    agents: ("live" | "dry-run")[];
  };
  scriptedReply?: string;              // Used in dry-run/loopback mode
  setup: (ctx: ScenarioContext) => Promise<void>;
  execute: (ctx: ScenarioContext) => Promise<void>;
  verify: (ctx: ScenarioContext) => Promise<VerifyResult>;
  teardown?: (ctx: ScenarioContext) => Promise<void>;
}

interface ScenarioSet {
  id: string;                          // e.g., "askuser"
  name: string;
  description: string;
  scenarios: Scenario[];
}

interface VerifyResult {
  passed: boolean;
  severity: "P0" | "P1" | "P2" | "P3";
  message: string;
  details?: string;                    // Diagnostic context for Claude to analyze
}

interface ScenarioContext {
  runtimeDir: string;
  mode: { slack: "live" | "loopback"; agents: "live" | "dry-run" };
  taskSlug?: string;                   // Created during setup
  loopbackAdapter?: LoopbackAdapter;   // Injected when slack mode is loopback
  report: (finding: string) => void;   // Log intermediate findings
}
```

## 5. CLI Interface

```bash
shkmn validate                                    # All scenarios, dry-run + loopback (default)
shkmn validate --set askuser                      # Specific scenario set
shkmn validate --scenario askuser.single-question  # Single scenario
shkmn validate --agents live --slack loopback      # Live agents, loopback Slack
shkmn validate --agents live --slack live           # Full integration test
shkmn validate --json                              # JSON output for skill consumption
```

**Execution flow:**

1. Discover scenario sets from `src/validation/scenarios/`
2. Filter by `--set` / `--scenario` flags
3. Validate mode compatibility (skip scenarios that don't support selected mode)
4. Run each scenario: `setup()` → `execute()` → `verify()` → `teardown()`
5. Collect results, generate report
6. Exit code: 0 if no P0/P1 failures, 1 otherwise

## 6. Loopback Adapter

The loopback adapter intercepts Slack communication at the outbox/inbox file boundary, allowing scenarios to run without a live Slack connection.

```typescript
interface LoopbackAdapter {
  // Intercepts: watches slack-outbox.jsonl for new entries
  // instead of Narada sending them to Slack
  interceptOutbox(): void;

  // Returns captured outbox entries (questions, notifications)
  getCapturedMessages(): OutboxEntry[];

  // Waits for a specific type of outbox entry (e.g., agent_question)
  waitForMessage(filter: (entry: OutboxEntry) => boolean,
                 timeoutMs?: number): Promise<OutboxEntry>;

  // Injects a synthetic reply into slack-inbox.jsonl
  // as if a user had replied on Slack
  injectReply(reply: {
    text: string;
    thread_ts: string;       // Match to the question's message ts
    user?: string;           // Simulated user ID
  }): void;

  // Generates a fake message ts for thread tracking
  generateMessageTs(): string;

  // Cleanup: restore normal outbox/inbox behavior
  restore(): void;
}
```

**Integration points:**

- Hooks into the existing `slack-outbox.jsonl` / `slack-inbox.jsonl` file paths
- When `interceptOutbox()` is active, the watcher's Narada trigger is suppressed — outbox entries are captured instead of sent
- `injectReply()` writes to `slack-inbox.jsonl` in the same format the watcher expects, then triggers the watcher's normal poll/process cycle
- Thread timestamps are synthetic but consistent — `generateMessageTs()` produces deterministic ts values so thread matching works

**What it exercises:**

- Agent → outbox write path (real)
- Outbox entry format and content (verified)
- Watcher inbox processing (real)
- Astra triage with pending questions context (real in live agent mode, simulated in dry-run)
- Control file write → stage resume (real)

**What it skips:**

- Slack MCP tool calls
- Real Slack threading behavior
- Network failures

## 7. Mode Matrix

Four mode combinations, each validating a different layer:

| Mode | Slack | Agents | What it tests | Cost | Speed |
|------|-------|--------|---------------|------|-------|
| **Quick check** | loopback | dry-run | Pipeline plumbing: state transitions, directory moves, hold/resume, control files, checkpoint save/load | Free | ~seconds |
| **Orchestration** | loopback | live | Real agents with intercepted Slack: agent calls AskUser, checkpoint serialized, session resumed with injected reply | $$ | ~minutes |
| **Integration** | live | dry-run | Real Slack round-trips with simulated pipeline: message posting, thread matching, Astra routing, reply detection | Free | ~seconds (+ Slack latency) |
| **Full E2E** | live | live | Everything real: agents run, questions post to Slack, Claude generates replies, watcher routes, agents resume | $$$ | ~minutes |

**Defaults:**

- `shkmn validate` → quick check (free, fast, good for CI)
- `/validate-pipeline` skill → Claude chooses based on what it's validating, defaults to orchestration mode

**Scenario compatibility:** Each scenario declares which modes it supports via `supportedModes`. Some scenarios only make sense in certain modes — e.g., "Astra disambiguates between two pending questions" needs live agents to exercise Astra's triage logic, so it declares `agents: ["live"]`.

**Reply strategy by mode:**

- Dry-run + loopback: hardcoded `scriptedReply` from scenario definition
- Live agents + loopback: hardcoded replies injected via loopback adapter
- Live agents + live Slack: Claude (via the skill) reads the agent's question and generates a realistic reply
- Dry-run + live Slack: hardcoded replies posted to real Slack

## 8. AskUser Scenario Set

The first scenario set, validating the full AskUser flow from spec7.

| # | Scenario ID | Description | Severity | Modes |
|---|-------------|-------------|----------|-------|
| 1 | `askuser.single-question` | Agent calls AskUser → checkpoint saved → hold state set → question appears in outbox → reply injected → stage resumes → agent continues | P0 | all |
| 2 | `askuser.multi-question-batch` | Agent asks 3 numbered questions in one AskUser call → reply addresses all three → agent parses correctly | P1 | loopback+live agents |
| 3 | `askuser.multiple-askuser-calls` | Agent calls AskUser twice in one stage → first cycle completes → second cycle completes → askCount increments correctly | P1 | loopback+live agents |
| 4 | `askuser.checkpoint-persistence` | AskUser fires → checkpoint file written to `artifacts/{stage}-checkpoint.json` → file is valid JSON → contains sessionId, tool_use_id, cost, turns | P0 | all |
| 5 | `askuser.hold-state` | Task moves to `12-hold/` with `holdReason: "awaiting_user_response"` → RunState has `pendingQuestion` populated → `shkmn status` shows it | P0 | all |
| 6 | `askuser.resume-from-hold` | Task in hold → `.control` file with `operation: "resume_stage"` written → task moves back to `{stage}/pending/` → checkpoint consumed (deleted) | P0 | all |
| 7 | `askuser.astra-question-reply` | Reply in thread with pending question → Astra receives pending questions context → returns `question_reply` with correct slug | P1 | loopback+live agents |
| 8 | `askuser.astra-clarify-target` | Two tasks on hold → ambiguous reply → Astra returns `clarify_question_target` → disambiguation posted → follow-up correctly routed | P2 | loopback+live agents |
| 9 | `askuser.astra-clarify-task` | Ambiguous inbound message → Astra returns `clarify_task` → clarification posted → user clarifies → task created | P2 | loopback+live agents |
| 10 | `askuser.cli-answer` | Task on hold → `shkmn answer <slug> "reply"` → control file written → stage resumes | P0 | all |
| 11 | `askuser.foreground-interactive` | Foreground mode detected → question displayed in terminal → stdin reply → immediate resume, no hold state | P1 | dry-run only |
| 12 | `askuser.slack-thread-record` | Foreground Q&A → summary posted to outbox for Slack thread history | P2 | loopback |
| 13 | `askuser.stage-hints-propagation` | User reply includes extra guidance → agent writes `stage-hints-update.md` → pipeline merges into RunState.stageHints → downstream stage receives hints | P1 | loopback+live agents |
| 14 | `askuser.task-amendment` | User reply changes scope → agent writes `task-amendment.md` → subsequent stages see amended context | P1 | loopback+live agents |
| 15 | `askuser.disabled-stage` | Stage not in `enabledStages` → AskUser tool not registered → agent cannot call it | P0 | all |
| 16 | `askuser.crash-recovery` | Checkpoint on disk + task in hold → simulate restart → recovery detects held task → re-registers pending question | P0 | all |
| 17 | `askuser.race-slack-cli` | Reply arrives via both loopback and CLI → first one resumes → second is ignored | P2 | loopback |
| 18 | `askuser.message-format` | Question outbox entry contains correct branded format: prefix, agent name, stage, slug, question text, reply prompt | P1 | all |

## 9. The `/validate-pipeline` Skill

The Claude skill wraps `shkmn validate` and adds intelligence the CLI runner cannot provide.

**Invocation:**

```
/validate-pipeline                     # Default: orchestration mode, all sets
/validate-pipeline askuser             # Specific set
/validate-pipeline --full              # Full E2E (live agents + live Slack)
/validate-pipeline --quick             # Quick check (dry-run + loopback)
```

**What Claude does that the CLI doesn't:**

1. **Pre-flight check:** Before running, Claude reads the current pipeline state (`shkmn status`, `shkmn doctor`) to ensure the environment is healthy. Flags issues before wasting a validation run.

2. **Mode selection:** Based on the user's request and environment state, Claude picks the appropriate mode. If no Slack config exists, it auto-selects loopback. If the user says "full test," it runs live+live.

3. **Live reply generation:** In live agent mode, when an agent posts a question, Claude reads the question, understands the context, and generates a realistic user reply. This tests whether agents handle natural, non-scripted answers correctly.

4. **Result interpretation:** After `shkmn validate --json` returns, Claude analyzes the results:
   - P0/P1 failures: diagnoses root cause, identifies which source files are likely involved, suggests what to investigate
   - P2/P3 warnings: assesses whether any are actually more severe based on context
   - Patterns: identifies if multiple failures share a root cause

5. **Report enrichment:** Takes the raw validation report and adds:
   - Comparison to previous validation runs (if they exist in `docs/validation/done/`)
   - Regression detection — did something that passed before now fail?
   - Recommendations prioritized by impact

6. **Selective re-runs:** If a scenario fails, Claude can re-run just that scenario with `--scenario` to confirm the failure or check if it was transient.

**What Claude does NOT do:**

- Fix issues (report only, per requirements)
- Skip scenarios or lower severity
- Run validation without user initiation

## 10. Report Format

**File location:** `docs/validation/done/{timestamp}-validation-{set-or-all}.md`

**Structure:**

```markdown
# Pipeline Validation Report

**Date:** 2026-04-15T14:30:00Z
**Mode:** loopback + live agents
**Scenario Set:** askuser (18 scenarios)
**Duration:** 4m 32s
**Cost:** $2.14
**Result:** FAIL (1 P0, 0 P1, 2 P2, 0 P3)

## Summary

| Severity | Passed | Failed | Skipped |
|----------|--------|--------|---------|
| P0       | 5      | 1      | 0       |
| P1       | 6      | 0      | 1       |
| P2       | 3      | 2      | 0       |
| P3       | 0      | 0      | 0       |

## Failures

### [P0] askuser.checkpoint-persistence
**Status:** FAIL
**Message:** Checkpoint file missing sessionId field
**Details:** Checkpoint written to artifacts/design-checkpoint.json but
sdkSessionId was null. Agent runner may not be extracting session ID
from SDK messages.
**Likely source:** src/core/agent-runner.ts — checkpoint serialization

### [P2] askuser.race-slack-cli
**Status:** FAIL
**Message:** Both resume paths executed — task resumed twice
**Details:** Control file from CLI was processed after loopback reply
already triggered resume. Checkpoint deletion may have a race window.
**Likely source:** src/core/stage-runner.ts — resumeStage()

## Passed Scenarios

| # | Scenario | Severity | Duration |
|---|----------|----------|----------|
| 1 | askuser.single-question | P0 | 12.3s |
| 5 | askuser.hold-state | P0 | 0.4s |
| ... | ... | ... | ... |

## Skipped Scenarios

| # | Scenario | Reason |
|---|----------|--------|
| 11 | askuser.foreground-interactive | Not supported in loopback+live mode |

## Environment
- ShaktimaanAI version: 0.3.0
- Node: 20.11.0
- Config: ~/.shkmn/runtime/shkmn.config.json
- Runtime dir: ~/.shkmn/runtime/
```

**JSON output** (`--json`) returns the same data structured for the skill to consume:

```typescript
interface ValidationReport {
  timestamp: string;
  mode: { slack: string; agents: string };
  scenarioSet: string;
  duration: number;
  costUsd: number;
  passed: boolean;           // false if any P0/P1 failed
  summary: { severity: string; passed: number; failed: number; skipped: number }[];
  results: {
    id: string;
    name: string;
    severity: string;
    status: "passed" | "failed" | "skipped";
    message: string;
    details?: string;
    durationMs: number;
  }[];
}
```

## 11. Extensibility — Adding New Scenario Sets

Adding a new scenario set is a two-step process:

**Step 1:** Create a file in `src/validation/scenarios/`:

```typescript
// src/validation/scenarios/recovery.ts
import { ScenarioSet } from "../types.js";

export const recoveryScenarios: ScenarioSet = {
  id: "recovery",
  name: "Crash Recovery",
  description: "Validates pipeline recovery from crashes at various points",
  scenarios: [
    {
      id: "recovery.mid-stage-crash",
      name: "Recovery from mid-stage crash",
      severity: "P0",
      supportedModes: { slack: ["loopback"], agents: ["live", "dry-run"] },
      async setup(ctx) { /* create task, advance to target stage */ },
      async execute(ctx) { /* kill agent mid-run, trigger recovery scan */ },
      async verify(ctx) { /* check task resumed at correct stage */ },
      async teardown(ctx) { /* cleanup task directories */ },
    },
  ],
};
```

**Step 2:** Register in `src/validation/scenarios/index.ts`:

```typescript
export { askuserScenarios } from "./askuser.js";
export { recoveryScenarios } from "./recovery.js";
// New sets auto-discovered by the runner via this barrel export
```

**Planned future scenario sets** (not in scope, listed for context):

| Set ID | What it validates |
|--------|-------------------|
| `pipeline-basics` | Stage progression, artifact chaining, state transitions |
| `recovery` | Crash recovery at each stage, checkpoint integrity |
| `retry-loop` | Validate → impl → review retry cycle |
| `slack-io` | Narada outbox processing, thread mapping, approval detection |
| `astra-triage` | Quick triage routing, quick-execute, control commands |
| `concurrency` | Multiple tasks running simultaneously, registry limits |

## 12. Changes Summary

### New Files

| File | Purpose |
|------|---------|
| `src/validation/types.ts` | `Scenario`, `ScenarioSet`, `ScenarioContext`, `VerifyResult`, `ValidationReport` types |
| `src/validation/runner.ts` | `ValidationRunner` — discovers sets, manages modes, executes scenarios, collects results |
| `src/validation/loopback-adapter.ts` | `LoopbackAdapter` — intercepts outbox, injects inbox replies, manages synthetic thread timestamps |
| `src/validation/report.ts` | Report generation — markdown and JSON formatters |
| `src/validation/scenarios/index.ts` | Barrel export for scenario set discovery |
| `src/validation/scenarios/askuser.ts` | AskUser scenario set (18 scenarios) |
| `src/commands/validate.ts` | `shkmn validate` CLI command — flags, mode parsing, runner invocation |

### Modified Files

| File | Change |
|------|--------|
| `src/commands/index.ts` | Register `validate` command |
| `src/core/watcher.ts` | Add hook point for loopback adapter to suppress Narada trigger |

### Skill File

| File | Purpose |
|------|---------|
| `/validate-pipeline` skill | Claude skill wrapper — pre-flight, mode selection, live reply generation, result interpretation, report enrichment |

### Unchanged

- Pipeline core (`pipeline.ts`, `stage-runner.ts`, `agent-runner.ts`)
- Existing commands (`doctor`, `stats`, `status`)
- Agent prompts
- Slack IO / notification surfaces

The validation tool is purely additive — it observes and exercises the pipeline but does not modify its internals.
