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
 * Supports flat key-value pairs, numbers, booleans, inline arrays,
 * and one-level nested objects (e.g. tools: with allowed:/disallowed: sub-keys).
 */
export function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const FENCE = /^---\r?\n/;
  const CLOSE = /^---\r?\n?/m;

  if (!FENCE.test(content)) {
    return { meta: {}, body: content };
  }

  // Strip opening ---
  const afterOpen = content.replace(/^---\r?\n/, "");

  // Find closing ---
  const closeMatch = afterOpen.match(/^---\r?\n?/m);
  if (!closeMatch || closeMatch.index === undefined) {
    return { meta: {}, body: content };
  }

  const yamlText = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);

  const meta = parseYaml(yamlText);
  return { meta, body };
}

/**
 * Minimal YAML parser supporting:
 * - Flat key: value pairs
 * - Numbers and booleans
 * - Inline arrays: key: [a, b, c]
 * - One-level nested objects (indented sub-keys)
 */
function parseYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    // Top-level key (no leading whitespace)
    const topMatch = line.match(/^(\w+):\s*(.*)/);
    if (!topMatch) {
      i++;
      continue;
    }

    const key = topMatch[1];
    const rest = topMatch[2].trim();

    if (rest !== "") {
      // Inline value — parse it
      result[key] = parseValue(rest);
      i++;
    } else {
      // Possibly a nested object — collect indented lines
      const nested: Record<string, unknown> = {};
      i++;
      while (i < lines.length) {
        const subLine = lines[i];
        if (!subLine.trim() || subLine.trim().startsWith("#")) {
          i++;
          continue;
        }
        // If not indented, we've left the nested block
        if (!/^\s+/.test(subLine)) {
          break;
        }
        const subMatch = subLine.match(/^\s+(\w+):\s*(.*)/);
        if (subMatch) {
          nested[subMatch[1]] = parseValue(subMatch[2].trim());
          i++;
        } else {
          i++;
        }
      }
      result[key] = Object.keys(nested).length > 0 ? nested : undefined;
    }
  }

  return result;
}

/**
 * Parses a scalar YAML value: inline array, boolean, number, or string.
 */
function parseValue(raw: string): unknown {
  // Inline array: [a, b, c]
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }

  // Boolean
  if (raw === "true") return true;
  if (raw === "false") return false;

  // Number
  const num = Number(raw);
  if (raw !== "" && !isNaN(num)) return num;

  // String — strip optional surrounding quotes
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }

  return raw;
}

const DEFAULT_TOOLS = {
  allowed: ["Read", "Glob", "Grep"],
  disallowed: [] as string[],
};

/**
 * Loads an agent config from `{agentDir}/{stage}.md`.
 * Parses YAML frontmatter and returns an AgentConfig.
 * Defaults tools to { allowed: ["Read","Glob","Grep"], disallowed: [] } if not specified.
 */
export function loadAgentConfig(agentDir: string, stage: string): AgentConfig {
  const filePath = join(agentDir, `${stage}.md`);

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Agent config not found for stage "${stage}" at "${filePath}". ` +
      `(${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const { meta, body } = parseFrontmatter(content);

  // Resolve tools
  let tools: AgentConfig["tools"] = { ...DEFAULT_TOOLS, disallowed: [] };
  if (meta.tools && typeof meta.tools === "object") {
    const rawTools = meta.tools as Record<string, unknown>;
    tools = {
      allowed: Array.isArray(rawTools.allowed) ? (rawTools.allowed as string[]) : DEFAULT_TOOLS.allowed,
      disallowed: Array.isArray(rawTools.disallowed) ? (rawTools.disallowed as string[]) : [],
    };
  }

  const config: AgentConfig = {
    stage: typeof meta.stage === "string" ? meta.stage : stage,
    description: typeof meta.description === "string" ? meta.description : "",
    tools,
    promptTemplate: body,
  };

  if (typeof meta.max_turns === "number") {
    config.maxTurns = meta.max_turns;
  }
  if (typeof meta.timeout_minutes === "number") {
    config.timeoutMinutes = meta.timeout_minutes;
  }

  return config;
}
