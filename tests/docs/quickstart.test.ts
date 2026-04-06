import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const QUICKSTART_PATH = join(__dirname, "..", "..", "QUICKSTART.md");

describe("QUICKSTART.md", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(QUICKSTART_PATH, "utf-8");
  });

  // S1: existence, header, prerequisites, clone & install, global constraints

  it("exists at repo root", () => {
    expect(existsSync(QUICKSTART_PATH)).toBe(true);
  });

  describe("header section", () => {
    it("contains 'Quickstart' in the title", () => {
      const firstLine = content.split("\n")[0];
      expect(firstLine).toMatch(/Quickstart/i);
    });

    it("contains ~10 minutes time estimate in first 5 lines", () => {
      const first5Lines = content.split("\n").slice(0, 5).join("\n");
      expect(first5Lines).toMatch(/~?\s*10\s*minutes/i);
    });
  });

  describe("prerequisites section", () => {
    it("lists Node.js 20+ with version check command", () => {
      expect(content).toContain("node --version");
      expect(content).toMatch(/Node\.?js\*{0,2}\s*\|?\s*20\+|Node\.?js.*>=\s*20/i);
    });

    it("lists Git with version check command", () => {
      expect(content).toContain("git --version");
    });

    it("lists Claude Code CLI with version check command", () => {
      expect(content).toContain("claude --version");
    });

    it("mentions both claude login and ANTHROPIC_API_KEY as auth options", () => {
      expect(content).toContain("claude login");
      expect(content).toContain("ANTHROPIC_API_KEY");
    });

    it("lists GitHub CLI with version check and gh auth login", () => {
      expect(content).toContain("gh --version");
      expect(content).toContain("gh auth login");
    });

    it("lists Azure CLI as optional for ADO integration", () => {
      expect(content).toMatch(/Azure CLI.*optional|optional.*Azure CLI/i);
      expect(content).toMatch(/Azure DevOps/i);
    });
  });

  describe("clone and install section", () => {
    it("contains git clone command", () => {
      expect(content).toContain(
        "git clone https://github.com/prpande/ShaktimaanAI.git"
      );
    });

    it("contains cd command", () => {
      expect(content).toContain("cd ShaktimaanAI");
    });

    it("contains npm install, npm run build, and npm link in correct order", () => {
      const buildIndex = content.indexOf("npm run build");
      const linkIndex = content.indexOf("npm link");
      expect(buildIndex).toBeGreaterThan(-1);
      expect(linkIndex).toBeGreaterThan(-1);
      expect(buildIndex).toBeLessThan(linkIndex);
    });
  });

  // S2: first-time setup, verify setup

  describe("first-time setup section", () => {
    it("documents shkmn init command", () => {
      expect(content).toContain("shkmn init");
    });

    it("lists all 7 wizard prompts in order", () => {
      const fields = [
        "runtimeDir",
        "reposRoot",
        "adoOrg",
        "adoProject",
        "adoArea",
        "dashboardRepoUrl",
        "dashboardRepoLocal",
      ];
      let lastIndex = -1;
      for (const field of fields) {
        const idx = content.indexOf(field);
        expect(idx).toBeGreaterThan(lastIndex);
        lastIndex = idx;
      }
    });

    it("marks runtimeDir as required with default ~/.shkmn/runtime", () => {
      expect(content).toMatch(/runtimeDir.*required/is);
      expect(content).toContain("~/.shkmn/runtime");
    });

    it("states other prompts can be skipped with Enter", () => {
      expect(content).toMatch(/press\s+Enter\s+to\s+skip/i);
    });

    it("instructs user to edit .env and set ANTHROPIC_API_KEY post-init", () => {
      expect(content).toMatch(/\.env/);
      expect(content).toContain("ANTHROPIC_API_KEY");
    });
  });

  describe("verify setup section", () => {
    it("documents shkmn doctor command", () => {
      expect(content).toContain("shkmn doctor");
    });

    it("explains doctor validates tools, config, and env", () => {
      const doctorIdx = content.indexOf("shkmn doctor");
      const surroundingText = content.substring(
        Math.max(0, doctorIdx - 200),
        doctorIdx + 500
      );
      expect(surroundingText).toMatch(/validat|check|verif/i);
    });

    it("warns that shkmn start does NOT validate env values", () => {
      expect(content).toMatch(
        /shkmn start.*does\s+\*{0,2}not\*{0,2}\s+validate|start.*won.t.*validate|start.*doesn.t.*check/i
      );
    });
  });

  // S3: start pipeline, submit first task, monitor progress

  describe("start pipeline section", () => {
    it("documents shkmn start in a dedicated terminal", () => {
      expect(content).toContain("shkmn start");
      expect(content).toMatch(/dedicated\s+terminal|foreground/i);
    });

    it("warns about running only one instance", () => {
      expect(content).toMatch(
        /race\s+condition|only\s+one|single\s+terminal|one\s+terminal/i
      );
    });
  });

  describe("submit first task section", () => {
    it("contains a concrete shkmn task example", () => {
      expect(content).toMatch(/shkmn task ".*"/);
    });

    it("explains slug is printed on creation", () => {
      expect(content).toMatch(/slug.*printed|prints.*slug/i);
    });

    it("explains .task file lands in 00-inbox", () => {
      expect(content).toContain("00-inbox");
    });

    it("mentions --quick for small changes", () => {
      expect(content).toContain("--quick");
    });

    it("mentions --repo for targeting a specific repository", () => {
      expect(content).toContain("--repo");
    });

    it("states shkmn task works independently of shkmn start", () => {
      expect(content).toMatch(
        /task.*independ|without.*start.*running|before.*watcher/i
      );
    });
  });

  describe("monitor progress section", () => {
    it("documents shkmn status", () => {
      expect(content).toContain("shkmn status");
    });

    it("documents shkmn logs with -f flag", () => {
      expect(content).toMatch(/shkmn logs.*-f/);
    });

    it("mentions prefix matching for slug", () => {
      expect(content).toMatch(/prefix\s*match/i);
    });

    it("explains slug discovery from shkmn task and shkmn status", () => {
      expect(content).toMatch(/slug.*shkmn task|shkmn task.*slug/i);
      expect(content).toMatch(/slug.*shkmn status|shkmn status.*slug/i);
    });
  });

  // S4: design gate approval, find your PR

  describe("design gate approval section", () => {
    it("explains task pauses after design stage in 12-hold", () => {
      expect(content).toContain("12-hold");
      expect(content).toMatch(/design.*stage|after.*design/i);
    });

    it("shows Held (awaiting approval) status", () => {
      expect(content).toMatch(/[Hh]eld.*awaiting approval/);
    });

    it("instructs to review logs then run shkmn approve", () => {
      expect(content).toContain("shkmn approve");
      expect(content).toMatch(/shkmn logs.*review|review.*logs/i);
    });

    it("mentions --feedback option", () => {
      expect(content).toContain("--feedback");
    });

    it("states shkmn start must be running for approval", () => {
      expect(content).toMatch(
        /start.*must.*running.*approv|watcher.*pick.*control/i
      );
    });
  });

  describe("find your PR section", () => {
    it("states PR is created automatically on shkmn/{slug} branch", () => {
      expect(content).toMatch(/shkmn\/\{?slug\}?|shkmn\/.+branch/i);
      expect(content).toMatch(/automatically|auto/i);
    });

    it("mentions PR URL in logs", () => {
      expect(content).toMatch(/PR.*URL.*log|log.*PR.*URL/i);
    });

    it("mentions gh pr list as alternative", () => {
      expect(content).toContain("gh pr list");
    });

    it("lists the post-approval stage sequence", () => {
      expect(content).toMatch(
        /structure.*plan.*impl.*validate.*review.*pr/i
      );
    });
  });

  // S5: troubleshooting

  describe("troubleshooting section", () => {
    it("has three subsections: EBUSY, timeout, recovery", () => {
      expect(content).toMatch(/EBUSY/);
      expect(content).toMatch(/[Tt]imeout/);
      expect(content).toMatch(/[Rr]ecovery.*crash|[Cc]rash.*[Rr]ecovery/i);
    });

    it("EBUSY section mentions retry with exponential backoff and copy-delete fallback", () => {
      expect(content).toMatch(/exponential\s+backoff|5\s+attempts|retry/i);
      expect(content).toMatch(/copy.*delete\s+fallback|fallback/i);
    });

    it("timeout section lists representative timeout values", () => {
      expect(content).toMatch(/15\s*m/i);
      expect(content).toMatch(/90\s*m/i);
    });

    it("timeout section mentions tasks move to 11-failed", () => {
      expect(content).toContain("11-failed");
    });

    it("timeout section does NOT claim shkmn retry recovers from 11-failed", () => {
      const failedIdx = content.indexOf("11-failed");
      if (failedIdx > -1) {
        const surrounding = content.substring(failedIdx, failedIdx + 300);
        expect(surrounding).not.toMatch(
          /shkmn retry.*recover.*11-failed|11-failed.*shkmn retry/i
        );
      }
    });

    it("recovery section says to run shkmn start again", () => {
      expect(content).toMatch(
        /run.*shkmn start.*again|restart.*shkmn start/i
      );
    });

    it("recovery section mentions corrupted run-state.json edge case", () => {
      expect(content).toContain("run-state.json");
    });

    it("recovery section mentions 2-hour timeout per task", () => {
      expect(content).toMatch(/2.hour\s+timeout/i);
    });
  });

  // S6: quick reference, what's next

  describe("quick reference section", () => {
    const EXPECTED_COMMANDS = [
      "shkmn init",
      "shkmn doctor",
      "shkmn start",
      "shkmn task",
      "shkmn status",
      "shkmn logs",
      "shkmn approve",
      "shkmn stop",
    ];

    it("contains a quick reference heading", () => {
      expect(content).toMatch(/Quick\s+Reference/i);
    });

    it("lists all 8 expected commands", () => {
      for (const cmd of EXPECTED_COMMANDS) {
        expect(content).toContain(cmd);
      }
    });

    it("does NOT include shkmn history in the table", () => {
      expect(content).not.toMatch(/shkmn\s+history/);
    });

    it("contains a Markdown table with at least 8 command rows", () => {
      const qrIdx = content.search(/Quick\s+Reference/i);
      const afterQR = content.substring(qrIdx);
      const tableRows = afterQR
        .split("\n")
        .filter((line) => line.includes("|") && line.includes("shkmn"));
      expect(tableRows.length).toBeGreaterThanOrEqual(8);
    });
  });

  describe("what's next section", () => {
    it("links to README.md", () => {
      expect(content).toContain("README.md");
    });

    it("mentions shkmn doctor for ongoing health checks", () => {
      const nextIdx = content.search(/What.s\s+Next/i);
      expect(nextIdx).toBeGreaterThan(-1);
      const afterNext = content.substring(nextIdx);
      expect(afterNext).toContain("shkmn doctor");
    });
  });

  // S7: flow diagram, cross-reference validation

  describe("flow diagram", () => {
    it("contains an ASCII-art or code-fenced flow diagram", () => {
      expect(content).toMatch(/shkmn init.*→|→.*shkmn start|→.*shkmn task/s);
    });

    it("uses ShaktimaanAI component names (Heimdall, Brahma, Garuda)", () => {
      expect(content).toContain("Heimdall");
      expect(content).toContain("Brahma");
      expect(content).toContain("Garuda");
    });

    it("mentions Hanuman for worktree setup in the impl stage", () => {
      expect(content).toMatch(/Hanuman.*worktree|worktree.*Hanuman/i);
    });
  });

  describe("cross-reference validation", () => {
    it("only references valid CLI subcommands", () => {
      const matches = content.match(/shkmn\s+(\w+)/g) || [];
      const validCommands = new Set([
        "init",
        "doctor",
        "start",
        "task",
        "status",
        "logs",
        "approve",
        "stop",
        "retry",
        "cancel",
        "pause",
        "resume",
        "skip",
        "restart",
        "modify",
        "config",
        "stats",
      ]);
      for (const match of matches) {
        const subcommand = match.replace("shkmn ", "");
        if (subcommand.startsWith("-")) continue;
        expect(validCommands.has(subcommand)).toBe(true);
      }
    });

    it("does NOT reference shkmn history", () => {
      expect(content).not.toMatch(/shkmn\s+history/);
    });

    it("references Node.js >= 20", () => {
      expect(content).toMatch(/Node\.?js\*{0,2}\s*\|?\s*20\+|Node.*>=\s*20/i);
    });

    it("has balanced code fences (no unclosed blocks)", () => {
      const fences = content.match(/^```/gm) || [];
      expect(fences.length % 2).toBe(0);
    });
  });
});
