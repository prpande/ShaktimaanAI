# Claude Agent Pipeline — Orchestrator, Config & Self-Update Addendum
**Extends:** PIPELINE-PLAN.md + PIPELINE-HISTORY-ADDENDUM.md
**Replaces:** The pipeline-watcher.ps1 scheduled task entirely.

---

## Design Decisions

| Decision | Choice |
|---|---|
| Orchestrator relationship | Replaces pipeline-watcher.ps1 as the single top-level persistent process |
| Input sources | FileSystemWatcher (inbox/review) + Slack poller + scheduled internal triggers |
| Intent classification | Hybrid — keywords for known intents, claude -p only for ambiguous freeform input |
| Agent lifecycle | Persistent: orchestrator only. Ephemeral: everything else (pipeline tasks, sync, config update, rollup, improve, notion push) |
| Orchestrator responsibility | Full — spawn, monitor, retry once, report, kill on second failure |
| Stall detection | Both — hard time cap per agent type AND heartbeat (no output in N minutes) |
| Concurrency | Parallel with cap — max 3 concurrent ephemeral agents |
| Agent registry | Local agent-registry.json (fast reads) + dashboard events (visibility) |
| Config format | Three layers: pipeline.config.json (committed, non-secrets) + .env (gitignored, secrets) + PIPELINE.md (human+agent readable context) |
| Repo registry | Root folder + explicit aliases for non-standard names |
| Config updates | Via Slack message, .config-update trigger file, or manual edit — all handled as ephemeral agents |
| Self-update | Daily 6 AM + startup + on-demand. VERSION tracked, logged to history.json |
| Self-improve | Prompts only, through review gate. Agents write retrospectives, improve-agent proposes PRs |

---

## Part 1: Revised Architecture

### What Changes From Previous Plans

`pipeline-watcher.ps1` is **retired**. Its scheduled task is replaced by `orchestrator.ps1`.

All previously separate scheduled tasks (daily-rollup, friday-notion-push, monthly-report,
agent-sync) are **removed from Task Scheduler**. Instead, the orchestrator manages them
internally via a timer loop — it wakes up at the right times and spawns ephemeral agents.

This means **one scheduled task** registers in Windows at startup:

```
ClaudeAgentOrchestrator  →  orchestrator.ps1  (run at logon, no timeout)
```

Everything else is spawned and managed by the orchestrator.

### Full Architecture

```
Windows Task Scheduler
        │  (at logon, one task only)
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  orchestrator.ps1  (persistent, single process)                 │
│                                                                  │
│  Input sources (all checked every 5 seconds):                   │
│  ├── FileSystemWatcher: 00-inbox\*.task                         │
│  ├── FileSystemWatcher: 00-inbox\*.trigger  (all trigger types) │
│  ├── FileSystemWatcher: 06-review\*.task    (approvals)         │
│  ├── Slack poller: #agent-pipeline messages  (when enabled)     │
│  └── Internal timer: scheduled jobs (rollup, sync, monthly)     │
│                                                                  │
│  Intent classifier:                                              │
│  ├── Known triggers → direct dispatch (no LLM call)            │
│  └── Freeform text  → claude -p classify → dispatch            │
│                                                                  │
│  Agent registry (agent-registry.json):                          │
│  ├── Track: agent type, PID, start time, last heartbeat         │
│  ├── Monitor: heartbeat timeout + hard time cap                 │
│  ├── On stall: retry once → kill + notify + move to failed     │
│  └── Concurrency cap: max 3 simultaneous ephemeral agents       │
└─────────────────────────────────────────────────────────────────┘
        │
        │  Spawns ephemeral agents (Start-Job / Start-Process)
        ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ pipeline     │  │ agent-sync   │  │ config-update │
│ task agent   │  │ (ephemeral)  │  │ (ephemeral)   │
│ (ephemeral)  │  └──────────────┘  └──────────────┘
└──────────────┘
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ daily-rollup │  │ notion-push  │  │ improve-agent │
│ (ephemeral)  │  │ (ephemeral)  │  │ (ephemeral)   │
└──────────────┘  └──────────────┘  └──────────────┘
        │
        ▼
agent-registry.json        ← Local fast-read registry
data/status.json           ← Dashboard visibility (pushed to GitHub)
```

---

## Part 2: Config System

### Three-Layer Config

```
agent-pipeline-scripts\          ← GitHub repo (committed)
├── pipeline.config.json          ← All non-secret settings. Versioned.
├── PIPELINE.md                   ← Human + agent readable context. Injected into prompts.
├── .env.example                  ← Documents every secret key. Never has real values.
└── ...scripts, templates, etc.

{ONEDRIVE_ROOT}\agent-pipeline\  ← OneDrive (never committed)
└── .env                          ← Real secret values. Gitignored at repo level.
```

### `pipeline.config.json`

```json
{
  "config_version": "1.0",
  "last_updated": "2026-04-04T00:00:00Z",

  "pipeline": {
    "root": "%OneDriveCommercial%\\agent-pipeline",
    "dashboard_repo_local": "C:\\Agents\\agent-dashboard",
    "dashboard_repo_url": "https://github.com/YOUR_ORG/agent-dashboard",
    "scripts_repo_local": "C:\\Agents\\agent-pipeline-scripts",
    "scripts_repo_url": "https://github.com/YOUR_ORG/agent-pipeline-scripts"
  },

  "repos": {
    "root": "C:\\Code",
    "aliases": {
      "businessapp":   "C:\\Code\\mindbody-businessapp",
      "tasktracker":   "C:\\Code\\ado-task-tracker",
      "chatbot":       "C:\\Code\\mindbody-chatbot"
    }
  },

  "ado": {
    "org":             "https://dev.azure.com/mindbody",
    "project":         "MBScrum",
    "default_area":    "BusinessApp",
    "default_assignee": "me"
  },

  "slack": {
    "enabled":         false,
    "channel":         "#agent-pipeline",
    "channel_id":      "",
    "poll_interval_seconds": 30
  },

  "agents": {
    "defaults": {
      "stages":        ["research", "spec", "impl"],
      "review_after":  "spec",
      "effort_level":  "high"
    },
    "max_turns": {
      "research":      30,
      "spec":          20,
      "impl":          60,
      "classify":      5,
      "config_update": 10,
      "improve":       40,
      "sync":          10
    },
    "timeouts_minutes": {
      "research":      45,
      "spec":          30,
      "impl":          90,
      "classify":      2,
      "config_update": 5,
      "improve":       60,
      "sync":          10,
      "rollup":        15,
      "notion_push":   10
    },
    "heartbeat_timeout_minutes": 10,
    "max_concurrent":  3,
    "retry_count":     1
  },

  "schedule": {
    "sync_time":       "06:00",
    "rollup_time":     "23:55",
    "notion_push_day": "Friday",
    "notion_push_time":"18:00",
    "monthly_report_day": 1,
    "monthly_report_time":"08:00"
  },

  "notifications": {
    "slack_on_complete":  true,
    "slack_on_failure":   true,
    "slack_on_sync":      true,
    "slack_on_review":    true
  },

  "versioning": {
    "current": "1.0.0",
    "log_syncs_to_history": true
  }
}
```

### `.env` (OneDrive only — never committed)

```ini
# Secrets — never commit this file
ADO_PAT=your-ado-personal-access-token
GITHUB_PAT=your-github-personal-access-token
SLACK_TOKEN=xoxp-your-slack-user-token
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
ANTHROPIC_API_KEY=sk-ant-your-key-if-needed
```

### `.env.example` (committed — documents keys, no values)

```ini
# Copy this to {PIPELINE_ROOT}\.env and fill in real values
ADO_PAT=
GITHUB_PAT=
SLACK_TOKEN=
SLACK_WEBHOOK_URL=
ANTHROPIC_API_KEY=
```

### `PIPELINE.md`

Injected at the top of every agent prompt at runtime. Gives agents
environment context without them needing to parse JSON.

```markdown
# Pipeline Environment Context

## Who I am working for
Developer: Pratyush
Team: MindBody BusinessApp
ADO Project: MBScrum (https://dev.azure.com/mindbody)
GitHub Org: YOUR_ORG

## Repositories
| Alias | Path | Purpose |
|---|---|---|
| businessapp | C:\Code\mindbody-businessapp | Main MindBody .NET backend |
| tasktracker | C:\Code\ado-task-tracker | ADO sync tool |
| chatbot | C:\Code\mindbody-chatbot | AI appointment chatbot |

When a task mentions a repo by alias or by recognisable name, resolve it
to the full path above. If no repo is specified and the task involves code,
default to businessapp.

## Stack Conventions
- Backend: .NET 8 / C#
- Build: dotnet build ./src/*.sln
- Test: dotnet test ./tests/ --no-build
- Branch naming: agent/{task-slug}
- Commit prefix: feat(agent): / fix(agent): / docs(agent):
- Never touch auth/login code without flagging for Identity team review
- Never hardcode site IDs, API keys, or credentials

## ADO Conventions
- Default area path: BusinessApp
- PBI naming: [Area] [Component] Short description
- Always link GitHub PRs to ADO work items
- Severity: 1=Critical, 2=High, 3=Medium, 4=Low

## Pipeline Folders
- Drop tasks: {PIPELINE_ROOT}\00-inbox\
- Review gates: {PIPELINE_ROOT}\06-review\
- Completed work: {PIPELINE_ROOT}\04-complete\

## What I should always do
- Read CLAUDE.md in the target repo before writing any code
- Check for existing patterns before introducing new ones
- Run build and tests before declaring implementation complete
- Update the ADO item state when opening a PR
```

### Config Loader (`scripts\load-config.ps1`)

Sourced by every script. Replaces the old `config.ps1` pattern.

```powershell
# load-config.ps1
# Sourced by all scripts. Loads pipeline.config.json + .env.
# Usage: . .\scripts\load-config.ps1

param([string]$ConfigDir = $PSScriptRoot\..)

# 1. Load pipeline.config.json
$ConfigFile = "$ConfigDir\pipeline.config.json"
if (-not (Test-Path $ConfigFile)) {
    throw "pipeline.config.json not found at $ConfigFile"
}
$Config = Get-Content $ConfigFile -Raw | ConvertFrom-Json

# 2. Expand environment variables in paths
function Expand-ConfigPath([string]$Path) {
    [System.Environment]::ExpandEnvironmentVariables($Path)
}

# 3. Resolve frequently used paths into flat variables (convenience)
$PipelineRoot    = Expand-ConfigPath $Config.pipeline.root
$DashboardRepo   = $Config.pipeline.dashboard_repo_local
$ScriptsRepo     = $Config.pipeline.scripts_repo_local
$AdoOrg          = $Config.ado.org
$AdoProject      = $Config.ado.project
$AdoArea         = $Config.ado.default_area
$SlackEnabled    = $Config.slack.enabled
$SlackChannel    = $Config.slack.channel
$SlackChannelId  = $Config.slack.channel_id
$SlackPollSecs   = $Config.slack.poll_interval_seconds
$MaxConcurrent   = $Config.agents.max_concurrent
$RetryCount      = $Config.agents.retry_count
$HeartbeatMins   = $Config.agents.heartbeat_timeout_minutes

# 4. Load .env secrets from OneDrive pipeline root
$EnvFile = "$PipelineRoot\.env"
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | Where-Object { $_ -match '^\s*[^#].+=.' } | ForEach-Object {
        $Parts = $_ -split '=', 2
        [System.Environment]::SetEnvironmentVariable($Parts[0].Trim(), $Parts[1].Trim())
    }
} else {
    Write-Host "  [Config] Warning: .env not found at $EnvFile — secrets not loaded"
}

# 5. Build repo alias lookup table
$RepoAliases = @{}
$Config.repos.aliases.PSObject.Properties | ForEach-Object {
    $RepoAliases[$_.Name] = $_.Value
}
$ReposRoot = $Config.repos.root

# 6. Helper: resolve repo alias or path
function Resolve-Repo([string]$Input) {
    if (-not $Input) { return "" }
    # Exact alias match
    if ($RepoAliases.ContainsKey($Input.ToLower())) {
        return $RepoAliases[$Input.ToLower()]
    }
    # Full path given — return as-is
    if (Test-Path $Input) { return $Input }
    # Try fuzzy match under repos root
    $Match = Get-ChildItem $ReposRoot -Directory |
             Where-Object { $_.Name -like "*$Input*" } |
             Select-Object -First 1
    if ($Match) { return $Match.FullName }
    return ""
}

# 7. Load PIPELINE.md for agent prompt injection
$PipelineMd = ""
$PipelineMdPath = "$ScriptsRepo\PIPELINE.md"
if (Test-Path $PipelineMdPath) {
    $PipelineMd = Get-Content $PipelineMdPath -Raw
    # Expand any {PIPELINE_ROOT} placeholders in PIPELINE.md
    $PipelineMd = $PipelineMd -replace '\{PIPELINE_ROOT\}', $PipelineRoot
}

Write-Host "  [Config] Loaded v$($Config.config_version) — pipeline v$($Config.versioning.current)"
```

---

## Part 3: Intent Classification

The orchestrator classifies every incoming input before deciding what agent to spawn.
Hybrid approach: fast keyword matching first, LLM only for ambiguous freeform.

### Known Intents (keyword dispatch — no LLM call)

| Input pattern | Intent | Agent spawned |
|---|---|---|
| `*.task` file | `pipeline_task` | Research → Spec → Impl chain |
| `*.push-notion` file | `notion_push` | notion-push.ps1 |
| `*.update` file | `agent_sync` | agent-sync.ps1 |
| `*.improve` file | `improve` | improve-agent.ps1 |
| `*.config-update` file | `config_update` | config-update-agent.ps1 |
| Slack: "sync agents" | `agent_sync` | agent-sync.ps1 |
| Slack: "sync config" | `config_update` | config-update-agent.ps1 |
| Slack: "improve agents" | `improve` | improve-agent.ps1 |
| Slack: "push to notion" | `notion_push` | notion-push.ps1 |
| Slack: "approved" (thread reply) | `approval` | Resume pipeline task |
| Internal timer: rollup time | `daily_rollup` | daily-rollup.ps1 |
| Internal timer: notion push day | `notion_push` | notion-push.ps1 |
| Internal timer: sync time | `agent_sync` | agent-sync.ps1 |
| Internal timer: monthly day | `monthly_report` | monthly-report.ps1 |

### Freeform Classification Prompt (used only when no keyword matches)

```
You are the intent classifier for a development pipeline orchestrator.
Classify the following input into exactly one intent.

Input: {{INPUT}}

Valid intents and when to use them:
- pipeline_task    : a development task, feature, bug fix, research, or doc request
- agent_sync       : request to update/sync the pipeline scripts from GitHub
- config_update    : request to change a pipeline configuration setting
- notion_push      : request to push a summary to Notion
- improve          : request to analyse agent performance and propose improvements
- unknown          : cannot be classified with confidence

Reply with ONLY a JSON object:
{ "intent": "pipeline_task", "confidence": 0.95, "reason": "one sentence" }
```

If `confidence < 0.7` → orchestrator posts to Slack asking for clarification.
If `intent = unknown` → orchestrator posts to Slack: "I didn't understand that — please use a trigger file or a known command."

---

## Part 4: orchestrator.ps1

Replaces pipeline-watcher.ps1. Single persistent process.

```powershell
# orchestrator.ps1
# The single top-level persistent process for the Claude Agent Pipeline.
# Replaces pipeline-watcher.ps1.
# Registered as: ClaudeAgentOrchestrator (run at logon, no timeout)

param([string]$ConfigDir = $PSScriptRoot\..)
. "$PSScriptRoot\load-config.ps1" -ConfigDir $ConfigDir
. "$PSScriptRoot\..\modules\slack\slack-notify.ps1"

# ════════════════════════════════════════════════════════
# AGENT REGISTRY
# ════════════════════════════════════════════════════════

$RegistryFile = "$PipelineRoot\agent-registry.json"

function Get-Registry {
    if (Test-Path $RegistryFile) {
        return (Get-Content $RegistryFile -Raw | ConvertFrom-Json) |
               ForEach-Object { $_ }  # ensure array
    }
    return @()
}

function Set-Registry([array]$Agents) {
    $Agents | ConvertTo-Json -Depth 5 | Set-Content $RegistryFile -Encoding UTF8
}

function Register-Agent {
    param([string]$AgentId, [string]$AgentType, [string]$TaskSlug,
          [int]$JobId, [string]$Description)
    $Registry = [System.Collections.ArrayList]@(Get-Registry)
    $Entry = [ordered]@{
        agent_id      = $AgentId
        agent_type    = $AgentType
        task_slug     = $TaskSlug
        job_id        = $JobId
        description   = $Description
        started_at    = (Get-Date -Format "o")
        last_heartbeat= (Get-Date -Format "o")
        retry_count   = 0
        status        = "running"
    }
    $Registry.Add((New-Object PSObject -Property $Entry)) | Out-Null
    Set-Registry @($Registry)
    Write-Log "ORCH" "Agent registered: $AgentId ($AgentType)"
}

function Update-Heartbeat([string]$AgentId) {
    $Registry = Get-Registry
    $Registry | Where-Object { $_.agent_id -eq $AgentId } |
        ForEach-Object { $_.last_heartbeat = (Get-Date -Format "o") }
    Set-Registry $Registry
}

function Remove-Agent([string]$AgentId) {
    $Registry = @(Get-Registry | Where-Object { $_.agent_id -ne $AgentId })
    Set-Registry $Registry
}

function Get-RunningCount {
    return @(Get-Registry | Where-Object { $_.status -eq "running" }).Count
}

# ════════════════════════════════════════════════════════
# HELPERS
# ════════════════════════════════════════════════════════

function Write-Log {
    param([string]$Component, [string]$Message)
    $Line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [$Component] $Message"
    Write-Host $Line
    Add-Content "$PipelineRoot\logs\orchestrator.log" $Line -Encoding UTF8
}

function Push-OrchestratorEvent {
    param([string]$AgentId, [string]$AgentType, [string]$Status, [string]$Message)
    # Appends to dashboard status.json — reuses Push-DashboardEvent from history-writer
    . "$PSScriptRoot\history-writer.ps1"
    Push-DashboardEvent `
        -Id        $AgentId `
        -Title     "$AgentType — $Message" `
        -Stage     $AgentType `
        -Status    $Status `
        -Agent     "orchestrator" `
        -Msg       $Message
}

# ════════════════════════════════════════════════════════
# INTENT CLASSIFICATION
# ════════════════════════════════════════════════════════

function Get-Intent {
    param([string]$Input, [string]$SourceType)  # SourceType: file | slack

    # Keyword dispatch — no LLM call
    $Lower = $Input.ToLower().Trim()
    if ($SourceType -eq "file") {
        switch -Wildcard ($Lower) {
            "*.task"          { return "pipeline_task" }
            "*.push-notion"   { return "notion_push" }
            "*.update"        { return "agent_sync" }
            "*.improve"       { return "improve" }
            "*.config-update" { return "config_update" }
        }
    }
    if ($SourceType -eq "slack") {
        if ($Lower -match '^sync agents?$')        { return "agent_sync" }
        if ($Lower -match '^sync config$')         { return "config_update" }
        if ($Lower -match '^improve agents?$')     { return "improve" }
        if ($Lower -match '^push.*(to )?notion$')  { return "notion_push" }
        if ($Lower -match '^approved?\.?$')        { return "approval" }
    }

    # Freeform — call claude -p classifier
    $Prompt = Get-Content "$ScriptsRepo\templates\prompt-classify.md" -Raw
    $Prompt = $Prompt -replace '\{\{INPUT\}\}', $Input
    $Result = $Prompt | claude -p `
        --max-turns $Config.agents.max_turns.classify `
        --output-format text 2>&1
    try {
        $Parsed = ($Result -replace '```json|```','').Trim() | ConvertFrom-Json
        if ($Parsed.confidence -ge 0.7) { return $Parsed.intent }
        return "unclear:$($Parsed.reason)"
    } catch {
        return "unknown"
    }
}

# ════════════════════════════════════════════════════════
# AGENT SPAWNER
# ════════════════════════════════════════════════════════

function Invoke-EphemeralAgent {
    param(
        [string]$AgentType,
        [string]$TaskSlug,
        [string]$Description,
        [scriptblock]$AgentBlock
    )

    # Concurrency cap check
    if ((Get-RunningCount) -ge $MaxConcurrent) {
        Write-Log "ORCH" "Concurrency cap ($MaxConcurrent) reached — queuing $AgentType"
        # Simple queue: write back to inbox with a short delay marker
        # In a full implementation this would be a proper queue file
        Start-Sleep -Seconds 30
        if ((Get-RunningCount) -ge $MaxConcurrent) {
            Write-Log "ORCH" "Still at cap after wait — dropping $AgentType to retry"
            return
        }
    }

    $AgentId  = "$AgentType-$(Get-Date -Format 'yyyyMMdd-HHmm')-$(Get-Random -Max 999)"
    $TimeoutMins = $Config.agents.timeouts_minutes.$AgentType
    if (-not $TimeoutMins) { $TimeoutMins = 30 }

    Write-Log "ORCH" "Spawning $AgentType | $AgentId | timeout: ${TimeoutMins}m"

    $Job = Start-Job -ScriptBlock $AgentBlock -ArgumentList $AgentId, $ConfigDir
    Register-Agent $AgentId $AgentType $TaskSlug $Job.Id $Description
    Push-OrchestratorEvent $AgentId $AgentType "in_progress" "Agent spawned: $Description"

    # Monitor in background
    $MonitorBlock = {
        param($JobRef, $AgentId, $TimeoutMins, $HeartbeatMins,
              $RegistryFile, $LogFile, $RetryCount, $AgentBlock, $ConfigDir)

        $Deadline  = (Get-Date).AddMinutes($TimeoutMins)
        $LastCheck = Get-Date

        while ($JobRef.State -eq "Running") {
            Start-Sleep -Seconds 30

            # Heartbeat check
            if (Test-Path $RegistryFile) {
                $Reg    = (Get-Content $RegistryFile -Raw | ConvertFrom-Json) |
                          Where-Object { $_.agent_id -eq $AgentId }
                $HbAge  = ((Get-Date) - [datetime]$Reg.last_heartbeat).TotalMinutes
                $Stalled = $HbAge -gt $HeartbeatMins
            } else { $Stalled = $false }

            # Hard timeout check
            $TimedOut = (Get-Date) -gt $Deadline

            if ($Stalled -or $TimedOut) {
                $Reason = if ($TimedOut) { "Exceeded ${TimeoutMins}m timeout" } else { "No heartbeat for ${HeartbeatMins}m" }
                Add-Content $LogFile "[$(Get-Date -Format 'HH:mm:ss')] [MONITOR] $AgentId stalled: $Reason"

                # Check retry count
                $Reg = (Get-Content $RegistryFile -Raw | ConvertFrom-Json) |
                       Where-Object { $_.agent_id -eq $AgentId }
                if ($Reg -and $Reg.retry_count -lt $RetryCount) {
                    Add-Content $LogFile "[$(Get-Date -Format 'HH:mm:ss')] [MONITOR] $AgentId retrying (attempt $($Reg.retry_count + 1))"
                    Stop-Job $JobRef -Force
                    $Reg.retry_count++
                    $Reg.status = "retrying"
                    # Re-spawn — simplified; full impl would re-invoke Invoke-EphemeralAgent
                    $NewJob = Start-Job -ScriptBlock $AgentBlock -ArgumentList $AgentId, $ConfigDir
                    $Reg.job_id = $NewJob.Id
                    $Reg.status = "running"
                    $Reg.started_at = (Get-Date -Format "o")
                    $Reg.last_heartbeat = (Get-Date -Format "o")
                    $Deadline = (Get-Date).AddMinutes($TimeoutMins)
                    Get-Content $RegistryFile -Raw | ConvertFrom-Json |
                        ForEach-Object { if ($_.agent_id -eq $AgentId) { $_ = $Reg } $_ } |
                        ConvertTo-Json -Depth 5 | Set-Content $RegistryFile -Encoding UTF8
                    $JobRef = $NewJob
                } else {
                    Add-Content $LogFile "[$(Get-Date -Format 'HH:mm:ss')] [MONITOR] $AgentId killed after $RetryCount retries"
                    Stop-Job $JobRef -Force
                    break
                }
            }
        }
    }

    Start-Job -ScriptBlock $MonitorBlock -ArgumentList `
        $Job, $AgentId, $TimeoutMins, $HeartbeatMins, `
        $RegistryFile, "$PipelineRoot\logs\orchestrator.log", `
        $RetryCount, $AgentBlock, $ConfigDir | Out-Null

    return $AgentId
}

# ════════════════════════════════════════════════════════
# DISPATCH — maps intents to agent blocks
# ════════════════════════════════════════════════════════

function Dispatch-Intent {
    param([string]$Intent, [string]$InputPath, [string]$InputContent,
          [string]$SlackThread = "")

    switch ($Intent) {

        "pipeline_task" {
            $Slug = [IO.Path]::GetFileNameWithoutExtension($InputPath)
            Invoke-EphemeralAgent "pipeline_task" $Slug "Pipeline task: $Slug" {
                param($AgentId, $ConfigDir)
                . "$ConfigDir\scripts\load-config.ps1" -ConfigDir $ConfigDir
                . "$ConfigDir\scripts\pipeline-stages.ps1"
                Invoke-PipelineTask $InputPath $Slug $AgentId
            }
        }

        "agent_sync" {
            Invoke-EphemeralAgent "sync" "" "Agent sync from GitHub" {
                param($AgentId, $ConfigDir)
                . "$ConfigDir\scripts\load-config.ps1" -ConfigDir $ConfigDir
                . "$ConfigDir\scripts\agent-sync.ps1"
                Invoke-AgentSync -AgentId $AgentId
            }
        }

        "config_update" {
            Invoke-EphemeralAgent "config_update" "" "Config update: $InputContent" {
                param($AgentId, $ConfigDir)
                . "$ConfigDir\scripts\load-config.ps1" -ConfigDir $ConfigDir
                . "$ConfigDir\scripts\config-update-agent.ps1"
                Invoke-ConfigUpdate -Instruction $InputContent -AgentId $AgentId
            }
        }

        "notion_push" {
            $Request = if ($InputPath -and (Test-Path $InputPath)) {
                (Get-Content $InputPath -Raw).Trim()
            } else { "this week" }
            Invoke-EphemeralAgent "notion_push" "" "Notion push: $Request" {
                param($AgentId, $ConfigDir)
                . "$ConfigDir\scripts\load-config.ps1" -ConfigDir $ConfigDir
                . "$ConfigDir\scripts\notion-push.ps1"
                Invoke-AdHocNotionPush -Request $Request
            }
            if ($InputPath -and (Test-Path $InputPath)) { Remove-Item $InputPath -Force }
        }

        "improve" {
            Invoke-EphemeralAgent "improve" "" "Improve agent prompts" {
                param($AgentId, $ConfigDir)
                . "$ConfigDir\scripts\load-config.ps1" -ConfigDir $ConfigDir
                . "$ConfigDir\scripts\improve-agent.ps1"
                Invoke-ImproveAgent -AgentId $AgentId
            }
        }

        "daily_rollup" {
            Invoke-EphemeralAgent "rollup" "" "Daily rollup" {
                param($AgentId, $ConfigDir)
                . "$ConfigDir\scripts\load-config.ps1" -ConfigDir $ConfigDir
                . "$ConfigDir\scripts\daily-rollup.ps1"
            }
        }

        "monthly_report" {
            Invoke-EphemeralAgent "monthly_report" "" "Monthly report" {
                param($AgentId, $ConfigDir)
                . "$ConfigDir\scripts\load-config.ps1" -ConfigDir $ConfigDir
                . "$ConfigDir\scripts\monthly-report.ps1"
            }
        }

        "approval" {
            # Find the task in 06-review that this thread belongs to
            $ReviewFile = Get-ChildItem "$PipelineRoot\06-review\*.task" |
                Where-Object {
                    (Get-Content $_.FullName -Raw) -match [regex]::Escape($SlackThread)
                } | Select-Object -First 1
            if ($ReviewFile) {
                $Content = Get-Content $ReviewFile.FullName -Raw
                if ($Content -notmatch "approved:\s*true") {
                    ("`napproved: true") | Add-Content $ReviewFile.FullName -Encoding UTF8
                    Write-Log "ORCH" "Approval written to $($ReviewFile.Name)"
                }
            }
        }

        { $_ -like "unclear:*" } {
            $Reason = $Intent -replace "unclear:",""
            Send-PipelineNotification "" "" "orchestrator" "blocked" `
                "I wasn't sure what to do: $Reason. Please rephrase or use a trigger file." $SlackThread
        }

        default {
            Write-Log "ORCH" "Unknown intent '$Intent' — ignoring"
        }
    }
}

# ════════════════════════════════════════════════════════
# SCHEDULED TRIGGER CHECKER
# ════════════════════════════════════════════════════════

$LastSyncDate    = [datetime]::MinValue
$LastRollupDate  = [datetime]::MinValue
$LastNotionDate  = [datetime]::MinValue
$LastMonthlyDate = [datetime]::MinValue

function Check-ScheduledTriggers {
    $Now   = Get-Date
    $Sched = $Config.schedule

    # Sync — daily at configured time
    $SyncTime = [datetime]::Parse("$($Now.ToString('yyyy-MM-dd')) $($Sched.sync_time)")
    if ($Now -ge $SyncTime -and $LastSyncDate.Date -lt $Now.Date) {
        $Script:LastSyncDate = $Now
        Write-Log "ORCH" "Scheduled sync trigger"
        Dispatch-Intent "agent_sync" "" ""
    }

    # Rollup — daily at configured time
    $RollupTime = [datetime]::Parse("$($Now.ToString('yyyy-MM-dd')) $($Sched.rollup_time)")
    if ($Now -ge $RollupTime -and $LastRollupDate.Date -lt $Now.Date) {
        $Script:LastRollupDate = $Now
        Write-Log "ORCH" "Scheduled rollup trigger"
        Dispatch-Intent "daily_rollup" "" ""
    }

    # Notion push — configured day + time
    $NotionTime = [datetime]::Parse("$($Now.ToString('yyyy-MM-dd')) $($Sched.notion_push_time)")
    if ($Now.DayOfWeek.ToString() -eq $Sched.notion_push_day -and
        $Now -ge $NotionTime -and
        $LastNotionDate.Date -lt $Now.Date) {
        $Script:LastNotionDate = $Now
        Write-Log "ORCH" "Scheduled Notion push trigger"
        Dispatch-Intent "notion_push" "" "this week"
    }

    # Monthly report — configured day of month
    if ($Now.Day -eq $Sched.monthly_report_day) {
        $MonthlyTime = [datetime]::Parse("$($Now.ToString('yyyy-MM-dd')) $($Sched.monthly_report_time)")
        if ($Now -ge $MonthlyTime -and $LastMonthlyDate.Date -lt $Now.Date) {
            $Script:LastMonthlyDate = $Now
            Write-Log "ORCH" "Scheduled monthly report trigger"
            Dispatch-Intent "monthly_report" "" ""
        }
    }
}

# ════════════════════════════════════════════════════════
# STARTUP
# ════════════════════════════════════════════════════════

Write-Log "ORCH" "Orchestrator starting — pipeline v$($Config.versioning.current)"
Write-Log "ORCH" "Config: v$($Config.config_version) | Max concurrent: $MaxConcurrent"
Write-Log "ORCH" "Inbox: $PipelineRoot\00-inbox\"

# Run sync on startup
Dispatch-Intent "agent_sync" "" ""

# ════════════════════════════════════════════════════════
# FILE SYSTEM WATCHERS
# ════════════════════════════════════════════════════════

# Inbox — all trigger file types
$InboxWatcher        = New-Object System.IO.FileSystemWatcher
$InboxWatcher.Path   = "$PipelineRoot\00-inbox"
$InboxWatcher.Filter = "*.*"
$InboxWatcher.EnableRaisingEvents = $true
Register-ObjectEvent $InboxWatcher "Created" -Action {
    $File    = $Event.SourceEventArgs.FullPath
    $Ext     = [IO.Path]::GetExtension($File)
    $Content = if (Test-Path $File) { (Get-Content $File -Raw -Encoding UTF8).Trim() } else { "" }

    # Map extensions to intents directly where possible
    $KnownExts = @{
        ".task"          = "pipeline_task"
        ".push-notion"   = "notion_push"
        ".update"        = "agent_sync"
        ".improve"       = "improve"
        ".config-update" = "config_update"
    }

    $Intent = if ($KnownExts.ContainsKey($Ext)) {
        $KnownExts[$Ext]
    } else {
        Get-Intent $Content "file"
    }

    Write-Log "ORCH" "Inbox: $(Split-Path $File -Leaf) → $Intent"
    Dispatch-Intent $Intent $File $Content
}

# Review folder — approval detection
$ReviewWatcher           = New-Object System.IO.FileSystemWatcher
$ReviewWatcher.Path      = "$PipelineRoot\06-review"
$ReviewWatcher.Filter    = "*.task"
$ReviewWatcher.NotifyFilter = [System.IO.NotifyFilters]::LastWrite
$ReviewWatcher.EnableRaisingEvents = $true
Register-ObjectEvent $ReviewWatcher "Changed" -Action {
    $File    = $Event.SourceEventArgs.FullPath
    $Content = Get-Content $File -Raw -Encoding UTF8
    if ($Content -match "approved:\s*true") {
        Write-Log "ORCH" "Approval file detected: $(Split-Path $File -Leaf)"
        # Resume pipeline — delegates to pipeline-stages.ps1
        . "$ScriptsRepo\scripts\pipeline-stages.ps1"
        Resume-PipelineTask $File
    }
}

# ════════════════════════════════════════════════════════
# MAIN LOOP
# ════════════════════════════════════════════════════════

Write-Host "`nOrchestrator running. Press Ctrl+C to stop.`n" -ForegroundColor Cyan

while ($true) {
    # Check scheduled triggers
    Check-ScheduledTriggers

    # Clean up completed jobs from registry
    $Registry = Get-Registry
    foreach ($Agent in @($Registry | Where-Object { $_.status -eq "running" })) {
        $Job = Get-Job -Id $Agent.job_id -ErrorAction SilentlyContinue
        if ($Job -and $Job.State -ne "Running") {
            Write-Log "ORCH" "Agent completed: $($Agent.agent_id)"
            Remove-Agent $Agent.agent_id
            Remove-Job $Job -Force -ErrorAction SilentlyContinue
        }
        # Update heartbeat for running jobs (jobs write a heartbeat file)
        $HbFile = "$PipelineRoot\logs\heartbeat-$($Agent.agent_id).tmp"
        if (Test-Path $HbFile) {
            Update-Heartbeat $Agent.agent_id
            Remove-Item $HbFile -Force
        }
    }

    Start-Sleep -Seconds 5
}
```

---

## Part 5: `scripts/config-update-agent.ps1`

Ephemeral agent. Reads a natural language instruction and updates
`pipeline.config.json` accordingly, then commits to GitHub.

```powershell
# config-update-agent.ps1 — ephemeral, run via orchestrator

function Invoke-ConfigUpdate {
    param([string]$Instruction, [string]$AgentId)

    . "$ScriptsRepo\scripts\load-config.ps1"

    $CurrentConfig = Get-Content "$ScriptsRepo\pipeline.config.json" -Raw
    $PipelineMdContent = $PipelineMd  # loaded by load-config.ps1

    $Prompt = @"
$PipelineMdContent

You are a config update agent. Update pipeline.config.json based on this instruction:

INSTRUCTION: $Instruction

CURRENT CONFIG:
$CurrentConfig

Rules:
- Only modify fields that the instruction clearly refers to
- Never modify: versioning.current, config_version
- Never add or remove top-level sections
- Preserve all existing values not mentioned in the instruction
- If the instruction is ambiguous or could break the pipeline, output:
  CONFIG_UPDATE_REFUSED: {reason}
- Otherwise output the complete updated JSON only, no preamble, no fences

After updating the file at $ScriptsRepo\pipeline.config.json:
1. Set git user if needed: git config user.email "agent@pipeline"
2. git -C "$ScriptsRepo" add pipeline.config.json
3. git -C "$ScriptsRepo" commit -m "config: $Instruction [agent]"
4. git -C "$ScriptsRepo" push
"@

    $Result = $Prompt | claude -p `
        --allowedTools "Read,Write,Bash,mcp__github__*" `
        --max-turns $Config.agents.max_turns.config_update `
        --output-format text 2>&1

    if ($Result -match "CONFIG_UPDATE_REFUSED:(.+)") {
        $Reason = $Matches[1].Trim()
        Write-Host "  [Config Update] Refused: $Reason"
        Send-PipelineNotification $AgentId "" "config_update" "blocked" `
            "Config update refused: $Reason" ""
        return
    }

    # Reload config after update
    . "$ScriptsRepo\scripts\load-config.ps1" -ConfigDir $ScriptsRepo

    Send-PipelineNotification $AgentId "" "config_update" "complete" `
        "Config updated: $Instruction" ""
    Write-Host "  [Config Update] Done: $Instruction"
}
```

---

## Part 6: PIPELINE.md Template Injection

Every agent prompt now starts with PIPELINE.md content. Add this to the top
of all four prompt templates (`prompt-research.md`, `prompt-spec.md`,
`prompt-impl.md`, `prompt-parse-slack.md`):

```
{{PIPELINE_CONTEXT}}

═══════════════════════════════════════════
```

And in `load-config.ps1`, the `$PipelineMd` variable is already populated.
All prompt template substitutions should add this replacement:

```powershell
$Prompt = $Prompt -replace '\{\{PIPELINE_CONTEXT\}\}', $PipelineMd
```

This is handled in `pipeline-stages.ps1` (the refactored agent runner from
the original watcher's `Invoke-Agent` function).

---

## Part 7: Updated Folder & File List

### New files added by this addendum

```
agent-pipeline-scripts\
├── pipeline.config.json          ← Central non-secret config (NEW)
├── .env.example                  ← Secret keys documentation (NEW)
├── PIPELINE.md                   ← Agent context file (NEW)
├── VERSION                       ← "1.0.0" (NEW)
├── CHANGELOG.md                  ← (NEW)
│
├── scripts\
│   ├── load-config.ps1           ← Replaces config.ps1 (NEW)
│   ├── orchestrator.ps1          ← Replaces pipeline-watcher.ps1 (NEW)
│   ├── pipeline-stages.ps1       ← Extracted from watcher: Invoke-Agent,
│   │                                Invoke-ResearchAgent, Invoke-SpecAgent,
│   │                                Invoke-ImplAgent, Resume-PipelineTask (NEW)
│   ├── config-update-agent.ps1   ← Config update ephemeral agent (NEW)
│   ├── agent-sync.ps1            ← Self-update mechanism (NEW)
│   ├── improve-agent.ps1         ← Prompt improvement proposals (NEW)
│   ├── retrospective-writer.ps1  ← Per-task retrospective (NEW)
│   ├── history-writer.ps1        ← (existing, updated to use load-config)
│   ├── daily-rollup.ps1          ← (existing, updated — no longer scheduled task)
│   ├── monthly-report.ps1        ← (existing, updated)
│   └── notion-push.ps1           ← (existing, updated)
│
└── templates\
    ├── prompt-classify.md        ← Intent classification prompt (NEW)
    ├── prompt-research.md        ← Updated: adds {{PIPELINE_CONTEXT}}
    ├── prompt-spec.md            ← Updated: adds {{PIPELINE_CONTEXT}}
    ├── prompt-impl.md            ← Updated: adds {{PIPELINE_CONTEXT}}
    └── prompt-parse-slack.md     ← Updated: adds {{PIPELINE_CONTEXT}}
```

### Removed / Replaced

| Was | Replaced by |
|---|---|
| `pipeline-watcher.ps1` | `orchestrator.ps1` |
| `config.ps1` | `load-config.ps1` + `pipeline.config.json` + `.env` |
| Separate scheduled tasks for rollup/sync/notion/monthly | Internal timer in orchestrator |

### New OneDrive files

```
{PIPELINE_ROOT}\
├── .env                           ← Secrets (NEW, gitignored)
├── agent-registry.json            ← Live agent tracking (NEW, runtime-generated)
└── logs\
    ├── orchestrator.log           ← Persistent orchestrator log (NEW)
    └── heartbeat-{agent-id}.tmp  ← Short-lived heartbeat signals (NEW, auto-deleted)
```

---

## Part 8: Updated setup-pipeline.ps1 Changes

Replace all `Register-ScheduledTask` calls with a single one:

```powershell
# ONE scheduled task — everything else managed by orchestrator internally
$OrchestratorScript = "$ScriptDir\scripts\orchestrator.ps1"
$Action   = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NonInteractive -WindowStyle Hidden -File `"$OrchestratorScript`" -ConfigDir `"$ScriptDir`""
$Trigger  = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "ClaudeAgentOrchestrator" `
    -Action $Action -Trigger $Trigger -Settings $Settings `
    -Description "Claude Agent Pipeline Orchestrator" -Force | Out-Null
Write-Host "  Registered: ClaudeAgentOrchestrator (single task — manages all agents)"
```

---

## Part 9: Implementation Order for Claude Code

Append to the master instruction block after items 1–23:

```
ORCHESTRATOR, CONFIG & SELF-UPDATE
Read PIPELINE-ORCHESTRATOR-ADDENDUM.md in full before starting.
Implement after all history addendum files are complete.

24. pipeline.config.json                   (with YOUR_ORG placeholders)
25. .env.example
26. PIPELINE.md                            (filled in for Pratyush's environment)
27. VERSION                                (initial value: "1.0.0")
28. CHANGELOG.md                           (initial entry for v1.0.0)
29. scripts\load-config.ps1
30. scripts\pipeline-stages.ps1           (extract Invoke-Agent and all stage
                                            functions from pipeline-watcher.ps1)
31. scripts\orchestrator.ps1              (references pipeline-stages.ps1)
32. scripts\config-update-agent.ps1
33. scripts\agent-sync.ps1
34. scripts\improve-agent.ps1
35. scripts\retrospective-writer.ps1
36. templates\prompt-classify.md
37. Update all four prompt templates      (add {{PIPELINE_CONTEXT}} at top)
38. Update setup-pipeline.ps1             (single scheduled task only)
39. Update all existing scripts           (replace `. $ConfigPath` with
                                           `. "$PSScriptRoot\load-config.ps1"`)

After all 39 files, output the complete final go-live checklist.
```
