import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolHealthResult, ToolMetadata } from "@langgraph-glove/tool-server";

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

export async function checkDockerHealth(): Promise<Omit<ToolHealthResult, "latencyMs">> {
  const dependencies: ToolHealthResult["dependencies"] = [];

  let cliVersion = "";
  try {
    const { stdout } = await execFileAsync("docker", ["--version"]);
    cliVersion = stdout.trim();
    dependencies.push({ name: "docker", ok: true, detail: cliVersion });
  } catch {
    dependencies.push({
      name: "docker",
      ok: false,
      detail: "The docker binary is not available on PATH.",
    });
    return {
      ok: false,
      summary: "Docker CLI not found",
      dependencies,
    };
  }

  try {
    const { stdout } = await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"]);
    dependencies.push({
      name: "docker-daemon",
      ok: true,
      detail: `Server version ${stdout.trim()}`,
    });
  } catch {
    dependencies.push({
      name: "docker-daemon",
      ok: false,
      detail: "The docker daemon is not reachable.",
    });
  }

  const ok = dependencies.every((dependency) => dependency.ok || dependency.severity === "warning");
  return {
    ok,
    summary: ok ? "Docker CLI and daemon are available" : "Docker daemon is not reachable",
    dependencies,
  };
}

export async function handleDockerHealth(
  _params: Record<string, unknown>,
): Promise<string> {
  const lines: string[] = [];
  const result = await checkDockerHealth();
  const cli = result.dependencies.find((dependency) => dependency.name === "docker");
  const daemon = result.dependencies.find((dependency) => dependency.name === "docker-daemon");

  lines.push("## Docker Health Check");
  lines.push("");
  lines.push(`- **CLI:** ${cli?.ok ? cli.detail : "❌ Not found"}`);

  if (daemon?.ok) {
    lines.push(`- **Daemon:** ✅ Running (${daemon.detail})`);
  } else if (cli?.ok === false || daemon === undefined) {
    lines.push("- **Daemon:** ⏭️ Skipped (Docker CLI not found)");
  } else {
    lines.push("- **Daemon:** ❌ Not reachable — the docker daemon does not appear to be running.");
  }

  return lines.join("\n");
}
