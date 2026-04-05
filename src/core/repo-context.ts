import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, basename, relative } from "node:path";

// ─── Internal helpers ─────────────────────────────────────────────────────────

function readIfExists(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Find files matching a simple glob pattern under root, up to maxDepth levels.
 * Supports "*" as a wildcard segment and exact names.
 * Returns absolute paths.
 */
function findFiles(root: string, extension: string, maxDepth: number): string[] {
  const results: string[] = [];
  function recurse(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        recurse(fullPath, depth + 1);
      } else if (entry.endsWith(extension)) {
        results.push(fullPath);
      }
    }
  }
  recurse(root, 0);
  return results;
}

/**
 * Build a directory tree string array (top maxDepth levels).
 * Excludes dotfile dirs, node_modules, and dist.
 */
function buildDirTree(root: string, maxDepth: number): string[] {
  const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".git"]);
  const lines: string[] = [];

  function recurse(dir: string, depth: number, prefix: string): void {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";

      if (stat.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry) || entry.startsWith(".")) continue;
        lines.push(`${prefix}${connector}${entry}/`);
        recurse(fullPath, depth + 1, prefix + childPrefix);
      } else {
        lines.push(`${prefix}${connector}${entry}`);
      }
    }
  }

  lines.push(`${basename(root)}/`);
  recurse(root, 0, "");
  return lines;
}

// ─── Tier 1: Convention files ─────────────────────────────────────────────────

const CONVENTION_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "CONVENTIONS.md",
  ".editorconfig",
  ".cursorrules",
  ".github/copilot-instructions.md",
];

function gatherTier1(repoPath: string): string {
  const sections: string[] = [];

  for (const relPath of CONVENTION_FILES) {
    const fullPath = join(repoPath, relPath);
    const content = readIfExists(fullPath);
    if (content !== null && content.trim().length > 0) {
      sections.push(`#### ${relPath}\n${content.trim()}`);
    }
  }

  if (sections.length === 0) return "";
  return `### Convention Files\n\n${sections.join("\n\n")}`;
}

// ─── Tier 2: Config signals ───────────────────────────────────────────────────

function extractPackageJson(repoPath: string): string {
  const content = readIfExists(join(repoPath, "package.json"));
  if (!content) return "";

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return "";
  }

  const lines: string[] = ["#### package.json"];

  if (typeof pkg.name === "string") {
    lines.push(`- **Name:** ${pkg.name}`);
  }

  const scripts = pkg.scripts as Record<string, string> | undefined;
  if (scripts && typeof scripts === "object" && Object.keys(scripts).length > 0) {
    lines.push("- **Scripts:**");
    for (const [name, cmd] of Object.entries(scripts)) {
      lines.push(`  - ${name}: ${cmd}`);
    }
  }

  const deps = pkg.dependencies as Record<string, string> | undefined;
  if (deps && typeof deps === "object" && Object.keys(deps).length > 0) {
    lines.push(`- **Dependencies:** ${Object.keys(deps).join(", ")}`);
  }

  const devDeps = pkg.devDependencies as Record<string, string> | undefined;
  if (devDeps && typeof devDeps === "object" && Object.keys(devDeps).length > 0) {
    lines.push(`- **Dev Dependencies:** ${Object.keys(devDeps).join(", ")}`);
  }

  if (lines.length === 1) return ""; // Only heading, no useful info
  return lines.join("\n");
}

function extractTsconfig(repoPath: string): string {
  const content = readIfExists(join(repoPath, "tsconfig.json"));
  if (!content) return "";

  let tsconfig: Record<string, unknown>;
  try {
    tsconfig = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return "";
  }

  const opts = tsconfig.compilerOptions as Record<string, unknown> | undefined;
  if (!opts || typeof opts !== "object") return "";

  const INTERESTING_KEYS = ["target", "module", "strict", "outDir", "paths"];
  const lines: string[] = ["#### tsconfig.json"];

  for (const key of INTERESTING_KEYS) {
    if (key in opts) {
      const val = opts[key];
      if (typeof val === "object") {
        lines.push(`- ${key}: ${JSON.stringify(val)}`);
      } else {
        lines.push(`- ${key}: ${String(val)}`);
      }
    }
  }

  if (lines.length === 1) return "";
  return lines.join("\n");
}

function extractCsproj(repoPath: string): string {
  const csprojPaths = findFiles(repoPath, ".csproj", 2);
  if (csprojPaths.length === 0) return "";

  const sections: string[] = [];

  for (const filePath of csprojPaths) {
    const content = readIfExists(filePath);
    if (!content) continue;

    const filename = basename(filePath);
    const lines: string[] = [`#### ${filename}`];

    // Extract TargetFramework
    const tfMatch = content.match(/<TargetFramework[^>]*>([^<]+)<\/TargetFramework>/);
    if (tfMatch) {
      lines.push(`- **TargetFramework:** ${tfMatch[1].trim()}`);
    }

    // Extract Nullable
    const nullableMatch = content.match(/<Nullable[^>]*>([^<]+)<\/Nullable>/);
    if (nullableMatch) {
      lines.push(`- **Nullable:** ${nullableMatch[1].trim()}`);
    }

    // Extract PackageReferences
    const pkgRefRegex = /<PackageReference\s+Include="([^"]+)"/g;
    const packages: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = pkgRefRegex.exec(content)) !== null) {
      packages.push(m[1]);
    }
    if (packages.length > 0) {
      lines.push(`- **PackageReferences:** ${packages.join(", ")}`);
    }

    if (lines.length > 1) {
      sections.push(lines.join("\n"));
    }
  }

  return sections.join("\n\n");
}

function extractDockerfile(repoPath: string): string {
  const content = readIfExists(join(repoPath, "Dockerfile"));
  if (!content) return "";

  const fromLines = content
    .split("\n")
    .filter((line) => line.trim().toUpperCase().startsWith("FROM"))
    .map((line) => `  - ${line.trim()}`);

  if (fromLines.length === 0) return "";

  return [`#### Dockerfile`, `- **FROM stages:**`, ...fromLines].join("\n");
}

function extractLintingConfigs(repoPath: string): string {
  const notes: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(repoPath);
  } catch {
    return "";
  }

  const hasEslint = entries.some((e) => e.startsWith(".eslintrc"));
  const hasPrettier = entries.some((e) => e.startsWith(".prettierrc"));

  if (hasEslint) notes.push("- **.eslintrc** present");
  if (hasPrettier) notes.push("- **.prettierrc** present");

  if (notes.length === 0) return "";
  return ["#### Linting / Formatting", ...notes].join("\n");
}

function extractDockerCompose(repoPath: string): string {
  const names = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
  for (const name of names) {
    const content = readIfExists(join(repoPath, name));
    if (!content) continue;

    // Extract service names from top-level services: key
    const serviceNames: string[] = [];
    const lines = content.split("\n");
    let inServices = false;
    for (const line of lines) {
      if (/^services:\s*$/.test(line)) { inServices = true; continue; }
      if (inServices && /^\S/.test(line)) break; // next top-level key
      if (inServices) {
        const svcMatch = line.match(/^\s{2}(\w[\w-]*):\s*$/);
        if (svcMatch) serviceNames.push(svcMatch[1]);
      }
    }

    if (serviceNames.length === 0) return `#### ${name}\n- Present (no services parsed)`;
    return [`#### ${name}`, `- **Services:** ${serviceNames.join(", ")}`].join("\n");
  }
  return "";
}

function extractCargoToml(repoPath: string): string {
  const content = readIfExists(join(repoPath, "Cargo.toml"));
  if (!content) return "";

  const lines: string[] = ["#### Cargo.toml"];
  const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
  if (nameMatch) lines.push(`- **Name:** ${nameMatch[1]}`);
  const editionMatch = content.match(/^edition\s*=\s*"([^"]+)"/m);
  if (editionMatch) lines.push(`- **Edition:** ${editionMatch[1]}`);

  // Extract dependency names from [dependencies] section
  const depSection = content.match(/\[dependencies\]\n([\s\S]*?)(?=\n\[|$)/);
  if (depSection) {
    const deps = depSection[1]
      .split("\n")
      .map((l) => l.match(/^(\w[\w-]*)\s*=/)?.[1])
      .filter(Boolean) as string[];
    if (deps.length > 0) lines.push(`- **Dependencies:** ${deps.join(", ")}`);
  }

  if (lines.length === 1) return "";
  return lines.join("\n");
}

function gatherTier2(repoPath: string): string {
  const sections: string[] = [];

  const pkgSection = extractPackageJson(repoPath);
  if (pkgSection) sections.push(pkgSection);

  const tsSection = extractTsconfig(repoPath);
  if (tsSection) sections.push(tsSection);

  const csprojSection = extractCsproj(repoPath);
  if (csprojSection) sections.push(csprojSection);

  const cargoSection = extractCargoToml(repoPath);
  if (cargoSection) sections.push(cargoSection);

  const dockerSection = extractDockerfile(repoPath);
  if (dockerSection) sections.push(dockerSection);

  const composeSection = extractDockerCompose(repoPath);
  if (composeSection) sections.push(composeSection);

  const lintSection = extractLintingConfigs(repoPath);
  if (lintSection) sections.push(lintSection);

  if (sections.length === 0) return "";
  return `### Stack & Tooling\n\n${sections.join("\n\n")}`;
}

// ─── Tier 3: Repo scan fallback ───────────────────────────────────────────────

function gatherRecentCommits(repoPath: string): string {
  try {
    const output = execSync("git log --oneline -15", {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!output) return "";
    return `#### Recent Commits\n\`\`\`\n${output}\n\`\`\``;
  } catch {
    return "";
  }
}

function gatherTier3(repoPath: string): string {
  const sections: string[] = [];

  const treeLines = buildDirTree(repoPath, 3);
  if (treeLines.length > 0) {
    sections.push(`#### Directory Structure\n\`\`\`\n${treeLines.join("\n")}\n\`\`\``);
  }

  const readme = readIfExists(join(repoPath, "README.md"));
  if (readme) {
    const excerpt = readme.split("\n").slice(0, 30).join("\n");
    sections.push(`#### README.md (excerpt)\n${excerpt.trim()}`);
  }

  const commits = gatherRecentCommits(repoPath);
  if (commits) {
    sections.push(commits);
  }

  if (sections.length === 0) return "";
  return `### Project Structure\n\n${sections.join("\n\n")}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

const WORD_THRESHOLD = 200;
const WORD_CAP = 2000;

export function gatherRepoContext(repoPath: string): string {
  if (!repoPath || !existsSync(repoPath)) {
    return "(no repo context available)";
  }

  const repoName = basename(repoPath);
  const tier1 = gatherTier1(repoPath);
  const tier2 = gatherTier2(repoPath);

  const combined12 = [tier1, tier2].filter(Boolean).join("\n\n");
  const combined12Words = wordCount(combined12);

  let tier3 = "";
  if (combined12Words < WORD_THRESHOLD) {
    tier3 = gatherTier3(repoPath);
  }

  const allSections = [tier1, tier2, tier3].filter(Boolean);
  if (allSections.length === 0) {
    return "(no repo context available)";
  }

  const body = allSections.join("\n\n");

  // Cap at ~2000 words — truncate by character estimate (avg ~5 chars/word + space)
  const MAX_CHARS = WORD_CAP * 6;
  const truncatedBody = body.length > MAX_CHARS ? body.slice(0, MAX_CHARS) + "\n\n_(context truncated)_" : body;

  return `## Repo Context: ${repoName}\n\n${truncatedBody}`;
}
