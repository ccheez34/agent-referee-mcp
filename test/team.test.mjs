// Team mode: AGENT_REFEREE_TEAM_MEMBER (and AGENT_REFEREE_TEAM_TOKEN, unless the network adds it) sends sealed_review to
// /team/<tier> instead of paying from the wallet, and adds the team_allowance tool. Against the fake service's team
// stand-in (real review code, real signing), plus a mocked client for the multi-part tiers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startFakeService, fakePayingFetch, serverAvailable, SERVER_DIR } from "./fake-service.mjs";
import { spawnServer, inProcess, tempDir } from "./helpers.mjs";
import { createServer, loadConfig } from "../src/server.mjs";
import { createTools, makeTeamFetch } from "../src/tools.mjs";
import { Budget, ReceiptStore } from "../src/store.mjs";

const skip = serverAvailable() ? false : `server repo not found at ${SERVER_DIR} (set AGENT_REFEREE_SERVER_DIR)`;
const TOKEN = "team-token-for-tests-" + "x".repeat(24);
const task = "Add 12.5 and 9.7 and give the sum to one decimal place.";
let svc;
before(async () => {
  if (!skip) svc = await startFakeService({ joinWaitSeconds: 2, team: { token: TOKEN, members: ["3.0", "S1", "broke"], budgets: { broke: 0 } } });
});
after(async () => svc?.close());

const envFor = async (extra = {}) => ({ AGENT_REFEREE_URL: svc.url, AGENT_REFEREE_PUBLIC_KEYS: svc.publicKey, AGENT_REFEREE_DATA_DIR: await tempDir(), ...extra });
async function teamServer(extraEnv = {}, payer) {
  const c = inProcess(createServer, { config: loadConfig(await envFor({ AGENT_REFEREE_TEAM_MEMBER: "3.0", AGENT_REFEREE_TEAM_TOKEN: TOKEN, ...extraEnv })), deps: payer ? { makePayingFetch: payer } : undefined });
  await c.init();
  return c;
}

test("config: member alone is team mode (the network adds the token); a token needs a member; bad values are refused without echoing the token", () => {
  assert.deepEqual(loadConfig({ AGENT_REFEREE_TEAM_MEMBER: " T3 " }).team, { member: "T3", token: undefined });
  assert.equal(loadConfig({}).team, undefined);
  assert.throws(() => loadConfig({ AGENT_REFEREE_TEAM_TOKEN: TOKEN }), /AGENT_REFEREE_TEAM_MEMBER isn't/);
  assert.throws(() => loadConfig({ AGENT_REFEREE_TEAM_MEMBER: "two words" }), /TEAM_MEMBER must be/);
  for (const bad of ["short-token", "has a space " + "x".repeat(40)]) {
    try {
      loadConfig({ AGENT_REFEREE_TEAM_MEMBER: "3.0", AGENT_REFEREE_TEAM_TOKEN: bad });
      assert.fail("should refuse");
    } catch (e) {
      assert.match(e.message, /32 or more printable/);
      assert.ok(!e.message.includes(bad.trim()), "the error never repeats the token");
    }
  }
});

test("makeTeamFetch: headers only on /team/* paths; no token header when none is set", async () => {
  const seen = [];
  const base = async (url, init) => (seen.push({ url, headers: init.headers }), new Response("{}"));
  const f = makeTeamFetch({ member: "S1", token: TOKEN }, base);
  await f("https://agentreferee.ai/team/review", { headers: { "content-type": "application/json" } });
  await f("https://agentreferee.ai/pubkey", { headers: {} });
  await f("https://agentreferee.ai/teamwork", {});
  assert.deepEqual(seen[0].headers, { "content-type": "application/json", "x-team-member": "S1", "x-team-token": TOKEN });
  assert.deepEqual(seen[1].headers, {});
  assert.equal(seen[2].headers, undefined);
  await makeTeamFetch({ member: "S1" }, base)("https://agentreferee.ai/team/allowance", {});
  assert.deepEqual(seen[3].headers, { "x-team-member": "S1" });
});

test("stdio: team mode lists team_allowance and says so at startup, never printing the token", { skip }, async () => {
  const s = spawnServer(await envFor({ AGENT_REFEREE_TEAM_MEMBER: "3.0", AGENT_REFEREE_TEAM_TOKEN: TOKEN }));
  await s.init();
  const names = (await s.request("tools/list")).result.tools.map((t) => t.name);
  assert.deepEqual(names, ["demo_match", "tiebreak", "sealed_review", "verify_receipt", "saved_receipts", "team_allowance"]);
  const a = await s.call("team_allowance", {});
  assert.equal(a.isError, false, a.text);
  assert.equal(a.structured.team.member, "3.0");
  assert.match(a.structured.summary, /\$8\.00 usable now/);
  assert.match(s.stderr, /Team allowance: on, as member 3\.0 \(token from AGENT_REFEREE_TEAM_TOKEN\)/);
  assert.ok(!s.stderr.includes(TOKEN) && !a.text.includes(TOKEN), "the token never appears in output");
  assert.equal(await s.close(), 0);
  assert.deepEqual(s.badLines, []);
});

test("sealed_review in team mode: /team/<tier>, checked receipt with funding team, team block, no wallet touched even when one is set", { skip }, async () => {
  const before = { paid: svc.stats.paidRequests, unpaid: svc.stats.unpaidAttempts, team: svc.stats.teamRequests.length };
  const c = await teamServer({ AGENT_REFEREE_PRIVATE_KEY: "0x" + "11".repeat(32) }, fakePayingFetch());
  for (const tier of ["review", "review-3"]) {
    const r = await c.call("sealed_review", { task, output: "22.2", tier, title: "team one" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.verdict, "pass");
    assert.equal(r.data.check.ok, true, JSON.stringify(r.data.check));
    assert.equal(r.data.receipt.payload.funding, "team");
    assert.equal(r.data.receipt.payload.payer, null);
    assert.equal(r.data.paid, undefined);
    assert.equal(r.data.free, undefined);
    assert.equal(r.data.team.member, "3.0");
    assert.match(r.data.team.note, /no wallet was charged/);
    assert.match(r.data.summary, /Team allowance \(member 3\.0\): \$\d+\.\d\d usable now\./);
    assert.equal(r.data.spent_today, undefined, "the local wallet cap isn't involved");
    assert.ok(r.data.receipt_file);
    assert.ok(!r.text.includes(TOKEN));
  }
  const sent = svc.stats.teamRequests.slice(before.team);
  assert.deepEqual(sent.map((x) => x.path), ["/team/review", "/team/review-3"]);
  assert.ok(sent.every((x) => x.token === TOKEN && x.member === "3.0" && x.payment === null), "token and member sent, no payment header");
  assert.equal(svc.stats.paidRequests, before.paid, "the paid route was never used");
  assert.equal(svc.stats.unpaidAttempts, before.unpaid);
  const a = await c.call("team_allowance", {});
  assert.match(a.data.summary, /member \$7\.75 of \$8\.00 left today/);
});

test("team mode: free: true still uses a free review", { skip }, async () => {
  svc.stats.freeUsed = { review: 0, "review-3": 0 };
  const n = svc.stats.teamRequests.length;
  const c = await teamServer();
  const r = await c.call("sealed_review", { task, output: "22.2", free: true });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.receipt.payload.funding, "free");
  assert.equal(svc.stats.teamRequests.length, n);
});

test("team mode refusals: wrong token, unknown member, no budget, and the token missing (network didn't add it)", { skip }, async () => {
  const cases = [
    [{ AGENT_REFEREE_TEAM_TOKEN: "y".repeat(40) }, /refused the token.*Nothing was used/s],
    [{ AGENT_REFEREE_TEAM_TOKEN: "" }, /refused the token.*network didn't add it/s],
    [{ AGENT_REFEREE_TEAM_MEMBER: "4.0" }, /doesn't know this member.*AGENT_REFEREE_TEAM_MEMBER/s],
    [{ AGENT_REFEREE_TEAM_MEMBER: "broke" }, /doesn't fit your allowance.*Nothing was used\..*isn't used as a fallback/s],
  ];
  for (const [env, re] of cases) {
    const c = await teamServer(env);
    const r = await c.call("sealed_review", { task, output: "22.2" });
    assert.equal(r.isError, true, JSON.stringify(env));
    assert.match(r.text, re);
    assert.ok(!r.text.includes(TOKEN));
    const a = await c.call("team_allowance", {});
    if (env.AGENT_REFEREE_TEAM_MEMBER !== "broke") assert.equal(a.isError, true);
  }
});

test("team mode: a receipt that doesn't say funding team fails the check", { skip }, async () => {
  const other = await startFakeService({ team: { token: TOKEN, members: ["3.0"], funding: "free" } });
  try {
    const c = inProcess(createServer, { config: loadConfig({ AGENT_REFEREE_URL: other.url, AGENT_REFEREE_PUBLIC_KEYS: other.publicKey, AGENT_REFEREE_DATA_DIR: await tempDir(), AGENT_REFEREE_TEAM_MEMBER: "3.0", AGENT_REFEREE_TEAM_TOKEN: TOKEN }) });
    await c.init();
    const r = await c.call("sealed_review", { task, output: "22.2" });
    assert.equal(r.data.check.ok, false);
    assert.match(r.data.check.problems.join(" "), /should say "funding": "team"/);
    assert.match(r.data.summary, /^WARNING/);
  } finally {
    await other.close();
  }
});

test("team mode, multi-part: review-3x2 goes to /team/review-3x2 with the pieces and needs no wallet", async () => {
  const vx = JSON.parse(readFileSync(new URL("./fixtures/multi-review-vectors.json", import.meta.url), "utf8"));
  const valid = vx.cases.find((c) => c.id === "valid-3x2");
  const dir = await tempDir();
  const calls = [];
  const receipt = structuredClone(valid.receipt);
  const tools = createTools({
    config: { publicKeys: [vx.public_key], dailyLimitMicro: 1_000_000, url: "https://example.invalid", team: { member: "T3", token: TOKEN } },
    makeClient: (o) => ({
      _call: async (method, path, body) => {
        calls.push({ method, path, body, fetch: typeof o.fetch });
        const p = receipt.payload;
        return { review_id: p.review_id, tier: "review-3x2", result: p.result, votes: p.votes, receipt, team: { member: "T3", usable_now: "$7.40" } };
      },
      verifyReview: async () => ({ ok: true, problems: [], trusts: [] }),
    }),
    makePayingFetch: async () => assert.fail("no payment in team mode"),
    budget: new Budget({ dir, dailyLimitMicro: 1_000_000 }),
    receipts: new ReceiptStore({ dir }),
  });
  const review = tools.find((t) => t.name === "sealed_review").handler;
  const r = await review({ tier: "review-3x2", task: valid.given.task, pieces: valid.given.pieces }, { progress: () => {} });
  assert.equal(calls[0].path, "/team/review-3x2");
  assert.equal(calls[0].fetch, "function");
  assert.deepEqual(calls[0].body.pieces, valid.given.pieces);
  // The vector's receipt is a paid one, so the team-funding check flags it.
  assert.equal(r.check.ok, false);
  assert.match(r.summary, /Team allowance \(member T3\): \$7\.40 usable now/);
  // Free is still refused for multi-part, before anything is sent.
  await assert.rejects(review({ tier: "review-3x2", task: valid.given.task, pieces: valid.given.pieces, free: true }, { progress: () => {} }), /paid only/);
  assert.equal(calls.length, 1);
});
