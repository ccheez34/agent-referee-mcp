// Each test tries to get past one rule (DESIGN §5; receipt spec v0.4 §5 and §10). An agent that ignores, forgets or
// breaks its instructions must still be refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, sha256OfText } from "../src/policy.mjs";
import { loadGateConfig } from "../src/server.mjs";
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

test("max_uses 3 allows exactly three", async () => {
  const g = await gate({ records: [approval({ max_uses: 3 })] });
  const out = [];
  for (let i = 0; i < 4; i++) out.push((await g.call("check_action", DEPLOY)).allowed);
  assert.deepEqual(out, [true, true, true, false]);
});

test("two gate processes racing for a one-use approval: exactly one wins", async () => {
  const a = approval();
  const g1 = await gate({ records: [a] });
  const g2 = await gate({ records: [a], dir: g1.dir, approvalsFile: g1.file, member: "5.0" });
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
  const a = approval({ max_uses: 5 });
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
  const a = approval({ max_uses: 5 });
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
