// The gate's policy: which actions are owner-only, whose keys sign approvals and receipts, and what each kind of
// "done" must carry. The owner writes it; the gate refuses to start unless its sha256 matches the one pinned in the
// gate's own settings (GATE_POLICY_SHA256), so a session that edits the file stops the gate instead of loosening it.
import { createHash } from "node:crypto";

export const POLICY_FORMAT = "agent-referee-gate-policy-v1";
const KEY = /^[A-Za-z0-9+/]{43}=$/; // a base64 Ed25519 public key (32 bytes)
// Canonical spelling only: the same 32 bytes have several base64 spellings, so keys are compared as decoded bytes too.
const canonicalKey = (k) => KEY.test(k) && Buffer.from(k, "base64").length === 32 && Buffer.from(k, "base64").toString("base64") === k;
const SUBJECT_OF = { L0: "sha256", L1: "commit", L2: "sha256" };
const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export const sha256OfText = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** Parses and checks the policy text against the pinned hash. Throws with a plain reason; never starts half-configured. */
export function loadPolicy(text, pinnedSha256) {
  const pinned = String(pinnedSha256 ?? "").trim().toLowerCase();
  if (!HEX64.test(pinned)) throw new Error("GATE_POLICY_SHA256 must be the policy file's 64-character sha256, set by the owner.");
  const actual = sha256OfText(text);
  if (actual !== pinned) throw new Error(`The policy file's sha256 is ${actual}, not the pinned ${pinned}. The gate won't start on a changed policy; the owner re-pins it after checking the change.`);
  let p;
  try {
    p = JSON.parse(text);
  } catch {
    throw new Error("The policy file isn't valid JSON.");
  }
  const problems = [];
  if (p.format !== POLICY_FORMAT) problems.push(`format must be "${POLICY_FORMAT}".`);
  if (typeof p.version !== "string" || !p.version.trim()) problems.push("version must be a non-empty string; approvals name it.");
  const actions = p.actions && typeof p.actions === "object" ? p.actions : null;
  if (!actions || !Object.keys(actions).length) problems.push('actions must map each action name to "owner_only" or "open".');
  else
    for (const [name, kind] of Object.entries(actions)) {
      if (!NAME.test(name)) problems.push(`Action name "${name}" must be lower-case letters, digits and underscores.`);
      if (kind !== "owner_only" && kind !== "open") problems.push(`Action "${name}" must be "owner_only" or "open".`);
    }
  for (const field of ["approval_keys", "receipt_keys"]) {
    if (!Array.isArray(p[field]) || !p[field].length || !p[field].every(canonicalKey)) problems.push(`${field} must be a non-empty list of base64 Ed25519 public keys, each in its canonical spelling.`);
  }
  const bytes = (k) => Buffer.from(String(k), "base64").toString("hex");
  if (Array.isArray(p.approval_keys) && Array.isArray(p.receipt_keys) && p.approval_keys.some((k) => p.receipt_keys.map(bytes).includes(bytes(k))))
    problems.push("An approval key is also a receipt key. The owner's approvals and Agent Referee's receipts must be signed by different keys, so neither can make the other.");
  const skew = p.clock_skew_seconds ?? 120;
  if (!Number.isInteger(skew) || skew < 0 || skew > 900) problems.push("clock_skew_seconds must be an integer from 0 to 900.");
  const done = p.done ?? {};
  if (typeof done !== "object") problems.push("done must map each kind of done to its requirements.");
  for (const [kind, rule] of Object.entries(done)) {
    if (!NAME.test(kind)) problems.push(`Done kind "${kind}" must be lower-case letters, digits and underscores.`);
    if (!Array.isArray(rule?.require) || !rule.require.length) problems.push(`done.${kind}.require must list at least one receipt requirement.`);
    else
      rule.require.forEach((r, i) => {
        const at = `done.${kind}.require[${i}]`;
        const ok =
          (r.level === "L0" && r.check === "stamp") ||
          (r.level === "L1" && (r.check === "github_commit" || r.check === "github_checks")) ||
          (r.level === "L2" && (r.check ?? "panel_pass") === "panel_pass");
        if (!ok) problems.push(`${at}: level and check must be L0 stamp, L1 github_commit, L1 github_checks or L2 panel_pass.`);
        if (!Number.isInteger(r.max_age_minutes) || r.max_age_minutes < 1) problems.push(`${at}: max_age_minutes must be a whole number of minutes, at least 1.`);
        if (r.check === "github_checks" && (!Array.isArray(r.required_checks) || !r.required_checks.length || !r.required_checks.every((c) => typeof c?.name === "string" && c.name && typeof c?.app === "string" && c.app)))
          problems.push(`${at}: github_checks needs required_checks: [{"name": "...", "app": "github-actions"}], each check that must have passed and the GitHub app that must have run it.`);
        if (r.on_default_branch !== undefined && (r.level !== "L1" || typeof r.on_default_branch !== "boolean"))
          problems.push(`${at}: on_default_branch (true or false) applies to L1 requirements only.`);
        if (r.task_sha256 !== undefined && (r.level !== "L2" || !HEX64.test(String(r.task_sha256))))
          problems.push(`${at}: task_sha256 pins the brief of an L2 review, as 64 lower-case hex characters.`);
      });
    // A kind that mixes a commit requirement with a hash requirement can't show that the hash belongs to the commit
    // (no receipt binds them yet), so the owner must say so explicitly; the done record then marks the pair unbound.
    if (Array.isArray(rule?.require)) {
      const kinds = new Set(rule.require.map((r) => SUBJECT_OF[r.level]).filter(Boolean));
      if (kinds.size > 1 && rule.allow_unbound_pair !== true)
        problems.push(`done.${kind} mixes a commit requirement (L1) with a hash requirement (L0 or L2). Nothing proves the hash is that commit's, so set "allow_unbound_pair": true only if you accept that; the done record will say the pair is unbound.`);
    }
  }
  const budgets = p.budgets ?? {};
  for (const [member, usd] of Object.entries(budgets.daily_usd ?? {}))
    if (typeof usd !== "number" || usd < 0) problems.push(`budgets.daily_usd.${member} must be a number of dollars, 0 or more.`);
  if (budgets.default_daily_usd !== undefined && (typeof budgets.default_daily_usd !== "number" || budgets.default_daily_usd < 0))
    problems.push("budgets.default_daily_usd must be a number of dollars, 0 or more.");
  const stale = p.lock_stale_minutes ?? 30;
  if (!Number.isInteger(stale) || stale < 1) problems.push("lock_stale_minutes must be a whole number, at least 1.");
  if (problems.length) throw new Error(`The policy has problems, so the gate won't start:\n- ${problems.join("\n- ")}`);
  return {
    ...p,
    sha256: actual,
    clock_skew_seconds: skew,
    lock_stale_minutes: stale,
    done,
    budgets: { daily_usd: budgets.daily_usd ?? {}, default_daily_usd: budgets.default_daily_usd ?? 0 },
  };
}
