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
