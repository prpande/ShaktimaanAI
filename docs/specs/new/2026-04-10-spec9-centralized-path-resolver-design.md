# Spec 9 — Centralized Path Resolver

**Status:** New
**Date:** 2026-04-10
**Scope:** Refactor + bugfix — centralizes path construction (no new features) and corrects the `init` config write location (behavior fix for a broken flow)

## Problem

Directory paths are constructed ad-hoc across 26+ files using hardcoded string literals and `join()` calls. There is no single source of truth for where things live on disk. Two partial centralizations exist (`runtime/dirs.ts` for directory creation, `core/stage-map.ts` for stage mappings), but neither is used by consumers for path resolution.

This caused a concrete bug: `shkmn init` writes `shkmn.config.json` into the user-provided `runtimeDir`, but `resolveConfigPath()` has a home-directory fallback that expects `~/.shkmn/runtime/shkmn.config.json`. When a user initializes with `runtimeDir = ~/.shkmn`, `init` writes `~/.shkmn/shkmn.config.json` while later resolution via the home fallback looks under `~/.shkmn/runtime/shkmn.config.json` — two code paths, two conventions, no shared constant.

If any directory were renamed today, 4–15 scattered files would need manual updates.

## Goals

1. Every path in the system derives from a single `buildPaths(runtimeDir)` function
2. No module outside `src/config/paths.ts` calls `join()` with `runtimeDir` or hardcoded directory/file names
3. Agents receive fully resolved paths — they never construct root paths, only relative subdirectories within their provided working directory
4. The watcher and pipeline pass paths down; agents and commands consume them
5. Fix the `init` vs `resolve-path` config location mismatch

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Where paths live | `config.paths` on `ResolvedConfig` | `config` already flows through the entire codebase — no new plumbing needed |
| System paths | Pre-resolved strings | Static, computed once at config load, zero overhead |
| Task paths | `resolveTask(slug, stage, location)` factory function | Task paths depend on runtime arguments (slug, stage, pending/done) |
| TaskPaths mutability | Immutable per stage-run | After `moveTaskDir()`, caller gets a fresh `TaskPaths` via new `resolveTask()` call. Avoids stale references |
| Code style | Plain object + functions, no class | Matches existing functional codebase style |
| Stage directory lookup | `stages` dictionary keyed by stage name | Extensible — adding a stage means adding one entry to `STAGE_DIR_MAP`, which flows through automatically |

## `RuntimePaths` Shape

```typescript
interface RuntimePaths {
  // Root
  readonly runtimeDir: string;

  // Stage directories — keyed by stage name, values are absolute paths
  // e.g. stages.impl → "~/.shkmn/runtime/06-impl"
  readonly stages: Readonly<Record<PipelineStageName, string>>;

  // Terminal directories — not pipeline stages, different semantics
  readonly terminals: Readonly<{
    inbox:    string;   // "~/.shkmn/runtime/00-inbox"
    complete: string;   // "~/.shkmn/runtime/10-complete"
    failed:   string;   // "~/.shkmn/runtime/11-failed"
    hold:     string;   // "~/.shkmn/runtime/12-hold"
  }>;

  // Non-stage directories
  readonly logsDir:           string;
  readonly historyDir:        string;
  readonly dailyLogDir:       string;
  readonly monthlyReportsDir: string;
  readonly interactionsDir:   string;
  readonly diagnosticsDir:    string;
  readonly astraResponsesDir: string;
  readonly worktreesDir:      string;

  // System files
  readonly pidFile:          string;
  readonly worktreeManifest: string;
  readonly usageBudget:      string;
  readonly envFile:          string;
  readonly configFile:       string;

  // Slack files
  readonly slackOutbox:    string;
  readonly slackInbox:     string;
  readonly slackSent:      string;
  readonly slackThreads:   string;
  readonly slackCursor:    string;
  readonly slackProcessed: string;

  // Task path factory (retryNumber defaults to 0 — first attempt has no suffix)
  resolveTask(slug: string, stage: PipelineStageName, location: "pending" | "done", retryNumber?: number): TaskPaths;
  resolveTask(slug: string, terminal: "hold" | "complete" | "failed" | "inbox"): TaskPaths;
}
```

## `TaskPaths` Shape

```typescript
interface TaskPaths {
  readonly taskDir:      string;            // Full path to task root
  readonly artifactsDir: string;            // taskDir/artifacts
  readonly outputFile:   string | undefined; // taskDir/artifacts/{stage}-output.md or {stage}-output-r{N}.md for retries (undefined for terminal locations)
  readonly runStateFile: string;            // taskDir/run-state.json
  readonly taskFile:     string;            // taskDir/task.task
}
```

- `outputFile` is derived from the stage argument and optional retry number: `{stage}-output.md` for the first attempt (retryNumber 0 or omitted), `{stage}-output-r{N}.md` for retries (retryNumber >= 1)
- For terminal locations (hold/complete/failed/inbox), `outputFile` is omitted (undefined) since no stage is running. Callers that need a specific artifact path in a terminal directory construct it from `artifactsDir` and the known stage name
- The object is disposable: after `moveTaskDir()`, the pipeline calls `resolveTask()` again for the new location

## `buildPaths()` Function

Lives in `src/config/paths.ts`. Single function, no class:

```typescript
export function buildPaths(runtimeDir: string): RuntimePaths {
  // 1. Build stages dictionary by iterating STAGE_DIR_MAP
  // 2. Build terminals with hardcoded names (00-inbox, 10-complete, 11-failed, 12-hold)
  // 3. Pre-resolve all system directory and file paths
  // 4. Attach resolveTask() as closure over runtimeDir
  // 5. Return frozen object
}
```

Imports `STAGE_DIR_MAP` from `src/core/stage-map.ts` — that remains the single source of truth for stage name-to-number mappings.

## Integration Points

### Config loading (`src/config/loader.ts`)

After Zod validation:
```typescript
const paths = buildPaths(parsed.pipeline.runtimeDir);
return { ...resolved, paths };
```

`ResolvedConfig` type in `src/config/schema.ts` gains `paths: RuntimePaths`.

### Init command (`src/commands/init.ts`)

`init` creates the config, so it can't use `loadConfig()`. The init wizard continues to prompt for a base directory (e.g. `~/.shkmn`) — this UX does not change. What changes is that `init` now explicitly appends `runtime/` before writing, matching what `resolveConfigPath()` already expects:
```
baseDir = userInput                      // e.g. "~/.shkmn" (unchanged prompt)
runtimeDir = join(baseDir, "runtime")    // "~/.shkmn/runtime"
paths = buildPaths(runtimeDir)
createRuntimeDirs(paths)
writeConfig(paths.configFile, answers)   // writes to ~/.shkmn/runtime/shkmn.config.json — fixes the bug
writeEnv(paths.envFile)                  // writes to ~/.shkmn/runtime/.env
```

The `pipeline.runtimeDir` value written inside the config JSON is the full `runtimeDir` path (e.g. `~/.shkmn/runtime`). This ensures `loadConfig()` and `init` agree on the canonical location.

### Pipeline (`src/core/pipeline.ts`)

Stage transitions use the `stages` dictionary and `resolveTask()`:
```typescript
const stageDir = config.paths.stages[stage];          // base dir for stage
const tp = config.paths.resolveTask(slug, stage, "pending");  // full task paths
// ... run agent with tp.outputFile, tp.artifactsDir ...
// after stage completes:
const nextTp = config.paths.resolveTask(slug, nextStage, "pending");
```

### Stage runner (`src/core/stage-runner.ts`)

Receives `TaskPaths` from pipeline. Passes `tp.outputFile` and `tp.artifactsDir` to agent-runner. No `join()` calls.

### Agent runner (`src/core/agent-runner.ts`)

Already receives resolved `outputPath` and `cwd` strings. No changes to its path handling — just the upstream source changes.

### Commands (`src/commands/*.ts`)

All commands access paths via `config.paths`:
- `start.ts`: `config.paths.logsDir`, `.pidFile`, `.worktreeManifest`, `.envFile`
- `stop.ts`: `config.paths.pidFile`, `.terminals.inbox`
- `status.ts`: `config.paths.resolveTask()`, `.terminals.hold`
- `logs.ts`: `config.paths.logsDir`
- `history.ts`: `config.paths.terminals.complete`, `.terminals.failed`
- `approve.ts`: `config.paths.terminals.hold`
- `recover.ts`: `config.paths.terminals.hold`, `.resolveTask()`
- `doctor.ts`: `config.paths.configFile`, `.envFile`
- `stats.ts`: `config.paths.interactionsDir`

### Watcher (`src/core/watcher.ts`)

```typescript
config.paths.terminals.inbox      // watch directory
config.paths.slackOutbox          // Slack queue files
config.paths.slackInbox
config.paths.slackProcessed
config.paths.astraResponsesDir
config.paths.terminals.hold       // held task check
```

### Slack queue (`src/core/slack-queue.ts`)

All five Slack file paths come from `config.paths.slack*`.

### Runtime dirs (`src/runtime/dirs.ts`)

`createRuntimeDirs` and `verifyRuntimeDirs` take `RuntimePaths` and iterate its `stages`, `terminals`, and system directory properties. No hardcoded directory names.

### Recovery (`src/core/recovery.ts`, `recovery-reentry.ts`)

Uses `config.paths.stages` to iterate stage directories for scanning, `config.paths.resolveTask()` for path resolution, `config.paths.terminals.hold` for hold operations.

## Files Changed

### New
- `src/config/paths.ts` — `buildPaths()`, `RuntimePaths` type, `TaskPaths` type

### Deleted
- `src/config/resolve-path.ts` — logic folds into `buildPaths()` / `loader.ts`

### Modified (26 files — path construction removed)

| File | Changes |
|---|---|
| `src/config/loader.ts` | Calls `buildPaths()`, attaches to config. Drops ad-hoc `join()` for budget file |
| `src/config/schema.ts` | `ResolvedConfig` gains `paths: RuntimePaths` |
| `src/runtime/dirs.ts` | Takes `RuntimePaths` instead of `string`. Iterates paths object |
| `src/commands/init.ts` | Calls `buildPaths()` directly. Writes to `paths.configFile` and `paths.envFile` |
| `src/commands/start.ts` | Uses `config.paths.logsDir`, `.pidFile`, `.worktreeManifest`, `.envFile` |
| `src/commands/stop.ts` | Uses `config.paths.pidFile`, `.terminals.inbox` |
| `src/commands/status.ts` | Uses `config.paths.resolveTask()`, `.terminals.hold` |
| `src/commands/logs.ts` | Uses `config.paths.logsDir` |
| `src/commands/history.ts` | Uses `config.paths.terminals.complete`, `.terminals.failed` |
| `src/commands/approve.ts` | Uses `config.paths.terminals.hold` |
| `src/commands/recover.ts` | Uses `config.paths.terminals.hold`, `.resolveTask()` |
| `src/commands/doctor.ts` | Uses `config.paths.configFile`, `.envFile` |
| `src/commands/stats.ts` | Uses `config.paths.interactionsDir` |
| `src/core/pipeline.ts` | Uses `config.paths.stages[]`, `.resolveTask()`, `.terminals.hold`, `.worktreesDir` |
| `src/core/stage-runner.ts` | Receives `TaskPaths`. Drops all `join()` for artifacts/output |
| `src/core/watcher.ts` | Uses `config.paths.terminals.inbox`, `.slack*`, `.astraResponsesDir`, `.terminals.hold` |
| `src/core/slack-queue.ts` | Uses `config.paths.slack*` |
| `src/core/worktree.ts` | Receives `worktreesDir` and `worktreeManifest` from caller |
| `src/core/recovery.ts` | Uses `config.paths.stages`, `.resolveTask()` |
| `src/core/recovery-reentry.ts` | Uses `config.paths.terminals.hold`, `.resolveTask()` |
| `src/core/astra-triage.ts` | Uses `config.paths.astraResponsesDir` |
| `src/core/approval-handler.ts` | Uses `config.paths.terminals.hold` |
| `src/core/budget.ts` | Uses `config.paths.usageBudget` |
| `src/core/interactions.ts` | Receives `interactionsDir` from caller |
| `src/surfaces/slack-notifier.ts` | Uses `config.paths.slackOutbox` |
| `src/surfaces/slack-surface.ts` | Uses `config.paths.slackCursor` |

### Untouched
- `src/core/stage-map.ts` — remains source of truth for stage name ↔ number mapping
- `src/core/agent-runner.ts` — already receives resolved strings from upstream
- `agents/*.md` — no path logic in prompt templates

## Test Impact

Existing tests that mock `runtimeDir` and construct paths with `join()` will update to either:
- Use `buildPaths(tmpDir)` to get a real paths object against a temp directory
- Mock `config.paths` directly

No new test files needed — just updating path references in existing test fixtures. `buildPaths()` itself gets unit tests to verify all paths resolve correctly.

## Validation Criteria

1. `shkmn init` followed by `shkmn start` works without config-not-found error
2. `grep -r 'join(.*runtimeDir' src/` returns zero matches outside `src/config/paths.ts`
3. `grep -r '"00-inbox"\|"10-complete"\|"11-failed"\|"12-hold"\|"astra-responses"' src/` returns zero matches outside `src/config/paths.ts` and `src/core/stage-map.ts`
4. All existing tests pass
5. Full pipeline run (inbox → complete) succeeds with no path errors
