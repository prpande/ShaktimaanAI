import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerStopCommand } from "../../src/commands/stop.js";

describe("registerStopCommand", () => {
  it("registers 'stop' command on the program", () => {
    const program = new Command();
    registerStopCommand(program);
    const cmd = program.commands.find(c => c.name() === "stop");
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain("Stop");
  });
});
