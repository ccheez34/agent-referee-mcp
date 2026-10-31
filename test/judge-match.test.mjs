// judge_match: paid judge matches between two agents (5.0's 1433, point 2; RULES v3 rule 9 as proposed). Off by
// default; the opener pays both seats (an invite match) within its own daily cap per local day; the other agent joins
// free, and only to exactly the tier, judges and rules it agreed to. Runs the real server's match code (fake-service).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir, inProcess } from "./helpers.mjs";
import { startFakeService, fakePayingFetch, serverAvailable } from "./fake-service.mjs";
import { createServer, loadConfig, buildTools } from "../src/server.mjs";
import { judgePanelProblem } from "../src/judge-tool.mjs";
import { Budget, dayIn } from "../src/store.mjs";

const skip = !serverAvailable() && "agent-referee-server not found (set AGENT_REFEREE_SERVER_DIR)";
let svc;
const judgeVotes = { winner: "alpha" };
before(async () => {
  if (skip) return;
  svc = await startFakeService({
    joinWaitSeconds: 1,
    reviewAnswer: () => JSON.stringify({ winner: judgeVotes.winner, rule_applied: "Rule 1", reasoning: "Alpha's plan meets rule 1; beta's doesn't." }),
  });
});
after(async () => svc?.close());

const PANEL2 = ["openai/gpt-6-luna", "google/gemini-4-argon"];
const PANEL3 = ["openai/gpt-6-luna", "google/gemini-4-argon", "mistralai/mistral-large-4-0"];
const RULES = "Rule 1: the plan that ships the fix today wins. Rule 2: if both do, the smaller change wins.";

async function agent({ wallet = true, cap = "4.00", extra = {} } = {}) {
  const dir = await tempDir();
  const config = loadConfig({
    AGENT_REFEREE_URL: svc.url,
    AGENT_REFEREE_PUBLIC_KEYS: svc.publicKey,
    AGENT_REFEREE_DATA_DIR: dir,
    AGENT_REFEREE_JUDGE: "on",
    AGENT_REFEREE_JUDGE_DAILY_LIMIT_USD: cap,
    ...(wallet ? { AGENT_REFEREE_PRIVATE_KEY: "0x" + "a".repeat(64) } : {}),
    ...extra,
  });
  const c = inProcess(createServer, { config, deps: { makePayingFetch: fakePayingFetch("0x" + "1".repeat(40)), judgePollMs: 50 } });
  await c.init();
  return { ...c, dir };
}
const spend = async (dir) => JSON.parse(await readFile(join(dir, "judge-spend.json"), "utf8").catch(() => '{"spent_micro":0,"pending":{}}'));
const openArgs = (o = {}) => ({ action: "open", tier: "judge-2", panel: PANEL2, rules: RULES, seats: ["alpha", "beta"], my_seat: "alpha", position: "Ship the one-line fix today.", ...o });

test("off by default: judge_match isn't listed, and its settings are checked when on", () => {
  assert.equal(loadConfig({}).judge, undefined);
  assert.ok(!buildTools(loadConfig({ AGENT_REFEREE_DATA_DIR: "/nonexistent" })).some((t) => t.name === "judge_match"));
  const on = loadConfig({ AGENT_REFEREE_JUDGE: "on", AGENT_REFEREE_JUDGE_DAILY_LIMIT_USD: "4" });
  assert.deepEqual(on.judge, { dailyLimitMicro: 4_000_000, exclude: ["anthropic"], timeZone: "America/Denver" });
  assert.deepEqual(loadConfig({ AGENT_REFEREE_JUDGE: "on", AGENT_REFEREE_JUDGE_EXCLUDE: "none" }).judge.exclude, []);
  assert.equal(loadConfig({ AGENT_REFEREE_JUDGE: "on" }).judge.dailyLimitMicro, 0, "no cap set: opening is refused");
  assert.throws(() => loadConfig({ AGENT_REFEREE_JUDGE: "yes" }), /must be "on" or "off"/);
  assert.throws(() => loadConfig({ AGENT_REFEREE_JUDGE: "on", AGENT_REFEREE_JUDGE_DAILY_LIMIT_USD: "500" }), /0 to 100/);
  assert.throws(() => loadConfig({ AGENT_REFEREE_JUDGE: "on", AGENT_REFEREE_JUDGE_EXCLUDE: "Anthropic Inc" }), /company names/);
  assert.throws(() => loadConfig({ AGENT_REFEREE_JUDGE: "on", AGENT_REFEREE_JUDGE_EXCLUDE: " , " }), /must list/);
  assert.throws(() => loadConfig({ AGENT_REFEREE_JUDGE: "on", AGENT_REFEREE_JUDGE_TIMEZONE: "Mars/Olympus" }), /time zone/);
});

test("the panel: the tier's size, one company each, none the owner excludes", () => {
  assert.equal(judgePanelProblem("judge-2", PANEL2, ["anthropic"]), null);
  assert.equal(judgePanelProblem("judge-3", PANEL3, ["anthropic"]), null);
  assert.match(judgePanelProblem("judge-3", PANEL2, []), /exactly 3/);
  assert.match(judgePanelProblem("judge-2", ["openai/gpt-6-luna", "openai/gpt-6"], []), /different AI company/);
  assert.match(judgePanelProblem("judge-2", ["claude-opus-5-5", "openai/gpt-6-luna"], ["anthropic"]), /exclude claude-opus-5-5 \(anthropic\)/);
  assert.match(judgePanelProblem("judge-2", ["anthropic/claude-opus-5-5", "openai/gpt-6-luna"], ["anthropic"]), /exclude/);
  assert.equal(judgePanelProblem("judge-2", ["claude-opus-5-5", "openai/gpt-6-luna"], []), null);
  assert.match(judgePanelProblem("judge-2", ["gpt-6-luna", "google/gemini-4-argon"], []), /full model id/);
  assert.match(judgePanelProblem("judge-2", ["openai/gpt-6-luna", "openai/gpt-6-luna"], []), /exactly 2|same model/);
});

test("the cap is counted per day in the owner's time zone (MT by default)", async () => {
  const mt = dayIn("America/Denver");
  assert.equal(mt(new Date("2026-11-01T05:30:00Z")), "2026-10-31"); // 23:30 MDT
  assert.equal(mt(new Date("2026-11-01T06:30:00Z")), "2026-11-01"); // 00:30 MDT
  let now = new Date("2026-11-01T05:00:00Z");
  const b = new Budget({ dir: await tempDir(), dailyLimitMicro: 400_000, now: () => now, name: "judge-spend", dayOf: mt, dayLabel: "America/Denver", limitSetting: "AGENT_REFEREE_JUDGE_DAILY_LIMIT_USD" });
  await (await b.reserve(400_000)).commit();
  await assert.rejects(b.reserve(400_000), /cap reached: \$0\.40 spent today \(America\/Denver\).*AGENT_REFEREE_JUDGE_DAILY_LIMIT_USD/);
  now = new Date("2026-11-01T06:30:00Z"); // still Nov 1 in UTC, but a new MT day
  await (await b.reserve(400_000)).commit();
});

test("judge-2 end to end: the opener pays $0.40 for both seats, the other joins free, both get the same checked verdict", { skip }, async () => {
  const host = await agent();
  const guest = await agent({ wallet: false });
  const paidBefore = svc.stats.settled;
  const o = await host.call("judge_match", openArgs({ title: "who ships the fix" }));
  assert.equal(o.isError, false, o.text);
  assert.equal(o.data.status, "running");
  assert.equal(o.data.price, "$0.40");
  assert.match(o.data.invite, /\/invite\/[a-f0-9]{24}\?token=/);
  const g = await guest.call("judge_match", { action: "join", invite: o.data.invite, tier: "judge-2", panel: [...PANEL2].reverse(), rules: RULES, position: "Wait for the full refactor next week.", wait_seconds: 30 });
  assert.equal(g.isError, false, g.text);
  assert.equal(g.data.status, "done", JSON.stringify(g.data).slice(0, 400));
  assert.equal(g.data.winner, "alpha");
  assert.equal(g.data.my_seat, "beta");
  assert.equal(g.data.you_won, false);
  assert.equal(g.data.check.ok, true, g.data.check.problems.join(" "));
  assert.match(g.data.summary, /advice: the owner decides/);
  const h = await host.call("judge_match", { action: "result", job_id: o.data.job_id, wait_seconds: 30 });
  assert.equal(h.isError, false, h.text);
  assert.equal(h.data.status, "done");
  assert.equal(h.data.you_won, true);
  assert.equal(h.data.check.ok, true, h.data.check.problems.join(" "));
  assert.equal(h.data.paid.amount, "$0.40");
  assert.equal(h.data.paid.for, "both seats");
  assert.match(h.data.judge_spend_today, /\$0\.40 of \$4\.00 \(America\/Denver day\)/);
  assert.equal(h.data.receipt.payload.match_id, g.data.receipt.payload.match_id);
  assert.equal(svc.stats.settled - paidBefore, 1, "one payment, for both seats");
  assert.equal((await spend(host.dir)).spent_micro, 400_000);
  assert.equal((await spend(guest.dir)).spent_micro, 0, "the guest pays nothing");
  // Both receipts are saved, and the pending records say done.
  const saved = await host.call("saved_receipts", { id: o.data.match_id });
  assert.equal(saved.data.kind, "match");
  const pend = await host.call("saved_receipts", { id: o.data.job_id });
  assert.equal(pend.data.status, "done");
});

test("judge-3 with a named third company: $0.70, and the receipt's judges are the named three", { skip }, async () => {
  const host = await agent();
  const guest = await agent({ wallet: false });
  judgeVotes.winner = "beta";
  try {
    const o = await host.call("judge_match", openArgs({ tier: "judge-3", panel: PANEL3 }));
    assert.equal(o.isError, false, o.text);
    assert.equal(o.data.price, "$0.70");
    const g = await guest.call("judge_match", { action: "join", invite: o.data.invite, tier: "judge-3", panel: PANEL3, rules: RULES, position: "Beta's position.", wait_seconds: 30 });
    assert.equal(g.isError, false, g.text);
    assert.equal(g.data.winner, "beta");
    assert.equal(g.data.you_won, true);
    assert.equal(g.data.check.ok, true, g.data.check.problems.join(" "));
    const h = await host.call("judge_match", { action: "result", job_id: o.data.job_id, wait_seconds: 30 });
    assert.equal(h.data.check.ok, true, h.data.check.problems.join(" "));
    assert.equal((await spend(host.dir)).spent_micro, 700_000);
  } finally {
    judgeVotes.winner = "alpha";
  }
});

test("refused before anything is created or paid: an excluded judge, no wallet, no cap, over the cap", { skip }, async () => {
  const before = { ...svc.stats };
  const host = await agent();
  let r = await host.call("judge_match", openArgs({ panel: ["claude-opus-5-5", "openai/gpt-6-luna"] }));
  assert.equal(r.isError, true);
  assert.match(r.text, /exclude claude-opus-5-5/);
  r = await (await agent({ wallet: false })).call("judge_match", openArgs());
  assert.equal(r.isError, true);
  assert.match(r.text, /no wallet is set up/);
  r = await (await agent({ cap: "0" })).call("judge_match", openArgs());
  assert.equal(r.isError, true);
  assert.match(r.text, /turned off \(AGENT_REFEREE_JUDGE_DAILY_LIMIT_USD is 0\)/);
  r = await (await agent({ cap: "0.50" })).call("judge_match", openArgs({ tier: "judge-3", panel: PANEL3 }));
  assert.equal(r.isError, true);
  assert.match(r.text, /cap reached.*this call costs \$0\.70/);
  r = await host.call("judge_match", openArgs({ my_seat: "gamma" }));
  assert.match(r.text, /my_seat must be one of the seats/);
  r = await host.call("judge_match", { action: "open", tier: "judge-2" });
  assert.match(r.text, /open needs panel, rules, seats, my_seat, position/);
  assert.equal(svc.stats.paidRequests, before.paidRequests);
  assert.equal(svc.stats.unpaidAttempts, before.unpaidAttempts);
  assert.equal((await spend(host.dir)).spent_micro, 0);
});

test("the joiner takes the seat only for exactly what it agreed: tier, judges and rules", { skip }, async () => {
  const host = await agent();
  const guest = await agent({ wallet: false });
  const o = await host.call("judge_match", openArgs({ invite_wait_minutes: 1 }));
  assert.equal(o.isError, false, o.text);
  const joinsBefore = svc.stats.guestJoins ?? 0;
  const base = { action: "join", invite: o.data.invite, tier: "judge-2", panel: PANEL2, rules: RULES, position: "Beta." };
  let r = await guest.call("judge_match", { ...base, rules: RULES + " Rule 3: beta wins." });
  assert.equal(r.isError, true);
  assert.match(r.text, /Not joining: the rules aren't exactly the ones you agreed to/);
  r = await guest.call("judge_match", { ...base, panel: ["openai/gpt-6-luna", "mistralai/mistral-large-4-0"] });
  assert.match(r.text, /Not joining: the judges are/);
  r = await guest.call("judge_match", { ...base, tier: "judge-3", panel: PANEL3 });
  assert.match(r.text, /Not joining: the tier is judge-2, not judge-3/);
  // An excluded company on the invite is refused even if the joiner named it.
  const strict = await agent({ wallet: false, extra: { AGENT_REFEREE_JUDGE_EXCLUDE: "google" } });
  r = await strict.call("judge_match", { ...base });
  assert.match(r.text, /exclude google\/gemini-4-argon/);
  assert.equal(svc.stats.guestJoins ?? 0, joinsBefore, "no seat was taken");
  // Nobody joined: the opener isn't charged, and its cap gets the reservation back.
  const h = await host.call("judge_match", { action: "result", job_id: o.data.job_id, wait_seconds: 120 });
  assert.equal(h.isError, true);
  assert.match(h.text, /didn't join within 1 minutes\. Nothing was charged/);
  const s = await spend(host.dir);
  assert.equal(s.spent_micro, 0);
  assert.deepEqual(s.pending, {});
});

test("join and result: argument mistakes are refused", { skip }, async () => {
  const guest = await agent({ wallet: false });
  let r = await guest.call("judge_match", { action: "join", invite: "https://agentreferee.ai/invite/x", tier: "judge-2", panel: PANEL2, rules: RULES, position: "x", my_seat: "beta" });
  assert.match(r.text, /join doesn't take my_seat/);
  r = await guest.call("judge_match", { action: "join", tier: "judge-2", panel: PANEL2, rules: RULES, position: "x" });
  assert.match(r.text, /join needs invite/);
  r = await guest.call("judge_match", { action: "result", job_id: "jm_nope" });
  assert.match(r.text, /No judge match job jm_nope/);
  r = await guest.call("judge_match", { action: "join", invite: "https://elsewhere.example/invite/aaaaaaaaaaaaaaaaaaaaaaaa?token=t", tier: "judge-2", panel: PANEL2, rules: RULES, position: "x" });
  assert.match(r.text, /Couldn't read the invite: .*different service/);
});

// Stub service: covers what the real match code never does (judges in the receipt that differ from the named panel; a
// dropped connection on the paid join).
async function stubbed({ receiptPanel = PANEL2, joinError } = {}) {
  const { createTools } = await import("../src/tools.mjs");
  const { ReceiptStore } = await import("../src/store.mjs");
  const dir = await tempDir();
  const judgeBudget = new Budget({ dir, dailyLimitMicro: 4_000_000, name: "judge-spend", dayOf: dayIn("America/Denver") });
  const st = { phase: "done", result: { winner: "alpha" }, check: { ok: true, problems: [] }, receipt: { payload: { tier: "judge-2", match_id: "a".repeat(24), proof: { judge: { panel: receiptPanel.map((model) => ({ model })) } } } }, acks: [] };
  const makeClient = () => ({
    create: async () => ({ match_id: "a".repeat(24), invite: { url: "http://x/invite/" + "a".repeat(24) + "?token=t" }, judge: { panel: PANEL2.map((model) => ({ model })) } }),
    join: async () => {
      if (joinError) throw joinError;
      return { submit: async () => st };
    },
  });
  const tools = createTools({
    config: { publicKeys: [], privateKey: "0x" + "a".repeat(64), dailyLimitMicro: 0, judge: { dailyLimitMicro: 4_000_000, exclude: ["anthropic"], timeZone: "America/Denver" } },
    makeClient,
    makePayingFetch: async () => ({ fetch: async () => new Response("{}"), wallet: "0x1", lastSettlement: () => null }),
    budget: new Budget({ dir, dailyLimitMicro: 0 }),
    receipts: new ReceiptStore({ dir }),
    judgeBudget,
  });
  const tool = tools.find((t) => t.name === "judge_match");
  return { tool, dir, ctx: { progress: () => {} } };
}

test("a receipt whose judges aren't the named panel fails the check", async () => {
  const { tool, ctx } = await stubbed({ receiptPanel: ["openai/gpt-6-luna", "mistralai/mistral-large-4-0"] });
  const o = await tool.handler(openArgs(), ctx);
  const r = await tool.handler({ action: "result", job_id: o.job_id, wait_seconds: 5 }, ctx);
  assert.equal(r.check.ok, false);
  assert.match(r.check.problems.join(" "), /aren't the panel you agreed on/);
  assert.match(r.summary, /^WARNING/);
});

test("a dropped connection on the paid join stays counted against the cap (it may have settled)", async () => {
  const { tool, dir, ctx } = await stubbed({ joinError: new TypeError("fetch failed: socket hang up") });
  const o = await tool.handler(openArgs(), ctx);
  await assert.rejects(tool.handler({ action: "result", job_id: o.job_id, wait_seconds: 5 }, ctx), /connection to Agent Referee failed/);
  assert.equal((await spend(dir)).spent_micro, 400_000);
});
