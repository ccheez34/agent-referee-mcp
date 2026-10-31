// End to end: the real MCP server (over stdio, and in-process for paid calls) against the server repo's real
// match and review code with real Ed25519 signing (see fake-service.mjs). Skipped if the server repo isn't next to this one.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startFakeService, fakePayingFetch, serverAvailable, SERVER_DIR } from "./fake-service.mjs";
import { spawnServer, inProcess, tempDir } from "./helpers.mjs";
import { createServer, loadConfig } from "../src/server.mjs";

const skip = serverAvailable() ? false : `server repo not found at ${SERVER_DIR} (set AGENT_REFEREE_SERVER_DIR)`;
let svc;
before(async () => {
  if (!skip) svc = await startFakeService({ joinWaitSeconds: 2 });
});
after(async () => svc?.close());

const envFor = async (extra = {}) => ({ AGENT_REFEREE_URL: svc.url, AGENT_REFEREE_PUBLIC_KEYS: svc.publicKey, AGENT_REFEREE_DATA_DIR: await tempDir(), ...extra });

test("stdio: handshake, the five tools, and stdout carries nothing but JSON-RPC", { skip }, async () => {
  const s = spawnServer(await envFor());
  const init = await s.init("2025-06-18");
  assert.equal(init.result.serverInfo.name, "agent-referee");
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.match(init.result.instructions, /tiebreak/);
  const list = await s.request("tools/list");
  const names = list.result.tools.map((t) => t.name);
  assert.deepEqual(names, ["demo_match", "tiebreak", "sealed_review", "review_result", "verify_receipt", "saved_receipts"]);
  for (const t of list.result.tools) {
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.ok(t.description.length > 80, `${t.name} explains itself`);
    assert.ok(t.annotations, `${t.name} has annotations`);
  }
  assert.match(list.result.tools.find((t) => t.name === "sealed_review").description, /^FREE OR PAID/, "the tool says what it costs first");
  assert.equal(list.result.tools.find((t) => t.name === "verify_receipt").annotations.readOnlyHint, true);
  assert.match(s.stderr, /Paid reviews: off/);
  assert.equal(await s.close(), 0);
  assert.deepEqual(s.badLines, []);
});

test("demo_match: every random tier plays to a checked, signed, demo-marked result", { skip }, async () => {
  const s = spawnServer(await envFor());
  await s.init();
  for (const args of [{}, { tier: "weighted", weights: { alpha: 90, beta: 10 }, title: "Who drafts" }, { tier: "rps" }, { tier: "rps-bo3", seats: ["red", "blue"] }]) {
    const r = await s.call("demo_match", args);
    assert.equal(r.isError, false, r.text);
    const d = r.structured;
    assert.equal(d.demo, true);
    assert.equal(d.phase, "done");
    const seats = args.seats ?? ["alpha", "beta"];
    assert.ok(seats.includes(d.winner), `winner is a seat: ${d.winner}`);
    assert.ok(Object.values(d.checks).every((c) => c.ok), JSON.stringify(d.checks));
    assert.equal(d.receipt.payload.demo, true);
    assert.equal(d.receipt.payload.tier, args.tier ?? "weighted");
    if (args.weights) assert.deepEqual(d.receipt.payload.outcome.weights, args.weights);
    if (args.title) assert.equal(d.receipt.payload.title, args.title);
  }
  await s.close();
  assert.deepEqual(s.badLines, []);
});

test("demo_match refuses bad arguments before contacting the service", { skip }, async () => {
  const s = spawnServer(await envFor());
  await s.init();
  const cases = [
    [{ tier: "judge" }, /tier must be one of/],
    [{ seats: ["a"] }, /at least 2/],
    [{ seats: ["a", "a"] }, /unique/],
    [{ seats: ["a b", "c"] }, /isn't allowed/],
    [{ tier: "rps", weights: { alpha: 1, beta: 1 } }, /only apply to the weighted tier/],
    [{ weights: { alpha: 1, gamma: 1 } }, /one entry per seat/],
    [{ weights: { alpha: 0, beta: 1 } }, /at least 1/],
    [{ surprise: true }, /isn't a known argument/],
  ];
  for (const [args, re] of cases) {
    const r = await s.call("demo_match", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, re, JSON.stringify(args));
  }
  await s.close();
});

test("tiebreak: two agents, two separate MCP servers, one key: same match, same winner, both checks pass", { skip }, async () => {
  const [a, b] = [spawnServer(await envFor()), spawnServer(await envFor())];
  await Promise.all([a.init(), b.init()]);
  const settings = { key: `task-912-${Date.now()}`, tier: "weighted", seats: ["buyer", "seller"], weights: { buyer: 60, seller: 40 }, title: "Who ships first" };
  const [ra, rb] = await Promise.all([
    a.call("tiebreak", { ...settings, my_seat: "buyer" }, { progressToken: "pa" }),
    // The second agent arrives a moment later, like in real life.
    new Promise((r) => setTimeout(r, 300)).then(() => b.call("tiebreak", { ...settings, my_seat: "seller" })),
  ]);
  assert.equal(ra.isError, false, ra.text);
  assert.equal(rb.isError, false, rb.text);
  assert.equal(ra.structured.match_id, rb.structured.match_id);
  assert.equal(ra.structured.winner, rb.structured.winner);
  assert.notEqual(ra.structured.you_won, rb.structured.you_won, "exactly one of them won");
  assert.equal(ra.structured.check.ok, true, ra.structured.check.problems.join(" "));
  assert.equal(rb.structured.check.ok, true, rb.structured.check.problems.join(" "));
  assert.deepEqual(ra.structured.receipt, rb.structured.receipt, "both hold the identical signed receipt");
  assert.ok(ra.structured.acks.length >= 3, "join, commit and reveal acknowledgments");
  assert.ok(a.notifications.some((n) => n.method === "notifications/progress" && n.params.progressToken === "pa"), "progress reached the client that asked for it");
  assert.equal(b.notifications.length, 0, "and not the one that didn't");
  await Promise.all([a.close(), b.close()]);
  assert.deepEqual([...a.badLines, ...b.badLines], []);
});

test("tiebreak rps: a chosen first move is used and the result still verifies", { skip }, async () => {
  const [a, b] = [spawnServer(await envFor()), spawnServer(await envFor())];
  await Promise.all([a.init(), b.init()]);
  const settings = { key: `rps-${Date.now()}`, tier: "rps" };
  const [ra, rb] = await Promise.all([a.call("tiebreak", { ...settings, my_seat: "alpha", move: "rock" }), b.call("tiebreak", { ...settings, my_seat: "beta", move: "rock" })]);
  assert.equal(ra.isError, false, ra.text);
  const rounds = ra.structured.receipt.payload.proof.rounds;
  assert.equal(rounds[0].reveals.alpha.value, "rock");
  assert.equal(rounds[0].reveals.beta.value, "rock");
  assert.ok(rounds.length >= 2, "rock vs rock ties, so the match replayed (with random moves)");
  assert.equal(ra.structured.check.ok && rb.structured.check.ok, true);
  await Promise.all([a.close(), b.close()]);
});

test("tiebreak: different settings under one key are refused with a clear message", { skip }, async () => {
  const [a, b] = [spawnServer(await envFor()), spawnServer(await envFor())];
  await Promise.all([a.init(), b.init()]);
  const key = `clash-${Date.now()}`;
  // a creates first, then waits; b uses other odds and must be told, while a eventually times out alone.
  const pa = a.call("tiebreak", { key, my_seat: "alpha", weights: { alpha: 50, beta: 50 }, wait_seconds: 15 });
  await new Promise((r) => setTimeout(r, 300));
  const rb = await b.call("tiebreak", { key, my_seat: "beta", weights: { alpha: 70, beta: 30 } });
  assert.equal(rb.isError, true);
  assert.match(rb.text, /different settings/);
  const ra = await pa;
  assert.equal(ra.isError, true);
  assert.match(ra.text, /didn't join.*nothing is charged.*same key/s);
  await Promise.all([a.close(), b.close()]);
});

test("tiebreak: my_seat must be one of the seats; move only for rps", { skip }, async () => {
  const s = spawnServer(await envFor());
  await s.init();
  assert.match((await s.call("tiebreak", { key: "abc-1", my_seat: "gamma" })).text, /my_seat must be one of the seats/);
  assert.match((await s.call("tiebreak", { key: "abc-1", my_seat: "alpha", move: "rock" })).text, /only applies to the rps tiers/);
  assert.match((await s.call("tiebreak", { key: "a b", my_seat: "alpha" })).text, /key/);
  assert.match((await s.call("tiebreak", { my_seat: "alpha" })).text, /key is required/);
  await s.close();
});

test("verify_receipt: valid demo receipts pass and are flagged demo; any tampering fails", { skip }, async () => {
  const s = spawnServer(await envFor());
  await s.init();
  const { structured: d } = await s.call("demo_match", {});
  const good = await s.call("verify_receipt", { receipt: d.receipt });
  assert.equal(good.structured.ok, true, good.structured.problems.join(" "));
  assert.equal(good.structured.kind, "match");
  assert.equal(good.structured.demo, true);
  assert.equal(good.structured.recomputed, true);
  assert.match(good.structured.summary, /^Valid DEMO weighted/);

  // As a JSON string, too.
  assert.equal((await s.call("verify_receipt", { receipt: JSON.stringify(d.receipt) })).structured.ok, true);

  // Flip the winner: the signature breaks AND the recomputation disagrees.
  const loser = d.receipt.payload.parties.find((p) => p !== d.winner);
  const forged = structuredClone(d.receipt);
  forged.payload.outcome.winner = loser;
  const bad = await s.call("verify_receipt", { receipt: forged });
  assert.equal(bad.structured.ok, false);
  assert.equal(bad.structured.signature_valid, false);
  assert.ok(bad.structured.problems.some((p) => /Winner should be/.test(p)), bad.structured.problems.join(" | "));

  // Strip the demo flag to pass it off as paid: the signature catches it.
  const undemo = structuredClone(d.receipt);
  delete undemo.payload.demo;
  assert.equal((await s.call("verify_receipt", { receipt: undemo })).structured.signature_valid, false);

  assert.match((await s.call("verify_receipt", { receipt: "{nope" })).text, /not valid JSON/);
  assert.match((await s.call("verify_receipt", { receipt: { hello: 1 } })).text, /no payload/);
  await s.close();
});

test("verify_receipt without the right key: a receipt signed by someone else is not valid", { skip }, async () => {
  // This server pins only the real Agent Referee key, so the test service's receipts must fail.
  const s = spawnServer({ AGENT_REFEREE_URL: svc.url, AGENT_REFEREE_DATA_DIR: await tempDir() });
  await s.init();
  const other = spawnServer(await envFor());
  await other.init();
  const { structured: d } = await other.call("demo_match", {});
  const r = await s.call("verify_receipt", { receipt: d.receipt });
  assert.equal(r.structured.ok, false);
  assert.equal(r.structured.signature_valid, false);
  assert.match(r.structured.signature, /may be forged/);
  await Promise.all([s.close(), other.close()]);
});

// ---------- paid: sealed review (in-process, with a stand-in for the x402 wallet) ----------

async function reviewServer({ limit = "1.00", privateKey = "0x" + "a".repeat(64), now } = {}) {
  const dir = await tempDir();
  const config = loadConfig({ AGENT_REFEREE_URL: svc.url, AGENT_REFEREE_PUBLIC_KEYS: svc.publicKey, AGENT_REFEREE_DATA_DIR: dir, AGENT_REFEREE_DAILY_LIMIT_USD: limit, ...(privateKey ? { AGENT_REFEREE_PRIVATE_KEY: privateKey } : {}) });
  const c = inProcess(createServer, { config, deps: { makePayingFetch: fakePayingFetch("0x" + "1".repeat(40)), now } });
  await c.init("2025-06-18");
  return { ...c, dir };
}

const task = "Convert 72 degrees Fahrenheit to Celsius, rounded to one decimal place. Give only the number.";

test("sealed_review: pays once, returns a checked verdict, saves the receipt, counts the spend", { skip }, async () => {
  const c = await reviewServer();
  const before = { ...svc.stats };
  const r = await c.call("sealed_review", { task, output: "22.2", title: "temp conversion" });
  assert.equal(r.isError, false, r.text);
  const d = r.data;
  assert.equal(d.verdict, "pass");
  assert.equal(d.check.ok, true, d.check.problems.join(" "));
  assert.equal(d.votes.length, 1);
  assert.equal(d.paid.amount, "$0.05");
  assert.equal(d.paid.wallet, "0x" + "1".repeat(40));
  assert.equal(d.paid.transaction, `0x${"ab".repeat(32)}`, "the settlement transaction is reported");
  assert.match(d.spent_today, /^\$0\.05 of \$1\.00/);
  assert.equal(svc.stats.settled - before.settled, 1, "exactly one payment settled");
  assert.equal(svc.stats.unpaidAttempts - before.unpaidAttempts, 1, "the first request got the 402, then paid");
  assert.equal(d.receipt.payload.payer, "0x" + "1".repeat(40));

  const saved = JSON.parse(await readFile(d.receipt_file, "utf8"));
  assert.deepEqual(saved.receipt, d.receipt);
  assert.equal(saved.kind, "review");

  // The receiver's side: verify with the exact task and output, then with a different output.
  const ok = await c.call("verify_receipt", { receipt: d.receipt, task, output: "22.2" });
  assert.equal(ok.data.ok, true, ok.data.problems?.join(" "));
  assert.deepEqual(ok.data.not_checked, []);
  const wrong = await c.call("verify_receipt", { receipt: d.receipt, task, output: "22.3" });
  assert.equal(wrong.data.ok, false);
  assert.ok(wrong.data.problems.some((p) => /different output/.test(p)));
  const partial = await c.call("verify_receipt", { receipt: d.receipt });
  assert.equal(partial.data.ok, true);
  assert.equal(partial.data.not_checked.length, 2, "it says what it couldn't check");
  // A saved record (as saved_receipts returns it) verifies too.
  assert.equal((await c.call("verify_receipt", { receipt: saved, task, output: "22.2" })).data.ok, true);

  const listed = await c.call("saved_receipts", {});
  assert.equal(listed.data.receipts.filter((x) => x.kind === "review").length, 1);
  assert.equal(listed.data.receipts.filter((x) => x.kind === "pending").length, 1, "and the pending record saved before sending, now marked done");
  assert.equal(listed.data.receipts.find((x) => x.kind === "review").id, d.review_id);
  assert.equal(d.status, "done", "a quick review comes back in the same call");
  const pending = await c.call("saved_receipts", { id: d.job_id });
  assert.equal(pending.data.status, "done");
  assert.equal(pending.data.review_id, d.review_id, "the pending record points to the receipt");
  assert.equal((await c.call("saved_receipts", { id: d.review_id })).data.receipt.signature, d.receipt.signature);
});

test("sealed_review review-3: three companies' votes, majority recomputed, split reported", { skip }, async () => {
  const c = await reviewServer();
  const answers = { "claude-opus-5-5": "pass", "openai/gpt-6-luna": "fail", "google/gemini-3.7-flash": "needs_changes" };
  const restore = globalThis.fetch;
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    if (url.includes("api.anthropic.com") || url.includes("openrouter.ai")) {
      const body = JSON.parse(init.body);
      const v = answers[body.model] ?? "pass";
      const text = JSON.stringify({ verdict: v, confidence: "medium", issues: v === "pass" ? [] : ["Off by a rounding step."], reasoning: "r" });
      return url.includes("openrouter")
        ? new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: text }, finish_reason: "stop" }] }))
        : new Response(JSON.stringify({ model: body.model, content: [{ type: "text", text }] }));
    }
    return inner(input, init);
  };
  try {
    const r = await c.call("sealed_review", { task, output: "22.2", tier: "review-3" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.verdict, "split");
    assert.ok(r.data.split, "a split explains itself");
    assert.equal(r.data.votes.length, 3);
    assert.deepEqual(r.data.votes.map((v) => v.model), ["claude-opus-5-5", "openai/gpt-6-luna", "google/gemini-3.7-flash"]);
    assert.equal(r.data.check.ok, true, r.data.check.problems.join(" "));
    assert.equal(r.data.paid.amount, "$0.20");
    assert.match(r.data.summary, /1 pass, 1 needs_changes, 1 fail|1 pass, 1 fail, 1 needs_changes|split/);
  } finally {
    globalThis.fetch = restore;
  }
});

test("sealed_review: if the client gives up mid-review, the review still finishes, is saved and is counted", { skip }, async () => {
  const c = await reviewServer();
  // Slow reviewer, so the cancel arrives while the paid request is in flight.
  const restore = globalThis.fetch;
  const inner = globalThis.fetch;
  let release;
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    if (url.includes("api.anthropic.com")) await new Promise((r) => (release = r));
    return inner(input, init);
  };
  try {
    const id = 99;
    c.server.receive(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "sealed_review", arguments: { task, output: "22.2" } } }));
    while (!release) await new Promise((r) => setTimeout(r, 10));
    c.server.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "client timeout" } }));
    release();
    // Wait for the receipt to land on disk.
    let list;
    for (let i = 0; i < 100; i++) {
      list = (await c.call("saved_receipts", {})).data;
      if (list.receipts.some((x) => x.kind === "review")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(list.receipts.filter((x) => x.kind === "review").length, 1, "the receipt was saved even though nobody was waiting for it");
    assert.match(list.spent_today, /^\$0\.05/, "and the spend was counted");
    assert.equal(c.out.filter((m) => m.id === id).length, 0, "the cancelled call got no response");
  } finally {
    globalThis.fetch = restore;
  }
});

test("sealed_review: if the spend record can't be written after paying, the receipt still comes back (with a warning)", { skip }, async () => {
  const { Budget } = await import("../src/store.mjs");
  const realReserve = Budget.prototype.reserve;
  Budget.prototype.reserve = async function (price) {
    const hold = await realReserve.call(this, price);
    return { release: hold.release, commit: async () => { throw Object.assign(new Error("EPERM: operation not permitted, rename 'spend.json'"), { code: "EPERM" }); } };
  };
  try {
    const c = await reviewServer();
    const r = await c.call("sealed_review", { task, output: "22.2" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.check.ok, true);
    assert.ok(r.data.receipt_file, "the paid receipt was saved");
    assert.match(r.data.warnings.join(" "), /Couldn't update today's spend record.*counts this call as spent/);
  } finally {
    Budget.prototype.reserve = realReserve;
  }
});

test("the x402 wiring: capped per request, reports the wallet and the settlement, explains a missing package", async () => {
  const { defaultPayingFetch } = await import("../src/tools.mjs");
  const calls = [];
  const fakeX402 = {
    createSigner: async (network, key) => ({ network, key, account: { address: "0x" + "2".repeat(40) } }),
    wrapFetchWithPayment: (f, signer, max) => {
      calls.push({ network: signer.network, max });
      return f;
    },
    decodeXPaymentResponse: (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8")),
  };
  const settlement = { success: true, transaction: "0xfeed", network: "base" };
  const baseFetch = async () => new Response("{}", { headers: { "x-payment-response": Buffer.from(JSON.stringify(settlement)).toString("base64") } });
  const p = await defaultPayingFetch("0x" + "a".repeat(64), 200_000, { load: async () => fakeX402, baseFetch });
  assert.deepEqual(calls, [{ network: "base", max: 200_000n }], "Base mainnet, capped at exactly the price");
  assert.equal(p.wallet, "0x" + "2".repeat(40));
  assert.equal(p.lastSettlement(), null);
  await p.fetch("https://x/review", {});
  assert.deepEqual(p.lastSettlement(), settlement);
  await assert.rejects(defaultPayingFetch("0x", 1, { load: async () => { throw new Error("nope"); } }), /need the x402-fetch package.*npx -y -p agent-referee-mcp -p x402-fetch agent-referee-mcp/);
});

test("sealed_review: the daily cap stops a call before any payment is attempted", { skip }, async () => {
  const c = await reviewServer({ limit: "0.25" });
  assert.equal((await c.call("sealed_review", { task, output: "22.2", tier: "review-3" })).isError, false);
  const before = { ...svc.stats };
  const r = await c.call("sealed_review", { task, output: "22.2", tier: "review-3" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Daily spending cap reached: \$0\.20 spent today.*cap \$0\.25.*Nothing was charged/);
  assert.deepEqual(svc.stats, before, "the service was never contacted");
  // A cheaper review still fits exactly under the cap ($0.20 + $0.05 = $0.25)…
  assert.equal((await c.call("sealed_review", { task, output: "22.2" })).isError, false);
  // …and then nothing more does.
  assert.match((await c.call("sealed_review", { task, output: "22.2" })).text, /cap reached: \$0\.25 spent/);
});

test("sealed_review: a reviewer failure is not charged and frees the budget", { skip }, async () => {
  const c = await reviewServer({ limit: "0.05" });
  const restore = globalThis.fetch;
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    if (url.includes("api.anthropic.com")) return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 });
    return inner(input, init);
  };
  const before = { ...svc.stats };
  let r;
  try {
    r = await c.call("sealed_review", { task, output: "22.2" });
  } finally {
    globalThis.fetch = restore;
  }
  assert.equal(r.isError, true);
  assert.match(r.data.error, /Nothing was charged/);
  assert.equal(svc.stats.settled, before.settled, "no payment settled");
  // The $0.05 hold was released, so the whole $0.05 cap is still available.
  const ok = await c.call("sealed_review", { task, output: "22.2" });
  assert.equal(ok.isError, false, ok.text);
});

test("sealed_review: a malformed key, a cap of 0 or bad input never reach the service", { skip }, async () => {
  const before = { ...svc.stats };
  const badKey = await reviewServer({ privateKey: "0x1234" });
  const r2 = await badKey.call("sealed_review", { task, output: "22.2" });
  assert.match(r2.text, /isn't a 0x-prefixed 64-character hex key/);
  assert.doesNotMatch(r2.text, /0x1234/, "the key itself is never echoed");

  const off = await reviewServer({ limit: "0" });
  assert.match((await off.call("sealed_review", { task, output: "22.2" })).text, /turned off/);

  const c = await reviewServer();
  assert.match((await c.call("sealed_review", { task: "short", output: "x" })).text, /at least 10/);
  assert.match((await c.call("sealed_review", { task: "          abc          ", output: "x" })).text, /actual text/);
  assert.match((await c.call("sealed_review", { task, output: "   \n  " })).text, /output is empty/);
  assert.match((await c.call("sealed_review", { task, output: "x".repeat(12001) })).text, /at most 12000/);
  assert.match((await c.call("sealed_review", { task, output: "x", tier: "review-5" })).text, /must be one of/);
  assert.match((await c.call("sealed_review", { task, output: "x", criteria: [{ name: "a", weight: 1 }, { name: "a", weight: 2 }] })).text, /unique/);
  assert.deepEqual(svc.stats, before, "nothing reached the service");
});

test("sealed_review: a busy service refuses before payment; the agent is told when to retry and the cap isn't used", { skip }, async () => {
  const c = await reviewServer();
  const before = svc.stats.settled;
  svc.stats.busy = true;
  try {
    const r = await c.call("sealed_review", { task, output: "22.2", tier: "review" });
    assert.equal(r.isError, true);
    assert.match(r.data.error, /busy right now.*Nothing was charged.*spending cap wasn't used.*about 12 s/s);
    assert.equal(svc.stats.settled, before);
    const spend = JSON.parse(await readFile(join(c.dir, "spend.json"), "utf8"));
    assert.equal(spend.spent_micro, 0, "the reservation was given back");
    assert.deepEqual(spend.pending, {});
  } finally {
    svc.stats.busy = false;
  }
});

test("sealed_review: the service's own refusal (a panel it won't accept) is passed on, uncharged", { skip }, async () => {
  const c = await reviewServer();
  const before = svc.stats.settled;
  const r = await c.call("sealed_review", { task, output: "22.2", tier: "review", panel: ["claude-opus-5-5", "openai/gpt-6-luna"] });
  assert.equal(r.isError, true);
  assert.match(r.data.error, /panel.*Nothing was charged/s);
  assert.equal(svc.stats.settled, before);
});

test("sealed_review without a wallet uses today's free reviews: checked receipt marked free, nothing paid, a clear message when they run out", { skip }, async () => {
  svc.stats.freeUsed = { review: 0, "review-3": 0 };
  const before = { ...svc.stats };
  const none = await reviewServer({ privateKey: null });
  const r = await none.call("sealed_review", { task, output: "22.2", title: "free one" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.verdict, "pass");
  assert.equal(r.data.check.ok, true, JSON.stringify(r.data.check));
  assert.equal(r.data.receipt.payload.funding, "free");
  assert.equal(r.data.paid, undefined);
  assert.equal(r.data.free.left_today, 2);
  assert.match(r.data.summary, /Free review \(2 of this kind left today\)/);
  assert.ok(r.data.receipt_file, "the receipt is saved like a paid one");
  assert.equal(svc.stats.paidRequests, before.paidRequests, "no paid request");
  assert.equal(svc.stats.unpaidAttempts, before.unpaidAttempts, "never touched the paid route");
  await none.call("sealed_review", { task, output: "22.2" });
  await none.call("sealed_review", { task, output: "22.2" });
  const out = await none.call("sealed_review", { task, output: "22.2" });
  assert.equal(out.isError, true);
  assert.match(out.text, /used today's free single-reviewer reviews \(3 per day/);
  // review-3 has its own allowance of one.
  assert.equal((await none.call("sealed_review", { task, output: "22.2", tier: "review-3" })).isError, false);
  assert.match((await none.call("sealed_review", { task, output: "22.2", tier: "review-3" })).text, /free review-3 reviews \(1 per day/);
  const saved = await none.call("saved_receipts", {});
  assert.equal(saved.isError, false);
});

test("sealed_review with a wallet and free: true uses a free review and spends nothing", { skip }, async () => {
  svc.stats.freeUsed = { review: 0, "review-3": 0 };
  const before = { ...svc.stats };
  const c = await reviewServer();
  const r = await c.call("sealed_review", { task, output: "22.2", free: true });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.receipt.payload.funding, "free");
  assert.equal(r.data.receipt.payload.payer, null);
  assert.equal(svc.stats.paidRequests, before.paidRequests);
  assert.equal(r.data.spent_today, undefined, "a free review doesn't report the local spending cap");
  // Without free: true, a wallet means paid, as before.
  const paid = await c.call("sealed_review", { task, output: "22.2" });
  assert.equal(paid.data.paid.amount, "$0.05");
  assert.equal(paid.data.receipt.payload.funding, undefined);
});

test("a busy service refuses a free review without using it", { skip }, async () => {
  svc.stats.freeUsed = { review: 0, "review-3": 0 };
  const none = await reviewServer({ privateKey: null });
  svc.stats.busy = true;
  try {
    const r = await none.call("sealed_review", { task, output: "22.2" });
    assert.equal(r.isError, true);
    assert.match(r.text, /busy/i);
    assert.match(r.text, /Try again in about 12 s/);
  } finally {
    svc.stats.busy = false;
  }
  assert.equal(svc.stats.freeUsed.review, 0);
});
