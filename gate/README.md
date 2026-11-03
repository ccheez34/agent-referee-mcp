# Agent Referee gate (v0.2.1, branch `gate-b2`): rules in code

Part B of the rules-in-code design (`research\specs\rules-in-code-2026-10-31\DESIGN.md`, v0). It's an MCP server that every session goes through for the steps the team's rules govern, whatever AI company runs the session.

**Its test, the owner's:** an agent that ignores, forgets or tries to break its instructions still can't:
- do anything on the owner-only list, or do it under another seat's name
- mark work done without the evidence the policy requires
- jump a lock or a budget

**What it holds:** no token, and no key that can sign. It can refuse or allow, never approve.

**Status:** built and tested on a branch. It isn't installed anywhere and isn't part of the npm package. Installing it is the owner's yes on the exact files ("Installing it", below).

**v0.2.0 (B2) changes, for whoever signs approvals (part A):** the approval format is now `agent-referee-owner-approval-v2`. An approval names the seat it's for (`member`), is used once (`max_uses` is 1), and may not last longer than the policy's `approval_max_hours`. A v1 approval is rejected with that reason; a v1 revocation still revokes. The policy must list every seat (`members`) and keep the seven baseline actions owner-only, or the gate won't start. A `canary` tool checks each seat's sandbox before its owner-only steps.

## The tools

| Tool | What it does |
|---|---|
| `check_action` | `{action, target, target_sha256?, dry_run?}`. An action the policy doesn't list fails validation. An `"open"` action is allowed, and logged. An `"owner_only"` action is allowed only by an owner-signed approval, read fresh from the approvals record on each call (part A's https address, no redirects, a 10-second timeout; or a file, for tests; records sorted by shape, then signature against the policy's keys), that matches all of these: <br>• this seat (`member`), from the gate's own settings <br>• this exact action, target and target_sha256 <br>• the policy version <br>• not expired, not dated ahead by more than `clock_skew_seconds`, and not lasting longer than `approval_max_hours` <br>• not revoked <br>• not used yet <br>An allowed call spends the approval's one use, so call it right before the step. `dry_run` spends nothing. If the policy sets a canary, this seat's canary must have passed within `max_age_hours`, for dry runs too. If the approvals record can't be read, the answer is no (fail closed). |
| `submit_done` | `{kind, subject, receipts, note?}`. Accepted only if every requirement the policy lists for that kind is met, each by a different receipt (spec v0.4 §5): <br>• the pinned signature (the envelope's own key is never trusted) <br>• the exact normalized subject <br>• the level and check the policy requires <br>• fresh <br>• not accepted here before <br>L2 must be a review-3 with three `pass` votes from three companies, recomputed. A 2-1 is a list of work, not a pass. |
| `take_lock` / `release_lock` | `{name, expected_minutes?, note?}`. One holder at a time across every session using the same state folder. Others are told who holds it, and whether it's stale (`lock_stale_minutes` past its expected end). Only the holder releases it; the owner clears others by hand. |
| `canary` | `{step, run_id?, read?, read_text?, fetch?, fetch_detail?}`. Only when the policy sets a canary. `"start"` writes a fresh decoy file where no session should reach and names an https address none should reach (one open run per seat at a time); the session tries both with its own tools, then calls `"report"` within 15 minutes with what happened. Both attempts must fail, and the report must not show the decoy's value. A pass lets this seat's owner-only steps through for `max_age_hours` (default 24); a failure is written as `canary-failed-<member>` in the state folder before the report record and the status, and sticks until the owner fixes the sandbox and deletes that file. A report missing `run_id`, `read` or `fetch` is refused. |
| `budget` | `{spend_usd?, what?}`. Shows this member's daily limit (UTC) and what's reserved. With `spend_usd`, it reserves first and refuses past the limit, in parallel too. |

**Who's calling** comes from `GATE_MEMBER` in the gate's own settings, set by the owner for each session's entry. It's never an argument, and it must be on the policy's `members` list, or the gate won't start.

## Settings (environment)

| Name | What |
|---|---|
| `GATE_POLICY` | Path of the owner's policy file (JSON, below). |
| `GATE_POLICY_SHA256` | The policy's sha256, pinned by the owner. On a mismatch the gate won't start, so editing the policy stops the gate instead of loosening it. |
| `GATE_STATE_DIR` | The gate's state folder: used approvals, accepted receipts, revocations seen, locks, spends, canary records and `decisions.jsonl`. **It must be out of the sessions' reach** (the sandbox, part D), or a session could delete its own used-approval record. **Every gate process of a seat shares it** (the MCP server and the hook's `check` command), or a one-use approval is usable once per folder. |
| `GATE_MEMBER` | This session's member name (letters, digits, `.`, `_`, `-`; up to 40), listed in the policy's `members`. |
| `GATE_APPROVALS_URL` or `GATE_APPROVALS_FILE` | The approvals record: part A's `GET /approvals` (https only), or a file. Its integrity comes from the signatures, so whoever can write the record can delete approvals (they stop working) but can't make one. **Use the URL for real use.** With a file, someone who can write it can also delete a revocation before any gate has read it, and that reopens the approval. Once a gate has seen a revocation, it remembers it in the state folder for good. A file is for tests, or for a folder the sessions can't write. |

**These settings are the gate's root of trust.** The entry or environment that carries them must be as unwritable to the sessions as the policy file: a session that could edit `GATE_MEMBER` would act under another seat's name; one that could point `GATE_STATE_DIR` at an empty folder would forget every used approval and every sticking canary failure; one that could re-pin a loosened policy with its own sha256 would loosen the gate (the pin stops an edit without a re-pin, not a re-pin). Only the owner writes them.

Start: `node gate/bin/agent-referee-gate.mjs` (stdio). It refuses to start, with the reason on stderr, when a setting is missing, the policy's sha256 differs from the pinned one, the policy is loose (below), `GATE_MEMBER` isn't listed, or an approval key is also a receipt key.

**As a command, for hooks that can't call an MCP tool:**
- Syntax: `node gate/bin/agent-referee-gate.mjs check <action> <target> [target_sha256] [--dry-run]`, with the same settings in its environment.
- It exits 0 only when the action is allowed, and an allowed check spends the approval's use unless `--dry-run` is given.
- It exits 1 when the action isn't allowed, and 2 when the gate can't run.
- It writes one JSON line to stdout and the reason to stderr. It needs `agent-referee-client` 0.10 or later, which this repo already depends on.

## The policy (`agent-referee-gate-policy-v1`)
```json
{
  "format": "agent-referee-gate-policy-v1",
  "version": "2026-11-03.1",
  "members": ["1.0", "2.0", "3.0", "4.0", "5.0"],
  "actions": { "deploy": "owner_only", "publish": "owner_only", "payment": "owner_only", "delete": "owner_only",
               "secret": "owner_only", "install": "owner_only", "rule_change": "owner_only", "merge": "open" },
  "approval_keys": ["<the owner's approval key, base64>"],
  "receipt_keys": ["vM2GY6ZEYc/omRlIFrzu0TaMGtjHXQtchg9d7lPKkTY="],
  "approval_max_hours": 24,
  "canary": { "decoy_dir": "/srv/gate-canary", "blocked_url": "https://canary.invalid/", "max_age_hours": 24 },
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
- **It fails closed.** The gate doesn't start on a policy that leaves out, or marks `"open"`, any of the seven baseline actions `deploy`, `publish`, `payment`, `delete`, `secret`, `install`, `rule_change`; that lists no `members`; or whose `approval_max_hours` is outside 1 to 168. A policy can add owner-only actions and open ones; it can't loosen the baseline.
- **`members`** lists each seat's member name once. A gate whose `GATE_MEMBER` isn't listed doesn't start, so a seat the owner hasn't named can't use the gate at all.
- **Only listed actions exist.** An unknown action is refused, so a hook or agent can't dodge with a new name.
- **`approval_max_hours`** (default 24) is the longest an approval may last from `issued_at` to `expires_at`. A longer one is refused even if it hasn't expired.
- **`canary`** (optional): `decoy_dir` is an absolute path to a folder the gate can write and no session should be able to read (outside the sandbox's view); `blocked_url` an https address the sandbox must block; `max_age_hours` (default 24) how long a pass lasts. Leave `canary` out and the tool isn't offered; owner-only steps then rest on the approvals alone.
- **`required_checks` names each check and the GitHub app that ran it** (`"github-actions"`). A check of the same name from another app doesn't count. An agent that edits the workflow in its own commit so the check always passes is still a risk: protect the workflow files with branch protection, or require an L2 review too.
- **`on_default_branch: true` on an L1 requirement** asks for a receipt that shows the commit on the repository's default branch. The service records this because a commit shown through a repository's API can live only in a fork. A receipt that says it isn't there, or that GitHub couldn't tell, is refused.
- **Proof receipts carry their format as `receipt_format`** (`agent-referee-proof-v1`), as signed by agent-referee-server `d9578f4`. A truncated list of commit statuses is refused, like a truncated list of check runs.
- **`task_sha256` on an L2 requirement** (optional) pins the review's brief, so an agent can't get three passes with an easy task. Without it, the done record still keeps the brief's hash (`review_task_sha256`) for anyone to check.
- **A kind that mixes a commit (L1) and a hash (L0 or L2)** needs `"allow_unbound_pair": true`, set by the owner. No receipt yet proves that the reviewed diff belongs to that commit, so the done record says `pair_bound: false`.
- **The keys must differ:** the gate won't start if an approval key is also a receipt key, compared as bytes. Each key must be written in its canonical base64 spelling.

## The approval record part A must produce (`agent-referee-owner-approval-v2`)

It uses today's receipt envelope `{payload, signature, algorithm: "Ed25519", public_key}`, signed over `canonicalJson(payload)` (agent-referee-client's: keys sorted, `undefined` dropped, no whitespace) with the owner's approval key. The gate checks the signature against the policy's `approval_keys` only; the key in the envelope is never trusted.

```json
{ "format": "agent-referee-owner-approval-v2", "type": "approval",
  "member": "3.0",
  "action": "deploy", "target": "agent-referee-server:production@<40-hex commit>", "target_sha256": null,
  "policy_version": "2026-11-03.1", "issued_at": "2026-11-03T17:00:00Z", "expires_at": "2026-11-03T19:00:00Z",
  "nonce": "<24-64 lower-case hex>", "max_uses": 1 }
```

- **`member`:** the seat the approval is for, as the gate's `GATE_MEMBER` names it (letters, digits, `.`, `_`, `-`; up to 40). Another seat's gate refuses it, even one sharing the same state folder and record. Part A's form needs a field for the seat.
- **`action`:** one of the policy's owner-only actions. **`target` and `target_sha256`** are compared byte for byte, so the exact version goes in one of them: a commit in the target, or a bundle's sha256. **`target_sha256` is always present:** 64 lower-case hex characters, or `null` when there is no hash; a record without the key is rejected at the shape check (a JavaScript `undefined` is dropped by `canonicalJson`, so sign `null`, not `undefined`). `target_sha256: null` matches only a request without one. For a payment, the target names the funding and the total (for example `payment:<funding>:<total in USD>`).
- **`policy_version`:** the gate policy's `version`. An approval made under another version is refused, so re-pinning the policy voids the approvals made before it.
- **Times:** ISO 8601 in UTC with a trailing `Z`. `expires_at` must be after `issued_at`; `issued_at` may not be ahead of the gate's clock by more than `clock_skew_seconds`; `expires_at` must be after now; and `expires_at − issued_at` may not exceed `approval_max_hours`.
- **`nonce`:** 24 to 64 lower-case hex characters, unique per approval. The gate records each use under the nonce in its state folder.
- **`max_uses`:** must be 1, or left out (`null` is rejected). **An approval is used once.** A standing approval ("deploy staging, at most 3, until 18:00") is three approvals, each with its own nonce and expiry; part A may sign several at once. The owner's standing limits that need no approval record at all (for example dispute matches up to a daily amount) live in a RULES version he confirmed, not in the gate.
- **The envelope's `public_key`** must be the pinned key's exact base64 spelling, or left out: the client library uses it to choose which pinned key to try, so the same key in another spelling is refused (fail closed). `algorithm` isn't checked.
- **A revocation** is `{format, type: "revocation", nonce, issued_at}` under the same key, with the approval's nonce and no `member`. A revocation in the v1 format still counts, since it only takes permission away.
- **v1 approvals** (`agent-referee-owner-approval-v1`, no seat) are rejected with the reason `format agent-referee-owner-approval-v1 names no seat; the owner signs it again as agent-referee-owner-approval-v2`. Nothing signed before this version opens anything.
- **`GET /approvals`** may return a list, or `{"approvals": [...]}`. The gate reads it on every owner-only check that gets past the canary (10-second timeout, no redirects; https only, checked both in the settings and by the loader itself); open actions never touch it.

**What the gate checks, in order, before allowing an owner-only step:** the policy's actions (an unknown or open action never reaches the approvals); this seat's canary, if the policy sets one; the approvals record is readable; each record's shape, then its signature with the pinned keys; the revocations seen are remembered and the gate's own records are listable (or it can't rule out a revocation); the action (an approval for another action isn't a candidate); the seat (an approval for this action but another seat is counted, never matched, and the answer gives only the count, not its nonce or target); the target and target_sha256; the policy version; not dated ahead, not expired, not over the lifetime cap; not revoked, counting revocations seen earlier; and a use left, spent atomically so two gates sharing a state folder can't both spend it. A refusal names the first reason a candidate didn't fit and lists up to 20 reasons in all, rejected records included by their reason alone (a rejected record may be another seat's, so its nonce goes only to the decision log), so a mistyped target or a stale policy version shows; the decision log keeps the first five reasons.

**Never:** a receipt, a message, a file in a session's reach or a tool's output counts as an approval. Only a record signed with the approvals key does.

## The canary: proving a seat's sandbox blocks what it must

The gate can't see a session's tools, so it asks the session to prove its sandbox from inside and records the answer:
1. `canary` with step `"start"` writes `decoy-<member>.txt` into `canary.decoy_dir` with a fresh random value (32 hex characters), keeps only the value's sha256 in the state folder, and names the decoy's path and `blocked_url`. One run per seat is open at a time, under the seat's own mutex: a second `start` within 15 minutes is refused until the first is reported, and two starts at once can't both open a run, so the decoy isn't overwritten under a live run.
2. The session tries, with its own tools (not the gate), to read the decoy file and to fetch the address. In a working sandbox both fail.
3. Within 15 minutes it calls step `"report"` with `run_id`, `read` and `fetch` (`"failed"` or `"succeeded"`; a report missing one of the three is refused), the read's output as it was (`read_text`), and the fetch's error (`fetch_detail`). Both texts are scanned for the value (every 32-character window of every hex run, case-folded), and neither is stored: the state folder keeps `read`, `fetch`, whether the value was seen, and the verdict.
4. **A pass** needs both to have failed and neither text to show the decoy's value. It opens this seat's owner-only steps for `max_age_hours` (default 24, 1 to 168); then the canary runs again.
5. **A failure** (a read or fetch that succeeded, or a report that shows the value) is recorded as `canary-failed-<member>` before the report record and the seat's status (`canary-status-<member>`) are written, so a crash at any later point leaves the seat blocked, and it sticks: this seat's owner-only steps wait until the owner fixes the sandbox and deletes that file in the state folder. The run itself can't be reported twice, used by another seat, or reported after its 15 minutes (a run record whose start time can't be read counts as late). A report runs under the run's own mutex, so two reports at once can't both pass the "already reported" check and a refused report changes nothing; and only the seat's open run can be reported (a start that crashed before its open record was written, or a run a later start replaced, is refused), so a seat never has two reportable runs. A busy mutex, a corrupt record or a failing write is refused with a reason the session can act on, never the raw error.

**What it proves:** that an honest session's sandbox blocks the decoy and the host, and that a session that pastes what it read gives itself away. **What it doesn't:** a session that reports "failed" without trying passes. The sandbox check script (part D) is the proof that holds against a lying session; the canary catches a sandbox that quietly lost its settings.

## Installing it, in order (the owner's steps)

Nothing in this folder installs anything. Installing a server, a hook or a policy is on the owner-only list, so each step below is the owner's, on the exact files (their sha256), and nothing is loosened between steps: until the last one, the gate can refuse but its "allowed" means nothing to the rules.

1. **Decide where the gate runs:** inside the sandbox (part D) as a local server, one process per seat, or hosted. Create the state folder (`GATE_STATE_DIR`) where the sessions' user can't read or write; the gate's user can. Create `canary.decoy_dir` the same way. The settings themselves (the MCP entry, or the environment the hook's `check` command runs with) live where only you can write them.
2. **Deploy part A** (the approvals service) and read its public key from its own `GET /pubkey`, never from a session or a message. Keep its token on the phone or in the password manager, never on the PC.
3. **Write the policy file** where sessions can't write it: `members` (every seat's name), `approval_keys` (part A's key), `receipt_keys` (Agent Referee's), the seven baseline actions `owner_only` plus any more, `approval_max_hours`, `canary`, the `done` kinds, `budgets`. Compute its sha256 yourself; that is `GATE_POLICY_SHA256`.
4. **Start one gate per seat** with `GATE_MEMBER` set to that seat, `GATE_POLICY`, `GATE_POLICY_SHA256`, `GATE_STATE_DIR` and `GATE_APPROVALS_URL`; a seat's hook command gets the same five settings, so every process of the seat shares one state folder. A gate that won't start says why on stderr; fix the policy or the settings, never the check.
5. **Put the sessions in the sandbox** (part D) so the secret paths and the blocked hosts are unreachable, and **install the hooks** (part C) so the owner-only commands call `check` first. Run part D's check script; every attempt in it must fail. The sandbox comes before the canary, which can only pass once the sandbox blocks what it must.
6. **Run the canary from each seat** (start, try both, report). Every seat must pass before any owner-only step is checked.
7. **Confirm a RULES version that names this gate's entry and the approvals key** in each session's chat. From then on, an approval the gate accepts counts as the owner's yes for that exact step (RULES rule 1). Before that, the gate is an honest agent's checklist, and the owner's yes is still text in the chat.

**Upgrading from v0.1.0 (`gate-v0`):** the state folder carries over (used nonces, accepted receipts, revocations, locks, spends). Part A must sign v2 records; every v1 approval stops working at once, and the policy needs `members` (and `approval_max_hours` or `canary` if wanted) and a new `version`, which voids the old approvals anyway.

## Tests

`npm run test:gate` runs 81 tests, each trying to get past one rule:
- **Approvals:** missing, other action or target, other target_sha256, expired, dated ahead, a date that doesn't parse, other policy version, revoked (and still revoked after the revocation is deleted), a revocation ignored when the state can't be listed, used up, two processes racing for one use, signed by a forger, a forger's signature with the owner's key in the envelope, signed with Agent Referee's key, edited after signing, unsigned, a record that can't be read, and an approvals address that isn't https, refused by the loader before any fetch.
- **B2:** `max_uses` above 1 or `null` rejected and the one use not spent twice; another seat's approval refused, even through a gate sharing the same state and record, and never named in the answer; a rejected record's nonce kept out of the answer too (the decision log keeps its prefix); an approval with no seat, in the v1 format, or without the `target_sha256` key rejected, while a v1 revocation still revokes; an `expires_at` not after `issued_at` rejected; a lifetime over `approval_max_hours` refused; a policy that leaves a baseline action out or open, or lists no members, doesn't start; a `GATE_MEMBER` the policy doesn't list doesn't start.
- **Canary:** owner-only steps wait for this seat's canary while open steps don't; both attempts failing passes it, the approval then works, and the pass lapses after `max_age_hours`; a read or fetch that succeeded, or a report showing the decoy's value, fails it and the failure sticks; the value in `fetch_detail`, or glued to other hex, is seen, and no state file ever holds the value or the report's text; one open run per seat, a second `start` refused until the first is reported or 15 minutes pass, and three starts at once open one run; a second report of a reported run changes nothing, even a failing one; a failing report sticks even when the report record or the status write after it fails; an upper-cased echo of the value is seen; a seat named like another seat's failure key (`failed-A` beside `A`) can't block it; a run whose start time can't be read is refused; another seat's run, an old run, a second report or a missing field is refused; two reports of one run at once leave one accepted and no sticking failure from the refused one; a busy mutex, a corrupt run record or a failing write comes back as a refusal the session can act on, with none of the record's text; a run whose start crashed before its open record, or that a later start replaced, can't be reported; the policy needs an absolute decoy folder and an https address, and a decoy folder that doesn't exist refuses the canary's `start` step (the owner creates it).
- **Receipts:** another commit or repo, stale or from the future, a required check still running, failed, missing or run by another app, another run failed, a truncated list, a failed or pending status, the wrong level, a forged signature, edited after signing, an unknown format, reused, two submissions racing, a 2-1, another output, another brief, a tally that doesn't recompute, reviewers not from three named companies (unprefixed ids, an empty or odd prefix, `claudette`, `claude-*` beside `anthropic/`, case variants), receipts in an order a greedy match would get wrong, one receipt sent twice for two requirements, an unbound commit-and-hash pair, a real live 2-1 receipt, and an L1 receipt built by the server's own code (d9578f4); the command form's exit codes.
- **The rest:** locks, budgets (also across two processes, a crashed holder, and a member named `__proto__`), a changed policy, shared keys in another spelling, and the member's name as an argument.

**Mutants (v0.1.0, 7f47b61 to 44c6ec5):** 36 checked (each removes one rule). 33 are caught. All three survivors remove a second check that another one already covers:
- the use-count precheck: the atomic use files still refuse reuse
- the canonical key spelling: the byte comparison still refuses a shared key
- the matching's "seen" set by index instead of id: the matching is keyed by receipt id anyway

**Mutants (v0.2.0 and v0.2.1, the B2 rules):** 21 checked, each removing or loosening one rule (the seat filter, `max_uses` other than 1 or `null`, the lifetime cap, `expires_at` after `issued_at`, a v1 approval, the baseline fail-closed check, an unlisted `GATE_MEMBER`, the canary skipped in `check_action`, a failure that doesn't stick, `fetch_detail` not scanned, whole hex runs instead of every window, the report's text stored, a pass that never lapses, a second `start` under an open run, the failure record after the status, a corrupt start time passing; v0.2.1: the report's mutex removed, the open-run check removed, state errors passed through raw). 20 are caught. The survivor removes the seat line inside `mismatch()`, a second check behind `check_action`'s own seat filter, whose removal is caught.

**Independent checks so far:**
- a fresh-agent read of 9318fdd: 10 findings, all fixed in the next commit, each with a test
- a review-3x3 of 7f47b61 (receipt `8006457af2764575bb723d52`, funded by the team allowance, $0.70): pass 2-1 (Sonnet pass, Luna needs_changes, Argon pass)
  - 5 findings fixed in the next commit, each with a test
  - 3 by design or wrong: the client ties votes to models; two fail closed
- a review-3x3 of c328066 (receipt `78c252a2e57efe617334daed`, team allowance, $0.70; Sonnet needs changes, Luna needs changes, Argon pass): 8 findings, 4 real and fixed in aaf5c7b with a test each (a crash window between the report record and the failure record; two starts at once; a seat named like another's failure key; https enforced by the loader too), 1 partly (upper-cased echoes, now case-folded), 2 brief gaps (the https check and `state.exists` lived outside the pieces), 1 first taken as by design and fixed after the re-check (below)
- the one re-check, a review-3x3 of aaf5c7b (receipt `620656793a1c468beabda9a7`, team allowance, $0.70; Sonnet needs changes, Luna needs changes, Argon pass): 5 findings, 3 real and fixed in the next commit with a test each or a README line (a failing second report of a reported run wrote the sticking failure before being refused; a rejected record's nonce prefix in a refusal could name another seat; the README's order of checks), 1 brief gap (`withMutex` wasn't in the task's facts), 1 of the three a README-only fix
- a review-3 of this README's tools, settings, canary, install order and limits at 8e0652c (receipt `c83a0abe0a05c9d125544fe4`, team allowance, $0.20; Opus needs changes, Luna needs changes, Argon pass): 13 findings, 1 real ordering error (the canary came before the sandbox it tests), 9 real or partly real precision points (the clock-skew tolerance, unknown actions, logging, the 32-hex value, a report missing a field, `--dry-run` in the command form, `check` beside `check_action`, what binds other companies' sessions, the failure file's name) and 3 wording or out-of-piece points; all taken in 49ea9b7
- the one re-check of those sections at 49ea9b7 (receipt `df0661d66c4d23fc32911c45`, team allowance, $0.20): **pass 3-0** (Opus, Luna, Argon), an L2 panel pass for that exact text; Opus's two wording notes (the file option in the `check_action` row; "before anything else") taken afterwards, unreviewed
- the second re-check of the code, a review-3 of the canary alone at cb27d2e (receipt `8a755c4194eaad776c840f1d`, team allowance, $0.20, on the owner's yes; Opus needs changes, Luna needs changes, Argon pass): 6 findings, 2 real and fixed in v0.2.1 with a test each (two reports of one run at once could leave a sticking failure from the refused one, now one report per run under the run's mutex; a busy mutex or a state error reached the session as a raw error, now a refusal with a reason and none of the record's text), 1 minor real fixed too (a start that crashed between its run record and its open record left a second reportable run; now only the open run can be reported), 1 brief gap (`max_age_hours` is validated by the policy loader, 1 to 168), 1 not taken (a failure record holding the JSON `null` reads as missing: the gate never writes one, and the folder is the owner's)
- a fresh-agent read of 5864e47 (v0.2.0's first commit): 11 findings, 3 medium (the decoy's value could reach the state folder through `fetch_detail`; the README didn't say `target_sha256` must be present; the settings as a root of trust were undocumented) and 8 low; 10 fixed in the next commit, each with a test or a README line; 1 partly (the state folder's growth: canary runs are now one open run per seat; the folder listing on every owner-only check is older than B2 and stays); within the last, member names such as `.` stay legal by design, since every state file name is prefixed

## What the gate can't do alone
- **It only binds sessions that must go through it.** The sandbox (part D) binds every CLI, whatever company's, by making the secret paths and the blocked hosts unreachable; the per-tool hooks (part C: Claude Code's, and each other CLI's own hook or approval setting where it has one) make the owner-only commands call `check_action` or its command form `check` first. Without them, the gate is an honest agent's checklist, not a wall.
- **The canary records what a session reports.** It catches a sandbox that lost its settings, not a session that lies; part D's check script does that.
- **It trusts its own settings.** `GATE_MEMBER`, the policy pin and the state folder are only as safe as the place they're written in (Settings, above).
- **"That commit is the one being merged"** is the caller's or CI's to state. The gate checks the receipt against the subject it's given.
- **One gate's record is per gate** (spec §5): each gate keeps its own accepted-receipt list.
