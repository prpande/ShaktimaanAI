import { readFileSync, writeFileSync } from "node:fs";
import { configSchema } from "../config/schema.js";

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
  if (!dotPath || dotPath.trim() === "") {
    throw new Error("Config path must not be empty");
  }
  const keys = dotPath.split(".");
  if (keys.some((k) => k === "")) {
    throw new Error(`Invalid config path: "${dotPath}" — contains empty segments`);
  }

  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  const draft: Record<string, unknown> = JSON.parse(JSON.stringify(raw));
  let current: Record<string, unknown> = draft;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current)) {
      current[key] = {};
    } else if (typeof current[key] !== "object" || current[key] === null) {
      throw new Error(
        `Cannot set "${dotPath}": intermediate key "${keys.slice(0, i + 1).join(".")}" ` +
        `is a ${typeof current[key]}, not an object`,
      );
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;

  const result = configSchema.safeParse(draft);
  if (!result.success) {
    const messages = result.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
    throw new Error(`Invalid config: ${messages}`);
  }

  writeFileSync(configPath, JSON.stringify(draft, null, 2) + "\n", "utf-8");
}
