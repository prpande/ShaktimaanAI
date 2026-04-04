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
