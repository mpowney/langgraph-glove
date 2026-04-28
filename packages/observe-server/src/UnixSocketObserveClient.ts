import net from "node:net";
import type { ObservabilityModuleEntry } from "@langgraph-glove/config";
import { socketPathForObserve } from "./socket.js";
import type { ObserveSendPayload, ObserveTransportClient } from "./types.js";

export class UnixSocketObserveClient implements ObserveTransportClient {
  async send(
    _moduleKey: string,
    module: ObservabilityModuleEntry,
    payload: ObserveSendPayload,
  ): Promise<void> {
    if (!module.socketName) {
      throw new Error("Unix socket observability module is missing socketName");
    }

    const socketPath = socketPathForObserve(module.socketName);
    const timeoutMs = module.delivery?.timeoutMs ?? 5000;

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let settled = false;

      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      socket.setTimeout(timeoutMs, () => {
        fail(new Error(`Unix socket send timed out after ${timeoutMs}ms`));
      });

      socket.once("error", fail);
      socket.once("connect", () => {
        socket.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
          if (error) {
            fail(error);
            return;
          }
          socket.end();
        });
      });
      socket.once("close", () => {
        finish();
      });
    });
  }
}
