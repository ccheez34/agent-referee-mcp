// Test helpers: real Ed25519 keys, signed approvals and receipts, a policy pinned by its hash, and a temp state folder.
import { generateKeyPairSync, sign, randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "agent-referee-client";
import { loadPolicy, sha256OfText, POLICY_FORMAT } from "../src/policy.mjs";
import { GateState } from "../src/state.mjs";
import { createGateTools } from "../src/tools.mjs";
import { APPROVAL_FORMAT } from "../src/approvals.mjs";
import { PROOF_FORMAT } from "../src/receipts.mjs";

export function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return { pub: raw.toString("base64"), privateKey };
}

export function signDoc(payload, key, envelopeKey = key.pub) {
  const signature = sign(null, Buffer.from(canonicalJson(payload), "utf8"), key.privateKey).toString("base64");
  return { payload, signature, algorithm: "Ed25519", public_key: envelopeKey };
}

export const owner = keypair();
export const referee = keypair();
export const forger = keypair();
export const NOW = Date.parse("2026-10-31T17:00:00.000Z");
export const iso = (ms) => new Date(ms).toISOString();
export const hex = (n) => randomBytes(n).toString("hex");
export const REPO = "ccheez34/agent-referee-mcp";
export const SHA = "7597ac32a637" + "0".repeat(28);
export const DIFF_SHA256 = "1e95273939ba098c3926a946b27c3c47899c10d7341399ec1225a630b7c6e021";

export function policyObject(over = {}) {
  return {
    format: POLICY_FORMAT,
    version: "test-1",
    actions: { deploy: "owner_only", publish: "owner_only", payment: "owner_only", delete: "owner_only", secret: "owner_only", install: "owner_only", rule_change: "owner_only", merge: "open" },
    approval_keys: [owner.pub],
    receipt_keys: [referee.pub],
    clock_skew_seconds: 120,
    done: {
      merge: { require: [{ level: "L1", check: "github_checks", required_checks: [{ name: "test", app: "github-actions" }], max_age_minutes: 60 }] },
      reviewed: { require: [{ level: "L2", check: "panel_pass", max_age_minutes: 1440 }] },
      stamped: { require: [{ level: "L0", check: "stamp", max_age_minutes: 60 }] },
      release: {
        allow_unbound_pair: true,
        require: [
          { level: "L1", check: "github_checks", required_checks: [{ name: "test", app: "github-actions" }], max_age_minutes: 60 },
          { level: "L2", check: "panel_pass", max_age_minutes: 1440 },
        ],
      },
    },
    budgets: { daily_usd: { "3.0": 1.0 }, default_daily_usd: 0.5 },
    lock_stale_minutes: 30,
    ...over,
  };
}

export function pinnedPolicy(over = {}) {
  const text = JSON.stringify(policyObject(over), null, 2);
  return loadPolicy(text, sha256OfText(text));
}

export function approval(over = {}, key = owner, envelopeKey) {
  const payload = {
    format: APPROVAL_FORMAT,
    type: "approval",
    action: "deploy",
    target: "agent-referee-server:production",
    target_sha256: "a".repeat(64),
    policy_version: "test-1",
    issued_at: iso(NOW - 60_000),
    expires_at: iso(NOW + 3_600_000),
    nonce: hex(16),
    max_uses: 1,
    ...over,
  };
  return signDoc(payload, key, envelopeKey);
}

export function revocation(nonce, key = owner) {
  return signDoc({ format: APPROVAL_FORMAT, type: "revocation", nonce, issued_at: iso(NOW - 1000) }, key);
}

export function checksReceipt({ runs, statuses = [], observedAt = NOW - 5 * 60_000, sha = SHA, repo = REPO, truncated = false, key = referee, envelopeKey, id = hex(12), check = "github_checks", onDefault, statusesTruncated = false } = {}) {
  const payload = {
    receipt_format: PROOF_FORMAT,
    type: "proof",
    service: "Agent Referee",
    receipt_id: id,
    level: "L1",
    check,
    subject: { repo, sha },
    observed: {
      commit_sha: sha,
      check_runs: runs ?? [{ name: "test", app: "github-actions", status: "completed", conclusion: "success", completed_at: iso(observedAt - 60_000) }],
      check_runs_total: (runs ?? [1]).length,
      ...(truncated ? { check_runs_truncated: true } : {}),
      statuses,
      combined_status: statuses.length ? "success" : "pending",
      observed_at: iso(observedAt),
      source: "api.github.com",
    },
    issued_at: iso(NOW - 60_000),
    caller: { member: "3.0", verified: false },
    funding: "team",
    price_micro: 0,
  };
  if (onDefault !== undefined) payload.observed.on_default_branch = onDefault;
  if (statusesTruncated) payload.observed.statuses_truncated = true;
  return signDoc(payload, key, envelopeKey);
}

export function stampReceipt({ sha256 = DIFF_SHA256, issuedAt = NOW - 60_000, key = referee, id = hex(12) } = {}) {
  return signDoc(
    { receipt_format: PROOF_FORMAT, type: "proof", service: "Agent Referee", receipt_id: id, level: "L0", check: "stamp", subject: { sha256 }, claimed: { text: "tests pass" }, note: "claimed by the caller; not checked by Agent Referee", issued_at: iso(issuedAt), caller: { member: "3.0" }, funding: "team", price_micro: 0 },
    key,
  );
}

const MODELS = ["claude-opus-5-5", "openai/gpt-6-luna", "google/gemini-3.7-flash"];
/** A review-3 receipt shaped like the service's (format agent-referee-review-v3), with the given verdicts. */
export function reviewReceipt({ verdicts = ["pass", "pass", "pass"], models = MODELS, output = DIFF_SHA256, createdAt = NOW - 3_600_000, key = referee, id = hex(12), tamperTally = false } = {}) {
  const tally = { pass: 0, needs_changes: 0, fail: 0, cannot_assess: 0 };
  for (const v of verdicts) tally[v]++;
  const top = Object.keys(tally).find((k) => tally[k] > 1) ?? "split";
  const votes = verdicts.map((verdict, i) => ({ reviewer: i + 1, model: models[i], verdict, confidence: "high", issues: verdict === "pass" ? [] : ["something"], reasoning: "r", model_reported: models[i] }));
  const payload = {
    type: "review",
    service: "Agent Referee",
    review_id: id,
    tier: "review-3",
    created_at: iso(createdAt),
    network: "base",
    payer: null,
    funding: "team",
    title: "t",
    task_sha256: "c".repeat(64),
    output_sha256: output,
    reviewers: { models, temperature: null, format_version: "agent-referee-review-v3", prompt_sha256: "d".repeat(64), decision_rule: "majority" },
    votes,
    result: { verdict: top, tally: tamperTally ? { ...tally, pass: tally.pass + 1 } : tally, unanimous: verdicts.every((v) => v === verdicts[0]) },
    note: "A review records what these AI models said about this exact task and output.",
  };
  return signDoc(payload, key);
}

export async function gate({ member = "3.0", records = [], policy = pinnedPolicy(), dir, now = () => NOW, approvalsFile } = {}) {
  dir = dir ?? (await mkdtemp(join(tmpdir(), "gate-")));
  const file = approvalsFile ?? join(dir, "..", `approvals-${hex(4)}.json`);
  if (!approvalsFile) await writeFile(file, JSON.stringify({ approvals: records }));
  const state = new GateState(join(dir, "state"));
  await state.init();
  const tools = createGateTools({ policy, state, member, approvalsSource: { file }, now });
  const call = (name, args) => tools.find((t) => t.name === name).handler(args, { progress() {} });
  return { call, dir, file, state, setRecords: (r) => writeFile(file, JSON.stringify({ approvals: r })) };
}
