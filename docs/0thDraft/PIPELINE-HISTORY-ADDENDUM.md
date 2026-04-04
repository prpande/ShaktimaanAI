# Claude Agent Pipeline — History & Analytics Addendum
**Extends:** PIPELINE-PLAN.md
**Purpose:** Development journal, velocity tracking, performance reflection
**Scope:** Personal (designed to support team later)

---

## Design Decisions

| Decision | Choice |
|---|---|
| Who | Personal — schema designed for team extension later |
| What counts | Pipeline tasks + ADO items closed outside the pipeline |
| Storage | Structured JSON + human-readable daily markdown |
| Granularity | Per-task entry on completion + daily rollup at 11:55 PM |
| View | History tab on GitHub Pages dashboard |
| Week view | Living "week so far" — regenerated nightly, always current for standups |
| Reporting | Daily log + cumulative week-so-far + monthly summary (1st of month) |
| Notion | Ad hoc .push-notion trigger file + Friday 6 PM auto-push |
| Metrics | Pipeline duration, stage durations, PR merge rate, ADO items closed |

---

## Architecture Overview

```
Per-task completion
      │
      ▼
history-writer.ps1         ← Appends to history.json when task hits 04-complete

11:55 PM daily (Task Scheduler)
      │
      ▼
daily-rollup.ps1           ← Queries ADO for items closed today (outside pipeline)
      │                       Writes daily-log\YYYY-MM-DD.md
      │                       Regenerates week-so-far.json (Monday→today, cumulative)
      │                       Pushes both files to dashboard repo

Friday 6 PM (Task Scheduler)
      │
      ▼
notion-push.ps1            ← Auto-pushes this week's summary to Notion
                               (runs after Friday's daily rollup has already run)

1st of each month 8 AM (Task Scheduler)
      │
      ▼
monthly-report.ps1         ← Covers prior full calendar month
                               Writes monthly-reports\YYYY-MM.md to OneDrive

On demand (.push-notion file dropped in 00-inbox)
      │
      ▼
notion-push.ps1            ← Generates summary for requested period → Notion page
```

---

## Part 1: New Files and Folders

### Additions to Pipeline Root

```
{PIPELINE_ROOT}\
├── ...existing folders...
│
├── history\
│   ├── history.json               ← Append-only record of all completed work
│   ├── daily-log\
│   │   ├── 2026-04-04.md
│   │   └── ...
│   └── monthly-reports\
│       ├── 2026-04.md
│       └── ...
│
└── scripts\
    ├── history-writer.ps1         ← Called by watcher on task completion
    ├── daily-rollup.ps1           ← Scheduled: 11:55 PM daily
    ├── monthly-report.ps1         ← Scheduled: 1st of month 8 AM
    └── notion-push.ps1            ← On-demand + Friday auto-push
```

### Additions to Dashboard Repo

```
agent-dashboard\
├── data\
│   ├── status.json                ← Existing
│   ├── history.json               ← NEW: mirrored from pipeline on each rollup
│   └── week-so-far.json           ← NEW: regenerated nightly, Monday to today
└── index.html                     ← Add History tab
```

---

## Part 2: Data Schemas

### history.json

Append-only array. Two entry types: pipeline_task and ado_item.

```json
[
  {
    "entry_id": "20260404-0900-mindbody-retry-logic",
    "type": "pipeline_task",
    "date": "2026-04-04",
    "title": "Add retry logic to MindBodyApiClient",
    "description": "Added Polly-based exponential backoff on 429/503/504. 8 unit tests.",
    "completed_at": "2026-04-04T14:22:00Z",
    "duration_minutes": 82,
    "stage_durations": { "research": 18, "spec": 24, "impl": 40 },
    "outcome": "complete",
    "links": {
      "ado": "https://dev.azure.com/mindbody/MBScrum/_workitems/edit/1502888",
      "pr": "https://github.com/mindbody/businessapp/pull/847",
      "pr_merged": null,
      "pr_merged_at": null
    },
    "tags": [],
    "repo": "mindbody-businessapp",
    "branch": "agent/20260404-0900-mindbody-retry-logic"
  },
  {
    "entry_id": "ado-1501234-20260404",
    "type": "ado_item",
    "date": "2026-04-04",
    "title": "Fix null reference in AppointmentService.GetAvailability",
    "description": "",
    "completed_at": "2026-04-04T16:45:00Z",
    "duration_minutes": null,
    "stage_durations": null,
    "outcome": "complete",
    "links": {
      "ado": "https://dev.azure.com/mindbody/MBScrum/_workitems/edit/1501234",
      "pr": null, "pr_merged": null, "pr_merged_at": null
    },
    "tags": [], "repo": null, "branch": null
  }
]
```

Team extension note: add "author": "pratyush" when expanding to team — schema is ready.

### week-so-far.json

Regenerated every night by daily-rollup.ps1. Always covers Monday of the current
week through today. This is the source for the standup banner on the dashboard.

```json
{
  "generated_at": "2026-04-04T23:55:00Z",
  "week_start": "2026-03-30",
  "week_end": "2026-04-04",
  "pipeline_tasks": 4,
  "ado_items": 3,
  "total_pipeline_min": 310,
  "prs_opened": 3,
  "daily_breakdown": [
    { "date": "2026-03-30", "pipeline_tasks": 1, "ado_items": 0, "pipeline_min": 75 },
    { "date": "2026-04-04", "pipeline_tasks": 1, "ado_items": 1, "pipeline_min": 82 }
  ],
  "entries": [ "...all history entries for the week sorted by date asc..." ]
}
```

---

## Part 3: Scripts

### scripts\history-writer.ps1

Sourced by pipeline-watcher.ps1. Called inside the "complete" handler.

```powershell
# history-writer.ps1 — sourced by pipeline-watcher.ps1, not run standalone

function Write-HistoryEntry {
    param([string]$Slug, [hashtable]$Meta, [string]$ImplSummaryPath = "")

    $HistoryFile = "$PipelineRoot\history\history.json"
    New-Item -ItemType Directory -Force -Path "$PipelineRoot\history" | Out-Null

    # Derive durations from status.json events
    $StatusFile = "$DashboardRepo\data\status.json"
    $TaskEvents = if (Test-Path $StatusFile) {
        (Get-Content $StatusFile -Raw | ConvertFrom-Json) |
            Where-Object { $_.id -eq $Slug }
    } else { @() }

    function Get-StageDuration([string]$Stage) {
        $S = $TaskEvents | Where-Object { $_.stage -eq $Stage -and $_.status -eq "in_progress" } |
             Sort-Object timestamp | Select-Object -First 1
        $E = $TaskEvents | Where-Object { $_.stage -eq $Stage -and $_.status -eq "complete" } |
             Sort-Object timestamp | Select-Object -First 1
        if ($S -and $E) {
            return [int]([datetime]$E.timestamp - [datetime]$S.timestamp).TotalMinutes
        }
        return $null
    }

    $InboxEv    = $TaskEvents | Where-Object { $_.stage -eq "inbox" } | Select-Object -First 1
    $CompleteEv = $TaskEvents | Where-Object { $_.stage -eq "complete" } | Select-Object -First 1
    $TotalMin   = if ($InboxEv -and $CompleteEv) {
        [int]([datetime]$CompleteEv.timestamp - [datetime]$InboxEv.timestamp).TotalMinutes
    } else { $null }

    $PrUrl = $null; $ImplDesc = ""
    if ($ImplSummaryPath -and (Test-Path $ImplSummaryPath)) {
        $IC = Get-Content $ImplSummaryPath -Raw
        if ($IC -match 'https://github\.com/\S+/pull/\d+') { $PrUrl = $Matches[0] }
        if ($IC -match '(?m)^## Summary\r?\n(.+)$') { $ImplDesc = $Matches[1].Trim() }
    }

    $Entry = [ordered]@{
        entry_id         = $Slug
        type             = "pipeline_task"
        date             = (Get-Date -Format "yyyy-MM-dd")
        title            = $Meta.Title
        description      = $ImplDesc
        completed_at     = (Get-Date -Format "o")
        duration_minutes = $TotalMin
        stage_durations  = [ordered]@{
            research = Get-StageDuration "research"
            spec     = Get-StageDuration "spec"
            impl     = Get-StageDuration "impl"
        }
        outcome          = "complete"
        links            = [ordered]@{
            ado          = if ($Meta.AdoItem) { "$AdoOrg/$AdoProject/_workitems/edit/$($Meta.AdoItem)" } else { $null }
            pr           = $PrUrl
            pr_merged    = $null
            pr_merged_at = $null
        }
        tags             = @()
        repo             = if ($Meta.Repo) { Split-Path $Meta.Repo -Leaf } else { $null }
        branch           = if ($Meta.Repo) { "agent/$Slug" } else { $null }
    }

    $Existing = if (Test-Path $HistoryFile) {
        [System.Collections.ArrayList]@((Get-Content $HistoryFile -Raw | ConvertFrom-Json))
    } else { [System.Collections.ArrayList]@() }

    $Existing.Add((New-Object PSObject -Property $Entry)) | Out-Null
    $Existing | ConvertTo-Json -Depth 10 | Set-Content $HistoryFile -Encoding UTF8
    Write-Host "  [History] Entry written: $Slug"
}
```

---

### scripts\daily-rollup.ps1

Three jobs in one pass: daily log, week-so-far regeneration, dashboard push.

```powershell
# daily-rollup.ps1 — scheduled 11:55 PM daily

. $ConfigPath

$Today       = Get-Date
$TodayStr    = $Today.ToString("yyyy-MM-dd")
$HistoryFile = "$PipelineRoot\history\history.json"
$LogDir      = "$PipelineRoot\history\daily-log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# 1. Load history
$AllHistory = if (Test-Path $HistoryFile) {
    [System.Collections.ArrayList]@((Get-Content $HistoryFile -Raw | ConvertFrom-Json))
} else { [System.Collections.ArrayList]@() }

# 2. Query ADO for items closed today not already in history
$ExistingAdoUrls = @($AllHistory | Where-Object { $_.date -eq $TodayStr } |
                     ForEach-Object { $_.links.ado }) -join ", "

$AdoPrompt = @"
Query Azure DevOps project $AdoProject for work items:
- Closed or resolved TODAY ($TodayStr)
- Assigned to me
- NOT in this list of already-tracked URLs: $ExistingAdoUrls

Output ONLY a JSON array, no markdown fences:
[{ "id": "1234", "title": "...", "url": "..." }]
If nothing found output: []
"@

$AdoRaw = $AdoPrompt | claude -p --allowedTools "mcp__ado__*" --output-format text 2>&1
$AdoItems = @()
try { $AdoItems = ($AdoRaw -replace '```json|```','').Trim() | ConvertFrom-Json }
catch { Write-Host "  ADO parse skipped: $_" }

# 3. Append ADO items to history
foreach ($Item in $AdoItems) {
    $E = [ordered]@{
        entry_id="ado-$($Item.id)-$TodayStr"; type="ado_item"; date=$TodayStr
        title=$Item.title; description=""; completed_at=(Get-Date -Format "o")
        duration_minutes=$null; stage_durations=$null; outcome="complete"
        links=[ordered]@{ ado=$Item.url; pr=$null; pr_merged=$null; pr_merged_at=$null }
        tags=@(); repo=$null; branch=$null
    }
    $AllHistory.Add((New-Object PSObject -Property $E)) | Out-Null
}
$AllHistory | ConvertTo-Json -Depth 10 | Set-Content $HistoryFile -Encoding UTF8

# 4. Build daily markdown log
$TodayAll  = @($AllHistory | Where-Object { $_.date -eq $TodayStr })
$Pipeline  = @($TodayAll | Where-Object { $_.type -eq "pipeline_task" })
$Ado       = @($TodayAll | Where-Object { $_.type -eq "ado_item" })
$PipMin    = ($Pipeline | Measure-Object -Property duration_minutes -Sum).Sum
$PRs       = @($Pipeline | Where-Object { $_.links.pr }).Count
$Longest   = if ($Pipeline.Count -gt 0) {
    $Pipeline | ForEach-Object {
        $sd = $_.stage_durations
        @("research","spec","impl") | ForEach-Object {
            [pscustomobject]@{ stage=$_; mins=$sd.$_ }
        }
    } | Where-Object { $_.mins } | Sort-Object mins -Descending | Select-Object -First 1
} else { $null }

$Md  = "# Development Log — $($Today.ToString('dddd, MMMM d, yyyy'))`n`n"
$Md += "## Summary`n"
$Md += "**$($Pipeline.Count) pipeline task(s)** + **$($Ado.Count) ADO item(s)** | "
$Md += "**$PipMin min** pipeline time | **$PRs PR(s)** opened`n`n"

if ($Pipeline.Count -gt 0) {
    $Md += "## Pipeline Tasks`n`n"
    foreach ($T in $Pipeline) {
        $Md += "### $($T.title)`n"
        if ($T.links.ado) { $Id = $T.links.ado -replace '.+/edit/',''; $Md += "- **ADO:** [$Id]($($T.links.ado))`n" }
        if ($T.links.pr)  { $Num = $T.links.pr -replace '.+/pull/',''; $Md += "- **PR:** [#$Num]($($T.links.pr))`n" }
        if ($T.duration_minutes) {
            $sd = $T.stage_durations
            $Md += "- **Duration:** $($T.duration_minutes) min"
            if ($sd) { $Md += " (Research: $($sd.research)m · Spec: $($sd.spec)m · Impl: $($sd.impl)m)" }
            $Md += "`n"
        }
        if ($T.description) { $Md += "- **Summary:** $($T.description)`n" }
        $Md += "`n"
    }
}

if ($Ado.Count -gt 0) {
    $Md += "## ADO Items Closed (outside pipeline)`n`n"
    foreach ($A in $Ado) {
        $Md += "### $($A.title)`n"
        if ($A.links.ado) { $Id = $A.links.ado -replace '.+/edit/',''; $Md += "- **ADO:** [$Id]($($A.links.ado))`n" }
        $Md += "`n"
    }
}

$Md += "## Metrics`n| Metric | Value |`n|---|---|`n"
$Md += "| Pipeline tasks | $($Pipeline.Count) |`n"
$Md += "| ADO items closed | $($Ado.Count) |`n"
$Md += "| Total pipeline time | $PipMin min |`n"
if ($Longest) { $Md += "| Longest stage | $($Longest.stage) ($($Longest.mins) min) |`n" }
$Md += "| PRs opened | $PRs |`n"
$Md | Set-Content "$LogDir\$TodayStr.md" -Encoding UTF8
Write-Host "Daily log: $LogDir\$TodayStr.md"

# 5. Regenerate week-so-far.json (Monday to today, cumulative)
$WS = $Today
while ($WS.DayOfWeek -ne [DayOfWeek]::Monday) { $WS = $WS.AddDays(-1) }
$WSStr = $WS.ToString("yyyy-MM-dd")

$WeekAll      = @($AllHistory | Where-Object { $_.date -ge $WSStr })
$WeekPipeline = @($WeekAll | Where-Object { $_.type -eq "pipeline_task" })
$WeekAdo      = @($WeekAll | Where-Object { $_.type -eq "ado_item" })

$DailyBreakdown = $WeekAll | Group-Object date | Sort-Object Name | ForEach-Object {
    [ordered]@{
        date           = $_.Name
        pipeline_tasks = @($_.Group | Where-Object { $_.type -eq "pipeline_task" }).Count
        ado_items      = @($_.Group | Where-Object { $_.type -eq "ado_item" }).Count
        pipeline_min   = ($_.Group | Measure-Object -Property duration_minutes -Sum).Sum
    }
}

$WeekSummary = [ordered]@{
    generated_at       = (Get-Date -Format "o")
    week_start         = $WSStr
    week_end           = $TodayStr
    pipeline_tasks     = $WeekPipeline.Count
    ado_items          = $WeekAdo.Count
    total_pipeline_min = ($WeekPipeline | Measure-Object -Property duration_minutes -Sum).Sum
    prs_opened         = @($WeekPipeline | Where-Object { $_.links.pr }).Count
    daily_breakdown    = @($DailyBreakdown)
    entries            = @($WeekAll | Sort-Object date)
}

$WeekFile = "$DashboardRepo\data\week-so-far.json"
$WeekSummary | ConvertTo-Json -Depth 10 | Set-Content $WeekFile -Encoding UTF8
Write-Host "week-so-far.json: $WSStr to $TodayStr ($($WeekAll.Count) entries)"

# 6. Push to dashboard repo
Copy-Item $HistoryFile "$DashboardRepo\data\history.json" -Force
Push-Location $DashboardRepo
git pull --quiet 2>$null
git add "data\history.json" "data\week-so-far.json" | Out-Null
git commit -m "history: rollup $TodayStr" --quiet | Out-Null
git push --quiet 2>$null
Pop-Location
Write-Host "Dashboard pushed."
```

---

### scripts\monthly-report.ps1

Covers the prior full calendar month. Runs 1st of each month.

```powershell
# monthly-report.ps1 — scheduled 1st of month at 8 AM

. $ConfigPath

$First      = Get-Date -Day 1
$MonthStart = $First.AddMonths(-1).ToString("yyyy-MM-dd")
$MonthEnd   = $First.AddDays(-1).ToString("yyyy-MM-dd")
$Label      = $First.AddMonths(-1).ToString("yyyy-MM")
$ReportDir  = "$PipelineRoot\history\monthly-reports"
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null

$All       = if (Test-Path "$PipelineRoot\history\history.json") {
    (Get-Content "$PipelineRoot\history\history.json" -Raw | ConvertFrom-Json)
} else { @() }

$Entries   = @($All | Where-Object { $_.date -ge $MonthStart -and $_.date -le $MonthEnd })
$Pipeline  = @($Entries | Where-Object { $_.type -eq "pipeline_task" })
$Ado       = @($Entries | Where-Object { $_.type -eq "ado_item" })
$TotMin    = ($Pipeline | Measure-Object -Property duration_minutes -Sum).Sum
$AvgMin    = if ($Pipeline.Count -gt 0) { [int]($TotMin / $Pipeline.Count) } else { 0 }
$PRs       = @($Pipeline | Where-Object { $_.links.pr }).Count

function Get-AvgStage([string]$Stage) {
    $Vals = @($Pipeline | Where-Object { $_.stage_durations -and $_.stage_durations.$Stage } |
              ForEach-Object { $_.stage_durations.$Stage })
    if ($Vals.Count) { [int](($Vals | Measure-Object -Sum).Sum / $Vals.Count) } else { 0 }
}

$MonthName = $First.AddMonths(-1).ToString("MMMM yyyy")
$Md  = "# Monthly Development Report — $MonthName`n`n"
$Md += "## Summary`n| Metric | Value |`n|---|---|`n"
$Md += "| Total items | $($Entries.Count) |`n"
$Md += "| Pipeline tasks | $($Pipeline.Count) |`n"
$Md += "| ADO items (manual) | $($Ado.Count) |`n"
$Md += "| PRs opened | $PRs |`n"
$Md += "| Total pipeline time | $TotMin min |`n"
$Md += "| Avg pipeline duration | $AvgMin min |`n"
$Md += "| Avg research stage | $(Get-AvgStage 'research') min |`n"
$Md += "| Avg spec stage | $(Get-AvgStage 'spec') min |`n"
$Md += "| Avg impl stage | $(Get-AvgStage 'impl') min |`n`n"
$Md += "## All Tasks`n`n"
foreach ($T in $Entries | Sort-Object date) {
    $Md += "- **[$($T.date)]** $($T.title)"
    if ($T.links.ado) { $Md += " · [ADO]($($T.links.ado))" }
    if ($T.links.pr)  { $Md += " · [PR]($($T.links.pr))" }
    $Md += "`n"
}
$Md | Set-Content "$ReportDir\$Label.md" -Encoding UTF8
Write-Host "Monthly report: $ReportDir\$Label.md"
```

---

### scripts\notion-push.ps1

Handles both the Friday auto-push and ad hoc trigger files.

```powershell
# notion-push.ps1
# Two entry points:
#   Invoke-WeeklyNotionPush  — called by Friday scheduled task
#   Invoke-AdHocNotionPush   — called by watcher when .push-notion file appears

. $ConfigPath

function Push-ToNotion {
    param([string]$Title, [string]$Content)
    $Prompt = @"
Using the Notion MCP, create a new page in the Engineering space with:
Title: $Title
Content (preserve all markdown formatting):
$Content
If a Dev Journal or Weekly Reports database exists, add it there.
Otherwise create a standalone page under Engineering space.
Set icon to a calendar emoji. Output only the created page URL.
"@
    $Result = $Prompt | claude -p --allowedTools "mcp__notion__*" --output-format text 2>&1
    Write-Host "Notion: $Result"
    return $Result
}

function Get-EntriesForPeriod([string]$Request) {
    $All   = if (Test-Path "$PipelineRoot\history\history.json") {
        (Get-Content "$PipelineRoot\history\history.json" -Raw | ConvertFrom-Json)
    } else { @() }
    $Today = Get-Date
    switch -Wildcard ($Request.ToLower()) {
        "this week"  {
            $WS = $Today
            while ($WS.DayOfWeek -ne [DayOfWeek]::Monday) { $WS = $WS.AddDays(-1) }
            return @($All | Where-Object { $_.date -ge $WS.ToString("yyyy-MM-dd") })
        }
        "last week"  {
            $WE = $Today
            while ($WE.DayOfWeek -ne [DayOfWeek]::Monday) { $WE = $WE.AddDays(-1) }
            $WS = $WE.AddDays(-7)
            return @($All | Where-Object { $_.date -ge $WS.ToString("yyyy-MM-dd") -and $_.date -lt $WE.ToString("yyyy-MM-dd") })
        }
        "this month" {
            $S = (Get-Date -Day 1).ToString("yyyy-MM-dd")
            return @($All | Where-Object { $_.date -ge $S })
        }
        "last month" {
            $S = (Get-Date -Day 1).AddMonths(-1).ToString("yyyy-MM-dd")
            $E = (Get-Date -Day 1).AddDays(-1).ToString("yyyy-MM-dd")
            return @($All | Where-Object { $_.date -ge $S -and $_.date -le $E })
        }
        "20??"       { return @($All | Where-Object { $_.date -like "$($Request.ToLower())*" }) }
        default      {
            # Default to this week
            $WS = $Today
            while ($WS.DayOfWeek -ne [DayOfWeek]::Monday) { $WS = $WS.AddDays(-1) }
            return @($All | Where-Object { $_.date -ge $WS.ToString("yyyy-MM-dd") })
        }
    }
}

function Build-SummaryMarkdown([array]$Entries, [string]$Label) {
    $Pipeline = @($Entries | Where-Object { $_.type -eq "pipeline_task" })
    $Ado      = @($Entries | Where-Object { $_.type -eq "ado_item" })
    $PipMin   = ($Pipeline | Measure-Object -Property duration_minutes -Sum).Sum
    $PRs      = @($Pipeline | Where-Object { $_.links.pr }).Count

    $Md  = "## $Label`n`n"
    $Md += "| Metric | Value |`n|---|---|`n"
    $Md += "| Pipeline tasks | $($Pipeline.Count) |`n"
    $Md += "| ADO items | $($Ado.Count) |`n"
    $Md += "| Total pipeline time | $PipMin min |`n"
    $Md += "| PRs opened | $PRs |`n`n"
    $Md += "## Tasks Completed`n`n"
    foreach ($T in $Entries | Sort-Object date) {
        $Md += "- **[$($T.date)]** $($T.title)"
        if ($T.links.ado) { $Md += " · [ADO]($($T.links.ado))" }
        if ($T.links.pr)  { $Md += " · [PR]($($T.links.pr))" }
        $Md += "`n"
    }
    return $Md
}

function Invoke-WeeklyNotionPush {
    $WF = "$DashboardRepo\data\week-so-far.json"
    if (-not (Test-Path $WF)) { Write-Host "week-so-far.json not found"; return }
    $Week    = Get-Content $WF -Raw | ConvertFrom-Json
    $Entries = @($Week.entries)
    $Label   = "Week of $($Week.week_start) to $($Week.week_end)"
    $Content = Build-SummaryMarkdown $Entries $Label
    Push-ToNotion -Title "Dev Week — $($Week.week_start)" -Content $Content
}

function Invoke-AdHocNotionPush {
    param([string]$TriggerFile)
    $Request = (Get-Content $TriggerFile -Raw -Encoding UTF8).Trim()
    $Entries = Get-EntriesForPeriod $Request
    if ($Entries.Count -eq 0) {
        Write-Host "No entries for '$Request'"; Remove-Item $TriggerFile -Force; return
    }
    $Content = Build-SummaryMarkdown $Entries $Request
    $Title   = "Dev Summary — $Request ($((Get-Date).ToString('yyyy-MM-dd')))"
    Push-ToNotion -Title $Title -Content $Content
    Remove-Item $TriggerFile -Force
    Write-Host "Ad hoc Notion push complete: $Request"
}

# Run as scheduled task (Friday auto-push) when not sourced
if ($MyInvocation.InvocationName -ne '.') { Invoke-WeeklyNotionPush }
```

---

## Part 4: Ad Hoc Notion Push Usage

Drop a file named `anything.push-notion` in `00-inbox\` with one of these as the content:

| Content | What gets pushed |
|---|---|
| `this week` | Monday to today (matches dashboard standup banner) |
| `last week` | Previous Mon–Sun |
| `this month` | 1st of current month to today |
| `last month` | Full previous calendar month |
| `2026` | Everything in history.json for that year |
| *(blank)* | Defaults to this week |

Watcher picks it up, generates the summary, creates the Notion page, deletes the file.
Works from mobile if OneDrive syncs the pipeline folder to your phone.

---

## Part 5: Changes to pipeline-watcher.ps1

Three additions:

```powershell
# 1. At the top alongside slack-notify, source history-writer:
. "$PipelineRoot\scripts\history-writer.ps1"

# 2. In the "complete" case of Move-Task, after bundling artifacts, add:
$ImplPath = "$PipelineRoot\03-impl\done\$Slug.impl.md"
Write-HistoryEntry $Slug $Meta $ImplPath

# 3. After the existing FileSystemWatcher registrations, add:
$NotionWatcher        = New-Object System.IO.FileSystemWatcher
$NotionWatcher.Path   = "$PipelineRoot\00-inbox"
$NotionWatcher.Filter = "*.push-notion"
$NotionWatcher.EnableRaisingEvents = $true
Register-ObjectEvent $NotionWatcher "Created" -Action {
    Start-Sleep -Milliseconds 500
    . "$PipelineRoot\scripts\notion-push.ps1"
    Invoke-AdHocNotionPush $Event.SourceEventArgs.FullPath
}
```

---

## Part 6: New Scheduled Tasks for setup-pipeline.ps1

Replace the previous weekly task block with these three:

```powershell
# Daily rollup — 11:55 PM every day
Register-ScheduledTask -TaskName "ClaudeAgentDailyRollup" -Force `
    -Action (New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NonInteractive -File `"$ScriptDir\scripts\daily-rollup.ps1`" -ConfigPath `"$ConfigPath`"") `
    -Trigger (New-ScheduledTaskTrigger -Daily -At "11:55PM") `
    -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1)) | Out-Null

# Friday Notion push — 6 PM (after that day's rollup)
Register-ScheduledTask -TaskName "ClaudeAgentFridayNotionPush" -Force `
    -Action (New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NonInteractive -File `"$ScriptDir\scripts\notion-push.ps1`" -ConfigPath `"$ConfigPath`"") `
    -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Friday -At "6:00PM") `
    -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1)) | Out-Null

# Monthly report — 1st of each month at 8 AM
Register-ScheduledTask -TaskName "ClaudeAgentMonthlyReport" -Force `
    -Action (New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NonInteractive -File `"$ScriptDir\scripts\monthly-report.ps1`" -ConfigPath `"$ConfigPath`"") `
    -Trigger (New-ScheduledTaskTrigger -Monthly -DaysOfMonth 1 -At "8:00AM") `
    -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1)) | Out-Null

Write-Host "  Registered: DailyRollup, FridayNotionPush, MonthlyReport"
```

---

## Part 7: Dashboard History Tab Spec

Add a History tab to index.html. Reads history.json and week-so-far.json.
Both files are polled every 30 seconds alongside status.json.

```
WEEK SO FAR BANNER  (reads week-so-far.json)
────────────────────────────────────────────
Full-width card at the top of the History tab.
Label: "Week of {week_start} — updated {generated_at formatted as local time}"
Sub-label: "Ready for standup"
Four metric chips in a row:
  Pipeline tasks  |  ADO items closed  |  Total pipeline time  |  PRs opened
Slightly lighter background than the rest of the page to make it stand out.
On mobile: chips wrap to 2x2 grid.


TWO PANELS SIDE BY SIDE  (reads history.json)
─────────────────────────────────────────────
LEFT: GitHub-style contribution heatmap
  52 columns (weeks) x 7 rows (Mon-Sun)
  Cell color intensity = items completed that day
  Color scale: 0=dark bg, 1=dim green, 2=medium green, 3+=bright green
  Hover tooltip: "{date}: {N} item(s) — {titles}"
  Current day: highlighted with a white border
  Pure SVG, no libraries

RIGHT: Week-by-week grouped bar chart
  Last 12 weeks
  Two bars per week: pipeline tasks (blue) and ADO items (gray)
  X axis: "W14", "W15" etc
  Y axis: integer count
  Pure canvas, no libraries


HISTORY LIST  (reads history.json)
────────────────────────────────────
Filter bar above list:
  [From date] [To date]   Type: All | Pipeline | ADO

Scrollable list newest-first. Each row:
  {type badge} | {date} | {title} | {duration or —} | {ADO} {PR} links

Clicking a row expands inline (accordion):
  Description | Stage breakdown (Research Xm / Spec Xm / Impl Xm) | Repo | Branch

STYLE: match existing dark theme (#0d1117) exactly. No external dependencies.
```

---

## Part 8: Implementation Order for Claude Code

Append this block to the Part 7 instruction in PIPELINE-PLAN.md:

```
HISTORY & ANALYTICS
Implement after all 14 core pipeline files are complete.
Read PIPELINE-HISTORY-ADDENDUM.md in full before starting.

15. scripts\history-writer.ps1
16. scripts\daily-rollup.ps1
17. scripts\monthly-report.ps1
18. scripts\notion-push.ps1
19. Update pipeline-watcher.ps1:
    - Source history-writer.ps1 at top
    - Call Write-HistoryEntry in the "complete" handler after bundling artifacts
    - Add .push-notion FileSystemWatcher (third watcher alongside inbox and review)
20. Update setup-pipeline.ps1:
    - Replace old weekly task block with DailyRollup, FridayNotionPush,
      and MonthlyReport per Part 6 of this addendum
21. Update agent-dashboard\data\ — add empty history.json: []
22. Update agent-dashboard\data\ — add initial week-so-far.json:
    { "generated_at":"","week_start":"","week_end":"","pipeline_tasks":0,
      "ado_items":0,"total_pipeline_min":0,"prs_opened":0,
      "daily_breakdown":[],"entries":[] }
23. Update agent-dashboard\index.html:
    - Add History tab per Part 7 spec
    - Poll week-so-far.json and history.json every 30 seconds alongside status.json

After all 23 files, output the complete go-live checklist covering
both core pipeline and history components.
```
