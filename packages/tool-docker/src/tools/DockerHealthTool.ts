import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolMetadata } from "@langgraph-glove/tool-server";

const execFileAsync = promisify(execFile);

export const dockerHealthToolMetadata: ToolMetadata = {
  name: "docker_health",
  description:
    "Use {name} to check whether docker is installed on the tool server's host machine and " +
    "is currently healthy (i.e. the docker daemon is running and reachable). " +
    "Returns version information and daemon status.",
  parameters: {
    type: "object",
    properties: {},
  },
};

export async function handleDockerHealth(
  _params: Record<string, unknown>,
): Promise<string> {
  const lines: string[] = [];

  // Check docker CLI is present and get version
  let cliVersion = "";
  try {
    const { stdout } = await execFileAsync("docker", ["--version"]);
    cliVersion = stdout.trim();
  } catch {
    return [
      "## Docker Health Check",
      "",
      "❌ **Docker CLI not found.** The `docker` binary is not available on the tool server's PATH.",
    ].join("\n");
  }

  // Check daemon health
  let daemonHealthy = false;
  let daemonInfo = "";
  try {
    const { stdout } = await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"]);
    daemonInfo = stdout.trim();
    daemonHealthy = true;
  } catch {
    daemonHealthy = false;
  }

  lines.push("## Docker Health Check");
  lines.push("");
  lines.push(`- **CLI:** ${cliVersion}`);

  if (daemonHealthy) {
    lines.push(`- **Daemon:** ✅ Running (server version ${daemonInfo})`);
  } else {
    lines.push("- **Daemon:** ❌ Not reachable — the docker daemon does not appear to be running.");
  }

  return lines.join("\n");
}
