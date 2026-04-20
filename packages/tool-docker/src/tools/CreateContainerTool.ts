import { execFile, spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { validatePrivilegeGrant, type ToolMetadata } from "@langgraph-glove/tool-server";
import { containerManager, TTL_INDEFINITE } from "../ContainerManager.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TTL_MINUTES = 10;
const MAX_TTL_MINUTES = 1440; // 24 hours
const KEEPALIVE_COMMAND = "trap 'exit 0' TERM INT; while :; do sleep 3600; done";

/**
 * CLI flags that grant the container elevated access to the host.
 * Providing any of these requires a privileged grant.
 */
const PRIVILEGED_FLAGS = [
  "--privileged",
  "--network=host",
  "--network host",
  "--pid=host",
  "--pid host",
  "--ipc=host",
  "--ipc host",
  "--userns=host",
  "--userns host",
  "--cap-add",
  "--device",
  "--security-opt",
  "--cgroup-parent",
  "--cgroupns=host",
  "--cgroupns host",
];

function requiresPrivilege(cliParams: string[]): boolean {
  const flat = cliParams.join(" ").toLowerCase();
  return PRIVILEGED_FLAGS.some((flag) => flat.includes(flag.toLowerCase()));
}

export const createContainerToolMetadata: ToolMetadata = {
  name: "docker_create_container",
  description:
    "Use {name} to start a new docker container from any docker image. " +
    "Docker Hub is the default registry and requires no authentication. " +
    "Returns a tool-managed container reference that must be used with other docker_* tools. " +
    "For direct docker run usage, the tool keeps the container alive for later docker_exec calls. " +
    "Containers are automatically stopped and removed when their TTL expires. " +
    "Use ttl=0 for an indefinite container. " +
    "Providing CLI parameters that grant the container elevated host access (e.g. --privileged, " +
    "--network host, --cap-add, --device) requires privileged access. " +
    "Privileged context is injected automatically by the runtime when enabled.",
  parameters: {
    type: "object",
    properties: {
      image: {
        type: "string",
        description:
          "Docker image identifier, e.g. 'ubuntu:24.04', 'nginx:latest', 'python:3.12-slim'. " +
          "Defaults to 'docker.io/' (Docker Hub) when no registry is specified.",
      },
      ttl: {
        type: "number",
        description:
          `TTL in minutes before the container is automatically stopped and removed. ` +
          `Defaults to ${DEFAULT_TTL_MINUTES} minutes. Set to 0 for an indefinite container. ` +
          `Maximum is ${MAX_TTL_MINUTES} minutes (24 hours).`,
      },
      cliParams: {
        type: "array",
        items: { type: "string" },
        description:
          "Additional docker run CLI flags, e.g. ['-e', 'MY_VAR=hello', '-p', '8080:80']. " +
          "Flags that grant elevated host access require privileged access. For non-compose containers, " +
          "the tool injects a keepalive shell by default unless you override the entrypoint yourself.",
      },
      compose: {
        type: "string",
        description:
          "Optional docker-compose YAML content as a string. When provided, 'docker compose' is " +
          "used instead of 'docker run'. The 'image' parameter is still required and used as a " +
          "label for the managed container record.",
      },
    },
    required: ["image"],
  },
};

export async function handleCreateContainer(
  params: Record<string, unknown>,
  adminApiUrl: string,
): Promise<string> {
  const image = typeof params["image"] === "string" ? params["image"].trim() : "";
  if (!image) {
    throw new Error("docker_create_container: 'image' parameter is required and must be a non-empty string");
  }

  const ttlMinutes = (() => {
    if (params["ttl"] === undefined || params["ttl"] === null) return DEFAULT_TTL_MINUTES;
    const v = Number(params["ttl"]);
    if (!Number.isFinite(v) || v < 0) {
      throw new Error("docker_create_container: 'ttl' must be a non-negative number of minutes");
    }
    if (v > MAX_TTL_MINUTES) {
      throw new Error(`docker_create_container: 'ttl' must not exceed ${MAX_TTL_MINUTES} minutes`);
    }
    return v;
  })();

  const cliParams: string[] = Array.isArray(params["cliParams"])
    ? (params["cliParams"] as unknown[]).map((p) => {
        if (typeof p !== "string") throw new Error("docker_create_container: each 'cliParams' entry must be a string");
        return p;
      })
    : [];

  const compose = typeof params["compose"] === "string" ? params["compose"] : null;

  // Privilege check for dangerous flags
  if (requiresPrivilege(cliParams)) {
    await validatePrivilegeGrant(params, adminApiUrl);
  }

  const ttlMs = ttlMinutes === TTL_INDEFINITE ? TTL_INDEFINITE : ttlMinutes * 60 * 1000;

  let dockerId: string;
  let composeUsed = false;

  if (compose) {
    composeUsed = true;
    dockerId = await runWithCompose(compose, image);
  } else {
    dockerId = await runContainer(image, cliParams);
  }

  const record = containerManager.register(dockerId, image, cliParams, composeUsed, ttlMs);

  const ttlDesc =
    ttlMinutes === TTL_INDEFINITE
      ? "indefinite"
      : `${ttlMinutes} minute${ttlMinutes !== 1 ? "s" : ""}`;

  return [
    "## Container Created",
    "",
    `- **Container Reference:** ${record.id}`,
    `- **Image:** ${image}`,
    `- **TTL:** ${ttlDesc}`,
    ...(cliParams.length > 0 ? [`- **CLI params:** ${cliParams.join(" ")}`] : []),
    ...(composeUsed ? ["- **Created via:** docker compose"] : []),
    "",
    "Use the container reference with other docker_* tools.",
  ].join("\n");
}

async function runContainer(image: string, cliParams: string[]): Promise<string> {
  const hasEntrypointOverride = cliParams.some((param, index) =>
    param === "--entrypoint" ||
    param.startsWith("--entrypoint=") ||
    (param === "--" && cliParams[index + 1] === "--entrypoint")
  );
  const args = ["run", "-d", "--rm", ...cliParams];

  if (!hasEntrypointOverride) {
    args.push("--entrypoint", "/bin/sh");
  }

  args.push(image);

  if (!hasEntrypointOverride) {
    args.push("-lc", KEEPALIVE_COMMAND);
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("docker", args));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`docker_create_container: failed to start container — ${msg}`);
  }

  const dockerId = stdout.trim().slice(0, 12);

  try {
    const { stdout: inspectStdout } = await execFileAsync("docker", [
      "inspect",
      "--format",
      "{{.State.Running}}",
      dockerId,
    ]);
    if (inspectStdout.trim() !== "true") {
      throw new Error("container is not running");
    }
  } catch {
    throw new Error(
      "docker_create_container: container exited before it became ready for docker_exec. " +
      "Use an image that can run a shell, or provide cliParams that keep the container alive.",
    );
  }

  return dockerId;
}

async function runWithCompose(compose: string, image: string): Promise<string> {
  const composePath = join(tmpdir(), `glove-docker-compose-${Date.now()}.yml`);
  try {
    await writeFile(composePath, compose, "utf8");

    // Start compose project detached
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", ["compose", "-f", composePath, "up", "-d"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", (err) => reject(new Error(`docker_create_container: compose up failed — ${err.message}`)));
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`docker_create_container: compose up exited with code ${code} — ${stderr.trim()}`));
        } else {
          resolve();
        }
      });
    });

    // Get the ID of the container running the specified image
    const { stdout } = await execFileAsync("docker", [
      "ps",
      "--filter", `ancestor=${image}`,
      "--format", "{{.ID}}",
      "--latest",
    ]);
    const id = stdout.trim().split("\n")[0] ?? "";
    if (!id) {
      throw new Error(
        `docker_create_container: compose started but could not find a running container for image '${image}'`,
      );
    }
    return id.slice(0, 12);
  } finally {
    await unlink(composePath).catch(() => {});
  }
}
