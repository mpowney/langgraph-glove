import fs from "node:fs";
import path from "node:path";
import { ToolProcessSupervisor } from "./supervisor/ToolProcessSupervisor.js";
import { ToolManagerScreen } from "./tui/ToolManagerScreen.js";

function parseArgs(argv: string[]): { command: string; toolArgs: string[] } {
  const [command = "run", ...toolArgs] = argv;
  return { command, toolArgs };
}

function findWorkspaceRoot(startDir: string): string {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    const toolsConfigPath = path.join(current, "config", "tools.json");
    if (fs.existsSync(packageJsonPath) && fs.existsSync(toolsConfigPath)) {
      return current;
    }

    if (current === root) {
      throw new Error("Could not locate workspace root with config/tools.json");
    }
    current = path.dirname(current);
  }
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const { command, toolArgs } = parseArgs(argv);
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  const supervisor = new ToolProcessSupervisor({ rootDir: workspaceRoot });

  const tools = supervisor.loadTools();

  if (command === "stop") {
    await supervisor.stopFromPidFile(toolArgs);
    return;
  }

  if (command === "dry-run") {
    // eslint-disable-next-line no-console
    console.log(`Tool manager dry run (${tools.length} enabled tools)`);
    for (const tool of tools) {
      // eslint-disable-next-line no-console
      console.log(`- ${tool.key}`);
      // eslint-disable-next-line no-console
      console.log(`  packageName: ${tool.packageName}`);
      // eslint-disable-next-line no-console
      console.log(`  packageDir: ${tool.packageDir}`);
      // eslint-disable-next-line no-console
      console.log(`  command: ${tool.command}`);
      // eslint-disable-next-line no-console
      console.log(`  env: ${JSON.stringify(tool.env)}`);
      // eslint-disable-next-line no-console
      console.log(`  logPath: ${tool.logPath}`);
    }
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    // eslint-disable-next-line no-console
    console.log("Usage: tool-manager [run|stop|dry-run|help] [tool-key ...]");
    return;
  }

  const screen = new ToolManagerScreen(supervisor);
  const screenRun = screen.run();
  await supervisor.startAll();
  await screenRun;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
