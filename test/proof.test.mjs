// proof_receipt and verify_receipt for proof receipts (receipt spec v0.4): a mocked team client returns receipts signed
// with a test key, shaped like the server's proofPayload (agent-referee-server src/proof.ts, branch proof-receipts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash, randomBytes } from "node:crypto";
import { canonicalJson, RefereeError } from "agent-referee-client";
import { createTools } from "../src/tools.mjs";
import { ReceiptStore } from "../src/store.mjs";
import { loadConfig } from "../src/server.mjs";
import { tempDir } from "./helpers.mjs";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pub: publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64"), privateKey };
}
const service = keypair();
const forger = keypair();
const signDoc = (payload, key = service) => ({ payload, signature: sign(null, Buffer.from(canonicalJson(payload), "utf8"), key.privateKey).toString("base64"), algorithm: "Ed25519", public_key: key.pub });
const sha = (t) => createHash("sha256").update(t, "utf8").digest("hex");
const COMMIT = "dce97cf86d06" + "a".repeat(28);
const NOW = "2026-10-31T18:30:00.000Z";

/** As the server's proofPayload. */
function payloadFor(body, { member = "3.0", observed, id = randomBytes(12).toString("hex") } = {}) {
  const common = { receipt_format: "agent-referee-proof-v1", type: "proof", service: "Agent Referee", receipt_id: id, level: body.level, check: body.check };
  const tail = { issued_at: NOW, caller: { member, verified: false }, funding: "team", price_micro: 0 };
  if (body.level === "L0") return { ...common, subject: { sha256: body.sha256 }, claimed: { text: body.claim }, note: "claimed by the caller; not checked by Agent Referee", ...tail };
  return { ...common, subject: { repo: body.repo, sha: body.sha }, observed: observed ?? { commit_sha: body.sha, check_runs: [{ name: "test", app: "github-actions", status: "completed", conclusion: "success", completed_at: NOW }, { name: "lint", app: "github-actions", status: "in_progress", conclusion: null, completed_at: null }], check_runs_total: 2, statuses: [], combined_status: "pending", observed_at: NOW, source: "api.github.com" }, ...tail };
}

async function tools({ proof = true, team = { member: "3.0", token: "t".repeat(40) }, answer } = {}) {
  const sent = [];
  const makeClient = () => ({
    _call: async (method, path, body) => {
      sent.push({ method, path, body });
      if (answer) return answer(body);
      return { receipt: signDoc(payloadFor(body)), what_it_proves: "…", never_an_approval: "…" };
    },
  });
  const dir = await tempDir();
  const list = createTools({ config: { publicKeys: [service.pub], dailyLimitMicro: 0, team, proof, url: "https://agentreferee.ai" }, makeClient, makePayingFetch: () => null, budget: {}, receipts: new ReceiptStore({ dir, enabled: true }) });
  const call = (name, args) => list.find((t) => t.name === name).handler(args, { progress() {} });
  return { list, call, sent };
}

test("proof_receipt is listed only with a team member and AGENT_REFEREE_PROOF on; the setting is checked", async () => {
  assert.ok((await tools()).list.some((t) => t.name === "proof_receipt"));
  assert.ok(!(await tools({ proof: false })).list.some((t) => t.name === "proof_receipt"));
  assert.ok(!(await tools({ team: null })).list.some((t) => t.name === "proof_receipt"));
  assert.equal(loadConfig({}).proof, false);
  assert.throws(() => loadConfig({ AGENT_REFEREE_PROOF: "on" }), /TEAM_MEMBER/);
  assert.throws(() => loadConfig({ AGENT_REFEREE_TEAM_MEMBER: "3.0", AGENT_REFEREE_PROOF: "yes" }), /"on" or "off"/);
});

test("L0 with text: only the sha256 is sent, the receipt is checked, saved, and found again", async () => {
  const t = await tools();
  const text = "the exact brief, which must not leave this machine";
  const r = await t.call("proof_receipt", { level: "L0", text, claim: "brief for review 3" });
  assert.equal(t.sent.length, 1);
  assert.deepEqual(t.sent[0], { method: "POST", path: "/team/proof", body: { level: "L0", check: "stamp", sha256: sha(text), claim: "brief for review 3" } });
  assert.ok(!JSON.stringify(t.sent).includes(text), "the text itself is never sent");
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.match(r.summary, /^Valid proof receipt \(L0 stamp\)/);
  assert.equal(r.time, NOW);
  assert.ok(r.receipt_file);
  const again = await t.call("saved_receipts", { id: r.receipt_id });
  assert.equal(again.receipt?.payload?.receipt_id ?? again.records?.[0]?.receipt?.payload?.receipt_id ?? again.receipt_id, r.receipt_id);
});

test("L1 github_checks: verified; the summary names runs still in progress and never says passed", async () => {
  const t = await tools();
  const r = await t.call("proof_receipt", { level: "L1", check: "github_checks", repo: "CCheez34/Agent-Referee-MCP", sha: COMMIT.toUpperCase() });
  assert.deepEqual(t.sent[0].body, { level: "L1", check: "github_checks", repo: "ccheez34/agent-referee-mcp", sha: COMMIT });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.match(r.summary, /1 still running/);
  assert.doesNotMatch(r.summary, /passed/);
});

test("a receipt the service returns is refused if signed by another key, for another subject, member or claim", async () => {
  const cases = [
    (b) => ({ receipt: signDoc(payloadFor(b), forger) }),
    (b) => ({ receipt: { ...signDoc(payloadFor(b), forger), public_key: service.pub } }),
    (b) => ({ receipt: signDoc(payloadFor({ ...b, sha256: "f".repeat(64) })) }),
    (b) => ({ receipt: signDoc(payloadFor(b, { member: "5.0" })) }),
    (b) => ({ receipt: signDoc(payloadFor({ ...b, claim: "a different claim" })) }),
  ];
  for (const answer of cases) {
    const t = await tools({ answer });
    const r = await t.call("proof_receipt", { level: "L0", sha256: "a".repeat(64), claim: "tests 55/0" });
    assert.equal(r.ok, false);
    assert.match(r.summary, /^NOT valid/);
  }
});

test("argument mistakes are refused before anything is sent", async () => {
  const t = await tools();
  for (const args of [
    { level: "L0", sha256: "a".repeat(64), text: "both" },
    { level: "L0" },
    { level: "L0", sha256: "a".repeat(64), repo: "a/b" },
    { level: "L1", check: "github_checks", repo: "a/b", sha: "abc1234" },
    { level: "L1", check: "stamp", repo: "a/b", sha: COMMIT },
    { level: "L1", check: "github_commit", repo: "a/b", sha: COMMIT, claim: "x" },
    { level: "L2" },
  ])
    await assert.rejects(t.call("proof_receipt", args));
  assert.equal(t.sent.length, 0);
});

test("team errors are explained, and nothing is saved", async () => {
  const t = await tools({ answer: () => { throw Object.assign(new RefereeError("Today's proof receipts are used up. Nothing was issued."), { status: 429 }); } });
  await assert.rejects(t.call("proof_receipt", { level: "L0", sha256: "a".repeat(64) }), /used up/);
});

test("verify_receipt: proof receipts checked against the subject you hold; claimed and observed never mixed", async () => {
  const t = await tools();
  const stamp = signDoc(payloadFor({ level: "L0", check: "stamp", sha256: "b".repeat(64), claim: "c" }));
  const ok = await t.call("verify_receipt", { receipt: stamp, sha256: "B".repeat(64) });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  assert.match(ok.trusts.join(" "), /never stands in for the owner's yes/);
  assert.equal((await t.call("verify_receipt", { receipt: stamp, sha256: "c".repeat(64) })).ok, false);
  assert.match((await t.call("verify_receipt", { receipt: stamp })).summary, /Not checked: sha256/);
  const stampWithObserved = signDoc({ ...stamp.payload, observed: { commit_sha: COMMIT } });
  assert.equal((await t.call("verify_receipt", { receipt: stampWithObserved })).ok, false);
  const obs = signDoc(payloadFor({ level: "L1", check: "github_commit", repo: "a/b", sha: COMMIT }, { observed: { commit_sha: COMMIT, tree_sha: null, parents: [], observed_at: NOW, source: "api.github.com" } }));
  assert.equal((await t.call("verify_receipt", { receipt: obs, repo: "a/b", sha: COMMIT })).ok, true);
  assert.equal((await t.call("verify_receipt", { receipt: obs, repo: "a/b", sha: "e".repeat(40) })).ok, false);
  const obsWithClaim = signDoc({ ...obs.payload, claimed: { text: "trust me" } });
  assert.equal((await t.call("verify_receipt", { receipt: obsWithClaim })).ok, false);
  const edited = { ...obs, payload: { ...obs.payload, observed: { ...obs.payload.observed, observed_at: "2026-11-01T00:00:00.000Z" } } };
  assert.equal((await t.call("verify_receipt", { receipt: edited })).ok, false);
});

test("a receipt that names its format the old way (format, not receipt_format) isn't one this tool knows", async () => {
  const t = await tools();
  const p = payloadFor({ level: "L0", check: "stamp", sha256: "b".repeat(64), claim: "c" });
  const { receipt_format, ...rest } = p;
  const old = signDoc({ ...rest, format: receipt_format });
  const r = await t.call("verify_receipt", { receipt: old, sha256: "b".repeat(64) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /receipt_format/);
});
