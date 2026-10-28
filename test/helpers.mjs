// Test helpers: drive the MCP server like a client would, over real stdio or in-process.
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const BIN = join(here, "..", "bin", "agent-referee-mcp.mjs");

export const tempDir = () => mkdtemp(join(tmpdir(), "arm-test-"));

/** Spawns the real bin and speaks JSON-RPC to it. Every stdout line must be valid JSON-RPC. */
export function spawnServer(env = {}) {
  // The full environment (Windows needs SystemRoot and friends for networking), minus any AGENT_REFEREE_* settings
  // from the shell, so a real wallet key or cap in your environment never leaks into a test.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AGENT_REFEREE_")));
  const child = spawn(process.execPath, [BIN], { env: { ...base, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  const notifications = [];
  const badLines = [];
  let stderr = "";
  let buf = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        badLines.push(line);
        continue;
      }
      if (msg.jsonrpc !== "2.0") badLines.push(line);
      if ("id" in msg && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      } else if (!("id" in msg)) notifications.push(msg);
      else badLines.push(line);
    }
  });
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));

  const request = (method, params, id = nextId++) =>
    new Promise((resolve) => {
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n");
    });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }) + "\n");

  return {
    child,
    request,
    notify,
    notifications,
    badLines,
    get stderr() {
      return stderr;
    },
    async init(protocolVersion = "2025-06-18") {
      const r = await request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } });
      notify("notifications/initialized");
      return r;
    },
    /** tools/call; returns { result, structured, text, isError }. */
    async call(name, args, meta) {
      const r = await request("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
      if (r.error) return { error: r.error };
      const text = r.result.content?.[0]?.text ?? "";
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { result: r.result, structured: r.result.structuredContent, data: parsed, text, isError: r.result.isError === true };
    },
    async close() {
      child.stdin.end();
      return exited;
    },
    exited,
  };
}

/** The same, in-process, through createServer (lets tests inject a fake paying fetch). */
export function inProcess(createServer, opts) {
  const out = [];
  const waiting = new Map();
  const server = createServer({
    ...opts,
    write: (line) => {
      const msg = JSON.parse(line);
      out.push(msg);
      if ("id" in msg && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      }
    },
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      server.receive(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
    });
  return {
    server,
    out,
    request,
    async init(protocolVersion = "2025-06-18") {
      return request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } });
    },
    async call(name, args) {
      const r = await request("tools/call", { name, arguments: args });
      if (r.error) return { error: r.error };
      const text = r.result.content?.[0]?.text ?? "";
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { result: r.result, data, text, isError: r.result.isError === true };
    },
  };
}
