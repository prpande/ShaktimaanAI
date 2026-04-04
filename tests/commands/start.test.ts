import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerStartCommand } from "../../src/commands/start.js";

describe("registerStartCommand", () => {
  it("registers 'start' command on the program", () => {
    const program = new Command();
    registerStartCommand(program);
    const cmd = program.commands.find(c => c.name() === "start");
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain("Start");
  });
});
