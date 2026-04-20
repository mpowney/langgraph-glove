import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Return true if docker still reports the container as present. */
export async function isDockerContainerPresent(dockerId: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["inspect", "--type", "container", dockerId]);
    return true;
  } catch {
    return false;
  }
}
