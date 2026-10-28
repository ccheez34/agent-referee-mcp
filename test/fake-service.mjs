// A local stand-in for https://agentreferee.ai that runs the server repo's REAL match and review code
// (MatchRoom, validateReview, reviewCommitment, runOneReviewer, reviewPayload, signReceipt) behind the same
// HTTP routes the client calls. Only three things are faked: Durable Object storage (in memory), the x402
// paywall (any X-PAYMENT header counts as paid), and the AI providers' answers.
//
// It needs the public server repo next to this package (../agent-referee-server) or AGENT_REFEREE_SERVER_DIR.
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = resolve(process.env.AGENT_REFEREE_SERVER_DIR || join(here, "..", "..", "agent-referee-server"));
export const serverAvailable = () => existsSync(join(SERVER_DIR, "src", "match.ts")) && existsSync(join(SERVER_DIR, "src", "review.ts"));

const load = (f) => import(pathToFileURL(join(SERVER_DIR, "src", f)).href);

/**
 * Start the fake service on a random localhost port.
 * @param {object} [opts]
 * @param {number} [opts.joinWaitSeconds] How long a join waits for the other seat (the real service: 15).
 * @param {(model: string) => string | (() => Response)} [opts.reviewAnswer] The AI answer per model (default: pass).
 */
export async function startFakeService({ joinWaitSeconds = 15, reviewAnswer } = {}) {
  const { MatchRoom } = await load("match.ts");
  const logic = await load("logic.ts");
  const review = await load("review.ts");
  const { signReceipt } = await load("receipt.ts");

  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const b64 = (b) => Buffer.from(b).toString("base64");
  const SIGNING_KEY = b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const PUBLIC_KEY = b64(await crypto.subtle.exportKey("raw", kp.publicKey));

  const env = {
    SIGNING_KEY,
    PUBLIC_KEY,
    JOIN_WAIT_SECONDS: String(joinWaitSeconds),
    ANTHROPIC_API_KEY: "test-anthropic",
    OPENROUTER_API_KEY: "test-openrouter",
    PANEL_3_MODELS: "claude-opus-5-5,openai/gpt-6-luna,google/gemini-3.7-flash",
    NETWORK: "base",
  };

  const mem = () => {
    const d = new Map();
    return { storage: { async get(k) { return structuredClone(d.get(k)); }, async put(k, v) { d.set(k, structuredClone(v)); }, async deleteAll() { d.clear(); }, async setAlarm() {} } };
  };
  const rooms = new Map();
  const room = (id) => {
    if (!rooms.has(id)) rooms.set(id, new MatchRoom(mem(), env));
    return rooms.get(id);
  };
  const forward = async (id, action, body) => {
    const res = await room(id).fetch(new Request(`https://match/${action}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }));
    return { status: res.status, body: await res.json() };
  };

  // The AI providers: answer with the queued verdict for each model. Everything else passes through.
  const stats = { reviewCalls: 0, paidRequests: 0, settled: 0, unpaidAttempts: 0, payers: [], busy: false, freeRequests: 0, freeUsed: { review: 0, "review-3": 0 } };
  const FREE_PER_DAY = { review: 3, "review-3": 1 };
  const answerFor = reviewAnswer ?? (() => JSON.stringify({ verdict: "pass", confidence: "high", issues: [], reasoning: "Checked against the task." }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    if (!url.includes("api.anthropic.com") && !url.includes("openrouter.ai")) return realFetch(input, init);
    stats.reviewCalls++;
    const body = JSON.parse(init.body);
    const a = answerFor(body.model, body);
    if (typeof a === "function") return a();
    if (url.includes("openrouter")) return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: a }, finish_reason: "stop" }] }));
    return new Response(JSON.stringify({ model: body.model, content: [{ type: "text", text: a }] }));
  };

  const ID_RE = /^[a-f0-9]{24}$/;
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      const path = url.pathname;
      let raw = "";
      for await (const c of req) raw += c;
      const body = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : undefined;
      const payment = req.headers["x-payment"];

      if (req.method === "GET" && path === "/pubkey") return send(res, 200, { algorithm: "Ed25519", public_key: PUBLIC_KEY, history: [] });

      if (req.method === "POST" && path === "/matches") {
        const demo = body?.demo === true;
        const id = typeof body?.key === "string" && logic.KEY_RE.test(body.key) ? await logic.idForKey(body.key, demo) : logic.randomToken(12);
        const r = await forward(id, "create", { id, input: body });
        return send(res, r.status, r.body);
      }
      let m;
      if (req.method === "GET" && (m = path.match(/^\/matches\/([^/]+)$/))) {
        if (!ID_RE.test(m[1])) return send(res, 400, { error: "Bad match id." });
        const r = await forward(m[1], "status");
        return send(res, r.status, r.body);
      }
      if (req.method === "POST" && (m = path.match(/^\/matches\/([^/]+)\/(commit|reveal|submit|retry-judge|rematch)$/))) {
        const r = await forward(m[1], m[2], body ?? {});
        return send(res, r.status, r.body);
      }
      if (req.method === "POST" && (m = path.match(/^\/demo\/join\/(rps|rps-bo3|weighted)$/))) {
        if (!body || typeof body.match_id !== "string" || !ID_RE.test(body.match_id)) return send(res, 400, { error: "match_id is required." });
        const r = await forward(body.match_id, "join", { seat: body.seat, tier: m[1], role: "party", paid: false, payments_enabled: false, demo: true, wait: true });
        return send(res, r.status, r.body);
      }
      if (req.method === "POST" && (m = path.match(/^\/join\/(rps|rps-bo3|weighted|judge|judge-2|judge-3)$/))) {
        // Paid join: the same paywall stand-in as reviews (no X-PAYMENT, no seat).
        if (!body || typeof body.match_id !== "string" || !ID_RE.test(body.match_id)) return send(res, 400, { error: "match_id is required." });
        if (!payment) {
          stats.unpaidAttempts++;
          return send(res, 402, { x402Version: 1, error: "X-PAYMENT header is required", accepts: [] });
        }
        stats.paidRequests++;
        const payer = logic.payerFromPaymentHeader(payment);
        const r = await forward(body.match_id, "join", { seat: body.seat, tier: m[1], role: "party", paid: true, payments_enabled: true, wait: true, payer });
        if (r.status < 400) stats.settled++;
        return send(res, r.status, r.body);
      }
      if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true, status: stats.busy ? "degraded" : "ok", reasons: [] });
      if (req.method === "POST" && (path === "/review" || path === "/review-3")) {
        const tier = path.slice(1);
        // The real service's admission gate: at capacity it answers 503 busy before any payment.
        if (stats.busy) {
          res.setHeader("retry-after", "12");
          return send(res, 503, { error: "busy: the AI reviewers are at capacity. Nothing was charged; retry in about 12 s.", busy: true, retry_after_s: 12 });
        }
        // The paywall: no payment header, no service (x402 answers 402 and the client pays and retries).
        if (!payment) {
          stats.unpaidAttempts++;
          return send(res, 402, { x402Version: 1, error: "X-PAYMENT header is required", accepts: [] });
        }
        stats.paidRequests++;
        const v = review.validateReview(body, tier);
        if (!v.ok) return send(res, 400, { error: `${v.error} Nothing was charged.` });
        let commitment;
        try {
          commitment = await review.reviewCommitment(tier, env, v.value.panel);
        } catch (e) {
          return send(res, 400, { error: `${e.message} Nothing was charged.` });
        }
        let votes;
        try {
          // Short waits between retries, so tests don't sit through the real 1-8 s backoff (older server copies ignore this).
          const fast = { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) };
          votes = await Promise.all(commitment.models.map((mm, i) => review.runOneReviewer({ ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, OPENROUTER_API_KEY: env.OPENROUTER_API_KEY }, mm, i + 1, v.value, 2000, fast)));
        } catch (e) {
          return send(res, 502, { error: `A reviewer didn't return a usable verdict (${String(e?.message ?? e).slice(0, 200)}). Nothing was charged; try again.` });
        }
        const payer = logic.payerFromPaymentHeader(payment);
        const payload = await review.reviewPayload({ tier, input: v.value, commitment, votes, payer, network: env.NETWORK, id: logic.randomToken(12) });
        const receipt = await signReceipt(payload, SIGNING_KEY, PUBLIC_KEY);
        // Settles only on success, like the real paywall; it reports the settlement in X-PAYMENT-RESPONSE.
        stats.settled++;
        stats.payers.push(payer);
        const settlement = Buffer.from(JSON.stringify({ success: true, transaction: `0x${"ab".repeat(32)}`, network: "base", payer })).toString("base64");
        return send(res, 200, { review_id: payload.review_id, tier, result: payload.result, votes, receipt, note: "test" }, { "x-payment-response": settlement });
      }
      // Free reviews: the real route's per-address allowance (3 + 1), no payment, receipts marked funding: free.
      if (req.method === "POST" && (path === "/free/review" || path === "/free/review-3")) {
        const tier = path.slice("/free/".length);
        stats.freeRequests++;
        if (stats.busy) {
          res.setHeader("retry-after", "12");
          return send(res, 503, { error: "busy: the AI reviewers are at capacity. Your free review wasn't used.", busy: true, retry_after_s: 12 });
        }
        const v = review.validateReview(body, tier);
        if (!v.ok) return send(res, 400, { error: `${v.error} Your free review wasn't used.` });
        if (stats.freeUsed[tier] >= FREE_PER_DAY[tier])
          return send(res, 429, { error: `You've used today's free ${tier === "review-3" ? "review-3" : "single-reviewer"} reviews (${FREE_PER_DAY[tier]} per day from one address). They reset at 00:00 UTC. Paid reviews (POST /review or /review-3 with x402) have no daily allowance.` });
        const commitment = await review.reviewCommitment(tier, env, v.value.panel);
        let votes;
        try {
          const fast = { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) };
          votes = await Promise.all(commitment.models.map((mm, i) => review.runOneReviewer({ ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, OPENROUTER_API_KEY: env.OPENROUTER_API_KEY }, mm, i + 1, v.value, 2000, fast)));
        } catch (e) {
          return send(res, 502, { error: `A reviewer didn't return a usable verdict (${String(e?.message ?? e).slice(0, 200)}). Your free review wasn't used; try again.` });
        }
        const used = ++stats.freeUsed[tier];
        const payload = await review.reviewPayload({ tier, input: v.value, commitment, votes, network: env.NETWORK, id: logic.randomToken(12), funding: "free" });
        const receipt = await signReceipt(payload, SIGNING_KEY, PUBLIC_KEY);
        return send(res, 200, { review_id: payload.review_id, tier, result: payload.result, votes, receipt, free: { used_today: used, per_day: FREE_PER_DAY[tier], left_today: FREE_PER_DAY[tier] - used }, note: "test" });
      }
      return send(res, 404, { error: `No route: ${req.method} ${path}` });
    } catch (e) {
      send(res, 500, { error: String(e?.stack ?? e) });
    }
  });

  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${http.address().port}`;
  return {
    url,
    publicKey: PUBLIC_KEY,
    signingKey: SIGNING_KEY,
    stats,
    async close() {
      globalThis.fetch = realFetch;
      http.closeAllConnections?.();
      await new Promise((r) => http.close(r));
    },
  };
}

/** A fake x402 paying fetch: adds an X-PAYMENT header shaped like a real one (the payer's address is readable). */
export function fakePayingFetch(wallet = "0x" + "1".repeat(40)) {
  return async (_key, maxMicro) => {
    let last = null;
    const header = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base", payload: { authorization: { from: wallet, value: String(maxMicro) } } })).toString("base64");
    return {
      wallet,
      lastSettlement: () => last,
      fetch: async (input, init = {}) => {
        const first = await fetch(input, init);
        if (first.status !== 402) return first;
        const res = await fetch(input, { ...init, headers: { ...(init.headers ?? {}), "X-PAYMENT": header } });
        const h = res.headers.get("x-payment-response");
        if (h) last = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
        return res;
      },
    };
  };
}
