// judge_match (B3, PLAN-v1.5): judge matches between the owner's own sessions, paid from the team allowance. Off by
// default; no wallet and no cap of its own; only a rule 9 dispute or an owner-approved match is played, and the kind
// rides in the match's title so the joiner and the receipt carry it. The opener's paid join goes through
// POST /team/host/join/<tier> (both seats to its member's allowance); the other agent joins free, and only to exactly
// the kind, tier, judges and rules it agreed to. Runs the real server's match code (fake-service).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir, inProcess } from "./helpers.mjs";
import { startFakeService, serverAvailable, modelSettings } from "./fake-service.mjs";
import { createServer, loadConfig, buildTools } from "../src/server.mjs";
import { judgePanelProblem, kindTitle, kindOfTitle, KINDS } from "../src/judge-tool.mjs";

const skip = !serverAvailable() && "agent-referee-server not found (set AGENT_REFEREE_SERVER_DIR)";
const TOKEN = "t".repeat(40);
let svc;
const judgeVotes = { winner: "alpha" };
before(async () => {
  if (skip) return;
  svc = await startFakeService({
    joinWaitSeconds: 1,
    reviewAnswer: () => JSON.stringify({ winner: judgeVotes.winner, rule_applied: "Rule 1", reasoning: "Alpha's plan meets rule 1; beta's doesn't." }),
    team: { token: TOKEN, members: ["3.0", "5.0", "poor"], budgets: { poor: 300_000 } },
  });
});
after(async () => svc?.close());

const PANEL2 = ["openai/gpt-6-luna", "google/gemini-4-argon"];
// A third company from the server's opt-in list: Mistral may not judge until it passes a judge trial (server, Oct 31).
const PANEL3 = ["openai/gpt-6-luna", "google/gemini-4-argon", "deepseek/deepseek-v4-pro-0813"];
const RULES = "Rule 1: the plan that ships the fix today wins. Rule 2: if both do, the smaller change wins.";
const DISPUTE = "2026-11-03 1226 from-2.0 to-3.0 - reply - the lock stays";
const YES = "yes to run judge-3 plan-5-vs-5.5 a7a6c1bd336e, $0.70 from the core pool";

async function agent({ member = "3.0", extra = {} } = {}) {
  const dir = await tempDir();
  const config = loadConfig({
    AGENT_REFEREE_URL: svc.url,
    AGENT_REFEREE_PUBLIC_KEYS: svc.publicKey,
    AGENT_REFEREE_DATA_DIR: dir,
    AGENT_REFEREE_JUDGE: "on",
    AGENT_REFEREE_TEAM_MEMBER: member,
    AGENT_REFEREE_TEAM_TOKEN: TOKEN,
    ...extra,
  });
  const c = inProcess(createServer, { config, deps: { judgePollMs: 50, judgeMinuteMs: 2000 } });
  await c.init();
  return { ...c, dir };
}
const openArgs = (o = {}) => ({ action: "open", kind: "dispute", dispute_message: DISPUTE, tier: "judge-2", panel: PANEL2, rules: RULES, seats: ["alpha", "beta"], my_seat: "alpha", position: "Ship the one-line fix today.", ...o });
const joinArgs = (invite, o = {}) => ({ action: "join", kind: "dispute", invite, tier: "judge-2", panel: PANEL2, rules: RULES, position: "Wait for the full refactor next week.", wait_seconds: 30, ...o });

test("off by default; on, it needs the team allowance and refuses the old wallet-cap settings", () => {
  assert.equal(loadConfig({}).judge, undefined);
  assert.ok(!buildTools(loadConfig({ AGENT_REFEREE_DATA_DIR: "/nonexistent" })).some((t) => t.name === "judge_match"));
  const on = loadConfig({ AGENT_REFEREE_JUDGE: "on", AGENT_REFEREE_TEAM_MEMBER: "3.0", AGENT_REFEREE_TEAM_TOKEN: TOKEN });
  assert.deepEqual(on.judge, { exclude: ["anthropic"] });
  assert.ok(buildTools({ ...on, dataDir: "/nonexistent", saveReceipts: false }).some((t) => t.name === "judge_match"));
  assert.deepEqual(loadConfig({ AGENT_REFEREE_JUDGE: "on", AGENT_REFEREE_TEAM_MEMBER: "3.0", AGENT_REFEREE_JUDGE_EXCLUDE: "none" }).judge.exclude, []);
  assert.throws(() => loadConfig({ AGENT_REFEREE_JUDGE: "on" }), /needs the team allowance \(AGENT_REFEREE_TEAM_MEMBER\)/);
  assert.throws(() => loadConfig({ AGENT_REFEREE_JUDGE: "on", AGENT_REFEREE_TEAM_MEMBER: "3.0", AGENT_REFEREE_JUDGE_DAILY_LIMIT_USD: "4" }), /isn't used any more/);
  assert.throws(() => loadConfig({ AGENT_REFEREE_JUDGE: "on", AGENT_REFEREE_TEAM_MEMBER: "3.0", AGENT_REFEREE_JUDGE_TIMEZONE: "America/Denver" }), /isn't used any more/);
  assert.throws(() => loadConfig({ AGENT_REFEREE_JUDGE: "yes" }), /must be "on" or "off"/);
  assert.throws(() => loadConfig({ AGENT_REFEREE_JUDGE: "on", AGENT_REFEREE_TEAM_MEMBER: "3.0", AGENT_REFEREE_JUDGE_EXCLUDE: "Anthropic Inc" }), /company names/);
  // A wallet on the entry doesn't make judge matches pay from it: the tool never takes a key.
  const withWallet = loadConfig({ AGENT_REFEREE_JUDGE: "on", AGENT_REFEREE_TEAM_MEMBER: "3.0", AGENT_REFEREE_PRIVATE_KEY: "0x" + "a".repeat(64), AGENT_REFEREE_DAILY_LIMIT_USD: "1" });
  assert.deepEqual(withWallet.judge, { exclude: ["anthropic"] });
});

test("the panel: the tier's size, one company each, none the owner excludes", () => {
  assert.equal(judgePanelProblem("judge-2", PANEL2, ["anthropic"]), null);
  assert.equal(judgePanelProblem("judge-3", PANEL3, ["anthropic"]), null);
  assert.match(judgePanelProblem("judge-3", PANEL2, []), /exactly 3/);
  assert.match(judgePanelProblem("judge-2", ["openai/gpt-6-luna", "openai/gpt-6"], []), /different AI company/);
  assert.match(judgePanelProblem("judge-2", ["claude-opus-5-5", "openai/gpt-6-luna"], ["anthropic"]), /exclude claude-opus-5-5 \(anthropic\)/);
  assert.equal(judgePanelProblem("judge-2", ["claude-opus-5-5", "openai/gpt-6-luna"], []), null);
  assert.match(judgePanelProblem("judge-2", ["gpt-6-luna", "google/gemini-4-argon"], []), /full model id/);
  assert.match(judgePanelProblem("judge-2", ["openai/gpt-6-luna", "openai/gpt-6-luna"], []), /exactly 2|same model/);
});

test("the kind rides in the title: written on open, read on join and from the receipt", async () => {
  assert.equal(await kindTitle({ kind: "dispute", dispute_message: DISPUTE }), `[rule 9 dispute: ${DISPUTE}]`);
  assert.equal(await kindTitle({ kind: "dispute", dispute_message: DISPUTE, title: "the lock" }), `[rule 9 dispute: ${DISPUTE}] the lock`);
  const approved = await kindTitle({ kind: "approved", approval: YES });
  assert.match(approved, /^\[owner-approved match: [0-9a-f]{12}\]$/);
  assert.deepEqual(kindOfTitle(`[rule 9 dispute: ${DISPUTE}] the lock`), { kind: "dispute", dispute_message: DISPUTE });
  assert.deepEqual(kindOfTitle(approved), { kind: "approved", approval_sha256_12: approved.slice("[owner-approved match: ".length, -1) });
  for (const bad of ["", "who ships the fix", "rule 9 dispute: x", "[rule 9 dispute: ]", "[owner-approved match: xyz]", "[owner-approved match: 0123456789ab", null, undefined]) assert.equal(kindOfTitle(bad), null, JSON.stringify(bad));
  assert.deepEqual(Object.keys(KINDS), ["dispute", "approved"]);
});

test("a rule 9 dispute, judge-2, end to end: both seats paid from the opener's allowance, no wallet, the kind in the receipt", { skip }, async () => {
  const host = await agent({ member: "3.0" });
  const guest = await agent({ member: "5.0" });
  const before = { ...svc.stats };
  const o = await host.call("judge_match", openArgs({ title: "who ships the fix" }));
  assert.equal(o.isError, false, o.text);
  assert.equal(o.data.status, "running");
  assert.equal(o.data.price, "$0.40");
  assert.equal(o.data.title, `[rule 9 dispute: ${DISPUTE}] who ships the fix`);
  assert.deepEqual(o.data.kind, { kind: "dispute", dispute_message: DISPUTE });
  assert.match(o.data.invite, /\/invite\/[a-f0-9]{24}\?token=/);
  const g = await guest.call("judge_match", joinArgs(o.data.invite, { panel: [...PANEL2].reverse() }));
  assert.equal(g.isError, false, g.text);
  assert.equal(g.data.status, "done", JSON.stringify(g.data).slice(0, 400));
  assert.equal(g.data.winner, "alpha");
  assert.equal(g.data.my_seat, "beta");
  assert.equal(g.data.you_won, false);
  assert.equal(g.data.check.ok, true, g.data.check.problems.join(" "));
  assert.deepEqual(g.data.kind, { kind: "dispute", dispute_message: DISPUTE });
  assert.match(g.data.free_seat, /team allowance/);
  const h = await host.call("judge_match", { action: "result", job_id: o.data.job_id, wait_seconds: 30 });
  assert.equal(h.isError, false, h.text);
  assert.equal(h.data.status, "done");
  assert.equal(h.data.you_won, true);
  assert.equal(h.data.check.ok, true, h.data.check.problems.join(" "));
  assert.deepEqual({ amount: h.data.paid.amount, for: h.data.paid.for, funding: h.data.paid.funding, member: h.data.paid.member }, { amount: "$0.40", for: "both seats", funding: "team", member: "3.0" });
  assert.equal(h.data.paid.team.member_spent_today, "$0.40");
  assert.equal(h.data.receipt.payload.match_id, g.data.receipt.payload.match_id);
  assert.equal(h.data.receipt.payload.title, o.data.title, "the kind is in the signed receipt");
  assert.deepEqual(h.data.receipt.payload.paid_by, {}, "no wallet paid");
  // The payment went through the team route only: no x402 request, no payer.
  assert.equal((svc.stats.teamHostJoins ?? 0) - (before.teamHostJoins ?? 0), 1);
  assert.equal(svc.stats.paidRequests, before.paidRequests, "no x402 payment");
  assert.equal(svc.stats.unpaidAttempts, before.unpaidAttempts);
  const teamCalls = svc.stats.teamRequests.filter((r) => r.path === "/team/host/join/judge-2");
  assert.ok(teamCalls.length >= 1 && teamCalls.every((r) => r.token === TOKEN && r.member === "3.0" && r.payment === null));
  // Both receipts are saved with the kind, and the pending records say done.
  const saved = await host.call("saved_receipts", { id: o.data.match_id });
  assert.equal(saved.data.kind, "match");
  assert.deepEqual(saved.data.match_kind, { kind: "dispute", dispute_message: DISPUTE });
  const pend = await host.call("saved_receipts", { id: o.data.job_id });
  assert.equal(pend.data.status, "done");
});

test("a judge the service excludes (JUDGE_EXCLUDE in its wrangler.jsonc) is refused by the service, before anyone pays", { skip }, async () => {
  const excluded = (modelSettings().JUDGE_EXCLUDE ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  if (!excluded.length) return; // nothing excluded today: nothing to refuse
  const host = await agent({ member: "3.0" });
  for (const model of excluded) {
    const o = await host.call("judge_match", openArgs({ kind: "approved", dispute_message: undefined, approval: YES, tier: "judge-3", panel: ["openai/gpt-6-luna", "google/gemini-4-argon", model] }));
    assert.equal(o.isError, true, `${model}: ${o.text}`);
    assert.match(o.text, /Not in the approved model pool/, o.text);
  }
});

test("an owner-approved match, judge-3: the yes line's text and sha256 are recorded, its first 12 hex are in the title and the receipt", { skip }, async () => {
  const host = await agent({ member: "3.0" });
  const guest = await agent({ member: "5.0" });
  const o = await host.call("judge_match", openArgs({ kind: "approved", dispute_message: undefined, approval: YES, tier: "judge-3", panel: PANEL3 }));
  assert.equal(o.isError, false, o.text);
  assert.equal(o.data.price, "$0.70");
  assert.equal(o.data.kind.kind, "approved");
  assert.equal(o.data.kind.approval, YES);
  assert.match(o.data.kind.approval_sha256, /^[0-9a-f]{64}$/);
  assert.equal(o.data.title, `[owner-approved match: ${o.data.kind.approval_sha256.slice(0, 12)}]`);
  const g = await guest.call("judge_match", joinArgs(o.data.invite, { kind: "approved", tier: "judge-3", panel: PANEL3 }));
  assert.equal(g.isError, false, g.text);
  assert.equal(g.data.check.ok, true, g.data.check.problems.join(" "));
  assert.deepEqual(g.data.kind, { kind: "approved", approval_sha256_12: o.data.kind.approval_sha256.slice(0, 12) }, "the joiner records the fingerprint it read from the title");
  const h = await host.call("judge_match", { action: "result", job_id: o.data.job_id, wait_seconds: 30 });
  assert.equal(h.isError, false, h.text);
  assert.equal(h.data.check.ok, true, h.data.check.problems.join(" "));
  assert.equal(h.data.kind.approval, YES);
  assert.equal(h.data.receipt.payload.title, o.data.title);
  const pend = await host.call("saved_receipts", { id: o.data.job_id });
  assert.equal(pend.data.match_kind.approval_sha256, o.data.kind.approval_sha256);
});

test("refused before anything is created or paid: no kind, a kind without its field, a yes line without a yes, both fields, an excluded judge", { skip }, async () => {
  const before = { ...svc.stats };
  const host = await agent();
  const refuse = async (args, re) => {
    const r = await host.call("judge_match", args);
    assert.equal(r.isError, true, JSON.stringify(r.data ?? r.text).slice(0, 200));
    assert.match(r.text, re);
    assert.match(r.text, /Nothing was charged/);
  };
  await refuse(openArgs({ kind: undefined, dispute_message: undefined }), /open needs .*kind/);
  await refuse(openArgs({ dispute_message: undefined }), /kind "dispute" needs dispute_message/);
  await refuse(openArgs({ dispute_message: "a ] b" }), /closing bracket/);
  await refuse(openArgs({ kind: "approved", dispute_message: undefined, approval: "go ahead and run it" }), /has to contain "yes"/);
  await refuse(openArgs({ kind: "approved", dispute_message: undefined }), /kind "approved" needs approval/);
  await refuse(openArgs({ approval: YES }), /kind "dispute" doesn't take approval/);
  await refuse(openArgs({ kind: "approved", approval: YES }), /kind "approved" doesn't take dispute_message/);
  await refuse(openArgs({ panel: ["claude-opus-5-5", "openai/gpt-6-luna"] }), /exclude claude-opus-5-5/);
  await refuse(openArgs({ my_seat: "gamma" }), /my_seat must be one of the seats/);
  const r = await host.call("judge_match", { action: "open", tier: "judge-2" });
  assert.match(r.text, /open needs panel, rules, seats, my_seat, position, kind/);
  assert.equal(svc.stats.teamRequests.filter((x) => x.path.startsWith("/team/host/join")).length, before.teamRequests.filter((x) => x.path.startsWith("/team/host/join")).length, "no paid join");
  assert.equal(svc.stats.paidRequests, before.paidRequests);
});

test("the allowance refuses the paid join (429): the opener is told, nothing is counted as paid", { skip }, async () => {
  const host = await agent({ member: "poor" }); // $0.30 a day in the fake service
  const guest = await agent({ member: "5.0" });
  const o = await host.call("judge_match", openArgs({ invite_wait_minutes: 1 }));
  assert.equal(o.isError, false, o.text);
  const g = await guest.call("judge_match", joinArgs(o.data.invite, { wait_seconds: 5 }));
  // The guest's free seat is taken whether or not the host's payment goes through; the host's result says what happened.
  const h = await host.call("judge_match", { action: "result", job_id: o.data.job_id, wait_seconds: 30 });
  assert.equal(h.isError, true, JSON.stringify(h.data ?? h.text).slice(0, 300));
  assert.match(h.text, /The paid join failed: .*doesn't fit your allowance today/);
  assert.match(h.text, /Nothing was used/);
  assert.doesNotMatch(h.text, /basescan|refund list|may have been charged/);
  assert.equal(h.data?.charge, "none");
  const pend = await host.call("saved_receipts", { id: o.data.job_id });
  assert.equal(pend.data.status, "failed");
  assert.equal(pend.data.charge, "none");
  assert.equal(pend.data.note, undefined, "the 'saved before anything was paid' note goes once the job ends");
  // The guest's free seat was taken; with the host never seated, its call ends without a verdict and without a charge.
  assert.ok(g.isError === true || ["running", "done"].includes(g.data?.status), JSON.stringify(g.data ?? g.text).slice(0, 200));
  if (g.isError) assert.match(g.text, /Your seat is free/);
});

test("a lost answer after the paid join went through: the host is told the charge may have happened, the record says so, and no retry is advised", { skip }, async () => {
  const host = await agent({ member: "3.0" });
  const guest = await agent({ member: "5.0" });
  const before = { ...svc.stats };
  const o = await host.call("judge_match", openArgs({ invite_wait_minutes: 1 }));
  assert.equal(o.isError, false, o.text);
  svc.stats.dropNextTeamJoin = true;
  const g = guest.call("judge_match", joinArgs(o.data.invite, { wait_seconds: 5 }));
  const h = await host.call("judge_match", { action: "result", job_id: o.data.job_id, wait_seconds: 30 });
  await g;
  assert.equal(h.isError, true, JSON.stringify(h.data ?? h.text).slice(0, 300));
  assert.match(h.text, /didn't get a clear answer/);
  assert.match(h.text, /may have been charged to the team allowance/);
  assert.match(h.text, /don't retry this open/);
  assert.match(h.text, new RegExp(`GET /matches/${o.data.match_id}`));
  assert.equal(h.data?.charge, "unclear");
  assert.equal(h.data?.price, "$0.40");
  assert.equal((svc.stats.teamSettled ?? 0) - (before.teamSettled ?? 0), 1, "the service did charge and seat the host");
  const pend = await host.call("saved_receipts", { id: o.data.job_id });
  assert.equal(pend.data.status, "failed");
  assert.equal(pend.data.charge, "unclear");
  assert.equal(svc.stats.dropNextTeamJoin, false);
});

test("an owner-approved match: one yes line pays for one match; with saved receipts off it isn't opened at all", { skip }, async () => {
  const host = await agent({ member: "3.0" });
  const guest = await agent({ member: "5.0" });
  const line = "yes to run judge-2 the-lock-question 0123456789ab, $0.40 from the core pool";
  const o = await host.call("judge_match", openArgs({ kind: "approved", dispute_message: undefined, approval: line, invite_wait_minutes: 1 }));
  assert.equal(o.isError, false, o.text);
  const again = await host.call("judge_match", openArgs({ kind: "approved", dispute_message: undefined, approval: `  ${line}  `, rules: RULES + " Rule 3: tie goes to alpha." }));
  assert.equal(again.isError, true);
  assert.match(again.text, new RegExp(`already used for match ${o.data.match_id}`));
  assert.match(again.text, /approves matches one at a time/);
  assert.match(again.text, /Nothing was charged/);
  const rec = await host.call("saved_receipts", { id: o.data.kind.approval_sha256 });
  assert.equal(rec.data.kind, "approval");
  assert.equal(rec.data.approval, line);
  assert.equal(rec.data.match_id, o.data.match_id);
  // The same line is reusable by another server only if that server shares the receipts folder: a second entry with
  // its own folder doesn't see it, which is why one core entry holds judge matches (PLAN-v1.5, B3).
  const r2 = await guest.call("judge_match", openArgs({ kind: "approved", dispute_message: undefined, approval: line, invite_wait_minutes: 1 }));
  assert.equal(r2.isError, false, "another entry's folder: not seen (by design; one entry for judge matches)");
  const off = await agent({ member: "3.0", extra: { AGENT_REFEREE_SAVE_RECEIPTS: "false" } });
  const r3 = await off.call("judge_match", openArgs({ kind: "approved", dispute_message: undefined, approval: "yes to one more" }));
  assert.equal(r3.isError, true);
  assert.match(r3.text, /needs saved receipts on/);
  // Nobody joins any of them: nothing is charged.
  for (const [a, j] of [[host, o.data.job_id], [guest, r2.data.job_id]]) {
    const h = await a.call("judge_match", { action: "result", job_id: j, wait_seconds: 120 });
    assert.match(h.text, /didn't join within 1 minutes\. Nothing was charged/);
  }
});

test("the match title must fit the service's 200 characters: the marker plus the label is refused before anything is created", { skip }, async () => {
  const host = await agent();
  const before = { ...svc.stats };
  const message = "m".repeat(160);
  const r = await host.call("judge_match", openArgs({ dispute_message: message, title: "a label that pushes it over the line" }));
  assert.equal(r.isError, true);
  assert.match(r.text, /over the service's 200/);
  assert.match(r.text, /Nothing was charged/);
  const ok = await host.call("judge_match", openArgs({ dispute_message: message, invite_wait_minutes: 1 }));
  assert.equal(ok.isError, false, ok.text);
  assert.equal(ok.data.title.length, 178);
  assert.equal(svc.stats.teamRequests.filter((x) => x.path.startsWith("/team/host/join")).length, before.teamRequests.filter((x) => x.path.startsWith("/team/host/join")).length);
});

test("the joiner takes the seat only for exactly what it agreed: kind, tier, judges and rules; an invite without a kind is refused", { skip }, async () => {
  const host = await agent({ member: "3.0" });
  const guest = await agent({ member: "5.0" });
  const o = await host.call("judge_match", openArgs({ invite_wait_minutes: 1 }));
  assert.equal(o.isError, false, o.text);
  const joinsBefore = svc.stats.guestJoins ?? 0;
  let r = await guest.call("judge_match", joinArgs(o.data.invite, { rules: RULES + " Rule 3: beta wins." }));
  assert.equal(r.isError, true);
  assert.match(r.text, /Not joining: the rules aren't exactly the ones you agreed to/);
  r = await guest.call("judge_match", joinArgs(o.data.invite, { panel: ["openai/gpt-6-luna", "mistralai/mistral-large-4-0"] }));
  assert.match(r.text, /Not joining: the judges are/);
  r = await guest.call("judge_match", joinArgs(o.data.invite, { tier: "judge-3", panel: PANEL3 }));
  assert.match(r.text, /Not joining: the tier is judge-2, not judge-3/);
  r = await guest.call("judge_match", joinArgs(o.data.invite, { kind: "approved" }));
  assert.match(r.text, /Not joining: it is rule 9 dispute, not owner-approved match/);
  r = await guest.call("judge_match", joinArgs(o.data.invite, { dispute_message: "another message" }));
  assert.match(r.text, /Not joining: its dispute message is/);
  r = await guest.call("judge_match", joinArgs(o.data.invite, { kind: undefined }));
  assert.match(r.text, /join needs .*kind/);
  const strict = await agent({ member: "5.0", extra: { AGENT_REFEREE_JUDGE_EXCLUDE: "google" } });
  r = await strict.call("judge_match", joinArgs(o.data.invite));
  assert.match(r.text, /exclude google\/gemini-4-argon/);
  assert.equal(svc.stats.guestJoins ?? 0, joinsBefore, "no seat was taken");
  // An invite match created outside this tool, with a plain title, isn't a kind this tool plays.
  const { AgentReferee } = await import("agent-referee-client");
  const plain = await new AgentReferee({ url: svc.url, publicKeys: [svc.publicKey] }).create({ tier: "judge-2", seats: ["alpha", "beta"], rules: RULES, panel: PANEL2, title: "who ships the fix", hostPays: "alpha" });
  r = await guest.call("judge_match", joinArgs(plain.invite.url));
  assert.match(r.text, /Not joining: its title carries no kind/);
  assert.equal(svc.stats.guestJoins ?? 0, joinsBefore, "no seat was taken");
  // Nobody joined the first match: the opener isn't charged.
  const h = await host.call("judge_match", { action: "result", job_id: o.data.job_id, wait_seconds: 120 });
  assert.equal(h.isError, true);
  assert.match(h.text, /didn't join within 1 minutes\. Nothing was charged/);
});

test("join and result: argument mistakes are refused", { skip }, async () => {
  const guest = await agent({ member: "5.0" });
  let r = await guest.call("judge_match", joinArgs("https://agentreferee.ai/invite/x", { my_seat: "beta" }));
  assert.match(r.text, /join doesn't take my_seat/);
  r = await guest.call("judge_match", joinArgs("https://agentreferee.ai/invite/x", { approval: YES }));
  assert.match(r.text, /join doesn't take approval/);
  r = await guest.call("judge_match", { action: "join", kind: "dispute", tier: "judge-2", panel: PANEL2, rules: RULES, position: "x" });
  assert.match(r.text, /join needs invite/);
  r = await guest.call("judge_match", { action: "result", job_id: "jm_nope" });
  assert.match(r.text, /No judge match job jm_nope/);
  r = await guest.call("judge_match", joinArgs("https://elsewhere.example/invite/aaaaaaaaaaaaaaaaaaaaaaaa?token=t"));
  assert.match(r.text, /Couldn't read the invite: .*different service/);
});

// Stub service: covers what the real match code never does (judges in the receipt that differ from the named panel; a
// receipt that names a paying wallet or another funding; a title without the kind; a forfeit).
const { Seat: ClientSeat } = await import("agent-referee-client");
const realSubmit = ClientSeat.prototype.submit;
async function stubbed({ receiptPanel = PANEL2, result = { winner: "alpha" }, payload = {}, phase = "done", joinAnswer, minuteMs } = {}) {
  const { createTools } = await import("../src/tools.mjs");
  const { ReceiptStore, Budget } = await import("../src/store.mjs");
  const dir = await tempDir();
  const MID = "a".repeat(24);
  const title = `[rule 9 dispute: ${DISPUTE}]`;
  const st = { phase, result, check: { ok: true, problems: [] }, receipt: { payload: { tier: "judge-2", match_id: MID, title, paid_by: {}, proof: { judge: { panel: receiptPanel.map((model) => ({ model })) } }, ...payload } }, acks: [], ...(phase === "error" ? { error: "the judges didn't answer" } : {}) };
  const calls = [];
  const requested = new Map();
  const makeClient = (o) => ({
    _requested: requested,
    create: async (spec) => {
      requested.set(MID, { tier: spec.tier, rules: spec.rules, seats: spec.seats, panel: spec.panel, host_pays: spec.hostPays });
      return { match_id: MID, title: spec.title, invite: { url: "http://x/invite/" + MID + "?token=t" }, judge: { panel: PANEL2.map((model) => ({ model })) } };
    },
    _call: async (method, path, body) => {
      calls.push({ method, path, body, teamFetch: typeof o.fetch === "function", at: Date.now() });
      if (joinAnswer) throw joinAnswer;
      return { seat: body.seat, seat_token: "st", ack: null, team: { member_spent_today: "$0.40" } };
    },
  });
  const tools = createTools({
    config: { url: "http://svc.test", publicKeys: [], dailyLimitMicro: 0, team: { member: "3.0", token: TOKEN }, judge: { exclude: ["anthropic"] } },
    makeClient,
    makePayingFetch: async () => { throw new Error("no wallet path"); },
    budget: new Budget({ dir, dailyLimitMicro: 0 }),
    receipts: new ReceiptStore({ dir }),
    judgePollMs: 10,
    ...(minuteMs ? { judgeMinuteMs: minuteMs } : {}),
  });
  const tool = tools.find((t) => t.name === "judge_match");
  // The stub's Seat: submit() answers with the stubbed match state and records what the seat asked for.
  const seen = {};
  ClientSeat.prototype.submit = async function () { seen.requested = this.requested; return st; };
  const restore = () => { ClientSeat.prototype.submit = realSubmit; };
  return { tool, dir, calls, seen, requested, restore, ctx: { progress: () => {} } };
}

test("a receipt whose judges aren't the named panel, or that names a paying wallet, another funding or no kind, fails the check", async () => {
  for (const [opts, re] of [
    [{ receiptPanel: ["openai/gpt-6-luna", "mistralai/mistral-large-4-0"] }, /aren't the panel you agreed on/],
    [{ payload: { paid_by: { alpha: "0x" + "1".repeat(40) } } }, /names a paying wallet/],
    [{ payload: { funding: "wallet" } }, /funding "wallet", not "team"/],
    [{ payload: { title: "who ships the fix" } }, /title doesn't carry this match's kind/],
  ]) {
    const { tool, ctx } = await stubbed(opts);
    const o = await tool.handler(openArgs(), ctx);
    const r = await tool.handler({ action: "result", job_id: o.job_id, wait_seconds: 5 }, ctx);
    assert.equal(r.check.ok, false, JSON.stringify(opts));
    assert.match(r.check.problems.join(" "), re);
    assert.match(r.summary, /^WARNING/);
  }
  {
    const { tool, ctx, restore } = await stubbed({ payload: { title: "[rule 9 dispute: another message entirely]" } });
    const o = await tool.handler(openArgs(), ctx);
    const r = await tool.handler({ action: "result", job_id: o.job_id, wait_seconds: 5 }, ctx);
    assert.equal(r.check.ok, false);
    assert.match(r.check.problems.join(" "), /isn't the one this match was opened or joined with/);
    restore();
  }
  const { tool, ctx, calls, seen, requested, restore } = await stubbed();
  const o = await tool.handler(openArgs(), ctx);
  const r = await tool.handler({ action: "result", job_id: o.job_id, wait_seconds: 5 }, ctx);
  assert.equal(r.check.ok, true, r.check.problems.join(" "));
  assert.deepEqual(calls.map((c) => c.path), ["/team/host/join/judge-2"], "the paid join goes through the team route");
  assert.equal(calls[0].teamFetch, true, "through the client whose fetch adds the team headers");
  assert.deepEqual(seen.requested, requested.get("a".repeat(24)), "the host's seat carries what it asked for, so the client's own receipt check runs");
  restore();
});

test("judging that ends without a verdict after the charge: the error says the seats are paid and the record keeps the charge", async () => {
  const { tool, ctx, dir, restore } = await stubbed({ phase: "error" });
  const o = await tool.handler(openArgs(), ctx);
  await assert.rejects(tool.handler({ action: "result", job_id: o.job_id, wait_seconds: 5 }, ctx), (e) => /Your seats are paid \(\$0\.40 from the team allowance\), but The match ended without a verdict \(phase: error\)/.test(e.message) && /credited back/.test(e.message) && e.details?.charge === "charged" && e.details?.paid?.amount === "$0.40");
  const { readFile } = await import("node:fs/promises");
  const pend = JSON.parse(await readFile(join(dir, "receipts", `pending-${o.job_id}.json`), "utf8"));
  assert.equal(pend.status, "failed");
  assert.equal(pend.charge, "charged");
  restore();
});

test("the invite wait is a time, not a count of answers: a service that answers 408 at once doesn't shorten it", async () => {
  const { RefereeError } = await import("agent-referee-client");
  const { tool, ctx, calls, restore } = await stubbed({ joinAnswer: new RefereeError("The other seat hasn't joined yet.", 408, {}), minuteMs: 150 });
  const started = Date.now();
  const o = await tool.handler(openArgs({ invite_wait_minutes: 2 }), ctx);
  await assert.rejects(tool.handler({ action: "result", job_id: o.job_id, wait_seconds: 10 }, ctx), /didn't join within 2 minutes\. Nothing was charged/);
  assert.ok(Date.now() - started >= 300, `waited ${Date.now() - started} ms`);
  assert.ok(calls.length >= 2 && calls.length <= 4, `${calls.length} calls`);
  restore();
});

test("a 404 on the team judge route is explained as the missing deploy, not as the allowance being off", async () => {
  const { RefereeError } = await import("agent-referee-client");
  const { tool, ctx, restore } = await stubbed({ joinAnswer: new RefereeError("No route: POST /team/host/join/judge-2", 404, {}) });
  const o = await tool.handler(openArgs(), ctx);
  await assert.rejects(tool.handler({ action: "result", job_id: o.job_id, wait_seconds: 5 }, ctx), (e) => /no team-paid judge route yet \(404/.test(e.message) && /Nothing was charged/.test(e.message) && e.details?.charge === "none");
  restore();
});

test("a forfeit is reported as a forfeit, not as the judges' verdict", async () => {
  const { tool, ctx, restore } = await stubbed({ receiptPanel: [], result: { winner: "alpha", by_forfeit: true, forfeited: ["beta"] } });
  const o = await tool.handler(openArgs(), ctx);
  const r = await tool.handler({ action: "result", job_id: o.job_id, wait_seconds: 5 }, ctx);
  assert.equal(r.by_forfeit, true);
  assert.equal(r.check.ok, true, r.check.problems.join(" "));
  assert.match(r.summary, /won by forfeit: the other side didn't submit in time, so no judge ran/);
  restore();
});

test("a team refusal on the paid join is explained as the allowance's, never as a wallet's; a 5xx is an unclear charge", async () => {
  const { RefereeError } = await import("agent-referee-client");
  let { tool, ctx, restore } = await stubbed({ joinAnswer: new RefereeError("This judge-2 ($0.40 for both seats) doesn't fit your allowance today ($0.30 left; it resets at 00:00 UTC). Nothing was used.", 429, {}) });
  let o = await tool.handler(openArgs(), ctx);
  await assert.rejects(tool.handler({ action: "result", job_id: o.job_id, wait_seconds: 5 }, ctx), (e) => /The paid join failed: .*doesn't fit your allowance/.test(e.message) && /team_allowance/.test(e.message) && !/basescan|refund list|may have been charged/.test(e.message) && e.details?.charge === "none");
  restore();
  ({ tool, ctx, restore } = await stubbed({ joinAnswer: new RefereeError("Bad gateway", 502, {}) }));
  o = await tool.handler(openArgs(), ctx);
  await assert.rejects(tool.handler({ action: "result", job_id: o.job_id, wait_seconds: 5 }, ctx), (e) => /may have been charged to the team allowance/.test(e.message) && /don't retry this open/.test(e.message) && e.details?.charge === "unclear");
  restore();
});
