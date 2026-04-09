# Smart Task Slug via Astra — Design

**Date:** 2026-04-08
**Status:** Draft
**Scope:** Have Astra generate a concise, meaningful task title during triage, used for slug generation instead of raw Slack message text

## Problem

Task slugs are derived from the first line of the Slack message via `extractTitle()` → `generateSlug()`. This produces slugs like `i-would-like-to-implement-the-spec-4-described-in-20260408142715` — long, unhelpful, and doesn't describe what the task actually does.

## Solution

Add a `taskTitle` field to `AstraTriageResult`. Astra generates this title **after** completing its triage analysis — after reading the repo, Slack threads, Notion pages, and understanding what the task involves. The title reflects Astra's enriched understanding, not the raw message text.

The title flows through `createTask` and becomes the slug base.

## Changes

### 1. Add `taskTitle` to `AstraTriageResult` (`src/core/types.ts`)

```typescript
export interface AstraTriageResult {
  action: "answer" | "route_pipeline" | "control_command";
  // ... existing fields ...

  // Pipeline routing path
  taskTitle?: string | null;  // NEW — concise 3-6 word title from triage analysis
  recommendedStages?: string[] | null;
  // ...
}
```

### 2. Add `taskTitle` to triage Zod schema (`src/core/astra-triage.ts`)

```typescript
const triageResultSchema = z.object({
  // ... existing fields ...
  taskTitle: z.string().nullable().optional(),
  // ...
});
```

### 3. Update Astra triage prompt (`agents/quick-triage.md`)

Add `taskTitle` to the required fields list in the Output format section:

```
- `taskTitle` — concise task title, 3-6 words. Based on your analysis of what needs to be done (not the user's exact words). Describes what will be built, fixed, or changed. Used as the task identifier. Only for `route_pipeline` actions, `null` otherwise.
```

### 4. Add `taskTitle` to `CreateTaskInput` (`src/core/task-creator.ts`)

```typescript
export interface CreateTaskInput {
  source: "slack" | "dashboard" | "cli";
  content: string;
  taskTitle?: string;  // NEW — Astra-generated title, preferred over extractTitle
  // ... existing fields ...
}
```

### 5. Use `taskTitle` in `createTask` (`src/core/task-creator.ts`)

```typescript
export function createTask(input, runtimeDir, config, enrichedContext?, repoSummary?) {
  const title = input.taskTitle ?? extractTitle(input.content);
  const slug = generateSlug(title);
  const content = buildTaskFileContent(input, config, enrichedContext, repoSummary);
  // ...
}
```

Also update `buildTaskFileContent` to use the Astra title for the task file header:

```typescript
export function buildTaskFileContent(input, config, enrichedContext?, repoSummary?) {
  const title = input.taskTitle ?? extractTitle(input.content);
  // ...
  lines.push(`# Task: ${title}`);
  // ...
}
```

### 6. Pass `taskTitle` through in watcher (`src/core/watcher.ts`)

In the `route_pipeline` handler:

```typescript
case "route_pipeline": {
  createTask(
    {
      source: "slack",
      content: text,
      taskTitle: triageResult.taskTitle ?? undefined,  // NEW
      repo: process.cwd(),
      slackThread: entry.thread_ts ?? entry.ts,
      stages: triageResult.recommendedStages ?? undefined,
      stageHints: triageResult.stageHints ?? undefined,
      requiredMcpServers: triageResult.requiredMcpServers ?? undefined,
    },
    runtimeDir,
    config,
    triageResult.enrichedContext ?? undefined,
    triageResult.repoSummary ?? undefined,
  );
  break;
}
```

## What stays the same

- `generateSlug()` — unchanged. Still kebab-cases, truncates to 50 chars, appends timestamp.
- `extractTitle()` — unchanged. Remains the fallback for CLI-created tasks or when Astra doesn't provide a title.
- Full original message is always preserved in the task file under "## What I want done".
- CLI `shkmn task` command — unaffected, continues using `extractTitle` from content.

## Example

**Slack message:** "I would like to implement the spec 4 described in the docs — the dashboard with kanban view and task status tracking"

**Before:** `i-would-like-to-implement-the-spec-4-described-in-20260408142715`

**After (Astra generates after reading the spec):** `spec4-dashboard-kanban-view-20260408142715`

## Testing

1. Test `triageResultSchema` accepts `taskTitle` field.
2. Test `createTask` prefers `taskTitle` over `extractTitle(content)` when provided.
3. Test `createTask` falls back to `extractTitle` when `taskTitle` is null/undefined.
4. Test `buildTaskFileContent` uses `taskTitle` in the `# Task:` header.
5. Test `generateSlug` produces clean slug from Astra-style titles (short, descriptive).
