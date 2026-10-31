// The hosted MCP server with in-memory Durable Objects and a fake Agent Referee that signs real Ed25519 receipts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256Hex } from "agent-referee-client";
import worker, { ReviewJob, subjectOf, countryHintOf } from "../src/worker.mjs";
import { callerIdFor } from "../src/job.mjs";

const b64 = (b) => Buffer.from(b).toString("base64");
async function keypair() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return { kp, pub: b64(await crypto.subtle.exportKey("raw", kp.publicKey)) };
}
const good = await keypair();
const evil = await keypair();
const VERDICTS = ["pass", "needs_changes", "fail", "cannot_assess"];

async function signedReview({ task, output, tier, key = good, funding = "free", verdict = "pass" }) {
  const models = tier === "review-3" ? ["claude-opus-5-5", "openai/gpt-6-luna", "google/gemini-3.7-flash"] : ["claude-sonnet-5-5"];
  const votes = models.map((model) => ({ model, verdict, summary: "ok", problems: [] }));
  const tally = Object.fromEntries(VERDICTS.map((v) => [v, votes.filter((x) => x.verdict === v).length]));
  const payload = {
    type: "review",
    review_id: "rv_test",
    tier,
    funding,
    payer: null,
    task_sha256: await sha256Hex(task),
    output_sha256: await sha256Hex(output),
    reviewers: { models, decision_rule: tier === "review-3" ? "majority" : "single" },
    votes,
    result: { verdict, tally, unanimous: true },
  };
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key.kp.privateKey, new TextEncoder().encode(canonicalJson(payload)));
  return { payload, signature: b64(sig), public_key: key.pub };
}

/** Durable Object namespace in memory. Alarms due now run on their own; later ones (the 24 h cleanup) wait for run(). */
function jobs(env) {
  const objs = new Map();
  const ns = {
    objs,
    idFromName: (n) => n,
    get(id) {
      if (!objs.has(id)) {
        const d = new Map();
        const o = { alarmAt: null };
        const storage = {
          async get(k) { return structuredClone(d.get(k)); },
          async put(k, v) { if (typeof k === "object") for (const [kk, vv] of Object.entries(k)) d.set(kk, structuredClone(vv)); else d.set(k, structuredClone(v)); },
          async delete(k) { return d.delete(k); },
          async deleteAll() { d.clear(); },
          async setAlarm(t) {
            o.alarmAt = t;
            if (t - Date.now() < 1000) setTimeout(() => o.job.alarm(), 0);
          },
        };
        o.data = d;
        o.job = new ReviewJob({ storage }, env);
        objs.set(id, o);
      }
      const o = objs.get(id);
      return { fetch: (u, i) => o.job.fetch(new Request(u, i)) };
    },
  };
  return ns;
}

function fakeReferee(answer) {
  const calls = [];
  return {
    calls,
    async fetch(req) {
      const body = await req.json();
      calls.push({ url: req.url, headers: Object.fromEntries(req.headers), body });
      return answer(req, body);
    },
  };
}
const okAnswer = (opts = {}) => async (req, body) => {
  const tier = req.url.endsWith("review-3") ? "review-3" : "review";
  const receipt = await signedReview({ task: body.task, output: body.output, tier, ...opts });
  return new Response(JSON.stringify({ review_id: "rv_test", tier, result: receipt.payload.result, votes: receipt.payload.votes, receipt, free: { used_today: 1, per_day: 3, left_today: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
};

function makeEnv(extra = {}, answer = okAnswer()) {
  const env = { INTERNAL_TOKEN: "t".repeat(40), EXTRA_PUBLIC_KEYS: good.pub, START_WAIT_MS: "2000", POLL_WAIT_MS: "2000", REFEREE_URL: "https://agentreferee.test", ...extra };
  env.REFEREE = fakeReferee(answer);
  env.JOBS = jobs(env);
  return env;
}

let nextId = 1;
async function rpc(env, method, params, { headers = {}, raw } = {}) {
  const body = raw ?? JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params });
  const res = await worker.fetch(new Request("https://mcp.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body }), env);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
const call = async (env, name, args, subject) => {
  const r = await rpc(env, "tools/call", { name, arguments: args, ...(subject ? { _meta: { "openai/subject": subject } } : {}) });
  return { ...r.body.result, data: r.body.result.structuredContent };
};
const work = { task: "Add 2 and 2 and give only the number.", output: "4" };

test("MCP basics: initialize, tools with explicit annotations, notifications accepted, other methods and origins refused", async () => {
  const env = makeEnv();
  const init = await rpc(env, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(init.status, 200);
  assert.equal(init.headers.get("content-type"), "application/json");
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.equal(init.body.result.serverInfo.name, "agent-referee");
  const list = (await rpc(env, "tools/list", {})).body.result.tools;
  assert.deepEqual(list.map((t) => t.name), ["start_review", "get_review", "verify_receipt"]);
  for (const t of list) for (const h of ["readOnlyHint", "destructiveHint", "openWorldHint"]) assert.equal(typeof t.annotations[h], "boolean", `${t.name} ${h}`);
  assert.equal(list[0].annotations.readOnlyHint, false, "start_review sends data out: not read-only");
  assert.equal(list[1].annotations.readOnlyHint, true);
  const note = await rpc(env, null, null, { raw: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(note.status, 202);
  const get = await worker.fetch(new Request("https://mcp.test/mcp"), env);
  assert.equal(get.status, 405);
  const page = await worker.fetch(new Request("https://mcp.test/mcp", { headers: { accept: "text/html" } }), env);
  assert.equal(page.status, 405, "a browser still gets 405");
  assert.match(await page.text(), /not a web page/);
  assert.equal((await rpc(env, "ping", {}, { headers: { origin: "https://evil.example" } })).status, 403);
  const fromChatgpt = await rpc(env, "ping", {}, { headers: { origin: "https://chatgpt.com" } });
  assert.equal(fromChatgpt.status, 200);
  assert.equal(fromChatgpt.headers.get("access-control-allow-origin"), "https://chatgpt.com");
  assert.equal((await rpc(env, "ping", {}, { headers: { "mcp-protocol-version": "1999-01-01" } })).status, 400);
  assert.equal((await rpc(env, null, null, { raw: "x".repeat(70_000) })).status, 413);
  assert.equal((await worker.fetch(new Request("https://mcp.test/"), env)).status, 200);
});

test("start_review: a quick review comes back done in one call, checked, with the person's id passed on and the text deleted", async () => {
  const env = makeEnv();
  const r = await call(env, "start_review", work, "user-123");
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.equal(r.data.status, "done");
  assert.equal(r.data.verdict, "pass");
  assert.equal(r.data.receipt.payload.funding, "free");
  assert.match(r.data.checked, /pinned key/);
  const sent = env.REFEREE.calls[0];
  assert.equal(sent.url, "https://agentreferee.test/internal/free/review");
  assert.equal(sent.headers["x-internal-auth"], "t".repeat(40));
  assert.equal(sent.headers["x-caller-id"], `chatgpt:${await callerIdFor(env, "user-123")}`, "only a keyed hash of the person's id is sent");
  assert.ok(!sent.headers["x-caller-id"].includes("user-123"));
  assert.deepEqual(Object.keys(sent.body).filter((k) => sent.body[k] !== undefined).sort(), ["output", "task"]);
  const [obj] = env.JOBS.objs.values();
  assert.equal(obj.data.has("input"), false, "the task and output are deleted once the review is done");
  assert.ok(!JSON.stringify([...obj.data.values()]).includes("user-123"), "the person's id isn't stored, only a hash");
  assert.ok(obj.alarmAt - Date.now() > 23 * 3600_000, "cleanup is scheduled about 24 h out");
  // The cleanup alarm deletes everything.
  obj.job.now = () => Date.now() + 25 * 3600_000;
  await obj.job.alarm();
  assert.equal(obj.data.size, 0);
});

test("start_review then get_review: the slow path, review-3, and only the same person can read it", async () => {
  const env = makeEnv({ START_WAIT_MS: "0" });
  const s = await call(env, "start_review", { ...work, tier: "review-3" }, "user-a");
  assert.equal(s.data.status, "queued");
  assert.match(s.data.next, /get_review/);
  const id = s.data.job_id;
  assert.match(id, /^[0-9a-f]{32}$/);
  const g = await call(env, "get_review", { job_id: id }, "user-a");
  assert.equal(g.data.status, "done", JSON.stringify(g.data));
  assert.equal(g.data.tier, "review-3");
  assert.equal(g.data.votes.length, 3);
  assert.equal(env.REFEREE.calls[0].url, "https://agentreferee.test/internal/free/review-3");
  assert.equal(g.data.attempted, undefined, "internal fields aren't shown");
  assert.equal((await call(env, "get_review", { job_id: id })).isError, true, "a job with an owner can't be read without an id");
  const other = await call(env, "get_review", { job_id: id }, "user-b");
  assert.equal(other.isError, true);
  assert.match(other.content[0].text, /No review with that job_id/);
  assert.equal((await call(env, "get_review", { job_id: "f".repeat(32) })).isError, true);
  assert.equal((await call(env, "get_review", { job_id: "nope" })).isError, true);
  assert.equal(env.REFEREE.calls.length, 1, "reading a result never starts another review");
});

test("an answer that doesn't check out isn't shown as a result", async () => {
  for (const [what, opts] of [["signed with another key", { key: evil }], ["not marked free", { funding: "paid" }]]) {
    const env = makeEnv({}, okAnswer(opts));
    const r = await call(env, "start_review", work);
    assert.equal(r.data.status, "failed", what);
    assert.ok(r.data.problems.length, what);
    assert.equal(r.data.verdict, undefined, what);
  }
  // A receipt about different text than was sent.
  const env = makeEnv({}, async (req, body) => okAnswer()(req, { ...body, output: "5" }));
  const r = await call(env, "start_review", work);
  assert.equal(r.data.status, "failed");
  assert.ok(r.data.problems.some((p) => /different output/.test(p)));
});

test("refusals and busy answers come back as clear failures; the free review isn't used", async () => {
  const limit = makeEnv({}, async () => new Response(JSON.stringify({ error: "You've used today's free single-reviewer reviews (3 per day per user)." }), { status: 429 }));
  const a = await call(limit, "start_review", work, "u");
  assert.equal(a.data.status, "failed");
  assert.match(a.data.error, /3 per day per user/);
  const busy = makeEnv({}, async () => new Response(JSON.stringify({ error: "busy", busy: true }), { status: 503, headers: { "retry-after": "30" } }));
  const b = await call(busy, "start_review", work);
  assert.deepEqual([b.data.busy, b.data.retry_after_seconds], [true, 30]);
  const wrong = makeEnv({}, async () => new Response(JSON.stringify({ error: "Wrong or missing internal token." }), { status: 401 }));
  assert.match((await call(wrong, "start_review", work)).data.error, /operator problem/);
  const down = makeEnv({}, async () => {
    throw new Error("network down");
  });
  assert.match((await call(down, "start_review", work)).data.error, /couldn.t be reached or didn.t answer in time/);
});

test("a review interrupted mid-way is never sent twice", async () => {
  const env = makeEnv({ START_WAIT_MS: "0" });
  const s = await call(env, "start_review", work);
  const obj = env.JOBS.objs.get(s.data.job_id);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(env.REFEREE.calls.length, 1);
  // Simulate the object restarting mid-review: the job says attempted but isn't finished, and the alarm fires again.
  const job = await obj.job.state.storage.get("job");
  await obj.job.state.storage.put("job", { ...job, status: "running", attempted: true });
  await obj.job.state.storage.put("input", { task: work.task, output: work.output });
  await obj.job.alarm();
  assert.equal(env.REFEREE.calls.length, 1);
  const g = await call(env, "get_review", { job_id: s.data.job_id });
  assert.equal(g.data.status, "failed");
  assert.match(g.data.error, /interrupted/);
  assert.equal(obj.data.has("input"), false);
});

test("start_review refuses bad input, a paused server and a missing connection, before anything is sent", async () => {
  const env = makeEnv();
  for (const bad of [{ task: "short", output: "4" }, { ...work, output: "x".repeat(12001) }, { ...work, tier: "judge" }, { ...work, extra: 1 }, { ...work, panel: [1] }]) {
    const r = await call(env, "start_review", bad);
    assert.equal(r.isError, true, JSON.stringify(bad).slice(0, 80));
  }
  assert.match((await call(makeEnv({ REMOTE_PAUSED: "true" }), "start_review", work)).content[0].text, /paused/);
  assert.match((await call(makeEnv({ INTERNAL_TOKEN: "" }), "start_review", work)).content[0].text, /isn't connected/);
  assert.equal(env.REFEREE.calls.length, 0);
});

test("verify_receipt: valid, tampered, wrong text, and not a receipt", async () => {
  const env = makeEnv();
  const receipt = await signedReview({ ...work, tier: "review" });
  const ok = await call(env, "verify_receipt", { receipt, ...work });
  assert.equal(ok.data.ok, true, JSON.stringify(ok.data));
  assert.equal(ok.data.funding, "free");
  const asText = await call(env, "verify_receipt", { receipt: JSON.stringify(receipt) });
  assert.equal(asText.data.signature_valid, true);
  assert.deepEqual(asText.data.not_checked, ["task", "output"]);
  const tampered = structuredClone(receipt);
  tampered.payload.result.verdict = "fail";
  assert.equal((await call(env, "verify_receipt", { receipt: tampered })).data.ok, false);
  const otherText = await call(env, "verify_receipt", { receipt, task: work.task, output: "5" });
  assert.equal(otherText.data.ok, false);
  assert.equal((await call(env, "verify_receipt", { receipt: { hello: 1 } })).isError, true);
  // The production key alone doesn't trust the test key.
  assert.equal((await call(makeEnv({ EXTRA_PUBLIC_KEYS: "" }), "verify_receipt", { receipt })).data.signature_valid, false);
});

test("subjectOf reads ChatGPT's anonymous id only when it's a plain short string", () => {
  assert.equal(subjectOf({ params: { _meta: { "openai/subject": "v1/abc" } } }), "v1/abc");
  assert.equal(subjectOf([{ method: "ping" }, { params: { _meta: { "openai/subject": "x" } } }]), "x");
  assert.equal(subjectOf({ params: { _meta: { "openai/subject": "has space" } } }), "has space");
  assert.equal(subjectOf({ params: { _meta: { "openai/subject": "   " } } }), undefined);
  assert.equal(subjectOf({ params: { _meta: { "openai/subject": "tab\there" } } }), undefined);
  assert.equal(subjectOf({ params: { _meta: { "openai/subject": "a".repeat(201) } } }), undefined);
  assert.equal(subjectOf(null), undefined);
});

test("ChatGPT's location hint: off by default; with LOCATION_HINTS on, only a two-letter country is sent on, never the city or coordinates", async () => {
  const loc = { city: "Springfield", region: "Somewhere", country: "us", timezone: "America/Chicago", latitude: 1.5, longitude: 2.5 };
  const meta = (l) => ({ name: "start_review", arguments: work, _meta: { "openai/subject": "user-9", "openai/userLocation": l } });
  // Off by default: nothing is read or sent.
  const off = makeEnv();
  await rpc(off, "tools/call", meta(loc));
  assert.equal(off.REFEREE.calls[0].headers["x-caller-country-hint"], undefined);
  // On: the country only.
  const on = makeEnv({ LOCATION_HINTS: "on" });
  await rpc(on, "tools/call", meta(loc));
  const sent = on.REFEREE.calls[0];
  assert.equal(sent.headers["x-caller-country-hint"], "US");
  const everything = JSON.stringify(sent) + JSON.stringify([...[...on.JOBS.objs.values()][0].data.values()]);
  for (const x of ["Springfield", "Somewhere", "America/Chicago", "1.5", "2.5"]) assert.ok(!everything.includes(x), `${x} is never sent or stored`);
  // Missing or odd values are treated as no hint.
  for (const l of [undefined, {}, { country: "USA" }, { country: 7 }, { country: "u1" }]) {
    const e = makeEnv({ LOCATION_HINTS: "on" });
    await rpc(e, "tools/call", meta(l));
    assert.equal(e.REFEREE.calls[0].headers["x-caller-country-hint"], undefined, JSON.stringify(l));
  }
  assert.equal(countryHintOf({ params: { _meta: { "openai/userLocation": { country: " de " } } } }, { LOCATION_HINTS: "ON" }), "DE");
  assert.equal(countryHintOf({ params: { _meta: { "openai/userLocation": { country: "DE" } } } }, {}), undefined);
});

test("the shown verdict comes from the signed receipt, not the rest of the answer; expired jobs can't be read", async () => {
  const env = makeEnv({}, async (req, body) => {
    const r = await okAnswer()(req, body);
    const d = await r.json();
    return new Response(JSON.stringify({ ...d, result: { verdict: "fail" }, votes: [] }), { status: 200 });
  });
  const r = await call(env, "start_review", work);
  assert.equal(r.data.status, "done");
  assert.equal(r.data.verdict, "pass");
  assert.equal(r.data.votes.length, 1);
  const [obj] = env.JOBS.objs.values();
  obj.job.now = () => Date.now() + 25 * 3600_000;
  assert.equal((await call(env, "get_review", { job_id: r.data.job_id })).isError, true);
});

test("panel must match the tier: 1 model for review, 3 different ones for review-3", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "start_review", { ...work, panel: ["a", "b"] })).isError, true);
  assert.equal((await call(env, "start_review", { ...work, tier: "review-3", panel: ["a", "a", "b"] })).isError, true);
  assert.equal((await call(env, "start_review", { ...work, tier: "review-3", panel: ["a"] })).isError, true);
  assert.equal(env.REFEREE.calls.length, 0);
  assert.equal((await call(env, "start_review", { ...work, panel: "rotate" })).data.status, "done");
});

test("a body over 64 KB is refused while streaming, even without a Content-Length", async () => {
  const env = makeEnv();
  const big = new TextEncoder().encode("é".repeat(40_000)); // 80,000 bytes, only 40,000 characters
  const stream = new ReadableStream({ start(c) { c.enqueue(big); c.close(); } });
  const res = await worker.fetch(new Request("https://mcp.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" }), env);
  assert.equal(res.status, 413);
});

test("an alarm that throws isn't rethrown; a job stuck running is reported as interrupted; every failure says whether the free review was used", async () => {
  const env = makeEnv({ START_WAIT_MS: "0" });
  const s = await call(env, "start_review", work);
  const obj = env.JOBS.objs.get(s.data.job_id);
  await new Promise((r) => setTimeout(r, 20));
  // A storage failure inside the alarm: alarm() resolves (no platform retry).
  const real = obj.job.state.storage.get;
  obj.job.state.storage.get = async () => { throw new Error("storage down"); };
  await obj.job.alarm();
  obj.job.state.storage.get = real;
  // Stuck "running" well past the review timeout: shown as failed, "maybe" used.
  const job = await obj.job.state.storage.get("job");
  await obj.job.state.storage.put("job", { ...job, status: "running", started_at: Date.now() - 10 * 60_000 });
  const g = await call(env, "get_review", { job_id: s.data.job_id });
  assert.equal(g.data.status, "failed");
  assert.equal(g.data.free_review_used, "maybe");
  assert.match(g.data.error, /may have used/);
  assert.equal(g.data.started_at, undefined);
  // A bad start request is refused cleanly.
  const bad = await env.JOBS.get("x".repeat(32)).fetch("https://job/start", { method: "POST", body: "not json" });
  assert.equal(bad.status, 400);
  // Refused by the service: "no"; answer that fails the checks: "yes".
  const refused = makeEnv({}, async () => new Response(JSON.stringify({ error: "busy" }), { status: 429 }));
  assert.equal((await call(refused, "start_review", work)).data.free_review_used, "no");
  const forged = makeEnv({}, okAnswer({ key: evil }));
  const f = await call(forged, "start_review", work);
  assert.equal(f.data.free_review_used, "probably");
  assert.match(f.data.error, /probably used/);
});

test("v3 fixes: a stuck job is marked failed for good and its text deleted; server errors say 'maybe'; an expired job is never sent", async () => {
  const env = makeEnv({ START_WAIT_MS: "0" });
  const s = await call(env, "start_review", work);
  const obj = env.JOBS.objs.get(s.data.job_id);
  await new Promise((r) => setTimeout(r, 20));
  const job = await obj.job.state.storage.get("job");
  await obj.job.state.storage.put("job", { ...job, status: "running", attempted: true, started_at: Date.now() - 10 * 60_000 });
  await obj.job.state.storage.put("input", { task: work.task, output: work.output });
  const g = await call(env, "get_review", { job_id: s.data.job_id });
  assert.equal(g.data.free_review_used, "maybe");
  assert.equal(obj.data.has("input"), false, "the text is deleted as soon as the job is known to have failed");
  assert.equal((await obj.job.state.storage.get("job")).status, "failed", "the failure is stored, not just shown");
  // A 502 without "wasn't used" in it: maybe. A 4xx: no.
  const e502 = makeEnv({}, async () => new Response(JSON.stringify({ error: "bad gateway" }), { status: 502 }));
  assert.equal((await call(e502, "start_review", work)).data.free_review_used, "maybe");
  const e502used = makeEnv({}, async () => new Response(JSON.stringify({ error: "A reviewer failed. Your free review wasn't used; try again." }), { status: 502 }));
  assert.equal((await call(e502used, "start_review", work)).data.free_review_used, "no");
  // A 200 whose body can't be read: maybe.
  const garbled = makeEnv({}, async () => new Response("not json", { status: 200 }));
  assert.equal((await call(garbled, "start_review", work)).data.free_review_used, "maybe");
  // An alarm that only runs after expiry deletes the job instead of sending it.
  const late = makeEnv({ START_WAIT_MS: "0" });
  const id = "e".repeat(32);
  const stub = late.JOBS.get(id);
  const o = late.JOBS.objs.get(id);
  o.job.alarm = () => Promise.resolve(); // hold the immediate alarm back
  await stub.fetch("https://job/start", { method: "POST", body: JSON.stringify({ id, tier: "review", ...work }) });
  delete o.job.alarm; // back to the real alarm, which now fires a day late
  o.job.now = () => Date.now() + 25 * 3600_000;
  await o.job.alarm();
  assert.equal(late.REFEREE.calls.length, 0, "an expired job is never sent");
  assert.equal(o.data.size, 0, "and it's deleted");
});
