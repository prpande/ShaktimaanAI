# Agentic Development Upgrade Plan
**For: Pratyush | Stack: .NET/C#, MindBody BusinessApp, Azure DevOps, GitHub, Notion**
**Platform: Windows**

---

## First: Answering Your Core Question — Do You Need to Spawn CLI Sessions Separately?

**No.** You do NOT need a separate terminal/CLI session to run agents. Here is how it actually breaks down:

| Mode | How You Trigger It | Interaction |
|---|---|---|
| **Interactive Claude Code** | Open terminal → `claude` | You talk to it. Full session. |
| **Headless / Non-interactive** | `claude -p "your prompt"` from any shell | Fire and forget. Outputs to stdout. |
| **Scheduled Agents (Windows)** | PowerShell script with `claude -p` → Windows Task Scheduler | Fully autonomous. No human needed. |
| **Subagents** | Claude Code spawns them internally | You don't do anything — Claude does it when it decides the task warrants parallel work. |
| **Claude.ai (browser/app)** | Chat interface | Single-threaded. NOT suitable for true agentic / autonomous workflows. |

**Key insight:** The Claude Windows desktop app and claude.ai are chat interfaces — they are reactive tools. True agentic work requires Claude Code CLI, because only the CLI supports:
- `claude -p` headless/non-interactive execution
- Spawning subagents programmatically
- Being called from PowerShell scripts and Task Scheduler
- Piping output into other tools (ADO, Notion, GitHub APIs)

---

## Your Agentic Stack Architecture

```
┌─────────────────────────────────────────────────────────┐
│  ORCHESTRATION LAYER (Windows Task Scheduler / PS)      │
│  Runs: claude -p "..." --allowedTools "..."             │
└────────────────────┬────────────────────────────────────┘
                     │
        ┌────────────▼────────────┐
        │   CLAUDE CODE (Agent)   │
        │   Reads: CLAUDE.md      │
        │   Reads: AGENTS.md      │
        │   Uses: MCP Servers     │
        └────┬──────────┬─────────┘
             │          │
    ┌─────────▼──┐  ┌───▼──────────┐
    │ Subagent 1 │  │  Subagent 2  │   (Claude spawns these automatically)
    │ Code Layer │  │  Test Layer  │
    └─────────────┘  └──────────────┘
             │          │
    ┌─────────▼──────────▼─────────┐
    │         MCP SERVERS          │
    │  - Azure DevOps (ADO)        │
    │  - GitHub                    │
    │  - Notion (already wired)    │
    └──────────────────────────────┘
```

---

## Phase 1 — Foundation (Week 1–2)
**Goal:** Transform your repos from "dumb folders Claude reads" to "context-aware agent workspaces."

### 1.1 CLAUDE.md Per Repo

Every repo needs a `CLAUDE.md` at the root. This is Claude's persistent brain for that repo — it reads it every session. Without it, every session starts cold.

**For your MindBody BusinessApp repo:**

```markdown
# MindBody BusinessApp — Claude Context

## Stack
- .NET 8 / C# backend
- MindBody Public API v6 (base URL: https://api.mindbodyonline.com/public/v6)
- Azure DevOps project: MBScrum
- GitHub repo: [your repo name]

## Architecture Conventions
- Services in /src/Services — never put business logic in controllers
- All MindBody API calls go through MindBodyApiClient wrapper — never call raw HttpClient
- Auth handled by Identity team — do not touch Account/Login flow without Identity sign-off
- legacyauth clients (client IDs containing "Legacy") require special handling — flag for Identity team

## ADO Conventions  
- PBI naming: [Area] [Component] Short description
- Area paths: Security-Identity-Access-Management | BusinessApp | Platform
- Bug severity: 1=Critical/Production, 2=High, 3=Medium, 4=Low
- Always link GitHub PRs to ADO work items

## Build & Test
- Build: dotnet build ./src/MindBody.sln
- Test: dotnet test ./tests/ --no-build
- Always run tests before committing

## Do Not
- Do not commit directly to main — always branch
- Do not modify MindBody API client auth headers
- Do not hardcode site IDs or API keys — use config
```

**For your ADO Task Tracker repo:**

```markdown
# ADO Task Tracker — Claude Context

## Purpose
Syncs GitHub + Notion activity → Azure DevOps PBIs and tasks automatically.

## Architecture
- Orchestrator: PowerShell script (daily loop via Task Scheduler)
- GitHub source: GitHub API (PAT in env vars)
- Notion source: Notion MCP
- ADO destination: ADO MCP (project: MBScrum)

## Key Rules
- Always deduplicate before creating ADO items — check if work item exists first
- PBI parent required for all tasks — never create orphan tasks
- Date lookback window: configurable, default 24h
```

### 1.2 AGENTS.md (New — Agent-Specific Memory)

Create `AGENTS.md` alongside `CLAUDE.md`. This is for multi-agent coordination context — patterns that worked, cross-session learnings:

```markdown
# Agents Coordination Context

## Proven Patterns
- When fixing bugs: spawn one agent for root cause analysis, separate agent for fix implementation
- ADO sync: always read Notion first, then GitHub commits, then reconcile — order matters
- MindBody API changes: flag Identity team on any auth-related diffs before implementing

## Pitfalls to Avoid
- Do not let subagents both edit the same .csproj file — merge conflicts
- ADO rate limit: max 20 work item creates per minute

## Codebase Gotchas
- MindBodyApiClient uses a connection pool — don't dispose in using blocks
- Test project references require explicit package restores before build
```

---

## Phase 2 — Headless Agents (Week 2–3)
**Goal:** Run Claude autonomously from PowerShell. No interactive session needed.

### 2.1 How Headless Works on Windows

```powershell
# Basic headless call — runs Claude, prints output, exits
claude -p "Review the last commit in this repo for any issues" --output-format text

# With specific tool permissions
claude -p "Find all TODO comments and create ADO tasks for them" `
  --allowedTools "Read,Bash,mcp__ado__wit_create_work_item"

# Pipe git diff into Claude
git diff HEAD~1 HEAD | claude -p "Review this diff for breaking changes to MindBody API contracts"

# Capture output to file
claude -p "Generate a daily standup summary from today's GitHub activity" `
  --output-format text > C:\Users\Pratyush\standup-$(Get-Date -Format 'yyyyMMdd').txt
```

### 2.2 Daily ADO Sync Agent (Upgrade of Your Existing Tracker)

Save this as `C:\Agents\daily-ado-sync.ps1`:

```powershell
# daily-ado-sync.ps1
# Runs Claude headlessly to sync yesterday's GitHub + Notion activity to ADO

param(
    [string]$LookbackHours = "24",
    [string]$RepoPath = "C:\Code\mindbody-businessapp"
)

Set-Location $RepoPath

$LogFile = "C:\Agents\logs\ado-sync-$(Get-Date -Format 'yyyyMMdd-HHmm').log"
New-Item -ItemType Directory -Force -Path "C:\Agents\logs" | Out-Null

$Prompt = @"
You are running as an automated ADO sync agent.

Task: Review the last $LookbackHours hours of development activity and sync it to Azure DevOps.

Steps:
1. Use GitHub tools to get commits and PR activity from the last $LookbackHours hours for the current repo
2. Use Notion MCP to get any tasks or notes added in the last $LookbackHours hours  
3. For each meaningful unit of work found:
   - Check ADO (MBScrum project) if a PBI or task already exists for it
   - If not, create appropriate ADO work item (Task under relevant PBI, or new PBI if needed)
   - Link GitHub PR/commit to the ADO item if applicable
4. Output a summary of what was created/updated

Use the ADO area path: BusinessApp
Do not create duplicate items — always search first.
"@

Write-Host "Starting ADO sync agent at $(Get-Date)" | Tee-Object -FilePath $LogFile
claude -p $Prompt `
  --allowedTools "mcp__ado__*,mcp__github__*,mcp__notion__*,Read,Bash" `
  --output-format text 2>&1 | Tee-Object -FilePath $LogFile -Append

Write-Host "ADO sync complete. Log: $LogFile"
```

**Schedule it via Windows Task Scheduler:**

```powershell
# Run this once to register the scheduled task
$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NonInteractive -File C:\Agents\daily-ado-sync.ps1"

$Trigger = New-ScheduledTaskTrigger -Daily -At "6:00AM"

$Settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -RestartCount 1

Register-ScheduledTask `
  -TaskName "DailyADOSync" `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Description "Claude agent: sync GitHub + Notion to ADO daily"
```

---

## Phase 3 — MCP Server Wiring (Week 3–4)
**Goal:** Give agents real tools — not just file reading, but actual ADO/GitHub/Notion actions.

### Current MCP Status
- ✅ Notion — already connected
- ❌ Azure DevOps — need to add
- ❌ GitHub — need to add (separate from browser auth)

### 3.1 Add ADO MCP to Claude Code

Edit `%USERPROFILE%\.claude\settings.json`:

```json
{
  "effortLevel": "high",
  "mcpServers": {
    "ado": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-azure-devops"],
      "env": {
        "ADO_ORG_URL": "https://dev.azure.com/mindbody",
        "ADO_PAT": "YOUR_PAT_HERE",
        "ADO_DEFAULT_PROJECT": "MBScrum"
      }
    },
    "github": {
      "command": "npx", 
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "YOUR_GH_PAT_HERE"
      }
    }
  }
}
```

> **Note:** Check `https://code.claude.com` for the exact MCP server package names — the above are reference names that may have updated.

### 3.2 Verify MCPs Are Working

```powershell
# In interactive Claude Code session:
# Type: /mcp
# Should list: ado, github, notion as connected

# Test ADO read
claude -p "List the last 5 work items assigned to me in MBScrum" `
  --allowedTools "mcp__ado__*"
```

---

## Phase 4 — Multi-Agent Workflows (Month 2)
**Goal:** Complex tasks are broken into parallel workstreams that Claude coordinates automatically.

### How Subagents Work in Your Context

You do NOT manually spawn subagents. You describe a complex task to Claude Code, and it internally spawns `Task(...)` workers when it determines parallelism would help. You just see `Spawning subagent...` in the output.

**Example — tell Claude Code this in an interactive session:**

```
I need you to do a full audit of the MindBody appointment booking flow:
- One agent: analyze the C# service layer for any calls that don't match the v6 API contract
- One agent: check ADO for any open bugs related to appointment booking (area: BusinessApp)  
- One agent: review recent GitHub commits in the last 2 weeks touching appointment-related files
Synthesize all findings into a single prioritized report and create ADO tasks for any issues found.
```

Claude will internally coordinate these as parallel tasks and give you a unified result.

### Multi-Agent Headless Script (Advanced)

```powershell
# parallel-audit.ps1 — runs two headless Claude instances simultaneously

$Job1 = Start-Job -ScriptBlock {
    Set-Location "C:\Code\mindbody-businessapp"
    claude -p "Analyze all C# files touching MindBody API for contract violations. Output JSON list of issues." `
      --allowedTools "Read,Bash" `
      --output-format text
}

$Job2 = Start-Job -ScriptBlock {
    Set-Location "C:\Code\mindbody-businessapp"
    claude -p "Search ADO MBScrum for all open bugs in BusinessApp area with severity 1 or 2. Output JSON list." `
      --allowedTools "mcp__ado__*" `
      --output-format text
}

# Wait for both and collect results
$Results1 = $Job1 | Wait-Job | Receive-Job
$Results2 = $Job2 | Wait-Job | Receive-Job

# Feed both results to a synthesis agent
$Combined = "CODE ISSUES:`n$Results1`n`nADO BUGS:`n$Results2"
$SynthesisPrompt = "Given these parallel audit results, create a unified priority list and generate ADO tasks for any new issues not already tracked:`n$Combined"

$Combined | claude -p $SynthesisPrompt --allowedTools "mcp__ado__*,Read"
```

---

## Phase 5 — Hooks (Month 2)
**Goal:** Automate repetitive post-action steps so Claude triggers them, not you.

Add to `%USERPROFILE%\.claude\settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{
          "type": "command",
          "command": "cd /d %REPO_PATH% && dotnet build ./src/MindBody.sln --no-restore 2>&1 | tail -5"
        }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash(git commit:*)",
        "hooks": [{
          "type": "command",
          "command": "cd /d %REPO_PATH% && dotnet test ./tests/ --no-build --verbosity minimal"
        }]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [{
          "type": "command",
          "command": "echo Subagent completed at %TIME% >> C:\\Agents\\logs\\subagent-activity.log"
        }]
      }
    ]
  }
}
```

---

## Phase 6 — PR Review Agent (Month 2–3)
**Goal:** Automatic code review on every GitHub PR targeting your repos.

### GitHub Actions Workflow
Add `.github/workflows/claude-review.yml` to your repos:

```yaml
name: Claude Code Review
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  claude-review:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code

      - name: Run Claude Review
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          $Diff = git diff origin/main...HEAD
          $Review = $Diff | claude -p @"
          Review this PR diff for:
          1. Breaking changes to MindBody API contracts
          2. Any changes to auth/login flow that should involve Identity team
          3. Missing error handling on external API calls
          4. ADO work item linked in PR description (flag if missing)
          Output structured feedback with severity levels.
          "@ --output-format text
          
          # Post review as PR comment via GitHub API
          $Body = @{ body = $Review } | ConvertTo-Json
          Invoke-RestMethod -Uri "https://api.github.com/repos/${{ github.repository }}/issues/${{ github.event.pull_request.number }}/comments" `
            -Method Post -Headers @{ Authorization = "Bearer $env:GITHUB_TOKEN" } `
            -Body $Body -ContentType "application/json"
```

---

## Summary: Your Upgrade Path by Week

| Week | What You Do | What You Gain |
|---|---|---|
| 1 | Write `CLAUDE.md` + `AGENTS.md` for your 2–3 main repos | Every session starts with full context |
| 2 | Wire ADO + GitHub MCPs in `settings.json` | Agents can read/write ADO and GitHub natively |
| 3 | Build `daily-ado-sync.ps1` + schedule via Task Scheduler | Your ADO tracker runs itself every morning |
| 4 | Add hooks for auto build/test after edits | Claude self-validates every change |
| 5–6 | Try multi-agent prompts interactively for complex features | Parallel analysis on large tasks |
| 7–8 | Add PR review GitHub Action | Automatic code review on every PR |

---

## What the Claude Windows App Can and Cannot Do

| Capability | claude.ai / Desktop App | Claude Code CLI |
|---|---|---|
| Chat / brainstorm | ✅ | ✅ |
| Read your files | ❌ (upload only) | ✅ (direct filesystem) |
| Write files / run commands | ❌ | ✅ |
| Headless / scheduled runs | ❌ | ✅ (`-p` flag) |
| MCP tool use (ADO, GitHub) | ✅ (Notion only, in browser) | ✅ (all configured MCPs) |
| Spawn subagents | ❌ | ✅ |
| GitHub Actions integration | ❌ | ✅ |

**Use the desktop app / claude.ai for:** Planning, architecture discussions, drafting messages (like your Slack bug reports), reviewing specs.  
**Use Claude Code CLI for:** Everything agentic — code, automation, scheduled work, multi-agent tasks.
