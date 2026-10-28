// Smoke test for a deployed hosted MCP server: talks to it the way ChatGPT does (JSON-RPC over POST /mcp, with an
// anonymous "openai/subject" id), runs one free review end to end and checks the receipt.
//
//   node scripts\smoke.mjs https://agent-referee-mcp-remote-staging.fairplayclub.workers.dev/mcp
//
// On staging the reviewers are fake (no AI cost). On live, this uses one real free review.
const url = process.argv[2];
if (!url || !/^https:\/\/.+\/mcp$/.test(url)) {
  console.log("Usage: node scripts\\smoke.mjs https://<host>/mcp");
  process.exit(1);
}
const subject = `smoke-test-${Date.now()}`;
let id = 0;
async function rpc(method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
const tool = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args, _meta: { "openai/subject": subject } });
  return { isError: !!r.isError, data: r.structuredContent, text: r.content?.[0]?.text };
};
const ok = (cond, what) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${what}`);
  if (!cond) process.exitCode = 1;
};

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
ok(init.serverInfo?.name === "agent-referee", `initialize: ${init.serverInfo?.name} ${init.serverInfo?.version}`);
const tools = (await rpc("tools/list", {})).tools.map((t) => t.name);
ok(tools.join(",") === "start_review,get_review,verify_receipt", `tools: ${tools.join(", ")}`);

const work = { task: "Add 2 and 2 and give only the number.", output: "4" };
const t0 = Date.now();
let r = await tool("start_review", work);
ok(!r.isError, `start_review: ${r.data?.summary ?? r.text}`);
for (let i = 0; i < 8 && r.data?.status !== "done" && r.data?.status !== "failed"; i++) r = await tool("get_review", { job_id: r.data.job_id });
ok(r.data?.status === "done", `result after ${((Date.now() - t0) / 1000).toFixed(0)} s: ${r.data?.summary ?? r.text}`);
if (r.data?.status === "done") {
  ok(r.data.receipt?.payload?.funding === "free", 'receipt says funding: "free"');
  const v = await tool("verify_receipt", { receipt: r.data.receipt, ...work });
  ok(v.data?.ok === true, `verify_receipt: ${v.data?.summary}`);
  const other = await rpc("tools/call", { name: "get_review", arguments: { job_id: r.data.job_id }, _meta: { "openai/subject": "someone-else" } });
  ok(other.isError === true, "another person can't read this result");
}
console.log(process.exitCode ? "\nSome checks failed." : "\nAll checks passed.");
