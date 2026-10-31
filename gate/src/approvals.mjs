// Owner approvals (DESIGN §3A; receipt spec v0.4 §5): records signed with the owner's own key, never Agent
// Referee's. The gate stores and checks them; it can't make one. An approval names the exact action and target with
// its hash, the policy version, an expiry, a one-time nonce and how many uses it allows. A revocation is another
// owner-signed record naming the nonce.
import { canonicalJson, verifySignature } from "agent-referee-client";

export const APPROVAL_FORMAT = "agent-referee-owner-approval-v1";
const HEX64 = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{24,64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
export const MAX_USES = 20;

/** What a record has to look like before its signature is even checked. Returns a problem, or null. */
function shapeProblem(p) {
  if (!p || typeof p !== "object") return "no payload";
  if (p.format !== APPROVAL_FORMAT) return `format isn't ${APPROVAL_FORMAT}`;
  if (!NONCE.test(String(p.nonce ?? ""))) return "nonce must be 24 to 64 lower-case hex characters";
  const validTime = (v) => ISO.test(String(v ?? "")) && Number.isFinite(Date.parse(v));
  if (!validTime(p.issued_at)) return "issued_at must be a real ISO time in UTC";
  if (p.type === "revocation") return null;
  if (p.type !== "approval") return 'type must be "approval" or "revocation"';
  if (typeof p.action !== "string" || !p.action) return "action is missing";
  if (typeof p.target !== "string" || !p.target) return "target is missing";
  if (p.target_sha256 !== null && !HEX64.test(String(p.target_sha256))) return "target_sha256 must be 64 lower-case hex characters, or null";
  if (typeof p.policy_version !== "string") return "policy_version is missing";
  if (!validTime(p.expires_at)) return "expires_at must be a real ISO time in UTC";
  const uses = p.max_uses ?? 1;
  if (!Number.isInteger(uses) || uses < 1 || uses > MAX_USES) return `max_uses must be 1 to ${MAX_USES}`;
  return null;
}

/** Fetches the approvals record: an owner-run service (URL) or a file. Throws if it can't be read: callers fail closed. */
export async function loadApprovalRecords({ file, url, fetchImpl = fetch, readText }) {
  let data;
  if (url) {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`The approvals record answered ${res.status}.`);
    data = await res.json();
  } else if (file) {
    data = JSON.parse(await readText(file));
  } else return [];
  const list = Array.isArray(data) ? data : Array.isArray(data?.approvals) ? data.approvals : null;
  if (!list) throw new Error('The approvals record must be a list of signed records, or {"approvals": [...]}.');
  return list;
}

/**
 * Sorts signed records into verified approvals and revoked nonces. Records that fail shape or signature are kept as
 * "rejected" with a reason, so check_action can say why nothing matched. Only the policy's approval keys count;
 * the key inside the envelope is never trusted alone.
 */
export async function sortRecords(records, approvalKeys) {
  const approvals = [];
  const revoked = new Set();
  const rejected = [];
  for (const r of records) {
    const p = r?.payload;
    const problem = shapeProblem(p);
    if (problem) {
      rejected.push({ nonce: p?.nonce ?? null, why: problem });
      continue;
    }
    if (!(await verifySignature(r, approvalKeys))) {
      rejected.push({ nonce: p.nonce, why: "not signed by the owner's approval key" });
      continue;
    }
    if (p.type === "revocation") revoked.add(p.nonce);
    else approvals.push({ ...p, max_uses: p.max_uses ?? 1, canonical: canonicalJson(p) });
  }
  return { approvals, revoked, rejected };
}

/** Why one verified approval doesn't fit a request (or null if it does, apart from uses). */
export function mismatch(a, req, { policyVersion, now, skewMs, revoked }) {
  if (a.action !== req.action) return null; // not a candidate at all
  if (a.target !== req.target) return `approval ${a.nonce.slice(0, 8)} is for target "${a.target.slice(0, 120)}", not this one`;
  if ((a.target_sha256 ?? null) !== (req.target_sha256 ?? null))
    return `approval ${a.nonce.slice(0, 8)} is for a different version of the target (target_sha256 differs)`;
  if (a.policy_version !== policyVersion) return `approval ${a.nonce.slice(0, 8)} was made under policy ${a.policy_version}, not ${policyVersion}`;
  if (Date.parse(a.issued_at) > now + skewMs) return `approval ${a.nonce.slice(0, 8)} is dated in the future`;
  if (Date.parse(a.expires_at) <= now) return `approval ${a.nonce.slice(0, 8)} expired at ${a.expires_at}`;
  if (revoked.has(a.nonce)) return `approval ${a.nonce.slice(0, 8)} was revoked`;
  return "";
}
