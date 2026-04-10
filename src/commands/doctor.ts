import type { Command } from "commander";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../config/loader.js";
import { verifyRuntimeDirs, createRuntimeDirs } from "../runtime/dirs.js";
import { buildPaths } from "../config/paths.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";

// ── Types ──────────────────────────────────────────────────────────────

/** Result of a single doctor check. */
export interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
  fixable: boolean;
}

/** Options passed to runDoctor. */
export interface DoctorOptions {
  fix: boolean;
}

/** Result of a fix attempt. */
export interface FixResult {
  success: boolean;
  message: string;
}

// ── Constants ──────────────────────────────────────────────────────────

/** Keys required in .env for pipeline operation. */
export const REQUIRED_ENV_KEYS = [
  "ADO_PAT",
  "GITHUB_PAT",
  "SLACK_TOKEN",
  "SLACK_WEBHOOK_URL",
  "ANTHROPIC_API_KEY",
] as const;

/** Expected agent prompt files (derived from pipeline stages + utility agents). */
export const EXPECTED_AGENT_FILES = [
  "agent-template.md",
  "quick-triage.md",
  "quick-execute.md",
  "slack-io.md",
  "questions.md",
  "research.md",
  "design.md",
  "structure.md",
  "plan.md",
  "impl.md",
  "validate.md",
  "review.md",
  "pr.md",
] as const;

// ── Auth Checks ───────────────────────────────────────────────────────

const AUTH_TIMEOUT = 15_000;

function isTimeoutError(err: unknown): boolean {
  return (err as { killed?: boolean }).killed === true;
}

function isNotInstalledError(err: unknown): boolean {
  const msg = (err as Error).message ?? "";
  return (
    (err as { code?: string }).code === "ENOENT" ||
    msg.includes("command not found") ||
    msg.includes("is not recognized")
  );
}

function checkAuthCommand(name: string, command: string, toolLabel: string): CheckResult {
  try {
    execSync(command, {
      encoding: "utf-8",
      timeout: AUTH_TIMEOUT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { name, passed: true, message: "Authenticated", fixable: false };
  } catch (err) {
    if (isTimeoutError(err)) {
      return { name, passed: false, message: `${toolLabel} auth check timed out (15s)`, fixable: false };
    }
    if (isNotInstalledError(err)) {
      return { name, passed: false, message: `${toolLabel} not installed \u2014 ${command.split(" ")[0]}: command not found`, fixable: false };
    }
    const stderr = (err as any)?.stderr?.toString() ?? "";
    const message = (err as Error).message;
    const exitCode = (err as any)?.status;

    if (stderr.includes("rate limit") || stderr.includes("429")) {
      return { name, passed: false, message: "Rate limited — try again later", fixable: false };
    }
    if (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("network")) {
      return { name, passed: false, message: "Network error — check connectivity", fixable: false };
    }
    return { name, passed: false, message: `Auth check failed (exit ${exitCode}): ${message}`, fixable: false };
  }
}

export function checkGhAuth(): CheckResult {
  return checkAuthCommand("GitHub CLI authenticated", "gh auth status", "GitHub CLI");
}

export function checkAzAuth(): CheckResult {
  return checkAuthCommand("Azure CLI authenticated", "az account show", "Azure CLI");
}

// ── Config Check ──────────────────────────────────────────────────────

export function checkConfig(configPath: string | null): CheckResult {
  const name = "Config validation";
  if (configPath === null) {
    return { name, passed: false, message: "Config file not found", fixable: false };
  }
  try {
    loadConfig(configPath);
    return { name, passed: true, message: "Valid", fixable: false };
  } catch (err) {
    return { name, passed: false, message: (err as Error).message, fixable: true };
  }
}

// ── Env File Check ────────────────────────────────────────────────────

export function checkEnvFile(configPath: string | null): CheckResult {
  const name = ".env file";
  if (configPath === null) {
    return { name, passed: false, message: "Cannot check — config file not found", fixable: false };
  }

  const envPath = join(dirname(configPath), ".env");
  if (!existsSync(envPath)) {
    return { name, passed: false, message: `.env file not found at ${envPath}`, fixable: false };
  }

  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch (err) {
    return { name, passed: false, message: `Failed to read .env: ${(err as Error).message}`, fixable: false };
  }

  const presentKeys = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      presentKeys.add(trimmed.slice(0, eqIdx).trim());
    }
  }

  const missing = REQUIRED_ENV_KEYS.filter((key) => !presentKeys.has(key));
  if (missing.length === 0) {
    return { name, passed: true, message: `All ${REQUIRED_ENV_KEYS.length} required keys present`, fixable: false };
  }
  return { name, passed: false, message: `Missing keys: ${missing.join(", ")}`, fixable: false };
}

// ── Runtime Dirs Check ────────────────────────────────────────────────

export function checkRuntimeDirs(runtimeDir: string | null): CheckResult {
  const name = "Runtime directories";
  if (runtimeDir === null) {
    return { name, passed: false, message: "Cannot check — no config loaded", fixable: true };
  }

  const { valid, missing } = verifyRuntimeDirs(buildPaths(runtimeDir));
  if (valid) {
    return { name, passed: true, message: "All directories present", fixable: false };
  }
  return {
    name,
    passed: false,
    message: `${missing.length} missing directories`,
    fixable: true,
  };
}

// ── Agent Prompts Check ───────────────────────────────────────────────

export function checkAgentPrompts(agentsDir: string): CheckResult {
  const name = "Agent prompt files";
  const total = EXPECTED_AGENT_FILES.length;

  const missing: string[] = [];
  for (const file of EXPECTED_AGENT_FILES) {
    if (!existsSync(join(agentsDir, file))) {
      missing.push(file);
    }
  }

  if (missing.length === 0) {
    return { name, passed: true, message: `${total}/${total} present`, fixable: false };
  }
  return {
    name,
    passed: false,
    message: `Missing: ${missing.join(", ")} (${total - missing.length}/${total} present)`,
    fixable: false,
  };
}

// ── Fix Functions ─────────────────────────────────────────────────────

export function fixMissingDirs(runtimeDir: string): FixResult {
  try {
    createRuntimeDirs(buildPaths(runtimeDir));
    return { success: true, message: "Created missing runtime directories" };
  } catch (err) {
    return { success: false, message: `Fix failed: ${(err as Error).message}` };
  }
}

/**
 * Deep-merge DEFAULT_CONFIG into the existing config file.
 * Only adds missing keys — never overwrites existing values.
 */
export function fixMissingConfigDefaults(configPath: string): FixResult {
  try {
    const raw = readFileSync(configPath, "utf-8");
    const existing = JSON.parse(raw) as Record<string, unknown>;

    const merged = deepMergeDefaults(existing, DEFAULT_CONFIG as unknown as Record<string, unknown>);

    writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");
    return { success: true, message: "Added missing config defaults" };
  } catch (err) {
    return { success: false, message: `Fix failed: ${(err as Error).message}` };
  }
}

/**
 * Recursively merge defaults into target. Only adds keys that are missing
 * in target. Never overwrites existing values. Skips empty-string defaults
 * to avoid blanking out user values with placeholder defaults.
 */
function deepMergeDefaults(
  target: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(defaults)) {
    const defaultVal = defaults[key];

    // Skip empty-string defaults — they are placeholders, not useful values
    if (defaultVal === "") continue;

    if (!(key in result)) {
      result[key] = defaultVal;
    } else if (
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key]) &&
      typeof defaultVal === "object" &&
      defaultVal !== null &&
      !Array.isArray(defaultVal)
    ) {
      result[key] = deepMergeDefaults(
        result[key] as Record<string, unknown>,
        defaultVal as Record<string, unknown>,
      );
    }
    // If key exists in target, keep target's value (never overwrite)
  }
  return result;
}

// ── Config Resolution (non-exiting) ───────────────────────────────────

/**
 * Same logic as findConfigPath() in src/config/loader.ts
 * but returns null instead of calling process.exit(1).
 */
export function tryResolveConfigPath(): string | null {
  const envPath = process.env.SHKMN_CONFIG;
  if (envPath && existsSync(envPath)) return envPath;

  const localPath = join(process.cwd(), "shkmn.config.json");
  if (existsSync(localPath)) return localPath;

  const homePath = join(homedir(), ".shkmn", "runtime", "shkmn.config.json");
  if (existsSync(homePath)) return homePath;

  return null;
}

// ── Orchestrator ──────────────────────────────────────────────────────

export function runDoctor(options: DoctorOptions): void {
  console.log("shkmn doctor");
  console.log("─────────────");

  const configPath = tryResolveConfigPath();

  let runtimeDir: string | null = null;
  let agentsDir: string = join(process.cwd(), "agents");

  if (configPath !== null) {
    try {
      const config = loadConfig(configPath);
      runtimeDir = config.pipeline.runtimeDir || null;
      if (config.pipeline.agentsDir) {
        agentsDir = config.pipeline.agentsDir;
      }
    } catch {
      // Config is invalid — checkConfig will report details.
      // Still try to read raw JSON for runtimeDir.
      try {
        const raw = JSON.parse(readFileSync(configPath, "utf-8"));
        if (raw?.pipeline?.runtimeDir) runtimeDir = raw.pipeline.runtimeDir;
      } catch {
        // Completely unreadable — downstream checks will report it.
      }
    }
  }

  // Run all 6 checks sequentially
  const checks: CheckResult[] = [
    checkGhAuth(),
    checkAzAuth(),
    checkConfig(configPath),
    checkRuntimeDirs(runtimeDir),
    checkEnvFile(configPath),
    checkAgentPrompts(agentsDir),
  ];

  // Display results
  for (const check of checks) {
    const marker = check.passed ? "\u2713" : "\u2717";
    const detail = check.message ? ` \u2014 ${check.message}` : "";
    console.log(`${marker} ${check.name}${detail}`);
  }

  console.log("");

  let passCount = checks.filter((c) => c.passed).length;
  let failCount = checks.length - passCount;

  if (failCount === 0) {
    console.log(`${passCount}/${checks.length} checks passed`);
  } else {
    console.log(`${passCount}/${checks.length} checks passed, ${failCount} failed`);
  }

  // Fix phase
  if (options.fix) {
    const fixableFailures = checks.filter((c) => !c.passed && c.fixable);
    if (fixableFailures.length > 0) {
      console.log("");
      console.log("Attempting fixes...");

      const dirsCheck = checks.find((c) => c.name === "Runtime directories");
      if (dirsCheck && !dirsCheck.passed && runtimeDir) {
        const fixResult = fixMissingDirs(runtimeDir);
        if (fixResult.success) {
          console.log(`  \u2713 Fixed: ${fixResult.message}`);
          const recheck = checkRuntimeDirs(runtimeDir);
          const idx = checks.indexOf(dirsCheck);
          checks[idx] = recheck;
        } else {
          console.log(`  \u2717 ${fixResult.message}`);
        }
      }

      const configCheck = checks.find((c) => c.name === "Config validation");
      if (configCheck && !configCheck.passed && configPath) {
        const fixResult = fixMissingConfigDefaults(configPath);
        if (fixResult.success) {
          console.log(`  \u2713 Fixed: ${fixResult.message}`);
          const recheck = checkConfig(configPath);
          const idx = checks.indexOf(configCheck);
          checks[idx] = recheck;
        } else {
          console.log(`  \u2717 ${fixResult.message}`);
        }
      }

      // Re-display updated summary
      passCount = checks.filter((c) => c.passed).length;
      failCount = checks.length - passCount;
      console.log("");
      if (failCount === 0) {
        console.log(`After fix: ${passCount}/${checks.length} checks passed`);
      } else {
        console.log(`After fix: ${passCount}/${checks.length} checks passed, ${failCount} failed`);
      }
    }
  }
}

// ── CLI Registration ──────────────────────────────────────────────────

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check local ShaktimaanAI installation health")
    .option("--fix", "Attempt to auto-repair fixable issues")
    .action(async (opts: { fix?: boolean }) => {
      const options: DoctorOptions = { fix: opts.fix === true };
      runDoctor(options);
    });
}
