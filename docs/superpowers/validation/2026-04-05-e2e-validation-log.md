# E2E Validation Log — 2026-04-05

## Prerequisites

- **Build:** PASS — clean build, no errors
- **Tests:** PASS — 482 tests across 34 files (after fixing 2 stale assertions)
- **Auth (gh):** PASS — logged in as prpande
- **Auth (az):** SKIP — not authenticated, not required for pipeline operation
- **Runtime dirs:** PASS — all 13 stage directories created at ~/.shkmn/runtime
- **Clean state:** PASS — no active tasks
- **Pre-existing test fixes:**
  - `tests/config/defaults.test.ts` — updated count from 14 to 15 (quick agent added in Spec 3)
  - `tests/core/recovery.test.ts` — updated to expect done dir scanning (Spec 3 recovery expansion)

## P0 Fixes Before Pipeline Could Run

### P0-1: Build script nested agents directory (commit 7101f4d)
- **Issue:** `cp -r agents/ dist/agents` created `dist/agents/agents/` on Windows
- **Root cause:** Git Bash `cp -r` behavior on Windows nests source dir
- **Fix:** Cross-platform Node.js script for file copying
- **Impact:** Pipeline couldn't find agent prompt files, all tasks failed immediately

### P0-2: Agent SDK query() call structure (commit b9cfe4f)
- **Issue:** `query()` takes `{prompt, options}` but we passed options at top level
- **Root cause:** SDK API mismatch — permissionMode, allowedTools, etc. were ignored
- **Fix:** Wrapped all options under `options:` key
- **Impact:** Agents stuck in permission prompts, couldn't execute any tools

### P0-3: maxTurns too low for research (commit 6d74add)
- **Issue:** Research agent hit 30-turn limit, pipeline treated as hard failure
- **Root cause:** Default maxTurns too conservative; error_max_turns discarded output
- **Fix:** Doubled maxTurns defaults; treat error_max_turns as partial success
- **Impact:** Research stage failed, losing useful partial output

### P0-4: Windows EBUSY on directory rename (commit 19548ef)
- **Issue:** `renameSync` fails on Windows when files have open handles
- **Root cause:** Agent SDK child processes hold file handles in task directory
- **Fix:** Retry with exponential backoff + cpSync/rmSync fallback
- **Impact:** Pipeline stuck after stage completion, couldn't transition stages

### P1-1: Read-only agents told to write files (commit 67b2bfd)
- **Issue:** System prompt says "Write your output to: {path}" but Write tool is disallowed
- **Root cause:** All stages got same output instruction regardless of tool permissions
- **Fix:** Read-only agents told to output text; pipeline captures it automatically
- **Impact:** Design agent wasted 15+ turns on Bash heredoc workarounds, all failing

### P2-1: Agent CWD vs repo path confusion (commit a11dadc)
- **Issue:** Research agent tried wrong file paths initially (6 errors)
- **Root cause:** Agent CWD is task dir, not repo root; repo path not prominent enough
- **Fix:** Add explicit repo path and "use absolute paths" warning to system prompt

### P2-2: Windows /c/ path incompatibility (commit a11dadc)
- **Issue:** Git Bash `$HOME` expands to `/c/Users/...` but Node.js expects `C:\`
- **Fix:** Add Windows path format warning to system prompt

### P2-3: Wasted tokens after error_max_turns (commit 774db33)
- **Issue:** After hitting turn limit, SDK continued generating 12+ more result entries ($1.15 waste)
- **Fix:** Break out of stream loop immediately after first error_max_turns result

### P2-4: Rate limiting (no code fix)
- **Issue:** 11 rate limit events in design stage
- **Root cause:** Large prompts (20KB research output as context) + frequent turns
- **Fix:** Not a code bug — API rate limits with auto-retry. Noted for optimization.

### P2-5: Design agent abort by user (no code fix)
- **Issue:** Watcher process died mid-design, agent aborted
- **Root cause:** Operational — our testing killed the watcher
- **Fix:** Not a code bug. Recovery handled it correctly on restart.

---

## Phase 1: Clean Baseline (shkmn stats)

**Task slug:** `add-a-shkmn-stats-command-that-reads-the-daily-int-20260405183658`
**Note:** 4th attempt after fixing P0 issues above. Previous attempts validated questions stage quality.

### Stage: questions (Narada) — from previous validated run
- **Cost:** $0.57 (25 turns)
- **Duration:** ~2.5 min
- **Artifact quality:** PASS — 19+ questions across 7 categories, all specific to task, real file paths, spotted data integrity issue with tokensUsed field
- **Issues found:** None

### Stage: research (Chitragupta) — from previous validated run
- **Cost:** $4.56 (84 turns)
- **Duration:** ~28 min
- **Artifact quality:** PENDING validation (output was 11.8KB, substantial)
- **Issues found:** Stage completed but pipeline couldn't transition (P0-4)

### Current run stages pending validation...

### Stage: research (Chitragupta)
- **Start time:** 
- **End time:** 
- **Tokens (in/out):** 
- **Cost:** 
- **Artifact quality:** 
- **Issues found:** 

### Stage: design (Vishwakarma)
- **Start time:** 
- **End time:** 
- **Tokens (in/out):** 
- **Cost:** 
- **Artifact quality:** 
- **Issues found:** 
- **Review gate:** 

### Stage: structure (Vastu)
- **Start time:** 
- **End time:** 
- **Tokens (in/out):** 
- **Cost:** 
- **Artifact quality:** 
- **Issues found:** 

### Stage: plan (Chanakya)
- **Start time:** 
- **End time:** 
- **Tokens (in/out):** 
- **Cost:** 
- **Artifact quality:** 
- **Issues found:** 

### Stage: impl (Karigar)
- **Start time:** 
- **End time:** 
- **Tokens (in/out):** 
- **Cost:** 
- **Artifact quality:** 
- **TDD cycle:** 
- **Worktree:** 
- **Issues found:** 

### Stage: validate (Dharma)
- **Start time:** 
- **End time:** 
- **Tokens (in/out):** 
- **Cost:** 
- **Artifact quality:** 
- **Verdict:** 
- **Issues found:** 

### Stage: review (Drona)
- **Start time:** 
- **End time:** 
- **Tokens (in/out):** 
- **Cost:** 
- **Artifact quality:** 
- **Review gate:** 
- **Issues found:** 

### Stage: pr (Garuda)
- **Start time:** 
- **End time:** 
- **Tokens (in/out):** 
- **Cost:** 
- **Artifact quality:** 
- **PR URL:** 
- **Issues found:** 

### Phase 1 Summary
- **Total cost:** 
- **Total duration:** 
- **Total retries:** 
- **Fix interventions:** 

---

## Phase 2: Chaos Run (shkmn doctor)

(To be filled during Phase 2)

---

## Phase 3: CLI Validation

(To be filled during Phases 1 and 2)

---

## Phase 4: Cost Report & Graduation

(To be filled after all phases complete)
