import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gatherRepoContext } from "../../src/core/repo-context.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-repo-context-" + Date.now());

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

// ─── empty / missing path ────────────────────────────────────────────────────

describe("gatherRepoContext — no-context cases", () => {
  it("returns no-context message when repo path is empty", () => {
    const result = gatherRepoContext("");
    expect(result).toBe("(no repo context available)");
  });

  it("returns no-context message when repo path does not exist", () => {
    const result = gatherRepoContext(join(tmpdir(), "shkmn-nonexistent-path-" + Date.now()));
    expect(result).toBe("(no repo context available)");
  });
});

// ─── Tier 1: convention files ────────────────────────────────────────────────

describe("gatherRepoContext — Tier 1: convention files", () => {
  it("includes CLAUDE.md content verbatim under Convention Files heading", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "## Project rules\n- Always write tests first.", "utf-8");

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain("### Convention Files");
    expect(result).toContain("#### CLAUDE.md");
    expect(result).toContain("## Project rules");
    expect(result).toContain("- Always write tests first.");
  });

  it("includes multiple convention files when present", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "Claude rules here.", "utf-8");
    writeFileSync(join(TEST_DIR, "CONTRIBUTING.md"), "How to contribute.", "utf-8");
    writeFileSync(join(TEST_DIR, ".editorconfig"), "indent_style = space", "utf-8");

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain("#### CLAUDE.md");
    expect(result).toContain("Claude rules here.");
    expect(result).toContain("#### CONTRIBUTING.md");
    expect(result).toContain("How to contribute.");
    expect(result).toContain("#### .editorconfig");
    expect(result).toContain("indent_style = space");
  });

  it("includes .github/copilot-instructions.md when present", () => {
    const ghDir = join(TEST_DIR, ".github");
    mkdirSync(ghDir, { recursive: true });
    writeFileSync(join(ghDir, "copilot-instructions.md"), "Copilot: always use TypeScript.", "utf-8");

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain("#### .github/copilot-instructions.md");
    expect(result).toContain("Copilot: always use TypeScript.");
  });
});

// ─── Tier 2: config signal extraction ────────────────────────────────────────

describe("gatherRepoContext — Tier 2: package.json", () => {
  it("extracts name, scripts, and key dependencies from package.json", () => {
    const pkg = {
      name: "my-test-app",
      scripts: {
        build: "tsc",
        test: "vitest run",
        start: "node dist/index.js",
      },
      dependencies: {
        express: "^4.18.0",
        zod: "^3.22.0",
      },
      devDependencies: {
        vitest: "^1.0.0",
        typescript: "^5.0.0",
      },
    };
    writeFileSync(join(TEST_DIR, "package.json"), JSON.stringify(pkg, null, 2), "utf-8");

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain("#### package.json");
    expect(result).toContain("my-test-app");
    expect(result).toContain("build: tsc");
    expect(result).toContain("test: vitest run");
    expect(result).toContain("express");
    expect(result).toContain("zod");
    expect(result).toContain("vitest");
    expect(result).toContain("typescript");
  });

  it("handles package.json with no scripts or dependencies gracefully", () => {
    const pkg = { name: "bare-pkg" };
    writeFileSync(join(TEST_DIR, "package.json"), JSON.stringify(pkg), "utf-8");

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain("#### package.json");
    expect(result).toContain("bare-pkg");
    // Should not throw and should not include empty sections
  });
});

describe("gatherRepoContext — Tier 2: tsconfig.json", () => {
  it("extracts compiler options from tsconfig.json", () => {
    const tsconfig = {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        strict: true,
        outDir: "dist",
        paths: { "@/*": ["./src/*"] },
      },
    };
    writeFileSync(join(TEST_DIR, "tsconfig.json"), JSON.stringify(tsconfig, null, 2), "utf-8");

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain("#### tsconfig.json");
    expect(result).toContain("ES2022");
    expect(result).toContain("strict: true");
    expect(result).toContain("outDir: dist");
  });
});

describe("gatherRepoContext — Tier 2: .csproj files", () => {
  it("extracts project info from .csproj files", () => {
    const csproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
    <PackageReference Include="Serilog" Version="3.1.1" />
  </ItemGroup>
</Project>`;
    writeFileSync(join(TEST_DIR, "MyApp.csproj"), csproj, "utf-8");

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain("#### MyApp.csproj");
    expect(result).toContain("net8.0");
    expect(result).toContain("Newtonsoft.Json");
    expect(result).toContain("Serilog");
  });

  it("discovers .csproj files one level deep", () => {
    const subDir = join(TEST_DIR, "MyProject");
    mkdirSync(subDir, { recursive: true });
    const csproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
  </PropertyGroup>
</Project>`;
    writeFileSync(join(subDir, "MyProject.csproj"), csproj, "utf-8");

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain("#### MyProject.csproj");
    expect(result).toContain("net9.0");
  });
});

describe("gatherRepoContext — Tier 2: Dockerfile and linting configs", () => {
  it("notes FROM lines from Dockerfile", () => {
    const dockerfile = `FROM node:20-alpine AS base
RUN npm install
FROM node:20-alpine AS runner
COPY --from=base /app .`;
    writeFileSync(join(TEST_DIR, "Dockerfile"), dockerfile, "utf-8");

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain("#### Dockerfile");
    expect(result).toContain("node:20-alpine");
  });

  it("notes presence of .eslintrc file", () => {
    writeFileSync(join(TEST_DIR, ".eslintrc.json"), '{"rules":{}}', "utf-8");

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain(".eslintrc");
  });

  it("notes presence of .prettierrc file", () => {
    writeFileSync(join(TEST_DIR, ".prettierrc"), '{"semi":true}', "utf-8");

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain(".prettierrc");
  });
});

// ─── Tier 3: repo scan fallback ──────────────────────────────────────────────

describe("gatherRepoContext — Tier 3: fallback scan", () => {
  it("falls back to directory tree when no convention or config files exist", () => {
    // Create some directory structure with source files
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });
    mkdirSync(join(TEST_DIR, "tests"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src", "index.ts"), "// main", "utf-8");

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain("### Project Structure");
    expect(result).toContain("#### Directory Structure");
    // Should see src or tests listed
    expect(result).toMatch(/src|tests/);
  });

  it("falls back to README.md excerpt when no convention or config files exist", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: readme content`);
    writeFileSync(join(TEST_DIR, "README.md"), lines.join("\n"), "utf-8");

    const result = gatherRepoContext(TEST_DIR);
    expect(result).toContain("#### README.md (excerpt)");
    // First 30 lines should be present, line 31+ should not
    expect(result).toContain("Line 1: readme content");
    expect(result).toContain("Line 30: readme content");
    expect(result).not.toContain("Line 31: readme content");
  });

  it("does NOT include Tier 3 when Tier 1+2 have sufficient content", () => {
    // Write a large CLAUDE.md to exceed 200 words
    const words = Array.from({ length: 250 }, (_, i) => `word${i}`).join(" ");
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), words, "utf-8");

    const result = gatherRepoContext(TEST_DIR);
    // Tier 3 directory structure should not appear
    expect(result).not.toContain("#### Directory Structure");
    expect(result).not.toContain("#### README.md (excerpt)");
  });
});

// ─── output structure ────────────────────────────────────────────────────────

describe("gatherRepoContext — output structure", () => {
  it("includes repo name heading derived from directory basename", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "some content", "utf-8");
    const result = gatherRepoContext(TEST_DIR);
    expect(result).toMatch(/## Repo Context:/);
  });

  it("returns no-context for a directory with absolutely nothing relevant", () => {
    // Empty directory — no convention files, no config, nothing
    const result = gatherRepoContext(TEST_DIR);
    // May produce Tier 3 output (empty directory listing) or no-context
    // Either way should not throw and should be a string
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
