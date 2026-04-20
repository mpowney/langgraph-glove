import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { v4 as uuidv4 } from "uuid";

const execFileAsync = promisify(execFile);

export const TTL_INDEFINITE = 0;

export interface ContainerRecord {
  /** Internal GUID returned to the agent. */
  id: string;
  /** Docker container ID (short hash). */
  dockerId: string;
  /** Docker image used. */
  image: string;
  /** CLI parameters supplied at creation time. */
  cliParams: string[];
  /** Whether a docker-compose file was used. */
  composeUsed: boolean;
  /** Creation timestamp (ms since epoch). */
  createdAt: number;
  /** Expiry timestamp (ms since epoch), or 0 for indefinite. */
  expiresAt: number;
}

/**
 * Manages docker containers keyed by internal UUID.
 * Automatically stops and removes containers whose TTL has elapsed.
 */
export class ContainerManager {
  private readonly containers = new Map<string, ContainerRecord>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Register a newly created docker container.
   *
   * @param dockerId - Short docker container ID.
   * @param image    - Image used to create the container.
   * @param cliParams - Additional CLI params used.
   * @param composeUsed - Whether a compose file was used.
   * @param ttlMs    - TTL in milliseconds, or `TTL_INDEFINITE` (0) for no expiry.
   * @returns Internal GUID for the container.
   */
  register(
    dockerId: string,
    image: string,
    cliParams: string[],
    composeUsed: boolean,
    ttlMs: number,
  ): ContainerRecord {
    const id = uuidv4();
    const now = Date.now();
    const expiresAt = ttlMs === TTL_INDEFINITE ? TTL_INDEFINITE : now + ttlMs;

    const record: ContainerRecord = {
      id,
      dockerId,
      image,
      cliParams,
      composeUsed,
      createdAt: now,
      expiresAt,
    };

    this.containers.set(id, record);

    if (ttlMs !== TTL_INDEFINITE) {
      const timer = setTimeout(() => {
        this.remove(id).catch(() => {});
      }, ttlMs);
      this.timers.set(id, timer);
    }

    return record;
  }

  /** Return a container record by internal GUID, or undefined if not found. */
  get(id: string): ContainerRecord | undefined {
    return this.containers.get(id);
  }

  /** Return all tracked container records. */
  list(): ContainerRecord[] {
    return [...this.containers.values()];
  }

  /**
   * Return the remaining TTL in milliseconds for a container.
   * Returns `TTL_INDEFINITE` (0) for indefinite containers and
   * a negative number if the container has already expired (but not yet removed).
   */
  remainingMs(id: string): number | null {
    const record = this.containers.get(id);
    if (!record) return null;
    if (record.expiresAt === TTL_INDEFINITE) return TTL_INDEFINITE;
    return record.expiresAt - Date.now();
  }

  /**
   * Stop and remove a container by internal GUID.
   * Clears the TTL timer if one exists.
   */
  async remove(id: string): Promise<void> {
    const record = this.containers.get(id);
    if (!record) return;

    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }

    this.containers.delete(id);

    try {
      await execFileAsync("docker", ["rm", "--force", record.dockerId]);
    } catch {
      // Container may have already exited or been removed externally.
    }
  }

  /** Stop and remove all tracked containers. */
  async removeAll(): Promise<void> {
    const ids = [...this.containers.keys()];
    await Promise.all(ids.map((id) => this.remove(id)));
  }
}

/** Singleton container manager shared across all tools. */
export const containerManager = new ContainerManager();
