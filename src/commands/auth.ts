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
    return { name, ok: true, version: output.toString().trim() };
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
