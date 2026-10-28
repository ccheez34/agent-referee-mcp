// The MCP protocol layer on its own, with stand-in tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpServer, ToolError, SUPPORTED_PROTOCOL_VERSIONS } from "../src/protocol.mjs";

function harness(tools, opts = {}) {
  const out = [];
  const s = createMcpServer({ info: { name: "t", version: "0" }, instructions: "hi", tools, write: (l) => out.push(JSON.parse(l)), heartbeatMs: opts.heartbeatMs ?? 10_000 });
  const send = async (msg) => s.receive(typeof msg === "string" ? msg : JSON.stringify(msg));
  return { s, out, send, last: () => out[out.length - 1] };
}

const echo = { name: "echo", description: "d", inputSchema: { type: "object" }, handler: async (a) => ({ got: a }) };
const failing = { name: "bad", description: "d", inputSchema: { type: "object" }, handler: async () => { throw new ToolError("nope", { hint: "x" }); } };
const crashing = { name: "crash", description: "d", inputSchema: { type: "object" }, handler: async () => { throw new TypeError("boom"); } };

test("initialize negotiates the version: echoes a supported one, offers the newest otherwise", async () => {
  for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
    const h = harness([echo]);
    await h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v, capabilities: {}, clientInfo: { name: "c", version: "1" } } });
    assert.equal(h.last().result.protocolVersion, v);
    assert.deepEqual(h.last().result.capabilities, { tools: { listChanged: false } });
    assert.equal(h.last().result.serverInfo.name, "t");
    assert.equal(h.last().result.instructions, "hi");
  }
  const h = harness([echo]);
  await h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } });
  assert.equal(h.last().result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
});

test("notifications get no reply; ping, tools/list and unknown methods do", async () => {
  const h = harness([echo]);
  await h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(h.out.length, 0);
  await h.send({ jsonrpc: "2.0", id: "p", method: "ping" });
  assert.deepEqual(h.last(), { jsonrpc: "2.0", id: "p", result: {} });
  await h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(h.last().result.tools[0].name, "echo");
  assert.equal("handler" in h.last().result.tools[0], false, "handlers never leak into the listing");
  await h.send({ jsonrpc: "2.0", id: 3, method: "resources/read" });
  assert.equal(h.last().error.code, -32601);
  // Clients that ask for resources or prompts anyway get empty lists, not an error.
  await h.send({ jsonrpc: "2.0", id: 4, method: "resources/list" });
  assert.deepEqual(h.last().result, { resources: [] });
  await h.send({ jsonrpc: "2.0", id: 5, method: "resources/templates/list" });
  assert.deepEqual(h.last().result, { resourceTemplates: [] });
  await h.send({ jsonrpc: "2.0", id: 6, method: "prompts/list" });
  assert.deepEqual(h.last().result, { prompts: [] });
});

test("garbage is answered with the right JSON-RPC errors, and client responses are ignored", async () => {
  const h = harness([echo]);
  await h.send("{not json");
  assert.equal(h.last().error.code, -32700);
  assert.equal(h.last().id, null);
  await h.send({ jsonrpc: "1.0", id: 5, method: "ping" });
  assert.equal(h.last().error.code, -32600);
  assert.equal(h.last().id, 5);
  const before = h.out.length;
  await h.send({ jsonrpc: "2.0", id: 9, result: {} });
  assert.equal(h.out.length, before, "a response from the client gets no reply");
  await h.send([]);
  assert.equal(h.last().error.code, -32600);
});

test("tools/call: results, tool errors as isError, crashes contained, unknown tools", async () => {
  const h = harness([echo, failing, crashing]);
  await h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  await h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { a: 1 } } });
  assert.deepEqual(JSON.parse(h.last().result.content[0].text), { got: { a: 1 } });
  assert.deepEqual(h.last().result.structuredContent, { got: { a: 1 } });
  assert.equal(h.last().result.isError, undefined);

  await h.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bad", arguments: {} } });
  assert.equal(h.last().result.isError, true);
  assert.deepEqual(JSON.parse(h.last().result.content[0].text), { error: "nope", hint: "x" });

  await h.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "crash", arguments: {} } });
  assert.equal(h.last().result.isError, true);
  assert.match(h.last().result.content[0].text, /boom/);

  await h.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } });
  assert.equal(h.last().error.code, -32602);
  await h.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "echo", arguments: [1] } });
  assert.equal(h.last().error.code, -32602);
});

test("older protocol versions get JSON text only, no structuredContent", async () => {
  const h = harness([echo]);
  await h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  await h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: {} } });
  assert.equal(h.last().result.structuredContent, undefined);
  assert.ok(h.last().result.content[0].text);
});

test("progress: tool messages and heartbeats reach the client only when it asked with a progressToken", async () => {
  let release;
  const slow = {
    name: "slow",
    description: "d",
    inputSchema: { type: "object" },
    handler: async (_a, { progress }) => {
      progress("step one");
      await new Promise((r) => (release = r));
      return { done: true };
    },
  };
  const h = harness([slow], { heartbeatMs: 20 });
  await h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  const p = h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "slow", arguments: {}, _meta: { progressToken: "tok" } } });
  await new Promise((r) => setTimeout(r, 70));
  release();
  await p;
  const prog = h.out.filter((m) => m.method === "notifications/progress");
  assert.ok(prog.length >= 2, `a message plus at least one heartbeat, got ${prog.length}`);
  assert.equal(prog[0].params.progressToken, "tok");
  assert.equal(prog[0].params.message, "step one");
  assert.ok(prog.every((m, i) => m.params.progress === i + 1), "progress increases with every notification");
  assert.deepEqual(JSON.parse(h.last().result.content[0].text), { done: true });

  // No token: no notifications at all.
  const h2 = harness([echo]);
  await h2.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: {} } });
  assert.equal(h2.out.filter((m) => m.method).length, 0);
});

test("a cancelled call is aborted and gets no response; other calls are unaffected", async () => {
  let sawAbort = false;
  let release;
  const slow = {
    name: "slow",
    description: "d",
    inputSchema: { type: "object" },
    handler: async (_a, { signal }) => {
      signal.addEventListener("abort", () => (sawAbort = true));
      await new Promise((r) => (release = r));
      return { done: true };
    },
  };
  const h = harness([slow, echo]);
  const p = h.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "slow", arguments: {} } });
  await new Promise((r) => setTimeout(r, 10));
  await h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "user stopped it" } });
  await h.send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "echo", arguments: {} } });
  release();
  await p;
  assert.equal(sawAbort, true);
  assert.equal(h.out.filter((m) => m.id === 7).length, 0, "no response for the cancelled call");
  assert.equal(h.out.filter((m) => m.id === 8).length, 1);
});

test("a batch gets one array back with every response", async () => {
  const h = harness([echo]);
  await h.send([
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { x: 1 } } },
  ]);
  assert.equal(h.out.length, 1);
  assert.ok(Array.isArray(h.out[0]));
  assert.deepEqual(h.out[0].map((r) => r.id), [1, 2]);
});
