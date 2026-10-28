// Agent Referee's hosted MCP server: Streamable HTTP at POST /mcp, stateless (no sessions), JSON answers only.
// For clients that need a URL instead of a local process, such as ChatGPT. It offers free sealed reviews
// (start_review / get_review) and offline receipt checks; paid reviews and tie-breaks stay in the local
// agent-referee-mcp package, where the owner's wallet lives.
import { createMcpServer, SUPPORTED_PROTOCOL_VERSIONS } from "../../src/protocol.mjs";
import { buildTools } from "./tools.mjs";

export { ReviewJob } from "./job.mjs";

export const VERSION = "0.1.0";
const MAX_BODY = 64_000;
// Browsers may only call from these pages (DNS-rebinding protection). Server-to-server calls send no Origin.
const DEFAULT_ORIGINS = ["https://chatgpt.com", "https://chat.openai.com"];

export const INSTRUCTIONS =
  "Agent Referee gives a piece of work an independent, signed check: one AI reviewer, or three from three AI companies, judge it against the task it was for. Call start_review with the exact task and output, then get_review with the job_id until it's done. Report the verdict and the problems found without overstating it: a review is what these models said, not a guarantee. verify_receipt checks a receipt someone hands you. Free: a few reviews per person per day.";

const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });

function allowedOrigins(env) {
  return [...DEFAULT_ORIGINS, ...String(env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
}

/** ChatGPT's anonymous id for the person ("openai/subject", meant for rate limiting), if the request has one. */
export function subjectOf(msg) {
  const calls = (Array.isArray(msg) ? msg : [msg]).filter((m) => m && typeof m === "object");
  for (const m of calls) {
    const s = m.params?._meta?.["openai/subject"];
    if (typeof s === "string" && /^[\x21-\x7e]{1,200}$/.test(s)) return s;
  }
  return undefined;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("origin");
    if (origin && !allowedOrigins(env).includes(origin)) return json(403, { error: "This origin isn't allowed." });
    const cors = origin ? { "access-control-allow-origin": origin, vary: "origin" } : {};

    if (url.pathname === "/" && req.method === "GET")
      return json(200, {
        name: "Agent Referee hosted MCP server",
        version: VERSION,
        mcp_endpoint: `${url.origin}/mcp`,
        transport: "Streamable HTTP (stateless, JSON answers)",
        tools: ["start_review", "get_review", "verify_receipt"],
        free: "A few free sealed reviews per person per day, inside a shared daily budget.",
        privacy: "Task and output go to Agent Referee and its reviewers' AI providers; this server deletes them once the review is done and keeps results for 24 hours. https://agentreferee.ai",
        source: "https://github.com/ccheez34/agent-referee-mcp/tree/main/remote",
      });

    if (url.pathname !== "/mcp") return json(404, { error: "Not found. The MCP endpoint is /mcp." });
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id, authorization" } });
    // No server-to-client stream (GET) and no sessions to end (DELETE): this server only answers requests.
    if (req.method !== "POST") return json(405, { error: "Use POST." }, { allow: "POST, OPTIONS", ...cors });

    const pv = req.headers.get("mcp-protocol-version");
    if (pv && !SUPPORTED_PROTOCOL_VERSIONS.includes(pv)) return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: `Unsupported MCP-Protocol-Version: ${pv}` } }, cors);
    const len = Number(req.headers.get("content-length") || 0);
    if (len > MAX_BODY) return json(413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large." } }, cors);
    const text = await req.text();
    if (text.length > MAX_BODY) return json(413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large." } }, cors);
    let msg = null;
    try {
      msg = JSON.parse(text);
    } catch {}

    const out = [];
    const server = createMcpServer({
      info: { name: "agent-referee", title: "Agent Referee", version: VERSION },
      instructions: INSTRUCTIONS,
      tools: buildTools({ env, subject: subjectOf(msg) }),
      write: (line) => out.push(line),
      log: (m) => console.error(m),
      heartbeatMs: 3_600_000, // no progress stream over plain JSON answers
    });
    await server.receive(text);
    // Only notifications or responses: accepted, nothing to answer.
    if (!out.length) return new Response(null, { status: 202, headers: cors });
    return new Response(out[0], { status: 200, headers: { "content-type": "application/json", ...cors } });
  },
};
