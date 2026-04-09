# Spec 1: Core Foundation & CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the npm package skeleton, `shkmn` CLI, config system, setup wizard, `.task` file parser, and runtime directory scaffolding — the foundation that all other specs build on.

**Architecture:** TypeScript npm package distributed globally. Commander.js for CLI subcommands. Two-layer config (JSON + .env) with Zod schema validation. Runtime directory with numbered stage folders is created by the setup wizard. All code is ESM, bundled with tsup, tested with vitest.

**Tech Stack:** TypeScript, Node.js 20+, tsup (bundler), commander (CLI), @clack/prompts (setup wizard), zod (config validation), vitest (testing), dotenv (.env loading)

**Reference:** [System Design Document](../specs/2026-04-04-shaktimaanai-system-design.md)

---

## File Structure

```
shaktimaanai/
├── src/
│   ├── cli.ts                    ← CLI entry point (#!/usr/bin/env node)
│   ├── commands/
│   │   ├── init.ts               ← shkmn init — setup wizard
│   │   ├── start.ts              ← shkmn start — placeholder for Spec 2
│   │   ├── stop.ts               ← shkmn stop — placeholder for Spec 2
│   │   ├── task.ts               ← shkmn task — placeholder for Spec 3
│   │   ├── approve.ts            ← shkmn approve — placeholder for Spec 3
│   │   ├── status.ts             ← shkmn status — placeholder for Spec 3
│   │   ├── logs.ts               ← shkmn logs — placeholder for Spec 3
│   │   ├── history.ts            ← shkmn history — placeholder for Spec 5
│   │   └── config.ts             ← shkmn config — view/edit config
│   ├── config/
│   │   ├── schema.ts             ← Zod schema for shkmn.config.json
│   │   ├── defaults.ts           ← Default config values (agent names, etc.)
│   │   └── loader.ts             ← Load config + .env, validate, merge defaults
│   ├── task/
│   │   └── parser.ts             ← Parse .task file format into typed object
│   └── runtime/
│       └── dirs.ts               ← Create/verify runtime directory structure
├── tests/
│   ├── config/
│   │   ├── schema.test.ts
│   │   ├── defaults.test.ts
│   │   └── loader.test.ts
│   ├── task/
│   │   └── parser.test.ts
│   ├── runtime/
│   │   └── dirs.test.ts
│   └── commands/
│       ├── init.test.ts
│       └── config.test.ts
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── .gitignore                    ← Updated for TypeScript project
└── .env.example                  ← Documents all secret keys
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsup.config.ts`
- Create: `vitest.config.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Initialize package.json**

```bash
cd C:/src/ShaktimaanAI
```

Create `package.json`:

```json
{
  "name": "shaktimaanai",
  "version": "0.1.0",
  "description": "Agentic development pipeline — automates research, design, TDD implementation, review, and PR creation",
  "type": "module",
  "bin": {
    "shkmn": "./dist/cli.js"
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": {
    "node": ">=20"
  },
  "keywords": [
    "ai",
    "agent",
    "pipeline",
    "claude",
    "development",
    "automation"
  ],
  "author": "Pratyush Pande",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/prpande/ShaktimaanAI.git"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "types": ["vitest/globals"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create tsup.config.ts**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  splitting: false,
  sourcemap: true,
  shims: true,
});
```

- [ ] **Step 4: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Update .gitignore for TypeScript project**

Replace the current `.gitignore` contents with:

```
# Dependencies
node_modules/

# Build output
dist/

# Environment
.env

# OS
.DS_Store
Thumbs.db

# IDE
.idea/
.vscode/
*.swp
*.swo

# Test
coverage/

# Runtime (never commit pipeline runtime data)
runtime/
```

- [ ] **Step 6: Install dependencies**

```bash
npm install commander @clack/prompts zod dotenv
npm install -D tsup typescript vitest @types/node
```

- [ ] **Step 7: Verify build runs**

```bash
mkdir -p src && echo '#!/usr/bin/env node\nconsole.log("shkmn");' > src/cli.ts
npm run build
```

Expected: `dist/cli.js` created with no errors.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json tsup.config.ts vitest.config.ts .gitignore
git commit -m "feat: scaffold npm package with tsup, vitest, commander"
```

---

### Task 2: Config Schema & Defaults

**Files:**
- Create: `src/config/defaults.ts`
- Create: `src/config/schema.ts`
- Create: `tests/config/defaults.test.ts`
- Create: `tests/config/schema.test.ts`

- [ ] **Step 1: Write the failing test for defaults**

Create `tests/config/defaults.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_AGENT_NAMES } from "../../src/config/defaults.js";

describe("DEFAULT_AGENT_NAMES", () => {
  it("has all 14 agent name entries", () => {
    expect(Object.keys(DEFAULT_AGENT_NAMES)).toHaveLength(14);
  });

  it("includes all expected agent roles", () => {
    const roles = [
      "questions", "research", "design", "structure", "plan",
      "workTree", "impl", "validate", "review", "pr",
      "watcher", "taskCreator", "approvalHandler", "intentClassifier",
    ];
    for (const role of roles) {
      expect(DEFAULT_AGENT_NAMES).toHaveProperty(role);
    }
  });

  it("maps questions to Narada", () => {
    expect(DEFAULT_AGENT_NAMES.questions).toBe("Narada");
  });

  it("maps watcher to Heimdall", () => {
    expect(DEFAULT_AGENT_NAMES.watcher).toBe("Heimdall");
  });
});

describe("DEFAULT_CONFIG", () => {
  it("has agents section with names and concurrency", () => {
    expect(DEFAULT_CONFIG.agents.names).toEqual(DEFAULT_AGENT_NAMES);
    expect(DEFAULT_CONFIG.agents.maxConcurrentTotal).toBe(3);
    expect(DEFAULT_CONFIG.agents.maxConcurrentValidate).toBe(1);
  });

  it("has schedule section with default times", () => {
    expect(DEFAULT_CONFIG.schedule.rollupTime).toBe("23:55");
    expect(DEFAULT_CONFIG.schedule.notionPushDay).toBe("Friday");
    expect(DEFAULT_CONFIG.schedule.notionPushTime).toBe("18:00");
    expect(DEFAULT_CONFIG.schedule.monthlyReportDay).toBe(1);
    expect(DEFAULT_CONFIG.schedule.monthlyReportTime).toBe("08:00");
  });

  it("has pipeline section with empty runtimeDir", () => {
    expect(DEFAULT_CONFIG.pipeline.runtimeDir).toBe("");
    expect(DEFAULT_CONFIG.pipeline.dashboardRepoLocal).toBe("");
    expect(DEFAULT_CONFIG.pipeline.dashboardRepoUrl).toBe("");
  });

  it("has default stages for coding tasks", () => {
    expect(DEFAULT_CONFIG.agents.defaultStages).toEqual([
      "questions", "research", "design", "structure", "plan",
      "impl", "validate", "review", "pr",
    ]);
    expect(DEFAULT_CONFIG.agents.defaultReviewAfter).toBe("design");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/config/defaults.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write defaults.ts**

Create `src/config/defaults.ts`:

```typescript
export const DEFAULT_AGENT_NAMES = {
  questions: "Narada",
  research: "Chitragupta",
  design: "Vishwakarma",
  structure: "Vastu",
  plan: "Chanakya",
  workTree: "Hanuman",
  impl: "Karigar",
  validate: "Dharma",
  review: "Drona",
  pr: "Garuda",
  watcher: "Heimdall",
  taskCreator: "Brahma",
  approvalHandler: "Indra",
  intentClassifier: "Sutradhaar",
} as const;

export type AgentRole = keyof typeof DEFAULT_AGENT_NAMES;

export const DEFAULT_CONFIG = {
  pipeline: {
    runtimeDir: "",
    dashboardRepoLocal: "",
    dashboardRepoUrl: "",
  },
  repos: {
    root: "",
    aliases: {} as Record<string, { path: string; sequentialBuild?: boolean }>,
  },
  ado: {
    org: "",
    project: "",
    defaultArea: "",
  },
  slack: {
    enabled: false,
    channel: "#agent-pipeline",
    channelId: "",
    pollIntervalSeconds: 30,
  },
  agents: {
    names: { ...DEFAULT_AGENT_NAMES } as Record<string, string>,
    defaultStages: [
      "questions", "research", "design", "structure", "plan",
      "impl", "validate", "review", "pr",
    ] as string[],
    defaultReviewAfter: "design",
    maxConcurrentTotal: 3,
    maxConcurrentValidate: 1,
    maxTurns: {
      questions: 15,
      research: 30,
      design: 20,
      structure: 15,
      plan: 20,
      impl: 60,
      validate: 10,
      review: 30,
      classify: 5,
    } as Record<string, number>,
    timeoutsMinutes: {
      questions: 15,
      research: 45,
      design: 30,
      structure: 20,
      plan: 30,
      impl: 90,
      validate: 15,
      review: 45,
      classify: 2,
    } as Record<string, number>,
    heartbeatTimeoutMinutes: 10,
    retryCount: 1,
  },
  schedule: {
    rollupTime: "23:55",
    notionPushDay: "Friday",
    notionPushTime: "18:00",
    monthlyReportDay: 1,
    monthlyReportTime: "08:00",
  },
} as const;

export type ShkmnConfig = typeof DEFAULT_CONFIG;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/config/defaults.test.ts
```

Expected: PASS (all 6 tests).

- [ ] **Step 5: Write the failing test for schema**

Create `tests/config/schema.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { configSchema } from "../../src/config/schema.js";

describe("configSchema", () => {
  it("accepts a valid full config", () => {
    const valid = {
      pipeline: {
        runtimeDir: "/home/user/.shkmn",
        dashboardRepoLocal: "/home/user/dashboard",
        dashboardRepoUrl: "https://github.com/user/dashboard.git",
      },
      repos: {
        root: "/home/user/code",
        aliases: {
          myapp: { path: "/home/user/code/myapp", sequentialBuild: true },
        },
      },
      ado: { org: "https://dev.azure.com/myorg", project: "MyProj", defaultArea: "App" },
      slack: { enabled: false, channel: "#pipeline", channelId: "", pollIntervalSeconds: 30 },
      agents: {
        names: { questions: "CustomName" },
        defaultStages: ["research", "impl"],
        defaultReviewAfter: "research",
        maxConcurrentTotal: 2,
        maxConcurrentValidate: 1,
        maxTurns: { research: 20 },
        timeoutsMinutes: { research: 30 },
        heartbeatTimeoutMinutes: 5,
        retryCount: 2,
      },
      schedule: {
        rollupTime: "23:00",
        notionPushDay: "Friday",
        notionPushTime: "17:00",
        monthlyReportDay: 1,
        monthlyReportTime: "09:00",
      },
    };

    const result = configSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("accepts a minimal config (only pipeline.runtimeDir required)", () => {
    const minimal = {
      pipeline: { runtimeDir: "/tmp/shkmn" },
    };
    const result = configSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("rejects config with missing pipeline.runtimeDir", () => {
    const invalid = { pipeline: {} };
    const result = configSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects config with non-string runtimeDir", () => {
    const invalid = { pipeline: { runtimeDir: 123 } };
    const result = configSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("allows partial agent names (user overrides only some)", () => {
    const partial = {
      pipeline: { runtimeDir: "/tmp/shkmn" },
      agents: { names: { questions: "MyQuestionBot" } },
    };
    const result = configSchema.safeParse(partial);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents?.names?.questions).toBe("MyQuestionBot");
    }
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

```bash
npx vitest run tests/config/schema.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 7: Write schema.ts**

Create `src/config/schema.ts`:

```typescript
import { z } from "zod";

const repoAliasSchema = z.object({
  path: z.string(),
  sequentialBuild: z.boolean().optional(),
});

export const configSchema = z.object({
  pipeline: z.object({
    runtimeDir: z.string().min(1, "pipeline.runtimeDir is required"),
    dashboardRepoLocal: z.string().optional().default(""),
    dashboardRepoUrl: z.string().optional().default(""),
  }),
  repos: z.object({
    root: z.string().optional().default(""),
    aliases: z.record(z.string(), repoAliasSchema).optional().default({}),
  }).optional().default({}),
  ado: z.object({
    org: z.string().optional().default(""),
    project: z.string().optional().default(""),
    defaultArea: z.string().optional().default(""),
  }).optional().default({}),
  slack: z.object({
    enabled: z.boolean().optional().default(false),
    channel: z.string().optional().default("#agent-pipeline"),
    channelId: z.string().optional().default(""),
    pollIntervalSeconds: z.number().optional().default(30),
  }).optional().default({}),
  agents: z.object({
    names: z.record(z.string(), z.string()).optional().default({}),
    defaultStages: z.array(z.string()).optional(),
    defaultReviewAfter: z.string().optional(),
    maxConcurrentTotal: z.number().optional(),
    maxConcurrentValidate: z.number().optional(),
    maxTurns: z.record(z.string(), z.number()).optional(),
    timeoutsMinutes: z.record(z.string(), z.number()).optional(),
    heartbeatTimeoutMinutes: z.number().optional(),
    retryCount: z.number().optional(),
  }).optional().default({}),
  schedule: z.object({
    rollupTime: z.string().optional(),
    notionPushDay: z.string().optional(),
    notionPushTime: z.string().optional(),
    monthlyReportDay: z.number().optional(),
    monthlyReportTime: z.string().optional(),
  }).optional().default({}),
});

export type ConfigInput = z.input<typeof configSchema>;
export type ConfigParsed = z.output<typeof configSchema>;
```

- [ ] **Step 8: Run test to verify it passes**

```bash
npx vitest run tests/config/schema.test.ts
```

Expected: PASS (all 5 tests).

- [ ] **Step 9: Commit**

```bash
git add src/config/defaults.ts src/config/schema.ts tests/config/defaults.test.ts tests/config/schema.test.ts
git commit -m "feat: add config schema (zod) and default values with agent names"
```

---

### Task 3: Config Loader

**Files:**
- Create: `src/config/loader.ts`
- Create: `tests/config/loader.test.ts`
- Create: `.env.example`

- [ ] **Step 1: Write the failing test**

Create `tests/config/loader.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, resolveConfig } from "../../src/config/loader.js";
import { DEFAULT_AGENT_NAMES } from "../../src/config/defaults.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-config-" + Date.now());

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("loads a valid config file and merges with defaults", () => {
    const configPath = join(TEST_DIR, "shkmn.config.json");
    writeFileSync(configPath, JSON.stringify({
      pipeline: { runtimeDir: "/tmp/shkmn-runtime" },
      agents: { names: { questions: "MyBot" } },
    }));

    const config = loadConfig(configPath);
    expect(config.pipeline.runtimeDir).toBe("/tmp/shkmn-runtime");
    expect(config.agents.names.questions).toBe("MyBot");
  });

  it("throws if config file does not exist", () => {
    expect(() => loadConfig(join(TEST_DIR, "nonexistent.json"))).toThrow();
  });

  it("throws if config is invalid JSON", () => {
    const configPath = join(TEST_DIR, "bad.json");
    writeFileSync(configPath, "not json {{{");
    expect(() => loadConfig(configPath)).toThrow();
  });

  it("throws if runtimeDir is missing", () => {
    const configPath = join(TEST_DIR, "shkmn.config.json");
    writeFileSync(configPath, JSON.stringify({ pipeline: {} }));
    expect(() => loadConfig(configPath)).toThrow(/runtimeDir/);
  });
});

describe("resolveConfig", () => {
  it("merges user agent names with defaults (user overrides win)", () => {
    const parsed = {
      pipeline: { runtimeDir: "/tmp/rt", dashboardRepoLocal: "", dashboardRepoUrl: "" },
      repos: { root: "", aliases: {} },
      ado: { org: "", project: "", defaultArea: "" },
      slack: { enabled: false, channel: "#agent-pipeline", channelId: "", pollIntervalSeconds: 30 },
      agents: { names: { questions: "AskBot" } },
      schedule: {},
    };

    const resolved = resolveConfig(parsed);
    expect(resolved.agents.names.questions).toBe("AskBot");
    expect(resolved.agents.names.research).toBe(DEFAULT_AGENT_NAMES.research);
    expect(resolved.agents.names.watcher).toBe(DEFAULT_AGENT_NAMES.watcher);
  });

  it("fills in all default agent names when none provided", () => {
    const parsed = {
      pipeline: { runtimeDir: "/tmp/rt", dashboardRepoLocal: "", dashboardRepoUrl: "" },
      repos: { root: "", aliases: {} },
      ado: { org: "", project: "", defaultArea: "" },
      slack: { enabled: false, channel: "#agent-pipeline", channelId: "", pollIntervalSeconds: 30 },
      agents: { names: {} },
      schedule: {},
    };

    const resolved = resolveConfig(parsed);
    expect(resolved.agents.names).toEqual(DEFAULT_AGENT_NAMES);
  });

  it("fills in default stages when not specified", () => {
    const parsed = {
      pipeline: { runtimeDir: "/tmp/rt", dashboardRepoLocal: "", dashboardRepoUrl: "" },
      repos: { root: "", aliases: {} },
      ado: { org: "", project: "", defaultArea: "" },
      slack: { enabled: false, channel: "#agent-pipeline", channelId: "", pollIntervalSeconds: 30 },
      agents: { names: {} },
      schedule: {},
    };

    const resolved = resolveConfig(parsed);
    expect(resolved.agents.defaultStages).toEqual([
      "questions", "research", "design", "structure", "plan",
      "impl", "validate", "review", "pr",
    ]);
    expect(resolved.agents.defaultReviewAfter).toBe("design");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/config/loader.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write loader.ts**

Create `src/config/loader.ts`:

```typescript
import { readFileSync } from "node:fs";
import { configSchema, type ConfigParsed } from "./schema.js";
import { DEFAULT_CONFIG, DEFAULT_AGENT_NAMES } from "./defaults.js";

export interface ResolvedConfig {
  pipeline: {
    runtimeDir: string;
    dashboardRepoLocal: string;
    dashboardRepoUrl: string;
  };
  repos: {
    root: string;
    aliases: Record<string, { path: string; sequentialBuild?: boolean }>;
  };
  ado: {
    org: string;
    project: string;
    defaultArea: string;
  };
  slack: {
    enabled: boolean;
    channel: string;
    channelId: string;
    pollIntervalSeconds: number;
  };
  agents: {
    names: Record<string, string>;
    defaultStages: string[];
    defaultReviewAfter: string;
    maxConcurrentTotal: number;
    maxConcurrentValidate: number;
    maxTurns: Record<string, number>;
    timeoutsMinutes: Record<string, number>;
    heartbeatTimeoutMinutes: number;
    retryCount: number;
  };
  schedule: {
    rollupTime: string;
    notionPushDay: string;
    notionPushTime: string;
    monthlyReportDay: number;
    monthlyReportTime: string;
  };
}

export function loadConfig(configPath: string): ResolvedConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    throw new Error(`Config file not found: ${configPath}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in config file: ${configPath}`);
  }

  const result = configSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Config validation failed:\n${issues.join("\n")}`);
  }

  return resolveConfig(result.data);
}

export function resolveConfig(parsed: ConfigParsed): ResolvedConfig {
  const mergedNames: Record<string, string> = {
    ...DEFAULT_AGENT_NAMES,
    ...(parsed.agents?.names ?? {}),
  };

  return {
    pipeline: {
      runtimeDir: parsed.pipeline.runtimeDir,
      dashboardRepoLocal: parsed.pipeline.dashboardRepoLocal ?? "",
      dashboardRepoUrl: parsed.pipeline.dashboardRepoUrl ?? "",
    },
    repos: {
      root: parsed.repos?.root ?? "",
      aliases: parsed.repos?.aliases ?? {},
    },
    ado: {
      org: parsed.ado?.org ?? "",
      project: parsed.ado?.project ?? "",
      defaultArea: parsed.ado?.defaultArea ?? "",
    },
    slack: {
      enabled: parsed.slack?.enabled ?? false,
      channel: parsed.slack?.channel ?? "#agent-pipeline",
      channelId: parsed.slack?.channelId ?? "",
      pollIntervalSeconds: parsed.slack?.pollIntervalSeconds ?? 30,
    },
    agents: {
      names: mergedNames,
      defaultStages: parsed.agents?.defaultStages ?? DEFAULT_CONFIG.agents.defaultStages as unknown as string[],
      defaultReviewAfter: parsed.agents?.defaultReviewAfter ?? DEFAULT_CONFIG.agents.defaultReviewAfter,
      maxConcurrentTotal: parsed.agents?.maxConcurrentTotal ?? DEFAULT_CONFIG.agents.maxConcurrentTotal,
      maxConcurrentValidate: parsed.agents?.maxConcurrentValidate ?? DEFAULT_CONFIG.agents.maxConcurrentValidate,
      maxTurns: { ...DEFAULT_CONFIG.agents.maxTurns, ...(parsed.agents?.maxTurns ?? {}) },
      timeoutsMinutes: { ...DEFAULT_CONFIG.agents.timeoutsMinutes, ...(parsed.agents?.timeoutsMinutes ?? {}) },
      heartbeatTimeoutMinutes: parsed.agents?.heartbeatTimeoutMinutes ?? DEFAULT_CONFIG.agents.heartbeatTimeoutMinutes,
      retryCount: parsed.agents?.retryCount ?? DEFAULT_CONFIG.agents.retryCount,
    },
    schedule: {
      rollupTime: parsed.schedule?.rollupTime ?? DEFAULT_CONFIG.schedule.rollupTime,
      notionPushDay: parsed.schedule?.notionPushDay ?? DEFAULT_CONFIG.schedule.notionPushDay,
      notionPushTime: parsed.schedule?.notionPushTime ?? DEFAULT_CONFIG.schedule.notionPushTime,
      monthlyReportDay: parsed.schedule?.monthlyReportDay ?? DEFAULT_CONFIG.schedule.monthlyReportDay,
      monthlyReportTime: parsed.schedule?.monthlyReportTime ?? DEFAULT_CONFIG.schedule.monthlyReportTime,
    },
  };
}

export function loadEnvFile(envPath: string): void {
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env file is optional — no error if missing
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/config/loader.test.ts
```

Expected: PASS (all 7 tests).

- [ ] **Step 5: Create .env.example**

Create `.env.example`:

```ini
# ShaktimaanAI — Secret Configuration
# Copy this to your runtime directory as .env and fill in real values.
# NEVER commit the real .env file.

# Azure DevOps personal access token
ADO_PAT=

# GitHub personal access token (if gh CLI auth is not sufficient)
GITHUB_PAT=

# Slack tokens (if not using MCP)
SLACK_TOKEN=
SLACK_WEBHOOK_URL=

# Anthropic API key (if needed beyond Claude Code's built-in auth)
ANTHROPIC_API_KEY=
```

- [ ] **Step 6: Commit**

```bash
git add src/config/loader.ts tests/config/loader.test.ts .env.example
git commit -m "feat: add config loader with .env support and default merging"
```

---

### Task 4: Runtime Directory Manager

**Files:**
- Create: `src/runtime/dirs.ts`
- Create: `tests/runtime/dirs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/runtime/dirs.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeDirs, STAGE_DIRS, verifyRuntimeDirs } from "../../src/runtime/dirs.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-dirs-" + Date.now());

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("STAGE_DIRS", () => {
  it("has 13 top-level stage directories", () => {
    expect(STAGE_DIRS).toHaveLength(13);
  });

  it("starts with 00-inbox and ends with 12-hold", () => {
    expect(STAGE_DIRS[0]).toBe("00-inbox");
    expect(STAGE_DIRS[STAGE_DIRS.length - 1]).toBe("12-hold");
  });
});

describe("createRuntimeDirs", () => {
  it("creates all stage directories with pending/done subdirs", () => {
    createRuntimeDirs(TEST_DIR);

    expect(existsSync(join(TEST_DIR, "00-inbox"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "01-questions", "pending"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "01-questions", "done"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "06-impl", "pending"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "06-impl", "active"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "06-impl", "done"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "10-complete"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "11-failed"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "12-hold"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "logs"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "history"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "history", "daily-log"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "history", "monthly-reports"))).toBe(true);
  });

  it("is idempotent — safe to run multiple times", () => {
    createRuntimeDirs(TEST_DIR);
    createRuntimeDirs(TEST_DIR);
    expect(existsSync(join(TEST_DIR, "00-inbox"))).toBe(true);
  });
});

describe("verifyRuntimeDirs", () => {
  it("returns missing dirs when runtime is not initialized", () => {
    const result = verifyRuntimeDirs(TEST_DIR);
    expect(result.valid).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it("returns valid when all dirs exist", () => {
    createRuntimeDirs(TEST_DIR);
    const result = verifyRuntimeDirs(TEST_DIR);
    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/runtime/dirs.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write dirs.ts**

Create `src/runtime/dirs.ts`:

```typescript
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const STAGE_DIRS = [
  "00-inbox",
  "01-questions",
  "02-research",
  "03-design",
  "04-structure",
  "05-plan",
  "06-impl",
  "07-validate",
  "08-review",
  "09-pr",
  "10-complete",
  "11-failed",
  "12-hold",
] as const;

const STAGES_WITH_PENDING_DONE = [
  "01-questions", "02-research", "03-design", "04-structure",
  "05-plan", "06-impl", "07-validate", "08-review", "09-pr",
] as const;

function getAllDirPaths(runtimeDir: string): string[] {
  const dirs: string[] = [];

  for (const stage of STAGE_DIRS) {
    dirs.push(join(runtimeDir, stage));

    if ((STAGES_WITH_PENDING_DONE as readonly string[]).includes(stage)) {
      dirs.push(join(runtimeDir, stage, "pending"));
      dirs.push(join(runtimeDir, stage, "done"));
    }

    // 06-impl also gets an "active" subdirectory for TDD slice artifacts
    if (stage === "06-impl") {
      dirs.push(join(runtimeDir, stage, "active"));
    }
  }

  // Non-stage directories
  dirs.push(join(runtimeDir, "logs"));
  dirs.push(join(runtimeDir, "history"));
  dirs.push(join(runtimeDir, "history", "daily-log"));
  dirs.push(join(runtimeDir, "history", "monthly-reports"));

  return dirs;
}

export function createRuntimeDirs(runtimeDir: string): void {
  for (const dir of getAllDirPaths(runtimeDir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function verifyRuntimeDirs(runtimeDir: string): {
  valid: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  for (const dir of getAllDirPaths(runtimeDir)) {
    if (!existsSync(dir)) {
      missing.push(dir);
    }
  }
  return { valid: missing.length === 0, missing };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/runtime/dirs.test.ts
```

Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/dirs.ts tests/runtime/dirs.test.ts
git commit -m "feat: add runtime directory creation and verification"
```

---

### Task 5: Task File Parser

**Files:**
- Create: `src/task/parser.ts`
- Create: `tests/task/parser.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/task/parser.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseTaskFile, type TaskMeta } from "../../src/task/parser.js";

const FULL_TASK = `# Task: Add retry logic to MindBodyApiClient

## What I want done
Add exponential backoff retry on transient HTTP errors (429, 503, 504).
Should be configurable: max retries and base delay. Add unit tests.

## Context
- MindBodyApiClient is in src/Services/MindBodyApiClient.cs
- Polly is already referenced — use it

## Repo
C:\\Code\\mindbody-businessapp

## ADO Item
1502604

## Slack Thread
1234567890.123456

## Pipeline Config
stages: research, design, impl, validate, review, pr
review_after: design
`;

const MINIMAL_TASK = `# Task: Document appointment API patterns

## What I want done
Research and document all appointment-related endpoints.

## Pipeline Config
stages: questions, research
review_after: none
`;

describe("parseTaskFile", () => {
  it("parses a full task file with all fields", () => {
    const meta = parseTaskFile(FULL_TASK);

    expect(meta.title).toBe("Add retry logic to MindBodyApiClient");
    expect(meta.description).toContain("exponential backoff");
    expect(meta.context).toContain("MindBodyApiClient");
    expect(meta.repo).toBe("C:\\Code\\mindbody-businessapp");
    expect(meta.adoItem).toBe("1502604");
    expect(meta.slackThread).toBe("1234567890.123456");
    expect(meta.stages).toEqual(["research", "design", "impl", "validate", "review", "pr"]);
    expect(meta.reviewAfter).toBe("design");
  });

  it("parses a minimal task file with defaults for missing fields", () => {
    const meta = parseTaskFile(MINIMAL_TASK);

    expect(meta.title).toBe("Document appointment API patterns");
    expect(meta.description).toContain("Research and document");
    expect(meta.context).toBe("");
    expect(meta.repo).toBe("");
    expect(meta.adoItem).toBe("");
    expect(meta.slackThread).toBe("");
    expect(meta.stages).toEqual(["questions", "research"]);
    expect(meta.reviewAfter).toBe("none");
  });

  it("returns default stages when Pipeline Config section is missing", () => {
    const bare = `# Task: Quick fix\n\n## What I want done\nFix the bug.\n`;
    const meta = parseTaskFile(bare);

    expect(meta.title).toBe("Quick fix");
    expect(meta.stages).toEqual([
      "questions", "research", "design", "structure", "plan",
      "impl", "validate", "review", "pr",
    ]);
    expect(meta.reviewAfter).toBe("design");
  });

  it("returns 'Unnamed Task' when title line is missing", () => {
    const noTitle = `## What I want done\nDo something.\n`;
    const meta = parseTaskFile(noTitle);
    expect(meta.title).toBe("Unnamed Task");
  });

  it("trims whitespace from all parsed fields", () => {
    const padded = `# Task:   Padded Title  \n\n## Repo\n  C:\\Code\\app  \n`;
    const meta = parseTaskFile(padded);
    expect(meta.title).toBe("Padded Title");
    expect(meta.repo).toBe("C:\\Code\\app");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/task/parser.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write parser.ts**

Create `src/task/parser.ts`:

```typescript
import { DEFAULT_CONFIG } from "../config/defaults.js";

export interface TaskMeta {
  title: string;
  description: string;
  context: string;
  repo: string;
  adoItem: string;
  slackThread: string;
  stages: string[];
  reviewAfter: string;
}

function extractSection(content: string, heading: string): string {
  const pattern = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |\\Z)`, "m");
  const match = content.match(pattern);
  if (!match) return "";
  return match[1].trim();
}

function extractFirstLine(content: string, heading: string): string {
  const section = extractSection(content, heading);
  if (!section) return "";
  // Return just the first non-empty line
  const lines = section.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[0] ?? "";
}

export function parseTaskFile(content: string): TaskMeta {
  // Title: "# Task: ..."
  const titleMatch = content.match(/^# Task:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "Unnamed Task";

  const description = extractSection(content, "What I want done");
  const context = extractSection(content, "Context");
  const repo = extractFirstLine(content, "Repo");
  const adoItem = extractFirstLine(content, "ADO Item");
  const slackThread = extractFirstLine(content, "Slack Thread");

  // Pipeline Config
  const configSection = extractSection(content, "Pipeline Config");
  let stages: string[] = [...(DEFAULT_CONFIG.agents.defaultStages as unknown as string[])];
  let reviewAfter: string = DEFAULT_CONFIG.agents.defaultReviewAfter;

  if (configSection) {
    const stagesMatch = configSection.match(/stages:\s*(.+)/);
    if (stagesMatch) {
      stages = stagesMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
    }

    const reviewMatch = configSection.match(/review_after:\s*(\w+)/);
    if (reviewMatch) {
      reviewAfter = reviewMatch[1].trim();
    }
  }

  return { title, description, context, repo, adoItem, slackThread, stages, reviewAfter };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/task/parser.test.ts
```

Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/task/parser.ts tests/task/parser.test.ts
git commit -m "feat: add .task file parser with section extraction"
```

---

### Task 6: Auth Verification Utility

**Files:**
- Create: `src/commands/auth.ts`
- Create: `tests/commands/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/commands/auth.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { checkTool, type ToolCheckResult } from "../../src/commands/auth.js";
import { execSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

describe("checkTool", () => {
  it("returns ok when command succeeds", () => {
    mockExecSync.mockReturnValue(Buffer.from("gh version 2.50.0"));
    const result = checkTool("gh", "gh --version");
    expect(result.name).toBe("gh");
    expect(result.ok).toBe(true);
    expect(result.version).toContain("gh version");
  });

  it("returns not ok when command throws", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("command not found");
    });
    const result = checkTool("gh", "gh --version");
    expect(result.name).toBe("gh");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("command not found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/commands/auth.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write auth.ts**

Create `src/commands/auth.ts`:

```typescript
import { execSync } from "node:child_process";

export interface ToolCheckResult {
  name: string;
  ok: boolean;
  version?: string;
  error?: string;
}

export function checkTool(name: string, command: string): ToolCheckResult {
  try {
    const output = execSync(command, { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
    return { name, ok: true, version: output.trim() };
  } catch (err) {
    return { name, ok: false, error: (err as Error).message };
  }
}

export const REQUIRED_TOOLS = [
  { name: "Claude Code", command: "claude --version" },
  { name: "GitHub CLI", command: "gh --version" },
  { name: "Azure CLI", command: "az --version" },
  { name: "Git", command: "git --version" },
  { name: "Node.js", command: "node --version" },
] as const;

export function checkAllTools(): ToolCheckResult[] {
  return REQUIRED_TOOLS.map((tool) => checkTool(tool.name, tool.command));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/commands/auth.test.ts
```

Expected: PASS (all 2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/commands/auth.ts tests/commands/auth.test.ts
git commit -m "feat: add CLI tool verification (gh, az, claude, git, node)"
```

---

### Task 7: Setup Wizard (`shkmn init`)

**Files:**
- Create: `src/commands/init.ts`
- Create: `tests/commands/init.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/commands/init.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeInitConfig, writeInitEnv } from "../../src/commands/init.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-init-" + Date.now());

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("writeInitConfig", () => {
  it("writes shkmn.config.json with provided values", () => {
    writeInitConfig(TEST_DIR, {
      runtimeDir: "/home/user/.shkmn/runtime",
      dashboardRepoUrl: "https://github.com/user/dash.git",
      dashboardRepoLocal: "/home/user/dash",
      reposRoot: "/home/user/code",
      adoOrg: "https://dev.azure.com/myorg",
      adoProject: "MyProject",
      adoArea: "MyArea",
    });

    const configPath = join(TEST_DIR, "shkmn.config.json");
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.pipeline.runtimeDir).toBe("/home/user/.shkmn/runtime");
    expect(config.pipeline.dashboardRepoUrl).toBe("https://github.com/user/dash.git");
    expect(config.ado.org).toBe("https://dev.azure.com/myorg");
    expect(config.agents.names.questions).toBe("Narada");
  });

  it("writes valid JSON that passes schema validation", () => {
    writeInitConfig(TEST_DIR, {
      runtimeDir: "/tmp/rt",
      dashboardRepoUrl: "",
      dashboardRepoLocal: "",
      reposRoot: "",
      adoOrg: "",
      adoProject: "",
      adoArea: "",
    });

    const { loadConfig } = await import("../../src/config/loader.js");
    const configPath = join(TEST_DIR, "shkmn.config.json");
    const config = loadConfig(configPath);
    expect(config.pipeline.runtimeDir).toBe("/tmp/rt");
  });
});

describe("writeInitEnv", () => {
  it("writes .env file with placeholder keys", () => {
    writeInitEnv(TEST_DIR);
    const envPath = join(TEST_DIR, ".env");
    expect(existsSync(envPath)).toBe(true);

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("ADO_PAT=");
    expect(content).toContain("ANTHROPIC_API_KEY=");
  });

  it("does not overwrite existing .env", () => {
    const envPath = join(TEST_DIR, ".env");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(envPath, "EXISTING=value\n");

    writeInitEnv(TEST_DIR);

    const content = readFileSync(envPath, "utf-8");
    expect(content).toBe("EXISTING=value\n");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/commands/init.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write init.ts**

Create `src/commands/init.ts`:

```typescript
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { intro, text, confirm, outro, isCancel, log } from "@clack/prompts";
import { DEFAULT_CONFIG, DEFAULT_AGENT_NAMES } from "../config/defaults.js";
import { createRuntimeDirs } from "../runtime/dirs.js";
import { checkAllTools } from "./auth.js";

export interface InitAnswers {
  runtimeDir: string;
  dashboardRepoUrl: string;
  dashboardRepoLocal: string;
  reposRoot: string;
  adoOrg: string;
  adoProject: string;
  adoArea: string;
}

export function writeInitConfig(dir: string, answers: InitAnswers): void {
  const config = {
    pipeline: {
      runtimeDir: answers.runtimeDir,
      dashboardRepoLocal: answers.dashboardRepoLocal,
      dashboardRepoUrl: answers.dashboardRepoUrl,
    },
    repos: {
      root: answers.reposRoot,
      aliases: {},
    },
    ado: {
      org: answers.adoOrg,
      project: answers.adoProject,
      defaultArea: answers.adoArea,
    },
    slack: {
      enabled: false,
      channel: "#agent-pipeline",
      channelId: "",
      pollIntervalSeconds: 30,
    },
    agents: {
      names: { ...DEFAULT_AGENT_NAMES },
      defaultStages: [...DEFAULT_CONFIG.agents.defaultStages],
      defaultReviewAfter: DEFAULT_CONFIG.agents.defaultReviewAfter,
      maxConcurrentTotal: DEFAULT_CONFIG.agents.maxConcurrentTotal,
      maxConcurrentValidate: DEFAULT_CONFIG.agents.maxConcurrentValidate,
      maxTurns: { ...DEFAULT_CONFIG.agents.maxTurns },
      timeoutsMinutes: { ...DEFAULT_CONFIG.agents.timeoutsMinutes },
      heartbeatTimeoutMinutes: DEFAULT_CONFIG.agents.heartbeatTimeoutMinutes,
      retryCount: DEFAULT_CONFIG.agents.retryCount,
    },
    schedule: { ...DEFAULT_CONFIG.schedule },
  };

  writeFileSync(
    join(dir, "shkmn.config.json"),
    JSON.stringify(config, null, 2) + "\n",
    "utf-8",
  );
}

export function writeInitEnv(dir: string): void {
  const envPath = join(dir, ".env");
  if (existsSync(envPath)) return; // never overwrite

  const content = `# ShaktimaanAI — Secret Configuration
# Fill in real values. NEVER commit this file.

ADO_PAT=
GITHUB_PAT=
SLACK_TOKEN=
SLACK_WEBHOOK_URL=
ANTHROPIC_API_KEY=
`;
  writeFileSync(envPath, content, "utf-8");
}

export async function runInitWizard(): Promise<void> {
  intro("ShaktimaanAI Setup");

  // 1. Check tools
  log.step("Checking required tools...");
  const tools = checkAllTools();
  for (const tool of tools) {
    if (tool.ok) {
      log.success(`${tool.name}: ${tool.version}`);
    } else {
      log.warn(`${tool.name}: NOT FOUND — ${tool.error}`);
    }
  }

  const missing = tools.filter((t) => !t.ok);
  if (missing.length > 0) {
    log.warn(`Missing tools: ${missing.map((t) => t.name).join(", ")}. Install them before running the pipeline.`);
  }

  // 2. Gather config
  const runtimeDir = await text({
    message: "Runtime directory (where pipeline data lives)",
    placeholder: join(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".shkmn", "runtime"),
    validate: (v) => (v.length === 0 ? "Required" : undefined),
  });
  if (isCancel(runtimeDir)) { process.exit(0); }

  const reposRoot = await text({
    message: "Root directory for your code repositories",
    placeholder: "C:\\Code",
  });
  if (isCancel(reposRoot)) { process.exit(0); }

  const adoOrg = await text({
    message: "Azure DevOps organization URL (leave blank to skip)",
    placeholder: "https://dev.azure.com/myorg",
  });
  if (isCancel(adoOrg)) { process.exit(0); }

  const adoProject = await text({
    message: "Azure DevOps project name",
    placeholder: "MyProject",
  });
  if (isCancel(adoProject)) { process.exit(0); }

  const adoArea = await text({
    message: "Default ADO area path",
    placeholder: "MyArea",
  });
  if (isCancel(adoArea)) { process.exit(0); }

  const dashboardRepoUrl = await text({
    message: "Dashboard GitHub repo URL (leave blank to set up later)",
    placeholder: "https://github.com/user/shaktimaanai-dashboard.git",
  });
  if (isCancel(dashboardRepoUrl)) { process.exit(0); }

  const dashboardRepoLocal = await text({
    message: "Local path for dashboard repo clone",
    placeholder: join(String(runtimeDir), "..", "dashboard"),
  });
  if (isCancel(dashboardRepoLocal)) { process.exit(0); }

  // 3. Write config
  const configDir = String(runtimeDir);
  const answers: InitAnswers = {
    runtimeDir: String(runtimeDir),
    dashboardRepoUrl: String(dashboardRepoUrl ?? ""),
    dashboardRepoLocal: String(dashboardRepoLocal ?? ""),
    reposRoot: String(reposRoot ?? ""),
    adoOrg: String(adoOrg ?? ""),
    adoProject: String(adoProject ?? ""),
    adoArea: String(adoArea ?? ""),
  };

  log.step("Creating runtime directories...");
  createRuntimeDirs(configDir);

  log.step("Writing config...");
  writeInitConfig(configDir, answers);
  writeInitEnv(configDir);

  // 4. Summary
  log.success(`Config written to: ${join(configDir, "shkmn.config.json")}`);
  log.success(`Runtime directories created at: ${configDir}`);
  log.info(`Edit ${join(configDir, ".env")} to add your secret tokens.`);

  outro("Setup complete! Run 'shkmn start' to begin.");
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/commands/init.test.ts
```

Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/commands/init.ts tests/commands/init.test.ts
git commit -m "feat: add shkmn init setup wizard with interactive prompts"
```

---

### Task 8: Config Command (`shkmn config`)

**Files:**
- Create: `src/commands/config.ts`
- Create: `tests/commands/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/commands/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getConfigValue, setConfigValue } from "../../src/commands/config.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-configcmd-" + Date.now());
let configPath: string;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  configPath = join(TEST_DIR, "shkmn.config.json");
  writeFileSync(configPath, JSON.stringify({
    pipeline: { runtimeDir: "/tmp/rt" },
    agents: { names: { questions: "Narada" } },
  }));
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("getConfigValue", () => {
  it("reads a nested value by dot path", () => {
    const value = getConfigValue(configPath, "pipeline.runtimeDir");
    expect(value).toBe("/tmp/rt");
  });

  it("reads a deeply nested value", () => {
    const value = getConfigValue(configPath, "agents.names.questions");
    expect(value).toBe("Narada");
  });

  it("returns undefined for nonexistent path", () => {
    const value = getConfigValue(configPath, "nonexistent.path");
    expect(value).toBeUndefined();
  });
});

describe("setConfigValue", () => {
  it("sets a nested value by dot path", () => {
    setConfigValue(configPath, "agents.names.questions", "MyBot");
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(raw.agents.names.questions).toBe("MyBot");
  });

  it("creates intermediate objects if needed", () => {
    setConfigValue(configPath, "repos.root", "/home/code");
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(raw.repos.root).toBe("/home/code");
  });

  it("preserves existing values when setting a new key", () => {
    setConfigValue(configPath, "agents.names.research", "Scout");
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(raw.agents.names.questions).toBe("Narada");
    expect(raw.agents.names.research).toBe("Scout");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/commands/config.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write config.ts**

Create `src/commands/config.ts`:

```typescript
import { readFileSync, writeFileSync } from "node:fs";

export function getConfigValue(configPath: string, dotPath: string): unknown {
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  const keys = dotPath.split(".");
  let current: unknown = raw;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function setConfigValue(configPath: string, dotPath: string, value: unknown): void {
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  const keys = dotPath.split(".");
  let current: Record<string, unknown> = raw;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
  writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/commands/config.test.ts
```

Expected: PASS (all 6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/commands/config.ts tests/commands/config.test.ts
git commit -m "feat: add shkmn config get/set for dot-path access"
```

---

### Task 9: CLI Entry Point & Command Registration

**Files:**
- Create: `src/cli.ts`
- Create: `src/commands/start.ts`
- Create: `src/commands/stop.ts`
- Create: `src/commands/task.ts`
- Create: `src/commands/approve.ts`
- Create: `src/commands/status.ts`
- Create: `src/commands/logs.ts`
- Create: `src/commands/history.ts`

- [ ] **Step 1: Create placeholder commands for Spec 2-5**

Create `src/commands/start.ts`:

```typescript
export function registerStartCommand(program: import("commander").Command): void {
  program
    .command("start")
    .description("Start the Heimdall watcher and scheduler")
    .action(() => {
      console.log("shkmn start — not yet implemented (Spec 2: Pipeline Engine)");
      process.exit(1);
    });
}
```

Create `src/commands/stop.ts`:

```typescript
export function registerStopCommand(program: import("commander").Command): void {
  program
    .command("stop")
    .description("Stop the Heimdall watcher gracefully")
    .action(() => {
      console.log("shkmn stop — not yet implemented (Spec 2: Pipeline Engine)");
      process.exit(1);
    });
}
```

Create `src/commands/task.ts`:

```typescript
export function registerTaskCommand(program: import("commander").Command): void {
  program
    .command("task")
    .description("Create a new pipeline task")
    .argument("<description>", "Task description in natural language")
    .option("-r, --repo <repo>", "Target repository alias or path")
    .option("-a, --ado <id>", "Existing ADO work item ID")
    .option("-s, --stages <stages>", "Comma-separated stage list")
    .action(() => {
      console.log("shkmn task — not yet implemented (Spec 3: Input Surfaces)");
      process.exit(1);
    });
}
```

Create `src/commands/approve.ts`:

```typescript
export function registerApproveCommand(program: import("commander").Command): void {
  program
    .command("approve")
    .description("Approve a task waiting in review")
    .argument("<slug>", "Task slug to approve")
    .option("-f, --feedback <feedback>", "Optional reviewer feedback")
    .action(() => {
      console.log("shkmn approve — not yet implemented (Spec 3: Input Surfaces)");
      process.exit(1);
    });
}
```

Create `src/commands/status.ts`:

```typescript
export function registerStatusCommand(program: import("commander").Command): void {
  program
    .command("status")
    .description("Show active pipeline runs and their current stages")
    .action(() => {
      console.log("shkmn status — not yet implemented (Spec 3: Input Surfaces)");
      process.exit(1);
    });
}
```

Create `src/commands/logs.ts`:

```typescript
export function registerLogsCommand(program: import("commander").Command): void {
  program
    .command("logs")
    .description("Tail logs for a specific task")
    .argument("<slug>", "Task slug")
    .action(() => {
      console.log("shkmn logs — not yet implemented (Spec 3: Input Surfaces)");
      process.exit(1);
    });
}
```

Create `src/commands/history.ts`:

```typescript
export function registerHistoryCommand(program: import("commander").Command): void {
  program
    .command("history")
    .description("Show recent completed tasks")
    .option("-n, --count <n>", "Number of entries to show", "10")
    .action(() => {
      console.log("shkmn history — not yet implemented (Spec 5: History & Reporting)");
      process.exit(1);
    });
}
```

- [ ] **Step 2: Write the CLI entry point**

Create `src/cli.ts`:

```typescript
#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { runInitWizard } from "./commands/init.js";
import { registerStartCommand } from "./commands/start.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerTaskCommand } from "./commands/task.js";
import { registerApproveCommand } from "./commands/approve.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerHistoryCommand } from "./commands/history.js";
import { getConfigValue, setConfigValue } from "./commands/config.js";

const program = new Command();

program
  .name("shkmn")
  .description("ShaktimaanAI — Agentic development pipeline")
  .version("0.1.0");

// shkmn init
program
  .command("init")
  .description("Interactive setup wizard — creates config, runtime dirs, dashboard repo")
  .action(async () => {
    await runInitWizard();
  });

// shkmn config get/set
const configCmd = program
  .command("config")
  .description("View or edit configuration");

configCmd
  .command("get")
  .description("Get a config value by dot-path")
  .argument("<path>", "Dot-separated config path (e.g. agents.names.questions)")
  .action((path: string) => {
    const configPath = resolveConfigPath();
    const value = getConfigValue(configPath, path);
    if (value === undefined) {
      console.error(`Key not found: ${path}`);
      process.exit(1);
    }
    console.log(typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));
  });

configCmd
  .command("set")
  .description("Set a config value by dot-path")
  .argument("<path>", "Dot-separated config path")
  .argument("<value>", "New value (strings, numbers, booleans)")
  .action((path: string, value: string) => {
    const configPath = resolveConfigPath();
    // Parse value type
    let parsed: unknown = value;
    if (value === "true") parsed = true;
    else if (value === "false") parsed = false;
    else if (!isNaN(Number(value)) && value.trim() !== "") parsed = Number(value);

    setConfigValue(configPath, path, parsed);
    console.log(`Set ${path} = ${JSON.stringify(parsed)}`);
  });

// Register placeholder commands for future specs
registerStartCommand(program);
registerStopCommand(program);
registerTaskCommand(program);
registerApproveCommand(program);
registerStatusCommand(program);
registerLogsCommand(program);
registerHistoryCommand(program);

program.parse();

function resolveConfigPath(): string {
  // 1. SHKMN_CONFIG env var
  if (process.env.SHKMN_CONFIG && existsSync(process.env.SHKMN_CONFIG)) {
    return process.env.SHKMN_CONFIG;
  }

  // 2. Current directory
  const cwd = join(process.cwd(), "shkmn.config.json");
  if (existsSync(cwd)) return cwd;

  // 3. Home directory .shkmn/runtime
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const homeConfig = join(home, ".shkmn", "runtime", "shkmn.config.json");
  if (existsSync(homeConfig)) return homeConfig;

  console.error("Config not found. Run 'shkmn init' first, or set SHKMN_CONFIG env var.");
  process.exit(1);
}
```

- [ ] **Step 3: Build and verify**

```bash
npm run build
node dist/cli.js --help
```

Expected output includes all registered commands: `init`, `start`, `stop`, `task`, `approve`, `status`, `logs`, `history`, `config`.

- [ ] **Step 4: Verify init command runs**

```bash
node dist/cli.js init --help
```

Expected: Shows init command description.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/commands/start.ts src/commands/stop.ts src/commands/task.ts src/commands/approve.ts src/commands/status.ts src/commands/logs.ts src/commands/history.ts
git commit -m "feat: add shkmn CLI entry point with all command registrations"
```

---

### Task 10: Run All Tests & Final Build

**Files:**
- No new files — verification only

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run
```

Expected: All tests pass (defaults, schema, loader, dirs, parser, auth, init, config).

- [ ] **Step 2: Build the package**

```bash
npm run build
```

Expected: `dist/cli.js` created with no errors.

- [ ] **Step 3: Test the CLI binary**

```bash
node dist/cli.js --version
```

Expected: `0.1.0`

```bash
node dist/cli.js --help
```

Expected: Full help output with all commands listed.

- [ ] **Step 4: Test global install locally**

```bash
npm link
shkmn --version
shkmn --help
```

Expected: `shkmn` command is available globally, shows version and help.

- [ ] **Step 5: Commit any fixes from the verification pass**

```bash
git add -A
git commit -m "chore: verification pass — all tests green, build clean"
```

- [ ] **Step 6: Push to GitHub**

```bash
git push origin master
```
