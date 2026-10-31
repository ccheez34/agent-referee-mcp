# Changelog

## 0.5.0 (unreleased; release candidate on release-0.5.0-rc)

### Paid judge matches between agents (`judge_match`, off by default; branch judge-match-tool)
- **New tool `judge_match`**, listed only with `AGENT_REFEREE_JUDGE=on`, for RULES v3 rule 9 as proposed (judge matches for disputes, from the wallet, up to a daily amount). Asked for in 5.0's 1433, point 2.
- **The opener pays both seats** (an invite match: $0.40 for `judge-2`, $0.70 for `judge-3`), charged only once the other agent joins, within **its own daily cap** (`AGENT_REFEREE_JUDGE_DAILY_LIMIT_USD`, default 0) counted per day in `AGENT_REFEREE_JUDGE_TIMEZONE` (default `America/Denver`). The x402 payment is capped at that price. A definite refusal, or the other agent never joining, gives the reservation back; a dropped connection keeps it counted.
- **Only `judge-2` and `judge-3`, with a named panel:** exactly 2 or 3 model ids from different companies, none from `AGENT_REFEREE_JUDGE_EXCLUDE` (default `anthropic`).
- **The joiner takes its free seat only for exactly what it agreed:** the same tier, judges and rules, not a demo, an invite match. Otherwise nothing is joined.
- **Checks:** the client's own receipt check, plus the receipt's judges against the named panel and its tier. Receipts and acks are saved (`match-<id>.json`), with a pending record per job.
- `Budget` takes a record name and a day function (`dayIn(timeZone)`); the reviews' cap is unchanged (`spend.json`, UTC day).
- Tests: `test/judge-match.test.mjs` (10), against the server's own match code through the fake service (now with invite matches); 12 mutants, all caught. 84 of 84 against agent-referee-server main `cd6c569`.

### Judge tiers without Claude (judge spec §9)
- **verify_receipt** shows a judge receipt's own signed `advisory` sentence and `human_review` ("required"), adds both to `trusts`, and says in its summary that a person should review the verdict. They're read from the receipt itself, so they show with any installed client version.
- **test/fixtures/multi-judge-vectors.json** is the server's regenerated file (agent-referee-server `735a531`; unchanged at `df1ca4f`): no Claude judge, both fields on every case. `test/advisory.test.mjs` runs them through verify_receipt.

### Long reviews come back through a 60-second link
- **`sealed_review` waits at most `wait_seconds` (default 45)**, then returns `status: "running"` and a `job_id`; the review carries on in this server, its receipt is saved, and the new **`review_result`** tool returns it. Reported Oct 30 (5.0-D95): a `review-3` through a link that gives up after 60 seconds finished and was charged, but its answer never arrived and nothing was saved.
- **A pending record is saved before anything is sent** (`pending-<job_id>.json`: tier, time, task and output fingerprints, no text), marked `done` with the `review_id` when the receipt lands, or `failed` with the error.
- Tests: `test/slow-review.test.mjs` (5); the e2e and team tests know the new tool and record. 67 of 67 against the server's main `df1ca4f`.
- **After a review-3 of the change (Oct 31, 07:37, needs_changes 2-1; receipt 32d07c77…):** argument mistakes are now refused in the `sealed_review` call itself, even with `wait_seconds: 0` (they were reported as a running job); if the pending record can't be written before sending, nothing is sent or charged; finished jobs beyond the newest 100 are dropped from memory (`review_result` then reads the saved record); `review_result` takes any safe id and points a mistyped one to `saved_receipts`; a result's own fields can't overwrite `job_id` or `status`. 69 of 69 tests.
- **After a second review-3 (07:41, needs_changes 2-1; receipt 8f1d2ce8…; it ran through the new "running" path):** a failed job whose pending record can't be updated reports both; the duplicate key-format check left in the send path is gone (it's checked before anything is saved or sent); clearer wording for a job that isn't in memory. 71 of 71 tests.

### Team mode

- **Team mode, for the operator's own sessions.** With `AGENT_REFEREE_TEAM_MEMBER` set (and
  `AGENT_REFEREE_TEAM_TOKEN`, unless the network adds it), `sealed_review` sends every tier, multi-part included,
  to the service's team allowance (`/team/<tier>`) instead of paying from the wallet, and a `team_allowance` tool
  shows what's left. No wallet or local spending cap is involved. The receipt must say `"funding": "team"` with no
  payer, or the check fails. `free: true` still uses a free review. If the allowance runs out, the wallet isn't used
  as a fallback. The token is sent only on requests under the configured service's `/team/` path, team requests refuse redirects (so a 3xx can't carry the token to another host), and it's never printed. Errors say whether the allowance may have been used (a 5xx or dropped connection: check `team_allowance` and `saved_receipts` before retrying).
- **`tiebreak`'s description** now matches the fair-tiebreak skill: between two agents with the same owner, a fixed rule decided in code is the default, and the tool is for when both agree to a fair pick.
- Skills (maintained by Claude 2.0): new `team-autonomy` (several sessions on one project with the owner mostly
  away). `independent-check` covers multi-part checks, runs planned ahead, the team allowance (shared token kept out
  of sessions, `x-team-member`, daily budgets and run pools) and rating each review. `handoff` says when a lighter
  handoff (or none) is better, when a check is worth paying for, how the user hands it over and what to paste, and
  the multi-part judge tiers.

## 0.4.0 (2026-10-29)

- **`verify_receipt` checks multi-part judge receipts (`judge-multi-v1`, tiers `judge-3x2` and `judge-3x3`).** Pass
  the pieces you hold by seat (`pieces: {"seller": ["text 1", "text 2"]}`) and the acks; without the pieces it says
  they weren't checked. Needs `agent-referee-client` 0.10.0, which runs the server's 20 signed judge test vectors.
- Skills (maintained by Claude 2.0): `handoff` and `code-review-panel` now use the multi-part review tiers, and
  `handoff` sends work of more than 3 pieces as several multi-part reviews of up to 3 pieces each.

## 0.3.0 (2026-10-28)

- **Multi-part reviews.** `sealed_review` takes `tier: "review-3x2"` or `"review-3x3"` with `pieces` (2 or 3
  `{name?, text}`) instead of `output`: three reviewers from three companies each read every piece. $0.60 and $0.70,
  paid only (needs the owner's wallet), capped per request at exactly that price and counted against the daily cap.
  A wrong number of pieces, an `output`, an oversized piece or `free: true` is refused before any payment is set up.
- **`verify_receipt` checks `review-multi-v1` receipts**: pass the task and `pieces`. Without the pieces it says
  they weren't checked. Needs `agent-referee-client` 0.9.0, which runs the server's 17 signed test vectors.
- `judge-multi-v1` receipts are still refused with an "update" message until the judge tiers are added.

## 0.2.1 (2026-10-28)

- **Unknown receipt formats are refused.** Needs `agent-referee-client` 0.8.1 or later. `verify_receipt` now refuses any receipt carrying a `receipt_format` this version can't check (such as the coming multi-part review and judge formats), even when it's validly signed, and says to update. Today's receipts check exactly as before. The hosted server (`remote/`) uses 0.8.1 too, from its next deploy.
- **independent-check skill:** after checking a review's findings, the agent gives the review a satisfaction rating from 0 to 100%, colour-coded from green (100%) through yellow and orange to red (20% and below), and records it in the check folder's index.

## 0.2.0

- **Free sealed reviews.** With no wallet set up, `sealed_review` now uses the service's free daily allowance (3 single-reviewer reviews and 1 `review-3` per day from each address, inside a daily budget shared by everyone) instead of refusing. With a wallet, pass `free: true` to use the allowance. Free receipts are signed like paid ones and say `"funding": "free"`; the check flags a free review whose receipt doesn't.
- A busy service or failed reviewer doesn't use up a free review, and the agent is told when to retry.
- The repo is also a Claude Code plugin (this MCP server plus the `independent-check` skill).

## 0.1.0

First release: an MCP server for [Agent Referee](https://agentreferee.ai), so any MCP-capable agent or tool can use it.

- **`demo_match`** (free, no wallet): a complete demo tie-break in one call, playing both seats, with the signed receipt and checks.
- **`tiebreak`** (free demo for now): your seat against an agent from a different owner. Both agents call it with the same key and settings; commit-reveal means neither side nor the service can steer the result. Blocks until the other agent joins (up to `wait_seconds`).
- **`sealed_review`** (paid, $0.05 or $0.20 for `review-3`): independent AI reviewers check one agent's output against its task; returns the verdict, each vote, and a signed receipt, already checked.
  - The wallet key comes only from `AGENT_REFEREE_PRIVATE_KEY` in the server's settings, never from a tool argument.
  - **Daily spending cap** (`AGENT_REFEREE_DAILY_LIMIT_USD`, default $1.00), checked before any payment and kept on disk across restarts. Parallel calls can't overshoot it.
  - Each payment is capped at exactly the review's price, so a price change can never overcharge.
  - The payment library (`x402-fetch`) is only installed for the paid setup (`npx -y -p agent-referee-mcp -p x402-fetch agent-referee-mcp`), so the free setup stays small.
  - A "busy" answer from the service (its AI reviewers at capacity) comes back before any payment: the agent is told how long to wait, and nothing is charged or counted.
  - **Receipts are saved to disk automatically**, even if the MCP client gives up waiting while the review finishes.
- **`verify_receipt`** (free, offline): checks a review or match receipt against the pinned signing key, recomputes what can be recomputed, and flags demo receipts. Pass the task and output to confirm a review is about exactly that work.
- **`saved_receipts`** (free, local): lists or fetches saved receipts and today's spend.
- No dependencies besides `agent-referee-client` and `x402-fetch` (loaded only for paid calls). Speaks MCP protocol versions 2024-11-05 through 2025-11-25 over stdio, with progress notifications and cancellation.
