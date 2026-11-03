// Each test tries to get past one rule (DESIGN §5; receipt spec v0.4 §5 and §10). An agent that ignores, forgets or
// breaks its instructions must still be refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, sha256OfText } from "../src/policy.mjs";
import { loadGateConfig } from "../src/server.mjs";
import { ToolError } from "../../src/protocol.mjs";
import {
  gate, approval, revocation, owner, referee, forger, signDoc, NOW, iso, hex, REPO, SHA, DIFF_SHA256,
  policyObject, pinnedPolicy, checksReceipt, stampReceipt, reviewReceipt,
} from "./helpers.mjs";

const DEPLOY = { action: "deploy", target: "agent-referee-server:production", target_sha256: "a".repeat(64) };

// ---------------- the policy ----------------

test("policy: a changed file doesn't start the gate (sha256 pinned by the owner)", () => {
  const text = JSON.stringify(policyObject());
  assert.throws(() => loadPolicy(text.replace("owner_only", "open"), sha256OfText(text)), /not the pinned/);
  assert.throws(() => loadPolicy(text, "abc"), /64-character sha256/);
  assert.equal(loadPolicy(text, sha256OfText(text)).version, "test-1");
});

test("policy: the owner's approval key can't also be a receipt key", () => {
  const text = JSON.stringify(policyObject({ receipt_keys: [owner.pub] }));
  assert.throws(() => loadPolicy(text, sha256OfText(text)), /different keys/);
});

test("policy: an L1 github_checks requirement must name the checks that matter", () => {
  for (const required_checks of [undefined, ["test"], [{ name: "test" }]]) {
    const text = JSON.stringify(policyObject({ done: { merge: { require: [{ level: "L1", check: "github_checks", required_checks, max_age_minutes: 60 }] } } }));
    assert.throws(() => loadPolicy(text, sha256OfText(text)), /required_checks/);
  }
});

test("config: member, state folder and an https approvals source are required", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gate-cfg-"));
  const text = JSON.stringify(policyObject());
  const pf = join(dir, "policy.json");
  await writeFile(pf, text);
  const env = { GATE_POLICY: pf, GATE_POLICY_SHA256: sha256OfText(text), GATE_STATE_DIR: join(dir, "s"), GATE_MEMBER: "3.0", GATE_APPROVALS_FILE: join(dir, "a.json") };
  assert.equal((await loadGateConfig(env)).member, "3.0");
  await assert.rejects(loadGateConfig({ ...env, GATE_APPROVALS_FILE: "" }), /GATE_APPROVALS_URL/);
  await assert.rejects(loadGateConfig({ ...env, GATE_APPROVALS_URL: "http://example.com/a" }), /https/);
  await assert.rejects(loadGateConfig({ ...env, GATE_STATE_DIR: "" }), /GATE_STATE_DIR/);
  await assert.rejects(loadGateConfig({ ...env, GATE_POLICY_SHA256: "0".repeat(64) }), /not the pinned/);
});

// ---------------- check_action: the owner-only list ----------------

test("an open action is allowed without an approval", async () => {
  const g = await gate();
  const r = await g.call("check_action", { action: "merge", target: "main" });
  assert.equal(r.allowed, true);
  assert.equal(r.owner_only, false);
});

test("an action not on the policy's list is refused", async () => {
  const g = await gate();
  await assert.rejects(g.call("check_action", { action: "deploy_prod", target: "x" }), /must be one of/);
});

test("an owner-only action with no approval is refused", async () => {
  const g = await gate();
  const r = await g.call("check_action", DEPLOY);
  assert.equal(r.allowed, false);
  assert.match(r.summary, /owner-only/);
});

test("a fitting approval allows once; a second use is refused", async () => {
  const a = approval();
  const g = await gate({ records: [a] });
  const first = await g.call("check_action", DEPLOY);
  assert.equal(first.allowed, true);
  assert.equal(first.approval_nonce, a.payload.nonce);
  const second = await g.call("check_action", DEPLOY);
  assert.equal(second.allowed, false);
  assert.match(second.reasons.join(" "), /used up/);
});

test("B2: an approval is used once: max_uses above 1 is rejected, and the one use can't be spent twice", async () => {
  const g = await gate({ records: [approval({ max_uses: 3 })] });
  const r = await g.call("check_action", DEPLOY);
  assert.equal(r.allowed, false);
  assert.match(r.reasons.join(" "), /max_uses must be 1/);
  // null isn't "left out": the record says something other than 1.
  const n = await gate({ records: [approval({ max_uses: null })] });
  assert.match((await n.call("check_action", DEPLOY)).reasons.join(" "), /max_uses must be 1/);
  const ok = await gate({ records: [approval()] });
  const out = [];
  for (let i = 0; i < 3; i++) out.push((await ok.call("check_action", DEPLOY)).allowed);
  assert.deepEqual(out, [true, false, false]);
});

test("two gate processes racing for a one-use approval: exactly one wins", async () => {
  const a = approval();
  const g1 = await gate({ records: [a] });
  const g2 = await gate({ records: [a], dir: g1.dir, approvalsFile: g1.file }); // a second process for the same seat
  const results = await Promise.all([g1.call("check_action", DEPLOY), g2.call("check_action", DEPLOY), g1.call("check_action", DEPLOY)]);
  assert.equal(results.filter((r) => r.allowed).length, 1);
});

test("a dry run spends nothing", async () => {
  const g = await gate({ records: [approval()] });
  assert.equal((await g.call("check_action", { ...DEPLOY, dry_run: true })).allowed, true);
  assert.equal((await g.call("check_action", { ...DEPLOY, dry_run: true })).uses_left, 1);
  assert.equal((await g.call("check_action", DEPLOY)).allowed, true);
});

test("an approval for another target, or another version of it, is refused", async () => {
  const g = await gate({ records: [approval()] });
  const other = await g.call("check_action", { ...DEPLOY, target: "agent-referee-server:staging" });
  assert.equal(other.allowed, false);
  assert.match(other.reasons[0], /target/);
  const otherSha = await g.call("check_action", { ...DEPLOY, target_sha256: "b".repeat(64) });
  assert.equal(otherSha.allowed, false);
  const noSha = await g.call("check_action", { action: DEPLOY.action, target: DEPLOY.target });
  assert.equal(noSha.allowed, false);
});

test("an approval for another action doesn't open this one", async () => {
  const g = await gate({ records: [approval({ action: "publish" })] });
  assert.equal((await g.call("check_action", DEPLOY)).allowed, false);
});

test("an expired approval, or one dated in the future, is refused", async () => {
  const g = await gate({ records: [approval({ expires_at: iso(NOW - 1) }), approval({ issued_at: iso(NOW + 3_600_000), expires_at: iso(NOW + 7_200_000) })] });
  const r = await g.call("check_action", DEPLOY);
  assert.equal(r.allowed, false);
  assert.match(r.reasons.join(" "), /expired/);
  assert.match(r.reasons.join(" "), /future/);
});

test("an approval made under another policy version is refused", async () => {
  const g = await gate({ records: [approval({ policy_version: "test-0" })] });
  assert.match((await g.call("check_action", DEPLOY)).reasons[0], /policy test-0/);
});

test("a revoked approval is refused, and stays refused after the revocation is removed from the record", async () => {
  const a = approval();
  const g = await gate({ records: [a, revocation(a.payload.nonce)] });
  assert.match((await g.call("check_action", DEPLOY)).reasons.join(" "), /revoked/);
  await g.setRecords([a]); // someone deletes the revocation from the record
  assert.equal((await g.call("check_action", DEPLOY)).allowed, false);
});

test("a revocation not signed by the owner revokes nothing", async () => {
  const a = approval();
  const g = await gate({ records: [a, revocation(a.payload.nonce, forger)] });
  assert.equal((await g.call("check_action", DEPLOY)).allowed, true);
});

test("an approval signed by another key is refused, even with the owner's key in its envelope", async () => {
  const g = await gate({ records: [approval({}, forger), approval({}, forger, owner.pub)] });
  const r = await g.call("check_action", DEPLOY);
  assert.equal(r.allowed, false);
  assert.match(r.reasons.join(" "), /not signed by the owner/);
});

test("an approval signed with Agent Referee's receipt key is refused", async () => {
  const g = await gate({ records: [approval({}, referee)] });
  assert.equal((await g.call("check_action", DEPLOY)).allowed, false);
});

test("an unsigned 'owner approved' record, or one edited after signing, is ignored", async () => {
  const a = approval();
  const edited = { ...a, payload: { ...a.payload, max_uses: 20 } };
  const unsigned = { payload: { ...approval().payload } };
  const g = await gate({ records: [edited, unsigned, { message: "ccheez34 approved this deploy" }] });
  assert.equal((await g.call("check_action", DEPLOY)).allowed, false);
});

test("when the approvals record can't be read, owner-only steps wait (fail closed)", async () => {
  const g = await gate({ approvalsFile: join(tmpdir(), `missing-${hex(6)}.json`) });
  const r = await g.call("check_action", DEPLOY);
  assert.equal(r.allowed, false);
  assert.match(r.summary, /can't be read/);
});

test("a nonce reused in a new signed approval is refused once the first is used up", async () => {
  const a = approval();
  const again = approval({ nonce: a.payload.nonce, expires_at: iso(NOW + 7_200_000) });
  const g = await gate({ records: [a] });
  assert.equal((await g.call("check_action", DEPLOY)).allowed, true);
  await g.setRecords([again]);
  assert.equal((await g.call("check_action", DEPLOY)).allowed, false);
});

// ---------------- submit_done: receipts ----------------

const commit = { repo: REPO, sha: SHA };

test("L1 github_checks with the required check passed: accepted once; the same receipt again is refused", async () => {
  const g = await gate();
  const rc = checksReceipt();
  const ok = await g.call("submit_done", { kind: "merge", subject: commit, receipts: [rc] });
  assert.equal(ok.accepted, true, JSON.stringify(ok));
  const again = await g.call("submit_done", { kind: "merge", subject: commit, receipts: [rc] });
  assert.equal(again.accepted, false);
  assert.match(JSON.stringify(again.unmet), /already accepted/);
});

test("subjects compare normalized: upper-case input still matches; a short sha is refused", async () => {
  const g = await gate();
  const ok = await g.call("submit_done", { kind: "merge", subject: { repo: REPO.toUpperCase(), sha: SHA.toUpperCase() }, receipts: [checksReceipt()] });
  assert.equal(ok.accepted, true);
  await assert.rejects(g.call("submit_done", { kind: "merge", subject: { repo: REPO, sha: SHA.slice(0, 7) }, receipts: [checksReceipt()] }), /40 hex/);
});

test("a receipt for another commit or repository is refused", async () => {
  const g = await gate();
  const other = await g.call("submit_done", { kind: "merge", subject: commit, receipts: [checksReceipt({ sha: "b".repeat(40) })] });
  assert.equal(other.accepted, false);
  assert.match(JSON.stringify(other.unmet), /different repository or commit/);
  const repo = await g.call("submit_done", { kind: "merge", subject: commit, receipts: [checksReceipt({ repo: "someone/else" })] });
  assert.equal(repo.accepted, false);
});

test("a stale observation is refused, and so is one from the future", async () => {
  const g = await gate();
  assert.match(JSON.stringify((await g.call("submit_done", { kind: "merge", subject: commit, receipts: [checksReceipt({ observedAt: NOW - 61 * 60_000 })] })).unmet), /older than 60/);
  assert.match(JSON.stringify((await g.call("submit_done", { kind: "merge", subject: commit, receipts: [checksReceipt({ observedAt: NOW + 10 * 60_000 })] })).unmet), /future/);
});

test("a required check still running, failed, missing, or a truncated list: refused", async () => {
  const g = await gate();
  const cases = [
    [{ name: "test", app: "github-actions", status: "in_progress", conclusion: null, completed_at: null }],
    [{ name: "test", app: "github-actions", status: "completed", conclusion: "failure", completed_at: iso(NOW) }],
    [{ name: "lint", app: "github-actions", status: "completed", conclusion: "success", completed_at: iso(NOW) }],
    [
      { name: "test", app: "github-actions", status: "completed", conclusion: "success", completed_at: iso(NOW) },
      { name: "build", app: "github-actions", status: "completed", conclusion: "failure", completed_at: iso(NOW) },
    ],
  ];
  for (const runs of cases) assert.equal((await g.call("submit_done", { kind: "merge", subject: commit, receipts: [checksReceipt({ runs })] })).accepted, false, JSON.stringify(runs));
  assert.match(JSON.stringify((await g.call("submit_done", { kind: "merge", subject: commit, receipts: [checksReceipt({ runs: cases[0] })] })).unmet), /still running/);
  assert.equal((await g.call("submit_done", { kind: "merge", subject: commit, receipts: [checksReceipt({ truncated: true })] })).accepted, false);
  const failedStatus = checksReceipt({ statuses: [{ context: "ci/legacy", state: "failure", updated_at: iso(NOW) }] });
  assert.equal((await g.call("submit_done", { kind: "merge", subject: commit, receipts: [failedStatus] })).accepted, false);
});

test("the wrong level is refused: a stamp or a github_commit where github_checks is required", async () => {
  const g = await gate();
  const stamp = await g.call("submit_done", { kind: "merge", subject: { ...commit, sha256: DIFF_SHA256 }, receipts: [stampReceipt()] });
  assert.equal(stamp.accepted, false);
  assert.match(JSON.stringify(stamp.unmet), /policy requires L1 github_checks/);
  assert.equal((await g.call("submit_done", { kind: "merge", subject: commit, receipts: [checksReceipt({ check: "github_commit" })] })).accepted, false);
});

test("a receipt signed with another key is refused, even with the pinned key in its envelope", async () => {
  const g = await gate();
  for (const rc of [checksReceipt({ key: forger }), checksReceipt({ key: forger, envelopeKey: referee.pub }), checksReceipt({ key: owner })]) {
    const r = await g.call("submit_done", { kind: "merge", subject: commit, receipts: [rc] });
    assert.equal(r.accepted, false);
    assert.match(JSON.stringify(r.unmet), /signature/);
  }
});

test("a receipt edited after signing is refused", async () => {
  const g = await gate();
  const rc = checksReceipt({ runs: [{ name: "test", status: "completed", conclusion: "failure", completed_at: iso(NOW) }] });
  rc.payload.observed.check_runs[0].conclusion = "success";
  assert.equal((await g.call("submit_done", { kind: "merge", subject: commit, receipts: [rc] })).accepted, false);
});

test("an unknown receipt format is refused", async () => {
  const g = await gate();
  const rc = checksReceipt();
  const odd = signDoc({ ...rc.payload, receipt_format: "agent-referee-proof-v9" }, referee);
  assert.match(JSON.stringify((await g.call("submit_done", { kind: "merge", subject: commit, receipts: [odd] })).unmet), /doesn't know/);
});

test("L0 stamp: accepted for its hash, refused for another, and refused when stale", async () => {
  const g = await gate();
  assert.equal((await g.call("submit_done", { kind: "stamped", subject: { sha256: DIFF_SHA256 }, receipts: [stampReceipt()] })).accepted, true);
  assert.equal((await g.call("submit_done", { kind: "stamped", subject: { sha256: "e".repeat(64) }, receipts: [stampReceipt()] })).accepted, false);
  assert.equal((await g.call("submit_done", { kind: "stamped", subject: { sha256: DIFF_SHA256 }, receipts: [stampReceipt({ issuedAt: NOW - 2 * 3_600_000 })] })).accepted, false);
});

test("L2: three 'pass' votes from three companies are accepted; a 2-1 is a list of work, not a pass", async () => {
  const g = await gate();
  const ok = await g.call("submit_done", { kind: "reviewed", subject: { sha256: DIFF_SHA256 }, receipts: [reviewReceipt()] });
  assert.equal(ok.accepted, true, JSON.stringify(ok));
  const split = await g.call("submit_done", { kind: "reviewed", subject: { sha256: DIFF_SHA256 }, receipts: [reviewReceipt({ verdicts: ["pass", "pass", "needs_changes"] })] });
  assert.equal(split.accepted, false);
  assert.match(JSON.stringify(split.unmet), /three \\"pass\\" votes/);
});

test("L2: a review of another output, a tally that doesn't recompute, or two reviewers from one company: refused", async () => {
  const g = await gate();
  const s = { sha256: DIFF_SHA256 };
  assert.match(JSON.stringify((await g.call("submit_done", { kind: "reviewed", subject: s, receipts: [reviewReceipt({ output: "f".repeat(64) })] })).unmet), /different output/);
  assert.match(JSON.stringify((await g.call("submit_done", { kind: "reviewed", subject: s, receipts: [reviewReceipt({ tamperTally: true })] })).unmet), /recompute/);
  const sameCo = reviewReceipt({ models: ["openai/gpt-6-luna", "openai/gpt-6-mini", "google/gemini-3.7-flash"] });
  assert.equal((await g.call("submit_done", { kind: "reviewed", subject: s, receipts: [sameCo] })).accepted, false);
  assert.equal((await g.call("submit_done", { kind: "reviewed", subject: s, receipts: [reviewReceipt({ createdAt: NOW - 25 * 3_600_000 })] })).accepted, false);
});

test("a kind with two requirements needs both, each met by a different receipt", async () => {
  const g = await gate();
  const subject = { ...commit, sha256: DIFF_SHA256 };
  const onlyChecks = await g.call("submit_done", { kind: "release", subject, receipts: [checksReceipt()] });
  assert.equal(onlyChecks.accepted, false);
  assert.deepEqual(onlyChecks.unmet.map((u) => u.requirement), ["L2 panel_pass"]);
  // Nothing was recorded as used by the refused submission, so the same receipt still works with its partner.
  const rc = checksReceipt();
  await g.call("submit_done", { kind: "release", subject, receipts: [rc] });
  const both = await g.call("submit_done", { kind: "release", subject, receipts: [rc, reviewReceipt()] });
  assert.equal(both.accepted, true, JSON.stringify(both));
});

test("two submissions racing with the same receipt: exactly one is accepted", async () => {
  const g1 = await gate();
  const g2 = await gate({ dir: g1.dir, approvalsFile: g1.file, member: "5.0" });
  const rc = checksReceipt();
  const out = await Promise.all([g1.call("submit_done", { kind: "merge", subject: commit, receipts: [rc] }), g2.call("submit_done", { kind: "merge", subject: commit, receipts: [rc] })]);
  assert.equal(out.filter((r) => r.accepted).length, 1);
});

// ---------------- locks ----------------

test("locks: one holder; others are told who holds it; only the holder releases; stale is flagged", async () => {
  let t = NOW;
  const a = await gate({ now: () => t });
  const b = await gate({ dir: a.dir, approvalsFile: a.file, member: "5.0", now: () => t });
  assert.equal((await a.call("take_lock", { name: "deploy-server", expected_minutes: 10 })).taken, true);
  const busy = await b.call("take_lock", { name: "deploy-server", expected_minutes: 10 });
  assert.equal(busy.taken, false);
  assert.equal(busy.held_by, "3.0");
  assert.equal(busy.stale, false);
  await assert.rejects(b.call("release_lock", { name: "deploy-server" }), /held by 3.0/);
  t = NOW + 41 * 60_000;
  assert.equal((await b.call("take_lock", { name: "deploy-server", expected_minutes: 10 })).stale, true);
  assert.equal((await a.call("release_lock", { name: "deploy-server" })).released, true);
  assert.equal((await b.call("take_lock", { name: "deploy-server", expected_minutes: 10 })).taken, true);
  await assert.rejects(a.call("take_lock", { name: "../escape", expected_minutes: 1 }), /isn't allowed/);
});

// ---------------- budget ----------------

test("budget: reservations stop at the member's daily limit, also when made in parallel", async () => {
  const g = await gate();
  assert.equal((await g.call("budget", { spend_usd: 0.6, what: "review-3 x3" })).reserved, true);
  const over = await g.call("budget", { spend_usd: 0.6, what: "more" });
  assert.equal(over.reserved, false);
  const parallel = await Promise.all(Array.from({ length: 5 }, () => g.call("budget", { spend_usd: 0.2, what: "review-3" })));
  assert.equal(parallel.filter((r) => r.reserved).length, 2);
  assert.equal((await g.call("budget", {})).spent_usd, 1);
  const other = await gate({ member: "9.9" });
  assert.equal((await other.call("budget", {})).limit_usd, 0.5);
  await assert.rejects(g.call("budget", { spend_usd: 0.2 }), /what/);
});

test("the member comes from the gate's settings, never from an argument", async () => {
  const g = await gate();
  await assert.rejects(g.call("take_lock", { name: "x", expected_minutes: 1, member: "5.0" }), /isn't a known argument/);
  await assert.rejects(gate({ member: "" }), /GATE_MEMBER/);
});

// ---------------- a real receipt from the live service ----------------

test("a real review-3 receipt (signed by the live service's key) is a 2-1, so it's refused as a pass for the reason of its votes", async () => {
  const { readFile } = await import("node:fs/promises");
  const real = JSON.parse(await readFile(new URL("./fixtures/real-review-3-2to1.json", import.meta.url), "utf8"));
  const policy = pinnedPolicy({ receipt_keys: [real.public_key], clock_skew_seconds: 120 });
  const g = await gate({ policy, now: () => Date.parse(real.payload.created_at) + 60_000 });
  const r = await g.call("submit_done", { kind: "reviewed", subject: { sha256: real.payload.output_sha256 }, receipts: [real] });
  assert.equal(r.accepted, false);
  const why = JSON.stringify(r.unmet);
  assert.match(why, /three \\"pass\\" votes/); // the signature and the recomputation passed; the votes didn't
  assert.doesNotMatch(why, /signature/);
});

// ---------------- after the fresh read of 9318fdd (findings 1-10) ----------------

test("F1: a kind mixing a commit and a hash needs the owner's explicit allow_unbound_pair, and the record says unbound", async () => {
  const p = policyObject();
  delete p.done.release.allow_unbound_pair;
  const text = JSON.stringify(p);
  assert.throws(() => loadPolicy(text, sha256OfText(text)), /allow_unbound_pair/);
  const g = await gate();
  const r = await g.call("submit_done", { kind: "release", subject: { ...commit, sha256: DIFF_SHA256 }, receipts: [checksReceipt(), reviewReceipt()] });
  assert.equal(r.accepted, true);
  assert.equal(r.pair_bound, false);
});

test("F2: a pinned brief (task_sha256) refuses a review briefed with another task; the record keeps the brief's hash", async () => {
  const pinned = "c".repeat(64);
  const policy = pinnedPolicy({ done: { reviewed: { require: [{ level: "L2", check: "panel_pass", max_age_minutes: 1440, task_sha256: "9".repeat(64) }] } } });
  const g = await gate({ policy });
  const r = await g.call("submit_done", { kind: "reviewed", subject: { sha256: DIFF_SHA256 }, receipts: [reviewReceipt()] });
  assert.match(JSON.stringify(r.unmet), /different task/);
  const open = await gate();
  const ok = await open.call("submit_done", { kind: "reviewed", subject: { sha256: DIFF_SHA256 }, receipts: [reviewReceipt()] });
  assert.deepEqual(ok.review_task_sha256, [pinned]);
});

test("F3: unprefixed ids can't pose as three companies; claude-* and anthropic/ are one company, in any case", async () => {
  const g = await gate();
  const s = { sha256: DIFF_SHA256 };
  for (const models of [["gpt-6-luna", "gpt-6-mini", "o5"], ["claude-opus-5-5", "Anthropic/claude-x", "google/gemini"], ["claude-a", "anthropic/claude-b", "google/x"], ["OpenAI/a", "openai/b", "google/c"]])
    assert.equal((await g.call("submit_done", { kind: "reviewed", subject: s, receipts: [reviewReceipt({ models })] })).accepted, false, models.join(","));
});

test("F4: a revocation in the record counts even when the state folder can't be listed; an unreadable state fails closed", async () => {
  const a = approval();
  const g = await gate({ records: [a, revocation(a.payload.nonce)] });
  const realList = g.state.list.bind(g.state);
  g.state.list = async (prefix) => (prefix === "revoked-" ? [] : realList(prefix));
  g.state.createOnce = (orig => async (name, rec) => (name.startsWith("revoked-") ? false : orig(name, rec)))(g.state.createOnce.bind(g.state));
  assert.equal((await g.call("check_action", DEPLOY)).allowed, false);
  g.state.list = async () => { const e = new Error("denied"); e.code = "EACCES"; throw e; };
  const r = await g.call("check_action", DEPLOY);
  assert.equal(r.allowed, false);
  assert.match(r.summary, /can't read its own records/);
});

test("F6: a required check run by another app doesn't count", async () => {
  const g = await gate();
  const runs = [{ name: "test", app: "some-other-app", status: "completed", conclusion: "success", completed_at: iso(NOW) }];
  assert.match(JSON.stringify((await g.call("submit_done", { kind: "merge", subject: commit, receipts: [checksReceipt({ runs })] })).unmet), /from github-actions isn't in the receipt/);
});

test("F7: approval dates that don't parse are rejected, not treated as never expiring", async () => {
  const g = await gate({ records: [approval({ expires_at: "2026-13-01T00:00:00Z" }), approval({ issued_at: "2026-02-31T25:00:00Z" })] });
  const r = await g.call("check_action", DEPLOY);
  assert.equal(r.allowed, false);
  assert.match(r.reasons.join(" "), /real ISO time/);
});

test("F8: a member named like a built-in property gets the default limit, not unlimited", async () => {
  for (const member of ["__proto__", "constructor", "toString"]) {
    const g = await gate({ member });
    assert.equal((await g.call("budget", { spend_usd: 1000, what: "x" })).reserved, false, member);
  }
});

test("F9: the same key in another base64 spelling is refused, so approval and receipt keys can't be the same bytes", () => {
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const alt = owner.pub.slice(0, 42) + B64[B64.indexOf(owner.pub[42]) ^ 1] + "="; // the unused low bits differ
  assert.equal(Buffer.from(alt, "base64").equals(Buffer.from(owner.pub, "base64")), true);
  const text = JSON.stringify(policyObject({ receipt_keys: [alt] }));
  assert.throws(() => loadPolicy(text, sha256OfText(text)), /canonical spelling|different keys/);
});

test("F10: a once-only record is never empty, and a crashed budget holder doesn't wedge the budget", async () => {
  const { writeFile, utimes } = await import("node:fs/promises");
  const g = await gate();
  assert.equal(await g.state.createOnce("lock-x", { holder: "3.0" }), true);
  assert.deepEqual(await g.state.read("lock-x"), { holder: "3.0" });
  const day = new Date(NOW).toISOString().slice(0, 10);
  const stale = g.state.path(`mutex-spend-3.0-${day}`);
  await writeFile(stale, "");
  const old = new Date(Date.now() - 60_000);
  await utimes(stale, old, old);
  assert.equal((await g.call("budget", { spend_usd: 0.2, what: "after a crash" })).reserved, true);
});

test("gaps: L2 created in the future, an accepted github_commit, a pending status, and budgets across two processes", async () => {
  const g = await gate();
  assert.equal((await g.call("submit_done", { kind: "reviewed", subject: { sha256: DIFF_SHA256 }, receipts: [reviewReceipt({ createdAt: NOW + 3_600_000 })] })).accepted, false);
  const commitOnly = await gate({ policy: pinnedPolicy({ done: { exists: { require: [{ level: "L1", check: "github_commit", max_age_minutes: 60 }] } } }) });
  assert.equal((await commitOnly.call("submit_done", { kind: "exists", subject: commit, receipts: [checksReceipt({ check: "github_commit" })] })).accepted, true);
  assert.equal((await g.call("submit_done", { kind: "merge", subject: commit, receipts: [checksReceipt({ statuses: [{ context: "ci", state: "pending", updated_at: iso(NOW) }] })] })).accepted, false);
  const g2 = await gate({ dir: g.dir, approvalsFile: g.file });
  const out = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? g : g2).call("budget", { spend_usd: 0.2, what: "x" })));
  assert.equal(out.filter((r) => r.reserved).length, 5);
});

test("the state folder failing to list (not just missing) throws, so callers fail closed", async () => {
  const { GateState } = await import("../src/state.mjs");
  const g = await gate();
  const notAFolder = new GateState(g.file); // a file, not a folder: readdir gives ENOTDIR
  await assert.rejects(notAFolder.list("revoked-"), /ENOTDIR/);
  const missing = new GateState(join(tmpdir(), `nope-${hex(6)}`));
  assert.deepEqual(await missing.list("x"), []);
});

test("one reviewer from an unnamed company with two named ones isn't three named companies", async () => {
  const g = await gate();
  const r = await g.call("submit_done", { kind: "reviewed", subject: { sha256: DIFF_SHA256 }, receipts: [reviewReceipt({ models: ["gpt-6-luna", "anthropic/claude-x", "google/gemini"] })] });
  assert.equal(r.accepted, false);
});

// ---------------- after the review-3x3 of 7f47b61 (receipt 8006457af2764575bb723d52) ----------------

test("R1 (Luna): an empty company prefix or a non-hyphenated claude id isn't a named company", async () => {
  const g = await gate();
  for (const models of [["/model", "openai/gpt-6-luna", "google/gemini"], ["claudette", "openai/gpt-6-luna", "google/gemini"], ["claude-opus-5-5", "openai/gpt-6-luna", "go*gle/x"]])
    assert.equal((await g.call("submit_done", { kind: "reviewed", subject: { sha256: DIFF_SHA256 }, receipts: [reviewReceipt({ models })] })).accepted, false, models.join(","));
});

test("R2 (Sonnet): the refusal names no person; pair_bound appears only when a commit and a hash were both submitted", async () => {
  const g = await gate();
  assert.doesNotMatch((await g.call("check_action", DEPLOY)).summary, /ccheez34/);
  const policy = pinnedPolicy({ done: { solo: { allow_unbound_pair: true, require: [{ level: "L2", check: "panel_pass", max_age_minutes: 1440 }] } } });
  const g2 = await gate({ policy });
  const r = await g2.call("submit_done", { kind: "solo", subject: { sha256: DIFF_SHA256 }, receipts: [reviewReceipt()] });
  assert.equal(r.accepted, true);
  assert.equal("pair_bound" in r, false);
});

test("R3 (Sonnet): the order of receipts doesn't matter, and one receipt sent twice can't meet two requirements", async () => {
  const policy = pinnedPolicy({
    done: {
      two: {
        require: [
          { level: "L1", check: "github_checks", required_checks: [{ name: "test", app: "github-actions" }], max_age_minutes: 60 },
          { level: "L1", check: "github_checks", required_checks: [{ name: "test", app: "github-actions" }, { name: "lint", app: "github-actions" }], max_age_minutes: 60 },
        ],
      },
    },
  });
  const both = [
    { name: "test", app: "github-actions", status: "completed", conclusion: "success", completed_at: iso(NOW) },
    { name: "lint", app: "github-actions", status: "completed", conclusion: "success", completed_at: iso(NOW) },
  ];
  const g = await gate({ policy });
  // A greedy match would give the first requirement the receipt with both checks, leaving none for the second.
  const r = await g.call("submit_done", { kind: "two", subject: commit, receipts: [checksReceipt({ runs: both }), checksReceipt()] });
  assert.equal(r.accepted, true, JSON.stringify(r));
  const g2 = await gate({ policy });
  const same = checksReceipt({ runs: both });
  const twice = await g2.call("submit_done", { kind: "two", subject: commit, receipts: [same, same] });
  assert.equal(twice.accepted, false);
  assert.match(JSON.stringify(twice.unmet), /one receipt meets one requirement/);
});

// ---------------- the server's real receipt shape (agent-referee-server d9578f4) ----------------

test("a proof receipt built by the server's own code (d9578f4) is accepted; the old `format` spelling isn't", async () => {
  const { readFile } = await import("node:fs/promises");
  const real = JSON.parse(await readFile(new URL("./fixtures/server-d9578f4-l1-checks.json", import.meta.url), "utf8"));
  const p = real.payload;
  const policy = pinnedPolicy({ receipt_keys: [real.public_key], done: { merge: { require: [{ level: "L1", check: "github_checks", required_checks: [{ name: "test", app: "github-actions" }], max_age_minutes: 60, on_default_branch: true }] } } });
  const g = await gate({ policy, now: () => Date.parse(p.observed.observed_at) + 60_000 });
  const ok = await g.call("submit_done", { kind: "merge", subject: p.subject, receipts: [real] });
  assert.equal(ok.accepted, true, JSON.stringify(ok));
  const { receipt_format, ...rest } = rc0().payload;
  const old = signDoc({ ...rest, format: receipt_format }, referee);
  const g2 = await gate();
  assert.match(JSON.stringify((await g2.call("submit_done", { kind: "merge", subject: commit, receipts: [old] })).unmet), /doesn't know/);
});
const rc0 = () => checksReceipt();

test("on_default_branch: required and absent, false or unknown is refused; truncated statuses are refused", async () => {
  const policy = pinnedPolicy({ done: { merge: { require: [{ level: "L1", check: "github_checks", required_checks: [{ name: "test", app: "github-actions" }], max_age_minutes: 60, on_default_branch: true }] } } });
  const g = await gate({ policy });
  for (const onDefault of [false, null, undefined]) assert.equal((await g.call("submit_done", { kind: "merge", subject: commit, receipts: [checksReceipt({ onDefault })] })).accepted, false, String(onDefault));
  assert.equal((await g.call("submit_done", { kind: "merge", subject: commit, receipts: [checksReceipt({ onDefault: true })] })).accepted, true);
  const g2 = await gate();
  assert.match(JSON.stringify((await g2.call("submit_done", { kind: "merge", subject: commit, receipts: [checksReceipt({ statusesTruncated: true })] })).unmet), /more commit statuses/);
  const text = JSON.stringify(policyObject({ done: { x: { require: [{ level: "L0", check: "stamp", max_age_minutes: 5, on_default_branch: true }] } } }));
  assert.throws(() => loadPolicy(text, sha256OfText(text)), /L1 requirements only/);
});

// ---------------- the command form, for hooks (2.0's 1126, point 6) ----------------

test("check command: exit 0 only when allowed (spending one use), 1 when not, 2 when the gate can't run", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const bin = fileURLToPath(new URL("../bin/agent-referee-gate.mjs", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "gate-cli-"));
  const text = JSON.stringify(policyObject());
  await writeFile(join(dir, "policy.json"), text);
  const now = Date.now();
  const a = approval({ issued_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 3_600_000).toISOString() });
  await writeFile(join(dir, "approvals.json"), JSON.stringify([a]));
  const env = { ...process.env, GATE_POLICY: join(dir, "policy.json"), GATE_POLICY_SHA256: sha256OfText(text), GATE_STATE_DIR: join(dir, "state"), GATE_MEMBER: "3.0", GATE_APPROVALS_FILE: join(dir, "approvals.json") };
  const run = (...args) => spawnSync(process.execPath, [bin, "check", ...args], { env, encoding: "utf8" });
  assert.equal(run("deploy", DEPLOY.target, DEPLOY.target_sha256, "--dry-run").status, 0);
  const first = run("deploy", DEPLOY.target, DEPLOY.target_sha256);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).allowed, true);
  assert.equal(run("deploy", DEPLOY.target, DEPLOY.target_sha256).status, 1, "the one use is spent");
  assert.equal(run("deploy", "somewhere-else").status, 1);
  assert.equal(run("deploy_prod", "x").status, 1, "an unknown action is refused");
  assert.equal(run("merge", "main").status, 0, "an open action");
  assert.equal(spawnSync(process.execPath, [bin, "check", "deploy", "x"], { env: { ...env, GATE_POLICY_SHA256: "0".repeat(64) }, encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [bin, "check"], { env, encoding: "utf8" }).status, 2);
});

// ---------------- B2: approvals name their seat; fail closed; a canary per seat ----------------

test("B2: an approval for another seat is refused, even by a gate sharing the same state and record", async () => {
  const a = approval({ member: "5.0" });
  const mine = await gate({ records: [a] });
  const r = await mine.call("check_action", DEPLOY);
  assert.equal(r.allowed, false);
  // The answer counts another seat's approval but never names it: not its nonce, seat or target.
  assert.match(r.reasons.join(" "), /1 approval\(s\) for "deploy" belong to other seats/);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(a.payload.nonce.slice(0, 8)));
  assert.doesNotMatch(JSON.stringify(r), /5\.0/);
  const theirs = await gate({ records: [a], dir: mine.dir, approvalsFile: mine.file, member: "5.0" });
  assert.equal((await theirs.call("check_action", DEPLOY)).allowed, true);
});

test("B2: a rejected record's nonce never appears in a refusal (it may be another seat's); the decision log keeps its prefix", async () => {
  const unsigned = approval({ member: "5.0" }, forger); // another seat's record, badly signed
  const g = await gate({ records: [unsigned] });
  const r = await g.call("check_action", DEPLOY);
  assert.equal(r.allowed, false);
  assert.match(r.reasons.join(" "), /a record was ignored: not signed by the owner's approval key/);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(unsigned.payload.nonce.slice(0, 8)));
  const { readFile } = await import("node:fs/promises");
  assert.match(await readFile(join(g.dir, "state", "decisions.jsonl"), "utf8"), new RegExp(unsigned.payload.nonce.slice(0, 8)));
});

test("B2: an approval whose expires_at isn't after issued_at is rejected, even inside the clock skew", async () => {
  const odd = approval({ issued_at: iso(NOW + 100_000), expires_at: iso(NOW + 50_000) });
  const g = await gate({ records: [odd] });
  const r = await g.call("check_action", DEPLOY);
  assert.equal(r.allowed, false);
  assert.match(r.reasons.join(" "), /expires_at must be after issued_at/);
});

test("B2: an approval with no seat, or in the old v1 format, is rejected; a v1 revocation still revokes", async () => {
  const { member, ...noSeat } = approval().payload;
  const v1 = approval({ format: "agent-referee-owner-approval-v1" });
  const { target_sha256, ...noHashKey } = approval().payload; // the key must be present: null when there's no hash
  const g = await gate({ records: [signDoc(noSeat, owner), v1, signDoc(noHashKey, owner)] });
  const r = await g.call("check_action", { action: DEPLOY.action, target: DEPLOY.target });
  assert.equal(r.allowed, false);
  assert.match(r.reasons.join(" "), /member \(the seat it's for\) is missing/);
  assert.match(r.reasons.join(" "), /names no seat; the owner signs it again/);
  assert.match(r.reasons.join(" "), /target_sha256 must be 64 lower-case hex characters, or null/);
  const a = approval();
  const oldRevocation = signDoc({ format: "agent-referee-owner-approval-v1", type: "revocation", nonce: a.payload.nonce, issued_at: iso(NOW - 1000) }, owner);
  const g2 = await gate({ records: [a, oldRevocation] });
  assert.match((await g2.call("check_action", DEPLOY)).reasons.join(" "), /revoked/);
});

test("B2: an approval lasting longer than approval_max_hours is refused (default 24)", async () => {
  const long = approval({ expires_at: iso(NOW - 60_000 + 25 * 3_600_000) });
  const g = await gate({ records: [long] });
  assert.match((await g.call("check_action", DEPLOY)).reasons.join(" "), /lasts longer than the policy allows/);
  const g48 = await gate({ records: [long], policy: pinnedPolicy({ approval_max_hours: 48 }) });
  assert.equal((await g48.call("check_action", DEPLOY)).allowed, true);
  for (const approval_max_hours of [0, 169, 1.5, "24"]) {
    const text = JSON.stringify(policyObject({ approval_max_hours }));
    assert.throws(() => loadPolicy(text, sha256OfText(text)), /approval_max_hours/);
  }
});

test("B2 fail closed: a policy leaving a baseline action out or open, or listing no members, doesn't start", () => {
  const base = policyObject();
  const cases = [
    { ...base, actions: { ...base.actions, deploy: "open" } },
    { ...base, actions: Object.fromEntries(Object.entries(base.actions).filter(([k]) => k !== "secret")) },
    { ...base, members: [] },
    { ...base, members: undefined },
    { ...base, members: ["3.0", "3.0"] },
    { ...base, members: ["3.0", "a b"] },
  ];
  for (const p of cases) {
    const text = JSON.stringify(p);
    assert.throws(() => loadPolicy(text, sha256OfText(text)), /owner_only|members/);
  }
});

test("B2 fail closed: a GATE_MEMBER the policy doesn't list doesn't start the gate", async () => {
  await assert.rejects(gate({ member: "7.0" }), /isn't on the policy's members list/);
  const dir = await mkdtemp(join(tmpdir(), "gate-cfg2-"));
  const text = JSON.stringify(policyObject());
  await writeFile(join(dir, "policy.json"), text);
  const { buildGateTools } = await import("../src/server.mjs");
  const env = { GATE_POLICY: join(dir, "policy.json"), GATE_POLICY_SHA256: sha256OfText(text), GATE_STATE_DIR: join(dir, "s"), GATE_APPROVALS_FILE: join(dir, "a.json") };
  await assert.rejects(buildGateTools(await loadGateConfig({ ...env, GATE_MEMBER: "7.0" })), /members list/);
  await assert.rejects(buildGateTools(await loadGateConfig(env)), /GATE_MEMBER/);
});

async function canaryGate({ records = [approval()], member = "3.0", age, nowRef = { t: NOW }, dir, mutexTimeoutMs } = {}) {
  const decoyDir = await mkdtemp(join(tmpdir(), "gate-decoy-"));
  const policy = pinnedPolicy({ canary: { decoy_dir: decoyDir, blocked_url: "https://blocked.invalid/canary", ...(age ? { max_age_hours: age } : {}) } });
  const g = await gate({ records, member, policy, now: () => nowRef.t, mutexTimeoutMs, ...(dir ? { dir: dir.dir, approvalsFile: dir.file } : {}) });
  return { ...g, decoyDir, nowRef };
}
const decoyValue = async (path) => (await (await import("node:fs/promises")).readFile(path, "utf8")).match(/DECOY_SECRET=([0-9a-f]{32})/)[1];

test("canary: with one in the policy, owner-only steps wait for this seat's canary; open steps don't", async () => {
  const g = await canaryGate();
  assert.equal((await g.call("check_action", { action: "merge", target: "main" })).allowed, true);
  const r = await g.call("check_action", DEPLOY);
  assert.equal(r.allowed, false);
  assert.match(r.summary, /no passing canary yet/);
  assert.equal((await g.call("check_action", { ...DEPLOY, dry_run: true })).allowed, false);
  assert.equal(g.names.includes("canary"), true);
  const plain = await gate({ records: [approval()] });
  assert.equal(plain.names.includes("canary"), false, "no canary in the policy: no canary tool, and no wait");
  assert.equal((await plain.call("check_action", DEPLOY)).allowed, true);
});

test("canary: both attempts failing passes it; the approval then works; it lapses after max_age_hours", async () => {
  const nowRef = { t: NOW };
  const g = await canaryGate({ records: [approval({ expires_at: iso(NOW + 20 * 3_600_000) }), approval({ expires_at: iso(NOW + 20 * 3_600_000) })], age: 2, nowRef });
  const s = await g.call("canary", { step: "start" });
  assert.match(s.decoy_path, /decoy-3\.0\.txt$/);
  assert.equal(s.blocked_url, "https://blocked.invalid/canary");
  const rep = await g.call("canary", { step: "report", run_id: s.run_id, read: "failed", read_text: "EACCES: permission denied", fetch: "failed", fetch_detail: "ENOTFOUND" });
  assert.equal(rep.passed, true, rep.summary);
  assert.equal((await g.call("check_action", DEPLOY)).allowed, true);
  nowRef.t = NOW + 2 * 3_600_000 + 1;
  const late = await g.call("check_action", DEPLOY);
  assert.equal(late.allowed, false);
  assert.match(late.summary, /more than 2 hours ago/);
});

test("canary: a read or fetch that succeeded, or a report showing the decoy's value, fails it, and the failure sticks", async () => {
  for (const bad of [{ read: "succeeded", fetch: "failed" }, { read: "failed", fetch: "succeeded" }, { read: "failed", fetch: "failed", showValue: true }]) {
    const g = await canaryGate();
    const s = await g.call("canary", { step: "start" });
    const value = await decoyValue(s.decoy_path);
    const rep = await g.call("canary", { step: "report", run_id: s.run_id, read: bad.read, fetch: bad.fetch, read_text: bad.showValue ? `file says DECOY_SECRET=${value}` : "denied" });
    assert.equal(rep.passed, false, JSON.stringify(bad));
    assert.match((await g.call("check_action", DEPLOY)).summary, /canary failed/);
    // A later clean report doesn't clear it: only the owner does, after fixing the sandbox.
    const s2 = await g.call("canary", { step: "start" });
    assert.equal((await g.call("canary", { step: "report", run_id: s2.run_id, read: "failed", fetch: "failed" })).passed, true);
    assert.match((await g.call("check_action", DEPLOY)).summary, /canary failed/);
    assert.equal(await g.state.remove("canary-failed-3.0"), true);
    assert.equal((await g.call("check_action", DEPLOY)).allowed, true);
  }
});

test("canary: another seat's run, an old run, a second report or a missing field is refused; only the hash is kept", async () => {
  const nowRef = { t: NOW };
  const g = await canaryGate({ nowRef });
  const s = await g.call("canary", { step: "start" });
  const other = await canaryGate({ member: "5.0", nowRef, dir: g });
  await assert.rejects(other.call("canary", { step: "report", run_id: s.run_id, read: "failed", fetch: "failed" }), /No canary run/);
  await assert.rejects(g.call("canary", { step: "report", run_id: s.run_id, read: "failed" }), /needs run_id, read and fetch/);
  await assert.rejects(g.call("canary", { step: "report", run_id: "0".repeat(24), read: "failed", fetch: "failed" }), /No canary run/);
  const value = await decoyValue(s.decoy_path);
  const { readdir, readFile } = await import("node:fs/promises");
  const stateDir = join(g.dir, "state");
  for (const f of await readdir(stateDir)) assert.equal((await readFile(join(stateDir, f), "utf8")).includes(value), false, f);
  await g.call("canary", { step: "report", run_id: s.run_id, read: "failed", fetch: "failed" });
  await assert.rejects(g.call("canary", { step: "report", run_id: s.run_id, read: "failed", fetch: "failed" }), /already reported/);
  const s2 = await g.call("canary", { step: "start" });
  nowRef.t = NOW + 16 * 60_000;
  await assert.rejects(g.call("canary", { step: "report", run_id: s2.run_id, read: "failed", fetch: "failed" }), /older than 15 minutes/);
});

test("canary: the decoy's value in fetch_detail, or glued to other hex, fails the report; no state file ever holds the value or the report's text", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const cases = [
    (v) => ({ read: "failed", read_text: "denied", fetch: "failed", fetch_detail: `curl: (22) body: DECOY_SECRET=${v}` }),
    (v) => ({ read: "failed", read_text: `cat: 1${v}`, fetch: "failed", fetch_detail: "ENOTFOUND" }),
    (v) => ({ read: "failed", read_text: `${v}${v}`, fetch: "failed" }),
  ];
  for (const make of cases) {
    const g = await canaryGate();
    const s = await g.call("canary", { step: "start" });
    const value = await decoyValue(s.decoy_path);
    const args = make(value);
    const rep = await g.call("canary", { step: "report", run_id: s.run_id, ...args });
    assert.equal(rep.passed, false, JSON.stringify(args));
    assert.match(rep.why, /shows the decoy's value/);
    const stateDir = join(g.dir, "state");
    for (const f of await readdir(stateDir)) {
      const text = await readFile(join(stateDir, f), "utf8");
      assert.equal(text.includes(value), false, `${f} holds the decoy's value`);
      assert.equal(text.includes("curl: (22)"), false, `${f} holds the report's text`);
    }
  }
});

test("canary: one open run per seat: a second start within 15 minutes is refused until the first is reported", async () => {
  const nowRef = { t: NOW };
  const g = await canaryGate({ nowRef });
  const s = await g.call("canary", { step: "start" });
  const first = await decoyValue(s.decoy_path);
  await assert.rejects(g.call("canary", { step: "start" }), /still open/);
  assert.equal(await decoyValue(s.decoy_path), first, "the decoy wasn't overwritten");
  assert.equal((await g.call("canary", { step: "report", run_id: s.run_id, read: "failed", fetch: "failed" })).passed, true);
  const s2 = await g.call("canary", { step: "start" }); // reported: a new run may start
  nowRef.t = NOW + 16 * 60_000; // an unreported run older than 15 minutes no longer blocks a new one
  const s3 = await g.call("canary", { step: "start" });
  assert.notEqual(s3.run_id, s2.run_id);
  await assert.rejects(g.call("canary", { step: "report", run_id: s2.run_id, read: "failed", fetch: "failed" }), /older than 15 minutes/);
});

test("canary: a failing report is recorded as sticking before the report record and the seat's status, so a crash at either later write leaves the seat blocked", async () => {
  for (const crashAt of ["canary-status-3.0", "canary-report-"]) {
    const g = await canaryGate();
    const s = await g.call("canary", { step: "start" });
    const realWrite = g.state.writeAtomic.bind(g.state);
    const realOnce = g.state.createOnce.bind(g.state);
    g.state.writeAtomic = async (name, record) => {
      if (name === crashAt) throw new Error("disk full");
      return realWrite(name, record);
    };
    g.state.createOnce = async (name, record) => {
      if (name.startsWith(crashAt) && crashAt.endsWith("-")) throw new Error("disk full");
      return realOnce(name, record);
    };
    await assert.rejects(g.call("canary", { step: "report", run_id: s.run_id, read: "succeeded", read_text: "the file", fetch: "failed" }), (e) => e instanceof ToolError && /couldn't read or write/.test(e.message) && !/disk full/.test(e.message));
    g.state.writeAtomic = realWrite;
    g.state.createOnce = realOnce;
    assert.match((await g.call("check_action", DEPLOY)).summary, /canary failed/, crashAt);
    // Even a later clean run doesn't clear it.
    const s2 = await g.call("canary", { step: "start" }).catch(() => null); // refused while the first run is open and unreported
    if (s2) assert.equal((await g.call("canary", { step: "report", run_id: s2.run_id, read: "failed", fetch: "failed" })).passed, true);
    assert.match((await g.call("check_action", DEPLOY)).summary, /canary failed/, crashAt);
  }
});

test("canary: a second report of a reported run changes nothing, even a failing one", async () => {
  const g = await canaryGate();
  const s = await g.call("canary", { step: "start" });
  assert.equal((await g.call("canary", { step: "report", run_id: s.run_id, read: "failed", fetch: "failed" })).passed, true);
  await assert.rejects(g.call("canary", { step: "report", run_id: s.run_id, read: "succeeded", read_text: "the file", fetch: "succeeded" }), /already reported/);
  assert.equal(await g.state.exists("canary-failed-3.0"), false, "no sticking failure from the refused second report");
  assert.equal((await g.call("check_action", DEPLOY)).allowed, true);
});

test("canary: two starts at once can't both open a run; a report echoing the value in upper case is seen", async () => {
  const g = await canaryGate();
  const results = await Promise.allSettled([g.call("canary", { step: "start" }), g.call("canary", { step: "start" }), g.call("canary", { step: "start" })]);
  const ok = results.filter((r) => r.status === "fulfilled");
  assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.status)));
  for (const r of results.filter((r) => r.status === "rejected")) assert.match(String(r.reason?.message ?? r.reason), /still open/);
  const s = ok[0].value;
  const value = await decoyValue(s.decoy_path);
  const rep = await g.call("canary", { step: "report", run_id: s.run_id, read: "failed", read_text: `DECOY_SECRET=${value.toUpperCase()}`, fetch: "failed" });
  assert.equal(rep.passed, false);
  assert.match(rep.why, /shows the decoy's value/);
});

test("canary: a seat named like another seat's failure key can't block it (distinct prefixes for status and failure)", async () => {
  const policy = pinnedPolicy({ members: ["A", "failed-A"], canary: { decoy_dir: await mkdtemp(join(tmpdir(), "gate-decoy-")), blocked_url: "https://blocked.invalid/canary" } });
  const other = await gate({ records: [approval({ member: "failed-A" })], member: "failed-A", policy });
  const s = await other.call("canary", { step: "start" });
  assert.equal((await other.call("canary", { step: "report", run_id: s.run_id, read: "failed", fetch: "failed" })).passed, true);
  const a = await gate({ records: [approval({ member: "A" })], member: "A", policy, dir: other.dir, approvalsFile: other.file });
  assert.match((await a.call("check_action", DEPLOY)).summary, /no passing canary yet/); // not "canary failed"
});

test("approvals: the loader itself refuses an address that isn't https, whatever the settings said", async () => {
  const { loadApprovalRecords } = await import("../src/approvals.mjs");
  let fetched = false;
  await assert.rejects(loadApprovalRecords({ url: "http://approvals.invalid/approvals", fetchImpl: async () => ((fetched = true), { ok: true, json: async () => [] }) }), /must be https/);
  assert.equal(fetched, false);
});

test("canary: a run record whose start time is unreadable is refused, like a late report", async () => {
  const g = await canaryGate();
  const s = await g.call("canary", { step: "start" });
  const run = await g.state.read(`canary-run-${s.run_id}`);
  await g.state.writeAtomic(`canary-run-${s.run_id}`, { ...run, started_at: "not-a-time" });
  await assert.rejects(g.call("canary", { step: "report", run_id: s.run_id, read: "failed", fetch: "failed" }), /older than 15 minutes, or its record is unreadable/);
  assert.match((await g.call("check_action", DEPLOY)).summary, /no passing canary yet/);
});

test("canary: a policy canary needs an absolute decoy folder and an https address; a missing folder refuses start", async () => {
  for (const canary of [{ decoy_dir: "relative/dir", blocked_url: "https://x.invalid" }, { decoy_dir: "/abs", blocked_url: "http://x.invalid" }, { decoy_dir: "/abs", blocked_url: "https://x.invalid", max_age_hours: 0 }]) {
    const text = JSON.stringify(policyObject({ canary }));
    assert.throws(() => loadPolicy(text, sha256OfText(text)), /canary\./);
  }
  const g = await gate({ policy: pinnedPolicy({ canary: { decoy_dir: join(tmpdir(), `missing-${hex(6)}`), blocked_url: "https://x.invalid" } }) });
  await assert.rejects(g.call("canary", { step: "start" }), /can't write the decoy/);
});

// ---------------- B2, the canary's second re-check (review-3 of cb27d2e, 3.0-C100) ----------------

test("canary: two reports of one run at once: one is accepted, the other refused, and the refused one leaves no sticking failure", async () => {
  const g = await canaryGate();
  const s = await g.call("canary", { step: "start" });
  const results = await Promise.allSettled([
    g.call("canary", { step: "report", run_id: s.run_id, read: "failed", fetch: "failed" }),
    g.call("canary", { step: "report", run_id: s.run_id, read: "succeeded", read_text: "the file", fetch: "failed" }),
  ]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected"], JSON.stringify(results.map((r) => r.status === "rejected" ? String(r.reason?.message) : "ok")));
  assert.match(String(results[1].reason?.message), /already reported/);
  assert.equal(results[0].value.passed, true);
  assert.equal(await g.state.exists("canary-failed-3.0"), false, "the refused report wrote nothing");
  assert.equal((await g.call("check_action", DEPLOY)).allowed, true);
});

test("canary: a busy mutex, a corrupt record or a failing write is refused as a ToolError the session can act on, never the raw error", async () => {
  const g = await canaryGate({ mutexTimeoutMs: 100 });
  // Another gate process holds this seat's start mutex.
  assert.equal(await g.state.createOnce("mutex-canary-start-3.0", { token: "other", at: Date.now() }), true);
  await assert.rejects(g.call("canary", { step: "start" }), (e) => e instanceof ToolError && /in progress.*try again/i.test(e.message));
  await g.state.remove("mutex-canary-start-3.0");
  const s = await g.call("canary", { step: "start" });
  // A corrupt run record: its text never reaches the session.
  const { writeFile: write } = await import("node:fs/promises");
  await write(join(g.state.dir, `canary-run-${s.run_id}`), "{not json: SECRET-LOOKING-TEXT");
  await assert.rejects(g.call("canary", { step: "report", run_id: s.run_id, read: "failed", fetch: "failed" }), (e) => e instanceof ToolError && /couldn't read or write/.test(e.message) && /Tell the owner/.test(e.message) && !/SECRET-LOOKING|not json/.test(e.message));
});

test("canary: only the seat's open run can be reported: a start that crashed before its open record, or a run a later start replaced, is unreportable", async () => {
  const g = await canaryGate();
  const s = await g.call("canary", { step: "start" });
  await g.state.remove("canary-open-3.0"); // as if the start had crashed between the run record and the open record
  await assert.rejects(g.call("canary", { step: "report", run_id: s.run_id, read: "failed", fetch: "failed" }), /isn't this seat's open run/);
  const s2 = await g.call("canary", { step: "start" }); // nothing open: a new run may start
  assert.notEqual(s2.run_id, s.run_id);
  await assert.rejects(g.call("canary", { step: "report", run_id: s.run_id, read: "failed", fetch: "failed" }), /isn't this seat's open run/);
  assert.equal((await g.call("canary", { step: "report", run_id: s2.run_id, read: "failed", fetch: "failed" })).passed, true);
  assert.equal(await g.state.exists(`canary-report-${s.run_id}`), false, "the orphan run was never reported");
});
