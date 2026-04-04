# Claude Agent Pipeline — Complete Implementation Plan
**Version:** 2.0  
**Platform:** Windows (PowerShell), OneDrive for Business  
**Stack:** .NET/C#, MindBody BusinessApp, Azure DevOps (MBScrum), GitHub, Notion  
**Last updated:** 2026-04-04

---

## All Design Decisions

| Decision | Choice |
|---|---|
| Stage control | Configure per-task (default: all three) |
| Checkpoints | Configurable per-task via `review_after:` |
| Impl landing | New branch + PR auto-created by agent |
| Build failure | Stop, move to `05-failed\`, notify Slack |
| Pipeline root | OneDrive for Business |
| Repos | Multiple + optional (blank repo = doc-only, impl skipped automatically) |
| Notifications | Slack + GitHub Pages dashboard |
| ADO | Auto-create PBI if no ID given; always link PR to ADO item |
| Dashboard repo | Dedicated `agent-dashboard` GitHub repo, GitHub Pages on `main` |
| Dashboard data | Single append-only `data/status.json` |
| Dashboard UI | Kanban board + detail panel per task |
| Slack inbound | Freeform natural language → `claude -p` parses → `.task` file dropped in inbox |
| Slack outbound | Thread per task; stage updates posted as thread replies |
| Approvals | Thread reply containing "approved" unblocks review gates |
| Slack auth | TBD — designed as a self-contained drop-in module |
| Slack coupling | Zero — core pipeline works fully without Slack |

---

## Part 1: Repository & Folder Structure

### 1A — Pipeline Folders (OneDrive for Business)

```
{ONEDRIVE_ROOT}\agent-pipeline\
│
├── 00-inbox\                    ← Drop .task files here (or Slack module writes here)
│
├── 01-research\
│   ├── pending\                 ← Watcher moves task here; research agent runs
│   └── done\                    ← Research agent writes {slug}.research.md here
│
├── 02-spec\
│   ├── pending\                 ← Research agent (or review gate) routes here
│   └── done\                    ← Spec agent writes {slug}.spec.md here
│
├── 03-impl\
│   ├── pending\                 ← Spec agent (or review gate) routes here
│   └── done\                    ← Impl agent writes {slug}.impl.md here
│
├── 04-complete\                 ← All artifacts bundled; task fully done
│   └── {slug}\                  ← One subfolder per completed task
│
├── 05-failed\                   ← Build/test failures, agent errors
│
├── 06-review\                   ← Tasks paused at a checkpoint awaiting approval
│
├── logs\                        ← One .log file per task (appended across all stages)
│
├── templates\
│   ├── task.template.md         ← Task input format reference
│   ├── prompt-research.md       ← Research agent prompt (loaded at runtime)
│   ├── prompt-spec.md           ← Spec agent prompt
│   ├── prompt-impl.md           ← Impl agent prompt
│   └── prompt-parse-slack.md   ← Slack message → task file prompt (Slack module)
│
├── config.ps1                   ← Single config file — all paths and tokens
├── setup-pipeline.ps1           ← Run once to create folders + register watcher
├── pipeline-watcher.ps1         ← Main loop — routes files, fires agents
└── modules\
    └── slack\
        ├── SLACK-MODULE.md      ← Slack integration spec (implement separately)
        ├── slack-poller.ps1     ← STUB — replace when Slack is set up
        └── slack-notify.ps1     ← STUB — replace when Slack is set up
```

### 1B — Dashboard Repository (GitHub)

```
agent-dashboard\                 ← New GitHub repo; GitHub Pages on main, root /
│
├── index.html                   ← Full dashboard UI (self-contained, no build step)
├── data\
│   └── status.json              ← Append-only event log; agents push updates here
├── assets\
│   ├── style.css
│   └── dashboard.js             ← Reads status.json, renders kanban + detail view
└── README.md
```

### 1C — Local Paths

```
C:\Agents\
├── agent-dashboard\             ← Local clone of dashboard repo (agents push here)
└── pipeline\                    ← Local clone of pipeline scripts repo
```

---

## Part 2: File Formats

### 2A — Task File (`.task`)

The `.task` file is the universal contract between all inputs (you, Slack module,
future integrations) and the pipeline. Everything upstream converts TO this format.
Everything downstream reads FROM it.

```markdown
# Task: {Short title}

## What I want done
{Full description. Can be a sentence or several paragraphs.}

## Context
{Background, constraints, related tickets, things to avoid.}

## Repo
{Full local Windows path, e.g. C:\Code\mindbody-businessapp}
{Leave blank for doc/research-only tasks — impl stage will be skipped automatically.}

## ADO Item
{Existing ADO work item ID to link against, e.g. 1502604}
{Leave blank to have the pipeline auto-create a new PBI in MBScrum.}

## Slack Thread
{Slack thread timestamp (ts) for posting updates back — set by Slack module.}
{Leave blank if task was created manually (no Slack thread to reply to).}

## Pipeline Config
stages: research, spec, impl
review_after: spec
```

**Minimal example — doc-only task, no code:**
```markdown
# Task: Document MindBody v6 appointment API patterns

## What I want done
Research and document all appointment-related endpoints in the MindBody v6 API
that we currently use. Cover request/response shapes, auth requirements, and
known quirks. Output a reference page to Notion under the Engineering space.

## Pipeline Config
stages: research, spec
review_after: none
```

**Full example — code task with review gate:**
```markdown
# Task: Add retry logic to MindBodyApiClient

## What I want done
Add exponential backoff retry on transient HTTP errors (429, 503, 504).
Should be configurable: max retries and base delay. Add unit tests.

## Context
- MindBodyApiClient is in src/Services/MindBodyApiClient.cs
- Polly is already referenced — use it, don't add a new library
- Do not touch the auth header logic

## Repo
C:\Code\mindbody-businessapp

## ADO Item
(leave blank — create new PBI)

## Pipeline Config
stages: research, spec, impl
review_after: spec
```

---

### 2B — Status Event Schema (`status.json`)

Every agent call appends one JSON object to the array in `data/status.json`.
The dashboard derives each task's *current* state from the latest event per task ID.
Full history is preserved for the detail panel.

```json
{
  "id":        "20260404-0900-mindbody-retry-logic",
  "title":     "Add retry logic to MindBodyApiClient",
  "stage":     "impl",
  "status":    "in_progress",
  "timestamp": "2026-04-04T11:32:00Z",
  "agent":     "impl",
  "message":   "Branch agent/20260404-0900-mindbody-retry-logic created. Running dotnet build.",
  "slack_thread": "1234567890.123456",
  "links": {
    "ado":      "https://dev.azure.com/mindbody/MBScrum/_workitems/edit/1502888",
    "pr":       null,
    "research": "01-research/done/20260404-0900-mindbody-retry-logic.research.md",
    "spec":     "02-spec/done/20260404-0900-mindbody-retry-logic.spec.md",
    "impl":     null
  }
}
```

**`status` values:** `queued` | `in_progress` | `review_needed` | `complete` | `failed` | `blocked`  
**`stage` values:** `inbox` | `research` | `spec` | `impl` | `complete` | `failed` | `review`

---

### 2C — Slack Module Interface Contract

These are the two functions the rest of the pipeline calls for Slack.
The stubs work silently (no-op) until the real Slack module is installed.

```powershell
# Called by pipeline-watcher.ps1 at every stage transition
# Parameters are stable — Slack module implements the body
function Send-PipelineNotification {
    param(
        [string]$TaskId,
        [string]$TaskTitle,
        [string]$Stage,
        [string]$Status,
        [string]$Message,
        [string]$SlackThread,   # Empty string if no Slack thread
        [hashtable]$Links = @{}
    )
    # STUB: no-op until slack-notify.ps1 is implemented
}

# Called by pipeline-watcher.ps1 to check for approval in a review thread
# Returns $true if an "approved" reply exists in the thread
function Test-SlackApproval {
    param([string]$SlackThread)
    # STUB: always returns $false until slack-poller.ps1 is implemented
    return $false
}
```

---

## Part 3: Scripts

### 3A — `config.ps1`

```powershell
# config.ps1
# The only file you need to edit. All other scripts source this.
# DO NOT commit real tokens to Git — use a .env pattern or Windows Credential Manager
# for production use.

# ── Paths ───────────────────────────────────────────────────────────────────

# Pipeline root on OneDrive for Business
# Find your OneDrive path: run   echo %OneDriveCommercial%   in CMD
$PipelineRoot = "$env:OneDriveCommercial\agent-pipeline"

# Local clone of the dashboard repo (agents push status updates here)
$DashboardRepo = "C:\Agents\agent-dashboard"

# GitHub dashboard repo remote URL
$DashboardRepoUrl = "https://github.com/YOUR_ORG/agent-dashboard.git"

# ── ADO ─────────────────────────────────────────────────────────────────────

$AdoOrg     = "https://dev.azure.com/mindbody"
$AdoProject = "MBScrum"
$AdoArea    = "BusinessApp"

# ── Claude Code Tool Permissions ─────────────────────────────────────────────
# Restrict each agent to only the tools it needs

$ResearchTools = "Read,Bash,mcp__ado__*,mcp__github__*,mcp__notion__*,WebSearch"
$SpecTools     = "Read,Write,mcp__ado__*,mcp__notion__*"
$ImplTools     = "Read,Write,Edit,Bash,mcp__ado__*,mcp__github__*"

# Safety rails: max turns per agent in headless mode
$ResearchMaxTurns = 30
$SpecMaxTurns     = 20
$ImplMaxTurns     = 60

# ── Slack (populated when Slack module is installed) ─────────────────────────

$SlackEnabled      = $false          # Set to $true when Slack module is ready
$SlackToken        = ""              # User OAuth token (xoxp-...)
$SlackChannel      = "#agent-pipeline"
$SlackChannelId    = ""              # Channel ID (C0123456789) — needed for API calls
$SlackPollInterval = 30             # Seconds between polls for new messages

# ── Dashboard ────────────────────────────────────────────────────────────────

$DashboardEnabled = $true
```

---

### 3B — `setup-pipeline.ps1`

```powershell
# setup-pipeline.ps1
# Run ONCE on initial setup. Safe to re-run — idempotent.

. .\config.ps1

Write-Host "`nClaude Agent Pipeline — Setup" -ForegroundColor Cyan
Write-Host "================================`n"

# 1. Create folder structure
Write-Host "Creating pipeline folders..." -ForegroundColor Yellow
$Folders = @(
    "$PipelineRoot\00-inbox",
    "$PipelineRoot\01-research\pending",
    "$PipelineRoot\01-research\done",
    "$PipelineRoot\02-spec\pending",
    "$PipelineRoot\02-spec\done",
    "$PipelineRoot\03-impl\pending",
    "$PipelineRoot\03-impl\done",
    "$PipelineRoot\04-complete",
    "$PipelineRoot\05-failed",
    "$PipelineRoot\06-review",
    "$PipelineRoot\logs",
    "$PipelineRoot\templates",
    "$PipelineRoot\modules\slack"
)
foreach ($F in $Folders) {
    New-Item -ItemType Directory -Force -Path $F | Out-Null
    Write-Host "  OK  $F"
}

# 2. Copy templates and scripts
Write-Host "`nCopying templates..." -ForegroundColor Yellow
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Copy-Item "$ScriptDir\templates\*" "$PipelineRoot\templates\" -Force
Copy-Item "$ScriptDir\modules\slack\*" "$PipelineRoot\modules\slack\" -Force

# 3. Clone dashboard repo
Write-Host "`nSetting up dashboard repo..." -ForegroundColor Yellow
if (-not (Test-Path $DashboardRepo)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $DashboardRepo) | Out-Null
    git clone $DashboardRepoUrl $DashboardRepo
    Write-Host "  Cloned to $DashboardRepo"
} else {
    Write-Host "  Already exists: $DashboardRepo"
}

# 4. Register pipeline watcher as a scheduled task (runs at logon, never times out)
Write-Host "`nRegistering watcher scheduled task..." -ForegroundColor Yellow
$WatcherPath = "$ScriptDir\pipeline-watcher.ps1"
$ConfigPath  = "$ScriptDir\config.ps1"
$Action   = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NonInteractive -WindowStyle Hidden -File `"$WatcherPath`" -ConfigPath `"$ConfigPath`""
$Trigger  = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask `
    -TaskName "ClaudeAgentPipeline" `
    -Action $Action -Trigger $Trigger -Settings $Settings `
    -Description "Claude Agent Pipeline watcher" -Force | Out-Null
Write-Host "  Registered: ClaudeAgentPipeline"

# 5. Verify Claude Code
Write-Host "`nChecking Claude Code..." -ForegroundColor Yellow
$ClaudeVersion = claude --version 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  OK  $ClaudeVersion"
} else {
    Write-Host "  MISSING — install from: https://code.claude.com" -ForegroundColor Red
}

# 6. Summary
Write-Host "`n================================" -ForegroundColor Cyan
Write-Host "Setup complete." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Edit config.ps1 — fill in YOUR_ORG, ADO details"
Write-Host "  2. Verify MCPs in %USERPROFILE%\.claude\settings.json (ado, github, notion)"
Write-Host "  3. Reboot or start task 'ClaudeAgentPipeline' from Task Scheduler"
Write-Host "  4. Drop a .task file into:"
Write-Host "     $PipelineRoot\00-inbox\" -ForegroundColor Yellow
Write-Host "  5. Dashboard: https://YOUR_ORG.github.io/agent-dashboard" -ForegroundColor Yellow
Write-Host ""
```

---

### 3C — `pipeline-watcher.ps1`

```powershell
# pipeline-watcher.ps1
# Main loop. Runs continuously at logon.
# Sources config, loads Slack module stubs, watches folders, fires agents.

param([string]$ConfigPath = ".\config.ps1")
. $ConfigPath
. "$PipelineRoot\modules\slack\slack-notify.ps1"    # Stub or real — same interface

# ══════════════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════════════

function Write-Log {
    param([string]$Slug, [string]$Stage, [string]$Msg)
    $Line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [$Stage] $Msg"
    Write-Host $Line
    Add-Content -Path "$PipelineRoot\logs\$Slug.log" -Value $Line -Encoding UTF8
}

function Get-Slug { param([string]$Path)
    [IO.Path]::GetFileNameWithoutExtension($Path)
}

function Read-TaskMeta {
    param([string]$File)
    $C = Get-Content $File -Raw -Encoding UTF8
    return @{
        Title       = if ($C -match '(?m)^# Task: (.+)$')         { $Matches[1].Trim() } else { "Unnamed Task" }
        Repo        = if ($C -match '(?m)^## Repo\r?\n(.+)$')     { $Matches[1].Trim() } else { "" }
        AdoItem     = if ($C -match '(?m)^## ADO Item\r?\n(\d+)') { $Matches[1].Trim() } else { "" }
        SlackThread = if ($C -match '(?m)^## Slack Thread\r?\n(.+)$') { $Matches[1].Trim() } else { "" }
        Stages      = if ($C -match 'stages:\s*(.+)')  {
                          $Matches[1].Trim() -split '\s*,\s*' | ForEach-Object { $_.Trim() }
                      } else { @("research","spec","impl") }
        ReviewAfter = if ($C -match 'review_after:\s*(\w+)') { $Matches[1].Trim() } else { "none" }
    }
}

function Push-DashboardEvent {
    param(
        [string]$Id, [string]$Title, [string]$Stage, [string]$Status,
        [string]$Agent, [string]$Msg, [string]$SlackThread = "",
        [hashtable]$Links = @{}
    )
    if (-not $DashboardEnabled) { return }

    $Event = [ordered]@{
        id           = $Id
        title        = $Title
        stage        = $Stage
        status       = $Status
        timestamp    = (Get-Date -Format "o")
        agent        = $Agent
        message      = $Msg
        slack_thread = $SlackThread
        links        = $Links
    }

    try {
        $JsonFile = "$DashboardRepo\data\status.json"
        $Existing = if (Test-Path $JsonFile) {
            (Get-Content $JsonFile -Raw | ConvertFrom-Json)
        } else { @() }

        # ConvertFrom-Json returns PSCustomObject array — convert to regular array
        $List = [System.Collections.ArrayList]@($Existing)
        $List.Add((New-Object PSObject -Property $Event)) | Out-Null

        $List | ConvertTo-Json -Depth 10 | Set-Content $JsonFile -Encoding UTF8

        Push-Location $DashboardRepo
        git pull --quiet 2>$null
        git add "data\status.json" | Out-Null
        git commit -m "status: $Id -> $Stage ($Status)" --quiet | Out-Null
        git push --quiet 2>$null
        Pop-Location
    } catch {
        Write-Host "  Dashboard push failed: $_" -ForegroundColor DarkYellow
    }
}

function Move-Task {
    param([string]$File, [string]$Slug, [string]$Dest,
          [hashtable]$Meta, [string]$Reason = "")

    $FileName = Split-Path $File -Leaf

    switch ($Dest) {
        "research"  { Move-Item $File "$PipelineRoot\01-research\pending\$FileName" -Force }
        "spec"      { Move-Item $File "$PipelineRoot\02-spec\pending\$FileName" -Force }
        "impl"      { Move-Item $File "$PipelineRoot\03-impl\pending\$FileName" -Force }

        "review" {
            Move-Item $File "$PipelineRoot\06-review\$FileName" -Force
            Write-Log $Slug "REVIEW" "Paused. Open the task file and add 'approved: true' to continue."
            Push-DashboardEvent $Slug $Meta.Title "review" "review_needed" "pipeline" `
                "Awaiting approval before next stage." $Meta.SlackThread
            Send-PipelineNotification $Slug $Meta.Title "review" "review_needed" `
                "Task *$($Meta.Title)* is waiting for your approval.`nOpen ``06-review\$FileName``, add ``approved: true``, and save — or reply *approved* in this thread." `
                $Meta.SlackThread
        }

        "complete" {
            $Dir = "$PipelineRoot\04-complete\$Slug"
            New-Item -ItemType Directory -Force -Path $Dir | Out-Null
            Move-Item $File "$Dir\$FileName" -Force

            # Bundle all artifacts into the complete folder
            @("01-research\done","02-spec\done","03-impl\done") | ForEach-Object {
                $Src = "$PipelineRoot\$_\$Slug.*"
                Get-Item $Src -ErrorAction SilentlyContinue |
                    Move-Item -Destination $Dir -Force -ErrorAction SilentlyContinue
            }
            Copy-Item "$PipelineRoot\logs\$Slug.log" $Dir -Force -ErrorAction SilentlyContinue

            Write-Log $Slug "COMPLETE" "All artifacts in 04-complete\$Slug\"
            Push-DashboardEvent $Slug $Meta.Title "complete" "complete" "pipeline" `
                "Task fully complete." $Meta.SlackThread
            Send-PipelineNotification $Slug $Meta.Title "complete" "complete" `
                ":white_check_mark: Task *$($Meta.Title)* is complete. All artifacts saved." `
                $Meta.SlackThread
        }

        "failed" {
            Move-Item $File "$PipelineRoot\05-failed\$FileName" -Force -ErrorAction SilentlyContinue
            Write-Log $Slug "FAILED" $Reason
            Push-DashboardEvent $Slug $Meta.Title "failed" "failed" "pipeline" $Reason $Meta.SlackThread
            Send-PipelineNotification $Slug $Meta.Title "failed" "failed" `
                ":x: Task *$($Meta.Title)* failed.`nReason: $Reason`nCheck: ``05-failed\$FileName``" `
                $Meta.SlackThread
        }
    }
}

# ══════════════════════════════════════════════════════
# AGENT RUNNERS
# ══════════════════════════════════════════════════════

function Invoke-Agent {
    param(
        [string]$Stage,
        [string]$File,
        [string]$Slug,
        [hashtable]$Meta,
        [string]$PromptTemplate,
        [string]$OutputFile,
        [string]$Tools,
        [int]$MaxTurns,
        [hashtable]$PromptVars = @{}
    )

    Write-Log $Slug $Stage.ToUpper() "Agent starting"
    Push-DashboardEvent $Slug $Meta.Title $Stage "in_progress" $Stage `
        "$Stage agent started." $Meta.SlackThread
    Send-PipelineNotification $Slug $Meta.Title $Stage "in_progress" `
        ":gear: *$Stage* agent started for task: *$($Meta.Title)*" $Meta.SlackThread

    # Build prompt from template
    $Prompt = Get-Content $PromptTemplate -Raw -Encoding UTF8
    $Prompt = $Prompt -replace "\{\{TASK_CONTENT\}\}", (Get-Content $File -Raw)
    foreach ($Key in $PromptVars.Keys) {
        $Prompt = $Prompt -replace "\{\{$Key\}\}", $PromptVars[$Key]
    }
    $Prompt = $Prompt `
        -replace "\{\{TASK_SLUG\}\}",    $Slug `
        -replace "\{\{OUTPUT_PATH\}\}",  $OutputFile `
        -replace "\{\{ADO_ITEM\}\}",     $Meta.AdoItem `
        -replace "\{\{ADO_ORG\}\}",      $AdoOrg `
        -replace "\{\{ADO_PROJECT\}\}",  $AdoProject `
        -replace "\{\{ADO_AREA\}\}",     $AdoArea

    # Determine working directory
    $WorkDir = if ($Meta.Repo -and (Test-Path $Meta.Repo)) { $Meta.Repo } else { $PipelineRoot }

    # Run agent headlessly
    Push-Location $WorkDir
    $AgentOutput = $Prompt | claude -p `
        --allowedTools $Tools `
        --max-turns $MaxTurns `
        --output-format text 2>&1
    Pop-Location

    # Check output file was produced
    if (Test-Path $OutputFile) {
        Write-Log $Slug $Stage.ToUpper() "Output: $(Split-Path $OutputFile -Leaf)"
        return $true
    } else {
        Write-Log $Slug $Stage.ToUpper() "ERROR: No output file found at $OutputFile"
        Write-Log $Slug $Stage.ToUpper() "Agent stdout: $AgentOutput"
        return $false
    }
}

function Invoke-ResearchAgent {
    param([string]$File, [string]$Slug, [hashtable]$Meta)
    return Invoke-Agent `
        -Stage      "research" `
        -File       $File `
        -Slug       $Slug `
        -Meta       $Meta `
        -PromptTemplate "$PipelineRoot\templates\prompt-research.md" `
        -OutputFile "$PipelineRoot\01-research\done\$Slug.research.md" `
        -Tools      $ResearchTools `
        -MaxTurns   $ResearchMaxTurns
}

function Invoke-SpecAgent {
    param([string]$File, [string]$Slug, [hashtable]$Meta)
    $ResearchContent = ""
    $ResearchFile = "$PipelineRoot\01-research\done\$Slug.research.md"
    if (Test-Path $ResearchFile) { $ResearchContent = Get-Content $ResearchFile -Raw }

    return Invoke-Agent `
        -Stage      "spec" `
        -File       $File `
        -Slug       $Slug `
        -Meta       $Meta `
        -PromptTemplate "$PipelineRoot\templates\prompt-spec.md" `
        -OutputFile "$PipelineRoot\02-spec\done\$Slug.spec.md" `
        -Tools      $SpecTools `
        -MaxTurns   $SpecMaxTurns `
        -PromptVars @{ RESEARCH_CONTENT = $ResearchContent }
}

function Invoke-ImplAgent {
    param([string]$File, [string]$Slug, [hashtable]$Meta)

    if (-not $Meta.Repo -or -not (Test-Path $Meta.Repo)) {
        Write-Log $Slug "IMPL" "No valid repo path — skipping impl"
        Move-Task $File $Slug "failed" $Meta "Impl stage requires a repo path. None was provided or path does not exist."
        return $false
    }

    $SpecContent = ""
    $SpecFile = "$PipelineRoot\02-spec\done\$Slug.spec.md"
    if (Test-Path $SpecFile) { $SpecContent = Get-Content $SpecFile -Raw }

    $BranchName = "agent/$Slug"
    $Success = Invoke-Agent `
        -Stage      "impl" `
        -File       $File `
        -Slug       $Slug `
        -Meta       $Meta `
        -PromptTemplate "$PipelineRoot\templates\prompt-impl.md" `
        -OutputFile "$PipelineRoot\03-impl\done\$Slug.impl.md" `
        -Tools      $ImplTools `
        -MaxTurns   $ImplMaxTurns `
        -PromptVars @{ SPEC_CONTENT = $SpecContent; BRANCH_NAME = $BranchName }

    if (-not $Success) { return $false }

    # Check impl output for build failure signal
    $ImplOut = Get-Content "$PipelineRoot\03-impl\done\$Slug.impl.md" -Raw
    if ($ImplOut -match "BUILD FAILED|TESTS FAILED") {
        Write-Log $Slug "IMPL" "Build or test failure detected"
        Move-Task $File $Slug "failed" $Meta "Build or tests failed. See 03-impl\done\$Slug.impl.md for details."
        return $false
    }

    return $true
}

# ══════════════════════════════════════════════════════
# PIPELINE ORCHESTRATOR
# ══════════════════════════════════════════════════════

function Invoke-Pipeline {
    param([string]$File)

    Start-Sleep -Milliseconds 500   # Let file finish writing to disk
    if (-not (Test-Path $File)) { return }

    $Slug = Get-Slug $File
    $Meta = Read-TaskMeta $File

    Write-Log $Slug "INBOX" "Received: $(Split-Path $File -Leaf) | Stages: $($Meta.Stages -join ', ')"
    Push-DashboardEvent $Slug $Meta.Title "inbox" "queued" "pipeline" `
        "Task received. Stages: $($Meta.Stages -join ', ')." $Meta.SlackThread
    Send-PipelineNotification $Slug $Meta.Title "inbox" "queued" `
        ":inbox_tray: New task received: *$($Meta.Title)*`nStages: $($Meta.Stages -join ' → ')" `
        $Meta.SlackThread

    # ── Research ──────────────────────────────────────
    if ("research" -in $Meta.Stages) {
        Move-Task $File $Slug "research" $Meta
        $File = "$PipelineRoot\01-research\pending\$(Split-Path $File -Leaf)"
        $OK = Invoke-ResearchAgent $File $Slug $Meta
        if (-not $OK) { Move-Task $File $Slug "failed" $Meta "Research agent failed to produce output."; return }

        Push-DashboardEvent $Slug $Meta.Title "research" "complete" "research" `
            "Research complete." $Meta.SlackThread `
            @{ research = "01-research/done/$Slug.research.md" }
        Send-PipelineNotification $Slug $Meta.Title "research" "complete" `
            ":mag: Research complete for *$($Meta.Title)*." $Meta.SlackThread

        if ($Meta.ReviewAfter -eq "research") { Move-Task $File $Slug "review" $Meta; return }
    }

    # ── Spec ──────────────────────────────────────────
    if ("spec" -in $Meta.Stages) {
        Move-Task $File $Slug "spec" $Meta
        $File = "$PipelineRoot\02-spec\pending\$(Split-Path $File -Leaf)"
        $OK = Invoke-SpecAgent $File $Slug $Meta
        if (-not $OK) { Move-Task $File $Slug "failed" $Meta "Spec agent failed to produce output."; return }

        Push-DashboardEvent $Slug $Meta.Title "spec" "complete" "spec" `
            "Spec complete." $Meta.SlackThread `
            @{ spec = "02-spec/done/$Slug.spec.md" }
        Send-PipelineNotification $Slug $Meta.Title "spec" "complete" `
            ":memo: Spec complete for *$($Meta.Title)*." $Meta.SlackThread

        if ($Meta.ReviewAfter -eq "spec") { Move-Task $File $Slug "review" $Meta; return }
    }

    # ── Impl ──────────────────────────────────────────
    if ("impl" -in $Meta.Stages) {
        Move-Task $File $Slug "impl" $Meta
        $File = "$PipelineRoot\03-impl\pending\$(Split-Path $File -Leaf)"
        $OK = Invoke-ImplAgent $File $Slug $Meta
        if (-not $OK) { return }   # Move-Task already called inside Invoke-ImplAgent on failure

        Push-DashboardEvent $Slug $Meta.Title "impl" "complete" "impl" `
            "Implementation complete." $Meta.SlackThread `
            @{ impl = "03-impl/done/$Slug.impl.md" }

        if ($Meta.ReviewAfter -eq "impl") { Move-Task $File $Slug "review" $Meta; return }
    }

    Move-Task $File $Slug "complete" $Meta
}

function Resume-Pipeline {
    param([string]$File)

    Start-Sleep -Milliseconds 500
    if (-not (Test-Path $File)) { return }

    $Content = Get-Content $File -Raw
    if ($Content -notmatch "approved:\s*true") { return }   # Not yet approved

    $Slug = Get-Slug $File
    $Meta = Read-TaskMeta $File

    # Also check Slack thread for approval reply (when Slack module is active)
    $SlackApproved = if ($Meta.SlackThread) { Test-SlackApproval $Meta.SlackThread } else { $false }
    if (-not ($Content -match "approved:\s*true") -and -not $SlackApproved) { return }

    Write-Log $Slug "REVIEW" "Approval detected — resuming pipeline"
    Push-DashboardEvent $Slug $Meta.Title "review" "in_progress" "pipeline" `
        "Approved. Resuming pipeline." $Meta.SlackThread
    Send-PipelineNotification $Slug $Meta.Title "review" "in_progress" `
        ":white_check_mark: Approved. Resuming pipeline for *$($Meta.Title)*." $Meta.SlackThread

    # Resume from the right stage by checking which artifacts already exist
    $ResearchDone = Test-Path "$PipelineRoot\01-research\done\$Slug.research.md"
    $SpecDone     = Test-Path "$PipelineRoot\02-spec\done\$Slug.spec.md"

    if ($SpecDone -and "impl" -in $Meta.Stages) {
        Move-Task $File $Slug "impl" $Meta
        $File = "$PipelineRoot\03-impl\pending\$(Split-Path $File -Leaf)"
        $OK = Invoke-ImplAgent $File $Slug $Meta
        if (-not $OK) { return }

    } elseif ($ResearchDone -and "spec" -in $Meta.Stages) {
        Move-Task $File $Slug "spec" $Meta
        $File = "$PipelineRoot\02-spec\pending\$(Split-Path $File -Leaf)"
        $OK = Invoke-SpecAgent $File $Slug $Meta
        if (-not $OK) { Move-Task $File $Slug "failed" $Meta "Spec agent failed on resume."; return }
        if ($Meta.ReviewAfter -eq "spec") { Move-Task $File $Slug "review" $Meta; return }

        if ("impl" -in $Meta.Stages) {
            Move-Task $File $Slug "impl" $Meta
            $File = "$PipelineRoot\03-impl\pending\$(Split-Path $File -Leaf)"
            $OK = Invoke-ImplAgent $File $Slug $Meta
            if (-not $OK) { return }
        }
    }

    Move-Task $File $Slug "complete" $Meta
}

# ══════════════════════════════════════════════════════
# FILE SYSTEM WATCHERS
# ══════════════════════════════════════════════════════

Write-Host "`nClaude Agent Pipeline — Watcher Running" -ForegroundColor Cyan
Write-Host "Inbox  : $PipelineRoot\00-inbox\" -ForegroundColor Yellow
Write-Host "Review : $PipelineRoot\06-review\" -ForegroundColor Yellow
Write-Host "Logs   : $PipelineRoot\logs\" -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop.`n"

# Inbox watcher
$InboxWatcher = New-Object System.IO.FileSystemWatcher
$InboxWatcher.Path                     = "$PipelineRoot\00-inbox"
$InboxWatcher.Filter                   = "*.task"
$InboxWatcher.EnableRaisingEvents      = $true
Register-ObjectEvent $InboxWatcher "Created" -Action { Invoke-Pipeline $Event.SourceEventArgs.FullPath }

# Review folder watcher
$ReviewWatcher = New-Object System.IO.FileSystemWatcher
$ReviewWatcher.Path                    = "$PipelineRoot\06-review"
$ReviewWatcher.Filter                  = "*.task"
$ReviewWatcher.NotifyFilter            = [System.IO.NotifyFilters]::LastWrite
$ReviewWatcher.EnableRaisingEvents     = $true
Register-ObjectEvent $ReviewWatcher "Changed" -Action { Resume-Pipeline $Event.SourceEventArgs.FullPath }

# Keep process alive
while ($true) { Start-Sleep -Seconds 5 }
```

---

## Part 4: Agent Prompt Templates

### `templates/prompt-research.md`

```
You are the Research Agent in an automated development pipeline.
Complete the research task below fully. Do not ask for confirmation between steps.

═══ TASK ═══
{{TASK_CONTENT}}

═══ YOUR JOB ═══
1. If a repo path is provided in the task, read all files relevant to this task.
   Understand the current implementation, conventions, and patterns.
2. Search ADO project {{ADO_PROJECT}} for related work items, existing bugs, or prior art
   related to this task. Note any relevant item IDs.
3. Search Notion for design docs, meeting notes, or prior decisions related to this area.
4. Identify the recommended approach with clear reasoning.
5. List all risks, edge cases, unknowns, and external dependencies.

═══ OUTPUT ═══
Write your complete research to EXACTLY this path:
{{OUTPUT_PATH}}

Use this exact structure:

# Research: {task title}

## Summary
One paragraph: what this task is, what currently exists, recommended approach.

## Relevant Files
List of files in the repo most relevant to this task (with brief note on each).

## Existing Patterns
What conventions, libraries, or patterns already exist that this task should follow.

## Recommended Approach
Detailed description of the recommended implementation approach.

## Alternative Approaches
2-3 alternatives with trade-offs vs the recommended approach.

## Risks & Edge Cases
Specific risks, edge cases, and things the spec agent must address.

## ADO Context
Related ADO items found. If no ADO item was specified in the task,
suggest a PBI title and area path ({{ADO_AREA}}) for the spec agent to create.

## Notion Context
Relevant Notion pages found (titles + URLs).

Write the file, then stop. Do not begin the spec.
```

---

### `templates/prompt-spec.md`

```
You are the Spec Agent in an automated development pipeline.
Produce a complete specification. Do not ask for confirmation. Do not write any code.

═══ TASK ═══
{{TASK_CONTENT}}

═══ RESEARCH ═══
{{RESEARCH_CONTENT}}

═══ YOUR JOB ═══
1. Write a complete specification document to {{OUTPUT_PATH}}.
2. Create (or update) an ADO work item:
   - If ADO Item is provided in the task ({{ADO_ITEM}}): update its description
     and acceptance criteria with the spec summary.
   - If no ADO Item: create a new PBI in {{ADO_PROJECT}} under area {{ADO_AREA}}.
     Use the title and area suggested in the research. Record the new item ID
     in the output file under "## ADO Item".
3. Save the spec document, then stop. Do not implement anything.

═══ OUTPUT ═══
Write the spec to EXACTLY this path:
{{OUTPUT_PATH}}

Use this exact structure:

# Spec: {task title}

## ADO Item
{URL of the ADO PBI created or updated}

## Problem Statement
What problem this solves and why it matters.

## Proposed Solution
Clear description of what will be built or changed.

## Components to Change
List each file/class/interface that will be modified, with a brief description of the change.

## New Files to Create
List each new file with its purpose.

## API Contract Changes
Any changes to public interfaces, REST endpoints, or event schemas.
FLAG explicitly if Identity team review is required (any auth/login changes).

## Test Plan
Unit tests: what scenarios to cover.
Integration tests: what end-to-end flows to verify.

## Acceptance Criteria
Numbered list — copy-paste ready for ADO.

## Out of Scope
Explicit list of what this task does NOT cover.

## Implementation Notes for Impl Agent
Specific instructions, gotchas, or constraints the impl agent must follow.
```

---

### `templates/prompt-impl.md`

```
You are the Implementation Agent in an automated development pipeline.
Implement the specification exactly as written. Do not ask for confirmation between steps.

═══ TASK ═══
{{TASK_CONTENT}}

═══ SPECIFICATION ═══
{{SPEC_CONTENT}}

═══ YOUR JOB ═══
Execute these steps in order. Stop immediately and report if any step fails.

STEP 1 — Create branch
  git checkout main (or the default branch)
  git pull
  git checkout -b {{BRANCH_NAME}}

STEP 2 — Implement
  Make all changes specified in the spec. No more, no less.
  Follow all conventions in CLAUDE.md if present.
  Do not modify files outside the scope defined in the spec.

STEP 3 — Build
  Run: dotnet build
  If build fails: write "BUILD FAILED" and the full error to {{OUTPUT_PATH}} and stop.

STEP 4 — Test
  Run: dotnet test --no-build
  If tests fail: write "TESTS FAILED" and the failure details to {{OUTPUT_PATH}} and stop.

STEP 5 — Commit and push
  git add -A
  git commit -m "feat(agent): {task title} [{{TASK_SLUG}}]"
  git push -u origin {{BRANCH_NAME}}

STEP 6 — Create PR
  Create a GitHub pull request:
    Title: [Agent] {task title}
    Body:
      ## Summary
      {2-3 sentence summary of what was implemented}

      ## Changes
      {bullet list of files changed}

      ## ADO Item
      {link to ADO item {{ADO_ITEM}} if provided}

      ## Notes
      {any deviations from the spec and the reason}

STEP 7 — Link ADO
  If ADO item {{ADO_ITEM}} was provided:
    Add the PR URL to the ADO item's Development links.
    Move the ADO item state to "In Review".

═══ OUTPUT ═══
Write a summary to EXACTLY this path:
{{OUTPUT_PATH}}

Structure:
# Implementation Summary: {task title}

## Result
BUILD SUCCEEDED / BUILD FAILED / TESTS FAILED   ← must be one of these exact strings

## Branch
{branch name}

## PR
{PR URL or "not created — build/tests failed"}

## ADO Item
{ADO item URL}

## Files Changed
{list of files modified or created}

## Deviations from Spec
{any changes from the spec, with reasons — or "None"}

## Test Results
{summary of test run}
```

---

### `templates/prompt-parse-slack.md`

*(Used by the Slack module — not by core pipeline)*

```
You are a task parser for a development pipeline.

A developer has sent the following Slack message to a pipeline channel.
Extract the task details and output a valid .task file.

═══ SLACK MESSAGE ═══
{{SLACK_MESSAGE}}

═══ AVAILABLE REPOS (from config) ═══
{{KNOWN_REPOS}}

═══ OUTPUT ═══
Output ONLY the .task file content — no preamble, no explanation.
Infer as much as possible from the message.
If a repo is mentioned or inferable from context, use the closest match from AVAILABLE REPOS.
If no repo is clear, leave the Repo field blank (doc-only task).
Default stages to: research, spec, impl
Default review_after to: spec

Use this exact format:

# Task: {inferred title}

## What I want done
{full description inferred from the message}

## Context
{any constraints, references, or background mentioned}

## Repo
{matched repo path or blank}

## ADO Item
{ADO item number if mentioned, else blank}

## Slack Thread
{{SLACK_THREAD_TS}}

## Pipeline Config
stages: research, spec, impl
review_after: spec
```

---

## Part 5: Slack Module (Self-Contained)

The Slack module lives in `modules\slack\`. The core pipeline has zero knowledge
of how it works — it only calls `Send-PipelineNotification` and `Test-SlackApproval`
which are defined in `slack-notify.ps1`.

### `modules/slack/SLACK-MODULE.md`

```markdown
# Slack Module — Implementation Spec

## Status
NOT YET IMPLEMENTED. Stubs are in place. Implement this module separately
once your Slack workspace integration is confirmed.

## What Needs to Be Implemented

### 1. slack-notify.ps1 (outbound — replace stub)
Implements two functions the pipeline calls:

  Send-PipelineNotification
    - If $SlackEnabled is $false in config.ps1 → do nothing (no-op)
    - If $SlackThread is non-empty → post as a reply to that thread
    - If $SlackThread is empty → post as a new top-level message to $SlackChannel
    - Format messages with Slack Block Kit for rich formatting

  Test-SlackApproval
    - If $SlackEnabled is $false → return $false
    - Read thread replies for $SlackThread via Slack API
    - Return $true if any reply from the authorized user contains "approved"

### 2. slack-poller.ps1 (inbound — new script)
  - Runs as a second scheduled task alongside the watcher
  - Polls $SlackChannel every $SlackPollInterval seconds
  - Tracks last-seen message timestamp to avoid reprocessing
  - For each new message from the authorized user:
    a. Call claude -p with prompt-parse-slack.md to extract task metadata
    b. Generate a task slug from timestamp + inferred title
    c. Write the .task file to 00-inbox\{slug}.task
    d. Post a thread opener back to Slack:
       "Got it — task '{title}' has entered the pipeline."
       "Stages: research → spec → impl | I'll update you here."

## Token Requirements
Depending on how Slack integration is set up, you will need one of:
  - User OAuth token (xoxp-...) with scopes: channels:history, chat:write
  - Bot token (xoxb-...) with scopes: channels:history, chat:write, channels:read
  - If using Claude's Slack MCP: verify which API methods it exposes before implementing

## Interface Contract (DO NOT CHANGE these signatures)
The core pipeline depends on these exact function signatures in slack-notify.ps1.
You can change the implementation body but never the parameter names or types.

  function Send-PipelineNotification {
      param([string]$TaskId, [string]$TaskTitle, [string]$Stage,
            [string]$Status, [string]$Message, [string]$SlackThread,
            [hashtable]$Links = @{})
  }

  function Test-SlackApproval {
      param([string]$SlackThread)
      # Must return [bool]
  }
```

### `modules/slack/slack-notify.ps1` (Stub — ships with core pipeline)

```powershell
# slack-notify.ps1 — STUB
# Replace this file with the real implementation when Slack is set up.
# DO NOT change function signatures.

. $ConfigPath  # Access $SlackEnabled

function Send-PipelineNotification {
    param(
        [string]$TaskId, [string]$TaskTitle, [string]$Stage,
        [string]$Status, [string]$Message, [string]$SlackThread,
        [hashtable]$Links = @{}
    )
    # No-op stub — Slack not yet configured
    if (-not $SlackEnabled) { return }
    Write-Host "  [Slack stub] Would post: $Message" -ForegroundColor DarkGray
}

function Test-SlackApproval {
    param([string]$SlackThread)
    # No-op stub — always returns false
    return $false
}
```

---

## Part 6: Dashboard (`agent-dashboard` repo)

### `data/status.json`
```json
[]
```

### Dashboard UI Spec (for `index.html`)

Hand this spec to Claude Code to build the dashboard:

```
Build a single self-contained index.html with no external dependencies and no build step.
All CSS and JS inline or in the same file. Must work when served by GitHub Pages.

DATA
- On load and every 30 seconds: fetch('./data/status.json')
- Derive current state per task: latest event where id matches (sort by timestamp desc)
- Full history per task: all events with that id (sorted asc for timeline view)

LAYOUT
Two views, toggled by tab buttons in the header:

VIEW 1 — KANBAN
Seven columns in this order:
  Queued | Research | Spec | Review | Impl | Complete | Failed

Each task card shows:
  - Task title (bold)
  - Task ID (small, muted)
  - Time since last update (e.g. "3 min ago")
  - Status badge: color-coded dot
    in_progress=blue, review_needed=orange, complete=green, failed=red, blocked=yellow, queued=gray

Clicking a card opens the Detail Panel.

VIEW 2 — LIST
All tasks sorted by most recent event, newest first.
Each row: status dot | title | current stage | last updated | links (ADO, PR if present)
Clicking a row opens the Detail Panel.

DETAIL PANEL
Slide-in panel from the right (or modal on mobile).
Shows:
  - Title (large)
  - Current status badge
  - Links row: ADO | PR | Research | Spec | Impl (show only if link exists in latest event)
  - Event timeline: all events for this task, oldest first
    Each event: timestamp | stage badge | agent name | message
  - Close button (X)

HEADER
  - Left: "Agent Pipeline" title
  - Center: summary counts — Active: N | Complete: N | Failed: N | Review: N
  - Right: "Last updated: HH:MM:SS" (updates on each poll)

STYLE
  - Dark theme (#0d1117 background, like GitHub dark)
  - Monospace for IDs and timestamps
  - Clean card shadows
  - Fully responsive — readable on mobile
  - No emoji in code, use Unicode or SVG icons
```

---

## Part 7: Implementation Order for Claude Code

Create a new folder. Put this plan file in it. Open Claude Code in that folder.
Give Claude Code the following instruction verbatim:

```
Read PIPELINE-PLAN.md in full before writing any files.

Implement in this exact order. Do not ask for confirmation between files.

CORE PIPELINE (implement first — works without Slack)
1.  config.ps1                              (with placeholder values clearly marked)
2.  setup-pipeline.ps1
3.  modules\slack\slack-notify.ps1         (stub only — per Part 5)
4.  pipeline-watcher.ps1
5.  templates\prompt-research.md
6.  templates\prompt-spec.md
7.  templates\prompt-impl.md
8.  templates\prompt-parse-slack.md
9.  templates\task.template.md             (a filled-in example task)

SLACK MODULE SPEC (implement second — documentation only, no working code yet)
10. modules\slack\SLACK-MODULE.md

DASHBOARD REPO (implement third — separate folder named agent-dashboard)
11. agent-dashboard\data\status.json       (empty array)
12. agent-dashboard\index.html             (full dashboard per Part 6 spec)
13. agent-dashboard\README.md              (GitHub Pages setup instructions)

PIPELINE REPO ROOT
14. README.md                              (overview, setup steps, usage examples)

After all files are created, output a final checklist of manual steps the user
must complete before the pipeline is live. Be specific about each step.
```

---

## Part 8: Go-Live Checklist

After Claude Code generates all files, complete these steps in order:

**One-time GitHub setup**
- [ ] Create `agent-dashboard` repo on GitHub (public or private)
- [ ] Enable GitHub Pages: Settings → Pages → Source: Deploy from branch → `main` → `/ (root)`
- [ ] Push the generated `agent-dashboard\` folder as the initial commit
- [ ] Note the Pages URL: `https://{your-org}.github.io/agent-dashboard`

**Config**
- [ ] Open `config.ps1` and fill in every `YOUR_ORG` / `YOUR_PATH` placeholder
- [ ] Set `$PipelineRoot` — run `echo %OneDriveCommercial%` in CMD to find your OneDrive path
- [ ] Set `$DashboardRepoUrl` to your new `agent-dashboard` repo URL

**MCPs**
- [ ] Open `%USERPROFILE%\.claude\settings.json`
- [ ] Confirm these MCP servers are configured: `ado`, `github`, `notion`
- [ ] Test: open Claude Code, type `/mcp`, verify all three show as connected

**Install**
- [ ] Run `.\setup-pipeline.ps1` from the pipeline scripts folder
- [ ] Clone dashboard repo: `git clone {url} C:\Agents\agent-dashboard`
- [ ] Reboot, or open Task Scheduler and manually start `ClaudeAgentPipeline`

**Smoke test**
- [ ] Copy `templates\task.template.md`, fill it in, save as `test-task.task` in `00-inbox\`
- [ ] Watch `logs\test-task.log` — should see INBOX → RESEARCH entries appear
- [ ] Visit `https://{your-org}.github.io/agent-dashboard` — task card should appear
- [ ] Confirm research output lands in `01-research\done\`

**Slack (do later — when integration is confirmed)**
- [ ] Set up Slack workspace connection (see `modules\slack\SLACK-MODULE.md`)
- [ ] Set `$SlackEnabled = $true` in `config.ps1`
- [ ] Implement `modules\slack\slack-notify.ps1` (replace stub)
- [ ] Create and register `modules\slack\slack-poller.ps1` as a second scheduled task
- [ ] Test: type a task in `#agent-pipeline`, confirm `.task` file appears in `00-inbox\`
