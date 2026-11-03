// Proof receipts (Agent Referee receipt spec v0.4; server route POST /team/proof): signed records that use no AI model.
//   L0 "stamp":   a claim and a sha256, signed as received, with the time. The claim isn't checked.
//   L1 "observe": a public GitHub commit, or its checks, read by the service itself, with the time it read them.
// L2 is a review-3 receipt with three "pass" votes; it comes from sealed_review, not from here.
// A receipt proves a fact. It never stands in for the owner's yes: deploys, payments, deletes, secrets, installing
// skills or servers, rule changes.
import { verifySignature } from "agent-referee-client";

export const PROOF_FORMAT = "agent-referee-proof-v1";
export const NEVER_AN_APPROVAL =
  "A receipt can pass a quality step. It never stands in for the owner's yes: deploys, payments, deletes, secrets, installing skills or servers, and rule changes.";
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const REPO = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** The request as the service normalizes it (spec §4): lower-case full-length hex; owner/name lower-cased. */
export function proofRequest(args, sha256OfText) {
  if (args.level === "L0") {
    if (args.check !== undefined && args.check !== "stamp") return { error: 'L0 has one check: "stamp".' };
    if ((args.sha256 === undefined) === (args.text === undefined)) return { error: "An L0 stamp needs exactly one of sha256 (64 hex, computed by you) or text (hashed here; the text itself is never sent)." };
    const sha256 = args.text !== undefined ? sha256OfText(args.text) : String(args.sha256).trim().toLowerCase();
    if (!HEX64.test(sha256)) return { error: "sha256 must be 64 hex characters: the full sha256 of the thing you're stamping." };
    if (args.repo !== undefined || args.sha !== undefined) return { error: "An L0 stamp takes sha256 or text and a claim, not repo or sha." };
    return { body: { level: "L0", check: "stamp", sha256, claim: args.claim ?? "" } };
  }
  if (args.level === "L1") {
    if (args.check !== "github_commit" && args.check !== "github_checks") return { error: 'L1 checks are "github_commit" and "github_checks".' };
    const repo = String(args.repo ?? "").trim().toLowerCase();
    const sha = String(args.sha ?? "").trim().toLowerCase();
    if (!REPO.test(repo)) return { error: 'repo must be "owner/name" of a public GitHub repository.' };
    if (!HEX40.test(sha)) return { error: "sha must be the commit's full 40 hex characters; short shas are refused." };
    if (args.sha256 !== undefined || args.text !== undefined || args.claim !== undefined) return { error: "An L1 observation takes repo and sha only: the service reads the facts itself." };
    return { body: { level: "L1", check: args.check, repo, sha } };
  }
  return { error: 'level must be "L0" or "L1". (L2 is a review-3 with three "pass" votes: use sealed_review.)' };
}

/**
 * Checks a proof receipt offline: the pinned signature (never the envelope's key alone), its shape, and, when given,
 * that it's about the exact subject you expect. Returns { ok, problems, level, check, subject, time, claimed, observed }.
 */
export async function checkProof(receipt, { pinned, expect = {} }) {
  const problems = [];
  const p = receipt?.payload ?? {};
  const signed = await verifySignature(receipt, pinned).catch(() => false);
  if (!signed) problems.push("The signature doesn't check out against Agent Referee's pinned key: don't rely on this receipt.");
  // The service signs the format as receipt_format (as review-multi-v1 does); a receipt without it isn't one we know.
  if (p.receipt_format !== PROOF_FORMAT || p.type !== "proof") problems.push(`Not a proof receipt this tool knows (receipt_format ${String(p.receipt_format).slice(0, 40)}).`);
  const level = p.level;
  const check = p.check;
  if (!((level === "L0" && check === "stamp") || (level === "L1" && (check === "github_commit" || check === "github_checks")))) problems.push(`Unknown level and check: ${String(level).slice(0, 10)} ${String(check).slice(0, 30)}.`);
  if (typeof p.receipt_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(p.receipt_id)) problems.push("The receipt has no valid receipt_id.");
  if (!ISO.test(String(p.issued_at ?? ""))) problems.push("issued_at is missing or not an ISO time.");
  if (typeof p.caller?.member !== "string") problems.push("The receipt names no team member.");
  const subject = p.subject ?? {};
  if (level === "L0") {
    if (!HEX64.test(String(subject.sha256 ?? ""))) problems.push("An L0 stamp's subject must be a full sha256.");
    if (p.observed !== undefined) problems.push("An L0 stamp must not carry an observed part: its claim is the caller's, never checked.");
  }
  if (level === "L1") {
    if (!REPO.test(String(subject.repo ?? "")) || !HEX40.test(String(subject.sha ?? ""))) problems.push("An L1 subject must be a repo and a full 40-character sha.");
    if (!p.observed || typeof p.observed !== "object") problems.push("An L1 receipt must carry what the service observed.");
    else {
      if (p.observed.commit_sha !== subject.sha) problems.push("The observed commit differs from the subject.");
      if (!ISO.test(String(p.observed.observed_at ?? ""))) problems.push("observed_at is missing or not an ISO time.");
      if (p.claimed !== undefined) problems.push("An L1 receipt must not carry a claim.");
    }
  }
  // The subject you hold: compared exactly, after the same normalization the service applies.
  const want = {
    sha256: expect.sha256 !== undefined ? String(expect.sha256).trim().toLowerCase() : undefined,
    repo: expect.repo !== undefined ? String(expect.repo).trim().toLowerCase() : undefined,
    sha: expect.sha !== undefined ? String(expect.sha).trim().toLowerCase() : undefined,
  };
  if (want.sha256 !== undefined && subject.sha256 !== want.sha256) problems.push("This stamp is for a different sha256 than the one you have.");
  if (want.repo !== undefined && subject.repo !== want.repo) problems.push("This observation is for a different repository.");
  if (want.sha !== undefined && subject.sha !== want.sha) problems.push("This observation is for a different commit.");
  if (expect.level !== undefined && level !== expect.level) problems.push(`This is ${level}, not ${expect.level}.`);
  if (expect.check !== undefined && check !== expect.check) problems.push(`This is ${check}, not ${expect.check}.`);
  const time = level === "L1" ? p.observed?.observed_at : p.issued_at;
  return {
    ok: problems.length === 0,
    signature_valid: signed,
    problems,
    level,
    check,
    receipt_id: p.receipt_id,
    member: p.caller?.member,
    member_verified: p.caller?.verified === true,
    ...(typeof p.limits === "string" ? { limits: p.limits } : {}),
    subject,
    time,
    ...(p.claimed !== undefined ? { claimed: p.claimed } : {}),
    ...(p.observed !== undefined ? { observed: p.observed } : {}),
  };
}

/** One line for an L1 github_checks observation: every run and status, with in-progress ones named. Never "passed". */
export function checksLine(observed) {
  const runs = Array.isArray(observed?.check_runs) ? observed.check_runs : [];
  const running = runs.filter((r) => r.status !== "completed").length;
  const failed = runs.filter((r) => r.status === "completed" && !["success", "skipped", "neutral"].includes(r.conclusion)).length;
  const ok = runs.filter((r) => r.status === "completed" && r.conclusion === "success").length;
  const statuses = Array.isArray(observed?.statuses) ? observed.statuses : [];
  const place = observed?.on_default_branch === true ? "on the default branch" : observed?.on_default_branch === false ? "NOT on the default branch" : "default branch unknown";
  return `${runs.length} check run(s): ${ok} succeeded, ${failed} didn't, ${running} still running${observed?.check_runs_truncated ? " (list truncated)" : ""}; ${statuses.length} status(es)${observed?.statuses_truncated ? " (list truncated)" : ""}, combined ${observed?.combined_status ?? "none"}; commit ${place}. Which ones matter is the gate's or reader's call.`;
}
