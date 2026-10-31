# Agent Referee gate (v0.1.0, branch `gate-v0`): rules in code

Part B of the rules-in-code design (`research\specs\rules-in-code-2026-10-31\DESIGN.md`, v0). It's an MCP server that every session goes through for the steps the team's rules govern, whatever AI company runs the session.

**Its test, the owner's:** an agent that ignores, forgets or tries to break its instructions still can't:
- do anything on the owner-only list
- mark work done without the evidence the policy requires
- jump a lock or a budget

**What it holds:** no token, and no key that can sign. It can refuse or allow, never approve.

**Status:** built and tested on a branch. It isn't installed anywhere and isn't part of the npm package. Installing it is the owner's yes on the exact files.

## The tools

| Tool | What it does |
|---|---|
| `check_action` | `{action, target, target_sha256?, dry_run?}`. An `"open"` action is allowed. An `"owner_only"` action is allowed only by an owner-signed approval that matches all of these: <br>• this exact action, target and target_sha256 <br>• the policy version <br>• not expired, not dated ahead <br>• not revoked <br>• with a use left <br>An allowed call spends one use, so call it right before the step. `dry_run` spends nothing. If the approvals record can't be read, the answer is no (fail closed). |
| `submit_done` | `{kind, subject, receipts, note?}`. Accepted only if every requirement the policy lists for that kind is met, each by a different receipt (spec v0.4 §5): <br>• the pinned signature (the envelope's own key is never trusted) <br>• the exact normalized subject <br>• the level and check the policy requires <br>• fresh <br>• not accepted here before <br>L2 must be a review-3 with three `pass` votes from three companies, recomputed. A 2-1 is a list of work, not a pass. |
| `take_lock` / `release_lock` | `{name, expected_minutes?, note?}`. One holder at a time across every session using the same state folder. Others are told who holds it, and whether it's stale (`lock_stale_minutes` past its expected end). Only the holder releases it; the owner clears others by hand. |
| `budget` | `{spend_usd?, what?}`. Shows this member's daily limit (UTC) and what's reserved. With `spend_usd`, it reserves first and refuses past the limit, in parallel too. |

**Who's calling** comes from `GATE_MEMBER` in the gate's own settings, set by the owner for each session's entry. It's never an argument.

## Settings (environment)

| Name | What |
|---|---|
| `GATE_POLICY` | Path of the owner's policy file (JSON, below). |
| `GATE_POLICY_SHA256` | The policy's sha256, pinned by the owner. On a mismatch the gate won't start, so editing the policy stops the gate instead of loosening it. |
| `GATE_STATE_DIR` | The gate's state folder: used nonces, accepted receipts, revocations seen, locks, spends, and `decisions.jsonl`. **It must be out of the sessions' reach** (the sandbox, part D), or a session could delete its own used-nonce records. |
| `GATE_MEMBER` | This session's member name. |
| `GATE_APPROVALS_URL` or `GATE_APPROVALS_FILE` | The approvals record: part A's `GET /approvals` (https only), or a file. Its integrity comes from the signatures, so whoever can write the record can delete approvals (they stop working) but can't make one. **Use the URL for real use.** With a file, someone who can write it can also delete a revocation before any gate has read it, and that reopens the approval. Once a gate has seen a revocation, it remembers it in the state folder for good. A file is for tests, or for a folder the sessions can't write. |

Start: `node gate/bin/agent-referee-gate.mjs` (stdio). It needs `agent-referee-client` 0.10 or later, which this repo already depends on.

## The policy (`agent-referee-gate-policy-v1`)
```json
{
  "format": "agent-referee-gate-policy-v1",
  "version": "2026-11-01.1",
  "actions": { "deploy": "owner_only", "publish": "owner_only", "payment": "owner_only", "delete": "owner_only",
               "secret": "owner_only", "install": "owner_only", "rule_change": "owner_only", "merge": "open" },
  "approval_keys": ["<the owner's approval key, base64>"],
  "receipt_keys": ["vM2GY6ZEYc/omRlIFrzu0TaMGtjHXQtchg9d7lPKkTY="],
  "clock_skew_seconds": 120,
  "done": {
    "merge":  { "require": [ { "level": "L1", "check": "github_checks", "required_checks": [{ "name": "test", "app": "github-actions" }], "max_age_minutes": 60 } ] },
    "change": { "allow_unbound_pair": true,
                "require": [ { "level": "L1", "check": "github_checks", "required_checks": [{ "name": "test", "app": "github-actions" }], "max_age_minutes": 60 },
                             { "level": "L2", "check": "panel_pass", "max_age_minutes": 1440 } ] }
  },
  "budgets": { "daily_usd": { "3.0": 1.0 }, "default_daily_usd": 0.5 },
  "lock_stale_minutes": 30
}
```
- **Only listed actions exist.** An unknown action is refused, so a hook or agent can't dodge with a new name.
- **`required_checks` names each check and the GitHub app that ran it** (`"github-actions"`). A check of the same name from another app doesn't count. An agent that edits the workflow in its own commit so the check always passes is still a risk: protect the workflow files with branch protection, or require an L2 review too.
- **`task_sha256` on an L2 requirement** (optional) pins the review's brief, so an agent can't get three passes with an easy task. Without it, the done record still keeps the brief's hash (`review_task_sha256`) for anyone to check.
- **A kind that mixes a commit (L1) and a hash (L0 or L2)** needs `"allow_unbound_pair": true`, set by the owner. No receipt yet proves that the reviewed diff belongs to that commit, so the done record says `pair_bound: false`.
- **The keys must differ:** the gate won't start if an approval key is also a receipt key, compared as bytes. Each key must be written in its canonical base64 spelling.

## The approval record part A must produce (`agent-referee-owner-approval-v1`)

It uses today's receipt envelope `{payload, signature, algorithm: "Ed25519", public_key}`, signed over `canonicalJson(payload)` (agent-referee-client's) with the owner's approval key.

```json
{ "format": "agent-referee-owner-approval-v1", "type": "approval",
  "action": "deploy", "target": "agent-referee-server:production", "target_sha256": "<64 hex or null>",
  "policy_version": "2026-11-01.1", "issued_at": "2026-11-01T17:00:00Z", "expires_at": "2026-11-01T19:00:00Z",
  "nonce": "<24-64 lower-case hex>", "max_uses": 1 }
```

- **A revocation** is `{format, type: "revocation", nonce, issued_at}` under the same key.
- **`max_uses`** runs from 1 to 20. A standing approval is several uses with an expiry, for example "deploy staging, at most 3, until 18:00".
- **`target_sha256: null`** matches only a request without one. When there's a hash, it must match exactly.
- **`GET /approvals`** may return a list, or `{"approvals": [...]}`.

## Tests

`npm run test:gate` runs 52 tests, each trying to get past one rule:
- **Approvals:** missing, other action or target, other target_sha256, expired, dated ahead, a date that doesn't parse, other policy version, revoked (and still revoked after the revocation is deleted), a revocation ignored when the state can't be listed, used up, two processes racing for one use, signed by a forger, a forger's signature with the owner's key in the envelope, signed with Agent Referee's key, edited after signing, unsigned, and a record that can't be read.
- **Receipts:** another commit or repo, stale or from the future, a required check still running, failed, missing or run by another app, another run failed, a truncated list, a failed or pending status, the wrong level, a forged signature, edited after signing, an unknown format, reused, two submissions racing, a 2-1, another output, another brief, a tally that doesn't recompute, reviewers not from three named companies (unprefixed ids, `claude-*` beside `anthropic/`, case variants), an unbound commit-and-hash pair, and a real live 2-1 receipt.
- **The rest:** locks, budgets (also across two processes, a crashed holder, and a member named `__proto__`), a changed policy, shared keys in another spelling, and the member's name as an argument.

**Mutants:** 31 checked (each removes one rule). 29 are caught. Both survivors remove a second check that another one already covers: the use-count precheck (the atomic use files still refuse reuse), and the canonical key spelling (the byte comparison still refuses a shared key).

**Independent checks so far:**
- a fresh-agent read of 9318fdd: 10 findings, all fixed in the next commit, each with a test
- a review-3: planned on the fixed version

## What the gate can't do alone
- **It only binds sessions that must go through it.** The Claude Code hooks (part C) and the sandbox (part D) make the owner-only commands and secret paths unreachable except through `check_action`. Without them, the gate is an honest agent's checklist, not a wall.
- **"That commit is the one being merged"** is the caller's or CI's to state. The gate checks the receipt against the subject it's given.
- **One gate's record is per gate** (spec §5): each gate keeps its own accepted-receipt list.
