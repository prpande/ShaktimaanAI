# Spec 6b: Cleanup & Hygiene — Design

**Date:** 2026-04-08
**Status:** Draft
**Scope:** 4 fixes addressing cleanup and hygiene issues found by the pipeline diagnostics audit

## Context

These are lower-risk, independent fixes from the diagnostics audit. They don't affect pipeline correctness but improve operational hygiene. Can be implemented after Spec 6a.

## Fix 1: Stale PID File Handling

**Diagnostic finding:** `shkmn.pid` contains PID 5 (Windows system process) after an unclean shutdown. Stale PID file persists indefinitely.

**Root cause:** The `shutdown()` handler in `start.ts` deletes the PID file on SIGINT/SIGTERM, but if the process crashes or is killed forcefully (SIGKILL, power loss, Windows Task Manager), the file remains.

**Design:**

On startup in `start.ts`, before writing the new PID file, validate any existing PID:

```typescript
// Before writing PID file:
const pidFile = join(config.pipeline.runtimeDir, "shkmn.pid");
if (existsSync(pidFile)) {
  const existingPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  if (!isNaN(existingPid)) {
    try {
      process.kill(existingPid, 0);  // Signal 0 = check if alive, don't kill
      // Process is alive — another instance is running
      console.error(
        `Pipeline already running (PID ${existingPid}). ` +
        `If this is stale, delete ${pidFile} and retry.`
      );
      process.exit(1);
    } catch {
      // Process is dead — stale PID file, safe to overwrite
      logger.warn(`[startup] Removed stale PID file (PID ${existingPid} is not running)`);
      unlinkSync(pidFile);
    }
  } else {
    // Malformed PID file — remove it
    unlinkSync(pidFile);
  }
}
writeFileSync(pidFile, String(process.pid), "utf-8");
```

Note: `process.kill(pid, 0)` on Windows may not work reliably for PIDs from other sessions. The `catch` path handles this — if the check throws for any reason, the PID is treated as stale. This is fail-safe: in the worst case, a truly running instance gets a competing startup, which chokidar handles by logging a watcher error.

**Files:** `src/commands/start.ts`

## Fix 2: Worktree Manifest Creation

**Diagnostic finding:** `worktree-manifest.json` doesn't exist. `recordWorktreeCompletion` reads the file and fails silently if absent. Failed task's worktree persists with no cleanup tracking.

**Root cause:** No code creates the manifest file initially. `recordWorktreeCompletion` assumes it exists.

**Design:**

Two changes:

**(a) Create manifest on worktree creation:**

In `createWorktree` in `worktree.ts`, after successfully creating the worktree, write a creation entry to the manifest:

```typescript
export function createWorktree(
  repoPath: string,
  slug: string,
  worktreesDir: string,
  baseBranch?: string,
): string {
  // ... existing worktree creation logic ...

  // Record creation in manifest
  const manifestPath = join(dirname(worktreesDir), "worktree-manifest.json");
  recordWorktreeCreation(manifestPath, {
    slug,
    repoPath,
    worktreePath,
    createdAt: new Date().toISOString(),
  });

  return worktreePath;
}
```

**(b) Handle missing manifest in read/write functions:**

In `recordWorktreeCompletion` (and the new `recordWorktreeCreation`), create the file with an empty array if it doesn't exist:

```typescript
function readManifest(manifestPath: string): WorktreeManifestEntry[] {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return [];  // File doesn't exist or is corrupt — start fresh
  }
}

function writeManifest(manifestPath: string, entries: WorktreeManifestEntry[]): void {
  writeFileSync(manifestPath, JSON.stringify(entries, null, 2), "utf-8");
}
```

Add `createdAt` to `WorktreeManifestEntry` (currently only has `completedAt`):

```typescript
export interface WorktreeManifestEntry {
  slug: string;
  repoPath: string;
  worktreePath: string;
  createdAt?: string;     // NEW — when worktree was created
  completedAt?: string;   // Existing — when task completed/failed
}
```

**Files:** `src/core/worktree.ts`

## Fix 3: Slack-io Stream File Rotation

**Diagnostic finding:** `slack-io-output-stream.jsonl` is 5.5MB and grows unboundedly. Every Narada poll appends to the same file.

**Root cause:** `createStreamLogger` in `stream-logger.ts` uses `appendFileSync` — correct for per-stage agent runs (unique paths), but problematic for the recurring slack-io agent that reuses the same output path every poll.

**Design:**

In `pollSlack()` in `watcher.ts`, truncate the stream file before spawning Narada:

```typescript
// Before the Narada runner call:
const streamPath = join(runtimeDir, "slack-io-output-stream.jsonl");
try {
  writeFileSync(streamPath, "", "utf-8");  // Truncate
} catch { /* swallow — file may not exist yet */ }

await runner({
  stage: "slack-io",
  slug: "slack-io-poll",
  // ...
  outputPath: join(runtimeDir, "slack-io-output.md"),
  // ...
});
```

The stream file path is derived from `outputPath` by the agent-runner (`outputPath.replace(/\.md$/, "-stream.jsonl")`), so truncating `slack-io-output-stream.jsonl` before the run ensures each poll cycle starts fresh.

The `slack-io-output.md` file is already overwritten each run (not appended), so only the stream file needs this fix.

**Files:** `src/core/watcher.ts` (`pollSlack`)

## Fix 4: Triage Stream Per-Invocation Path

**Diagnostic finding:** `triage-output-stream.jsonl` accumulates across all triage invocations (281KB for 8 runs). Mixes sessions, making attribution difficult.

**Root cause:** `runAstraTriage` uses a fixed `outputPath` (`astra-responses/triage-output.md`) for every triage invocation. The stream logger derives from this, producing the same stream file path every time.

**Design:**

Make the triage output path per-invocation, using the Slack message timestamp:

```typescript
// In watcher.ts, before calling runAstraTriage:
// Pass the message timestamp so triage can use a unique output path
const triageResult = await runAstraTriage(astraInput, runner, config, logger, entry.ts);
```

Update `runAstraTriage` signature to accept a timestamp and use it in the output path:

```typescript
export async function runAstraTriage(
  input: AstraInput,
  runAgentFn: AgentRunnerFn,
  config: ResolvedConfig,
  logger: Logger,
  messageTs?: string,   // NEW — optional, for unique output path
): Promise<AstraTriageResult | null> {
  const tsSlug = messageTs?.replace(".", "-") ?? "triage";
  const outputPath = join(
    config.pipeline.runtimeDir,
    "astra-responses",
    `triage-${tsSlug}-output.md`,
  );

  // ... rest unchanged, uses outputPath ...
}
```

This produces per-invocation files like:
- `astra-responses/triage-1775574738-962879-output.md` (never written — Write disallowed, but harmless)
- `astra-responses/triage-1775574738-962879-output-stream.jsonl` (per-invocation stream)

Matches the existing quick-execute pattern (`{ts}.md`, `{ts}-stream.jsonl`).

**Files:** `src/core/astra-triage.ts`, `src/core/watcher.ts` (pass timestamp)

## Testing Strategy

1. **PID file:** Test startup with stale PID (process not running) — should delete and continue. Test with live PID — should abort.
2. **Worktree manifest:** Test `createWorktree` writes manifest entry. Test `recordWorktreeCompletion` creates file if missing. Test `cleanupExpired` reads the manifest correctly.
3. **Slack-io stream:** Test that stream file is truncated before each poll (check file size after mock poll).
4. **Triage stream:** Test that output path includes message timestamp. Test that separate triage invocations produce separate stream files.
