# Spec 2b: Alignment Agents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace stub alignment agent prompts with production prompts, introduce agent configuration via markdown files with YAML frontmatter, add tiered repo context gathering, and rewire the agent runner to use the new system.

**Architecture:** Each agent is defined by a single markdown file in `agents/` — YAML frontmatter for machine config (tools, turns, timeout) and markdown body for the prompt template. A new `agent-config.ts` module parses these files. A new `repo-context.ts` gathers target repo conventions via a 3-tier strategy. The agent runner is updated to use both, replacing the hardcoded `STAGE_TOOL_MAP` and `loadTemplate()`. Display names live only in `shkmn.config.json`.

**Tech Stack:** TypeScript, Node.js 20+, vitest. No new npm dependencies.

**Reference:** [Spec 2b Design](../specs/2026-04-04-spec2b-alignment-agents-design.md) | [Spec 2a Plan](./2026-04-04-spec2a-pipeline-infrastructure.md)

---

## File Structure

```
src/
├── core/
│   ├── agent-config.ts          ← NEW: YAML frontmatter parser + agent config loader
│   ├── repo-context.ts          ← NEW: Tiered repo context gatherer
│   ├── agent-runner.ts          ← MODIFY: use agent-config, repo-context, remove STAGE_TOOL_MAP
│   └── template.ts             ← MODIFY: remove loadTemplate(), keep hydrateTemplate()
├── config/
│   ├── defaults.ts             ← MODIFY: add agentsDir path
│   └── schema.ts               ← MODIFY: add agents.tools config section
│   └── loader.ts               ← MODIFY: resolve new agents config fields
agents/
├── questions.md                 ← NEW: Questions agent (full production prompt)
├── research.md                  ← NEW: Research agent (full production prompt)
├── design.md                    ← NEW: Design agent (full production prompt)
├── structure.md                 ← NEW: Structure agent (full production prompt)
├── plan.md                      ← NEW: Plan agent (full production prompt)
├── impl.md                      ← NEW: Impl agent (migrated stub)
├── validate.md                  ← NEW: Validate agent (migrated stub)
├── review.md                    ← NEW: Review agent (migrated stub)
├── pr.md                        ← NEW: PR agent (new stub)
├── classify.md                  ← NEW: Intent classifier (migrated)
└── agent-template.md            ← NEW: Blank starter template
tests/
├── core/
│   ├── agent-config.test.ts     ← NEW
│   ├── repo-context.test.ts     ← NEW
│   ├── agent-runner.test.ts     ← MODIFY: update for new API
│   └── template.test.ts        ← MODIFY: remove loadTemplate tests
```

---

### Task 1: Agent Config Loader

**Files:**
- Create: `src/core/agent-config.ts`
- Create: `tests/core/agent-config.test.ts`

- [ ] **Step 1: Write the failing test — parse valid frontmatter**

```typescript
// tests/core/agent-config.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadAgentConfig } from "../../src/core/agent-config.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-agent-config-" + Date.now());

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("loadAgentConfig", () => {
  it("parses frontmatter and returns config with prompt body", () => {
    writeFileSync(
      join(TEST_DIR, "questions.md"),
      [
        "---",
        "stage: questions",
        "description: Asks targeted technical questions",
        "tools:",
        "  allowed: [Read, Glob, Grep, Bash]",
        "  disallowed: [Write, Edit]",
        "max_turns: 25",
        "timeout_minutes: 15",
        "---",
        "",
        "# Identity",
        "",
        "You are {{AGENT_NAME}}, the questions agent.",
      ].join("\n"),
      "utf-8"
    );

    const config = loadAgentConfig(TEST_DIR, "questions");
    expect(config.stage).toBe("questions");
    expect(config.description).toBe("Asks targeted technical questions");
    expect(config.tools.allowed).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect(config.tools.disallowed).toEqual(["Write", "Edit"]);
    expect(config.maxTurns).toBe(25);
    expect(config.timeoutMinutes).toBe(15);
    expect(config.promptTemplate).toContain("# Identity");
    expect(config.promptTemplate).toContain("You are {{AGENT_NAME}}, the questions agent.");
    expect(config.promptTemplate).not.toContain("---");
    expect(config.promptTemplate).not.toContain("stage: questions");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/agent-config.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/agent-config.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/core/agent-config.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentConfig {
  stage: string;
  description: string;
  tools: {
    allowed: string[];
    disallowed: string[];
  };
  maxTurns?: number;
  timeoutMinutes?: number;
  promptTemplate: string;
}

/**
 * Parses YAML frontmatter from a markdown string.
 * Returns the parsed key-value pairs and the markdown body after the frontmatter.
 */
export function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: content };
  }

  const yamlBlock = match[1];
  const body = match[2].replace(/^\r?\n/, ""); // trim leading blank line after frontmatter
  const meta: Record<string, unknown> = {};

  // Simple YAML parser — handles flat keys, arrays, and one-level nested objects
  const lines = yamlBlock.split(/\r?\n/);
  let currentKey: string | null = null;
  let currentNested: Record<string, unknown> | null = null;

  for (const line of lines) {
    // Nested key-value: "  key: value"
    const nestedMatch = line.match(/^  (\w+):\s*(.+)$/);
    if (nestedMatch && currentKey !== null) {
      if (currentNested === null) {
        currentNested = {};
      }
      const val = nestedMatch[2].trim();
      currentNested[nestedMatch[1]] = parseYamlValue(val);
      meta[currentKey] = currentNested;
      continue;
    }

    // Top-level key: value
    const topMatch = line.match(/^(\w+):\s*(.*)$/);
    if (topMatch) {
      // Save previous nested object
      if (currentKey !== null && currentNested !== null) {
        meta[currentKey] = currentNested;
      }

      currentKey = topMatch[1];
      currentNested = null;
      const val = topMatch[2].trim();

      if (val === "") {
        // Value is on next lines (nested object or block)
        continue;
      }

      meta[currentKey] = parseYamlValue(val);
      currentKey = val === "" ? currentKey : null;
    }
  }

  // Save final nested object
  if (currentKey !== null && currentNested !== null) {
    meta[currentKey] = currentNested;
  }

  return { meta, body };
}

function parseYamlValue(val: string): unknown {
  // Array: [item1, item2, ...]
  if (val.startsWith("[") && val.endsWith("]")) {
    return val
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Number
  if (/^\d+$/.test(val)) {
    return parseInt(val, 10);
  }

  // Boolean
  if (val === "true") return true;
  if (val === "false") return false;

  return val;
}

const DEFAULT_TOOLS = { allowed: ["Read", "Glob", "Grep"], disallowed: [] as string[] };

/**
 * Loads an agent configuration from a markdown file with YAML frontmatter.
 * File path: {agentDir}/{stage}.md
 */
export function loadAgentConfig(agentDir: string, stage: string): AgentConfig {
  const filePath = join(agentDir, `${stage}.md`);
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Agent config not found for stage "${stage}" at "${filePath}". ` +
      `(${err instanceof Error ? err.message : String(err)})`
    );
  }

  const { meta, body } = parseFrontmatter(content);

  const tools = meta.tools as Record<string, unknown> | undefined;

  return {
    stage: (meta.stage as string) ?? stage,
    description: (meta.description as string) ?? "",
    tools: {
      allowed: Array.isArray(tools?.allowed) ? (tools.allowed as string[]) : DEFAULT_TOOLS.allowed,
      disallowed: Array.isArray(tools?.disallowed) ? (tools.disallowed as string[]) : DEFAULT_TOOLS.disallowed,
    },
    maxTurns: typeof meta.max_turns === "number" ? meta.max_turns : undefined,
    timeoutMinutes: typeof meta.timeout_minutes === "number" ? meta.timeout_minutes : undefined,
    promptTemplate: body,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/agent-config.test.ts`
Expected: PASS

- [ ] **Step 5: Write additional tests — edge cases**

Add to `tests/core/agent-config.test.ts`:

```typescript
  it("returns default tools when frontmatter has no tools section", () => {
    writeFileSync(
      join(TEST_DIR, "simple.md"),
      [
        "---",
        "stage: simple",
        "description: A simple agent",
        "---",
        "",
        "Do the thing.",
      ].join("\n"),
      "utf-8"
    );

    const config = loadAgentConfig(TEST_DIR, "simple");
    expect(config.tools.allowed).toEqual(["Read", "Glob", "Grep"]);
    expect(config.tools.disallowed).toEqual([]);
    expect(config.maxTurns).toBeUndefined();
    expect(config.timeoutMinutes).toBeUndefined();
  });

  it("handles file with no frontmatter — entire content is the prompt", () => {
    writeFileSync(
      join(TEST_DIR, "bare.md"),
      "# Just a prompt\n\nNo frontmatter here.",
      "utf-8"
    );

    const config = loadAgentConfig(TEST_DIR, "bare");
    expect(config.stage).toBe("bare");
    expect(config.description).toBe("");
    expect(config.promptTemplate).toContain("# Just a prompt");
  });

  it("throws when agent file does not exist", () => {
    expect(() => loadAgentConfig(TEST_DIR, "nonexistent")).toThrow(
      /Agent config not found/
    );
  });

  it("uses stage parameter as fallback when frontmatter has no stage field", () => {
    writeFileSync(
      join(TEST_DIR, "nostage.md"),
      [
        "---",
        "description: No stage field",
        "---",
        "",
        "Prompt body.",
      ].join("\n"),
      "utf-8"
    );

    const config = loadAgentConfig(TEST_DIR, "nostage");
    expect(config.stage).toBe("nostage");
  });

  it("parses MCP tool glob patterns in allowed tools", () => {
    writeFileSync(
      join(TEST_DIR, "research.md"),
      [
        "---",
        "stage: research",
        "description: Research agent",
        "tools:",
        "  allowed: [Read, Glob, Grep, Bash, WebSearch, WebFetch, mcp__claude_ai_Slack__*, mcp__plugin_notion_notion__*]",
        "  disallowed: [Write, Edit]",
        "---",
        "",
        "Research prompt.",
      ].join("\n"),
      "utf-8"
    );

    const config = loadAgentConfig(TEST_DIR, "research");
    expect(config.tools.allowed).toContain("mcp__claude_ai_Slack__*");
    expect(config.tools.allowed).toContain("mcp__plugin_notion_notion__*");
    expect(config.tools.allowed).toHaveLength(8);
  });
```

- [ ] **Step 6: Run all tests to verify they pass**

Run: `npx vitest run tests/core/agent-config.test.ts`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/agent-config.ts tests/core/agent-config.test.ts
git commit -m "feat: add agent config loader — parse YAML frontmatter from agent markdown files"
```

---

### Task 2: Repo Context Gatherer

**Files:**
- Create: `src/core/repo-context.ts`
- Create: `tests/core/repo-context.test.ts`

- [ ] **Step 1: Write the failing test — Tier 1 convention files**

```typescript
// tests/core/repo-context.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { gatherRepoContext } from "../../src/core/repo-context.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-repo-context-" + Date.now());

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("gatherRepoContext", () => {
  it("returns no-context message when repo path is empty", () => {
    const result = gatherRepoContext("");
    expect(result).toBe("(no repo context available)");
  });

  it("returns no-context message when repo path does not exist", () => {
    const result = gatherRepoContext("/nonexistent/path/12345");
    expect(result).toBe("(no repo context available)");
  });

  it("includes CLAUDE.md content verbatim under Convention Files heading", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Rules\n\n- Use strict mode\n- No any types", "utf-8");

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain("## Repo Context:");
    expect(result).toContain("### Convention Files");
    expect(result).toContain("#### CLAUDE.md");
    expect(result).toContain("- Use strict mode");
    expect(result).toContain("- No any types");
  });

  it("includes multiple convention files when present", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "Claude rules here", "utf-8");
    writeFileSync(join(TEST_DIR, "CONTRIBUTING.md"), "Contributing guidelines", "utf-8");

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain("#### CLAUDE.md");
    expect(result).toContain("Claude rules here");
    expect(result).toContain("#### CONTRIBUTING.md");
    expect(result).toContain("Contributing guidelines");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/repo-context.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/repo-context.js'`

- [ ] **Step 3: Write Tier 1 implementation**

```typescript
// src/core/repo-context.ts
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const CONVENTION_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "CONVENTIONS.md",
  ".editorconfig",
  ".cursorrules",
  ".github/copilot-instructions.md",
];

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function readIfExists(filePath: string): string | null {
  try {
    if (existsSync(filePath)) {
      return readFileSync(filePath, "utf-8");
    }
  } catch {
    // Unreadable — skip
  }
  return null;
}

function gatherTier1(repoPath: string): string {
  const sections: string[] = [];

  for (const file of CONVENTION_FILES) {
    const content = readIfExists(join(repoPath, file));
    if (content !== null && content.trim().length > 0) {
      sections.push(`#### ${file}\n\n${content.trim()}`);
    }
  }

  if (sections.length === 0) return "";
  return `### Convention Files\n\n${sections.join("\n\n")}`;
}

/**
 * Gathers context about a target repository for injection into agent prompts.
 * Uses a tiered strategy: convention files → config signals → repo scan fallback.
 */
export function gatherRepoContext(repoPath: string): string {
  if (!repoPath || !existsSync(repoPath)) {
    return "(no repo context available)";
  }

  const repoName = basename(repoPath);
  const parts: string[] = [];

  const tier1 = gatherTier1(repoPath);
  if (tier1) parts.push(tier1);

  if (parts.length === 0) {
    return "(no repo context available)";
  }

  return `## Repo Context: ${repoName}\n\n${parts.join("\n\n")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/repo-context.test.ts`
Expected: PASS

- [ ] **Step 5: Write Tier 2 tests — config signals**

Add to `tests/core/repo-context.test.ts`:

```typescript
  it("extracts name, scripts, and key dependencies from package.json", () => {
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({
        name: "my-app",
        scripts: { build: "tsc", test: "vitest run", lint: "eslint ." },
        dependencies: { express: "^4.18.0", zod: "^3.22.0" },
        devDependencies: { vitest: "^1.0.0", typescript: "^5.3.0" },
      }),
      "utf-8"
    );

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain("### Stack & Tooling");
    expect(result).toContain("my-app");
    expect(result).toContain("build: tsc");
    expect(result).toContain("test: vitest run");
    expect(result).toContain("express");
    expect(result).toContain("vitest");
  });

  it("extracts compiler options from tsconfig.json", () => {
    writeFileSync(
      join(TEST_DIR, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          strict: true,
          outDir: "./dist",
          paths: { "@/*": ["./src/*"] },
        },
      }),
      "utf-8"
    );

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain("### Stack & Tooling");
    expect(result).toContain("target: ES2022");
    expect(result).toContain("strict: true");
  });

  it("extracts project info from .csproj files", () => {
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "src", "MyApp.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Polly" Version="8.2.0" />
    <PackageReference Include="Serilog" Version="3.1.0" />
  </ItemGroup>
</Project>`,
      "utf-8"
    );

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain("### Stack & Tooling");
    expect(result).toContain("net8.0");
    expect(result).toContain("Polly");
  });
```

- [ ] **Step 6: Implement Tier 2**

Add to `src/core/repo-context.ts`:

```typescript
const CONFIG_FILES_JSON = ["package.json", "tsconfig.json"];

function gatherTier2(repoPath: string): string {
  const sections: string[] = [];

  // package.json
  const pkgContent = readIfExists(join(repoPath, "package.json"));
  if (pkgContent) {
    try {
      const pkg = JSON.parse(pkgContent);
      const lines: string[] = [];
      if (pkg.name) lines.push(`- **Name:** ${pkg.name}`);
      if (pkg.scripts) {
        const scripts = Object.entries(pkg.scripts)
          .map(([k, v]) => `  - ${k}: ${v}`)
          .join("\n");
        lines.push(`- **Scripts:**\n${scripts}`);
      }
      if (pkg.dependencies) {
        lines.push(`- **Dependencies:** ${Object.keys(pkg.dependencies).join(", ")}`);
      }
      if (pkg.devDependencies) {
        lines.push(`- **Dev Dependencies:** ${Object.keys(pkg.devDependencies).join(", ")}`);
      }
      if (lines.length > 0) {
        sections.push(`#### package.json\n\n${lines.join("\n")}`);
      }
    } catch {
      // Invalid JSON — skip
    }
  }

  // tsconfig.json
  const tsContent = readIfExists(join(repoPath, "tsconfig.json"));
  if (tsContent) {
    try {
      const ts = JSON.parse(tsContent);
      const co = ts.compilerOptions;
      if (co) {
        const lines: string[] = [];
        if (co.target) lines.push(`- target: ${co.target}`);
        if (co.module) lines.push(`- module: ${co.module}`);
        if (co.strict !== undefined) lines.push(`- strict: ${co.strict}`);
        if (co.outDir) lines.push(`- outDir: ${co.outDir}`);
        if (co.paths) lines.push(`- paths: ${JSON.stringify(co.paths)}`);
        if (lines.length > 0) {
          sections.push(`#### tsconfig.json\n\n${lines.join("\n")}`);
        }
      }
    } catch {
      // Invalid JSON — skip
    }
  }

  // .csproj files (search top 2 levels)
  const csprojFiles = findFiles(repoPath, /\.csproj$/, 2);
  for (const csprojPath of csprojFiles) {
    const content = readIfExists(csprojPath);
    if (content) {
      const lines: string[] = [];
      const tfMatch = content.match(/<TargetFramework>([^<]+)<\/TargetFramework>/);
      if (tfMatch) lines.push(`- TargetFramework: ${tfMatch[1]}`);
      const nullMatch = content.match(/<Nullable>([^<]+)<\/Nullable>/);
      if (nullMatch) lines.push(`- Nullable: ${nullMatch[1]}`);
      const pkgRefs = [...content.matchAll(/<PackageReference Include="([^"]+)" Version="([^"]+)"/g)];
      if (pkgRefs.length > 0) {
        lines.push(`- Packages: ${pkgRefs.map(m => `${m[1]} ${m[2]}`).join(", ")}`);
      }
      if (lines.length > 0) {
        const relPath = csprojPath.slice(repoPath.length + 1).replace(/\\/g, "/");
        sections.push(`#### ${relPath}\n\n${lines.join("\n")}`);
      }
    }
  }

  // Dockerfile
  const dockerContent = readIfExists(join(repoPath, "Dockerfile"));
  if (dockerContent) {
    const fromLines = dockerContent
      .split("\n")
      .filter((l) => l.match(/^FROM\s/i))
      .map((l) => `- ${l.trim()}`);
    if (fromLines.length > 0) {
      sections.push(`#### Dockerfile\n\n${fromLines.join("\n")}`);
    }
  }

  // .eslintrc* / .prettierrc*
  const lintFiles = [".eslintrc.json", ".eslintrc.js", ".eslintrc.yml", ".prettierrc", ".prettierrc.json"];
  for (const f of lintFiles) {
    if (existsSync(join(repoPath, f))) {
      sections.push(`#### ${f}\n\n(present — linting/formatting configured)`);
    }
  }

  if (sections.length === 0) return "";
  return `### Stack & Tooling\n\n${sections.join("\n\n")}`;
}

/**
 * Finds files matching a pattern within maxDepth levels of the root directory.
 */
function findFiles(root: string, pattern: RegExp, maxDepth: number, depth = 0): string[] {
  if (depth > maxDepth) return [];
  const results: string[] = [];
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(root, entry.name);
      if (entry.isFile() && pattern.test(entry.name)) {
        results.push(full);
      } else if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        results.push(...findFiles(full, pattern, maxDepth, depth + 1));
      }
    }
  } catch {
    // Permission denied or unreadable — skip
  }
  return results;
}
```

Update `gatherRepoContext` to call Tier 2:

```typescript
export function gatherRepoContext(repoPath: string): string {
  if (!repoPath || !existsSync(repoPath)) {
    return "(no repo context available)";
  }

  const repoName = basename(repoPath);
  const parts: string[] = [];
  let totalWords = 0;

  const tier1 = gatherTier1(repoPath);
  if (tier1) {
    parts.push(tier1);
    totalWords += wordCount(tier1);
  }

  const tier2 = gatherTier2(repoPath);
  if (tier2) {
    parts.push(tier2);
    totalWords += wordCount(tier2);
  }

  if (parts.length === 0) {
    return "(no repo context available)";
  }

  // Cap at ~2000 words
  let result = `## Repo Context: ${repoName}\n\n${parts.join("\n\n")}`;
  const words = result.split(/\s+/);
  if (words.length > 2000) {
    result = words.slice(0, 2000).join(" ") + "\n\n(truncated — repo context exceeds 2000 words)";
  }

  return result;
}
```

- [ ] **Step 7: Run tests to verify Tier 2 passes**

Run: `npx vitest run tests/core/repo-context.test.ts`
Expected: All PASS

- [ ] **Step 8: Write Tier 3 tests — repo scan fallback**

Add to `tests/core/repo-context.test.ts`:

```typescript
  it("falls back to directory tree when no convention or config files exist", () => {
    // Create a minimal repo structure with no convention or config files
    mkdirSync(join(TEST_DIR, "src", "controllers"), { recursive: true });
    mkdirSync(join(TEST_DIR, "src", "models"), { recursive: true });
    mkdirSync(join(TEST_DIR, "tests"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src", "controllers", "app.ts"), "export class App {}", "utf-8");
    writeFileSync(join(TEST_DIR, "README.md"), "# My Project\n\nA cool project.", "utf-8");

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain("### Project Structure");
    expect(result).toContain("src/");
    expect(result).toContain("tests/");
    expect(result).toContain("# My Project");
  });

  it("does NOT include Tier 3 when Tier 1+2 have sufficient content", () => {
    // CLAUDE.md with 300+ words should suppress Tier 3
    const longContent = "# Conventions\n\n" + "This is a rule. ".repeat(150);
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), longContent, "utf-8");
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain("### Convention Files");
    expect(result).not.toContain("### Project Structure");
  });
```

- [ ] **Step 9: Implement Tier 3**

Add to `src/core/repo-context.ts`:

```typescript
function gatherTier3(repoPath: string): string {
  const sections: string[] = [];

  // Directory tree (top 3 levels)
  const tree = buildDirTree(repoPath, 3);
  if (tree.length > 0) {
    sections.push(`#### Directory Structure\n\n\`\`\`\n${tree.join("\n")}\n\`\`\``);
  }

  // README.md excerpt
  const readme = readIfExists(join(repoPath, "README.md"));
  if (readme) {
    const excerpt = readme.split("\n").slice(0, 30).join("\n").trim();
    sections.push(`#### README.md (excerpt)\n\n${excerpt}`);
  }

  if (sections.length === 0) return "";
  return `### Project Structure\n\n${sections.join("\n\n")}`;
}

function buildDirTree(root: string, maxDepth: number, prefix = "", depth = 0): string[] {
  if (depth >= maxDepth) return [];
  const lines: string[] = [];

  try {
    const entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "dist")
      .sort((a, b) => {
        // Directories first
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        lines.push(`${prefix}${entry.name}/`);
        lines.push(...buildDirTree(join(root, entry.name), maxDepth, prefix + "  ", depth + 1));
      } else {
        lines.push(`${prefix}${entry.name}`);
      }
    }
  } catch {
    // Unreadable — skip
  }

  return lines;
}
```

Update `gatherRepoContext` to conditionally call Tier 3:

```typescript
  // Tier 3: only if Tiers 1+2 are thin
  if (totalWords < 200) {
    const tier3 = gatherTier3(repoPath);
    if (tier3) parts.push(tier3);
  }
```

- [ ] **Step 10: Run all tests to verify**

Run: `npx vitest run tests/core/repo-context.test.ts`
Expected: All PASS

- [ ] **Step 11: Commit**

```bash
git add src/core/repo-context.ts tests/core/repo-context.test.ts
git commit -m "feat: add tiered repo context gatherer — convention files, config signals, and fallback scan"
```

---

### Task 3: Update Config — Add agentsDir and agents.tools

**Files:**
- Modify: `src/config/defaults.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/loader.ts`
- Modify: `tests/config/defaults.test.ts`

- [ ] **Step 1: Write the failing test — agentsDir in defaults**

Add to `tests/config/defaults.test.ts`:

```typescript
it("DEFAULT_CONFIG includes pipeline.agentsDir as empty string", () => {
  expect(DEFAULT_CONFIG.pipeline.agentsDir).toBe("");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config/defaults.test.ts`
Expected: FAIL — `agentsDir` does not exist on the type

- [ ] **Step 3: Add agentsDir to defaults and config types**

In `src/config/defaults.ts`, add `agentsDir` to the `ShkmnConfig.pipeline` interface and `DEFAULT_CONFIG`:

```typescript
// In the ShkmnConfig interface, pipeline section:
pipeline: {
  runtimeDir: string;
  agentsDir: string;
  dashboardRepoLocal: string;
  dashboardRepoUrl: string;
};
```

```typescript
// In DEFAULT_CONFIG, pipeline section:
pipeline: {
  runtimeDir: "",
  agentsDir: "",
  dashboardRepoLocal: "",
  dashboardRepoUrl: "",
},
```

In `src/config/schema.ts`, add to the pipeline schema:

```typescript
pipeline: z.object({
  runtimeDir: z.string().min(1, "pipeline.runtimeDir is required"),
  agentsDir: z.string().optional().default(""),
  dashboardRepoLocal: z.string().optional().default(""),
  dashboardRepoUrl: z.string().optional().default(""),
}),
```

In `src/config/loader.ts`, update the `ResolvedConfig` interface and `resolveConfig`:

```typescript
// In ResolvedConfig, pipeline section:
pipeline: {
  runtimeDir: string;
  agentsDir: string;
  dashboardRepoLocal: string;
  dashboardRepoUrl: string;
};

// In resolveConfig(), pipeline section:
pipeline: {
  runtimeDir: parsed.pipeline.runtimeDir,
  agentsDir: parsed.pipeline.agentsDir ?? d.pipeline.agentsDir,
  dashboardRepoLocal: parsed.pipeline.dashboardRepoLocal ?? d.pipeline.dashboardRepoLocal,
  dashboardRepoUrl: parsed.pipeline.dashboardRepoUrl ?? d.pipeline.dashboardRepoUrl,
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config/defaults.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite to check for breakage**

Run: `npx vitest run`
Expected: All PASS (existing tests should not break — `agentsDir` defaults to empty string)

- [ ] **Step 6: Commit**

```bash
git add src/config/defaults.ts src/config/schema.ts src/config/loader.ts tests/config/defaults.test.ts
git commit -m "feat: add pipeline.agentsDir config field for agent markdown file directory"
```

---

### Task 4: Update Template Module — Remove loadTemplate

**Files:**
- Modify: `src/core/template.ts`
- Modify: `tests/core/template.test.ts`

- [ ] **Step 1: Remove `loadTemplate` from template.ts**

Edit `src/core/template.ts` — remove the `loadTemplate` function and its import of `readFileSync` and `join`. Keep only `hydrateTemplate`:

```typescript
// src/core/template.ts
export function hydrateTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return vars[key] !== undefined ? vars[key] : match;
  });
}
```

- [ ] **Step 2: Remove loadTemplate tests from template.test.ts**

Edit `tests/core/template.test.ts`:
- Remove the entire `describe("loadTemplate", ...)` block
- Remove unused imports: `mkdirSync`, `rmSync`, `writeFileSync`, `existsSync`, `join`, `tmpdir`
- Remove `TEST_DIR`, `beforeEach`, `afterEach`
- Remove `loadTemplate` from the import
- Keep only the `hydrateTemplate` tests

The file should start with:

```typescript
import { describe, it, expect } from "vitest";
import { hydrateTemplate } from "../../src/core/template.js";

describe("hydrateTemplate", () => {
  // ... all existing hydrateTemplate tests unchanged ...
});
```

- [ ] **Step 3: Run tests to verify**

Run: `npx vitest run tests/core/template.test.ts`
Expected: All PASS (only hydrateTemplate tests remain)

- [ ] **Step 4: Commit**

```bash
git add src/core/template.ts tests/core/template.test.ts
git commit -m "refactor: remove loadTemplate from template.ts — replaced by agent-config loader"
```

---

### Task 5: Rewire Agent Runner

**Files:**
- Modify: `src/core/agent-runner.ts`
- Modify: `tests/core/agent-runner.test.ts`

This is the largest task. The agent runner currently uses `loadTemplate()` + hardcoded `STAGE_TOOL_MAP`. It needs to use `loadAgentConfig()` + `gatherRepoContext()` + 3 new template variables.

- [ ] **Step 1: Write the failing tests for new behavior**

Replace `tests/core/agent-runner.test.ts` entirely:

```typescript
// tests/core/agent-runner.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildSystemPrompt, resolveToolPermissions, resolveMaxTurns, resolveTimeoutMinutes } from "../../src/core/agent-runner.js";
import { configSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/loader.js";
import type { AgentRunOptions } from "../../src/core/types.js";

// ─── helpers ────────────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), "shkmn-test-agent-runner-" + Date.now());
const AGENTS_DIR = join(TEST_DIR, "agents");
const REPO_DIR = join(TEST_DIR, "repo");

function makeConfig(overrides?: { agentsDir?: string; agentNames?: Record<string, string> }) {
  const parsed = configSchema.parse({
    pipeline: {
      runtimeDir: "/tmp/rt",
      agentsDir: overrides?.agentsDir ?? AGENTS_DIR,
    },
    agents: overrides?.agentNames ? { names: overrides.agentNames } : undefined,
  });
  return resolveConfig(parsed);
}

function writeAgentMd(stage: string, content: string) {
  writeFileSync(join(AGENTS_DIR, `${stage}.md`), content, "utf-8");
}

beforeEach(() => {
  mkdirSync(AGENTS_DIR, { recursive: true });
  mkdirSync(REPO_DIR, { recursive: true });
});
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

// ─── buildSystemPrompt ───────────────────────────────────────────────────────

describe("buildSystemPrompt", () => {
  function makeOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
    return {
      stage: "questions",
      slug: "my-task",
      taskContent: "Build the feature",
      previousOutput: "",
      outputPath: "/tmp/output/questions.md",
      cwd: "/tmp/cwd",
      config: makeConfig(),
      templateDir: "", // no longer used
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      ...overrides,
    };
  }

  it("loads prompt from agent config file and hydrates all variables", () => {
    writeAgentMd("questions", [
      "---",
      "stage: questions",
      "description: Questions agent",
      "tools:",
      "  allowed: [Read, Glob, Grep]",
      "  disallowed: [Write]",
      "---",
      "",
      "Agent: {{AGENT_NAME}} | Role: {{AGENT_ROLE}} | Task: {{TASK_CONTENT}} | Prev: {{PREVIOUS_OUTPUT}} | Out: {{OUTPUT_PATH}} | Ctx: {{PIPELINE_CONTEXT}} | Repo: {{REPO_CONTEXT}} | RepoPath: {{REPO_PATH}} | Stages: {{STAGE_LIST}}",
    ].join("\n"));

    const config = makeConfig();
    const result = buildSystemPrompt(makeOptions({ config }));

    expect(result).toContain("Agent: Narada");
    expect(result).toContain("Role: questions");
    expect(result).toContain("Task: Build the feature");
    expect(result).toContain("Prev: (none)");
    expect(result).toContain("Out: /tmp/output/questions.md");
    expect(result).toContain("Pipeline: ShaktimaanAI");
    expect(result).toContain("Repo:");
    expect(result).toContain("Stages:");
  });

  it("injects repo context when task has a repo path with CLAUDE.md", () => {
    writeFileSync(join(REPO_DIR, "CLAUDE.md"), "# Rules\n- Be strict", "utf-8");

    writeAgentMd("questions", [
      "---",
      "stage: questions",
      "description: test",
      "---",
      "",
      "RepoCtx: {{REPO_CONTEXT}}",
    ].join("\n"));

    // Simulate a task with repo path
    const config = makeConfig();
    const taskContent = `# Task: Test\n\n## What I want done\nDo stuff\n\n## Repo\n${REPO_DIR}`;
    const result = buildSystemPrompt(makeOptions({ config, taskContent }));

    expect(result).toContain("# Rules");
    expect(result).toContain("- Be strict");
  });

  it("uses custom agent name from config override", () => {
    writeAgentMd("impl", [
      "---",
      "stage: impl",
      "description: test",
      "---",
      "",
      "Agent: {{AGENT_NAME}}",
    ].join("\n"));

    const config = makeConfig({ agentNames: { impl: "MyCustomAgent" } });
    const result = buildSystemPrompt(makeOptions({ stage: "impl", config }));
    expect(result).toContain("Agent: MyCustomAgent");
  });
});

// ─── resolveToolPermissions ───────────────────────────────────────────────────

describe("resolveToolPermissions", () => {
  it("returns tools from agent config when no config override exists", () => {
    const agentTools = { allowed: ["Read", "Bash"], disallowed: ["Write"] };
    const config = makeConfig();
    const result = resolveToolPermissions("questions", agentTools, config);
    expect(result.allowed).toEqual(["Read", "Bash"]);
    expect(result.disallowed).toEqual(["Write"]);
  });

  it("returns default read-only tools when agent config has no tools", () => {
    const agentTools = { allowed: [] as string[], disallowed: [] as string[] };
    const config = makeConfig();
    const result = resolveToolPermissions("questions", agentTools, config);
    expect(result.allowed).toEqual(["Read", "Glob", "Grep"]);
  });
});

// ─── resolveMaxTurns / resolveTimeoutMinutes ─────────────────────────────────

describe("resolveMaxTurns", () => {
  it("prefers config value over agent config value", () => {
    const config = makeConfig();
    // config.agents.maxTurns.questions is 15 (from defaults)
    const result = resolveMaxTurns("questions", 25, config);
    expect(result).toBe(15);
  });

  it("uses agent config value when no config override", () => {
    const config = makeConfig();
    // "custom" stage has no entry in config.agents.maxTurns
    const result = resolveMaxTurns("custom", 25, config);
    expect(result).toBe(25);
  });

  it("falls back to 30 when neither source has a value", () => {
    const config = makeConfig();
    const result = resolveMaxTurns("custom", undefined, config);
    expect(result).toBe(30);
  });
});

describe("resolveTimeoutMinutes", () => {
  it("prefers config value over agent config value", () => {
    const config = makeConfig();
    // config.agents.timeoutsMinutes.questions is 15 (from defaults)
    const result = resolveTimeoutMinutes("questions", 20, config);
    expect(result).toBe(15);
  });

  it("falls back to 30 when neither source has a value", () => {
    const config = makeConfig();
    const result = resolveTimeoutMinutes("custom", undefined, config);
    expect(result).toBe(30);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/agent-runner.test.ts`
Expected: FAIL — missing exports `resolveToolPermissions`, `resolveMaxTurns`, `resolveTimeoutMinutes`, and `buildSystemPrompt` has wrong behavior

- [ ] **Step 3: Rewrite agent-runner.ts**

```typescript
// src/core/agent-runner.ts
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentConfig } from "./agent-config.js";
import { gatherRepoContext } from "./repo-context.js";
import { hydrateTemplate } from "./template.js";
import { parseTaskFile } from "../task/parser.js";
import type { ResolvedConfig } from "../config/loader.js";
import type { AgentRunOptions, AgentRunResult } from "./types.js";

// ─── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];
const DEFAULT_MAX_TURNS = 30;
const DEFAULT_TIMEOUT_MINUTES = 30;

// ─── Resolution helpers (exported for testing) ─────────────────────────────

export function resolveToolPermissions(
  stage: string,
  agentTools: { allowed: string[]; disallowed: string[] },
  _config: ResolvedConfig,
): { allowed: string[]; disallowed: string[] } {
  // Agent config tools are the source of truth (from agents/{stage}.md frontmatter).
  // If the agent config has no tools, fall back to read-only defaults.
  const allowed = agentTools.allowed.length > 0 ? agentTools.allowed : DEFAULT_READ_ONLY_TOOLS;
  const disallowed = agentTools.disallowed;
  return { allowed, disallowed };
}

export function resolveMaxTurns(
  stage: string,
  agentMaxTurns: number | undefined,
  config: ResolvedConfig,
): number {
  return config.agents.maxTurns[stage] ?? agentMaxTurns ?? DEFAULT_MAX_TURNS;
}

export function resolveTimeoutMinutes(
  stage: string,
  agentTimeout: number | undefined,
  config: ResolvedConfig,
): number {
  return config.agents.timeoutsMinutes[stage] ?? agentTimeout ?? DEFAULT_TIMEOUT_MINUTES;
}

// ─── System prompt builder ───────────────────────────────────────────────────

/**
 * Loads the agent config, gathers repo context, and hydrates the prompt template.
 */
export function buildSystemPrompt(options: AgentRunOptions): string {
  const { stage, slug, taskContent, previousOutput, outputPath, config } = options;

  // Determine agents directory — prefer config, fall back to shipped agents/
  const agentsDir = config.pipeline.agentsDir || findShippedAgentsDir();
  const agentConfig = loadAgentConfig(agentsDir, stage);

  // Extract repo path from task content
  const taskMeta = parseTaskFile(taskContent);
  const repoPath = taskMeta.repo;

  // Gather repo context
  const repoContext = gatherRepoContext(repoPath);

  // Resolve agent display name from config
  const agentName = config.agents.names[stage] ?? stage;

  // Build stage list from task meta
  const stageList = taskMeta.stages.length > 0
    ? taskMeta.stages.join(", ")
    : config.agents.defaultStages.join(", ");

  const vars: Record<string, string> = {
    AGENT_NAME: agentName,
    AGENT_ROLE: stage,
    TASK_CONTENT: taskContent,
    PREVIOUS_OUTPUT: previousOutput || "(none)",
    OUTPUT_PATH: outputPath,
    PIPELINE_CONTEXT: `Pipeline: ShaktimaanAI | Task: ${slug} | Stage: ${stage}`,
    REPO_CONTEXT: repoContext,
    REPO_PATH: repoPath || "(no repo)",
    STAGE_LIST: stageList,
  };

  return hydrateTemplate(agentConfig.promptTemplate, vars);
}

/**
 * Find the shipped agents/ directory relative to the package root.
 */
function findShippedAgentsDir(): string {
  // In ESM, resolve relative to this file (src/core/ or dist/) — go up to project root
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const projectRoot = join(thisDir, "..", "..");
    return join(projectRoot, "agents");
  } catch {
    return join(process.cwd(), "agents");
  }
}

// ─── Agent runner ────────────────────────────────────────────────────────────

/**
 * Runs the Claude agent SDK for the given stage and options.
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const { stage, cwd, config, logger, abortController: externalAbort } = options;

  const startMs = Date.now();
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  // Load agent config for tool permissions and timeouts
  const agentsDir = config.pipeline.agentsDir || findShippedAgentsDir();
  const agentConfig = loadAgentConfig(agentsDir, stage);

  const { allowed: allowedTools, disallowed: disallowedTools } = resolveToolPermissions(
    stage, agentConfig.tools, config,
  );
  const systemPrompt = buildSystemPrompt(options);

  const maxTurns = resolveMaxTurns(stage, agentConfig.maxTurns, config);
  const timeoutMinutes = resolveTimeoutMinutes(stage, agentConfig.timeoutMinutes, config);
  const timeoutMs = timeoutMinutes * 60 * 1000;

  const abortController = externalAbort ?? new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  timeoutHandle = setTimeout(() => {
    logger.warn(`[agent-runner] Stage "${stage}" timed out after ${timeoutMinutes}m — aborting`);
    abortController.abort();
  }, timeoutMs);

  try {
    let output = "";
    let costUsd = 0;
    let turns = 0;
    let receivedResult = false;

    const messages = query({
      prompt: systemPrompt,
      allowedTools,
      disallowedTools,
      maxTurns,
      cwd,
      abortController,
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
    });

    for await (const message of messages) {
      if (message.type === "result") {
        receivedResult = true;
        if (message.subtype === "success") {
          const msg = message as Record<string, unknown>;
          output = typeof msg.result === "string" ? msg.result : "";
          costUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
          turns = typeof msg.num_turns === "number" ? msg.num_turns : 0;
        } else {
          const msg = message as Record<string, unknown>;
          const errors = Array.isArray(msg.errors) ? (msg.errors as string[]) : [];
          return {
            success: false,
            output: "",
            costUsd: 0,
            turns: 0,
            durationMs: Date.now() - startMs,
            error: errors.join("; ") || "Agent returned error result",
          };
        }
      }
    }

    if (!receivedResult) {
      return {
        success: false,
        output: "",
        costUsd: 0,
        turns: 0,
        durationMs: Date.now() - startMs,
        error: "No result message received from agent — stream completed without a result",
      };
    }

    return { success: true, output, costUsd, turns, durationMs: Date.now() - startMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[agent-runner] Stage "${stage}" threw: ${message}`);
    return {
      success: false,
      output: "",
      costUsd: 0,
      turns: 0,
      durationMs: Date.now() - startMs,
      error: message,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}
```

Wait — the `findShippedAgentsDir` function above has a duplicate definition and uses `require` which is wrong for ESM. Let me fix this. The actual implementation should be:

```typescript
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function findShippedAgentsDir(): string {
  // In ESM, resolve relative to project root (2 levels up from src/core/)
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    // thisDir is dist/ or src/core/ — go up to project root
    const projectRoot = join(thisDir, "..", "..");
    return join(projectRoot, "agents");
  } catch {
    return join(process.cwd(), "agents");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/agent-runner.test.ts`
Expected: All PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All PASS. If other tests import `getStageTools` or `loadTemplate` (removed), fix those imports.

- [ ] **Step 6: Commit**

```bash
git add src/core/agent-runner.ts tests/core/agent-runner.test.ts
git commit -m "refactor: rewire agent runner to use agent-config loader and repo context gatherer"
```

---

### Task 6: Create Agent Markdown Files — Stubs (Non-Alignment)

Migrate the existing prompt content from `src/templates/` to `agents/` for stages that are NOT being rewritten in this spec (impl, validate, review, pr, classify). Also create the agent-template.md.

**Files:**
- Create: `agents/impl.md`
- Create: `agents/validate.md`
- Create: `agents/review.md`
- Create: `agents/pr.md`
- Create: `agents/classify.md`
- Create: `agents/agent-template.md`

- [ ] **Step 1: Create agents/impl.md**

```markdown
---
stage: impl
description: Executes implementation plan using strict TDD — red-green-refactor per slice
tools:
  allowed: [Read, Write, Edit, Bash, Glob, Grep]
  disallowed: []
max_turns: 60
timeout_minutes: 90
---

# Identity

You are {{AGENT_NAME}}, the implementation agent in the ShaktimaanAI pipeline.

## Pipeline Context

{{PIPELINE_CONTEXT}}

## Task

{{TASK_CONTENT}}

## Implementation Plan

{{PREVIOUS_OUTPUT}}

## Repo Context

{{REPO_CONTEXT}}

## Instructions

Execute the implementation plan above using strict Test-Driven Development. For every unit of work:

1. **Write the test first** — create or update the test file with a failing test that describes the desired behavior
2. **Run the test** — confirm it fails for the right reason
3. **Write the minimum code** to make the test pass
4. **Run the test again** — confirm it passes
5. **Refactor** if needed, keeping tests green

Rules:
- Never write production code before a failing test exists for it
- Tests must follow the project's existing test patterns
- Export only what is specified in the plan
- Do not add dependencies not listed in the project's package manifest
- Commit nothing — produce the final file contents only

After completing all slices, output a summary listing: files created/modified, tests added, and any deviations from the plan with justification.

## Output Path

{{OUTPUT_PATH}}
```

- [ ] **Step 2: Create agents/validate.md**

```markdown
---
stage: validate
description: Discovers and runs build/test commands, reports pass/fail status
tools:
  allowed: [Read, Bash, Glob, Grep]
  disallowed: [Write, Edit]
max_turns: 10
timeout_minutes: 15
---

# Identity

You are {{AGENT_NAME}}, the validation agent in the ShaktimaanAI pipeline.

## Pipeline Context

{{PIPELINE_CONTEXT}}

## Task

{{TASK_CONTENT}}

## Implementation Output

{{PREVIOUS_OUTPUT}}

## Repo Context

{{REPO_CONTEXT}}

## Instructions

Your job is to discover and run the project's build and test commands, then report the results.

Steps:
1. **Discover commands** — inspect build configs (package.json, Makefile, .csproj, etc.) to find the correct build and test commands
2. **Run build** — execute the build command and capture output
3. **Run tests** — execute the test command and capture output
4. **Analyse results** — identify any failures, errors, or warnings
5. **Report** — produce a structured validation report

The validation report must include:
- **Build status** — PASS or FAIL with full command output
- **Test status** — PASS or FAIL with full test output
- **Failures** — each failing test or build error listed with file, line, and message
- **Coverage summary** — if available
- **Verdict** — READY_FOR_REVIEW or NEEDS_FIXES

If tests fail, do not attempt to fix them — report the failures and halt.

## Output Path

{{OUTPUT_PATH}}
```

- [ ] **Step 3: Create agents/review.md**

```markdown
---
stage: review
description: Performs thorough code quality review of implementation changes
tools:
  allowed: [Read, Glob, Grep]
  disallowed: [Write, Edit, Bash]
max_turns: 30
timeout_minutes: 45
---

# Identity

You are {{AGENT_NAME}}, the review agent in the ShaktimaanAI pipeline.

## Pipeline Context

{{PIPELINE_CONTEXT}}

## Task

{{TASK_CONTENT}}

## Validation Report

{{PREVIOUS_OUTPUT}}

## Repo Context

{{REPO_CONTEXT}}

## Instructions

Perform a thorough code quality review of the implementation. You have access to all changed files and the validation report from the previous stage.

Review criteria:
- **Correctness** — does the code do what the task requires?
- **Test quality** — are tests meaningful, isolated, and complete?
- **Type safety** — are types precise? Is `any` avoided? Are return types explicit?
- **Error handling** — are all error paths covered and handled gracefully?
- **Code clarity** — are names descriptive? Is logic easy to follow?
- **SOLID principles** — are functions small and single-purpose?
- **Security** — are there any obvious vulnerabilities?
- **Performance** — are there any obvious inefficiencies?
- **Consistency** — does the code follow existing project conventions?

For each finding, classify it as:
- `MUST_FIX` — blocks merge
- `SHOULD_FIX` — important but not blocking
- `SUGGESTION` — optional improvement

End the review with a **Verdict**: `APPROVED`, `APPROVED_WITH_SUGGESTIONS`, or `CHANGES_REQUIRED`.

## Output Path

{{OUTPUT_PATH}}
```

- [ ] **Step 4: Create agents/pr.md**

```markdown
---
stage: pr
description: Creates a branch, pushes code, and opens a pull request
tools:
  allowed: [Bash]
  disallowed: [Write, Edit]
max_turns: 15
timeout_minutes: 10
---

# Identity

You are {{AGENT_NAME}}, the PR agent in the ShaktimaanAI pipeline.

## Pipeline Context

{{PIPELINE_CONTEXT}}

## Task

{{TASK_CONTENT}}

## Review Output

{{PREVIOUS_OUTPUT}}

## Instructions

Create and push a pull request for the completed implementation.

Steps:
1. **Verify** — ensure the working tree is clean and all changes are committed
2. **Push** — push the branch to the remote
3. **Create PR** — use `gh pr create` with a clear title and structured body
4. **Link** — if an ADO work item ID is present in the task, link it in the PR body

PR body structure:
- Summary (1-3 bullet points)
- Test plan (what was tested and how)
- Link to ADO item (if applicable)

Output the PR URL when done.

## Output Path

{{OUTPUT_PATH}}
```

- [ ] **Step 5: Create agents/classify.md**

```markdown
---
stage: classify
description: Classifies intent of freeform input into structured task metadata
tools:
  allowed: []
  disallowed: [Read, Write, Edit, Bash, Glob, Grep]
max_turns: 5
timeout_minutes: 2
---

# Identity

You are {{AGENT_NAME}}, the intent classifier in the ShaktimaanAI pipeline.

## Pipeline Context

{{PIPELINE_CONTEXT}}

## Input

{{TASK_CONTENT}}

## Instructions

Classify the intent of the input above. Analyse the content and determine what type of task or request it represents.

Output ONLY valid JSON. No markdown, no explanation, no code fences. The JSON object must have exactly these fields:

- `intent` — string, one of: `"implement"`, `"bugfix"`, `"refactor"`, `"docs"`, `"question"`, `"unknown"`
- `confidence` — number between 0.0 and 1.0 representing classification confidence
- `extractedSlug` — string, a short kebab-case identifier derived from the task (e.g., `"add-user-auth"`)
- `extractedContent` — string, the full cleaned task content to pass into the pipeline

Example output:
{"intent":"implement","confidence":0.95,"extractedSlug":"add-template-hydrator","extractedContent":"Add a template hydration module that replaces {{VAR}} placeholders in markdown templates."}

## Previous Output

{{PREVIOUS_OUTPUT}}
```

- [ ] **Step 6: Create agents/agent-template.md**

```markdown
---
stage: STAGE_NAME
description: Brief description of what this agent does
tools:
  allowed: [Read, Glob, Grep]
  disallowed: [Write, Edit, Bash]
max_turns: 30
timeout_minutes: 30
---

# Identity

You are {{AGENT_NAME}}, the STAGE_NAME agent in the ShaktimaanAI pipeline.

## Pipeline Context

{{PIPELINE_CONTEXT}}

## Task

{{TASK_CONTENT}}

## Previous Output

{{PREVIOUS_OUTPUT}}

## Repo Context

{{REPO_CONTEXT}}

## Instructions

[Describe the agent's purpose and responsibilities here.]

[Describe the inputs the agent receives and what it should do with them.]

[Describe the expected output format.]

## Self-Validation

Before finishing, verify:
- [List verification checks here]

## Output Path

{{OUTPUT_PATH}}
```

- [ ] **Step 7: Commit**

```bash
git add agents/impl.md agents/validate.md agents/review.md agents/pr.md agents/classify.md agents/agent-template.md
git commit -m "feat: create agent markdown files for non-alignment stages (stubs migrated from src/templates/)"
```

---

### Task 7: Create Agent Markdown Files — Questions Agent (Production Prompt)

**Files:**
- Create: `agents/questions.md`

- [ ] **Step 1: Create agents/questions.md**

```markdown
---
stage: questions
description: Asks targeted technical questions to prevent wrong assumptions before implementation
tools:
  allowed: [Read, Glob, Grep, Bash, WebSearch, WebFetch]
  disallowed: [Write, Edit]
max_turns: 30
timeout_minutes: 20
---

# Identity

You are {{AGENT_NAME}}, the questions agent in the ShaktimaanAI pipeline.

Your questions will be handed to the research agent, who will investigate them. Your questions are the ONLY input the research agent receives alongside the original task. The research agent will NOT see this prompt or your reasoning — only your output.

## Pipeline Context

{{PIPELINE_CONTEXT}}

Stage sequence for this task: {{STAGE_LIST}}

## Repo Context

{{REPO_CONTEXT}}

## Task

{{TASK_CONTENT}}

## Instructions

Your purpose is to prevent the "plan-reading illusion" — where a plan looks correct but is built on wrong assumptions about the codebase. You do this by generating questions that surface the unknowns.

### Phase 1: Investigate the Codebase

Before generating questions, investigate the target repository:

1. Scan the directory structure — understand the project layout
2. Read files in the area the task touches — understand existing patterns
3. Check existing tests — understand the testing approach
4. Look at recent git history in relevant areas — understand what's been changing
5. Check build configuration — understand the toolchain

Use this investigation to generate INFORMED questions — not naive ones you could have answered yourself.

### Phase 2: Generate Questions

Generate questions in each of the following categories. You MUST have at least one question per category.

**Existing Patterns**
How does the codebase currently handle things similar to what this task requires? What conventions are already established?

**Integration Points**
What existing code will this change touch, call into, or depend on? What interfaces or contracts must be respected?

**Constraints**
What rules, conventions, or technical limitations apply? Are there files, modules, or patterns that must not be modified?

**Ambiguity**
What is underspecified in the task description that could lead to two different (both reasonable) implementations? What assumptions need to be validated?

**Risk**
What could this change break? What are the edge cases? Are there performance or security implications?

**Dependencies**
What external libraries, APIs, or services are involved? Are there version constraints or compatibility concerns?

## Self-Validation

Before finishing, verify:
- You have at least one question in EVERY category above
- Each question is specific enough that the research agent can investigate it concretely (not "is the code good?" but "does UserService.create() validate email format before insertion?")
- You have not included questions you already answered during your codebase investigation
- Questions reference actual files, modules, or patterns you observed — not hypothetical ones

## Output Format

Output a categorized markdown list. One question per line, prefixed with `-`. Group under category headings.

```
## Existing Patterns
- [question]
- [question]

## Integration Points
- [question]

## Constraints
- [question]

## Ambiguity
- [question]

## Risk
- [question]

## Dependencies
- [question]
```

Write your output to: {{OUTPUT_PATH}}
```

- [ ] **Step 2: Commit**

```bash
git add agents/questions.md
git commit -m "feat: add production prompt for questions agent"
```

---

### Task 8: Create Agent Markdown Files — Research Agent (Production Prompt)

**Files:**
- Create: `agents/research.md`

- [ ] **Step 1: Create agents/research.md**

```markdown
---
stage: research
description: Investigates codebase, web, Slack, and Notion to answer questions with cited evidence
tools:
  allowed: [Read, Glob, Grep, Bash, WebSearch, WebFetch, mcp__claude_ai_Slack__*, mcp__plugin_notion_notion__*]
  disallowed: [Write, Edit]
max_turns: 30
timeout_minutes: 45
---

# Identity

You are {{AGENT_NAME}}, the research agent in the ShaktimaanAI pipeline.

You are a factual investigator. You record evidence without judgment. You do NOT design solutions, propose architectures, or make recommendations. You gather and cite facts.

## Pipeline Context

{{PIPELINE_CONTEXT}}

Stage sequence for this task: {{STAGE_LIST}}

## Repo Context

{{REPO_CONTEXT}}

## Questions to Investigate

{{PREVIOUS_OUTPUT}}

## Task (for reference)

{{TASK_CONTENT}}

## Instructions

You have been given a list of technical questions from the questions agent. Your job is to investigate each one and provide a factual, evidence-backed answer.

### Investigation Protocol

For each question, follow this search order:

1. **Codebase first** — use Grep, Glob, and Read to find relevant code. Check file contents, function signatures, type definitions, and test files.
2. **Git history** — use `git log`, `git blame`, and `git diff` to understand recent changes, who changed what, and why.
3. **Web search** — use WebSearch and WebFetch for external API documentation, library docs, migration guides, or known issues.
4. **Slack** — search Slack channels for relevant team discussions, decisions, or context using the Slack MCP tools.
5. **Notion** — search Notion for existing design documents, ADRs, or decision records using the Notion MCP tools.

### Evidence Standards

- **Every finding must have a citation.** File path with line number, URL, Slack message link, or Notion page reference.
- **If conflicting evidence exists**, report BOTH sides. Do not pick a winner — the design agent will resolve conflicts.
- **If a question cannot be answered**, state `NOT FOUND` and list exactly what you searched (file patterns, grep queries, web searches attempted).
- **Confidence rating** for each answer:
  - `HIGH` — direct evidence found (code, docs, explicit statements)
  - `MEDIUM` — indirect evidence or inference from patterns
  - `LOW` — limited evidence, partially answered

### What NOT To Do

- Do NOT propose solutions or designs
- Do NOT suggest implementation approaches
- Do NOT skip questions — address every single one
- Do NOT speculate beyond what evidence supports

## Self-Validation

Before finishing, verify:
- Every question from the input has a corresponding numbered answer
- Every answer includes at least one citation (file:line, URL, or "NOT FOUND" with search details)
- Conflicting evidence is explicitly flagged, not silently resolved
- No answer contains design recommendations or implementation suggestions

## Output Format

Numbered list matching the input questions exactly. For each:

```
### Q1: [Original question text]

**Finding:** [Factual answer]

**Evidence:**
- `src/services/user-service.ts:45` — UserService.create() calls validate() before insert
- `git log --oneline -5 src/services/` — last modified 2026-03-28 by @dev

**Confidence:** HIGH
```

Repeat for every question. Do not skip any.

Write your output to: {{OUTPUT_PATH}}
```

- [ ] **Step 2: Commit**

```bash
git add agents/research.md
git commit -m "feat: add production prompt for research agent"
```

---

### Task 9: Create Agent Markdown Files — Design Agent (Production Prompt)

**Files:**
- Create: `agents/design.md`

- [ ] **Step 1: Create agents/design.md**

```markdown
---
stage: design
description: Produces dual-track architectural design — faithful to task and adapted based on research
tools:
  allowed: [Read, Glob, Grep, Bash]
  disallowed: [Write, Edit]
max_turns: 20
timeout_minutes: 30
---

# Identity

You are {{AGENT_NAME}}, the design agent in the ShaktimaanAI pipeline.

You produce architectural designs that implementation agents can execute without ambiguity. You work from research evidence, not assumptions.

## Pipeline Context

{{PIPELINE_CONTEXT}}

Stage sequence for this task: {{STAGE_LIST}}

## Repo Context

{{REPO_CONTEXT}}

## Task

{{TASK_CONTENT}}

## Research Findings

{{PREVIOUS_OUTPUT}}

## Instructions

### Phase 1: Synthesize Research

Before designing, create a brief "What We Know" summary:
- Key facts established by research
- Existing patterns that must be followed
- Constraints and limitations discovered
- Any conflicting evidence and how you resolve it
- Unanswered questions and what you assume in their absence

### Phase 2: Design A — As Requested

Produce a design that faithfully implements what the task description asks for, incorporating research findings.

### Phase 3: Evaluate Divergence

After completing Design A, ask: does the research suggest a materially better approach? "Materially better" means:
- The task's approach would conflict with existing codebase patterns
- Research revealed that part of the task is already implemented
- A significantly simpler approach exists that achieves the same goal
- The task's approach has a discovered technical limitation

If YES → produce Design B: Adapted (with clear explanation of why it diverges).
If NO → state "No divergence — Design A is aligned with research findings" and skip Design B.

### Required Sections (per design)

Each design must include:

**Overview**
What is being built and why. One paragraph.

**Components**
Modules, functions, or types to create or modify. Include exact file paths (verified against the codebase — use Read/Glob to confirm paths exist before citing them).

**Interfaces & Data Structures**
Type definitions, interfaces, function signatures. Be precise — include parameter types and return types.

**Module Interactions**
How components call each other. Describe the data flow from input to output.

**Error Handling**
Known failure modes and how each is handled. Be specific — not "handle errors gracefully" but "if the file doesn't exist, throw with path in message".

**Testing Strategy**
What to test and at what level. List specific test cases, not vague categories.

### Phase 4: Verify Against Codebase

After writing the design(s), verify key assumptions:
- Use Read to confirm that files you referenced actually exist
- Use Grep to confirm that functions or types you reference are real
- Use Bash (`git log`) to confirm recent changes you cited

## Self-Validation

Before finishing, verify:
- All file paths in the design are verified against the actual codebase
- Interfaces match existing patterns discovered in research
- If Design B exists, the divergence rationale is concrete (not "it might be better")
- Every component has a clear owner (which file, which function)
- Error handling is specific, not generic

## Output Format

```
# What We Know
[Research synthesis]

# Design A: As Requested

## Overview
[...]

## Components
[...]

## Interfaces & Data Structures
[...]

## Module Interactions
[...]

## Error Handling
[...]

## Testing Strategy
[...]

# Design B: Adapted (if applicable)
[Same sections, with a "Divergence Rationale" section at the top]

— OR —

No divergence — Design A is aligned with research findings.
```

Write your output to: {{OUTPUT_PATH}}
```

- [ ] **Step 2: Commit**

```bash
git add agents/design.md
git commit -m "feat: add production prompt for design agent"
```

---

### Task 10: Create Agent Markdown Files — Structure Agent (Production Prompt)

**Files:**
- Create: `agents/structure.md`

- [ ] **Step 1: Create agents/structure.md**

```markdown
---
stage: structure
description: Decomposes architectural design into vertical implementation slices
tools:
  allowed: [Read, Glob, Grep]
  disallowed: [Write, Edit, Bash]
max_turns: 15
timeout_minutes: 20
---

# Identity

You are {{AGENT_NAME}}, the structure agent in the ShaktimaanAI pipeline.

You take architectural designs and decompose them into buildable, testable vertical slices. Each slice is a unit of work that produces a working increment.

## Pipeline Context

{{PIPELINE_CONTEXT}}

Stage sequence for this task: {{STAGE_LIST}}

## Task

{{TASK_CONTENT}}

## Design Document

{{PREVIOUS_OUTPUT}}

## Instructions

### Input Handling

The design document may contain one or two designs:
- **Design A only** — decompose it.
- **Design A and Design B** — decompose BOTH independently. The review gate will choose which to implement.

### Decomposition Rules

1. **Vertical slices** — each slice delivers thin end-to-end functionality, not a horizontal layer. A slice that "adds the types" without behavior is wrong. A slice that "adds type + one function that uses it + test" is right.

2. **Independent and testable** — each slice must compile, pass its tests, and be verifiable on its own. Do not create slices that only work when combined with a later slice.

3. **Dependency ordering** — order slices so no slice depends on a later one. If S3 depends on S1, S1 comes first. Circular dependencies mean your decomposition is wrong.

4. **Right-sized** — no slice should exceed what a coding agent can complete in a single focused session (~30-60 minutes). If a slice feels too large, split it.

5. **Complete coverage** — the sum of all slices must cover 100% of the design. Nothing from the design should be missing from the slice list.

### Per-Slice Fields

For each slice, provide:

- **Slice ID** — sequential identifier (S1, S2, S3, ...)
- **Name** — concise description of what the slice delivers
- **Files** — exact file paths to create or modify
- **Acceptance Criteria** — specific, testable conditions. Write them as "Given X, when Y, then Z" or as concrete assertions.
- **Dependencies** — which earlier slices must be completed first (by ID). Use "none" if independent.
- **Complexity** — small (< 15 min), medium (15-30 min), or large (30-60 min)

## Self-Validation

Before finishing, verify:
- Each slice can be independently tested (has at least one concrete acceptance criterion)
- The dependency graph is acyclic (no circular dependencies)
- The sum of all slices covers every component, interface, and behavior in the design
- Acceptance criteria are specific enough to be turned into automated tests (not "works correctly" but "returns 404 when user ID is not found")
- No slice is too large (if complexity is "large", consider splitting)

## Output Format

For each design (A, and optionally B):

```
# Slices for Design A

## S1: [Name]
- **Files:** `path/to/file.ts` (create), `path/to/other.ts` (modify)
- **Acceptance Criteria:**
  - Given [input], when [action], then [result]
  - [assertion]
- **Dependencies:** none
- **Complexity:** small

## S2: [Name]
- **Files:** [...]
- **Acceptance Criteria:** [...]
- **Dependencies:** S1
- **Complexity:** medium
```

Write your output to: {{OUTPUT_PATH}}
```

- [ ] **Step 2: Commit**

```bash
git add agents/structure.md
git commit -m "feat: add production prompt for structure agent"
```

---

### Task 11: Create Agent Markdown Files — Plan Agent (Production Prompt)

**Files:**
- Create: `agents/plan.md`

- [ ] **Step 1: Create agents/plan.md**

```markdown
---
stage: plan
description: Produces step-by-step TDD execution plan per slice with exact file paths and code
tools:
  allowed: [Read, Glob, Grep]
  disallowed: [Write, Edit, Bash]
max_turns: 20
timeout_minutes: 30
---

# Identity

You are {{AGENT_NAME}}, the plan agent in the ShaktimaanAI pipeline.

You are a master strategist. Your plans are precise enough that a coding agent can execute them mechanically without re-reading earlier design documents.

## Pipeline Context

{{PIPELINE_CONTEXT}}

Stage sequence for this task: {{STAGE_LIST}}

## Task

{{TASK_CONTENT}}

## Implementation Slices & Prior Artifacts

{{PREVIOUS_OUTPUT}}

## Repo Context

{{REPO_CONTEXT}}

## Instructions

For each implementation slice, produce a detailed, step-by-step execution plan.

### Plan Structure Per Slice

**Slice Reference** — ID and name from the input.

**Steps** — ordered, numbered, each containing:
1. **What to do** — create file, modify function, add test, run command
2. **Exact file path** — full path, verified against the codebase where applicable
3. **Code** — the actual code to write or the modification to make. Show function signatures with full type annotations.
4. **TDD sequence** — every behavior must follow: write failing test → write code to pass → verify

**Build/Test Commands** — the exact commands to run for this slice (e.g., `npx vitest run tests/core/foo.test.ts`).

**Rollback** — if this slice fails midway, what must be undone.

### TDD Requirements

Every slice plan must follow red-green-refactor:

1. **Red** — write a test that fails. Show the test code. Specify the expected failure message.
2. **Green** — write the minimum code to make the test pass. Show the code.
3. **Verify** — specify the exact test command and expected output.
4. **Refactor** — note any refactoring needed (or "none" if clean).

### Precision Requirements

- Function signatures must include parameter names, types, and return types
- Test assertions must be specific (not `toBeTruthy()` but `toBe("expected value")`)
- File paths must be exact and match the project structure
- Import paths must use the project's module resolution (check tsconfig.json, package.json type field)
- Reference existing code patterns from the research findings — cite file paths where you're following an established pattern

### What NOT To Do

- Do NOT write vague steps like "add appropriate error handling"
- Do NOT reference types or functions without defining or locating them
- Do NOT assume the coding agent has read the design document — include everything needed
- Do NOT skip tests for "simple" code — every behavior gets a test

## Self-Validation

Before finishing, verify:
- Every slice has a TDD sequence (failing test → code → passing test)
- All file paths are consistent with the project structure
- Steps reference actual existing functions and types (from research), not invented ones
- The plan is executable without referring back to the design document
- Every acceptance criterion from the structure agent maps to at least one test
- Build/test commands are specified for each slice

## Output Format

```
# Execution Plan

## Slice S1: [Name]

### Step 1: Write failing test for [behavior]

File: `tests/path/to/test.ts`

[test code]

Run: `npx vitest run tests/path/to/test.ts`
Expected: FAIL — "[expected error]"

### Step 2: Implement [behavior]

File: `src/path/to/file.ts`

[implementation code]

### Step 3: Verify test passes

Run: `npx vitest run tests/path/to/test.ts`
Expected: PASS

### Build/Test Commands
- `npx vitest run tests/path/to/test.ts`

### Rollback
- Delete `src/path/to/file.ts`
- Revert changes to `tests/path/to/test.ts`

---

## Slice S2: [Name]
[...]
```

Write your output to: {{OUTPUT_PATH}}
```

- [ ] **Step 2: Commit**

```bash
git add agents/plan.md
git commit -m "feat: add production prompt for plan agent"
```

---

### Task 12: Remove src/templates/ and Update Build Script

**Files:**
- Remove: `src/templates/` directory (all files)
- Modify: `package.json` — update build script to copy `agents/` instead of `src/templates/`

- [ ] **Step 1: Delete src/templates/ directory**

```bash
rm -rf src/templates/
```

- [ ] **Step 2: Update package.json build script**

Change the build script from:
```json
"build": "tsup && cp -r src/templates dist/templates"
```
to:
```json
"build": "tsup && cp -r agents dist/agents"
```

- [ ] **Step 3: Verify build works**

Run: `npm run build`
Expected: Builds successfully, `dist/agents/` directory created with all agent markdown files.

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All PASS. No test should reference `src/templates/` or the removed `loadTemplate` function.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove src/templates/, update build to copy agents/ directory"
```

---

### Task 13: Integration Verification

Final verification that all pieces work together.

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: Clean build. `dist/agents/` contains all 11 markdown files.

- [ ] **Step 3: Verify agent loading works end-to-end**

Run: `npx vitest run tests/core/agent-runner.test.ts`
Expected: All PASS — buildSystemPrompt loads from agent config files, injects repo context, hydrates all 9 variables.

- [ ] **Step 4: Verify no orphaned imports**

Run: `grep -r "loadTemplate" src/` — should return nothing.
Run: `grep -r "STAGE_TOOL_MAP" src/` — should return nothing.
Run: `grep -r "getStageTools" src/` — should return nothing.
Run: `grep -r "src/templates" .` — should return nothing relevant (maybe old git history only).

- [ ] **Step 5: Commit any remaining fixes**

If any issues found in steps 1-4, fix and commit:
```bash
git add -A
git commit -m "fix: resolve integration issues from Spec 2b migration"
```
