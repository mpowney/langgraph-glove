import http from "node:http";
import express, { type Express } from "express";
import { ToolServer } from "./ToolServer";
import type { RpcRequest } from "./RpcProtocol";

/**
 * A tool server that accepts JSON-RPC calls over HTTP POST at `POST /rpc`.
 *
 * A `GET /tools` introspection endpoint is also provided, returning the
 * metadata for all registered tools as a JSON array — useful for debugging.
 *
 * @example
 * ```ts
 * const server = new HttpToolServer(3001);
 * server.register({ name: "echo", description: "Echoes input", parameters: {} },
 *   async (params) => params);
 * await server.start();
 * // POST http://localhost:3001/rpc  { id, method, params }
 * ```
 */
export class HttpToolServer extends ToolServer {
  private readonly app: Express;
  private httpServer?: http.Server;

  constructor(private readonly port: number, private readonly host = "0.0.0.0") {
    super();
    this.app = express();
    this.app.use(express.json());
    this.configureRoutes();
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer(this.app);
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.port, this.host, () => {
        console.log(`[HttpToolServer] Listening on http://${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.httpServer?.close((err) => (err ? reject(err) : resolve())),
    );
  }

  private configureRoutes(): void {
    // Primary RPC endpoint — called by HttpRpcClient
    this.app.post("/rpc", async (req, res): Promise<void> => {
      console.log(`[HttpToolServer] Received RPC request: ${JSON.stringify(req.body)}`);
      const request = req.body as RpcRequest;
      if (!request?.id || !request?.method) {
        res.status(400).json({ error: "Invalid RPC request: missing id or method" });
        return;
      }

      const response = await this.dispatch(request);
      res.json(response);
    });

    // Human-readable introspection — useful during development
    this.app.get("/tools", async (_req, res): Promise<void> => {
      console.log(`[HttpToolServer] Received introspection request`);
      const result = await this.dispatch({ id: "introspect", method: "__introspect__", params: {} });
      res.json(result.result);
    });

    // Health check
    this.app.get("/health", async (_req, res): Promise<void> => {
      console.log(`[HttpToolServer] Received health request`);
      const startedAt = Date.now();
      const result = await this.dispatch({ id: "healthcheck", method: "__healthcheck__", params: {} });
      const latencyMs = Date.now() - startedAt;
      if (result.error) {
        res.status(500).json({
          ok: false,
          summary: typeof result.error === "string" ? result.error : JSON.stringify(result.error),
          dependencies: [],
          latencyMs,
        });
        return;
      }
      if (result.result?.ok === false) {
        res.status(503).json(result.result);
        return;
      }
      res.json(result.result);
    });
  }
}
