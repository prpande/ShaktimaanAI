import type { Command } from "commander";

export function registerTaskCommand(program: Command): void {
  program
    .command("task")
    .description("Create a new pipeline task")
    .argument("<description>", "Description of the task")
    .option("--repo <repo>", "Target repository")
    .option("--ado <ado>", "Azure DevOps work item reference")
    .option("--stages <stages>", "Comma-separated list of stages to run")
    .action(() => {
      console.log("shkmn task — not yet implemented (Spec 3: Task Lifecycle)");
      process.exit(1);
    });
}
