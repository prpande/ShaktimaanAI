import type { Command } from "commander";

export function registerApproveCommand(program: Command): void {
  program
    .command("approve")
    .description("Approve a task waiting in review")
    .argument("<slug>", "Task slug to approve")
    .option("--feedback <feedback>", "Optional feedback message")
    .action(() => {
      console.log("shkmn approve — not yet implemented (Spec 3: Task Lifecycle)");
      process.exit(1);
    });
}
