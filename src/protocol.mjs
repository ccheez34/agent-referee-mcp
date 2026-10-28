// A small, dependency-free MCP server over stdio: newline-delimited JSON-RPC 2.0.
// Covers what a tools-only server needs: initialize, ping, tools/list, tools/call, progress notifications
// and cancellation. stdout carries protocol messages only; logs go to stderr.

/** Protocol versions this server speaks, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** Thrown by a tool handler for a problem the agent should read (bad input, a refusal). Becomes an isError result. */
export class ToolError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ToolError";
    this.details = details;
  }
}

/**
 * @param {object} opts
 * @param {{name: string, title?: string, version: string}} opts.info
 * @param {string} [opts.instructions]
 * @param {Array<{name: string, title?: string, description: string, inputSchema: object, annotations?: object,
 *   handler: (args: object, ctx: {progress: (message?: string) => void, signal: AbortSignal}) => Promise<object|string>}>} opts.tools
 * @param {(line: string) => void} opts.write Writes one serialized message (the transport adds the newline).
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.heartbeatMs] How often a long tool call sends a progress heartbeat (default 10 s).
 */
export function createMcpServer({ info, instructions, tools, write, log = () => {}, heartbeatMs = 10_000 }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  /** Tool calls still running: request id -> { controller, cancelled } */
  const inflight = new Map();
  let protocolVersion = SUPPORTED_PROTOCOL_VERSIONS[0];

  const send = (msg) => write(JSON.stringify(msg));
  const ok = (id, res) => ({ jsonrpc: "2.0", id, result: res });
  const fail = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  function listTools() {
    return tools.map(({ name, title, description, inputSchema, annotations }) => {
      const t = { name, description, inputSchema };
      if (title) t.title = title;
      if (annotations) t.annotations = annotations;
      return t;
    });
  }

  function toolResult(value, isError = false) {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    const out = { content: [{ type: "text", text }] };
    if (isError) out.isError = true;
    // structuredContent arrived in 2025-06-18; older clients get the same data as JSON text only.
    if (protocolVersion >= "2025-06-18" && value && typeof value === "object" && !Array.isArray(value)) out.structuredContent = value;
    return out;
  }

  async function callTool(id, params) {
    const tool = byName.get(params?.name);
    if (!tool) return fail(id, INVALID_PARAMS, `Unknown tool: ${String(params?.name)}`);
    const args = params.arguments ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) return fail(id, INVALID_PARAMS, "arguments must be an object.");

    const token = params?._meta?.progressToken;
    const hasToken = token !== undefined && token !== null;
    let step = 0;
    const progress = (message) => {
      if (!hasToken || entry.cancelled) return;
      step += 1;
      const p = { progressToken: token, progress: step };
      if (message && protocolVersion >= "2025-03-26") p.message = message;
      send({ jsonrpc: "2.0", method: "notifications/progress", params: p });
    };
    const entry = { controller: new AbortController(), cancelled: false };
    inflight.set(id, entry);
    // Keep long calls visibly alive (some clients extend their timeout when progress arrives).
    const beat = hasToken ? setInterval(() => progress("Still working…"), heartbeatMs) : null;
    beat?.unref?.();
    try {
      const value = await tool.handler(args, { progress, signal: entry.controller.signal });
      return ok(id, toolResult(value));
    } catch (e) {
      if (e instanceof ToolError) return ok(id, toolResult(e.details ? { error: e.message, ...e.details } : e.message, true));
      log(`tool ${tool.name} failed unexpectedly: ${e?.stack ?? e}`);
      return ok(id, toolResult(`Unexpected error in ${tool.name}: ${String(e?.message ?? e)}`, true));
    } finally {
      if (beat) clearInterval(beat);
      inflight.delete(id);
      // A cancelled call gets no response: the client has already stopped waiting for it.
      if (entry.cancelled) return null; // eslint-disable-line no-unsafe-finally
    }
  }

  async function handle(msg) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return fail(null, INVALID_REQUEST, "Invalid request.");
    // A response from the client: this server never sends requests, so there's nothing to match it to.
    if (!("method" in msg) && ("result" in msg || "error" in msg)) return null;
    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(msg.id ?? null, INVALID_REQUEST, "Invalid request.");

    const { method, params } = msg;
    if (!("id" in msg)) {
      // Notifications get no reply. Only cancellation needs action; initialized and the rest need none.
      if (method === "notifications/cancelled") {
        const e = inflight.get(params?.requestId);
        if (e) {
          e.cancelled = true;
          e.controller.abort(params?.reason ?? "cancelled");
        }
      }
      return null;
    }

    const { id } = msg;
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0];
        const res = { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { ...info } };
        if (instructions) res.instructions = instructions;
        return ok(id, res);
      }
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: listTools() });
      case "tools/call":
        return callTool(id, params);
      // This server has no resources or prompts. "Method not found" would be correct too, but some clients
      // ask anyway, and an empty list keeps them happy.
      case "resources/list":
        return ok(id, { resources: [] });
      case "resources/templates/list":
        return ok(id, { resourceTemplates: [] });
      case "prompts/list":
        return ok(id, { prompts: [] });
      default:
        return fail(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  async function safeHandle(msg) {
    try {
      return await handle(msg);
    } catch (e) {
      log(`internal error: ${e?.stack ?? e}`);
      return msg && typeof msg === "object" && "id" in msg ? fail(msg.id ?? null, INTERNAL_ERROR, "Internal error.") : null;
    }
  }

  /** Feed one raw line from the client. Each response is written when its own call finishes, so slow calls don't block others. */
  async function receive(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      send(fail(null, PARSE_ERROR, "Parse error."));
      return;
    }
    if (Array.isArray(msg)) {
      // JSON-RPC batch (allowed by protocol 2025-03-26): one array back once every call in it is done.
      if (msg.length === 0) return send(fail(null, INVALID_REQUEST, "Empty batch."));
      const out = (await Promise.all(msg.map(safeHandle))).filter(Boolean);
      if (out.length) write(JSON.stringify(out));
      return;
    }
    const res = await safeHandle(msg);
    if (res) send(res);
  }

  return {
    receive,
    listTools,
    get protocolVersion() {
      return protocolVersion;
    },
  };
}

/** Run a server on stdin/stdout. Resolves once stdin closes and every in-flight call has finished. */
export function runStdio({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, ...opts }) {
  const log = (m) => stderr.write(`[agent-referee-mcp] ${m}\n`);
  const server = createMcpServer({ ...opts, write: (line) => stdout.write(line + "\n"), log });
  const pending = new Set();
  const track = (p) => {
    pending.add(p);
    p.finally(() => pending.delete(p));
  };
  let buf = "";
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      track(server.receive(line));
    }
  });
  return new Promise((resolve) => {
    stdin.on("end", async () => {
      if (buf.trim()) track(server.receive(buf));
      // Finish what's running: a paid review that completes after the client left still has its receipt saved.
      while (pending.size) await Promise.allSettled([...pending]);
      resolve();
    });
  });
}
