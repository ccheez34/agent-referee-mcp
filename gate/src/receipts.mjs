// How the gate accepts a receipt for a "done" (receipt spec v0.4 §5), offline:
//   1. signature with the policy's pinned receipt keys (the key inside the envelope is never trusted alone)
//   2. subject: byte for byte the thing being gated
//   3. type: format and level first; the level and check the policy requires, never what the agent chose;
//      L2 = a review-3 with three "pass" votes from three companies
//   4. freshness: issued_at (L0), observed_at (L1), created_at (L2) within the window
//   5. once per gate: accepted receipt ids are recorded and refused the second time (done in tools.mjs)
import { verifySignature, verifyReviewOutcome } from "agent-referee-client";

export const PROOF_FORMAT = "agent-referee-proof-v1";
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const REPO = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;
const PASSING = new Set(["success"]);

// As the client's companyOfModel, but case-insensitive: the prefix before "/", "claude-*" is Anthropic, and every other
// unprefixed id counts as one group ("other"), so unprefixed ids can't pose as three companies.
// A prefix must be a real name (letters, digits, hyphens); "/model" or "claudette" are not companies.
const companyOf = (m) => {
  const id = String(m).toLowerCase();
  if (id.includes("/")) {
    const prefix = id.split("/")[0];
    return /^[a-z0-9][a-z0-9-]*$/.test(prefix) ? prefix : "other";
  }
  return id.startsWith("claude-") ? "anthropic" : "other";
};

/** Normalizes the subject the caller says it's submitting (spec §4). Returns { subject } or { error }. */
export function normalizeSubject(s) {
  if (!s || typeof s !== "object") return { error: "subject must be an object: {repo, sha} for a commit, and/or {sha256} for a file or diff." };
  const out = {};
  if (s.repo !== undefined || s.sha !== undefined) {
    const repo = String(s.repo ?? "").trim().toLowerCase();
    const sha = String(s.sha ?? "").trim().toLowerCase();
    if (!REPO.test(repo)) return { error: 'subject.repo must be "owner/name".' };
    if (!HEX40.test(sha)) return { error: "subject.sha must be the commit's full 40 hex characters." };
    Object.assign(out, { repo, sha });
  }
  if (s.sha256 !== undefined) {
    const h = String(s.sha256).trim().toLowerCase();
    if (!HEX64.test(h)) return { error: "subject.sha256 must be 64 hex characters." };
    out.sha256 = h;
  }
  if (!Object.keys(out).length) return { error: "subject names nothing: give {repo, sha} and/or {sha256}." };
  return { subject: out };
}

/** The receipt's own id, used for "once per gate". */
export function receiptId(receipt) {
  const p = receipt?.payload ?? {};
  if (p.receipt_format === PROOF_FORMAT) return typeof p.receipt_id === "string" ? `proof-${p.receipt_id}` : null;
  if (p.type === "review") return typeof p.review_id === "string" ? `review-${p.review_id}` : null;
  return null;
}

function ageProblem(timeText, maxAgeMinutes, now, skewMs, label) {
  const t = Date.parse(String(timeText ?? ""));
  if (!Number.isFinite(t)) return `${label} is missing`;
  if (t > now + skewMs) return `${label} is in the future`;
  if (now - t > maxAgeMinutes * 60_000) return `${label} (${timeText}) is older than ${maxAgeMinutes} minutes`;
  return null;
}

/**
 * Does this one receipt meet this one requirement for this subject? Returns null if it does, or the reason it doesn't.
 * Signature first, then format and level, then subject, then freshness.
 */
export async function receiptProblem(receipt, req, subject, { receiptKeys, now, skewMs }) {
  if (!receipt || typeof receipt !== "object" || !receipt.payload) return "not a signed receipt (no payload)";
  if (!(await verifySignature(receipt, receiptKeys))) return "the signature doesn't check out against the gate's pinned receipt key";
  const p = receipt.payload;

  if (req.level === "L2") {
    if (p.type !== "review") return "an L2 requirement needs a review receipt";
    if (p.tier !== "review-3") return `an L2 pass must be a review-3, not ${String(p.tier).slice(0, 30)}`;
    if (!subject.sha256) return "an L2 requirement needs subject.sha256 (the hash of the exact file or diff reviewed)";
    if (p.output_sha256 !== subject.sha256) return "the review is about a different output than subject.sha256";
    if (req.task_sha256 && p.task_sha256 !== req.task_sha256) return "the review was briefed with a different task than the one the policy pins";
    const check = await verifyReviewOutcome(receipt, {});
    if (!check.ok) return `the review receipt doesn't recompute: ${check.problems.join("; ").slice(0, 300)}`;
    const votes = p.votes ?? [];
    if (votes.length !== 3) return "a panel pass needs exactly three votes";
    if (!votes.every((v) => v?.verdict === "pass")) return `a panel pass needs three "pass" votes; this one is ${votes.map((v) => v?.verdict).join(", ")}, a list of work to do`;
    const companies = new Set((p.reviewers?.models ?? []).map((m) => companyOf(String(m))));
    if (companies.size !== 3 || companies.has("other")) return "the three reviewers aren't from three different, named AI companies";
    return ageProblem(p.created_at, req.max_age_minutes, now, skewMs, "the review's created_at");
  }

  // The service signs the format as receipt_format (agent-referee-server d9578f4), as review-multi-v1 does.
  if (p.receipt_format !== PROOF_FORMAT) return `the gate doesn't know this receipt's format (${String(p.receipt_format ?? p.format ?? p.type).slice(0, 40)})`;
  if (p.type !== "proof") return "not a proof receipt";
  if (p.level !== req.level || p.check !== req.check) return `this is ${p.level} ${p.check}; the policy requires ${req.level} ${req.check} here`;

  if (req.level === "L0") {
    if (!subject.sha256) return "an L0 stamp requirement needs subject.sha256";
    if (p.subject?.sha256 !== subject.sha256) return "the stamp is for a different hash";
    return ageProblem(p.issued_at, req.max_age_minutes, now, skewMs, "the stamp's issued_at");
  }

  // L1
  if (!subject.repo || !subject.sha) return "an L1 requirement needs subject.repo and subject.sha";
  if (p.subject?.repo !== subject.repo || p.subject?.sha !== subject.sha) return "the observation is for a different repository or commit";
  const o = p.observed;
  if (!o || typeof o !== "object") return "the receipt has no observed part";
  if (o.commit_sha !== subject.sha) return "the observed commit differs from the subject";
  const stale = ageProblem(o.observed_at, req.max_age_minutes, now, skewMs, "observed_at");
  if (stale) return stale;
  // A commit served through the repository's API can live only in a fork; the service records where it is.
  if (req.on_default_branch === true && o.on_default_branch !== true)
    return `the policy needs the commit on the default branch; the receipt says ${o.on_default_branch === false ? "it isn't" : "GitHub couldn't tell"}`;
  if (req.check === "github_commit") return null;

  if (o.check_runs_truncated) return "GitHub reported more check runs than the receipt lists, so it can't show every one passed";
  const runs = Array.isArray(o.check_runs) ? o.check_runs : [];
  const bad = runs.filter((r) => r.status === "completed" && !PASSING.has(r.conclusion) && r.conclusion !== "skipped" && r.conclusion !== "neutral");
  if (bad.length) return `check runs didn't pass: ${bad.map((r) => `${r.name} (${r.conclusion})`).join(", ").slice(0, 300)}`;
  for (const { name, app } of req.required_checks) {
    const mine = runs.filter((r) => r.name === name && r.app === app);
    if (!mine.length) return `the required check "${name}" from ${app} isn't in the receipt`;
    if (mine.some((r) => r.status !== "completed")) return `the required check "${name}" was still running when observed, so it isn't a pass`;
    if (!mine.every((r) => PASSING.has(r.conclusion))) return `the required check "${name}" didn't succeed`;
  }
  if (o.statuses_truncated) return "GitHub reported more commit statuses than the receipt lists, so it can't show every one succeeded";
  const statuses = Array.isArray(o.statuses) ? o.statuses : [];
  const badStatus = statuses.filter((s) => s.state !== "success");
  if (badStatus.length) return `commit statuses not successful: ${badStatus.map((s) => `${s.context} (${s.state})`).join(", ").slice(0, 300)}`;
  return null;
}
